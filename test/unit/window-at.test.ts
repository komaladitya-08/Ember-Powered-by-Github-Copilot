/**
 * The wait the real Windows suite uses before it presses at a point (cifix-2): CI read the window under the middle of
 * the Ask box's field once, 150 ms after the pointer got there, found another window and failed without saying which.
 * The wait reads until the wanted window is there, within a limit, and says what was over it meanwhile.
 */

import { describe, expect, it } from "vitest";
import { waitForWindowAt, type WindowAt } from "../integration/window-at";

const ASK: WindowAt = { id: 459336, className: "Chrome_WidgetWin_1", title: "Ask Ember", pid: 4000 };
const OTHER: WindowAt = { id: 262636, className: "Chrome_WidgetWin_1", title: "Ember overlay", pid: 4000 };
const BENCH: WindowAt = { id: 77, className: "WindowsForms10.Window.8.app", title: "Ember Bench (Windows)", pid: 5000 };

/** A clock the wait's own sleeps move, and a point whose window changes with it. */
function desk(at: (ms: number) => WindowAt | null) {
  let t = 0, reads = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, read: () => { reads++; return at(t); }, reads: () => reads };
}
const name = (w: WindowAt) => (w.id === BENCH.id ? "the bench" : w.title === "Ember overlay" ? "Ember's overlay" : "another window");

describe("waitForWindowAt (cifix-2)", () => {
  it("says the window was there at once when the first read finds it, without waiting", async () => {
    const d = desk(() => ASK);
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 20_000, name, ...d });
    expect(r).toMatchObject({ reached: true, waitedMs: 0, others: [] });
    expect(r.line).toBe("the Ask field: the window under the pointer at once");
    expect(d.reads()).toBe(1);
  });

  it("waits for the window while another is over the point, and says which one and for how long", async () => {
    const d = desk(ms => (ms < 600 ? OTHER : ASK));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 20_000, name, ...d });
    expect(r.reached).toBe(true);
    expect(r.waitedMs).toBe(600);
    expect(r.others).toEqual([{ window: OTHER, name: "Ember's overlay", firstMs: 0, lastMs: 550 }]);
    expect(r.line).toBe("the Ask field: the window under the pointer after 600 ms; until then Ember's overlay (window 262636, class Chrome_WidgetWin_1, title \"Ember overlay\", pid 4000, seen from 0 to 550 ms)");
  });

  it("gives up at the limit, never passing, and names every window that was over the point", async () => {
    const d = desk(ms => (ms < 300 ? OTHER : BENCH));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 1_000, name, ...d });
    expect(r.reached).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(r.others.map(o => o.name)).toEqual(["Ember's overlay", "the bench"]);
    expect(r.line).toMatch(/^the Ask field: never the window under the pointer in 1000 ms; Ember's overlay \(.*seen from 0 to 250 ms\), the bench \(window 77, .*seen from 300 to 1000 ms\)$/);
  });

  it("counts a point with no window under it as not reached, and says so", async () => {
    const d = desk(() => null);
    const r = await waitForWindowAt({ what: "the bench's corner", want: BENCH.id, limitMs: 200, name, ...d });
    expect(r.reached).toBe(false);
    expect(r.line).toContain("no window at all");
  });
});
