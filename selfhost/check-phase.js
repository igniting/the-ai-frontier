#!/usr/bin/env node
// Compares one phase of lumenc with the reference compiler on a set of files:
//   node selfhost/check-phase.js <tokens|ast|types|ir|wasm> [files...]
// With no files: all examples, the prelude, and lumenc's own source.

import { readFileSync, readdirSync } from 'node:fs';
import { stage1Wasm, runLumenc, refTokens, refAst, refTypes, refIR, lumencSource, latin1, toBytes } from './harness.js';
import { PRELUDE } from '../src/prelude.js';

const [mode, ...files] = process.argv.slice(2);
const inputs = files.length
  ? files.map((f) => [f, readFileSync(f, 'utf8')])
  : [
    ...readdirSync('examples').filter((f) => f.endsWith('.lm')).map((f) => [`examples/${f}`, readFileSync(`examples/${f}`, 'utf8')]),
    ['prelude', PRELUDE],
    ['lumenc.lm', lumencSource().source],
  ];
const ref = { tokens: refTokens, ast: refAst, types: refTypes, ir: refIR }[mode];
const wasm = stage1Wasm();
let bad = 0;
for (const [name, text] of inputs) {
  const r = runLumenc(wasm, mode, text);
  // A lumenc compile error is a panic "@start-end phase: message"; compare the message.
  const m = /^panic: @\d+-\d+ \w+: ([\s\S]*)$/.exec(r.error ?? '');
  if (m) { r.output = latin1(toBytes(`error: ${m[1]}\n`)); r.error = null; }
  const expected = latin1(toBytes(ref(text)));
  if (r.error || r.output !== expected) {
    bad++;
    const at = [...r.output].findIndex((c, i) => c !== expected[i]);
    console.log(`MISMATCH ${name}: ${r.error ?? ''}`);
    if (!r.error) console.log(`  at ${at}:\n  lumenc: ${JSON.stringify(r.output.slice(at - 60, at + 80))}\n  ref:    ${JSON.stringify(expected.slice(at - 60, at + 80))}`);
  } else console.log(`ok ${name} (${r.timeMs.toFixed(0)} ms)`);
}
process.exit(bad ? 1 : 0);
