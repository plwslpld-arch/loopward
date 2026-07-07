#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { RoutingCase } from '../../core/src/types.ts';
import { getProvider, PROVIDER_NAMES } from '../../core/src/provider.ts';
import { runSuite, type Variant } from '../../core/src/loop.ts';
import { runMultistepSuite, type MultistepTask } from '../../core/src/multistep.ts';
import { loadTools, auditConfusability, synthesizeCases, type Tool } from '../../core/src/tools.ts';
import { norm } from '../../core/src/oracle.ts';
import { runAttacks, type AttackReport } from '../../redteam/src/attack-run.ts';
import { runFix } from '../../redteam/src/fix.ts';
import { buildExport, toFiles } from '../../coevo/src/export.ts';
import { gitSha, LOOPWARD_VERSION, type StampInput, type Manifest } from '../../core/src/manifest.ts';
import { verifyReport, formatVerify } from '../../eval/src/verify.ts';
import { harnessMatrix, DEFAULT_STRATEGIES } from '../../eval/src/harness-portability/harness-matrix.ts';
import { runFlywheel } from '../../coevo/experiments/micro-loop/flywheel.ts';
import { correctAttacks, correctStopAxis } from '../../eval/src/stats/multiseed.ts';
import { aggregateSeeds } from '../../eval/src/stats/seed-sweep.ts';
import { regressionGate, formatGate } from '../../eval/src/gate.ts';
import { buildAuditSarif } from '../../core/src/sarif.ts';
import { fetchMcpTools, normalizeSavedToolsList, toToolsFile } from '../../core/src/mcp.ts';
import { runStopAxis, STOP_NUDGES, type StopAxisReport } from '../../redteam/src/stop-axis.ts';

function loadSuite(path: string): RoutingCase[] {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data == null || typeof data !== 'object') throw new Error(`suite ${path}: expected a JSON array of cases (or { cases: [...] })`);
  const cases: RoutingCase[] = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(cases)) throw new Error(`suite ${path}: expected an array of cases (or { cases: [...] })`);
  for (const c of cases) {
    if (!c.id || !c.intent || !Array.isArray(c.candidates) || !c.ground_truth)
      throw new Error(`suite ${path}: bad case ${JSON.stringify(c).slice(0, 80)}`);
    if (!c.candidates.includes(c.ground_truth))
      throw new Error(`suite ${path}: case ${c.id} ground_truth "${c.ground_truth}" not in candidates`);
    // Two candidates that normalize equal are indistinguishable to the oracle, so a route to the
    // WRONG one would score correct. Reject rather than silently mis-score. Same norm the oracle uses.
    const byNorm = new Map<string, string>();
    for (const cand of c.candidates) {
      const k = norm(cand);
      const prev = byNorm.get(k);
      if (prev !== undefined && prev !== cand)
        throw new Error(`suite ${path}: case ${c.id} candidates "${prev}" and "${cand}" are indistinguishable to the oracle`);
      byNorm.set(k, cand);
    }
  }
  return cases;
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const pp = (x: number) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'pp';

interface ProviderOpts { model?: string; baseURL?: string; timeoutMs?: number }

// wall-clock time + git enter ONLY here, at the CLI boundary — never in library code or self-checks.
const stamp = (): StampInput => ({ timestamp: new Date().toISOString(), git_sha: gitSha() });

// ── output mode ──────────────────────────────────────────────────────────────
// 'human' = tables + provenance footer (default); 'json' = the exact report object (the same one
// written to runs/*.json) to stdout for jq/CI, no table; 'quiet' = files still written, no chatter.
let VIEW: 'human' | 'json' | 'quiet' = 'human';

/** Friendly numeric validation. Rejects NaN/±Infinity, out-of-range, and (int) non-integers — a bad
 *  flag must FAIL loudly, never coerce to NaN and silently pass a gate or mislabel a run/filename. */
function parseNum(name: string, raw: string, opts: { int?: boolean; min?: number; max?: number } = {}): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got "${raw}"`);
  if (opts.int && !Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${name} must be >= ${opts.min}, got ${n}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${name} must be <= ${opts.max}, got ${n}`);
  return n;
}

/** --ratio is a train fraction strictly inside (0,1); 0 or 1 gives a degenerate empty-train/all-held split. */
function validateRatio(raw: string): number {
  const n = parseNum('--ratio', raw);
  if (n <= 0 || n >= 1) throw new Error(`--ratio must be strictly between 0 and 1 (exclusive), got ${n}`);
  return n;
}

const wantsHelp = (argv: string[]) => argv[0] === 'help' || argv.includes('--help') || argv.includes('-h');
const wantsVersion = (argv: string[]) => argv.includes('--version') || argv.includes('-V');

// commands that accept EITHER a routing suite OR a tools schema (never both)
const EITHER_OR = new Set(['attack', 'fix', 'matrix', 'flywheel', 'multiseed']);
/** Reject contradictory input flags instead of silently preferring one. */
function assertExclusiveInputs(cmd: string, v: { tools?: string; suite?: string; reports?: string; seeds?: string }) {
  if (EITHER_OR.has(cmd) && v.tools && v.suite) throw new Error('use --tools OR --suite, not both');
  if (cmd === 'multiseed' && v.reports && v.seeds) throw new Error('use --reports OR --seeds, not both');
}

/** One-line provenance footer, drawn straight from the manifest the report already carries. */
function reproFooter(m: Manifest, seedLabel?: string | number) {
  const sha = String(m.git_sha || 'unknown').slice(0, 8);
  const hash = String(m.tool_schema_hash || '').slice(0, 8);
  console.log(`run: git ${sha} · tools ${hash} · seed ${seedLabel ?? m.seed} · oracle ${m.oracle_version}`);
}

