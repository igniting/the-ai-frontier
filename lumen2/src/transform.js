// lumen2 transform: a user's function applied to every line of a file, on
// every core. The user writes
//
//   fn transform(n: Int, line: String) -> Option<String>
//
// for line n (from 1) without its line break: Some(text) prints text as an
// output line, None drops the line. Its effects may only be `fail`: a
// transform that could print, read input, read the clock or use randomness
// is rejected before it runs. So it can run on lines in any order, on any
// thread, and the output is the same however many threads run it.
//
// The program that runs is the transform, then the library
// (transform/lib.lm: CSV fields, numbers, text), then the harness
// (transform/harness.lm), which reads a batch of lines at a time, maps the
// batch with par_map and prints the results in order. Node only.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkSource, compileSource, formatDiagnostic, runWasm } from './api.js';
import { inputOf } from './runtime.js';

export const LIBRARY = readFileSync(new URL('../transform/lib.lm', import.meta.url), 'utf8');
const HARNESS = readFileSync(new URL('../transform/harness.lm', import.meta.url), 'utf8');
export const CONTRACT = 'fn transform(n: Int, line: String) -> Option<String>';

const EFFECT_WORDS = { output: 'write output', input: 'read input', clock: 'read the clock', random: 'use randomness' };

// The effects in a function type's text, as printed by the checker: after
// " ! ", one name or several in braces.
export function effectsOf(type) {
  const m = / ! (\{[^}]*\}|\w+)$/.exec(type);
  if (!m) return [];
  return m[1].replace(/[{}]/g, '').split(',').map((e) => e.trim()).filter(Boolean);
}

// Where each top-level function of the transform is defined: name -> line.
function definitions(udf) {
  const at = new Map();
  udf.split('\n').forEach((l, i) => { const m = /^fn\s+([A-Za-z_]\w*)/.exec(l); if (m && !at.has(m[1])) at.set(m[1], i + 1); });
  return at;
}

const fail = (...errors) => ({ ok: false, errors });

// Formats the checker's errors on the combined program: those in the
// transform as usual (its lines come first, so line numbers are its own),
// those after it as being about the library or the harness.
function report(udf, combined, errors, what) {
  return errors.map((e) => {
    if (e.span && e.span.s <= udf.length) return formatDiagnostic(combined, e);
    return `error: ${e.message}\n  = note: in ${what}, not in the transform: does the transform define a name the library or the harness also defines? (see transform/lib.lm)`;
  });
}

// The program that runs a transform: line numbers from first, batch lines read
// at a time, chunk lines to a task, at most steps steps a line (null: no limit).
function program(udf, { first, batch, chunk, steps }) {
  return `${udf}\n${LIBRARY}\nfn tf_first() -> Int { ${first} }\nfn tf_batch() -> Int { ${batch} }\nfn tf_chunk() -> Int { ${chunk} }\nfn tf_budget() -> Int { ${steps ?? 0} }\n${HARNESS}`;
}
const compileProgram = (src, sizes) => compileSource(src, { grants: ['input', 'output'], fuel: sizes.steps !== null });

// The default budget: ten million steps a line. A step is the start of a
// function (the transform's, the library's, a lambda's) or a jump back to the
// start of a loop; a line of CSV takes hundreds.
export const DEFAULT_STEPS = 10000000;

// The transform's text without comments and string literals.
const code = (src) => src.replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

// Checks a transform and compiles the program that runs it. Returns
// { ok: true, bytes, signature, ... } or { ok: false, errors } (formatted).
// batch: how many lines are read at a time; chunk: how many lines a task
// transforms (par_map maps a batch's chunks). steps: how many steps each
// line may take, or null for no limit. cache: a directory where compiled
// transforms are kept (see cacheKey), or null.
export function compileTransform(udf, { batch = 4096, chunk = 64, steps = DEFAULT_STEPS, cache = null } = {}) {
  const defs = definitions(udf);
  if (defs.has('main')) return fail(`error: a transform does not define \`main\` (the harness does): define \`${CONTRACT}\``);
  // Names starting with tf_ are the harness's, to define or to use (tf_steps would let a transform set its own budget).
  const reserved = /\btf_\w*/.exec(code(udf));
  if (reserved) return fail(`error: \`${reserved[0]}\`: names starting with \`tf_\` are the harness's${defs.has(reserved[0]) ? ` (line ${defs.get(reserved[0])})` : ''}`);
  const sizes = { first: 1, batch: Math.max(1, Math.floor(batch)), chunk: Math.max(1, Math.floor(chunk)), steps: steps === null ? null : Math.max(1, Math.floor(steps)) };
  const key = cache ? cacheKey(udf, sizes) : null;
  const hit = key && fromCache(cache, key);
  if (hit) return { ok: true, ...hit, udf, ...sizes, cached: true };

  // The whole program. The harness calls transform from a function declared
  // with only `fail`, inside par_map, so if it compiles, transform has the
  // contract's type and can only fail.
  const r = compileProgram(program(udf, sizes), sizes);
  if (!r.ok) return fail(...diagnose(udf, defs, program(udf, sizes), r.errors));
  const signature = r.signatures.find((s) => s.name === 'transform').type;
  if (key) toCache(cache, key, r.bytes, signature);
  return { ok: true, bytes: r.bytes, signature, udf, ...sizes };
}

