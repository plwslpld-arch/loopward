// gate: a deterministic baseline-vs-current REGRESSION gate for CI. Given two AttackReports it decides
// whether the current run is significantly worse than the baseline on clean routing or any shared attack.
// Pure function of the two report objects — no provider, no Date, no git, fixed seeds — so the same pair
// always yields the same verdict. The deterministic oracle already scored every case (the reports carry
// 0/1 matrices); this module only compares those columns, it never re-judges a route or calls an LLM.
//
// Default (paired) mode aligns the two runs case-by-case (identical caseId sets required) and, per metric,
// runs the same seeded paired bootstrap + one-sided sign-flip permutation test the rest of the suite uses,
// then Holm-corrects across all gated metrics. A metric only fails the gate if it is BOTH statistically
// significant (Holm-p < alpha) AND practically meaningful (the bootstrap lower bound clears an explicit
// tolerance margin). Improvements never fail.
import { bootstrapDeltaCI, mean } from '../../redteam/src/metrics.ts';
import type { DeltaCI } from '../../redteam/src/metrics.ts';
import { holm, permutationPValue } from './stats/multiseed.ts';
import { verifyReport } from './verify.ts';
import type { AttackReport } from '../../redteam/src/attack-run.ts';

export interface GateMetric {
  metric: string;   // 'clean' or an attack name
  drop: number;     // mean(baselineCol) - mean(currentCol); >0 = current is worse (regression direction)
  ci: DeltaCI;      // paired bootstrap of the drop (paired mode); baseline robustness band (unpaired mode)
  p: number;        // one-sided permutation p that the drop > 0 (NaN in unpaired mode — no test is run)
  p_holm: number;   // Holm-adjusted across all gated metrics (NaN in unpaired mode)
  regressed: boolean;
}

export interface GateResult {
  pass: boolean;
  mode: 'paired' | 'unpaired';
  metrics: GateMetric[];
  missing_attacks: string[]; // attacks in baseline but absent from current (coverage gap => fail)
  guard_errors: string[];    // provenance/comparability violations that hard-stop the gate
  note: string;
}

export interface GateOpts {
  tolerance?: number;        // practical-significance margin the CI lower bound must clear (default 0)
  alpha?: number;            // family-wise significance level after Holm (default 0.05)
  unpaired?: boolean;        // heuristic fallback when the two runs cover different caseId sets
  allowSchemaChange?: boolean; // permit a differing tool_schema_hash between the two runs
}

const PERM_SEED = 1337;
const PERM_B = 2000;

const caseIdSet = (r: AttackReport): Set<string> => new Set(r.matrix.map((row) => row.caseId));

