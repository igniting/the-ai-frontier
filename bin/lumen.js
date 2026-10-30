#!/usr/bin/env node
// Lumen command-line interface.
//
//   lumen run   <file.lm> [-O] [--interp] [--gc-stress] [--stats] [--input <file>]
//   lumen build <file.lm> [-O] [-o out.wasm]
//   lumen wat   <file.lm>          print the generated WebAssembly text
//   lumen ir    <file.lm>          print the A-normal-form IR
//   lumen check <file.lm>          type-check and print inferred signatures

import { readFileSync, writeFileSync } from 'node:fs';
import { compile, runWasm, interpretSource, checkSource, formatDiagnostic, decodeBytes } from '../src/compiler.js';

const [cmd, file, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const usage = () => {
  console.error('usage: lumen <run|build|wat|ir|check> <file.lm> [-O] [--interp] [--gc-stress] [--stats] [-o out.wasm]');
  process.exit(2);
};
if (!cmd || !file) usage();

const src = readFileSync(file, 'utf8');
const inputAt = rest.indexOf('--input');
const input = inputAt >= 0 ? readFileSync(rest[inputAt + 1]).toString('latin1') : '';
const color = process.stderr.isTTY ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_, s) => s;

function report(result) {
  for (const w of result.warnings ?? []) console.error(color(33, formatDiagnostic(src, w, 'warning')));
  if (!result.ok) {
    for (const e of result.errors) console.error(color(31, formatDiagnostic(src, e)));
    process.exit(1);
  }
}

const out = (s) => process.stdout.write(decodeBytes(s));
const optimize = flag('-O');

switch (cmd) {
  case 'run': {
    if (flag('--interp')) {
      const r = interpretSource(src, { input });
      report(r);
      out(r.output);
      if (r.error) { console.error(color(31, `runtime error: ${r.error}`)); process.exit(1); }
      break;
    }
    const c = compile(src, { gcStress: flag('--gc-stress'), optimize });
    report(c);
    const r = runWasm(c.wasm, { input, onOutput: (s) => process.stdout.write(decodeBytes(s)) });
    if (flag('--stats')) {
      const t = c.timings;
      const ms = (x) => `${x.toFixed(1)}ms`;
      console.error(color(2, [
        `compile: parse ${ms(t.parse)}, typecheck ${ms(t.typecheck)}, lower ${ms(t.lower)}, codegen ${ms(t.codegen)}, encode ${ms(t.encode)}`,
        `binary:  ${c.wasm.length} bytes, ${c.functionCount} functions`,
        ...(c.peephole ? [`-O:      ${[...c.peephole.stats.values()].reduce((a, b) => a + b, 0)} rewrites, ${c.peephole.before - c.peephole.after} instructions removed`] : []),
        `run:     ${ms(r.timeMs)}, ${r.stats.gcCount} collections, ${(r.stats.allocatedBytes / 1e6).toFixed(1)} MB allocated, heap ${(r.stats.heapBytes / 1024).toFixed(0)} KiB`,
      ].join('\n')));
    }
    if (r.error) { console.error(color(31, `runtime error: ${r.error}`)); process.exit(1); }
    break;
  }
  case 'build': {
    const c = compile(src, { optimize });
    report(c);
    const i = rest.indexOf('-o');
    const target = i >= 0 ? rest[i + 1] : file.replace(/\.lm$/, '') + '.wasm';
    writeFileSync(target, c.wasm);
    console.error(`wrote ${target} (${c.wasm.length} bytes)`);
    break;
  }
  case 'wat': {
    const c = compile(src, { optimize });
    report(c);
    console.log(c.wat);
    break;
  }
  case 'ir': {
    const c = compile(src);
    report(c);
    console.log(c.ir);
    break;
  }
  case 'check': {
    const r = checkSource(src);
    report(r);
    for (const s of r.signatures) console.log(`fn ${s.name}: ${s.type}`);
    break;
  }
  default:
    usage();
}
