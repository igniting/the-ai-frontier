// Lexer: source text -> tokens with byte-accurate spans.
//
// Strings are byte strings. A string literal's value is the UTF-8 encoding of
// its characters, held in a JavaScript string whose char codes are bytes
// (0-255), so every later phase can treat strings as byte sequences.

import { LumenError } from './diagnostics.js';

export const KEYWORDS = new Set(['fn', 'let', 'if', 'else', 'match', 'type', 'true', 'false', 'trait', 'impl', 'for', 'where', 'property']);

// Longest first, so that `|>` wins over `|`.
const PUNCT = ['|>', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '++', '..',
  '(', ')', '{', '}', '[', ']', ',', ';', ':', '<', '>', '+', '-', '*', '/', '%', '!', '=', '|'];

export const MAX_INT = (1n << 63n) - 1n;

export function utf8(text) {
  let out = '';
  for (const b of new TextEncoder().encode(text)) out += String.fromCharCode(b);
  return out;
}

export function decodeBytes(bytes) {
  const arr = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(arr);
}

export function lex(src) {
  const tokens = [];
  let i = 0;
  const err = (msg, s, e = s + 1) => { throw new LumenError(msg, { s, e }); };
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) {
      const start = i;
      let depth = 0;
      do {
        if (src.startsWith('/*', i)) { depth++; i += 2; } else if (src.startsWith('*/', i)) { depth--; i += 2; } else i++;
        if (i >= src.length && depth > 0) err('unterminated comment', start, start + 2);
      } while (depth > 0);
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch)) {
      while (i < src.length && /[0-9_]/.test(src[i])) i++;
      const text = src.slice(start, i).replace(/_/g, '');
      if (/[A-Za-z]/.test(src[i] ?? '')) err('invalid number literal', start, i + 1);
      tokens.push({ k: 'int', v: BigInt(text), s: start, e: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      const text = src.slice(start, i);
      if (KEYWORDS.has(text)) tokens.push({ k: text, s: start, e: i });
      else tokens.push({ k: /^[A-Z]/.test(text) ? 'upper' : 'lower', v: text, s: start, e: i });
      continue;
    }
    if (ch === '"') {
      i++;
      let text = '';
      for (;;) {
        if (i >= src.length || src[i] === '\n') err('unterminated string literal', start, i);
        const c = src[i];
        if (c === '"') { i++; break; }
        if (c === '\\') {
          const n = src[i + 1];
          const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", 0: '\0' };
          if (n in simple) { text += simple[n]; i += 2; continue; }
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
            text += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          err('unknown escape sequence', i, i + 2);
        }
        // Collect a run of ordinary characters and encode them as UTF-8.
        let j = i;
        while (j < src.length && src[j] !== '"' && src[j] !== '\\' && src[j] !== '\n') j++;
        text += utf8(src.slice(i, j));
        i = j;
      }
      tokens.push({ k: 'str', v: text, s: start, e: i });
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) err(`unexpected character \`${ch}\``, start);
    tokens.push({ k: p, s: start, e: start + p.length });
    i += p.length;
  }
  tokens.push({ k: 'eof', s: src.length, e: src.length });
  return tokens;
}
