import type { Provider, RoutingCase, Trajectory, Step } from './types.ts';
import { scoreRoute } from './oracle.ts';

export type Variant = 'single' | 'self-check' | 'react' | 'observe';

/**
 * Run one case through the loop. Four harness strategies, same deterministic oracle scoring the
 * result — so `matrix` can measure how much the HARNESS (not the model) changes robustness:
 *  - `single`:     perceive → route → act → verify → stop (one shot).
 *  - `self-check`: adds a reflect node (re-examine the pick before committing).
 *  - `react`:      think (free-text) → route, feeding the reasoning back into the pick.
 *  - `observe`:    route → observe(returned: ok) → maybe re-route, up to 2 feedback turns
 *                  (the routing analogue of the multi-step observation loop).
 * ponytail: every branch re-uses route()/generate() only, and ends in the same verify(scoreRoute)
 * tail — no new Provider method, oracle stays the sole scorer.
 */
export async function runCase(c: RoutingCase, provider: Provider, seed: number, variant: Variant = 'single'): Promise<Trajectory> {
  const steps: Step[] = [];
  steps.push({ node: 'perceive', intent: c.intent, candidates: c.candidates });
  let tool: string;

  if (variant === 'react') {
    const thought = provider.generate
      ? await provider.generate(`Think briefly about which single candidate tool best serves this intent, then name it.\nIntent: ${c.intent}\nCandidates: ${c.candidates.join(', ')}`, seed)
      : '';
    steps.push({ node: 'think', thought });
    const r = await provider.route(thought ? `${c.intent}\n(Reasoning: ${thought})` : c.intent, c.candidates, seed);
    steps.push({ node: 'route', routed: r.tool, raw: r.raw });
    tool = r.tool;
  } else if (variant === 'observe') {
    let pick = (await provider.route(c.intent, c.candidates, seed)).tool;
    steps.push({ node: 'route', routed: pick });
    for (let k = 0; k < 2; k++) {
      const next = (await provider.route(
        `${c.intent}\nYou selected "${pick}" and it returned: ok. Given that observation, reply with the single best final tool name (keep "${pick}" if it is already correct).`,
        c.candidates, seed)).tool;
      steps.push({ node: 'observe', from: pick, to: next, changed: next !== pick });
      if (next === pick) break;
      pick = next;
    }
    tool = pick;
  } else {
    const first = await provider.route(c.intent, c.candidates, seed);
    steps.push({ node: 'route', routed: first.tool, raw: first.raw });
    tool = first.tool;
    if (variant === 'self-check') {
      const reflectIntent =
        `${c.intent}\n(You initially chose "${first.tool}". Double-check it is the single best tool for the ` +
        `intent above; if another candidate fits better, switch. Reply with only the final tool name.)`;
      const second = await provider.route(reflectIntent, c.candidates, seed);
      steps.push({ node: 'reflect', from: first.tool, to: second.tool, changed: second.tool !== first.tool, raw: second.raw });
      tool = second.tool;
    }
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
