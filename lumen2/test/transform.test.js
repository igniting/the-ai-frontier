// lumen2 transform: a user's function over every line of a file. The
// contract is checked before anything runs; the output is the same on any
// number of threads, in any batch and chunk sizes; a failure names its line;
// and the library agrees with a JavaScript implementation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileTransform, runTransform, effectsOf } from '../src/transform.js';
import { runWasm } from '../src/runtime.js';

const example = (f) => readFileSync(new URL(`../transform/examples/${f}`, import.meta.url), 'utf8');
const bench = (f) => new URL(`../transform/bench/${f}`, import.meta.url).pathname;

// The JavaScript version of the library and of the orders transform (the
// benchmark's), run directly: the expected output.
const jsLib = new Function(`${readFileSync(bench('lib.js'), 'utf8')}\nreturn { fields, field, parseInt_, parseDecimal, showDecimal, csv, hash };`)();
const jsOrders = new Function(`${readFileSync(bench('lib.js'), 'utf8')}\n${readFileSync(bench('orders.js'), 'utf8')}\nreturn transform;`)();
const expected = (transform, text) => {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l, i) => transform(i + 1, l)).filter((r) => r !== null).map((r) => `${r}\n`).join('');
};

const orders = (rows, seed = 1) => spawnSync(process.execPath, [bench('gen-orders.js'), String(rows), String(seed)], { encoding: 'latin1', maxBuffer: 1 << 28 }).stdout;

const compiled = (udf, sizes) => {
  const t = compileTransform(udf, sizes);
  assert.ok(t.ok, t.errors?.join('\n'));
  return t;
};
const rejected = (udf) => {
  const t = compileTransform(udf);
  assert.equal(t.ok, false, 'the transform must be rejected');
  return t.errors.join('\n');
};

test('the orders example: the same output on 1 and 4 threads, in any batch and chunk sizes, as JavaScript computes', () => {
  const text = orders(5000, 7);
  const want = expected(jsOrders, text);
  assert.ok(want.split('\n').length > 1000);
  for (const sizes of [{}, { batch: 100, chunk: 7 }, { batch: 1, chunk: 1 }, { batch: 333, chunk: 1000 }]) {
    const t = compiled(example('orders.lm'), sizes);
    for (const threads of [1, 4]) {
      const r = runTransform(t, { input: text, threads });
      assert.ok(r.ok, r.error);
      assert.equal(r.lines, 5001);
      assert.equal(r.output, want, `${JSON.stringify(sizes)} on ${threads} threads`);
    }
  }
});

test('the logs example', () => {
  const t = compiled(example('logs.lm'));
  const text = [
    '203.0.113.9 - - [06/Nov/2026:10:00:00 +0000] "GET /index.html HTTP/1.1" 200 5120',
    '198.51.100.4 - - [06/Nov/2026:10:00:01 +0000] "POST /api/orders HTTP/1.1" 503 87',
    '198.51.100.4 - - [06/Nov/2026:10:00:02 +0000] "GET /api/orders?id=7 HTTP/1.1" 500 0',
    'not a log line',
    '192.0.2.1 - - [06/Nov/2026:10:00:03 +0000] "GET /health HTTP/1.1" 404 12',
    '',
  ].join('\n');
  const r = runTransform(t, { input: text, threads: 2 });
  assert.ok(r.ok, r.error);
  assert.equal(r.output, '10:00:01,503,POST,/api/orders\n10:00:02,500,GET,/api/orders\n');
});

test('the sensors example: floats parsed, converted and printed', () => {
  const t = compiled(example('sensors.lm'));
  const text = 'sensor,time,celsius\nA,10:00,21.5\nB,10:00,-40\nC,10:00,n/a\nA,10:05,30.25\nB,10:05,1e1\n';
  for (const threads of [1, 3]) {
    const r = runTransform(t, { input: text, threads });
    assert.ok(r.ok, r.error);
    assert.equal(r.output, 'sensor,time,fahrenheit,alert\nA,10:00,70.7,\nB,10:00,-40.0,\nA,10:05,86.5,high\nB,10:05,50.0,\n');
  }
});

