// Type-directed random program generator for differential testing.
//
// Every generated program is well-typed *by construction*: expressions are
// produced for a requested type from an environment of typed variables.
// Programs terminate by construction too (recursion is bounded by small
// literal counters), but they may legitimately fail at runtime — division by
// zero, out-of-bounds string indexing, panics — and the compiled code must
// fail at exactly the same point, with exactly the same output before it.
//
// Works in Node and in the browser (the playground runs it live).

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
  };
}

const TYPES = ['Int', 'Bool', 'String', 'List', 'Opt', 'Pair', 'Shape', 'Fn'];
const ANNOT = { Int: 'Int', Bool: 'Bool', String: 'String', List: 'List<Int>', Opt: 'Option<Int>', Pair: '(Int, Bool)', Shape: 'Shape', Fn: 'fn(Int) -> Int' };
const STRINGS = ['""', '"a"', '"b"', '"hello"', '"ab"', '"zz"', '"\\n"', '"x y"', '"ü"', '"✓"', '"lumen"', '"A"', '"\\x00"'];
const INT_EDGES = ['0', '1', '-1', '2', '7', '10', '1073741823', '-1073741824', '65536', '-32768', '46341'];

const PRELUDE_DECLS = `type Shape { Dot, Circle(Int), Pair(Shape, Shape) }
fn show_bool(b) { if b { "true" } else { "false" } }
fn show_opt(o) { match o { None -> "None", Some(x) -> "Some(" ++ int_to_string(x) ++ ")" } }
fn show_pair(p) { match p { (n, b) -> "(" ++ int_to_string(n) ++ ", " ++ show_bool(b) ++ ")" } }
fn show_shape(s) {
  match s {
    Dot -> "Dot",
    Circle(r) -> "Circle(" ++ int_to_string(r) ++ ")",
    Pair(a, b) -> "Pair(" ++ show_shape(a) ++ ", " ++ show_shape(b) ++ ")",
  }
}
fn show_fn(f) { show_list(map([0, 1, -3, 100], f), int_to_string) }
fn twice(f, x) { f(f(x)) }
fn pick(b, x, y) { if b { x } else { y } }
fn ident(x) { x }`;

