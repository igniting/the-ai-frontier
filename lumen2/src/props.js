// Property-based testing. A `property` is a function whose parameters have
// concrete types; it holds when it returns true for every input. The runner
// generates inputs from the parameter types, small ones first, and when a
// case fails (returns false or stops with a runtime error) it shrinks the
// inputs to a minimal counterexample, which it prints as Lumen source.
//
// Cases run in the reference interpreter. When every case passes, they are
// run again as one compiled program, which must agree; a counterexample is
// also replayed compiled. So properties double as tests of the compiler.

import { interpret, INT_MIN, INT_MAX } from './interp.js';
import { prune, substParams } from './types.js';
import { makeHost } from './host.js';

// A small seedable generator (mulberry32), returning floats in [0, 1).
function rng(seed) {
  let a = Number(BigInt.asUintN(32, BigInt(seed))) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EDGE_INTS = [0n, 1n, -1n, 2n, 10n, -10n, 255n, 256n, (1n << 31n) - 1n, -(1n << 31n), 1n << 32n, INT_MAX, INT_MIN, INT_MAX - 1n, INT_MIN + 1n];
const CHARS = 'ab xyz01-\n';

export function makeGenerator(program, seed) {
  const rand = rng(seed);
  const int = (n) => Math.floor(rand() * n);
  const pick = (xs) => xs[int(xs.length)];
  const adtOf = (name) => program.adts.get(name);
  const ctorValue = (c, f) => ({ t: 'ctor', key: c.key, idx: c.idx, name: c.name, f });
  const fieldsOf = (t, c) => {
    const d = adtOf(t.name);
    const sub = new Map(d.params.map((p, i) => [p, t.args[i]]));
    return c.fieldTypes.map((f) => substParams(f, sub));
  };
  const mentions = (t, name) => {
    t = prune(t);
    if (t.k === 'con') return t.name === name || t.args.some((a) => mentions(a, name));
    if (t.k === 'tuple') return t.elems.some((a) => mentions(a, name));
    return false;
  };
  const list = (t, xs) => {
    const [nil, cons] = adtOf('List').ctors;
    return xs.reduceRight((acc, x) => ctorValue(cons, [x, acc]), ctorValue(nil, []));
  };

  function gen(t, size) {
    t = prune(t);
    if (t.k === 'tuple') return { t: 'tup', v: t.elems.map((e) => gen(e, size)) };
    switch (t.name) {
      case 'Int': {
        const r = rand();
        if (r < 0.5) return BigInt(int(2 * size + 1) - size);
        if (r < 0.7) return BigInt(int(2001) - 1000);
        if (r < 0.85) return pick(EDGE_INTS);
        return BigInt.asIntN(64, (BigInt(int(2 ** 32)) << 32n) | BigInt(int(2 ** 32)));
      }
      case 'Bool': return rand() < 0.5;
      case 'Unit': return null;
      case 'String': {
        let s = '';
        const n = int(size + 1);
        for (let i = 0; i < n; i++) s += rand() < 0.9 ? pick(CHARS) : String.fromCharCode(int(256));
        return s;
      }
      case 'Array': return { t: 'arr', v: Array.from({ length: int(size + 1) }, () => gen(t.args[0], size)) };
      case 'List': return list(t, Array.from({ length: int(size + 1) }, () => gen(t.args[0], size)));
      default: {
        // A constructor: when the size runs out, prefer ones that do not recurse.
        const ctors = adtOf(t.name).ctors;
        const flat = ctors.filter((c) => !fieldsOf(t, c).some((f) => mentions(f, t.name)));
        const c = size <= 0 && flat.length ? pick(flat) : pick(ctors);
        const fs = fieldsOf(t, c);
        return ctorValue(c, fs.map((f) => gen(f, Math.floor((size - 1) / Math.max(1, fs.length)))));
      }
    }
  }

  // Smaller values of the same type, most promising first.
  function* shrink(t, v) {
    t = prune(t);
    if (t.k === 'tuple') {
      for (let i = 0; i < v.v.length; i++) for (const s of shrink(t.elems[i], v.v[i])) yield { t: 'tup', v: v.v.map((x, j) => (j === i ? s : x)) };
      return;
    }
    switch (t.name) {
      case 'Int': {
        if (v === 0n) return;
        const seen = new Set();
        for (const c of [0n, v / 2n, v - (v > 0n ? 1n : -1n), v < 0n && v > INT_MIN ? -v : null]) {
          if (c === null || c === v || seen.has(c)) continue;
          seen.add(c);
          yield c;
        }
        return;
      }
      case 'Bool': if (v) yield false; return;
      case 'Unit': return;
      case 'String': {
        if (!v.length) return;
        yield '';
        if (v.length > 1) { yield v.slice(0, v.length >> 1); yield v.slice(v.length >> 1); }
        for (let i = 0; i < v.length && i < 16; i++) yield v.slice(0, i) + v.slice(i + 1);
        for (let i = 0; i < v.length && i < 16; i++) if (v[i] !== 'a') yield `${v.slice(0, i)}a${v.slice(i + 1)}`;
        return;
      }
      case 'Array': for (const xs of shrinkSeq(t.args[0], v.v)) yield { t: 'arr', v: xs }; return;
      case 'List': {
        const xs = [];
        for (let c = v; c.name === 'Cons'; c = c.f[1]) xs.push(c.f[0]);
        for (const ys of shrinkSeq(t.args[0], xs)) yield list(t, ys);
        return;
      }
      default: {
        // Simpler constructors, then subterms of the same type, then smaller fields.
        for (const c of adtOf(t.name).ctors) if (c.idx < v.idx && !c.fieldTypes.length) yield ctorValue(c, []);
        const fs = fieldsOf(t, adtOf(t.name).ctors[v.idx]);
        for (let i = 0; i < fs.length; i++) if (sameType(fs[i], t)) yield v.f[i];
        for (let i = 0; i < fs.length; i++) for (const s of shrink(fs[i], v.f[i])) yield ctorValue(adtOf(t.name).ctors[v.idx], v.f.map((x, j) => (j === i ? s : x)));
      }
    }
  }
  function* shrinkSeq(et, xs) {
    if (!xs.length) return;
    yield [];
    if (xs.length > 1) { yield xs.slice(0, xs.length >> 1); yield xs.slice(xs.length >> 1); }
    for (let i = 0; i < xs.length && i < 16; i++) yield [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (let i = 0; i < xs.length && i < 16; i++) for (const s of shrink(et, xs[i])) yield xs.map((x, j) => (j === i ? s : x));
  }
  const sameType = (a, b) => {
    a = prune(a); b = prune(b);
    if (a.k !== b.k) return false;
    if (a.k === 'tuple') return a.elems.length === b.elems.length && a.elems.every((x, i) => sameType(x, b.elems[i]));
    return a.name === b.name && a.args.every((x, i) => sameType(x, b.args[i]));
  };

  return { gen, shrink };
}

// A value as Lumen source, so that a counterexample can be pasted into a program.
export function literal(v) {
  switch (typeof v) {
    case 'bigint': return v.toString();
    case 'boolean': return String(v);
    case 'string': {
      let s = '"';
      for (const ch of v) {
        const c = ch.charCodeAt(0);
        if (ch === '"' || ch === '\\') s += `\\${ch}`;
        else if (ch === '\n') s += '\\n';
        else if (c < 32 || c > 126) s += `\\x${c.toString(16).padStart(2, '0')}`;
        else s += ch;
      }
      return `${s}"`;
    }
    default: {
      if (v === null) return '()';
      if (v.t === 'tup') return `(${v.v.map(literal).join(', ')})`;
      if (v.t === 'arr') return `array_from_list([${v.v.map(literal).join(', ')}])`;
      if (v.key.startsWith('List.')) {
        const xs = [];
        for (let c = v; c.name === 'Cons'; c = c.f[1]) xs.push(c.f[0]);
        return `[${xs.map(literal).join(', ')}]`;
      }
      return v.f.length ? `${v.name}(${v.f.map(literal).join(', ')})` : v.name;
    }
  }
}

// Evaluates a refinement predicate (the small language refinements allow).
function holds(e, env) {
  switch (e.k) {
    case 'int': case 'bool': return e.v;
    case 'var': return env.get(e.ref.id);
    case 'unop': return e.op === '-' ? -holds(e.e, env) : !holds(e.e, env);
    case 'call': { const x = holds(e.args[0], env); return BigInt(x.t === 'arr' ? x.v.length : x.length); }
    case 'binop': {
      const l = holds(e.l, env);
      if (e.op === '&&') return l && holds(e.r, env);
      if (e.op === '||') return l || holds(e.r, env);
      const r = holds(e.r, env);
      switch (e.op) {
        case '+': return l + r; case '-': return l - r; case '*': return l * r;
        case '<': return l < r; case '<=': return l <= r; case '>': return l > r; case '>=': return l >= r;
        case '==': return l === r; default: return l !== r;
      }
    }
    default: throw new Error(`props: ${e.k}`);
  }
}
// Do generated arguments satisfy the parameters' refinements?
const admissible = (params, args) => {
  const env = new Map(params.map((p, i) => [p.id, args[i]]));
  return params.every((p, i) => !p.refine || holds(p.refine.pred, new Map(env).set(p.refine.vId, args[i])));
};

// Runs every property of a checked program. compile(source) turns a harness
// program into { output, error } from the compiled code (or null to skip).
// Returns [{ name, ok, cases, counterexample?, reason?, shrinks?, compiled? }].
export function testProperties(program, source, { runs = 100, seed = 1, maxSize = 30, maxSteps = 2_000_000, compile = null } = {}) {
  const results = [];
  for (const prop of program.properties) {
    const { gen, shrink } = makeGenerator(program, BigInt(seed) * 7919n + BigInt(results.length));
    const outcome = (args) => {
      const r = interpret(program, { entry: { key: prop.key, args }, maxSteps, host: makeHost({ seed }) });
      if (r.error) return { ok: false, reason: `stopped with ${r.error}` };
      return r.value ? { ok: true } : { ok: false, reason: 'returned false' };
    };
    const call = (args) => `${prop.name}(${args.map(literal).join(', ')})`;
    const cases = [];
    let failure = null;
    for (let i = 0; i < runs && !failure; i++) {
      const size = Math.floor((i * maxSize) / runs);
      // Inputs to a refined parameter are drawn until one satisfies the refinement.
      let args = null;
      for (let tries = 0; tries < 200 && !args; tries++) {
        const a = prop.params.map((p) => gen(p.ty, size));
        if (admissible(prop.params, a)) args = a;
      }
      if (!args) continue;
      cases.push(args);
      const o = outcome(args);
      if (!o.ok) failure = { args, reason: o.reason, at: i + 1 };
    }
    if (!failure) {
      const result = { name: prop.name, ok: true, cases: cases.length, discarded: runs - cases.length };
      if (compile) {
        const r = compile(harness(source, cases.map((args) => `println(if ${call(args)} { "1" } else { "0" });`)));
        result.compiled = r && !r.error && r.output === '1\n'.repeat(cases.length) ? 'agrees' : `disagrees (${r?.error ?? 'a case returned false'})`;
      }
      results.push(result);
      continue;
    }
    // Shrink: take the first smaller input that still fails, until none does.
    let { args, reason } = failure;
    let shrinks = 0;
    for (let improved = true; improved && shrinks < 1000;) {
      improved = false;
      for (let i = 0; i < args.length && !improved; i++) {
        for (const s of shrink(prop.params[i].ty, args[i])) {
          const next = args.map((x, j) => (j === i ? s : x));
          if (!admissible(prop.params, next)) continue;
          const o = outcome(next);
          if (!o.ok) { args = next; reason = o.reason; shrinks++; improved = true; break; }
        }
      }
    }
    const result = { name: prop.name, ok: false, cases: failure.at, reason, shrinks, counterexample: prop.params.map((p, i) => ({ name: p.name, value: literal(args[i]) })) };
    if (compile) {
      const r = compile(harness(source, [`println(if ${call(args)} { "1" } else { "0" });`]));
      const compiledReason = r?.error ? `stopped with ${r.error}` : r?.output === '0\n' ? 'returned false' : 'passed';
      result.compiled = compiledReason === reason ? 'agrees' : `disagrees (${compiledReason})`;
    }
    results.push(result);
  }
  return results;
}

export const HARNESS = '__lumen2_property_cases';
const harness = (source, lines) => `${source}\nfn ${HARNESS}() {\n  ${lines.join('\n  ')}\n  ()\n}\n`;
