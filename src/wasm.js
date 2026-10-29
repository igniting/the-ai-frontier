// A small WebAssembly module builder: binary encoder + WAT pretty-printer.
//
// Function bodies are flat arrays of instructions, each an array
// [opcode-name, ...immediates]. Functions, globals, locals, types and branch
// labels are referenced by name; the encoder resolves names to indices
// (labels to relative depths) so code generators never juggle numbers.

const VALTYPE = { i32: 0x7f, i64: 0x7e, f64: 0x7c };

// name -> [opcode bytes, immediate kinds...]
const OPS = {
  unreachable: [[0x00]], nop: [[0x01]],
  block: [[0x02], 'label', 'blocktype'], loop: [[0x03], 'label', 'blocktype'], if: [[0x04], 'label', 'blocktype'],
  else: [[0x05]], end: [[0x0b]],
  br: [[0x0c], 'labelref'], br_if: [[0x0d], 'labelref'], return: [[0x0f]],
  call: [[0x10], 'func'], call_indirect: [[0x11], 'type', 'table0'],
  return_call: [[0x12], 'func'], return_call_indirect: [[0x13], 'type', 'table0'],
  drop: [[0x1a]], select: [[0x1b]],
  'local.get': [[0x20], 'local'], 'local.set': [[0x21], 'local'], 'local.tee': [[0x22], 'local'],
  'global.get': [[0x23], 'global'], 'global.set': [[0x24], 'global'],
  'i32.load': [[0x28], 'mem2'], 'i32.load8_u': [[0x2d], 'mem0'], 'i32.store': [[0x36], 'mem2'], 'i32.store8': [[0x3a], 'mem0'],
  'memory.size': [[0x3f], 'zero'], 'memory.grow': [[0x40], 'zero'],
  'i32.const': [[0x41], 'i32'], 'i64.const': [[0x42], 'i64'],
  'i32.eqz': [[0x45]], 'i32.eq': [[0x46]], 'i32.ne': [[0x47]], 'i32.lt_s': [[0x48]], 'i32.lt_u': [[0x49]],
  'i32.gt_s': [[0x4a]], 'i32.gt_u': [[0x4b]], 'i32.le_s': [[0x4c]], 'i32.le_u': [[0x4d]], 'i32.ge_s': [[0x4e]], 'i32.ge_u': [[0x4f]],
  'i32.add': [[0x6a]], 'i32.sub': [[0x6b]], 'i32.mul': [[0x6c]], 'i32.div_s': [[0x6d]], 'i32.div_u': [[0x6e]],
  'i32.rem_s': [[0x6f]], 'i32.rem_u': [[0x70]], 'i32.and': [[0x71]], 'i32.or': [[0x72]], 'i32.xor': [[0x73]],
  'i32.shl': [[0x74]], 'i32.shr_s': [[0x75]], 'i32.shr_u': [[0x76]],
  'i64.add': [[0x7c]], 'i64.extend_i32_u': [[0xad]],
  'memory.copy': [[0xfc, 10], 'zero', 'zero'], 'memory.fill': [[0xfc, 11], 'zero'],
};

// ------------------------------------------------------------------ LEB128 --
function uleb(n, out) {
  n >>>= 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
}

