// Pretty-printer for the A-normal-form IR (shown in the playground).

const atom = (a) => {
  switch (a.k) {
    case 'var': return `${a.v.name}${a.v.traced ? '' : '#'}${a.v.id}`;
    case 'imm': return `${a.n >> 1}`;
    case 'str': return `str${a.idx}`;
    case 'sclo': return `&${a.fn}`;
    case 'envf': return `env[${a.i}]`;
    case 'self': return 'self';
  }
};

const path = (p) => p.map((i) => `.${i}`).join('');

function expr(e, ind) {
  const pad = '  '.repeat(ind);
  switch (e.k) {
    case 'atom': return atom(e.a);
    case 'let': {
      const v = `${e.v.name}${e.v.traced ? '' : '#'}${e.v.id}`;
      return `let ${v} = ${expr(e.rhs, ind + 1)}\n${pad}${expr(e.body, ind)}`;
    }
    case 'seq': return `${expr(e.first, ind + 1)};\n${pad}${expr(e.rest, ind)}`;
    case 'prim': return `${e.op}(${e.args.map(atom).join(', ')})`;
    case 'builtin': return `${e.name}(${e.args.map(atom).join(', ')})`;
    case 'call': return `call ${e.fn}${e.env ? `[${atom(e.env)}]` : ''}(${e.args.map(atom).join(', ')})`;
    case 'callc': return `callc ${atom(e.clo)}(${e.args.map(atom).join(', ')})`;
    case 'alloc': return `alloc tag${e.tag}(${e.args.map(atom).join(', ')})`;
    case 'closure': return `closure ${e.fn}[${e.captured.map(atom).join(', ')}]`;
    case 'if':
      return `if ${atom(e.c)} {\n${pad}  ${expr(e.t, ind + 1)}\n${pad}} else {\n${pad}  ${expr(e.e, ind + 1)}\n${pad}}`;
    case 'match': {
      const arms = e.arms.map((arm) => {
        const tests = arm.tests.map((t) => {
          const at = `${atom(e.scrut)}${path(t.path)}`;
          if (t.k === 'imm') return `${at} == ${t.n >> 1}`;
          if (t.k === 'isblock') return `is_block(${at})`;
          if (t.k === 'tag') return `tag(${at}) == ${t.tag}`;
          return `${at} == str${t.idx}`;
        });
        const binds = arm.binds.map((b) => `${b.v.name}${b.v.traced ? '' : '#'}${b.v.id} = ${atom(e.scrut)}${path(b.path)}`);
        const head = [tests.length ? tests.join(' && ') : 'always', ...(binds.length ? [`bind ${binds.join(', ')}`] : [])].join('; ');
        const guard = arm.guard ? ` if ${expr(arm.guard, ind + 2)}` : '';
        return `${pad}  [${head}]${guard} =>\n${pad}    ${expr(arm.body, ind + 2)}`;
      });
      return `match ${atom(e.scrut)} {\n${arms.join('\n')}\n${pad}}`;
    }
  }
  return `?${e.k}`;
}

export function printIR(funcs) {
  return funcs.map((f) => {
    const params = f.params.map((v) => `${v.name}${v.traced ? '' : '#'}${v.id}`).join(', ');
    return `fn ${f.name}(${params})${f.env ? ' [closure]' : ''} {\n  ${expr(f.body, 1)}\n}`;
  }).join('\n\n') + '\n\n// `x#3` = untraced (immediate-only) variable, kept out of the GC root set';
}
