/** Real Electron/Chromium checks for the production approval renderer and captured button gestures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";

it.skipIf(process.env.EMBER_APPROVAL_TEST !== "1")("reads and focuses an exact approval, and cancels captured drags before release", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-approval-live-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
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
  } finally { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 90_000);

it.skipIf(process.env.EMBER_APPROVAL_TEST !== "1")("keeps a refusal visible when its card is pulled before the reply, and clears it for a replacement", async () => {
  const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-approval-notice-"));
  const requireCjs = createRequire(import.meta.url);
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const main = path.join(dir, "main.cjs");
    // The reply to a press waits until the test releases it, so the card can be pulled or replaced first.
    const source = `
      import { app, BrowserWindow, ipcMain } from "electron";
      import { createPromptWindowController } from "./app/main/remote/prompt-window";
      const quiet = { info(){}, debug(){}, warn(){}, error(){}, child(){return this;} };
      let ctl, release;
      const card = n => ({ title: 'Question ' + n, prompt: 'Send it?', kind: 'approval', id: 'approval-' + n, n, options: [{id:'once',label:'Allow',primary:true},{id:'deny',label:'Not now'}] });
      app.whenReady().then(() => {
        ctl = createPromptWindowController({ os: "linux", log: quiet, ipc: ipcMain, create() {
          const w = new BrowserWindow({ width: 520, height: 600, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: ${JSON.stringify(path.join(root, "dist/app/preload/prompt.cjs"))} } });
          w.loadFile(${JSON.stringify(path.join(root, "dist/app/renderer/prompt/index.html"))}); return w;
        }});
        ctl.onApproval(() => new Promise(r => { release = () => r("gone"); }));
        globalThis.__p = { show: n => ctl.showApproval(card(n)), hide: n => ctl.hideApproval(n), release: () => release() };
        globalThis.__p.show(1);
      });`;
    await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [main, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
    const page = await app.firstWindow();
    const p = (fn: "show" | "hide" | "release", n?: number) => app!.evaluate((_e, a) => (globalThis as unknown as { __p: Record<string, (n?: number) => void> }).__p[a.fn](a.n), { fn, n });
    const notice = page.locator("#notice");
    const press = async () => { await page.getByRole("button", { name: "Not now", exact: true }).click({ timeout: 3000 }); };

    // Pulled before the reply: the refusal is still there to read, though the card is gone.
    await page.locator("#title").waitFor({ state: "visible" });
    await press();
    await p("hide", 1);
    await expect.poll(() => page.locator("#card").isVisible()).toBe(false);
    await p("release");
    await expect.poll(() => notice.evaluate(el => (el as HTMLElement).checkVisibility())).toBe(true);
    expect(await notice.innerText()).not.toBe("");

    // Replaced before the reply: the old question's refusal doesn't land under the new one.
    await p("show", 2);
    await expect.poll(() => page.locator("#title").innerText()).toBe("Question 2");
    expect(await notice.evaluate(el => (el as HTMLElement).hidden)).toBe(true);
    await press();
    await p("show", 3);
    await expect.poll(() => page.locator("#title").innerText()).toBe("Question 3");
    await p("release");
    await page.waitForTimeout(150);
    expect(await notice.evaluate(el => (el as HTMLElement).hidden)).toBe(true);

    // Reply first, then replaced: it clears, as before.
    await press();
    await p("release");
    await expect.poll(() => notice.evaluate(el => (el as HTMLElement).hidden)).toBe(false);
    await p("show", 4);
    await expect.poll(() => page.locator("#title").innerText()).toBe("Question 4");
    expect(await notice.evaluate(el => (el as HTMLElement).hidden)).toBe(true);
  } finally {
    // The prompt window keeps the app alive (it hides rather than closes), so end the process outright.
    await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
