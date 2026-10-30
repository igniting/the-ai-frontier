// Differential fuzzing: random well-typed programs, run by the reference
// interpreter and by the compiled WebAssembly (normally, in paranoid mode and
// without reuse). Every run must print the same output and stop with the same
// error, and a run that finishes must have freed every object it allocated.
//
//   node test/fuzz.js [COUNT] [FIRST_SEED]          fuzz the compiler
//   node test/fuzz.js --mutants [BUDGET]            check that each planted bug is caught
//
// The generator is type-directed: it builds an expression of a requested type
// from the variables in scope, literals, operators, constructors, matches,
// closures, prelude functions and earlier generated functions.

import { checkSource } from '../src/api.js';
import { interpret } from '../src/interp.js';
import { compileProgram, runWasm } from '../src/codegen.js';

// ------------------------------------------------------------------ types --
const T = {
  int: 'Int', bool: 'Bool', str: 'String', ints: 'List<Int>', strs: 'List<String>', opt: 'Option<Int>',
  pair: '(Int, String)', tree: 'Tree', shape: 'Shape', color: 'Color', arr: 'Array<Int>', sarr: 'Array<String>',
  fn: 'fn(Int) -> Int', nested: 'List<List<Int>>',
};
const VALUE_TYPES = Object.values(T).filter((t) => t !== T.fn);
const COMPARABLE = VALUE_TYPES;
const DECLS = `type Tree { Leaf, Node(Tree, Int, Tree) }
type Shape { Circle(Int), Rect(Int, Int), Dot }
type Color { Red, Green, Blue }
fn insert(t, x) {
  match t {
    Leaf -> Node(Leaf, x, Leaf),
    Node(l, y, r) -> if x < y { Node(insert(l, x), y, r) } else if x > y { Node(l, y, insert(r, x)) } else { t },
  }
}
fn tree_list(t) { match t { Leaf -> [], Node(l, x, r) -> append(tree_list(l), [x, ..tree_list(r)]) } }
fn show_tree(t) { match t { Leaf -> ".", Node(l, x, r) -> "(" ++ show_tree(l) ++ int_to_string(x) ++ show_tree(r) ++ ")" } }
fn show_shape(s) { match s { Circle(r) -> "C" ++ int_to_string(r), Rect(w, h) -> "R" ++ int_to_string(w) ++ "x" ++ int_to_string(h), Dot -> "D" } }
fn show_color(c) { match c { Red -> "red", Green -> "green", Blue -> "blue" } }
fn small(n) { abs(n % 7) }
`;

