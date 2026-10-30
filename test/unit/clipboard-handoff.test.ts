/**
 * Handing Ember's clipboard to the clipboard manager, and reading the PRIMARY selection, on a private X server
 * (Xvfb; skipped off Linux and without Xvfb). A second X client of ours plays the other apps and the manager, so the
 * checks are against real selections: who owns CLIPBOARD/CLIPBOARD_MANAGER/PRIMARY, whether the owner is the same X
 * client as Ember's window, the freedesktop SAVE_TARGETS request, and the deadline when a request goes unanswered.
 * Never the user's $DISPLAY: the server is started with -displayfd and killed at the end.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { handClipboardToManager, readSelection } from "../../app/main/hands/clipboard-handoff";

const requireCjs = createRequire(import.meta.url);

const hasXvfb = (() => {
  if (process.platform !== "linux") return false;
  try {
    const r = spawnSync("Xvfb", ["-help"], { stdio: "ignore" });
    return !r.error;
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

function xlib() {
  const koffi = requireCjs("koffi") as typeof import("koffi");
  const lib = koffi.load("libX11.so.6");
  return {
    koffi,
    XOpenDisplay: lib.func("void *XOpenDisplay(const char *name)"),
    XCloseDisplay: lib.func("int XCloseDisplay(void *dpy)"),
    XDefaultRootWindow: lib.func("unsigned long XDefaultRootWindow(void *dpy)"),
    XCreateSimpleWindow: lib.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long borderPixel, unsigned long background)"),
    XInternAtom: lib.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)"),
    XSetSelectionOwner: lib.func("int XSetSelectionOwner(void *dpy, unsigned long selection, unsigned long owner, unsigned long time)"),
    XGetSelectionOwner: lib.func("unsigned long XGetSelectionOwner(void *dpy, unsigned long selection)"),
    XConvertSelection: lib.func("int XConvertSelection(void *dpy, unsigned long selection, unsigned long target, unsigned long property, unsigned long requestor, unsigned long time)"),
    XChangeProperty: lib.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long property, unsigned long type, int format, int mode, const uint8_t *data, int n)"),
    XGetWindowProperty: lib.func("int XGetWindowProperty(void *dpy, unsigned long w, unsigned long prop, long offset, long length, int del, unsigned long reqType, _Out_ unsigned long *actualType, _Out_ int *actualFormat, _Out_ unsigned long *nitems, _Out_ unsigned long *bytesAfter, _Out_ void **data)"),
    XFree: lib.func("int XFree(void *data)"),
    XPending: lib.func("int XPending(void *dpy)"),
    XNextEvent: lib.func("int XNextEvent(void *dpy, _Out_ uint8_t *event)"),
    XSendEvent: lib.func("int XSendEvent(void *dpy, unsigned long w, int propagate, long mask, uint8_t *event)"),
    XFlush: lib.func("int XFlush(void *dpy)"),
  };
}

/** libX11 through koffi can be missing or throw; put a fake koffi where the source's createRequire finds the real one. */
describe("when koffi can't use libX11", () => {
  const koffiPath = requireCjs.resolve("koffi");
  const real = requireCjs.cache[koffiPath];
  const swap = (exports: unknown) => {
    requireCjs.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports } as unknown as NodeModule;
  };
  afterEach(() => {
    if (real) requireCjs.cache[koffiPath] = real;
    else delete requireCjs.cache[koffiPath];
  });

  it("both functions fall back safely when libX11 can't be bound", async () => {
    swap({ load() { throw new Error("libX11.so.6 missing"); } });
    expect(await handClipboardToManager({ ourWindow: 1 })).toBe("unavailable");
    expect(await readSelection({ sameClientAs: 1 })).toBe("");
  });

  it("readSelection returns empty when an X call throws", async () => {
    const fns: Record<string, () => unknown> = {
      XOpenDisplay: () => ({}),
      XInternAtom: () => { throw new Error("X protocol error"); },
    };
    swap({
      load() {
        return {
          func(decl: string) {
            const name = /(\w+)\(/.exec(decl)?.[1] ?? "";
            return fns[name] ?? (() => 0);
          },
        };
      },
    });
    expect(await readSelection({ sameClientAs: 1 })).toBe("");
  });
});

