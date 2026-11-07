// lumen2 transform --incremental: a transform run again over a file that has
// changed transforms only the lines that changed.
//
// The file is cut into chunks of whole lines, at points that depend only on
// the bytes nearby, so an edit moves only the cuts around it. A chunk whose
// SHA-256 hash the last run saw takes its output from the last run. Each run
// of chunks it did not see lies between two that it did (or an end of the
// file), and so does the part of the last input that it replaces; the lines
// the two have in common at their starts and at their ends, compared byte
// for byte, take their outputs from the last run too. Only the lines left
// are transformed, all in one run, on every core.
//
// That is sound because of what the checker proves about a transform. It can
// only compute and fail, so its output for a line depends on nothing but the
// line and the line's number: not on the clock, randomness, input, or
// anything kept from one line to the next. And the result is the same bits
// on every run and every machine: integers are checked for overflow, floats
// are always finite, and the step budget counts steps, not time. On top of
// that, lineThreshold proves from the transform's code a number T such that
// the output for a line numbered above T does not depend on the number. An
// output is reused for a line whose number is above T in both runs, or is
// the same in both. The hash is a cryptographic one because the file's lines
// may come from anyone: with a weak hash, a line written to collide with
// another would be given the other's output.
//
// If the run fails, it is done again from the start without the state, so a
// failure, and the output printed before it, are exactly those of a full
// run. The state is changed only by a run that succeeds.

