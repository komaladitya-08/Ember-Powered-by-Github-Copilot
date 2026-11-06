/** Real Electron/Chromium checks for the production approval renderer and captured button gestures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";

type Launched = Awaited<ReturnType<typeof _electron.launch>>;

/**
 * Ends a launched Electron app and waits for its process to be gone, so a later file in the same X session (action-link's
 * keystrokes into a GTK dialog, #183) never meets a window left mapped. Plain `app.close()` and `app.exit(0)` both return
 * while the process, and the prompt window it showed, lives on (measured: still running 20 s later), so the windows are
 * destroyed first, then the app exits; the real "exit" event is awaited, and a process that ignores that is killed.
 * Returns how it ended, so a test can insist on the graceful way.
 */
async function endApp(app: Launched | undefined): Promise<"gone" | "exited" | "killed"> {
  if (!app) return "gone";
  const proc = app.process();
  if (proc.exitCode !== null || proc.signalCode !== null) return "gone";
  const exited = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  await app.evaluate(({ app: a, BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(w => w.destroy()); a.exit(0); }).catch(() => undefined); // the connection may drop as it exits
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<"stuck">(resolve => { timer = setTimeout(() => resolve("stuck"), 10_000); });
  const how = await Promise.race([exited.then(() => "exited" as const), stuck]);
  clearTimeout(timer);
  if (how === "exited") return "exited";
  proc.kill("SIGKILL");
  await exited;
  return "killed";
}

it.skipIf(process.env.EMBER_APPROVAL_TEST !== "1")("reads and focuses an exact approval, and cancels captured drags before release", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-approval-live-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Launched | undefined, ended: Awaited<ReturnType<typeof endApp>> | undefined;
  try {
    const main = path.join(dir, "main.cjs"), gesture = path.join(dir, "gesture.js");
    await build({ entryPoints: [path.join(root, "packages/bubble/src/bubble.ts")], outfile: gesture, bundle: true, platform: "browser", format: "iife", globalName: "EmberGesture" });
    const source = `
      import { app, BrowserWindow, ipcMain } from "electron";
      import { createPromptWindowController } from "./app/main/remote/prompt-window";
      import { Confirmer } from "./app/main/agent/confirm";
      const results = [], quiet = { info(){}, debug(){}, warn(){}, error(){}, child(){return this;} };
      let ctl, current;
      const c = new Confirmer(() => {}, { armMs: 500, onChange(q) { if (!q && current) ctl.hideApproval(current.n); current = q; } });
      app.whenReady().then(() => {
        ctl = createPromptWindowController({ os: "linux", log: quiet, ipc: ipcMain, create() {
          const w = new BrowserWindow({ width: 520, height: 600, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: ${JSON.stringify(path.join(root, "dist/app/preload/prompt.cjs"))} } });
          w.loadFile(${JSON.stringify(path.join(root, "dist/app/renderer/prompt/index.html"))}); return w;
        }});
        ctl.onApproval((n, answer) => { if (answer === undefined) { c.wholeSeen(n); return true; } return c.answer('q' + n + ':' + answer, 'bubble'); });
        const q = { title: 'May I?', prompt: 'Send this exact message?', detail: Array.from({length:160}, (_,i) => 'Line ' + i + ': review this exact message.').join('\\n'), options:[{id:'once',label:'Allow',primary:true},{id:'deny',label:'Not now'}] };
        c.ask(q).then(a => results.push(a));
        ctl.showApproval({ ...q, kind:'approval', id:'approval-' + current.n, n:current.n });
        globalThis.__approval = { results, gesture: async () => {
          const w = new BrowserWindow({ width: 700, height: 500, webPreferences: { sandbox:true } });
          await w.loadURL('data:text/html,<html><body><button id="choice" style="position:fixed;left:40px;top:40px;width:120px;height:44px">Allow</button></body></html>');
        } };
      });`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [main, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
    const page = await app.firstWindow();
    await page.locator("#title").waitFor({ state: "visible" });
    expect(await page.locator("#title").innerText()).toBe("May I?");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("title");
    const allow = page.getByRole("button", { name: "Allow", exact: true });
    expect(await allow.isDisabled()).toBe(true);
    expect(await page.locator("#body").innerText()).toContain("Line 159: review this exact message.");
    await page.locator("#body").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => allow.isDisabled()).toBe(false);
    await page.waitForTimeout(550); // Confirmer rearms after the last text entered view.
    await allow.click();
    const answers = () => app!.evaluate(() => (globalThis as unknown as { __approval: { results: string[] } }).__approval.results);
    await expect.poll(answers).toEqual(["once"]);
    await app.evaluate(async () => { await (globalThis as unknown as { __approval: { gesture(): Promise<void> } }).__approval.gesture(); });
    const buttons = app.windows().find(p => p.url().startsWith("data:"))!;
    await buttons.addScriptTag({ path: gesture });
    await buttons.evaluate(() => {
      const state = window as unknown as { count: number; EmberGesture: { onPress(b: HTMLElement, fn: () => void): void } };
      state.count = 0;
      state.EmberGesture.onPress(document.getElementById("choice")!, () => { state.count++; });
    });
    const count = () => buttons.evaluate(() => (window as unknown as { count: number }).count);
    await buttons.mouse.move(70, 60); await buttons.mouse.down();
    expect(await count()).toBe(0);
    await buttons.mouse.move(300, 200); await buttons.mouse.up();
    expect(await count()).toBe(0);
    await buttons.mouse.move(70, 60); await buttons.mouse.down();
    await buttons.mouse.move(300, 200); await buttons.mouse.move(70, 60); await buttons.mouse.up();
    expect(await count()).toBe(1);
    await buttons.locator("#choice").evaluate(el => el.setAttribute("aria-expanded", "false"));
    await buttons.mouse.down();
    await buttons.locator("#choice").evaluate(el => el.setAttribute("aria-expanded", "false"));
    await buttons.mouse.up();
    expect(await count()).toBe(2); // unchanged progress repaint does not lose the release
    await buttons.mouse.down();
    await buttons.locator("#choice").evaluate(el => { (el as HTMLElement).hidden = true; (el as HTMLElement).hidden = false; });
    await buttons.mouse.up();
    expect(await count()).toBe(2);
    await buttons.locator("#choice").focus(); await buttons.keyboard.press("Space");
    expect(await count()).toBe(3);
    await buttons.screenshot({ path: path.join(dir, "gesture.png") });
    ended = await endApp(app);
    app = undefined;
  } finally {
    if (app) await endApp(app); // a failed run: still end it, but the assertion below is for a passing one
    fs.rmSync(dir, { recursive: true, force: true });
  }
  expect(ended).toBe("exited"); // no Electron left mapped for the next file in this X session (#183)
}, 90_000);

