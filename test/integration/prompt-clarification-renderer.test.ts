/** The built prompt page, with only its preload bridge replaced. No model or network is used. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";

declare global {
  interface Window {
    __clarificationAnswer: unknown;
    __clarificationShow: (card: unknown) => void;
  }
}

const gate = process.env.EMBER_UIUX_TEST !== "1";
let browser: Browser;
let server: http.Server;
let port: number;
beforeAll(async () => {
  if (gate) return;
  browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const dist = path.resolve("dist");
  server = http.createServer((req, res) => {
    const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { if (!gate) { await browser.close(); server.close(); } });

it.skipIf(gate)("shows the question and returns only the user's chosen or typed answer", async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    let show: (card: unknown) => void = () => undefined;
    window.__clarificationAnswer = null;
    window.__clarificationShow = card => show(card);
    (window as unknown as { emberPrompt: unknown }).emberPrompt = {
      pull: async () => null, onShow: (fn: (card: unknown) => void) => { show = fn; },
      answer: (answer: unknown) => { window.__clarificationAnswer = answer; }, cancel: (id: string) => { window.__clarificationAnswer = { id, cancelled: true }; },
      notice: () => undefined, approval: async () => ({ ok: false }),
    };
  });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/prompt/index.html`);
  await page.evaluate(() => window.__clarificationShow({ id: "q1", kind: "clarification", question: "Which branch?", choices: ["main", "release"], allowFreeform: true }));
  await expect.poll(() => page.locator("#title").innerText()).toBe("Ember needs an answer");
  expect(await page.locator("#body").innerText()).toContain("Your answer goes to the connected model");
  await page.getByRole("button", { name: "release" }).click();
  expect(await page.evaluate(() => window.__clarificationAnswer)).toEqual({ id: "q1", ok: true, value: "release", choice: 1 });
  await page.evaluate(() => { window.__clarificationAnswer = null; window.__clarificationShow({ id: "q2", kind: "clarification", question: "Which folder?", allowFreeform: true }); });
  await page.locator("#field").fill("workspace");
  await page.locator("#field").press("Enter");
  expect(await page.evaluate(() => window.__clarificationAnswer)).toEqual({ id: "q2", ok: true, value: "workspace" });
  expect(await page.locator("#field").inputValue()).toBe("");
  await page.evaluate(() => { window.__clarificationAnswer = null; window.__clarificationShow({ id: "q3", kind: "clarification", question: "Continue?", choices: ["yes", "no"], allowFreeform: false }); });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__clarificationAnswer)).toEqual({ id: "q3", cancelled: true });
  await page.close();
});
