// Parity tests for the port: runs the Lumen 2 compiler (built from
// compiler/*.lm by the reference compiler) and the reference compiler on the
// same programs, and compares what each stage produces.
//
//   node compiler/parity.mjs ast [FILES...]     (default corpus when none given)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compilerSource } from './build.js';
import { compileSource, utf8 } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { makeHost } from '../src/host.js';
import { parse } from '../src/parser.js';
import { checkOnce, check } from '../src/check.js';
import { PRELUDE } from '../src/prelude.js';
import { lowerProgram, tkey } from '../src/lower.js';
import { inlineSmall } from '../src/inline.js';
import { simplify } from '../src/simplify.js';
import { generate } from '../test/fuzz.js';

const here = (p) => new URL(p, import.meta.url);
const CACHE = process.env.LUMEN2C_CACHE ?? '/tmp/lumen2c-cache';

// The compiler as a wasm module, compiled by the reference compiler (cached).
export function compilerModule() {
  const src = compilerSource();
  const key = createHash('sha256').update(src).digest('hex').slice(0, 16);
  const file = `${CACHE}/${key}.wasm`;
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  const t = performance.now();
  const c = compileSource(src, { grants: null });
  if (!c.ok) {
    const e = c.errors[0];
    const line = src.slice(0, e.span?.s ?? 0).split('\n').length;
    throw new Error(`lumen2c does not compile: ${e.message} (line ${line} of the built source)${e.note ? `; ${e.note}` : ''}`);
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, c.bytes);
  console.error(`(built lumen2c: ${c.bytes.length} bytes in ${Math.round(performance.now() - t)} ms)`);
  return c.bytes;
}

// Runs the compiler in a mode; returns { out } or { err: { message, s, e, note } } or { crash }.
export function runCompiler(bytes, mode, src) {
  const r = runWasm(bytes, { input: `${mode}\n${utf8(src)}`, host: makeHost() });
  if (r.error) {
    const m = /^panic: LUMENERR(.*)$/s.exec(r.error);
    if (m) return { err: JSON.parse(m[1]) };
    return { crash: r.error, out: r.output };
  }
  return { out: r.output };
}

// Byte offsets for a JavaScript string's UTF-16 offsets.
export function byteOffsets(src) {
  const map = new Int32Array(src.length + 1);
  let b = 0;
  for (let i = 0; i < src.length; i++) {
    map[i] = b;
    const c = src.charCodeAt(i);
    if (c < 0x80) b += 1; else if (c < 0x800) b += 2; else if (c >= 0xd800 && c < 0xdc00) { b += 4; map[++i] = b; continue; } else b += 3;
  }
  map[src.length] = b;
  return map;
}

const jstr = (s) => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"'; else if (c === 92) out += '\\\\'; else if (c === 10) out += '\\n';
    else if (c < 32 || c >= 127) out += `\\u00${c.toString(16).padStart(2, '0')}`;
    else out += s[i];
  }
  return `${out}"`;
};

