// Offline self-check for the dashboard build: regenerates index.html from the template
// and asserts the floating-tooltip refactor landed intact (old clipped ::after gone, new
// position:fixed JS tooltip present) and that every attack description survived the inline
// with no truncation. Node stdlib only; run from the repo root: node packages/dashboard/selfcheck.ts
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('./', import.meta.url);
const tplPath = fileURLToPath(new URL('template.html', dir));
const indexPath = fileURLToPath(new URL('index.html', dir));

// Regenerate index.html from template.html + data.json.
execFileSync('node', ['packages/dashboard/build.mjs'], { stdio: 'inherit' });

const html = readFileSync(indexPath, 'utf8');
const tpl = readFileSync(tplPath, 'utf8');

// The clipped pseudo-element tooltip must be gone.
assert.ok(!html.includes('.q::after'), 'expected .q::after to be removed');
assert.ok(!html.includes(':hover::after'), 'expected :hover::after to be removed');

// The new floating tooltip must be present.
assert.ok(html.includes('.q-tip'), 'expected .q-tip rule');
assert.ok(html.includes('position:fixed'), 'expected position:fixed on the floating tooltip');
assert.ok(html.includes('getBoundingClientRect'), 'expected getBoundingClientRect positioning logic');
assert.ok(html.includes("addEventListener('scroll'"), 'expected scroll listener to hide the tooltip');

// Data must be inlined (placeholder consumed by build.mjs).
assert.ok(!html.includes('/*__DATA__*/{}'), 'expected the /*__DATA__*/{} placeholder to be gone (data inlined)');

// Content fidelity: every English attack description (d:"...") from the template must appear
// verbatim in the built index.html. These strings feed the data-tip attributes at render time,
// so a truncated copy here would mean a truncated tooltip.
// Grab the en block only (it precedes the zh block).
const zhIdx = tpl.indexOf('zh: {');
const enBlock = zhIdx > 0 ? tpl.slice(0, zhIdx) : tpl;
const dRe = /d:"((?:[^"\\]|\\.)*)"/g;
const descs: string[] = [];
for (let m; (m = dRe.exec(enBlock)); ) descs.push(m[0]);
assert.equal(descs.length, 6, `expected 6 English attack descriptions, found ${descs.length}`);
for (const d of descs) {
  assert.ok(html.includes(d), `attack description truncated or missing in build: ${d.slice(0, 40)}...`);
}

console.log('OK');
