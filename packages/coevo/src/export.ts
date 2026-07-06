// Co-evolution export: turn routing failures (from a red-team run) into post-training signal.
// Three standard shapes so a model team can consume them directly. Nothing model-specific here —
// the failures are the harness's feedback to the model. This is the "model × harness co-evolution" loop.
import type { Failure } from '../../redteam/src/attack-run.ts';

/** The exact routing prompt a trainer would replay — mirrors what the loop showed the model. */
export function routingPrompt(intent: string, candidates: string[]): string {
  return `Route the request to exactly one tool. Reply with only the tool name.\nIntent: ${intent}\nTools: ${candidates.join(', ')}`;
}

const isReal = (f: Failure): boolean => f.chosen.trim().toLowerCase() !== f.ground_truth.trim().toLowerCase();

export interface PreferencePair { prompt: string; chosen: string; rejected: string; meta: { attack: string; caseId: string } }
export interface RewardSample { prompt: string; completion: string; reward: number; meta: { attack: string; caseId: string } }
export interface SftSample { prompt: string; completion: string; rejected: string; meta: { attack: string; caseId: string } }

/** DPO-style preference pairs: chosen = correct route, rejected = the model's misroute. */
export function toPreferencePairs(failures: Failure[]): PreferencePair[] {
  return failures.filter(isReal).map((f) => ({
    prompt: routingPrompt(f.intent, f.candidates),
    chosen: f.ground_truth,
    rejected: f.chosen,
    meta: { attack: f.attack, caseId: f.caseId },
  }));
}

/** Verifiable-reward samples: two per failure — the misroute (reward 0) and the correct route (reward 1). */
export function toVerifiableReward(failures: Failure[]): RewardSample[] {
  const out: RewardSample[] = [];
  for (const f of failures.filter(isReal)) {
    const prompt = routingPrompt(f.intent, f.candidates);
    out.push({ prompt, completion: f.chosen, reward: 0, meta: { attack: f.attack, caseId: f.caseId } });
    out.push({ prompt, completion: f.ground_truth, reward: 1, meta: { attack: f.attack, caseId: f.caseId } });
  }
  return out;
}

/** SFT negatives: supervised target = correct route, with the model's wrong pick recorded for analysis. */
export function toSftNegatives(failures: Failure[]): SftSample[] {
  return failures.filter(isReal).map((f) => ({
    prompt: routingPrompt(f.intent, f.candidates),
    completion: f.ground_truth,
    rejected: f.chosen,
    meta: { attack: f.attack, caseId: f.caseId },
  }));
}

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

export interface CoevoExport {
  preference_pairs: PreferencePair[];
  reward_samples: RewardSample[];
  sft_negatives: SftSample[];
}

export function buildExport(failures: Failure[]): CoevoExport {
  return {
    preference_pairs: toPreferencePairs(failures),
    reward_samples: toVerifiableReward(failures),
    sft_negatives: toSftNegatives(failures),
  };
}

/** Serialize each shape to a JSONL string keyed by filename. */
export function toFiles(ex: CoevoExport): Record<string, string> {
  return {
    'preference_pairs.jsonl': jsonl(ex.preference_pairs),
    'reward_samples.jsonl': jsonl(ex.reward_samples),
    'sft_negatives.jsonl': jsonl(ex.sft_negatives),
  };
}