// The reference parser's tree, in compiler/90-dump.lm's format.
export function dumpAst(ast, off) {
  const sp = (x) => `@${off[x.s]}-${off[x.e]}`;
  const list = (xs, f) => `(${xs.map(f).join(' ')})`;
  const opt = (o, f) => (o === null || o === undefined ? '_' : f(o));
  const eff = (f) => `(eff ${list(f.labels, (l) => l)} ${opt(f.tail, (t) => t)} ${sp(f.span)})`;
  const te = (t) => {
    switch (t.k) {
      case 'trefine': return `(refine ${t.v} ${sp(t.vSpan)} ${te(t.base)} ${ex(t.pred)} ${sp(t.span)})`;
      case 'tfun': return `(tfun ${list(t.params, te)} ${te(t.ret)} ${opt(t.eff, eff)} ${sp(t.span)})`;
      case 'tcon': return `(tcon ${t.name} ${list(t.args, te)} ${sp(t.span)})`;
      case 'ttuple': return `(ttuple ${list(t.elems, te)} ${sp(t.span)})`;
      case 'tvar': return `(tvar ${t.name} ${sp(t.span)})`;
      default: throw new Error(t.k);
    }
  };
  const pat = (p) => {
    switch (p.k) {
      case 'pwild': return `(pwild ${sp(p.span)})`;
      case 'pvar': return `(pvar ${p.name} ${sp(p.span)})`;
      case 'pint': return `(pint ${p.v} ${sp(p.span)})`;
      case 'pstr': return `(pstr ${jstr(p.v)} ${sp(p.span)})`;
      case 'pbool': return `(pbool ${p.v} ${sp(p.span)})`;
      case 'punit': return `(punit ${sp(p.span)})`;
      case 'ptuple': return `(ptuple ${list(p.elems, pat)} ${sp(p.span)})`;
      case 'pctor': return `(pctor ${p.name}${p.list ? ' list ' : ' '}${list(p.args, pat)} ${sp(p.span)})`;
      default: throw new Error(p.k);
    }
  };
  const param = (p) => `(param ${p.name} ${opt(p.ann, te)} ${sp(p.span)})`;
  const ex = (e) => {
    switch (e.k) {
      case 'int': return `(int ${e.v} ${sp(e.span)})`;
      case 'str': return `(str ${jstr(e.v)} ${sp(e.span)})`;
      case 'bool': return `(bool ${e.v} ${sp(e.span)})`;
      case 'var': return `(var ${e.name} ${sp(e.span)})`;
      case 'ctor': return `(ctor ${e.name}${e.list ? ' list ' : ' '}${opt(e.args, (a) => list(a, ex))} ${sp(e.span)})`;
      case 'unit': return `(unit ${sp(e.span)})`;
      case 'tuple': return `(tuple ${list(e.elems, ex)} ${sp(e.span)})`;
      case 'call': return `(call ${ex(e.fn)} ${list(e.args, ex)} ${sp(e.span)})`;
      case 'binop': return `(binop ${e.op} ${ex(e.l)} ${ex(e.r)} ${sp(e.span)})`;
      case 'unop': return `(unop ${e.op} ${ex(e.e)} ${sp(e.span)})`;
      case 'lambda': return `(lambda ${list(e.params, param)} ${ex(e.body)} ${sp(e.span)})`;
      case 'if': return `(if ${ex(e.cond)} ${ex(e.then)} ${opt(e.else, ex)} ${sp(e.span)})`;
      case 'match': return `(match ${ex(e.scrut)} ${list(e.arms, arm)} ${sp(e.span)})`;
      case 'block': return `(block ${list(e.stmts, stmt)} ${opt(e.result, ex)} ${sp(e.span)})`;
      default: throw new Error(e.k);
    }
  };
  const arm = (a) => `(arm ${pat(a.pat)} ${opt(a.guard, ex)} ${ex(a.body)} ${sp(a.span)})`;
  const stmt = (s) => (s.k === 'let' ? `(let ${pat(s.pat)} ${opt(s.ann, te)} ${ex(s.value)} ${sp(s.span)})` : s.k === 'expr' ? `(expr ${ex(s.e)})` : `(fndecl ${fn(s.fn)})`);
  const fn = (f) => `(fn ${f.name}${f.property ? ' property ' : ' '}${list(f.params, param)} ${opt(f.ret, te)} ${opt(f.eff, eff)} ${ex(f.body)} ${sp(f.span)} ${sp(f.nameSpan)})`;
  const types = ast.types.map((t) => `(type ${t.name} ${list(t.params, (x) => x)} ${list(t.ctors, (c) => `(ctor ${c.name} ${list(c.fields, te)} ${sp(c.span)})`)} ${sp(t.span)} ${sp(t.nameSpan)})`);
  const traits = ast.traits.map((t) => `(trait ${t.name} ${list(t.methods, (m) => `(method ${m.name} ${list(m.params, param)} ${opt(m.ret, te)} ${opt(m.eff, eff)} ${sp(m.span)} ${sp(m.nameSpan)})`)} ${sp(t.span)} ${sp(t.nameSpan)})`);
  const impls = ast.impls.map((i) => `(impl ${i.trait} ${sp(i.traitSpan)} ${te(i.forType)} ${list(i.where, (w) => `(where ${w.param} ${list(w.traits, (c) => `${c.name}${sp(c.span)}`)} ${sp(w.span)})`)} ${list(i.methods, fn)} ${sp(i.span)})`);
  return [types.join('\n'), ast.fns.map(fn).join('\n'), traits.join('\n'), impls.join('\n'), ast.properties.map(fn).join('\n')].join('\n--\n');
}

const errText = (e) => `ERROR ${e.message} @${e.s}-${e.e}${e.note ? ` note: ${e.note}` : ''}`;

export function jsCheck1(src, grants = null, entry = 'main') {
  const off = byteOffsets(src);
  try {
    const p = checkOnce(src, { assumeSafe: true, grants, entry });
    const lines = p.signatures.map((s) => `sig ${s.name}: ${s.type}`);
    for (const w of p.warnings) lines.push(`warn ${w.message} @${off[w.span.s]}-${off[w.span.e]}`);
    return lines.join('\n');
  } catch (e) {
    if (!e.span) throw e;
    return errText({ message: e.message, s: off[e.span.s], e: off[e.span.e], note: e.note });
  }
}

