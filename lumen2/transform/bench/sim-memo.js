#!/usr/bin/env node
// node sim-memo.js INPUT STATE_DIR UDF FILE... > OUTPUT
// A cache of the function's output by row, as a careful engineer would add
// one, for transform/bench/simulate.js: a row whose bytes the cache has
// seen, under the same version of the files FILE... (the function's code,
// and whatever else its author knew to list), takes the cached output; the
// other rows run in C (UDF, which reads the known names from KNOWN_NAMES),
// on every core. Every row is looked up, so deleted rows and rows with old
// timestamps are handled.
//
// A cache like this is right only if the function depends on nothing but
// the row and the files listed, and nothing checks that: simulate.js runs it
// once with only the code listed, and once with the file of names too.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [input, state, udf, ...files] = process.argv.slice(2);
mkdirSync(state, { recursive: true });
const cachePath = join(state, 'cache.tsv');
const h = createHash('sha256');
for (const f of files) h.update(readFileSync(f));
const version = h.digest('hex');
const lines = readFileSync(input, 'latin1').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const header = lines[0];

// The cache: a line with the code's version, then "row TAB output" lines.
const cache = new Map();
if (existsSync(cachePath)) {
  const c = readFileSync(cachePath, 'latin1').split('\n');
  if (c[0] === version) for (let i = 1; i < c.length; i++) { const t = c[i].indexOf('\t'); if (t > 0) cache.set(c[i].slice(0, t), c[i].slice(t + 1)); }
}
const missing = [];
for (let i = 1; i < lines.length; i++) if (!cache.has(lines[i])) missing.push(lines[i]);
const r = spawnSync(udf, [], { input: `${header}\n${missing.join('\n')}\n`, encoding: 'latin1', maxBuffer: 1 << 30, env: process.env });
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
const outs = r.stdout.split('\n');
for (let j = 0; j < missing.length; j++) cache.set(missing[j], outs[j + 1]);

const out = [outs[0]];
const keep = [version];
for (let i = 1; i < lines.length; i++) { const o = cache.get(lines[i]); out.push(o); keep.push(`${lines[i]}\t${o}`); }
writeFileSync(cachePath, `${keep.join('\n')}\n`, 'latin1');
process.stdout.write(`${out.join('\n')}\n`, 'latin1');
process.stderr.write(`transformed ${missing.length} rows\n`);
