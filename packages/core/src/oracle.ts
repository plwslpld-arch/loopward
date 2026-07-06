// RoutingOracle: deterministic ground-truth scoring. No LLM-judge — a routing
// decision is either the correct candidate or it isn't.

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

export function scoreRoute(routed: string, groundTruth: string): { correct: boolean } {
  return { correct: norm(routed) === norm(groundTruth) };
}
