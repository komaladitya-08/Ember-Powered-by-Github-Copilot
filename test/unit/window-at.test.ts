/**
 * The wait the real Windows suite uses before it presses at a point (cifix-2): CI read the window under the middle of
 * the Ask box's field once, 150 ms after the pointer got there, found another window and failed without saying which.
 * The wait reads until the wanted window is there, within a limit, and says what was over it meanwhile.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { focusTrail, hoverActivation, readProbeSummary, waitForWindowAt, watchEvent, type WindowAt } from "../integration/window-at";

const ASK: WindowAt = { id: 459336, className: "Chrome_WidgetWin_1", title: "Ask Ember", pid: 4000 };
const OTHER: WindowAt = { id: 262636, className: "Chrome_WidgetWin_1", title: "Ember overlay", pid: 4000 };
const BENCH: WindowAt = { id: 77, className: "WindowsForms10.Window.8.app", title: "Ember Bench (Windows)", pid: 5000 };

/** A clock the wait's own sleeps move, and a point whose window changes with it. */
function desk(at: (ms: number) => WindowAt | null) {
  let t = 0, reads = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, read: () => { reads++; return at(t); }, reads: () => reads };
}
/** Ember's own windows: its process's. */
const own = (w: WindowAt) => w.pid === ASK.pid;
const name = (w: WindowAt) => (w.id === BENCH.id ? "the bench" : w.title === "Ember overlay" ? "Ember's overlay" : "another window");

describe("waitForWindowAt (cifix-2)", () => {
  it("says the window was there at once when the first read finds it, without waiting", async () => {
    const d = desk(() => ASK);
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 20_000, own, name, ...d });
    expect(r).toMatchObject({ reached: true, waitedMs: 0, others: [] });
    expect(r.line).toBe("the Ask field: the window under the pointer at once");
    expect(d.reads()).toBe(1);
  });

  it("waits for the window while another is over the point, and says which one and for how long", async () => {
    const d = desk(ms => (ms < 600 ? OTHER : ASK));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 20_000, own, name, ...d });
    expect(r.reached).toBe(true);
    expect(r.waitedMs).toBe(600);
    expect(r.others).toEqual([{ window: OTHER, name: "Ember's overlay", firstMs: 0, lastMs: 550 }]);
    expect(r.line).toBe("the Ask field: the window under the pointer after 600 ms; until then Ember's overlay (window 262636, class Chrome_WidgetWin_1, title \"Ember overlay\", pid 4000, seen from 0 to 550 ms)");
  });

  it("gives up at the limit, never passing, and names every window that was over the point", async () => {
    const d = desk(ms => (ms < 300 ? OTHER : BENCH));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 1_000, own, name, ...d });
    expect(r.reached).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(r.others.map(o => o.name)).toEqual(["Ember's overlay", "the bench"]);
    expect(r.line).toMatch(/^the Ask field: never the window under the pointer in 1000 ms; Ember's overlay \(.*seen from 0 to 250 ms\), the bench \(window 77, .*seen from 300 to 1000 ms\)$/);
  });

  it("counts a point with no window under it as not reached, and says so", async () => {
    const d = desk(() => null);
    const r = await waitForWindowAt({ what: "the bench's corner", want: BENCH.id, limitMs: 200, own, name, ...d });
    expect(r.reached).toBe(false);
    expect(r.line).toContain("no window at all");
  });

  it("gives up once one of Ember's own windows has been over the point for the bound, however long the limit is (cifix-x9-1)", async () => {
    // The reviewer's probe: Ember's overlay over the Ask field for 20 s, then the box. A click there in that time
    // goes to Ember's bubble, not to the field the user is typing in: that is a failure, not something to wait out.
    const d = desk(ms => (ms < 20_000 ? OTHER : ASK));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 22_000, ownLimitMs: 2_000, own, name, ...d });
    expect(r.reached).toBe(false);
    expect(r.ownOver).toBe(true);
    expect(r.waitedMs).toBe(2_000);
    expect(r.line).toBe("the Ask field: under Ember's own window for 2000 ms, where a press would go to it instead; Ember's overlay (window 262636, class Chrome_WidgetWin_1, title \"Ember overlay\", pid 4000, seen from 0 to 2000 ms)");
  });

  it("still waits out one of Ember's own windows that leaves the point within the bound (cifix-x9-1)", async () => {
    const d = desk(ms => (ms < 600 ? OTHER : ASK));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 22_000, ownLimitMs: 2_000, own, name, ...d });
    expect(r).toMatchObject({ reached: true, ownOver: false, waitedMs: 600 });
  });

  it("counts Ember's own window only while it stays: another program's window or none in between starts the bound again (cifix-x9-1)", async () => {
    // Ember's 1.5 s, the bench 1 s, Ember's 1.5 s, then the box: never 2 s of Ember's own in one stretch.
    const d = desk(ms => (ms < 1_500 ? OTHER : ms < 2_500 ? BENCH : ms < 4_000 ? OTHER : ASK));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 22_000, ownLimitMs: 2_000, own, name, ...d });
    expect(r).toMatchObject({ reached: true, ownOver: false, waitedMs: 4_000 });
  });

  it("waits the whole limit for another program's window, which is timing and not Ember's doing (cifix-x9-1)", async () => {
    const d = desk(ms => (ms < 20_000 ? BENCH : ASK));
    const r = await waitForWindowAt({ what: "the Ask field", want: ASK.id, limitMs: 22_000, ownLimitMs: 2_000, own, name, ...d });
    expect(r).toMatchObject({ reached: true, ownOver: false, waitedMs: 20_000 });
  });
});

