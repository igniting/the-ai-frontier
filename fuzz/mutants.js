#!/usr/bin/env node
// Mutation testing for the fuzzer itself: "who checks the checker?"
//
// Each mutant is a realistic compiler bug injected into a private copy of
// src/. A good differential fuzzer must notice it. For every mutant we run
// generated programs until one disagrees with the reference interpreter,
// and report how many programs it took (or that the bug survived).
//
//   node fuzz/mutants.js [--budget N]

import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { generateProgram, renderProgram } from './generate.js';
import { makeChecker } from './check.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const budgetArg = process.argv.indexOf('--budget');
const BUDGET = budgetArg > 0 ? Number(process.argv[budgetArg + 1]) : 1000;
const HANG_MS = 10000;

export const MUTANTS = [
  {
    name: 'concat forgets to root its arguments before allocating',
    file: 'runtime.js',
    find: "    pushRoots('$a', '$b'),\n    newString('$n'),\n    popRoots('$a', '$b'),",
    replace: "    newString('$n'),",
  },
  {
    name: 'substring forgets to root its argument before allocating',
    file: 'runtime.js',
    find: "    pushRoots('$s'),\n    newString('$n'),\n    popRoots('$s'),",
    replace: "    newString('$n'),",
  },
  {
    name: 'GC scan skips the last field of every object',
    file: 'runtime.js',
    find: "lg('$p'), lg('$h'), c(9), o('i32.shr_u'), c(2), o('i32.shl'), o('i32.add'), ls('$end'),",
    replace: "lg('$p'), lg('$h'), c(9), o('i32.shr_u'), c(1), o('i32.sub'), c(2), o('i32.shl'), o('i32.add'), ls('$end'),",
  },
  {
    name: 'function prologue does not zero the shadow-stack frame',
    file: 'codegen.js',
    find: "emit(lg('$fp'), paramSlots ? [c(paramSlots * 4), o('i32.add')] : [], c(0), c((slots - paramSlots) * 4), ['memory.fill']);",
    replace: '',
  },
  {
    name: 'allocation loads the fields before calling alloc (stale pointers after a GC)',
    file: 'codegen.js',
    find: `      emit(c(4 + 4 * fields.length), call('$rt:alloc'), ls('$tmp'), lg('$tmp'), c(hdr), st(0));
      fields.forEach((a, i) => {
        emit(lg('$tmp'));
        genAtom(a);
        emit(st(4 + 4 * i));
      });
      emit(lg('$tmp'));`,
    replace: `      fields.forEach((a) => genAtom(a));
      emit(c(4 + 4 * fields.length), call('$rt:alloc'), ls('$tmp'), lg('$tmp'), c(hdr), st(0));
      for (let i = fields.length - 1; i >= 0; i--) {
        emit(ls('$swap'), lg('$tmp'), lg('$swap'), st(4 + 4 * i));
      }
      emit(lg('$tmp'));`,
    extra: [{ find: "if (needsTmp) locals.push({ name: '$tmp', type: 'i32' });", replace: "if (needsTmp) locals.push({ name: '$tmp', type: 'i32' }, { name: '$swap', type: 'i32' });" }],
  },
  {
    name: 'captured variables read from the wrong closure slot',
    file: 'codegen.js',
    find: 'ld(8 + 4 * a.i)',
    replace: 'ld(8 + 4 * (a.i > 0 ? a.i - 1 : a.i))',
  },
  {
    name: 'arguments evaluated before the callee expression',
    file: 'lower.js',
    find: "return withAtom(f, ctx, (clo) => withAtoms(e.args, ctx, (args) => ({ k: 'callc', clo, args })));",
    replace: "return withAtoms(e.args, ctx, (args) => withAtom(f, ctx, (clo) => ({ k: 'callc', clo, args })));",
  },
  {
    name: 'binary operators evaluate the right operand first',
    file: 'lower.js',
    find: "return withAtom(e.l, ctx, (l) => withAtom(e.r, ctx, (r) => ({ k: 'prim', op: prim, args: [l, r] })));",
    replace: "return withAtom(e.r, ctx, (r) => withAtom(e.l, ctx, (l) => ({ k: 'prim', op: prim, args: [l, r] })));",
  },
  {
    name: 'pattern matching skips the "is a heap block" test',
    file: 'lower.js',
    find: "if (nNullary > 0) tests.push({ k: 'isblock', path });",
    replace: '',
  },
  {
    name: 'ordering treats nullary constructors as greater than constructors with fields',
    file: 'runtime.js',
    find: "if_(null, ret(lg('$a'), c(1), o('i32.shr_s'), kindOf(lg('$b')), o('i32.lt_s'), if_('i32', c(-1), c(1)))),",
    replace: "if_(null, ret(c(1))),",
  },
  {
    name: 'structural equality ignores the last field',
    file: 'runtime.js',
    find: "    lg('$a'), lg('$n'), c(2), o('i32.shl'), o('i32.add'), ld(), ls('$a'),\n    lg('$b'), lg('$n'), c(2), o('i32.shl'), o('i32.add'), ld(), ls('$b'),\n    ['br', '$top'],\n    ['end'],\n    o('unreachable'),\n  ], 'Structural equality. Returns raw 0/1.');",
    replace: "    c(1), o('return'),\n    ['end'],\n    o('unreachable'),\n  ], 'Structural equality. Returns raw 0/1.');",
  },
  {
    name: 'tagged multiplication forgets to untag one operand',
    file: 'codegen.js',
    find: "genAtom(b); emit(c(1), o('i32.sub'), o('i32.mul'), c(1), o('i32.add'));",
    replace: "genAtom(b); emit(o('i32.mul'), c(1), o('i32.or'));",
  },
  {
    name: 'division-by-zero check is missing for `%`',
    file: 'codegen.js',
    find: "genAtom(b); emit(c(1), o('i32.eq'), ['if', null, null], c(ERR.DIV_ZERO), call('$rt:trap'), ['end']);",
    replace: "if (e.op === 'div') { genAtom(b); emit(c(1), o('i32.eq'), ['if', null, null], c(ERR.DIV_ZERO), call('$rt:trap'), ['end']); }",
  },
  {
    name: 'int_to_string drops the minus sign',
    file: 'runtime.js',
    find: "lg('$neg'), if_(null, [lg('$pos'), c(1), o('i32.sub'), lt('$pos'), c(45), ['i32.store8', 0]]),",
    replace: '',
  },
  {
    name: 'substring does not clamp a negative start',
    file: 'runtime.js',
    find: "lg('$a'), c(0), o('i32.lt_s'), if_(null, [c(0), ls('$a')]),",
    replace: '',
  },
  {
    name: 'string comparison treats a prefix as greater',
    file: 'runtime.js',
    find: "lg('$la'), lg('$lb'), o('i32.gt_u'), lg('$la'), lg('$lb'), o('i32.lt_u'), o('i32.sub'),",
    replace: "lg('$la'), lg('$lb'), o('i32.lt_u'), lg('$la'), lg('$lb'), o('i32.gt_u'), o('i32.sub'),",
  },
  {
    name: '-O: a superoptimizer rule is off by one (x >>> 1 == 0 rewritten to x <u 1)',
    file: 'rules.js',
    find: '"rhs":[["i32.const",1],["i32.le_u"]]',
    replace: '"rhs":[["i32.const",1],["i32.lt_u"]]',
  },
  {
    name: '-O: frame zeroing elision ignores direct calls as GC points (stale roots)',
    file: 'optimize.js',
    find: "else if (op === 'call_indirect' || (op === 'call' && !safeCallees.has(arg))) {",
    replace: "else if (op === 'call_indirect') {",
  },
  {
    name: '-O: frame zeroing elision trusts writes made inside an if (not on every path)',
    file: 'optimize.js',
    find: "else if (op === 'end') written = saved.pop() ?? written;",
    replace: "else if (op === 'end') saved.pop();",
  },
  {
    name: '-O: inline allocation forgets to bump the heap pointer (objects overlap)',
    file: 'codegen.js',
    find: "['else'], gg('$hp'), lg('$tmp'), gs('$hp'), ['end'],",
    replace: "['else'], gg('$hp'), ['end'],",
  },
  {
    name: '-O: the heap-growth test is inverted (the heap does not grow when it must)',
    file: 'runtime.js',
    find: "lg('$base'), lg('$size'), c(2), o('i32.shr_u'), o('i32.gt_u'),",
    replace: "lg('$base'), lg('$size'), c(2), o('i32.shr_u'), o('i32.le_u'),",
  },
  {
    name: '-O: temporary forwarding deletes a store whose local is read again later',
    file: 'optimize.js',
    find: 'if (uses.get(ins[1]) !== 2) out.push',
    replace: 'if (uses.get(ins[1]) > 3) out.push',
  },
  {
    name: '-O: the constant folder swaps the operands of subtraction',
    file: 'peephole.js',
    find: "case 'i32.sub': return (a - b) | 0;",
    replace: "case 'i32.sub': return (b - a) | 0;",
  },
];