function usageText(): string[] {
  return [
    'usage:  loopward <command>   (run with no command for interactive mode)',
    '  audit  --tools <schema.json> [--sarif out.sarif]  confusable tool names, no key, instant (+ SARIF)',
    '  attack --tools <schema.json> | --suite <f.json>   6 red-team attacks + robustness CI',
    '  fix    --tools <schema.json> | --suite <f.json>   propose renames, re-verify the delta',
    '  matrix --tools <schema.json> | --suite <f.json>   compare loop strategies on a fixed model',
    '  multi  --suite <tasks.json> [--stop-axis]         multi-step loop: stop / over-run / success',
    '  multiseed --seeds 1,2,3 --suite|--tools | --reports a,b,c   N seeds, honest across-seed spread',
    '  coevo  --report <attack-report.json>              misroutes → DPO / reward / SFT data',
    '  flywheel --tools <schema.json> | --suite <f.json> train guardrail, re-measure held-out lift',
    '  gate   --baseline <base.json> --report <cur.json> fail(1) if robustness regressed (case-paired, Holm)',
    '  stats  --report <report.json>                     Holm-corrected significance (attack or stop-axis)',
    "  verify --report <report.json>                     re-check a report's deterministic fields, offline",
    '  mcp-tools --server "<cmd>" | --from <saved.json>  import a live MCP server\'s tool catalog',
    '  run    --suite <f.json>                           clean routing accuracy only',
    `  common: [--provider ${PROVIDER_NAMES.join('|')}] [--model M] [--base-url URL] [--seed 42] [--out f] [--timeout ms] [--json|--quiet]`,
    '  keys via env, one per provider: OPENAI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, ...',
  ];
}
function printUsage(sink: (s: string) => void = console.log) { for (const l of usageText()) sink(l); }

async function cmdRun(suite: string, provider: string, seed: number, out: string | undefined, po: ProviderOpts, variant: Variant) {
  const cases = loadSuite(suite);
  const summary = await runSuite(cases, getProvider(provider, po), seed, variant);
  const outPath = out ?? `runs/${summary.provider.replace(/[^\w.-]/g, '_')}-${variant}-seed${seed}.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, summary.trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n');
  if (VIEW === 'json') { console.log(JSON.stringify(summary, null, 2)); return; }
  if (VIEW === 'quiet') return;
  console.log(`provider=${summary.provider} variant=${variant} seed=${seed}`);
  console.log(`clean routing accuracy: ${summary.correct}/${summary.total} = ${pct(summary.accuracy)}`);
  console.log(`trajectories → ${outPath}`);
}

async function cmdAttack(suite: string | undefined, toolsPath: string | undefined, providerName: string, seed: number, out: string | undefined, po: ProviderOpts, variant: Variant, failUnder?: number) {
  const provider = getProvider(providerName, po);
  let cases;
  if (toolsPath) {
    const tools = loadTools(toolsPath);
    console.log(`synthesizing ${tools.length} test intents from your tools with ${provider.name}...`);
    cases = await synthesizeCases(tools, provider, seed);
  } else {
    cases = loadSuite(suite!);
  }
  const rep = await runAttacks(cases, provider, seed, undefined, variant, stamp());
  const outPath = out ?? `runs/attack-${rep.provider.replace(/[^\w.-]/g, '_')}-${variant}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rep, null, 2));

  if (VIEW === 'json') console.log(JSON.stringify(rep, null, 2));
  else if (VIEW === 'human') {
    console.log(`provider=${rep.provider} variant=${variant} seed=${seed}  n=${rep.total}`);
    console.log(`clean routing accuracy: ${pct(rep.clean_accuracy)}\n`);
    console.log('attack                  acc     misroute   robustness_delta (95% CI)');
    console.log('─'.repeat(74));
    for (const a of [...rep.attacks].sort((x, y) => y.robustness_delta.delta - x.robustness_delta.delta)) {
      const d = a.robustness_delta;
      console.log(
        `${a.attack.padEnd(22)} ${pct(a.accuracy).padStart(6)}  ${pct(a.misroute_rate).padStart(7)}    ` +
          `${pp(d.delta).padStart(7)}  [${pp(d.lo)}, ${pp(d.hi)}]`,
      );
    }
    console.log(`\nfull report → ${outPath}`);
    reproFooter(rep.manifest);
  }

  if (failUnder !== undefined) {
    const worst = rep.attacks.reduce((m, a) => Math.min(m, a.accuracy), 1);
    const worstAttack = rep.attacks.find((a) => a.accuracy === worst);
    if (worst * 100 < failUnder) {
      console.error(`\nFAIL: worst attacked accuracy ${pct(worst)} (${worstAttack?.attack}) is under --fail-under ${failUnder}%`);
      process.exit(1);
    }
    if (VIEW === 'human') console.log(`gate ok: worst attacked accuracy ${pct(worst)} >= ${failUnder}%`);
  }
}

