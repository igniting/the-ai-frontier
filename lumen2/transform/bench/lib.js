// The transform library in JavaScript, as transform/lib.lm defines it (on
// well-formed ASCII input), for the Node baseline: udf-vm.js runs it and the
// user's transform inside a vm context.

function fields(line) {
  if (!line.includes('"')) return line.split(',');
  const row = [];
  let i = 0;
  for (;;) {
    if (line[i] === '"') {
      let text = '', j = i + 1;
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) { text += line.slice(j); i = line.length; break; }
        text += line.slice(j, q);
        if (line[q + 1] === '"') { text += '"'; j = q + 2; continue; }
        const c = line.indexOf(',', q + 1);
        i = c < 0 ? line.length : c;
        break;
      }
      row.push(text);
    } else {
      const c = line.indexOf(',', i);
      const j = c < 0 ? line.length : c;
      row.push(line.slice(i, j));
      i = j;
    }
    if (i < line.length && line[i] === ',') i++; else return row;
  }
}

function field(row, i) { return i >= 0 && i < row.length ? row[i] : ''; }

function parseInt_(s) {
  const t = s.startsWith('-') ? s.slice(1) : s;
  if (!/^[0-9]{1,18}$/.test(t)) return null;
  return Number(s); // exact only up to 2^53
}

function parseDecimal(s, places) {
  const neg = s.startsWith('-');
  const m = /^([0-9]*)(?:\.([0-9]*))?$/.exec(neg ? s.slice(1) : s);
  if (!m) return null;
  const whole = m[1], frac = m[2] ?? '';
  if (whole.length + frac.length === 0 || frac.length > places || whole.length + places > 18) return null;
  const n = Number(whole + frac) * 10 ** (places - frac.length);
  return neg ? -n : n;
}

function showDecimal(n, places) {
  if (places <= 0) return String(n);
  const p = 10 ** places, a = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(a / p)}.${String(a % p).padStart(places, '0')}`;
}

function csv(xs) { return xs.map((x) => (/[,"\n\r]/.test(x) ? `"${x.replaceAll('"', '""')}"` : x)).join(','); }

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 257 + s.charCodeAt(i) + 1) % 4294967291;
  return h;
}
