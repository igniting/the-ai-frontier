#!/usr/bin/env node
// node udf-vm.js TRANSFORM.js [--no-vm] < input > output
// Node's way to run user code apart from the host's: the library and the
// user's file run in a vm context, and the host calls the context's
// transform on every line. The Node documentation says of node:vm: "The
// node:vm module is not a security mechanism. Do not use it to run untrusted
// code." The user's code also runs on this one thread.
// --no-vm: the library and the user's code run in the host's own context
// instead (as with eval), to show what the vm context costs.

import { readFileSync, readSync, writeSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('.', import.meta.url);
const lib = readFileSync(new URL('lib.js', here), 'utf8');
const user = readFileSync(process.argv[2], 'utf8');
let transform;
if (process.argv.includes('--no-vm')) transform = new Function(`${lib}\n${user}\nreturn transform;`)();
else {
  const context = vm.createContext({});
  vm.runInContext(lib, context, { filename: 'lib.js' });
  vm.runInContext(user, context, { filename: process.argv[2] });
  transform = vm.runInContext('transform', context);
}

const buf = Buffer.alloc(1 << 20);
let rest = '', n = 0, out = [], size = 0;
const flush = () => { const b = Buffer.from(out.join('')); for (let i = 0; i < b.length;) i += writeSync(1, b, i); out = []; size = 0; };
const line = (l) => {
  const r = transform(++n, l.endsWith('\r') ? l.slice(0, -1) : l);
  if (r !== null && r !== undefined) { out.push(r, '\n'); if ((size += r.length) > 1 << 20) flush(); }
};
for (;;) {
  const k = readSync(0, buf, 0, buf.length, null);
  if (k === 0) break;
  const text = rest + buf.toString('latin1', 0, k);
  const lines = text.split('\n');
  rest = lines.pop();
  for (const l of lines) line(l);
}
if (rest) line(rest);
flush();