async function cmdFix(suite: string | undefined, toolsPath: string | undefined, providerName: string, seed: number, out: string | undefined, po: ProviderOpts, variant: Variant) {
  const provider = getProvider(providerName, po);
  let tools: Tool[];
  let cases: RoutingCase[];
  if (toolsPath) {
    tools = loadTools(toolsPath);
    console.log(`synthesizing ${tools.length} test intents from your tools with ${provider.name}...`);
    cases = await synthesizeCases(tools, provider, seed);
  } else {
    cases = loadSuite(suite!);
    // no descriptions in a bare suite; derive a name-only catalog so the audit can still run
    tools = [...new Set(cases.flatMap((c) => c.candidates))].map((name) => ({ name, description: '' }));
  }
  const rep = await runFix(tools, cases, provider, seed, variant, stamp());
  const outPath = out ?? `runs/fix-${rep.provider.replace(/[^\w.-]/g, '_')}-${variant}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rep, null, 2));

  if (VIEW === 'json') { console.log(JSON.stringify(rep, null, 2)); return; }
  if (VIEW === 'quiet') return;

  console.log(`\nprovider=${rep.provider} variant=${variant} seed=${seed}`);
  if (!rep.renames.length) {
    console.log('\nno HIGH-risk confusable names to fix — routing is already unambiguous by name.');
    console.log(`report → ${outPath}`);
    reproFooter(rep.after.manifest);
    return;
  }
  console.log('\nproposed renames (suggestion is model-made; the re-measure below is deterministic):');
  for (const r of rep.renames) console.log(`  ${r.from}  →  ${r.to}   (${r.reason})`);
  console.log('\nattack                  before   after    delta');
  console.log('─'.repeat(52));
  const beforeBy = new Map(rep.before.attacks.map((a) => [a.attack, a.accuracy]));
  for (const a of rep.after.attacks) {
    const b = beforeBy.get(a.attack) ?? a.accuracy;
    const d = (a.accuracy - b) * 100;
    console.log(`${a.attack.padEnd(22)} ${pct(b).padStart(6)}  ${pct(a.accuracy).padStart(6)}   ${(d >= 0 ? '+' : '') + d.toFixed(1)}pp`);
  }
  console.log(`\nverified: the renames moved "${rep.worst_attack}" (worst attack before the fix) ${pct(rep.acc_before)} → ${pct(rep.acc_after)} = ${rep.recovered_pp >= 0 ? '+' : ''}${rep.recovered_pp}pp.`);
  console.log(`report → ${outPath}`);
  reproFooter(rep.after.manifest);
}

async function cmdCoevo(reportPath: string, outDir: string) {
  const rep = JSON.parse(readFileSync(reportPath, 'utf8')) as AttackReport;
  if (!rep.failures) throw new Error(`${reportPath} has no failures[] — re-run 'attack' with the current version`);
  const files = toFiles(buildExport(rep.failures));
  mkdirSync(outDir, { recursive: true });
  console.log(`from ${rep.provider} (${rep.failures.length} raw misroutes):`);
  for (const [name, body] of Object.entries(files)) {
    const path = `${outDir.replace(/\/$/, '')}/${name}`;
    writeFileSync(path, body);
    console.log(`  ${String(body ? body.trimEnd().split('\n').length : 0).padStart(4)} rows → ${path}`);
  }
}

async function cmdMulti(suite: string, provider: string, seed: number, out: string | undefined, po: ProviderOpts, failUnder?: number) {
  const data = JSON.parse(readFileSync(suite, 'utf8'));
  const tasks: MultistepTask[] = Array.isArray(data) ? data : data.tasks;
  if (!Array.isArray(tasks)) throw new Error(`suite ${suite}: expected tasks[] (or { tasks: [...] })`);
  for (const t of tasks)
    if (!t.id || !t.task || !Array.isArray(t.tools) || !Array.isArray(t.required))
      throw new Error(`suite ${suite}: bad task ${JSON.stringify(t).slice(0, 80)}`);

  const sum = await runMultistepSuite(tasks, getProvider(provider, po), seed);
  const outPath = out ?? `runs/multi-${sum.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(sum, null, 2));

  if (VIEW === 'json') console.log(JSON.stringify(sum, null, 2));
  else if (VIEW === 'human') {
    console.log(`provider=${sum.provider} seed=${seed}  n=${sum.total} (multi-step loop)`);
    console.log(`task success:      ${pct(sum.success_rate)}`);
    console.log(`premature-stop:    ${pct(sum.premature_stop_rate)}`);
    console.log(`over-run:          ${pct(sum.over_run_rate)}`);
    console.log(`avg extra calls:   ${sum.avg_extra_calls.toFixed(2)}`);
    console.log(`results → ${outPath}`);
  }

  if (failUnder !== undefined) {
    if (sum.success_rate * 100 < failUnder) {
      console.error(`\nFAIL: multi-step success ${pct(sum.success_rate)} is under --fail-under ${failUnder}%`);
      process.exit(1);
    }
    if (VIEW === 'human') console.log(`gate ok: multi-step success ${pct(sum.success_rate)} >= ${failUnder}%`);
  }
}