// The whole check (both passes and the proofs), in compiler/99-main.lm's `check` format.
export function jsCheck(src, grants = null, entry = 'main', mutant = null) {
  const off = byteOffsets(src);
  const key = (k) => { const m = /^user:(\d+):(\d+)$/.exec(k); return m ? `user:${off[+m[1]]}:${off[+m[2]]}` : k; };
  try {
    const p = check(src, { grants, entry, mutant, includePrelude: true });
    const v = p.verification;
    const lines = p.signatures.map((s) => `sig ${s.name}: ${s.type}`);
    for (const w of p.warnings) lines.push(`warn ${w.message} @${off[w.span.s]}-${off[w.span.e]}`);
    for (const k of [...v.safe].map(key).sort(cmpBytes)) lines.push(`safe ${k}`);
    for (const x of [...v.unproved].map(([k, n]) => `${key(k)}: ${n}`).sort(cmpBytes)) lines.push(`unproved ${x}`);
    for (const o of v.obligations) if (o.scope === 'user') lines.push(`ob ${o.kind} ${o.site ? key(o.site) : ''} @${off[o.span.s]}-${off[o.span.e]} ${o.what} ${o.status} ${o.lemmas ?? 0} ${o.clauses ?? 0} ${o.counterexample ?? ''}`);
    return lines.join('\n');
  } catch (e) {
    if (!e.span) return `CRASH ${e.message}`;
    return errText({ message: e.message, s: off[e.span.s], e: off[e.span.e], note: e.note });
  }
}
const cmpBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The IR, in compiler/90-dump.lm's format.
const jbytes = jstr; // the compiler's strings hold one byte per character
export function dumpIR(ir) {
  const tk = (t) => (t ? tkey(t) : '-');
  const at = (a) => (a.k === 'var' ? `$${a.v}` : a.k === 'int' ? `#${a.n}` : a.k === 'bool' ? String(a.b) : a.k === 'unit' ? '()' : jbytes(a.s));
  const ats = (xs) => `[${xs.map(at).join(' ')}]`;
  const tys = (xs) => `[${xs.map(tk).join(' ')}]`;
  const path = (p) => `[${p.join(' ')}]`;
  const out = [];
  const rhs = (r) => {
    switch (r.k) {
      case 'atom': return `atom ${at(r.a)}`;
      case 'prim': return `prim ${r.op} ${ats(r.args)} ${tk(r.ty)}`;
      case 'cmp': return `cmp ${r.op} ${tk(r.ty)} ${ats(r.args)}`;
      case 'call': return `call ${r.fn} ${ats(r.args)}`;
      case 'callc': return `callc ${at(r.f)} ${ats(r.args)}`;
      case 'ctor': return `ctor ${tk(r.ty)} ${r.tag} ${ats(r.args)} ${r.reuse ?? '-'}`;
      case 'tuple': return `tuple ${tk(r.ty)} ${ats(r.args)} ${r.reuse ?? '-'}`;
      case 'closure': return `closure ${r.fn} ${tk(r.ty)} ${ats(r.captures)} ${tys(r.captureTys)}`;
      case 'staticfn': return `static ${r.fn} ${tk(r.ty)}`;
      case 'field': case 'peek': return `${r.k} ${at(r.x)} ${path(r.path)} ${tk(r.ty)} ${tk(r.objTy)}`;
      case 'testtag': return `testtag ${at(r.x)} ${path(r.path)} ${tk(r.objTy)} ${tk(r.ty)} ${r.tag}`;
      case 'testlit': return `testlit ${at(r.x)} ${path(r.path)} ${tk(r.objTy)} ${tk(r.ty)} ${at(r.lit)}`;
      case 'envfield': return `envfield ${r.i} ${tk(r.ty)}`;
      case 'builtin': return `builtin ${r.name} ${ats(r.args)} ${tk(r.ty)} ${tys(r.argTys)}`;
      case 'expr': return 'expr';
      default: throw new Error(`dumpIR: ${r.k}`);
    }
  };
  const ex = (e) => {
    for (;;) {
      switch (e.k) {
        case 'let': out.push(`let ${e.v} ${rhs(e.rhs)}`); if (e.rhs.k === 'expr') { ex(e.rhs.e); out.push('end'); } e = e.body; continue;
        case 'ret': out.push(`ret ${rhs(e.rhs)}`); if (e.rhs.k === 'expr') { ex(e.rhs.e); out.push('end'); } return;
        case 'if': out.push(`if ${at(e.c)}`); ex(e.t); out.push('else'); ex(e.e); out.push('end'); return;
        case 'unreachable': out.push('unreachable'); return;
        case 'dup': out.push(`dup ${e.v}`); e = e.body; continue;
        case 'drop': out.push(`drop ${e.v}`); e = e.body; continue;
        case 'dropreuse': out.push(`dropreuse ${e.r} ${e.v}`); e = e.body; continue;
        case 'freetoken': out.push(`free ${e.v} ${e.size ?? '-'}`); e = e.body; continue;
        case 'unpack': out.push(`unpack ${e.v} [${e.xs.map((x) => `${x.x}:${x.i}`).join(' ')}] ${e.r ?? '-'} ${tys(e.fields ?? [])}`); e = e.body; continue;
        default: throw new Error(`dumpIR: ${e.k}`);
      }
    }
  };
  for (const f of ir.fns) {
    out.push(`fn ${f.name} env=${f.env} ret=${tk(f.ret)}`);
    out.push(`params ${f.params.map((p) => `${p.v}:${tk(p.ty)}`).join(' ')}`);
    out.push(`vars ${[...f.vars].map(([v, t]) => `${v}:${tk(t)}`).join(' ')}`);
    out.push(`borrowed ${[...(f.borrowed ?? [])].join(' ')}`);
    out.push(`captures ${tys(f.captures ?? [])}`);
    if (f.modes) out.push(`modes ${f.modes.join(' ')}`);
    ex(f.body);
  }
  out.push(`main ${ir.main}`);
  for (const [k, v] of ir.ordImpls) out.push(`ord ${k} ${v}`);
  return out.join('\n');
}

