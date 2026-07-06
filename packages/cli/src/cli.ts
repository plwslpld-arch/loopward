#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoutingCase } from '../../core/src/types.ts';
import { getProvider } from '../../core/src/provider.ts';
import { runSuite } from '../../core/src/loop.ts';
import { runAttacks } from '../../redteam/src/attack-run.ts';

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

async function cmdRun(suite: string, provider: string, seed: number, out?: string) {
  const cases = loadSuite(suite);
  const summary = await runSuite(cases, getProvider(provider), seed);
  const outPath = out ?? `runs/${summary.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, summary.trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log(`provider=${summary.provider} seed=${seed}`);
  console.log(`clean routing accuracy: ${summary.correct}/${summary.total} = ${pct(summary.accuracy)}`);
  console.log(`trajectories → ${outPath}`);
}

async function cmdAttack(suite: string, provider: string, seed: number, out?: string) {
  const cases = loadSuite(suite);
  const rep = await runAttacks(cases, getProvider(provider), seed);
  const outPath = out ?? `runs/attack-${rep.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rep, null, 2));

  console.log(`provider=${rep.provider} seed=${seed}  n=${rep.total}`);
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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      suite: { type: 'string', short: 's' },
      provider: { type: 'string', short: 'p', default: 'mock' },
      seed: { type: 'string', default: '42' },
      out: { type: 'string', short: 'o' },
    },
  });
  const cmd = positionals[0];
  const seed = Number(values.seed);
  if (!values.suite && (cmd === 'run' || cmd === 'attack')) throw new Error('--suite <file.json> is required');

  if (cmd === 'run') await cmdRun(values.suite!, values.provider!, seed, values.out);
  else if (cmd === 'attack') await cmdAttack(values.suite!, values.provider!, seed, values.out);
  else {
    console.error('usage:');
    console.error('  loopbench run    --suite <file.json> [--provider mock|deepseek] [--seed 42] [--out trace.jsonl]');
    console.error('  loopbench attack --suite <file.json> [--provider mock|deepseek] [--seed 42] [--out report.json]');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
