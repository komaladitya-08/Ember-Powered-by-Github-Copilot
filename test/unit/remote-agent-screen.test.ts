import { describe, expect, it } from "vitest";
import { ignoreXErrors, rootScreen } from "../../app/remote/screen";

/** A stand-in for koffi that records what is bound and registered (no libX11 is loaded). */
function fakeKoffi(o: { loadFails?: boolean } = {}) {
  const calls: string[] = [];
  let handler: ((dpy: unknown, event: unknown) => number) | null = null;
  const koffi = {
    load(name: string) {
      calls.push(`load ${name}`);
      if (o.loadFails) throw new Error("libX11.so.6: cannot open shared object file");
      return {
        func(decl: string) {
          calls.push(`func ${decl}`);
          return (h: unknown) => { calls.push(`XSetErrorHandler ${String(h)}`); return null; };
        },
      };
    },
    proto(decl: string) { calls.push(`proto ${decl}`); return "proto"; },
    pointer(t: unknown) { return `pointer(${String(t)})`; },
    register(fn: (dpy: unknown, event: unknown) => number, t: unknown) { calls.push(`register ${String(t)}`); handler = fn; return "registered"; },
  };
  return { koffi, calls, handler: () => handler };
}

describe("the remote desktop helper's X error handler (review #4)", () => {
  // Plain Node has no X error handler of its own, so Xlib's default ends the helper on the first BadWindow (a menu or
  // tooltip that closed between two calls). Electron's main process and the desk helper install one; so must this.
  it("installs a handler that ignores X errors, once per process", () => {
    const f = fakeKoffi();
    const state = { installed: false };
    expect(ignoreXErrors(() => f.koffi as never, state)).toBe(true);
    expect(f.calls).toEqual([
      "load libX11.so.6",
      "proto int EmberXErrorHandler(void *dpy, void *event)",
      "func void *XSetErrorHandler(EmberXErrorHandler *handler)",
      "register pointer(proto)",
      "XSetErrorHandler registered",
    ]);
    // The handler returns 0: the error is ignored and the call that caused it just fails.
    expect(f.handler()?.(null, null)).toBe(0);
    expect(ignoreXErrors(() => f.koffi as never, state)).toBe(true);
    expect(state.installed).toBe(true);
    expect(f.calls.filter(c => c.startsWith("XSetErrorHandler"))).toHaveLength(1);
  });

  it("answers false, without throwing, where koffi or libX11 can't load (a macOS remote, no X)", () => {
    const state = { installed: false };
    expect(ignoreXErrors(() => { throw new Error("Cannot find module 'koffi'"); }, state)).toBe(false);
    expect(ignoreXErrors(() => fakeKoffi({ loadFails: true }).koffi as never, state)).toBe(false);
    expect(state.installed).toBe(false);
  });
});

describe("rootScreen", () => {
  it("is one display of the root's size at scale 1", () => {
    const s = rootScreen({ width: 1600, height: 900 });
    expect(s.getAllDisplays()).toEqual([{ bounds: { x: 0, y: 0, width: 1600, height: 900 }, scaleFactor: 1 }]);
  });
});
