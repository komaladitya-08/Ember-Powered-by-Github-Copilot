/** Built Home in Chromium: Sign out and Forget everything ask first, with live counts, and Esc or cancel call nothing. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";

declare global { interface Window { __calls: string[]; __counts: { tasks: number; facts: number; reminders: number; routines: number } } }

it.skipIf(process.env.EMBER_SIGNOUT_FORGET_TEST !== "1")("asks before Sign out and Forget everything, shows live counts, and cancels cleanly", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
  const browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const dist = path.resolve("dist");
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(seed => {
      window.__calls = []; window.__counts = { tasks: 3, facts: 4, reminders: 2, routines: 1 };
      const rows = () => Array.from({ length: window.__counts.facts }, (_, i) => ({ id: `f${i}`, text: `Fact ${i}`, source: "user", at: "2026-11-04" }));
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return () => () => undefined;
        if (name === "getStatus") return async () => seed.status;
        // The finished one is never counted, whatever the number asked for.
        if (name === "tasks") return async () => [...["running", "waiting", "queued"].slice(0, window.__counts.tasks).map((status, i) => ({ id: `t${i}`, status })), { id: "done", status: "done" }];
        if (name === "memory") return async () => ({ rows: rows(), ownership: "ready" });
        if (name === "reminders") return async () => Array.from({ length: window.__counts.reminders }, (_, i) => ({ id: `r${i}`, text: "x", at: 1, created: 1, kept: false }));
        if (name === "routines") return async () => Array.from({ length: window.__counts.routines }, (_, i) => ({ id: `n${i}`, name: "n", steps: [] }));
        if (name === "signOut") return async () => { window.__calls.push("signOut"); };
        if (name === "forgetAllMemory") return async () => { window.__calls.push("forgetAll"); };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => {
      document.body.classList.remove("loading", "first-run");
      (document.getElementById("sign-out") as HTMLElement).hidden = false;
      (document.getElementById("memory-forget-all") as HTMLElement).hidden = false;
    });
    await page.locator('a[href="#copilot-h"]').click();
    const calls = () => page.evaluate(() => window.__calls);
    const focusedId = () => page.evaluate(() => document.activeElement?.id);

    // Sign out: opens with live counts, Esc changes nothing, focus returns.
    await page.locator("#sign-out").click();
    await expect.poll(() => page.locator("#sign-out-confirm").isVisible()).toBe(true);
    expect(await page.locator("#sign-out-scope").innerText()).toBe("Sign out? This stops 3 tasks that are running or waiting, and clears this conversation, 4 saved facts, 2 reminders and 1 routine.");
    expect(await focusedId()).toBe("sign-out-no");
    await page.keyboard.press("Escape");
    expect(await page.locator("#sign-out-confirm").isHidden()).toBe(true);
    expect(await focusedId()).toBe("sign-out");
    expect(await calls()).toEqual([]);

    // Counts are read again on each open; Cancel button also changes nothing.
    await page.evaluate(() => { window.__counts = { tasks: 0, facts: 1, reminders: 0, routines: 0 }; });
    await page.locator("#sign-out").click();
    await expect.poll(() => page.locator("#sign-out-scope").innerText()).toContain("0 tasks");
    await page.locator("#sign-out-no").click();
    expect(await focusedId()).toBe("sign-out");
    expect(await calls()).toEqual([]);

    // Confirm runs the existing path.
    await page.locator("#sign-out").click();
    await page.locator("#sign-out-yes").click();
    expect(await page.locator("#sign-out-confirm").isHidden()).toBe(true);
    await expect.poll(calls).toEqual(["signOut"]);
    expect(await focusedId()).toBe("sign-out");

    // Forget everything.
    await page.locator('a[href="#memory-h"]').click();
    await page.evaluate(() => { window.__counts = { tasks: 2, facts: 4, reminders: 2, routines: 1 }; });
    await page.locator("#memory-forget-all").click();
    await expect.poll(() => page.locator("#forget-all-confirm").isVisible()).toBe(true);
    expect(await page.locator("#forget-all-scope").innerText()).toBe("Forget everything? This removes 4 saved facts and what Ember learned from them. 2 tasks, 2 reminders and 1 routine stay as they are.");
    await page.keyboard.press("Escape");
    expect(await focusedId()).toBe("memory-forget-all");
    expect(await calls()).toEqual(["signOut"]);
    await page.locator("#memory-forget-all").click();
    await page.locator("#forget-all-yes").click();
    await expect.poll(calls).toEqual(["signOut", "forgetAll"]);
    expect(await focusedId()).toBe("memory-forget-all");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}, 60_000);
