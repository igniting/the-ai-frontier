// A small WebAssembly module builder and binary encoder.
//
// Instructions are arrays [opcode-name, ...immediates]. Functions, globals,
// locals, types and branch labels are referred to by name; the encoder
// resolves them to indices (labels to relative depths).

const VALTYPE = { i32: 0x7f, i64: 0x7e };

const OPS = {
  unreachable: [0x00], nop: [0x01], block: [0x02, 'bt'], loop: [0x03, 'bt'], if: [0x04, 'bt'], else: [0x05], end: [0x0b],
  br: [0x0c, 'label'], br_if: [0x0d, 'label'], return: [0x0f],
  call: [0x10, 'func'], call_indirect: [0x11, 'type', 'zero'], return_call: [0x12, 'func'], return_call_indirect: [0x13, 'type', 'zero'],
  drop: [0x1a], select: [0x1b],
  'local.get': [0x20, 'local'], 'local.set': [0x21, 'local'], 'local.tee': [0x22, 'local'],
  'global.get': [0x23, 'global'], 'global.set': [0x24, 'global'],
  'i32.load': [0x28, 'mem2'], 'i64.load': [0x29, 'mem3'], 'i32.load8_u': [0x2d, 'mem0'],
  'i32.store': [0x36, 'mem2'], 'i64.store': [0x37, 'mem3'], 'i32.store8': [0x3a, 'mem0'],
  'memory.size': [0x3f, 'zero'], 'memory.grow': [0x40, 'zero'],
  'i32.const': [0x41, 'i32'], 'i64.const': [0x42, 'i64'],
  'i32.eqz': [0x45], 'i32.eq': [0x46], 'i32.ne': [0x47], 'i32.lt_s': [0x48], 'i32.lt_u': [0x49], 'i32.gt_s': [0x4a], 'i32.gt_u': [0x4b],
  'i32.le_s': [0x4c], 'i32.le_u': [0x4d], 'i32.ge_s': [0x4e], 'i32.ge_u': [0x4f],
  'i64.eqz': [0x50], 'i64.eq': [0x51], 'i64.ne': [0x52], 'i64.lt_s': [0x53], 'i64.lt_u': [0x54], 'i64.gt_s': [0x55], 'i64.gt_u': [0x56],
  'i64.le_s': [0x57], 'i64.le_u': [0x58], 'i64.ge_s': [0x59], 'i64.ge_u': [0x5a],
  'i32.clz': [0x67], 'i32.add': [0x6a], 'i32.sub': [0x6b], 'i32.mul': [0x6c], 'i32.div_s': [0x6d], 'i32.div_u': [0x6e], 'i32.rem_s': [0x6f], 'i32.rem_u': [0x70],
  'i32.and': [0x71], 'i32.or': [0x72], 'i32.xor': [0x73], 'i32.shl': [0x74], 'i32.shr_s': [0x75], 'i32.shr_u': [0x76],
  'i64.add': [0x7c], 'i64.sub': [0x7d], 'i64.mul': [0x7e], 'i64.div_s': [0x7f], 'i64.div_u': [0x80], 'i64.rem_s': [0x81], 'i64.rem_u': [0x82],
  'i64.and': [0x83], 'i64.or': [0x84], 'i64.xor': [0x85], 'i64.shl': [0x86], 'i64.shr_s': [0x87], 'i64.shr_u': [0x88],
  'i32.wrap_i64': [0xa7], 'i64.extend_i32_s': [0xac], 'i64.extend_i32_u': [0xad],
  'memory.copy': [0xfc, 'u:10', 'zero', 'zero'], 'memory.fill': [0xfc, 'u:11', 'zero'],
};

function uleb(n, out) {
  n >>>= 0;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
}
function sleb(n, out) {
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { out.push(b); return; }
    out.push(b | 0x80);
  }
}
// Appends without spreading, which overflows the stack for large arrays.
const append = (out, xs) => { for (const x of xs) out.push(x); };
const str = (s, out) => { const b = new TextEncoder().encode(s); uleb(b.length, out); append(out, b); };
const vec = (items, f, out) => { uleb(items.length, out); for (const it of items) f(it, out); };