function sameCases(a: AttackReport, b: AttackReport): boolean {
  const sa = caseIdSet(a), sb = caseIdSet(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

export function regressionGate(baseline: AttackReport, current: AttackReport, opts: GateOpts = {}): GateResult {
  const tolerance = opts.tolerance ?? 0;
  const alpha = opts.alpha ?? 0.05;
  const unpaired = opts.unpaired ?? false;
  const allowSchemaChange = opts.allowSchemaChange ?? false;
  const mode: GateResult['mode'] = unpaired ? 'unpaired' : 'paired';

  const guard_errors: string[] = [];

  // 1) Both reports must be internally consistent — a fabricated column would poison the comparison.
  if (!verifyReport(baseline).pass) guard_errors.push('baseline failed verifyReport (internally inconsistent report)');
  if (!verifyReport(current).pass) guard_errors.push('current failed verifyReport (internally inconsistent report)');

  // 2) Comparability guards: same provider, same variant, same tool schema (unless explicitly allowed).
  if (baseline.provider !== current.provider) guard_errors.push(`provider mismatch: baseline=${baseline.provider} current=${current.provider}`);
  if (baseline.variant !== current.variant) guard_errors.push(`variant mismatch: baseline=${baseline.variant} current=${current.variant}`);
  if (!allowSchemaChange && baseline.manifest.tool_schema_hash !== current.manifest.tool_schema_hash) {
    guard_errors.push(`tool_schema_hash mismatch: baseline=${baseline.manifest.tool_schema_hash} current=${current.manifest.tool_schema_hash} (pass allowSchemaChange to override)`);
  }

  // 3) Case alignment: paired mode demands identical caseId sets; unpaired opts out of the paired test.
  const aligned = sameCases(baseline, current);
  if (!unpaired && !aligned) {
    guard_errors.push('caseId sets differ between baseline and current (pass unpaired for a heuristic, non-test comparison)');
  }

  // 4) Coverage: every attack the baseline measured must still be present in current.
  const currentAttacks = new Set(current.attacks.map((a) => a.attack));
  const missing_attacks = baseline.attacks.map((a) => a.attack).filter((n) => !currentAttacks.has(n));

  // Hard stops: any guard violation short-circuits before we compute metrics (they would be meaningless).
  if (guard_errors.length > 0) {
    return {
      pass: false, mode, metrics: [], missing_attacks, guard_errors,
      note: 'Gate did not run: comparability/consistency guards failed. No metric comparison was performed.',
    };
  }

  if (unpaired) return unpairedGate(baseline, current, tolerance, missing_attacks);
  return pairedGate(baseline, current, tolerance, alpha, missing_attacks);
}

function pairedGate(baseline: AttackReport, current: AttackReport, tolerance: number, alpha: number, missing_attacks: string[]): GateResult {
  const baseRow = new Map(baseline.matrix.map((r) => [r.caseId, r]));
  const curRow = new Map(current.matrix.map((r) => [r.caseId, r]));
  const ids = baseline.matrix.map((r) => r.caseId); // caseId sets are identical here (guard passed)

  // gated columns: clean routing + every attack shared by both reports.
  const sharedAttacks = baseline.attacks.map((a) => a.attack).filter((n) => current.attacks.some((c) => c.attack === n));
  const cols = ['clean', ...sharedAttacks];

  const raw = cols.map((col) => {
    const baselineCol = ids.map((id) => Number(baseRow.get(id)![col]));
    const currentCol = ids.map((id) => Number(curRow.get(id)![col]));
    const drop = mean(baselineCol) - mean(currentCol); // >0 means current lost accuracy vs baseline
    const ci = bootstrapDeltaCI(baselineCol, currentCol, current.seed);
    const p = permutationPValue(baselineCol, currentCol, PERM_SEED, PERM_B, 'greater');
    return { metric: col, drop, ci, p };
  });

  const pHolm = holm(raw.map((r) => r.p));
  const metrics: GateMetric[] = raw.map((r, i) => ({
    metric: r.metric,
    drop: r.drop,
    ci: r.ci,
    p: r.p,
    p_holm: pHolm[i],
    // regression = statistically significant (Holm) AND the whole CI clears the tolerance margin.
    // Improvements (drop<0 => ci.lo<0) can never satisfy ci.lo > tolerance, so they never fail.
    regressed: pHolm[i] < alpha && r.ci.lo > tolerance,
  }));

  const pass = missing_attacks.length === 0 && metrics.every((m) => !m.regressed);
  return {
    pass, mode: 'paired', metrics, missing_attacks, guard_errors: [],
    note: `paired mode, n=${ids.length}, tolerance=${tolerance}, alpha=${alpha}. Per metric: seeded paired bootstrap of the accuracy drop + one-sided sign-flip permutation p (seed ${PERM_SEED}, B=${PERM_B}), Holm-corrected across ${cols.length} metrics; a metric fails only if Holm-p<${alpha} AND its bootstrap lower bound > ${tolerance}. Honest limit: the paired bootstrap captures case-sampling uncertainty, NOT model run-to-run stochasticity (temperature-0 / seed-invariant providers give no independent run variance to resample); the tolerance is the explicit margin standing in for that unmodeled noise.`,
  };
}

function unpairedGate(baseline: AttackReport, current: AttackReport, tolerance: number, missing_attacks: string[]): GateResult {
  // ponytail: the two runs cover different cases, so no paired test exists. We fall back to a coarse
  // accuracy comparison: current is flagged only if its attacked accuracy drops below baseline by more
  // than the tolerance PLUS half the baseline's own robustness CI width (a rough noise band). p/p_holm
  // are left NaN to make explicit that this is a heuristic screen, not a hypothesis test.
  const sharedAttacks = baseline.attacks.filter((a) => current.attacks.some((c) => c.attack === a.attack));
  const metrics: GateMetric[] = sharedAttacks.map((b) => {
    const c = current.attacks.find((x) => x.attack === b.attack)!;
    const drop = b.accuracy - c.accuracy; // >0 means current is worse under this attack
    const margin = (b.robustness_delta.hi - b.robustness_delta.lo) / 2;
    return {
      metric: b.attack,
      drop,
      ci: b.robustness_delta, // reference band the margin is derived from (not a comparison CI)
      p: NaN,
      p_holm: NaN,
      regressed: drop > tolerance + margin,
    };
  });

  const pass = missing_attacks.length === 0 && metrics.every((m) => !m.regressed);
  return {
    pass, mode: 'unpaired', metrics, missing_attacks, guard_errors: [],
    note: `unpaired HEURISTIC (not a statistical test): baseline and current cover different caseId sets, so no paired test is possible. Per shared attack, current fails if (baseline.acc - current.acc) > tolerance(${tolerance}) + half the baseline robustness-CI width. Treat as a smoke screen, not evidence; re-run on a shared case set for a real gate.`,
  };
}

const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : x.toFixed(4));

export function formatGate(r: GateResult): string {
  const lines: string[] = [];
  lines.push(`gate: ${r.mode} mode`);
  if (r.guard_errors.length > 0) {
    lines.push('');
    lines.push('GUARD ERRORS:');
    for (const g of r.guard_errors) lines.push(`  XX  ${g}`);
  }
  if (r.missing_attacks.length > 0) {
    lines.push('');
    lines.push(`MISSING ATTACKS (present in baseline, absent from current): ${r.missing_attacks.join(', ')}`);
  }
  if (r.metrics.length > 0) {
    lines.push('');
    for (const m of r.metrics) {
      const verdict = m.regressed ? 'REGRESSED' : m.drop < 0 ? 'ok (improved)' : 'ok';
      lines.push(`  ${m.regressed ? 'XX' : 'ok'}  ${m.metric.padEnd(16)} drop=${m.drop.toFixed(4)}  ci.lo=${pct(m.ci.lo)}  p_holm=${pct(m.p_holm)}  ${verdict}`);
    }
  }
  lines.push('');
  lines.push(r.pass ? 'PASS — no metric regressed beyond tolerance.' : 'FAIL — a regression, missing attack, or guard violation was detected.');
  lines.push('');
  lines.push(r.note);
  return lines.join('\n');
}
