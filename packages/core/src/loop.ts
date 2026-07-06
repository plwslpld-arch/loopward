import type { Provider, RoutingCase, Trajectory, Step } from './types.ts';
import { scoreRoute } from './oracle.ts';

/**
 * The `single` variant: one pass through the 5-node loop
 * (perceive → route → act → verify → stop). For routing-only cases (W1) `act` is a
 * no-op and `stop` fires after one iteration. Multi-step execution and the other
 * variants (self-check, planner-subagent) arrive in W2/W3.
 */
export async function runCase(c: RoutingCase, provider: Provider, seed: number): Promise<Trajectory> {
  const steps: Step[] = [];

  steps.push({ node: 'perceive', intent: c.intent, candidates: c.candidates });

  const { tool, raw } = await provider.route(c.intent, c.candidates, seed);
  steps.push({ node: 'route', routed: tool, raw });

  steps.push({ node: 'act', note: 'no-op (routing-only)' });

  const { correct } = scoreRoute(tool, c.ground_truth);
  steps.push({ node: 'verify', correct, groundTruth: c.ground_truth });

  steps.push({ node: 'stop', reason: 'single-variant one-shot' });

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
  trajectories: Trajectory[];
}

export async function runSuite(cases: RoutingCase[], provider: Provider, seed: number): Promise<RunSummary> {
  const trajectories: Trajectory[] = [];
  for (const c of cases) trajectories.push(await runCase(c, provider, seed));
  const correct = trajectories.filter((t) => t.correct).length;
  return {
    total: trajectories.length,
    correct,
    accuracy: trajectories.length ? correct / trajectories.length : 0,
    provider: provider.name,
    seed,
    trajectories,
  };
}
