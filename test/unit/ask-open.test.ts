/**
 * The order the ask box opens in from the keyboard (review #78, owner decision D-78). Linux holds the keyboard while
 * the box opens, so Ember reads where the user is first, as it always did. Windows and macOS can't hold it: every letter
 * typed before the box has the keyboard goes to the user's app, so the box shows first and the screen is read after,
 * of the window the user was in, taken just before (once the box is up, Windows' active window is the box, and macOS's
 * AX names no focused app). Perception reads that window, not the one active by then, and is told what had the keyboard
 * in it (cross-review P1): nothing there says it has the keyboard once the box has it.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openAskInOrder, userWindowsNow } from "../../app/main/ask-open";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxWindow } from "../../app/main/perception/sidecar";
import type { PerceptionWindows, X11Window } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";
import { wrapWindowsWith } from "../../app/main/wsl/routed-windows";
import { dropRouter, routerFor } from "../../app/main/wsl/router";
import { geditScene, harness, quiet, stacked } from "./wsl-fakes";

type W = { id: number; title: string };
const NOTES: W = { id: 7, title: "notes.txt" };

/** The steps of one opening, in order, with the window the read was of and what it was told had the keyboard there. */
function open(o: { holding: boolean; look?: boolean; active: W | null; keyboard?: number }) {
  const steps: string[] = [];
  openAskInOrder<W>({
    holding: o.holding, look: o.look ?? true,
    activeWindow: () => { steps.push("active window"); return o.active; },
    ...(o.keyboard !== undefined ? { keyboard: () => o.keyboard! } : {}),
    read: (active, before) => steps.push(active ? `read ${active.title}${before ? ` (had the keyboard: ${before.native ?? "ask the app"})` : ""}` : before ? "read (told)" : "read"),
    show: () => steps.push("show"),
  });
  return steps;
}

describe("the ask box's opening from the keyboard (review #78)", () => {
  it("where Ember holds the keyboard (Linux), reads where the user is first, as always", () => {
    expect(open({ holding: true, active: NOTES })).toEqual(["read", "show"]);
  });

  it("where it can't (Windows, macOS), shows the box first and reads the window the user was in after", () => {
    expect(open({ holding: false, active: NOTES })).toEqual(["active window", "show", "read notes.txt (had the keyboard: ask the app)"]);
  });

  it("tells that read what had the keyboard there, taken before the box showed (cross-review P1)", () => {
    // Windows: the focused child window (an edit box), taken with the windows; macOS: none, so the app is asked.
    expect(open({ holding: false, active: NOTES, keyboard: 0x41 })).toEqual(["active window", "show", "read notes.txt (had the keyboard: 65)"]);
    expect(open({ holding: false, active: NOTES, keyboard: 0 })).toEqual(["active window", "show", "read notes.txt (had the keyboard: ask the app)"]);
    // Read first (Linux, or no window named): what has the keyboard says so itself, as always.
    expect(open({ holding: true, active: NOTES, keyboard: 0x41 })).toEqual(["read", "show"]);
    expect(open({ holding: false, active: null, keyboard: 0x41 })).toEqual(["active window", "read", "show"]);
  });

  it("reads first, as before, when the window system can't name the user's window", () => {
    expect(open({ holding: false, active: null })).toEqual(["active window", "read", "show"]);
  });

  it("only shows the box when what the user is in was read already (the handle's menu)", () => {
    expect(open({ holding: false, look: false, active: NOTES })).toEqual(["show"]);
    expect(open({ holding: true, look: false, active: NOTES })).toEqual(["show"]);
  });

  it("is how main opens the box, holding only where the platform holds the keyboard (Linux)", () => {
    const MAIN = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    const openAsk = /const openAsk = [\s\S]*?\n {2}};\n/.exec(MAIN)?.[0] ?? "";
    expect(openAsk).toContain("openAskInOrder({\n      holding: !!platform.keyboardHold, look,");
    expect(openAsk).toContain("keyboard: () => where?.keyboard ?? 0,");
    expect(openAsk).toContain("read: (active, before) => captureContext(active, before),");
    // Nothing else reads the screen there, before the box or after it.
    expect(openAsk.match(/captureContext\(/g)).toHaveLength(1);
    // The quick look reads the window taken before the box opened, when there is one.
    expect(MAIN).toContain("Promise.all([perception.quickContext(taken, before), selected])");
  });
});

