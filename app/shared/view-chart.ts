/**
 * The geometry of a view's static charts (app/shared/view.ts `chart`, `gauge`, a metric's spark): pure numbers in, plain
 * shapes out, so a page draws them with a few SVG elements and nothing is computed per frame. The model gives values
 * only; Ember picks every scale, tick, position and label length here. Coordinates are SVG user units in a fixed box
 * (the chart's `viewBox`), so a chart scales with its card (and the text size) as one picture; gridlines sit on half
 * units, so they land on whole device pixels at 1×.
 */

import type { ViewNode } from "./view";

type Chart = Extract<ViewNode, { kind: "chart" }>;
type Gauge = Extract<ViewNode, { kind: "gauge" }>;

export interface Box { x: number; y: number; w: number; h: number }
export interface Tick { value: number; label: string; at: number }

export interface ChartGeometry {
  width: number;
  height: number;
  horizontal: boolean;
  plot: Box;
  /** Value gridlines: y positions (x for horizontal bars). */
  ticks: Tick[];
  /** Where value 0 (or the scale's floor) is. */
  baseline: number;
  /** Category labels at their centres (x; y for horizontal bars), some skipped when they wouldn't fit. */
  labels: { label: string; at: number }[];
  bars: { series: number; index: number; x: number; y: number; w: number; h: number }[];
  /** Each series' line as runs of points (a null value breaks it), and its filled area for an area chart. */
  lines: { series: number; runs: string[]; areas: string[] }[];
}

/** Average width of a caption-size character in user units: enough to keep labels inside the box. */
const CHAR = 6;
const FONT_LINE = 14;

