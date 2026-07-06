// Inlines data.json into template.html -> a self-contained index.html for GitHub Pages.
// Regenerate data.json from runs/ with the aggregation, then: node packages/dashboard/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const tpl = readFileSync(new URL('template.html', dir), 'utf8');
const data = readFileSync(new URL('data.json', dir), 'utf8').trim();
const out = tpl.replace('/*__DATA__*/{}', () => data);
if (out === tpl) throw new Error('data placeholder not found in template.html');
writeFileSync(new URL('index.html', dir), out);
console.log('built index.html (self-contained, ' + out.length + ' bytes)');
