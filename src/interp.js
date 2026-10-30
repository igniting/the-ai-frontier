// Reference interpreter: a direct, tree-walking evaluator over the typed AST.
//
// It is deliberately independent from the compiler back end (no IR, no
// closure conversion, no pattern-match compilation, no garbage collector) so
// that it can serve as an *oracle*: the differential fuzzer runs every
// generated program through both and demands byte-identical output.
//
// Semantics that must agree exactly with the WebAssembly runtime:
//   * Int is 31-bit two's complement with wrap-around.
//   * Evaluation order is strictly left to right (callee, then arguments).
//   * Structural equality/ordering compare constructor index, then fields
//     left to right, and fail on functions only when they are reached.
//   * Strings are byte strings.
// Tail calls are trampolined so that tail-recursive loops run in constant
// JS stack, like the compiled code (which uses wasm `return_call`).

import { LumenRuntimeError, LumenError } from './diagnostics.js';
import { decodeBytes } from './lexer.js';

export const wrap31 = (x) => (x << 1) >> 1;

class Block {
  constructor(tag, fields) {
    this.tag = tag;
    this.fields = fields;
  }
}
class Closure {
  constructor(node, env, selfBinding = null) {
    this.node = node;
    this.env = env;
    this.selfBinding = selfBinding;
  }
}
class Builtin {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
}
class CtorFn {
  constructor(ctor) {
    this.ctor = ctor;
  }
}
class TailCall {
  constructor(f, args) {
    this.f = f;
    this.args = args;
  }
}
const UNIT = Object.freeze({ unit: true });

const fail = (msg) => { throw new LumenRuntimeError(msg); };