// A small, fast, seedable random number generator (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(seed) {
  const rand = rng(seed);
  const int = (n) => Math.floor(rand() * n);
  const pick = (xs) => xs[int(xs.length)];
  const chance = (p) => rand() < p;
  let names = 0;
  const fresh = (p) => `${p}${names++}`;
  const fns = []; // { name, params: [types], ret }

  const show = (t, e) => {
    switch (t) {
      case T.int: return `int_to_string(${e})`;
      case T.bool: return `(if ${e} { "T" } else { "F" })`;
      case T.str: return `("<" ++ ${e} ++ ">")`;
      case T.ints: return `show_list(${e}, int_to_string)`;
      case T.strs: return `show_list(${e}, |s| s)`;
      case T.opt: return `(match ${e} { Some(x) -> "S" ++ int_to_string(x), None -> "N" })`;
      case T.pair: return `(match ${e} { (n, s) -> int_to_string(n) ++ "/" ++ s })`;
      case T.tree: return `show_tree(${e})`;
      case T.shape: return `show_shape(${e})`;
      case T.color: return `show_color(${e})`;
      case T.arr: return `show_list(array_to_list(${e}), int_to_string)`;
      case T.sarr: return `show_list(array_to_list(${e}), |s| s)`;
      case T.fn: return `int_to_string((${e})(3))`;
      case T.nested: return `show_list(${e}, |xs| show_list(xs, int_to_string))`;
      default: throw new Error(t);
    }
  };

  const SMALL = ['0', '1', '2', '3', '7', '-1', '-5', '10', '100'];
  const BIG = ['9223372036854775807', '-9223372036854775808', '4611686018427387904', '3037000499'];
  const intLit = () => (chance(0.1) ? pick(BIG) : pick(SMALL));
  const STRS = ['""', '"a"', '"b"', '"ab"', '"hello"', '"Zz"', '"0"', '"mid dle"'];

  // An expression of type t. env: [{ name, t }].
  function gen(t, d, env) {
    const vars = env.filter((v) => v.t === t);
    if (d <= 0 || chance(0.15)) {
      if (vars.length && chance(0.6)) return pick(vars).name;
      return leaf(t, env);
    }
    const r = rand();
    if (r < 0.08) return `{ ${letStmt(d, env, (env2) => gen(t, d - 1, env2))} }`;
    if (r < 0.14) return `(if ${gen(T.bool, d - 1, env)} { ${gen(t, d - 1, env)} } else { ${gen(t, d - 1, env)} })`;
    if (r < 0.24) return matchExpr(t, d, env);
    if (r < 0.28) {
      const callable = fns.filter((f) => f.ret === t);
      if (callable.length) { const f = pick(callable); return `${f.name}(${f.params.map((p) => gen(p, d - 1, env)).join(', ')})`; }
    }
    if (r < 0.31 && t !== T.fn) {
      const x = fresh('v'), pt = pick([T.int, T.str, T.ints]);
      return `(|${x}| ${gen(t, d - 1, [...env, { name: x, t: pt }])})(${gen(pt, d - 1, env)})`;
    }
    return specific(t, d, env);
  }

  function letStmt(d, env, k) {
    const lt = pick(VALUE_TYPES);
    const x = fresh('l');
    return `let ${x} = ${gen(lt, d - 1, env)}; ${k([...env, { name: x, t: lt }])}`;
  }

  function leaf(t, env) {
    switch (t) {
      case T.int: return intLit();
      case T.bool: return pick(['true', 'false']);
      case T.str: return pick(STRS);
      case T.ints: return pick(['[]', '[1, 2, 3]', '[5]', '[3, 1, 2, 1]', '[-2, 0]']);
      case T.strs: return pick(['[]', '["x", "y"]', '["b", "a", "b"]']);
      case T.opt: return pick(['None', 'Some(4)', 'Some(-1)']);
      case T.pair: return `(${intLit()}, ${pick(STRS)})`;
      case T.tree: return pick(['Leaf', 'Node(Leaf, 5, Leaf)', 'insert(insert(Leaf, 2), 9)']);
      case T.shape: return pick(['Dot', 'Circle(2)', 'Rect(3, 4)']);
      case T.color: return pick(['Red', 'Green', 'Blue']);
      case T.arr: return pick(['array_empty()', 'array_make(3, 0)', 'array_from_list([4, 5, 6])', 'array_from_list(range(0, 9))']);
      case T.sarr: return pick(['array_empty()', 'array_make(4, "s")', 'array_from_list(["p", "q", "r"])']);
      case T.fn: {
        const named = fns.filter((f) => f.ret === T.int && f.params.length === 1 && f.params[0] === T.int);
        if (named.length && chance(0.3)) return pick(named).name;
        const x = fresh('a');
        const ints = env.filter((v) => v.t === T.int).map((v) => v.name);
        return `|${x}| ${pick([`${x} + 1`, `${x} * 2`, `0 - ${x}`, ints.length ? `${x} + ${pick(ints)}` : `${x} % 5`])}`;
      }
      case T.nested: return pick(['[]', '[[1], [2, 3]]', '[[], [0]]']);
      default: throw new Error(t);
    }
  }

  function lambda1(pt, rt, d, env) {
    const x = fresh('x');
    return `|${x}| ${gen(rt, d - 1, [...env, { name: x, t: pt }])}`;
  }

  function specific(t, d, env) {
    const g = (u) => gen(u, d - 1, env);
    // Indices and sizes: mostly in range, sometimes not.
    const idx = () => (chance(0.75) ? pick(['0', '0', '1', '2']) : chance(0.7) ? `(small(${g(T.int)}) % 3)` : g(T.int));
    const size = () => (chance(0.5) ? `small(${g(T.int)})` : `(small(${g(T.int)}) * ${pick(['3', '5', '8'])})`);
    const cmpTy = () => pick(COMPARABLE);
    switch (t) {
      case T.int: return pick([
        () => `(${g(T.int)} ${pick(['+', '-', '*', '/', '%'])} ${chance(0.5) ? pick(['2', '3', '-7', '10']) : g(T.int)})`,
        () => `(${g(T.int)} + ${g(T.int)})`,
        () => `(-${g(T.int)})`,
        () => `length(${g(T.ints)})`, () => `sum(${g(T.ints)})`, () => `string_length(${g(T.str)})`,
        () => `char_code_at(${g(T.str)}, ${idx()})`, () => `array_get(${g(T.arr)}, ${idx()})`,
        () => `array_length(${g(T.sarr)})`, () => `unwrap_or(${g(T.opt)}, ${g(T.int)})`,
        () => `(${g(T.fn)})(${g(T.int)})`, () => `min(${g(T.int)}, ${g(T.int)})`, () => `abs(${g(T.int)})`,
        () => { const a = fresh('acc'), x = fresh('x'); return `fold(${g(T.ints)}, ${g(T.int)}, |${a}, ${x}| ${gen(T.int, d - 1, [...env, { name: a, t: T.int }, { name: x, t: T.int }])})`; },
        () => `length(tree_list(${g(T.tree)}))`,
      ])();
      case T.bool: return pick([
        () => { const u = cmpTy(); return `(${g(u)} ${pick(['==', '!=', '<', '<=', '>', '>='])} ${g(u)})`; },
        () => `(${g(T.bool)} ${pick(['&&', '||'])} ${g(T.bool)})`, () => `!${g(T.bool)}`,
        () => `is_empty(${g(T.ints)})`, () => `contains(${g(T.strs)}, ${g(T.str)})`,
        () => `any(${g(T.ints)}, ${lambda1(T.int, T.bool, d, env)})`, () => `all(${g(T.ints)}, ${lambda1(T.int, T.bool, d, env)})`,
      ])();
      case T.str: return pick([
        () => `(${g(T.str)} ++ ${g(T.str)})`, () => `int_to_string(${g(T.int)})`,
        () => `substring(${g(T.str)}, ${idx()}, ${idx()})`, () => `char_from_code(${pick(['65', '97', '48', '255', '256', '-1'])} + ${idx()})`,
        () => `join(${g(T.strs)}, ${g(T.str)})`, () => { const u = pick(VALUE_TYPES); return show(u, g(u)); },
        () => persist(d, env),
        () => `repeat_string(${g(T.str)}, small(${g(T.int)}))`, () => `array_get(${g(T.sarr)}, ${idx()})`,
      ])();
      case T.ints: return pick([
        () => `[${Array.from({ length: int(4) }, () => g(T.int)).join(', ')}]`, () => `[${g(T.int)}, ..${g(T.ints)}]`,
        () => `range(${g(T.int)} % 3, ${size()})`, () => `map(range(0, ${size()}), ${g(T.fn)})`, () => `map(${g(T.ints)}, ${lambda1(T.int, T.int, d, env)})`,
        () => `filter(${g(T.ints)}, ${lambda1(T.int, T.bool, d, env)})`, () => `reverse(${g(T.ints)})`,
        () => `append(${g(T.ints)}, ${g(T.ints)})`, () => `sort(${g(T.ints)})`, () => `take(${g(T.ints)}, ${idx()})`,
        () => `drop(${g(T.ints)}, ${idx()})`, () => `concat(${g(T.nested)})`, () => `array_to_list(${g(T.arr)})`,
        () => `tree_list(${g(T.tree)})`, () => `map(${g(T.ints)}, ${g(T.fn)})`,
      ])();
      case T.strs: return pick([
        () => `[${Array.from({ length: int(3) }, () => g(T.str)).join(', ')}]`, () => `map(${g(T.ints)}, ${lambda1(T.int, T.str, d, env)})`,
        () => `sort(${g(T.strs)})`, () => `reverse(${g(T.strs)})`, () => `[${g(T.str)}, ..${g(T.strs)}]`, () => `array_to_list(${g(T.sarr)})`,
      ])();
      case T.opt: return pick([
        () => `Some(${g(T.int)})`, () => `head(${g(T.ints)})`, () => `find(${g(T.ints)}, ${lambda1(T.int, T.bool, d, env)})`,
        () => `nth(${g(T.ints)}, ${idx()})`, () => `map_option(${g(T.opt)}, ${g(T.fn)})`,
      ])();
      case T.pair: return pick([() => `(${g(T.int)}, ${g(T.str)})`, () => `(match ${g(T.pair)} { (n, s) -> (${gen(T.int, d - 1, env)}, s ++ "!") })`])();
      case T.tree: return pick([
        () => `Node(${g(T.tree)}, ${g(T.int)}, ${g(T.tree)})`, () => `insert(${g(T.tree)}, ${g(T.int)})`,
        () => `fold(${g(T.ints)}, ${g(T.tree)}, insert)`, () => `fold(range(0, ${size()}), ${g(T.tree)}, |t, i| insert(t, (i * ${pick(['7', '13', '-3'])}) % 17))`,
      ])();
      case T.shape: return pick([() => `Circle(${g(T.int)})`, () => `Rect(${g(T.int)}, ${g(T.int)})`, () => 'Dot'])();
      case T.color: return pick(['Red', 'Green', 'Blue']);
      case T.arr: return pick([
        () => `array_make(${size()}, ${g(T.int)})`, () => `array_set(${g(T.arr)}, ${idx()}, ${g(T.int)})`,
        () => `array_push(${g(T.arr)}, ${g(T.int)})`, () => `array_from_list(${g(T.ints)})`,
      ])();
      case T.sarr: return pick([
        () => `array_make(${size()}, ${g(T.str)})`, () => `array_set(${g(T.sarr)}, ${idx()}, ${g(T.str)})`,
        () => `array_push(${g(T.sarr)}, ${g(T.str)})`, () => `array_from_list(${g(T.strs)})`,
      ])();
      case T.fn: return pick([
        () => lambda1(T.int, T.int, d, env),
        () => { const f = fresh('f'), h = fresh('h'); return `{ let ${f} = ${g(T.fn)}; let ${h} = ${g(T.fn)}; |x| ${f}(${h}(x)) }`; },
      ])();
      case T.nested: return pick([
        () => `[${g(T.ints)}, ${g(T.ints)}]`, () => `map(${g(T.ints)}, |n| range(0, small(n)))`, () => `[${g(T.ints)}, ..${g(T.nested)}]`,
      ])();
      default: throw new Error(t);
    }
  }

  // Values are persistent: updating one must leave the original unchanged.
  function persist(d, env) {
    const a = fresh('old'), b = fresh('new');
    const g = (u) => gen(u, d - 1, env);
    const [t, update] = pick([
      [T.arr, (x) => `array_set(${x}, ${pick(['0', '1'])}, ${g(T.int)})`],
      [T.arr, (x) => `array_push(${x}, ${g(T.int)})`],
      [T.sarr, (x) => `array_set(${x}, 0, ${g(T.str)})`],
      [T.ints, (x) => `reverse(${x})`],
      [T.tree, (x) => `insert(${x}, ${g(T.int)})`],
      [T.strs, (x) => `sort(${x})`],
    ]);
    return `{ let ${a} = ${g(t)}; let ${b} = ${update(a)}; ${show(t, a)} ++ "|" ++ ${show(t, b)} ++ "|" ++ ${show(t, a)} }`;
  }

  function matchExpr(t, d, env) {
    const g = (u, e2 = env) => gen(u, d - 1, e2);
    const v = (p) => fresh(p);
    switch (int(7)) {
      case 0: {
        const x = v('x'), y = v('y'), rest = v('r');
        return `(match ${g(T.ints)} {
      [] -> ${g(t)},
      [${x}] if ${g(T.bool, [...env, { name: x, t: T.int }])} -> ${g(t, [...env, { name: x, t: T.int }])},
      [${x}, ${y}, ..${rest}] -> ${g(t, [...env, { name: x, t: T.int }, { name: y, t: T.int }, { name: rest, t: T.ints }])},
      _ -> ${g(t)},
    })`;
      }
      case 1: { const x = v('x'); return `(match ${g(T.opt)} { Some(0) -> ${g(t)}, Some(${x}) -> ${g(t, [...env, { name: x, t: T.int }])}, None -> ${g(t)} })`; }
      case 2: {
        const l = v('l'), x = v('x'), r = v('r');
        return `(match ${g(T.tree)} { Leaf -> ${g(t)}, Node(${l}, ${x}, ${r}) -> ${g(t, [...env, { name: l, t: T.tree }, { name: x, t: T.int }, { name: r, t: T.tree }])} })`;
      }
      case 3: {
        const a = v('w'), b = v('h');
        return `(match ${g(T.shape)} { Circle(${a}) if ${a} > 1 -> ${g(t, [...env, { name: a, t: T.int }])}, Rect(${a}, ${b}) -> ${g(t, [...env, { name: a, t: T.int }, { name: b, t: T.int }])}, _ -> ${g(t)} })`;
      }
      case 4: { const n = v('n'), s = v('s'); return `(match ${g(T.pair)} { (${n}, ${s}) -> ${g(t, [...env, { name: n, t: T.int }, { name: s, t: T.str }])} })`; }
      case 5: return `(match ${g(T.int)} { 0 -> ${g(t)}, 1 -> ${g(t)}, _ -> ${g(t)} })`;
      default: return `(match ${g(T.str)} { "a" -> ${g(t)}, "" -> ${g(t)}, _ -> ${g(t)} })`;
    }
  }

  // Top-level functions, then main.
  const out = [DECLS];
  const nFns = 1 + int(4);
  for (let i = 0; i < nFns; i++) {
    const params = Array.from({ length: int(3) + (chance(0.3) ? 0 : 1) }, () => pick(Object.values(T)));
    const ret = pick(Object.values(T));
    const name = fresh('f');
    const ps = params.map((p) => ({ name: fresh('p'), t: p }));
    out.push(`fn ${name}(${ps.map((p) => p.name).join(', ')}) { ${gen(ret, 3, ps)} }`);
    fns.push({ name, params, ret });
  }
  // A structurally recursive function over a list.
  if (chance(0.5)) {
    const name = fresh('rec');
    const x = fresh('x'), rest = fresh('rest'), acc = fresh('acc');
    const env = [{ name: x, t: T.int }, { name: rest, t: T.ints }, { name: acc, t: T.int }];
    out.push(`fn ${name}(xs, ${acc}) { match xs { [] -> ${acc}, [${x}, ..${rest}] -> ${name}(${rest}, ${gen(T.int, 2, env)}) } }`);
    fns.push({ name, params: [T.ints, T.int], ret: T.int });
  }
  const stmts = [];
  const env = [];
  const nStmts = 2 + int(6);
  for (let i = 0; i < nStmts; i++) {
    const t = pick(Object.values(T));
    if (chance(0.4) && t !== T.fn) {
      const x = fresh('m');
      stmts.push(`let ${x} = ${gen(t, 4, env)};`);
      env.push({ name: x, t });
      stmts.push(`println(${show(t, x)});`);
    } else stmts.push(`println(${show(t, gen(t, 4, env))});`);
    // Now and then, something big enough to exercise long lists, deep trees and in-place updates.
    if (chance(0.25)) {
      const n = pick(['200', '1000', '5000']);
      stmts.push(pick([
        `println(int_to_string(sum(map(range(0, ${n}), ${leaf(T.fn, env)}))));`,
        `println(int_to_string(length(tree_list(fold(range(0, ${n}), Leaf, |t, i| insert(t, (i * 7919) % ${n}))))));`,
        `println(show_list(take(reverse(sort(map(range(0, ${n}), |i| (i * 37) % 101))), 5), int_to_string));`,
        `println(int_to_string(array_length(fold(range(0, ${n}), array_empty(), |a, i| array_push(a, i)))));`,
        `println(int_to_string(array_get(fold(range(0, ${n}), array_make(${n}, 0), |a, i| array_set(a, i, i * 2)), ${n} - 1)));`,
        `println(join(take(map(range(0, ${n}), int_to_string), 4), "+") ++ int_to_string(length(append(range(0, ${n}), range(0, ${n})))));`,
      ]));
    }
  }
  out.push(`fn main() {\n  ${stmts.join('\n  ')}\n}`);
  return out.join('\n');
}

