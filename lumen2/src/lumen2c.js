// The Lumen 2 compiler. It is written in Lumen 2 (compiler/*.lm) and runs
// here as WebAssembly: compiler/lumen2c.wasm is the compiler compiled by
// itself (compiler/bootstrap.js rebuilds it and checks the fixed point).
//
// This module only moves text in and out. The compiler reads a mode line and
// the program, and prints a report as one line of JSON (then, when it
// compiles, the module's bytes). Spans in the report are byte offsets in the
// program's UTF-8 text; here they become offsets in the JavaScript string.

import { runWasm } from './runtime.js';
import { makeHost } from './host.js';
import { utf8, decodeBytes } from './lexer.js';
import { LumenError } from './diagnostics.js';

// A certificate checker (the IR type checker, the ownership checker) rejected
// a pass's output: a bug in the compiler, caught before it produced code.
export class CertificateError extends Error {}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const WASM = new URL('../compiler/lumen2c.wasm', import.meta.url);
// The compiler's bytes, read when first needed: from the file in Node, and
// with a synchronous request in a browser worker (where the compiler runs, so
// that the API stays synchronous and a page never waits on it).
let seed = null;
function seedBytes() {
  if (!seed) {
    if (isNode) seed = process.getBuiltinModule('node:fs').readFileSync(process.env.LUMEN2C_WASM ?? WASM);
    else {
      const x = new XMLHttpRequest();
      x.open('GET', WASM, false);
      x.responseType = 'arraybuffer';
      x.send();
      if (x.status !== 200) throw new Error(`could not load the compiler (${WASM}): ${x.status}`);
      seed = new Uint8Array(x.response);
    }
  }
  return seed;
}

// The character offset of every byte offset of a string's UTF-8 encoding.
export function charOffsets(source) {
  const bytes = utf8(source).length;
  const map = new Int32Array(bytes + 1);
  let b = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.codePointAt(i);
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    for (let k = 0; k < n; k++) map[b + k] = i;
    b += n;
    if (c >= 0x10000) i++;
  }
  map[bytes] = source.length;
  return map;
}

const text = (s) => decodeBytes(s);

