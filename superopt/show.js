// Renders rules for humans: compact stack code, and the same code as an
// expression over the stack inputs (a, b) and locals (x0, x1, ...).

const SHORT = { 'i32.const': '', 'local.get': '' };

function kText({ k, f, d }) {
  switch (f) {
    case 'id': return k;
    case 'sum': return `${k}+${d}`;
    case 'diff': return `${k}-${d}`;
    case 'add': return d < 0 ? `${k}-${-d}` : `${k}+${d}`;
    case 'neg': return `-${k}`;
    case 'shl1': return `2*${k}`;
    case 'shr1': return `${k}/2`;
  }
  return '?';
}

export function show(code) {
  return code.map(([op, arg]) => {
    if (op === 'kconst') return kText(arg);
    if (op in SHORT) return String(arg);
    return op.replace(/^i32\./, '');
  }).join(' ');
}

const INFIX = {
  'i32.add': '+', 'i32.sub': '-', 'i32.mul': '*', 'i32.and': '&', 'i32.or': '|', 'i32.xor': '^', 'i32.shl': '<<',
  'i32.shr_s': '>>', 'i32.shr_u': '>>>', 'i32.eq': '==', 'i32.ne': '!=', 'i32.lt_s': '<', 'i32.gt_s': '>',
  'i32.le_s': '<=', 'i32.ge_s': '>=', 'i32.lt_u': '<u', 'i32.gt_u': '>u', 'i32.le_u': '<=u', 'i32.ge_u': '>=u',
};

export function showExpr(code, inputs) {
  const s = Array.from({ length: inputs }, (_, i) => ({ t: 'ab'[i] ?? `in${i}`, atom: true }));
  const wrap = (e) => (e.atom ? e.t : `(${e.t})`);
  for (const [op, arg] of code) {
    if (op === 'kconst') s.push({ t: kText(arg), atom: arg.f === 'id' });
    else if (op === 'i32.const' || op === 'local.get') s.push({ t: String(arg), atom: !(typeof arg === 'number' && arg < 0) });
    else if (op === 'i32.eqz') s.push({ t: `!${wrap(s.pop())}`, atom: true });
    else if (op === 'select') { const c = s.pop(), b = s.pop(), a = s.pop(); s.push({ t: `${wrap(c)} ? ${wrap(a)} : ${wrap(b)}` }); }
    else { const b = s.pop(), a = s.pop(); s.push({ t: `${wrap(a)} ${INFIX[op]} ${wrap(b)}` }); }
  }
  return s.map((e) => e.t).join(', ');
}
