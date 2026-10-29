#!/usr/bin/env node
// Differential fuzzer: generates random well-typed Lumen programs and checks
// that three executions agree byte-for-byte (output and runtime error):
//   1. the reference tree-walking interpreter,
//   2. the compiled WebAssembly,
//   3. the compiled WebAssembly with a 4 KiB heap and GC on *every* allocation
//      (and the old semispace poisoned), which flushes out any pointer the
//      compiler forgot to root.
// On a mismatch it shrinks the program (dropping main statements and unused
// functions) and writes it to fuzz/failures/.
//
//   node fuzz/fuzz.js [--count N] [--seed S] [--size 1..3] [--quiet]

import { mkdirSync, writeFileSync } from 'node:fs';
import { generateProgram, renderProgram } from './generate.js';
import { checkProgram } from './check.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const count = opt('count', 500);
const seed0 = opt('seed', Date.now() % 1e9);
const size = opt('size', 2);
const quiet = args.includes('--quiet');

const totals = { ok: 0, runtimeErrors: 0, skipped: 0, mismatches: 0, rejected: 0, gcs: 0 };
const t0 = Date.now();
for (let k = 0; k < count; k++) {
  const seed = seed0 + k;
  const prog = generateProgram(seed, { size });
  const r = checkProgram(renderProgram(prog));
  if (r.status === 'skipped') totals.skipped++;
  else if (r.status === 'rejected') {
    totals.rejected++;
    console.log(`seed ${seed}: generator produced a program the compiler rejected:\n${r.detail}`);
  } else if (r.status === 'mismatch') {
    totals.mismatches++;
    const small = shrink(prog);
    mkdirSync('fuzz/failures', { recursive: true });
    const file = `fuzz/failures/seed-${seed}.lm`;
    writeFileSync(file, renderProgram(small));
    console.log(`seed ${seed}: MISMATCH (${r.detail}) -> ${file}`);
  } else {
    totals.ok++;
    totals.gcs += r.gcCount;
    if (r.error) totals.runtimeErrors++;
  }
  if (!quiet && (k + 1) % 100 === 0) console.log(`  ${k + 1}/${count} programs...`);
}

function shrink(prog) {
  let cur = prog;
  const fails = (p) => checkProgram(renderProgram(p)).status === 'mismatch';
  for (let changed = true; changed;) {
    changed = false;
    for (let i = cur.stmts.length - 1; i >= 0; i--) {
      const cand = { ...cur, stmts: cur.stmts.filter((_, j) => j !== i) };
      if (cand.stmts.length && fails(cand)) { cur = cand; changed = true; }
    }
    for (let i = cur.decls.length - 1; i >= 1; i--) {
      const cand = { ...cur, decls: cur.decls.filter((_, j) => j !== i) };
      if (fails(cand)) { cur = cand; changed = true; }
    }
  }
  return cur;
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${count} programs (seeds ${seed0}..${seed0 + count - 1}, size ${size}) in ${secs}s`);
console.log(`  agreed:       ${totals.ok}  (${totals.runtimeErrors} ended in an identical runtime error; ${totals.gcs} GCs in stress mode)`);
console.log(`  skipped:      ${totals.skipped}  (exceeded the interpreter step budget)`);
console.log(`  rejected:     ${totals.rejected}`);
console.log(`  MISMATCHES:   ${totals.mismatches}`);
process.exit(totals.mismatches || totals.rejected ? 1 : 0);
