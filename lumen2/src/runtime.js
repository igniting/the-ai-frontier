// Running compiled Lumen 2 programs: the host functions a module imports
// (output, input, the clock, random numbers) and the runtime errors it can
// stop with. The runtime conventions (object layout, failure codes) are the
// compiler's, in compiler/46-codegen.lm.

import { makeHost } from './host.js';
import { makePool, threadCount, minPages } from './par.js';

export const FAILURES = ['', 'integer overflow', 'division by zero', 'index out of bounds', 'out of memory', 'string too long', 'use after free'];

export class LumenTrap extends Error {}

// Runs a compiled program. Strings are byte strings, as in the interpreter.
// Returns { output, error, live, allocs, lines, item }: live is the number of
// objects still allocated when main returned, which must be 0; allocs counts
// every allocation the program made; lines, how many lines read_line read.
// item: when the error happened in par_map on threads, { index, of }: the
// element that failed (the first one, as a sequential map would find) and
// how many elements there were.
// bytes: the module's bytes, or an already compiled WebAssembly.Module.
// input: a string (one byte per character), a Uint8Array, or { fd }: a file
// descriptor to read lines from as the program asks for them (then
// read_input is not available).
// write: called with the bytes of each write (a view into the program's
// memory, valid during the call) instead of collecting them in output.
// talk (for the compiler's host): talk(text) sees each write first, and may
// return the next line that read_line reads (or null to treat it as output).
// threads: for a module compiled in threads mode (a program that calls
// par_map), how many threads to use (default: LUMEN2_THREADS, or one per core).
export function runWasm(bytes, { input = '', host = makeHost(), talk = null, threads = null, write = null } = {}) {
  let out = '';
  const answers = [];
  let memory = null;
  let item = null;
  // A view of the memory, made again only when it has grown past it (the
  // buffer of a shared memory is a new object each time it is read).
  let view = new Uint8Array(0);
  const bytesAt = (ptr, len) => {
    if (ptr + len > view.length || view.length === 0) view = new Uint8Array(memory.buffer);
    return view.subarray(ptr, ptr + len);
  };
  const asString = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
  const src = inputOf(input);
  const env = {
    write: (ptr, len) => {
      if (write && !talk) { write(bytesAt(ptr, len)); return; }
      const s = asString(bytesAt(ptr, len));
      const a = talk ? talk(s) : null;
      if (a === null) out += s; else if (a !== undefined) answers.push(a);
    },
    input_len: () => src.all().length,
    input_read: (ptr) => { const b = src.all(); bytesAt(ptr, b.length).set(b); },
    // read_line: the length of the next line (with its newline), then its bytes.
    line_len: () => (answers.length ? answers[0].length : src.lineLen()),
    line_read: (ptr) => {
      if (answers.length) { const a = answers.shift(); const b = bytesAt(ptr, a.length); for (let i = 0; i < a.length; i++) b[i] = a.charCodeAt(i) & 0xff; return; }
      src.lineRead((n) => bytesAt(ptr, n));
    },
    fail: (code) => { throw new LumenTrap(FAILURES[code] ?? `internal error ${code}`); },
    panic: (ptr, len) => { throw new LumenTrap(`panic: ${asString(bytesAt(ptr, len))}`); },
    clock: () => host.clock(),
    random: (lo, hi) => host.random(lo, hi),
  };
  const module = bytes instanceof WebAssembly.Module ? bytes : new WebAssembly.Module(bytes);
  // Threads mode: the module imports a shared memory, and par_map asks the
  // host (env.par) to compute a task's elements on every thread.
  let pool = null, instance = null;
  if (WebAssembly.Module.imports(module).some((i) => i.kind === 'memory')) {
    if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') throw new Error('this program was compiled to run par_map on threads, which needs Node');
    memory = new WebAssembly.Memory({ initial: minPages(module), maximum: 16384, shared: true });
    env.memory = memory;
    env.par = (n) => {
      pool ??= makePool(module, memory, threads ?? threadCount());
      const first = pool.run(n, (i) => instance.exports.par_item(i));
      if (first === null) return;
      item = { index: first.index, of: n };
      if (first.error) throw first.error;
      if (first.kind === 1) throw new LumenTrap(FAILURES[first.a] ?? `internal error ${first.a}`);
      if (first.kind === 2) throw new LumenTrap(`panic: ${asString(bytesAt(first.a, first.b))}`);
      if (first.kind === 3) throw new RangeError('Maximum call stack size exceeded');
      throw new WebAssembly.RuntimeError('in a parallel task');
    };
  }
  instance = new WebAssembly.Instance(module, { env });
  memory = instance.exports.memory;
  const counts = () => {
    const w = pool ? pool.counts() : { live: 0, allocs: 0 };
    return { live: instance.exports.live.value + w.live, allocs: instance.exports.allocs.value + w.allocs };
  };
  try {
    instance.exports._start();
  } catch (e) {
    const { allocs } = counts();
    const stopped = { output: out, live: null, allocs, lines: src.lines(), item };
    if (e instanceof LumenTrap) return { ...stopped, error: e.message };
    if (e instanceof RangeError && /call stack/i.test(e.message)) return { ...stopped, error: 'stack overflow' };
    if (e instanceof WebAssembly.RuntimeError) return { ...stopped, error: `internal error: ${e.message}` };
    throw e;
  } finally {
    pool?.close();
  }
  return { output: out, error: null, ...counts(), lines: src.lines(), item: null };
}

