// node packages/eval/src/selfcheck.ts — exits non-zero on failure. Offline via mockProvider.
import assert from 'node:assert/strict';
import type { RoutingCase } from '../../core/src/types.ts';
import { mockProvider } from '../../core/src/provider.ts';
import { toolSchemaHash } from '../../core/src/manifest.ts';
import { runAttacks } from '../../redteam/src/attack-run.ts';
import { verifyReport } from './verify.ts';

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
