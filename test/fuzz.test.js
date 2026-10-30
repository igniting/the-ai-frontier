// A fixed-seed slice of the differential fuzzer runs with the test suite.
// (`npm run fuzz` runs thousands more; `node fuzz/mutants.js` checks that
// the fuzzer catches deliberately injected compiler bugs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateProgram, renderProgram } from '../fuzz/generate.js';
import { checkProgram } from '../fuzz/check.js';

test('300 random programs agree across the interpreter and four wasm builds (plain/-O, with and without GC stress)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const src = renderProgram(generateProgram(seed, { size: 1 + (seed % 3) }));
    const r = checkProgram(src);
    assert.notEqual(r.status, 'mismatch', `seed ${seed}: ${r.detail}\n${src}`);
    assert.notEqual(r.status, 'rejected', `seed ${seed}: ${r.detail}`);
  }
});
