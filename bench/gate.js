// The gate every optimization in the performance campaign must pass before
// it is kept (see CAMPAIGN.md). Runs, in order, stopping at the first failure:
//
//   1. the test suite (every language test runs four ways, including -O);
//   2. differential fuzzing on fresh seeds: interpreter vs wasm vs GC-stress
//      wasm vs -O wasm, 1500 programs of each size;
//   3. mutation testing: every injected compiler and optimizer bug is caught;
//   4. every superoptimizer rule re-proved and its proof RUP-checked;
//   5. the self-hosted bootstrap still reaches its byte-identical fixed point;
//   6. the benchmarks, whose -O output must match the baseline's exactly.
//
//   node bench/gate.js [--seed S] [--quick]

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const seedAt = args.indexOf('--seed');
const seed = seedAt >= 0 ? +args[seedAt + 1] : Math.floor(Math.random() * 1e8);
const quick = args.includes('--quick');
const n = quick ? 300 : 1500;

const steps = [
  ['tests', 'npm test --silent'],
  ...[1, 2, 3].map((size) => [`fuzz size ${size}`, `node fuzz/fuzz.js --count ${n} --size ${size} --seed ${seed + size * 1e6} --quiet`]),
  ['mutants', `node fuzz/mutants.js --budget ${quick ? 200 : 400}`],
  ['rules', 'node superopt/verify.js'],
  ['bootstrap', `node selfhost/bootstrap.js --programs ${quick ? 30 : 100}`],
  ['benchmarks', 'node bench/bench.js --runs 1'],
];

const t0 = Date.now();
for (const [name, cmd] of steps) {
  const t = Date.now();
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
    const last = out.trim().split('\n').filter((l) => /\S/.test(l)).slice(-1)[0] ?? '';
    console.log(`  pass  ${name.padEnd(12)} ${((Date.now() - t) / 1000).toFixed(0).padStart(4)} s   ${last.trim().slice(0, 90)}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n${(e.stdout ?? '') + (e.stderr ?? '')}`.slice(0, 4000));
    process.exit(1);
  }
}
console.log(`gate passed in ${((Date.now() - t0) / 1000).toFixed(0)} s (fuzz seed ${seed})`);
