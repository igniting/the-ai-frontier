#!/usr/bin/env node
// lumen2 check FILE                 print every function's inferred type and effects
// lumen2 run FILE [--input FILE]    compile to WebAssembly and run
//            [--allow CAPS]         grant capabilities besides output: input,clock,random or all
//            [--seed N]             seed for random_int (default: from the system)
//            [--interp]             use the reference interpreter instead
//            [--paranoid]           never reuse freed memory; catch any use after free
// lumen2 test FILE [--runs N]       test every property with generated inputs
//            [--seed N]
// lumen2 certify FILE [--out DIR]   check every certificate; write them to DIR
// lumen2 build FILE [-o OUT.wasm]   write the WebAssembly module
// lumen2 ir FILE [FN]               print the IR with its reference-count operations
//
// Exit codes are set with process.exitCode rather than process.exit(), which
// can drop output still queued for a pipe.

import { readFileSync, writeFileSync } from 'node:fs';
import { checkSource, interpretSource, compileSource, testSource, certifySource, formatDiagnostic, decodeBytes, utf8, makeHost, runWasm } from '../src/api.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lineCol } from '../src/diagnostics.js';
import { CAPABILITIES } from '../src/types.js';

const [cmd, file, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const flag = (name) => rest.includes(name);

function main() {
  if (!cmd || !file) {
    console.error('usage: lumen2 check FILE | run FILE [--allow CAPS] [--input FILE] [--seed N] [--interp] [--paranoid] | test FILE [--runs N] [--seed N] | certify FILE [--out DIR] | build FILE [-o OUT] | ir FILE [FN]');
    return 2;
  }
  const source = readFileSync(file, 'utf8');
  // A program that runs is granted output; anything else must be asked for.
  let grants = null;
  if (cmd === 'run') {
    const allow = (opt('--allow') ?? '').split(',').filter(Boolean);
    const unknown = allow.filter((a) => a !== 'all' && !CAPABILITIES.includes(a));
    if (unknown.length) { console.error(`unknown capability: ${unknown.join(', ')} (the capabilities are ${CAPABILITIES.join(', ')})`); return 2; }
    grants = allow.includes('all') ? CAPABILITIES : [...new Set(['output', ...allow])];
  }
  const c = checkSource(source, { grants });
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
      const seed = opt('--seed') ?? String(Math.floor(Math.random() * 2 ** 31));
      const host = makeHost({ seed: BigInt(seed), realClock: true });
      let r;
      if (flag('--interp')) r = interpretSource(source, { input, host, grants });
      else {
        r = runWasm(compileSource(source, { paranoid: flag('--paranoid'), grants }).bytes, { input, host });
        if (!r.error && r.live) r.error = `internal error: ${r.live} objects were never freed`;
      }
      process.stdout.write(decodeBytes(r.output));
      if (r.error) { console.error(`runtime error: ${r.error}`); return 1; }
      return 0;
    }
    case 'test': {
      const t = testSource(source, { runs: Number(opt('--runs') ?? 100), seed: Number(opt('--seed') ?? 1) });
      if (!t.results.length) { console.log('no properties'); return 0; }
      let failed = 0;
      for (const r of t.results) {
        const compiled = r.compiled ? `; compiled code ${r.compiled}` : '';
        if (r.ok) { console.log(`ok      ${r.name} (${r.cases} cases${compiled})`); continue; }
        failed++;
        console.log(`FAILED  ${r.name}: ${r.reason} on case ${r.cases}${compiled}`);
        console.log(`        counterexample, shrunk in ${r.shrinks} step${r.shrinks === 1 ? '' : 's'}: ${r.counterexample.map((x) => `${x.name} = ${x.value}`).join(', ')}`);
      }
      console.log(`${t.results.length - failed} passed, ${failed} failed`);
      return failed || t.results.some((r) => r.compiled && r.compiled !== 'agrees') ? 1 : 0;
    }
    case 'certify': {
      const r = certifySource(source);
      if (!r.ok) { for (const e of r.errors) console.error(formatDiagnostic(source, e)); return 1; }
      const { types, ownership } = r.certificates;
      const proved = r.obligations.filter((o) => o.status === 'proved');
      const kept = r.obligations.filter((o) => o.kind === 'partial' && o.status !== 'proved');
      const lemmas = proved.reduce((n, o) => n + o.lemmas, 0);
      console.log(`types      ${types.functions} IR functions, ${types.instructions} instructions: all well typed`);
      console.log(`ownership  ${ownership.functions} functions, ${ownership.dups} dups, ${ownership.drops} drops, ${ownership.reuses} reuses: balanced on every path`);
      console.log(`proofs     ${proved.length} obligations proved, ${lemmas} lemmas, every refutation checked; ${kept.length} partial operation${kept.length === 1 ? '' : 's'} keep \`fail\``);
      console.log(`wasm       ${r.bytes.length} bytes, validated by the engine`);
      const out = opt('--out');
      if (out) {
        mkdirSync(join(out, 'proofs'), { recursive: true });
        const where = (o) => (o.scope === 'user' ? ` at ${Object.values(lineCol(source, o.span.s)).join(':')}` : ' in the prelude');
        const manifest = [];
        proved.forEach((o, i) => {
          const n = String(i + 1).padStart(3, '0');
          const what = `${o.what}${where(o)}`;
          writeFileSync(join(out, 'proofs', `${n}.cnf`), `c ${what}\np cnf ${o.cnf.nvars} ${o.cnf.clauses.length}\n${o.cnf.clauses.map((c) => `${c.join(' ')} 0`).join('\n')}\n`);
          writeFileSync(join(out, 'proofs', `${n}.drup`), `${o.proof.map((c) => `${c.join(' ')} 0`).join('\n')}\n`);
          manifest.push(`${n}  ${what}  (${o.cnf.nvars} variables, ${o.cnf.clauses.length} clauses, ${o.lemmas} lemmas)`);
        });
        writeFileSync(join(out, 'proofs', 'MANIFEST'), `${manifest.join('\n')}\n`);
        writeFileSync(join(out, 'ir.txt'), r.ir.fns.map((f) => f.text).join('\n\n') + '\n');
        writeFileSync(join(out, 'program.wasm'), r.bytes);
        console.log(`wrote ${out}/proofs (DIMACS + DRUP), ${out}/ir.txt and ${out}/program.wasm`);
      }
      return 0;
    }
    case 'build': {
      const out = opt('-o') ?? file.replace(/\.[^.]*$/, '') + '.wasm';
      writeFileSync(out, compileSource(source, { paranoid: flag('--paranoid') }).bytes);
      return 0;
    }
    case 'ir': {
      const { ir } = compileSource(source, { ir: true });
      const want = rest[0];
      const shown = (f) => (want ? f.name === want || f.name.startsWith(`${want}<`) : !f.name.includes(':') || f.name.startsWith('lambda'));
      for (const f of ir.fns) if (shown(f)) console.log(`${f.text}\n`);
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

process.exitCode = main();
