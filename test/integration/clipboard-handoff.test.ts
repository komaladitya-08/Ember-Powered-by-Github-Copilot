/**
 * Handing the clipboard to a clipboard manager when Ember quits (review round 5), on a private X server (Xvfb; skipped
 * without it, and never on the user's own display, whose clipboard and clipboard manager it would take): a pretend
 * Electron owns the clipboard and a pretend manager follows the freedesktop protocol (it reads
 * every format from the owner, then owns the clipboard itself). Nothing is asked of a clipboard that isn't Ember's or
 * when there is no manager, and a manager that doesn't answer costs at most the deadline.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { handClipboardToManager } from "../../app/main/hands/clipboard-handoff";

const requireCjs = createRequire(import.meta.url);
const xvfb = spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status === 0;

function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const x = koffi.load("libX11.so.6");
  return {
    koffi,
    XOpenDisplay: x.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: x.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateSimpleWindow: x.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int b, unsigned long bp, unsigned long bg)"),
    XInternAtom: x.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XSetSelectionOwner: x.func("int XSetSelectionOwner(void *dpy, unsigned long sel, unsigned long w, unsigned long time)"),
    XGetSelectionOwner: x.func("unsigned long XGetSelectionOwner(void *dpy, unsigned long sel)"),
    XConvertSelection: x.func("int XConvertSelection(void *dpy, unsigned long sel, unsigned long target, unsigned long prop, unsigned long w, unsigned long time)"),
    XChangeProperty: x.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XGetWindowProperty: x.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long off, long len, int del, unsigned long req, _Out_ unsigned long *type, _Out_ int *format, _Out_ unsigned long *n, _Out_ unsigned long *after, _Out_ void **data)"),
    XSendEvent: x.func("int XSendEvent(void *dpy, unsigned long w, int propagate, long mask, uint8_t *event)"),
    XPending: x.func("int XPending(void *dpy)"),
    XNextEvent: x.func("int XNextEvent(void *dpy, _Out_ uint8_t *event)"),
    XFlush: x.func("int XFlush(void *dpy)"),
    XFree: x.func("int XFree(void *data)"),
  };
}

describe.skipIf(!xvfb)("the clipboard goes to the clipboard manager when Ember quits", () => {
  const x = xlib();
  const open: unknown[] = [];
  let server: ChildProcess;
  let display = "";
  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "640x480x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
  });
  afterAll(() => { server?.kill(); });
  const timers: ReturnType<typeof setInterval>[] = [];
  afterEach(() => {
    for (const t of timers.splice(0)) clearInterval(t);
    for (const d of open.splice(0)) x.XCloseDisplay(d);
  });

  /** A client on its own connection that answers selection requests with `serve` (property 0: refused). */
  const client = (serve: (req: { requestor: number; selection: number; target: number; property: number; time: bigint }, c: { dpy: unknown; win: number }) => number | null, onNotify?: (property: number, target: number) => void) => {
    const dpy = x.XOpenDisplay(display);
    open.push(dpy);
    const win = Number(x.XCreateSimpleWindow(dpy, x.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0));
    const ev = Buffer.alloc(192);
    const notify = (req: { requestor: number; selection: number; target: number; time: bigint }, property: number) => {
      const n = Buffer.alloc(192);
      n.writeInt32LE(31, 0); n.writeInt32LE(1, 16);
      n.writeBigUInt64LE(BigInt(req.requestor), 32); n.writeBigUInt64LE(BigInt(req.selection), 40); n.writeBigUInt64LE(BigInt(req.target), 48);
      n.writeBigUInt64LE(BigInt(property), 56); n.writeBigUInt64LE(req.time, 64);
      x.XSendEvent(dpy, req.requestor, 0, 0, n); x.XFlush(dpy);
    };
    const pending: { req: { requestor: number; selection: number; target: number; time: bigint }; property: number }[] = [];
    timers.push(setInterval(() => {
      while (x.XPending(dpy) > 0) {
        x.XNextEvent(dpy, ev);
        const type = ev.readInt32LE(0);
        if (type === 30) {
          const req = { requestor: Number(ev.readBigUInt64LE(40)), selection: Number(ev.readBigUInt64LE(48)), target: Number(ev.readBigUInt64LE(56)), property: Number(ev.readBigUInt64LE(64)), time: ev.readBigUInt64LE(72) };
          const p = serve(req, { dpy, win });
          if (p !== null) notify(req, p); else pending.push({ req, property: req.property });
        } else if (type === 31) onNotify?.(Number(ev.readBigUInt64LE(56)), Number(ev.readBigUInt64LE(48)));
      }
    }, 5));
    const atom = (n: string) => Number(x.XInternAtom(dpy, n, 0));
    return { dpy, win, atom, pending, notify };
  };
  const atoms = (n: number, b: Buffer) => Array.from({ length: n }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
  const prop = (dpy: unknown, win: number, p: number) => {
    const type = [0], format = [0], n = [0], after = [0], data: unknown[] = [null];
    x.XGetWindowProperty(dpy, win, p, 0, 65536, 1, 0, type, format, n, after, data);
    const size = format[0] === 32 ? Number(n[0]) * 8 : Number(n[0]);
    const b = data[0] ? Buffer.from(x.koffi.decode(data[0], "uint8_t", size) as Uint8Array) : Buffer.alloc(0);
    if (data[0]) x.XFree(data[0]);
    return { b, n: Number(n[0]), format: format[0] };
  };

  /** Electron with the user's text on the clipboard. */
  const electron = () => {
    const e = client((req, c) => {
      const TARGETS = e.atom("TARGETS"), UTF8 = e.atom("UTF8_STRING");
      if (req.target === TARGETS) {
        const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(TARGETS), 0); b.writeBigUInt64LE(BigInt(UTF8), 8);
        x.XChangeProperty(c.dpy, req.requestor, req.property, 4, 32, 0, b, 2);
        return req.property;
      }
      if (req.target === UTF8) { const b = Buffer.from("the user's copy"); x.XChangeProperty(c.dpy, req.requestor, req.property, UTF8, 8, 0, b, b.length); return req.property; }
      return 0;
    });
    x.XSetSelectionOwner(e.dpy, e.atom("CLIPBOARD"), e.win, 0); x.XFlush(e.dpy);
    return e;
  };

  /** A clipboard manager; `answers: false` never replies to SAVE_TARGETS. */
  const manager = (answers = true) => {
    const saved = new Map<number, string>();
    let job: { req: { requestor: number; selection: number; target: number; time: bigint }; property: number; queue: number[]; current: number } | null = null;
    const next = () => {
      if (!job) return;
      if (!job.queue.length) {
        x.XSetSelectionOwner(m.dpy, m.atom("CLIPBOARD"), m.win, 0); x.XFlush(m.dpy);
        m.notify(job.req, job.property);
        job = null;
        return;
      }
      job.current = job.queue.shift()!;
      x.XConvertSelection(m.dpy, m.atom("CLIPBOARD"), job.current, m.atom("SAVED"), m.win, 0); x.XFlush(m.dpy);
    };
    const m = client((req, c) => {
      if (req.target !== m.atom("SAVE_TARGETS")) return 0;
      if (!answers) return null;
      const list = prop(c.dpy, req.requestor, req.property);
      job = { req, property: req.property, queue: atoms(list.n, list.b), current: 0 };
      next();
      return null;
    }, property => {
      if (job && property) saved.set(job.current, prop(m.dpy, m.win, m.atom("SAVED")).b.toString());
      next();
    });
    x.XSetSelectionOwner(m.dpy, m.atom("CLIPBOARD_MANAGER"), m.win, 0); x.XFlush(m.dpy);
    return { ...m, saved };
  };

  it("the manager takes every format from Ember's process and keeps the clipboard", async () => {
    const e = electron();
    const m = manager();
    expect(await handClipboardToManager({ ourWindow: e.win + 4, display })).toBe("saved");
    expect([...m.saved.entries()]).toEqual([[e.atom("UTF8_STRING"), "the user's copy"]]);
    expect(Number(x.XGetSelectionOwner(m.dpy, m.atom("CLIPBOARD")))).toBe(m.win);
  });

  it("asks nothing of a clipboard another app holds, or with no manager; waits no longer than its deadline", async () => {
    const e = electron();
    const m = manager(false);
    expect(await handClipboardToManager({ ourWindow: m.win, display })).toBe("not-ours");
    expect(m.pending).toEqual([]);
    const t0 = Date.now();
    expect(await handClipboardToManager({ ourWindow: e.win, timeoutMs: 300, display })).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
    x.XSetSelectionOwner(m.dpy, m.atom("CLIPBOARD_MANAGER"), 0, 0); x.XFlush(m.dpy);
    await new Promise(r => setTimeout(r, 50));
    expect(await handClipboardToManager({ ourWindow: e.win, display })).toBe("no-manager");
  });
});
