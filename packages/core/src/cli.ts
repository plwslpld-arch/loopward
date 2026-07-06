#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoutingCase } from './types.ts';
import { getProvider } from './provider.ts';
import { runSuite } from './loop.ts';

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
  if (cmd !== 'run') {
    console.error('usage: loopbench run --suite <file.json> [--provider mock|deepseek] [--seed 42] [--out trace.jsonl]');
    process.exit(1);
  }
  if (!values.suite) throw new Error('--suite <file.json> is required');

  const seed = Number(values.seed);
  const cases = loadSuite(values.suite);
  const summary = await runSuite(cases, getProvider(values.provider!), seed);

  const outPath = values.out ?? `runs/${summary.provider.replace(/[^\w.-]/g, '_')}-seed${seed}.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, summary.trajectories.map((t) => JSON.stringify(t)).join('\n') + '\n');

  const pct = (summary.accuracy * 100).toFixed(1);
  console.log(`provider=${summary.provider} seed=${seed}`);
  console.log(`clean routing accuracy: ${summary.correct}/${summary.total} = ${pct}%`);
  console.log(`trajectories → ${outPath}`);
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
