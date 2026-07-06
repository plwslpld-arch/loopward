// Runnable self-check (no framework). `node src/selfcheck.ts` — exits non-zero on failure.
import assert from 'node:assert/strict';
import type { RoutingCase } from './types.ts';
import { scoreRoute } from './oracle.ts';
import { mockProvider } from './provider.ts';
import { runSuite } from './loop.ts';

// oracle: exact, case-insensitive
assert.equal(scoreRoute('get_weather', 'get_weather').correct, true);
assert.equal(scoreRoute('GET_WEATHER', 'get_weather').correct, true);
assert.equal(scoreRoute('get_forecast', 'get_weather').correct, false);

const suite: RoutingCase[] = [
  { id: 'a', intent: 'send an email to bob', candidates: ['send_email', 'send_slack_message'], ground_truth: 'send_email' },
  { id: 'b', intent: 'ping the team on slack', candidates: ['send_email', 'send_slack_message'], ground_truth: 'send_slack_message' },
  { id: 'c', intent: 'nothing matches here', candidates: ['send_email', 'send_slack_message'], ground_truth: 'send_slack_message' },
];

const r1 = await runSuite(suite, mockProvider, 42);
const r2 = await runSuite(suite, mockProvider, 42);

// deterministic: same seed → identical routing decisions
assert.deepEqual(r1.trajectories.map((t) => t.routed), r2.trajectories.map((t) => t.routed));
assert.ok(r1.accuracy >= 0 && r1.accuracy <= 1);
assert.equal(r1.total, 3);
// mock routes a/b correctly on token overlap; c has no overlap → falls to first candidate (wrong)
assert.equal(r1.trajectories[0].correct, true);
assert.equal(r1.trajectories[1].correct, true);

// every trajectory walks all 5 loop nodes
for (const t of r1.trajectories) {
  assert.deepEqual(t.steps.map((s) => s.node), ['perceive', 'route', 'act', 'verify', 'stop']);
}

console.log(`selfcheck OK — mock accuracy ${(r1.accuracy * 100).toFixed(1)}% on ${r1.total} cases`);
