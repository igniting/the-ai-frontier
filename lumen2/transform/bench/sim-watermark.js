#!/usr/bin/env node
// node sim-watermark.js INPUT STATE_DIR UDF > OUTPUT
// The incremental pattern of dbt's incremental models and most warehouse
// pipelines, for transform/bench/simulate.js: transform only the rows whose
// updated_at is later than the latest the last run saw, and merge their
// outputs into the last output by the row's id (the unique key). The
// function runs in C (UDF, which reads the known names from KNOWN_NAMES),
// on every core.
//
// It trusts updated_at, as that pattern does: a row that arrives with a
// timestamp older than the last run's latest is never transformed, a
// deleted row stays in the output, and a change to the reference data
// reaches only the rows transformed after it, until someone runs it again
// in full. The input is CSV whose first field is the id and whose last is
// updated_at, in a form that sorts as text.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [input, state, udf] = process.argv.slice(2);
mkdirSync(state, { recursive: true });
const tablePath = join(state, 'table.csv'), markPath = join(state, 'watermark');
const text = readFileSync(input, 'latin1');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const header = lines[0];
const mark = existsSync(markPath) ? readFileSync(markPath, 'latin1') : '';

// The rows to transform: those updated after the watermark.
const chosen = [];
let latest = mark;
for (let i = 1; i < lines.length; i++) {
  const updated = lines[i].slice(lines[i].lastIndexOf(',') + 1);
  if (updated > mark) { chosen.push(lines[i]); if (updated > latest) latest = updated; }
}
const r = spawnSync(udf, [], { input: `${header}\n${chosen.join('\n')}\n`, encoding: 'latin1', maxBuffer: 1 << 30, env: process.env });
if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
const outs = r.stdout.split('\n');
const outHeader = outs[0];

// Merged into the last output by id.
const table = new Map();
if (existsSync(tablePath)) {
  const old = readFileSync(tablePath, 'latin1').split('\n');
  for (let i = 1; i < old.length; i++) if (old[i]) table.set(old[i].slice(0, old[i].indexOf(',')), old[i]);
}
for (let i = 1; i < outs.length; i++) if (outs[i]) table.set(outs[i].slice(0, outs[i].indexOf(',')), outs[i]);
const ids = [...table.keys()].sort();
const out = `${outHeader}\n${ids.map((id) => table.get(id)).join('\n')}\n`;
writeFileSync(tablePath, out, 'latin1');
writeFileSync(markPath, latest, 'latin1');
process.stdout.write(out, 'latin1');
process.stderr.write(`transformed ${chosen.length} rows\n`);
