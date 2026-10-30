// Compile/run engine for the playground. Runs inside a Web Worker (so a
// runaway program can be stopped), or on the main thread as a fallback.

import { compile, runWasm, runWasmAsync, interpretSource, checkSource, formatDiagnostic } from '../src/compiler.js';

const toBytes = (byteString) => Uint8Array.from(byteString, (c) => c.charCodeAt(0));

function diagnostics(source, list, severity) {
  return (list ?? []).map((d) => ({
    severity, message: d.message, span: d.span, formatted: formatDiagnostic(source, d, severity),
  }));
}

export async function handle(msg, post, { sync = true, fuel = 0 } = {}) {
  const { type, id, source, options = {} } = msg;
  if (type === 'check') {
    const r = checkSource(source);
    post({
      type: 'checked', id, ok: r.ok, signatures: r.signatures ?? [],
      diagnostics: [...diagnostics(source, r.errors, 'error'), ...diagnostics(source, r.warnings, 'warning')],
    });
    return;
  }
  if (type !== 'run') return;

  const c = compile(source, { gcStress: !!options.gcStress, optimize: !!options.optimize, fuel });
  if (!c.ok) {
    post({ type: 'compiled', id, ok: false, timings: c.timings, diagnostics: diagnostics(source, c.errors, 'error') });
    return;
  }
  post({
    type: 'compiled', id, ok: true, timings: c.timings, wasmSize: c.wasm.length, functionCount: c.functionCount,
    optimized: c.peephole && { rewrites: [...c.peephole.stats.values()].reduce((a, b) => a + b, 0), removed: c.peephole.before - c.peephole.after },
    signatures: c.signatures, diagnostics: diagnostics(source, c.warnings, 'warning'), wat: c.wat, ir: c.ir,
  });

  // Stream program output in small batches while it runs.
  const decoder = new TextDecoder();
  let pending = '';
  let last = performance.now();
  const flush = () => {
    if (pending) post({ type: 'output', id, text: decoder.decode(toBytes(pending), { stream: true }) });
    pending = '';
    last = performance.now();
  };
  const onOutput = (s) => {
    pending += s;
    if (pending.length > 16384 || performance.now() - last > 40) flush();
  };
  const r = sync ? runWasm(c.wasm, { onOutput }) : await runWasmAsync(c.wasm, { onOutput });
  flush();
  post({ type: 'ran', id, error: r.error, timeMs: r.timeMs, stats: r.stats });

  if (options.compare) {
    const i = interpretSource(source, { maxSteps: 50_000_000 });
    post({
      type: 'interpreted', id, timeMs: i.timeMs, error: i.error,
      match: i.output === r.output && i.error === r.error,
    });
  }
}
