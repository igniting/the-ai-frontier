// An independent checker for DRUP refutations (as written by sat.js, or by
// any other solver that emits RUP lemmas).
//
// Each lemma must follow from the formula and the lemmas accepted before it
// by reverse unit propagation: assume every literal of the lemma false, then
// propagate unit clauses; a conflict must follow. The refutation is valid
// when the empty clause is reached this way. The checker is written
// separately from the solver and shares no code with it, so a bug in the
// solver cannot make it accept a wrong answer.

export function checkRefutation(nvars, clauses, proof, { mutant = null } = {}) {
  if (mutant === 'rup-accept-all') return { ok: true, lemmas: proof.length };
  const slot = (l) => (l > 0 ? 2 * l : -2 * l + 1); // watch-list index of a literal
  const val = new Int8Array(nvars + 1); // 0 unknown, 1 true, -1 false
  const value = (l) => (l > 0 ? val[l] : -val[-l]);
  const trail = new Int32Array(nvars + 1);
  const watch = Array.from({ length: 2 * nvars + 2 }, () => []); // clauses watching a literal, visited when it becomes false
  const db = [];
  const units = [];
  let hasEmpty = false;

  const add = (c) => {
    const lits = [...new Set(c)];
    if (!lits.length) { hasEmpty = true; return; }
    if (lits.length === 1) { units.push(lits[0]); return; }
    const ci = db.length;
    db.push(Int32Array.from(lits));
    watch[slot(lits[0])].push(ci);
    watch[slot(lits[1])].push(ci);
  };

  // Makes the literals true and propagates; reports whether a conflict follows.
  // The assignment is undone afterwards; the watches stay valid.
  const conflicts = (assumed) => {
    let top = 0, head = 0, conflict = false;
    const make = (l) => {
      const v = value(l);
      if (v === -1) return false;
      if (v === 0) { val[Math.abs(l)] = l > 0 ? 1 : -1; trail[top++] = l; }
      return true;
    };
    for (const l of units) if (!make(l)) { conflict = true; break; }
    if (!conflict) for (const l of assumed) if (!make(l)) { conflict = true; break; }
    while (!conflict && head < top) {
      const f = -trail[head++]; // this literal is now false
      const ws = watch[slot(f)];
      for (let i = 0; i < ws.length;) {
        const c = db[ws[i]];
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
        if (value(c[0]) === -1) { conflict = true; break; }
        make(c[0]);
        i++;
      }
    }
    for (let i = 0; i < top; i++) val[Math.abs(trail[i])] = 0;
    return conflict;
  };

  for (const c of clauses) add(c);
  if (hasEmpty) return { ok: true, lemmas: 0 };
  for (let i = 0; i < proof.length; i++) {
    const lemma = proof[i];
    if (lemma.some((l) => !Number.isInteger(l) || l === 0 || Math.abs(l) > nvars)) return { ok: false, reason: `lemma ${i + 1} mentions an unknown variable` };
    if (!conflicts(lemma.map((l) => -l))) return { ok: false, reason: `lemma ${i + 1} does not follow by unit propagation` };
    if (!lemma.length) return { ok: true, lemmas: i + 1 };
    add(lemma);
  }
  return { ok: false, reason: 'the proof does not derive the empty clause' };
}
