// RoutingOracle: deterministic ground-truth scoring. No LLM-judge — a routing
// decision is either the correct candidate or it isn't.

/** The one normalizer the oracle scores by. Exported so guards reuse the exact same rule
 *  and can never diverge into a second, independent judge. */
export const norm = (s: string | undefined): string => (s ?? '').normalize('NFC').trim().toLowerCase();

export function scoreRoute(routed: string, groundTruth: string): { correct: boolean } {
  return { correct: norm(routed) === norm(groundTruth) };
}
