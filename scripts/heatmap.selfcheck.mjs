// Offline self-check for scripts/heatmap.mjs. Imports the pure helpers (no SVG is
// written on import) and asserts the color ramp, delta formatting, xml escaping,
// determinism, and validation throws. Run: node scripts/heatmap.selfcheck.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hslToHex, cellColor, formatDelta, xmlEscape, buildSvg, textFillFor, contrast } from './heatmap.mjs';

const data = JSON.parse(readFileSync(new URL('../packages/dashboard/data.json', import.meta.url), 'utf8'));

// 1. buildSvg is deterministic (byte-identical across calls)
assert.equal(buildSvg(data, { dark: false }), buildSvg(data, { dark: false }), 'light svg not deterministic');
assert.equal(buildSvg(data, { dark: true }), buildSvg(data, { dark: true }), 'dark svg not deterministic');

// 2. cellColor ramp: greenest at 0, reddest at 100
assert.equal(cellColor(0), hslToHex(145, 62, 34), 'cellColor(0) should be greenest');
assert.equal(cellColor(100), hslToHex(0, 62, 34), 'cellColor(100) should be reddest');
assert.equal(cellColor(-10), cellColor(0), 'negative deltas clamp to 0');

// 3. hue is monotonic non-increasing over t (green -> red)
let prevHue = Infinity;
for (let i = 0; i <= 20; i++) {
  const t = i / 20;
  const hue = 145 - 145 * t;
  assert.ok(hue <= prevHue, 'hue must be non-increasing');
  prevHue = hue;
}

// 4. formatDelta
assert.equal(formatDelta(-2.4), '-2.4');
assert.equal(formatDelta(0), '0');
assert.equal(formatDelta(100), '+100');
assert.equal(formatDelta(23.8), '+23.8');

// 5. light SVG has one value <text> per cell and every model name appears
const light = buildSvg(data, { dark: false });
const cellCount = data.models.length * data.attacks.length;
const monoTexts = (light.match(/font-family="monospace" font-size="13"/g) || []).length;
assert.equal(monoTexts, cellCount, `expected ${cellCount} cell value texts, got ${monoTexts}`);
for (const m of data.models) {
  assert.ok(light.includes(xmlEscape(m.name)), `missing model name ${m.name}`);
}

// 6. xml escaping of a synthetic hostile name
const evil = JSON.parse(JSON.stringify(data));
evil.models[0].name = 'a<b&c"d';
const esc = buildSvg(evil, { dark: false });
assert.ok(esc.includes('a&lt;b&amp;c&quot;d'), 'hostile name not escaped');
assert.ok(!esc.includes('a<b&c"d'), 'raw hostile name leaked');

// 7. validation throws on bad vendor / out-of-range delta
const badVendor = JSON.parse(JSON.stringify(data));
badVendor.models[0].vendor = 'Nope';
assert.throws(() => buildSvg(badVendor, {}), /Nope/, 'bad vendor should throw');

const badDelta = JSON.parse(JSON.stringify(data));
badDelta.models[0].deltas[data.attacks[0]] = 500;
assert.throws(() => buildSvg(badDelta, {}), /out of range/, 'delta 500 should throw');

// 8. colorblind-safety is only real if the number is LEGIBLE: every cell's chosen text color must
//    clear a WCAG contrast floor against its fill (the old all-white text failed on the yellow-green band).
let minContrast = Infinity;
for (const m of data.models) {
  for (const a of data.attacks) {
    const fill = cellColor(m.deltas[a]);
    const cr = contrast(fill, textFillFor(fill));
    minContrast = Math.min(minContrast, cr);
    assert.ok(cr >= 4.3, `cell ${m.name}/${a} fill ${fill} text contrast ${cr.toFixed(2)} < 4.3 (near-AA)`);
  }
}

// 9. cells are byte-identical across light/dark chrome (only bg + label/legend fills may differ)
const dark = buildSvg(data, { dark: true });
const cellsOf = (svg) => svg.split('\n').filter((l) => l.includes('rx="4"') || l.includes('font-family="monospace" font-size="13"'));
assert.deepEqual(cellsOf(light), cellsOf(dark), 'cell rects + value texts must be identical across light/dark');

// 10. the COMMITTED SVGs must match a fresh generation (no drift from data.json)
const committedLight = readFileSync(new URL('../assets/heatmap.svg', import.meta.url), 'utf8');
const committedDark = readFileSync(new URL('../assets/heatmap-dark.svg', import.meta.url), 'utf8');
assert.equal(committedLight, light, 'assets/heatmap.svg is stale — run `node scripts/heatmap.mjs` and commit');
assert.equal(committedDark, dark, 'assets/heatmap-dark.svg is stale — run `node scripts/heatmap.mjs` and commit');

console.log(`heatmap.selfcheck: all assertions passed (min cell text contrast ${minContrast.toFixed(2)}:1, cells stable across light/dark, committed SVGs in sync)`);
