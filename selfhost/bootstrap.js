#!/usr/bin/env node
// Bootstraps the self-hosted compiler and checks it bit for bit.
//
//   stage1 = reference compiler (JS)  compiles lumenc.lm
//   stage2 = stage1 (wasm)            compiles lumenc.lm
//   stage3 = stage2 (wasm)            compiles lumenc.lm
//
// Expected: stage1 == stage2 == stage3, byte for byte (a fixed point), and
// for every other program, lumenc's output == the reference compiler's.
//
//   node selfhost/bootstrap.js [--programs N]   N random fuzz programs too (default 200)

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile, runWasm } from '../src/compiler.js';
import { stage1Wasm, runLumenc, lumencSource, outputBytes } from './harness.js';
import { wasmDiff } from './wasmdiff.js';
import { generateProgram, renderProgram } from '../fuzz/generate.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const N = arg('programs', 200);
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

function selfCompile(wasm, text) {
  const r = runLumenc(wasm, 'wasm', text);
  if (r.error) throw new Error(`lumenc failed: ${r.error}`);
  return { bytes: outputBytes(r.output), timeMs: r.timeMs };
}

const t0 = Date.now();
const { source } = lumencSource();
const lines = source.split('\n').length;
console.log(`lumenc.lm: ${lines} lines of Lumen\n`);

const stage1 = stage1Wasm();
console.log(`stage1  reference compiler -> lumenc.wasm   ${stage1.length} bytes  sha256 ${sha(stage1)}`);
const s2 = selfCompile(stage1, source);
console.log(`stage2  stage1 compiles itself              ${s2.bytes.length} bytes  sha256 ${sha(s2.bytes)}  (${(s2.timeMs / 1000).toFixed(2)} s)`);
const d12 = wasmDiff(stage1, s2.bytes);
const s3 = selfCompile(s2.bytes, source);
console.log(`stage3  stage2 compiles itself              ${s3.bytes.length} bytes  sha256 ${sha(s3.bytes)}  (${(s3.timeMs / 1000).toFixed(2)} s)`);
const d23 = wasmDiff(s2.bytes, s3.bytes);
console.log(`\nstage1 == stage2: ${d12 ? 'NO\n  ' + d12 : 'yes, byte for byte'}`);
console.log(`stage2 == stage3: ${d23 ? 'NO\n  ' + d23 : 'yes, byte for byte (fixed point)'}`);

// Every example and N random programs: lumenc must emit exactly what the reference emits.
const programs = [
  ...readdirSync('examples').filter((f) => f.endsWith('.lm')).map((f) => [`examples/${f}`, readFileSync(`examples/${f}`, 'utf8')]),
  ...Array.from({ length: N }, (_, k) => [`fuzz seed ${7000 + k}`, renderProgram(generateProgram(7000 + k, { size: 1 + (k % 3) }))]),
];
let same = 0, rejectedBoth = 0, bad = 0;
for (const [name, text] of programs) {
  const ref = compile(text);
  const r = runLumenc(stage1, 'wasm', text);
  if (!ref.ok) {
    if (r.error) rejectedBoth++;
    else { bad++; console.log(`MISMATCH ${name}: reference rejects (${ref.errors[0].message}), lumenc accepts`); }
    continue;
  }
  if (r.error) { bad++; console.log(`MISMATCH ${name}: lumenc failed: ${r.error}`); continue; }
  const d = wasmDiff(ref.wasm, outputBytes(r.output));
  if (d) {
    bad++;
    console.log(`MISMATCH ${name}: ${d}`);
    mkdirSync('selfhost/failures', { recursive: true });
    writeFileSync(`selfhost/failures/${name.replace(/[^\w.-]+/g, '_')}.lm`, text);
  } else same++;
}
console.log(`\nprograms: ${same} byte-identical, ${rejectedBoth} rejected by both, ${bad} mismatches (of ${programs.length})`);
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(d12 || d23 || bad ? 1 : 0);