test('a transform that could print, read, read the clock or use randomness is rejected, naming the functions', () => {
  let e = rejected('fn shout(s: String) -> String { println(s); s }\nfn transform(n: Int, line: String) -> Option<String> { Some(shout(line)) }\n');
  assert.match(e, /`transform` can write output, but a transform may only compute/);
  assert.match(e, /shout +fn\(String\) -> String ! output +\(line 1\)/);
  assert.match(e, /transform +fn\(Int, String\) -> Option<String> ! output +\(line 2\)/);
  e = rejected('fn transform(n: Int, line: String) -> Option<String> { if clock_ms() % 2 == 0 { None } else { Some(int_to_string(random_int(1, 6))) } }\n');
  assert.match(e, /can read the clock and use randomness/);
  e = rejected('fn transform(n: Int, line: String) -> Option<String> { Some(read_line()) }\n');
  assert.match(e, /can read input/);
  // Failing is allowed.
  const t = compiled('fn transform(n: Int, line: String) -> Option<String> { if n > 2 { panic("too many") } else { Some(line) } }\n');
  assert.deepEqual(effectsOf(t.signature), ['fail']);
});

test('the contract: the type of transform, no main, no tf_ names, errors at the line in the file', () => {
  assert.match(rejected('fn transform(n: Int, line: String) -> String { line }\n'), /must have the type `fn\(Int, String\) -> Option<String>`, but it has the type `fn\(Int, String\) -> String`/);
  assert.match(rejected('fn transform(line: String) -> Option<String> { Some(line) }\n'), /must have the type/);
  assert.match(rejected('fn transfrom(n: Int, line: String) -> Option<String> { Some(line) }\n'), /defines no transform/);
  assert.match(rejected('fn main() { () }\nfn transform(n: Int, line: String) -> Option<String> { None }\n'), /does not define `main`/);
  assert.match(rejected('fn tf_x() -> Int { 1 }\nfn transform(n: Int, line: String) -> Option<String> { None }\n'), /`tf_x`: names starting with `tf_` are the harness's/);
  assert.match(rejected('\n\nfn transform(n: Int, line: String) -> Option<String> { Some(line ++ 1) }\n'), /--> 3:/);
  // A name the library defines.
  assert.match(rejected('fn fields(s: String) -> Int { 1 }\nfn transform(n: Int, line: String) -> Option<String> { None }\n'), /fields/);
});

test('a failure names the first line that fails, on any number of threads; the batches before it are printed', () => {
  const text = orders(3000, 3);
  const udf = 'fn transform(n: Int, line: String) -> Option<String> {\n  let id = field(fields(line), 0);\n  if id == "100001234" || id == "100001250" || id == "100002900" { panic("bad order " ++ id) } else { Some(id) }\n}\n';
  for (const sizes of [{}, { batch: 100, chunk: 7 }, { batch: 1000, chunk: 1 }]) {
    const t = compiled(udf, sizes);
    for (const threads of [1, 4]) {
      const r = runTransform(t, { input: text, threads });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'line 1235: panic: bad order 100001234', `${JSON.stringify(sizes)} on ${threads} threads`);
      const printed = r.output.split('\n').filter(Boolean);
      const batch = sizes.batch ?? 4096;
      assert.equal(printed.length, Math.floor(1234 / batch) * batch, 'every batch before the failing one');
    }
  }
  const t = compiled('fn transform(n: Int, line: String) -> Option<String> { if n == 77 { Some(int_to_string(4611686018427387904 * n)) } else { None } }\n', { batch: 50, chunk: 4 });
  assert.equal(runTransform(t, { input: orders(100), threads: 3 }).error, 'line 77: integer overflow');
  // Every line before the failing one dropped: the batches print nothing.
  const rows = Array.from({ length: 3000 }, (_, i) => `row${i + 1}\n`).join('');
  const none = compiled('fn transform(n: Int, line: String) -> Option<String> { if line == "row1235" { panic("x") } else { None } }\n', { batch: 100, chunk: 7 });
  for (const threads of [1, 4]) assert.equal(runTransform(none, { input: rows, threads }).error, 'line 1235: panic: x');
});

