// Reference-count insertion, after Perceus (Reinking, Xie, de Moura and
// Leijen, "Perceus: Garbage Free Reference Counting with Reuse", 2021).
//
// Every variable that may point to the heap is *owned* by exactly one place
// at a time. A use either consumes the reference (passing it to a call,
// storing it in a new object, returning it) or borrows it (reading a field,
// comparing, printing). This pass makes ownership explicit:
//   * a variable consumed more than once is `dup`ed for the extra uses;
//   * a variable still needed later is `dup`ed before being consumed;
//   * a variable that is dead is `drop`ped as soon as possible: before the
//     next instruction if it is not used there, right after it if it is only
//     borrowed there.
// So memory is freed the moment it becomes unreachable: no garbage collector,
// no root scanning, and no cycles, because values are immutable.
//
// For `let x = <nested expression> in body`, variables the body still needs
// are *borrowed* inside the nested expression; the others are owned by it
// and must be consumed or dropped there.

export function makeHeapTest(adts) {
  const memo = new Map();
  return function isHeap(t) {
    if (t.k === 'tuple' || t.k === 'fun') return true;
    if (['Int', 'Bool', 'Unit'].includes(t.name)) return false;
    if (t.name === 'String' || t.name === 'Array') return true;
    if (!memo.has(t.name)) memo.set(t.name, adts.get(t.name).ctors.some((c) => c.fieldTypes.length));
    return memo.get(t.name);
  };
}

// Which argument positions of a builtin take ownership.
const BUILTIN_CONSUMES = {
  array_make: [false, true],
  array_set: [true, false, true],
  array_push: [true, true],
};

