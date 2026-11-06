// Rebuilds the Lumen 2 compiler from its source with the current build of
// itself, and checks the fixed point.
//
//   stage 1: compiler/lumen2c.wasm compiles compiler/*.lm
//   stage 2: stage 1 compiles compiler/*.lm again, and so on
//
// Without --write, the committed build must already be the fixed point: it
// compiles its own source to itself, byte for byte. With --write (after a
// change to the compiler's source), the stages go on until one compiles the
// source to itself, and that build replaces compiler/lumen2c.wasm. A change
// to code generation needs three stages: stage 1 is the new source compiled
// the old way, stage 2 the new source compiled the new way, and stage 3 must
// equal stage 2.
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
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  let prev = seed;
  for (let stage = 1; ; stage++) {
    const t = performance.now();
    const next = build(prev, src);
    console.log(`stage ${stage}: ${next.length} bytes (${hash(next)}) in ${Math.round(performance.now() - t)} ms`);
    if (same(prev, next)) {
      if (write) { writeFileSync(here('lumen2c.wasm'), next); console.log(`fixed point; wrote compiler/lumen2c.wasm${stage === 1 ? ' (unchanged)' : ''}`); }
      else if (stage === 1) console.log('fixed point: compiler/lumen2c.wasm compiles its source to itself');
      break;
    }
    if (!write) { console.error(`compiler/lumen2c.wasm (${hash(seed)}) is not the fixed point of its source: run node compiler/bootstrap.js --write`); process.exitCode = 1; break; }
    if (stage === 4) { console.error('no fixed point after four stages'); process.exitCode = 1; break; }
    prev = next;
  }
}