it.skipIf(process.env.EMBER_APPROVAL_TEST !== "1")("keeps a refused press visible, with its window shown, whether the card is pulled or replaced before or after the reply", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-approval-notice-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Launched | undefined, ended: Awaited<ReturnType<typeof endApp>> | undefined;
  try {
    const main = path.join(dir, "main.cjs");
    // The real ipc handler for a press is wrapped so its reply (decided "gone" at press time) is held until the test
    // releases it: the card can then be pulled or replaced before the page hears back, as it can when main is slow.
    const source = `
      import { app, BrowserWindow, ipcMain } from "electron";
      import { createPromptWindowController } from "./app/main/remote/prompt-window";
      const quiet = { info(){}, debug(){}, warn(){}, error(){}, child(){return this;} };
      let ctl, release, win;
      const card = n => ({ title: 'Question ' + n, prompt: 'Send it?', kind: 'approval', id: 'approval-' + n, n, options: [{id:'once',label:'Allow',primary:true},{id:'deny',label:'Not now'}] });
      const ipc = { on: (c, f) => ipcMain.on(c, f), handle: (c, f) => ipcMain.handle(c, async (e, raw) => {
        const r = f(e, raw);
        if (c === 'prompt:approval' && globalThis.__hold) await new Promise(res => { release = res; });
        return r;
      }) };
      app.whenReady().then(() => {
        ctl = createPromptWindowController({ os: "linux", log: quiet, ipc, create() {
          win = new BrowserWindow({ width: 520, height: 600, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: ${JSON.stringify(path.join(root, "dist/app/preload/prompt.cjs"))} } });
          win.loadFile(${JSON.stringify(path.join(root, "dist/app/renderer/prompt/index.html"))}); return win;
        }});
        ctl.onApproval(() => false);
        globalThis.__p = { show: n => ctl.showApproval(card(n)), hide: n => ctl.hideApproval(n), hold: on => { globalThis.__hold = on; }, release: () => release(), visible: () => win.isVisible() };
        globalThis.__p.show(1);
      });`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [main, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
    const page = await app.firstWindow();
    const p = (fn: "show" | "hide" | "hold" | "release", n?: number | boolean) => app!.evaluate((_e, a) => (globalThis as unknown as { __p: Record<string, (n?: unknown) => unknown> }).__p[a.fn](a.n), { fn, n });
    const winVisible = () => app!.evaluate(() => (globalThis as unknown as { __p: { visible(): boolean } }).__p.visible());
    const notice = page.locator("#notice");
    const noticeShown = () => notice.evaluate(el => (el as HTMLElement).checkVisibility());
    const press = async () => { await page.getByRole("button", { name: "Not now", exact: true }).click({ timeout: 3000 }); };
    const title = () => page.locator("#title").innerText();
    const showHeld = async (n: number) => { await p("show", n); await expect.poll(() => page.locator("#card").isVisible()).toBe(true); await expect.poll(title).toBe("Question " + n); };
    await page.locator("#title").waitFor({ state: "visible" });

    // 1. Pulled before the reply: the card goes, the window hides, then the reply's refusal brings it back to be read.
    await p("hold", true);
    await press();
    await p("hide", 1);
    await expect.poll(() => page.locator("#card").isVisible()).toBe(false);
    await expect.poll(winVisible).toBe(false);
    await p("release");
    await expect.poll(noticeShown).toBe(true);
    await expect.poll(winVisible).toBe(true);
    expect(await notice.innerText()).toContain("earlier question");

    // 2. Replaced before the reply: the old press's refusal is worded as the earlier question's, under the new one.
    await showHeld(2);
    await press();
    await p("show", 3);
    await expect.poll(title).toBe("Question 3");
    await p("release");
    await expect.poll(noticeShown).toBe(true);
    expect(await notice.innerText()).toContain("earlier question");
    expect(await winVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Allow", exact: true }).isVisible()).toBe(true); // the new question is still answerable

    // 3. Reply first, then the card is pulled: the notice stays and the window stays up.
    await p("hold", false);
    await p("hide", 3); await p("hide", 2); // 2 was replaced, not answered: it is still queued behind 3
    await showHeld(4);
    await press(); // answered "gone" at once
    await expect.poll(noticeShown).toBe(true);
    expect(await notice.innerText()).not.toContain("earlier question"); // its own question is still the one shown
    await p("hide", 4);
    await expect.poll(() => page.locator("#card").isVisible()).toBe(false);
    await expect.poll(noticeShown).toBe(true);
    await expect.poll(winVisible).toBe(true);

    // 4. Reply first, then replaced: it is said of the question that has gone, not clean.
    await showHeld(5);
    await press();
    await expect.poll(noticeShown).toBe(true);
    await p("show", 6);
    await expect.poll(title).toBe("Question 6");
    expect(await notice.innerText()).toContain("earlier question");
    expect(await winVisible()).toBe(true);
    ended = await endApp(app);
    app = undefined;
  } finally {
    if (app) await endApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  expect(ended).toBe("exited");
}, 90_000);