// `mutant` plants a known bug, to check that the test harness catches it.
export function perceus(fn, isHeap, mutant = null) {
  const fvCache = new WeakMap();
  const heapVar = (v) => isHeap(fn.vars.get(v));
  // A borrowed projection keeps the value it was read from alive. (Lowering
  // already guarantees this, since a match arm re-reads its fields from the
  // matched value after the guard; the rule keeps the pass correct on its own.)
  const peekSource = new Map();
  let fresh = 0;

  function atomVars(atoms) { return atoms.filter((a) => a.k === 'var').map((a) => a.v); }

  // Variables used by a right-hand side, split into consuming and borrowing uses.
  function uses(rhs) {
    switch (rhs.k) {
      case 'atom': return { consume: atomVars([rhs.a]), borrow: [] };
      case 'prim': return { consume: [], borrow: atomVars(rhs.args) };
      case 'cmp': return { consume: [], borrow: atomVars(rhs.args) };
      case 'call': return { consume: atomVars(rhs.args), borrow: [] };
      case 'callc': return { consume: atomVars([rhs.f, ...rhs.args]), borrow: [] };
      case 'ctor': case 'tuple': return { consume: atomVars(rhs.args), borrow: [] };
      case 'closure': return { consume: atomVars(rhs.captures), borrow: [] };
      case 'staticfn': return { consume: [], borrow: [] };
      case 'field': case 'peek': case 'testtag': case 'testlit': return { consume: [], borrow: atomVars([rhs.x]) };
      case 'envfield': return { consume: [], borrow: ['env'] };
      case 'builtin': {
        const mask = BUILTIN_CONSUMES[rhs.name] ?? [];
        const consume = [], borrow = [];
        rhs.args.forEach((a, i) => { if (a.k === 'var') (mask[i] ? consume : borrow).push(a.v); });
        return { consume, borrow };
      }
      default: throw new Error(`perceus: rhs ${rhs.k}`);
    }
  }

  function fv(e) {
    if (fvCache.has(e)) return fvCache.get(e);
    let s;
    switch (e.k) {
      case 'ret': s = rhsFv(e.rhs); break;
      case 'let': {
        s = new Set(fv(e.body));
        s.delete(e.v);
        for (const v of rhsFv(e.rhs)) s.add(v);
        break;
      }
      case 'if': s = new Set([...atomVars([e.c]), ...fv(e.t), ...fv(e.e)]); break;
      case 'unreachable': s = new Set(); break;
      default: throw new Error(`perceus: fv ${e.k}`);
    }
    fvCache.set(e, s);
    return s;
  }
  function rhsFv(rhs) {
    if (rhs.k === 'expr') return fv(rhs.e);
    const u = uses(rhs);
    return new Set([...u.consume, ...u.borrow]);
  }

  const wrapDups = (vars, body) => vars.reduceRight((b, v) => ({ k: 'dup', v, body: b }), body);
  const wrapDrops = (vars, body) => vars.reduceRight((b, v) => ({ k: 'drop', v, body: b }), body);

  // Plans the reference-count operations around one rhs.
  // Returns { pre: drops before, dups, post: drops after, owned: owned set afterwards }.
  function plan(rhs, owned, borrowed, liveAfter) {
    const { consume, borrow } = uses(rhs);
    const dups = [];
    const remaining = new Set(owned);
    const counts = new Map();
    for (const v of consume) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, n] of counts) {
      if (!heapVar(v)) continue;
      const canTransfer = remaining.has(v) && (mutant === 'perceus-transfer-live' || !liveAfter.has(v)) && !borrow.includes(v);
      const nDups = canTransfer ? n - 1 : n;
      for (let i = 0; i < nDups; i++) dups.push(v);
      if (canTransfer) remaining.delete(v);
    }
    const mentioned = new Set(mutant === 'perceus-drop-borrowed' ? consume : [...consume, ...borrow]);
    const pre = [...remaining].filter((v) => !mentioned.has(v) && !liveAfter.has(v));
    pre.forEach((v) => remaining.delete(v));
    const post = [...remaining].filter((v) => !liveAfter.has(v));
    post.forEach((v) => remaining.delete(v));
    return { pre, dups, post: mutant === 'perceus-no-post-drop' ? [] : post, owned: remaining };
  }

  // Live variables after an instruction, including the sources of live peeks.
  function live(vars) {
    const s = new Set(vars);
    for (const v of [...s]) for (let x = peekSource.get(v); x !== undefined; x = peekSource.get(x)) s.add(x);
    return s;
  }

  // retTy is the type of the value the expression produces.
  function go(e, owned, borrowed, retTy) {
    switch (e.k) {
      case 'unreachable': return e;
      case 'if': return { k: 'if', c: e.c, t: go(e.t, owned, borrowed, retTy), e: go(e.e, owned, borrowed, retTy) };
      case 'ret': {
        if (e.rhs.k === 'expr') return go(e.rhs.e, owned, borrowed, retTy);
        const p = plan(e.rhs, owned, borrowed, new Set());
        if (!p.post.length) return wrapDrops(p.pre, wrapDups(p.dups, e));
        // Something is only borrowed by the result: compute it, drop, then return it.
        const v = `res$${fresh++}`;
        fn.vars.set(v, retTy);
        return wrapDrops(p.pre, wrapDups(p.dups, { k: 'let', v, rhs: e.rhs, body: wrapDrops(p.post, { k: 'ret', rhs: { k: 'atom', a: { k: 'var', v } } }) }));
      }
      case 'let': {
        if (e.rhs.k === 'peek' && e.rhs.x.k === 'var') peekSource.set(e.v, e.rhs.x.v);
        const bodyFv = new Set(fv(e.body));
        bodyFv.delete(e.v);
        const liveAfter = live(bodyFv);
        if (e.rhs.k === 'expr') {
          const inner = new Set([...owned].filter((v) => !liveAfter.has(v)));
          const lent = new Set([...borrowed, ...[...owned].filter((v) => liveAfter.has(v))]);
          const sub = go(e.rhs.e, inner, lent, fn.vars.get(e.v));
          const after = new Set([...owned].filter((v) => liveAfter.has(v)));
          if (heapVar(e.v)) after.add(e.v);
          return { k: 'let', v: e.v, rhs: { k: 'expr', e: sub }, body: go(e.body, after, borrowed, retTy) };
        }
        const p = plan(e.rhs, owned, borrowed, liveAfter);
        const isBorrowedResult = fn.borrowed?.has(e.v);
        const next = new Set(p.owned);
        if (heapVar(e.v) && !isBorrowedResult) next.add(e.v);
        const nextBorrowed = isBorrowedResult ? new Set([...borrowed, e.v]) : borrowed;
        const body = go(e.body, next, nextBorrowed, retTy);
        return wrapDrops(p.pre, wrapDups(p.dups, { k: 'let', v: e.v, rhs: e.rhs, body: wrapDrops(p.post, body) }));
      }
      default: throw new Error(`perceus: ${e.k}`);
    }
  }

  const owned = new Set(fn.params.map((p) => p.v).filter(heapVar));
  fn.body = go(fn.body, owned, new Set(), fn.ret);
  return fn;
}

