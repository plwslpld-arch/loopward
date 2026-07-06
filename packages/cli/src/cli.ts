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
      'fail-under': { type: 'string' },
      'fail-on-high': { type: 'boolean' },
    },
  });
  const cmd = positionals[0];
  if (!cmd || cmd === 'interactive') { await cmdInteractive(); return; }
  const seed = Number(values.seed);
  const po: ProviderOpts = { model: values.model, baseURL: values['base-url'] };
  const variant = values.variant as Variant;
  if (variant !== 'single' && variant !== 'self-check') throw new Error(`--variant must be single|self-check, got ${variant}`);
  if (!values.suite && cmd === 'run') throw new Error('--suite <file.json> is required');
  if (!values.suite && !values.tools && cmd === 'attack') throw new Error('attack needs --suite <file.json> or --tools <schema.json>');
  if (!values.suite && !values.tools && cmd === 'fix') throw new Error('fix needs --suite <file.json> or --tools <schema.json>');

  const failUnder = values['fail-under'] !== undefined ? Number(values['fail-under']) : undefined;

  if (cmd === 'run') await cmdRun(values.suite!, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'attack') await cmdAttack(values.suite, values.tools, values.provider!, seed, values.out, po, variant, failUnder);
  else if (cmd === 'multi') await cmdMulti(values.suite!, values.provider!, seed, values.out, po, failUnder);
  else if (cmd === 'fix') await cmdFix(values.suite, values.tools, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'audit') { if (!values.tools) throw new Error('--tools <schema.json> is required'); cmdAudit(values.tools, values['fail-on-high']); }
  else if (cmd === 'verify') { const path = values.report ?? positionals[1]; if (!path) throw new Error('verify needs --report <report.json>'); cmdVerify(path); }
  else if (cmd === 'coevo') {
    if (!values.report) throw new Error('--report <attack-report.json> is required');
    await cmdCoevo(values.report, values.out ?? 'coevo-out');
  } else {
    console.error('usage:  loopward <command>   (run with no command for interactive mode)');
    console.error('  audit  --tools <schema.json>                      confusable tool names, no key, instant');
    console.error('  attack --tools <schema.json> | --suite <f.json>   6 red-team attacks + robustness CI');
    console.error('  fix    --tools <schema.json> | --suite <f.json>   propose renames, re-verify the delta');
    console.error('  multi  --suite <tasks.json>                       multi-step loop: stop / over-run / success');
    console.error('  coevo  --report <attack-report.json>              misroutes → DPO / reward / SFT data');
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
