// Running compiled Lumen 2 programs: the host functions a module imports
// (output, input, the clock, random numbers) and the runtime errors it can
// stop with. The runtime conventions (object layout, failure codes) are the
// compiler's, in compiler/46-codegen.lm.

import { makeHost } from './host.js';

export const FAILURES = ['', 'integer overflow', 'division by zero', 'index out of bounds', 'out of memory', 'string too long', 'use after free'];

export class LumenTrap extends Error {}

// Runs a compiled program. Strings are byte strings, as in the interpreter.
// Returns { output, error, live, allocs }: live is the number of objects
// still allocated when main returned, which must be 0; allocs counts every
// allocation the program made.
// bytes: the module's bytes, or an already compiled WebAssembly.Module.
// talk (for the compiler's host): talk(text) sees each write first, and may
// return the next line that read_line reads (or null to treat it as output).
export function runWasm(bytes, { input = '', host = makeHost(), talk = null } = {}) {
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
  const instance = new WebAssembly.Instance(bytes instanceof WebAssembly.Module ? bytes : new WebAssembly.Module(bytes), { env });
  memory = instance.exports.memory;
  try {
    instance.exports._start();
  } catch (e) {
    const allocs = instance.exports.allocs.value;
    if (e instanceof LumenTrap) return { output: out, error: e.message, live: null, allocs };
    if (e instanceof RangeError && /call stack/i.test(e.message)) return { output: out, error: 'stack overflow', live: null, allocs };
    if (e instanceof WebAssembly.RuntimeError) return { output: out, error: `internal error: ${e.message}`, live: null, allocs };
    throw e;
  }
  return { output: out, error: null, live: instance.exports.live.value, allocs: instance.exports.allocs.value };
}
