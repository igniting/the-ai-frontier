// Hindley–Milner type inference with let-polymorphism, algebraic data types
// and optional annotations. Every expression and pattern node is annotated
// with `.ty`; variable nodes get `.ref` (their binding) and constructor nodes
// get `.ctor` — later phases (exhaustiveness, interpreter, lowering) rely on it.
//
// Top-level functions may appear in any order and be mutually recursive: we
// build the call graph, split it into strongly connected components (Tarjan)
// and infer each component in dependency order, generalizing after each one.
// That is what lets `map` be used polymorphically by a function defined above it.

import { LumenError } from './diagnostics.js';
import {
  GENERIC, newVar, tcon, tfun, ttuple, prune, unify, generalize, instantiate,
  UnifyError, TypePrinter, INT, BOOL, STRING, UNIT, pinLevels,
} from './types.js';
import { checkMatch, checkIrrefutable } from './exhaustive.js';

export const BUILTIN_SIGNATURES = (() => {
  const a = newVar(GENERIC);
  return {
    print: tfun([STRING], UNIT),
    println: tfun([STRING], UNIT),
    int_to_string: tfun([INT], STRING),
    string_length: tfun([STRING], INT),
    substring: tfun([STRING, INT, INT], STRING),
    char_code_at: tfun([STRING, INT], INT),
    char_from_code: tfun([INT], STRING),
    panic: tfun([STRING], a),
    read_input: tfun([], STRING),
    array_make: tfun([INT, a], tcon('Array', [a])),
    array_get: tfun([tcon('Array', [a]), INT], a),
    array_set: tfun([tcon('Array', [a]), INT, a], UNIT),
    array_length: tfun([tcon('Array', [a])], INT),
  };
})();

// Built-in types and their type parameters.
const BUILTIN_TYPES = { Int: [], Bool: [], String: [], Unit: [], Array: ['a'] };

// A syntactic value: evaluating it cannot create an array (no calls, no blocks).
function isValue(e) {
  switch (e.k) {
    case 'int': case 'str': case 'bool': case 'unit': case 'var': case 'lambda': return true;
    case 'ctor': return (e.args ?? []).every(isValue);
    case 'tuple': return e.elems.every(isValue);
    case 'binop': return isValue(e.l) && isValue(e.r);
    case 'unop': return isValue(e.e);
    default: return false;
  }
}
const MAX_CTORS = 240; // constructor tags must fit in the 8-bit heap header field

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function suggest(name, candidates) {
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestDist && d <= Math.max(1, Math.floor(name.length / 3))) { best = c; bestDist = d; }
  }
  return best ? [`did you mean \`${best}\`?`] : [];
}

class Scope {
  constructor(parent, kind = 'local') {
    this.parent = parent;
    this.kind = kind;
    this.values = new Map();
    if (kind !== 'local') {
      this.types = new Map();
      this.ctors = new Map();
    }
  }
  find(table, name) {
    for (let s = this; s; s = s.parent) {
      const v = s[table]?.get(name);
      if (v) return v;
    }
    return null;
  }
  names(table) {
    const out = new Set();
    for (let s = this; s; s = s.parent) for (const k of s[table]?.keys() ?? []) out.add(k);
    return out;
  }
}

