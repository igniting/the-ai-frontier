// Pinpoints the first difference between two wasm binaries: which section,
// and for the code section which function (by name) and where in its body.

function uleb(bytes, pos) {
  let result = 0, shift = 0, b;
  do { b = bytes[pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [result >>> 0, pos];
}

function sections(bytes) {
  const out = [];
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos++];
    const [size, p] = uleb(bytes, pos);
    out.push({ id, start: p, end: p + size, bytes: bytes.subarray(p, p + size) });
    pos = p + size;
  }
  return out;
}

function functionNames(secs) {
  const names = new Map();
  const custom = secs.find((s) => s.id === 0);
  if (!custom) return names;
  const b = custom.bytes;
  let [n, pos] = uleb(b, 0);
  pos += n; // "name"
  pos++; // subsection id
  [, pos] = uleb(b, pos);
  let count;
  [count, pos] = uleb(b, pos);
  for (let i = 0; i < count; i++) {
    let idx, len;
    [idx, pos] = uleb(b, pos);
    [len, pos] = uleb(b, pos);
    names.set(idx, new TextDecoder().decode(b.subarray(pos, pos + len)));
    pos += len;
  }
  return names;
}

function codeBodies(sec) {
  const bodies = [];
  let [count, pos] = uleb(sec.bytes, 0);
  for (let i = 0; i < count; i++) {
    let size;
    [size, pos] = uleb(sec.bytes, pos);
    bodies.push(sec.bytes.subarray(pos, pos + size));
    pos += size;
  }
  return bodies;
}

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

export function wasmDiff(a, b) {
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null;
  const sa = sections(a), sb = sections(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i], y = sb[i];
    if (!x || !y || x.id !== y.id) return `section ${i}: ids ${x?.id} vs ${y?.id}`;
    if (x.bytes.length === y.bytes.length && x.bytes.every((v, k) => v === y.bytes[k])) continue;
    if (x.id === 10) {
      const imports = (() => { const imp = sa.find((s) => s.id === 2); return imp ? uleb(imp.bytes, 0)[0] : 0; })();
      const names = functionNames(sa);
      const ba = codeBodies(x), bb = codeBodies(y);
      if (ba.length !== bb.length) return `code section: ${ba.length} vs ${bb.length} functions`;
      for (let f = 0; f < ba.length; f++) {
        const p = ba[f], q = bb[f];
        const at = p.findIndex((v, k) => v !== q[k]);
        if (at >= 0 || p.length !== q.length) {
          const k = at < 0 ? Math.min(p.length, q.length) : at;
          return `function ${f} (${names.get(imports + f) ?? '?'}): bodies differ at byte ${k} of ${p.length}/${q.length}\n  a: ${hex(p.subarray(Math.max(0, k - 12), k + 16))}\n  b: ${hex(q.subarray(Math.max(0, k - 12), k + 16))}`;
        }
      }
    }
    const k = x.bytes.findIndex((v, j) => v !== y.bytes[j]);
    const at = k < 0 ? Math.min(x.bytes.length, y.bytes.length) : k;
    return `section id ${x.id} (${x.bytes.length} vs ${y.bytes.length} bytes) differs at ${at}\n  a: ${hex(x.bytes.subarray(Math.max(0, at - 12), at + 16))}\n  b: ${hex(y.bytes.subarray(Math.max(0, at - 12), at + 16))}`;
  }
  return 'binaries differ (trailing bytes)';
}
