// Provenance manifest stamped on reports. Library code stays deterministic: wall-clock time and
// git enter ONLY at the CLI boundary via StampInput, so self-checks and workflow runs are byte-stable.
// The companion `verify` (eval/verify.ts) re-derives the deterministic fields — it is a consistency
// linter, not a proof the run actually happened (the model outputs aren't stored, so a hand-edited
// but internally-consistent report would still pass).
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// bump when scoreRoute's semantics change; today it is exact normalized-name match.
export const ORACLE_VERSION = 'route-exact-v1';

let _version: string | undefined;
function readVersion(): string {
  if (_version !== undefined) return _version;
  // src tree puts package.json 3 levels up; the compiled dist adds one more — try both, then give up.
  for (const up of ['../../../package.json', '../../../../package.json']) {
    try {
      const v = JSON.parse(readFileSync(new URL(up, import.meta.url), 'utf8')).version as string;
      if (v) { _version = v; return v; }
    } catch { /* try next candidate */ }
  }
  _version = '0.0.0'; // moved/unknown layout: degrade, never crash the importer
  return _version;
}
export const LOOPWARD_VERSION = readVersion();

export interface Manifest {
  loopward_version: string;
  oracle_version: string;
  model: string;      // provider.name, never a key
  seed: number;
  variant: string;
  tools: string[];    // sorted, de-duped candidate-name universe the routing chose among
  tool_schema_hash: string;
  git_sha: string;
  timestamp: string;
}
export interface StampInput { timestamp?: string; git_sha?: string; version?: string }

export function toolSchemaHash(toolNames: string[]): string {
  const canon = [...new Set(toolNames)].sort();
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

/** CLI-only: shells out to git. Library code and self-checks never call this — they default to 'unknown'. */
export function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch { return 'unknown'; }
}

export function buildManifest(i: { seed: number; variant: string; model: string; toolNames: string[]; stamp?: StampInput }): Manifest {
  const tools = [...new Set(i.toolNames)].sort();
  return {
    loopward_version: i.stamp?.version ?? LOOPWARD_VERSION,
    oracle_version: ORACLE_VERSION,
    model: i.model,
    seed: i.seed,
    variant: i.variant,
    tools,
    tool_schema_hash: toolSchemaHash(tools),
    git_sha: i.stamp?.git_sha ?? 'unknown',
    timestamp: i.stamp?.timestamp ?? '1970-01-01T00:00:00.000Z',
  };
}