type Request = { requestor: number; selection: number; target: number; property: number; time: bigint };
type Env = { dpy: unknown; win: number; atom(name: string): number };
type Serve = (req: Request, env: Env) => number | null;

describe.runIf(process.platform === "linux" && hasXvfb && hasXlib)("clipboard handoff on a private X server", () => {
  let x!: ReturnType<typeof xlib>;
  let server: ChildProcess | undefined;
  let display = "";
  const open: unknown[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  beforeAll(async () => {
    x = xlib();
    server = spawn("Xvfb", ["-displayfd", "3", "-noreset", "-screen", "0", "640x480x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      const failure = (why: string) => reject(new Error(`Xvfb didn't start: ${why}`));
      server!.once("error", err => failure(err.message));
      server!.once("exit", code => failure(`exit ${String(code)}`));
      server!.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
    });
    const probe = x.XOpenDisplay(display);
    if (!probe) throw new Error(`Xvfb didn't accept connections on ${display}`);
    x.XCloseDisplay(probe);
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>(resolve => {
      if (server!.exitCode !== null || server!.signalCode !== null) return resolve();
      const kill = setTimeout(() => server!.kill("SIGKILL"), 2000);
      server!.once("exit", () => { clearTimeout(kill); resolve(); });
      server!.kill("SIGTERM");
    });
  });

  afterEach(() => {
    for (const t of timers.splice(0)) clearInterval(t);
    // Nothing owned between tests: the selections of a closed client would otherwise linger for -noreset.
    for (const dpy of open.splice(0)) {
      for (const name of ["CLIPBOARD", "CLIPBOARD_MANAGER", "PRIMARY"]) x.XSetSelectionOwner(dpy, Number(x.XInternAtom(dpy, name, 0)), 0, 0);
      x.XFlush(dpy);
      x.XCloseDisplay(dpy);
    }
  });

  const write = (dpy: unknown, w: number, prop: number, type: number, format: number, data: Buffer) =>
    x.XChangeProperty(dpy, w, prop, type, format, 0, data, format === 32 ? data.length / 8 : data.length);

  const notify = (dpy: unknown, req: Request, property: number) => {
    const e = Buffer.alloc(192);
    e.writeInt32LE(31, 0); // SelectionNotify
    e.writeInt32LE(1, 16);
    e.writeBigUInt64LE(BigInt(req.requestor), 32);
    e.writeBigUInt64LE(BigInt(req.selection), 40);
    e.writeBigUInt64LE(BigInt(req.target), 48);
    e.writeBigUInt64LE(BigInt(property), 56);
    e.writeBigUInt64LE(req.time, 64);
    x.XSendEvent(dpy, req.requestor, 0, 0, e);
    x.XFlush(dpy);
  };

  const readProperty = (dpy: unknown, w: number, prop: number) => {
    const type = [0], format = [0], n = [0], after = [0], data: unknown[] = [null];
    x.XGetWindowProperty(dpy, w, prop, 0, 65536, 1, 0, type, format, n, after, data);
    const size = format[0] === 32 ? Number(n[0]) * 8 : Number(n[0]);
    const bytes = data[0] ? Buffer.from(x.koffi.decode(data[0], "uint8_t", size) as Uint8Array) : Buffer.alloc(0);
    if (data[0]) x.XFree(data[0]);
    return bytes;
  };

  /** A client of our own on the private server; `serve` answers the SelectionRequests sent to its window. */
  const client = (serve?: Serve) => {
    const dpy = x.XOpenDisplay(display);
    if (!dpy) throw new Error(`Can't open X display ${display}`);
    open.push(dpy);
    const win = Number(x.XCreateSimpleWindow(dpy, x.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0));
    const atom = (name: string) => Number(x.XInternAtom(dpy, name, 0));
    if (serve) {
      const ev = Buffer.alloc(192);
      timers.push(setInterval(() => {
        while (x.XPending(dpy) > 0) {
          x.XNextEvent(dpy, ev);
          if (ev.readInt32LE(0) !== 30) continue; // SelectionRequest
          const req: Request = {
            requestor: Number(ev.readBigUInt64LE(40)),
            selection: Number(ev.readBigUInt64LE(48)),
            target: Number(ev.readBigUInt64LE(56)),
            property: Number(ev.readBigUInt64LE(64)),
            time: ev.readBigUInt64LE(72),
          };
          const property = serve(req, { dpy, win, atom });
          if (property !== null) notify(dpy, req, property);
        }
      }, 5));
    }
    const own = (name: string) => { x.XSetSelectionOwner(dpy, atom(name), win, 0); x.XFlush(dpy); };
    return { dpy, win, atom, own };
  };

  /** The formats an answered TARGETS request offers, as a format-32 list. */
  const atomList = (atoms: number[]) => {
    const b = Buffer.alloc(atoms.length * 8);
    atoms.forEach((a, i) => b.writeBigUInt64LE(BigInt(a), i * 8));
    return b;
  };

  describe("handClipboardToManager", () => {
    it("is unavailable for a display that doesn't exist", async () => {
      expect(await handClipboardToManager({ ourWindow: 1, display: ":987654" })).toBe("unavailable");
    });

    it("finds no manager when nothing owns CLIPBOARD_MANAGER", async () => {
      const app = client();
      app.own("CLIPBOARD");
      expect(await handClipboardToManager({ ourWindow: app.win, display })).toBe("no-manager");
    });

    it("leaves a clipboard another client owns alone", async () => {
      const manager = client();
      manager.own("CLIPBOARD_MANAGER");
      const app = client();
      app.own("CLIPBOARD");
      expect(await handClipboardToManager({ ourWindow: manager.win, display })).toBe("not-ours");
    });

    it("leaves an empty clipboard alone", async () => {
      const manager = client();
      manager.own("CLIPBOARD_MANAGER");
      expect(await handClipboardToManager({ ourWindow: manager.win, display })).toBe("not-ours");
    });

    it("times out by its deadline when the owner never answers TARGETS", async () => {
      const owner = client();
      owner.own("CLIPBOARD_MANAGER");
      owner.own("CLIPBOARD");
      const t0 = Date.now();
      expect(await handClipboardToManager({ ourWindow: owner.win, timeoutMs: 150, display })).toBe("timeout");
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it("is refused when the owner refuses the TARGETS conversion", async () => {
      const owner = client(() => 0);
      owner.own("CLIPBOARD_MANAGER");
      owner.own("CLIPBOARD");
      expect(await handClipboardToManager({ ourWindow: owner.win, timeoutMs: 1000, display })).toBe("refused");
    });

    it("is refused when only meta formats are offered, without asking the manager", async () => {
      const seen: number[] = [];
      const owner = client((req, env) => {
        seen.push(req.target);
        if (req.target === env.atom("TARGETS")) {
          write(env.dpy, req.requestor, req.property, env.atom("ATOM"), 32, atomList([env.atom("TIMESTAMP")]));
          return req.property;
        }
        return 0;
      });
      owner.own("CLIPBOARD_MANAGER");
      owner.own("CLIPBOARD");
      expect(await handClipboardToManager({ ourWindow: owner.win, timeoutMs: 1000, display })).toBe("refused");
      expect(seen).not.toContain(owner.atom("SAVE_TARGETS"));
    });

    it("saves the non-meta formats with the manager", async () => {
      let saved: number[] = [];
      const app = client();
      const owner = client((req, env) => {
        if (req.target === env.atom("TARGETS")) {
          const list = [env.atom("TARGETS"), env.atom("UTF8_STRING"), env.atom("TIMESTAMP")];
          write(env.dpy, req.requestor, req.property, env.atom("ATOM"), 32, atomList(list));
          return req.property;
        }
        if (req.target === env.atom("SAVE_TARGETS")) {
          const b = readProperty(env.dpy, req.requestor, req.property);
          saved = Array.from({ length: b.length / 8 }, (_, i) => Number(b.readBigUInt64LE(i * 8)));
          return req.property;
        }
        return 0;
      });
      owner.own("CLIPBOARD_MANAGER");
      owner.own("CLIPBOARD");
      expect(await handClipboardToManager({ ourWindow: owner.win, timeoutMs: 1000, display })).toBe("saved");
      // TARGETS and TIMESTAMP are about the selection itself: only UTF8_STRING is handed over.
      expect(saved).toEqual([owner.atom("UTF8_STRING")]);
      expect(Number(x.XGetSelectionOwner(app.dpy, app.atom("CLIPBOARD_MANAGER")))).toBe(owner.win);
    });

    it("is refused when the manager refuses SAVE_TARGETS", async () => {
      const owner = client((req, env) => {
        if (req.target === env.atom("TARGETS")) {
          write(env.dpy, req.requestor, req.property, env.atom("ATOM"), 32, atomList([env.atom("UTF8_STRING")]));
          return req.property;
        }
        return 0; // SAVE_TARGETS answered with property None
      });
      owner.own("CLIPBOARD_MANAGER");
      owner.own("CLIPBOARD");
      expect(await handClipboardToManager({ ourWindow: owner.win, timeoutMs: 1000, display })).toBe("refused");
    });
  });

  describe("readSelection", () => {
    it("is empty for a display that doesn't exist", async () => {
      expect(await readSelection({ sameClientAs: 1, display: ":987654" })).toBe("");
    });

    it("is empty when nothing owns PRIMARY", async () => {
      const app = client();
      expect(await readSelection({ sameClientAs: app.win, timeoutMs: 150, display })).toBe("");
    });

    it("is empty when another client owns PRIMARY, without even asking the owner", async () => {
      const text = "the other app's selection";
      const requests: number[] = [];
      const owner = client((req, env) => {
        requests.push(req.selection);
        write(env.dpy, req.requestor, req.property, env.atom("UTF8_STRING"), 8, Buffer.from(text));
        return req.property;
      });
      owner.own("PRIMARY");
      const other = client();
      expect(await readSelection({ sameClientAs: other.win, timeoutMs: 150, display })).toBe("");
      // A willing owner that was never asked: the empty answer is the client check, not a timeout.
      expect(requests).toEqual([]);
      // Positive control: the same owner does answer its own client.
      expect(await readSelection({ sameClientAs: owner.win, timeoutMs: 1000, display })).toBe(text);
    });

    it("is empty when the window to compare with is 0, without even asking the owner", async () => {
      const text = "the owner would answer";
      const requests: number[] = [];
      const owner = client((req, env) => {
        requests.push(req.selection);
        write(env.dpy, req.requestor, req.property, env.atom("UTF8_STRING"), 8, Buffer.from(text));
        return req.property;
      });
      owner.own("PRIMARY");
      expect(await readSelection({ sameClientAs: 0, timeoutMs: 150, display })).toBe("");
      expect(requests).toEqual([]);
    });

    it("gives up by its deadline when the owner never answers", async () => {
      const owner = client();
      owner.own("PRIMARY");
      const t0 = Date.now();
      expect(await readSelection({ sameClientAs: owner.win, timeoutMs: 150, display })).toBe("");
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    it("is empty when the owner refuses the conversion", async () => {
      const owner = client(() => 0);
      owner.own("PRIMARY");
      expect(await readSelection({ sameClientAs: owner.win, timeoutMs: 1000, display })).toBe("");
    });

    it("is empty when the answer isn't 8-bit text", async () => {
      const owner = client((req, env) => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(42n);
        write(env.dpy, req.requestor, req.property, env.atom("CARDINAL"), 32, b);
        return req.property;
      });
      owner.own("PRIMARY");
      expect(await readSelection({ sameClientAs: owner.win, timeoutMs: 1000, display })).toBe("");
    });

    it("returns the owner's UTF-8 text, cut to max characters", async () => {
      const text = "the user's selection";
      const owner = client((req, env) => {
        write(env.dpy, req.requestor, req.property, env.atom("UTF8_STRING"), 8, Buffer.from(text));
        return req.property;
      });
      owner.own("PRIMARY");
      expect(await readSelection({ sameClientAs: owner.win, timeoutMs: 1000, display })).toBe(text);
      expect(await readSelection({ sameClientAs: owner.win, timeoutMs: 1000, max: 8, display })).toBe(text.slice(0, 8));
    });
  });
});