// Lowering after one checking pass (lower.js), then (opt) inlining and simplification.
export function jsLower1(src, grants = null, entry = 'main', mutant = null, stage = 'lower1') {
  const off = byteOffsets(src);
  try {
    const p = checkOnce(src, { assumeSafe: true, grants, entry });
    if (!p.main) return 'NOMAIN';
    const ir = lowerProgram(p, { mutant });
    if (stage !== 'lower1') { inlineSmall(ir); for (const f of ir.fns) simplify(f); }
    return dumpIR(ir);
  } catch (e) {
    if (!e.span) return `CRASH ${e.message}`;
    return errText({ message: e.message, s: off[e.span.s], e: off[e.span.e], note: e.note });
  }
}

export function jsAst(src) {
  const off = byteOffsets(src);
  try { return dumpAst(parse(src), off); } catch (e) {
    if (!e.span) throw e;
    return errText({ message: e.message, s: off[e.span.s], e: off[e.span.e], note: e.note });
  }
}

// The default corpus: every Lumen 2 program in the repository, generated programs, and broken ones.
export function corpus({ fuzz = 200 } = {}) {
  const items = [];
  const add = (dir, name) => items.push({ name, src: readFileSync(here(`../${dir}/${name}`), 'utf8') });
  for (const f of readdirSync(here('../examples'))) if (f.endsWith('.lm')) add('examples', f);
  for (const f of readdirSync(here('../examples/showcase'))) if (f.endsWith('.lm')) add('examples/showcase', f);
  for (const f of readdirSync(here('../proofs'))) if (f.endsWith('.lm')) add('proofs', f);
  add('selfhost', 'lumen2c.lm');
  items.push({ name: 'prelude', src: PRELUDE });
  items.push({ name: 'lumen2c (port)', src: compilerSource() });
  for (let s = 1; s <= fuzz; s++) items.push({ name: `fuzz ${s}`, src: generate(s) });
  return items;
}