export function typecheck(preludeAst, userAst) {
  let level = 0;
  let bindingIds = 0;
  const typeInfos = new Map(); // internal type name -> info
  const matches = [];
  const lets = [];
  const warnings = [];

  const fail = (msg, span, notes) => { throw new LumenError(msg, span, { phase: 'type', notes }); };

  // -------------------------------------------------------------- scopes --
  const builtinScope = new Scope(null, 'builtin');
  for (const [name, params] of Object.entries(BUILTIN_TYPES)) builtinScope.types.set(name, { name, params, builtin: true });
  for (const [name, type] of Object.entries(BUILTIN_SIGNATURES)) {
    builtinScope.values.set(name, { id: bindingIds++, name, kind: 'builtin', type });
  }
  const preludeScope = new Scope(builtinScope, 'global');
  const userScope = new Scope(preludeScope, 'global');

  // ------------------------------------------------------- type mismatches --
  function mismatch(err, expected, actual, span, prefix = '') {
    const p = new TypePrinter();
    if (err.kind === 'occurs') {
      fail(`${prefix}cannot construct the infinite type ${p.show(err.a)} = ${p.show(err.b)}`, span, ['a value is being used in a way that requires its type to contain itself']);
    }
    const exp = p.show(expected);
    const act = p.show(actual);
    const notes = [];
    const inner = [p.show(err.a), p.show(err.b)];
    if (!(inner.includes(exp) && inner.includes(act)) && err.kind === 'mismatch') {
      notes.push(`${inner[0]} is not compatible with ${inner[1]}`);
    }
    if (err.kind === 'arity') notes.push('the function types take a different number of arguments');
    fail(`${prefix}expected ${exp}, found ${act}`, span, notes);
  }

  function expect(actual, expected, span, prefix) {
    try {
      unify(actual, expected);
    } catch (err) {
      if (!(err instanceof UnifyError)) throw err;
      mismatch(err, expected, actual, span, prefix);
    }
  }

  // ----------------------------------------------------- type expressions --
  function convertType(te, scope, tvars, allowFresh) {
    switch (te.k) {
      case 'tvar': {
        if (!tvars.has(te.name)) {
          if (!allowFresh) fail(`unknown type variable \`${te.name}\``, te.span, ['type parameters must be declared, e.g. `type Box<a> { Box(a) }`']);
          tvars.set(te.name, newVar(level));
        }
        return tvars.get(te.name);
      }
      case 'tname': {
        const info = scope.find('types', te.name);
        if (!info) fail(`unknown type \`${te.name}\``, te.span, suggest(te.name, scope.names('types')));
        if (info.params.length !== te.args.length) {
          const n = info.params.length;
          fail(`type \`${te.name}\` expects ${n} type argument${n === 1 ? '' : 's'}, found ${te.args.length}`, te.span);
        }
        return tcon(info.name, te.args.map((a) => convertType(a, scope, tvars, allowFresh)));
      }
      case 'tfun':
        return tfun(te.params.map((p) => convertType(p, scope, tvars, allowFresh)), convertType(te.ret, scope, tvars, allowFresh));
      case 'ttuple':
        return ttuple(te.elems.map((x) => convertType(x, scope, tvars, allowFresh)));
    }
  }

  // ---------------------------------------------------------- declarations --
  function declareTypes(decls, scope, suffix) {
    for (const d of decls.filter((d) => d.k === 'type')) {
      if (Object.hasOwn(BUILTIN_TYPES, d.name)) fail(`cannot redefine built-in type \`${d.name}\``, d.nameSpan);
      if (scope.types.has(d.name)) fail(`type \`${d.name}\` is defined twice`, d.nameSpan);
      if (d.ctors.length > MAX_CTORS) fail(`type \`${d.name}\` has too many constructors (max ${MAX_CTORS})`, d.nameSpan);
      const internal = typeInfos.has(d.name) ? `${d.name}#${suffix}` : d.name;
      const info = { name: internal, display: d.name, params: d.params, decl: d, ctors: [] };
      typeInfos.set(internal, info);
      scope.types.set(d.name, info);
    }
    for (const d of decls.filter((d) => d.k === 'type')) {
      const info = scope.types.get(d.name);
      const tvars = new Map();
      const paramVars = d.params.map((p) => {
        if (tvars.has(p)) fail(`type parameter \`${p}\` is declared twice`, d.span);
        const v = newVar(GENERIC);
        tvars.set(p, v);
        return v;
      });
      const result = tcon(info.name, paramVars);
      d.ctors.forEach((c, index) => {
        if (scope.ctors.has(c.name)) fail(`constructor \`${c.name}\` is defined twice`, c.span);
        const fields = c.fields.map((f) => convertType(f, scope, tvars, false));
        const ctor = { name: c.name, index, arity: fields.length, fields, result, scheme: tfun(fields, result), type: info };
        info.ctors.push(ctor);
        scope.ctors.set(c.name, ctor);
      });
      info.paramVars = paramVars;
    }
  }

  function declareFns(decls, scope, suffix, origin) {
    const fns = decls.filter((d) => d.k === 'fn');
    for (const d of fns) {
      if (scope.values.has(d.name)) fail(`function \`${d.name}\` is defined twice`, d.nameSpan);
      const shadowed = preludeScope.values.has(d.name) && scope !== preludeScope;
      const binding = {
        id: bindingIds++, name: d.name, kind: 'global', type: null, decl: d,
        internal: shadowed ? `${d.name}#${suffix}` : d.name,
      };
      d.binding = binding;
      d.origin = origin;
      d.scope = scope;
      scope.values.set(d.name, binding);
    }
    return fns;
  }

  // Free references from a function body to global functions, honouring local
  // shadowing. Used to build the call graph for SCC ordering.
  function globalRefs(fnDecl) {
    const refs = new Set();
    const patNames = (p, out) => {
      if (p.k === 'pvar') out.add(p.name);
      for (const c of p.elems ?? p.args ?? []) patNames(c, out);
      return out;
    };
    const walk = (e, bound) => {
      if (!e) return;
      switch (e.k) {
        case 'var':
          if (!bound.has(e.name)) {
            const b = fnDecl.scope.find('values', e.name);
            if (b?.kind === 'global') refs.add(b.decl);
          }
          return;
        case 'lambda':
        case 'fn': {
          const inner = new Set(bound);
          if (e.k === 'fn') inner.add(e.name);
          e.params.forEach((p) => inner.add(p.name));
          walk(e.body, inner);
          return;
        }
        case 'block': {
          let cur = new Set(bound);
          for (const s of e.stmts) {
            if (s.k === 'let') {
              walk(s.e, cur);
              cur = new Set(cur);
              patNames(s.pat, cur);
            } else if (s.k === 'fn') {
              cur = new Set(cur);
              cur.add(s.name);
              walk(s, cur);
            } else walk(s.e, cur);
          }
          walk(e.result, cur);
          return;
        }
        case 'match':
          walk(e.e, bound);
          for (const arm of e.arms) {
            const inner = patNames(arm.pat, new Set(bound));
            walk(arm.guard, inner);
            walk(arm.body, inner);
          }
          return;
        case 'call': walk(e.fn, bound); e.args.forEach((a) => walk(a, bound)); return;
        case 'ctor': (e.args ?? []).forEach((a) => walk(a, bound)); return;
        case 'binop': walk(e.l, bound); walk(e.r, bound); return;
        case 'unop': walk(e.e, bound); return;
        case 'if': walk(e.c, bound); walk(e.t, bound); walk(e.e, bound); return;
        case 'tuple': e.elems.forEach((x) => walk(x, bound)); return;
      }
    };
    walk(fnDecl.body, new Set(fnDecl.params.map((p) => p.name)));
    return refs;
  }

  function sccs(fns) {
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
    let counter = 0;
    const edges = new Map(fns.map((f) => [f, [...globalRefs(f)]]));
    const visit = (v) => {
      index.set(v, counter);
      low.set(v, counter++);
      stack.push(v);
      onStack.add(v);
      for (const w of edges.get(v)) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    };
    for (const f of fns) if (!index.has(f)) visit(f);
    return out; // reverse topological order: dependencies come first
  }

  // ----------------------------------------------------------- inference --
  function newBinding(name, type, span) {
    return { id: bindingIds++, name, kind: 'local', type, span };
  }

  function inferPattern(p, expected, scope, seen) {
    p.ty = expected;
    const literal = (type, what) => expect(type, expected, p.span, `${what} pattern: `);
    switch (p.k) {
      case 'pwild':
        return;
      case 'pvar': {
        if (seen.has(p.name)) fail(`variable \`${p.name}\` is bound twice in the same pattern`, p.span);
        seen.add(p.name);
        p.binding = newBinding(p.name, expected, p.span);
        scope.values.set(p.name, p.binding);
        return;
      }
      case 'pint': return literal(INT, 'integer');
      case 'pstr': return literal(STRING, 'string');
      case 'pbool': return literal(BOOL, 'boolean');
      case 'punit': return literal(UNIT, 'unit');
      case 'ptuple': {
        const elems = p.elems.map(() => newVar(level));
        expect(ttuple(elems), expected, p.span, 'tuple pattern: ');
        p.elems.forEach((sub, i) => inferPattern(sub, elems[i], scope, seen));
        return;
      }
      case 'pctor': {
        const ctor = p.sugar ? preludeScope.ctors.get(p.name) : scope.find('ctors', p.name);
        if (!ctor) fail(`unknown constructor \`${p.name}\``, p.span, suggest(p.name, scope.names('ctors')));
        if (ctor.arity !== p.args.length) {
          fail(`constructor \`${p.name}\` has ${ctor.arity} field${ctor.arity === 1 ? '' : 's'}, but the pattern has ${p.args.length}`, p.span);
        }
        p.ctor = ctor;
        const inst = instantiate(ctor.scheme, level);
        expect(inst.ret, expected, p.span, `constructor pattern \`${p.name}\`: `);
        p.args.forEach((sub, i) => inferPattern(sub, inst.params[i], scope, seen));
      }
    }
  }

  function inferFunction(node, scope, selfBinding) {
    const tvars = new Map();
    const inner = new Scope(scope);
    if (selfBinding) inner.values.set(selfBinding.name, selfBinding);
    const seen = new Set();
    const params = node.params.map((p) => {
      if (seen.has(p.name) && p.name !== '_') fail(`parameter \`${p.name}\` is declared twice`, p.span);
      seen.add(p.name);
      const t = p.ann ? convertType(p.ann, scope, tvars, true) : newVar(level);
      p.binding = newBinding(p.name, t, p.span);
      if (p.name !== '_') inner.values.set(p.name, p.binding);
      return t;
    });
    const ret = node.ret ? convertType(node.ret, scope, tvars, true) : newVar(level);
    const fnType = tfun(params, ret);
    if (selfBinding) expect(fnType, selfBinding.type, node.nameSpan ?? node.span);
    const bodyTy = infer(node.body, inner);
    expect(bodyTy, ret, node.ret ? node.body.result?.span ?? node.body.span : node.body.span, node.ret ? 'return type: ' : '');
    node.ty = fnType;
    return fnType;
  }

  function inferCall(e, fnTy, scope, calleeName) {
    let f = prune(fnTy);
    if (f.k === 'var') {
      const shape = tfun(e.args.map(() => newVar(level)), newVar(level));
      unify(f, shape);
      f = shape;
    }
    if (f.k !== 'fun') fail(`cannot call a value of type ${new TypePrinter().show(f)}`, e.fn?.span ?? e.span);
    if (f.params.length !== e.args.length) {
      const n = f.params.length;
      fail(`${calleeName ? `\`${calleeName}\`` : 'this function'} takes ${n} argument${n === 1 ? '' : 's'} but ${e.args.length} ${e.args.length === 1 ? 'was' : 'were'} supplied`, e.span,
        [`its type is ${new TypePrinter().show(f)}`]);
    }
    e.args.forEach((a, i) => expect(infer(a, scope), f.params[i], a.span));
    return f.ret;
  }

  function infer(e, scope) {
    e.ty = inferInner(e, scope);
    return e.ty;
  }

  // `[a, b, ..rest]` is sugar for nested Cons cells. Checking the elements
  // directly against each other gives "expected Int, found String" at the
  // offending element instead of a mismatch between two List types.
  function inferListLiteral(e, scope) {
    const consCtor = preludeScope.ctors.get('Cons');
    const elem = newVar(level);
    const listTy = tcon(consCtor.type.name, [elem]);
    const cells = [];
    let node = e;
    for (; node.k === 'ctor' && node.literal === e.literal; node = node.args[1]) cells.push(node);
    cells.forEach((cell, i) => {
      expect(infer(cell.args[0], scope), elem, cell.args[0].span, i ? 'list elements must all have the same type: ' : '');
    });
    const ownNil = node.k === 'ctor' && node.sugar && node.name === 'Nil';
    expect(infer(node, scope), listTy, node.span, ownNil ? '' : 'the tail of a list (`..rest`): ');
    for (const cell of cells) {
      cell.ctor = consCtor;
      cell.ty = listTy;
    }
    return listTy;
  }

  function inferInner(e, scope) {
    switch (e.k) {
      case 'int': return INT;
      case 'str': return STRING;
      case 'bool': return BOOL;
      case 'unit': return UNIT;
      case 'var': {
        const b = scope.find('values', e.name);
        if (!b) fail(`unknown variable \`${e.name}\``, e.span, suggest(e.name, scope.names('values')));
        if (!b.type) throw new Error(`internal: \`${e.name}\` used before its type was inferred`);
        e.ref = b;
        return instantiate(b.type, level);
      }
      case 'ctor': {
        if (e.sugar && e.name === 'Cons') return inferListLiteral(e, scope);
        const ctor = e.sugar ? preludeScope.ctors.get(e.name) : scope.find('ctors', e.name);
        if (!ctor) fail(`unknown constructor \`${e.name}\``, e.nameSpan ?? e.span, suggest(e.name, scope.names('ctors')));
        e.ctor = ctor;
        const inst = instantiate(ctor.scheme, level);
        if (e.args === null) return ctor.arity === 0 ? inst.ret : inst;
        if (ctor.arity === 0) fail(`constructor \`${e.name}\` takes no arguments`, e.span);
        return inferCall(e, inst, scope, e.name);
      }
      case 'call': {
        const fnTy = infer(e.fn, scope);
        return inferCall(e, fnTy, scope, e.fn.k === 'var' ? e.fn.name : null);
      }
      case 'lambda':
        return inferFunction(e, scope, null);
      case 'binop': {
        const { op } = e;
        const operand = (x, type, what) => expect(infer(x, scope), type, x.span, `\`${op}\` ${what}: `);
        if (['+', '-', '*', '/', '%'].includes(op)) {
          operand(e.l, INT, 'needs Int operands');
          operand(e.r, INT, 'needs Int operands');
          return INT;
        }
        if (op === '++') {
          operand(e.l, STRING, 'concatenates Strings');
          operand(e.r, STRING, 'concatenates Strings');
          return STRING;
        }
        if (op === '&&' || op === '||') {
          operand(e.l, BOOL, 'needs Bool operands');
          operand(e.r, BOOL, 'needs Bool operands');
          return BOOL;
        }
        // Structural (in)equality and ordering work on any type except functions.
        const lt = infer(e.l, scope);
        expect(infer(e.r, scope), lt, e.r.span, `\`${op}\` compares values of the same type: `);
        e.operandTy = lt;
        return BOOL;
      }
      case 'unop':
        if (e.op === '-') {
          expect(infer(e.e, scope), INT, e.e.span, 'negation: ');
          return INT;
        }
        expect(infer(e.e, scope), BOOL, e.e.span, '`!`: ');
        return BOOL;
      case 'if': {
        expect(infer(e.c, scope), BOOL, e.c.span, 'if condition: ');
        const t = infer(e.t, scope);
        if (!e.e) {
          expect(t, UNIT, e.t.result?.span ?? e.t.span, '`if` without `else`: ');
          return UNIT;
        }
        expect(infer(e.e, scope), t, e.e.result?.span ?? e.e.span, '`if` and `else` have incompatible types: ');
        return t;
      }
      case 'match': {
        const st = infer(e.e, scope);
        const result = newVar(level);
        for (const arm of e.arms) {
          const inner = new Scope(scope);
          inferPattern(arm.pat, st, inner, new Set());
          if (arm.guard) expect(infer(arm.guard, inner), BOOL, arm.guard.span, 'match guard: ');
          expect(infer(arm.body, inner), result, arm.body.span, 'match arms have incompatible types: ');
        }
        matches.push(e);
        return result;
      }
      case 'block': {
        let cur = new Scope(scope);
        for (const s of e.stmts) {
          if (s.k === 'expr') {
            infer(s.e, cur);
          } else if (s.k === 'let') {
            level++;
            const t = infer(s.e, cur);
            if (s.ann) expect(t, convertType(s.ann, cur, new Map(), true), s.e.span);
            const next = new Scope(cur);
            inferPattern(s.pat, t, next, new Set());
            level--;
            // The value restriction: arrays are mutable, so only a syntactic
            // value may be polymorphic (`let a = array_make(1, [])` must not be).
            const general = isValue(s.e);
            for (const b of next.values.values()) (general ? generalize : pinLevels)(b.type, level);
            lets.push(s);
            cur = next;
          } else if (s.k === 'fn') {
            const next = new Scope(cur);
            level++;
            s.binding = newBinding(s.name, newVar(level), s.nameSpan);
            inferFunction(s, next, s.binding);
            level--;
            generalize(s.binding.type, level);
            next.values.set(s.name, s.binding);
            cur = next;
          }
        }
        return e.result ? infer(e.result, cur) : UNIT;
      }
      case 'tuple':
        return ttuple(e.elems.map((x) => infer(x, scope)));
    }
    throw new Error(`typecheck: unknown node ${e.k}`);
  }

  // -------------------------------------------------------------- driver --
  declareTypes(preludeAst.decls, preludeScope, 'prelude');
  declareTypes(userAst.decls, userScope, 'user');
  const preludeFns = declareFns(preludeAst.decls, preludeScope, 'prelude', 'prelude');
  const userFns = declareFns(userAst.decls, userScope, 'user', 'user');

  for (const comp of sccs([...preludeFns, ...userFns])) {
    level++;
    for (const d of comp) d.binding.type = newVar(level);
    for (const d of comp) inferFunction(d, d.scope, d.binding);
    level--;
    for (const d of comp) generalize(d.binding.type, level);
  }

  const main = userScope.values.get('main');
  if (!main) fail('no `main` function found', { s: 0, e: 0 }, ['add `fn main() { ... }` as the program entry point']);
  if (main.decl.params.length !== 0) fail('`main` must not take any parameters', main.decl.nameSpan);

  // ----------------------------------------------- exhaustiveness checks --
  const ctx = { typeInfos };
  for (const m of matches) {
    const { missing, redundant } = checkMatch(m, ctx);
    if (missing) {
      fail(`non-exhaustive match: pattern \`${missing}\` is not covered`, m.e.span,
        ['add an arm for the missing case, or a wildcard `_ ->` arm']);
    }
    for (const i of redundant) warnings.push({ message: 'unreachable match arm: earlier arms already cover it', span: m.arms[i].pat.span });
  }
  for (const s of lets) {
    const missing = checkIrrefutable(s.pat, ctx);
    if (missing) fail(`refutable pattern in \`let\`: \`${missing}\` is not covered`, s.pat.span, ['use `match` to handle the other cases']);
  }

  const signatures = userFns.map((d) => ({ name: d.name, type: new TypePrinter().show(d.binding.type), span: d.nameSpan }));
  return { typeInfos, warnings, signatures, preludeFns, userFns, main: main.decl };
}
