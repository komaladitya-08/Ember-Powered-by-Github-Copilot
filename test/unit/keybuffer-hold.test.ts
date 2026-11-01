/**
 * holdKeyboard(): Ember's own X keyboard grab while the ask box opens. Without an X server or libX11 it must fail
 * safely (null); on a real display (Xvfb) it must keep the keys typed during the hold, let go on stop or the safety
 * timeout, and keep retrying while another client (the hotkey's grab) still has the keyboard.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { holdKeyboard } from "../../app/main/hands/keybuffer";

const requireCjs = createRequire(import.meta.url);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 1500) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(5);
  return cond();
};

type Event = { event: string; fields: Record<string, unknown> };
const logger = (events: Event[]) => (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); };

describe("holdKeyboard without an X library", () => {
  const koffiPath = requireCjs.resolve("koffi");
  let realKoffi: NodeModule | undefined;

  beforeEach(() => {
    realKoffi = requireCjs.cache[koffiPath];
    const fake = { load() { throw new Error("no native library here"); } };
    requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: fake } as unknown as NodeModule;
  });

  afterEach(() => {
    if (realKoffi) requireCjs.cache[koffiPath] = realKoffi;
    else delete requireCjs.cache[koffiPath];
  });

  it("returns null when koffi cannot load libX11", () => {
    expect(holdKeyboard()).toBeNull();
    expect(holdKeyboard({ display: ":0", maxMs: 1 })).toBeNull();
  });
});

describe.runIf(process.platform === "linux")("holdKeyboard without a display", () => {
  it("returns null when the X display does not exist", () => {
    expect(holdKeyboard({ display: ":987654" })).toBeNull();
  });
});

/** Whether this machine can run the real-X tests: Linux, Xvfb, and both X libraries, all loadable. */
function xReady(): boolean {
  if (process.platform !== "linux") return false;
  if (spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status !== 0) return false;
  try {
    const koffi = requireCjs("koffi") as typeof import("koffi");
    koffi.load("libX11.so.6");
    koffi.load("libXtst.so.6");
    return true;
  } catch {
    return false;
  }
}

const X_READY = xReady();

function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x = koffi.load("libX11.so.6");
  const xtst = koffi.load("libXtst.so.6");
  return {
    XOpenDisplay: x.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XGrabKeyboard: x.func("int XGrabKeyboard(void *dpy, unsigned long w, int ownerEvents, int pointerMode, int keyboardMode, unsigned long time)"),
    XUngrabKeyboard: x.func("int XUngrabKeyboard(void *dpy, unsigned long time)"),
    XKeysymToKeycode: x.func("uint8_t XKeysymToKeycode(void *dpy, unsigned long sym)"),
    XTestFakeKeyEvent: xtst.func("int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int isPress, unsigned long delay)"),
    XSync: x.func("int XSync(void *dpy, int discard)"),
  };
}

const RETURN = 0xff0d, ESCAPE = 0xff1b, BACKSPACE = 0xff08, SPACE = 0x20;
const SUPER_L = 0xffeb, CONTROL_L = 0xffe3;

