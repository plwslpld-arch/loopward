// `node src/selfcheck.ts` — exits non-zero on failure.
import assert from 'node:assert/strict';
import type { Provider, RoutingCase } from '../../core/src/types.ts';
import type { MultistepTask } from '../../core/src/multistep.ts';
import { mockProvider } from '../../core/src/provider.ts';
import { ATTACKS, getAttack } from './attacks.ts';
import { bootstrapDeltaCI } from './metrics.ts';
import { runAttacks } from './attack-run.ts';
import { runFix } from './fix.ts';
import { assertMeaningPreserved, MeaningPreservationError, guardRecall, loadGoldSlice } from './oracle-guard.ts';
import { runStopAxis, STOP_NUDGES, assertStopMeaningPreserved, StopMeaningError } from './stop-axis.ts';

// every attack preserves ground_truth and keeps it in the candidate list
const c: RoutingCase = { id: 't', intent: 'What is the weather in Tokyo', candidates: ['get_weather', 'get_forecast'], ground_truth: 'get_weather' };
for (const a of ATTACKS) {
  const out = a.apply(c);
  assert.equal(out.ground_truth, c.ground_truth, `${a.name} changed ground_truth`);
  assert.ok(out.candidates.includes(c.ground_truth), `${a.name} dropped ground_truth from candidates`);
}

// firstDistractor no-leak: a case with NO genuine distractor (single candidate — the ground truth is
// the only option) must never be turned into an answer leak. semantic_injection must return the case
// UNCHANGED, never fall back to naming the ground truth; negation_trap must not steer away from the
// sole correct tool. Reverting the `?? c.ground_truth` fix makes the injected text contain 'only_tool'
// and fails these assertions.
const soloGt = 'only_tool';
const solo: RoutingCase = { id: 'solo', intent: 'do the only thing', candidates: [soloGt], ground_truth: soloGt };
const inj = getAttack('semantic_injection').apply(solo);
assert.ok(!inj.intent.includes(soloGt), 'semantic_injection leaked the ground-truth tool name on a single-candidate case');
assert.equal(inj.intent, solo.intent, 'semantic_injection must return the case unchanged when there is no genuine distractor');
const neg = getAttack('negation_trap').apply(solo);
assert.ok(!neg.intent.includes(soloGt), 'negation_trap steered away from the sole correct tool on a single-candidate case');
// a case-variant candidate is NOT a genuine distractor (oracle norms them equal) — still no leak.
const caseVariant: RoutingCase = { id: 'cv', intent: 'do the only thing', candidates: ['Only_Tool'], ground_truth: soloGt };
assert.equal(getAttack('semantic_injection').apply(caseVariant).intent, caseVariant.intent, 'a norm-equal case-variant must not count as a distractor');

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