// A readable rendering of an IR function, with its reference-count operations.
export function showIR(fn) {
  const a = (x) => (x.k === 'var' ? x.v : x.k === 'int' ? String(x.n) : x.k === 'bool' ? String(x.b) : x.k === 'unit' ? '()' : JSON.stringify(x.s));
  const as = (xs) => xs.map(a).join(', ');
  const path = (r) => `${a(r.x)}${r.path.map((i) => `.${i}`).join('')}`;
  const rhs = (r, ind) => {
    switch (r.k) {
      case 'atom': return a(r.a);
      case 'prim': return `${r.op}(${as(r.args)})`;
      case 'cmp': return `cmp_${r.op}(${as(r.args)})`;
      case 'call': return `${r.fn}(${as(r.args)})`;
      case 'callc': return `${a(r.f)}(${as(r.args)})`;
      case 'ctor': return `ctor#${r.tag}${r.reuse ? `@${r.reuse}` : ''}(${as(r.args)})`;
      case 'tuple': return `${r.reuse ? `@${r.reuse}` : ''}(${as(r.args)})`;
      case 'closure': return `closure ${r.fn} [${as(r.captures)}]`;
      case 'staticfn': return `static ${r.fn}`;
      case 'field': return `field ${path(r)}`;
      case 'peek': return `peek ${path(r)}`;
      case 'testtag': return `is#${r.tag} ${path(r)}`;
      case 'testlit': return `is ${a(r.lit)} ${path(r)}`;
      case 'envfield': return `env.${r.i}`;
      case 'builtin': return `${r.name}(${as(r.args)})`;
      case 'expr': return `{\n${expr(r.e, ind + 1)}\n${'  '.repeat(ind)}}`;
      default: return r.k;
    }
  };
  const expr = (e, ind) => {
    const p = '  '.repeat(ind);
    switch (e.k) {
      case 'let': return `${p}let ${e.v} = ${rhs(e.rhs, ind)}\n${expr(e.body, ind)}`;
      case 'ret': return `${p}ret ${rhs(e.rhs, ind)}`;
      case 'dup': return `${p}dup ${e.v}\n${expr(e.body, ind)}`;
      case 'drop': return `${p}drop ${e.v}\n${expr(e.body, ind)}`;
      case 'dropreuse': return `${p}let ${e.r} = drop-reuse ${e.v}\n${expr(e.body, ind)}`;
      case 'freetoken': return `${p}free ${e.v}\n${expr(e.body, ind)}`;
      case 'if': return `${p}if ${a(e.c)} {\n${expr(e.t, ind + 1)}\n${p}} else {\n${expr(e.e, ind + 1)}\n${p}}`;
      case 'unreachable': return `${p}unreachable`;
      default: return `${p}${e.k}`;
    }
  };
  return `fn ${fn.name}(${fn.params.map((q) => q.v).join(', ')}) {\n${expr(fn.body, 1)}\n}`;
}