import { readFileSync, readSync, openSync, writeSync, closeSync, renameSync, mkdirSync, realpathSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { hash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { parse } from './parser.js';
import { runWasm } from './api.js';
import { runTransform } from './transform.js';
import { threadCount } from './par.js';

// ------------------------------------------------------ the line numbers --

const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);

// T for a transform's source: every use of transform's first parameter (the
// line's number) is a comparison with an integer literal, and T is the
// largest of those literals (0 if there are none). Each such comparison has
// the same value for every number above its literal, so for lines above T
// the transform computes the same thing whatever their number. Any other use
// of the number, or another variable of the same name (which this does not
// try to tell apart), gives Infinity: every chunk is then reused only at the
// same line number.
export function lineThreshold(udf) {
  let ast;
  try { ast = parse(udf); } catch { return Infinity; }
  const fn = ast.fns.find((f) => f.name === 'transform');
  if (!fn || fn.params.length !== 2) return Infinity;
  const n = fn.params[0].name;
  let t = 0, other = false;
  const isN = (e) => e && e.k === 'var' && e.name === n;
  const walk = (node) => {
    if (other || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (node.k === 'binop' && COMPARE.has(node.op) && (isN(node.l) || isN(node.r))) {
      const lit = isN(node.l) ? node.r : node.l;
      if (lit.k === 'int') { t = Math.max(t, Number(lit.v)); return; }
    }
    if ((node.k === 'var' || node.k === 'pvar') && node.name === n) { other = true; return; }
    if (node.k === 'lambda' && node.params.some((p) => p.name === n)) { other = true; return; }
    for (const [key, v] of Object.entries(node)) if (key !== 'span') walk(v);
  };
  walk(fn.body);
  return other ? Infinity : t;
}

// ------------------------------------------------------------ the chunks --

// A chunk ends after a line that is a cut, once it has at least MIN_BYTES,
// and at the end of the line that takes it to MAX_BYTES; one line in eight
// is a cut. So a chunk of 50-byte lines has about 18 of them.
export const MIN_BYTES = 512;
export const MAX_BYTES = 65536;

// Whether the line b[s, e) is a cut: a hash of its length and of its first
// and last 32 bytes (all of it, if it is shorter than 64).
function cut(b, s, e) {
  let h = (0x811c9dc5 ^ (e - s)) | 0;
  const a = Math.min(e, s + 32), z = Math.max(a, e - 32);
  for (let i = s; i < a; i++) h = Math.imul(h ^ b[i], 0x01000193);
  for (let i = z; i < e; i++) h = Math.imul(h ^ b[i], 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h & 7) === 0;
}

// The chunks of b[lo, hi) (hi is the end of b or the start of a line):
// starts[i] to starts[i + 1] is chunk i, of counts[i] lines. Lines are split
// as the harness reads them: after each "\n", and a last line without one.
export function chunksOf(b, lo = 0, hi = b.length) {
  const starts = [lo], counts = [];
  let lines = 0, from = lo;
  for (let s = lo; s < hi;) {
    const nl = b.indexOf(10, s);
    const e = nl < 0 || nl >= hi ? hi : nl + 1;
    lines++;
    if (e === hi || (e - from >= MIN_BYTES && cut(b, s, e)) || e - from >= MAX_BYTES) {
      counts.push(lines); starts.push(e); lines = 0; from = e;
    }
    s = e;
  }
  return { starts, counts };
}

// How many bytes a and b have in common at their starts, and at their ends
// (at most limit).
function commonStart(a, b) {
  const n = Math.min(a.length, b.length), step = 1 << 16;
  let i = 0;
  while (i + step <= n && a.subarray(i, i + step).equals(b.subarray(i, i + step))) i += step;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonEnd(a, b, limit) {
  const step = 1 << 16;
  let i = 0;
  while (i + step <= limit && a.subarray(a.length - i - step, a.length - i).equals(b.subarray(b.length - i - step, b.length - i))) i += step;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// ------------------------------------------------------------- the state --

// Where the state of incremental runs of a transform over a file is kept (a
// directory): under the hash of the transform's program and the file's path.
export function statePath(t, path, cacheDir) {
  let real = path;
  try { real = realpathSync(path); } catch { /* the path as given */ }
  return join(cacheDir, 'runs', hash('sha256', `${t.key}\0${real}`, 'hex'));
}

// The state is a directory. Its file `index` is a line of JSON (the version,
// the program's key, the sizes of the parts, and the names of the files that
// hold the last run's input and output), then the last run's chunks' keys
// separated by line breaks, a table of its chunks (float64s: where each
// starts in the input, its first line's index, its number of lines, where
// its output starts) and the length of each line's output (uint32s, 0 for a
// line dropped). The input is the bytes the run read, written from memory
// (so they are exactly what it transformed), and only the parts compared
// are read back.
function loadState(dir, program) {
  let b, fd = -1;
  try { b = readFileSync(join(dir, 'index')); } catch { return null; }
  try {
    const nl = b.indexOf(10);
    const head = JSON.parse(b.toString('utf8', 0, nl));
    if (head.version !== 3 || head.program !== program) return null;
    const { chunks, lines } = head;
    let p = nl + 1;
    const take = (n) => { const r = b.subarray(p, p + n); if (r.length !== n) throw new Error('short'); p += n; return r; };
    const keyText = take(head.keys).toString('latin1');
    const keys = chunks ? keyText.split('\n') : [];
    const table = new Float64Array(copy(take(32 * chunks)));
    const lens = new Uint32Array(copy(take(4 * lines)));
    if (keys.length !== chunks || p !== b.length) return null;
    const output = readFileSync(join(dir, head.output));
    fd = openSync(join(dir, head.input), 'r');
    const inputLength = head.inputLength;
    // Each line's output's offset, and a check that the table agrees with
    // the lines, the input and the output.
    const off = new Float64Array(lines + 1);
    for (let l = 0; l < lines; l++) off[l + 1] = off[l] + lens[l];
    if (off[lines] !== output.length) { closeSync(fd); return null; }
    let line = 0;
    for (let c = 0; c < chunks; c++) {
      const s0 = table[4 * c], l0 = table[4 * c + 1], n = table[4 * c + 2], o0 = table[4 * c + 3];
      const s1 = c + 1 < chunks ? table[4 * c + 4] : inputLength;
      if (l0 !== line || !(n >= 1) || o0 !== off[l0] || !(s1 > s0) || (c === 0 && s0 !== 0)) { closeSync(fd); return null; }
      line += n;
    }
    if (line !== lines) { closeSync(fd); return null; }
    // The chunk with a key (the first, if two chunks had the same bytes).
    let index = null;
    const lookup = (key) => {
      if (!index) { index = new Map(); for (let c = chunks - 1; c >= 0; c--) index.set(keys[c], c); }
      return index.get(key);
    };
    // The last input. The state is trusted as the compiled transforms beside
    // it in the cache are: its input is not hashed again when it is read.
    const readAll = () => {
      const r = Buffer.alloc(inputLength);
      for (let got = 0; got < r.length;) { const n = readSync(fd, r, got, r.length - got, got); if (n === 0) throw new Error('the state\'s input is shorter than its index says'); got += n; }
      return r;
    };
    return { keys, lookup, table, lens, off, output, chunks, lines, inputLength, readAll, cost: head.cost ?? null, files: [head.input, head.output], close: () => closeSync(fd) };
  } catch { if (fd >= 0) closeSync(fd); return null; }
}

// A copy of u's bytes, aligned (Buffer's slice does not copy).
const copy = (u) => { const c = new Uint8Array(u.length); c.set(u); return c.buffer; };
const writeAll = (fd, b) => { for (let i = 0; i < b.length;) i += writeSync(fd, b, i, b.length - i); };
const removing = (f) => { try { unlinkSync(f); } catch { /* gone already */ } };

// Writes the new state: its input, output (runs) and index, then switches
// to it by renaming the index, and removes the old state's files (and any
// left by runs that stopped before they could, after ten minutes).
function saveState(dir, program, { keys, table, lens, input, runs, size, cost, old }) {
  const id = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const inputName = `input-${id}`, outputName = `output-${id}`, inputLength = input.length;
  const keyText = Buffer.from(keys.join('\n'), 'latin1');
  const head = Buffer.from(`${JSON.stringify({ version: 3, program, chunks: keys.length, lines: lens.length, keys: keyText.length, input: inputName, inputLength, output: outputName, cost })}\n`);
  let fd = -1;
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(join(dir, inputName), 'w');
    writeAll(fd, input);
    closeSync(fd);
    fd = openSync(join(dir, outputName), 'w');
    for (const r of runs) writeAll(fd, r);
    closeSync(fd);
    const tmp = join(dir, `index.${inputName}.tmp`);
    fd = openSync(tmp, 'w');
    for (const x of [head, keyText, new Uint8Array(table.buffer), new Uint8Array(lens.buffer, lens.byteOffset, lens.byteLength)]) writeAll(fd, x);
    closeSync(fd); fd = -1;
    renameSync(tmp, join(dir, 'index'));
    if (old) for (const f of old.files) removing(join(dir, f));
    const stale = Date.now() - 600000;
    for (const f of readdirSync(dir)) {
      if (f !== 'index' && f !== inputName && f !== outputName) { try { if (statSync(join(dir, f)).mtimeMs < stale) removing(join(dir, f)); } catch { /* gone */ } }
    }
    return true;
  } catch {
    if (fd >= 0) closeSync(fd);
    removing(join(dir, inputName));
    removing(join(dir, outputName));
    return false;
  }
}

// The lines of b[s, e), as [start, end) pairs, each with its line break.
function linesOf(b, s, e) {
  const r = [];
  while (s < e) { const nl = b.indexOf(10, s); const x = nl < 0 || nl >= e ? e : nl + 1; r.push(s, x); s = x; }
  return r;
}

// ------------------------------------------------------------------ a run --

// Runs t, compiled with { chunked: true }, over the file at path, using and
// then updating the state in the directory state. normal(): the same
// transform compiled without chunked, for a run that fails (it is run again
// in full). write: as for runTransform. Returns what runTransform returns,
// and how many lines were transformed and how many chunks were reused whole.
export function runIncremental(t, { path, state, normal, write = null, threads = null }) {
  const prof = process.env.LUMEN2_PROFILE ? [] : null;
  let last = performance.now();
  const mark = (what) => { if (prof) { const now = performance.now(); prof.push(`${what} ${(now - last).toFixed(0)}`); last = now; } };
  const input = readFileSync(path);
  mark('read');
  let old = loadState(state, t.key), oin = null;
  if (old) {
    try { oin = old.readAll(); } catch { old.close(); old = null; } // a state whose input is short is no state
  }
  mark('load');
  try {
    const r = run(t, { input, old, oin, normal, write, threads, mark });
    if (r.ok && r.changed) saveState(state, t.key, { ...r.changed, input, old });
    delete r.changed;
    mark('save');
    if (prof) console.error(`ms: ${prof.join(', ')}`);
    return r;
  } finally { if (old) old.close(); }
}

function run(t, { input, old, oin, normal, write, threads, mark }) {
  const T = lineThreshold(t.udf);
  // The new file starts with the last input's chunks 0 to pc - 1 (the bytes
  // the two have in common at their starts, in whole chunks ending at a line
  // break of the new file) and ends with its chunks sm on (in common at their
  // ends, after a line break also in common), delta bytes further on. Only
  // the part between is cut into chunks and hashed now.
  let pc = 0, sm = old ? old.chunks : 0;
  const oend = (c) => (c + 1 < old.chunks ? old.table[4 * c + 4] : old.inputLength);
  if (old) {
    const p = commonStart(input, oin);
    while (pc < old.chunks && oend(pc) <= p && (oend(pc) === input.length || input[oend(pc) - 1] === 10)) pc++;
    const b = pc ? oend(pc - 1) : 0;
    const q = commonEnd(input, oin, Math.min(input.length, oin.length) - b);
    sm = pc;
    while (sm < old.chunks && old.table[4 * sm] - 1 < old.inputLength - q) sm++;
  }
  mark('compare');
  const delta = old ? input.length - old.inputLength : 0;
  const lo = pc ? oend(pc - 1) : 0, hi = old && sm < old.chunks ? old.table[4 * sm] + delta : input.length;
  const mid = chunksOf(input, lo, hi);
  mark('chunk');
  const k = pc + mid.counts.length + (old ? old.chunks - sm : 0);
  const starts = new Float64Array(k + 1), counts = new Float64Array(k), keys = new Array(k), match = new Int32Array(k).fill(-1);
  const first = new Float64Array(k + 1); // first[i]: the index of chunk i's first line
  let i = 0;
  const key = (line, digest) => (line + 1 <= T ? `${line + 1}@${digest}` : digest);
  for (let c = 0; c < pc; c++, i++) { starts[i] = old.table[4 * c]; counts[i] = old.table[4 * c + 2]; keys[i] = old.keys[c]; match[i] = c; first[i + 1] = first[i] + counts[i]; }
  // A chunk of the middle is looked for among the old chunks the middle
  // replaces, when they are few, and else among all the old chunks.
  const find = (kk) => {
    if (sm - pc > 64) return old.lookup(kk);
    for (let c = pc; c < sm; c++) if (old.keys[c] === kk) return c;
    return undefined;
  };
  for (let c = 0; c < mid.counts.length; c++, i++) {
    starts[i] = mid.starts[c]; counts[i] = mid.counts[c];
    keys[i] = key(first[i], hash('sha256', input.subarray(mid.starts[c], mid.starts[c + 1]), 'base64'));
    if (old) { const o = find(keys[i]); if (o !== undefined) match[i] = o; }
    first[i + 1] = first[i] + counts[i];
  }
  for (let c = sm; old && c < old.chunks; c++, i++) {
    starts[i] = old.table[4 * c] + delta; counts[i] = old.table[4 * c + 2];
    const was = old.keys[c], at = was.indexOf('@');
    keys[i] = key(first[i], at < 0 ? was : was.slice(at + 1));
    if (keys[i] === was) match[i] = c; else { const o = find(keys[i]); if (o !== undefined) match[i] = o; }
    first[i + 1] = first[i] + counts[i];
  }
  starts[k] = input.length;
  const L = first[k];
  let reusedChunks = 0;
  for (let x = 0; x < k; x++) if (match[x] >= 0) reusedChunks++;
  mark('hash');

  // The plan: segments of the output, in order: kind[x] = 0 for the last
  // run's output of its lines a[x] to a[x] + b[x] - 1, 1 for the output of
  // piece a[x] (lines to transform now: pieces[j] = [first line's number,
  // start, end, count]).
  const kind = [], pa = [], pb = [], pieces = [];
  const sameNumber = (x, y) => (T === Infinity || x <= T || y <= T ? x === y : true);
  // Where new line l (an index) starts, in chunk c: a chunk's start, or found
  // by splitting the chunk into lines.
  const lineStart = (l, c) => {
    if (l === first[c]) return starts[c];
    if (l === first[c + 1]) return starts[c + 1];
    return linesOf(input, starts[c], starts[c + 1])[2 * (l - first[c])];
  };
  // New lines lo to hi - 1, from chunk c on, as pieces of whole chunks of at
  // least PIECE lines where they can be (a piece is a task).
  const PIECE = 256;
  const fresh = (lo, hi, c) => {
    while (lo < hi) {
      while (first[c + 1] <= lo) c++;
      let d = c, end = Math.min(hi, first[c + 1]);
      while (end === first[d + 1] && end < hi && end - lo < PIECE) { d++; end = Math.min(hi, first[d + 1]); }
      pieces.push([lo + 1, lineStart(lo, c), lineStart(end, d), end - lo]);
      kind.push(1); pa.push(pieces.length - 1); pb.push(0);
      lo = end; c = d;
    }
  };
  for (let i = 0; i < k;) {
    if (match[i] >= 0) { const o = match[i]; kind.push(0); pa.push(old.table[4 * o + 1]); pb.push(old.table[4 * o + 2]); i++; continue; }
    let j = i;
    while (j < k && match[j] < 0) j++;
    // chunks i to j - 1 are new; the old lines they replace:
    const lo = first[i], hi = first[j];
    let olo = 0, ohi = 0, oc = 0, od = 0;
    if (old) {
      const oL = i > 0 ? match[i - 1] : -1, oR = j < k ? match[j] : old.chunks;
      if (oL < oR) {
        oc = oL + 1; od = oR; // old chunks oc to od - 1
        olo = oc < old.chunks ? old.table[4 * oc + 1] : old.lines;
        ohi = od < old.chunks ? old.table[4 * od + 1] : old.lines;
      }
    }
    const ob = ohi > olo ? oin.subarray(old.table[4 * oc], od < old.chunks ? old.table[4 * od] : old.inputLength) : null;
    const ol = ob ? linesOf(ob, 0, ob.length) : null;
    if (ob && ol.length === 2 * (ohi - olo)) { // (else the state's input does not agree with its index: no line is reused)
      const nl = linesOf(input, starts[i], starts[j]);
      const n = hi - lo, m = ohi - olo;
      const nt = [], ot = [];
      for (let x = 0; x < n; x++) nt.push(input.toString('latin1', nl[2 * x], nl[2 * x + 1]));
      for (let y = 0; y < m; y++) ot.push(ob.toString('latin1', ol[2 * y], ol[2 * y + 1]));
      const same = (x, y) => nt[x] === ot[y] && sameNumber(lo + x + 1, olo + y + 1);
      // New line x takes old line y's output where the two are matched; the
      // lines between are transformed.
      let x = 0;
      for (const [x0, y0, len] of common(n, m, same)) {
        fresh(lo + x, lo + x0, i);
        kind.push(0); pa.push(olo + y0); pb.push(len);
        x = x0 + len;
      }
      fresh(lo + x, hi, i);
    } else fresh(lo, hi, i);
    i = j;
  }
  mark('plan');

  const again = () => ({ ...runTransform(normal(), { input, write, threads }), transformed: L, reusedChunks: 0, again: true });
  const done = []; // per piece: [lens, start, end] (its output is all[start, end))
  let linesDone = 0, all = null, cost = old ? old.cost : null;
  if (pieces.length) {
    const parts = [];
    for (const [no, s, e, n] of pieces) { parts.push(Buffer.from(`${no} ${n}\n`), input.subarray(s, e)); linesDone += n; }
    // Starting threads takes tens of milliseconds, so work that the last
    // runs' measured cost says is shorter than 100 ms runs on this one.
    const use = threads ?? (cost && linesDone * cost.us < 100000 ? 1 : null);
    const out = [];
    const began = performance.now();
    const r = runWasm(t.bytes, { input: Buffer.concat(parts), threads: use, write: (b) => out.push(Buffer.from(b)) });
    if (r.error) return again();
    // The cost of a line on one thread, as measured on the most lines yet.
    if (linesDone >= 1000 && !(cost && cost.lines >= linesDone)) cost = { us: ((performance.now() - began) * 1000 * (use ?? threadCount())) / linesDone, lines: linesDone };
    all = Buffer.concat(out);
    let at = 0;
    for (const [, , , n] of pieces) {
      const nl = all.indexOf(10, at);
      const lens = nl < 0 ? [] : all.toString('latin1', at, nl).split(' ').map(Number);
      let size = 0;
      for (const x of lens) size += x;
      if (lens.length !== n || !lens.every((x) => x >= 0) || nl + 1 + size > all.length) throw new Error('lumen2 transform --incremental: the chunked harness printed something unexpected');
      done.push([lens, nl + 1, nl + 1 + size]);
      at = nl + 1 + size;
    }
    if (at !== all.length) throw new Error('lumen2 transform --incremental: the chunked harness printed something unexpected');
  }
  mark('transform');

  // The output, as runs of bytes (neighbouring segments that are neighbours
  // in the same buffer make one), and each line's output's length.
  const lens = new Uint32Array(L), runs = [];
  let rb = null, rs = 0, re = 0, line = 0, size = 0;
  const put = (b, s, e) => {
    if (b === rb && s === re) re = e;
    else { if (rb) runs.push(rb.subarray(rs, re)); rb = b; rs = s; re = e; }
    size += e - s;
  };
  for (let x = 0; x < kind.length; x++) {
    if (kind[x] === 0) {
      const l = pa[x], n = pb[x];
      lens.set(old.lens.subarray(l, l + n), line);
      put(old.output, old.off[l], old.off[l + n]);
      line += n;
    } else {
      const [ls, s, e] = done[pa[x]];
      lens.set(ls, line);
      put(all, s, e);
      line += ls.length;
    }
  }
  if (rb) runs.push(rb.subarray(rs, re));
  mark('assemble');
  if (write) for (const r of runs) write(r);
  mark('write');
  let changed = null;
  if (!(old && pieces.length === 0 && k === old.chunks && match.every((o, i) => o === i))) {
    const table = new Float64Array(4 * k);
    let o = 0, l = 0;
    for (let i = 0; i < k; i++) {
      table[4 * i] = starts[i]; table[4 * i + 1] = first[i]; table[4 * i + 2] = counts[i]; table[4 * i + 3] = o;
      for (const end = first[i + 1]; l < end; l++) o += lens[l];
    }
    changed = { keys, table, lens, runs, size, cost };
  }
  return {
    ok: true, lines: L, output: write ? undefined : new TextDecoder().decode(Buffer.concat(runs)),
    chunks: k, reusedChunks, transformed: linesDone, changed,
  };
}

// The lines two sequences of n and m lines have in common, in order, as
// runs [x, y, length] (lines x to x + length - 1 of the first are lines y to
// y + length - 1 of the second): a longest common subsequence, by Myers'
// O((n + m) D) algorithm, where D is the number of lines that differ. Past
// 2000 differences it settles for the lines in common at the two ends.
export function common(n, m, same) {
  const max = Math.min(n + m, 2000), off = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let kk = -d; kk <= d; kk += 2) {
      let x = kk === -d || (kk !== d && v[off + kk - 1] < v[off + kk + 1]) ? v[off + kk + 1] : v[off + kk - 1] + 1;
      let y = x - kk;
      while (x < n && y < m && same(x, y)) { x++; y++; }
      v[off + kk] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) {
    let p = 0, q = 0;
    while (p < n && p < m && same(p, p)) p++;
    while (q < n - p && q < m - p && same(n - 1 - q, m - 1 - q)) q++;
    return [...(p ? [[0, 0, p]] : []), ...(q ? [[n - q, m - q, q]] : [])];
  }
  // Back from (n, m) through the trace: at each step, the diagonal run of
  // matched lines (a snake) after one insertion or deletion.
  const runs = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const w = trace[d], kk = x - y;
    const pk = kk === -d || (kk !== d && w[off + kk - 1] < w[off + kk + 1]) ? kk + 1 : kk - 1;
    const px = w[off + pk], py = px - pk;
    const sx = pk === kk + 1 ? px : px + 1; // where the snake starts
    if (x > sx) runs.push([sx, sx - kk, x - sx]);
    x = px; y = py;
  }
  if (x > 0) runs.push([0, 0, x]); // the snake at d = 0 (then x equals y)
  return runs.reverse();
}
