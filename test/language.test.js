// Language semantics. Every program runs three ways (interpreter, wasm, wasm
// with a GC on every allocation) and all three must agree exactly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, output, compileError, signatures } from './helpers.js';

const main = (body, decls = '') => `${decls}\nfn main() {\n${body}\n}`;
const show = (e) => `println(int_to_string(${e}));`;

describe('integers', () => {
  test('31-bit wrap-around', () => {
    assert.equal(output(main([
      show('1073741823 + 1'), show('-1073741824 - 1'), show('65536 * 65536'), show('46341 * 46341'), show('-(-1073741824)'),
    ].join('\n'))), '-1073741824\n1073741823\n0\n4633\n-1073741824\n');
  });
  test('division truncates toward zero; remainder has the sign of the dividend', () => {
    assert.equal(output(main([show('7 / 2'), show('-7 / 2'), show('7 % -2'), show('-7 % 2'), show('-1073741824 / -1')].join('\n'))),
      '3\n-3\n1\n-1\n-1073741824\n');
  });
  test('division by zero is a runtime error, after earlier output', () => {
    assert.deepEqual(run(main('println("before"); println(int_to_string(1 / (2 - 2))); println("after");')),
      { output: 'before\n', error: 'division by zero' });
    assert.equal(run(main(show('5 % 0'))).error, 'division by zero');
  });
});

describe('strings', () => {
  test('bytes, slicing and conversion', () => {
    assert.equal(output(main([
      show('string_length("héllo")'),
      'println(substring("hello world", 6, 100) ++ "|" ++ substring("abc", -5, 2) ++ "|" ++ substring("abc", 2, 1) ++ "|");',
      show('char_code_at("A", 0)'),
      'println(char_from_code(72) ++ char_from_code(105 + 256));',
      'println(int_to_string(-1073741824) ++ " " ++ int_to_string(0));',
      'println(join(chars("abc"), "-"));',
    ].join('\n'))), '6\nworld|ab||\n65\nHi\n-1073741824 0\na-b-c\n');
  });
  test('out-of-bounds indexing is a runtime error', () => {
    assert.equal(run(main(show('char_code_at("abc", 3)'))).error, 'index out of bounds');
    assert.equal(run(main(show('char_code_at("abc", -1)'))).error, 'index out of bounds');
  });
  test('read_input returns the host-supplied bytes', () => {
    const src = main('let s = read_input(); println(int_to_string(string_length(s)) ++ ":" ++ s ++ ":" ++ int_to_string(char_code_at(s, 1)));');
    assert.equal(run(src, { input: 'h\xc3\xa9!' }).output, '4:hé!:195\n');
    assert.equal(run(src, { input: '' }).error, 'index out of bounds');
  });
  test('parse_int is written in Lumen', () => {
    assert.equal(output(main('println(show_list(map(["42", "-7", "", "12x", "-"], |s| unwrap_or(parse_int(s), 999)), int_to_string));')),
      '[42, -7, 999, 999, 999]\n');
  });
});

describe('structural equality and ordering', () => {
  test('works on lists, options, tuples and strings', () => {
    const cmp = (a, b) => `println(show_bool(${a} < ${b}) ++ show_bool(${a} == ${b}));`;
    const decls = 'fn show_bool(b) { if b { "T" } else { "F" } }';
    assert.equal(output(main([
      cmp('[1, 2]', '[1, 3]'), cmp('[1, 2]', '[1, 2]'), cmp('[1]', '[1, 0]'),
      cmp('None', 'Some(0)'), cmp('Some(2)', 'Some(1)'),
      cmp('(1, "b")', '(1, "a")'), cmp('"ab"', '"abc"'), cmp('""', '""'),
    ].join('\n'), decls)), 'TF\nFT\nTF\nTF\nFF\nFF\nTF\nFT\n');
  });
  test('comparing functions fails only when a function is actually reached', () => {
    const decls = 'fn f(x) { x }';
    assert.equal(run(main('println(if (1, f) == (2, f) { "eq" } else { "ne" });', decls)).output, 'ne\n');
    assert.equal(run(main('println(if (1, f) == (1, f) { "eq" } else { "ne" });', decls)).error, 'cannot compare functions');
  });
  test('equality of long lists runs in constant stack', () => {
    assert.equal(output(main('println(if range(0, 300000) == range(0, 300000) { "equal" } else { "different" });'), { stress: false }), 'equal\n');
  });
});

