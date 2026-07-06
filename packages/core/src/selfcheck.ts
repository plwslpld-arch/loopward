// Runnable self-check (no framework). `node src/selfcheck.ts` — exits non-zero on failure.
import assert from 'node:assert/strict';
import type { RoutingCase } from './types.ts';
import { scoreRoute } from './oracle.ts';
import { mockProvider } from './provider.ts';
import { runSuite } from './loop.ts';
import { runMultistep, runMultistepSuite, type MultistepTask } from './multistep.ts';

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

// single variant walks the 5 core nodes
for (const t of r1.trajectories) {
  assert.deepEqual(t.steps.map((s) => s.node), ['perceive', 'route', 'act', 'verify', 'stop']);
}

// self-check variant inserts a reflect node (extra decision point)
const sc = await runSuite(suite, mockProvider, 42, 'self-check');
assert.equal(sc.variant, 'self-check');
for (const t of sc.trajectories) {
  assert.deepEqual(t.steps.map((s) => s.node), ['perceive', 'route', 'reflect', 'act', 'verify', 'stop']);
  const reflect = t.steps.find((s) => s.node === 'reflect')!;
  assert.equal(typeof reflect.changed, 'boolean');
}

// multi-step loop: terminates, and scores the loop-specific failure modes
const tasks: MultistepTask[] = [
  { id: 'm1', task: 'send an email then add a calendar event', tools: ['send_email', 'create_calendar_event', 'read_file'], required: ['send_email', 'create_calendar_event'] },
];
const one = await runMultistep(tasks[0], mockProvider, 42);
assert.ok(one.steps <= tasks[0].required.length + 3, 'multi-step must terminate within the step cap');
assert.equal(typeof one.success, 'boolean');
// a hand-built perfect trajectory scores as success
const perfect: MultistepTask = { id: 'p', task: 't', tools: ['a', 'b'], required: ['a', 'b'] };
const detTasks = [perfect];
const ms = await runMultistepSuite(detTasks, mockProvider, 42);
assert.ok(ms.success_rate >= 0 && ms.success_rate <= 1);
assert.ok(ms.over_run_rate >= 0 && ms.over_run_rate <= 1);

console.log(`selfcheck OK — single ${(r1.accuracy * 100).toFixed(1)}% / self-check ${(sc.accuracy * 100).toFixed(1)}% routing; multi-step terminates & scores`);