// ── stop-axis: a nudge-sensitive stub proves each nudge moves the HALT decision as expected ────────
{
  const premature = STOP_NUDGES.find((n) => n.kind === 'premature')!.text;
  const overrun = STOP_NUDGES.find((n) => n.kind === 'overrun')!.text;
  // Reads which tools were already called from the loop's progress lines, then obeys the nudge:
  // premature -> stop immediately; overrun -> never stop (loop hits the cap); else -> normal completion.
  const nudgeStub: Provider = {
    name: 'nudge-stub',
    async route(prompt, candidates) {
      const called = new Set([...prompt.matchAll(/called (\S+) →/g)].map((m) => m[1].toLowerCase()));
      const tools = candidates.filter((c) => c.toLowerCase() !== 'done');
      if (prompt.includes(premature)) return { tool: 'done' };
      if (prompt.includes(overrun)) return { tool: tools[0] };
      const next = tools.find((t) => !called.has(t.toLowerCase()));
      return { tool: next ?? 'done' };
    },
  };
  const saTasks: MultistepTask[] = [
    { id: 't1', task: 'do alpha then beta', tools: ['alpha', 'beta'], required: ['alpha', 'beta'] },
    { id: 't2', task: 'do gamma then delta', tools: ['gamma', 'delta'], required: ['gamma', 'delta'] },
  ];
  const sa = await runStopAxis(saTasks, nudgeStub, 42);
  assert.equal(sa.clean_rates.success, 1, 'clean stub completes every task');
  assert.equal(sa.clean_rates.premature_stop, 0);
  assert.equal(sa.clean_rates.over_run, 0);
  const byId = new Map(sa.per_nudge.map((n) => [n.id, n]));
  const prem = byId.get('premature')!, over = byId.get('overrun')!, ctrl = byId.get('control')!;
  assert.ok(prem.deltas.premature_stop.delta > 0, 'premature nudge raises premature_stop');
  assert.ok(prem.deltas.success.delta < 0, 'premature nudge lowers success');
  assert.ok(over.deltas.over_run.delta > 0, 'overrun nudge raises over_run');
  assert.ok(over.deltas.success.delta < 0, 'overrun nudge lowers success');
  for (const m of ['premature_stop', 'over_run', 'success'] as const)
    assert.equal(ctrl.deltas[m].delta, 0, 'the control nudge is a placebo — zero movement');
  for (const n of sa.per_nudge) for (const m of ['premature_stop', 'over_run', 'success'] as const) {
    const d = n.deltas[m];
    assert.ok(d.lo <= d.delta && d.delta <= d.hi, 'CI brackets the point delta');
  }
  assert.deepEqual(sa.vectors.clean.taskIds, sa.vectors.byNudge['premature'].taskIds, 'per-task vectors aligned by taskId');
  // guard: a nudge that names a DISTINCTIVE (snake_case) task tool is rejected (it could smuggle
  // task-specific ground truth); a benign one is not. Short single-word names are handled below.
  const distinct: MultistepTask = { id: 'd', task: 'send then archive the report', tools: ['send_report', 'archive_report'], required: ['send_report', 'archive_report'] };
  assert.throws(
    () => assertStopMeaningPreserved(distinct, { id: 'x', kind: 'control', text: 'reply done and do not call send_report again' }),
    (e: unknown) => e instanceof StopMeaningError && e.code === 'nudge_names_tool',
  );
  assert.doesNotThrow(() => assertStopMeaningPreserved(distinct, { id: 'y', kind: 'control', text: 'proceed with more steps if anything remains' }));
  // word-boundary, NOT substring: 'send_reports' contains 'send_report' but must not trip (a plain .includes regression would).
  assert.doesNotThrow(() => assertStopMeaningPreserved(distinct, { id: 'z', kind: 'control', text: 'update the send_reports chart before finishing' }), 'a tool name inside a larger word must not trip the guard');
  // ...but a whole-word match next to punctuation MUST trip.
  assert.throws(() => assertStopMeaningPreserved(distinct, { id: 'w', kind: 'control', text: 'do not run send_report-only mode' }), (e: unknown) => e instanceof StopMeaningError && e.code === 'nudge_names_tool');
  // collision fix (load-bearing): a GENERIC-word tool name like 'reply' must NOT abort the run, even
  // though the premature nudge literally contains the word "reply" (and "task"/"call"/"complete" etc).
  // Before the isDistinctiveTool scope, assertStopMeaningPreserved matched 'reply' as a whole-word tool
  // name and runStopAxis threw the meaning-preserved assertion for any task naming such a tool.
  const replyTask: MultistepTask = { id: 'rp', task: 'reply to the message then archive it', tools: ['reply', 'archive'], required: ['reply', 'archive'] };
  for (const n of STOP_NUDGES) assert.doesNotThrow(() => assertStopMeaningPreserved(replyTask, n), `generic-word tool 'reply' tripped nudge "${n.id}"`);
  await assert.doesNotReject(runStopAxis([replyTask], nudgeStub, 42), "a task with a generic-word tool name ('reply') must not make runStopAxis throw");
  console.log('selfcheck OK — stop-axis: premature↑stop↓success, overrun↑run↓success, control placebo=0, guard is word-boundary (send_reports≠send_report), catches distinctive-name leaks, no longer aborts on generic-word tool names (reply/task)');
}
