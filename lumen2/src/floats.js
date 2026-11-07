// Floats as text, for compiled code (the host functions in runtime.js and
// par-worker.js) and for the interpreter alike, so that both write and read
// every float the same way. JavaScript's own algorithms do the work: the
// shortest decimal that reads back as the same double, toFixed's exact
// rounding, and Number's correctly rounded parsing.

// The shortest form, with ".0" when it would read as an integer: 1.0, 0.1,
// 1.5e-7, 1e+21. -0.0 is written 0.0, like 0.0, which it equals.
export function floatToString(x) {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

// d digits after the point (d clamped to 0..20, as compiled code does).
export function floatToFixed(x, d) {
  return x.toFixed(Math.max(0, Math.min(20, d)));
}

// The number s writes, or NaN: an optional sign, digits with an optional
// point (or a point and digits), an optional exponent; finite.
const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export function parseFloatText(s) {
  if (!FLOAT_TEXT.test(s)) return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
}

// The host functions: float_fmt(x, d) formats x (its shortest form when
// d < 0) and returns the length; float_take(ptr) writes those bytes at ptr;
// float_parse(ptr, len) reads a number. bytesAt(ptr, len) is a view of the
// program's memory.
export function floatHost(bytesAt) {
  let pending = '';
  return {
    float_fmt: (x, d) => { pending = d < 0 ? floatToString(x) : floatToFixed(x, d); return pending.length; },
    float_take: (ptr) => { const b = bytesAt(ptr, pending.length); for (let i = 0; i < pending.length; i++) b[i] = pending.charCodeAt(i); },
    float_parse: (ptr, len) => { const b = bytesAt(ptr, len); let s = ''; for (let i = 0; i < len; i++) s += String.fromCharCode(b[i]); return parseFloatText(s); },
  };
}
