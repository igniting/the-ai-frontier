// Rebuilds the Lumen 2 compiler from its source with the current build of
// itself, and checks the fixed point.
//
//   stage 1: compiler/lumen2c.wasm compiles compiler/*.lm
//   stage 2: stage 1 compiles compiler/*.lm again
//
// Stage 1 and stage 2 must be the same bytes: the compiler, compiled by
// itself, compiles itself to itself. With --write, the result replaces
// compiler/lumen2c.wasm (after a change to the compiler's source); without
// it, the committed build must already be that fixed point.
//
//   node compiler/bootstrap.js [--write]

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compilerSource } from './build.js';
import { makeCompiler } from '../src/lumen2c.js';

const here = (p) => new URL(p, import.meta.url);
const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

export function build(compilerBytes, src = compilerSource()) {
  const c = makeCompiler(compilerBytes).compile(src, { grants: null });
  if (!c.ok) {
    const e = c.errors[0];
    throw new Error(`the compiler's source does not compile: ${e.message} (line ${src.slice(0, e.span.s).split('\n').length})`);
  }
  return c.bytes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const seed = readFileSync(here('lumen2c.wasm'));
  const src = compilerSource();
  let t = performance.now();
  const stage1 = build(seed, src);
  console.log(`stage 1: ${stage1.length} bytes (${hash(stage1)}) in ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  const stage2 = build(stage1, src);
  console.log(`stage 2: ${stage2.length} bytes (${hash(stage2)}) in ${Math.round(performance.now() - t)} ms`);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(stage1, stage2)) { console.error('no fixed point: stage 1 and stage 2 differ'); process.exitCode = 1; }
  else if (write) { writeFileSync(here('lumen2c.wasm'), stage2); console.log(`fixed point; wrote compiler/lumen2c.wasm${same(seed, stage2) ? ' (unchanged)' : ''}`); }
  else if (!same(seed, stage1)) { console.error(`fixed point, but compiler/lumen2c.wasm (${hash(seed)}) is not it: run node compiler/bootstrap.js --write`); process.exitCode = 1; }
  else console.log('fixed point: compiler/lumen2c.wasm compiles its source to itself');
}
