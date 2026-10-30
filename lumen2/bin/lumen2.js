#!/usr/bin/env node
// lumen2 check FILE                 print every function's inferred type and effects
// lumen2 run FILE [--input FILE]    compile to WebAssembly and run
//            [--interp]             use the reference interpreter instead
//            [--paranoid]           never reuse freed memory; catch any use after free
// lumen2 build FILE [-o OUT.wasm]   write the WebAssembly module
// lumen2 ir FILE [FN]               print the IR with its reference-count operations

import { readFileSync, writeFileSync } from 'node:fs';
import { checkSource, interpretSource, compileSource, formatDiagnostic, decodeBytes, utf8 } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { showIR } from '../src/perceus.js';

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || !file) {
  console.error('usage: lumen2 check FILE | run FILE [--input FILE] [--interp] [--paranoid] | build FILE [-o OUT] | ir FILE [FN]');
  process.exit(2);
}
const source = readFileSync(file, 'utf8');
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const flag = (name) => rest.includes(name);

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
  const inputPath = opt('--input');
  const input = inputPath ? utf8(readFileSync(inputPath, 'utf8')) : '';
  let r;
  if (flag('--interp')) r = interpretSource(source, { input });
  else {
    r = runWasm(compileSource(source, { paranoid: flag('--paranoid') }).bytes, { input });
    if (!r.error && r.live) r.error = `internal error: ${r.live} objects were never freed`;
  }
  process.stdout.write(decodeBytes(r.output));
  if (r.error) { console.error(`runtime error: ${r.error}`); process.exit(1); }
  process.exit(0);
}
if (cmd === 'build') {
  const out = opt('-o') ?? file.replace(/\.[^.]*$/, '') + '.wasm';
  writeFileSync(out, compileSource(source, { paranoid: flag('--paranoid') }).bytes);
  process.exit(0);
}
if (cmd === 'ir') {
  const { ir } = compileSource(source);
  const want = rest[0];
  for (const f of ir.fns) if (want ? f.name === want || f.name.startsWith(`${want}<`) : !f.name.includes(':') || f.name.startsWith('lambda')) console.log(`${showIR(f)}\n`);
  process.exit(0);
}
console.error(`unknown command: ${cmd}`);
process.exit(2);
