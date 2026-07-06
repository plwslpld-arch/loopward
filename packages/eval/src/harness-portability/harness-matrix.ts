// harness-matrix: run the SAME attacked suite on a FIXED model across several loop strategies, and
// measure how much the HARNESS (not the model) moves routing robustness.
//
// We deliberately do NOT report a variance-components / ICC "harness explains X%" number: with a single
// 0/1 draw per (strategy, attack, case) cell the error term is confounded with the three-way
// interaction, so those components are unidentified on this design. Instead we report what IS
// identified: per-strategy attacked accuracy, and PAIRED bootstrap deltas between strategies resampled
// at the CASE level (the correct cluster — a case's six attack outcomes are correlated). Every number is
// conditional on this model and this suite; a different model can reorder the strategies.
import type { Provider, RoutingCase } from '../../../core/src/types.ts';
import type { Variant } from '../../../core/src/loop.ts';
import { runAttacks } from '../../../redteam/src/attack-run.ts';
import { bootstrapDeltaCI, mean, type DeltaCI } from '../../../redteam/src/metrics.ts';

export const DEFAULT_STRATEGIES: Variant[] = ['single', 'self-check', 'react', 'observe'];

export interface StrategyRow { strategy: Variant; clean: number; attacked: number }
export interface StrategyDelta { a: Variant; b: Variant; delta: DeltaCI }
export interface HarnessMatrixReport {
  provider: string;
  seed: number;
  strategies: Variant[];
  attacks: string[];
  n_cases: number;
  per_strategy: StrategyRow[];
  best: Variant;
  worst: Variant;
  deltas: StrategyDelta[]; // best strategy vs each other, paired by case
  note: string;
}

/** One number per case: that case's accuracy averaged over the attack columns (the case-level unit
 *  the bootstrap resamples, so within-case correlation across attacks is respected). */
export function perCaseAttacked(matrix: any[], attackNames: string[]): number[] {
  return matrix.map((row) => mean(attackNames.map((a) => Number(row[a]))));
}

export async function harnessMatrix(
  cases: RoutingCase[], provider: Provider, seed: number, strategies: Variant[] = DEFAULT_STRATEGIES,
): Promise<HarnessMatrixReport> {
  const reps: { strategy: Variant; matrix: any[]; clean: number }[] = [];
  for (const s of strategies) {
    const rep = await runAttacks(cases, provider, seed, undefined, s);
    reps.push({ strategy: s, matrix: rep.matrix, clean: rep.clean_accuracy });
  }
  const attackNames = reps.length ? [...new Set(reps[0].matrix.flatMap((r) => Object.keys(r).filter((k) => k !== 'caseId' && k !== 'clean')))] : [];

  const vecByStrategy = new Map(reps.map((r) => [r.strategy, perCaseAttacked(r.matrix, attackNames)]));
  const per_strategy: StrategyRow[] = reps.map((r) => ({ strategy: r.strategy, clean: r.clean, attacked: mean(vecByStrategy.get(r.strategy)!) }));

  const ranked = [...per_strategy].sort((x, y) => y.attacked - x.attacked);
  const best = ranked[0].strategy;
  const worst = ranked[ranked.length - 1].strategy;
  const bestVec = vecByStrategy.get(best)!;
  const deltas: StrategyDelta[] = per_strategy
    .filter((r) => r.strategy !== best)
    .map((r) => ({ a: best, b: r.strategy, delta: bootstrapDeltaCI(bestVec, vecByStrategy.get(r.strategy)!, seed) }));

  return {
    provider: provider.name, seed, strategies, attacks: attackNames, n_cases: cases.length,
    per_strategy, best, worst, deltas,
    note: `attacked accuracy is pooled over ${attackNames.length} attacks; deltas are case-level paired bootstrap, conditional on model "${provider.name}" and this suite. strategy levels are not fully independent (self-check/observe both re-feed a prior pick), and a different model can reorder them.`,
  };
}
