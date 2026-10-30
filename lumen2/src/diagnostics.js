// Compile errors carry a source span; formatDiagnostic renders them with the
// offending line underlined.

export class LumenError extends Error {
  constructor(message, span, note = null) {
    super(message);
    this.span = span;
    this.note = note;
  }
}

export function lineCol(src, offset) {
  let line = 1, col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

export function formatDiagnostic(src, err) {
  if (!err.span) return `error: ${err.message}`;
  const { line, col } = lineCol(src, err.span.s);
  const text = src.split('\n')[line - 1] ?? '';
  const width = Math.max(1, Math.min(err.span.e, err.span.s + text.length - col + 1) - err.span.s);
  const pad = ' '.repeat(String(line).length);
  const out = [
    `error: ${err.message}`,
    `${pad}--> ${line}:${col}`,
    `${pad} |`,
    `${line} | ${text}`,
    `${pad} | ${' '.repeat(col - 1)}${'^'.repeat(width)}`,
  ];
  if (err.note) out.push(`${pad} = note: ${err.note}`);
  return out.join('\n');
}
