/**
 * The geometry of a view's static charts (app/shared/view-chart.ts): Ember picks every scale, tick and position from the
 * model's numbers, keeps every shape inside its box, breaks a line where a value is missing, and cuts labels to fit (the
 * hidden table and the text form keep them whole).
 */

import { describe, expect, it } from "vitest";
import { axisLabel, chartGeometry, fitLabel, gaugeGeometry, niceTicks, sparkPoints } from "../../app/shared/view-chart";
import { nodeLines, type ViewNode } from "../../app/shared/view";

type Chart = Extract<ViewNode, { kind: "chart" }>;
const chart = (c: Partial<Chart>): Chart => ({ kind: "chart", type: "bar", categories: ["Mon", "Tue", "Wed"], series: [{ name: "Files", values: [3, 8, 5] }], ...c });

describe("a chart's scale", () => {
  it("steps in 1, 2 or 5 × 10ⁿ round the values", () => {
    expect(niceTicks(0, 8)).toMatchObject({ min: 0, max: 8, step: 2, ticks: [0, 2, 4, 6, 8] });
    expect(niceTicks(0, 2100)).toMatchObject({ min: 0, max: 2500, step: 500 });
    expect(niceTicks(-3, 7).ticks).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(0.1, 0.35).step).toBeCloseTo(0.05);
    // One value, or none that are finite: still a scale.
    expect(niceTicks(5, 5)).toMatchObject({ min: 0 });
    expect(niceTicks(Number.NaN, Number.NaN)).toMatchObject({ min: 0, max: 1 });
  });

  it("writes axis values short", () => {
    expect(axisLabel(2500)).toBe("2,500");
    // ICU releases use either case for the English compact million suffix.
    expect(axisLabel(1_200_000)).toMatch(/^1\.2[mM]$/);
    expect(axisLabel(0.25)).toBe("0.25");
    expect(fitLabel("September", 5)).toBe("Sept…");
    expect(fitLabel("May", 5)).toBe("May");
  });
});

describe("a chart's shapes", () => {
  const inside = (g: ReturnType<typeof chartGeometry>) => {
    for (const b of g.bars) {
      expect(b.x).toBeGreaterThanOrEqual(g.plot.x - 0.5);
      expect(b.x + b.w).toBeLessThanOrEqual(g.plot.x + g.plot.w + 0.5);
      expect(b.y).toBeGreaterThanOrEqual(g.plot.y - 0.5);
      expect(b.y + b.h).toBeLessThanOrEqual(g.plot.y + g.plot.h + 0.5);
    }
  };

  it("draws bars from zero, side by side for each series, inside the plot", () => {
    const g = chartGeometry(chart({ series: [{ name: "In", values: [3, 8, 5] }, { name: "Out", values: [1, null, 2] }] }));
    expect(g.bars).toHaveLength(5);
    inside(g);
    const [mon] = g.bars;
    expect(mon.y + mon.h).toBeCloseTo(g.baseline - 0.5, 0);
    const tallest = g.bars.reduce((a, b) => (b.h > a.h ? b : a));
    expect(tallest).toMatchObject({ series: 0, index: 1 });
    expect(g.labels.map(l => l.label)).toEqual(["Mon", "Tue", "Wed"]);
    // Gridlines on half units: whole device pixels at 1×.
    for (const t of g.ticks) expect(t.at % 1).toBe(0.5);
  });

  it("draws negative bars below the baseline", () => {
    const g = chartGeometry(chart({ series: [{ name: "Change", values: [-2, 4, 1] }] }));
    inside(g);
    expect(g.bars[0].y).toBeGreaterThanOrEqual(g.baseline - 1);
  });

  it("lays horizontal bars along the value axis, with category labels cut to their column", () => {
    const g = chartGeometry(chart({ type: "hbar", categories: ["A very long client name indeed", "B"], series: [{ name: "Due", values: [2100, 500] }] }));
    expect(g.horizontal).toBe(true);
    inside(g);
    expect(g.labels[0].label.endsWith("…")).toBe(true);
    expect(g.bars[0].w).toBeGreaterThan(g.bars[1].w);
  });

  it("breaks a line where a value is missing, and fills an area to the baseline", () => {
    const g = chartGeometry(chart({ type: "area", categories: ["1", "2", "3", "4", "5"], series: [{ name: "Load", values: [1, 2, null, 4, 3] }] }));
    expect(g.lines[0].runs).toHaveLength(2);
    expect(g.lines[0].areas).toHaveLength(2);
    expect(g.lines[0].areas[0]).toMatch(/^M[\d.]+,[\d.]+ L.* Z$/);
  });

  it("skips category labels that wouldn't fit, never overlapping them", () => {
    const cats = Array.from({ length: 24 }, (_, i) => `Week ${i + 1}`);
    const g = chartGeometry(chart({ type: "line", categories: cats, series: [{ name: "x", values: cats.map((_, i) => i) }] }));
    expect(g.labels.length).toBeLessThan(24);
    const gaps = g.labels.slice(1).map((l, i) => l.at - g.labels[i].at);
    for (const gap of gaps) expect(gap).toBeGreaterThan(g.labels[0].label.length * 5);
  });

  it("draws a spark as one line with no axes", () => {
    const g = chartGeometry(chart({ type: "spark", categories: [], series: [{ name: "Trend", values: [1, 3, 2, 5] }] }));
    expect(g.ticks).toEqual([]);
    expect(g.lines[0].runs[0].split(" ")).toHaveLength(4);
    expect(sparkPoints([1, 2, 3]).split(" ")).toHaveLength(3);
  });

  it("says the same numbers in words", () => {
    expect(nodeLines(chart({ title: "Files a day", unit: "MB" }))).toEqual(["Files a day: Bar chart, 1 series, 3 categories", "Files: Mon 3 MB, Tue 8 MB, Wed 5 MB"]);
  });
});

describe("a gauge", () => {
  it("draws its value's arc along the half circle, and its bands outside it", () => {
    const g = gaugeGeometry({ kind: "gauge", label: "Paid", value: 50, min: 0, max: 100, bands: [{ upTo: 50, tone: "negative" }, { upTo: 100, tone: "positive" }] });
    expect(g.track).toBe("M16,84 A64,64 0 0 1 144,84");
    expect(g.value).toBe("M16,84 A64,64 0 0 1 80,20");
    expect(g.bands.map(b => b.tone)).toEqual(["negative", "positive"]);
    expect(gaugeGeometry({ kind: "gauge", label: "x", value: 0, min: 0, max: 10 }).value).toBeNull();
  });
});