// ---------------------------------------------------------- differential --
// Returns null when all runs agree, a description of the disagreement
// otherwise, or 'skip' when the interpreter ran out of fuel or stack.
export function differential(src, { mutant = null, maxSteps = 3000000 } = {}) {
  const c = checkSource(src);
  if (!c.ok) return `does not check: ${c.errors[0].message}`;
  let ref;
  try { ref = interpret(c.program, { maxSteps }); } catch (e) { ref = { output: e.output ?? '', error: e.message }; }
  if (ref.error === 'out of fuel' || ref.error === 'stack overflow') return 'skip';
  const modes = [{ paranoid: false }, { paranoid: true }, { reuse: false }];
  for (const mode of modes) {
    let r;
    try { r = runWasm(compileProgram(c.program, { ...mode, mutant }).bytes); } catch (e) { return `${JSON.stringify(mode)}: compiler crashed: ${e.stack}`; }
    if (r.output !== ref.output || r.error !== ref.error) {
      return `${JSON.stringify(mode)}: interpreter printed ${JSON.stringify(ref.output.slice(-200))} and stopped with ${ref.error}; wasm printed ${JSON.stringify(r.output.slice(-200))} and stopped with ${r.error}`;
    }
    if (!r.error && r.live !== 0) return `${JSON.stringify(mode)}: ${r.live} objects were never freed`;
  }
  return null;
}