async function cmdMatrix(suite: string | undefined, toolsPath: string | undefined, providerName: string, seed: number, out: string | undefined, po: ProviderOpts, strategiesArg?: string) {
  const provider = getProvider(providerName, po);
  let cases: RoutingCase[];
  if (toolsPath) {
    const tools = loadTools(toolsPath);
    console.log(`synthesizing ${tools.length} test intents from your tools with ${provider.name}...`);
    cases = await synthesizeCases(tools, provider, seed);
  } else cases = loadSuite(suite!);

  const allowed = ['single', 'self-check', 'react', 'observe'];
  const strategies = (strategiesArg ? strategiesArg.split(',').map((s) => s.trim()) : DEFAULT_STRATEGIES) as Variant[];
  for (const s of strategies) if (!allowed.includes(s)) throw new Error(`--strategies: unknown strategy "${s}" (use ${allowed.join(',')})`);

  const rep = await harnessMatrix(cases, provider, seed, strategies);
  const outPath = out ?? `runs/matrix-${rep.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rep, null, 2));

  if (VIEW === 'json') { console.log(JSON.stringify(rep, null, 2)); return; }
  if (VIEW === 'quiet') return;

  console.log(`\nprovider=${rep.provider} seed=${seed}  n=${rep.n_cases}  (harness strategies on a FIXED model)\n`);
  console.log('strategy        clean    attacked');
  console.log('─'.repeat(38));
  for (const r of rep.per_strategy) console.log(`${r.strategy.padEnd(14)} ${pct(r.clean).padStart(6)}  ${pct(r.attacked).padStart(8)}`);
  console.log(`\nmost robust harness: ${rep.best}. delta vs the others (case-paired, 95% CI):`);
  for (const d of rep.deltas) console.log(`  ${d.a} − ${d.b}:  ${pp(d.delta.delta)}  [${pp(d.delta.lo)}, ${pp(d.delta.hi)}]`);
  console.log(`\n${rep.note}`);
  console.log(`report → ${outPath}`);
  console.log(`strategy definitions + where each has helped/hurt: harnesses/README.md`);
}

async function cmdFlywheel(suite: string | undefined, toolsPath: string | undefined, providerName: string, seed: number, ratio: number, out: string | undefined, po: ProviderOpts) {
  const provider = getProvider(providerName, po);
  let cases: RoutingCase[];
  if (toolsPath) {
    const tools = loadTools(toolsPath);
    console.log(`synthesizing ${tools.length} test intents from your tools with ${provider.name}...`);
    cases = await synthesizeCases(tools, provider, seed);
  } else cases = loadSuite(suite!);

  const r = await runFlywheel(cases, provider, seed, { ratio });
  const outPath = out ?? `runs/flywheel-${r.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(r, null, 2));

  if (VIEW === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
  if (VIEW === 'quiet') return;

  console.log(`\nprovider=${r.provider} seed=${seed}  split ${r.n_train} train / ${r.n_held} held (ratio ${r.ratio})`);
  console.log(`\nguardrail (activated by TRAIN injections):\n  ${r.guardrail.replace(/\n/g, '\n  ') || '(none — no injection misroutes in TRAIN)'}`);
  console.log(`\nheld-out injection subset (${r.addressable_attacks.join(', ')}):`);
  console.log(`  accuracy  ${pct(r.before_accuracy)} → ${pct(r.after_accuracy)}`);
  console.log(`  lift      ${pp(r.lift.delta)}${r.ci_valid ? `  [${pp(r.lift.lo)}, ${pp(r.lift.hi)}]` : '  (held set too small for a CI)'}`);
  console.log(`  (all six attacks, pooled: ${pct(r.pooled_before)} → ${pct(r.pooled_after)})`);
  console.log(`\n${r.note}`);
  console.log(`receipt → ${outPath}`);
}

function cmdStats(reportPath: string, alpha: number) {
  const rep = JSON.parse(readFileSync(reportPath, 'utf8'));
  // stop-axis reports carry per_nudge + clean_rates; attack reports carry attacks[] + matrix.
  if (rep.per_nudge && rep.clean_rates) {
    const c = correctStopAxis(rep as StopAxisReport, { alpha });
    console.log(`provider=${c.provider} seed=${c.seed}  alpha=${c.alpha}  (stop-axis)\n`);
    console.log('nudge      metric            dir        delta     95% CI               p      Holm-p   sig');
    console.log('─'.repeat(92));
    for (const cell of c.cells) {
      console.log(
        `${cell.nudge.padEnd(10)} ${cell.metric.padEnd(16)} ${cell.direction.padEnd(9)} ${pp(cell.delta).padStart(7)}  ` +
          `[${pp(cell.ci.lo)}, ${pp(cell.ci.hi)}]  ${cell.p.toFixed(3)}  ${cell.p_holm.toFixed(3)}  ${cell.significant ? 'yes' : 'no'}`,
      );
    }
    console.log(`\n${c.note}`);
    return;
  }
  const c = correctAttacks(rep as AttackReport, { alpha });
  console.log(`provider=${c.provider} seed=${c.seed}  alpha=${c.alpha}\n`);
  console.log('attack                  delta     95% CI               p      Holm-p   dz     sig');
  console.log('─'.repeat(84));
  for (const a of [...c.attacks].sort((x, y) => y.delta - x.delta)) {
    console.log(
      `${a.attack.padEnd(22)} ${pp(a.delta).padStart(7)}  [${pp(a.ci.lo)}, ${pp(a.ci.hi)}]  ` +
        `${a.p.toFixed(3)}  ${a.p_holm.toFixed(3)}  ${a.dz.toFixed(2).padStart(5)}  ${a.significant ? 'yes' : 'no'}`,
    );
  }
  console.log(`\n${c.note}`);
}

function cmdVerify(reportPath: string) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const result = verifyReport(report);
  console.log(`verifying ${reportPath} (offline, re-derives deterministic fields):\n`);
  console.log(formatVerify(result));
  process.exit(result.pass ? 0 : 1);
}

