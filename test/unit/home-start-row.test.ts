/**
 * First run's Start row stays at the window's foot while the page scrolls under it, so whatever takes keyboard focus
 * must scroll clear of it (WCAG 2.4.11 and 2.4.12). Its words wrap it onto more lines at a larger text size, in a narrower
 * window and when the window is zoomed in, so the page's scroll padding follows the row's own height.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { followStartRow, startRowHeight } from "../../app/renderer/home/start-row";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
const css = read("app/renderer/home/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const shared = read("app/renderer/shared/ember.css");

/** A ResizeObserver that the test drives: what it watches, and a way to report sizes as the browser would. */
function fakeWatch() {
  const made: { cb: (entries: ResizeObserverEntry[]) => void; watched: Element[] }[] = [];
  class Watch {
    watched: Element[] = [];
    constructor(public cb: (entries: ResizeObserverEntry[]) => void) { made.push(this); }
    observe(el: Element) { this.watched.push(el); }
  }
  const report = (...heights: number[]) => made[0].cb(heights.map(h => ({ borderBoxSize: [{ blockSize: h, inlineSize: 400 }] }) as unknown as ResizeObserverEntry));
  return { Watch, made, report };
}

/** The page's root, as far as followStartRow writes to it. */
function fakeRoot() {
  const props = new Map<string, string>();
  return { props, style: { setProperty: (n: string, v: string) => void props.set(n, v), removeProperty: (n: string) => { props.delete(n); return ""; } } };
}

describe("first run's Start row and the page's scroll padding", () => {
  it("keeps the row's own height on the page's root, in whole px, as the row changes size", () => {
    const row = {} as Element;
    const root = fakeRoot();
    const w = fakeWatch();
    followStartRow(row, root, w.Watch);
    expect(w.made).toHaveLength(1);
    expect(w.made[0].watched).toEqual([row]);
    // Measured on the built page: one line at Default and 760 px wide, three at Larger and 420 px, zoomed in further.
    w.report(96);
    expect(root.props.get("--start-row-h")).toBe("96px");
    w.report(175.6);
    expect(root.props.get("--start-row-h")).toBe("176px");
    // Several reports in one go: the last is the row's size now.
    w.report(136, 269.6);
    expect(root.props.get("--start-row-h")).toBe("270px");
    // Hidden (after Start) or not laid out: the stylesheet's own length again.
    w.report(0);
    expect(root.props.has("--start-row-h")).toBe(false);
    w.report(Number.NaN);
    expect(root.props.has("--start-row-h")).toBe(false);
  });

  it("reads a height only from a size the browser could have drawn", () => {
    expect(startRowHeight(148)).toBe("148px");
    expect(startRowHeight(187.01)).toBe("188px");
    for (const bad of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) expect(startRowHeight(bad), String(bad)).toBeNull();
  });

  it("scrolls focus clear of the row and the gap under it, at the row's height, and a scaled length until it is measured", () => {
    const pad = /html:has\(> body\.first-run\) \{\s*scroll-padding-bottom: ([^;]+);/.exec(css)?.[1];
    const gap = /body\.first-run \.start-row \{[^}]*\bbottom: (\d+)px;/.exec(css)?.[1];
    // The room a focus ring gets at the window's top, kept below too (the ring is 4 px outside its control).
    const ring = /(?:^|\})\s*html \{\s*scroll-padding-top: (\d+)px;/m.exec(css)?.[1];
    expect(gap).toBe("12");
    expect(ring).toBe("16");
    expect(pad).toBe(`calc(var(--start-row-h, 138px * var(--text-scale)) + ${gap}px + ${ring}px)`);
    // Before the first measurement, the length is at least the row's height at the window's narrowest (420 px, not
    // zoomed), measured on the built page at each text size: 136, 143.8 and 175.6 px (2 px steps from 420 to 800 px).
    const scales = { default: 1, large: Number(/data-text-size="large"\] \{ --text-scale: ([\d.]+);/.exec(shared)?.[1]), larger: Number(/data-text-size="larger"\] \{ --text-scale: ([\d.]+);/.exec(shared)?.[1]) };
    const tallest = { default: 136, large: 143.8, larger: 175.6 };
    for (const [size, s] of Object.entries(scales)) expect(138 * s, size).toBeGreaterThanOrEqual(tallest[size as keyof typeof tallest]);
  });

  it("is started by the settings window on its own Start row and root", () => {
    const main = read("app/renderer/home/main.ts");
    expect(main).toMatch(/import \{ followStartRow \} from "\.\/start-row";/);
    expect(main).toMatch(/followStartRow\(\$\("start-row"\), document\.documentElement\);/);
  });
});
