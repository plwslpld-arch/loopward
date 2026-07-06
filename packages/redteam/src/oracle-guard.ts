// oracle-guard: a deterministic, structural meaning-preservation guard for attack perturbations.
// A perturbation is allowed to make routing HARDER (add decoys, reword the intent), but it must never
// silently change WHAT the correct answer is. This is a runtime invariant wired into runAttacks, so a
// mis-parameterized future attack fails loudly instead of quietly flipping ground truth.
//
// It is STRUCTURAL only. It reuses the oracle's exact normalizer and never picks or scores a route, so
// the deterministic oracle stays the sole scorer. It deliberately does NOT try to decide "would a human
// read this differently?" — that semantic axis is out of scope (a regex meaning-classifier would both
// overreach and crash on legitimate foo/foo_v2 catalogs), and is instead surfaced honestly by the gold
// slice below as known false-negatives.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { norm } from '../../core/src/oracle.ts';
import type { RoutingCase } from '../../core/src/types.ts';

export class MeaningPreservationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MeaningPreservationError';
    this.code = code;
  }
}

const count = (arr: string[], target: string): number => arr.filter((x) => norm(x) === norm(target)).length;

/** Throw on the FIRST violated structural invariant; return silently if the perturbation is admissible. */
export function assertMeaningPreserved(before: RoutingCase, after: RoutingCase): void {
  // I1 — the true answer must not change.
  if (norm(after.ground_truth) !== norm(before.ground_truth))
    throw new MeaningPreservationError('gt_changed', `ground_truth changed: ${before.ground_truth} -> ${after.ground_truth}`);
  // I2 — the true answer must remain selectable.
  if (!after.candidates.some((x) => norm(x) === norm(after.ground_truth)))
    throw new MeaningPreservationError('gt_not_candidate', `ground_truth ${after.ground_truth} is not among candidates`);
  // I3 — attacks may ADD decoys but must never remove/rename a real option (that changes the choice set).
  for (const c of before.candidates)
    if (!after.candidates.some((x) => norm(x) === norm(c)))
      throw new MeaningPreservationError('candidate_dropped', `candidate dropped: ${c}`);
  // I4 — the true answer must be unambiguous (exactly one matching candidate).
  if (count(after.candidates, after.ground_truth) !== 1)
    throw new MeaningPreservationError('gt_duplicated', `ground_truth ${after.ground_truth} appears ${count(after.candidates, after.ground_truth)} times`);
  // I5 — the intent must not be emptied to nothing.
  if (after.intent.trim().length === 0)
    throw new MeaningPreservationError('empty_intent', 'intent perturbed to empty');
}

// ---- gold slice: honest guard recall (NOT a chance-corrected agreement) -------------------------

export interface GoldRow {
  id: string;
  kind: string;                        // what the row exercises
  before: RoutingCase;
  after: RoutingCase;
  human_label: 'preserved' | 'flipped';
  note?: string;
}

/** The guard's verdict on a row: does the structural invariant catch it? */
export function guardVerdict(row: GoldRow): 'preserved' | 'flipped' {
  try { assertMeaningPreserved(row.before, row.after); return 'preserved'; }
  catch (e) { if (e instanceof MeaningPreservationError) return 'flipped'; throw e; }
}

export interface GuardRecall {
  n: number;
  flips: number;              // human-labeled meaning-flips
  caught: number;             // flips the structural guard catches
  missed: number;             // flips it cannot see (semantic-only) — honest false-negatives
  false_positives: number;    // preserving rows it wrongly rejects — must be 0 by design
  recall: number;             // caught / flips
  misses: string[];           // notes on what slips through
}

/**
 * The guard is a one-sided structural detector: it should catch every STRUCTURAL flip and never reject a
 * genuinely meaning-preserving perturbation (false_positives must be 0). It cannot catch SEMANTIC-only
 * flips; those are reported as `missed` rather than hidden. We report raw recall, not Cohen's kappa —
 * one rater is a deterministic function and the confusion matrix is triangular by design, so a
 * chance-corrected agreement statistic would misrepresent a one-sided false-negative rate.
 */
export function guardRecall(rows: GoldRow[]): GuardRecall {
  let caught = 0, missed = 0, false_positives = 0;
  const misses: string[] = [];
  for (const r of rows) {
    const g = guardVerdict(r);
    if (r.human_label === 'flipped') {
      if (g === 'flipped') caught++;
      else { missed++; misses.push(`${r.id}: ${r.note ?? r.kind}`); }
    } else if (g === 'flipped') {
      false_positives++;
      misses.push(`FALSE POSITIVE ${r.id}: guard rejected a meaning-preserving perturbation`);
    }
  }
  const flips = caught + missed;
  return { n: rows.length, flips, caught, missed, false_positives, recall: flips ? caught / flips : 1, misses };
}

export function loadGoldSlice(path?: string): GoldRow[] {
  const p = path ?? fileURLToPath(new URL('../../../datasets/gold/meaning-preservation.json', import.meta.url));
  return JSON.parse(readFileSync(p, 'utf8')).rows as GoldRow[];
}
