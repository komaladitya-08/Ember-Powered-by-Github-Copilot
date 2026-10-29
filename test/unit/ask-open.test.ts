/**
 * The order the ask box opens in from the keyboard (review #78, owner decision D-78). Linux holds the keyboard while
 * the box opens, so Ember reads where the user is first, as it always did. Windows and macOS can't hold it: every letter
 * typed before the box has the keyboard goes to the user's app, so the box shows first and the screen is read after,
 * of the window the user was in, taken just before (once the box is up, Windows' active window is the box, and macOS's
 * AX names no focused app). Perception reads that window, not the one active by then.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openAskInOrder } from "../../app/main/ask-open";
import { Perception } from "../../app/main/perception";
import type { AtspiSidecar, AxWindow } from "../../app/main/perception/sidecar";
import type { PerceptionWindows, X11Window } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";

type W = { id: number; title: string };
const NOTES: W = { id: 7, title: "notes.txt" };

/** The steps of one opening, in order, with the window the read was of. */
function open(o: { holding: boolean; look?: boolean; active: W | null }) {
  const steps: string[] = [];
  openAskInOrder<W>({
    holding: o.holding, look: o.look ?? true,
    activeWindow: () => { steps.push("active window"); return o.active; },
    read: active => steps.push(active ? `read ${active.title}` : "read"),
    show: () => steps.push("show"),
  });
  return steps;
}

describe("the ask box's opening from the keyboard (review #78)", () => {
  it("where Ember holds the keyboard (Linux), reads where the user is first, as always", () => {
    expect(open({ holding: true, active: NOTES })).toEqual(["read", "show"]);
  });

  it("where it can't (Windows, macOS), shows the box first and reads the window the user was in after", () => {
    expect(open({ holding: false, active: NOTES })).toEqual(["active window", "show", "read notes.txt"]);
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
    expect(openAsk).toContain("read: active => captureContext(active),");
    // Nothing else reads the screen there, before the box or after it.
    expect(openAsk.match(/captureContext\(/g)).toHaveLength(1);
    // The quick look reads the window taken before the box opened, when there is one.
    expect(MAIN).toContain("Promise.all([perception.quickContext(taken), selected])");
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

  it("reads the window active now when none is given, as before", async () => {
    const { perception, reads } = boxUp();
    // Ember's own window is never read.
    expect(await perception.quickContext()).toBeNull();
    expect(reads).toEqual([]);
  });
});
