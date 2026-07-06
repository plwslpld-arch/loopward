// node packages/eval/src/selfcheck.ts — exits non-zero on failure. Offline via mockProvider.
import assert from 'node:assert/strict';
import type { RoutingCase } from '../../core/src/types.ts';
import { mockProvider } from '../../core/src/provider.ts';
import { toolSchemaHash } from '../../core/src/manifest.ts';
import { runAttacks } from '../../redteam/src/attack-run.ts';
import { verifyReport } from './verify.ts';
import { harnessMatrix } from './harness-portability/harness-matrix.ts';

const suite: RoutingCase[] = [
  { id: 'a', intent: 'What is the weather in Tokyo', candidates: ['get_weather', 'get_forecast', 'get_air_quality'], ground_truth: 'get_weather' },
  { id: 'b', intent: 'Email the report to Sarah', candidates: ['send_email', 'send_slack_message'], ground_truth: 'send_email' },
  { id: 'c', intent: 'Convert 100 USD to EUR', candidates: ['convert_currency', 'get_stock_price'], ground_truth: 'convert_currency' },
];

const rep = await runAttacks(suite, mockProvider, 42);
assert.equal(verifyReport(rep).pass, true, 'clean report should verify');
assert.equal(rep.manifest.tool_schema_hash, toolSchemaHash([...new Set(suite.flatMap((c) => c.candidates))]));

// hash is order-independent and dedup-stable
assert.equal(toolSchemaHash(['b', 'a']), toolSchemaHash(['a', 'b', 'a']));

// library manifest is deterministic (fixed epoch timestamp + git 'unknown', no wall-clock)
const rep2 = await runAttacks(suite, mockProvider, 42);
assert.deepEqual(rep.manifest, rep2.manifest, 'library manifest must be byte-stable');

// tamper tests: each corruption must be caught by a specific check
const clone = () => JSON.parse(JSON.stringify(rep));
let t = clone(); t.clean_accuracy += 0.5;
assert.equal(verifyReport(t).pass, false, 'bumped clean_accuracy must fail');
t = clone(); t.manifest.tool_schema_hash = 'deadbeefdeadbeef';
assert.equal(verifyReport(t).pass, false, 'corrupt hash must fail');
t = clone(); t.attacks[0].robustness_delta.delta += 0.1;
assert.equal(verifyReport(t).pass, false, 'nudged CI must fail');
t = clone();
const acol = t.attacks[0].attack;
t.matrix[0][acol] = t.matrix[0][acol] ? 0 : 1;
assert.equal(verifyReport(t).pass, false, 'flipped matrix bit must fail');

console.log(`selfcheck OK — verify passes clean report (hash ${rep.manifest.tool_schema_hash}), rejects 4 tampered fields`);

// harness-matrix: 4 strategies on a fixed model, per-strategy accuracy + case-paired deltas, deterministic
const hm = await harnessMatrix(suite, mockProvider, 42);
assert.equal(hm.strategies.length, 4);
assert.equal(hm.per_strategy.length, 4);
assert.equal(hm.deltas.length, 3, 'best vs each of the other three strategies');
assert.ok(['single', 'self-check', 'react', 'observe'].includes(hm.best));
for (const r of hm.per_strategy) { assert.ok(r.attacked >= 0 && r.attacked <= 1); assert.ok(r.clean >= 0 && r.clean <= 1); }
for (const d of hm.deltas) assert.ok(d.delta.lo <= d.delta.delta && d.delta.delta <= d.delta.hi, 'CI brackets the point delta');
const hm2 = await harnessMatrix(suite, mockProvider, 42);
assert.deepEqual(hm, hm2, 'harness-matrix must be deterministic under a deterministic provider');
console.log(`selfcheck OK — harness-matrix: ${hm.strategies.join('/')}; most robust = ${hm.best}`);
