/**
 * The X11 window system behind the platform contract (platform/linux/window-system.ts): x11.ts's members unchanged,
 * and the unit conversions main.ts used to do itself from Electron's primary scale factor (main.ts's cursor(), flyTo
 * and perception's screen bounds), with the same arithmetic.
 */

import { describe, expect, it, vi } from "vitest";
import { openLinuxWindows, x11WindowId } from "../../app/main/platform/linux/window-system";
import type { X11 } from "../../app/main/x11";
import type { OwnWindowHandle, ScreenLike } from "../../app/main/platform/types";

const primary = { bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 };
const side = { bounds: { x: 1280, y: -100, width: 1920, height: 1080 }, scaleFactor: 1 };
const screen: ScreenLike = { getPrimaryDisplay: () => primary, getAllDisplays: () => [primary, side] };

/** A fake X11 whose members record their calls. */
function fakeX11() {
  const calls: unknown[][] = [];
  const rec = <T>(name: string, value: T) => (...a: unknown[]) => { calls.push([name, ...a]); return value; };
  const win = { id: 0x400001, pid: 77, title: "Notes", x: 0, y: 0, width: 10, height: 10, wmClass: "gedit gedit" };
  const x: X11 = {
    hasCompositor: rec("hasCompositor", true),
    pointer: rec("pointer", { x: 300, y: 200, mask: 256 }),
    keysDown: rec("keysDown", { control: true, alt: true, space: false }),
    activeWindow: rec("activeWindow", win),
    focusWindow: rec("focusWindow", win),
    clientWindows: rec("clientWindows", [win]),
    stack: rec("stack", []),
    capture: rec("capture", null),
    close: rec("close", undefined),
  };
  return { x, calls };
}

describe("openLinuxWindows", () => {
  it("without $DISPLAY is null, and doesn't try to open X at all (today's gate)", () => {
    const open = vi.fn(() => fakeX11().x);
    expect(openLinuxWindows({ screen, env: {}, open })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("is null when the display can't be opened", () => {
    expect(openLinuxWindows({ screen, env: { DISPLAY: ":0" }, open: () => null })).toBeNull();
  });

  it("is X11 itself: every member goes straight to x11.ts with the same arguments", () => {
    const { x, calls } = fakeX11();
    const ws = openLinuxWindows({ screen, env: { DISPLAY: ":0" }, open: () => x })!;
    expect(ws.kind).toBe("x11");
    expect(ws.compositorMayChange).toBe(true);
    expect(ws.hasCompositor(1)).toBe(true);
    expect(ws.pointer()).toEqual({ x: 300, y: 200, mask: 256 });
    expect(ws.keysDown()).toEqual({ control: true, alt: true, space: false });
    expect(ws.activeWindow()?.wmClass).toBe("gedit gedit");
    expect(ws.focusWindow()?.id).toBe(0x400001);
    expect(ws.clientWindows()).toHaveLength(1);
    expect(ws.stack()).toEqual([]);
    expect(ws.capture(1, 2, 3, 4)).toBeNull();
    ws.close();
    expect(calls).toEqual([["hasCompositor", 1], ["pointer"], ["keysDown"], ["activeWindow"], ["focusWindow"], ["clientWindows"], ["stack"], ["capture", 1, 2, 3, 4], ["close"]]);
    // Absent on Linux: GNOME Shell's own dialogs come from the sidecar's shell_overlays.
    expect(ws.systemDialogOpen).toBeUndefined();
  });

  it("converts to DIP by the primary display's scale factor, as main.ts did for the cursor and flyTo", () => {
    const ws = openLinuxWindows({ screen, env: { DISPLAY: ":0" }, open: () => fakeX11().x })!;
    // main.ts's own arithmetic (cursor() and flyTo), for comparison.
    const scale = () => screen.getPrimaryDisplay().scaleFactor || 1;
    const p = { x: 300, y: 200 };
    expect(ws.toDipPoint(p)).toEqual({ x: p.x / scale(), y: p.y / scale() });
    const b = { x: 101, y: 51, width: 33, height: 9 };
    expect(ws.toDip(b)).toEqual({ x: b.x / scale(), y: b.y / scale(), width: b.width / scale(), height: b.height / scale() });
    expect(ws.toDip(b)).toEqual({ x: 50.5, y: 25.5, width: 16.5, height: 4.5 });
  });

  it("takes a scale factor of 0 as 1 (as main.ts's `|| 1`)", () => {
    const flat: ScreenLike = { getPrimaryDisplay: () => ({ ...primary, scaleFactor: 0 }), getAllDisplays: () => [primary] };
    const ws = openLinuxWindows({ screen: flat, env: { DISPLAY: ":0" }, open: () => fakeX11().x })!;
    expect(ws.toDipPoint({ x: 30, y: 40 })).toEqual({ x: 30, y: 40 });
  });

  it("gives the screen bounds main.ts computed for perception: the displays' union times the primary scale", () => {
    const ws = openLinuxWindows({ screen, env: { DISPLAY: ":0" }, open: () => fakeX11().x })!;
    // main.ts:1172-1178 verbatim, for comparison.
    const today = () => {
      const scale = screen.getPrimaryDisplay().scaleFactor || 1;
      const all = screen.getAllDisplays().map(d => d.bounds);
      const x0 = Math.min(...all.map(b => b.x)), y0 = Math.min(...all.map(b => b.y));
      const x1 = Math.max(...all.map(b => b.x + b.width)), y1 = Math.max(...all.map(b => b.y + b.height));
      return { x: x0 * scale, y: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale };
    };
    expect(ws.screenBounds()).toEqual(today());
    expect(ws.screenBounds()).toEqual({ x: 0, y: -200, width: 6400, height: 2160 });
  });

  it("asks Electron's screen nothing until a conversion is asked for (it throws before app ready)", () => {
    const throwing = new Proxy({}, { get() { throw new Error("screen used before ready"); } }) as ScreenLike;
    const ws = openLinuxWindows({ screen: throwing, env: { DISPLAY: ":0" }, open: () => fakeX11().x })!;
    expect(ws.kind).toBe("x11");
    expect(() => ws.toDipPoint({ x: 1, y: 1 })).toThrow("before ready");
  });
});

describe("openLinuxWindows in a Wayland session (review #240)", () => {
  // The SSH remote's desktop child opens X11 through it too, in the x11 session logind chose there: the Wayland rule is
  // the Linux platform's own, for this computer (platform-linux.test.ts), and never reaches a remote.
  it("adds no system-dialog check of its own: that is this computer's platform's", () => {
    for (const env of [{ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }]) {
      const ws = openLinuxWindows({ screen, env, open: () => fakeX11().x })!;
      expect("systemDialogOpen" in ws).toBe(false);
      expect("systemDialogReason" in ws).toBe(false);
    }
  });
});

describe("x11WindowId", () => {
  it("reads the X id from the native handle's first 32 bits, and is 0 when it can't", () => {
    const handle = Buffer.alloc(8);
    handle.writeUInt32LE(0x3a00007, 0);
    const win = (h: () => Buffer): OwnWindowHandle => ({ getNativeWindowHandle: h, getMediaSourceId: () => "window:1:0" });
    expect(x11WindowId(win(() => handle))).toBe(0x3a00007);
    const ws = openLinuxWindows({ screen, env: { DISPLAY: ":0" }, open: () => fakeX11().x })!;
    expect(ws.windowId(win(() => handle))).toBe(0x3a00007);
    expect(ws.windowId(win(() => { throw new Error("destroyed"); }))).toBe(0);
    expect(ws.windowId(win(() => Buffer.alloc(0)))).toBe(0);
  });
});
