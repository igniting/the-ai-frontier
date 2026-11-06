// Running compiled Lumen 2 programs: the host functions a module imports
// (output, input, the clock, random numbers) and the runtime errors it can
// stop with. The runtime conventions (object layout, failure codes) are the
// compiler's, in compiler/46-codegen.lm.

import { makeHost } from './host.js';
import { makePool, threadCount, minPages } from './par.js';

export const FAILURES = ['', 'integer overflow', 'division by zero', 'index out of bounds', 'out of memory', 'string too long', 'use after free'];

export class LumenTrap extends Error {}

// Runs a compiled program. Strings are byte strings, as in the interpreter.
// Returns { output, error, live, allocs }: live is the number of objects
// still allocated when main returned, which must be 0; allocs counts every
// allocation the program made.
// bytes: the module's bytes, or an already compiled WebAssembly.Module.
// talk (for the compiler's host): talk(text) sees each write first, and may
// return the next line that read_line reads (or null to treat it as output).
// threads: for a module compiled in threads mode (a program that calls
// par_map), how many threads to use (default: LUMEN2_THREADS, or one per core).
export function runWasm(bytes, { input = '', host = makeHost(), talk = null, threads = null } = {}) {
  let out = '';
  const answers = [];
  let memory = null;
  const bytesAt = (ptr, len) => new Uint8Array(memory.buffer, ptr, len);
  const asString = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
  let cursor = 0; // where read_line reads next
  const lineEnd = () => { const nl = input.indexOf('\n', cursor); return nl < 0 ? input.length : nl + 1; };
  const env = {
    write: (ptr, len) => {
      const s = asString(bytesAt(ptr, len));
      const a = talk ? talk(s) : null;
      if (a === null) out += s; else if (a !== undefined) answers.push(a);
    },
    input_len: () => input.length,
    input_read: (ptr) => { const b = bytesAt(ptr, input.length); for (let i = 0; i < input.length; i++) b[i] = input.charCodeAt(i) & 0xff; },
    // read_line: the length of the next line (with its newline), then its bytes.
    line_len: () => (answers.length ? answers[0].length : lineEnd() - cursor),
    line_read: (ptr) => {
      if (answers.length) { const a = answers.shift(); const b = bytesAt(ptr, a.length); for (let i = 0; i < a.length; i++) b[i] = a.charCodeAt(i) & 0xff; return; }
      const end = lineEnd(); const b = bytesAt(ptr, end - cursor); for (let i = cursor; i < end; i++) b[i - cursor] = input.charCodeAt(i) & 0xff; cursor = end;
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
    if (e instanceof LumenTrap) return { output: out, error: e.message, live: null, allocs };
    if (e instanceof RangeError && /call stack/i.test(e.message)) return { output: out, error: 'stack overflow', live: null, allocs };
    if (e instanceof WebAssembly.RuntimeError) return { output: out, error: `internal error: ${e.message}`, live: null, allocs };
    throw e;
  } finally {
    pool?.close();
  }
  return { output: out, error: null, ...counts() };
}

