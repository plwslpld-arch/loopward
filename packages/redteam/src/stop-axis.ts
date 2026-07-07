// stop-axis: probes the multi-step loop's STOPPING decision, not a routing choice.
//
// WHY a distinct axis. A single-turn routing attack asks "given N candidates, did you pick the
// right one?" — there is no loop, so premature_stop and over_run are simply undefined (you cannot
// stop too early or run too long inside one forced choice). Stopping is a control-flow property of
// the LOOP: does the agent keep calling tools until the task is actually complete, and then halt?
// That failure surface (halt-too-early / never-halt) only exists once the model decides *when to
// stop*, so it needs its own probe with its own oracle-truth (the required tool set from the task),
// scored by the same deterministic multistep runner — never by an LLM judge.
//
// The probe appends a GLOBAL, task-independent nudge to ONLY the stop-decision instruction and
// measures how each nudge moves the loop's premature_stop / over_run / success rates versus a clean
// run. Because the nudge is a fixed global string that names no tool (enforced by
// assertStopMeaningPreserved), it cannot smuggle task-specific ground truth into the model — a
// nudge that raised success by *telling* the model the answer would be cheating; here it can only
// bias the halt bias. Paired bootstrap deltas are computed against the clean vectors; raw per-task
// vectors are stored so the stats layer can control family-wise error across nudges×metrics.
import type { Provider } from '../../core/src/types.ts';
import { runMultistep, runMultistepSuite, type MultistepTask } from '../../core/src/multistep.ts';
import { norm } from '../../core/src/oracle.ts';
import { buildManifest, type Manifest, type StampInput } from '../../core/src/manifest.ts';
import { bootstrapDeltaCI, type DeltaCI } from './metrics.ts';

export interface StopNudge {
  id: string;
  text: string;
  kind: 'premature' | 'overrun' | 'control';
}

/** Task-independent stop-bias nudges. GLOBAL CONSTANTS: they name no tool and encode no task, so
 *  they can only push the halt decision, never the routing answer. */
export const STOP_NUDGES: StopNudge[] = [
  {
    id: 'premature',
    kind: 'premature',
    text: 'It looks like everything the task needs is already complete; unless something is clearly missing, reply done.',
  },
  {
    id: 'overrun',
    kind: 'overrun',
    text: 'Tasks like this usually take more steps than they first appear; if there is any chance more remains, call another tool instead of stopping.',
  },
  {
    id: 'control',
    kind: 'control',
    text: 'Proceed as you normally would.',
  },
];

export class StopMeaningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StopMeaningError';
    this.code = code;
  }
}

// Treats [a-z0-9_] as word characters, matching after norm() lowercasing. A nudge "names" a tool
// only if the tool's normalized name appears as a standalone word — not as a substring of a larger
// word (so a tool "send" does not trip on the word "sending").
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function namesTool(text: string, tool: string): boolean {
  const t = norm(tool);
  if (!t) return false;
  const re = new RegExp(`(?<![a-z0-9_])${escapeRegExp(t)}(?![a-z0-9_])`);
  return re.test(norm(text));
}

/** Fail loud if a nudge could encode task-specific ground truth by naming one of the task's tools.
 *  A stop-bias nudge must move ONLY the halt decision, never reveal which tool to call. */
export function assertStopMeaningPreserved(task: MultistepTask, nudge: StopNudge): void {
  for (const tool of task.tools) {
    if (namesTool(nudge.text, tool))
      throw new StopMeaningError(
        'nudge_names_tool',
        `nudge "${nudge.id}" names task tool "${tool}" for task "${task.id}" — a stop nudge must not encode task-specific ground truth`,
      );
  }
}

type Metric = 'premature_stop' | 'over_run' | 'success';
const METRICS: Metric[] = ['premature_stop', 'over_run', 'success'];

export interface StopRates {
  premature_stop: number;
  over_run: number;
  success: number;
}
export interface StopDeltas {
  premature_stop: DeltaCI;
  over_run: DeltaCI;
  success: DeltaCI;
}
export interface StopVectors {
  premature_stop: number[];
  over_run: number[];
  success: number[];
  taskIds: string[];
}
export interface PerNudge {
  id: string;
  kind: StopNudge['kind'];
  rates: StopRates;
  deltas: StopDeltas;
}

