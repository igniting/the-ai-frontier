// Runs the differential fuzzer continuously and reports progress.
import { generateProgram, renderProgram } from '../fuzz/generate.js';
import { checkProgram } from '../fuzz/check.js';

self.onmessage = (e) => {
  const { seed, size } = e.data;
  const totals = { programs: 0, agreed: 0, runtimeErrors: 0, skipped: 0, mismatches: 0, gcs: 0, lines: 0 };
  let lastReport = 0;
  const step = () => {
    const s = seed + totals.programs;
    const src = renderProgram(generateProgram(s, { size }));
    const r = checkProgram(src);
    totals.programs++;
    totals.lines += src.split('\n').length;
    if (r.status === 'ok') {
      totals.agreed++;
      totals.gcs += r.gcCount;
      if (r.error) totals.runtimeErrors++;
    } else if (r.status === 'skipped') totals.skipped++;
    else {
      totals.mismatches++;
      self.postMessage({ type: 'mismatch', seed: s, source: src, detail: r.detail });
    }
    const now = performance.now();
    if (now - lastReport > 120) {
      lastReport = now;
      self.postMessage({ type: 'progress', totals, seed: s, source: src, error: r.error ?? null });
    }
    setTimeout(step, 0);
  };
  step();
};
