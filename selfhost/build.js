#!/usr/bin/env node
// Concatenates selfhost/src/*.lm (Lumen has no modules) into selfhost/lumenc.lm
// and type-checks the result with the reference compiler. Diagnostics are
// mapped back to the part file and line they came from.
//
//   node selfhost/build.js            build + check
//   node selfhost/build.js --quiet    only report errors

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource, formatDiagnostic } from '../src/compiler.js';
import { lineCol } from '../src/diagnostics.js';

const here = dirname(fileURLToPath(import.meta.url));

export function buildSource() {
  const parts = readdirSync(join(here, 'src')).filter((f) => f.endsWith('.lm')).sort();
  let source = '';
  const ranges = [];
  for (const f of parts) {
    const text = readFileSync(join(here, 'src', f), 'utf8');
    const startLine = source.split('\n').length;
    ranges.push({ file: f, startLine, lines: text.split('\n').length });
    source += text.endsWith('\n') ? text : text + '\n';
  }
  return { source, ranges };
}

export function locate(ranges, line) {
  const r = [...ranges].reverse().find((x) => line >= x.startLine);
  return r ? `${r.file}:${line - r.startLine + 1}` : `line ${line}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { source, ranges } = buildSource();
  writeFileSync(join(here, 'lumenc.lm'), source);
  const r = checkSource(source);
  if (!r.ok) {
    const e = r.errors[0];
    const { line } = lineCol(source, e.span?.s ?? 0);
    console.error(`${locate(ranges, line)}\n${formatDiagnostic(source, e)}`);
    process.exit(1);
  }
  for (const w of r.warnings) {
    const { line } = lineCol(source, w.span.s);
    console.error(`warning at ${locate(ranges, line)}: ${w.message}`);
  }
  if (!process.argv.includes('--quiet')) {
    console.log(`selfhost/lumenc.lm: ${source.split('\n').length} lines, ${r.signatures.length} functions, types check`);
  }
}
