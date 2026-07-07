// Bring-Your-Own-Tools: load a user's real tool catalog and audit it for routing confusability,
// with zero model calls. Point it at your OpenAI/Anthropic tool schema and it tells you which
// tools a router is likely to mix up before you ship them.
import { readFileSync } from 'node:fs';
import type { Provider, RoutingCase } from './types.ts';

export interface Tool { name: string; description: string; }

/** Turn a user's tool catalog into routing test cases: one synthesized intent per tool,
 *  with the whole catalog as candidates and that tool as ground truth. */
export async function synthesizeCases(tools: Tool[], provider: Provider, seed: number): Promise<RoutingCase[]> {
  if (!provider.generate) throw new Error(`provider ${provider.name} can't synthesize intents (no generate())`);
  const names = tools.map((t) => t.name);
  const cases: RoutingCase[] = [];
  for (const t of tools) {
    const prompt =
      `A user is talking to an assistant that can call this tool:\n` +
      `name: ${t.name}\ndescription: ${t.description || '(no description)'}\n\n` +
      `Write ONE natural, realistic user request (a single sentence) that should be handled by exactly ` +
      `this tool and no other. Do not mention the tool name. Output only the request.`;
    const intent = (await provider.generate(prompt, seed)).replace(/^["'\s]+|["'\s]+$/g, '');
    cases.push({ id: t.name, intent, candidates: names, ground_truth: t.name });
  }
  return cases;
}

/** Accepts OpenAI ([{type:"function",function:{name,description}}]), Anthropic ([{name,description,input_schema}]),
 *  or a flat [{name,description}] list — with or without a { tools: [...] } / { functions: [...] } wrapper. */
export function loadTools(path: string): Tool[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  // A JSON literal `null` / number / string would blow up on `.tools` with a cryptic TypeError.
  if (raw == null || typeof raw !== 'object') throw new Error(`${path}: expected a JSON object/array`);
  const arr: any[] = Array.isArray(raw) ? raw : raw.tools ?? raw.functions ?? [];
  const tools = arr.map((t) => {
    const f = t.function ?? t;
    return { name: String(f.name ?? '').trim(), description: String(f.description ?? '').trim() };
  }).filter((t) => t.name);
  if (!tools.length) throw new Error(`${path}: no tools found (expected OpenAI/Anthropic tool schema or [{name,description}])`);
  return tools;
}

const STOP = new Set(['the','a','an','to','of','for','and','or','with','in','on','by','from','this','that','it',
  'get','set','list','create','update','delete','fetch','query','return','returns','use','used','when','your','user']);

// Near-synonym access verbs map to a canonical action. A router confuses get_status / fetch_status /
// query_status precisely because get/fetch/query mean the same thing — so we treat them as equal.
const VERB = new Map<string, string>(Object.entries({
  get:'read', fetch:'read', query:'read', read:'read', retrieve:'read', lookup:'read', find:'read', search:'read', show:'read',
  list:'list', enumerate:'list',
  set:'write', update:'write', modify:'write', edit:'write', change:'write', put:'write', patch:'write',
  create:'create', add:'create', new:'create', make:'create', insert:'create',
  delete:'delete', remove:'delete', destroy:'delete', drop:'delete', cancel:'delete',
  send:'send', post:'send', dispatch:'send', notify:'send',
}));
const norm = (tok: string) => VERB.get(tok) ?? tok;

// Unicode-aware split: token = a run of letters/numbers in ANY script (CJK, Cyrillic, …). The old
// [^a-z0-9]+ split reduced non-ASCII names to EMPTY, so jaccard()=0 gave a false all-clear on them.
const splitUni = (s: string) => s.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const rawNameTokens = (s: string) => new Set(splitUni(s));
const nameTokens = (s: string) => new Set([...rawNameTokens(s)].map(norm));
const descTokens = (s: string) => new Set(splitUni(s).filter((w) => w.length > 2 && !STOP.has(w)));

/** Tool names the confusability heuristic can't analyze because they tokenize to EMPTY — e.g. a
 *  pure-emoji or pure-symbol name. Surfaced so a caller WARNs ("N tools have names the confusability
 *  heuristic can't analyze") instead of the audit silently passing them as "not confusable". */
export function unanalyzableTools(tools: Tool[]): string[] {
  return tools.filter((t) => nameTokens(t.name).size === 0).map((t) => t.name);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const shared = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));

export interface ConfusablePair {
  a: string; b: string; score: number; nameSim: number; descSim: number; sharedTokens: string[];
}

/** Rank tool pairs by how confusable they are for a router. Name overlap weighs more than description. */
export function auditConfusability(tools: Tool[], threshold = 0.34): ConfusablePair[] {
  const nt = tools.map((t) => nameTokens(t.name));         // verb-normalized, for scoring
  const rnt = tools.map((t) => rawNameTokens(t.name));     // raw, for display
  const dt = tools.map((t) => descTokens(t.description));
  const out: ConfusablePair[] = [];
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const nameSim = jaccard(nt[i], nt[j]);
      const descSim = jaccard(dt[i], dt[j]);
      const score = 0.6 * nameSim + 0.4 * descSim;
      if (score >= threshold || nameSim >= 0.5) {
        const disp = [...new Set([...shared(rnt[i], rnt[j]), ...shared(dt[i], dt[j])])];
        out.push({ a: tools[i].name, b: tools[j].name, score: +score.toFixed(3),
          nameSim: +nameSim.toFixed(3), descSim: +descSim.toFixed(3), sharedTokens: disp });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