function cmdAudit(toolsPath: string, failOnHigh?: boolean, sarifPath?: string, outPath?: string) {
  const tools = loadTools(toolsPath);
  const pairs = auditConfusability(tools); // already sorted by score, descending
  const result = { audited: tools.length, pairs };
  // SARIF is written first (before any early return or fail-on-high exit) so the file always lands —
  // an empty results[] is valid and correctly clears prior code-scanning alerts.
  if (sarifPath) {
    const raw = readFileSync(toolsPath, 'utf8');
    const log = buildAuditSarif(pairs, { toolsUri: toolsPath.replace(/\\/g, '/'), rawToolsText: raw });
    mkdirSync(dirname(sarifPath), { recursive: true });
    writeFileSync(sarifPath, JSON.stringify(log, null, 2) + '\n');
  }
  // --out carries the FULL pair list (stdout is capped below); SARIF/--out are never truncated.
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  }
  if (VIEW === 'json') console.log(JSON.stringify(result, null, 2));
  else if (VIEW === 'human') {
    console.log(`audited ${tools.length} tools, found ${pairs.length} confusable pair(s) (no model calls)\n`);
    if (!pairs.length) {
      console.log('no obviously confusable tool pairs. nice catalog.');
      if (sarifPath) console.log(`sarif → ${sarifPath}`);
      if (outPath) console.log(`full list → ${outPath}`);
    } else {
      console.log('risk   pair                                        shared');
      console.log('─'.repeat(70));
      const CAP = 50;
      for (const p of pairs.slice(0, CAP)) {
        const risk = p.score >= 0.5 ? 'HIGH' : p.score >= 0.34 ? 'med ' : 'low ';
        const pair = `${p.a} ~ ${p.b}`;
        console.log(`${risk}  ${pair.slice(0, 42).padEnd(42)}  ${p.sharedTokens.join(', ') || '(similar descriptions)'}`);
      }
      if (pairs.length > CAP) console.log(`\nshowing top ${CAP} of ${pairs.length} — full list via --sarif / --out`);
      console.log(`\nthese pairs are the ones a router is most likely to mix up. rename, merge, or disambiguate descriptions.`);
      if (sarifPath) console.log(`sarif → ${sarifPath}`);
      if (outPath) console.log(`full list → ${outPath}`);
    }
  }
  const high = pairs.filter((p) => p.score >= 0.5);
  if (failOnHigh && high.length) {
    console.error(`\nFAIL: ${high.length} HIGH-risk confusable pair(s) with --fail-on-high set`);
    process.exit(1);
  }
}

async function cmdMcpTools(server: string | undefined, from: string | undefined, out: string | undefined, opts: { protocol?: string; timeout?: number }) {
  if (opts.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout <= 0)) throw new Error('--timeout must be a positive number of milliseconds');
  let result;
  if (server) {
    console.error(`⚠ executing MCP server command locally: ${server}`);
    console.error('  (this runs the command you passed — only import from servers you trust)');
    result = await fetchMcpTools(server, { env: process.env, protocol: opts.protocol, timeoutMs: opts.timeout });
  } else if (from) {
    result = normalizeSavedToolsList(JSON.parse(readFileSync(from, 'utf8')));
    if (!result.tools.length) throw new Error(`${from}: no tools in the saved MCP response`);
  } else throw new Error('mcp-tools needs --server "<cmd>" or --from <saved.json>');

  const file = toToolsFile(result, server ?? from!, new Date().toISOString());
  const outPath = out ?? 'runs/mcp-tools.json';
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n');

  if (VIEW === 'json') { console.log(JSON.stringify(file, null, 2)); return; }
  if (VIEW === 'quiet') return;

  const count = (file as { tools: unknown[] }).tools.length;
  const info = result.serverInfo ? ` from ${result.serverInfo.name ?? 'server'}${result.serverInfo.version ? ' ' + result.serverInfo.version : ''}` : '';
  console.log(`imported ${count} tool(s)${info}${result.protocolVersion ? ` (MCP ${result.protocolVersion})` : ''}`);
  console.log('note: an MCP catalog is a point-in-time snapshot; a later fetch may differ.');
  console.log(`tools → ${outPath}`);
  console.log(`next:  loopward audit --tools ${outPath}`);
}

function cmdGate(baselinePath: string, currentPath: string, opts: { tolerance?: number; alpha?: number; unpaired?: boolean; allowSchemaChange?: boolean }) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as AttackReport;
  const current = JSON.parse(readFileSync(currentPath, 'utf8')) as AttackReport;
  const result = regressionGate(baseline, current, opts);
  console.log(`gate: baseline ${baselinePath}  vs  current ${currentPath}\n`);
  console.log(formatGate(result));
  process.exit(result.pass ? 0 : 1);
}

