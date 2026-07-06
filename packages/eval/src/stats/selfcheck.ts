// node packages/eval/src/stats/selfcheck.ts — offline via mockProvider, exits non-zero on failure.
import assert from 'node:assert/strict';
import type { RoutingCase } from '../../../core/src/types.ts';
import { mockProvider } from '../../../core/src/provider.ts';
import { runAttacks } from '../../../redteam/src/attack-run.ts';
import { holm, permutationPValue, pairedEffectSize, correctAttacks } from './multiseed.ts';

// Holm: exact corrected values ([.01,.04,.03] -> [.03,.06,.06]; the .04 is pulled up to .06 by the
// running max — the spec's [.03,.04,.06] was wrong and would certify a broken step-down).
const raw = [0.01, 0.04, 0.03];
const h = holm(raw);
assert.deepEqual(h.map((x) => +x.toFixed(4)), [0.03, 0.06, 0.06]);
for (let i = 0; i < raw.length; i++) assert.ok(h[i] >= raw[i] - 1e-12, 'adjusted >= raw');
const ord = raw.map((_, i) => i).sort((a, b) => raw[a] - raw[b]);
for (let k = 1; k < ord.length; k++) assert.ok(h[ord[k]] >= h[ord[k - 1]] - 1e-12, 'Holm monotone in ascending-p order');

// permutation p: deterministic; 1 when there is no separation; small under full separation
assert.equal(permutationPValue([1, 1, 1, 1], [1, 1, 1, 1]), 1);
assert.equal(permutationPValue([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0]),
  permutationPValue([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0]), 'deterministic');
assert.ok(permutationPValue([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0]) < 0.05, 'clear effect is significant');

// effect size: 0 for identical, positive when clean beats attack
assert.equal(pairedEffectSize([1, 1, 1], [1, 1, 1]), 0);
assert.ok(pairedEffectSize([1, 1, 1, 0], [0, 0, 0, 0]) > 0);

// end-to-end on a real mock report: correction never shrinks a p below its raw value
const suite: RoutingCase[] = [
  { id: 'a', intent: 'What is the weather in Tokyo', candidates: ['get_weather', 'get_forecast', 'get_air_quality'], ground_truth: 'get_weather' },
  { id: 'b', intent: 'Email the report to Sarah', candidates: ['send_email', 'send_slack_message'], ground_truth: 'send_email' },
  { id: 'c', intent: 'Convert 100 USD to EUR', candidates: ['convert_currency', 'get_stock_price'], ground_truth: 'convert_currency' },
];
const c = correctAttacks(await runAttacks(suite, mockProvider, 42));
assert.equal(c.attacks.length, 6);
for (const a of c.attacks) {
  assert.ok(a.p_holm >= a.p - 1e-12, 'Holm never shrinks p below raw');
  assert.equal(typeof a.significant, 'boolean');
  assert.ok(a.ci.lo <= a.delta && a.delta <= a.ci.hi, 'CI brackets the point delta');
}
console.log(`stats selfcheck OK — holm/permutation/dz; ${c.attacks.filter((a) => a.significant).length}/6 attacks significant after Holm`);