describe('functions and closures', () => {
  test('closures capture variables, including from enclosing closures', () => {
    assert.equal(output(main(`
      let a = 1;
      let f = |x| { let b = x * 10; |y| a + b + y };
      let g = f(2);
      println(int_to_string(g(300)));
    `)), '321\n');
  });
  test('local recursive functions and mutual recursion at top level', () => {
    assert.equal(output(main(`
      fn fact(n) { if n <= 1 { 1 } else { n * fact(n - 1) } }
      println(int_to_string(fact(10)));
      println(show_list(map(range(0, 5), is_even), |b| if b { "e" } else { "o" }));
    `, 'fn is_even(n) { if n == 0 { true } else { is_odd(n - 1) } }\nfn is_odd(n) { if n == 0 { false } else { is_even(n - 1) } }')),
    '3628800\n[e, o, e, o, e]\n');
  });
  test('builtins and constructors can be used as first-class values', () => {
    assert.equal(output(main('let xs = map([1, 2], Some); println(show_list(map(xs, |o| unwrap_or(o, 0)), int_to_string)); each(["a", "b"], println);')),
      '[1, 2]\na\nb\n');
  });
  test('tail calls run in constant stack, including through closures', () => {
    // ping's call to `pong` is an indirect tail call (return_call_indirect).
    const decls = 'fn go(n, acc) { if n == 0 { acc } else { go(n - 1, acc + 1) } }\n' +
      'fn ping(n, pong) { if n == 0 { 0 } else { pong(n - 1) } }\n' +
      'fn via_closure(n) { fn pong(m) { ping(m, pong) } pong(n) }';
    assert.equal(output(main(show('go(1000000, 0)') + show('via_closure(1000000)'), decls), { stress: false }), '1000000\n0\n');
  });
  test('deep non-tail recursion reports a stack overflow instead of crashing', () => {
    const r = run(main(show('depth(10000000)'), 'fn depth(n) { if n == 0 { 0 } else { 1 + depth(n - 1) } }'));
    assert.equal(r.error, 'stack overflow');
  });
  test('evaluation order is left to right', () => {
    assert.equal(output(main(`
      let t = |s, v| { print(s); v };
      let r = t("a", 1) + t("b", 2) * t("c", 3);
      let f = t("f", |x, y| x - y);
      println(" " ++ int_to_string(f(t("x", 10), t("y", 4))) ++ " " ++ int_to_string(r));
    `)), 'abcfxy 6 7\n');
  });
});

describe('pattern matching', () => {
  test('nested patterns, literals, guards and list sugar', () => {
    assert.equal(output(main(`
      let classify = |xs| match xs {
        [] -> "empty",
        [0, ..] -> "starts with zero",
        [x] if x < 0 -> "single negative",
        [_] -> "single",
        [a, b, ..rest] if a == b -> "pair-prefix +" ++ int_to_string(length(rest)),
        _ -> "other",
      };
      [[], [0, 5], [-3], [4], [7, 7, 1, 2], [1, 2]] |> each(|xs| println(classify(xs)));
      println(match ("x", Some((1, true))) { ("x", Some((n, true))) -> int_to_string(n), _ -> "no" });
    `)), 'empty\nstarts with zero\nsingle negative\nsingle\npair-prefix +2\nother\n1\n');
  });
  test('user types may shadow prelude constructors; list syntax still means List', () => {
    assert.equal(output(main('println(show_list([1, 2], int_to_string)); match Cons(3) { Cons(n) -> println(int_to_string(n)), Nil -> () }',
      'type Mine { Nil, Cons(Int) }')), '[1, 2]\n3\n');
  });
  test('user functions may shadow prelude functions without breaking the prelude', () => {
    assert.equal(output(main('println(map(5)); println(show_list(reverse([1, 2]), int_to_string));', 'fn map(x) { "my map " ++ int_to_string(x) }')),
      'my map 5\n[2, 1]\n');
  });
});