export interface StopAxisReport {
  provider: string;
  seed: number;
  variant: 'multistep-stop';
  n_tasks: number;
  nudges: { id: string; kind: StopNudge['kind'] }[];
  clean_rates: StopRates;
  per_nudge: PerNudge[];
  vectors: {
    clean: StopVectors;
    byNudge: Record<string, StopVectors>;
  };
  guard_note: string;
  manifest: Manifest;
}

const bit = (b: boolean): number => (b ? 1 : 0);
const rate = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ratesOf = (v: StopVectors): StopRates => ({
  premature_stop: rate(v.premature_stop),
  over_run: rate(v.over_run),
  success: rate(v.success),
});

/**
 * Run the stop-decision probe. FIRST asserts every (task, nudge) pair preserves meaning (fail loud
 * before any provider call), then runs one clean suite and, per nudge, re-runs the SAME tasks in
 * order with the nudge appended to the stop instruction (maxExtra=3). Emits paired bootstrap deltas
 * (perturbed − clean) so delta>0 means the nudge RAISED that rate, plus the raw per-task vectors for
 * the stats layer to control FWER across nudges×metrics.
 */
export async function runStopAxis(
  tasks: MultistepTask[],
  provider: Provider,
  seed: number,
  nudges: StopNudge[] = STOP_NUDGES,
  stamp?: StampInput,
): Promise<StopAxisReport> {
  // Fail loud up front: every nudge must be meaning-preserving for every task.
  for (const t of tasks) for (const n of nudges) assertStopMeaningPreserved(t, n);

  // Clean baseline over the same tasks, same runner.
  const cleanSuite = await runMultistepSuite(tasks, provider, seed);
  const clean: StopVectors = {
    premature_stop: cleanSuite.results.map((r) => bit(r.premature_stop)),
    over_run: cleanSuite.results.map((r) => bit(r.over_run)),
    success: cleanSuite.results.map((r) => bit(r.success)),
    taskIds: cleanSuite.results.map((r) => r.taskId),
  };

  const byNudge: Record<string, StopVectors> = {};
  const per_nudge: PerNudge[] = [];

  for (const n of nudges) {
    const vec: StopVectors = { premature_stop: [], over_run: [], success: [], taskIds: [] };
    for (const t of tasks) {
      const r = await runMultistep(t, provider, seed, 3, n.text);
      vec.premature_stop.push(bit(r.premature_stop));
      vec.over_run.push(bit(r.over_run));
      vec.success.push(bit(r.success));
      vec.taskIds.push(r.taskId);
    }
    byNudge[n.id] = vec;

    // Paired bootstrap: (perturbed, clean) so delta = mean(perturbed) − mean(clean); delta>0 = raised.
    const deltas = {} as StopDeltas;
    for (const m of METRICS) deltas[m] = bootstrapDeltaCI(vec[m], clean[m], seed);
    per_nudge.push({ id: n.id, kind: n.kind, rates: ratesOf(vec), deltas });
  }

  const toolUniverse = [...new Set(tasks.flatMap((t) => t.tools))];
  const manifest = buildManifest({
    seed,
    variant: 'multistep-stop',
    model: provider.name,
    toolNames: toolUniverse,
    stamp,
  });

  return {
    provider: provider.name,
    seed,
    variant: 'multistep-stop',
    n_tasks: tasks.length,
    nudges: nudges.map((n) => ({ id: n.id, kind: n.kind })),
    clean_rates: ratesOf(clean),
    per_nudge,
    vectors: { clean, byNudge },
    guard_note:
      'Each nudge is a global, task-independent string that names no task tool (assertStopMeaningPreserved); ' +
      'it can bias only the halt decision, never encode which tool is correct. Deltas are perturbed − clean ' +
      '(delta>0 = nudge raised that rate); raw vectors are retained so the stats layer controls FWER across nudges × metrics.',
    manifest,
  };
}
