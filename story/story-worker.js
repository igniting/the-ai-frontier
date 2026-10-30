// The story page's live demos that need the compiler or the prover. Runs in a
// Web Worker so a long-running program never freezes the page.

import { compile, runWasm, formatDiagnostic, decodeBytes } from '../src/compiler.js';
import { prove } from '../superopt/synth.js';
import { concrete } from '../superopt/bv.js';

const text = (byteString) => decodeBytes(byteString);

function compileAndRun(source, options) {
  const c = compile(source, options);
  if (!c.ok) return { ok: false, error: formatDiagnostic(source, c.errors[0]) };
  const r = runWasm(c.wasm);
  return {
    ok: true, output: r.output, error: r.error, bytes: c.wasm.length, timings: c.timings, timeMs: r.timeMs,
    instructions: r.stats.instructions, signatures: c.signatures, peephole: c.peephole,
  };
}

self.onmessage = async ({ data: m }) => {
  const reply = (x) => self.postMessage({ id: m.id, ...x });
  try {
    if (m.type === 'run') {
      const r = compileAndRun(m.source, { optimize: !!m.optimize, countInstructions: true });
      if (!r.ok) return reply(r);
      reply({
        ok: true, output: text(r.output), error: r.error, bytes: r.bytes, timeMs: r.timeMs,
        compileMs: Object.values(r.timings).reduce((a, b) => a + b, 0), instructions: r.instructions,
        signatures: r.signatures.map((s) => `${s.name} : ${s.type}`),
      });
    } else if (m.type === 'compare') {
      // The same program built both ways; executed instructions are counted exactly.
      const source = await (await fetch(new URL(`../examples/${m.name}.lm`, import.meta.url))).text();
      const base = compileAndRun(source, { countInstructions: true });
      const opt = compileAndRun(source, { optimize: true, countInstructions: true });
      reply({
        ok: base.ok && opt.ok, same: base.output === opt.output && base.error === opt.error,
        outputBytes: base.output?.length ?? 0,
        base: { instructions: base.instructions, bytes: base.bytes },
        opt: { instructions: opt.instructions, bytes: opt.bytes, rewrites: [...(opt.peephole?.stats.values() ?? [])].reduce((a, b) => a + b, 0) },
      });
    } else if (m.type === 'prove') {
      // Is `lhs` equal to `rhs` for every 32-bit input on the stack?
      const t = performance.now();
      const p = prove({ odd: [], inputs: m.inputs }, m.lhs, m.rhs);
      const ms = performance.now() - t;
      if (p.proved) return reply({ proved: true, lemmas: p.lemmas ?? 0, trivial: !!p.trivial, ms });
      if (!p.cex) return reply({ proved: false, unknown: true, ms });
      const stack = p.cex.stack;
      reply({ proved: false, ms, input: stack, lhs: concrete(m.lhs, {}, stack)[0], rhs: concrete(m.rhs, {}, stack)[0] });
    }
  } catch (e) {
    reply({ ok: false, error: e.message });
  }
};