describe("the windows taken just before the box shows (review #78)", () => {
  it("are taken in one look where the window system can (macOS), else one after the other, and are none without one", () => {
    const calls: string[] = [];
    const TERM: W = { id: 3, title: "Terminal" };
    const pair = { focusWindow: () => (calls.push("focus"), TERM), activeWindow: () => (calls.push("active"), NOTES) };
    expect(userWindowsNow<W>(pair)).toEqual({ focus: TERM, active: NOTES, keyboard: 0 });
    expect(calls).toEqual(["focus", "active"]);
    calls.length = 0;
    expect(userWindowsNow<W>({ ...pair, focusAndActive: () => (calls.push("both"), { focus: TERM, active: NOTES }) })).toEqual({ focus: TERM, active: NOTES, keyboard: 0 });
    expect(calls).toEqual(["both"]);
    expect(userWindowsNow<W>(null)).toEqual({ focus: null, active: null, keyboard: 0 });
  });

  it("take what has the keyboard inside them too where the window system can tell (Windows), 0 where it can't (cross-review P1)", () => {
    const pair = { focusWindow: () => NOTES, activeWindow: () => NOTES };
    expect(userWindowsNow<W>({ ...pair, keyboardFocus: () => 0x41 })).toEqual({ focus: NOTES, active: NOTES, keyboard: 0x41 });
    expect(userWindowsNow<W>({ ...pair, keyboardFocus: () => { throw new Error("gone"); } })).toEqual({ focus: NOTES, active: NOTES, keyboard: 0 });
  });
});

