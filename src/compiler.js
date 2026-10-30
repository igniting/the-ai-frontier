// Public API: compile Lumen source to WebAssembly, run it, or interpret it.

import { parse } from './parser.js';
import { typecheck } from './typecheck.js';
import { PRELUDE } from './prelude.js';
import { lower, reachableFunctions } from './lower.js';
import { codegen } from './codegen.js';
import { interpret } from './interp.js';
import { printIR } from './irprint.js';
import { LumenError, LumenRuntimeError, formatDiagnostic } from './diagnostics.js';
import { ERR_MESSAGES } from './runtime.js';
import { decodeBytes } from './lexer.js';

export { formatDiagnostic, decodeBytes };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function check(source, timings) {
  let t = now();
  const preludeAst = parse(PRELUDE);
  const userAst = parse(source);
  timings.parse = now() - t;
  t = now();
  const checked = typecheck(preludeAst, userAst);
  timings.typecheck = now() - t;
  return checked;
}

// Type-check only.
export function checkSource(source) {
  const timings = {};
  try {
    const checked = check(source, timings);
    return { ok: true, checked, signatures: checked.signatures, warnings: checked.warnings, timings };
  } catch (e) {
    if (e instanceof LumenError) return { ok: false, errors: [e], warnings: [], timings };
    throw e;
  }
}

export function compile(source, options = {}) {
  const timings = {};
  try {
    const checked = check(source, timings);
    let t = now();
    const ir = lower(checked);
    timings.lower = now() - t;
    t = now();
    const { mod, layout, functionCount, peephole } = codegen(ir, options);
    timings.codegen = now() - t;
    t = now();
    const wasm = mod.encode();
    timings.encode = now() - t;
    return {
      ok: true, wasm, layout, functionCount, timings, peephole,
      signatures: checked.signatures, warnings: checked.warnings,
      get wat() { return mod.toWat(); },
      get ir() { return printIR(reachableFunctions(ir)); },
    };
  } catch (e) {
    if (e instanceof LumenError) return { ok: false, errors: [e], warnings: [], timings };
    throw e;
  }
}

function bytesToString(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}

function makeImports(state) {
  const readString = (ptr) => {
    const view = new DataView(state.memory.buffer);
    const len = view.getUint32(ptr, true) >>> 9;
    return bytesToString(new Uint8Array(state.memory.buffer, ptr + 4, len));
  };
  return {
    env: {
      print(ptr, newline) {
        const s = readString(ptr) + (newline ? '\n' : '');
        state.output += s;
        state.onOutput?.(s);
      },
      input_len: () => state.input.length,
      input_copy(ptr) {
        new Uint8Array(state.memory.buffer, ptr, state.input.length).set(state.input);
      },
      error(code, ptr) {
        if (code === 3) throw new LumenRuntimeError(`panic: ${decodeBytes(readString(ptr))}`);
        throw new LumenRuntimeError(ERR_MESSAGES[code] ?? `runtime error ${code}`);
      },
    },
  };
}

function finish(state, instance, run) {
  state.memory = instance.exports.memory;
  const t = now();
  let error = null;
  try {
    run();
  } catch (e) {
    if (e instanceof LumenRuntimeError) error = e.message;
    else if (e instanceof RangeError) error = 'stack overflow';
    else if (e instanceof WebAssembly.RuntimeError) error = `internal error: wasm trap (${e.message})`;
    else throw e;
  }
  const ex = instance.exports;
  return {
    output: state.output,
    error,
    timeMs: now() - t,
    stats: {
      gcCount: ex.gc_count.value,
      allocatedBytes: Number(ex.alloc_bytes.value),
      heapBytes: ex.from_end.value - ex.from_start.value,
      liveBytes: ex.hp.value - ex.from_start.value,
      memoryBytes: ex.memory.buffer.byteLength,
    },
  };
}

// Program input for read_input(): a Uint8Array, or a string of bytes.
const inputBytes = (input = '') => (typeof input === 'string' ? Uint8Array.from(input, (ch) => ch.charCodeAt(0) & 255) : input);

// Synchronous run (Node, Web Workers).
export function runWasm(wasm, { onOutput, input } = {}) {
  const state = { output: '', memory: null, onOutput, input: inputBytes(input) };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), makeImports(state));
  return finish(state, instance, () => instance.exports.run());
}

// Asynchronous run (browser main thread, where sync compilation of large modules is disallowed).
export async function runWasmAsync(wasm, { onOutput, input } = {}) {
  const state = { output: '', memory: null, onOutput, input: inputBytes(input) };
  const { instance } = await WebAssembly.instantiate(wasm, makeImports(state));
  return finish(state, instance, () => instance.exports.run());
}

// Run with the reference interpreter instead of compiling.
export function interpretSource(source, options = {}) {
  const timings = {};
  try {
    const checked = check(source, timings);
    const t = now();
    const r = interpret(checked, options);
    return { ok: true, ...r, timeMs: now() - t };
  } catch (e) {
    if (e instanceof LumenError) return { ok: false, errors: [e] };
    throw e;
  }
}

export function compileAndRun(source, options = {}) {
  const c = compile(source, options);
  if (!c.ok) return c;
  return { ...c, ...runWasm(c.wasm, options) };
}
