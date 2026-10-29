// Small programs that pin down the corners of SPEC.md. Expected output is
// produced by the reference implementation when scoring.

const main = (body, decls = '') => `${decls}\nfn main() {\n${body}\n}\n`;
const show = (e) => `println(int_to_string(${e}));`;

export const PROBES = [
  ['int wrap-around', main([show('1073741823 + 1'), show('-1073741824 - 1'), show('65536 * 65536'), show('46341 * 46341'), show('-(-1073741824)')].join('\n'))],
  ['division and remainder signs', main([show('7 / 2'), show('-7 / 2'), show('7 % -2'), show('-7 % 2'), show('-1073741824 / -1')].join('\n'))],
  ['division by zero keeps earlier output', main('println("before"); println(int_to_string(1 / (2 - 2))); println("after");')],
  ['remainder by zero', main(show('5 % 0'))],
  ['byte strings', main([
    show('string_length("héllo ✓")'),
    'println(substring("hello world", 6, 100) ++ "|" ++ substring("abc", -5, 2) ++ "|" ++ substring("abc", 2, 1) ++ "|");',
    show('char_code_at("é", 1)'),
    'println(char_from_code(72) ++ char_from_code(105 + 256) ++ char_from_code(-191));',
    'println("tab\\tquote\\"backslash\\\\hex\\x41");',
  ].join('\n'))],
  ['index out of bounds', main(show('char_code_at("abc", 3)'))],
  ['negative index', main(show('char_code_at("abc", -1)'))],
  ['panic', main('println("x"); panic("boom")')],
  ['structural ordering', main([
    'let b = |x| if x { "T" } else { "F" };',
    ...[['[1, 2]', '[1, 3]'], ['[1]', '[1, 0]'], ['None', 'Some(0)'], ['Some(2)', 'Some(1)'], ['(1, "b")', '(1, "a")'], ['"ab"', '"abc"'], ['false', 'true'], ['Err(1)', 'Ok(5)']]
      .map(([x, y]) => `println(b(${x} < ${y}) ++ b(${x} == ${y}) ++ b(${x} >= ${y}));`),
  ].join('\n'))],
  ['constructor index ordering', main('println(show_list(sort([C, A(2), B, A(1), D(0)]), |x| match x { A(n) -> "A" ++ int_to_string(n), B -> "B", C -> "C", D(n) -> "D" }));', 'type T { A(Int), B, C, D(Int) }')],
  ['comparing functions: not reached', main('println(if (1, f) == (2, f) { "eq" } else { "ne" });', 'fn f(x) { x }')],
  ['comparing functions: reached', main('println("start"); println(if (1, f) == (1, f) { "eq" } else { "ne" });', 'fn f(x) { x }')],
  ['evaluation order', main(`
  let t = |s, v| { print(s); v };
  let r = t("a", 1) + t("b", 2) * t("c", 3);
  let f = t("f", |x, y| x - y);
  let p = (t("p", 1), t("q", 2));
  println(" " ++ int_to_string(f(t("x", 10), t("y", 4))) ++ " " ++ int_to_string(r));
  println(if t("l", false) && t("r", true) { "and" } else { "short-circuit" });`)],
  ['closures capture', main('let a = 1; let f = |x| { let b = x * 10; |y| a + b + y }; let g = f(2); println(int_to_string(g(300)));')],
  ['let-polymorphism', main('let pair = |x| (x, x); let (a, _) = pair(1); let (b, _) = pair("s"); println(int_to_string(a) ++ b);')],
  ['definition order', main('println(int_to_string(fst(swap((1, 2)))));', 'fn fst(p) { match p { (a, _) -> a } }\nfn swap(p) { match p { (a, b) -> (b, a) } }')],
  ['prelude shadowing', main('println(map(5)); println(show_list(reverse([1, 2]), int_to_string));', 'fn map(x) { "my map " ++ int_to_string(x) }')],
  ['list syntax ignores user Cons', main('println(show_list([1, 2], int_to_string)); match Cons(3) { Cons(n) -> println(int_to_string(n)), Nil -> () }', 'type Mine { Nil, Cons(Int) }')],
  ['first-class constructors and builtins', main('println(show_list(map(map([1, 2], Some), |o| unwrap_or(o, 0)), int_to_string)); each(["a", "b"], println);')],
  ['tail calls: one million iterations', main(show('go(1000000, 0)') + show('ping(1000001)'), 'fn go(n, acc) { if n == 0 { acc } else { go(n - 1, acc + 1) } }\nfn ping(n) { if n == 0 { 0 } else { pong(n - 1) } }\nfn pong(n) { if n == 0 { 1 } else { ping(n - 1) } }')],
  ['tail calls through closures', main(show('via(1000000)'), 'fn ping(n, pong) { if n == 0 { 7 } else { pong(n - 1) } }\nfn via(n) { fn pong(m) { ping(m, pong) } pong(n) }')],
  ['equality on long lists', main('println(if range(0, 200000) == range(0, 200000) { "equal" } else { "different" });')],
  ['nested patterns and guards', main(`
  let classify = |xs| match xs {
    [] -> "empty",
    [0, ..] -> "zero-first",
    [x] if x < 0 -> "negative",
    [_] -> "single",
    [a, b, ..rest] if a == b -> "pair+" ++ int_to_string(length(rest)),
    _ -> "other",
  };
  [[], [0, 5], [-3], [4], [7, 7, 1, 2], [1, 2]] |> each(|xs| println(classify(xs)));`)],
  ['string patterns', main('["a", "b", ""] |> each(|s| println(match s { "a" -> "A", "" -> "empty", other -> other ++ "!" }));')],
  ['garbage collection under load', main(`
  fn churn(k, acc) { if k == 0 { acc } else { churn(k - 1, acc + length(map(range(0, 2000), |i| (i, int_to_string(i))))) } }
  let kept = map(range(0, 1000), int_to_string);
  println(int_to_string(churn(300, 0)) ++ " " ++ unwrap_or(nth(kept, 999), "?"));`)],
  ['rejects a type error', main('let x = 1 + "a";')],
  ['rejects a non-exhaustive match', main('println(match Some(1) { Some(x) -> int_to_string(x) })')],
  ['rejects a refutable let', main('let Some(x) = Some(1);')],
  ['rejects an infinite type', main('let f = |x| x(x);')],
];
