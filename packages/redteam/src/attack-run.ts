import type { Provider, RoutingCase } from '../../core/src/types.ts';
import { runSuite, type Variant } from '../../core/src/loop.ts';
import { buildManifest, type Manifest, type StampInput } from '../../core/src/manifest.ts';
import { ATTACKS, type Attack } from './attacks.ts';
import { assertMeaningPreserved } from './oracle-guard.ts';
import { bootstrapDeltaCI, mean, type DeltaCI } from './metrics.ts';

export interface AttackResult {
  attack: string;
  source: string;
  accuracy: number;      // under attack
  misroute_rate: number; // 1 - accuracy
  robustness_delta: DeltaCI;
}

/** A single misroute under an attack — the raw material for co-evolution export. */
export interface Failure {
  attack: string;
  caseId: string;
  intent: string;        // the perturbed intent the model actually saw
  candidates: string[];  // the (possibly perturbed) candidate set
  chosen: string;        // what the model wrongly routed to
  ground_truth: string;  // the correct route
}

export interface AttackReport {
  provider: string;
  seed: number;
  variant: Variant;
  total: number;
  clean_accuracy: number;
  attacks: AttackResult[];
  /** heatmap-ready: per case, correctness under clean + each attack (1/0). */
  matrix: { caseId: string; clean: number; [attack: string]: string | number }[];
  /** every misroute under attack (for coevo). */
  failures: Failure[];
  /** provenance: seed, tool-schema hash, oracle/version, model id, git sha (verifiable offline). */
  manifest: Manifest;
}

const bit = (b: boolean): number => (b ? 1 : 0);

export async function runAttacks(
  cases: RoutingCase[],
  provider: Provider,
  seed: number,
  attacks: Attack[] = ATTACKS,
  variant: Variant = 'single',
  stamp?: StampInput,
): Promise<AttackReport> {
  const clean = await runSuite(cases, provider, seed, variant);
  const cleanBy = new Map(clean.trajectories.map((t) => [t.caseId, bit(t.correct)]));
  const cleanArr = cases.map((c) => cleanBy.get(c.id) ?? 0);

  const matrix = cases.map((c) => ({ caseId: c.id, clean: cleanBy.get(c.id) ?? 0 }) as AttackReport['matrix'][number]);
  const failures: Failure[] = [];

  const results: AttackResult[] = [];
  for (const atk of attacks) {
    // guard the single choke-point every attack flows through: a perturbation may make routing
    // harder but must never silently change the true answer (throws MeaningPreservationError).
    const perturbed = cases.map((c) => { const p = atk.apply(c); assertMeaningPreserved(c, p); return p; });
    const run = await runSuite(perturbed, provider, seed, variant);
    const by = new Map(run.trajectories.map((t) => [t.caseId, bit(t.correct)]));
    const attackArr = cases.map((c) => by.get(c.id) ?? 0);
    matrix.forEach((row, i) => (row[atk.name] = attackArr[i]));
    // record every misroute under this attack — the coevo raw material
    run.trajectories.forEach((t, i) => {
      if (!t.correct) failures.push({
        attack: atk.name, caseId: t.caseId, intent: perturbed[i].intent,
        candidates: perturbed[i].candidates, chosen: t.routed, ground_truth: t.groundTruth,
      });
    });
    results.push({
      attack: atk.name,
      source: atk.source,
      accuracy: mean(attackArr),
      misroute_rate: 1 - mean(attackArr),
      robustness_delta: bootstrapDeltaCI(cleanArr, attackArr, seed),
    });
  }

  const toolNames = [...new Set(cases.flatMap((c) => c.candidates))];
  return {
    provider: provider.name,
    seed,
    variant,
    total: cases.length,
    clean_accuracy: mean(cleanArr),
    attacks: results,
    matrix,
    failures,
    manifest: buildManifest({ seed, variant, model: provider.name, toolNames, stamp }),
  };
}
