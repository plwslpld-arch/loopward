import type { Provider, RoutingCase } from '../../core/src/types.ts';
import { runSuite } from '../../core/src/loop.ts';
import { ATTACKS, type Attack } from './attacks.ts';
import { bootstrapDeltaCI, mean, type DeltaCI } from './metrics.ts';

export interface AttackResult {
  attack: string;
  source: string;
  accuracy: number;      // under attack
  misroute_rate: number; // 1 - accuracy
  robustness_delta: DeltaCI;
}

export interface AttackReport {
  provider: string;
  seed: number;
  total: number;
  clean_accuracy: number;
  attacks: AttackResult[];
  /** heatmap-ready: per case, correctness under clean + each attack (1/0). */
  matrix: { caseId: string; clean: number; [attack: string]: string | number }[];
}

const bit = (b: boolean): number => (b ? 1 : 0);

export async function runAttacks(
  cases: RoutingCase[],
  provider: Provider,
  seed: number,
  attacks: Attack[] = ATTACKS,
): Promise<AttackReport> {
  const clean = await runSuite(cases, provider, seed);
  const cleanBy = new Map(clean.trajectories.map((t) => [t.caseId, bit(t.correct)]));
  const cleanArr = cases.map((c) => cleanBy.get(c.id) ?? 0);

  const matrix = cases.map((c) => ({ caseId: c.id, clean: cleanBy.get(c.id) ?? 0 }) as AttackReport['matrix'][number]);

  const results: AttackResult[] = [];
  for (const atk of attacks) {
    const perturbed = cases.map((c) => atk.apply(c));
    const run = await runSuite(perturbed, provider, seed);
    const by = new Map(run.trajectories.map((t) => [t.caseId, bit(t.correct)]));
    const attackArr = cases.map((c) => by.get(c.id) ?? 0);
    matrix.forEach((row, i) => (row[atk.name] = attackArr[i]));
    results.push({
      attack: atk.name,
      source: atk.source,
      accuracy: mean(attackArr),
      misroute_rate: 1 - mean(attackArr),
      robustness_delta: bootstrapDeltaCI(cleanArr, attackArr, seed),
    });
  }

  return {
    provider: provider.name,
    seed,
    total: cases.length,
    clean_accuracy: mean(cleanArr),
    attacks: results,
    matrix,
  };
}
