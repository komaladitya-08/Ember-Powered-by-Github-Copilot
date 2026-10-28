/**
 * Ember quitting while a borrow drives (logout, SIGTERM): main stops the borrow and closes the input in the same tick,
 * so the borrow's own clean-up, which runs later, finds a closed input that does nothing. The borrow hands everything
 * back at once instead: keys and buttons up, then the pointer home and the keyboard back to the window that had it.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BorrowStopped, CursorBorrow } from "../../app/main/hands/borrow";
import type { XInput } from "../../app/main/hands/input";

/** A pretend X input that, like the real one, does nothing once closed. */
function fakeX() {
  const s = { open: true, pointer: { x: 1152, y: 720 }, active: 11, log: [] as string[], held: new Set<string>() };
  const live = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { if (s.open) fn(...a); };
  const x: XInput = {
    pointer: () => (s.open ? { ...s.pointer } : null),
    pointerState: () => (s.open ? { ...s.pointer, mask: 0 } : null),
    move: live((px: number, py: number) => { s.pointer = { x: px, y: py }; s.log.push(`move ${px},${py}`); }),
    button: live((b: number, down: boolean) => { if (down) s.held.add(`button ${b}`); else s.held.delete(`button ${b}`); s.log.push(`button ${b} ${down ? "down" : "up"}`); }),
    keysym: (sym, down) => { if (!s.open) return false; if (down) s.held.add(`key ${sym}`); else s.held.delete(`key ${sym}`); s.log.push(`key ${sym} ${down ? "down" : "up"}`); return true; },
    keycode: live((code: number, down: boolean) => { if (!down) s.held.delete(`key ${code}`); s.log.push(`keycode ${code} ${down ? "down" : "up"}`); }),
    keysymOf: name => ({ Control_L: 0xffe3, a: 0x61 } as Record<string, number>)[name] ?? 0,
    keycodeOf: sym => sym,
    needsShift: () => false,
    keysDown: () => [],
    activeWindow: () => s.active,
    focusedWindow: () => s.active,
    screenSize: () => ({ width: 2304, height: 1440 }),
    findWindow: () => 22,
    activate: live((w: number) => { s.active = w; s.log.push(`activate ${w}`); }),
    sync: () => undefined,
    releaseAll: live(() => { for (const h of s.held) s.log.push(`release ${h}`); s.held.clear(); }),
    close: () => { x.releaseAll(); s.open = false; },
  };
  return { s, x };
}

describe("quitting while Ember borrows the mouse", () => {
  it("lets go and puts the pointer and the keyboard back before the input closes (review #66)", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    let parked!: () => void;
    const run = b.borrow(async hand => {
      await hand.glideTo(800, 450);
      x.button(1, true); // a button held mid-click when the quit comes
      await new Promise<void>(r => { parked = r; });
      await hand.keys("ctrl+a");
    }, { idleMs: 0, window: 22, sleep: () => Promise.resolve() }).catch(e => e);
    await new Promise(r => setTimeout(r, 0));
    expect(s.pointer).toEqual({ x: 800, y: 450 });
    expect(s.active).toBe(22);
    // main.ts's will-quit handler, in one tick.
    b.stopForQuit();
    x.close();
    parked();
    expect(await run).toBeInstanceOf(BorrowStopped);
    expect(s.pointer).toEqual({ x: 1152, y: 720 });
    expect(s.active).toBe(11);
    // Let go before the pointer moved: a held button with a move would be a drag.
    const release = s.log.indexOf("release button 1"), home = s.log.lastIndexOf("move 1152,720");
    expect(release).toBeGreaterThanOrEqual(0);
    expect(release).toBeLessThan(home);
    expect(s.log.filter(l => l.startsWith("key"))).toEqual([]); // nothing typed after the quit
  });

  it("does nothing more for a borrow that is only waiting, and the next borrow never starts", async () => {
    const { s, x } = fakeX();
    const b = new CursorBorrow(x);
    let parked!: () => void;
    const first = b.borrow(() => new Promise<void>(r => { parked = r; }), { idleMs: 0, sleep: () => Promise.resolve() });
    const queued = b.borrow(async hand => { await hand.glideTo(5, 5); }, { idleMs: 0, sleep: () => Promise.resolve() }).catch(e => e);
    await new Promise(r => setTimeout(r, 0));
    b.stopForQuit();
    parked();
    await first.catch(() => undefined);
    expect(await queued).toBeInstanceOf(BorrowStopped);
    expect(s.log).not.toContain("move 5,5");
  });
});

