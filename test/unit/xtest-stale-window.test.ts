/**
 * openXInput (hands/input.ts) makes X calls on other apps' windows — clients()
 * reads _NET_WM_NAME/_NET_WM_PID of every window in _NET_CLIENT_LIST, and
 * findWindow is called on titles the app has just closed — but it never installs
 * an X error handler (x11.ts and xshape.ts do, via ignoreXErrors()). In Ember's
 * main process Xlib's default error handler exits the whole process on the first
 * BadWindow: an app that quits while its window id is still in _NET_CLIENT_LIST
 * ends Ember on the next findWindow.
 *
 * Repro: a private Xvfb, a window created and destroyed, and _NET_CLIENT_LIST
 * still naming it (what the server-side list looks like for a moment after an
 * app quits). findWindow must answer 0, not end the process.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { openXInput, type XInput } from "../../app/main/hands/input";

const requireCjs = createRequire(import.meta.url);

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

describe.runIf(X_READY)("openXInput survives a stale window in _NET_CLIENT_LIST", () => {
  let server: ChildProcess | undefined;
  let display = "";
  let xi: XInput | null = null;

  beforeAll(async () => {
    server = spawn("Xvfb", ["-displayfd", "3", "-noreset", "-nolisten", "tcp", "-screen", "0", "800x600x24"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    display = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Xvfb did not report a display")), 5000);
      server!.stdio[3]!.on("data", (d: Buffer) => {
        clearTimeout(timer);
        resolve(`:${d.toString().trim()}`);
      });
    });
    xi = openXInput(display);
  }, 10_000);

  afterAll(() => {
    xi?.close();
    server?.kill();
  });

  it("reads the stale id as gone instead of letting Xlib end the process", () => {
    expect(xi).toBeTruthy();
    const koffi = requireCjs("koffi") as typeof import("koffi");
    const x = koffi.load("libX11.so.6");
    const dpy = x.func("void *XOpenDisplay(const char *name)")(display);
    try {
      const root = Number(x.func("unsigned long XDefaultRootWindow(void *dpy)")(dpy));
      const destroy = x.func("int XDestroyWindow(void *dpy, unsigned long w)");
      const atom = (n: string) => x.func("unsigned long XInternAtom(void *dpy, const char *name, int onlyIfExists)")(dpy, n, 0);
      const XSync = x.func("int XSync(void *dpy, int discard)");
      // An app that just quit: its window is gone, the client list still names it.
      const gone = Number(x.func("unsigned long XCreateSimpleWindow(void *dpy, unsigned long parent, int x, int y, unsigned int w, unsigned int h, unsigned int border, unsigned long border_pixel, unsigned long background)")(dpy, root, 0, 0, 20, 20, 0, 0, 0));
      destroy(dpy, gone);
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(BigInt(gone));
      x.func("int XChangeProperty(void *dpy, unsigned long w, unsigned long prop, unsigned long type, int format, int mode, const void *data, int n)")(dpy, root, atom("_NET_CLIENT_LIST"), atom("WINDOW"), 32, 0, data, 1);
      XSync(dpy, 0);

      // Before the fix: reading the stale id's properties is a BadWindow, and
      // Xlib's default error handler exits the process before this answers.
      expect(xi!.findWindow("gone")).toBe(0);
      // And the connection still works afterwards.
      expect(xi!.pointerState()).toBeTruthy();
    } finally {
      x.func("int XCloseDisplay(void *dpy)")(dpy);
    }
  });
});
