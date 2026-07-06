// stats: apply multiple-comparison correction to the six attacks in one attack report, so a per-attack
// "significant" badge accounts for the fact that six simultaneous 95% CIs would falsely flag ~1-in-4
// runs. Deliberately NOT a seed sweep: mockProvider ignores its seed and the real provider routes at
// temperature 0, so extra seeds add no independent variance — pooling case-pairs across seeds would be
// pseudo-replication that manufactures significance. The real uncertainty is the case-level paired
// bootstrap already in the report; we add a directional permutation p and Holm correction over it.
import type { AttackReport } from '../../../redteam/src/attack-run.ts';
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
