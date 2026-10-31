// Builds the source of lumen2c, the Lumen 2 compiler written in Lumen 2: the
// files of this directory in name order, then the prelude as a string.
//
//   node compiler/build.js [OUT]     (default: print to standard output)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { PRELUDE } from '../src/prelude.js';

const here = (p) => new URL(p, import.meta.url);

// A Lumen 2 string literal for any text: quotes, backslashes and control
// characters escaped, everything else as it is.
export function literal(text) {
  let out = '"';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (c < 32) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

export function compilerSource() {
  const files = readdirSync(here('./')).filter((f) => /^\d\d-.*\.lm$/.test(f)).sort();
  const parts = files.map((f) => readFileSync(here(f), 'utf8'));
  parts.push(`// ================================================================== prelude\nfn prelude_source() { ${literal(PRELUDE)} }\n`);
  return parts.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = compilerSource();
  if (process.argv[2]) writeFileSync(process.argv[2], src); else process.stdout.write(src);
}
