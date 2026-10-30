// Golden tests: every example program produces exactly its recorded output,
// with and without -O (or its recorded compile-time diagnostic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, runWasm, interpretSource, formatDiagnostic, decodeBytes } from '../src/compiler.js';

const dir = new URL('../examples/', import.meta.url);
const examples = readdirSync(dir).filter((f) => f.endsWith('.lm'));
// The interpreter is ~100x slower than compiled code; cross-check it on the lighter examples.
const INTERPRET = new Set(['hello', 'calculator', 'huffman', 'mandelbrot']);

for (const file of examples) {
  const name = file.replace(/\.lm$/, '');
  const src = readFileSync(new URL(file, dir), 'utf8');
  test(`example ${name}`, () => {
    const c = compile(src);
    const errFile = new URL(`expected/${name}.err`, dir);
    if (existsSync(errFile)) {
      assert.equal(c.ok, false);
      assert.equal(formatDiagnostic(src, c.errors[0]) + '\n', readFileSync(errFile, 'utf8'));
      return;
    }
    assert.ok(c.ok, c.errors && formatDiagnostic(src, c.errors[0]));
    const expected = readFileSync(new URL(`expected/${name}.out`, dir), 'utf8');
    const r = runWasm(c.wasm);
    assert.equal(r.error, null);
    assert.equal(decodeBytes(r.output), expected);
    const o = runWasm(compile(src, { optimize: true }).wasm);
    assert.equal(decodeBytes(o.output), expected, '-O');
    if (INTERPRET.has(name)) {
      const i = interpretSource(src);
      assert.equal(decodeBytes(i.output), expected);
    }
  });
}