export class Module {
  constructor() {
    this.types = []; this.typeIndex = new Map();
    this.imports = []; this.funcs = []; this.globals = []; this.exports = []; this.data = [];
    this.table = []; this.tableIndex = new Map();
    this.memory = { min: 1, max: 65536 };
    this.funcIndex = new Map();
  }

  type(params, results) {
    const key = `${params.join(',')}->${results.join(',')}`;
    if (!this.typeIndex.has(key)) { this.typeIndex.set(key, this.types.length); this.types.push({ params, results }); }
    return this.typeIndex.get(key);
  }

  importFunc(module, name, fname, params, results) {
    this.imports.push({ module, name, fname, type: this.type(params, results) });
  }

  // params and locals: [{ name, type }]
  addFunc(f) { this.funcs.push(f); return f; }
  hasFunc(name) { return this.funcs.some((f) => f.name === name) || this.imports.some((i) => i.fname === name); }
  addGlobal(name, type, mutable, init) { this.globals.push({ name, type, mutable, init }); }
  addExport(name, kind, target) { this.exports.push({ name, kind, target }); }
  addData(offset, bytes) { this.data.push({ offset, bytes }); }
  tableSlot(fname) {
    if (!this.tableIndex.has(fname)) { this.tableIndex.set(fname, this.table.length); this.table.push(fname); }
    return this.tableIndex.get(fname);
  }

