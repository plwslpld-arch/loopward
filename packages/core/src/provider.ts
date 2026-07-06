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
 * tokens with the intent (first on a tie). Runs offline with zero deps so the pipeline
 * is testable without an API key. A plumbing stand-in, not a model under test.
 * ponytail: token-overlap heuristic; real signal comes from a real provider.
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
  // deterministic offline stand-in: echo the tool's description as the synthesized intent
  async generate(prompt) {
    const m = prompt.match(/description:\s*(.+)/i);
    return (m?.[1] ?? prompt).trim();
  },
};

/**
 * Generic OpenAI-compatible chat provider (plain fetch, no SDK). Works with any gateway
 * that speaks /chat/completions — OpenAI, DeepSeek, or any proxy — by pointing baseURL at it.
 * Keys/URLs are injected by the caller from the environment; nothing is hardcoded here.
 * ponytail: routing is one structured call, so a plain request is right; adopt an agent SDK
 * at W3 only when the planner-subagent variant needs real multi-step tool-calling.
 */
export function openaiCompatibleProvider(opts: { name?: string; baseURL: string; apiKey?: string; model: string }): Provider {
  const url = opts.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const name = opts.name ?? `openai:${opts.model}`;

  async function chat(messages: { role: string; content: string }[], seed: number): Promise<string> {
    if (!opts.apiKey) throw new Error(`${name}: missing API key (set it in the environment)`);
    // Some newer/reasoning models reject temperature/seed. Start with them; drop on a 400 that names them.
    let sampling = true;
    const mkBody = () => JSON.stringify(sampling ? { model: opts.model, messages, temperature: 0, seed } : { model: opts.model, messages });
    // ponytail: 4 tries with linear backoff — a single transient blip shouldn't abort a 300-call run.
    let res: Response | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: mkBody(),
        });
        if (res.ok) break;
        const text = await res.text();
        if (res.status === 400 && sampling && /temperature|seed|top_p|sampling/i.test(text)) { sampling = false; continue; }
        if (res.status < 500 && res.status !== 429) throw new Error(`${opts.model} ${res.status}: ${text}`);
      } catch (e) {
        if (attempt === 4) throw e;
      }
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    if (!res || !res.ok) throw new Error(`${opts.model} failed after retries: ${res?.status ?? 'network'}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  }

  return {
    name,
    async route(intent, candidates, seed): Promise<RouteResult> {
      const sys =
        'You are a tool router. Given a user intent and a list of candidate tools, ' +
        'reply with ONLY the exact name of the single best tool. No explanation.';
      const user = `Intent: ${intent}\nCandidates: ${candidates.join(', ')}\nAnswer with one exact candidate name.`;
      const raw = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], seed);
      // snap free-text answer to the closest candidate (exact, then substring)
      const exact = candidates.find((c) => c.toLowerCase() === raw.toLowerCase());
      const tool = exact ?? candidates.find((c) => raw.toLowerCase().includes(c.toLowerCase())) ?? raw;
      return { tool, raw };
    },
    generate(prompt, seed) {
      return chat([{ role: 'user', content: prompt }], seed);
    },
  };
}

const env = (k: string): string | undefined => process.env[k];

/**
 * Resolve a provider by name. Keys and base URLs come from the environment — nothing secret
 * lives in the repo. Any OpenAI-compatible gateway is used via `openai` by setting OPENAI_BASE_URL.
 *   mock      — offline, deterministic, no key
 *   deepseek  — DEEPSEEK_API_KEY   [DEEPSEEK_MODEL=deepseek-chat]
 *   openai    — OPENAI_API_KEY, OPENAI_MODEL   [OPENAI_BASE_URL=https://api.openai.com/v1]
 */
export function getProvider(name: string, opts: { model?: string; baseURL?: string } = {}): Provider {
  if (name === 'mock') return mockProvider;
  if (name === 'deepseek') {
    const model = opts.model ?? env('DEEPSEEK_MODEL') ?? 'deepseek-chat';
    return openaiCompatibleProvider({ name: `deepseek:${model}`, baseURL: 'https://api.deepseek.com/v1', apiKey: env('DEEPSEEK_API_KEY'), model });
  }
  if (name === 'openai') {
    const model = opts.model ?? env('OPENAI_MODEL');
    if (!model) throw new Error('openai provider needs a model (--model <name> or OPENAI_MODEL)');
    const baseURL = opts.baseURL ?? env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
    return openaiCompatibleProvider({ baseURL, apiKey: env('OPENAI_API_KEY'), model });
  }
  throw new Error(`unknown provider: ${name} (use: mock | deepseek | openai)`);
}
