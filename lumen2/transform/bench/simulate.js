#!/usr/bin/env node
// node transform/bench/simulate.js [ROWS] [--days N] [--threads N]
// A month in the life of a pipeline that cleans a vendor file: every day a
// system exports it again, in full (default 500,000 rows), and a function
// matches each company name to the closest of a list of known names
// (transform/examples/match.lm). Each day the file changes as such files
// do: rows are appended (0.4%), corrected (0.1%, mostly recent ones),
// deleted (0.02%), and some arrive late, with yesterday's timestamp (0.02%).
// A new supplier starts appearing on day 10, and on day 15 the team adds it
// to the known names. On day 22 a correction updates 5% of the rows.
//
// Five ways to keep the output up to date, each run as its own process
// each day, and each day's output compared, row by row, with the right
// one (the function run over the whole file in C):
//   - run the function over the whole file again, in C on N threads;
//   - the incremental pattern of dbt and warehouse pipelines (transform the
//     rows updated since the last run, merge by id: sim-watermark.js);
//   - a cache of outputs by row and by the code's version (sim-memo.js),
//     and the same cache keyed by the file of names too, as an engineer who
//     knew the function reads it would key it;
//   - lumen2 transform --incremental.
// The first three run the function in C (match-file.c), which reads the
// known names from a file, as C and Python programs usually keep such data;
// in Lumen 2 they are part of the transform, the only place a transform
// can get them from. Python running the whole file again is estimated from
// a sample.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const valued = new Set(['--days', '--threads']);
const ROWS = Number(args.find((a, i) => /^\d+$/.test(a) && !valued.has(args[i - 1])) ?? 500000);
const DAYS = Number(opt('--days', 30));
const threads = Number(opt('--threads', 4));
const SUPPLIER_DAY = Math.round(DAYS / 3), NAMES_DAY = Math.round(DAYS / 2), BACKFILL_DAY = Math.round(DAYS * 0.73);

const here = new URL('.', import.meta.url).pathname;
const root = join(here, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'lumen2-simulate-'));
const at = (f) => join(dir, f);

// ------------------------------------------------------------- the data --

