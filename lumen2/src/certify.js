// Certificate checkers for the compiler's passes. Each pass's output carries
// the evidence of its correctness, and an independent checker validates it on
// every compile; a rejected certificate stops the compile with an internal
// error instead of producing wrong code.
//
//   lowering    The IR is explicitly typed (every variable has a concrete
//               type), so checkTypes re-checks every instruction: arguments
//               against parameters, constructor fields against declarations,
//               projections against the shapes they read, and so on.
//   Perceus     The IR's dup/drop/drop-reuse instructions are a proof that
//               reference counts balance. checkOwnership replays the counts
//               along every path, following the IR's ownership rules written
//               out again here (not shared with perceus.js): no use after the
//               last reference is given away, no leak at a return, every
//               reuse token used or freed exactly once.
//   refinement  Each obligation's DRUP refutation is checked by rup.js (see
//               blast.js); here only the counts are reported.
//   wasm        The engine validates the module.

import { tkey } from './lower.js';
import { substParams, INT, BOOL, STRING, UNIT } from './types.js';

export class CertificateError extends Error {}

// ---------------------------------------------------------------- types --
export function checkTypes(ir, adts) {
  const fns = new Map(ir.fns.map((f) => [f.name, f]));
  const same = (a, b) => a && b && tkey(a) === tkey(b);
  const ARRAY = (t) => ({ k: 'con', name: 'Array', args: [t] });
  const LIST = (t) => ({ k: 'con', name: 'List', args: [t] });
  let instructions = 0;

  for (const f of ir.fns) {
    const bad = (msg) => { throw new CertificateError(`IR types in ${f.name}: ${msg}`); };
    const varTy = (v) => f.vars.get(v) ?? bad(`unknown variable ${v}`);
    const atomTy = (a) => (a.k === 'var' ? varTy(a.v) : a.k === 'int' ? INT : a.k === 'bool' ? BOOL : a.k === 'unit' ? UNIT : a.k === 'str' ? STRING : bad(`atom ${a.k}`));
    const expect = (a, t, what) => { if (!same(atomTy(a), t)) bad(`${what}: expected ${tkey(t)}, found ${tkey(atomTy(a))}`); };
    const variants = (t) => {
      const d = adts.get(t.name) ?? bad(`unknown type ${tkey(t)}`);
      const sub = new Map(d.params.map((p, i) => [p, t.args[i]]));
      return d.ctors.map((c) => c.fieldTypes.map((ft) => substParams(ft, sub)));
    };
    // The types a path of field indices can reach inside a value of type t.
    const walk = (t, path) => {
      let tys = [t];
      for (const i of path) {
        tys = tys.flatMap((u) => (u.k === 'tuple' ? (i < u.elems.length ? [u.elems[i]] : []) : u.k === 'con' && adts.has(u.name) ? variants(u).filter((fs) => i < fs.length).map((fs) => fs[i]) : []));
      }
      return tys;
    };
    const reaches = (r) => {
      expect(r.x, r.objTy, 'projected value');
      if (!walk(r.objTy, r.path).some((u) => same(u, r.ty))) bad(`no field at path ${r.path.join('.')} of ${tkey(r.objTy)} has type ${tkey(r.ty)}`);
    };
    const fnTy = (t, what) => (t.k === 'fun' ? t : bad(`${what} is not a function`));

    function rhsTy(r) {
      instructions++;
      switch (r.k) {
        case 'atom': return atomTy(r.a);
        case 'prim':
          if (['add', 'sub', 'mul', 'div', 'rem'].includes(r.op)) { r.args.forEach((a) => expect(a, INT, r.op)); return INT; }
          if (r.op === 'neg') { expect(r.args[0], INT, 'neg'); return INT; }
          if (r.op === 'not') { expect(r.args[0], BOOL, 'not'); return BOOL; }
          r.args.forEach((a) => expect(a, r.ty, r.op));
          return BOOL;
        case 'cmp': r.args.forEach((a) => expect(a, r.ty, 'comparison')); return r.op === 'three' ? INT : BOOL;
        case 'call': {
          const g = fns.get(r.fn) ?? bad(`call of unknown function ${r.fn}`);
          if (g.env) bad(`direct call of closure code ${r.fn}`);
          if (g.params.length !== r.args.length) bad(`${r.fn} takes ${g.params.length} arguments`);
          r.args.forEach((a, i) => expect(a, g.params[i].ty, `argument ${i + 1} of ${r.fn}`));
          return g.ret;
        }
        case 'callc': {
          const t = fnTy(atomTy(r.f), 'callee');
          if (t.params.length !== r.args.length) bad('closure call arity');
          r.args.forEach((a, i) => expect(a, t.params[i], `argument ${i + 1} of a closure`));
          return t.ret;
        }
        case 'ctor': {
          const vs = variants(r.ty);
          if (r.tag >= vs.length) bad(`constructor ${r.tag} of ${tkey(r.ty)}`);
          if (vs[r.tag].length !== r.args.length) bad(`constructor ${r.tag} of ${tkey(r.ty)} has ${vs[r.tag].length} fields`);
          r.args.forEach((a, i) => expect(a, vs[r.tag][i], `field ${i} of constructor ${r.tag}`));
          return r.ty;
        }
        case 'tuple':
          if (r.ty.k !== 'tuple' || r.ty.elems.length !== r.args.length) bad('tuple shape');
          r.args.forEach((a, i) => expect(a, r.ty.elems[i], `tuple element ${i}`));
          return r.ty;
        case 'closure': case 'staticfn': {
          const g = fns.get(r.fn) ?? bad(`closure of unknown function ${r.fn}`);
          const t = fnTy(r.ty, 'closure');
          if (!g.env || !same(g.params[0].ty, t)) bad(`${r.fn} is not code for ${tkey(t)}`);
          if (g.params.length - 1 !== t.params.length || g.params.slice(1).some((p, i) => !same(p.ty, t.params[i])) || !same(g.ret, t.ret)) bad(`${r.fn} does not have type ${tkey(t)}`);
          if (r.k === 'closure') {
            if ((g.captures ?? []).length !== r.captures.length) bad(`${r.fn} captures ${(g.captures ?? []).length} values`);
            r.captures.forEach((a, i) => expect(a, g.captures[i], `capture ${i} of ${r.fn}`));
          } else if ((g.captures ?? []).length) bad(`${r.fn} needs captures`);
          return t;
        }
        case 'field': case 'peek': reaches(r); return r.ty;
        case 'testtag': reaches(r); if (r.tag >= variants(r.ty).length) bad('tag test of a missing constructor'); return BOOL;
        case 'testlit': reaches(r); expect(r.lit, r.ty, 'literal pattern'); return BOOL;
        case 'envfield': {
          const caps = f.captures ?? bad('envfield outside closure code');
          if (r.i >= caps.length || !same(caps[r.i], r.ty)) bad(`capture ${r.i}`);
          return r.ty;
        }
        case 'builtin': return builtinTy(r);
        default: return bad(`instruction ${r.k}`);
      }
    }

    function builtinTy(r) {
      r.args.forEach((a, i) => expect(a, r.argTys[i], `argument ${i + 1} of ${r.name}`));
      const [a0, a1] = r.argTys;
      const elem = () => (a0?.k === 'con' && a0.name === 'Array' ? a0.args[0] : bad(`${r.name} of a non-array`));
      const SIGS = {
        print: () => [[STRING], UNIT], println: () => [[STRING], UNIT], read_input: () => [[], STRING], read_line: () => [[], STRING], clock_ms: () => [[], INT], random_int: () => [[INT, INT], INT],
        int_to_string: () => [[INT], STRING], string_length: () => [[STRING], INT], substring: () => [[STRING, INT, INT], STRING],
        char_code_at: () => [[STRING, INT], INT], char_from_code: () => [[INT], STRING], concat: () => [[STRING, STRING], STRING],
        concat_strings: () => [[LIST(STRING)], STRING],
        panic: () => [[STRING], r.ty],
        array_make: () => [[INT, a1], ARRAY(a1)], array_empty: () => [[], r.ty], array_length: () => [[a0], INT],
        array_get: () => [[a0, INT], elem()], array_set: () => [[a0, INT, elem()], a0], array_push: () => [[a0, elem()], a0],
      };
      const want = SIGS[r.name]?.() ?? bad(`unknown builtin ${r.name}`);
      const [params, ret] = want;
      if (params.length !== r.argTys.length || params.some((p, i) => !same(p, r.argTys[i]))) bad(`${r.name} applied to ${r.argTys.map(tkey).join(', ')}`);
      if (r.name === 'array_empty' && !(r.ty.k === 'con' && r.ty.name === 'Array')) bad('array_empty of a non-array');
      if (!same(ret, r.ty)) bad(`${r.name} returns ${tkey(ret)}, not ${tkey(r.ty)}`);
      return r.ty;
    }

    function expr(e, resultTy) {
      switch (e.k) {
        case 'let': {
          const t = e.rhs.k === 'expr' ? (expr(e.rhs.e, varTy(e.v)), varTy(e.v)) : rhsTy(e.rhs);
          if (!same(t, varTy(e.v))) bad(`${e.v} has type ${tkey(varTy(e.v))} but is bound to a ${tkey(t)}`);
          return expr(e.body, resultTy);
        }
        case 'ret': {
          const t = e.rhs.k === 'expr' ? (expr(e.rhs.e, resultTy), resultTy) : rhsTy(e.rhs);
          if (!same(t, resultTy)) bad(`returns a ${tkey(t)} where a ${tkey(resultTy)} is expected`);
          return undefined;
        }
        case 'if': expect(e.c, BOOL, 'condition'); expr(e.t, resultTy); return expr(e.e, resultTy);
        case 'unreachable': return undefined;
        case 'dup': case 'drop': case 'dropreuse': case 'freetoken': varTy(e.v); return expr(e.body, resultTy);
        case 'unpack':
          for (const x of e.xs) if (!same(varTy(x.x), e.fields[x.i])) bad(`unpack: ${x.x} is not field ${x.i} of ${e.v}`);
          return expr(e.body, resultTy);
        default: return bad(`expression ${e.k}`);
      }
    }
    f.params.forEach((p) => { if (!same(p.ty, varTy(p.v))) bad(`parameter ${p.v}`); });
    expr(f.body, f.ret);
  }
  return { functions: ir.fns.length, instructions };
}

