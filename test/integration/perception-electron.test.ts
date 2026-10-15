/**
 * Reads Electron windows (Chromium's accessibility) through the real sidecar and
 * X11: a decorated window is found inside its window manager's frame, a page at
 * scale 2 keeps the physical pixels Chromium reports, and secret fields (other
 * languages, a label above the field, a password revealed before Ember looked)
 * are withheld, refused and blacked out. Needs an X11 display with an
 * accessibility bus and a Python with pyatspi; skipped otherwise
 * (EMBER_ATSPI_TEST=1 requires them).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { AtspiSidecar, pickPython } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { openX11, type X11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const python = pickPython();
const available = !!process.env.DISPLAY && spawnSync(python, ["-c", "import pyatspi, gi"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const electron = createRequire(import.meta.url)("electron") as unknown as string;

const SECRETS_PAGE = `<!doctype html><title>Ember test: Secrets</title><body style="font:13px sans-serif">
<div><label for=pw2>Key</label> <input id=pw2 type=password value="revealedBeforeRead"> <button>Reveal</button></div>
<div>Card number<br><input value="4000123412341234"></div>
<div><span>Wachtwoord</span> <input aria-label="Wachtwoord" value="LEAK-nl"></div>
<div><span>Пароль</span> <input aria-label="Пароль" value="LEAK-ru"></div>
<div><span>Security answer</span> <input aria-label="Security answer" value="LEAK-answer"></div>
<div><label>Name <input value="Alice"></label></div>
<script>setTimeout(() => { pw2.type = "text"; }, 300);</script></body>`;
const LIST_PAGE = `<!doctype html><title>Ember test: List</title><body style="margin:0;font:13px sans-serif">
<ul aria-label="Rows">${Array.from({ length: 20 }, (_, i) => `<li>Row ${i}</li>`).join("")}</ul></body>`;
const MAIN = `
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(() => {
  const [title, html, frame] = [process.env.EMBER_TEST_TITLE, process.env.EMBER_TEST_HTML, process.env.EMBER_TEST_FRAME === "1"];
  const w = new BrowserWindow({ width: 500, height: 360, x: 40, y: 40, title, frame });
  w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  w.on("page-title-updated", e => e.preventDefault());
});
`;

describe.skipIf(!available && !required)("Electron windows through the real sidecar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-electron-test-"));
  const apps: ChildProcess[] = [];
  let sidecar: AtspiSidecar;
  let x11: X11;
  let perception: Perception;
  const pids: Record<string, number> = {};

  const start = (title: string, html: string, frame: boolean, scale: number) => {
    const child = spawn(electron, ["--no-sandbox", `--force-device-scale-factor=${scale}`, dir], {
      stdio: "ignore", env: { ...process.env, EMBER_TEST_TITLE: title, EMBER_TEST_HTML: html, EMBER_TEST_FRAME: frame ? "1" : "0" },
    });
    apps.push(child);
  };

  beforeAll(async () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ember-electron-test", main: "main.js" }));
    fs.writeFileSync(path.join(dir, "main.js"), MAIN);
    start("Ember test: Secrets", SECRETS_PAGE, true, 1);
    start("Ember test: List", LIST_PAGE, false, 2);
    x11 = openX11()!;
    sidecar = new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python);
    perception = new Perception({ sidecar, x11, log: quiet, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 4000, height: 4000 }) });
    for (let i = 0; i < 100 && Object.keys(pids).length < 2; i++) {
      const { windows } = await sidecar.listWindows().catch(() => ({ windows: [] }));
      for (const w of windows) if (w.name.startsWith("Ember test: ") && w.pid != null) pids[w.name.slice(12)] = w.pid;
      await new Promise(r => setTimeout(r, 200));
    }
    if (Object.keys(pids).length < 2) throw new Error("the Electron test windows never appeared on the accessibility bus");
    // The page's password field is revealed shortly after it loads.
    await new Promise(r => setTimeout(r, 1000));
  }, 40_000);

  afterAll(() => {
    sidecar?.stop();
    x11?.close();
    for (const a of apps) a.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a scale-2 page in the physical pixels Chromium reports", async () => {
    const raw = await sidecar.readWindow({ pid: pids.List });
    const seen = await perception.read({ pid: pids.List });
    expect(seen.axScale).toBe(2);
    const row = (nodes: typeof raw.nodes) => nodes.find(n => n.name === "Row 3" && n.bounds)?.bounds;
    expect(row(seen.nodes)).toEqual(row(raw.nodes));
    // The frame itself is logical, so it is scaled: it is the X11 window.
    const w = x11.stack().find(s => s.pid === pids.List)!;
    expect(seen.window?.bounds).toMatchObject({ width: w.inner.width, height: w.inner.height });
  });

  it("finds a decorated window inside its frame, withholds secrets and blacks them out", async () => {
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: pids.Secrets } });
    expect(p.capture, p.text).not.toBeNull();
    for (const leak of ["revealedBeforeRead", "4000123412341234", "LEAK-"]) expect(p.text).not.toContain(leak);
    expect(p.text).toContain('text="Alice"');
    const secret = p.nodes.filter(n => n.secret && n.bounds);
    expect(secret.length).toBeGreaterThanOrEqual(5);
    const { data, info } = await sharp(p.capture!.data).raw().toBuffer({ resolveWithObject: true });
    const c = p.capture!;
    for (const n of secret) {
      const x = Math.round((n.bounds!.x + n.bounds!.width / 2 - c.rect.x) * c.scale), y = Math.round((n.bounds!.y + n.bounds!.height / 2 - c.rect.y) * c.scale);
      expect(data[(y * info.width + x) * info.channels], n.name).toBeLessThan(30);
    }
    // The revealed password is refused for typing, also by a helper started afresh.
    const key = p.nodes.find(n => n.role === "entry" && n.name === "Key")!;
    await expect(sidecar.setText(key.id, "x")).rejects.toThrow(/password/);
    sidecar.stop();
    const again = await sidecar.readWindow({ pid: pids.Secrets });
    const fresh = again.nodes.find(n => n.role === "entry" && n.name === "Key")!;
    expect(fresh.secret).toBe(true);
    await expect(sidecar.setText(fresh.id, "x")).rejects.toThrow(/password/);
  });
});