// Broken programs: real ones with characters deleted, inserted or cut off.
export function brokenCorpus(n = 600) {
  const base = corpus({ fuzz: 20 }).filter((x) => x.src.length < 60000);
  let seed = 99;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  const junk = ['(', ')', '{', '}', '[', ']', ',', ';', ':', '|', '->', '"', '/*', '1x', 'fn', 'let', '=', '<', '>', '..', '\\q', '@', '-', '!', '99999999999999999999'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const { name, src } = base[rnd(base.length)];
    const at = rnd(src.length);
    const kind = rnd(7);
    let text;
    if (kind === 0) text = src.slice(0, at) + src.slice(at + 1 + rnd(3));
    else if (kind === 1) text = src.slice(0, at) + junk[rnd(junk.length)] + src.slice(at);
    else if (kind === 2) text = src.slice(0, at);
    else {
      // Semantic mutations: well-formed programs with type and effect errors.
      const words = [...src.matchAll(/\b[a-z_][a-z0-9_]*\b/g)];
      const ints = [...src.matchAll(/\b\d+\b/g)];
      const ops = [...src.matchAll(/ (\+|-|\*|==|<|&&|\+\+) /g)];
      const fns = [...src.matchAll(/fn [a-z_0-9]+\([^)]*\)( -> [A-Za-z<>(), ]+)? \{/g)];
      const pick = (xs) => xs[rnd(xs.length)];
      if (kind === 3 && words.length > 1) { const a = pick(words), b = pick(words); text = src.slice(0, a.index) + b[0] + src.slice(a.index + a[0].length); }
      else if (kind === 4 && ints.length) { const a = pick(ints); text = src.slice(0, a.index) + pick(['"s"', 'true', '[]', '()', 'None']) + src.slice(a.index + a[0].length); }
      else if (kind === 5 && ops.length) { const a = pick(ops); text = src.slice(0, a.index) + ' ' + pick(['+', '++', '==', '&&', '/', '<']) + ' ' + src.slice(a.index + a[0].length); }
      else if (fns.length) { const a = pick(fns); const end = a.index + a[0].length - 1; text = src.slice(0, end) + pick(['! {} ', '! output ', '! fail ', '! {input | e} ']) + src.slice(end); }
      else text = src.slice(0, at);
    }
    out.push({ name: `broken ${i} (${name})`, src: text });
  }
  return out;
}

function main() {
  const [stage, ...args] = process.argv.slice(2);
  const bytes = compilerModule();
  const tests = args[0] === '--tests' ? JSON.parse(readFileSync(args[1], 'utf8')).map((t, i) => ({ name: `test program ${i}`, ...t })) : null;
  const files = tests ? [] : args;
  const items = tests ?? (files.length ? files.map((f) => ({ name: f, src: readFileSync(f, 'utf8') })) : [...corpus(), ...brokenCorpus()]);
  let same = 0, diff = 0;
  for (const { name, src, grants = null, entry = 'main' } of items) {
    let want, got;
    const t0 = performance.now();
    if (stage === 'ast') {
      want = jsAst(src);
      const r = runCompiler(bytes, 'ast', src);
      got = r.err ? errText(r.err) : r.crash ? `CRASH ${r.crash}` : r.out.replace(/\n$/, '');
    } else if (stage === 'check1') {
      want = jsCheck1(src, grants, entry);
      const r = runCompiler(bytes, `check1${grants ? ` grants=${grants.join(',')}` : ''}${entry !== 'main' ? ` entry=${entry}` : ''}`, src);
      got = r.err ? errText(r.err) : r.crash ? `CRASH ${r.crash}` : r.out.replace(/\n$/, '');
    } else if (stage === 'check') {
      want = jsCheck(src, grants, entry);
      const r = runCompiler(bytes, `check${grants ? ` grants=${grants.join(',')}` : ''}${entry !== 'main' ? ` entry=${entry}` : ''}`, src);
      got = r.err ? errText(r.err) : r.crash ? `CRASH ${r.crash}` : r.out.replace(/\n$/, '');
    } else if (stage === 'lower1' || stage === 'opt1') {
      want = jsLower1(src, grants, entry, process.env.MUTANT ?? null, stage);
      const r = runCompiler(bytes, `${stage}${grants ? ` grants=${grants.join(',')}` : ''}${entry !== 'main' ? ` entry=${entry}` : ''}${process.env.MUTANT ? ` mutant=${process.env.MUTANT}` : ''}`, src);
      got = r.err ? errText(r.err) : r.crash ? `CRASH ${r.crash}` : r.out.replace(/\n$/, '');
    } else throw new Error(`unknown stage ${stage}`);
    const ms = performance.now() - t0;
    if (ms > 5000 && process.env.PARITY_TIMES) console.log(`(${name}: ${Math.round(ms)} ms)`);
    if (want === got) same++;
    else {
      diff++;
      if (diff <= 3) {
        const a = want.split('\n'), b = got.split('\n');
        let i = 0;
        while (i < a.length && a[i] === b[i]) i++;
        console.log(`DIFFER: ${name} (line ${i + 1})\n  want: ${(a[i] ?? '').slice(0, 400)}\n  got:  ${(b[i] ?? '').slice(0, 400)}`);
      }
    }
  }
  console.log(`${stage}: ${same} same, ${diff} different`);
  process.exit(diff ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
