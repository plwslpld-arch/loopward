#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoutingCase } from '../../core/src/types.ts';
import { getProvider } from '../../core/src/provider.ts';
import { runSuite, type Variant } from '../../core/src/loop.ts';
import { runMultistepSuite, type MultistepTask } from '../../core/src/multistep.ts';
import { loadTools, auditConfusability } from '../../core/src/tools.ts';
import { runAttacks, type AttackReport } from '../../redteam/src/attack-run.ts';
import { buildExport, toFiles } from '../../coevo/src/export.ts';

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

async function cmdAttack(suite: string, provider: string, seed: number, out: string | undefined, po: ProviderOpts, variant: Variant) {
  const cases = loadSuite(suite);
  const rep = await runAttacks(cases, getProvider(provider, po), seed, undefined, variant);
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

async function cmdMulti(suite: string, provider: string, seed: number, out: string | undefined, po: ProviderOpts) {
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
}

function cmdAudit(toolsPath: string) {
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
    },
  });
  const cmd = positionals[0];
  const seed = Number(values.seed);
  const po: ProviderOpts = { model: values.model, baseURL: values['base-url'] };
  const variant = values.variant as Variant;
  if (variant !== 'single' && variant !== 'self-check') throw new Error(`--variant must be single|self-check, got ${variant}`);
  if (!values.suite && (cmd === 'run' || cmd === 'attack')) throw new Error('--suite <file.json> is required');

  if (cmd === 'run') await cmdRun(values.suite!, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'attack') await cmdAttack(values.suite!, values.provider!, seed, values.out, po, variant);
  else if (cmd === 'multi') await cmdMulti(values.suite!, values.provider!, seed, values.out, po);
  else if (cmd === 'audit') { if (!values.tools) throw new Error('--tools <schema.json> is required'); cmdAudit(values.tools); }
  else if (cmd === 'coevo') {
    if (!values.report) throw new Error('--report <attack-report.json> is required');
    await cmdCoevo(values.report, values.out ?? 'coevo-out');
  } else {
    console.error('usage:');
    console.error('  loopbench run    --suite <f.json> [--provider mock|deepseek|openai] [--model M] [--variant single|self-check] [--seed 42] [--out f]');
    console.error('  loopbench attack --suite <f.json> [--provider mock|deepseek|openai] [--model M] [--variant single|self-check] [--seed 42] [--out f]');
    console.error('  loopbench multi  --suite <tasks.json> [--provider mock|deepseek|openai] [--model M] [--seed 42] [--out f]');
    console.error('  loopbench audit  --tools <schema.json>   (bring your own tools; no model calls)');
    console.error('  loopbench coevo  --report <attack-report.json> [--out coevo-out]');
    console.error('  keys via env: DEEPSEEK_API_KEY | OPENAI_API_KEY (+ OPENAI_BASE_URL, OPENAI_MODEL)');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
