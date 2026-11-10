/** Noticing the X server go away (app/main/x11.ts watchDisplayGone), with a stand-in for koffi: no libX11 is loaded. */

import { describe, expect, it } from "vitest";
import { watchDisplayGone } from "../../app/main/x11";

/** A stand-in for koffi that records what is bound, registered and called. */
function fakeKoffi(o: { loadFails?: boolean } = {}) {
  const calls: string[] = [];
  let handler: ((dpy: unknown) => number) | null = null;
  const koffi = {
    load(name: string) {
      calls.push(`load ${name}`);
      if (o.loadFails) throw new Error("libX11.so.6: cannot open shared object file");
      return {
        func(decl: string) {
          calls.push(`func ${decl}`);
          return (h: unknown) => { calls.push(`XSetIOErrorHandler ${String(h)}`); return "gtk"; };
        },
      };
    },
    proto(decl: string) { calls.push(`proto ${decl}`); return "proto"; },
    pointer(t: unknown) { return `pointer(${String(t)})`; },
    register(fn: (dpy: unknown) => number, t: unknown) { calls.push(`register ${String(t)}`); handler = fn; return "ember"; },
    call(fn: unknown, t: unknown, dpy: unknown) { calls.push(`call ${String(fn)} ${String(t)} ${String(dpy)}`); return 0; },
  };
  return { koffi, calls, handler: () => handler };
}

describe("watching for the display to go away", () => {
  it("ends the run once when the X connection breaks, then hands on to GTK's handler, which ends the process (reliability-performance-r1)", () => {
    const f = fakeKoffi();
    const ended: string[] = [];
    const restore = watchDisplayGone(() => ended.push("ended"), () => f.koffi as never, { restore: null, ended: null });
    expect(restore).toBeTypeOf("function");
    expect(f.calls).toEqual([
      "load libX11.so.6",
      "proto int EmberXIOErrorHandler(void *dpy)",
      "func void *XSetIOErrorHandler(EmberXIOErrorHandler *handler)",
      "register pointer(proto)",
      "XSetIOErrorHandler ember",
    ]);
    // Two connections (Ember's own and GTK's) can both break: the run ends once, and each goes on to GTK's handler.
    f.handler()?.(1n);
    f.handler()?.(2n);
    expect(ended).toEqual(["ended"]);
    expect(f.calls.filter(c => c.startsWith("call"))).toEqual(["call gtk proto 1", "call gtk proto 2"]);
  });

  it("still hands on to GTK's handler when ending the run throws (reliability-performance-r1)", () => {
    const f = fakeKoffi();
    watchDisplayGone(() => { throw new Error("settings couldn't be saved"); }, () => f.koffi as never, { restore: null, ended: null });
    expect(() => f.handler()?.(1n)).not.toThrow();
    expect(f.calls.at(-1)).toBe("call gtk proto 1");
  });

  it("puts GTK's handler back as Ember quits, and tells no one after (reliability-performance-r1)", () => {
    const f = fakeKoffi();
    const state = { restore: null, ended: null };
    const ended: string[] = [];
    const restore = watchDisplayGone(() => ended.push("ended"), () => f.koffi as never, state);
    restore?.();
    restore?.();
    expect(f.calls.filter(c => c.startsWith("XSetIOErrorHandler"))).toEqual(["XSetIOErrorHandler ember", "XSetIOErrorHandler gtk"]);
    f.handler()?.(1n);
    expect(ended).toEqual([]);
  });

  it("installs one handler per process: a second watch takes over the telling (reliability-performance-r1)", () => {
    const f = fakeKoffi();
    const state = { restore: null, ended: null };
    const ended: string[] = [];
    const restore = watchDisplayGone(() => ended.push("first"), () => f.koffi as never, state);
    expect(watchDisplayGone(() => ended.push("second"), () => f.koffi as never, state)).toBe(restore);
    expect(f.calls.filter(c => c.startsWith("register"))).toHaveLength(1);
    f.handler()?.(1n);
    expect(ended).toEqual(["second"]);
  });

  it("answers null, without throwing, where koffi or libX11 can't load", () => {
    const state = { restore: null, ended: null };
    expect(watchDisplayGone(() => undefined, () => { throw new Error("Cannot find module 'koffi'"); }, state)).toBeNull();
    expect(watchDisplayGone(() => undefined, () => fakeKoffi({ loadFails: true }).koffi as never, state)).toBeNull();
    expect(state.restore).toBeNull();
  });
});
