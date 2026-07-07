// Offline self-check for the CI renderer: run the real attack pipeline against the mock provider
// (no key, no network) and assert the badge/comment formatting invariants CI depends on — stable
// marker, every attack listed, a signed pp confidence bracket, determinism, and the color ladder.
// Pure node:assert; exits non-zero on any failed invariant.
import assert from 'node:assert';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockProvider } from '../../core/src/provider.ts';
import { runAttacks } from '../../redteam/src/attack-run.ts';
import type { RoutingCase } from '../../core/src/types.ts';
import {
  MARKER,
  badgeColor,
  worstAttack,
  renderBadge,
  renderComment,
  renderAuditOnly,
  unmeasuredBadge,
  main as renderPrMain,
} from './render-pr.ts';

function loadSuite(): RoutingCase[] {
  const raw = JSON.parse(readFileSync('datasets/routing/sample.json', 'utf8')) as { cases: RoutingCase[] };
  return raw.cases;
}

async function main(): Promise<void> {
  const cases = loadSuite();
  const rep = await runAttacks(cases, mockProvider, 42, undefined, 'single', {
    timestamp: '1970-01-01T00:00:00.000Z',
    git_sha: 'test',
  });

  const comment = renderComment(rep);
  assert.ok(comment.startsWith(MARKER), 'comment must start with MARKER');
  for (const a of rep.attacks) {
    assert.ok(comment.includes(a.attack), `comment missing attack: ${a.attack}`);
  }
  // a signed confidence bracket, e.g. [+0.0pp, +25.0pp] — either bound may legitimately be negative
  assert.ok(/\[[+-]?[\d.]+pp, [+-]?[\d.]+pp\]/.test(comment), 'comment missing a [..pp, ..pp] CI bracket');

  // deterministic: same report -> byte-identical comment
  assert.strictEqual(renderComment(rep), renderComment(rep), 'renderComment must be deterministic');

  // worst attack == min accuracy
  const accs = rep.attacks.map((a) => a.accuracy);
  assert.strictEqual(worstAttack(rep).accuracy, Math.min(...accs), 'worstAttack must be the min accuracy');

  const badge = renderBadge(rep);
  assert.strictEqual(badge.schemaVersion, 1, 'badge schemaVersion must be 1');
  assert.ok(badge.message.includes(rep.provider), 'badge message must include provider');
  assert.ok(badge.message.includes(`n=${rep.total}`), 'badge message must include n=total');

  // color ladder edges
  assert.strictEqual(badgeColor(0.90), 'brightgreen');
  assert.strictEqual(badgeColor(0.899), 'green');
  assert.strictEqual(badgeColor(0.49), 'red');
  assert.strictEqual(unmeasuredBadge().color, 'lightgrey');

  // Committed pilot badge (repo-root robustness.json) is the Pages default now — it must be a valid
  // shields endpoint object AND must NOT be the grey 'not measured' sentinel (that was a false claim
  // masquerading as no-data; 13 models WERE measured). Fails if the honest badge is reverted/deleted.
  const committed = JSON.parse(readFileSync('robustness.json', 'utf8')) as Record<string, unknown>;
  assert.strictEqual(committed.schemaVersion, 1, 'committed robustness.json schemaVersion must be 1');
  assert.ok(typeof committed.label === 'string' && committed.label.length > 0, 'committed robustness.json needs a non-empty label');
  assert.ok(typeof committed.message === 'string' && committed.message.length > 0, 'committed robustness.json needs a non-empty message');
  assert.ok(typeof committed.color === 'string' && committed.color.length > 0, 'committed robustness.json needs a non-empty color');
  assert.notStrictEqual(committed.message, 'not measured', "committed robustness.json must not be the false 'not measured' badge");

  assert.ok(renderAuditOnly('x').startsWith(MARKER), 'audit-only body must start with MARKER');

  // dispatcher: --badge / --comment must write to the REQUESTED path (the CI workflows pass _site/... paths).
  const repPath = join(tmpdir(), 'loopward-ci-rep.json');
  const badgePath = join(tmpdir(), 'loopward-ci-badge.json');
  const commentPath = join(tmpdir(), 'loopward-ci-comment.md');
  writeFileSync(repPath, JSON.stringify(rep));
  try {
    renderPrMain([repPath, '--badge', badgePath, '--comment', commentPath, '--run-url', 'http://x']);
    assert.ok(existsSync(badgePath), 'badge must be written to the requested --badge path, not a hardcoded name');
    assert.ok(existsSync(commentPath), 'comment must be written to the requested --comment path');
    assert.strictEqual(JSON.parse(readFileSync(badgePath, 'utf8')).schemaVersion, 1);
    assert.ok(readFileSync(commentPath, 'utf8').startsWith(MARKER));
    rmSync(badgePath, { force: true });
    renderPrMain(['--unmeasured', '--badge', badgePath]);
    assert.ok(existsSync(badgePath), 'unmeasured badge must honor the requested --badge path');
    assert.strictEqual(JSON.parse(readFileSync(badgePath, 'utf8')).color, 'lightgrey');
  } finally {
    rmSync(repPath, { force: true });
    rmSync(badgePath, { force: true });
    rmSync(commentPath, { force: true });
  }

  console.log(`OK ci/selfcheck: ${rep.attacks.length} attacks, worst=${worstAttack(rep).attack} ${(worstAttack(rep).accuracy * 100).toFixed(1)}%; dispatcher honors output paths`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