describe('type inference', () => {
  test('infers principal types for polymorphic functions', () => {
    const sigs = signatures(`
      fn compose(f, g) { |x| f(g(x)) }
      fn pair_up(xs) { zip(xs, map(xs, |x| (x, x))) }
      fn count_matching(xs, p) { length(filter(xs, p)) }
      fn main() {}`);
    assert.equal(sigs.compose, 'fn(fn(a) -> b, fn(c) -> a) -> fn(c) -> b');
    assert.equal(sigs.pair_up, 'fn(List<a>) -> List<(a, (a, a))>');
    assert.equal(sigs.count_matching, 'fn(List<a>, fn(a) -> Bool) -> Int');
  });
  test('functions are generalized in dependency order, regardless of source order', () => {
    const sigs = signatures('fn main() { use_id() }\nfn use_id() { (id(1), id("x")) }\nfn id(x) { x }');
    assert.equal(sigs.use_id, 'fn() -> (Int, String)');
  });
  test('let-bound values are polymorphic', () => {
    assert.equal(output(main('let pair = |x| (x, x); let (a, _) = pair(1); let (b, _) = pair("s"); println(int_to_string(a) ++ b);')), '1s\n');
  });
  test('type errors', () => {
    assert.match(compileError(main('let x = 1 + "a";')), /`\+` needs Int operands: expected Int, found String/);
    assert.match(compileError(main('if 1 { 2 } else { 3 }')), /if condition: expected Bool, found Int/);
    assert.match(compileError(main('let f = |x| x(x);')), /infinite type/);
    assert.match(compileError(main('[1, "two"]')), /list elements must all have the same type: expected Int, found String/);
    assert.match(compileError(main('[1, ..["two"]]')), /the tail of a list .*: expected List<Int>, found List<String>/);
    assert.match(compileError('fn f(a, b) { a }\nfn main() { f(1) }'), /takes 2 arguments but 1 was supplied/);
    assert.match(compileError(main('lenght([1])')), /unknown variable `lenght`/);
    assert.match(compileError(main('let x: Int = "s";')), /expected Int, found String/);
    assert.match(compileError('fn main() -> Int { "s" }'), /return type: expected Int, found String/);
  });
  test('unknown names come with suggestions', () => {
    const r = compileError(main('println(int_to_strin(1))'));
    assert.match(r, /unknown variable/);
  });
});

describe('exhaustiveness', () => {
  test('reports a concrete missing value', () => {
    assert.match(compileError(main('match Some(1) { Some(_) -> 1 }')), /pattern `None` is not covered/);
    assert.match(compileError(main('match [1] { [] -> 0, [x] -> x }')), /pattern `\[_, _, \.\._\]` is not covered/);
    assert.match(compileError(main('match (true, false) { (true, _) -> 0, (_, true) -> 1 }')), /pattern `\(false, false\)` is not covered/);
    assert.match(compileError(main('match 3 { 0 -> 0, 1 -> 1 }')), /pattern `2` is not covered/);
    assert.match(compileError(main('match Some(1) { Some(x) if x > 0 -> 1, None -> 0 }')), /pattern `Some\(_\)` is not covered/);
    assert.match(compileError(main('let Some(x) = Some(1);')), /refutable pattern/);
  });
  test('accepts exhaustive matches over infinite types with a catch-all', () => {
    assert.equal(output(main('println(match "b" { "a" -> "A", s -> s ++ "!" });')), 'b!\n');
  });
});

test('strings longer than 2^23 - 1 bytes are a runtime error, in the interpreter too', () => {
  const r = run(`
    fn grow(s, n) { if n == 0 { s } else { grow(s ++ s, n - 1) } }
    fn main() { println(int_to_string(string_length(grow("ab", 21)))); println(int_to_string(string_length(grow("ab", 22)))); }
  `, { stress: false });
  assert.equal(r.output, '4194304\n');
  assert.equal(r.error, 'string too long');
});
