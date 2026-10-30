// Recursive-descent parser producing a span-annotated syntax tree.
//
// Desugarings done here, so later phases see a smaller language:
//   [a, b, ..rest]  ->  Cons(a, Cons(b, rest))   (expressions and patterns; always the prelude's List)
//   x |> f(a)       ->  f(x, a)        x |> f  ->  f(x)
//   -<int literal>  ->  negative literal

import { lex, MAX_INT } from './lexer.js';
import { LumenError } from './diagnostics.js';

const sp = (s, e) => ({ s, e });

export function parse(src) {
  const toks = lex(src);
  let pos = 0;
  const peek = (o = 0) => toks[pos + o];
  const at = (k) => peek().k === k;
  const next = () => toks[pos++];
  const fail = (msg, t = peek()) => { throw new LumenError(msg, sp(t.s, t.e)); };
  const describe = (t) => (t.k === 'eof' ? 'end of input' : t.k === 'lower' || t.k === 'upper' ? `\`${t.v}\`` : t.k === 'int' ? 'a number' : t.k === 'str' ? 'a string' : `\`${t.k}\``);
  const expect = (k, what = `\`${k}\``) => (at(k) ? next() : fail(`expected ${what}, found ${describe(peek())}`));
  const accept = (k) => (at(k) ? next() : null);

  // ------------------------------------------------------------- types --
  // `io` is shorthand for all four capabilities.
  const IO = ['input', 'output', 'clock', 'random'];
  const KNOWN = new Set([...IO, 'fail']);
  const expand = (l) => (l === 'io' ? IO : [l]);

  function effect() {
    // `! output`, `! e`, `! {output, fail}`, `! {io | e}`, `! {}`
    const start = expect('!');
    const labels = [];
    let tail = null;
    if (accept('{')) {
      while (!at('}') && !at('|')) {
        labels.push(...expand(expect('lower', 'an effect name').v));
        if (!accept(',')) break;
      }
      if (accept('|')) tail = expect('lower', 'an effect variable').v;
      const end = expect('}');
      return { labels, tail, span: sp(start.s, end.e) };
    }
    const t = expect('lower', 'an effect');
    // A known effect is closed; any other lowercase name is an effect variable.
    if (t.v === 'io' || KNOWN.has(t.v)) return { labels: expand(t.v), tail: null, span: sp(start.s, t.e) };
    return { labels: [], tail: t.v, span: sp(start.s, t.e) };
  }

  function type() {
    const t = peek();
    if (accept('fn')) {
      expect('(');
      const params = [];
      while (!at(')')) { params.push(type()); if (!accept(',')) break; }
      expect(')');
      expect('->');
      const ret = type();
      const eff = at('!') ? effect() : null;
      return { k: 'tfun', params, ret, eff, span: sp(t.s, (eff ?? ret).span.e) };
    }
    if (accept('(')) {
      if (accept(')')) return { k: 'tcon', name: 'Unit', args: [], span: sp(t.s, toks[pos - 1].e) };
      const first = type();
      if (accept(')')) return first;
      const elems = [first];
      while (accept(',')) { if (at(')')) break; elems.push(type()); }
      const end = expect(')');
      return { k: 'ttuple', elems, span: sp(t.s, end.e) };
    }
    if (at('lower')) { next(); return { k: 'tvar', name: t.v, span: sp(t.s, t.e) }; }
    if (at('upper')) {
      next();
      const args = [];
      let end = t.e;
      if (accept('<')) {
        while (!at('>')) { args.push(type()); if (!accept(',')) break; }
        end = expect('>').e;
      }
      return { k: 'tcon', name: t.v, args, span: sp(t.s, end) };
    }
    return fail(`expected a type, found ${describe(t)}`);
  }

  // ---------------------------------------------------------- patterns --
  function pattern() {
    const t = peek();
    if (at('lower')) {
      next();
      return t.v === '_' ? { k: 'pwild', span: sp(t.s, t.e) } : { k: 'pvar', name: t.v, span: sp(t.s, t.e) };
    }
    if (at('int')) { next(); return { k: 'pint', v: checkInt(t.v, t), span: sp(t.s, t.e) }; }
    if (at('-') && peek(1).k === 'int') {
      next();
      const n = next();
      return { k: 'pint', v: checkInt(-n.v, n), span: sp(t.s, n.e) };
    }
    if (at('str')) { next(); return { k: 'pstr', v: t.v, span: sp(t.s, t.e) }; }
    if (at('true') || at('false')) { next(); return { k: 'pbool', v: t.k === 'true', span: sp(t.s, t.e) }; }
    if (accept('(')) {
      if (accept(')')) return { k: 'punit', span: sp(t.s, toks[pos - 1].e) };
      const first = pattern();
      if (accept(')')) return first;
      const elems = [first];
      while (accept(',')) { if (at(')')) break; elems.push(pattern()); }
      const end = expect(')');
      return { k: 'ptuple', elems, span: sp(t.s, end.e) };
    }
    if (accept('[')) {
      const elems = [];
      let rest = { k: 'pctor', name: 'Nil', args: [], list: true, span: sp(t.s, t.e) };
      while (!at(']')) {
        if (at('..')) {
          const dots = next();
          rest = at(']') ? { k: 'pwild', span: sp(dots.s, dots.e) } : pattern();
          break;
        }
        elems.push(pattern());
        if (!accept(',')) break;
      }
      const end = expect(']');
      let p = rest;
      for (let i = elems.length - 1; i >= 0; i--) p = { k: 'pctor', name: 'Cons', args: [elems[i], p], list: true, span: sp(elems[i].span.s, end.e) };
      if (p.k === 'pctor' && p.name === 'Nil') p.span = sp(t.s, end.e);
      return p;
    }
    if (at('upper')) {
      next();
      const args = [];
      let end = t.e;
      if (accept('(')) {
        while (!at(')')) { args.push(pattern()); if (!accept(',')) break; }
        end = expect(')').e;
      }
      return { k: 'pctor', name: t.v, args, span: sp(t.s, end) };
    }
    return fail(`expected a pattern, found ${describe(t)}`);
  }

  function checkInt(v, t) {
    if (v > MAX_INT || v < -MAX_INT - 1n) fail('integer literal out of range (64-bit integers)', t);
    return v;
  }

  // ------------------------------------------------------- expressions --
  function expr() { return pipe(); }

  function pipe() {
    let e = binary(0);
    while (at('|>')) {
      next();
      const rhs = binary(0);
      if (rhs.k === 'call') e = { k: 'call', fn: rhs.fn, args: [e, ...rhs.args], span: sp(e.span.s, rhs.span.e) };
      else e = { k: 'call', fn: rhs, args: [e], span: sp(e.span.s, rhs.span.e) };
    }
    return e;
  }

  const LEVELS = [['||'], ['&&'], ['==', '!=', '<', '<=', '>', '>='], ['++'], ['+', '-'], ['*', '/', '%']];
  function binary(level) {
    if (level === LEVELS.length) return unary();
    const ops = LEVELS[level];
    let l = binary(level + 1);
    if (level === 2) { // comparisons do not chain
      if (ops.includes(peek().k)) {
        const op = next().k;
        const r = binary(level + 1);
        l = { k: 'binop', op, l, r, span: sp(l.span.s, r.span.e) };
        if (ops.includes(peek().k)) fail('comparison operators cannot be chained; use parentheses');
      }
      return l;
    }
    if (level === 3) { // ++ is right-associative
      if (at('++')) {
        next();
        const r = binary(level);
        return { k: 'binop', op: '++', l, r, span: sp(l.span.s, r.span.e) };
      }
      return l;
    }
    while (ops.includes(peek().k)) {
      const op = next().k;
      const r = binary(level + 1);
      l = { k: 'binop', op, l, r, span: sp(l.span.s, r.span.e) };
    }
    return l;
  }

  function unary() {
    const t = peek();
    if (at('-')) {
      next();
      if (at('int')) {
        const n = next();
        return postfix({ k: 'int', v: checkInt(-n.v, n), span: sp(t.s, n.e) });
      }
      const e = unary();
      return { k: 'unop', op: '-', e, span: sp(t.s, e.span.e) };
    }
    if (at('!')) {
      next();
      const e = unary();
      return { k: 'unop', op: '!', e, span: sp(t.s, e.span.e) };
    }
    return postfix(primary());
  }

  function postfix(e) {
    while (at('(')) {
      next();
      const args = [];
      while (!at(')')) { args.push(expr()); if (!accept(',')) break; }
      const end = expect(')');
      e = { k: 'call', fn: e, args, span: sp(e.span.s, end.e) };
    }
    return e;
  }

  function primary() {
    const t = peek();
    switch (t.k) {
      case 'int': next(); return { k: 'int', v: checkInt(t.v, t), span: sp(t.s, t.e) };
      case 'str': next(); return { k: 'str', v: t.v, span: sp(t.s, t.e) };
      case 'true': case 'false': next(); return { k: 'bool', v: t.k === 'true', span: sp(t.s, t.e) };
      case 'lower': next(); return { k: 'var', name: t.v, span: sp(t.s, t.e) };
      case 'upper': {
        next();
        if (at('(')) {
          next();
          const args = [];
          while (!at(')')) { args.push(expr()); if (!accept(',')) break; }
          const end = expect(')');
          return { k: 'ctor', name: t.v, args, span: sp(t.s, end.e) };
        }
        return { k: 'ctor', name: t.v, args: null, span: sp(t.s, t.e) };
      }
      case '(': {
        next();
        if (accept(')')) return { k: 'unit', span: sp(t.s, toks[pos - 1].e) };
        const first = expr();
        if (accept(')')) return first;
        const elems = [first];
        while (accept(',')) { if (at(')')) break; elems.push(expr()); }
        const end = expect(')');
        return { k: 'tuple', elems, span: sp(t.s, end.e) };
      }
      case '[': {
        next();
        const elems = [];
        let rest = null;
        while (!at(']')) {
          if (accept('..')) { rest = expr(); break; }
          elems.push(expr());
          if (!accept(',')) break;
        }
        const end = expect(']');
        let e = rest ?? { k: 'ctor', name: 'Nil', args: [], list: true, span: sp(t.s, end.e) };
        for (let i = elems.length - 1; i >= 0; i--) e = { k: 'ctor', name: 'Cons', args: [elems[i], e], list: true, span: sp(elems[i].span.s, end.e) };
        return e;
      }
      case '{': return block();
      case 'if': return ifExpr();
      case 'match': return matchExpr();
      case '|': case '||': return lambda();
      default: return fail(`expected an expression, found ${describe(t)}`);
    }
  }

  function lambda() {
    const t = next();
    const params = [];
    if (t.k === '|') {
      while (!at('|')) { params.push(param()); if (!accept(',')) break; }
      expect('|');
    }
    const body = expr();
    return { k: 'lambda', params, body, span: sp(t.s, body.span.e) };
  }

  function param() {
    const t = expect('lower', 'a parameter name');
    const ann = accept(':') ? type() : null;
    return { name: t.v, ann, span: sp(t.s, t.e) };
  }

  function ifExpr() {
    const t = expect('if');
    const cond = expr();
    const then = block();
    let els = null;
    if (accept('else')) els = at('if') ? ifExpr() : block();
    return { k: 'if', cond, then, else: els, span: sp(t.s, (els ?? then).span.e) };
  }

  function matchExpr() {
    const t = expect('match');
    const scrut = expr();
    expect('{');
    const arms = [];
    while (!at('}')) {
      const pat = pattern();
      const guard = accept('if') ? expr() : null;
      expect('->');
      const body = expr();
      arms.push({ pat, guard, body, span: sp(pat.span.s, body.span.e) });
      if (!accept(',') && !at('}') && !['block', 'if', 'match'].includes(body.k)) fail(`expected \`,\` or \`}\`, found ${describe(peek())}`);
    }
    const end = expect('}');
    return { k: 'match', scrut, arms, span: sp(t.s, end.e) };
  }

  function block() {
    const t = expect('{');
    const stmts = [];
    let result = null;
    while (!at('}')) {
      if (at('let')) {
        const l = next();
        const pat = pattern();
        const ann = accept(':') ? type() : null;
        expect('=');
        const value = expr();
        expect(';');
        stmts.push({ k: 'let', pat, ann, value, span: sp(l.s, value.span.e) });
        continue;
      }
      if (at('fn') && peek(1).k === 'lower') {
        stmts.push({ k: 'fndecl', fn: fnDecl() });
        continue;
      }
      const e = expr();
      if (accept(';')) { stmts.push({ k: 'expr', e }); continue; }
      if (at('}')) { result = e; break; }
      if (['if', 'match', 'block'].includes(e.k)) { stmts.push({ k: 'expr', e }); continue; }
      fail(`expected \`;\` or \`}\`, found ${describe(peek())}`);
    }
    const end = expect('}');
    return { k: 'block', stmts, result, span: sp(t.s, end.e) };
  }

  function fnDecl() {
    const t = expect('fn');
    const name = expect('lower', 'a function name');
    expect('(');
    const params = [];
    while (!at(')')) { params.push(param()); if (!accept(',')) break; }
    expect(')');
    const ret = accept('->') ? type() : null;
    const eff = at('!') ? effect() : null;
    const body = block();
    return { k: 'fn', name: name.v, params, ret, eff, body, span: sp(t.s, body.span.e), nameSpan: sp(name.s, name.e) };
  }

  function typeDecl() {
    const t = expect('type');
    const name = expect('upper', 'a type name');
    const params = [];
    if (accept('<')) {
      while (!at('>')) { params.push(expect('lower', 'a type parameter').v); if (!accept(',')) break; }
      expect('>');
    }
    expect('{');
    const ctors = [];
    while (!at('}')) {
      const c = expect('upper', 'a constructor name');
      const fields = [];
      let end = c.e;
      if (accept('(')) {
        while (!at(')')) { fields.push(type()); if (!accept(',')) break; }
        end = expect(')').e;
      }
      ctors.push({ name: c.v, fields, span: sp(c.s, end) });
      if (!accept(',')) break;
    }
    const end = expect('}');
    return { k: 'typedecl', name: name.v, params, ctors, span: sp(t.s, end.e), nameSpan: sp(name.s, name.e) };
  }

  const types = [], fns = [];
  while (!at('eof')) {
    if (at('type')) types.push(typeDecl());
    else if (at('fn')) fns.push(fnDecl());
    else fail(`expected \`fn\` or \`type\` at the top level, found ${describe(peek())}`);
  }
  return { types, fns };
}
