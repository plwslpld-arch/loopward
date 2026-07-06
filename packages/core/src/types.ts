// Core data shapes for LoopBench. Kept deliberately small for W1 (routing-only).

/** One routing test case with deterministic ground truth. */
export interface RoutingCase {
  id: string;
  intent: string;
  candidates: string[];      // tool/skill names the loop must choose among
  ground_truth: string;      // the single correct candidate
  expected_stop?: boolean;   // used from W2+; W1 is one-shot
}

export interface RouteResult {
  tool: string;
  raw?: string;              // provider's raw response, for the trajectory trace
}

export interface Provider {
  name: string;
  /** Pick exactly one candidate for the given intent. `seed` is recorded for reproducibility. */
  route(intent: string, candidates: string[], seed: number): Promise<RouteResult>;
  /** Free-text completion, used to synthesize test intents from a user's own tools. */
  generate?(prompt: string, seed: number): Promise<string>;
}

export interface Step {
  node: 'perceive' | 'route' | 'reflect' | 'act' | 'verify' | 'stop';
  [k: string]: unknown;
}

export interface Trajectory {
  caseId: string;
  intent: string;
  candidates: string[];
  routed: string;
  groundTruth: string;
  correct: boolean;
  seed: number;
  provider: string;
  steps: Step[];
}