async function loadMutant(m) {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-mutant-'));
  cpSync(SRC, dir, { recursive: true });
  const path = join(dir, m.file);
  let text = readFileSync(path, 'utf8');
  for (const { find, replace } of [{ find: m.find, replace: m.replace }, ...(m.extra ?? [])]) {
    if (!text.includes(find)) throw new Error(`mutant "${m.name}": patch target not found in ${m.file}`);
    text = text.replace(find, replace);
  }
  writeFileSync(path, text);
  return { mod: await import(pathToFileURL(join(dir, 'compiler.js')).href), dir };
}

// Worker: test one mutant, reporting progress so the parent can detect hangs.
if (!isMainThread) {
  const m = MUTANTS[workerData.index];
  const { mod, dir } = await loadMutant(m);
  const check = makeChecker(mod);
  for (let k = 0; k < workerData.budget; k++) {
    parentPort.postMessage({ k });
    const r = check(renderProgram(generateProgram(100000 + k, { size: 2 })));
    if (r.status === 'mismatch' || r.status === 'rejected') {
      parentPort.postMessage({ caughtAt: k + 1, detail: r.detail });
      break;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  parentPort.postMessage({ done: true });
}

function runMutant(index) {
  return new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { index, budget: BUDGET } });
    let last = Date.now(), k = 0, result = null;
    const timer = setInterval(() => {
      if (Date.now() - last > HANG_MS) {
        clearInterval(timer);
        w.terminate();
        resolve({ caughtAt: k + 1, detail: `program ${k + 1} hung (no result after ${HANG_MS / 1000}s)` });
      }
    }, 250);
    w.on('message', (msg) => {
      last = Date.now();
      if ('k' in msg) k = msg.k;
      if (msg.caughtAt) result = msg;
      if (msg.done) { clearInterval(timer); w.terminate(); resolve(result ?? {}); }
    });
    w.on('error', (e) => { clearInterval(timer); resolve({ caughtAt: k + 1, detail: `crashed: ${e.message}` }); });
  });
}

if (isMainThread) {
  let survived = 0;
  console.log(`Mutation testing: up to ${BUDGET} generated programs per mutant\n`);
  for (let i = 0; i < MUTANTS.length; i++) {
    const m = MUTANTS[i];
    const { caughtAt, detail } = await runMutant(i);
    if (caughtAt) {
      console.log(`  CAUGHT   after ${String(caughtAt).padStart(4)} program${caughtAt === 1 ? ' ' : 's'}  ${m.name}`);
      console.log(`           ${detail.split('\n')[0].slice(0, 110)}`);
    } else {
      survived++;
      console.log(`  SURVIVED ${BUDGET} programs      ${m.name}`);
    }
  }
  console.log(`\n${MUTANTS.length - survived}/${MUTANTS.length} injected bugs caught.`);
  process.exit(survived ? 1 : 0);
}
