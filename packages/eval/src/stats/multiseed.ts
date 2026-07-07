// stats: apply multiple-comparison correction to the six attacks in one attack report, so a per-attack
// "significant" badge accounts for the fact that six simultaneous 95% CIs would falsely flag ~1-in-4
// runs. Deliberately NOT a seed sweep: mockProvider ignores its seed and the real provider routes at
// temperature 0, so extra seeds add no independent variance — pooling case-pairs across seeds would be
// pseudo-replication that manufactures significance. The real uncertainty is the case-level paired
// bootstrap already in the report; we add a directional permutation p and Holm correction over it.
import type { AttackReport } from '../../../redteam/src/attack-run.ts';
import type { StopAxisReport } from '../../../redteam/src/stop-axis.ts';
import { bootstrapDeltaCI, mean, rng, type DeltaCI } from '../../../redteam/src/metrics.ts';

/** Holm step-down (family-wise) correction. Returns adjusted p-values in the input order,
 *  non-decreasing when read in ascending-p order, each >= its raw input. */
export function holm(p: number[]): number[] {
  const m = p.length;
  const order = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  const adj = new Array<number>(m);
  let running = 0;
  for (let k = 0; k < m; k++) {
    const i = order[k];
    running = Math.max(running, (m - k) * p[i]);
    adj[i] = Math.min(running, 1);
  }
  return adj;
}

/** Paired sign-flip permutation p-value. Robustness is directional (an attack can only reduce
 *  accuracy), so the default is one-sided ('greater': clean beats attack). add-one keeps p in (0,1]. */
export function permutationPValue(clean: number[], attack: number[], seed = 1337, B = 2000, sided: 'greater' | 'two-sided' = 'greater'): number {
  const n = clean.length;
  if (n === 0) return 1;
  const d = clean.map((c, i) => c - attack[i]);
  if (d.every((x) => x === 0)) return 1;
  const obs = mean(d);
  const rand = rng(seed);
  let count = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (rand() < 0.5 ? -1 : 1) * d[i];
    const perm = s / n;
    if (sided === 'greater' ? perm >= obs - 1e-12 : Math.abs(perm) >= Math.abs(obs) - 1e-12) count++;
  }
  return (count + 1) / (B + 1);
}

/** Cohen's d_z for paired data: mean(diff) / sd(diff). Magnitude that doesn't inflate with n. */
export function pairedEffectSize(clean: number[], attack: number[]): number {
  const n = clean.length;
  if (n < 2) return 0;
  const d = clean.map((c, i) => c - attack[i]);
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  return sd === 0 ? 0 : m / sd;
}

export interface AttackStat {
  attack: string;
  delta: number;       // clean_acc - attacked_acc
  ci: DeltaCI;         // case-level paired bootstrap (one-sided use: ci.lo)
  p: number;           // directional permutation p
  p_holm: number;      // Holm-adjusted across the six attacks
  dz: number;          // paired effect size
  significant: boolean; // FWER-controlled: p_holm < alpha AND directional CI excludes 0 (ci.lo > 0)
}
export interface CorrectedReport { provider: string; seed: number; alpha: number; note: string; attacks: AttackStat[] }

export function correctAttacks(report: AttackReport, opts: { alpha?: number; permSeed?: number; B?: number } = {}): CorrectedReport {
  const alpha = opts.alpha ?? 0.05;
  const permSeed = opts.permSeed ?? 1337;
  const B = opts.B ?? 2000;
  const matrix = report.matrix as any[];
  const clean = matrix.map((r) => Number(r.clean));
  const raw = report.attacks.map((a) => {
    const col = matrix.map((r) => Number(r[a.attack]));
    return { attack: a.attack, ci: bootstrapDeltaCI(clean, col, report.seed), p: permutationPValue(clean, col, permSeed, B, 'greater'), dz: pairedEffectSize(clean, col) };
  });
  const pHolm = holm(raw.map((r) => r.p));
  return {
    provider: report.provider, seed: report.seed, alpha,
    note: `single-seed, n=${matrix.length}. p is a one-sided paired permutation test; Holm controls the family-wise error rate across the ${raw.length} attacks; an attack is "significant" only if Holm-p < ${alpha} AND its one-sided CI excludes 0.`,
    attacks: raw.map((r, i) => ({ attack: r.attack, delta: r.ci.delta, ci: r.ci, p: r.p, p_holm: pHolm[i], dz: r.dz, significant: pHolm[i] < alpha && r.ci.lo > 0 })),
  };
}