// Planted bugs: each must be caught by the differential check.
export const MUTANTS = [
  'perceus-transfer-live', // pass ownership of a variable that is still needed: a missing dup
  'perceus-no-post-drop', // forget to drop variables last used by a borrowing instruction
  'perceus-drop-borrowed', // drop a variable before the instruction that borrows it
  'capture-no-dup', // read a closure's captured value without taking a reference
  'reuse-shared', // reuse a cell even when it is shared
  'reuse-no-free', // forget to free a reuse token on a path that does not use it
  'array-set-shared', // update a shared array in place
  'drop-skip-last-field', // free an object without releasing its last field
  'add-no-overflow', // drop the overflow check on +
  'cmp-ignore-tag', // compare constructors by their fields only
  'substring-end', // off by one at the end of a substring
];

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--mutants') {
    const budget = Number(args[1] ?? 300);
    let missed = 0;
    for (const mutant of MUTANTS) {
      let caught = null;
      for (let seed = 1; seed <= budget && !caught; seed++) {
        const d = differential(generate(seed), { mutant });
        if (d && d !== 'skip') caught = seed;
      }
      console.log(`${mutant.padEnd(24)} ${caught ? `caught by seed ${caught}` : `NOT CAUGHT in ${budget} seeds`}`);
      if (!caught) missed++;
    }
    process.exit(missed ? 1 : 0);
  }
  const count = Number(args[0] ?? 200);
  const first = Number(args[1] ?? 1);
  let skipped = 0, failed = 0;
  for (let seed = first; seed < first + count; seed++) {
    const src = generate(seed);
    const d = differential(src);
    if (d === 'skip') { skipped++; continue; }
    if (d) {
      failed++;
      console.log(`seed ${seed}: ${d}\n${src}\n`);
      if (failed >= 3) break;
    }
  }
  console.log(`${count} programs, ${skipped} skipped (interpreter out of fuel or stack), ${failed} disagreements`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
