// verify: an offline CONSISTENCY LINTER for a report. It re-derives the deterministic fields (the
// tool-schema hash, per-attack accuracy, and the seeded bootstrap CIs) from the report's own matrix
// and checks they agree. It does NOT prove the run happened: the model's raw outputs aren't stored,
// so a fabricated-but-internally-consistent report would also pass. It never instantiates a provider
// and never re-judges a route — the deterministic oracle stays the sole scorer, reused via scoreRoute.
import { scoreRoute } from '../../core/src/oracle.ts';
import { toolSchemaHash } from '../../core/src/manifest.ts';
import { bootstrapDeltaCI, mean } from '../../redteam/src/metrics.ts';

export interface Check { name: string; ok: boolean; detail?: string }
export interface VerifyResult { pass: boolean; checks: Check[] }

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

export function verifyReport(report: any): VerifyResult {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const m = report?.manifest;
  const matrix: any[] = report?.matrix;
  const attacks: any[] = report?.attacks;

  const mOk = !!m && typeof m.tool_schema_hash === 'string' && Array.isArray(m.tools) && typeof m.seed === 'number';
  add('manifest present and typed', mOk);
  if (mOk) {
    add('tool_schema_hash matches recorded tools', toolSchemaHash(m.tools) === m.tool_schema_hash);
    add('seed/variant consistent with manifest', report.seed === m.seed && report.variant === m.variant);
  }
  add('total === matrix rows', Array.isArray(matrix) && report.total === matrix.length);

  if (Array.isArray(matrix) && Array.isArray(attacks)) {
    const cols = ['clean', ...attacks.map((a) => a.attack)];
    add('matrix cells are all 0/1', matrix.every((r) => cols.every((c) => r[c] === 0 || r[c] === 1)));
    add('clean_accuracy recomputes', close(mean(matrix.map((r) => r.clean)), report.clean_accuracy));

    const cleanCol = matrix.map((r) => Number(r.clean));
    let accOk = true, ciOk = true;
    for (const a of attacks) {
      const col = matrix.map((r) => Number(r[a.attack]));
      if (!close(mean(col), a.accuracy) || !close(1 - mean(col), a.misroute_rate)) accOk = false;
      const ci = bootstrapDeltaCI(cleanCol, col, report.seed);
      const d = a.robustness_delta;
      if (!close(ci.delta, d.delta) || !close(ci.lo, d.lo) || !close(ci.hi, d.hi)) ciOk = false;
    }
    add('per-attack accuracy recomputes', accOk);
    add('bootstrap CIs reproduce (seeded; marginal, uncorrected)', ciOk);
  }

  if (Array.isArray(report.failures)) {
    add('failures are genuine misroutes (oracle-checked)',
      report.failures.every((f: any) => scoreRoute(f.chosen, f.ground_truth).correct === false));
  }
  return { pass: checks.every((c) => c.ok), checks };
}

export function formatVerify(r: VerifyResult): string {
  const lines = r.checks.map((c) => `  ${c.ok ? 'ok' : 'XX'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  lines.push('');
  lines.push(r.pass
    ? 'PASS — report is internally consistent (a consistency check, not a proof the run happened).'
    : 'FAIL — report has internal inconsistencies.');
  return lines.join('\n');
}