// ------------------------------------------------------------ ownership --
// Which operands an instruction takes ownership of; the rest it only reads.
const CONSUMING_BUILTIN_ARGS = { array_make: [1], array_set: [0, 2], array_push: [0, 1] };
// A call takes the arguments at its callee's owned parameters, and only reads
// the ones at borrowed parameters.
function operands(r, modeOf) {
  const vars = (as) => as.filter((a) => a.k === 'var').map((a) => a.v);
  switch (r.k) {
    case 'atom': return { takes: vars([r.a]), reads: [] };
    case 'call': {
      const takes = [], reads = [];
      r.args.forEach((a, i) => { if (a.k === 'var') (modeOf(r.fn, i) === 'owned' ? takes : reads).push(a.v); });
      return { takes, reads };
    }
    case 'ctor': case 'tuple': return { takes: vars(r.args), reads: [] };
    case 'callc': return { takes: vars([r.f, ...r.args]), reads: [] };
    case 'closure': return { takes: vars(r.captures), reads: [] };
    case 'prim': case 'cmp': return { takes: [], reads: vars(r.args) };
    case 'field': case 'peek': case 'testtag': case 'testlit': return { takes: [], reads: vars([r.x]) };
    case 'envfield': return { takes: [], reads: ['env'] };
    case 'staticfn': return { takes: [], reads: [] };
    case 'builtin': {
      const taken = CONSUMING_BUILTIN_ARGS[r.name] ?? [];
      const takes = [], reads = [];
      r.args.forEach((a, i) => { if (a.k === 'var') (taken.includes(i) ? takes : reads).push(a.v); });
      return { takes, reads };
    }
    default: throw new CertificateError(`ownership: unknown instruction ${r.k}`);
  }
}