/** main.ts without its comments, every run of white space made one space (main-privacy-wiring.test.ts's reading). */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** The body of every app.on("will-quit", …) in main.ts, in the order main registers them. */
function willQuitHandlers(): string[] {
  const out: string[] = [];
  const head = 'app.on("will-quit", ';
  for (let at = MAIN.indexOf(head); at >= 0; at = MAIN.indexOf(head, at + 1)) {
    let depth = 1, i = at + head.length;
    for (; i < MAIN.length && depth > 0; i++) depth += MAIN[i] === "(" ? 1 : MAIN[i] === ")" ? -1 : 0;
    out.push(MAIN.slice(at + head.length, i - 1));
  }
  return out;
}

describe("quitting while Ember borrows the mouse, as main.ts quits", () => {
  // main.ts can't be loaded in a unit test (it is Electron's entry point), so its will-quit listeners are read from its
  // source and what they do to the borrow, the window system and the input is run here in the same order. They are all
  // registered straight in whenReady, so the order in the file is the order Electron calls them.
  it("hands the keyboard back while the window system can still say the window is there (review #66)", async () => {
    // main's mayRefocus asks the window system's list (shownWindows over wsRef.stack()), and a closed window system
    // lists nothing, so the keyboard can only go back before it closes.
    expect(MAIN).toContain("const shownWindows = () => wsRef?.stack().filter(w => w.title && w.width > 1 && w.height > 1) ?? [];");
    expect(MAIN).toContain("mayRefocus: w => !askWindow.isWindow(w) && shownWindows().some(s => s.client === w || s.id === w),");
    const calls = willQuitHandlers().flatMap(h => [...h.matchAll(/borrowRef\?\.stopForQuit\(\)|\bws\?\.close\(\)|xinput\?\.close\(\)/g)].map(m => m[0]));
    expect(calls).toContain("ws?.close()");
    expect(calls).toContain("xinput?.close()");

    const { s, x } = fakeX();
    const ws = { open: true, windows: [{ id: 11, client: 11, title: "Where the user was", width: 640, height: 480 }, { id: 22, client: 22, title: "Target", width: 800, height: 600 }] };
    const stack = () => (ws.open ? ws.windows : []);
    const shownWindows = () => stack().filter(w => w.title && w.width > 1 && w.height > 1);
    const b = new CursorBorrow(x, { mayRefocus: w => shownWindows().some(sw => sw.client === w || sw.id === w) });
    let parked!: () => void;
    const run = b.borrow(async hand => {
      await hand.glideTo(800, 450);
      await new Promise<void>(r => { parked = r; });
      await hand.keys("ctrl+a");
    }, { idleMs: 0, window: 22, sleep: () => Promise.resolve() }).catch(e => e);
    await new Promise(r => setTimeout(r, 0));
    expect(s.active).toBe(22);
    // will-quit, as main.ts has it.
    for (const call of calls) {
      if (call === "borrowRef?.stopForQuit()") b.stopForQuit();
      else if (call === "ws?.close()") ws.open = false;
      else x.close();
    }
    parked();
    expect(await run).toBeInstanceOf(BorrowStopped);
    expect(s.pointer).toEqual({ x: 1152, y: 720 });
    expect(s.active).toBe(11);
  });
});