  encode() {
    // Register every function type first: the type section comes before the code.
    for (const f of this.funcs) {
      this.type(f.params.map((p) => p.type), f.results);
      for (const [op, a] of f.body) if ((op === 'call_indirect' || op === 'return_call_indirect') && typeof a === 'object') this.type(a.params, a.results);
    }
    const funcIdx = new Map();
    this.imports.forEach((im, i) => funcIdx.set(im.fname, i));
    this.funcs.forEach((f, i) => funcIdx.set(f.name, this.imports.length + i));
    const globalIdx = new Map(this.globals.map((g, i) => [g.name, i]));
    const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const section = (id, f) => { const body = []; f(body); out.push(id); uleb(body.length, out); append(out, body); };

    section(1, (o) => vec(this.types, (t, o2) => {
      o2.push(0x60);
      vec(t.params, (p, o3) => o3.push(VALTYPE[p]), o2);
      vec(t.results, (r, o3) => o3.push(VALTYPE[r]), o2);
    }, o));
    section(2, (o) => vec(this.imports, (im, o2) => { str(im.module, o2); str(im.name, o2); o2.push(0x00); uleb(im.type, o2); }, o));
    section(3, (o) => vec(this.funcs, (f, o2) => uleb(this.type(f.params.map((p) => p.type), f.results), o2), o));
    section(4, (o) => vec([0], (_, o2) => { o2.push(0x70, 0x00); uleb(this.table.length, o2); }, o));
    section(5, (o) => vec([this.memory], (m, o2) => { o2.push(0x01); uleb(m.min, o2); uleb(m.max, o2); }, o));
    section(6, (o) => vec(this.globals, (g, o2) => {
      o2.push(VALTYPE[g.type], g.mutable ? 1 : 0);
      if (g.type === 'i64') { o2.push(0x42); sleb(g.init, o2); } else { o2.push(0x41); sleb(g.init, o2); }
      o2.push(0x0b);
    }, o));
    section(7, (o) => vec(this.exports, (e, o2) => {
      str(e.name, o2);
      if (e.kind === 'func') { o2.push(0x00); uleb(funcIdx.get(e.target), o2); } else if (e.kind === 'memory') { o2.push(0x02); uleb(0, o2); } else { o2.push(0x03); uleb(globalIdx.get(e.target), o2); }
    }, o));
    section(9, (o) => vec([0], (_, o2) => {
      o2.push(0x00, 0x41, 0x00, 0x0b);
      vec(this.table, (fname, o3) => {
        if (!funcIdx.has(fname)) throw new Error(`wasm: table entry for unknown function ${fname}`);
        uleb(funcIdx.get(fname), o3);
      }, o2);
    }, o));
    section(10, (o) => vec(this.funcs, (f, o2) => {
      const body = [];
      const localIdx = new Map();
      f.params.forEach((p, i) => localIdx.set(p.name, i));
      // Group locals by type.
      const locals = f.locals ?? [];
      locals.forEach((l, i) => localIdx.set(l.name, f.params.length + i));
      vec(locals, (l, o3) => { uleb(1, o3); o3.push(VALTYPE[l.type]); }, body);
      const labels = [];
      for (const ins of f.body) {
        const [op, ...args] = ins;
        const spec = OPS[op];
        if (!spec) throw new Error(`wasm: unknown instruction ${op} in ${f.name}`);
        body.push(spec[0]);
        let ai = 0;
        for (const kind of spec.slice(1)) {
          if (kind === 'zero') { body.push(0x00); continue; }
          if (kind.startsWith('u:')) { uleb(Number(kind.slice(2)), body); continue; }
          const a = args[ai++];
          switch (kind) {
            case 'bt':
              labels.push(a ?? null);
              { const bt = args[ai++]; body.push(bt ? VALTYPE[bt] : 0x40); }
              break;
            case 'label': {
              const depth = typeof a === 'number' ? a : labels.length - 1 - labels.lastIndexOf(a);
              if (depth < 0 || depth >= labels.length + 1 || (typeof a !== 'number' && labels.lastIndexOf(a) < 0)) throw new Error(`wasm: unknown label ${a} in ${f.name}`);
              uleb(depth, body);
              break;
            }
            case 'func':
              if (!funcIdx.has(a)) throw new Error(`wasm: unknown function ${a} (called from ${f.name})`);
              uleb(funcIdx.get(a), body);
              break;
            case 'type': uleb(typeof a === 'number' ? a : this.type(a.params, a.results), body); break;
            case 'local':
              if (!localIdx.has(a)) throw new Error(`wasm: unknown local ${a} in ${f.name}`);
              uleb(localIdx.get(a), body);
              break;
            case 'global':
              if (!globalIdx.has(a)) throw new Error(`wasm: unknown global ${a}`);
              uleb(globalIdx.get(a), body);
              break;
            case 'i32': sleb(a | 0, body); break;
            case 'i64': sleb(BigInt.asIntN(64, BigInt(a)), body); break;
            case 'mem0': uleb(0, body); uleb(a ?? 0, body); break;
            case 'mem2': uleb(2, body); uleb(a ?? 0, body); break;
            case 'mem3': uleb(3, body); uleb(a ?? 0, body); break;
            default: throw new Error(kind);
          }
        }
        if (op === 'end') labels.pop();
      }
      body.push(0x0b);
      uleb(body.length, o2);
      append(o2, body);
    }, o));
    section(11, (o) => vec(this.data, (d, o2) => {
      o2.push(0x00, 0x41); sleb(d.offset, o2); o2.push(0x0b);
      uleb(d.bytes.length, o2); append(o2, d.bytes);
    }, o));
    return new Uint8Array(out);
  }

  // A readable text rendering of one function, for debugging and the docs.
  toText(name) {
    const f = this.funcs.find((g) => g.name === name);
    if (!f) return null;
    let depth = 1;
    const lines = [`(func $${f.name} ${f.params.map((p) => `(param $${p.name} ${p.type})`).join(' ')} ${f.results.length ? `(result ${f.results[0]})` : ''}`];
    for (const [op, ...args] of f.body) {
      if (op === 'end' || op === 'else') depth--;
      lines.push(`${'  '.repeat(depth)}${op}${args.filter((a) => a !== undefined && a !== null).map((a) => ` ${typeof a === 'object' ? JSON.stringify(a) : a}`).join('')}`);
      if (op === 'block' || op === 'loop' || op === 'if' || op === 'else') depth++;
    }
    lines.push(')');
    return lines.join('\n');
  }
}
