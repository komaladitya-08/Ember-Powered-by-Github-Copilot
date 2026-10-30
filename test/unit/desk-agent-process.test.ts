/**
 * Ember's desk helper (app/main/desk/agent-process.ts) run in this process, against a private X server, so v8 sees it:
 * the ready list it sends, its failure paths, how it answers sync and async calls, and the real X work of keys.key /
 * keys.restore (keyboard mapping read and changed) and wm.ready / wm.end (a bare Xvfb, then a simulated EWMH window
 * manager, with a second X client of ours playing the manager). The X11 and XInput modules are fakes; DISPLAY is
 * this test's Xvfb only while the helper is imported, never the user's.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type Sharp from "sharp";

const requireCjs = createRequire(import.meta.url);

/** The fake X11/XInput modules read this, and record what the helper calls on them. */
const h = vi.hoisted(() => {
  const image = () => ({ x: 0, y: 0, width: 4, height: 2, bgra: Buffer.alloc(4 * 2 * 4) });
  return {
    x11Null: false,
    inputNull: false,
    calls: [] as { target: string; method: string; args: unknown[] }[],
    capture: image() as { x: number; y: number; width: number; height: number; bgra: Buffer } | null,
    active: { title: "Fake app" } as { title: string } | null,
    screen: { width: 4, height: 2 },
  };
});

vi.mock("../../app/main/x11", () => ({
  openX11: (display: string) => {
    h.calls.push({ target: "openX11", method: "", args: [display] });
    if (h.x11Null) return null;
    return {
      capture(...args: unknown[]) {
        h.calls.push({ target: "x11", method: "capture", args });
        return h.capture;
      },
      activeWindow() {
        h.calls.push({ target: "x11", method: "activeWindow", args: [] });
        return h.active;
      },
      echo(...args: unknown[]) {
        h.calls.push({ target: "x11", method: "echo", args });
        return args;
      },
      boom() {
        h.calls.push({ target: "x11", method: "boom", args: [] });
        throw new Error("kaboom");
      },
      numeric() {
        h.calls.push({ target: "x11", method: "numeric", args: [] });
        throw 42;
      },
      close() {
        h.calls.push({ target: "x11", method: "close", args: [] });
      },
    };
  },
}));

vi.mock("../../app/main/hands/input", () => ({
  openXInput: (display: string) => {
    h.calls.push({ target: "openXInput", method: "", args: [display] });
    if (h.inputNull) return null;
    return {
      screenSize() {
        h.calls.push({ target: "input", method: "screenSize", args: [] });
        return h.screen;
      },
      echo(...args: unknown[]) {
        h.calls.push({ target: "input", method: "echo", args });
        return args;
      },
    };
  },
}));

const hasXvfb = (() => {
  if (process.platform !== "linux") return false;
  try {
    return !spawnSync("Xvfb", ["-help"], { stdio: "ignore" }).error;
  } catch {
    return false;
  }
})();
const hasXlib = (() => {
  if (process.platform !== "linux") return false;
  try {
    requireCjs("koffi").load("libX11.so.6");
    return true;
  } catch {
    return false;
  }
})();

/** The small part of libX11 this test itself needs: to play a window manager and to read the key map back. */
function makeXlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  return {
    koffi,
    XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: lib.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: lib.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateSimpleWindow: lib.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)"),
    XInternAtom: lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XChangeProperty: lib.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long property, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XGetWindowProperty: lib.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)"),
    XQueryTree: lib.func("int XQueryTree(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *n)"),
    XFree: lib.func("int XFree(void *data)"),
    XSync: lib.func("int XSync(void *dpy, int discard)"),
    XDisplayKeycodes: lib.func("int XDisplayKeycodes(void *dpy, _Out_ int *min, _Out_ int *max)"),
    XGetKeyboardMapping: lib.func("void *XGetKeyboardMapping(void *dpy, uint8_t first, int count, _Out_ int *per)"),
  };
}

type Xlib = ReturnType<typeof makeXlib>;
type Dpy = Parameters<Xlib["XCloseDisplay"]>[0];

