// node packages/eval/src/selfcheck.ts — exits non-zero on failure. Offline via mockProvider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { RoutingCase } from '../../core/src/types.ts';
import { mockProvider } from '../../core/src/provider.ts';
import { toolSchemaHash } from '../../core/src/manifest.ts';
import { runAttacks } from '../../redteam/src/attack-run.ts';
import { bootstrapDeltaCI, mean } from '../../redteam/src/metrics.ts';
import { verifyReport } from './verify.ts';
import { regressionGate } from './gate.ts';
import { harnessMatrix, DEFAULT_STRATEGIES } from './harness-portability/harness-matrix.ts';

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
// honesty: `best` is the DATA-SELECTED argmax, so the best-vs-others family must be Holm-corrected and the
// winner's-curse/selection bias must be disclosed. These assertions FAIL if the correction or the
// disclosure is reverted (a raw uncorrected report has no p_holm and no winner's-curse note).
for (const d of hm.deltas) {
  assert.ok(typeof d.p === 'number' && d.p >= 0 && d.p <= 1, 'each best-vs-other delta carries a raw permutation p in [0,1]');
  assert.ok(typeof d.p_holm === 'number' && d.p_holm >= 0 && d.p_holm <= 1, 'each best-vs-other delta carries a Holm-adjusted p in [0,1]');
  assert.ok(d.p_holm >= d.p - 1e-12, 'the Holm-adjusted p is never below the raw p (step-down inflates, never shrinks)');
}
assert.ok(hm.note.includes("winner's-curse"), 'note must disclose the winner\'s-curse/selection bias of the data-selected best');
assert.ok(hm.note.includes('DATA-SELECTED'), 'note must state that `best` is the data-selected empirical argmax');
assert.ok(hm.note.includes('Holm-corrected'), 'note must state the best-vs-others comparisons are Holm-corrected');
const hm2 = await harnessMatrix(suite, mockProvider, 42);
assert.deepEqual(hm, hm2, 'harness-matrix must be deterministic under a deterministic provider');
console.log(`selfcheck OK — harness-matrix: ${hm.strategies.join('/')}; most robust = ${hm.best} (Holm-corrected best-vs-others, winner's-curse disclosed)`);

// ── baseline regression gate ──────────────────────────────────────────────────────────────────────
// Use a 12-case suite so a full-column zeroing yields a genuinely significant paired drop (n=3 can't).
{
  const parsed = JSON.parse(readFileSync('datasets/routing/sample.json', 'utf8'));
  const gcases: RoutingCase[] = Array.isArray(parsed) ? parsed : parsed.cases;
  const base = await runAttacks(gcases, mockProvider, 42);
  assert.equal(verifyReport(base).pass, true);

  // (1) identical -> pass, nothing regressed, and deterministic
  const self = regressionGate(base, structuredClone(base));
  assert.equal(self.pass, true, 'a report gated against itself must pass');
  assert.ok(self.metrics.every((m) => !m.regressed), 'no metric regresses vs itself');
  assert.deepEqual(regressionGate(base, structuredClone(base)), regressionGate(base, structuredClone(base)), 'gate is deterministic');

  // (2) a real regression. Build a HIGH-signal baseline (force one attack to 100% correct, staying
  //     verify-consistent) then zero that column in `current`, so the 12-case paired drop is
  //     unambiguously Holm-significant. Both reports keep recomputing their own accuracy/CI.
  const recompute = (rep: typeof base, attack: string, cleanCol: number[]) => {
    const col = rep.matrix.map((r) => Number(r[attack]));
    const a = rep.attacks.find((x) => x.attack === attack)!;
    a.accuracy = mean(col);
    a.misroute_rate = 1 - mean(col);
    a.robustness_delta = bootstrapDeltaCI(cleanCol, col, rep.seed);
  };
  const cleanCol = base.matrix.map((r) => Number(r.clean));
  const target = base.attacks[0].attack;
  const hi = structuredClone(base);
  for (const row of hi.matrix) row[target] = 1;
  recompute(hi, target, cleanCol);
  assert.equal(verifyReport(hi).pass, true, 'the high-signal baseline stays consistent');
  const cur = structuredClone(hi);
  for (const row of cur.matrix) row[target] = 0;
  recompute(cur, target, cleanCol);
  assert.equal(verifyReport(cur).pass, true, 'the worsened report stays internally consistent');
  const reg = regressionGate(hi, cur);
  assert.equal(reg.pass, false, 'a real regression must fail the gate');
  const tm = reg.metrics.find((m) => m.metric === target)!;
  assert.equal(tm.regressed, true, 'the zeroed attack is flagged');
  assert.ok(tm.ci.lo > 0, 'a flagged regression has a CI lower bound above 0');
  assert.ok(tm.p_holm < 0.05, 'a flagged regression is Holm-significant');
  assert.ok(reg.metrics.filter((m) => m.metric !== target).every((m) => !m.regressed), 'only the worsened metric regresses');

  // (3) one-sidedness: swap the args so `current` is now the BETTER run — improvements never fail
  const imp = regressionGate(cur, hi);
  assert.equal(imp.pass, true, 'an improvement must never fail the gate');
  assert.equal(imp.metrics.find((m) => m.metric === target)!.regressed, false);

  // (4) coverage: dropping an attack from current is a regression the gate must not miss
  const miss = structuredClone(base);
  const dropped = miss.attacks.pop()!.attack;
  for (const row of miss.matrix) delete row[dropped];
  const cov = regressionGate(base, miss);
  assert.ok(cov.missing_attacks.includes(dropped), 'a dropped attack surfaces as missing');
  assert.equal(cov.pass, false, 'a coverage gap fails the gate');

  // (5) guard: a mismatched tool schema hard-stops the comparison
  const sch = structuredClone(base);
  sch.manifest.tool_schema_hash = 'deadbeefdeadbeef';
  const gg = regressionGate(base, sch);
  assert.equal(gg.pass, false, 'a schema mismatch fails the gate');
  assert.ok(gg.guard_errors.length > 0, 'a schema mismatch is reported as a guard error');

  // (6) ISOLATING FIXTURES: make each conjunct of `regressed = Holm-significant AND ci.lo > tolerance`
  //     independently load-bearing, so a mutant deleting either guardrail turns a test red.
  // (6a) Holm is load-bearing: half the target column zeroed. The drop's CI excludes 0 (a ci.lo-only rule
  //      WOULD flag it) but it is NOT Holm-significant, so the real code must NOT flag it.
  const half = structuredClone(hi);
  const halfN = Math.floor(half.matrix.length / 2);
  half.matrix.forEach((row, i) => { row[target] = i < halfN ? 0 : 1; });
  recompute(half, target, cleanCol);
  const hm = regressionGate(hi, half).metrics.find((m) => m.metric === target)!;
  assert.ok(hm.ci.lo > 0, 'the half-zeroed drop has ci.lo > 0 (the CI conjunct alone would fire)');
  assert.equal(hm.regressed, false, 'a non-Holm-significant drop must NOT regress — proves Holm is load-bearing');
  // (6b) the CI/tolerance conjunct is load-bearing: the full regression IS Holm-significant (a Holm-only
  //      rule WOULD flag it), but with tolerance == its ci.lo it does not clear the bar, so it must NOT regress.
  const cm = regressionGate(hi, cur, { tolerance: tm.ci.lo }).metrics.find((m) => m.metric === target)!;
  assert.equal(cm.regressed, false, 'a Holm-significant drop whose ci.lo == tolerance must NOT regress');
  // (6c) tolerance binds ci.lo, NOT the point drop. A strong (Holm-sig) drop with point drop > ci.lo:
  //      a tolerance in the gap must NOT regress (a point-drop rule would still fire).
  const strong = structuredClone(hi);
  strong.matrix.forEach((row, i) => { row[target] = i < Math.floor(strong.matrix.length * 5 / 6) ? 0 : 1; });
  recompute(strong, target, cleanCol);
  const s0 = regressionGate(hi, strong).metrics.find((m) => m.metric === target)!;
  assert.ok(s0.drop > s0.ci.lo + 1e-9, 'the strong fixture leaves a gap between point drop and ci.lo');
  assert.equal(s0.regressed, true, 'the strong drop regresses at tolerance 0');
  const midTol = (s0.ci.lo + s0.drop) / 2; // above ci.lo, below the point drop
  assert.equal(regressionGate(hi, strong, { tolerance: midTol }).metrics.find((m) => m.metric === target)!.regressed, false, 'tolerance above ci.lo (but below the point drop) must NOT regress — tolerance binds ci.lo');
  // (6d) the reported drop sign is pinned: a regression is positive, an improvement is negative.
  assert.ok(tm.drop > 0, 'a regression reports a positive drop');
  assert.ok(imp.metrics.find((m) => m.metric === target)!.drop < 0, 'an improvement reports a negative drop');

  console.log(`selfcheck OK — gate: self-pass, catches a zeroed "${target}", Holm & ci.lo/tolerance each isolated & load-bearing, passes improvements, fails coverage + schema drift`);
}

