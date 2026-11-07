#!/usr/bin/env node
// gen-companies.js ROWS [SEED] > companies.csv
// A CSV of company names as people type them, the same for the same ROWS and
// SEED: id, company, country, amount. Nine in ten are one of the 64 names
// transform/examples/match.lm knows, half of those misspelt (one to three
// letters changed, added, dropped or swapped), in lower, title or upper
// case; the rest are names it does not know.

import { writeSync } from 'node:fs';

const rows = Number(process.argv[2] ?? 1000);
let seed = BigInt(process.argv[3] ?? 1);
const next = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number(seed >> 33n) % n; };
const prefixes = ['north', 'blue', 'silver', 'red', 'green', 'iron', 'oak', 'stone'];
const suffixes = ['field supply', 'harbor foods', 'line logistics', 'peak software', 'river energy', 'gate textiles', 'ridge pharma', 'brook media'];
const countries = ['AT', 'BE', 'DE', 'ES', 'FI', 'FR', 'IE', 'IT', 'NL', 'PT', 'US', 'GB', 'CA', 'JP', 'BR', 'IN'];
const letters = 'abcdefghijklmnopqrstuvwxyz';
const letter = () => letters[next(26)];

function misspell(s) {
  for (let k = [0, 0, 0, 1, 1, 2, 3][next(7)]; k > 0; k--) {
    const i = next(s.length);
    switch (next(4)) {
      case 0: s = s.slice(0, i) + letter() + s.slice(i + 1); break;
      case 1: s = s.slice(0, i) + letter() + s.slice(i); break;
      case 2: if (s.length > 3) s = s.slice(0, i) + s.slice(i + 1); break;
      default: if (i + 1 < s.length) s = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2); break;
    }
  }
  return s;
}

let buf = 'id,company,country,amount\n';
for (let i = 1; i <= rows; i++) {
  let name;
  if (next(10) === 0) name = Array.from({ length: 2 + next(2) }, () => Array.from({ length: 3 + next(6) }, letter).join('')).join(' ');
  else name = misspell(`${prefixes[next(8)]} ${suffixes[next(8)]}`);
  const c = next(3);
  if (c === 1) name = name.replace(/\b[a-z]/g, (x) => x.toUpperCase());
  if (c === 2) name = name.toUpperCase();
  const cents = 100 + next(1000000);
  buf += `${700000000 + i},${name},${countries[next(countries.length)]},${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}\n`;
  if (buf.length > 1 << 20) { writeSync(1, buf); buf = ''; }
}
writeSync(1, buf);
