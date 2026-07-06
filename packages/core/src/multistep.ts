// Multi-step loop: a real loop, not single-turn routing. The agent calls one tool at a time
// (seeing the task + what it has already called) and decides when to stop. This surfaces the
// loop failure modes single-turn routing cannot: premature-stop, over-run, and missteps.
// ponytail: reuses provider.route() by feeding task + history back in, candidates = tools + "done".
import type { Provider } from './types.ts';

export interface MultistepTask {
  id: string;
  task: string;
  tools: string[];
  required: string[]; // the correct tool set (order recorded but scored as a set for now)
}

export interface MultistepResult {
  taskId: string;
  called: string[];
  stopped: boolean;         // the model emitted "done"
  success: boolean;         // exactly the required tools, nothing extra, and stopped
  premature_stop: boolean;  // stopped with required tools still uncalled
  over_run: boolean;        // never stopped, or called extra/duplicate tools
  missing: string[];
  extra: string[];
  steps: number;
  trajectory: { step: number; action: string }[];
}

const DONE = 'done';
const lc = (s: string) => s.trim().toLowerCase();

export async function runMultistep(task: MultistepTask, provider: Provider, seed: number, maxExtra = 3): Promise<MultistepResult> {
  const maxSteps = task.required.length + maxExtra;
  const called: string[] = [];
  const trajectory: { step: number; action: string }[] = [];
  let stopped = false;

  for (let i = 0; i < maxSteps; i++) {
    // Feed observations back (a real loop shows tool results). We stub the result as "ok" —
    // enough signal that the step succeeded so the model can progress and know when to stop.
    const history = called.length
      ? `Progress so far:\n${called.map((t, j) => `  ${j + 1}. called ${t} → returned ok`).join('\n')}`
      : 'No tools called yet.';
    const prompt =
      `Task: ${task.task}\n${history}\n` +
      `Call one tool at a time; each tool you need should be called once. ` +
      `Reply with the single next tool to call, or "${DONE}" if every step the task needs is already done.`;
    const { tool } = await provider.route(prompt, [...task.tools, DONE], seed);
    trajectory.push({ step: i, action: tool });
    if (lc(tool) === DONE) { stopped = true; break; }
    called.push(tool);
  }

  const requiredSet = new Set(task.required.map(lc));
  const calledSet = new Set(called.map(lc));
  const missing = task.required.filter((r) => !calledSet.has(lc(r)));
  const extra = called.filter((c) => !requiredSet.has(lc(c)));
  const success = stopped && missing.length === 0 && extra.length === 0 && called.length === task.required.length;
  const premature_stop = stopped && missing.length > 0;
  const over_run = !stopped || extra.length > 0 || called.length > task.required.length;

  return { taskId: task.id, called, stopped, success, premature_stop, over_run, missing, extra, steps: called.length, trajectory };
}

export interface MultistepSummary {
  provider: string;
  seed: number;
  total: number;
  success_rate: number;
  premature_stop_rate: number;
  over_run_rate: number;
  avg_extra_calls: number;
  results: MultistepResult[];
}

export async function runMultistepSuite(tasks: MultistepTask[], provider: Provider, seed: number): Promise<MultistepSummary> {
  const results: MultistepResult[] = [];
  for (const t of tasks) results.push(await runMultistep(t, provider, seed));
  const rate = (f: (r: MultistepResult) => boolean) => (results.length ? results.filter(f).length / results.length : 0);
  const avg = (g: (r: MultistepResult) => number) => (results.length ? results.reduce((s, r) => s + g(r), 0) / results.length : 0);
  return {
    provider: provider.name,
    seed,
    total: results.length,
    success_rate: rate((r) => r.success),
    premature_stop_rate: rate((r) => r.premature_stop),
    over_run_rate: rate((r) => r.over_run),
    avg_extra_calls: avg((r) => r.extra.length),
    results,
  };
}
