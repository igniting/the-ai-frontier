// The self-hosting fixed point.
//
//   stage 1 = lumen2c.lm compiled by the compiler (compiler/lumen2c.wasm)
//   stage 2 = lumen2c.lm compiled by stage 1
//   stage 3 = lumen2c.lm compiled by stage 2
//
// Stage 2 and stage 3 must be byte-identical: the compiler, compiled by
// itself, reproduces itself. Stage 1 and stage 2 differ (they come from
// different compilers) but must behave the same, which the test suite checks
// on the examples and on generated programs.
//
//   node selfhost/bootstrap.js [--out DIR]   (DIR gets the three modules)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileSource } from '../src/api.js';
import { runWasm } from '../src/runtime.js';
import { makeHost } from '../src/host.js';
import { utf8 } from '../src/lexer.js';

export const SOURCE = new URL('./lumen2c.lm', import.meta.url);

// Runs a compiler module on a source text; returns the module it writes.
export function compileWith(compiler, source) {
  const t = performance.now();
  const r = runWasm(compiler, { input: utf8(source), host: makeHost() });
  if (r.error) throw new Error(`the compiler stopped: ${r.error}`);
  if (r.live !== 0) throw new Error(`the compiler leaked ${r.live} objects`);
  const bytes = Uint8Array.from(r.output, (c) => c.charCodeAt(0));
  return { bytes, ms: performance.now() - t, allocs: r.allocs };
}

export function stage1() {
  const c = compileSource(readFileSync(SOURCE, 'utf8'), { grants: null });
  if (!c.ok) throw new Error(`lumen2c.lm: ${c.errors[0].message}`);
  return c.bytes;
}

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = readFileSync(SOURCE, 'utf8');
  const i = process.argv.indexOf('--out');
  const out = i >= 0 ? process.argv[i + 1] : null;
  let t = performance.now();
  const s1 = stage1();
  console.log(`stage 1: lumen2c.lm (${src.split('\n').length} lines) compiled by the compiler: ${s1.length} bytes, ${sha(s1)} (${Math.round(performance.now() - t)} ms)`);
  const s2 = compileWith(s1, src);
  console.log(`stage 2: compiled by stage 1: ${s2.bytes.length} bytes, ${sha(s2.bytes)} (${Math.round(s2.ms)} ms, ${s2.allocs} allocations, nothing leaked)`);
  if (!WebAssembly.validate(s2.bytes)) throw new Error('stage 2 is not a valid module');
  const s3 = compileWith(s2.bytes, src);
  console.log(`stage 3: compiled by stage 2: ${s3.bytes.length} bytes, ${sha(s3.bytes)} (${Math.round(s3.ms)} ms, ${s3.allocs} allocations, nothing leaked)`);
  const same = s2.bytes.length === s3.bytes.length && s2.bytes.every((b, k) => b === s3.bytes[k]);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/stage1.wasm`, s1);
    writeFileSync(`${out}/stage2.wasm`, s2.bytes);
    writeFileSync(`${out}/stage3.wasm`, s3.bytes);
  }
  console.log(same ? 'FIXED POINT: stage 2 and stage 3 are byte-identical' : 'NOT A FIXED POINT: stage 2 and stage 3 differ');
  process.exitCode = same ? 0 : 1;
}
