import type { Provider, RouteResult } from './types.ts';

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Deterministic stand-in "model": picks the candidate whose name shares the most
 * tokens with the intent (first candidate on a tie). Runs offline with zero deps so
 * the whole pipeline is testable without an API key. Real robustness numbers need a
 * real provider — this is a plumbing stand-in, not a model under test.
 * ponytail: token-overlap heuristic; the real signal comes from the deepseek provider.
 */
export const mockProvider: Provider = {
  name: 'mock',
  async route(intent, candidates, _seed): Promise<RouteResult> {
    const it = tokens(intent);
    let best = candidates[0];
    let bestScore = -1;
    for (const c of candidates) {
      const s = overlap(it, tokens(c));
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return { tool: best, raw: `overlap-pick score=${bestScore}` };
  },
};

/**
 * DeepSeek (OpenAI-compatible) via plain fetch — no SDK dependency. Needs DEEPSEEK_API_KEY.
 * ponytail: routing is a single structured decision, so a plain call is right here.
 * Adopt Vercel AI SDK at W3 when the planner-subagent variant needs real multi-step tool-calling.
 */
export function deepseekProvider(opts: { model?: string; apiKey?: string } = {}): Provider {
  const model = opts.model ?? 'deepseek-chat';
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
  return {
    name: `deepseek:${model}`,
    async route(intent, candidates, seed): Promise<RouteResult> {
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
      const sys =
        'You are a tool router. Given a user intent and a list of candidate tools, ' +
        'reply with ONLY the exact name of the single best tool. No explanation.';
      const user = `Intent: ${intent}\nCandidates: ${candidates.join(', ')}\nAnswer with one exact candidate name.`;
      const body = JSON.stringify({
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0,
        seed,
      });
      // ponytail: 3 tries with linear backoff — a single transient blip shouldn't abort a 300-call run.
      let res: Response | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body,
          });
          if (res.ok) break;
          if (res.status < 500 && res.status !== 429) throw new Error(`deepseek ${res.status}: ${await res.text()}`);
        } catch (e) {
          if (attempt === 3) throw e;
        }
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
      if (!res || !res.ok) throw new Error(`deepseek failed after retries: ${res?.status ?? 'network'}`);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const raw = (data.choices?.[0]?.message?.content ?? '').trim();
      // snap the free-text answer to the closest candidate (exact, then substring)
      const exact = candidates.find((c) => c.toLowerCase() === raw.toLowerCase());
      const tool = exact ?? candidates.find((c) => raw.toLowerCase().includes(c.toLowerCase())) ?? raw;
      return { tool, raw };
    },
  };
}

export function getProvider(name: string): Provider {
  if (name === 'mock') return mockProvider;
  if (name === 'deepseek') return deepseekProvider();
  throw new Error(`unknown provider: ${name} (use: mock | deepseek)`);
}
