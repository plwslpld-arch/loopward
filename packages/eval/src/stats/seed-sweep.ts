// stats: honest multi-seed aggregator. Given one AttackReport per DISTINCT seed (same provider, variant,
// tool-schema, cases and attacks), it treats each seed as ONE replication and reports only descriptive
// spread of the per-seed robustness deltas plus a reproducibility count (in how many seeds each attack was
// flagged significant by that seed's OWN Holm correction). It deliberately does NOT pool case-pairs across
// seeds, and computes NO t-interval, NO across-seed p-value, NO Fisher/Stouffer combination — because a
// temperature-0 (or seed-ignoring mock) router makes extra seeds near-degenerate, so any such pooling would
// be pseudo-replication that manufactures certainty. The real uncertainty lives in each seed's own case-level
// bootstrap CI (carried through verbatim), never here.
// ponytail: reuses each report's robustness_delta.delta verbatim as the single per-seed scalar rather than
// re-deriving a parallel path — one number, one source of truth, no second scorer to drift.
import type { AttackReport } from '../../../redteam/src/attack-run.ts';
import { mean, type DeltaCI } from '../../../redteam/src/metrics.ts';
import { correctAttacks } from './multiseed.ts';
import type { Manifest } from '../../../core/src/manifest.ts';

/** One seed's contribution for a given attack: its verbatim delta, its own case-level CI, and whether
 *  that seed's OWN Holm-corrected test flagged this attack significant. */
export interface SeedDelta {
  seed: number;
  delta: number;
  ci: DeltaCI;
  significant: boolean;
}

export interface AttackSeedSummary {
  attack: string;
  n_seeds: number;
  seed_deltas: SeedDelta[];
  mean_delta: number;
  sd_delta: number | null;         // sample SD (n-1); null when n<2 (no spread is estimable)
  min_delta: number;
  max_delta: number;
  sign_stable: boolean;            // every seed's delta same sign (all >0, all <0, or all ==0)
  significant_in: number;          // # of seeds whose own Holm marked THIS attack significant
  identical_across_seeds: boolean; // bit-identical matrix column across all seeds, aligned by caseId
}

export interface MultiSeedReport {
  provider: string;
  variant: string;
  seeds: number[];                    // ascending, one per report
  n_cases: number;
  clean_accuracy_by_seed: number[];   // aligned with seeds[]
  tool_schema_hash: string;
  manifests: Manifest[];              // inherited verbatim from inputs (aligned with seeds[])
  attacks: AttackSeedSummary[];
  degenerate: boolean;                // true iff EVERY attack is identical_across_seeds
  note: string;
}

/** sample standard deviation (n-1); null when fewer than 2 observations. Snaps float-epsilon residual
 *  (e.g. from the mean of identical values) to exactly 0 so identical seeds report 0 spread, not 1e-16. */
function sampleSD(xs: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  return sd < 1e-12 ? 0 : sd;
}

/**
 * Aggregate one AttackReport per distinct seed into a descriptive multi-seed summary.
 * Pure and offline: no provider, no Date, no git — it only re-reads the given reports and each seed's own
 * Holm correction. Throws (never silently pools) if the reports are not comparable replications.
 */
