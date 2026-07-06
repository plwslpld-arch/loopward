// node scripts/regenerate-all.mjs [K]
// Re-runs the offline mock pipeline K times, verifies every fresh report, PROVES determinism by
// deep-equality of the numbers across runs (stronger than a range<=eps gate, which is a tautology on
// a deterministic provider), reports observed run-to-run variance per headline metric, and rebuilds
// the dashboard. On a live provider the variance table would surface non-zero jitter.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';

const K = Number(process.argv[2] ?? 3);
const dir = 'runs/_regen';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const run = (args) => {
  const r = spawnSync('node', args, { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  return r;
};

const reports = [];
for (let k = 0; k < K; k++) {
  const out = `${dir}/run-${k}.json`;
  run(['packages/cli/src/cli.ts', 'attack', '--suite', 'datasets/routing/sample.json', '--provider', 'mock', '--seed', '42', '--out', out]);
  run(['packages/cli/src/cli.ts', 'verify', '--report', out]); // exits non-zero unless the report verifies
  reports.push(JSON.parse(readFileSync(out, 'utf8')));
}

// compare the numbers only (manifest git_sha/timestamp legitimately differ per invocation)
const numbers = (r) => { const { manifest, ...rest } = r; return rest; };
const base = JSON.stringify(numbers(reports[0]));
const identical = reports.every((r) => JSON.stringify(numbers(r)) === base);

console.log(`regenerated ${K} mock runs; every report verified.`);
console.log(`determinism: ${identical ? 'PASS — all runs byte-identical (numbers)' : 'FAIL — runs diverged'}\n`);

const metric = (r, n) => (n === 'clean' ? r.clean_accuracy : r.attacks.find((a) => a.attack === n).robustness_delta.delta);
const names = ['clean', ...reports[0].attacks.map((a) => a.attack)];
console.log('metric                   min      max      range');
for (const n of names) {
  const xs = reports.map((r) => metric(r, n));
  const lo = Math.min(...xs), hi = Math.max(...xs);
  console.log(`${n.padEnd(22)} ${lo.toFixed(4)}  ${hi.toFixed(4)}  ${(hi - lo).toFixed(4)}`);
}

run(['packages/dashboard/build.mjs']);
console.log('\nrebuilt dashboard (index.html) from current data.json.');
process.exit(identical ? 0 : 1);