function sleb(n, out) {
  n |= 0;
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

function sleb64(n, out) {
  n = BigInt.asIntN(64, BigInt(n));
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if ((n === 0n && (byte & 0x40) === 0) || (n === -1n && (byte & 0x40) !== 0)) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

const strBytes = (s, out) => {
  const b = new TextEncoder().encode(s);
  uleb(b.length, out);
  out.push(...b);
};

const vec = (items, enc, out) => {
  uleb(items.length, out);
  for (const it of items) enc(it, out);
};

// ------------------------------------------------------------------ module --
export class Module {
  constructor() {
    this.types = new Map(); // signature key -> { name, params, results }
    this.imports = []; // { module, field, name, params, results }
    this.funcs = []; // { name, params: [{name,type}], results, locals: [{name,type}], body, exportName }
    this.globals = []; // { name, type, mutable, init, exportName }
    this.table = []; // function names (element segment at offset 0)
    this.memory = { min: 1, max: null, exportName: 'memory' };
    this.data = []; // { offset, bytes: Uint8Array, comment }
  }

  type(params, results) {
    const key = `${params.join(',')}->${results.join(',')}`;
    if (!this.types.has(key)) {
      const name = `$t${this.types.size}`;
      this.types.set(key, { name, params, results });
    }
    return this.types.get(key);
  }

  namedType(name, params, results) {
    const key = `${params.join(',')}->${results.join(',')}`;
    if (!this.types.has(key)) this.types.set(key, { name, params, results });
    const t = this.types.get(key);
    if (/^\$t\d+$/.test(t.name)) t.name = name; // prefer the descriptive name
    return t.name;
  }

  addImport(module, field, name, params, results) {
    this.type(params, results);
    this.imports.push({ module, field, name, params, results });
  }

  addFunc(f) {
    f.locals ??= [];
    this.type(f.params.map((p) => p.type), f.results);
    this.funcs.push(f);
    return f;
  }

  addGlobal(name, type, mutable, init, exportName) {
    this.globals.push({ name, type, mutable, init, exportName });
  }

  // Remove functions that are not reachable from exports or the table.
  prune() {
    const byName = new Map(this.funcs.map((f) => [f.name, f]));
    const live = new Set();
    const work = [...this.funcs.filter((f) => f.exportName).map((f) => f.name), ...this.table];
    while (work.length) {
      const name = work.pop();
      if (live.has(name)) continue;
      live.add(name);
      const f = byName.get(name);
      if (!f) continue;
      for (const ins of f.body) if (ins[0] === 'call' || ins[0] === 'return_call') work.push(ins[1]);
    }
    this.funcs = this.funcs.filter((f) => live.has(f.name));
    this.imports = this.imports.filter((im) => live.has(im.name));
  }

  // -------------------------------------------------------------- encode --
  encode() {
    const funcIndex = new Map();
    this.imports.forEach((im, i) => funcIndex.set(im.name, i));
    this.funcs.forEach((f, i) => funcIndex.set(f.name, this.imports.length + i));
    const globalIndex = new Map(this.globals.map((g, i) => [g.name, i]));
    const typeOf = (params, results) => this.type(params, results);
    const lookup = (map, name, what) => {
      if (!map.has(name)) throw new Error(`wasm: unknown ${what} ${name}`);
      return map.get(name);
    };

    const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const section = (id, build) => {
      const body = [];
      build(body);
      out.push(id);
      uleb(body.length, out);
      for (const b of body) out.push(b);
    };
    const constExpr = (type, value, o) => {
      if (type === 'i64') { o.push(0x42); sleb64(value, o); } else { o.push(0x41); sleb(value, o); }
      o.push(0x0b);
    };

    // Types are registered lazily while encoding, so pre-register everything first.
    for (const f of this.funcs) typeOf(f.params.map((p) => p.type), f.results);
    for (const im of this.imports) typeOf(im.params, im.results);
    const finalTypes = [...this.types.values()];
    const finalTypeIndex = new Map(finalTypes.map((t, i) => [t.name, i]));

    section(1, (o) => vec(finalTypes, (t, o2) => {
      o2.push(0x60);
      vec(t.params, (p, o3) => o3.push(VALTYPE[p]), o2);
      vec(t.results, (r, o3) => o3.push(VALTYPE[r]), o2);
    }, o));
    section(2, (o) => vec(this.imports, (im, o2) => {
      strBytes(im.module, o2);
      strBytes(im.field, o2);
      o2.push(0x00);
      uleb(finalTypeIndex.get(this.type(im.params, im.results).name), o2);
    }, o));
    section(3, (o) => vec(this.funcs, (f, o2) => uleb(finalTypeIndex.get(this.type(f.params.map((p) => p.type), f.results).name), o2), o));
    section(4, (o) => vec([this.table], (t, o2) => { o2.push(0x70, 0x00); uleb(t.length, o2); }, o));
    section(5, (o) => vec([this.memory], (m, o2) => {
      if (m.max == null) { o2.push(0x00); uleb(m.min, o2); } else { o2.push(0x01); uleb(m.min, o2); uleb(m.max, o2); }
    }, o));
    section(6, (o) => vec(this.globals, (g, o2) => {
      o2.push(VALTYPE[g.type], g.mutable ? 1 : 0);
      constExpr(g.type, g.init, o2);
    }, o));
    const exports = [
      ...this.funcs.filter((f) => f.exportName).map((f) => [f.exportName, 0, funcIndex.get(f.name)]),
      ...(this.memory.exportName ? [[this.memory.exportName, 2, 0]] : []),
      ...this.globals.filter((g) => g.exportName).map((g) => [g.exportName, 3, globalIndex.get(g.name)]),
    ];
    section(7, (o) => vec(exports, ([name, kind, idx], o2) => { strBytes(name, o2); o2.push(kind); uleb(idx, o2); }, o));
    section(9, (o) => vec([this.table], (t, o2) => {
      o2.push(0x00);
      constExpr('i32', 0, o2);
      vec(t, (name, o3) => uleb(lookup(funcIndex, name, 'function'), o3), o2);
    }, o));
    section(10, (o) => vec(this.funcs, (f, o2) => {
      const body = [];
      const groups = [];
      for (const l of f.locals) {
        if (groups.length && groups[groups.length - 1][1] === l.type) groups[groups.length - 1][0]++;
        else groups.push([1, l.type]);
      }
      vec(groups, ([n, t], o3) => { uleb(n, o3); o3.push(VALTYPE[t]); }, body);
      const localIndex = new Map([...f.params, ...f.locals].map((l, i) => [l.name, i]));
      const labels = [];
      for (const ins of f.body) {
        const [op, ...args] = ins;
        const spec = OPS[op];
        if (!spec) throw new Error(`wasm: unknown instruction ${op} in ${f.name}`);
        body.push(...spec[0]);
        let ai = 0;
        for (const kind of spec.slice(1)) {
          switch (kind) {
            case 'label': labels.push(args[ai++] ?? null); break;
            case 'blocktype': { const t = args[ai++]; body.push(t ? VALTYPE[t] : 0x40); break; }
            case 'labelref': {
              const name = args[ai++];
              const depth = labels.length - 1 - labels.lastIndexOf(name);
              if (depth > labels.length - 1 || labels.lastIndexOf(name) < 0) throw new Error(`wasm: unknown label ${name} in ${f.name}`);
              uleb(depth, body);
              break;
            }
            case 'func': uleb(lookup(funcIndex, args[ai++], 'function'), body); break;
            case 'type': uleb(lookup(finalTypeIndex, args[ai++], 'type'), body); break;
            case 'table0': body.push(0x00); break;
            case 'local': uleb(lookup(localIndex, args[ai++], `local in ${f.name}:`), body); break;
            case 'global': uleb(lookup(globalIndex, args[ai++], 'global'), body); break;
            case 'mem2': body.push(2); uleb(args[ai++] ?? 0, body); break;
            case 'mem0': body.push(0); uleb(args[ai++] ?? 0, body); break;
            case 'zero': body.push(0x00); break;
            case 'i32': sleb(args[ai++], body); break;
            case 'i64': sleb64(args[ai++], body); break;
          }
        }
        if (op === 'end') labels.pop();
      }
      if (labels.length) throw new Error(`wasm: unbalanced blocks in ${f.name}`);
      body.push(0x0b);
      uleb(body.length, o2);
      for (const b of body) o2.push(b);
    }, o));
    section(11, (o) => vec(this.data, (d, o2) => {
      o2.push(0x00);
      constExpr('i32', d.offset, o2);
      uleb(d.bytes.length, o2);
      for (const b of d.bytes) o2.push(b);
    }, o));
    // Custom "name" section: function names show up in stack traces and dev tools.
    const names = [];
    strBytes('name', names);
    const sub = [];
    vec([...this.imports.map((im) => im.name), ...this.funcs.map((f) => f.name)].map((n, i) => [i, n]),
      ([i, n], o) => { uleb(i, o); strBytes(n.replace(/^\$/, ''), o); }, sub);
    names.push(1);
    uleb(sub.length, names);
    names.push(...sub);
    out.push(0);
    uleb(names.length, out);
    out.push(...names);

    return new Uint8Array(out);
  }

  // ----------------------------------------------------------------- WAT --
  toWat() {
    const lines = ['(module'];
    const sig = (params, results) => [
      params.length ? ` (param ${params.join(' ')})` : '',
      results.length ? ` (result ${results.join(' ')})` : '',
    ].join('');
    for (const t of this.types.values()) lines.push(`  (type ${t.name} (func${sig(t.params, t.results)}))`);
    for (const im of this.imports) lines.push(`  (import "${im.module}" "${im.field}" (func ${im.name}${sig(im.params, im.results)}))`);
    const m = this.memory;
    lines.push(`  (memory${m.exportName ? ` (export "${m.exportName}")` : ''} ${m.min}${m.max != null ? ` ${m.max}` : ''})`);
    for (const g of this.globals) {
      const type = g.mutable ? `(mut ${g.type})` : g.type;
      lines.push(`  (global ${g.name}${g.exportName ? ` (export "${g.exportName}")` : ''} ${type} (${g.type}.const ${g.init}))`);
    }
    lines.push(`  (table ${this.table.length} funcref)`);
    if (this.table.length) lines.push(`  (elem (i32.const 0) ${this.table.join(' ')})`);
    for (const f of this.funcs) {
      lines.push('');
      if (f.comment) for (const c of f.comment.split('\n')) lines.push(`  ;; ${c}`);
      const params = f.params.map((p) => ` (param ${p.name} ${p.type})`).join('');
      const results = f.results.length ? ` (result ${f.results.join(' ')})` : '';
      lines.push(`  (func ${f.name}${f.exportName ? ` (export "${f.exportName}")` : ''}${params}${results}`);
      for (const l of f.locals) lines.push(`    (local ${l.name} ${l.type})`);
      let depth = 2;
      for (const ins of f.body) {
        const [op, ...args] = ins;
        if (op === 'end' || op === 'else') depth--;
        lines.push('  '.repeat(depth) + formatIns(op, args));
        if (op === 'block' || op === 'loop' || op === 'if' || op === 'else') depth++;
      }
      lines.push('  )');
    }
    for (const d of this.data) {
      lines.push('');
      if (d.comment) lines.push(`  ;; ${d.comment}`);
      lines.push(`  (data (i32.const ${d.offset}) "${escapeBytes(d.bytes)}")`);
    }
    lines.push(')');
    return lines.join('\n');
  }
}

function formatIns(op, args) {
  switch (op) {
    case 'block':
    case 'loop':
    case 'if':
      return [op, args[0], args[1] ? `(result ${args[1]})` : ''].filter(Boolean).join(' ');
    case 'call_indirect':
    case 'return_call_indirect':
      return `${op} (type ${args[0]})`;
    case 'i32.load':
    case 'i32.store':
    case 'i32.load8_u':
    case 'i32.store8':
      return args[0] ? `${op} offset=${args[0]}` : op;
    default:
      return [op, ...args].join(' ');
  }
}

function escapeBytes(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c) s += String.fromCharCode(b);
    else s += '\\' + b.toString(16).padStart(2, '0');
  }
  return s;
}