export function aggregateSeeds(reports: AttackReport[], opts: { alpha?: number } = {}): MultiSeedReport {
  const alpha = opts.alpha ?? 0.05;
  if (reports.length === 0) throw new Error('aggregateSeeds: need at least one report');

  // sort by seed so seeds[]/clean_accuracy_by_seed[]/manifests[]/seed_deltas[] are aligned & deterministic
  const sorted = [...reports].sort((a, b) => a.seed - b.seed);

  const ref = sorted[0];
  const refCaseIds = ref.matrix.map((r) => r.caseId);
  const refCaseKey = [...refCaseIds].sort().join('');
  const refAttackNames = ref.attacks.map((a) => a.attack);
  const refAttackKey = [...refAttackNames].sort().join('');

  const seenSeeds = new Set<number>();
  for (const rep of sorted) {
    if (seenSeeds.has(rep.seed)) throw new Error(`aggregateSeeds: duplicate seed ${rep.seed} — seeds must be DISTINCT (never pool same-seed reports)`);
    seenSeeds.add(rep.seed);
    if (rep.provider !== ref.provider) throw new Error(`aggregateSeeds: provider mismatch (${rep.provider} vs ${ref.provider})`);
    if (rep.variant !== ref.variant) throw new Error(`aggregateSeeds: variant mismatch (${rep.variant} vs ${ref.variant})`);
    if (rep.manifest.tool_schema_hash !== ref.manifest.tool_schema_hash) throw new Error(`aggregateSeeds: tool_schema_hash mismatch (${rep.manifest.tool_schema_hash} vs ${ref.manifest.tool_schema_hash})`);
    if (rep.total !== ref.total) throw new Error(`aggregateSeeds: total mismatch (${rep.total} vs ${ref.total})`);
    if ([...rep.matrix.map((r) => r.caseId)].sort().join('') !== refCaseKey) throw new Error('aggregateSeeds: caseId set mismatch across seeds');
    if ([...rep.attacks.map((a) => a.attack)].sort().join('') !== refAttackKey) throw new Error('aggregateSeeds: attack-name set mismatch across seeds');
  }

  // per-report: attack -> verbatim robustness_delta, and its own Holm significance
  const perReport = sorted.map((rep) => {
    const deltaByAttack = new Map(rep.attacks.map((a) => [a.attack, a.robustness_delta]));
    const sigByAttack = new Map(correctAttacks(rep, { alpha }).attacks.map((a) => [a.attack, a.significant]));
    const colByAttack = new Map<string, Map<string, number>>();
    for (const name of refAttackNames) {
      const col = new Map<string, number>();
      for (const row of rep.matrix) col.set(row.caseId, Number(row[name]));
      colByAttack.set(name, col);
    }
    const cleanCol = new Map<string, number>();
    for (const row of rep.matrix) cleanCol.set(row.caseId, Number(row.clean));
    return { seed: rep.seed, deltaByAttack, sigByAttack, colByAttack, cleanCol };
  });

  // A per-seed delta = mean(clean) - mean(attack), so "identical across seeds" must include the CLEAN
  // column too — otherwise two seeds with the same attack column but different clean columns produce
  // different deltas (sd_delta > 0) while we'd wrongly flag them degenerate and claim "SD = 0".
  const cleanIdentical = (() => {
    const ref0 = perReport[0].cleanCol;
    for (let s = 1; s < perReport.length; s++) {
      for (const cid of refCaseIds) if (perReport[s].cleanCol.get(cid) !== ref0.get(cid)) return false;
    }
    return true;
  })();

  const attacks: AttackSeedSummary[] = refAttackNames.map((name) => {
    const seed_deltas: SeedDelta[] = perReport.map((pr) => {
      const ci = pr.deltaByAttack.get(name) as DeltaCI;
      return { seed: pr.seed, delta: ci.delta, ci, significant: pr.sigByAttack.get(name) ?? false };
    });
    const deltas = seed_deltas.map((s) => s.delta);
    const allPos = deltas.every((d) => d > 0);
    const allNeg = deltas.every((d) => d < 0);
    const allZero = deltas.every((d) => d === 0);

    // identical_across_seeds: this attack's per-case OUTCOME (clean bit AND attack bit) is bit-identical
    // across seeds. Requiring the clean column too guarantees identical => identical delta => sd == 0,
    // so the DEGENERATE "no independent replication" claim is never emitted while spread is actually nonzero.
    let identical = cleanIdentical;
    const refCol = perReport[0].colByAttack.get(name)!;
    for (let s = 1; s < perReport.length && identical; s++) {
      const col = perReport[s].colByAttack.get(name)!;
      for (const cid of refCaseIds) {
        if (col.get(cid) !== refCol.get(cid)) { identical = false; break; }
      }
    }

    return {
      attack: name,
      n_seeds: seed_deltas.length,
      seed_deltas,
      mean_delta: mean(deltas),
      sd_delta: sampleSD(deltas),
      min_delta: Math.min(...deltas),
      max_delta: Math.max(...deltas),
      sign_stable: allPos || allNeg || allZero,
      significant_in: seed_deltas.filter((s) => s.significant).length,
      identical_across_seeds: identical,
    };
  });

  const degenerate = attacks.every((a) => a.identical_across_seeds);
  const note = degenerate
    ? `DEGENERATE: every attack's per-case outcomes are bit-identical across all ${sorted.length} seeds (a temperature-0 or seed-ignoring router). SD=0 means no independent replication occurred, NOT certainty — the real uncertainty is the per-seed case bootstrap CI (carried in each seed_deltas[].ci), never the zero spread here.`
    : `Seeds capture only residual run-to-run stochasticity; the seed is the replication unit and case-pairs are NEVER pooled across seeds. No across-seed p-value, t-interval, or Fisher/Stouffer combination is computed — only descriptive spread of the ${sorted.length} per-seed deltas plus significant_in, a reproducibility count over each seed's OWN Holm correction. The real per-run uncertainty is each seed_deltas[].ci.`;

  return {
    provider: ref.provider,
    variant: ref.variant,
    seeds: sorted.map((r) => r.seed),
    n_cases: ref.total,
    clean_accuracy_by_seed: sorted.map((r) => r.clean_accuracy),
    tool_schema_hash: ref.manifest.tool_schema_hash,
    manifests: sorted.map((r) => r.manifest),
    attacks,
    degenerate,
    note,
  };
}
