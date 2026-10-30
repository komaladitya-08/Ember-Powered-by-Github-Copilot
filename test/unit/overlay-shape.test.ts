/**
 * The overlay's input shape while Ember flies: the renderer reports new clickable rectangles every frame, so each
 * report costs one shape request on a display kept open, not a libX11 bind, an XOpenDisplay and a second identical
 * request (about a millisecond of the main thread each, every frame of a flight). libX11 is a fake here, put in
 * Node's require cache where xshape loads koffi from; the real server is test/integration/overlay-shape-live.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1200 }, bounds: { x: 0, y: 0, width: 1920, height: 1200 } };
  return {
    BrowserWindow: class {},
    screen: { getCursorScreenPoint: () => ({ x: 900, y: 600 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display, off() {} },
  };
});

import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";

/** What reached "libX11", in order (the overlay window's own calls go in the same log). */
let log: string[] = [];
let displays = 0;
let noServer = false;

function fakeKoffi() {
  const fns: Record<string, (...a: unknown[]) => unknown> = {
    XOpenDisplay: (name: unknown) => { log.push(`open ${String(name)}`); return noServer ? null : { n: ++displays }; },
    XCloseDisplay: (dpy: unknown) => { log.push(`close ${(dpy as { n: number }).n}`); return 0; },
    XSync: (dpy: unknown) => { log.push(`sync ${(dpy as { n: number }).n}`); return 1; },
    XShapeCombineRectangles: (dpy: unknown, xid: unknown, _kind: unknown, _x: unknown, _y: unknown, _rects: unknown, n: unknown) => {
      log.push(`shape ${(dpy as { n: number }).n} ${String(xid)} ${String(n)}`);
    },
  };
  return {
    load(name: string) {
      log.push(`load ${name}`);
      return { func: (decl: string) => fns[/(\w+)\(/.exec(decl)![1]!] ?? (() => 0) };
    },
    proto() { return "proto"; },
    pointer(t: unknown) { return `pointer(${String(t)})`; },
    register(fn: (...a: unknown[]) => unknown) { return fn; },
  };
}

const requireCjs = createRequire(import.meta.url);
const koffiPath = requireCjs.resolve("koffi");
let realKoffi: NodeModule | undefined;

beforeEach(() => {
  log = [];
  displays = 0;
  noServer = false;
  realKoffi = requireCjs.cache[koffiPath];
  requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: fakeKoffi() } as unknown as NodeModule;
  // A fresh xshape each time: it keeps the binding and the open displays for the process.
  vi.resetModules();
});

afterEach(() => {
  if (realKoffi) requireCjs.cache[koffiPath] = realKoffi;
  else delete requireCjs.cache[koffiPath];
});

const allow = [{ x: 100, y: 100, width: 60, height: 24 }];

describe("setInputShape", () => {
  it("binds libX11 once and keeps one display open across calls", async () => {
    const { setInputShape } = await import("../../app/main/xshape");
    for (let i = 0; i < 30; i++) expect(setInputShape(0x400001, [{ ...allow[0]!, x: 100 + i }])).toBe(true);
    // libX11 is loaded once for the shapes and once to install the X error handler that ignores a stale overlay xid.
    expect(log.filter(l => l.startsWith("load"))).toEqual(["load libX11.so.6", "load libXext.so.6", "load libX11.so.6"]);
    expect(log.filter(l => l.startsWith("open"))).toEqual(["open null"]);
    expect(log.filter(l => l.startsWith("close"))).toEqual([]);
    expect(log.filter(l => l.startsWith("shape"))).toHaveLength(30);
    // Each request is applied when it returns (a press right after lands on the new region).
    expect(log.slice(-2)).toEqual(["shape 1 4194305 1", "sync 1"]);
  });

  it("keeps one display per name (a test's own Xvfb beside $DISPLAY), and closeInputShape closes them all", async () => {
    const { setInputShape, closeInputShape } = await import("../../app/main/xshape");
    setInputShape(7, allow, 1, ":99");
    setInputShape(7, allow);
    setInputShape(7, [], 1, ":99");
    setInputShape(7, allow);
    expect(log.filter(l => l.startsWith("open"))).toEqual(["open :99", "open null"]);
    expect(log.filter(l => l.startsWith("shape"))).toEqual(["shape 1 7 1", "shape 2 7 1", "shape 1 7 0", "shape 2 7 1"]);
    closeInputShape();
    expect(log.filter(l => l.startsWith("close"))).toEqual(["close 1", "close 2"]);
    // Closed is not gone: the next call opens the display again.
    setInputShape(7, allow);
    expect(log.filter(l => l.startsWith("open"))).toEqual(["open :99", "open null", "open null"]);
  });

  it("no X server: false, and it tries again next time (it may come up)", async () => {
    const { setInputShape } = await import("../../app/main/xshape");
    noServer = true;
    expect(setInputShape(7, allow)).toBe(false);
    noServer = false;
    expect(setInputShape(7, allow)).toBe(true);
    expect(log.filter(l => l.startsWith("open"))).toEqual(["open null", "open null"]);
  });
});

describe("the overlay's clickable rectangles", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

  async function overlay() {
    const { OverlayManager } = await import("../../app/main/overlay");
    const m = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 900, y: 600 }));
    const handle = Buffer.alloc(4);
    handle.writeUInt32LE(0x400001, 0);
    const webContents = {};
    const win = {
      webContents,
      isDestroyed: () => false,
      destroy() {},
      getNativeWindowHandle: () => handle,
      setIgnoreMouseEvents: (on: boolean) => log.push(`ignore ${on}`),
    };
    const display = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 } };
    (m as unknown as { overlays: Map<number, unknown> }).overlays.set(1, { win, display, interactive: [], clickThrough: true, shaped: false, cards: null });
    return { m, sender: webContents as Electron.WebContents };
  }

  it("a flight's reports cost one shape request each; the re-apply follows only the switch out of click-through", async () => {
    const { m, sender } = await overlay();
    // The first report: shape, take clicks (Chromium resets the input region to the whole window), shape again.
    m.setInteractive(sender, allow);
    expect(log.filter(l => !l.startsWith("load") && !l.startsWith("sync"))).toEqual(["open null", "shape 1 4194305 1", "ignore false", "shape 1 4194305 1"]);
    // Ember flies: the body rectangle moves every frame.
    log = [];
    for (let i = 0; i < 45; i++) m.setInteractive(sender, [allow[0]!, { x: 100 + i * 7, y: 200 + i * 3, width: 54, height: 63 }]);
    expect(log.filter(l => l.startsWith("shape"))).toHaveLength(45);
    expect(log.filter(l => l.startsWith("open") || l.startsWith("load") || l.startsWith("ignore"))).toEqual([]);
    // Nothing clickable: click-through; then clickable again: the re-apply after the switch comes back.
    log = [];
    m.setInteractive(sender, []);
    m.setInteractive(sender, allow);
    expect(log.filter(l => !l.startsWith("sync"))).toEqual(["ignore true", "shape 1 4194305 1", "ignore false", "shape 1 4194305 1"]);
  });

  it("stopping closes the display the shapes went over", async () => {
    const { m, sender } = await overlay();
    m.setInteractive(sender, allow);
    m.stop();
    expect(log.filter(l => l.startsWith("close"))).toEqual(["close 1"]);
  });
});
