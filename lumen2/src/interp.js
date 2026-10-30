// The reference interpreter: a direct evaluator over the typed syntax tree.
// It is the executable definition of Lumen 2's semantics, and the oracle the
// compiled code is tested against. It shares nothing with the back end.
//
//   * Int is a 64-bit two's-complement integer; an operation whose exact
//     result does not fit is the runtime error `integer overflow`.
//   * Evaluation is strictly left to right: the callee, then the arguments.
//   * Arrays are values: array_set returns an updated array and never changes
//     the array it was given.
//   * Tail calls run in constant stack (a trampoline).

export const INT_MIN = -(1n << 63n);
export const INT_MAX = (1n << 63n) - 1n;
export const MAX_ARRAY = (1 << 24) - 1;
export const MAX_STRING = (1 << 24) - 1;

export class LumenRuntimeError extends Error {}
const fail = (msg) => { throw new LumenRuntimeError(msg); };
const int = (v) => (v < INT_MIN || v > INT_MAX ? fail('integer overflow') : v);

class TailCall { constructor(fn, args) { this.fn = fn; this.args = args; } }

// Structural ordering. The last field is compared by looping, not recursion,
// so comparing long lists takes constant stack.
export function compare(a, b) {
  for (;;) {
    if (typeof a === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
    if (a === null) return 0;
    if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
    let xs, ys;
    if (a.t === 'tup') { xs = a.v; ys = b.v; }
    else if (a.t === 'ctor') {
      if (a.idx !== b.idx) return a.idx < b.idx ? -1 : 1;
      xs = a.f; ys = b.f;
    } else if (a.t === 'arr') {
      if (a.v.length !== b.v.length) return a.v.length < b.v.length ? -1 : 1;
      xs = a.v; ys = b.v;
    } else throw new Error('compare: not comparable');
    if (!xs.length) return 0;
    for (let i = 0; i < xs.length - 1; i++) { const c = compare(xs[i], ys[i]); if (c) return c; }
    a = xs[xs.length - 1]; b = ys[ys.length - 1];
  }
}

export function interpret(program, { input = '', maxSteps = Infinity, maxDepth = 10000 } = {}) {
  const fns = new Map(program.fns.map((f) => [f.key, f]));
  let out = '';
  let steps = 0;
  let depth = 0;
  const tick = () => { if (++steps > maxSteps) fail('out of fuel'); };

  const lookup = (env, id) => {
    for (let e = env; e; e = e.parent) if (e.vars.has(id)) return e.vars.get(id);
    throw new Error(`interp: unbound ${id}`);
  };
  const scope = (parent) => ({ vars: new Map(), parent });

  const BUILTINS = {
    print: ([s]) => { out += s; return null; },
    println: ([s]) => { out += `${s}\n`; return null; },
    read_input: () => input,
    int_to_string: ([n]) => n.toString(),
    string_length: ([s]) => BigInt(s.length),
    substring: ([s, start, end]) => {
      const len = BigInt(s.length);
      const a = start < 0n ? 0n : start > len ? len : start;
      const b = end < a ? a : end > len ? len : end;
      return s.slice(Number(a), Number(b));
    },
    char_code_at: ([s, i]) => (i < 0n || i >= BigInt(s.length) ? fail('index out of bounds') : BigInt(s.charCodeAt(Number(i)))),
    char_from_code: ([c]) => String.fromCharCode(Number(BigInt.asUintN(8, c))),
    panic: ([m]) => fail(`panic: ${m}`),
    array_make: ([n, x]) => {
      if (n < 0n) fail('index out of bounds');
      if (n > BigInt(MAX_ARRAY)) fail('out of memory');
      return { t: 'arr', v: Array(Number(n)).fill(x) };
    },
    array_empty: () => ({ t: 'arr', v: [] }),
    array_get: ([a, i]) => (i < 0n || i >= BigInt(a.v.length) ? fail('index out of bounds') : a.v[Number(i)]),
    array_set: ([a, i, x]) => {
      if (i < 0n || i >= BigInt(a.v.length)) fail('index out of bounds');
      const v = a.v.slice();
      v[Number(i)] = x;
      return { t: 'arr', v };
    },
    array_length: ([a]) => BigInt(a.v.length),
    array_push: ([a, x]) => (a.v.length >= MAX_ARRAY ? fail('out of memory') : { t: 'arr', v: [...a.v, x] }),
  };

  // Calls a function value with argument values, looping on tail calls.
  function call(fn, args) {
    if (++depth > maxDepth) fail('stack overflow');
    try {
      for (;;) {
        tick();
        let r;
        if (fn.t === 'bi') return BUILTINS[fn.name](args);
        if (fn.t === 'ctorfn') return { t: 'ctor', key: fn.info.key, idx: fn.info.idx, name: fn.info.name, f: args };
        if (fn.t === 'glob') {
          const f = fns.get(fn.key);
          const env = scope(null);
          f.params.forEach((p, i) => env.vars.set(p.id, args[i]));
          r = evalTail(f.body, env);
        } else {
          const env = scope(fn.env);
          fn.params.forEach((p, i) => env.vars.set(p.id, args[i]));
          r = evalTail(fn.body, env);
        }
        if (!(r instanceof TailCall)) return r;
        fn = r.fn; args = r.args;
      }
    } finally { depth--; }
  }

  // Evaluates an expression in tail position: a call becomes a TailCall.
  function evalTail(e, env) {
    for (;;) {
      switch (e.k) {
        case 'call': {
          const fn = ev(e.fn, env);
          const args = e.args.map((a) => ev(a, env));
          return new TailCall(fn, args);
        }
        case 'block': {
          const inner = scope(env);
          for (const st of e.stmts) stmt(st, inner);
          if (!e.result) return null;
          e = e.result; env = inner;
          continue;
        }
        case 'if': {
          const c = ev(e.cond, env);
          if (c) { e = e.then; continue; }
          if (!e.else) return null;
          e = e.else;
          continue;
        }
        case 'match': {
          const v = ev(e.scrut, env);
          const arm = selectArm(e, v, env);
          e = arm.body; env = arm.env;
          continue;
        }
        default: return ev(e, env);
      }
    }
  }

  function selectArm(e, v, env) {
    for (const arm of e.arms) {
      const inner = scope(env);
      if (matchPat(arm.pat, v, inner) && (!arm.guard || ev(arm.guard, inner))) return { body: arm.body, env: inner };
    }
    throw new Error('interp: match failure (exhaustiveness should prevent this)');
  }

  function matchPat(p, v, env) {
    switch (p.k) {
      case 'pwild': return true;
      case 'pvar': env.vars.set(p.id, v); return true;
      case 'pint': case 'pstr': case 'pbool': return v === p.v;
      case 'punit': return true;
      case 'ptuple': return p.elems.every((q, i) => matchPat(q, v.v[i], env));
      case 'pctor': return v.idx === p.ctorInfo.idx && p.args.every((q, i) => matchPat(q, v.f[i], env));
      default: throw new Error(p.k);
    }
  }

  function stmt(st, env) {
    if (st.k === 'let') { matchPat(st.pat, ev(st.value, env), env); return; }
    if (st.k === 'expr') { ev(st.e, env); return; }
    const f = st.fn; // a local function: a closure that can see itself
    const clo = { t: 'clo', params: f.params, body: f.body, env };
    env.vars.set(f.id, clo);
  }

  function ev(e, env) {
    tick();
    switch (e.k) {
      case 'int': return e.v;
      case 'str': return e.v;
      case 'bool': return e.v;
      case 'unit': return null;
      case 'var':
        if (e.ref.k === 'local') return lookup(env, e.ref.id);
        if (e.ref.k === 'global') return { t: 'glob', key: e.ref.key };
        return { t: 'bi', name: e.ref.name };
      case 'ctor':
        if (e.args === null) return e.ctor.fieldTypes.length ? { t: 'ctorfn', info: e.ctor } : { t: 'ctor', key: e.ctor.key, idx: e.ctor.idx, name: e.ctor.name, f: [] };
        return { t: 'ctor', key: e.ctor.key, idx: e.ctor.idx, name: e.ctor.name, f: e.args.map((a) => ev(a, env)) };
      case 'call': {
        const fn = ev(e.fn, env);
        const args = e.args.map((a) => ev(a, env));
        return call(fn, args);
      }
      case 'binop': return binop(e, env);
      case 'unop': {
        const v = ev(e.e, env);
        return e.op === '-' ? int(-v) : !v;
      }
      case 'lambda': return { t: 'clo', params: e.params, body: e.body, env };
      case 'tuple': return { t: 'tup', v: e.elems.map((x) => ev(x, env)) };
      case 'block': case 'if': case 'match': {
        const r = evalTail(e, env);
        return r instanceof TailCall ? call(r.fn, r.args) : r;
      }
      default: throw new Error(`interp: ${e.k}`);
    }
  }

  function binop(e, env) {
    if (e.op === '&&') return ev(e.l, env) && ev(e.r, env);
    if (e.op === '||') return ev(e.l, env) || ev(e.r, env);
    const l = ev(e.l, env), r = ev(e.r, env);
    switch (e.op) {
      case '+': return int(l + r);
      case '-': return int(l - r);
      case '*': return int(l * r);
      case '/': return r === 0n ? fail('division by zero') : int(l / r);
      case '%': return r === 0n ? fail('division by zero') : l % r;
      case '++': return l.length + r.length > MAX_STRING ? fail('string too long') : l + r;
      case '==': return compare(l, r) === 0;
      case '!=': return compare(l, r) !== 0;
      case '<': return compare(l, r) < 0;
      case '<=': return compare(l, r) <= 0;
      case '>': return compare(l, r) > 0;
      case '>=': return compare(l, r) >= 0;
      default: throw new Error(e.op);
    }
  }

  let error = null;
  try {
    call({ t: 'glob', key: program.main.key }, []);
  } catch (e) {
    if (e instanceof LumenRuntimeError) error = e.message;
    else if (e instanceof RangeError) error = 'stack overflow';
    else throw e;
  }
  return { output: out, error, steps };
}
