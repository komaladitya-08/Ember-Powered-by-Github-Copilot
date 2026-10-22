/**
 * A stand-in for Ember's overlay in a real Electron, for the Ember-level suites (test/integration/ember-win32.test.ts):
 * one transparent, click-through, always-on-top window made with the overlay's own options (overlay.ts create(), the
 * platform's hoverShaper row, "screen-saver" level, the "Ember overlay" title), painting a solid red block where the
 * test asks, and going transparent for a capture exactly as OverlayManager.hideForCapture does (opacity 0, then 60 ms
 * for the compositor). The real overlay loads Ember's renderer; the window and the hiding are what a capture sees.
 * The child prints "READY {pid, hwnd}" and answers "hide" with "HIDDEN" and "show" with "SHOWN", one line each.
 * Not a test file: it has no tests of its own.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { buildSync } from "esbuild";
import { electronBinary } from "./vocabulary-clipboard";

const CHILD = `
import { app, BrowserWindow } from "electron";
import readline from "node:readline";
import { applyAllWorkspaces, hoverShaper } from "./app/main/platform/compose";

const [x, y, width, height] = process.argv.slice(-4).map(Number);
const shaper = hoverShaper(process.platform === "darwin" ? "darwin" : "win32");
app.whenReady().then(async () => {
  const floating = shaper.floating("overlay");
  const win = new BrowserWindow({
    x, y, width, height, transparent: true, frame: false, backgroundColor: "#00000000", hasShadow: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, type: "toolbar", title: "Ember overlay", ...floating.options,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  applyAllWorkspaces(win, floating.allWorkspaces);
  win.setIgnoreMouseEvents(true, shaper.forward ? { forward: true } : undefined);
  const page = '<!doctype html><title>Ember overlay</title><body style="margin:0;background:transparent">'
    + '<div style="position:fixed;inset:0;background:#ff0000"></div></body>';
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page));
  win.showInactive();
  win.setBounds({ x, y, width, height });
  // Two frames for the compositor to show it.
  await new Promise(r => setTimeout(r, 300));
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
  process.stdout.write("READY " + JSON.stringify({ pid: process.pid, hwnd }) + "\\n");
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", async line => {
    if (line === "hide") {
      win.setOpacity(0);
      await new Promise(r => setTimeout(r, 60));
      process.stdout.write("HIDDEN\\n");
    } else if (line === "show") {
      win.setOpacity(1);
      process.stdout.write("SHOWN\\n");
    } else if (line === "quit") {
      app.exit(0);
    }
  });
  lines.on("close", () => app.exit(0));
});
`;

/** The running stand-in. */
export interface OverlayChild {
  pid: number;
  hwnd: number;
  /** Goes transparent as Ember does for a capture; resolves once it has, with the function that shows it again. */
  hide(): Promise<() => Promise<void>>;
  close(): void;
}

/** Builds the stand-in into .cache/test under `root` and shows it over `rect` (physical pixels at 100 %, DIP otherwise). */
export async function startOverlayChild(root: string, rect: { x: number; y: number; width: number; height: number }): Promise<OverlayChild> {
  const dir = path.join(root, ".cache", "test", "overlay-child-electron");
  fs.mkdirSync(dir, { recursive: true });
  buildSync({
    stdin: { contents: CHILD, loader: "ts", resolveDir: root, sourcefile: "overlay-child.ts" },
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], outfile: path.join(dir, "main.cjs"), logLevel: "silent",
  });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ember-overlay-child-test", main: "main.cjs" }));
  const electron = electronBinary();
  if (!fs.existsSync(electron)) throw new Error(`no Electron binary at ${electron} (npx install-electron)`);
  // ELECTRON_RUN_AS_NODE from the caller would start a plain Node instead of the app.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child: ChildProcess = spawn(electron, [dir, String(rect.x), String(rect.y), String(rect.width), String(rect.height)], { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr!.on("data", d => { stderr += d; });
  const lines = readline.createInterface({ input: child.stdout! });
  const waiting: { want: string; resolve: (line: string) => void }[] = [];
  lines.on("line", line => {
    const i = waiting.findIndex(w => line.startsWith(w.want));
    if (i >= 0) waiting.splice(i, 1)[0].resolve(line);
  });
  const next = (want: string, ms: number) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the overlay stand-in didn't say ${want} within ${ms} ms\n${stderr}`)), ms);
    waiting.push({ want, resolve: line => { clearTimeout(timer); resolve(line); } });
  });
  const exited = new Promise<never>((_, reject) => child.on("exit", code => reject(new Error(`the overlay stand-in exited (${String(code)})\n${stderr}`))));
  exited.catch(() => undefined);
  const ready = JSON.parse((await Promise.race([next("READY ", 60_000), exited])).slice("READY ".length)) as { pid: number; hwnd: number };
  const send = (line: string) => { child.stdin!.write(`${line}\n`); };
  return {
    pid: ready.pid,
    hwnd: ready.hwnd,
    async hide() {
      const hidden = next("HIDDEN", 5_000);
      send("hide");
      await hidden;
      return async () => {
        const shown = next("SHOWN", 5_000);
        send("show");
        await shown;
      };
    },
    close() {
      if (child.exitCode === null) {
        send("quit");
        setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2_000).unref();
      }
    },
  };
}