async function cmdMultiseed(suite: string | undefined, toolsPath: string | undefined, providerName: string, seedsArg: string | undefined, reportsArg: string | undefined, variant: Variant, out: string | undefined, po: ProviderOpts, alpha: number, failUnder?: number) {
  let report;
  if (reportsArg) {
    const reports = reportsArg.split(',').map((s) => s.trim()).filter(Boolean).map((p) => JSON.parse(readFileSync(p, 'utf8')) as AttackReport);
    report = aggregateSeeds(reports, { alpha });
  } else {
    const seeds = [...new Set((seedsArg ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)))];
    if (!seeds.length) throw new Error('multiseed run mode needs --seeds <comma-separated ints> (or --reports to aggregate saved reports)');
    const provider = getProvider(providerName, po);
    let cases: RoutingCase[];
    if (toolsPath) { const tools = loadTools(toolsPath); console.log(`synthesizing ${tools.length} test intents from your tools with ${provider.name}...`); cases = await synthesizeCases(tools, provider, seeds[0]); }
    else cases = loadSuite(suite!);
    const reports: AttackReport[] = [];
    for (const s of seeds) { console.log(`seed ${s}...`); reports.push(await runAttacks(cases, provider, s, undefined, variant, stamp())); }
    report = aggregateSeeds(reports, { alpha });
  }
  const outPath = out ?? `runs/multiseed-${report.provider.replace(/[^\w.-]/g, '_')}-${report.variant}-seeds${report.seeds.join('_')}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (VIEW === 'json') console.log(JSON.stringify(report, null, 2));
  else if (VIEW === 'human') {
    console.log(`\nprovider=${report.provider} variant=${report.variant}  seeds=[${report.seeds.join(', ')}]  n=${report.n_cases}\n`);
    console.log('attack                  mean Δ    range              SD       sig    identical?');
    console.log('─'.repeat(80));
    for (const a of [...report.attacks].sort((x, y) => y.mean_delta - x.mean_delta)) {
      const sd = a.sd_delta === null ? 'n/a' : (a.sd_delta * 100).toFixed(1) + 'pp';
      console.log(`${a.attack.padEnd(22)} ${pp(a.mean_delta).padStart(7)}  [${pp(a.min_delta)}, ${pp(a.max_delta)}]  ${sd.padStart(7)}  ${(a.significant_in + '/' + a.n_seeds).padStart(5)}   ${a.identical_across_seeds ? 'yes' : 'no'}`);
    }
    if (report.degenerate) console.log('\n⚠ DEGENERATE: every attack is bit-identical across seeds (a temp-0 / seed-ignoring provider). SD=0 means no independent replication happened, NOT certainty.');
    console.log(`\n${report.note}`);
    console.log(`report → ${outPath}`);
    if (report.manifests[0]) reproFooter(report.manifests[0], report.seeds.join(','));
  }

  if (failUnder !== undefined) {
    const cleanMean = report.clean_accuracy_by_seed.reduce((a, b) => a + b, 0) / (report.clean_accuracy_by_seed.length || 1);
    const worst = report.attacks.reduce((m, a) => Math.min(m, cleanMean - a.mean_delta), 1);
    if (worst * 100 < failUnder) { console.error(`\nFAIL: worst mean-across-seeds attacked accuracy ${pct(worst)} is under --fail-under ${failUnder}%`); process.exit(1); }
    if (VIEW === 'human') console.log(`gate ok: worst mean-across-seeds attacked accuracy ${pct(worst)} >= ${failUnder}%`);
  }
}

async function cmdStopAxis(suite: string, providerName: string, seed: number, out: string | undefined, po: ProviderOpts, failOnFragile: boolean, alpha: number) {
  const data = JSON.parse(readFileSync(suite, 'utf8'));
  const tasks: MultistepTask[] = Array.isArray(data) ? data : data.tasks;
  if (!Array.isArray(tasks)) throw new Error(`suite ${suite}: expected tasks[] (or { tasks: [...] })`);
  const provider = getProvider(providerName, po);
  const rep = await runStopAxis(tasks, provider, seed, STOP_NUDGES, stamp());
  const outPath = out ?? `runs/stopaxis-${rep.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rep, null, 2));

  if (VIEW === 'json') console.log(JSON.stringify(rep, null, 2));
  else if (VIEW === 'human') {
    console.log(`provider=${rep.provider} seed=${seed}  n=${rep.n_tasks}  (stop-axis probe of the HALT decision)\n`);
    console.log(`clean rates:  premature-stop ${pct(rep.clean_rates.premature_stop)}   over-run ${pct(rep.clean_rates.over_run)}   success ${pct(rep.clean_rates.success)}\n`);
    for (const n of rep.per_nudge) {
      const moved = Math.abs(n.deltas.premature_stop.delta) > 1e-9 || Math.abs(n.deltas.over_run.delta) > 1e-9 || Math.abs(n.deltas.success.delta) > 1e-9;
      const flag = n.kind === 'control' && moved ? '   ⚠ control moved — confound, treat other deltas with caution' : '';
      console.log(`${n.id} (${n.kind})${flag}`);
      for (const m of ['premature_stop', 'over_run', 'success'] as const) {
        const d = n.deltas[m];
        console.log(`   ${m.padEnd(16)} ${pp(d.delta).padStart(7)}  [${pp(d.lo)}, ${pp(d.hi)}]`);
      }
    }
    console.log(`\n${rep.guard_note}`);
    console.log(`report → ${outPath}`);
    reproFooter(rep.manifest);
  }

  if (failOnFragile) {
    const c = correctStopAxis(rep, { alpha });
    // A Holm-significant PLACEBO control means task-independent filler text moved the halt decision —
    // the run is confounded and the other deltas can't be trusted. Fail hard, don't silently greenlight.
    const confound = c.cells.filter((cell) => cell.kind === 'control' && cell.significant);
    if (confound.length) { console.error(`\nFAIL: placebo control is Holm-significant (${confound.map((x) => x.metric).join(', ')}) — the run is confounded; other deltas are untrustworthy`); process.exit(1); }
    const bad = c.cells.filter((cell) => cell.kind !== 'control' && cell.significant);
    if (bad.length) { console.error(`\nFAIL: ${bad.length} stop-axis cell(s) Holm-significant: ${bad.map((b) => `${b.nudge}/${b.metric}`).join(', ')}`); process.exit(1); }
    if (VIEW === 'human') console.log(`gate ok: placebo control unmoved and no non-control nudge is Holm-significant.`);
  }
}

