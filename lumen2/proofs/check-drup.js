// Checks a DRUP refutation with proofs/rup.lm: a DRUP checker written in
// Lumen 2 with every array access proved in bounds, so that no function in it
// can fail. It shares no code with src/rup.js, the checker prove-schur.js
// uses, so the two are independent checks of the same proof.
//
//   node proofs/check-drup.js FORMULA.cnf PROOF.drup [--selfhost]
//
// By default rup.lm is compiled by the reference compiler (src/), which proves
// it first and stops if any function could fail. With --selfhost it is
// compiled by the self-hosted compiler instead (stage 2 of
// selfhost/bootstrap.js, the module that reproduces itself byte for byte).
// Either way the checker reads its input a line at a time, so the proof can
// be larger than Lumen 2's longest string. Exits 0 only on "s VERIFIED".

import { readFileSync } from 'node:fs';
import { compileSource } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { makeHost } from '../src/host.js';
import { stage1, compileWith } from '../selfhost/bootstrap.js';

const SOURCE = new URL('./rup.lm', import.meta.url);

// The checker as a WebAssembly module, and how it was made.
export function checker({ selfhost = false } = {}) {
  const src = readFileSync(SOURCE, 'utf8');
  const t = performance.now();
  if (selfhost) {
    const s2 = compileWith(stage1(), readFileSync(new URL('../selfhost/lumen2c.lm', import.meta.url), 'utf8')).bytes;
    return { bytes: compileWith(s2, src).bytes, how: 'compiled by the self-hosted compiler', ms: performance.now() - t };
  }
  const c = compileSource(src);
  if (!c.ok) throw new Error(`rup.lm: ${c.errors[0].message}`);
  const failing = c.signatures.filter((s) => s.type.includes('fail')).map((s) => s.name);
  if (failing.length) throw new Error(`rup.lm: these functions can fail: ${failing.join(', ')}`);
  return { bytes: c.bytes, how: 'proved (no function can fail) and compiled by the reference compiler', ms: performance.now() - t };
}

export function checkDrup(bytes, cnf, drup) {
  const t = performance.now();
  const r = runWasm(bytes, { input: cnf + drup, host: makeHost() });
  if (r.error) throw new Error(`the checker stopped: ${r.error}`);
  if (r.live !== 0) throw new Error(`the checker leaked ${r.live} objects`);
  return { verdict: r.output.trim(), ms: performance.now() - t };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length !== 2) {
    console.error('usage: node proofs/check-drup.js FORMULA.cnf PROOF.drup [--selfhost]');
    process.exit(2);
  }
  const [cnf, drup] = files.map((f) => readFileSync(f, 'latin1'));
  const c = checker({ selfhost: process.argv.includes('--selfhost') });
  console.log(`rup.lm: ${c.how} in ${(c.ms / 1000).toFixed(1)} s (${c.bytes.length} bytes)`);
  const lemmas = drup.split('\n').filter((l) => /^\s*-?\d/.test(l)).length;
  const r = checkDrup(c.bytes, cnf.endsWith('\n') ? cnf : `${cnf}\n`, drup);
  console.log(`${r.verdict}  (${lemmas} lemmas in ${(r.ms / 1000).toFixed(1)} s)`);
  process.exit(r.verdict === 's VERIFIED' ? 0 : 1);
}
