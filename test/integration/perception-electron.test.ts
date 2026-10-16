/**
 * Reads Electron windows (Chromium's accessibility) through the real sidecar and
 * X11: a decorated window is found inside its window manager's frame, a page at
 * scale 2 keeps the physical pixels Chromium reports, and secret fields (other
 * languages, a label above the field, a password revealed before Ember looked)
 * are withheld, refused and blacked out, also where a read cut short never reached them, and a field deep in a
 * page's layers or a fixed panel after a long list is read like any other. Needs an X11 display with an
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
import { AtspiSidecar, pickPython, type AxNode } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { openX11, type X11 } from "../../app/main/x11";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
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
// Hundreds of links before the card fields: a read stops at its node limit before reaching them.
const CHECKOUT_PAGE = `<!doctype html><title>Ember test: Checkout</title><body style="margin:0;padding:4px;font:9px sans-serif">
${Array.from({ length: 6 }, (_, d) => `<div>${Array.from({ length: 80 }, (_, i) => `<a href="#${d}-${i}">L${d}.${i}</a>`).join(" ")}</div>`).join("")}
<div style="font:16px sans-serif">Card number<br><input style="font:16px monospace;width:300px;color:#00b000" value="4111 1111 1111 1111"></div>
<div style="font:16px sans-serif">Security code <input style="font:16px monospace;width:80px;color:#00b000" value="737"></div></body>`;
// A card field 40 layers of <div>s down, and a fixed "Pay now" panel after 250 paragraphs: both on screen.
const DEEP_PAGE = `<!doctype html><title>Ember test: Deep</title><body style="margin:0;padding:4px;font:13px sans-serif">
${'<div role="group" aria-label="layer">'.repeat(40)}Card number <input style="font:16px monospace;width:260px;color:#00b000" value="4111 1111 1111 1111">${"</div>".repeat(40)}
${Array.from({ length: 250 }, (_, i) => `<p style="margin:2px">Item ${i}</p>`).join("")}
<div style="position:fixed;right:10px;top:50px;width:330px;background:#eef;padding:8px">Pay now<br>
Card number <input style="font:16px monospace;width:220px;color:#00b000" value="5500 0000 0000 0004"><br><button>Pay</button></div></body>`;
// A form as in an Electron app (review round 6): Chromium names a check box's, radio button's and switch's action
// "check" or "uncheck", and keeps a <select>'s options (and their Selection) on a child menu. What the page hears
// shows in its last paragraph.
const FORM_PAGE = `<!doctype html><title>Ember test: Form</title><body style="font:14px sans-serif">
<div><label>Description <input id=desc></label></div>
<div><label>Category <select id=cat><option>Travel</option><option>Meals</option><option>Office</option></select></label></div>
<div><label><input type=checkbox id=urgent> Urgent</label> <label><input type=radio name=pay id=cash checked> Cash</label>
<label><input type=radio name=pay id=card> Card</label> <button role=switch aria-checked=false id=sw>Notify</button></div>
<p id=out>nothing yet</p>
<script>
const show = () => { out.textContent = "cat=" + cat.value + " urgent=" + urgent.checked + " pay=" + (card.checked ? "card" : "cash") + " notify=" + sw.getAttribute("aria-checked"); };
cat.onchange = urgent.onchange = cash.onchange = card.onchange = show;
sw.onclick = () => { sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true"); show(); };
</script></body>`;
const MAIN = `
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("force-renderer-accessibility");
app.whenReady().then(() => {
  const [title, html, frame] = [process.env.EMBER_TEST_TITLE, process.env.EMBER_TEST_HTML, process.env.EMBER_TEST_FRAME === "1"];
  const big = process.env.EMBER_TEST_BIG === "1";
  const w = new BrowserWindow({ width: big ? 700 : 500, height: big ? 420 : 360, x: big ? 580 : 40, y: 40, title, frame });
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
  const appear = async (n: number) => {
    for (let i = 0; i < 100 && Object.keys(pids).length < n; i++) {
      const { windows } = await sidecar.listWindows().catch(() => ({ windows: [] }));
      for (const w of windows) if (w.name.startsWith("Ember test: ") && w.pid != null) pids[w.name.slice(12)] = w.pid;
      await new Promise(r => setTimeout(r, 200));
    }
  };

  const start = (title: string, html: string, frame: boolean, scale: number, big = false) => {
    // Chromium joins the accessibility bus only when asked: by the desktop's accessibility setting, which a bare
    // X server (CI's dbus-run-session + xvfb-run) doesn't have, or by ACCESSIBILITY_ENABLED.
    const child = spawn(electron, ["--no-sandbox", `--force-device-scale-factor=${scale}`, dir], {
      stdio: "ignore", env: { ...process.env, ACCESSIBILITY_ENABLED: "1", EMBER_TEST_TITLE: title, EMBER_TEST_HTML: html, EMBER_TEST_FRAME: frame ? "1" : "0", EMBER_TEST_BIG: big ? "1" : "0" },
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
    await appear(2);
    // Last, so it opens on top of the scale-2 window (which covers most of the screen).
    start("Ember test: Checkout", CHECKOUT_PAGE, true, 1, true);
    await appear(3);
    if (Object.keys(pids).length < 3) throw new Error("the Electron test windows never appeared on the accessibility bus");
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

  it("blacks out secret fields a cut-short read never reached", async () => {
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: pids.Checkout } });
    expect(p.truncated).toBe("nodes");
    expect(p.nodes.some(n => n.role === "entry")).toBe(false);
    expect(p.capture, p.text).not.toBeNull();
    expect(p.text).not.toContain("covered by other windows");
    // The card number and the code are written in green: none of it may be left in the picture.
    const { data, info } = await sharp(p.capture!.data).raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i + 1] > 140 && data[i] < 90 && data[i + 2] < 90) green++;
    expect(green).toBeLessThan(5);
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

  it("reads and blacks out what shows deep in a page's layers, or out of order after a long list", async () => {
    // Last, on top of the other windows (their tests are done).
    start("Ember test: Deep", DEEP_PAGE, true, 1);
    await appear(4);
    if (!pids.Deep) throw new Error("the deep page never appeared on the accessibility bus");
    let p = await perception.perceive({ image: true, scope: "window", target: { pid: pids.Deep } });
    for (let i = 0; i < 20 && p.nodes.filter(n => n.role === "entry").length < 2; i++) {
      await new Promise(r => setTimeout(r, 250)); // the page is still being handed over
      p = await perception.perceive({ image: true, scope: "window", target: { pid: pids.Deep } });
    }
    expect(p.truncated, p.text).toBeNull();
    const entries = p.nodes.filter(n => n.role === "entry");
    expect(entries.map(n => n.secret)).toEqual([true, true]);
    expect(Math.max(...entries.map(n => n.depth))).toBeGreaterThan(40);
    expect(p.nodes.some(n => n.role === "push button" && n.name === "Pay")).toBe(true);
    for (const leak of ["4111", "5500"]) expect(p.text).not.toContain(leak);
    expect(p.capture, p.text).not.toBeNull();
    const { data, info } = await sharp(p.capture!.data).raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i + 1] > 140 && data[i] < 90 && data[i + 2] < 90) green++;
    expect(green).toBeLessThan(5);
    // Deeper than a read goes: the read says what it left out.
    const shallow = await sidecar.readWindow({ pid: pids.Deep, maxDepth: 20 });
    expect([shallow.truncated, shallow.cut]).toEqual([true, ["depth"]]);
  }, 40_000);

  it("fills in a web form by accessibility: check boxes, radio buttons, switches and drop-downs; text only with the mouse, asked once (review round 6)", async () => {
    start("Ember test: Form", FORM_PAGE, true, 1);
    await appear(Object.keys(pids).length + 1);
    if (!pids.Form) throw new Error("the form never appeared on the accessibility bus");
    let nodes: AxNode[] = [];
    for (let i = 0; i < 20 && !nodes.some(n => n.role === "combo box"); i++) {
      nodes = (await sidecar.readWindow({ pid: pids.Form })).nodes;
      await new Promise(r => setTimeout(r, 250)); // the page is still being handed over
    }
    const find = (role: RegExp, name: string) => nodes.find(n => role.test(n.role) && n.name === name)!;
    const urgent = find(/^check box$/, "Urgent");
    expect(urgent.actions?.map(a => a.toLowerCase())).toContain("check");
    // Each by Chromium's own action, never the mouse; and back off with "uncheck", not "check" once more.
    for (const n of [urgent, find(/^radio button$/, "Card"), find(/^(toggle button|switch)$/, "Notify")]) {
      const r = await sidecar.doAction(n.id, "toggle");
      expect(r.after?.states, n.name).toContain("checked");
    }
    const off = await sidecar.doAction(urgent.id, "toggle");
    expect([off.action, off.after?.states.includes("checked")]).toEqual(["uncheck", false]);

    // The worker's own tools, on the real page: the drop-down is chosen by accessibility; the description can only
    // be typed with the mouse and keyboard, so that is the one question.
    const asked: string[] = [];
    const answers = ["once", "deny"];
    const worker = new Worker({
      client: {} as never, log: quiet, model: "m", vision: false, workDir: dir,
      perception, sidecar, policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
      confirmer: { ask: async (q: { prompt: string }) => { asked.push(q.prompt); return answers.shift() ?? "deny"; } },
      audit: { write: () => undefined }, settings: { get: () => ({ grants: {} }), update: () => undefined },
      presenter: new Presenter(() => undefined),
      lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
      cursor: { borrow: {}, findWindow: () => 1, setBorrowing: () => undefined },
    } as unknown as WorkerDeps, { id: "f1", goal: "Fill in the expense report: Meals, train to Lyon", target: { title: "Ember test: Form", pid: pids.Form } });
    const call = (name: string, args: Record<string, unknown>) =>
      worker.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
    const screen = (await call("perceive_window", {})).textResultForLlm;
    const id = (re: RegExp) => Number(/\[(\d+)\]/.exec(screen.split("\n").find(l => re.test(l)) ?? "")?.[1]);
    const chose = await call("choose_option", { id: id(/\] combo box "Category"/), option: "Meals" });
    expect(chose.textResultForLlm).toMatch(/^Done\. Now: combo box "Category".*selected="Meals"/);
    expect(asked).toEqual([expect.stringMatching(/^Let me work in .*First step: choose “Meals” in “Category” combo box/)]);
    const typed = await call("type_text", { id: id(/\] entry "Description"/), text: "Train to Lyon", mode: "replace" });
    expect(typed.resultType).toBe("denied");
    expect(asked.slice(1)).toEqual([expect.stringMatching(/^Borrow your mouse and keyboard to type “Train to Lyon” into “Description” entry/)]);
    await worker.dispose();

    // What the page itself heard.
    let said = "";
    for (let i = 0; i < 20 && !said.includes("cat=Meals"); i++) {
      const { nodes: now } = await sidecar.readWindow({ pid: pids.Form });
      said = now.map(n => `${n.name} ${n.text ?? ""}`).find(s => s.includes("cat=")) ?? "";
      if (!said.includes("cat=Meals")) await new Promise(r => setTimeout(r, 200));
    }
    expect(said).toContain("cat=Meals urgent=false pay=card notify=true");
  }, 40_000);
});