// The program's input, as read_input and read_line see it. lineLen() is the
// length of the next line, with its newline (0 at the end); lineRead(at)
// copies it to at(length) and moves past it; lines() counts the lines read.
// With marks, the input also keeps what was read since the last mark():
// sinceMark() is a copy of it.
// input: a string (one byte per character), a Uint8Array, { fd }, or an
// input made by this function (returned as it is).
export function inputOf(input, { marks = false } = {}) {
  if (input && typeof input.lineLen === 'function') return input;
  if (typeof input === 'string') {
    const b = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) b[i] = input.charCodeAt(i) & 0xff;
    return bytesInput(b);
  }
  if (input instanceof Uint8Array) return bytesInput(input);
  if (input && typeof input.fd === 'number') return streamInput(input.fd, marks);
  throw new TypeError('runWasm: input must be a string, a Uint8Array or { fd }');
}

function bytesInput(b) {
  let cursor = 0, end = -1, lines = 0, keep = 0;
  const next = () => { if (end < 0) { const nl = b.indexOf(10, cursor); end = nl < 0 ? b.length : nl + 1; } return end; };
  return {
    all: () => b,
    lineLen: () => next() - cursor,
    lineRead: (at) => { const e = next(); if (e > cursor) lines++; at(e - cursor).set(b.subarray(cursor, e)); cursor = e; end = -1; },
    lines: () => lines,
    mark: () => { keep = cursor; },
    sinceMark: () => b.slice(keep, cursor),
  };
}

// A file read a buffer at a time: a line is kept only until it is read (or,
// with marks, until the next mark).
function streamInput(fd, marks) {
  const fs = process.getBuiltinModule('node:fs');
  let buf = new Uint8Array(1 << 20), start = 0, stop = 0, eof = false, end = -1, lines = 0, keep = 0;
  const more = () => {
    const from = marks ? keep : start;
    if (from > 0) { buf.copyWithin(0, from, stop); start -= from; stop -= from; keep -= from; }
    if (stop === buf.length) { const b = new Uint8Array(buf.length * 2); b.set(buf); buf = b; }
    const n = retrying(() => fs.readSync(fd, buf, stop, buf.length - stop, null));
    if (n === 0) eof = true; else stop += n;
  };
  const next = () => {
    if (end >= 0) return end;
    let seen = start; // no newline in buf[start, seen)
    for (;;) {
      const nl = buf.indexOf(10, seen);
      if (nl >= 0 && nl < stop) return (end = nl + 1);
      if (eof) return (end = stop);
      const ahead = stop - start;
      more();
      seen = start + ahead;
    }
  };
  return {
    all: () => { throw new Error('read_input is not available when the input is read a line at a time'); },
    lineLen: () => next() - start,
    lineRead: (at) => { const e = next(); if (e > start) lines++; at(e - start).set(buf.subarray(start, e)); start = e; end = -1; },
    lines: () => lines,
    mark: () => { keep = start; },
    sinceMark: () => buf.slice(keep, start),
  };
}

// Runs a read or write again while the file is not ready (a pipe that
// another process set to non-blocking).
export function retrying(op) {
  for (;;) {
    try { return op(); } catch (e) {
      if (e.code !== 'EAGAIN') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

