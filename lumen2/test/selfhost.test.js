// The self-hosted compiler (selfhost/lumen2c.lm): it reaches a fixed point,
// and the modules it writes behave exactly as the reference interpreter says
// programs must, with nothing leaked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { interpretSource, makeHost } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { generate } from './fuzz.js';
import { stage1, compileWith, SOURCE } from '../selfhost/bootstrap.js';
import { referenceEncoding } from '../proofs/prove-schur.js';

const source = readFileSync(SOURCE, 'utf8');
const s1 = stage1();
const s2 = compileWith(s1, source).bytes;

test('the compiler compiled by itself reproduces itself byte for byte', () => {
  const s3 = compileWith(s2, source).bytes;
  assert.ok(WebAssembly.validate(s2));
  assert.equal(Buffer.compare(Buffer.from(s2), Buffer.from(s3)), 0, 'stage 2 and stage 3 differ');
});

function agrees(name, src, input = '') {
  const want = interpretSource(src, { input, host: makeHost({ seed: 5n }), grants: null, maxSteps: 3000000 });
  assert.ok(want.ok, `${name}: ${want.errors?.[0]?.message}`);
  if (want.error && /fuel|steps|stack/.test(want.error)) return false;
  for (const [stage, compiler] of [['stage 1', s1], ['stage 2', s2]]) {
    const got = runWasm(compileWith(compiler, src).bytes, { input, host: makeHost({ seed: 5n }) });
    assert.equal(got.output, want.output, `${name} (${stage}): output`);
    assert.equal(got.error, want.error ?? null, `${name} (${stage}): error`);
    if (!got.error) assert.equal(got.live, 0, `${name} (${stage}): leaked objects`);
  }
  return true;
}

test('its modules agree with the interpreter on the examples and the Schur programs', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const f of readdirSync(dir)) if (f.endsWith('.lm') && f !== 'properties.lm') agrees(f, readFileSync(new URL(f, dir), 'utf8'));
  const f = referenceEncoding(3, 14);
  const cnf = `p cnf ${f.numVars} ${f.clauses.length}\n${f.clauses.map((c) => `${c.join(' ')} 0`).join('\n')}\n`;
  agrees('sat.lm', readFileSync(new URL('../proofs/sat.lm', import.meta.url), 'utf8'), cnf);
  agrees('schur.lm', readFileSync(new URL('../proofs/schur.lm', import.meta.url), 'utf8'), '4 44');
  // The proved DRUP checker, on the solver's refutation of 1..14 in three groups.
  const proof = runWasm(compileWith(s2, readFileSync(new URL('../proofs/sat.lm', import.meta.url), 'utf8')).bytes, { input: cnf }).output;
  assert.ok(agrees('rup.lm', readFileSync(new URL('../proofs/rup.lm', import.meta.url), 'utf8'), cnf + proof.split('\n').filter((l) => /^-?\d/.test(l)).join('\n') + '\n'), 'the interpreter ran out of fuel');
});

test('its modules agree with the interpreter on generated programs', () => {
  let ran = 0;
  for (let seed = 1; seed <= 60; seed++) if (agrees(`generated program ${seed}`, generate(seed))) ran++;
  assert.ok(ran >= 55);
});
