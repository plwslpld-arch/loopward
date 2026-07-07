import type { Provider, RouteResult } from './types.ts';
import { norm } from './oracle.ts';

/** Escape a string for literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A client error the gateway will never recover from (401/403/404/...). Thrown so chat() can
 *  fail fast instead of burning all 4 retry attempts on a request that can only ever fail. */
class PermanentError extends Error {}

/**
 * Snap a model's free-text answer to a candidate WITHOUT ever inventing a tool it didn't name.
 * Exact normalized match → that candidate (matched=true). Otherwise the candidates that occur in the
 * answer as WHOLE-WORD tokens ('_' is a boundary char, so 'get_weather_history.' matches only
 * get_weather_history, never get_weather): exactly one distinct → snap (matched=true); zero or
 * genuinely ambiguous (>1) → do NOT guess, tool=raw and matched=false (which scores incorrect).
 * Exported so the snap contract is unit-testable without a live endpoint.
 */
export function snapToCandidate(raw: string, candidates: string[]): RouteResult {
  const nraw = norm(raw);
  const exact = candidates.find((c) => norm(c) === nraw);
  if (exact !== undefined) return { tool: exact, raw, matched: true };
  const hits: string[] = [];
  for (const c of candidates) {
    const nc = norm(c);
    if (!nc) continue;
    const re = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegex(nc) + '(?![\\p{L}\\p{N}_])', 'u');
    if (re.test(nraw)) hits.push(c);
  }
  const distinct = new Set(hits.map((c) => norm(c)));
  if (distinct.size === 1) return { tool: hits[0], raw, matched: true };
  return { tool: raw, raw, matched: false };
}

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
export function openaiCompatibleProvider(opts: { name?: string; baseURL: string; apiKey?: string; model: string; timeoutMs?: number }): Provider {
  const url = opts.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const name = opts.name ?? `openai:${opts.model}`;
  // Per-request wall-clock cap; a hung socket must not stall a 300-call run. Default: a sane built-in cap.
  const timeoutMs = opts.timeoutMs ?? 60000;

  async function chat(messages: { role: string; content: string }[], seed: number): Promise<string> {
    if (!opts.apiKey) throw new Error(`${name}: missing API key (set it in the environment)`);
    // Some newer/reasoning models reject temperature/seed. Start with them; drop on a 400 that names them.
    let sampling = true;
    const mkBody = () => JSON.stringify(sampling ? { model: opts.model, messages, temperature: 0, seed } : { model: opts.model, messages });
    // ponytail: 4 tries with linear backoff — a single transient blip shouldn't abort a 300-call run.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const ctl = new AbortController();
      const abortTimer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: mkBody(),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          // sampling-param 400: retry the same attempt-count budget without temperature/seed.
          if (res.status === 400 && sampling && /temperature|seed|top_p|sampling/i.test(text)) { sampling = false; continue; }
          // permanent client error (401/403/404/...): fail fast — rethrow so it isn't retried 4x.
          if (res.status < 500 && res.status !== 429) throw new PermanentError(`${opts.model} ${res.status}: ${text}`);
          // retryable (>=500 or 429): remember and fall through to backoff.
          lastErr = new Error(`${opts.model} ${res.status}: ${text}`);
        } else {
          // Read + parse the body INSIDE the try: a 200 with a non-JSON body is a transient gateway
          // hiccup, so treat it as a retryable failure rather than throwing out the whole run un-retried.
          const body = await res.text();
          try {
            const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
            return (data.choices?.[0]?.message?.content ?? '').trim();
          } catch {
            lastErr = new Error(`${opts.model}: 200 with non-JSON body`);
          }
        }
      } catch (e) {
        if (e instanceof PermanentError) throw e; // never retry a permanent client error
        lastErr = e;                              // network error / timeout abort → retryable
      } finally {
        clearTimeout(abortTimer);
      }
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${opts.model} failed after retries`);
  }

  return {
    name,
    async route(intent, candidates, seed): Promise<RouteResult> {
      const sys =
        'You are a tool router. Given a user intent and a list of candidate tools, ' +
        'reply with ONLY the exact name of the single best tool. No explanation.';
      const user = `Intent: ${intent}\nCandidates: ${candidates.join(', ')}\nAnswer with one exact candidate name.`;
      const raw = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], seed);
      return snapToCandidate(raw, candidates);
    },
    generate(prompt, seed) {
      return chat([{ role: 'user', content: prompt }], seed);
    },
  };
}

const env = (k: string): string | undefined => process.env[k];

/**
 * First-party OpenAI-compatible providers (each serves its own models, not a reseller/relay).
 * The base URL is baked in; the key is read from `keyEnv` (falling back to OPENAI_API_KEY).
 * Anything not listed still works via
 *   --provider openai --base-url <url> --model <name>
 * so "any OpenAI-compatible model" is genuinely any model, preset or not — including your own
 * self-hosted endpoint or any aggregator you choose to point at.
 */
export const PRESETS: Record<string, { baseURL: string; keyEnv: string; defaultModel?: string }> = {
  openai:      { baseURL: 'https://api.openai.com/v1',                          keyEnv: 'OPENAI_API_KEY' },
  deepseek:    { baseURL: 'https://api.deepseek.com/v1',                        keyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  moonshot:    { baseURL: 'https://api.moonshot.cn/v1',                         keyEnv: 'MOONSHOT_API_KEY' },
  dashscope:   { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY' },
  groq:        { baseURL: 'https://api.groq.com/openai/v1',                     keyEnv: 'GROQ_API_KEY' },
  together:    { baseURL: 'https://api.together.xyz/v1',                        keyEnv: 'TOGETHER_API_KEY' },
  siliconflow: { baseURL: 'https://api.siliconflow.cn/v1',                      keyEnv: 'SILICONFLOW_API_KEY' },
};

export const PROVIDER_NAMES = ['mock', ...Object.keys(PRESETS)];

/**
 * Resolve a provider by name. Keys and base URLs come from the environment — nothing secret
 * lives in the repo. `--base-url` overrides a preset, so any OpenAI-compatible endpoint works
 * even under a preset name.
 *   mock — offline, deterministic, no key
 *   <preset> — e.g. openai | deepseek | moonshot | groq ... (key from its env var)
 */
export function getProvider(name: string, opts: { model?: string; baseURL?: string; timeoutMs?: number } = {}): Provider {
  if (name === 'mock') return mockProvider;
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown provider: ${name} (use: ${PROVIDER_NAMES.join(' | ')}, or --provider openai --base-url <url>)`);
  const model = opts.model ?? env('OPENAI_MODEL') ?? preset.defaultModel;
  if (!model) throw new Error(`provider ${name} needs a model (--model <name> or OPENAI_MODEL)`);
  const baseURL = opts.baseURL ?? env('OPENAI_BASE_URL') ?? preset.baseURL;
  const apiKey = env(preset.keyEnv) ?? env('OPENAI_API_KEY');
  return openaiCompatibleProvider({ name: `${name}:${model}`, baseURL, apiKey, model, timeoutMs: opts.timeoutMs });
}
