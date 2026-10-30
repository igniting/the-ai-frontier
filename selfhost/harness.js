// Helpers for running lumenc (the self-hosted compiler) and comparing each of
// its phases with the reference compiler.

import { compile, runWasm, formatDiagnostic } from '../src/compiler.js';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { PRELUDE } from '../src/prelude.js';
import { checkSource } from '../src/compiler.js';
import { lineCol } from '../src/diagnostics.js';
import { buildSource, locate } from './build.js';

export const toBytes = (text) => new TextEncoder().encode(text);
const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; };
export const preludeBytes = toBytes(PRELUDE);

let stage1 = null;
export function lumencSource() { return buildSource(); }

// Compiles lumenc with the reference compiler (once per process).
export function stage1Wasm() {
  if (!stage1) {
    const { source, ranges } = buildSource();
    const c = compile(source);
    if (!c.ok) {
      const e = c.errors[0];
      throw new Error(`lumenc does not compile at ${locate(ranges, lineCol(source, e.span?.s ?? 0).line)}:\n${formatDiagnostic(source, e)}`);
    }
    stage1 = c.wasm;
  }
  return stage1;
}

// Runs a lumenc binary in a mode over a program; returns { output (bytes as latin1 string), error }.
export function runLumenc(wasm, mode, programText, { prelude = preludeBytes } = {}) {
  const program = typeof programText === 'string' ? toBytes(programText) : programText;
  const header = toBytes(`${mode} ${prelude.length}\n`);
  const input = new Uint8Array(header.length + prelude.length + program.length);
  input.set(header, 0);
  input.set(prelude, header.length);
  input.set(program, header.length + prelude.length);
  const r = runWasm(wasm, { input });
  return { output: r.output, error: r.error, timeMs: r.timeMs, stats: r.stats };
}

export const outputBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// ----------------------------------------------- reference phase dumps --
export function refTokens(src) {
  // Offsets in the reference lexer are UTF-16 code units; convert to bytes.
  const byteOffset = (i) => toBytes(src.slice(0, i)).length;
  return lex(src).map((t) => `${t.t} ${byteOffset(t.s)} ${byteOffset(t.e)}`).join('\n') + '\n';
}

const opt = (x, f) => (x == null ? '_' : f(x));
function texp(t) {
  switch (t.k) {
    case 'tname': return t.args.length ? `${t.name}<${t.args.map(texp).join(',')}>` : t.name;
    case 'tvar': return `'${t.name}`;
    case 'tfun': return `fn(${t.params.map(texp).join(',')})->${texp(t.ret)}`;
    case 'ttuple': return `(${t.elems.map(texp).join(',')})`;
  }
}
function pat(p) {
  switch (p.k) {
    case 'pwild': return '_';
    case 'pvar': return p.name;
    case 'pint': return String(p.v);
    case 'pstr': return `"${p.v}"`;
    case 'pbool': return String(p.v);
    case 'punit': return '()';
    case 'ptuple': return `(tuple ${p.elems.map(pat).join(' ')})`;
    case 'pctor': return `(${p.name}${p.sugar ? '*' : ''}${p.args.map((x) => ' ' + pat(x)).join('')})`;
  }
}
const params = (ps) => ps.map((p) => `${p.name}:${opt(p.ann, texp)}`).join(' ');
let byteOf = (i) => i;
function expr(e) {
  switch (e.k) {
    case 'int': return String(e.v);
    case 'str': return `"${e.v}"`;
    case 'bool': return String(e.v);
    case 'unit': return '()';
    case 'var': return e.name;
    case 'ctor': return `(${e.name}${e.sugar ? '*' + (e.literal == null ? -1 : byteOf(e.literal)) : ''}${opt(e.args, (xs) => `[${xs.map(expr).join(' ')}]`)})`;
    case 'call': return `(call ${expr(e.fn)}${e.args.map((x) => ' ' + expr(x)).join('')})`;
    case 'lambda': return `(lambda [${params(e.params)}] ${opt(e.ret, texp)} ${expr(e.body)})`;
    case 'binop': return `(${e.op} ${expr(e.l)} ${expr(e.r)})`;
    case 'unop': return `(un${e.op} ${expr(e.e)})`;
    case 'if': return `(if ${expr(e.c)} ${expr(e.t)} ${opt(e.e, expr)})`;
    case 'match': return `(match ${expr(e.e)}${e.arms.map((a) => ` [${pat(a.pat)} ${opt(a.guard, expr)} ${expr(a.body)}]`).join('')})`;
    case 'block': return `(block${e.stmts.map((s) => ' ' + stmt(s)).join('')} => ${opt(e.result, expr)})`;
    case 'tuple': return `(tuple ${e.elems.map(expr).join(' ')})`;
  }
}
const fnd = (d) => `(fn ${d.name} [${params(d.params)}] ${opt(d.ret, texp)} ${expr(d.body)})`;
function stmt(s) {
  if (s.k === 'let') return `(let ${pat(s.pat)} ${opt(s.ann, texp)} ${expr(s.e)})`;
  if (s.k === 'expr') return expr(s.e);
  return fnd(s);
}
function decl(d) {
  if (d.k === 'type') return `(type ${d.name} [${d.params.join(' ')}]${d.ctors.map((c) => ` (${c.name}${c.fields.map((f) => ' ' + texp(f)).join('')})`).join('')})`;
  return fnd(d);
}
// The reference parser keeps strings as byte strings; print them as bytes too.
export function refAst(src) {
  byteOf = (i) => toBytes(src.slice(0, i)).length;
  return parse(src).decls.map(decl).join('\n') + '\n';
}
export function refTypes(src) {
  const r = checkSource(src);
  if (!r.ok) return `error: ${r.errors[0].message}\n`;
  return r.signatures.map((s) => `${s.name}: ${s.type}`).join('\n') + (r.signatures.length ? '\n' : '');
}
export function refIR(src) {
  const c = compile(src);
  if (!c.ok) return `error: ${c.errors[0].message}\n`;
  return c.ir + '\n';
}
export { latin1 };
