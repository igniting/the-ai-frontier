// Errors carry a source span ({ s, e } byte offsets into the source text) so
// every phase can report precise, rustc-style diagnostics.

export class LumenError extends Error {
  constructor(message, span, { phase = 'error', notes = [] } = {}) {
    super(message);
    this.span = span;
    this.phase = phase;
    this.notes = notes;
  }
}

export class LumenRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.isRuntime = true;
  }
}

export function lineCol(source, offset) {
  let line = 1, col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

// Renders a diagnostic with a code frame:
//
//   error: expected Int, found String
//    --> 3:15
//     |
//   3 |   let x = 1 + "a";
//     |               ^^^
export function formatDiagnostic(source, diag, severity = 'error') {
  const lines = [`${severity}: ${diag.message}`];
  if (diag.span) {
    const { line, col } = lineCol(source, diag.span.s);
    const srcLines = source.split('\n');
    const text = srcLines[line - 1] ?? '';
    const gutter = String(line).length;
    const pad = ' '.repeat(gutter);
    const endOnLine = Math.min(diag.span.e, diag.span.s + Math.max(1, text.length - col + 1));
    const width = Math.max(1, endOnLine - diag.span.s);
    lines.push(`${pad}--> ${line}:${col}`);
    lines.push(`${pad} |`);
    lines.push(`${line} | ${text}`);
    lines.push(`${pad} | ${' '.repeat(col - 1)}${'^'.repeat(width)}`);
  }
  for (const note of diag.notes ?? []) lines.push(`  = note: ${note}`);
  return lines.join('\n');
}
