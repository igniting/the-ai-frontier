// Collects every program the test suites check, with its options, into a
// JSON corpus for the parity tests (compiler/parity.mjs --tests FILE).
//
//   node compiler/collect.mjs OUT.json
import { writeFileSync } from 'node:fs';
const seen = new Map();
globalThis.__lumen2Log = (source, options) => {
  const o = { grants: options.grants ?? null, entry: options.entry ?? 'main' };
  const key = JSON.stringify([source, o]);
  if (!seen.has(key)) seen.set(key, { src: source, ...o });
};
process.on('exit', () => writeFileSync(process.argv[2], JSON.stringify([...seen.values()])));
for (const f of ['frontend', 'backend', 'proofs', 'showcase', 'superopt']) await import(`../test/${f}.test.js`);
