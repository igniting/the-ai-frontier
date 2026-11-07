// lumen2 transform --incremental: a run over a changed file transforms only
// the chunks it has not seen, and its output is always exactly a full run's.
// Random edits (lines changed, inserted, deleted, appended, duplicated,
// moved; a missing last line break; CRLF; empty lines) on transforms that
// ignore the line number, compare it with constants, or use it; failures,
// budgets and broken state files; and the proof about line numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, truncateSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileTransform, runTransform } from '../src/transform.js';
import { lineThreshold, chunksOf, runIncremental, common, MIN_BYTES, MAX_BYTES } from '../src/incremental.js';

const dir = mkdtempSync(join(tmpdir(), 'lumen2-incremental-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cache = join(dir, 'cache');
const example = (f) => readFileSync(new URL(`../transform/examples/${f}`, import.meta.url), 'utf8');
const bench = (f) => new URL(`../transform/bench/${f}`, import.meta.url).pathname;
const orders = (rows, seed = 1) => spawnSync(process.execPath, [bench('gen-orders.js'), String(rows), String(seed)], { encoding: 'latin1', maxBuffer: 1 << 28 }).stdout;

const compiled = (udf, opts) => {
  const t = compileTransform(udf, { cache, ...opts });
  assert.ok(t.ok, t.errors?.join('\n'));
  return t;
};
// A transform compiled both ways: for incremental runs, and for full ones.
const both = (udf, opts = {}) => ({ inc: compiled(udf, { ...opts, chunked: true }), full: compiled(udf, opts) });

let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

// One incremental run over text, which must do exactly what a full run does.
let inputs = 0;
function step(p, text, state, threads) {
  const path = join(dir, `input-${inputs++ % 2}`);
  writeFileSync(path, text, 'latin1');
  const r = runIncremental(p.inc, { path, state, threads, normal: () => p.full });
  const f = runTransform(p.full, { input: Buffer.from(text, 'latin1'), threads });
  assert.equal(r.ok, f.ok, `ok: ${r.error} / ${f.error}`);
  assert.equal(r.error, f.error);
  assert.equal(r.output, f.output);
  return r;
}

// Random edits to an array of lines; extra() makes a new line.
function edit(lines, extra) {
  const at = () => rnd(lines.length + 1);
  switch (rnd(10)) {
    case 0: if (lines.length) lines[rnd(lines.length)] = extra(); break;
    case 1: lines.splice(at(), 0, ...Array.from({ length: 1 + rnd(5) }, extra)); break;
    case 2: if (lines.length) lines.splice(rnd(lines.length), 1 + rnd(5)); break;
    case 3: lines.push(...Array.from({ length: 1 + rnd(200) }, extra)); break;
    case 4: { const a = rnd(lines.length + 1); lines.splice(at(), 0, ...lines.slice(a, a + rnd(300))); break; } // a block twice
    case 5: { const a = rnd(lines.length + 1); const block = lines.splice(a, rnd(300)); lines.splice(at(), 0, ...block); break; } // a block moved
    case 6: if (lines.length) { const i = rnd(lines.length); lines[i] = `${lines[i]}\r`; } break;
    case 7: lines.splice(at(), 0, ''); break;
    case 8: if (lines.length > 10) lines.length -= rnd(Math.floor(lines.length / 2)); break;
    default: if (lines.length) lines[rnd(lines.length)] += 'x'; break;
  }
}
const text = (lines, lastBreak) => lines.join('\n') + (lastBreak && lines.length ? '\n' : '');

test('the chunks cover the file, end at line breaks, and do not move away from an edit', () => {
  for (let trial = 0; trial < 40; trial++) {
    const lines = Array.from({ length: rnd(3000) }, () => 'abcdefghij'.repeat(rnd(trial % 5 === 0 ? 9000 : 12)).slice(rnd(10)));
    const b = Buffer.from(text(lines, rnd(2) === 0), 'latin1');
    const { starts, counts } = chunksOf(b);
    assert.equal(starts[0], 0);
    assert.equal(starts[starts.length - 1], b.length);
    assert.equal(counts.length, starts.length - 1);
    let total = 0;
    for (let i = 0; i < counts.length; i++) {
      const c = b.subarray(starts[i], starts[i + 1]);
      assert.ok(c.length > 0);
      if (i < counts.length - 1) assert.equal(c[c.length - 1], 10, 'a chunk ends at a line break');
      const breaks = c.filter((x) => x === 10).length;
      assert.equal(counts[i], c[c.length - 1] === 10 ? breaks : breaks + 1);
      if (counts[i] > 1) assert.ok(c.length - (c.length - c.lastIndexOf(10, c.length - 2) - 1) < MAX_BYTES, 'only a chunk of one long line is longer than MAX_BYTES');
      total += counts[i];
    }
    assert.equal(total, b.length === 0 ? 0 : b.toString('latin1').split('\n').length - (b[b.length - 1] === 10 ? 1 : 0));
  }
  // An edit in the middle of a long file changes only the chunks around it.
  const lines = orders(20000).split('\n').slice(0, -1);
  const textBefore = text(lines, true);
  const before = chunksOf(Buffer.from(textBefore, 'latin1'));
  lines[10000] = 'something else entirely,,,';
  const after = chunksOf(Buffer.from(text(lines, true), 'latin1'));
  const set = (c, t) => new Set(c.starts.slice(0, -1).map((s, i) => t.slice(s, c.starts[i + 1])));
  const a = set(before, textBefore), b = set(after, text(lines, true));
  const changed = [...b].filter((x) => !a.has(x)).length;
  assert.ok(changed <= 3, `${changed} chunks changed`);
  assert.ok(MIN_BYTES < MAX_BYTES);
});

test('the lines in common: a longest common subsequence, as runs', () => {
  const lcs = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
    return d[a.length][b.length];
  };
  for (let t = 0; t < 3000; t++) {
    const a = Array.from({ length: rnd(30) }, () => rnd(1 + (t % 6))), b = Array.from({ length: rnd(30) }, () => rnd(1 + (t % 6)));
    let px = 0, py = 0, total = 0;
    for (const [x, y, len] of common(a.length, b.length, (i, j) => a[i] === b[j])) {
      assert.ok(x >= px && y >= py && len >= 1, 'runs in order');
      for (let i = 0; i < len; i++) assert.equal(a[x + i], b[y + i]);
      px = x + len; py = y + len; total += len;
    }
    assert.equal(total, lcs(a, b));
  }
  // Past 2000 differences: the lines in common at the two ends.
  const big = (k) => Array.from({ length: 3000 }, (_, i) => (i < 10 || i >= 2990 ? i : i * k));
  const a = big(2), b = big(3);
  assert.deepEqual(common(a.length, b.length, (i, j) => a[i] === b[j]), [[0, 0, 10], [2990, 2990, 10]]);
});

test('the proof about line numbers: the largest constant the number is compared with, or none', () => {
  const t = (body, param = 'n') => lineThreshold(`fn transform(${param}: Int, line: String) -> Option<String> { ${body} }\n`);
  assert.equal(t('Some(line)'), 0);
  assert.equal(t('if n == 1 { None } else { Some(line) }'), 1);
  assert.equal(t('if 1 == n { None } else { Some(line) }'), 1);
  assert.equal(t('if n <= 3 || n == 10 || n > 7 { None } else { Some(line) }'), 10);
  assert.equal(t('if n != 2 && n >= -5 { Some(line) } else { None }'), 2);
  assert.equal(t('let f = |s| if n == 4 { s } else { s ++ "!" }; Some(f(line))'), 4);
  assert.equal(t('if i == 1 { None } else { Some(line) }', 'i'), 1);
  // Any other use of the number: unknown.
  assert.equal(t('Some(int_to_string(n) ++ line)'), Infinity);
  assert.equal(t('if n % 2 == 0 { None } else { Some(line) }'), Infinity);
  assert.equal(t('if n == n { None } else { Some(line) }'), Infinity);
  assert.equal(t('if n < string_length(line) { None } else { Some(line) }'), Infinity);
  assert.equal(t('let k = n; if k == 1 { None } else { Some(line) }'), Infinity);
  // Another n (a let, a lambda's parameter, a pattern) is not told apart from it.
  assert.equal(t('let n = 5; if n == 1 { None } else { Some(line) }'), Infinity);
  assert.equal(t('let f = |n| n + 1; Some(line)'), Infinity);
  assert.equal(t('match Some(3) { Some(n) -> Some(line), None -> None }'), Infinity);
  assert.equal(lineThreshold('fn transform(n: Int) -> Int { n }\n'), Infinity);
  assert.equal(lineThreshold('this does not parse'), Infinity);
  assert.equal(lineThreshold(example('orders.lm')), 1);
});

// The transforms the random edits run: the orders example (which compares
// the number with 1), one that ignores it, one that compares it with
// several constants, one that prints it, and one whose outputs hold line
// breaks and empty strings.
const TRANSFORMS = {
  orders: example('orders.lm'),
  ignores: 'fn transform(n: Int, line: String) -> Option<String> { if string_length(line) % 3 == 0 { None } else { Some(upper(line)) } }\n',
  compares: 'fn transform(n: Int, line: String) -> Option<String> { if n <= 3 { Some("head " ++ line) } else if n == 40 { None } else if n > 25 { Some(line) } else { Some(lower(line)) } }\n',
  prints: 'fn transform(n: Int, line: String) -> Option<String> { if string_length(line) == 2 { None } else { Some(int_to_string(n) ++ ": " ++ line) } }\n',
  breaks: 'fn transform(n: Int, line: String) -> Option<String> { if string_length(line) % 4 == 1 { Some("") } else { Some(line ++ "\\n" ++ trim(line)) } }\n',
};

for (const [name, udf] of Object.entries(TRANSFORMS)) {
  test(`random edits, transform that ${name === 'orders' ? 'is the orders example' : name} the line number: always a full run's output`, () => {
    const p = both(udf);
    const pool = orders(4000, 3).split('\n').slice(1, -1);
    const extra = name === 'orders' ? () => pool[rnd(pool.length)] : () => `row ${rnd(100000)},${'xyz'.repeat(rnd(30))},${rnd(9)}`;
    const lines = name === 'orders' ? orders(3000).split('\n').slice(0, -1) : Array.from({ length: 3000 }, extra);
    const state = join(dir, `${name}.state`);
    let lastBreak = true, reused = 0, total = 0;
    const first = step(p, text(lines, lastBreak), state, 1);
    assert.equal(first.reusedChunks, 0);
    assert.equal(first.transformed, first.lines);
    for (let round = 0; round < 24; round++) {
      for (let e = 1 + rnd(3); e > 0; e--) edit(lines, extra);
      if (name === 'orders' && lines[0] !== orders(1).split('\n')[0]) lines.unshift(orders(1).split('\n')[0]);
      if (name === 'orders') for (let i = 1; i < lines.length; i++) if (!/^\d+,/.test(lines[i]) || lines[i].endsWith('x')) lines[i] = pool[rnd(pool.length)];
      if (rnd(6) === 0) lastBreak = !lastBreak;
      const r = step(p, text(lines, lastBreak), state, round % 2 ? 4 : 1);
      reused += r.lines - r.transformed; total += r.lines;
    }
    // Most lines' outputs were reused (every round makes a few edits); the
    // transform that prints the number loses the lines after an insertion
    // or a deletion.
    assert.ok(reused / total > (name === 'prints' ? 0.2 : 0.8), `${reused} of ${total} lines reused`);
  });
}

test('a changed line is the only line transformed, and nothing changed transforms nothing', () => {
  const p = both(TRANSFORMS.orders);
  const lines = orders(20000).split('\n').slice(0, -1);
  const state = join(dir, 'one.state');
  step(p, text(lines, true), state, 4);
  const same = step(p, text(lines, true), state, 4);
  assert.equal(same.transformed, 0);
  assert.equal(same.reusedChunks, same.chunks);
  const files = readdirSync(state).sort();
  assert.deepEqual(step(p, text(lines, true), state, 1).transformed, 0);
  assert.deepEqual(readdirSync(state).sort(), files, 'a run that changes nothing leaves the state alone');
  lines[12345] = lines[54];
  assert.equal(step(p, text(lines, true), state, 4).transformed, 1);
  lines.push(lines[99]);
  assert.equal(step(p, text(lines, true), state, 4).transformed, 1);
  // Line 1 is the header (the transform compares the number with 1): a line
  // inserted after it moves every other line down, and only it is transformed.
  lines.splice(1, 0, lines[5000]);
  assert.equal(step(p, text(lines, true), state, 1).transformed, 1);
  lines.splice(7000, 3);
  lines.splice(9000, 0, lines[1], lines[2]);
  assert.equal(step(p, text(lines, true), state, 4).transformed, 2);
  assert.equal(readdirSync(state).length, 3, 'the state is an index, an input and an output');
});

test('a run that fails is a full run, exactly, and leaves the state as it was', () => {
  const udf = 'fn transform(n: Int, line: String) -> Option<String> { if includes(line, "BOOM") { panic("boom at " ++ line) } else if includes(line, "SPIN") { Some(int_to_string(spin(0))) } else { Some(line) } }\nfn spin(k: Int) -> Int { if k < 0 { k } else { spin(k + 1) } }\n';
  const p = both(udf, { steps: 100000 });
  const lines = Array.from({ length: 9000 }, (_, i) => `line ${i} ${'.'.repeat(i % 50)}`);
  const state = join(dir, 'fails.state');
  step(p, text(lines, true), state, 4);
  for (const [bad, threads] of [['BOOM', 4], ['SPIN', 1], ['BOOM', 1]]) {
    const changed = lines.slice();
    changed[1234] = `a ${bad} here`;
    const r = step(p, text(changed, true), state, threads);
    assert.equal(r.ok, false);
    assert.equal(r.again, true);
    assert.equal(r.error, bad === 'BOOM' ? 'line 1235: panic: boom at a BOOM here' : 'line 1235: out of steps (each line may take 100,000 steps)');
  }
  const back = step(p, text(lines, true), state, 4);
  assert.equal(back.transformed, 0, 'the failed runs did not change the state');
  assert.equal(readdirSync(state).length, 3);
});

test('a broken or foreign state is ignored, and the output is still right', () => {
  const p = both(TRANSFORMS.ignores);
  const lines = Array.from({ length: 5000 }, (_, i) => `r${i},${i * 7 % 13}`);
  const state = join(dir, 'broken.state');
  step(p, text(lines, true), state, 2);
  const index = join(state, 'index');
  const named = (prefix) => { const head = JSON.parse(readFileSync(index, 'latin1').split('\n')[0]); return join(state, prefix === 'input-' ? head.input : head.output); };
  for (const damage of [
    () => truncateSync(index, Math.floor(statSync(index).size / 2)),
    () => writeFileSync(index, 'not a state'),
    () => truncateSync(index, 0),
    () => writeFileSync(index, `${JSON.stringify({ version: 3, program: p.inc.key, chunks: 2, lines: 3, keys: 3, input: 'x', inputLength: 9, output: 'y' })}\nab\ncd`),
    () => rmSync(named('output-')),
    () => truncateSync(named('output-'), 10),
    () => rmSync(named('input-')),
  ]) {
    lines[rnd(lines.length)] += '!'; // a change, so that the run writes a new state
    step(p, text(lines, true), state, 2);
    damage();
    const r = step(p, text(lines, true), state, 2);
    assert.equal(r.reusedChunks, 0);
    assert.equal(r.transformed, r.lines);
  }
  // A shortened input is no state either.
  lines[rnd(lines.length)] += '!';
  step(p, text(lines, true), state, 2);
  truncateSync(named('input-'), 100);
  lines[4000] += '?';
  assert.equal(step(p, text(lines, true), state, 2).reusedChunks, 0);
  rmSync(state, { recursive: true });
  // Another transform's state at the same path: nothing is reused.
  step(p, text(lines, true), state, 2);
  const other = both(TRANSFORMS.breaks);
  assert.equal(step(other, text(lines, true), state, 2).reusedChunks, 0);
  // An empty file, and a file of one line without a break.
  for (const t of ['', 'one line']) step(p, t, join(dir, 'tiny.state'), 1);
});

test('lumen2 transform --incremental: the command', () => {
  const input = join(dir, 'cli.csv');
  const state = join(dir, 'cli.state');
  writeFileSync(input, orders(5000), 'latin1');
  const cli = (...args) => spawnSync(process.execPath, [new URL('../bin/lumen2.js', import.meta.url).pathname, 'transform', new URL('../transform/examples/orders.lm', import.meta.url).pathname, '--input', input, ...args], { encoding: 'latin1', env: { ...process.env, XDG_CACHE_HOME: cache } });
  const full = cli();
  assert.equal(full.status, 0, full.stderr);
  const first = cli('--incremental', '--state', state, '--stats');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, full.stdout);
  assert.match(first.stderr, /^transformed 5,001 of 5,001 lines; reused the rest\n$/);
  const second = cli('--incremental', '--state', state, '--stats');
  assert.equal(second.stdout, full.stdout);
  assert.match(second.stderr, /^transformed 0 of 5,001 lines/);
  // Without --state, the state is kept in the cache.
  assert.equal(cli('--incremental').stdout, full.stdout);
  assert.match(cli('--incremental', '--stats').stderr, /^transformed 0 of/);
  assert.match(spawnSync(process.execPath, [new URL('../bin/lumen2.js', import.meta.url).pathname, 'transform', new URL('../transform/examples/orders.lm', import.meta.url).pathname, '--incremental'], { encoding: 'latin1', input: 'x\n' }).stderr, /--incremental: give the input with --input FILE/);
});