describe("Perception's quick look (review #78)", () => {
  const OWN = 999;
  const user: X11Window & { wmClass: string } = { id: 7, pid: 42, title: "notes.txt", wmClass: "gedit", x: 0, y: 0, width: 200, height: 150 };
  const box: X11Window & { wmClass: string } = { id: 9, pid: OWN, title: "Ask Ember", wmClass: "ember", x: 0, y: 0, width: 560, height: 92 };
  const geditAx: AxWindow = { app: "gedit", pid: 42, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 200, height: 150 } };

  /** A screen where the ask box has the keyboard now; reads of the user's window answer with it. */
  function boxUp() {
    const reads: unknown[] = [];
    const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;
    const sidecar = {
      readWindow: async (p: { pid?: number }) => { reads.push(p); return { window: p.pid === 42 ? geditAx : null, nodes: [], ms: 1 }; },
    } as unknown as AtspiSidecar;
    const ws: PerceptionWindows = { stack: () => [], activeWindow: () => box, focusWindow: () => box, clientWindows: () => [], capture: () => null };
    const perception = new Perception({ sidecar, x11: ws, log, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), ownPid: OWN });
    return { perception, reads };
  }

  it("reads the window the user was in when it is given, though Ember's box is active by then", async () => {
    const { perception, reads } = boxUp();
    const ctx = await perception.quickContext(user);
    expect(reads).toEqual([expect.objectContaining({ pid: 42, title: "notes.txt" })]);
    expect(ctx?.target).toMatchObject({ pid: 42, title: "notes.txt" });
  });

  it("tells the read what had the keyboard in that window when it is given (cross-review P1)", async () => {
    const { perception, reads } = boxUp();
    await perception.quickContext(user, { native: 0x41 });
    await perception.quickContext(user, {});
    await perception.quickContext(user);
    expect(reads).toEqual([
      expect.objectContaining({ pid: 42, focusBefore: { native: 0x41 } }),
      expect.objectContaining({ pid: 42, focusBefore: {} }),
      expect.not.objectContaining({ focusBefore: expect.anything() }),
    ]);
  });

  it("reads the window active now when none is given, as before", async () => {
    const { perception, reads } = boxUp();
    // Ember's own window is never read.
    expect(await perception.quickContext()).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe("the user's window on Windows with WSLg, as Perception names it (review #78)", () => {
  const made: ReturnType<typeof harness>[] = [];
  afterEach(() => { for (const h of made.splice(0)) dropRouter(routerFor(h.options)); });
  const OWN = 999;

  /**
   * gedit in Ubuntu (RAIL HWND 11 of msrdc 4242, its title naming only the file), identified by the router, and Ember's
   * box (HWND 50) in front of it once it is up. The user has just put gedit on the never-look list: Perception has it, the
   * router's last look (up to 2 s old) was before, so it still names the window (an app on the list at its look stays
   * "msrdc"). `seen`: the window system main hands Perception (WSLg windows renamed); `raw`: the backend's own.
   */
  async function geditUnderTheBox() {
    const h = harness();
    made.push(h);
    h.wsl.add("Ubuntu");
    const s = geditScene(h, { title: "notes.txt (Ubuntu)" });
    h.setups.set("Ubuntu", x => { x.frames = [{ ...s.frame, name: "notes.txt" }]; });
    h.windows.stack.push(stacked(50, OWN, "Ask Ember", "ember", { x: 600, y: 900, width: 560, height: 92 }));
    const seen = wrapWindowsWith(h.windows.ws, h.options, h.deps);
    await routerFor(h.options).refresh();
    // A sidecar that names no window: only the window system's name for it can tell it is on the never-look list.
    const sidecar = { readWindow: async () => ({ window: null, nodes: [], ms: 1 }) } as unknown as AtspiSidecar;
    const perception = new Perception({ sidecar, x11: seen, log: quiet, neverLook: () => ["gedit"], screenBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }), ownPid: OWN });
    return { h, seen, raw: h.windows.ws, perception };
  }
  const PRIVATE = /private window/;

  it("is private by its Linux app's name when taken from the window system Perception reads, as the read before the box was", async () => {
    const { h, seen, perception } = await geditUnderTheBox();
    h.windows.foreground = 11;
    // The base's order: read before the box, of the window active then.
    expect((await perception.quickContext())?.text).toMatch(PRIVATE);
    // The box's order: the window taken just before the box, read once it is up (Windows' active window is the box then).
    const taken = seen.activeWindow();
    expect(taken?.wmClass).toBe("wsl:Ubuntu:gedit");
    h.windows.foreground = 50;
    expect((await perception.quickContext(taken))?.text).toMatch(PRIVATE);
  });

  it("would not be from the backend's own window system: every WSLg window is msrdc there", async () => {
    const { h, raw, perception } = await geditUnderTheBox();
    h.windows.foreground = 11;
    const taken = raw.activeWindow();
    expect(taken?.wmClass).toBe("msrdc");
    h.windows.foreground = 50;
    expect((await perception.quickContext(taken))?.text).not.toMatch(PRIVATE);
  });

  it("is taken by main from that window system (Perception's x11), not the backend's", () => {
    const MAIN = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(MAIN).toContain("const wsSeen = ws && wrapWindowsForWsl(ws, wslOptions);\n    wsSeenRef = wsSeen;\n");
    expect(MAIN).toMatch(/sidecar: seenBy, x11: wsSeen,/);
    const openAsk = /const openAsk = [\s\S]*?\n {2}};\n/.exec(MAIN)?.[0] ?? "";
    // Where Ember can't hold the keyboard, both windows are taken from it before the box shows, in one look where it can.
    expect(openAsk).toContain("const where = look && !platform.keyboardHold ? userWindowsNow(wsSeenRef ?? wsRef) : null;");
    expect(openAsk).toContain("askOver = !look ? over : where ? noteFocus(where.focus).id : focusNow().id;");
    expect(openAsk).toContain("activeWindow: () => where?.active ?? null,");
    expect(openAsk).not.toMatch(/wsRef\?\.activeWindow\(\)/);
  });
});
