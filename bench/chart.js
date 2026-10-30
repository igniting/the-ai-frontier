// Draws the campaign's two charts as standalone SVG (light and dark themes,
// a native tooltip on every mark) from bench/history.json and the final
// A/B measurement in bench/ab-final.json:
//
//   bench/campaign-instructions.svg   executed instructions per campaign step
//   bench/campaign-time.svg           wall time saved by -O, per benchmark
//
//   node bench/chart.js

import { readFileSync, writeFileSync } from 'node:fs';

const history = JSON.parse(readFileSync('bench/history.json', 'utf8'));
const ab = JSON.parse(readFileSync('bench/ab-final.json', 'utf8'));

export const SHORT = ['start', 'temps', 're-mine', 'headroom', 'inline alloc', 'zeroing', 'fixpoint', 'slot loads', 'self loops'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}%`;
const geomean = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);

// Instructions relative to the default build, per step (geometric mean over all benchmarks).
export function instructionSeries() {
  return history.map((e, i) => {
    const names = Object.keys(e.results);
    const ratio = geomean(names.map((n) => e.results[n].instructions / e.base[n].instructions));
    return { step: i, label: e.label, short: SHORT[i] ?? String(i), change: (ratio - 1) * 100 };
  });
}

const STYLE = `
  <style>
    svg { --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7; --series: #2a78d6; }
    @media (prefers-color-scheme: dark) {
      svg { --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835; --series: #3987e5; }
    }
    text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink-2); }
    .title { font-size: 15px; font-weight: 600; fill: var(--ink); }
    .sub { font-size: 12px; fill: var(--ink-2); }
    .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
    .name { font-size: 11px; fill: var(--ink-2); }
    .value { font-size: 12px; font-weight: 600; fill: var(--ink); font-variant-numeric: tabular-nums; }
    .grid { stroke: var(--grid); stroke-width: 1; }
    .axis { stroke: var(--axis); stroke-width: 1; }
    .line { stroke: var(--series); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; }
    .dot { fill: var(--series); stroke: var(--surface); stroke-width: 2; }
    .bar { fill: var(--series); }
    .hit { fill: transparent; }
    .hit:hover + .dot, g:hover > .bar { opacity: 0.8; }
  </style>`;

function lineChart(points) {
  const W = 760, H = 340, L = 56, R = 70, T = 64, B = 62;
  const lo = Math.min(-30, Math.floor(Math.min(...points.map((p) => p.change)) / 5) * 5), hi = 0;
  const x = (i) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const ticks = [];
  for (let v = hi; v >= lo; v -= 5) ticks.push(v);
  const last = points[points.length - 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t1 d1">
  <title id="t1">Executed instructions with -O, per campaign step</title>
  <desc id="d1">${esc(points.map((p) => `step ${p.step} (${p.short}): ${pct(p.change)}`).join('; '))}</desc>${STYLE}
  <rect width="${W}" height="${H}" fill="var(--surface)"/>
  <text class="title" x="${L - 40}" y="26">Executed wasm instructions with -O, relative to the default build</text>
  <text class="sub" x="${L - 40}" y="46">Geometric mean over ${Object.keys(history[0].results).length} benchmarks; each step passed the gate before it was kept. Lower is better.</text>
  ${ticks.map((v) => `<line class="${v === 0 ? 'axis' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
  <text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${pct(v).replace('.0%', '%')}</text>`).join('\n  ')}
  ${points.map((p) => `<text class="tick" x="${x(p.step)}" y="${H - B + 20}" text-anchor="middle">${p.step}</text>
  <text class="name" x="${x(p.step)}" y="${H - B + 36}" text-anchor="middle">${esc(p.short)}</text>`).join('\n  ')}
  <polyline class="line" points="${points.map((p) => `${x(p.step).toFixed(1)},${y(p.change).toFixed(1)}`).join(' ')}"/>
  ${points.map((p) => `<g><title>${esc(`${p.label}: ${pct(p.change)}`)}</title><circle class="hit" cx="${x(p.step)}" cy="${y(p.change)}" r="14"/><circle class="dot" cx="${x(p.step)}" cy="${y(p.change)}" r="5"/></g>`).join('\n  ')}
  <text class="value" x="${x(last.step) + 12}" y="${y(last.change) + 4}">${pct(last.change)}</text>
</svg>
`;
}

function barChart(rows) {
  const W = 760, rowH = 30, T = 64, L = 130, R = 70, B = 30;
  const H = T + rows.length * rowH + B;
  const max = Math.ceil(Math.max(...rows.map((r) => r.saved)) / 10) * 10;
  const x = (v) => L + (v * (W - L - R)) / max;
  const ticks = [];
  for (let v = 0; v <= max; v += 10) ticks.push(v);
  const bar = (r, i) => {
    const y0 = T + i * rowH + (rowH - 18) / 2, w = Math.max(x(r.saved) - L, 1), h = 18, rad = Math.min(4, w);
    // Square at the baseline, 4px rounded at the data end.
    const d = `M${L},${y0} H${L + w - rad} Q${L + w},${y0} ${L + w},${y0 + rad} V${y0 + h - rad} Q${L + w},${y0 + h} ${L + w - rad},${y0 + h} H${L} Z`;
    return `<g><title>${esc(`${r.name}: ${r.a.toFixed(1)} ms → ${r.b.toFixed(1)} ms (${r.saved.toFixed(1)}% less time)`)}</title>
    <rect class="hit" x="0" y="${T + i * rowH}" width="${W}" height="${rowH}"/>
    <path class="bar" d="${d}"/>
    <text class="name" x="${L - 10}" y="${y0 + 13}" text-anchor="end">${esc(r.name)}</text>
    <text class="value" x="${L + w + 8}" y="${y0 + 13}">${r.saved.toFixed(1)}%</text></g>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t2 d2">
  <title id="t2">Wall time saved by -O, per benchmark</title>
  <desc id="d2">${esc(rows.map((r) => `${r.name}: ${r.saved.toFixed(1)}% less time`).join('; '))}</desc>${STYLE}
  <rect width="${W}" height="${H}" fill="var(--surface)"/>
  <text class="title" x="16" y="26">Wall time saved by -O</text>
  <text class="sub" x="16" y="46">Default build vs -O compiled by the same compiler, runs alternated in one process; median of 15 runs (Node ${process.versions.node}).</text>
  ${ticks.map((v) => `<line class="${v === 0 ? 'axis' : 'grid'}" x1="${x(v)}" x2="${x(v)}" y1="${T - 4}" y2="${H - B + 4}"/>
  <text class="tick" x="${x(v)}" y="${H - B + 18}" text-anchor="middle">${v}%</text>`).join('\n  ')}
  ${rows.map(bar).join('\n  ')}
</svg>
`;
}

export function timeRows() {
  return Object.entries(ab).map(([name, { a, b }]) => ({ name, a, b, saved: (1 - b / a) * 100 })).sort((p, q) => q.saved - p.saved);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync('bench/campaign-instructions.svg', lineChart(instructionSeries()));
  writeFileSync('bench/campaign-time.svg', barChart(timeRows()));
  console.log('wrote bench/campaign-instructions.svg, bench/campaign-time.svg');
}
