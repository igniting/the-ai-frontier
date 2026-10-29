// Lexer: source text -> tokens. Each token is { t, v, s, e } where `t` is the
// token kind, `v` its value and [s, e) its span in the source.
//
// String literal values are *byte strings*: JS strings whose char codes are
// the UTF-8 bytes of the literal. The compiled program and the reference
// interpreter both operate on bytes, so they agree on lengths and ordering.

import { LumenError } from './diagnostics.js';

export const KEYWORDS = new Set(['fn', 'let', 'if', 'else', 'match', 'type', 'true', 'false']);

// Longest operators first so that maximal munch works with a simple scan.
const OPERATORS = [
  '|>', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '++', '..',
  '(', ')', '{', '}', '[', ']', ',', ';', ':', '<', '>', '+', '-', '*', '/', '%', '!', '=', '|',
];

export const MAX_INT = 2 ** 30 - 1; // Ints are 31-bit two's complement.

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdent = (c) => isIdentStart(c) || isDigit(c);

export function utf8Bytes(text) {
  let out = '';
  for (const b of new TextEncoder().encode(text)) out += String.fromCharCode(b);
  return out;
}

export function decodeBytes(byteString) {
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function lex(src) {
  const tokens = [];
  let i = 0;
  const err = (msg, s, e = s + 1) => { throw new LumenError(msg, { s, e }, { phase: 'syntax' }); };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      let depth = 0;
      do {
        if (src.startsWith('/*', i)) { depth++; i += 2; }
        else if (src.startsWith('*/', i)) { depth--; i += 2; }
        else if (i >= src.length) err('unterminated block comment', start, start + 2);
        else i++;
      } while (depth > 0);
      continue;
    }
    const s = i;
    if (isDigit(c)) {
      while (i < src.length && (isDigit(src[i]) || src[i] === '_')) i++;
      if (isIdentStart(src[i] ?? '')) err('invalid character in number literal', i);
      const value = Number(src.slice(s, i).replaceAll('_', ''));
      if (value > MAX_INT + 1) err(`integer literal ${src.slice(s, i)} does not fit in 31 bits`, s, i);
      tokens.push({ t: 'int', v: value, s, e: i });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < src.length && isIdent(src[i])) i++;
      const word = src.slice(s, i);
      if (KEYWORDS.has(word)) tokens.push({ t: word, v: word, s, e: i });
      else if (word[0] >= 'A' && word[0] <= 'Z') tokens.push({ t: 'uid', v: word, s, e: i });
      else tokens.push({ t: 'lid', v: word, s, e: i });
      continue;
    }
    if (c === '"') {
      i++;
      let bytes = '';
      let chunk = '';
      const flush = () => { bytes += utf8Bytes(chunk); chunk = ''; };
      while (true) {
        if (i >= src.length || src[i] === '\n') err('unterminated string literal', s, i);
        const ch = src[i];
        if (ch === '"') { i++; break; }
        if (ch === '\\') {
          const esc = src[i + 1];
          const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", 0: '\0' }[esc];
          if (simple !== undefined) { chunk += simple; i += 2; continue; }
          if (esc === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
            flush();
            bytes += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          err(`unknown escape sequence \\${esc ?? ''}`, i, i + 2);
        }
        const cp = src.codePointAt(i);
        chunk += String.fromCodePoint(cp);
        i += cp > 0xffff ? 2 : 1;
      }
      flush();
      tokens.push({ t: 'str', v: bytes, s, e: i });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) err(`unexpected character '${c}'`, s);
    i += op.length;
    tokens.push({ t: op, v: op, s, e: i });
  }
  tokens.push({ t: 'eof', v: '', s: src.length, e: src.length });
  return tokens;
}
