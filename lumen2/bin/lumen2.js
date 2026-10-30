#!/usr/bin/env node
// lumen2 check FILE            print every function's inferred type and effects
// lumen2 run FILE [--interp]   run a program (the reference interpreter until the back end is used)
//            [--input FILE]

import { readFileSync } from 'node:fs';
import { checkSource, interpretSource, formatDiagnostic, decodeBytes, utf8 } from '../src/api.js';

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) {
  console.error('usage: lumen2 check FILE | lumen2 run FILE [--input FILE]');
  process.exit(2);
}
const source = readFileSync(file, 'utf8');
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };

const c = checkSource(source);
if (!c.ok) {
  for (const e of c.errors) console.error(formatDiagnostic(source, e));
  process.exit(1);
}
for (const w of c.warnings) console.error(formatDiagnostic(source, w).replace(/^error/, 'warning'));

if (cmd === 'check') {
  for (const s of c.signatures) console.log(`${s.name} : ${s.type}`);
  process.exit(0);
}
if (cmd === 'run') {
  const inputPath = opt('input');
  const input = inputPath ? utf8(readFileSync(inputPath, 'utf8')) : '';
  const r = interpretSource(source, { input });
  process.stdout.write(decodeBytes(r.output));
  if (r.error) { console.error(`runtime error: ${r.error}`); process.exit(1); }
  process.exit(0);
}
console.error(`unknown command: ${cmd}`);
process.exit(2);