describe("focusTrail (cifix-x9-2)", () => {
  it("says, in ms from the chord and in time order, what took the foreground and what the box did", () => {
    const line = focusTrail("before the right-click", 1000, [
      { t: 1043, what: "Ember's \"Ask Ember\" show" },
      { t: 1000, what: "foreground: the bench" },
      { t: 1064, what: "foreground: Ember's \"Ask Ember\"" },
      { t: 2630, what: "Ember's \"Ask Ember\" hide" },
      { t: 2630, what: "Ember's \"Ask Ember\" blur" },
      { t: 2625, what: "foreground: another program's window" },
    ]);
    expect(line).toBe("before the right-click: 0 ms foreground: the bench; 43 ms Ember's \"Ask Ember\" show; 64 ms foreground: Ember's \"Ask Ember\"; "
      + "1625 ms foreground: another program's window; 1630 ms Ember's \"Ask Ember\" hide; 1630 ms Ember's \"Ask Ember\" blur");
  });

  it("keeps the latest events past its limit and counts the ones it leaves out", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ t: i * 10, what: `e${i}` }));
    expect(focusTrail("w", 0, events, 2)).toBe("w: (3 earlier left out) 30 ms e3; 40 ms e4");
  });

  it("says when nothing was recorded rather than printing an empty trail", () => {
    expect(focusTrail("w", 0, [])).toBe("w: nothing recorded");
  });
});

describe("hoverActivation (cifix-x9-3)", () => {
  const mask = (hex: string) => `\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    UserPreferencesMask    REG_BINARY    ${hex}\r\n`;
  it("says activate on hover is off from Windows' default mask, and names the mask", () => {
    expect(hoverActivation(mask("9E1E078012000000"), "")).toBe("activate on hover: off (UserPreferencesMask 9E1E078012000000, ActiveWndTrkTimeout unset)");
  });

  it("says it is on from bit 0 of the mask's first byte, with the wait the runner sets", () => {
    const timeout = "\r\n    ActiveWndTrkTimeout    REG_DWORD    0x96\r\n";
    expect(hoverActivation(mask("9F1E078012000000"), timeout)).toBe("activate on hover: on (UserPreferencesMask 9F1E078012000000, ActiveWndTrkTimeout 150 ms)");
  });

  it("says unknown when the registry couldn't be read, never off", () => {
    expect(hoverActivation("", "")).toBe("activate on hover: unknown (UserPreferencesMask unreadable, ActiveWndTrkTimeout unset)");
  });
});