describe.runIf(X_READY)("holdKeyboard on a real X display", () => {
  let server: ChildProcess | undefined;
  let display = "";
  let L: ReturnType<typeof xlib>;
  const clients: { close(): void }[] = [];

  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-noreset", "-nolisten", "tcp", "-screen", "0", "640x480x24"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    display = ":" + await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Xvfb did not report a display")), 5000);
      server!.stdio[3]!.on("data", (d: Buffer) => {
        buf += d.toString();
        const first = buf.split("\n")[0].trim();
        if (/^\d+$/.test(first)) {
          clearTimeout(timer);
          resolve(first);
        }
      });
      server!.once("exit", code => {
        clearTimeout(timer);
        reject(new Error(`Xvfb exited (${code}) before reporting a display`));
      });
    });
    L = xlib();
  }, 10_000);

  afterAll(async () => {
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { server!.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, 2000);
      server!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  function helper() {
    const dpy = L.XOpenDisplay(display);
    if (!dpy) throw new Error("cannot open the test display");
    const root = Number(L.XDefaultRootWindow(dpy));
    let open = true;
    const c = {
      grab() {
        const status = Number(L.XGrabKeyboard(dpy, root, 0, 1, 1, 0));
        L.XSync(dpy, 0);
        return status;
      },
      ungrab() {
        L.XUngrabKeyboard(dpy, 0);
        L.XSync(dpy, 0);
      },
      keycode(keysym: number) {
        return Number(L.XKeysymToKeycode(dpy, keysym));
      },
      key(keysym: number) {
        const code = c.keycode(keysym);
        L.XTestFakeKeyEvent(dpy, code, 1, 0);
        L.XTestFakeKeyEvent(dpy, code, 0, 0);
        L.XSync(dpy, 0);
      },
      down(keysym: number) {
        const code = c.keycode(keysym);
        L.XTestFakeKeyEvent(dpy, code, 1, 0);
        L.XSync(dpy, 0);
        return code;
      },
      up(keysym: number) {
        const code = c.keycode(keysym);
        L.XTestFakeKeyEvent(dpy, code, 0, 0);
        L.XSync(dpy, 0);
      },
      type(text: string) {
        for (const ch of text) c.key(ch.codePointAt(0) ?? 0);
      },
      close() {
        if (!open) return;
        open = false;
        L.XCloseDisplay(dpy);
      },
    };
    clients.push(c);
    return c;
  }

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
  });

  it("holds the keyboard, keeps the letters typed, and gives it back on stop", async () => {
    const h = helper();
    const events: Event[] = [];
    const held = holdKeyboard({ display, maxMs: 1000, log: logger(events) });
    expect(held).not.toBeNull();
    expect(held!.holding()).toBe(true);
    const grabbed = events.filter(e => e.event === "keys.grab");
    expect(grabbed).toHaveLength(1);
    expect(grabbed[0].fields).toMatchObject({ status: "GrabSuccess", attempts: 1 });

    h.type("hi");
    await sleep(150); // the buffer drains every millisecond
    const typed = held!.stop();
    expect(typed).toEqual({ text: "hi", submit: false, cancel: false });
    expect(held!.holding()).toBe(false);
    // Stopping again returns the very same result and never throws.
    expect(held!.stop()).toBe(typed);
    // The grab is gone: another client can take the keyboard.
    expect(await until(() => h.grab() === 0)).toBe(true);
    h.ungrab();
  });

  it("honours modifiers held during the hold: Super+x and Ctrl+Space type nothing", async () => {
    const h = helper();
    const held = holdKeyboard({ display, maxMs: 1000 })!;
    expect(await until(() => held.holding())).toBe(true);

    h.type("a");
    // Xvfb's default modifier map puts Super_L on Mod4 and Control_L on Control (`xmodmap -pm`). If a
    // display has no Super_L keycode, skip only that part; Ctrl+Space still exercises the modifier state.
    if (h.keycode(SUPER_L) !== 0) {
      h.down(SUPER_L);
      h.type("x");
      h.up(SUPER_L);
    }
    if (h.keycode(CONTROL_L) !== 0) {
      h.down(CONTROL_L);
      h.key(SPACE);
      h.up(CONTROL_L);
    }
    h.type("b");
    await sleep(150);
    expect(held.stop()).toEqual({ text: "ab", submit: false, cancel: false });
  });

  it("sends on Return, closes on Escape, and Backspace removes a letter", async () => {
    const h = helper();

    const send = holdKeyboard({ display, maxMs: 1000 })!;
    expect(await until(() => send.holding())).toBe(true);
    h.type("hi");
    h.key(RETURN);
    await sleep(150);
    expect(send.stop()).toEqual({ text: "hi", submit: true, cancel: false });

    const erase = holdKeyboard({ display, maxMs: 1000 })!;
    expect(await until(() => erase.holding())).toBe(true);
    h.type("hi");
    h.key(BACKSPACE);
    await sleep(150);
    expect(erase.stop()).toEqual({ text: "h", submit: false, cancel: false });

    const close = holdKeyboard({ display, maxMs: 1000 })!;
    expect(await until(() => close.holding())).toBe(true);
    h.type("hi");
    h.key(ESCAPE);
    await sleep(150);
    expect(close.stop()).toEqual({ text: "hi", submit: false, cancel: true });
  });

  it("lets go by itself at the safety timeout", async () => {
    const h = helper();
    const held = holdKeyboard({ display, maxMs: 100 })!;
    expect(held.holding()).toBe(true);
    expect(await until(() => !held.holding(), 1000)).toBe(true);
    expect(await until(() => h.grab() === 0, 1000)).toBe(true);
    h.ungrab();
  });

  it("waits out another grab, logs its status once, and keeps only keys typed after it grabs", async () => {
    const h = helper();
    expect(h.grab()).toBe(0);
    const events: Event[] = [];
    const held = holdKeyboard({ display, maxMs: 1000, log: logger(events) })!;
    expect(held.holding()).toBe(false);

    // Typed while the helper still owns the keyboard: the buffer never sees these.
    h.type("before");
    await sleep(30);
    const statuses = events.filter(e => e.event === "keys.grab_status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0].fields).toMatchObject({ status: "AlreadyGrabbed", attempts: 1 });
    // Still the same status on every retry: no log per attempt.
    await sleep(30);
    expect(events.filter(e => e.event === "keys.grab_status")).toHaveLength(1);
    expect(held.holding()).toBe(false);

    // The other grab goes: Ember takes the keyboard for the rest of the hold.
    h.ungrab();
    expect(await until(() => held.holding(), 1000)).toBe(true);
    expect(events.some(e => e.event === "keys.grab")).toBe(true);
    h.type("hi");
    await sleep(150);
    expect(held.stop()).toEqual({ text: "hi", submit: false, cancel: false });
  });

  it("reports a grab it never got when it is stopped", async () => {
    const h = helper();
    expect(h.grab()).toBe(0);
    const events: Event[] = [];
    const held = holdKeyboard({ display, maxMs: 1000, log: logger(events) })!;
    expect(held.holding()).toBe(false);
    await sleep(40);
    const typed = held.stop();
    expect(typed).toEqual({ text: "", submit: false, cancel: false });
    expect(held.holding()).toBe(false);
    const failed = events.find(e => e.event === "keys.grab_failed");
    expect(failed).toBeDefined();
    expect(failed!.fields.status).toBe("AlreadyGrabbed");
    expect(Number(failed!.fields.attempts)).toBeGreaterThan(0);
    expect(events.some(e => e.event === "keys.grab")).toBe(false);
    h.ungrab();
  });

  it("reports a grab it never got when the safety timeout ends the hold", async () => {
    const h = helper();
    expect(h.grab()).toBe(0);
    const events: Event[] = [];
    const held = holdKeyboard({ display, maxMs: 100, log: logger(events) })!;
    expect(held.holding()).toBe(false);
    expect(await until(() => events.some(e => e.event === "keys.grab_failed"), 1000)).toBe(true);
    expect(held.holding()).toBe(false);
    expect(events.find(e => e.event === "keys.grab_failed")!.fields.status).toBe("AlreadyGrabbed");
    expect(events.some(e => e.event === "keys.grab")).toBe(false);
    h.ungrab();
  });
});
