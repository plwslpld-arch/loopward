// Renders packages/dashboard/data.json into two self-contained SVG heatmaps
// (light + dark chrome) for embedding in the README. Pure helpers are exported so
// heatmap.selfcheck.mjs can exercise the color/format/escape logic offline; the
// SVGs are only written when this file is run directly (imports never write).
//
// The cell color is a hex port of template.html's sev() (hsl severity ramp).
// Deterministic by construction: no Date, no git, no randomness. Cells are
// byte-identical across the two files; only background + label/legend/footer text
// fills change with the `dark` flag, so the grid itself is a fixed artifact.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// mirrored from packages/dashboard/template.html:174
const VENDOR_COLOR = {
  Anthropic: '#d97757', OpenAI: '#10a37f', Google: '#4285f4',
  xAI: '#8b5cf6', DeepSeek: '#4d6bfe', Alibaba: '#ff6a00', Zhipu: '#3859ff',
};

const CHROME = {
  light: { bg: '#f6f7f9', ink: '#171b22', muted: '#616b7a', line: '#e5e8ec' },
  dark: { bg: '#0b0e14', ink: '#e6edf3', muted: '#8b95a5', line: '#212836' },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// standard HSL->RGB (h deg, s/l percent) -> #rrggbb hex. Deterministic.
export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// hex port of template.html:297 sev(): green (held) -> red (broke) severity ramp. Rounds hue and
// lightness to integers first, exactly like sev()'s `hsl(${hue.toFixed(0)} 62% ${l.toFixed(0)}%)`,
// so the static image matches the live dashboard cell-for-cell.
export function cellColor(v) {
  const t = clamp(v, 0, 100) / 100;
  const hue = Math.round(145 - 145 * t);
  const l = Math.round(34 + 6 * Math.sin(t * Math.PI));
  return hslToHex(hue, 62, l);
}

// WCAG relative luminance of a #rrggbb color, and contrast ratio between two colors.
function luminance(hex) {
  const ch = hex.replace('#', '');
  const lin = [0, 2, 4]
    .map((i) => parseInt(ch.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Pick the text color (near-black or white) with the BETTER contrast against the cell fill, so the
// in-cell number stays legible on the yellow-green mid-band too (where white-on-color fails WCAG).
export function textFillFor(bg) {
  return contrast(bg, '#111111') >= contrast(bg, '#ffffff') ? '#111111' : '#ffffff';
}

// integers as-is, else one decimal; sign prefix: '+' for >0, '-' for <0, '0' for 0.
export function formatDelta(v) {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const body = Number.isInteger(v) ? String(abs) : abs.toFixed(1);
  return (v > 0 ? '+' : '-') + body;
}

export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// prettify an attack key ("cross_skill_confusion") and split words across 2 lines.
function wrapAttack(key) {
  const words = key.replace(/_/g, ' ').split(' ');
  if (words.length === 1) return [words[0], ''];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

// layout constants (all integers)
const PAD = 24;
const LABEL_W = 210;
const CELL_W = 88;
const CELL_H = 44;
const HEAD_H = 58;
const SWATCH_W = 48;
const SWATCH_H = 16;

function validate(data) {
  for (const m of data.models) {
    if (!VENDOR_COLOR[m.vendor]) throw new Error(`unknown vendor "${m.vendor}" for model ${m.name}`);
    for (const a of data.attacks) {
      if (!(a in m.deltas)) throw new Error(`model ${m.name} missing attack "${a}"`);
      const d = m.deltas[a];
      if (typeof d !== 'number' || d < -100 || d > 100) {
        throw new Error(`delta out of range for ${m.name}/${a}: ${d}`);
      }
    }
  }
}

export function buildSvg(data, { dark } = {}) {
  validate(data);
  const c = dark ? CHROME.dark : CHROME.light;
  const rows = data.models;
  const cols = data.attacks;

  const gridLeft = PAD + LABEL_W;
  const gridTop = PAD + HEAD_H;
  const gridBottom = gridTop + rows.length * CELL_H;
  const legendTop = gridBottom + 34;
  const legendCaptionY = legendTop + SWATCH_H + 34;
  const footerY = legendCaptionY + 30;

  const width = gridLeft + cols.length * CELL_W + PAD;
  const height = footerY + PAD;

  const p = []; // SVG body pieces
  p.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${c.bg}"/>`);

  // column headers (attack keys, 2-line wrapped)
  for (let j = 0; j < cols.length; j++) {
    const cx = gridLeft + j * CELL_W + CELL_W / 2;
    const [l1, l2] = wrapAttack(cols[j]);
    p.push(
      `<text x="${cx}" y="${PAD + HEAD_H - 26}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${c.ink}">` +
      `<tspan x="${cx}">${xmlEscape(l1)}</tspan>` +
      (l2 ? `<tspan x="${cx}" dy="14">${xmlEscape(l2)}</tspan>` : '') +
      `</text>`,
    );
  }

  // rows: model label + cells
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const rowY = gridTop + i * CELL_H;
    const midY = rowY + CELL_H / 2;

    // vendor dot + model name + vendor (chrome-dependent text)
    p.push(`<circle cx="${PAD + 9}" cy="${midY}" r="5" fill="${VENDOR_COLOR[m.vendor]}"/>`);
    p.push(
      `<text x="${PAD + 24}" y="${midY - 3}" font-family="sans-serif" font-size="13" font-weight="600" fill="${c.ink}">${xmlEscape(m.name)}</text>`,
    );
    p.push(
      `<text x="${PAD + 24}" y="${midY + 12}" font-family="sans-serif" font-size="11" fill="${c.muted}">${xmlEscape(m.vendor)}</text>`,
    );

    // cells (chrome-independent: byte-identical across light/dark)
    for (let j = 0; j < cols.length; j++) {
      const v = m.deltas[cols[j]];
      const x = gridLeft + j * CELL_W;
      const fill = cellColor(v);
      const textFill = textFillFor(fill);
      p.push(`<rect x="${x + 1}" y="${rowY + 1}" width="${CELL_W - 2}" height="${CELL_H - 2}" rx="4" fill="${fill}"/>`);
      p.push(
        `<text x="${x + CELL_W / 2}" y="${midY}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="13" fill="${textFill}">${formatDelta(v)}</text>`,
      );
    }
  }

  // legend: 6 discrete swatches at t=0..1 (chrome-independent swatch fills)
  const legendT = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  for (let k = 0; k < legendT.length; k++) {
    const x = gridLeft + k * SWATCH_W;
    p.push(`<rect x="${x}" y="${legendTop}" width="${SWATCH_W}" height="${SWATCH_H}" fill="${cellColor(legendT[k] * 100)}"/>`);
  }
  const legW = legendT.length * SWATCH_W;
  const ticks = [[0, gridLeft], [50, gridLeft + legW / 2], [100, gridLeft + legW]];
  for (const [label, tx] of ticks) {
    p.push(
      `<text x="${tx}" y="${legendTop + SWATCH_H + 16}" text-anchor="middle" font-family="monospace" font-size="11" fill="${c.muted}">${label}</text>`,
    );
  }
  p.push(
    `<text x="${gridLeft}" y="${legendCaptionY}" font-family="sans-serif" font-size="12" fill="${c.muted}">${xmlEscape('delta = routing-accuracy points lost (green held, red broke); number in every cell')}</text>`,
  );

  // footer
  p.push(
    `<text x="${PAD}" y="${footerY}" font-family="sans-serif" font-size="11" fill="${c.muted}">${xmlEscape(data.generated + ' · deterministic ground-truth oracle, not an LLM judge')}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">\n${p.join('\n')}\n</svg>\n`;
}

function main() {
  const data = JSON.parse(readFileSync(new URL('../packages/dashboard/data.json', import.meta.url), 'utf8'));
  const light = buildSvg(data, { dark: false });
  const dark = buildSvg(data, { dark: true });
  writeFileSync(new URL('../assets/heatmap.svg', import.meta.url), light);
  writeFileSync(new URL('../assets/heatmap-dark.svg', import.meta.url), dark);
  console.log(`wrote assets/heatmap.svg (${light.length} B) + assets/heatmap-dark.svg (${dark.length} B)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
