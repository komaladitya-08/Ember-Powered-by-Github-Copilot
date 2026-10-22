/**
 * The macOS window system and input backends on a real Mac, against TextEdit with a fresh plain-text file in a
 * temporary folder: TextEdit's window is in the stack with its process and app name, activation brings it to the
 * front, text typed with textKey (whatever the layout) arrives, Command+S pressed by keysym saves it, the pointer
 * follows a move, and nothing stays pressed. Without the Accessibility permission only the checks that need none
 * run; with EMBER_DARWIN_TEST=1 the suite fails instead of skipping (off macOS, without the backends, or without the
 * permission), printing which binary needs the grant so CI learns which client TCC wanted.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import { openDarwinInput, openDarwinWindows, darwinInputError, darwinWindowsError, type DarwinInput, type DarwinWindowSystem } from "../../app/main/platform/darwin";
import { openCoreFoundation } from "../../app/main/platform/darwin/cf";
import { openCoreGraphics, rectOf } from "../../app/main/platform/darwin/cg";
import { openAX } from "../../app/main/platform/darwin/ax";

const required = process.env.EMBER_DARWIN_TEST === "1";
const onMac = process.platform === "darwin";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TEXT = "Ember 1é";

/** AXIsProcessTrusted() for this process (false off macOS or when AX can't be bound). */
const trusted = (() => {
  const cf = onMac ? openCoreFoundation() : null;
  return !!(cf && openAX(cf)?.trusted());
})();

/** This process and its ancestors (the TCC "responsible process" is one of them), for the grant message. */
function ancestry(): string {
  const chain = [`${process.pid} ${process.execPath}`];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout?.trim() ?? "");
    if (!m) break;
    chain.push(`${pid} ${m[2]}`);
    pid = Number(m[1]);
  }
  return chain.join("\n  ");
}