// ── stop-axis correction ────────────────────────────────────────────────────────────────────────
// The stop-axis probe produces a family of (nudge × {premature_stop, over_run, success}) cells. Each
// cell's expected direction is PRE-REGISTERED from the nudge's intent, so the placebo control gets no
// directional prior and cannot be gamed into significance. Holm controls the family-wise error across
// the whole grid; a cell is significant only if Holm-p < alpha AND its paired bootstrap CI excludes 0
// in the registered direction. Reuses the exact permutation/Holm machinery above — no second scorer.
type StopMetric = 'premature_stop' | 'over_run' | 'success';
type StopDirection = 'up' | 'down' | 'two-sided';

/** premature → premature_stop↑, success↓; overrun → over_run↑, success↓; control & off-target → two-sided. */
function stopDirection(kind: 'premature' | 'overrun' | 'control', metric: StopMetric): StopDirection {
  if (kind === 'premature') return metric === 'premature_stop' ? 'up' : metric === 'success' ? 'down' : 'two-sided';
  if (kind === 'overrun') return metric === 'over_run' ? 'up' : metric === 'success' ? 'down' : 'two-sided';
  return 'two-sided';
}

export interface StopCellStat {
  nudge: string;
  kind: 'premature' | 'overrun' | 'control';
  metric: StopMetric;
  direction: StopDirection;
  delta: number;   // mean(perturbed) - mean(clean)  (>0 = nudge raised the rate)
  ci: DeltaCI;
  p: number;       // permutation p in the pre-registered direction
  p_holm: number;  // Holm-adjusted across the whole nudge × metric family
  significant: boolean;
}
export interface CorrectedStopReport { provider: string; seed: number; alpha: number; note: string; cells: StopCellStat[] }

const STOP_METRICS: StopMetric[] = ['premature_stop', 'over_run', 'success'];

export function correctStopAxis(report: StopAxisReport, opts: { alpha?: number; permSeed?: number; B?: number } = {}): CorrectedStopReport {
  const alpha = opts.alpha ?? 0.05;
  const permSeed = opts.permSeed ?? 1337;
  const B = opts.B ?? 2000;
  const clean = report.vectors.clean;
  const raw = report.per_nudge.flatMap((nu) => {
    const pv = report.vectors.byNudge[nu.id];
    return STOP_METRICS.map((metric) => {
      const perturbed = pv[metric];
      const cleanCol = clean[metric];
      const direction = stopDirection(nu.kind, metric);
      const ci = bootstrapDeltaCI(perturbed, cleanCol, report.seed); // delta = mean(perturbed) - mean(clean)
      // one-sided test in the registered direction; 'down' flips the arguments so the same 'greater' test applies
      const p = direction === 'up' ? permutationPValue(perturbed, cleanCol, permSeed, B, 'greater')
        : direction === 'down' ? permutationPValue(cleanCol, perturbed, permSeed, B, 'greater')
        : permutationPValue(perturbed, cleanCol, permSeed, B, 'two-sided');
      return { nudge: nu.id, kind: nu.kind, metric, direction, delta: ci.delta, ci, p };
    });
  });
  const pHolm = holm(raw.map((r) => r.p));
  const cells: StopCellStat[] = raw.map((r, i) => {
    const excludesZero = r.direction === 'up' ? r.ci.lo > 0 : r.direction === 'down' ? r.ci.hi < 0 : (r.ci.lo > 0 || r.ci.hi < 0);
    return { ...r, p_holm: pHolm[i], significant: pHolm[i] < alpha && excludesZero };
  });
  return {
    provider: report.provider, seed: report.seed, alpha,
    note: `stop-axis: ${report.per_nudge.length} nudges × 3 metrics = ${cells.length} cells. Directions are PRE-REGISTERED (premature→premature_stop↑, success↓; overrun→over_run↑, success↓; control & off-target cells two-sided). One-sided sign-flip permutation p in the registered direction; Holm controls FWER across the whole family; a cell is "significant" only if Holm-p < ${alpha} AND its paired bootstrap CI excludes 0. The control nudge is a placebo and should NOT be flagged.`,
    cells,
  };
}
