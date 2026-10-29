#!/usr/bin/env node
// Scores any implementation of Lumen against this reference implementation.
//
//   node challenge/score.js [--fuzz N] [--seed S] [--timeout MS] -- <command> [args...]
//
// The command is run once per test program, with the program's path appended,
// and must follow the protocol in SPEC.md ("Runtime errors"): program output on
// stdout; on a runtime error, `runtime error: <message>` on stderr and a
// non-zero exit; on a compile error, nothing on stdout and a non-zero exit.
//
// Expected results come from this repository's reference implementation, so
// the score measures agreement with SPEC.md, byte for byte.
//
// Example (scores this repository against itself):
//   node challenge/score.js -- node bin/lumen.js run

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, runWasm, interpretSource, decodeBytes } from '../src/compiler.js';
import { generateProgram, renderProgram } from '../fuzz/generate.js';
import { PROBES } from './probes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
if (dash < 0 || dash === argv.length - 1) {
  console.error('usage: node challenge/score.js [--fuzz N] [--seed S] [--timeout MS] -- <command> [args...]');
  process.exit(2);
}
const flags = argv.slice(0, dash);
const command = argv.slice(dash + 1);
const flag = (name, def) => {
  const i = flags.indexOf(`--${name}`);
  return i >= 0 ? Number(flags[i + 1]) : def;
};
const FUZZ = flag('fuzz', 300);
const SEED = flag('seed', 424242);
const TIMEOUT = flag('timeout', 30000);

// Expected behaviour according to the reference implementation.
function reference(src) {
  const c = compile(src);
  if (!c.ok) return { rejects: true };
  const r = runWasm(c.wasm);
  return { rejects: false, stdout: decodeBytes(r.output), error: r.error };
}

const cases = [];
const exDir = join(root, 'examples');
for (const f of readdirSync(exDir).filter((f) => f.endsWith('.lm')).sort()) {
  const name = f.replace(/\.lm$/, '');
  const src = readFileSync(join(exDir, f), 'utf8');
  const rejects = existsSync(join(exDir, 'expected', `${name}.err`));
  const stdout = rejects ? '' : readFileSync(join(exDir, 'expected', `${name}.out`), 'utf8');
  cases.push({ group: 'examples', name, src, expect: { rejects, stdout, error: null } });
}
for (const [name, src] of PROBES) cases.push({ group: 'spec probes', name, src, expect: reference(src) });
for (let k = 0; k < FUZZ; k++) {
  const seed = SEED + k;
  const src = renderProgram(generateProgram(seed, { size: 1 + (k % 3) }));
  const ref = interpretSource(src, { maxSteps: 300000 });
  if (ref.error === 'out of fuel' || ref.error === 'stack overflow') continue; // not a stable expectation
  cases.push({ group: 'fuzz', name: `seed ${seed}`, src, expect: { rejects: false, stdout: decodeBytes(ref.output), error: ref.error } });
}

const dir = mkdtempSync(join(tmpdir(), 'lumen-score-'));
const groups = new Map();
const failures = [];
console.log(`Scoring: ${command.join(' ')}\n${cases.length} programs (${FUZZ} fuzz seeds from ${SEED})\n`);

cases.forEach((c, i) => {
  const file = join(dir, `case${i}.lm`);
  writeFileSync(file, c.src);
  const r = spawnSync(command[0], [...command.slice(1), file], { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 << 20 });
  const why = judge(c.expect, r);
  const g = groups.get(c.group) ?? { pass: 0, total: 0 };
  g.total++;
  if (!why) g.pass++;
  else failures.push({ ...c, why, file });
  groups.set(c.group, g);
  if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${cases.length}\n`);
});

function judge(expect, r) {
  if (r.error?.code === 'ETIMEDOUT') return `timed out after ${TIMEOUT} ms`;
  if (r.error) return `could not run: ${r.error.message}`;
  if (expect.rejects) {
    if (r.status === 0) return 'accepted a program that must be rejected at compile time';
    if (r.stdout) return 'printed output for a program that must be rejected';
    return null;
  }
  if (r.stdout !== expect.stdout) {
    const at = [...r.stdout].findIndex((ch, k) => ch !== expect.stdout[k]);
    const pos = at < 0 ? Math.min(r.stdout.length, expect.stdout.length) : at;
    return `stdout differs at character ${pos}: expected ${JSON.stringify(expect.stdout.slice(pos, pos + 40))}, got ${JSON.stringify(r.stdout.slice(pos, pos + 40))}`
      + (r.status !== 0 ? `\n    (exit ${r.status}; stderr: ${JSON.stringify(r.stderr.slice(0, 200))})` : '');
  }
  if (expect.error === null && r.status !== 0) return `exited with status ${r.status}: ${r.stderr.slice(0, 200)}`;
  if (expect.error !== null) {
    if (r.status === 0) return `expected runtime error "${expect.error}", but exited successfully`;
    if (!r.stderr.includes(`runtime error: ${expect.error}`)) return `expected "runtime error: ${expect.error}" on stderr, got ${JSON.stringify(r.stderr.slice(0, 200))}`;
  }
  return null;
}

let pass = 0, total = 0;
for (const [name, g] of groups) {
  pass += g.pass;
  total += g.total;
  console.log(`  ${name.padEnd(12)} ${String(g.pass).padStart(4)} / ${g.total}`);
}
console.log(`  ${'total'.padEnd(12)} ${String(pass).padStart(4)} / ${total}   (${((100 * pass) / total).toFixed(1)}%)\n`);
for (const f of failures.slice(0, 12)) console.log(`FAIL [${f.group}] ${f.name}\n    ${f.why}\n`);
if (failures.length > 12) console.log(`… and ${failures.length - 12} more failures.`);
if (!failures.length) rmSync(dir, { recursive: true, force: true });
else console.log(`Failing programs are kept in ${dir}`);
process.exit(failures.length ? 1 : 0);
