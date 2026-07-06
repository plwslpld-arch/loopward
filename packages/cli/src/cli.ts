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
import { runAttacks, type AttackReport } from '../../redteam/src/attack-run.ts';
import { runFix } from '../../redteam/src/fix.ts';
import { buildExport, toFiles } from '../../coevo/src/export.ts';
import { gitSha, type StampInput } from '../../core/src/manifest.ts';
import { verifyReport, formatVerify } from '../../eval/src/verify.ts';
import { harnessMatrix, DEFAULT_STRATEGIES } from '../../eval/src/harness-portability/harness-matrix.ts';
import { runFlywheel } from '../../coevo/experiments/micro-loop/flywheel.ts';
import { correctAttacks } from '../../eval/src/stats/multiseed.ts';

function loadSuite(path: string): RoutingCase[] {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const cases: RoutingCase[] = Array.isArray(data) ? data : data.cases;
  if (!Array.isArray(cases)) throw new Error(`suite ${path}: expected an array of cases (or { cases: [...] })`);
  for (const c of cases) {
    if (!c.id || !c.intent || !Array.isArray(c.candidates) || !c.ground_truth)
      throw new Error(`suite ${path}: bad case ${JSON.stringify(c).slice(0, 80)}`);
    if (!c.candidates.includes(c.ground_truth))
      throw new Error(`suite ${path}: case ${c.id} ground_truth "${c.ground_truth}" not in candidates`);
  }
  return cases;
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const pp = (x: number) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'pp';

interface ProviderOpts { model?: string; baseURL?: string }

// wall-clock time + git enter ONLY here, at the CLI boundary — never in library code or self-checks.
const stamp = (): StampInput => ({ timestamp: new Date().toISOString(), git_sha: gitSha() });

async function cmdRun(suite: string, provider: string, seed: number, out: string | undefined, po: ProviderOpts, variant: Variant) {
  const cases = loadSuite(suite);
  const summary = await runSuite(cases, getProvider(provider, po), seed, variant);
  const outPath = out ?? `runs/${summary.provider.replace(/[^\w.-]/g, '_')}-${variant}-seed${seed}.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, summary.trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n');
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

  if (failUnder !== undefined) {
    const worst = rep.attacks.reduce((m, a) => Math.min(m, a.accuracy), 1);
    const worstAttack = rep.attacks.find((a) => a.accuracy === worst);
    if (worst * 100 < failUnder) {
      console.error(`\nFAIL: worst attacked accuracy ${pct(worst)} (${worstAttack?.attack}) is under --fail-under ${failUnder}%`);
      process.exit(1);
    }
    console.log(`gate ok: worst attacked accuracy ${pct(worst)} >= ${failUnder}%`);
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

  console.log(`\nprovider=${rep.provider} variant=${variant} seed=${seed}`);
  if (!rep.renames.length) {
    console.log('\nno HIGH-risk confusable names to fix — routing is already unambiguous by name.');
    console.log(`report → ${outPath}`);
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

  console.log(`provider=${sum.provider} seed=${seed}  n=${sum.total} (multi-step loop)`);
  console.log(`task success:      ${pct(sum.success_rate)}`);
  console.log(`premature-stop:    ${pct(sum.premature_stop_rate)}`);
  console.log(`over-run:          ${pct(sum.over_run_rate)}`);
  console.log(`avg extra calls:   ${sum.avg_extra_calls.toFixed(2)}`);
  console.log(`results → ${outPath}`);

  if (failUnder !== undefined) {
    if (sum.success_rate * 100 < failUnder) {
      console.error(`\nFAIL: multi-step success ${pct(sum.success_rate)} is under --fail-under ${failUnder}%`);
      process.exit(1);
    }
    console.log(`gate ok: multi-step success ${pct(sum.success_rate)} >= ${failUnder}%`);
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

  console.log(`\nprovider=${rep.provider} seed=${seed}  n=${rep.n_cases}  (harness strategies on a FIXED model)\n`);
  console.log('strategy        clean    attacked');
  console.log('─'.repeat(38));
  for (const r of rep.per_strategy) console.log(`${r.strategy.padEnd(14)} ${pct(r.clean).padStart(6)}  ${pct(r.attacked).padStart(8)}`);
  console.log(`\nmost robust harness: ${rep.best}. delta vs the others (case-paired, 95% CI):`);
  for (const d of rep.deltas) console.log(`  ${d.a} − ${d.b}:  ${pp(d.delta.delta)}  [${pp(d.delta.lo)}, ${pp(d.delta.hi)}]`);
  console.log(`\n${rep.note}`);
  console.log(`report → ${outPath}`);
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

  console.log(`\nprovider=${r.provider} seed=${seed}  split ${r.n_train} train / ${r.n_held} held (ratio ${r.ratio})`);
  console.log(`\nguardrail (activated by TRAIN injections):\n  ${r.guardrail.replace(/\n/g, '\n  ') || '(none — no injection misroutes in TRAIN)'}`);
  console.log(`\nheld-out injection subset (${r.addressable_attacks.join(', ')}):`);
  console.log(`  accuracy  ${pct(r.before_accuracy)} → ${pct(r.after_accuracy)}`);
  console.log(`  lift      ${pp(r.lift.delta)}${r.ci_valid ? `  [${pp(r.lift.lo)}, ${pp(r.lift.hi)}]` : '  (held set too small for a CI)'}`);
  console.log(`  (all six attacks, pooled: ${pct(r.pooled_before)} → ${pct(r.pooled_after)})`);
  console.log(`\n${r.note}`);
  console.log(`receipt → ${outPath}`);
}

function cmdStats(reportPath: string) {
  const rep = JSON.parse(readFileSync(reportPath, 'utf8')) as AttackReport;
  const c = correctAttacks(rep);
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

function cmdAudit(toolsPath: string, failOnHigh?: boolean) {
  const tools = loadTools(toolsPath);
  const pairs = auditConfusability(tools);
  console.log(`audited ${tools.length} tools, found ${pairs.length} confusable pair(s) (no model calls)\n`);
  if (!pairs.length) { console.log('no obviously confusable tool pairs. nice catalog.'); return; }
  console.log('risk   pair                                        shared');
  console.log('─'.repeat(70));
  for (const p of pairs) {
    const risk = p.score >= 0.5 ? 'HIGH' : p.score >= 0.34 ? 'med ' : 'low ';
    const pair = `${p.a} ~ ${p.b}`;
    console.log(`${risk}  ${pair.slice(0, 42).padEnd(42)}  ${p.sharedTokens.join(', ') || '(similar descriptions)'}`);
  }
  console.log(`\nthese pairs are the ones a router is most likely to mix up. rename, merge, or disambiguate descriptions.`);
  const high = pairs.filter((p) => p.score >= 0.5);
  if (failOnHigh && high.length) {
    console.error(`\nFAIL: ${high.length} HIGH-risk confusable pair(s) with --fail-on-high set`);
    process.exit(1);
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

async function main() {
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
    },
  });
  const cmd = positionals[0];
  if (!cmd || cmd === 'interactive') { await cmdInteractive(); return; }
  const seed = Number(values.seed);
  const po: ProviderOpts = { model: values.model, baseURL: values['base-url'] };
  const variant = values.variant as Variant;
  if (!['single', 'self-check', 'react', 'observe'].includes(variant)) throw new Error(`--variant must be single|self-check|react|observe, got ${variant}`);
  if (!values.suite && cmd === 'run') throw new Error('--suite <file.json> is required');
  if (!values.suite && !values.tools && cmd === 'attack') throw new Error('attack needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'fix') throw new Error('fix needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'matrix') throw new Error('matrix needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'flywheel') throw new Error('flywheel needs --suite <file.json> or --tools <schema.json>');

  const failUnder = values['fail-under'] !== undefined ? Number(values['fail-under']) : undefined;

  if (cmd === 'run') await cmdRun(values.suite!, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'attack') await cmdAttack(values.suite, values.tools, values.provider!, seed, values.out, po, variant, failUnder);
  else if (cmd === 'multi') await cmdMulti(values.suite!, values.provider!, seed, values.out, po, failUnder);
  else if (cmd === 'fix') await cmdFix(values.suite, values.tools, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'matrix') await cmdMatrix(values.suite, values.tools, values.provider!, seed, values.out, po, values.strategies);
  else if (cmd === 'flywheel') await cmdFlywheel(values.suite, values.tools, values.provider!, seed, values.ratio !== undefined ? Number(values.ratio) : 0.5, values.out, po);
  else if (cmd === 'audit') { if (!values.tools) throw new Error('--tools <schema.json> is required'); cmdAudit(values.tools, values['fail-on-high']); }
  else if (cmd === 'verify') { const path = values.report ?? positionals[1]; if (!path) throw new Error('verify needs --report <report.json>'); cmdVerify(path); }
  else if (cmd === 'stats') { const path = values.report ?? positionals[1]; if (!path) throw new Error('stats needs --report <attack-report.json>'); cmdStats(path); }
  else if (cmd === 'coevo') {
    if (!values.report) throw new Error('--report <attack-report.json> is required');
    await cmdCoevo(values.report, values.out ?? 'coevo-out');
  } else {
    console.error('usage:  loopward <command>   (run with no command for interactive mode)');
    console.error('  audit  --tools <schema.json>                      confusable tool names, no key, instant');
    console.error('  attack --tools <schema.json> | --suite <f.json>   6 red-team attacks + robustness CI');
    console.error('  fix    --tools <schema.json> | --suite <f.json>   propose renames, re-verify the delta');
    console.error('  matrix --tools <schema.json> | --suite <f.json>   compare loop strategies on a fixed model');
    console.error('  multi  --suite <tasks.json>                       multi-step loop: stop / over-run / success');
    console.error('  coevo  --report <attack-report.json>              misroutes → DPO / reward / SFT data');
    console.error('  flywheel --tools <schema.json> | --suite <f.json> train guardrail, re-measure held-out lift');
    console.error('  stats  --report <attack-report.json>              Holm-corrected significance across the 6 attacks');
    console.error('  verify --report <report.json>                     re-check a report\'s deterministic fields, offline');
    console.error('  run    --suite <f.json>                           clean routing accuracy only');
    console.error(`  common: [--provider ${PROVIDER_NAMES.join('|')}] [--model M] [--base-url URL] [--seed 42] [--out f]`);
    console.error('  keys via env, one per provider: OPENAI_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, DMXAPI_API_KEY, ...');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
