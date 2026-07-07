// Emit tool-confusability findings as SARIF 2.1.0 so they render in GitHub code scanning / any SARIF
// viewer. Pure and deterministic: no fs/time/git, no model calls — same pairs in, byte-identical log out.
// These are heuristic name/description overlaps, NOT proven vulnerabilities, so levels top out at
// 'warning' and we never attach security-severity (which would misrepresent them as CVE-grade).
import { createHash } from 'node:crypto';
import type { ConfusablePair } from './tools.ts';
import { LOOPWARD_VERSION } from './manifest.ts';

export interface SarifRegion { startLine: number; startColumn: number; endColumn: number; }
export interface SarifArtifactLocation { uri: string; }
export interface SarifPhysicalLocation { artifactLocation: SarifArtifactLocation; region?: SarifRegion; }
export interface SarifLogicalLocation { name: string; kind: string; fullyQualifiedName: string; }
export interface SarifLocation { physicalLocation: SarifPhysicalLocation; logicalLocations: SarifLogicalLocation[]; }
export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[]; // logicalLocations live inside each location (SARIF 2.1.0 shape)
  partialFingerprints: Record<string, string>;
  properties: { score: number; nameSim: number; descSim: number; sharedTokens: string[] };
}
export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: 'warning' };
}
export interface SarifDriver {
  name: string;
  informationUri: string;
  version: string;
  rules: SarifRule[];
}
export interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

const RULE_ID = 'confusable-tool-pair';
const HELP_URI = 'https://github.com/plwslpld-arch/loopward';

/** Locate the first `"name":"<name>"` JSON key/value in rawText, returning a 1-based region spanning the
 *  value string (columns bracket the opening and closing quotes). null when the tool name isn't found. */
export function locateName(rawText: string, name: string): SarifRegion | null {
  // Match the JSON key "name" with the exact value, tolerating whitespace around the colon. Regex
  // metacharacters in the name are escaped to literals; a name containing JSON-escaped characters
  // (a literal " or \) won't match its escaped form in rawText and simply yields no region (graceful).
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('"name"\\s*:\\s*"' + esc + '"');
  const m = re.exec(rawText);
  if (!m) return null;
  const idx = m.index;
  const before = rawText.slice(0, idx);
  const nl = before.lastIndexOf('\n');
  const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
  const lineStart = nl + 1;
  // Column of the value's opening quote (1-based). m[0] is `"name": "<value>"`; find the last `"` before value.
  const openQuoteInMatch = m[0].lastIndexOf('"', m[0].length - 2 - name.length); // opening quote of the value
  const valueOpen = idx + openQuoteInMatch;
  const startColumn = valueOpen - lineStart + 1;
  const endColumn = startColumn + name.length + 2; // opening quote + value + closing quote
  return { startLine, startColumn, endColumn };
}

function fingerprint(a: string, b: string): string {
  const pair = [a, b].sort();
  return createHash('sha256').update(JSON.stringify(pair)).digest('hex').slice(0, 16);
}

function logical(name: string): SarifLogicalLocation {
  return { name, kind: 'function', fullyQualifiedName: name };
}

function messageFor(p: ConfusablePair): string {
  const tokens = p.sharedTokens.length ? p.sharedTokens.join(', ') : 'similar descriptions';
  return `Tools '${p.a}' and '${p.b}' are confusable (score ${p.score}, name-sim ${p.nameSim}, ` +
    `desc-sim ${p.descSim}). Shared tokens: ${tokens}. A router is likely to mix them up.`;
}

/** Build a deterministic SARIF 2.1.0 log from confusability findings. One rule, one result per pair. */
export function buildAuditSarif(
  pairs: ConfusablePair[],
  opts: { toolsUri: string; rawToolsText?: string; version?: string },
): SarifLog {
  const uri = opts.toolsUri.replace(/\\/g, '/');
  const rule: SarifRule = {
    id: RULE_ID,
    name: 'ConfusableToolPair',
    shortDescription: { text: 'Two tools a router is likely to confuse' },
    fullDescription: {
      text: 'Two tools whose names and/or descriptions overlap enough that an LLM router is likely to ' +
        'call the wrong one. This is a heuristic overlap score, not a proven vulnerability.',
    },
    helpUri: HELP_URI,
    defaultConfiguration: { level: 'warning' },
  };

  const results: SarifResult[] = pairs.map((p) => {
    const physicalLocation: SarifPhysicalLocation = { artifactLocation: { uri } };
    if (opts.rawToolsText) {
      const region = locateName(opts.rawToolsText, p.a);
      if (region) physicalLocation.region = region;
    }
    const logicalLocations = [logical(p.a), logical(p.b)];
    return {
      ruleId: RULE_ID,
      ruleIndex: 0,
      level: (p.score >= 0.5 ? 'warning' : 'note') as 'warning' | 'note',
      message: { text: messageFor(p) },
      locations: [{ physicalLocation, logicalLocations }],
      partialFingerprints: { 'confusablePair/v1': fingerprint(p.a, p.b) },
      properties: { score: p.score, nameSim: p.nameSim, descSim: p.descSim, sharedTokens: p.sharedTokens },
    };
  });

  const run: SarifRun = {
    tool: {
      driver: {
        name: 'loopward',
        informationUri: HELP_URI,
        version: opts.version ?? LOOPWARD_VERSION,
        rules: [rule],
      },
    },
    results,
  };

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [run],
  };
}
