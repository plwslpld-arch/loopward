// Pure, zero-dep renderer for the CI robustness PR comment + shields.io badge.
// It ONLY formats fields already present on an AttackReport — it never scores, never calls a
// model, never touches wall-clock time or randomness. The deterministic oracle (scoreRoute)
// is the sole judge; this file just pretty-prints what the run already decided, so the same
// report always renders byte-identical Markdown (idempotent CI comment upserts, stable badges).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AttackReport } from '../../redteam/src/attack-run.ts';

/** Sentinel that lets CI find-and-replace its own comment instead of piling up new ones. */
export const MARKER = '<!-- loopward-robustness-report -->';

const pct = (x: number): string => (x * 100).toFixed(1) + '%';
const pp = (x: number): string => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'pp';

/** Fixed color ladder on the WORST-attack accuracy (shields.io named colors). */
export function badgeColor(worstAcc: number): string {
  if (worstAcc >= 0.90) return 'brightgreen';
  if (worstAcc >= 0.80) return 'green';
  if (worstAcc >= 0.70) return 'yellowgreen';
  if (worstAcc >= 0.60) return 'yellow';
  if (worstAcc >= 0.50) return 'orange';
  return 'red';
}

/** The single worst attack by accuracy (ties resolve to the first — attacks[] order). */
export function worstAttack(rep: AttackReport): { attack: string; accuracy: number } {
  let worst = { attack: rep.attacks[0]?.attack ?? 'none', accuracy: rep.attacks[0]?.accuracy ?? 0 };
  for (const a of rep.attacks) {
    if (a.accuracy < worst.accuracy) worst = { attack: a.attack, accuracy: a.accuracy };
  }
  return worst;
}

export interface Badge { schemaVersion: 1; label: string; message: string; color: string }

/** shields.io endpoint badge keyed on the worst attack. */
export function renderBadge(rep: AttackReport): Badge {
  const w = worstAttack(rep);
  return {
    schemaVersion: 1,
    label: 'routing robustness',
    message: `${pct(w.accuracy)} worst (${rep.provider}, n=${rep.total})`,
    color: badgeColor(w.accuracy),
  };
}

/** Grey "we never ran the attack suite" badge (no key / forked PR). */
export function unmeasuredBadge(): Badge {
  return { schemaVersion: 1, label: 'routing robustness', message: 'not measured', color: 'lightgrey' };
}

/** Markdown table of attacks, worst regression first (robustness_delta.delta desc). */
export function renderTable(rep: AttackReport): string {
  const rows = [...rep.attacks].sort((a, b) => b.robustness_delta.delta - a.robustness_delta.delta);
  const head = '| attack | acc | misroute | Δ | 95% CI |\n| --- | --- | --- | --- | --- |';
  const body = rows.map((a) => {
    const ci = `[${pp(a.robustness_delta.lo)}, ${pp(a.robustness_delta.hi)}]`;
    return `| ${a.attack} | ${pct(a.accuracy)} | ${pct(a.misroute_rate)} | ${pp(a.robustness_delta.delta)} | ${ci} |`;
  });
  return [head, ...body].join('\n');
}

/** The full PR comment. Starts with MARKER so CI can upsert it. Deterministic given the report. */
export function renderComment(rep: AttackReport, ctx?: { runUrl?: string }): string {
  const w = worstAttack(rep);
  const m = rep.manifest;
  const parts: string[] = [];
  parts.push(MARKER);
  parts.push('## Routing robustness');
  parts.push(
    `Clean accuracy **${pct(rep.clean_accuracy)}** · Worst attack **${w.attack} ${pct(w.accuracy)}** · n=${rep.total}`,
  );
  parts.push(renderTable(rep));
  if (ctx?.runUrl) parts.push(`[Full run ↗](${ctx.runUrl})`);
  const prov = [
    '<details><summary>Provenance</summary>',
    '',
    `- model: \`${m.model}\``,
    `- variant: \`${m.variant}\``,
    `- seed: \`${m.seed}\``,
    `- oracle_version: \`${m.oracle_version}\``,
    `- loopward_version: \`${m.loopward_version}\``,
    `- tool_schema_hash: \`${m.tool_schema_hash}\``,
    `- git_sha: \`${m.git_sha}\``,
    '',
    '_Scored by a deterministic oracle — never an LLM judge._',
    '</details>',
  ].join('\n');
  parts.push(prov);
  return parts.join('\n\n') + '\n';
}

/** Body used when the attack suite was skipped (no key or forked PR): audit-only, no scoring. */
export function renderAuditOnly(auditText: string): string {
  return [
    MARKER,
    '## Routing robustness',
    '_Attack suite skipped (no API key / forked PR) — showing confusability audit only._',
    '',
    auditText.trim(),
    '',
    '_Scored by a deterministic oracle — never an LLM judge._',
  ].join('\n') + '\n';
}

// ---- argv dispatcher (formats only; never scores) --------------------------------------------
// --badge / --comment take the OUTPUT PATH (so CI can write into _site/), each defaulting to a
// conventional filename when given as a bare flag. --audit-only takes the input audit-text path.
export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      badge: { type: 'string' },
      comment: { type: 'string' },
      'audit-only': { type: 'string' },
      unmeasured: { type: 'boolean' },
      'run-url': { type: 'string' },
    },
  });
  const badgePath = values.badge === '' ? 'robustness.json' : values.badge;   // bare `--badge` -> default name
  const commentPath = values.comment === '' ? 'comment.md' : values.comment;

  // Grey "not measured" badge needs no report.
  if (values.unmeasured) {
    writeFileSync(badgePath ?? 'robustness.json', JSON.stringify(unmeasuredBadge(), null, 2) + '\n');
    return 0;
  }

  // Audit-only: --audit-only is the path to a plain-text confusability audit, not a report.
  if (values['audit-only'] !== undefined) {
    const txt = readFileSync(values['audit-only'], 'utf8');
    writeFileSync(commentPath ?? 'comment.md', renderAuditOnly(txt));
    return 0;
  }

  const path = positionals[0];
  if (!path) {
    process.stderr.write('render-pr: missing report path (positional)\n');
    return 1;
  }
  const rep = JSON.parse(readFileSync(path, 'utf8')) as AttackReport;
  if (!Array.isArray(rep.attacks) || rep.attacks.length === 0) {
    process.stderr.write('render-pr: report has no attacks[] to render\n');
    return 1;
  }

  // Write whichever outputs were requested; if neither flag was given, write both to defaults.
  if (badgePath === undefined && commentPath === undefined) {
    writeFileSync('comment.md', renderComment(rep, { runUrl: values['run-url'] }));
    writeFileSync('robustness.json', JSON.stringify(renderBadge(rep), null, 2) + '\n');
    return 0;
  }
  if (commentPath !== undefined) writeFileSync(commentPath, renderComment(rep, { runUrl: values['run-url'] }));
  if (badgePath !== undefined) writeFileSync(badgePath, JSON.stringify(renderBadge(rep), null, 2) + '\n');
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