export function generateProgram(seed, { size = 1 } = {}) {
  const R = rng(seed);
  let counter = 0;
  const fresh = (p = 'v') => `${p}${counter++}`;
  const funcs = []; // { name, params: [type], ret, src }

  const show = (t, e) => {
    switch (t) {
      case 'Int': return `int_to_string(${e})`;
      case 'Bool': return `show_bool(${e})`;
      case 'String': return `"\\"" ++ ${e} ++ "\\""`;
      case 'List': return `show_list(${e}, int_to_string)`;
      case 'Opt': return `show_opt(${e})`;
      case 'Pair': return `show_pair(${e})`;
      case 'Shape': return `show_shape(${e})`;
      case 'Fn': return `show_fn(${e})`;
    }
  };

  const varsOf = (env, t) => env.filter((v) => v.type === t);

  function leaf(t, env) {
    const vs = varsOf(env, t);
    if (vs.length && R.chance(0.6)) return R.pick(vs).name;
    switch (t) {
      case 'Int': return R.chance(0.5) ? R.pick(INT_EDGES) : String(R.int(-20, 100));
      case 'Bool': return R.pick(['true', 'false']);
      case 'String': return R.pick(STRINGS);
      case 'List': return R.pick(['[]', `[${R.int(-5, 9)}]`, `[${R.int(0, 9)}, ${R.int(-9, 9)}, ${R.int(0, 99)}]`, `range(0, ${R.int(0, 6)})`]);
      case 'Opt': return R.chance(0.5) ? 'None' : `Some(${R.int(-3, 30)})`;
      case 'Pair': return `(${R.int(-5, 50)}, ${R.pick(['true', 'false'])})`;
      case 'Shape': return R.pick(['Dot', `Circle(${R.int(0, 9)})`, `Pair(Dot, Circle(${R.int(0, 5)}))`]);
      case 'Fn': return R.pick(['(|x| x + 1)', '(|x| x * 2)', 'ident', '(|x| -x)', `(|x| x % ${R.int(1, 9)})`]);
    }
  }

  // An Int that is never zero, so most divisions succeed.
  const safeDivisor = (env, d) => `(abs(${gen('Int', env, d)}) % 9 + 1)`;

  function genMatch(t, env, d) {
    const st = R.pick(['List', 'Opt', 'Shape', 'Pair', 'Int', 'String', 'Bool']);
    const scrut = gen(st, env, d - 1);
    const arms = [];
    const body = (extra) => gen(t, [...env, ...extra], d - 1);
    const guard = (extra) => (R.chance(0.3) ? ` if ${gen('Bool', [...env, ...extra], d - 2)}` : '');
    switch (st) {
      case 'List': {
        const x = fresh(), y = fresh(), rest = fresh();
        const ex = [{ name: x, type: 'Int' }], exy = [...ex, { name: y, type: 'Int' }, { name: rest, type: 'List' }];
        if (R.chance(0.5)) {
          arms.push(`[] -> ${body([])}`);
          arms.push(`[${x}]${guard(ex)} -> ${body(ex)}`);
          arms.push(`[${x}, ${y}, ..${rest}]${guard(exy)} -> ${body(exy)}`);
          arms.push(`_ -> ${body([])}`);
        } else {
          const er = [...ex, { name: rest, type: 'List' }];
          arms.push(`[${x}, ..${rest}] -> ${body(er)}`);
          arms.push(`[] -> ${body([])}`);
        }
        break;
      }
      case 'Opt': {
        const x = fresh(), ex = [{ name: x, type: 'Int' }];
        if (R.chance(0.4)) arms.push(`Some(${R.int(-2, 5)}) -> ${body([])}`);
        const g = guard(ex);
        arms.push(`Some(${x})${g} -> ${body(ex)}`);
        arms.push(R.chance(0.5) && !g ? `None -> ${body([])}` : `_ -> ${body([])}`);
        break;
      }
      case 'Shape': {
        const a = fresh(), b = fresh(), r = fresh();
        const eab = [{ name: a, type: 'Shape' }, { name: b, type: 'Shape' }];
        if (R.chance(0.4)) arms.push(`Pair(Circle(${r}), _) -> ${body([{ name: r, type: 'Int' }])}`);
        if (R.chance(0.3)) arms.push(`Pair(Dot, Dot) -> ${body([])}`);
        const g = guard(eab);
        arms.push(`Pair(${a}, ${b})${g} -> ${body(eab)}`);
        arms.push(`Circle(${r}) -> ${body([{ name: r, type: 'Int' }])}`);
        arms.push(R.chance(0.5) && !g ? `Dot -> ${body([])}` : `_ -> ${body([])}`);
        break;
      }
      case 'Pair': {
        const n = fresh(), bb = fresh();
        if (R.chance(0.5)) {
          arms.push(`(${n}, true) -> ${body([{ name: n, type: 'Int' }])}`);
          arms.push(`(${n}, false) -> ${body([{ name: n, type: 'Int' }])}`);
        } else {
          arms.push(`(${n}, ${bb}) -> ${body([{ name: n, type: 'Int' }, { name: bb, type: 'Bool' }])}`);
        }
        break;
      }
      case 'Int': {
        const n = fresh();
        arms.push(`${R.int(-1, 3)} -> ${body([])}`);
        if (R.chance(0.5)) arms.push(`${R.pick(INT_EDGES)} -> ${body([])}`);
        arms.push(`${n}${guard([{ name: n, type: 'Int' }])} -> ${body([{ name: n, type: 'Int' }])}`);
        arms.push(`_ -> ${body([])}`);
        break;
      }
      case 'String': {
        const s = fresh();
        arms.push(`${R.pick(STRINGS)} -> ${body([])}`);
        arms.push(`${s} -> ${body([{ name: s, type: 'String' }])}`);
        break;
      }
      case 'Bool':
        arms.push(`true -> ${body([])}`, `false -> ${body([])}`);
        break;
    }
    return `match ${scrut} { ${arms.join(', ')} }`;
  }

  function callFunc(t, env, d) {
    const cands = funcs.filter((f) => f.ret === t);
    if (!cands.length) return null;
    const f = R.pick(cands);
    if (f.recursive) return `${f.name}(${R.int(0, 12)}, ${gen(f.params[1], env, d - 1)})`;
    return `${f.name}(${f.params.map((p) => gen(p, env, d - 1)).join(', ')})`;
  }

  function gen(t, env, d) {
    if (d <= 0 || R.chance(0.12)) return leaf(t, env);
    if (R.chance(0.04)) {
      // A call whose callee *and* argument have visible side effects: pins down
      // the evaluation order of closure calls (callee first, then arguments).
      const v = fresh();
      const callee = `{ print("<${counter}"); |${v}| ${gen(t, [...env, { name: v, type: 'Int' }], d - 1)} }`;
      return `(${callee})({ print(">${counter}"); ${gen('Int', env, d - 1)} })`;
    }
    const r = R.float();
    // ------------------------------------------------- type-independent
    if (r < 0.06) return `if ${gen('Bool', env, d - 1)} { ${gen(t, env, d - 1)} } else { ${gen(t, env, d - 1)} }`;
    if (r < 0.12) return genMatch(t, env, d);
    if (r < 0.17) {
      const lt = R.pick(TYPES);
      const v = fresh();
      const ann = R.chance(0.3) ? `: ${ANNOT[lt]}` : '';
      return `{ let ${v}${ann} = ${gen(lt, env, d - 1)}; ${gen(t, [...env, { name: v, type: lt }], d - 1)} }`;
    }
    if (r < 0.20) {
      const st = R.pick(TYPES);
      return `{ println(${show(st, gen(st, env, d - 2))}); ${gen(t, env, d - 1)} }`;
    }
    if (r < 0.23) return `pick(${gen('Bool', env, d - 1)}, ${gen(t, env, d - 1)}, ${gen(t, env, d - 1)})`;
    if (r < 0.25) return `ident(${gen(t, env, d - 1)})`;
    if (r < 0.28) {
      // Immediately-applied lambda capturing the environment.
      const v = fresh();
      const at = R.pick(TYPES);
      return `(|${v}| ${gen(t, [...env, { name: v, type: at }], d - 1)})(${gen(at, env, d - 1)})`;
    }
    if (r < 0.31) {
      // Local recursive function: a bounded loop with an accumulator, closing over env.
      const go = fresh('go'), i = fresh('i'), acc = fresh('acc');
      const inner = [...env, { name: i, type: 'Int' }, { name: acc, type: t }];
      const step = gen(t, inner, d - 1);
      const tailCall = R.chance(0.6);
      const back = fresh('r');
      const recurse = tailCall
        ? `${go}(${i} - 1, ${step})`
        : `{ let ${back} = ${go}(${i} - 1, ${acc}); ${gen(t, [...inner, { name: back, type: t }], d - 2)} }`;
      return `{ fn ${go}(${i}, ${acc}) { if ${i} <= 0 { ${acc} } else { ${recurse} } } ${go}(${R.int(0, 8)}, ${gen(t, env, d - 1)}) }`;
    }
    if (r < 0.36) {
      const c = callFunc(t, env, d);
      if (c) return c;
    }
    if (r < 0.40) {
      const fs = varsOf(env, 'Fn');
      if (t === 'Int' && fs.length) return `${R.pick(fs).name}(${gen('Int', env, d - 1)})`;
    }
    // ---------------------------------------------------- type-specific
    switch (t) {
      case 'Int': {
        const k = R.int(0, 17);
        const a = () => gen('Int', env, d - 1);
        if (k <= 4) return `(${a()} ${R.pick(['+', '-', '*', '+', '-'])} ${a()})`;
        if (k === 5) return R.chance(0.15) ? `(${a()} ${R.pick(['/', '%'])} ${a()})` : `(${a()} ${R.pick(['/', '%'])} ${safeDivisor(env, d - 1)})`;
        if (k === 6) return `-${R.chance(0.5) ? a() : `(${a()})`}`;
        if (k === 7) return `length(${gen('List', env, d - 1)})`;
        if (k === 8) return `string_length(${gen('String', env, d - 1)})`;
        if (k === 9) return `fold(${gen('List', env, d - 1)}, ${a()}, |${fresh('s')}, ${fresh('x')}| ${'s' + (counter - 2)} ${R.pick(['+', '-', '*'])} ${'x' + (counter - 1)})`;
        if (k === 10) return `sum(${gen('List', env, d - 1)})`;
        if (k === 11) return `unwrap_or(${gen('Opt', env, d - 1)}, ${a()})`;
        if (k === 12) return `twice(${gen('Fn', env, d - 1)}, ${a()})`;
        if (k === 13) {
          // Usually in bounds (the string is padded); occasionally an arbitrary index.
          return R.chance(0.9)
            ? `char_code_at(${gen('String', env, d - 1)} ++ "xyz", ${R.int(0, 2)})`
            : `char_code_at(${gen('String', env, d - 1)}, ${a()})`;
        }
        if (k === 14) return `match ${gen('Pair', env, d - 1)} { (${fresh()}, _) -> ${'v' + (counter - 1)} }`;
        if (k === 16) {
          // An array of some element type: made, updated, read (indices occasionally out of range).
          const arr = fresh('arr'), n = R.chance(0.03) ? 0 : R.int(1, 4);
          const at = () => (R.chance(0.985) ? R.int(0, Math.max(0, n - 1)) : R.int(-1, n + 1));
          const et = R.pick(['Int', 'String', 'List', 'Shape']);
          const read = { Int: (x) => x, String: (x) => `string_length(${x})`, List: (x) => `length(${x})`, Shape: (x) => `string_length(show_shape(${x}))` }[et];
          return `{ let ${arr} = array_make(${n}, ${gen(et, env, d - 1)}); array_set(${arr}, ${at()}, ${gen(et, env, d - 1)}); ${read(`array_get(${arr}, ${at()})`)} + array_length(${arr}) }`;
        }
        if (k === 17) {
          // A local recursive function fills an array it captures, so later reads see the writes.
          const arr = fresh('arr'), fill = fresh('fill'), i = fresh('i'), n = R.int(1, 6);
          const elem = gen('Int', [...env, { name: i, type: 'Int' }], d - 1);
          return `{ let ${arr} = array_make(${n}, ${a()}); fn ${fill}(${i}) { if ${i} < ${n} { array_set(${arr}, ${i}, ${elem}); ${fill}(${i} + 1) } else { () } } ${fill}(${R.int(0, n)}); array_get(${arr}, ${R.int(0, n - 1)}) }`;
        }
        return `abs(${a()})`;
      }
      case 'Bool': {
        const k = R.int(0, 7);
        if (k <= 2) {
          // Comparing functions is a runtime error; exercise that path occasionally.
          const ct = R.chance(0.01) ? 'Fn' : R.pick(['Int', 'Int', 'String', 'List', 'Opt', 'Pair', 'Shape', 'Bool', 'Array']);
          if (ct === 'Array') {
            const arr = () => `array_make(${R.int(0, 3)}, ${gen('Int', env, d - 2)})`;
            return `(${arr()} ${R.pick(['==', '!=', '<', '<=', '>', '>='])} ${arr()})`;
          }
          return `(${gen(ct, env, d - 1)} ${R.pick(['==', '!=', '<', '<=', '>', '>='])} ${gen(ct, env, d - 1)})`;
        }
        if (k === 3) return `(${gen('Bool', env, d - 1)} ${R.pick(['&&', '||'])} ${gen('Bool', env, d - 1)})`;
        if (k === 4) return `!${gen('Bool', env, d - 1)}`;
        if (k === 5) return `is_empty(${gen('List', env, d - 1)})`;
        if (k === 6) return `contains(${gen('List', env, d - 1)}, ${gen('Int', env, d - 1)})`;
        return `any(${gen('List', env, d - 1)}, |${fresh()}| ${gen('Bool', [...env, { name: 'v' + (counter - 1), type: 'Int' }], d - 2)})`;
      }
      case 'String': {
        const k = R.int(0, 7);
        if (k <= 2) return `(${gen('String', env, d - 1)} ++ ${gen('String', env, d - 1)})`;
        if (k === 3) return `int_to_string(${gen('Int', env, d - 1)})`;
        if (k === 4) return `substring(${gen('String', env, d - 1)}, ${R.int(-2, 4)}, ${gen('Int', env, d - 1)})`;
        if (k === 5) return `char_from_code(${gen('Int', env, d - 1)})`;
        if (k === 6) return `join(map(${gen('List', env, d - 1)}, int_to_string), ${R.pick(STRINGS)})`;
        const st = R.pick(TYPES);
        return show(st, gen(st, env, d - 1));
      }
      case 'List': {
        const k = R.int(0, 9);
        const l = () => gen('List', env, d - 1);
        const x = () => fresh();
        if (k === 0) return `[${gen('Int', env, d - 1)}, ..${l()}]`;
        if (k === 1) { const v = x(); return `map(${l()}, |${v}| ${gen('Int', [...env, { name: v, type: 'Int' }], d - 2)})`; }
        if (k === 2) { const v = x(); return `filter(${l()}, |${v}| ${gen('Bool', [...env, { name: v, type: 'Int' }], d - 2)})`; }
        if (k === 3) return `append(${l()}, ${l()})`;
        if (k === 4) return `reverse(${l()})`;
        if (k === 5) return `sort(${l()})`;
        if (k === 6) return `take(${l()}, ${R.int(-1, 4)})`;
        if (k === 7) return `drop(${l()}, ${R.int(-1, 4)})`;
        if (k === 8) return `range(${R.int(-3, 3)}, ${R.int(-2, 8)})`;
        return `[${gen('Int', env, d - 1)}, ${gen('Int', env, d - 1)}]`;
      }
      case 'Opt': {
        const k = R.int(0, 4);
        if (k === 0) return `Some(${gen('Int', env, d - 1)})`;
        if (k === 1) return `head(${gen('List', env, d - 1)})`;
        if (k === 2) return `nth(${gen('List', env, d - 1)}, ${R.int(-1, 3)})`;
        if (k === 3) return `parse_int(${R.chance(0.5) ? gen('String', env, d - 1) : `int_to_string(${gen('Int', env, d - 1)})`})`;
        return `map_option(${gen('Opt', env, d - 1)}, ${gen('Fn', env, d - 1)})`;
      }
      case 'Pair':
        return `(${gen('Int', env, d - 1)}, ${gen('Bool', env, d - 1)})`;
      case 'Shape': {
        const k = R.int(0, 2);
        if (k === 0) return `Circle(${gen('Int', env, d - 1)})`;
        if (k === 1) return `Pair(${gen('Shape', env, d - 1)}, ${gen('Shape', env, d - 1)})`;
        return 'Dot';
      }
      case 'Fn': {
        const v = fresh();
        if (R.chance(0.2)) return R.pick(['abs', 'ident', '(|x| x)']);
        return `(|${v}| ${gen('Int', [...env, { name: v, type: 'Int' }], d - 1)})`;
      }
    }
    return leaf(t, env);
  }

  // ------------------------------------------------- top-level functions --
  const nFuncs = R.int(1, 3 + 2 * size);
  for (let k = 0; k < nFuncs; k++) {
    const name = fresh('f');
    const ret = R.pick(TYPES);
    if (R.chance(0.3)) {
      // Bounded recursion: f(n, acc). Non-tail recursion keeps values live across calls.
      const n = fresh('n'), acc = fresh('acc');
      const env = [{ name: n, type: 'Int' }, { name: acc, type: ret }];
      const tailCall = R.chance(0.5);
      const back = fresh('r');
      const step = tailCall
        ? `${name}(${n} - 1, ${gen(ret, env, 3)})`
        : `{ let ${back} = ${name}(${n} - 1, ${acc}); ${gen(ret, [...env, { name: back, type: ret }], 3)} }`;
      const ann = R.chance(0.5);
      const src = `fn ${name}(${n}${ann ? ': Int' : ''}, ${acc}${ann ? `: ${ANNOT[ret]}` : ''})${ann ? ` -> ${ANNOT[ret]}` : ''} {\n  if ${n} <= 0 { ${acc} } else { ${step} }\n}`;
      funcs.push({ name, params: ['Int', ret], ret, src, recursive: true });
    } else {
      const params = Array.from({ length: R.int(0, 3) }, () => R.pick(TYPES));
      const names = params.map(() => fresh('p'));
      const env = params.map((type, i) => ({ name: names[i], type }));
      const ann = R.chance(0.4);
      const body = gen(ret, env, 3 + size);
      const ps = names.map((p, i) => (ann ? `${p}: ${ANNOT[params[i]]}` : p)).join(', ');
      funcs.push({ name, params, ret, src: `fn ${name}(${ps})${ann ? ` -> ${ANNOT[ret]}` : ''} {\n  ${body}\n}` });
    }
  }

  // --------------------------------------------------------------- main --
  const stmts = [];
  const env = [];
  const nStmts = R.int(3, 5 + 3 * size);
  for (let k = 0; k < nStmts; k++) {
    const t = R.pick(TYPES);
    if (R.chance(0.3)) {
      const v = fresh('m');
      stmts.push(`let ${v} = ${gen(t, env, 2 + size)};`);
      env.push({ name: v, type: t });
    } else {
      stmts.push(`println(${show(t, gen(t, env, 3 + size))});`);
    }
  }
  return { decls: [PRELUDE_DECLS, ...funcs.map((f) => f.src)], stmts };
}

export function renderProgram({ decls, stmts }) {
  return `${decls.join('\n\n')}\n\nfn main() {\n${stmts.map((s) => `  ${s}`).join('\n')}\n}\n`;
}
