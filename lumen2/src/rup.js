// An independent checker for DRUP refutations (as written by sat.js, or by
// any other solver that emits RUP lemmas).
//
// Each lemma must follow from the formula and the lemmas accepted before it
// by reverse unit propagation: assume every literal of the lemma false, then
// propagate unit clauses; a conflict must follow. The refutation is valid
// when the empty clause is reached this way. The checker is written
// separately from the solver and shares no code with it, so a bug in the
// solver cannot make it accept a wrong answer.
//
// What unit propagation derives from the clauses alone (the top level) is
// kept between lemmas, so each check only propagates its own assumptions.
//
// A proof may also delete clauses ({ d: [literals] }, from a DRUP line
// "d literals 0"): later lemmas are checked without them, which is faster
// and only ever harder to pass. What the top level derived while a deleted
// clause was there stays: it follows from the formula either way.

export function checkRefutation(nvars, clauses, proof, { mutant = null } = {}) {
  if (mutant === 'rup-accept-all') return { ok: true, lemmas: proof.length };
  const slot = (l) => (l > 0 ? 2 * l : -2 * l + 1); // watch-list index of a literal
  const val = new Int8Array(nvars + 1); // 0 unknown, 1 true, -1 false
  const value = (l) => (l > 0 ? val[l] : -val[-l]);
  const trail = new Int32Array(nvars + 1);
  const watch = Array.from({ length: 2 * nvars + 2 }, () => []); // clauses watching a literal, visited when it becomes false
  const db = []; // clauses (null once deleted)
  const byKey = new Map(); // a clause's sorted literals -> indices in db of its copies
  let top = 0; // trail length
  let base = 0; // the top-level part of the trail, kept between checks
  let head = 0; // the next trail position to propagate
  let refuted = false; // the top level itself is contradictory

  const make = (l) => {
    const v = value(l);
    if (v === -1) return false;
    if (v === 0) { val[Math.abs(l)] = l > 0 ? 1 : -1; trail[top++] = l; }
    return true;
  };
  // Propagates from the trail position `head`; returns true on a conflict.
  const propagate = () => {
    while (head < top) {
      const f = -trail[head++]; // this literal is now false
      const ws = watch[slot(f)];
      for (let i = 0; i < ws.length;) {
        const c = db[ws[i]];
        if (c === null) { ws[i] = ws[ws.length - 1]; ws.pop(); continue; } // deleted
        if (c[0] === f) { c[0] = c[1]; c[1] = f; }
        if (value(c[0]) === 1) { i++; continue; }
        let moved = false;
        for (let k = 2; k < c.length; k++) {
          if (value(c[k]) !== -1) {
            c[1] = c[k]; c[k] = f;
            watch[slot(c[1])].push(ws[i]);
            ws[i] = ws[ws.length - 1]; ws.pop();
            moved = true;
            break;
          }
        }
        if (moved) continue;
        if (value(c[0]) === -1) return true;
        make(c[0]);
        i++;
      }
    }
    return false;
  };
  const undoTo = (n) => { while (top > n) val[Math.abs(trail[--top])] = 0; head = n; };

  // Adds a clause at the top level, watching two literals that are not false
  // there if it has them; a clause that is unit or false there is propagated.
  const add = (c) => {
    const lits = [...new Set(c)];
    if (lits.some((l) => lits.includes(-l))) return; // a tautology
    lits.sort((x, y) => (value(y) !== -1) - (value(x) !== -1)); // non-false literals first
    const open = lits.filter((l) => value(l) !== -1).length;
    if (lits.length >= 2) {
      const ci = db.length;
      const k = [...lits].sort((x, y) => x - y).join(' ');
      if (byKey.has(k)) byKey.get(k).push(ci); else byKey.set(k, [ci]);
      db.push(Int32Array.from(lits));
      watch[slot(lits[0])].push(ci);
      watch[slot(lits[1])].push(ci);
    }
    if (open === 0) { refuted = true; return; }
    if (open === 1 && value(lits[0]) === 0) {
      make(lits[0]);
      if (propagate()) refuted = true;
      base = top;
    }
  };

  for (const c of clauses) {
    if (!c.length) return { ok: true, lemmas: 0 };
    add(c);
    if (refuted) return { ok: true, lemmas: 0 };
  }
  for (let i = 0; i < proof.length; i++) {
    const lemma = proof[i];
    if (!Array.isArray(lemma)) {
      // A deletion: one copy of the clause is no longer used (unknown clauses are ignored).
      const copies = byKey.get([...new Set(lemma.d)].sort((x, y) => x - y).join(' '));
      if (copies?.length) db[copies.pop()] = null;
      continue;
    }
    if (lemma.some((l) => !Number.isInteger(l) || l === 0 || Math.abs(l) > nvars)) return { ok: false, reason: `lemma ${i + 1} mentions an unknown variable` };
    // Assume the lemma false and propagate; then return to the top level.
    let conflict = false;
    for (const l of lemma) if (!make(-l)) { conflict = true; break; }
    if (!conflict) conflict = propagate();
    undoTo(base);
    if (!conflict) return { ok: false, reason: `lemma ${i + 1} does not follow by unit propagation` };
    if (!lemma.length) return { ok: true, lemmas: i + 1 };
    add(lemma);
    if (refuted) return { ok: true, lemmas: i + 1 };
  }
  return { ok: false, reason: 'the proof does not derive the empty clause' };
}