// A compiler built from the given module bytes (by default, compiler/lumen2c.wasm).
export function makeCompiler(bytes = seedBytes()) {
  const module = new WebAssembly.Module(bytes);
  // Proof results this compiler found, by query, shared between its runs: the
  // compiler asks before proving and tells after (compiler/34-blast.lm).
  // Proofs are deterministic, so sharing them only saves time.
  // Every message comes before the report, so the first other write ends them
  // (the module's bytes can start with byte 1 too).
  const proofs = new Map();
  const talker = () => {
    let open = true;
    return (s) => {
      if (!open || s.charCodeAt(0) !== 1) { open = false; return null; }
      return answer(s);
    };
  };
  const answer = (s) => {
    const body = s.slice(2, -1);
    if (s[1] === '?') return `${proofs.get(body) ?? '-'}\n`;
    const tab = body.indexOf('\t');
    if (proofs.size >= 20000) proofs.clear();
    proofs.set(body.slice(0, tab), body.slice(tab + 1));
    return undefined;
  };

  // Runs the compiler: the report and, after it, the output's remaining bytes.
  function run(words, given, source) {
    const lines = [[...words, 'cache'].filter(Boolean).join(' '), ...given];
    const r = runWasm(module, { input: `${lines.join('\n')}\n${utf8(source)}`, host: makeHost(), talk: talker() });
    if (r.error) {
      const off = charOffsets(source);
      let m = /^panic: LUMENERR(.*)$/s.exec(r.error);
      if (m) {
        const e = JSON.parse(m[1]);
        return { error: new LumenError(text(e.message), { s: off[e.s], e: off[e.e] }, e.note === null ? null : text(e.note)) };
      }
      m = /^panic: LUMENCERT(.*)$/s.exec(r.error);
      if (m) throw new CertificateError(text(m[1]));
      // A panic in the compiler is an internal error (`internal error: ...`); anything else is reported as it is.
      throw new Error(r.error.startsWith('panic: ') ? text(r.error.slice(7)) : `internal error: the compiler stopped: ${r.error}`);
    }
    const nl = r.output.indexOf('\n');
    return { report: JSON.parse(r.output.slice(0, nl)), rest: r.output.slice(nl + 1) };
  }

  const options = ({ grants = null, entry = 'main', mutant = null }) => [
    grants ? `grants=${grants.join(',')}` : '', entry !== 'main' ? `entry=${entry}` : '', mutant ? `mutant=${mutant}` : '',
  ];

  // The checker's findings, with spans as character offsets. Site keys stay as
  // the compiler wrote them (`raw`), for handing back to it, and are also given
  // in character offsets, for the reference interpreter's front end.
  function findings(report, source) {
    const off = charOffsets(source);
    const span = (x) => ({ s: off[x.s], e: off[x.e] });
    const key = (k) => { const m = /^user:(\d+):(\d+)$/.exec(k); return m ? `user:${off[+m[1]]}:${off[+m[2]]}` : k; };
    return {
      signatures: report.signatures.map((s) => ({ name: s.name, type: text(s.type), span: span(s) })),
      warnings: report.warnings.map((w) => new LumenError(text(w.message), span(w))),
      hasMain: report.main,
      verification: {
        raw: { safe: report.safe, unproved: report.unproved },
        safe: new Set(report.safe.map(key)),
        unproved: new Map(report.unproved.map(([k, n]) => [key(k), text(n)])),
        obligations: report.obligations.map((o) => {
          const x = {
            kind: o.kind, scope: o.scope, site: o.site ? key(o.site) : null, span: o.scope === 'user' ? span(o) : { s: o.s, e: o.e },
            what: text(o.what), status: o.status,
          };
          if (o.status === 'proved') { x.lemmas = o.lemmas; x.clauses = o.clauses; }
          if (o.status === 'refuted') x.counterexample = text(o.counterexample);
          if (o.cnf) { x.cnf = { nvars: o.nvars, clauses: o.cnf }; x.proof = o.proof; }
          return x;
        }),
      },
    };
  }

  return {
    // Checks a program: { ok: true, signatures, warnings, hasMain, verification } or { ok: false, errors }.
    check(source, { keepProofs = false, ...opts } = {}) {
      const r = run(['report', ...options(opts), keepProofs ? 'keep' : ''], [], source);
      if (r.error) return { ok: false, errors: [r.error] };
      return { ok: true, ...findings(r.report, source) };
    },
    // Checks and compiles a program. `given`: the verification of an earlier
    // check of the same program with the same options, used instead of proving again.
    compile(source, { given = null, keepProofs = false, inline = true, borrow = true, reuse = true, specialize = true, superopt = true, paranoid = false, ir = false, funcs = false, ...opts } = {}) {
      const lines = given ? [...given.safe.map((k) => `S ${k}`), ...given.unproved.map(([k, n]) => `U ${k} ${n}`)] : [];
      const words = [
        'compile', ...options(opts), given ? `given=${lines.length}` : '', keepProofs ? 'keep' : '',
        inline ? '' : 'noinline', borrow ? '' : 'noborrow', reuse ? '' : 'noreuse', specialize ? '' : 'nospec',
        superopt ? '' : 'nosuperopt', paranoid ? 'paranoid' : '', ir ? 'ir' : '', funcs ? 'funcs' : '',
      ];
      const r = run(words, lines, source);
      if (r.error) return { ok: false, errors: [r.error] };
      const out = { ok: true, ...findings(r.report, source) };
      if (!r.report.main) return out;
      const rep = r.report;
      out.bytes = Uint8Array.from(r.rest.slice(0, rep.bytes), (c) => c.charCodeAt(0));
      // The last certificate: the engine validates the module.
      if (!WebAssembly.validate(out.bytes)) throw new CertificateError('wasm: the engine rejected the module');
      out.certificates = { types: rep.types, ownership: rep.ownership };
      out.rewrites = new Map(rep.rewrites);
      out.ir = { fns: rep.fns.map((f) => (ir ? { name: f.name, text: f.text } : { name: f.name })) };
      if (funcs) {
        const pairs = (xs) => xs.map(([name, type]) => ({ name, type }));
        out.funcs = rep.funcs.map((f) => ({ name: f.name, params: pairs(f.params), results: f.results, locals: pairs(f.locals), body: f.body }));
      }
      return out;
    },
  };
}

// The compiler built from compiler/lumen2c.wasm, made when first used.
let main = null;
export const lumen2c = {
  check: (...args) => (main ??= makeCompiler()).check(...args),
  compile: (...args) => (main ??= makeCompiler()).compile(...args),
};
