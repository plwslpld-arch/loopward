// fix: turn the diagnostic into a controller. Take the tools whose names a router confuses,
// propose a clearer rename (model-made when a real provider is available, deterministic fallback
// otherwise), then re-run the IDENTICAL attacked suite through the same deterministic oracle and
// report the verified robustness delta. The suggestion is model-made; the re-measurement is not.
import type { Provider, RoutingCase } from '../../core/src/types.ts';
import { auditConfusability, type Tool } from '../../core/src/tools.ts';
import type { Variant } from '../../core/src/loop.ts';
import { runAttacks, type AttackReport } from './attack-run.ts';

export interface Rename { from: string; to: string; reason: string; }
export interface FixReport {
  provider: string;
  renames: Rename[];
  before: AttackReport;
  after: AttackReport;
  // controlled delta on the attack that was worst BEFORE the fix (same attack, before vs after)
  worst_attack: string;
  acc_before: number;
  acc_after: number;
  recovered_pp: number;
}

const ident = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const toks = (s: string) => new Set(ident(s).split('_').filter(Boolean));

/** A clearer, distinct name for tool `b` (the one we rename) vs its confusable twin `a`.
 *  Uses the model when it can; falls back to a deterministic rename so `fix` runs offline. */
async function proposeRename(a: Tool, b: Tool, provider: Provider, taken: Set<string>, seed: number): Promise<string> {
  // deterministic fallback: splice b's most distinctive description word in after its leading verb,
  // keeping b's own name tokens (so the renamed tool still matches its intent, just unambiguously).
  const aWords = toks(a.description);
  const bNameToks = toks(b.name);
  const distinct = [...toks(b.description)].find((w) => w.length > 3 && !aWords.has(w) && !bNameToks.has(w)) ?? 'v2';
  const parts = b.name.split(/[^a-z0-9]+/i).filter(Boolean);
  let name = ident(parts.length > 1 ? `${parts[0]}_${distinct}_${parts.slice(1).join('_')}` : `${b.name}_${distinct}`);

  if (provider.generate) {
    try {
      const prompt =
        `Two tools have confusable names for a router:\n` +
        `A) ${a.name}: ${a.description}\n` +
        `B) ${b.name}: ${b.description}\n\n` +
        `Rename tool B to a short snake_case function name a router will NOT confuse with A, ` +
        `staying accurate to B's description. Output ONLY the new name.`;
      const raw = ident(((await provider.generate(prompt, seed)) || '').trim().split(/\s+/).pop() ?? '');
      // accept only a real identifier that stays tied to B (shares a token with B's name/description),
      // else keep the deterministic fallback — guards against a stand-in model echoing junk like "name".
      const bAll = new Set([...bNameToks, ...toks(b.description)]);
      const sensible = raw.length >= 3 && raw.length <= 40 && raw !== ident(a.name) && raw.split('_').some((t) => bAll.has(t));
      if (sensible) name = raw;
    } catch { /* keep deterministic fallback */ }
  }
  let out = name, i = 2;
  while (taken.has(out)) out = `${name}_${i++}`;
  return out;
}

function applyRenames(cases: RoutingCase[], map: Map<string, string>): RoutingCase[] {
  return cases.map((c) => ({
    ...c,
    candidates: c.candidates.map((x) => map.get(x) ?? x),
    ground_truth: map.get(c.ground_truth) ?? c.ground_truth,
  }));
}

/**
 * @param tools     the catalog (for the confusability audit)
 * @param baseCases the routing cases (same intents get re-tested; only names change)
 */
export async function runFix(
  tools: Tool[], baseCases: RoutingCase[], provider: Provider, seed: number, variant: Variant = 'single',
): Promise<FixReport> {
  const before = await runAttacks(baseCases, provider, seed, undefined, variant);

  const byName = new Map(tools.map((t) => [t.name, t]));
  const taken = new Set(tools.map((t) => t.name));
  const map = new Map<string, string>();
  const renames: Rename[] = [];
  for (const p of auditConfusability(tools).filter((x) => x.score >= 0.5)) { // HIGH-risk only
    const a = byName.get(p.a), b = byName.get(p.b);
    if (!a || !b || map.has(b.name)) continue;
    const to = await proposeRename(a, b, provider, taken, seed);
    taken.delete(b.name); taken.add(to);
    map.set(b.name, to);
    renames.push({ from: b.name, to, reason: `confusable with ${a.name} (shared: ${p.sharedTokens.join(', ') || 'similar'})` });
  }

  const after = await runAttacks(applyRenames(baseCases, map), provider, seed, undefined, variant);

  // report on the attack that was worst BEFORE — same attack, before vs after (a controlled delta)
  const worst = before.attacks.reduce((m, x) => (x.accuracy < m.accuracy ? x : m), before.attacks[0]);
  const accAfter = after.attacks.find((x) => x.attack === worst.attack)?.accuracy ?? worst.accuracy;
  return {
    provider: provider.name, renames, before, after,
    worst_attack: worst.attack,
    acc_before: worst.accuracy,
    acc_after: accAfter,
    recovered_pp: +((accAfter - worst.accuracy) * 100).toFixed(1),
  };
}