// ── harnesses/strategies.json parity with loop.ts / DEFAULT_STRATEGIES ───────────────────────────
// The doc manifest is inert metadata, but this check binds it to the code: you cannot add, drop, or
// misdescribe a strategy without npm test going red.
{
  const parsed = JSON.parse(readFileSync('harnesses/strategies.json', 'utf8'));
  const strat: any[] = Array.isArray(parsed) ? parsed : parsed.strategies;
  const ids = strat.map((s) => s.id);
  assert.deepEqual([...ids].sort(), [...DEFAULT_STRATEGIES].sort(), 'strategies.json ids must equal DEFAULT_STRATEGIES');
  assert.equal(strat.length, 4);
  const byId = new Map(strat.map((s) => [s.id, s]));
  for (const s of strat) {
    assert.ok(s.node_sequence.includes('route'), `${s.id} must route`);
    assert.equal(s.node_sequence[s.node_sequence.length - 1], 'stop', `${s.id} must end in stop`);
    assert.ok(s.mechanism && s.when_it_helps && s.when_it_hurts, `${s.id} must be documented`);
    assert.ok(Array.isArray(s.evidence) && s.evidence.length >= 1 && s.evidence[0].finding && s.evidence[0].model && s.evidence[0].seed !== undefined, `${s.id} must carry stamped evidence`);
  }
  assert.ok(byId.get('self-check').node_sequence.includes('reflect'), 'self-check branch marker');
  assert.ok(byId.get('react').node_sequence.includes('think'), 'react branch marker');
  assert.ok(byId.get('observe').node_sequence.includes('observe'), 'observe branch marker');
  const single = byId.get('single').node_sequence;
  assert.ok(!single.includes('reflect') && !single.includes('think') && !single.includes('observe'), 'single has no branch node');
  // self-check must not read as an endorsement: it documents where it hurt (F2) and its F5 result is a wash
  // (neutral), never a bare win. If a future run shows a real +helps, this assertion should be revisited.
  const scDirs = new Set(byId.get('self-check').evidence.map((e: any) => e.direction));
  assert.ok(scDirs.has('hurts') && !scDirs.has('helps'), 'self-check must document a hurt (F2) and carry no bare helps win (F5 is a wash)');
  console.log(`selfcheck OK — harnesses/strategies.json mirrors loop.ts strategies (${[...ids].sort().join('/')}); self-check shows hurt + wash, not an endorsement`);
}