export function checkOwnership(ir, isHeap) {
  const stats = { functions: 0, dups: 0, drops: 0, reuses: 0, borrowed: 0 };
  const byName = new Map(ir.fns.map((f) => [f.name, f]));
  const modeOf = (name, i) => byName.get(name)?.modes?.[i] ?? 'owned';
  for (const f of ir.fns) {
    stats.functions++;
    const bad = (msg) => { throw new CertificateError(`ownership in ${f.name}: ${msg}`); };
    const heap = (v) => isHeap(f.vars.get(v));
    const source = new Map(); // a borrowed projection -> the variable it reads

    // State: owned reference counts, borrowed projections, reuse tokens.
    const copy = (s) => ({ owned: new Map(s.owned), borrowed: new Set(s.borrowed), tokens: new Set(s.tokens) });
    // A borrowed parameter stays alive for the whole call; a projection, while what it reads is alive.
    const live = (s, v) => (s.owned.get(v) ?? 0) > 0 || (s.borrowed.has(v) && (!source.has(v) || live(s, source.get(v))));
    const take = (s, v) => {
      const n = s.owned.get(v) ?? 0;
      if (n === 0) bad(`${v} is given away, but no reference to it is held${s.borrowed.has(v) ? ' (it is only borrowed)' : ''}`);
      s.owned.set(v, n - 1);
    };
    const key = (s) => [...[...s.owned].filter(([, n]) => n > 0).map(([v, n]) => `${v}:${n}`).sort(), '|', ...[...s.tokens].sort()].join(',');

    function step(s, r) {
      const { takes, reads } = operands(r, modeOf);
      for (const v of reads) if (heap(v) && !live(s, v)) bad(`${v} is read after its last reference was released`);
      for (const v of takes) if (heap(v)) take(s, v);
      // A value that is both read and given away must stay alive through the instruction.
      for (const v of reads) if (heap(v) && takes.includes(v) && !live(s, v)) bad(`${v} is given away while it is still being read`);
      if (r.reuse) { if (!s.tokens.has(r.reuse)) bad(`reuse token ${r.reuse} is not available`); s.tokens.delete(r.reuse); stats.reuses++; }
    }

    // Returns the state at the end of each path that reaches a `ret` (for a nested expression).
    function expr(e, s, top, ends) {
      switch (e.k) {
        case 'let': {
          if (e.rhs.k === 'expr') {
            const inner = [];
            expr(e.rhs.e, s, false, inner);
            if (!inner.length) return; // every path is unreachable
            if (new Set(inner.map(key)).size > 1) bad(`the branches of the expression bound to ${e.v} end holding different references`);
            s = inner[0];
          } else step(s, e.rhs);
          if (heap(e.v)) {
            if (e.rhs.k === 'peek') { s.borrowed.add(e.v); source.set(e.v, e.rhs.x.v); } else s.owned.set(e.v, 1);
          }
          return expr(e.body, s, top, ends);
        }
        case 'ret':
          if (e.rhs.k === 'expr') return expr(e.rhs.e, s, top, ends);
          step(s, e.rhs);
          if (top) {
            const left = [...s.owned].filter(([, n]) => n > 0).map(([v]) => v);
            if (left.length) bad(`returns while still holding ${left.join(', ')} (a leak)`);
            if (s.tokens.size) bad(`returns with an unused reuse token ${[...s.tokens][0]} (a leak)`);
          } else ends.push(s);
          return undefined;
        case 'if': expr(e.t, copy(s), top, ends); return expr(e.e, copy(s), top, ends);
        case 'unreachable': return undefined;
        case 'dup':
          if (!live(s, e.v)) bad(`${e.v} is duplicated after its last reference was released`);
          s.owned.set(e.v, (s.owned.get(e.v) ?? 0) + 1);
          stats.dups++;
          return expr(e.body, s, top, ends);
        case 'drop': take(s, e.v); stats.drops++; return expr(e.body, s, top, ends);
        case 'dropreuse': take(s, e.v); s.tokens.add(e.r); stats.drops++; return expr(e.body, s, top, ends);
        case 'freetoken':
          if (!s.tokens.has(e.v)) bad(`frees reuse token ${e.v}, which is not held`);
          s.tokens.delete(e.v);
          return expr(e.body, s, top, ends);
        case 'unpack':
          // v is given up; each extracted projection of it becomes an owned reference.
          for (const x of e.xs) {
            if (!s.borrowed.has(x.x) || source.get(x.x) !== e.v) bad(`unpack of ${e.v} takes ${x.x}, which is not a projection of it`);
          }
          if (new Set(e.xs.map((x) => x.i)).size !== e.xs.length) bad(`unpack of ${e.v} takes a field twice`);
          take(s, e.v);
          for (const x of e.xs) { s.borrowed.delete(x.x); s.owned.set(x.x, (s.owned.get(x.x) ?? 0) + 1); }
          if (e.r) { s.tokens.add(e.r); stats.reuses; }
          stats.drops++;
          return expr(e.body, s, top, ends);
        default: return bad(`expression ${e.k}`);
      }
    }
    const mode = (i) => f.modes?.[i] ?? 'owned';
    if (f.env && f.params.some((p, i) => mode(i) !== 'owned')) bad('closure code cannot borrow its parameters');
    const start = {
      owned: new Map(f.params.filter((p, i) => heap(p.v) && mode(i) === 'owned').map((p) => [p.v, 1])),
      borrowed: new Set(f.params.filter((p, i) => mode(i) === 'borrowed').map((p) => p.v)),
      tokens: new Set(),
    };
    stats.borrowed += start.borrowed.size;
    expr(f.body, start, true, []);
  }
  return stats;
}