describe("watchEvent (cifix-x9-6)", () => {
  const name = (w: { root: number; className: string; image: string }) => (w.root === 77 ? "the bench" : `${w.image} (class ${w.className})`);
  it("names the window Windows made the foreground and says which of the chord's keys were down", () => {
    const line = '{"t":1700000000900,"event":"foreground","hwnd":5,"root":5,"class":"Windows.UI.Core.CoreWindow","title":"Start","pid":9,"image":"C:\\\\Windows\\\\explorer.exe","win":true,"alt":false}';
    expect(watchEvent(line, name)).toEqual({ t: 1700000000900, what: "Windows says foreground: C:\\Windows\\explorer.exe (class Windows.UI.Core.CoreWindow) (window 5); Win down, Alt up" });
  });

  it("takes the focus moving to another window, and a minimise, in the suite's words", () => {
    expect(watchEvent('{"t":1,"event":"focus","root":77,"class":"x","title":"","pid":2,"image":"","win":false,"alt":false}', name)?.what)
      .toBe("Windows says focus: the bench (window 77); Win up, Alt up");
    expect(watchEvent('{"t":2,"event":"minimize-start","root":77,"win":false,"alt":true}', name)?.what)
      .toBe("Windows says minimize-start: the bench (window 77); Win up, Alt down");
  });

  it("names the watched app's own events, so what it did as it took the foreground back is in the timeline (cifix-x9-8)", () => {
    expect(watchEvent('{"t":3,"event":"process","code":"0x8005","root":77,"object":-4,"child":0,"win":false,"alt":false}', name)?.what)
      .toBe("its own event focus (object -4, child 0) in the bench (window 77); Win up, Alt up");
    expect(watchEvent('{"t":3,"event":"process","code":"0x4e00","root":77,"object":0,"child":0}', name)?.what)
      .toBe("its own event 0x4e00 (object 0, child 0) in the bench (window 77); Win up, Alt up");
    expect(watchEvent('{"t":3,"event":"process","code":"bad","root":77}', name)?.what).toBe("its own event ? (object 0, child 0) in the bench (window 77); Win up, Alt up");
  });

  it("skips the ready line, half a line and events it doesn't know", () => {
    expect(watchEvent('{"ready":true,"t":1}', name)).toBeNull();
    expect(watchEvent('{"t":1,"event":"fore', name)).toBeNull();
    expect(watchEvent('{"t":1,"event":"destroy","root":1}', name)).toBeNull();
    expect(watchEvent("null", name)).toBeNull();
  });
});

describe("the foreground watcher's script (cifix-x9-6)", () => {
  const ps1 = fs.readFileSync(path.resolve("test/fixtures/win_foreground_watch.ps1"), "latin1");
  it("is ASCII, which Windows PowerShell 5.1 reads the same without a byte-order mark", () => {
    expect([...ps1].filter(c => c.charCodeAt(0) > 0x7e || (c.charCodeAt(0) < 0x20 && c !== "\n" && c !== "\t")).length).toBe(0);
  });

  it("hooks foreground, focus and minimise changes out of context, and ends when its input closes", () => {
    for (const s of ["EVENT_SYSTEM_FOREGROUND = 0x0003", "EVENT_OBJECT_FOCUS = 0x8005", "EVENT_SYSTEM_MINIMIZESTART = 0x0016", "WINEVENT_OUTOFCONTEXT = 0x0000", "Console.In.ReadLine()", "WM_QUIT"]) expect(ps1).toContain(s);
    expect(ps1).toContain('{\\"ready\\":true');
  });
});

describe("readProbeSummary (cifix-x9-9)", () => {
  it("times the bench's return from the box showing, the read's start and its answer, and says the box closed", () => {
    expect(readProbeSummary("delay:4000", 1000, [
      { t: 1020, kind: "box shown" }, { t: 5030, kind: "read started" }, { t: 5070, kind: "bench foreground" },
      { t: 5080, kind: "box hidden" }, { t: 5110, kind: "read answered" },
    ])).toBe("read probe (delay:4000): the box showed at 20 ms; the read started at 4030 ms and answered at 4110 ms; the bench took the foreground: "
      + "4050 ms after the box showed, 40 ms after the read started, -40 ms after it answered; the box closed at 4080 ms (ms from the chord)");
  });

  it("says the read was off, and that the bench never came back and the box stayed open", () => {
    expect(readProbeSummary("off", 0, [{ t: 15, kind: "box shown" }, { t: 30, kind: "box foreground" }]))
      .toBe("read probe (off): the box showed at 15 ms; the read was off; the bench took the foreground: never; the box was still open at the end (ms from the chord)");
  });

  it("takes the read as started when the box showed for the usual read, and says when the box never showed", () => {
    expect(readProbeSummary("now", 0, [{ t: 10, kind: "box shown" }, { t: 900, kind: "bench foreground" }, { t: 950, kind: "read answered" }]))
      .toBe("read probe (now): the box showed at 10 ms; the read started at 10 ms and answered at 950 ms; the bench took the foreground: "
        + "890 ms after the box showed, 890 ms after the read started, -50 ms after it answered; the box was still open at the end (ms from the chord)");
    expect(readProbeSummary("off", 0, [])).toBe("read probe (off): the box never showed");
    // A stage left out (cifix-x9-10): the rest of the read still starts as the box shows.
    expect(readProbeSummary("skip:texts", 0, [{ t: 10, kind: "box shown" }, { t: 700, kind: "read answered" }]))
      .toBe("read probe (skip:texts): the box showed at 10 ms; the read started at 10 ms and answered at 700 ms; the bench took the foreground: never; the box was still open at the end (ms from the chord)");
  });
});
