// `node src/selfcheck.ts` — exits non-zero on failure.
import assert from 'node:assert/strict';
import type { Failure } from '../../redteam/src/attack-run.ts';
import { toPreferencePairs, toVerifiableReward, toSftNegatives, toFiles, buildExport } from './export.ts';

const failures: Failure[] = [
  { attack: 'boundary_blur', caseId: 'wx-01', intent: 'temp in Berlin', candidates: ['fetch_weather', 'get_weather'], chosen: 'fetch_weather', ground_truth: 'get_weather' },
  { attack: 'negation_trap', caseId: 'msg-01', intent: 'email the report. Do not use send_slack_message.', candidates: ['send_email', 'send_slack_message'], chosen: 'send_slack_message', ground_truth: 'send_email' },
  // a non-failure slipped in (chosen == ground_truth) must be dropped
  { attack: 'noop', caseId: 'x', intent: 'x', candidates: ['a', 'b'], chosen: 'a', ground_truth: 'a' },
];

const pairs = toPreferencePairs(failures);
assert.equal(pairs.length, 2, 'the chosen==ground_truth row must be filtered out');
assert.equal(pairs[0].chosen, 'get_weather');
assert.equal(pairs[0].rejected, 'fetch_weather');
assert.ok(pairs[0].prompt.includes('get_weather') && pairs[0].prompt.includes('fetch_weather'));

const reward = toVerifiableReward(failures);
assert.equal(reward.length, 4, 'two reward samples per real failure');
assert.deepEqual([...new Set(reward.map((r) => r.reward))].sort(), [0, 1]);
// the correct route always carries reward 1, the misroute reward 0
const p0 = reward.filter((r) => r.meta.caseId === 'wx-01');
assert.equal(p0.find((r) => r.completion === 'get_weather')!.reward, 1);
assert.equal(p0.find((r) => r.completion === 'fetch_weather')!.reward, 0);

const sft = toSftNegatives(failures);
assert.equal(sft.length, 2);
assert.equal(sft[0].completion, 'get_weather');

const files = toFiles(buildExport(failures));
assert.deepEqual(Object.keys(files).sort(), ['preference_pairs.jsonl', 'reward_samples.jsonl', 'sft_negatives.jsonl']);
// valid JSONL: every line parses
for (const [name, body] of Object.entries(files)) {
  for (const line of body.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line), `${name} has a bad line`);
}

console.log(`selfcheck OK — ${pairs.length} preference pairs, ${reward.length} reward samples, ${sft.length} sft negatives`);