// Zero-arg guided mode: `loopward` with no command. For real terminals; no-op-friendly defaults.
async function cmdInteractive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = '') => ((await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def);
  try {
    console.log('loopward — answer a few questions (press enter for the default).\n');
    const cmd = await ask('command: audit / attack / fix / multi', 'audit');
    const seed = Number(await ask('seed', '42'));
    if (cmd === 'audit') {
      cmdAudit(await ask('path to your tools.json', 'datasets/tools/sample-tools.json'), false);
      return;
    }
    if (cmd === 'multi') {
      const suite = await ask('path to tasks.json', 'datasets/multistep/tasks.json');
      const provider = await ask(`provider: ${PROVIDER_NAMES.join(' / ')}`, 'mock');
      const model = provider === 'mock' ? undefined : (await ask('model (e.g. gpt-5.5)')) || undefined;
      await cmdMulti(suite, provider, seed, undefined, { model });
      return;
    }
    if (cmd !== 'attack' && cmd !== 'fix') { console.error(`unknown command: ${cmd}`); return; }
    const useTools = (await ask('point at a tools schema (t) or a routing suite (s)?', 't')) !== 's';
    const path = await ask(useTools ? 'path to tools.json' : 'path to suite.json',
      useTools ? 'datasets/tools/sample-tools.json' : 'datasets/routing/sample.json');
    const provider = await ask(`provider: ${PROVIDER_NAMES.join(' / ')}`, 'mock');
    const model = provider === 'mock' ? undefined : (await ask('model (e.g. gpt-5.5)')) || undefined;
    const po: ProviderOpts = { model };
    const s = useTools ? undefined : path;
    const t = useTools ? path : undefined;
    if (cmd === 'attack') await cmdAttack(s, t, provider, seed, undefined, po, 'single');
    else await cmdFix(s, t, provider, seed, undefined, po, 'single');
  } finally {
    rl.close();
  }
}

