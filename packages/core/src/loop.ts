import type { Provider, RoutingCase, Trajectory, Step } from './types.ts';
import { scoreRoute } from './oracle.ts';

export type Variant = 'single' | 'self-check';

/**
 * Run one case through the loop.
 *  - `single`: perceive → route → act → verify → stop (one shot).
 *  - `self-check`: perceive → route → reflect → act → verify → stop. The reflect node adds a
 *    second decision point (the model re-examines its own pick) — an extra attack surface, and
 *    the thing we measure: does a reflective loop recover routes an attack knocked over?
 * ponytail: reflection is done by re-calling route() with the first pick fed back in — no new
 * Provider method needed. The planner-subagent variant arrives with the multi-step loop.
 */
export async function runCase(c: RoutingCase, provider: Provider, seed: number, variant: Variant = 'single'): Promise<Trajectory> {
  const steps: Step[] = [];
  steps.push({ node: 'perceive', intent: c.intent, candidates: c.candidates });

  const first = await provider.route(c.intent, c.candidates, seed);
  steps.push({ node: 'route', routed: first.tool, raw: first.raw });
  let tool = first.tool;

  if (variant === 'self-check') {
    const reflectIntent =
      `${c.intent}\n(You initially chose "${first.tool}". Double-check it is the single best tool for the ` +
      `intent above; if another candidate fits better, switch. Reply with only the final tool name.)`;
    const second = await provider.route(reflectIntent, c.candidates, seed);
    steps.push({ node: 'reflect', from: first.tool, to: second.tool, changed: second.tool !== first.tool, raw: second.raw });
    tool = second.tool;
  }

  steps.push({ node: 'act', note: 'no-op (routing-only)' });

  const { correct } = scoreRoute(tool, c.ground_truth);
  steps.push({ node: 'verify', correct, groundTruth: c.ground_truth });
  steps.push({ node: 'stop', reason: `${variant} done` });

  return {
    caseId: c.id,
    intent: c.intent,
    candidates: c.candidates,
    routed: tool,
    groundTruth: c.ground_truth,
    correct,
    seed,
    provider: provider.name,
    steps,
  };
}

export interface RunSummary {
  total: number;
  correct: number;
  accuracy: number;
  provider: string;
  seed: number;
  variant: Variant;
  trajectories: Trajectory[];
}

export async function runSuite(cases: RoutingCase[], provider: Provider, seed: number, variant: Variant = 'single'): Promise<RunSummary> {
  const trajectories: Trajectory[] = [];
  for (const c of cases) trajectories.push(await runCase(c, provider, seed, variant));
  const correct = trajectories.filter((t) => t.correct).length;
  return {
    total: trajectories.length,
    correct,
    accuracy: trajectories.length ? correct / trajectories.length : 0,
    provider: provider.name,
    seed,
    variant,
    trajectories,
  };
}