test('the library agrees with JavaScript: CSV fields and lines, numbers, hashes', () => {
  // Random rows of fields, written as CSV by the JavaScript csv(); the Lumen 2
  // transform parses each line and prints every field's length and text,
  // then its numbers and hash.
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const alphabet = ['a', 'b', 'Z', ',', '"', ' ', '-', '.', '0', '7', '9'];
  const word = () => Array.from({ length: rnd(6) }, () => alphabet[rnd(alphabet.length)]).join('');
  const rows = Array.from({ length: 400 }, () => Array.from({ length: 1 + rnd(5) }, word));
  const text = rows.map((r) => `${jsLib.csv(r)}\n`).join('');
  const t = compiled([
    'fn show_opt(o: Option<Int>) -> String { match o { Some(x) -> int_to_string(x), None -> "none" } }',
    'fn transform(n: Int, line: String) -> Option<String> {',
    '  let row = fields(line);',
    '  Some(join(map(array_to_list(row), |f| int_to_string(string_length(f)) ++ ":" ++ f ++ ":" ++ show_opt(parse_int(f)) ++ ":" ++ show_opt(parse_decimal(f, 2)) ++ ":" ++ int_to_string(hash(f))), "|") ++ "|" ++ csv(array_to_list(row)))',
    '}',
  ].join('\n'), { batch: 64, chunk: 5 });
  const show = (x) => (x === null ? 'none' : String(x));
  const want = rows.map((r) => `${r.map((f) => `${f.length}:${f}:${show(jsLib.parseInt_(f))}:${show(jsLib.parseDecimal(f, 2))}:${jsLib.hash(f)}`).join('|')}|${jsLib.csv(r)}\n`).join('');
  const r = runTransform(t, { input: text, threads: 4 });
  assert.ok(r.ok, r.error);
  assert.equal(r.output, want);
});

test('the text functions', () => {
  const t = compiled([
    'fn transform(n: Int, line: String) -> Option<String> {',
    '  Some(join([lower(line), upper(line), "[" ++ trim(line) ++ "]", join(array_to_list(split(line, "ab")), "/"), replace_all(line, "ab", "X"),',
    '    if starts_with(line, " a") { "s" } else { "-" }, if ends_with(line, "b ") { "e" } else { "-" }, int_to_string(index_of(line, "ab")),',
    '    if includes(line, "Ab") { "i" } else { "-" }, show_decimal(0 - 1205, 2), show_decimal(7, 3), show_decimal(42, 0), pad_left("7", 3, "0"), chomp("x\\r\\n")], ";"))',
    '}',
  ].join('\n'));
  const r = runTransform(t, { input: ' aAbabZ, b \n', threads: 1 });
  assert.ok(r.ok, r.error);
  assert.equal(r.output, ' aababz, b ; AABABZ, B ;[aAbabZ, b]; aAb/Z, b ; aAbXZ, b ;s;e;4;i;-12.05;0.007;42;007;x\n');
});

test('input read a buffer at a time from a file, with lines longer than the buffer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumen2-transform-test-'));
  try {
    const long = 'x'.repeat(3 << 20);
    const text = `a,1\n${long},2\nb,3\n\nc`;
    const file = join(dir, 'in.csv');
    writeFileSync(file, text);
    const t = compiled('fn transform(n: Int, line: String) -> Option<String> { let row = fields(line); Some(int_to_string(n) ++ ":" ++ int_to_string(string_length(field(row, 0))) ++ ":" ++ field(row, 1)) }\n', { batch: 2, chunk: 1 });
    const fd = openSync(file, 'r');
    const r = runTransform(t, { input: { fd }, threads: 2 });
    closeSync(fd);
    assert.ok(r.ok, r.error);
    assert.equal(r.output, `1:1:1\n2:${3 << 20}:2\n3:1:3\n4:0:\n5:1:\n`);
    assert.equal(r.lines, 5);
    // The command, on standard input.
    const cli = spawnSync(process.execPath, [new URL('../bin/lumen2.js', import.meta.url).pathname, 'transform', new URL('../transform/examples/orders.lm', import.meta.url).pathname, '--threads', '2'], { input: orders(300), encoding: 'latin1' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, expected(jsOrders, orders(300)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runWasm reads lines from bytes as from a string', () => {
  const t = compiled('fn transform(n: Int, line: String) -> Option<String> { Some(int_to_string(n) ++ line) }\n');
  const a = runWasm(t.bytes, { input: 'x\ny\n', threads: 1 });
  const b = runWasm(t.bytes, { input: new TextEncoder().encode('x\ny\n'), threads: 1 });
  assert.equal(a.output, '1x\n2y\n');
  assert.equal(b.output, a.output);
  assert.equal(b.lines, 2);
});