/** Electron's screen, as far as the tests need it, from CoreGraphics' active displays (points). */
function displayScreen(): ScreenLike {
  const cg = openCoreGraphics();
  const bounds: Rect[] = [];
  if (cg) {
    const ids = Buffer.alloc(16 * 4), count = [0];
    if (cg.CGGetActiveDisplayList(16, ids, count) === 0) {
      for (let i = 0; i < count[0]!; i++) {
        const r = rectOf(cg.CGDisplayBounds(ids.readUInt32LE(i * 4)));
        if (r) bounds.push(r);
      }
    }
  }
  const all = bounds.map(b => ({ bounds: b, scaleFactor: 2 }));
  return { getPrimaryDisplay: () => all[0] ?? { bounds: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1 }, getAllDisplays: () => all };
}

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe.skipIf(!onMac && !required)("the macOS backends on a real desktop", () => {
  let ws: DarwinWindowSystem;
  let x: DarwinInput;
  let screen: ScreenLike;

  beforeAll(() => {
    if (!onMac) throw new Error("EMBER_DARWIN_TEST=1, but this isn't macOS");
    console.log(`darwin: AXIsProcessTrusted() = ${trusted}; this process and its parents:\n  ${ancestry()}`);
    screen = displayScreen();
    const opened = openDarwinWindows({ screen });
    if (!opened) throw new Error(`the macOS window system didn't open: ${String(darwinWindowsError)}`);
    ws = opened;
    const input = openDarwinInput();
    if (!input) throw new Error(`macOS input didn't open: ${String(darwinInputError)}`);
    x = input;
    console.log(`darwin: Screen Recording = ${ws.screenRecording()}`);
  });

  afterAll(() => {
    x?.close();
    ws?.close();
  });

  it("reads the window list, the pointer and the keys without any permission", () => {
    expect(ws.kind).toBe("darwin");
    const stack = ws.stack();
    expect(stack.length).toBeGreaterThan(0); // at least the menu bar of a logged-in session
    for (let i = 0; i < stack.length; i++) expect(stack[i]!.client).toBe(stack[i]!.id);
    const p = ws.pointer();
    expect(p && Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false, shift: false, command: false });
    expect(x.keysDown()).toEqual([]);
    // What the borrow's checks cost on this Mac (they run every 8 ms while Ember glides): for the CI log.
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { x.keysDown(); x.pointerState(); ws.stack(); }
    console.log(`darwin: keysDown + pointerState + stack take ${((performance.now() - t0) / 20).toFixed(2)} ms`);
  });

  it("measures the displays in points and knows what is on them", () => {
    const main = screen.getPrimaryDisplay().bounds;
    expect(main.width).toBeGreaterThan(0);
    expect(ws.screenBounds().width).toBeGreaterThanOrEqual(main.width);
    expect(x.screenSize().width).toBeGreaterThan(0);
    expect(x.onScreen(main.x + main.width / 2, main.y + main.height / 2)).toBe(true);
    expect(x.onScreen(-100_000, -100_000)).toBe(false);
  });

  it("captures nothing without a capture function", () => {
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
  });

  it("reads the keyboard layout in use on the main thread", () => {
    const layout = x.layout();
    expect(layout).not.toBeNull();
    expect(layout!.shift).toBe(0x38 + 8);
    expect(x.keycodeOf(x.keysymOf("s"))).toBeGreaterThan(0);
  });

  describe.skipIf(!trusted && !required)("with the Accessibility permission, in TextEdit", () => {
    let dir = "";
    let file = "";
    let pid = 0;
    let win = 0;

    beforeAll(async () => {
      if (!trusted) {
        throw new Error(`EMBER_DARWIN_TEST=1, but this process isn't trusted for Accessibility (AXIsProcessTrusted() is false). Grant it to the binary that runs the tests, or to the app TCC holds responsible:\n  ${ancestry()}`);
      }
      expect(x.blockedReason(0)).toBeNull();
      dir = mkdtempSync(join(tmpdir(), "ember-darwin-"));
      file = join(dir, "ember.txt");
      writeFileSync(file, "");
      const before = new Set(textEditPids());
      // A new TextEdit with no restored windows, plain text read and written as UTF-8, no automatic corrections.
      const opened = spawnSync("/usr/bin/open", ["-n", "-a", "TextEdit", file, "--args",
        "-ApplePersistenceIgnoreState", "YES", "-PlainTextEncoding", "4", "-PlainTextEncodingForWrite", "4",
        "-CorrectSpellingAutomatically", "NO", "-NSAutomaticSpellingCorrectionEnabled", "NO", "-SmartQuotes", "NO", "-SmartDashes", "NO",
        "-TextReplacement", "NO"], { encoding: "utf8" });
      if (opened.status !== 0) throw new Error(`open -a TextEdit failed: ${opened.stderr}`);
      pid = await waitFor(() => textEditPids().find(p => !before.has(p)), 20_000, "a new TextEdit process");
      win = await waitFor(() => ws.stack().find(s => s.pid === pid && s.wmClass === "TextEdit" && !s.overrideRedirect)?.id, 20_000, "TextEdit's window in the stack");
    }, 60_000);

    afterAll(() => {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("lists TextEdit's window with its process and app name, and finds it by its title", async () => {
      expect(ws.clientWindows().some(w => w.id === win && w.pid === pid && w.wmClass === "TextEdit" && w.wmClassName === "TextEdit")).toBe(true);
      await waitFor(() => x.findWindow("ember.txt", pid) === win, 10_000, "findWindow to find ember.txt over AX");
    });

    it("brings TextEdit's window to the front and reports it as active and focused", async () => {
      x.activate(win);
      await waitFor(() => x.focusedWindow() === win, 10_000, "TextEdit's window to have the keyboard");
      expect(ws.activeWindow()?.id).toBe(win);
      expect(ws.focusWindow()).toMatchObject({ id: win, pid, wmClass: "TextEdit" });
      expect(x.activeWindow()).toBe(win);
    }, 20_000);

    it("types text whatever the layout, and saves it with Command+S pressed by keysym", async () => {
      await waitFor(() => x.focusedWindow() === win || (x.activate(win), false), 10_000, "TextEdit's window to have the keyboard");
      for (const ch of TEXT) {
        expect(x.textKey(ch, true)).toBe(true);
        expect(x.textKey(ch, false)).toBe(true);
        await sleep(30);
      }
      await sleep(300);
      const command = x.keysymOf("Super_L"), s = x.keysymOf("s");
      expect(x.keysym(command, true)).toBe(true);
      expect(x.keysym(s, true)).toBe(true);
      expect(x.keysym(s, false)).toBe(true);
      expect(x.keysym(command, false)).toBe(true);
      await waitFor(() => readFileSync(file, "utf8") === TEXT, 15_000, `the file to read "${TEXT}" (it reads ${JSON.stringify(readFileSync(file, "utf8"))})`);
    }, 30_000);

    it("moves the pointer where it was asked", async () => {
      const main = screen.getPrimaryDisplay().bounds;
      const to = { x: Math.round(main.x + main.width / 2) + 7, y: Math.round(main.y + main.height / 2) + 5 };
      x.move(to.x, to.y);
      await waitFor(() => {
        const p = ws.pointer();
        return p && Math.abs(p.x - to.x) <= 2 && Math.abs(p.y - to.y) <= 2;
      }, 2_000, `the pointer at ${to.x},${to.y}`);
    });

    it("leaves nothing pressed after releaseAll()", async () => {
      expect(x.keysym(x.keysymOf("Shift_L"), true)).toBe(true);
      await sleep(100);
      // Whether the session's key state shows Ember's own posted keys (the borrow filters them either way): for the CI log.
      console.log(`darwin: a posted Shift shows in keysDown() = ${x.keysDown().includes(0x38 + 8)}, in the flags = ${ws.keysDown()?.shift}`);
      x.releaseAll();
      await waitFor(() => x.keysDown().length === 0, 2_000, "no key down");
      expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false, shift: false, command: false });
      expect(ws.pointer()!.mask & 0x1f00).toBe(0);
    });
  });
});

/** The pids of every running TextEdit. */
function textEditPids(): number[] {
  const r = spawnSync("/usr/bin/pgrep", ["-x", "TextEdit"], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0);
}
