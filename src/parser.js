// Recursive-descent parser producing a span-annotated AST.
//
// Desugarings performed here (so every later phase sees a smaller language):
//   [a, b, ..rest]   ->  Cons(a, Cons(b, rest))       (expressions and patterns)
//   x |> f(a)        ->  f(x, a)
//   x |> f           ->  f(x)
//   -<int literal>   ->  negative literal

import { lex, MAX_INT } from './lexer.js';
import { LumenError } from './diagnostics.js';

const span = (s, e) => ({ s, e });

export function parse(src) {
  const toks = lex(src);
  let pos = 0;

  const peek = (o = 0) => toks[Math.min(pos + o, toks.length - 1)];
  const at = (t) => peek().t === t;
  const next = () => toks[pos++];
  const fail = (msg, tok = peek()) => {
    throw new LumenError(msg, span(tok.s, Math.max(tok.e, tok.s + 1)), { phase: 'syntax' });
  };
  const describe = (tok) => (tok.t === 'eof' ? 'end of input' : `'${src.slice(tok.s, tok.e)}'`);
  const expect = (t, what = `'${t}'`) => {
    if (!at(t)) fail(`expected ${what}, found ${describe(peek())}`);
    return next();
  };
  const accept = (t) => (at(t) ? next() : null);

  // Comma-separated list up to (and including) the closing token; trailing comma allowed.
  function commaList(close, item) {
    const items = [];
    while (!at(close)) {
      items.push(item());
      if (!accept(',')) break;
    }
    expect(close);
    return items;
  }

  function checkIntRange(tok, value) {
    if (value > MAX_INT) fail(`integer literal ${value} does not fit in 31 bits (max ${MAX_INT})`, tok);
  }

  // ---------------------------------------------------------------- types --
  function parseType() {
    const t = peek();
    if (accept('fn')) {
      expect('(');
      const params = commaList(')', parseType);
      expect('->');
      const ret = parseType();
      return { k: 'tfun', params, ret, span: span(t.s, ret.span.e) };
    }
    if (accept('(')) {
      const elems = commaList(')', parseType);
      const sp = span(t.s, toks[pos - 1].e);
      if (elems.length === 0) return { k: 'tname', name: 'Unit', args: [], span: sp };
      if (elems.length === 1 && toks[pos - 2].t !== ',') return elems[0];
      return { k: 'ttuple', elems, span: sp };
    }
    if (at('uid')) {
      const name = next();
      let args = [];
      if (accept('<')) {
        args = [];
        do {
          args.push(parseType());
        } while (accept(','));
        closeAngle();
      }
      return { k: 'tname', name: name.v, args, span: span(name.s, toks[pos - 1].e) };
    }
    if (at('lid')) {
      const v = next();
      return { k: 'tvar', name: v.v, span: span(v.s, v.e) };
    }
    fail(`expected a type, found ${describe(t)}`);
  }

  // `List<List<Int>>=` lexes the tail as `>` `>=`; split it so types close cleanly.
  function closeAngle() {
    const tok = peek();
    if (tok.t === '>=') {
      toks.splice(pos, 1, { t: '>', v: '>', s: tok.s, e: tok.s + 1 }, { t: '=', v: '=', s: tok.s + 1, e: tok.e });
    }
    expect('>');
  }

  // ------------------------------------------------------------- patterns --
  function parsePattern() {
    const t = peek();
    switch (t.t) {
      case 'lid':
        next();
        return t.v === '_' ? { k: 'pwild', span: span(t.s, t.e) } : { k: 'pvar', name: t.v, span: span(t.s, t.e) };
      case 'int':
        next();
        checkIntRange(t, t.v);
        return { k: 'pint', v: t.v, span: span(t.s, t.e) };
      case '-': {
        next();
        const n = expect('int', 'an integer literal');
        return { k: 'pint', v: -n.v, span: span(t.s, n.e) };
      }
      case 'str':
        next();
        return { k: 'pstr', v: t.v, span: span(t.s, t.e) };
      case 'true':
      case 'false':
        next();
        return { k: 'pbool', v: t.t === 'true', span: span(t.s, t.e) };
      case '(': {
        next();
        const elems = commaList(')', parsePattern);
        const sp = span(t.s, toks[pos - 1].e);
        if (elems.length === 0) return { k: 'punit', span: sp };
        if (elems.length === 1 && toks[pos - 2].t !== ',') return elems[0];
        return { k: 'ptuple', elems, span: sp };
      }
      case 'uid': {
        next();
        const args = accept('(') ? commaList(')', parsePattern) : [];
        return { k: 'pctor', name: t.v, args, span: span(t.s, toks[pos - 1].e) };
      }
      case '[': {
        next();
        const elems = [];
        let tail = null;
        while (!at(']')) {
          if (accept('..')) {
            tail = parsePattern();
            accept(',');
            break;
          }
          elems.push(parsePattern());
          if (!accept(',')) break;
        }
        const close = expect(']');
        let result = tail ?? { k: 'pctor', name: 'Nil', args: [], span: span(close.s, close.e), sugar: true };
        for (let i = elems.length - 1; i >= 0; i--) {
          result = { k: 'pctor', name: 'Cons', args: [elems[i], result], span: span(elems[i].span.s, close.e), sugar: true };
        }
        result.span = span(t.s, close.e);
        return result;
      }
    }
    fail(`expected a pattern, found ${describe(t)}`);
  }

  // ---------------------------------------------------------- expressions --
  function parseParams(close) {
    return commaList(close, () => {
      const name = peek().t === 'lid' ? next() : fail(`expected a parameter name, found ${describe(peek())}`);
      const ann = accept(':') ? parseType() : null;
      return { name: name.v, ann, span: span(name.s, name.e) };
    });
  }

  function parseExpr() {
    return parsePipe();
  }

  function parsePipe() {
    let lhs = parseBinary(0);
    while (at('|>')) {
      const op = next();
      const rhs = parseBinary(0);
      const sp = span(lhs.span.s, rhs.span.e);
      if (rhs.k === 'call') lhs = { k: 'call', fn: rhs.fn, args: [lhs, ...rhs.args], span: sp };
      else if (rhs.k === 'ctor' && rhs.args) lhs = { k: 'ctor', name: rhs.name, args: [lhs, ...rhs.args], span: sp, nameSpan: rhs.nameSpan };
      else if (rhs.k === 'ctor') lhs = { k: 'ctor', name: rhs.name, args: [lhs], span: sp, nameSpan: rhs.nameSpan };
      else lhs = { k: 'call', fn: rhs, args: [lhs], span: sp, pipe: op };
    }
    return lhs;
  }

  // Binary operator table: [tokens, associativity]. Lower index binds looser.
  const LEVELS = [
    [['||'], 'left'],
    [['&&'], 'left'],
    [['==', '!=', '<', '<=', '>', '>='], 'none'],
    [['++'], 'right'],
    [['+', '-'], 'left'],
    [['*', '/', '%'], 'left'],
  ];

  function parseBinary(level) {
    if (level === LEVELS.length) return parseUnary();
    const [ops, assoc] = LEVELS[level];
    let lhs = parseBinary(level + 1);
    while (ops.includes(peek().t)) {
      const op = next();
      const rhs = assoc === 'right' ? parseBinary(level) : parseBinary(level + 1);
      lhs = { k: 'binop', op: op.t, l: lhs, r: rhs, span: span(lhs.span.s, rhs.span.e), opSpan: span(op.s, op.e) };
      if (assoc === 'none' && ops.includes(peek().t)) {
        fail(`comparison operators cannot be chained; use parentheses`);
      }
      if (assoc === 'right') break;
    }
    return lhs;
  }

  function parseUnary() {
    const t = peek();
    if (t.t === '-' && peek(1).t === 'int' && peek(1).s === t.e) {
      next();
      const n = next();
      return parsePostfix({ k: 'int', v: -n.v, span: span(t.s, n.e) });
    }
    if (t.t === '-' || t.t === '!') {
      next();
      const e = parseUnary();
      return { k: 'unop', op: t.t, e, span: span(t.s, e.span.e) };
    }
    return parsePostfix(parsePrimary());
  }

  function parsePostfix(e) {
    while (at('(')) {
      next();
      const args = commaList(')', parseExpr);
      e = { k: 'call', fn: e, args, span: span(e.span.s, toks[pos - 1].e) };
    }
    return e;
  }

  function parsePrimary() {
    const t = peek();
    switch (t.t) {
      case 'int':
        next();
        checkIntRange(t, t.v);
        return { k: 'int', v: t.v, span: span(t.s, t.e) };
      case 'str':
        next();
        return { k: 'str', v: t.v, span: span(t.s, t.e) };
      case 'true':
      case 'false':
        next();
        return { k: 'bool', v: t.t === 'true', span: span(t.s, t.e) };
      case 'lid':
        next();
        if (t.v === '_') fail(`'_' can only be used in patterns`, t);
        return { k: 'var', name: t.v, span: span(t.s, t.e) };
      case 'uid': {
        next();
        const nameSpan = span(t.s, t.e);
        if (accept('(')) {
          const args = commaList(')', parseExpr);
          return { k: 'ctor', name: t.v, args, span: span(t.s, toks[pos - 1].e), nameSpan };
        }
        return { k: 'ctor', name: t.v, args: null, span: nameSpan, nameSpan };
      }
      case '(': {
        next();
        const elems = commaList(')', parseExpr);
        const sp = span(t.s, toks[pos - 1].e);
        if (elems.length === 0) return { k: 'unit', span: sp };
        if (elems.length === 1 && toks[pos - 2].t !== ',') return { ...elems[0], span: sp, paren: true };
        return { k: 'tuple', elems, span: sp };
      }
      case '[': {
        next();
        const elems = [];
        let tail = null;
        while (!at(']')) {
          if (accept('..')) {
            tail = parseExpr();
            accept(',');
            break;
          }
          elems.push(parseExpr());
          if (!accept(',')) break;
        }
        const close = expect(']');
        let result = tail ?? { k: 'ctor', name: 'Nil', args: null, span: span(close.s, close.e), nameSpan: span(close.s, close.e), sugar: true };
        for (let i = elems.length - 1; i >= 0; i--) {
          result = { k: 'ctor', name: 'Cons', args: [elems[i], result], span: span(elems[i].span.s, close.e), nameSpan: span(t.s, t.e), sugar: true };
        }
        return { ...result, span: span(t.s, close.e) };
      }
      case 'fn': {
        next();
        expect('(');
        const params = parseParams(')');
        const ret = accept('->') ? parseType() : null;
        const body = parseBlock();
        return { k: 'lambda', params, ret, body, span: span(t.s, body.span.e) };
      }
      case '|':
      case '||': {
        next();
        const params = t.t === '||' ? [] : parseParams('|');
        const body = parseExpr();
        return { k: 'lambda', params, ret: null, body, span: span(t.s, body.span.e) };
      }
      case 'if':
        return parseIf();
      case 'match':
        return parseMatch();
      case '{':
        return parseBlock();
    }
    fail(`expected an expression, found ${describe(t)}`);
  }

  function parseIf() {
    const t = expect('if');
    const c = parseExpr();
    const thenB = parseBlock();
    let elseB = null;
    if (accept('else')) elseB = at('if') ? parseIf() : parseBlock();
    return { k: 'if', c, t: thenB, e: elseB, span: span(t.s, (elseB ?? thenB).span.e) };
  }

  function parseMatch() {
    const t = expect('match');
    const scrut = parseExpr();
    expect('{', `'{' to start the match arms`);
    const arms = [];
    while (!at('}')) {
      const pat = parsePattern();
      const guard = accept('if') ? parseExpr() : null;
      expect('->', `'->' after the match pattern`);
      const body = parseExpr();
      arms.push({ pat, guard, body, span: span(pat.span.s, body.span.e) });
      if (!accept(',') && !at('}') && body.k !== 'block' && body.k !== 'match' && body.k !== 'if') {
        fail(`expected ',' or '}' after match arm, found ${describe(peek())}`);
      }
    }
    const close = expect('}');
    if (arms.length === 0) fail('match needs at least one arm', close);
    return { k: 'match', e: scrut, arms, span: span(t.s, close.e) };
  }

  function parseFnDecl(isLocal) {
    const start = expect('fn');
    const name = expect('lid', 'a function name');
    expect('(');
    const params = parseParams(')');
    const ret = accept('->') ? parseType() : null;
    const body = parseBlock();
    return { k: 'fn', name: name.v, nameSpan: span(name.s, name.e), params, ret, body, span: span(start.s, body.span.e), isLocal };
  }

  function parseBlock() {
    const open = expect('{');
    const stmts = [];
    let result = null;
    while (!at('}')) {
      if (at('let')) {
        const t = next();
        const pat = parsePattern();
        const ann = accept(':') ? parseType() : null;
        expect('=');
        const e = parseExpr();
        expect(';', `';' after let binding`);
        stmts.push({ k: 'let', pat, ann, e, span: span(t.s, e.span.e) });
        continue;
      }
      if (at('fn') && peek(1).t === 'lid') {
        stmts.push(parseFnDecl(true));
        continue;
      }
      const e = parseExpr();
      if (accept(';')) {
        stmts.push({ k: 'expr', e, span: e.span });
        continue;
      }
      if (at('}')) {
        result = e;
        break;
      }
      if (e.k === 'if' || e.k === 'match' || e.k === 'block') {
        stmts.push({ k: 'expr', e, span: e.span });
        continue;
      }
      fail(`expected ';' or '}' after expression, found ${describe(peek())}`);
    }
    const close = expect('}');
    return { k: 'block', stmts, result, span: span(open.s, close.e) };
  }

  // --------------------------------------------------------- declarations --
  function parseTypeDecl() {
    const t = expect('type');
    const name = expect('uid', 'a type name (capitalized)');
    const params = [];
    if (accept('<')) {
      do {
        params.push(expect('lid', 'a type parameter').v);
      } while (accept(','));
      closeAngle();
    }
    expect('{');
    const ctors = commaList('}', () => {
      const c = expect('uid', 'a constructor name (capitalized)');
      const fields = accept('(') ? commaList(')', parseType) : [];
      return { name: c.v, fields, span: span(c.s, toks[pos - 1].e) };
    });
    return { k: 'type', name: name.v, nameSpan: span(name.s, name.e), params, ctors, span: span(t.s, toks[pos - 1].e) };
  }

  const decls = [];
  while (!at('eof')) {
    if (at('type')) decls.push(parseTypeDecl());
    else if (at('fn')) decls.push(parseFnDecl(false));
    else fail(`expected a top-level 'fn' or 'type' declaration, found ${describe(peek())}`);
  }
  return { decls };
}
