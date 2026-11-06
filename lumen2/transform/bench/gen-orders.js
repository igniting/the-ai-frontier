#!/usr/bin/env node
// gen-orders.js ROWS [SEED] > orders.csv
// A CSV of orders, the same for the same ROWS and SEED: order, customer,
// country, quantity, unit_price, time. One customer name in 50 holds a
// comma, so it is in quotes.

import { writeSync } from 'node:fs';

const rows = Number(process.argv[2] ?? 1000);
let seed = BigInt(process.argv[3] ?? 1);
const next = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number(seed >> 33n) % n; };
const countries = ['AT', 'BE', 'DE', 'ES', 'FI', 'FR', 'IE', 'IT', 'NL', 'PT', 'US', 'GB', 'CA', 'JP', 'BR', 'IN', 'CH', 'SE', 'PL', 'AU'];
const first = ['ana', 'ben', 'chen', 'dara', 'emil', 'fatima', 'gus', 'hana', 'ivan', 'jo', 'kofi', 'lena', 'mo', 'noor', 'olga', 'pia'];

let buf = 'order,customer,country,quantity,unit_price,time\n';
for (let i = 1; i <= rows; i++) {
  const name = `${first[next(first.length)]}${next(100000)}`;
  const customer = next(50) === 0 ? `"${name}, ltd"` : name;
  const cents = 99 + next(50000);
  const price = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  const t = 1767225600 + i * 7 + next(7);
  const time = new Date(t * 1000).toISOString().replace('.000Z', 'Z');
  buf += `${100000000 + i},${customer},${countries[next(countries.length)]},${1 + next(12)},${price},${time}\n`;
  if (buf.length > 1 << 20) { writeSync(1, buf); buf = ''; }
}
writeSync(1, buf);
