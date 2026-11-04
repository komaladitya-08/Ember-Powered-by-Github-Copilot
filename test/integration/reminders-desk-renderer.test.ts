/** Real DOM checks for reminder recovery and inert desk text; native accessibility remains a separate acceptance run. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

describe.skipIf(process.env.EMBER_UIUX_TEST !== "1")("reminder and desk renderers (UX12/14)", () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: 'import { mountReminders } from "./app/renderer/home/reminders"; mountReminders(window.ember);', resolveDir: process.cwd() }, bundle: true, platform: "browser", write: false });
    const home = fs.readFileSync("dist/app/renderer/home/index.html", "utf8").replace('class="loading"', 'class=""').replace('src="main.js"', 'src="reminders-only.js"');
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost").pathname;
      if (url.endsWith("reminders-only.js")) { res.setHeader("Content-Type", "application/javascript"); res.end(bundle.outputFiles[0].text); return; }
      if (url === "/renderer/home/index.html") { res.setHeader("Content-Type", "text/html"); res.end(home); return; }
      const target = path.resolve("dist/app", `.${url}`);
      if (!target.startsWith(path.resolve("dist/app") + path.sep) || !fs.existsSync(target)) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", url.endsWith(".js") ? "application/javascript" : url.endsWith(".css") ? "text/css" : url.endsWith(".html") ? "text/html" : "application/octet-stream");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

  it("retains an authored edit through background updates and failed saves, and confirms bulk scope", async () => {
    const page = await browser.newPage({ viewport: { width: 560, height: 800 } });
    await page.addInitScript(() => {
      const w = window as unknown as { ember: unknown; reminderPush: (r: unknown[]) => void; reminderFail: boolean; reminderBulk: number; reminderHold: boolean; releaseReminder(): void };
      let rows = [{ id: "a", text: "Call Priya", at: Date.now() + 120_000, created: Date.now(), kept: false }];
      w.reminderFail = true; w.reminderBulk = 0; w.reminderHold = false; w.releaseReminder = () => undefined;
      w.ember = {
        reminders: async () => rows,
        onReminders: (fn: (r: typeof rows) => void) => { w.reminderPush = next => { rows = next as typeof rows; fn(rows); }; },
        changeReminder: async (change: { expected: { id: string }; replacement: { text: string; at: number } | null }) => {
          if (w.reminderHold) await new Promise<void>(resolve => { w.releaseReminder = resolve; });
          if (w.reminderFail) throw new Error("simulated persistence failure");
          rows = rows.flatMap(r => r.id === change.expected.id ? change.replacement ? [{ ...r, ...change.replacement }] : [] : [r]);
          w.reminderPush(rows);
        },
        forgetAllRoutines: async () => { if (w.reminderFail) throw new Error("simulated persistence failure"); w.reminderBulk++; rows = []; w.reminderPush(rows); },
      };
    });
    await page.goto(`${origin}/renderer/home/index.html`);
    const originalAt = await page.evaluate(async () => (await (window as unknown as { ember: { reminders(): Promise<{ at: number }[]> } }).ember.reminders())[0].at);
    await page.getByRole("button", { name: "Edit reminder: Call Priya", exact: true }).click();
    const input = page.locator("#reminders-list input[type=text]:visible");
    await input.fill("My corrected reminder");
    await page.evaluate(() => { document.documentElement.dataset.textSize = "larger"; });
    for (const selector of ["#conversation-search", "#reminders-list input[type=text]:visible", "#reminders-list input[type=datetime-local]:visible"]) {
      const size = await page.locator(selector).evaluate(e => ({ height: e.getBoundingClientRect().height, font: parseFloat(getComputedStyle(e).fontSize) }));
      expect(size.height).toBeGreaterThanOrEqual(36); expect(size.font).toBeGreaterThanOrEqual(18);
    }
    await page.evaluate(() => {
      const w = window as unknown as { ember: { reminders(): Promise<unknown[]> }; reminderPush(r: unknown[]): void };
      void w.ember.reminders().then(rows => w.reminderPush([...rows, { id: "b", text: "Stand up", at: Date.now() + 180_000, created: Date.now(), kept: true }]));
    });
    expect(await input.inputValue()).toBe("My corrected reminder");
    expect(await input.evaluate(e => document.activeElement === e)).toBe(true);
    await page.getByRole("button", { name: "Save reminder", exact: true }).click();
    await expect.poll(() => page.locator("#routines-message").innerText()).toContain("Couldn't change");
    expect(await input.inputValue()).toBe("My corrected reminder");
    expect(await page.getByRole("button", { name: "Save reminder", exact: true }).evaluate(e => document.activeElement === e)).toBe(true);
    await page.evaluate(() => { (window as unknown as { reminderFail: boolean }).reminderFail = false; });
    await page.getByRole("button", { name: "Save reminder", exact: true }).click();
    await expect.poll(() => page.locator("#routines-message").innerText()).toBe("Reminder updated.");
    expect(await page.evaluate(async () => (await (window as unknown as { ember: { reminders(): Promise<{ at: number }[]> } }).ember.reminders())[0].at)).toBe(originalAt);
    await page.getByRole("button", { name: "Edit reminder: My corrected reminder", exact: true }).click();
    await input.fill("My final reminder");
    await page.evaluate(() => { (window as unknown as { reminderHold: boolean }).reminderHold = true; });
    await page.getByRole("button", { name: "Save reminder", exact: true }).click();
    await page.locator("#reminders-refresh").focus();
    await page.evaluate(() => (window as unknown as { releaseReminder(): void }).releaseReminder());
    await expect.poll(() => page.locator("#reminders-list [aria-disabled=true]").count()).toBe(0);
    expect(await page.locator("#reminders-refresh").evaluate(e => document.activeElement === e)).toBe(true);
    await page.locator("#routines-forget-all").click();
    expect(await page.locator("#routines-delete-scope").innerText()).toContain("2 waiting reminders");
    expect(await page.evaluate(() => (window as unknown as { reminderBulk: number }).reminderBulk)).toBe(0);
    await page.locator("#routines-delete-no").click();
    expect(await page.locator("#reminders-list li").count()).toBe(2);
    await page.locator("#routines-forget-all").click();
    await page.evaluate(() => { (window as unknown as { reminderFail: boolean }).reminderFail = true; });
    await page.locator("#routines-delete-yes").click();
    await expect.poll(() => page.locator("#routines-message").innerText()).toContain("Couldn't delete");
    expect(await page.locator("#routines-delete-yes").evaluate(e => document.activeElement === e)).toBe(true);
    await page.evaluate(() => { (window as unknown as { reminderFail: boolean }).reminderFail = false; });
    await page.locator("#routines-delete-yes").click();
    await expect.poll(() => page.locator("#routines-message").innerText()).toBe("All routines and waiting reminders deleted.");
    expect(await page.locator("#reminders-list").innerText()).toBe("No reminders waiting.");
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  }, 60_000);

  it("ignores old initial and manual snapshots after newer pushes and account erasure", async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { ember: unknown; reminderResolve(rows: unknown[]): void; reminderPush(rows: unknown[]): void; reminderReset(): void };
      w.ember = {
        reminders: () => new Promise(resolve => { w.reminderResolve = resolve; }),
        onReminders: (fn: (rows: unknown[]) => void) => { w.reminderPush = fn; },
        onConversationForgotten: (fn: () => void) => { w.reminderReset = fn; },
      };
    });
    await page.goto(`${origin}/renderer/home/index.html`);
    await page.evaluate(async () => {
      const w = window as unknown as { reminderReset(): void; reminderResolve(rows: unknown[]): void };
      w.reminderReset(); w.reminderResolve([{ id: "old", text: "Previous account private reminder", at: Date.now() + 120_000, created: Date.now(), kept: true }]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(await page.locator("#reminders-list").innerText()).toBe("No reminders waiting.");
    await page.locator("#reminders-refresh").click();
    await page.evaluate(async () => {
      const w = window as unknown as { reminderPush(rows: unknown[]): void; reminderResolve(rows: unknown[]): void };
      w.reminderPush([]); w.reminderResolve([{ id: "stale", text: "Already cancelled reminder", at: Date.now() + 120_000, created: Date.now(), kept: false }]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(await page.locator("#reminders-list").innerText()).toBe("No reminders waiting.");
    await page.close();
  }, 60_000);

  it("shows actual named desk contents as text without executing app markup or taking over", async () => {
    const page = await browser.newPage({ viewport: { width: 560, height: 500 } });
    await page.addInitScript(() => {
      const w = window as unknown as { emberDesk: unknown; tookOver: number };
      w.tookOver = 0;
      w.emberDesk = { onFrame: () => undefined, onMode: () => undefined, takeOver: () => { w.tookOver++; }, handBack: () => undefined,
        hide: () => undefined, input: () => undefined, release: () => undefined,
        describe: async () => ({ at: Date.now(), title: "Draft document", message: "Read-only snapshot.", rows: [{ role: "button", name: "Save", text: "focused" }, { role: "text", name: "Document", text: "<img src=x onerror=alert(1)>" }] }) };
    });
    await page.goto(`${origin}/renderer/desk/index.html`);
    await page.locator("#desk-reading summary").click(); await page.locator("#read-refresh").click();
    await expect.poll(() => page.locator("#read-title").innerText()).toBe("Draft document");
    expect(await page.locator("#read-contents").innerText()).toContain("button: Save");
    expect(await page.locator("#read-contents").innerText()).toContain("<img src=x onerror=alert(1)>");
    expect(await page.locator("#read-contents img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { tookOver: number }).tookOver)).toBe(0);
    await page.locator("#read-contents").focus();
    expect(await page.locator("#read-contents").evaluate(e => document.activeElement === e)).toBe(true);
    await page.close();
  }, 60_000);
});
