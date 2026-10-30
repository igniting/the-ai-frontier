#!/usr/bin/env node
// lumen2 check FILE                 print every function's inferred type and effects
// lumen2 run FILE [--input FILE]    compile to WebAssembly and run
//            [--interp]             use the reference interpreter instead
//            [--paranoid]           never reuse freed memory; catch any use after free
// lumen2 build FILE [-o OUT.wasm]   write the WebAssembly module
// lumen2 ir FILE [FN]               print the IR with its reference-count operations
//
// Exit codes are set with process.exitCode rather than process.exit(), which
// can drop output still queued for a pipe.

import { readFileSync, writeFileSync } from 'node:fs';
import { checkSource, interpretSource, compileSource, formatDiagnostic, decodeBytes, utf8 } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { showIR } from '../src/perceus.js';

const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const flag = (name) => rest.includes(name);

function main() {
  if (!cmd || !file) {
    console.error('usage: lumen2 check FILE | run FILE [--input FILE] [--interp] [--paranoid] | build FILE [-o OUT] | ir FILE [FN]');
    return 2;
  }
  const source = readFileSync(file, 'utf8');
  const c = checkSource(source);
  if (!c.ok) {
    for (const e of c.errors) console.error(formatDiagnostic(source, e));
    return 1;
  }
  for (const w of c.warnings) console.error(formatDiagnostic(source, w).replace(/^error/, 'warning'));

  switch (cmd) {
    case 'check':
      for (const s of c.signatures) console.log(`${s.name} : ${s.type}`);
      return 0;
    case 'run': {
      const inputPath = opt('--input');
      const input = inputPath ? utf8(readFileSync(inputPath, 'utf8')) : '';
      let r;
      if (flag('--interp')) r = interpretSource(source, { input });
      else {
        r = runWasm(compileSource(source, { paranoid: flag('--paranoid') }).bytes, { input });
        if (!r.error && r.live) r.error = `internal error: ${r.live} objects were never freed`;
      }
      process.stdout.write(decodeBytes(r.output));
      if (r.error) { console.error(`runtime error: ${r.error}`); return 1; }
      return 0;
    }
    case 'build': {
      const out = opt('-o') ?? file.replace(/\.[^.]*$/, '') + '.wasm';
      writeFileSync(out, compileSource(source, { paranoid: flag('--paranoid') }).bytes);
      return 0;
    }
    case 'ir': {
      const { ir } = compileSource(source);
      const want = rest[0];
      const shown = (f) => (want ? f.name === want || f.name.startsWith(`${want}<`) : !f.name.includes(':') || f.name.startsWith('lambda'));
      for (const f of ir.fns) if (shown(f)) console.log(`${showIR(f)}\n`);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

process.exitCode = main();