export function compareValues(a, b) {
  for (;;) {
    if (typeof a === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
    if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (a === UNIT) return 0;
    if (!(a instanceof Block)) return fail('cannot compare functions');
    if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
    const n = a.fields.length;
    if (n === 0) return 0;
    for (let i = 0; i < n - 1; i++) {
      const c = compareValues(a.fields[i], b.fields[i]);
      if (c !== 0) return c;
    }
    // Loop on the last field (like the runtime) so long lists don't exhaust the stack.
    a = a.fields[n - 1];
    b = b.fields[n - 1];
  }
}

export function interpret(checked, { maxSteps = Infinity, input = '' } = {}) {
  let out = '';
  let steps = 0;
  const globals = new Map();

  const builtins = {
    print: (s) => { out += s; return UNIT; },
    println: (s) => { out += s + '\n'; return UNIT; },
    int_to_string: (n) => String(n),
    string_length: (s) => s.length,
    substring: (s, a, b) => {
      const start = Math.max(0, Math.min(a, s.length));
      const end = Math.max(start, Math.min(b, s.length));
      return s.slice(start, end);
    },
    char_code_at: (s, i) => (i >= 0 && i < s.length ? s.charCodeAt(i) : fail('index out of bounds')),
    char_from_code: (c) => String.fromCharCode(c & 255),
    panic: (s) => fail(`panic: ${decodeBytes(s)}`),
    read_input: () => input,
  };
  const builtinValues = new Map(Object.entries(builtins).map(([k, f]) => [k, new Builtin(k, f)]));

  function lookup(ref, env) {
    switch (ref.kind) {
      case 'local': return env[ref.id];
      case 'builtin': return builtinValues.get(ref.name);
      case 'global': {
        let v = globals.get(ref);
        if (!v) globals.set(ref, (v = new Closure(ref.decl, Object.create(null))));
        return v;
      }
    }
  }

  function bindPattern(p, v, env) {
    switch (p.k) {
      case 'pwild': return true;
      case 'pvar': env[p.binding.id] = v; return true;
      case 'pint':
      case 'pstr':
      case 'pbool': return v === p.v;
      case 'punit': return true;
      case 'ptuple': return p.elems.every((sub, i) => bindPattern(sub, v.fields[i], env));
      case 'pctor': return v.tag === p.ctor.index && p.args.every((sub, i) => bindPattern(sub, v.fields[i], env));
    }
  }

  function apply(f, args) {
    for (;;) {
      if (++steps > maxSteps) fail('out of fuel');
      if (f instanceof Closure) {
        const env = Object.create(f.env);
        if (f.selfBinding) env[f.selfBinding.id] = f;
        f.node.params.forEach((p, i) => { env[p.binding.id] = args[i]; });
        const r = evaluate(f.node.body, env, true);
        if (r instanceof TailCall) {
          f = r.f;
          args = r.args;
          continue;
        }
        return r;
      }
      if (f instanceof Builtin) return f.fn(...args);
      if (f instanceof CtorFn) return new Block(f.ctor.index, args);
      throw new Error('interp: calling a non-function');
    }
  }

  function arith(op, a, b) {
    switch (op) {
      case '+': return wrap31(a + b);
      case '-': return wrap31(a - b);
      case '*': return wrap31(Math.imul(a, b));
      case '/': return b === 0 ? fail('division by zero') : wrap31(Math.trunc(a / b));
      case '%': return b === 0 ? fail('division by zero') : (a % b) | 0;
    }
  }

  function evaluate(e, env, tail) {
    switch (e.k) {
      case 'int':
      case 'str':
      case 'bool':
        return e.v;
      case 'unit':
        return UNIT;
      case 'var':
        return lookup(e.ref, env);
      case 'ctor': {
        const c = e.ctor;
        if (e.args === null) return c.arity === 0 ? new Block(c.index, []) : new CtorFn(c);
        return new Block(c.index, e.args.map((a) => evaluate(a, env, false)));
      }
      case 'call': {
        const f = evaluate(e.fn, env, false);
        const args = e.args.map((a) => evaluate(a, env, false));
        return tail && f instanceof Closure ? new TailCall(f, args) : apply(f, args);
      }
      case 'lambda':
        return new Closure(e, env);
      case 'binop': {
        const { op } = e;
        if (op === '&&') return evaluate(e.l, env, false) ? evaluate(e.r, env, tail) : false;
        if (op === '||') return evaluate(e.l, env, false) ? true : evaluate(e.r, env, tail);
        const a = evaluate(e.l, env, false);
        const b = evaluate(e.r, env, false);
        switch (op) {
          case '++': return a + b;
          case '==': return compareValues(a, b) === 0;
          case '!=': return compareValues(a, b) !== 0;
          case '<': return compareValues(a, b) < 0;
          case '<=': return compareValues(a, b) <= 0;
          case '>': return compareValues(a, b) > 0;
          case '>=': return compareValues(a, b) >= 0;
          default: return arith(op, a, b);
        }
      }
      case 'unop': {
        const v = evaluate(e.e, env, false);
        return e.op === '-' ? wrap31(-v) : !v;
      }
      case 'if':
        if (evaluate(e.c, env, false)) return evaluate(e.t, env, tail);
        return e.e ? evaluate(e.e, env, tail) : UNIT;
      case 'match': {
        const v = evaluate(e.e, env, false);
        for (const arm of e.arms) {
          const armEnv = Object.create(env);
          if (bindPattern(arm.pat, v, armEnv) && (!arm.guard || evaluate(arm.guard, armEnv, false))) {
            return evaluate(arm.body, armEnv, tail);
          }
        }
        return fail('match failure');
      }
      case 'block': {
        let cur = env;
        for (const s of e.stmts) {
          if (s.k === 'expr') {
            const r = evaluate(s.e, cur, false);
            if (r instanceof TailCall) throw new Error('interp: tail call escaped');
          } else if (s.k === 'let') {
            const v = evaluate(s.e, cur, false);
            cur = Object.create(cur);
            bindPattern(s.pat, v, cur);
          } else if (s.k === 'fn') {
            cur = Object.create(cur);
            cur[s.binding.id] = new Closure(s, cur, s.binding);
          }
        }
        return e.result ? evaluate(e.result, cur, tail) : UNIT;
      }
      case 'tuple':
        return new Block(0, e.elems.map((x) => evaluate(x, env, false)));
    }
    throw new Error(`interp: unknown node ${e.k}`);
  }

  let error = null;
  try {
    apply(lookup(checked.main.binding, null), []);
  } catch (err) {
    if (err instanceof LumenRuntimeError) error = err.message;
    else if (err instanceof RangeError) error = 'stack overflow';
    else if (err instanceof LumenError) throw err;
    else throw err;
  }
  return { output: out, error, steps };
}
