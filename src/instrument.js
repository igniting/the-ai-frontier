// Instruction counting for benchmarks: a deterministic cost measure that,
// unlike wall-clock time, does not depend on the machine or the JIT.
//
// Each function body is cut into straight-line segments (a segment ends
// at a control instruction or a call, and a new one begins wherever control
// can arrive: after block/loop/if/else/end, after a conditional branch, and
// after a call returns). The start of every segment adds its length to the
// exported i64 global `icount`. The counting code itself is not counted.

const ENDS_SEGMENT = new Set([
  'block', 'loop', 'if', 'else', 'end', 'br', 'br_if', 'br_table', 'return', 'unreachable',
  'call', 'call_indirect', 'return_call', 'return_call_indirect',
]);

export function instrumentModule(mod) {
  mod.addGlobal('$icount', 'i64', true, 0, 'icount');
  for (const f of mod.funcs) {
    const out = [];
    let start = 0, n = 0; // where the current segment's counter goes, and its length
    const close = () => {
      if (n) out.splice(start, 0, ['global.get', '$icount'], ['i64.const', n], ['i64.add'], ['global.set', '$icount']);
      start = out.length;
      n = 0;
    };
    for (const ins of f.body) {
      out.push(ins);
      n++;
      if (ENDS_SEGMENT.has(ins[0])) close();
    }
    close();
    f.body = out;
  }
}