/** A label cut to `n` characters (with "…"), for the picture only: the hidden table and the text form keep it whole. */
export function fitLabel(s: string, n: number): string {
  if (n < 2) return "";
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…`;
}

/** A value as an axis writes it: short ("1.2K", "3.5M", "0.25"). */
export function axisLabel(v: number): string {
  if (Math.abs(v) >= 10_000) return v.toLocaleString("en-GB", { notation: "compact", maximumFractionDigits: 1 });
  return v.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(v) >= 10 ? 0 : 2 });
}

/** A "nice" scale over lo..hi with about `count` steps of 1, 2 or 5 × 10ⁿ. */
export function niceTicks(lo: number, hi: number, count = 4): { min: number; max: number; step: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (lo > hi) [lo, hi] = [hi, lo];
  if (hi === lo) { if (hi === 0) hi = 1; else if (hi > 0) lo = 0; else hi = 0; }
  const rough = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = min, i = 0; v <= max + step / 2 && i < 12; v += step, i++) ticks.push(Number(v.toPrecision(12)));
  return { min, max, step, ticks };
}

const half = (v: number) => Math.round(v) + 0.5;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** A chart's shapes in a `width` box (user units), a vertical chart `tall` units high (a card's are shorter). */
export function chartGeometry(c: Chart, width = 280, tall = 116): ChartGeometry {
  const values = c.series.flatMap(s => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const bars = c.type === "bar" || c.type === "hbar";
  const lo0 = Math.min(...values, bars ? 0 : Infinity);
  const lo = c.yMin !== undefined ? Math.min(c.yMin, ...values) : lo0;
  const scale = niceTicks(lo, Math.max(...values), c.type === "spark" ? 2 : 4);
  const span = scale.max - scale.min || 1;
  const n = c.type === "spark" ? c.series[0].values.length : c.categories.length;
  // The legend is drawn above the picture, as text (view-dom.ts): the box holds only the plot and its labels.
  const legend = 0;

  if (c.type === "spark") {
    const height = 28;
    const plot = { x: 1, y: 2, w: width - 2, h: height - 4 };
    const y = (v: number) => plot.y + plot.h - ((v - scale.min) / span) * plot.h;
    const x = (i: number) => plot.x + (n > 1 ? (i / (n - 1)) * plot.w : plot.w / 2);
    return { width, height, horizontal: false, plot, ticks: [], baseline: y(scale.min), labels: [], bars: [], lines: [lineOf(0, c.series[0].values, x, y, y(scale.min), false)] };
  }

  if (c.type === "hbar") {
    // A row a caption line tall at least, so the labels beside the bars never touch.
    const per = Math.max(FONT_LINE + 6, c.series.length * 9 + 8);
    const longest = Math.max(...c.categories.map(s => s.length));
    const labelW = Math.min(Math.round(width * 0.38), longest * CHAR + 8);
    // Room on the right for half the last value label, which is centred on its tick.
    const plot = { x: labelW, y: legend + 2, w: width - labelW - 14, h: n * per };
    const height = plot.y + plot.h + FONT_LINE + 4;
    const vx = (v: number) => plot.x + ((v - scale.min) / span) * plot.w;
    const base = vx(Math.max(scale.min, Math.min(0, scale.max)));
    const ticks = scale.ticks.map(v => ({ value: v, label: axisLabel(v), at: half(vx(v)) }));
    const bh = Math.max(4, (per - 6) / c.series.length);
    const out: ChartGeometry["bars"] = [];
    c.series.forEach((s, si) => s.values.forEach((v, i) => {
      if (v === null) return;
      const x0 = Math.min(base, vx(v)), x1 = Math.max(base, vx(v));
      out.push({ series: si, index: i, x: r1(x0), y: r1(plot.y + i * per + 3 + si * bh), w: r1(Math.max(1, x1 - x0)), h: r1(bh - 1) });
    }));
    const labels = c.categories.map((label, i) => ({ label: fitLabel(label, Math.floor((labelW - 8) / CHAR)), at: r1(plot.y + i * per + per / 2) }));
    return { width, height, horizontal: true, plot, ticks, baseline: half(base), labels, bars: out, lines: [] };
  }

  const height = tall + legend;
  const valueW = Math.max(...scale.ticks.map(v => axisLabel(v).length)) * CHAR + 6;
  const plot = { x: valueW, y: legend + 6, w: width - valueW - 4, h: height - legend - 6 - FONT_LINE - 6 };
  const vy = (v: number) => plot.y + plot.h - ((v - scale.min) / span) * plot.h;
  const ticks = scale.ticks.map(v => ({ value: v, label: axisLabel(v), at: half(vy(v)) }));
  const slot = plot.w / Math.max(1, n);
  const every = Math.max(1, Math.ceil((Math.max(...c.categories.map(s => Math.min(s.length, 10))) * CHAR + 4) / slot));
  const fit = Math.max(2, Math.floor((slot * every - 4) / CHAR));
  // A line runs from just inside the plot's ends, so the first and last labels, centred under their points, stay in the box.
  const inset = bars ? 0 : Math.min(14, plot.w / 8);
  const cx = (i: number) => (bars ? plot.x + slot * (i + 0.5) : plot.x + inset + (n > 1 ? (i / (n - 1)) * (plot.w - inset * 2) : plot.w / 2 - inset));
  const labels = c.categories.flatMap((label, i) => (i % every === 0 ? [{ label: fitLabel(label, fit), at: r1(cx(i)) }] : []));
  const base = vy(Math.max(scale.min, Math.min(0, scale.max)));
  if (bars) {
    const groupW = slot * 0.72;
    const bw = groupW / c.series.length;
    const out: ChartGeometry["bars"] = [];
    c.series.forEach((s, si) => s.values.forEach((v, i) => {
      if (v === null) return;
      const y0 = Math.min(base, vy(v)), y1 = Math.max(base, vy(v));
      out.push({ series: si, index: i, x: r1(plot.x + slot * i + (slot - groupW) / 2 + si * bw), y: r1(y0), w: r1(Math.max(1, bw - 1)), h: r1(Math.max(1, y1 - y0)) });
    }));
    return { width, height, horizontal: false, plot, ticks, baseline: half(base), labels, bars: out, lines: [] };
  }
  const lines = c.series.map((s, si) => lineOf(si, s.values, cx, vy, base, c.type === "area"));
  return { width, height, horizontal: false, plot, ticks, baseline: half(base), labels, bars: [], lines };
}

function lineOf(series: number, values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number, base: number, area: boolean) {
  const runs: string[] = [], areas: string[] = [];
  let run: [number, number][] = [];
  const end = () => {
    if (run.length) {
      runs.push(run.map(([a, b]) => `${r1(a)},${r1(b)}`).join(" "));
      if (area) areas.push(`M${r1(run[0][0])},${r1(base)} ${run.map(([a, b]) => `L${r1(a)},${r1(b)}`).join(" ")} L${r1(run[run.length - 1][0])},${r1(base)} Z`);
    }
    run = [];
  };
  values.forEach((v, i) => { if (v === null || !Number.isFinite(v)) end(); else run.push([x(i), y(v)]); });
  end();
  return { series, runs, areas };
}

export interface GaugeGeometry {
  width: number;
  height: number;
  track: string;
  value: string | null;
  bands: { d: string; tone: string }[];
  cx: number;
  cy: number;
}

/** An arc of the gauge's half circle from fraction a to b (0 at the left end, 1 at the right). */
function arc(cx: number, cy: number, r: number, a: number, b: number): string {
  const p = (f: number) => [cx - r * Math.cos(Math.PI * f), cy - r * Math.sin(Math.PI * f)].map(r1);
  const [x0, y0] = p(a), [x1, y1] = p(b);
  return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`;
}

/** A gauge's half circle: its track, the arc up to its value, and its bands along the outside. */
export function gaugeGeometry(g: Gauge): GaugeGeometry {
  const width = 160, height = 96, cx = 80, cy = 84, r = 64;
  const f = (v: number) => Math.min(1, Math.max(0, (v - g.min) / (g.max - g.min)));
  const fv = f(g.value);
  let from = 0;
  const bands = (g.bands ?? []).map(b => { const d = arc(cx, cy, r + 9, from, f(b.upTo)); from = f(b.upTo); return { d, tone: b.tone }; });
  return { width, height, cx, cy, track: arc(cx, cy, r, 0, 1), value: fv > 0.002 ? arc(cx, cy, r, 0, fv) : null, bands };
}

/** A metric's small trend line: one run of points in a 64 × 20 box. */
export function sparkPoints(values: readonly number[], width = 64, height = 20): string {
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  return values.map((v, i) => `${r1(1 + (values.length > 1 ? (i / (values.length - 1)) * (width - 2) : width / 2))},${r1(height - 2 - ((v - lo) / span) * (height - 4))}`).join(" ");
}