/**
 * The helper is imported again for each scenario (vi.resetModules), and koffi keeps type names globally: a second
 * koffi.proto("int EmberXErrorHandler(…)") throws "Duplicate type name". Reuse the first type of each name; every
 * other call (load, decode, register…) is the real koffi, so openKeyboard/openWmProbe still talk to the real Xvfb.
 */
function koffiWithReusableProto(real: typeof import("koffi")) {
  const types = new Map<string, unknown>();
  const K = real as unknown as Record<string, (...a: unknown[]) => unknown>;
  return {
    load: (...a: unknown[]) => K.load(...a),
    proto: (...a: unknown[]) => {
      const definition = a.find((v): v is string => typeof v === "string" && v.includes("("));
      const name = definition ? /\b(\w+)\s*\(/.exec(definition)?.[1] : undefined;
      if (name) {
        const had = types.get(name);
        if (had) return had;
        const made = K.proto(...a);
        types.set(name, made);
        return made;
      }
      return K.proto(...a);
    },
    pointer: (...a: unknown[]) => K.pointer(...a),
    register: (...a: unknown[]) => K.register(...a),
    decode: (...a: unknown[]) => K.decode(...a),
    array: (...a: unknown[]) => K.array(...a),
    struct: (...a: unknown[]) => K.struct(...a),
  };
}

type DeskRequest = { id: number; t: string; m: string; a?: unknown[]; async?: boolean };
type Reply = Record<string, unknown>;

describe.runIf(process.platform === "linux" && hasXvfb && hasXlib)("the desk helper process", () => {
  let x!: Xlib;
  let server: ChildProcess | undefined;
  let display = "";
  let wmDpy: Dpy = null;
  let readDpy: Dpy = null;
  let cleanup: (() => void) | null = null;
  let koffiPath = "";
  let priorKoffi: NodeModule | undefined;

  const atom = (dpy: Dpy, name: string) => Number(x.XInternAtom(dpy, name, 0));

  const childrenOf = (dpy: Dpy, win: number): number[] => {
    const r = [0], parent = [0], list: unknown[] = [null], n = [0];
    if (!x.XQueryTree(dpy, win, r, parent, list, n) || !list[0]) return [];
    try {
      const b = Buffer.from(x.koffi.decode(list[0], "uint8_t", Number(n[0]) * 8) as Uint8Array);
      return Array.from({ length: Number(n[0]) }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
    } finally {
      x.XFree(list[0]);
    }
  };

  const readName = (dpy: Dpy, win: number): string | null => {
    const type = [0], format = [0], n = [0], after = [0], data: unknown[] = [null];
    if (x.XGetWindowProperty(dpy, win, atom(dpy, "WM_NAME"), 0, 1024, 0, 0, type, format, n, after, data) !== 0) return null;
    const ptr = data[0];
    if (!ptr) return null;
    try {
      if (format[0] !== 8 || Number(n[0]) === 0) return null;
      return Buffer.from(x.koffi.decode(ptr, "uint8_t", Number(n[0])) as Uint8Array).toString("utf8");
    } finally {
      x.XFree(ptr);
    }
  };

  const probesNamed = (name: string): number[] => {
    const root = Number(x.XDefaultRootWindow(wmDpy));
    return childrenOf(wmDpy, root).filter(w => readName(wmDpy, w) === name);
  };

  /** Sets a window property of 32-bit items (X's C longs, 8 bytes here); an empty list clears it. */
  const setLongs = (dpy: Dpy, win: number, name: string, values: number[]) => {
    const data = Buffer.alloc(Math.max(values.length, 1) * 8);
    values.forEach((v, i) => data.writeBigUInt64LE(BigInt(v), i * 8));
    x.XChangeProperty(dpy, win, atom(dpy, name), atom(dpy, "WINDOW"), 32, 0, data, values.length);
    x.XSync(dpy, 0);
  };

  /** The keysyms the server has for `code` (all shift levels). */
  const levelsOf = (dpy: Dpy, code: number): number[] => {
    const min = [0], max = [0], per = [0];
    x.XDisplayKeycodes(dpy, min, max);
    const ptr = x.XGetKeyboardMapping(dpy, min[0], max[0] - min[0] + 1, per);
    if (!ptr) return [];
    try {
      const n = (max[0] - min[0] + 1) * per[0];
      const b = Buffer.from(x.koffi.decode(ptr, "uint8_t", n * 8) as Uint8Array);
      const at = (code - min[0]) * per[0];
      return Array.from({ length: per[0] }, (_, l) => Number(b.readBigUInt64LE((at + l) * 8)));
    } finally {
      x.XFree(ptr);
    }
  };

  const allKeysyms = (dpy: Dpy): number[] => {
    const min = [0], max = [0], per = [0];
    x.XDisplayKeycodes(dpy, min, max);
    const ptr = x.XGetKeyboardMapping(dpy, min[0], max[0] - min[0] + 1, per);
    if (!ptr) return [];
    try {
      const n = (max[0] - min[0] + 1) * per[0];
      const b = Buffer.from(x.koffi.decode(ptr, "uint8_t", n * 8) as Uint8Array);
      return Array.from({ length: n }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
    } finally {
      x.XFree(ptr);
    }
  };

  beforeAll(async () => {
    koffiPath = requireCjs.resolve("koffi");
    const realKoffi = requireCjs(koffiPath) as typeof import("koffi");
    priorKoffi = requireCjs.cache[koffiPath];
    requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: koffiWithReusableProto(realKoffi) } as unknown as NodeModule;
    x = makeXlib();
    server = spawn("Xvfb", ["-displayfd", "3", "-noreset", "-nolisten", "tcp", "-screen", "0", "640x480x24"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      const failure = (why: string) => reject(new Error(`Xvfb didn't start: ${why}`));
      server!.once("error", (err: Error) => failure(err.message));
      server!.once("exit", (code: number | null) => failure(`exit ${String(code)}`));
      server!.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
    });
    const probe = x.XOpenDisplay(display);
    if (!probe) throw new Error(`Xvfb didn't accept connections on ${display}`);
    x.XCloseDisplay(probe);
    wmDpy = x.XOpenDisplay(display);
    readDpy = x.XOpenDisplay(display);
    if (!wmDpy || !readDpy) throw new Error(`can't open ${display} for the test's own X client`);
  });

  afterAll(async () => {
    if (x) {
      if (wmDpy) x.XCloseDisplay(wmDpy);
      if (readDpy) x.XCloseDisplay(readDpy);
    }
    if (server) {
      await new Promise<void>(resolve => {
        if (server!.exitCode !== null || server!.signalCode !== null) return resolve();
        const kill = setTimeout(() => server!.kill("SIGKILL"), 2000);
        server!.once("exit", () => { clearTimeout(kill); resolve(); });
        server!.kill("SIGTERM");
      });
    }
    if (koffiPath) {
      if (priorKoffi) requireCjs.cache[koffiPath] = priorKoffi;
      else delete requireCjs.cache[koffiPath];
    }
  });

  beforeEach(() => {
    h.x11Null = false;
    h.inputNull = false;
    h.calls = [];
    h.capture = { x: 0, y: 0, width: 4, height: 2, bgra: Buffer.alloc(4 * 2 * 4) };
    h.active = { title: "Fake app" };
    h.screen = { width: 4, height: 2 };
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  /**
   * Imports the helper with its IPC stubbed. The test runner itself talks to this process over process.send/message
   * (a fork pool), so the helper's "message"/"disconnect" handlers are captured instead of added, and process.send
   * only records what the helper sends while running inside our emit (AsyncLocalStorage); the runner's own IPC goes
   * through to the real send.
   */
  async function load(opts: { x11Null?: boolean; inputNull?: boolean } = {}) {
    h.x11Null = opts.x11Null ?? false;
    h.inputNull = opts.inputNull ?? false;
    vi.resetModules();
    const sendBefore = Object.getOwnPropertyDescriptor(process, "send");
    const onBefore = Object.getOwnPropertyDescriptor(process, "on");
    const connectedBefore = Object.getOwnPropertyDescriptor(process, "connected");
    const displayBefore = process.env.DISPLAY;
    const sent: Reply[] = [];
    const handlers: { message: ((r: DeskRequest) => void)[]; disconnect: (() => void)[] } = { message: [], disconnect: [] };
    const realSend = process.send;
    const insideAgent = new AsyncLocalStorage<boolean>();
    let importing = true;
    Object.defineProperty(process, "send", {
      configurable: true,
      writable: true,
      value: (m: Reply, cb?: () => void) => {
        if (importing || insideAgent.getStore()) { sent.push(m); cb?.(); return true; }
        if (typeof realSend !== "function") return false;
        return Reflect.apply(realSend, process, cb ? [m, cb] : [m]) as boolean;
      },
    });
    Object.defineProperty(process, "connected", { configurable: true, get: () => true });
    const realOn = process.on;
    Object.defineProperty(process, "on", {
      configurable: true,
      writable: true,
      value: (event: string, listener: (...args: never[]) => void) => {
        if (event === "message") { handlers.message.push(listener as (r: DeskRequest) => void); return process; }
        if (event === "disconnect") { handlers.disconnect.push(listener as () => void); return process; }
        return realOn.call(process, event, listener as (...args: unknown[]) => void);
      },
    });
    process.env.DISPLAY = display;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await insideAgent.run(true, () => import("../../app/main/desk/agent-process"));
    } finally {
      importing = false;
      if (onBefore) Object.defineProperty(process, "on", onBefore); else delete (process as { on?: unknown }).on;
      if (displayBefore === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = displayBefore;
    }
    cleanup = () => {
      if (sendBefore) Object.defineProperty(process, "send", sendBefore); else delete (process as { send?: unknown }).send;
      if (connectedBefore) Object.defineProperty(process, "connected", connectedBefore); else delete (process as { connected?: unknown }).connected;
      exit.mockRestore();
    };
    const emit = (r: DeskRequest) => {
      for (const l of handlers.message) insideAgent.run(true, () => l(r));
    };
    const disconnect = () => {
      for (const l of handlers.disconnect) insideAgent.run(true, () => l());
    };
    return { sent, exit, emit, disconnect };
  }

  it("announces the calls it serves, with the real keys and window-manager targets", async () => {
    const { sent } = await load();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      ready: true,
      calls: {
        x11: ["capture", "activeWindow", "echo", "boom", "numeric", "close"],
        input: ["screenSize", "echo"],
        keys: ["key", "restore"],
        view: ["snapshot"],
        wm: ["ready", "end"],
      },
    });
    expect(h.calls).toContainEqual({ target: "openX11", method: "", args: [display] });
    expect(h.calls).toContainEqual({ target: "openXInput", method: "", args: [display] });
  });

  it("says which parts of the desk display it couldn't open, then exits 1 from the send callback", async () => {
    const { sent, exit } = await load({ x11Null: true });
    expect(sent).toEqual([{ ready: false, error: "couldn't open the desk display (x11)" }]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("names a missing input module too, and every missing part", async () => {
    const input = await load({ inputNull: true });
    expect(input.sent).toEqual([{ ready: false, error: "couldn't open the desk display (input)" }]);
    expect(input.exit).toHaveBeenCalledWith(1);
    input.emit({ id: 1, t: "x11", m: "echo", a: [] });
    cleanup?.();
    cleanup = null;
    const both = await load({ x11Null: true, inputNull: true });
    expect(both.sent).toEqual([{ ready: false, error: "couldn't open the desk display (x11, input)" }]);
    expect(both.exit).toHaveBeenCalledWith(1);
  });

  it("answers a sync call with its value and the arguments it was given", async () => {
    const { sent, emit } = await load();
    emit({ id: 7, t: "x11", m: "echo", a: [1, "two", { three: 3 }] });
    expect(sent.at(-1)).toEqual({ id: 7, v: [1, "two", { three: 3 }] });
    emit({ id: 8, t: "input", m: "echo", a: [] });
    expect(sent.at(-1)).toEqual({ id: 8, v: [] });
  });

  it("rejects an unknown target, an unknown method, close, and reports both Error and non-Error throws", async () => {
    const { sent, emit } = await load();
    emit({ id: 1, t: "nope", m: "echo", a: [] });
    expect(sent.at(-1)).toEqual({ id: 1, e: "unknown desk call nope.echo" });
    emit({ id: 2, t: "x11", m: "nope", a: [] });
    expect(sent.at(-1)).toEqual({ id: 2, e: "unknown desk call x11.nope" });
    emit({ id: 3, t: "x11", m: "close", a: [] });
    expect(sent.at(-1)).toEqual({ id: 3, e: "unknown desk call x11.close" });
    expect(h.calls).not.toContainEqual({ target: "x11", method: "close", args: [] });
    emit({ id: 4, t: "x11", m: "boom", a: [] });
    expect(sent.at(-1)).toEqual({ id: 4, e: "kaboom" });
    emit({ id: 5, t: "x11", m: "numeric", a: [] });
    expect(sent.at(-1)).toEqual({ id: 5, e: "42" });
  });

  it("answers async calls with async:true, for values and for errors", async () => {
    const { sent, emit } = await load();
    emit({ id: 1, t: "x11", m: "echo", a: ["hi"], async: true });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ id: 1, async: true, v: ["hi"] });
    emit({ id: 2, t: "x11", m: "boom", a: [], async: true });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual({ id: 2, async: true, e: "kaboom" });
  });

  it("exits 0 when Ember disconnects", async () => {
    const { exit, disconnect } = await load();
    disconnect();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reads the key map for a key it has, and lends a spare key to a character it doesn't", async () => {
    const { sent, emit } = await load();
    // 'a' is on the Xvfb keyboard already, without Shift.
    emit({ id: 1, t: "keys", m: "key", a: [0x61] });
    const a = sent.at(-1) as { id: number; v: { code: number; shift: boolean | null } };
    expect(a.id).toBe(1);
    expect(a.v.code).toBeGreaterThan(0);
    expect(a.v.shift).toBe(false);
    expect(levelsOf(readDpy, a.v.code).slice(0, 2)).toEqual([0x61, 0x41]);

    // Greek alpha has no key: a spare one is given it, on both shift levels.
    expect(allKeysyms(readDpy)).not.toContain(0x10003b1);
    emit({ id: 2, t: "keys", m: "key", a: [0x10003b1] });
    const alpha = sent.at(-1) as { id: number; v: { code: number; shift: boolean | null } };
    expect(alpha.id).toBe(2);
    expect(alpha.v.code).toBeGreaterThan(0);
    expect(alpha.v.shift).toBeNull();
    expect(levelsOf(readDpy, alpha.v.code).slice(0, 2)).toEqual([0x10003b1, 0x10003b1]);

    // restore() puts NoSymbol back on every lent key.
    emit({ id: 3, t: "keys", m: "restore", a: [] });
    expect(sent.at(-1)).toEqual({ id: 3, v: undefined });
    expect(levelsOf(readDpy, alpha.v.code).every(s => s === 0)).toBe(true);
  });

  it("is not ready for a bare Xvfb, then follows a simulated EWMH window manager to ready, and closes on end", async () => {
    const { sent, emit } = await load();
    const ready = (id: number) => {
      emit({ id, t: "wm", m: "ready", a: [] });
      return (sent.at(-1) as { v: boolean }).v;
    };
    // No _NET_SUPPORTING_WM_CHECK at all.
    expect(ready(1)).toBe(false);

    // Our own client plays a minimal window manager, starting with a stale check: the root names W, but W
    // does not name itself yet, so no probe may be mapped.
    const root = Number(x.XDefaultRootWindow(wmDpy));
    const w = Number(x.XCreateSimpleWindow(wmDpy, root, 0, 0, 1, 1, 0, 0, 0));
    setLongs(wmDpy, root, "_NET_SUPPORTING_WM_CHECK", [w]);
    expect(ready(2)).toBe(false);
    expect(probesNamed("Ember's window manager check")).toEqual([]);

    // W names itself now: the check passes, so the helper maps a probe and waits for the manager to manage it.
    setLongs(wmDpy, w, "_NET_SUPPORTING_WM_CHECK", [w]);
    expect(ready(3)).toBe(false);
    const probes = probesNamed("Ember's window manager check");
    expect(probes).toHaveLength(1);
    const probe = probes[0]!;

    // A probe exists but has no WM_STATE yet (and the client list is empty): still not ready.
    expect(ready(4)).toBe(false);

    // The manager manages the probe, but its list still shows the probe: not ready yet.
    setLongs(wmDpy, probe, "WM_STATE", [1]);
    setLongs(wmDpy, root, "_NET_CLIENT_LIST", [probe]);
    expect(ready(5)).toBe(false);

    // The managed probes are gone from its list: ready.
    setLongs(wmDpy, root, "_NET_CLIENT_LIST", []);
    expect(ready(6)).toBe(true);

    // end() lets go of the connection: the next ready() opens it again and starts over with a new probe.
    emit({ id: 7, t: "wm", m: "end", a: [] });
    expect(sent.at(-1)).toEqual({ id: 7, v: undefined });
    expect(ready(8)).toBe(false);
    emit({ id: 9, t: "wm", m: "end", a: [] });
    expect(sent.at(-1)).toEqual({ id: 9, v: undefined });
  });

  it("snapshots the desk: a JPEG, its size and the active window's title", async () => {
    const sharp = requireCjs("sharp") as typeof Sharp;
    const { sent, emit } = await load();
    emit({ id: 1, t: "view", m: "snapshot", a: [100, 80], async: true });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const reply = sent[1] as { id: number; async: boolean; v: { jpeg: Buffer; width: number; height: number; title: string } };
    expect(reply.id).toBe(1);
    expect(reply.async).toBe(true);
    expect(Buffer.isBuffer(reply.v.jpeg)).toBe(true);
    expect([...reply.v.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    // A requested width wider than the 4x2 capture must not upscale it.
    const meta = await sharp(reply.v.jpeg).metadata();
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(2);
    expect(reply.v.width).toBe(4);
    expect(reply.v.height).toBe(2);
    expect(reply.v.title).toBe("Fake app");
    expect(h.calls.filter(c => c.target === "x11" && c.method === "capture")).toEqual([
      { target: "x11", method: "capture", args: [0, 0, 4, 2] },
    ]);
  });

  it("scales a capture down to the requested width", async () => {
    const sharp = requireCjs("sharp") as typeof Sharp;
    h.screen = { width: 8, height: 4 };
    h.capture = { x: 0, y: 0, width: 8, height: 4, bgra: Buffer.alloc(8 * 4 * 4) };
    const { sent, emit } = await load();
    emit({ id: 1, t: "view", m: "snapshot", a: [4, 80], async: true });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const reply = sent[1] as { v: { jpeg: Buffer; width: number; height: number } };
    const meta = await sharp(reply.v.jpeg).metadata();
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(2);
    expect(reply.v.width).toBe(8);
    expect(reply.v.height).toBe(4);
    expect(h.calls.filter(c => c.target === "x11" && c.method === "capture")).toEqual([
      { target: "x11", method: "capture", args: [0, 0, 8, 4] },
    ]);
  });

  it("loads sharp at the first frame when it wasn't there at start-up", async () => {
    const sharpPath = requireCjs.resolve("sharp");
    const priorSharp = requireCjs.cache[sharpPath];
    const realSharp = requireCjs(sharpPath);
    let reads = 0;
    const failing = { id: sharpPath, filename: sharpPath, loaded: true };
    Object.defineProperty(failing, "exports", {
      configurable: true,
      get() {
        if (reads++ === 0) throw new Error("sharp isn't ready yet");
        return realSharp;
      },
    });
    requireCjs.cache[sharpPath] = failing as unknown as NodeModule;
    try {
      const { sent, emit } = await load();
      expect(sent[0]).toMatchObject({ ready: true });
      expect(reads).toBe(1);
      emit({ id: 1, t: "view", m: "snapshot", a: [4, 80], async: true });
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      const v = (sent[1] as { v: { jpeg: Buffer } }).v;
      expect([...v.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      expect(reads).toBe(2);
    } finally {
      if (priorSharp) requireCjs.cache[sharpPath] = priorSharp;
      else delete requireCjs.cache[sharpPath];
    }
  });

  it("snapshots nothing when capture returns null, and uses an empty title when there is no active window", async () => {
    h.capture = null;
    const { sent, emit } = await load();
    emit({ id: 1, t: "view", m: "snapshot", a: [4, 80], async: true });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ id: 1, async: true, v: null });
    cleanup?.();
    cleanup = null;

    h.capture = { x: 0, y: 0, width: 4, height: 2, bgra: Buffer.alloc(4 * 2 * 4) };
    h.active = null;
    const second = await load();
    second.emit({ id: 1, t: "view", m: "snapshot", a: [4, 80], async: true });
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    expect((second.sent[1] as { v: { title: string } }).v.title).toBe("");
  });
});
