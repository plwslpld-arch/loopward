// `node src/selfcheck.ts` — exits non-zero on failure.
import assert from 'node:assert/strict';
import type { RoutingCase } from '../../core/src/types.ts';
import { mockProvider } from '../../core/src/provider.ts';
import { ATTACKS, getAttack } from './attacks.ts';
import { bootstrapDeltaCI } from './metrics.ts';
import { runAttacks } from './attack-run.ts';
import { runFix } from './fix.ts';
import { assertMeaningPreserved, MeaningPreservationError, guardRecall, loadGoldSlice } from './oracle-guard.ts';

// every attack preserves ground_truth and keeps it in the candidate list
const c: RoutingCase = { id: 't', intent: 'What is the weather in Tokyo', candidates: ['get_weather', 'get_forecast'], ground_truth: 'get_weather' };
for (const a of ATTACKS) {
  const out = a.apply(c);
  assert.equal(out.ground_truth, c.ground_truth, `${a.name} changed ground_truth`);
  assert.ok(out.candidates.includes(c.ground_truth), `${a.name} dropped ground_truth from candidates`);
}

// boundary_blur inserts a decoy before the ground truth
const blurred = getAttack('boundary_blur').apply(c);
assert.equal(blurred.candidates.indexOf('fetch_weather'), blurred.candidates.indexOf('get_weather') - 1);

// bootstrap CI is deterministic and brackets the point estimate
const clean = [1, 1, 1, 1];
const attacked = [1, 0, 0, 0];
const ci1 = bootstrapDeltaCI(clean, attacked, 42);
const ci2 = bootstrapDeltaCI(clean, attacked, 42);
assert.deepEqual(ci1, ci2);
assert.ok(Math.abs(ci1.delta - 0.75) < 1e-9);
assert.ok(ci1.lo <= ci1.delta && ci1.delta <= ci1.hi);

// end-to-end: attacks measurably drop accuracy on the mock
const suite: RoutingCase[] = [
  { id: 'a', intent: 'What is the weather in Tokyo', candidates: ['get_weather', 'get_forecast', 'get_air_quality'], ground_truth: 'get_weather' },
  { id: 'b', intent: 'Email the report to Sarah', candidates: ['send_email', 'send_slack_message'], ground_truth: 'send_email' },
  { id: 'c', intent: 'Convert 100 USD to EUR', candidates: ['convert_currency', 'get_stock_price'], ground_truth: 'convert_currency' },
];
const rep = await runAttacks(suite, mockProvider, 42);
assert.equal(rep.attacks.length, 6);
assert.equal(rep.matrix.length, 3);
const worst = Math.max(...rep.attacks.map((a) => a.robustness_delta.delta));
assert.ok(worst > 0, 'expected at least one attack to reduce accuracy');

console.log(`selfcheck OK — clean=${(rep.clean_accuracy * 100).toFixed(0)}%, worst attack delta=${(worst * 100).toFixed(0)}pp`);

// fix: proposes a rename for confusable tools and re-verifies deterministically (no model needed)
const fixTools = [
  { name: 'get_status', description: 'Get the current status of a service or job.' },
  { name: 'fetch_status', description: 'Fetch the latest status for a given resource.' },
  { name: 'send_email', description: 'Send an email message to a recipient.' },
];
const cand = fixTools.map((t) => t.name);
const fixCases: RoutingCase[] = [
  { id: 'get_status', intent: 'check the current status of my running job', candidates: cand, ground_truth: 'get_status' },
  { id: 'fetch_status', intent: 'fetch the latest status for that resource', candidates: cand, ground_truth: 'fetch_status' },
  { id: 'send_email', intent: 'email the report to Sarah', candidates: cand, ground_truth: 'send_email' },
];
const fixRep = await runFix(fixTools, fixCases, mockProvider, 42);
assert.ok(fixRep.renames.length >= 1, 'fix should rename a confusable pair');
assert.equal(fixRep.after.attacks.length, 6, 'fix re-verify should run all attacks');
assert.ok(Number.isFinite(fixRep.recovered_pp), 'fix should report numeric recovered_pp');
const renamed = fixRep.renames[0];
assert.notEqual(renamed.to, renamed.from, 'rename should change the name');
assert.match(renamed.to, /^[a-z0-9_]+$/, 'rename should be a clean snake_case identifier');
console.log(`selfcheck OK — fix renamed ${fixRep.renames.length} pair(s), ${renamed.from}→${renamed.to}, ${fixRep.recovered_pp >= 0 ? '+' : ''}${fixRep.recovered_pp}pp on ${fixRep.worst_attack}`);

// oracle-guard: all 6 shipped attacks satisfy the structural invariants; each violation is caught
for (const a of ATTACKS) assert.doesNotThrow(() => assertMeaningPreserved(c, a.apply(c)), `${a.name} tripped the guard`);
const violations: [RoutingCase, string][] = [
  [{ ...c, ground_truth: 'get_forecast' }, 'gt_changed'],
  [{ ...c, candidates: ['get_forecast', 'send_email'] }, 'gt_not_candidate'],
  [{ ...c, candidates: ['get_weather'] }, 'candidate_dropped'],
  [{ ...c, candidates: ['get_weather', 'get_weather', 'get_forecast'] }, 'gt_duplicated'],
  [{ ...c, intent: '   ' }, 'empty_intent'],
];
for (const [after, code] of violations)
  assert.throws(() => assertMeaningPreserved(c, after), (e: unknown) => e instanceof MeaningPreservationError && e.code === code, `expected ${code}`);

// gold slice: honest structural-recall, never a false positive
const gr = guardRecall(loadGoldSlice());
assert.equal(gr.false_positives, 0, 'guard must never reject a meaning-preserving perturbation');
assert.equal(gr.caught, 5, 'guard should catch all 5 structural flips');
assert.equal(gr.missed, 2, 'guard is expected to miss the 2 semantic-only flips');
assert.ok(gr.recall > 0.7 && gr.recall < 0.75, 'recall should be 5/7');
console.log(`selfcheck OK — guard: 6/6 attacks pass, caught ${gr.caught}/${gr.flips} flips (recall ${(gr.recall * 100).toFixed(0)}%), ${gr.missed} semantic-only misses, ${gr.false_positives} false positives`);
