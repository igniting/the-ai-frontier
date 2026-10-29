// Runs one program three ways and compares the results. The reference
// interpreter is always the real one; the compiler under test can be
// swapped out (mutation testing loads deliberately broken copies).

import * as realCompiler from '../src/compiler.js';

export const STEP_BUDGET = 300000;

export function makeChecker(compiler = realCompiler) {
  const { interpretSource, formatDiagnostic } = realCompiler;
  return function checkProgram(src) {
    const ref = interpretSource(src, { maxSteps: STEP_BUDGET });
    if (!ref.ok) return { status: 'rejected', detail: formatDiagnostic(src, ref.errors[0]) + '\n' + src };
    if (ref.error === 'out of fuel' || ref.error === 'stack overflow') return { status: 'skipped' };
    const runs = [
      ['wasm', {}],
      ['wasm+gc-stress', { gcStress: true }],
    ];
    let gcCount = 0;
    for (const [label, options] of runs) {
      let r;
      try {
        const c = compiler.compile(src, { ...options, fuel: 50_000_000 });
        if (!c.ok) return { status: 'rejected', detail: formatDiagnostic(src, c.errors[0]) };
        r = compiler.runWasm(c.wasm);
      } catch (e) {
        return { status: 'mismatch', detail: `${label}: compiler crashed: ${e.message.split('\n')[0]}` };
      }
      if (r.output !== ref.output || r.error !== ref.error) {
        const firstDiff = [...r.output].findIndex((ch, i) => ch !== ref.output[i]);
        return { status: 'mismatch', detail: `${label}: interp error=${ref.error} wasm error=${r.error} first output diff at ${firstDiff}` };
      }
      if (options.gcStress) gcCount = r.stats.gcCount;
    }
    return { status: 'ok', error: ref.error, gcCount };
  };
}

export const checkProgram = makeChecker();