// Why a transform's program does not compile, in terms of the transform: its
// own errors, or how it breaks the contract (checked on the transform and
// the library alone, with a main that does nothing).
function diagnose(udf, defs, full, errors) {
  const probe = `${udf}\n${LIBRARY}\nfn main() { () }\n`;
  const c = checkSource(probe);
  if (!c.ok) return report(udf, probe, c.errors, 'the transform library');
  const sig = c.signatures.find((s) => s.name === 'transform');
  if (!sig) return [`error: the file defines no transform: define \`${CONTRACT}\``];
  const bad = effectsOf(sig.type).filter((e) => e !== 'fail');
  if (bad.length) {
    const words = bad.map((e) => EFFECT_WORDS[e] ?? e);
    const culprits = c.signatures.filter((s) => defs.has(s.name) && effectsOf(s.type).some((e) => bad.includes(e)));
    const width = Math.max(...culprits.map((s) => s.name.length));
    return [[
      `error: \`transform\` can ${words.join(' and ')}, but a transform may only compute (and fail)`,
      ...culprits.map((s) => `  ${s.name.padEnd(width)}  ${s.type}  (line ${defs.get(s.name)})`),
      '  = note: a transform runs on many lines at once, in any order, on every core; so that the output',
      '    is the same however it is run, it may not print, read input, read the clock or use randomness',
    ].join('\n')];
  }
  const inTransform = errors.filter((e) => e.span && e.span.s <= udf.length);
  if (inTransform.length) return report(udf, full, inTransform, 'the harness');
  return [`error: \`transform\` must have the type \`fn(Int, String) -> Option<String>\`, but it has the type \`${sig.type}\``];
}

// The cache of compiled transforms: a program is kept under the hash of
// everything it is compiled from (the compiler, the library, the harness, the
// transform and the sizes), so a change to any of them compiles it again.
export function defaultCache() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lumen2', 'transforms');
}
function cacheKey(udf, sizes) {
  const h = createHash('sha256').update(readFileSync(new URL('../compiler/lumen2c.wasm', import.meta.url)));
  for (const part of [LIBRARY, HARNESS, udf, JSON.stringify(sizes)]) h.update(`\0${part}`);
  return h.digest('hex');
}
function fromCache(dir, key) {
  try {
    const { signature } = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
    return { bytes: readFileSync(join(dir, `${key}.wasm`)), signature };
  } catch { return null; }
}
function toCache(dir, key, bytes, signature) {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${key}.${process.pid}.tmp`);
    writeFileSync(tmp, bytes); renameSync(tmp, join(dir, `${key}.wasm`));
    writeFileSync(tmp, JSON.stringify({ signature })); renameSync(tmp, join(dir, `${key}.json`));
  } catch { /* a cache that cannot be written is no cache */ }
}

// Runs a compiled transform. input: as for runWasm; write(bytes): called with
// each batch's output (without it, the output is returned). Returns { ok,
// lines, output } or { ok: false, error, lines, output }: the error says
// which line failed.
export function runTransform(t, { input, write = null, threads = null }) {
  const src = inputOf(input, { marks: true });
  const kept = [];
  // The harness prints once per batch, after mapping it: what was read since
  // the last print is the batch being mapped.
  const r = runWasm(t.bytes, { input: src, threads, write: (b) => { src.mark(); if (write) write(b); else kept.push(b.slice()); } });
  const output = write ? undefined : new TextDecoder().decode(Buffer.concat(kept));
  if (!r.error) return { ok: true, lines: r.lines, output };
  const error = r.item ? located(t, src.sinceMark(), r) : r.error;
  const why = /out of steps$/.test(error) ? ` (each line may take ${t.steps.toLocaleString('en')} steps)` : '';
  return { ok: false, error: error + why, lines: r.lines, output };
}

// The error of a run that failed in par_map, with the line that failed: the
// first in the failing chunk, which is found by transforming that chunk's
// lines again, one to a task (the transform is pure, so it fails the same way).
// read: what was read since the last print, which ends with the batch: every
// batch before it was full, so it is the last lines - before lines.
function located(t, read, r) {
  const all = [];
  for (let i = 0; i < read.length;) { let j = read.indexOf(10, i); j = j < 0 ? read.length : j + 1; all.push(read.subarray(i, j)); i = j; }
  const before = t.batch * Math.floor((r.lines - 1) / t.batch);
  const lines = all.slice(all.length - (r.lines - before));
  const lo = r.item.index * t.chunk;
  const chunk = lines.slice(lo, lo + t.chunk);
  const first = t.first + before + lo;
  if (chunk.length === 1) return `line ${first}: ${r.error}`;
  const span = `lines ${first} to ${first + chunk.length - 1}: ${r.error}`;
  const sizes = { first, batch: t.chunk, chunk: 1, steps: t.steps };
  const again = compileProgram(program(t.udf, sizes), sizes);
  if (!again.ok) return span;
  const r2 = runWasm(again.bytes, { input: Buffer.concat(chunk), threads: 1, write: () => {} });
  return r2.item ? `line ${first + r2.item.index}: ${r2.error}` : span;
}