let x = 2463534242;
const rnd = (n) => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) % n; };
const template = readFileSync(join(root, 'transform', 'examples', 'match.lm'), 'utf8');
const listStart = template.indexOf('fn known()'), listEnd = template.indexOf('fn transform');
const baseNames = [...template.slice(listStart, listEnd).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const SUPPLIER = 'copper bay foods';
const letters = 'abcdefghijklmnopqrstuvwxyz';
const countries = ['AT', 'BE', 'DE', 'ES', 'FI', 'FR', 'IE', 'IT', 'NL', 'PT', 'US', 'GB', 'CA', 'JP', 'BR', 'IN'];
function misspell(s) {
  for (let k = [0, 0, 0, 1, 1, 2, 3][rnd(7)]; k > 0; k--) {
    const i = rnd(s.length);
    switch (rnd(4)) {
      case 0: s = s.slice(0, i) + letters[rnd(26)] + s.slice(i + 1); break;
      case 1: s = s.slice(0, i) + letters[rnd(26)] + s.slice(i); break;
      case 2: if (s.length > 3) s = s.slice(0, i) + s.slice(i + 1); break;
      default: if (i + 1 < s.length) s = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2); break;
    }
  }
  const c = rnd(3);
  return c === 1 ? s.replace(/\b[a-z]/g, (y) => y.toUpperCase()) : c === 2 ? s.toUpperCase() : s;
}
const company = (day) => {
  if (rnd(10) === 0) return Array.from({ length: 2 + rnd(2) }, () => Array.from({ length: 3 + rnd(6) }, () => letters[rnd(26)]).join('')).join(' ');
  return misspell(day >= SUPPLIER_DAY && rnd(20) === 0 ? SUPPLIER : baseNames[rnd(baseNames.length)]);
};
const amount = () => { const c = 100 + rnd(1000000); return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`; };
const DAY0 = Date.UTC(2026, 9, 1);
const stamp = (day) => new Date(DAY0 + day * 86400000 + rnd(86400) * 1000).toISOString().slice(0, 19) + 'Z';

// rows: [id, company, country, amount, updated_at], in id order; null when deleted.
const rows = [];
let nextId = 700000001;
const add = (day, when) => rows.push([String(nextId++), company(day), countries[rnd(countries.length)], amount(), stamp(when)]);
for (let i = 0; i < ROWS; i++) add(0, -30 + Math.floor((30 * i) / ROWS)); // a month of history
const live = () => rows.filter(Boolean);
const snapshot = () => `id,company,country,amount,updated_at\n${live().map((r) => r.join(',')).join('\n')}\n`;
const share = (f) => Math.max(1, Math.round(live().length * f));
function change(day) {
  const events = [];
  const appended = share(0.004);
  for (let k = appended; k > 0; k--) add(day, day);
  events.push(`${appended} appended`);
  const late = share(0.0002);
  for (let k = late; k > 0; k--) add(day, day - 1);
  events.push(`${late} late`);
  const n = rows.length;
  let updated = 0;
  for (let k = share(day === BACKFILL_DAY ? 0.05 : 0.001); k > 0; k--) {
    const i = day !== BACKFILL_DAY && rnd(5) > 0 ? n - 1 - rnd(Math.ceil(n / 10)) : rnd(n);
    const r = rows[i];
    if (!r) continue;
    if (day !== BACKFILL_DAY && rnd(2) === 0) r[1] = company(day); else r[3] = amount();
    r[4] = stamp(day);
    updated++;
  }
  events.push(`${updated} updated`);
  let deleted = 0;
  for (let k = share(0.0002); k > 0; k--) { const i = rnd(n); if (rows[i]) { rows[i] = null; deleted++; } }
  events.push(`${deleted} deleted`);
  return events.join(', ');
}

// ------------------------------------------------------------ the runs --

const udf = at('match-file');
execFileSync('cc', ['-O2', '-fopenmp', join(here, 'udf.c'), join(here, 'match-file.c'), '-o', udf]);
const env = { ...process.env, KNOWN_NAMES: at('names.txt'), OMP_NUM_THREADS: String(threads), XDG_CACHE_HOME: at('cache') };
const data = at('vendors.csv');
const run = (name, cmd, argv) => {
  const fd = openSync(data, 'r'), ofd = openSync(at(`${name}.out`), 'w');
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, argv, { stdio: [fd, ofd, 'pipe'], env });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  closeSync(fd); closeSync(ofd);
  if (r.status !== 0) throw new Error(`${name} failed: ${r.stderr}`);
  return ms;
};
const ways = [
  ['full', 'Run the function over the whole file again, in C', () => run('full', udf, [])],
  ['watermark', 'Transform rows updated since the last run, merge by id (dbt-style), in C', () => run('watermark', process.execPath, [join(here, 'sim-watermark.js'), data, at('watermark-state'), udf])],
  ['memo', 'Cache outputs by row and the code\'s version, in C', () => run('memo', process.execPath, [join(here, 'sim-memo.js'), data, at('memo-state'), udf, join(here, 'match-file.c')])],
  ['careful', 'The same cache, keyed by the names file too, in C', () => run('careful', process.execPath, [join(here, 'sim-memo.js'), data, at('careful-state'), udf, join(here, 'match-file.c'), at('names.txt')])],
  ['lumen2', 'lumen2 transform --incremental', () => run('lumen2', process.execPath, [join(root, 'bin', 'lumen2.js'), 'transform', at('vendors.lm'), '--input', data, '--incremental', '--state', at('lumen2-state'), '--threads', String(threads)])],
];

// Rows of an output that are not the right one's, by id: wrong, missing
// (the right output has the id, this one does not) and extra (the other way).
const byId = (text) => { const m = new Map(); for (const l of text.split('\n').slice(1)) if (l) m.set(l.slice(0, l.indexOf(',')), l); return m; };
function compare(right, got) {
  let wrong = 0, missing = 0, extra = 0;
  for (const [id, l] of right) { const g = got.get(id); if (g === undefined) missing++; else if (g !== l) wrong++; }
  for (const id of got.keys()) if (!right.has(id)) extra++;
  return { wrong, missing, extra, total: wrong + missing + extra };
}

// Python over the whole file, timed on a sample.
const sample = at('sample.csv');
writeFileSync(sample, `${snapshot().split('\n').slice(0, 2001).join('\n')}\n`, 'latin1');
const pt = process.hrtime.bigint();
spawnSync('python3', [join(here, 'udf.py'), join(here, 'match.py')], { stdio: [openSync(sample, 'r'), 'ignore', 'inherit'] });
const pythonPerRow = Number(process.hrtime.bigint() - pt) / 1e6 / 2000;

const log = [];
try {
  let names = baseNames.slice();
  for (let day = 0; day <= DAYS; day++) {
    const events = day === 0 ? `${ROWS.toLocaleString('en')} rows` : change(day);
    if (day === NAMES_DAY) names = [...names, SUPPLIER];
    writeFileSync(at('names.txt'), `${names.join('\n')}\n`);
    writeFileSync(at('vendors.lm'), template.slice(0, listStart) + `fn known() -> List<String> {\n  [\n${names.map((nm) => `    "${nm}"`).join(',\n')}\n  ]\n}\n\n` + template.slice(listEnd));
    writeFileSync(data, snapshot(), 'latin1');
    const entry = { day, events, rows: live().length, ms: {}, bad: {} };
    for (const [key, , f] of ways) entry.ms[key] = f();
    const right = byId(readFileSync(at('full.out'), 'latin1'));
    for (const [key] of ways) entry.bad[key] = compare(right, byId(readFileSync(at(`${key}.out`), 'latin1')));
    entry.ms.python = pythonPerRow * entry.rows;
    log.push(entry);
    process.stderr.write(`day ${day} (${events}${day === NAMES_DAY ? ', names changed' : ''}): ${ways.map(([k]) => `${k} ${(entry.ms[k] / 1000).toFixed(2)} s${entry.bad[k].total ? ` (${entry.bad[k].total} rows wrong)` : ''}`).join(', ')}\n`);
  }

  // ------------------------------------------------------------ the report --
  const secs = (ms) => (ms >= 100000 ? `${Math.round(ms / 60000)} min` : ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(2)} s`);
  const days = log.slice(1);
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const all = [...ways.map(([k, label]) => [k, label]), ['python', 'Run the function over the whole file again, in Python (estimated)']];
  console.log(`\n${ROWS.toLocaleString('en')} rows, ${DAYS} days after the first; the function and the strategies on ${threads} threads.\n`);
  console.log(`| Strategy | Days with a wrong output | Day 0 | Usual day (median) | Day ${NAMES_DAY}: names changed | Day ${BACKFILL_DAY}: 5% updated | Days 1 to ${DAYS} in all |`);
  console.log('|---|---|---|---|---|---|---|');
  for (const [k, label] of all) {
    const wrong = k === 'python' ? 0 : days.filter((e) => e.bad[k].total > 0).length;
    console.log(`| ${label} | ${wrong} of ${DAYS} | ${secs(log[0].ms[k])} | ${secs(median(days.map((e) => e.ms[k])))} | ${secs(log[NAMES_DAY].ms[k])} | ${secs(log[BACKFILL_DAY].ms[k])} | ${secs(days.reduce((t, e) => t + e.ms[k], 0))} |`);
  }
  const last = log[log.length - 1];
  console.log(`\nWrong rows on day ${DAYS}, of ${last.rows.toLocaleString('en')}:\n`);
  console.log('| Strategy | Wrong output | Missing | Deleted but still there |');
  console.log('|---|---|---|---|');
  for (const [k, label] of ways) console.log(`| ${label} | ${last.bad[k].wrong} | ${last.bad[k].missing} | ${last.bad[k].extra} |`);
  writeFileSync(join(process.env.SIMULATE_LOG ?? at('log.json')), JSON.stringify(log));
  // The tool under test, and the cache keyed by everything the function
  // reads, must be right every day.
  for (const k of ['lumen2', 'careful']) {
    const bad = log.filter((e) => e.bad[k].total > 0).map((e) => e.day);
    if (bad.length) { console.error(`${k} was wrong on days ${bad.join(', ')}`); process.exitCode = 1; }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