// Framework-free self-check for the CLI's pure input-handling. Invoke: `loopward __selfcheck`.
// Each assertion FAILS if the corresponding fix is reverted (bad flag silently coerced, help/version
// unhandled, contradictory input flags accepted).
function runCliSelfcheck() {
  // Tiny framework-free asserts (plain throws — no node:assert assertion signatures, so no runtime dep).
  const eq = (got: unknown, want: unknown, msg: string) => { if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };
  const rejects = (fn: () => unknown, re: RegExp, msg: string) => {
    let threw: Error | undefined;
    try { fn(); } catch (e) { threw = e as Error; }
    if (!threw) throw new Error(`${msg}: expected a throw matching ${re}, but nothing was thrown`);
    if (!re.test(threw.message)) throw new Error(`${msg}: threw "${threw.message}" which does not match ${re}`);
  };
  const accepts = (fn: () => unknown, msg: string) => { try { fn(); } catch (e) { throw new Error(`${msg}: unexpected throw "${(e as Error).message}"`); } };

  // parseNum: a bad numeric flag must THROW, never coerce to NaN and silently pass a gate / mislabel a run.
  rejects(() => parseNum('--fail-under', 'notanumber'), /finite/, 'non-numeric --fail-under');
  rejects(() => parseNum('--fail-under', 'NaN'), /finite/, 'NaN --fail-under (was a silent gate pass)');
  eq(parseNum('--fail-under', '90'), 90, 'valid --fail-under passes through');
  rejects(() => parseNum('--seed', '1.5', { int: true }), /integer/, 'fractional --seed');
  eq(parseNum('--seed', '42', { int: true }), 42, 'valid --seed passes through');
  rejects(() => parseNum('--timeout', '0', { int: true, min: 1 }), />=/, '--timeout must be > 0');
  rejects(() => parseNum('--alpha', 'Infinity', { min: 0, max: 1 }), /finite/, 'non-finite --alpha');
  rejects(() => parseNum('--alpha', '2', { min: 0, max: 1 }), /<=/, 'out-of-range --alpha');
  // --ratio must be strictly inside (0,1) — 0 or 1 is a degenerate empty-train/all-held split.
  rejects(() => validateRatio('0'), /between 0 and 1/, '--ratio 0');
  rejects(() => validateRatio('1'), /between 0 and 1/, '--ratio 1');
  eq(validateRatio('0.5'), 0.5, 'valid --ratio passes through');
  // --help/-h/help + --version/-V are recognized before parseArgs, so they never throw "Unknown option".
  eq(wantsHelp(['--help']), true, '--help recognized');
  eq(wantsHelp(['-h']), true, '-h recognized');
  eq(wantsHelp(['help']), true, 'help subcommand recognized');
  eq(wantsHelp(['attack', '--suite', 'x.json']), false, 'real command is not treated as help');
  eq(wantsVersion(['--version']), true, '--version recognized');
  eq(wantsVersion(['-V']), true, '-V recognized');
  // usage block is real and lists commands (exactly what --help prints before exit 0).
  const u = usageText();
  eq(u[0].startsWith('usage'), true, 'usage starts with "usage"');
  eq(u.some((l) => /audit/.test(l)) && u.some((l) => /attack/.test(l)), true, 'usage lists commands');
  // mutually-exclusive inputs throw instead of silently preferring one.
  rejects(() => assertExclusiveInputs('attack', { tools: 't.json', suite: 's.json' }), /not both/, '--tools + --suite');
  accepts(() => assertExclusiveInputs('attack', { tools: 't.json' }), '--tools alone is fine');
  accepts(() => assertExclusiveInputs('attack', { suite: 's.json' }), '--suite alone is fine');
  rejects(() => assertExclusiveInputs('multiseed', { reports: 'a,b', seeds: '1,2' }), /not both/, '--reports + --seeds');
  console.log('cli selfcheck OK — parseNum rejects NaN/frac/out-of-range; --help/-h/help + --version/-V recognized; --tools+--suite and --reports+--seeds rejected');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '__selfcheck') { runCliSelfcheck(); return; }
  if (wantsHelp(argv)) { printUsage(); process.exit(0); }
  if (wantsVersion(argv)) { console.log(LOOPWARD_VERSION); process.exit(0); }

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      suite: { type: 'string', short: 's' },
      provider: { type: 'string', short: 'p', default: 'mock' },
      model: { type: 'string', short: 'm' },
      'base-url': { type: 'string' },
      seed: { type: 'string', default: '42' },
      out: { type: 'string', short: 'o' },
      report: { type: 'string', short: 'r' },
      variant: { type: 'string', short: 'v', default: 'single' },
      tools: { type: 'string', short: 't' },
      strategies: { type: 'string' },
      ratio: { type: 'string' },
      'fail-under': { type: 'string' },
      'fail-on-high': { type: 'boolean' },
      // gate
      baseline: { type: 'string' },
      tolerance: { type: 'string' },
      alpha: { type: 'string' },
      unpaired: { type: 'boolean' },
      'allow-schema-change': { type: 'boolean' },
      // audit sarif
      sarif: { type: 'string' },
      // mcp-tools
      server: { type: 'string' },
      from: { type: 'string' },
      protocol: { type: 'string' },
      timeout: { type: 'string' },
      // multiseed
      seeds: { type: 'string' },
      reports: { type: 'string' },
      // stop-axis
      'stop-axis': { type: 'boolean' },
      'fail-on-fragile': { type: 'boolean' },
      // output
      json: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
    },
  });
  if (values.json) VIEW = 'json';
  else if (values.quiet) VIEW = 'quiet';
  const cmd = positionals[0];
  if (!cmd || cmd === 'interactive') {
    // In a pipe/CI (no TTY) a bare `loopward` would block on prompts forever — print usage and exit 0.
    if (!cmd && !process.stdin.isTTY) { printUsage(); process.exit(0); }
    await cmdInteractive();
    return;
  }
  assertExclusiveInputs(cmd, values);
  const seed = parseNum('--seed', values.seed!, { int: true });
  const timeoutMs = values.timeout !== undefined ? parseNum('--timeout', values.timeout, { int: true, min: 1 }) : undefined;
  const po: ProviderOpts = { model: values.model, baseURL: values['base-url'], timeoutMs };
  const variant = values.variant as Variant;
  if (!['single', 'self-check', 'react', 'observe'].includes(variant)) throw new Error(`--variant must be single|self-check|react|observe, got ${variant}`);
  if (!values.suite && cmd === 'run') throw new Error('--suite <file.json> is required');
  if (!values.suite && !values.tools && cmd === 'attack') throw new Error('attack needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'fix') throw new Error('fix needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'matrix') throw new Error('matrix needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'flywheel') throw new Error('flywheel needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && cmd === 'multi') throw new Error('multi needs --suite <tasks.json>');
  if (cmd === 'multiseed' && !values.reports && !((values.suite || values.tools) && values.seeds)) throw new Error('multiseed needs --reports <a,b,c> (aggregate saved reports) OR --suite|--tools with --seeds 1,2,3 (run)');

  const failUnder = values['fail-under'] !== undefined ? parseNum('--fail-under', values['fail-under']) : undefined;
  const alpha = values.alpha !== undefined ? parseNum('--alpha', values.alpha, { min: 0, max: 1 }) : 0.05;

  if (cmd === 'run') await cmdRun(values.suite!, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'attack') await cmdAttack(values.suite, values.tools, values.provider!, seed, values.out, po, variant, failUnder);
  else if (cmd === 'multi') {
    if (values['stop-axis']) {
      if (failUnder !== undefined) console.error('note: --fail-under is ignored with --stop-axis; gate the stop axis with --fail-on-fragile');
      await cmdStopAxis(values.suite!, values.provider!, seed, values.out, po, !!values['fail-on-fragile'], alpha);
    } else await cmdMulti(values.suite!, values.provider!, seed, values.out, po, failUnder);
  }
  else if (cmd === 'fix') await cmdFix(values.suite, values.tools, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'matrix') await cmdMatrix(values.suite, values.tools, values.provider!, seed, values.out, po, values.strategies);
  else if (cmd === 'flywheel') await cmdFlywheel(values.suite, values.tools, values.provider!, seed, values.ratio !== undefined ? validateRatio(values.ratio) : 0.5, values.out, po);
  else if (cmd === 'multiseed') await cmdMultiseed(values.suite, values.tools, values.provider!, values.seeds, values.reports, variant, values.out, po, alpha, failUnder);
  else if (cmd === 'gate') { const cur = values.report ?? positionals[1]; if (!values.baseline || !cur) throw new Error('gate needs --baseline <base.json> and --report <current.json>'); cmdGate(values.baseline, cur, { tolerance: values.tolerance !== undefined ? parseNum('--tolerance', values.tolerance) : undefined, alpha, unpaired: !!values.unpaired, allowSchemaChange: !!values['allow-schema-change'] }); }
  else if (cmd === 'mcp-tools') await cmdMcpTools(values.server, values.from, values.out, { protocol: values.protocol, timeout: timeoutMs });
  else if (cmd === 'audit') { if (!values.tools) throw new Error('--tools <schema.json> is required'); cmdAudit(values.tools, values['fail-on-high'], values.sarif, values.out); }
  else if (cmd === 'verify') { const path = values.report ?? positionals[1]; if (!path) throw new Error('verify needs --report <report.json>'); cmdVerify(path); }
  else if (cmd === 'stats') { const path = values.report ?? positionals[1]; if (!path) throw new Error('stats needs --report <attack-report.json>'); cmdStats(path, alpha); }
  else if (cmd === 'coevo') {
    if (!values.report) throw new Error('--report <attack-report.json> is required');
    await cmdCoevo(values.report, values.out ?? 'coevo-out');
  } else {
    printUsage((s) => console.error(s));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
