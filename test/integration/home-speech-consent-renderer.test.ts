/** Built Home in Chromium: "I agree, start listening" fetches the speech models only after consent is saved (audit FE #20). */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";

declare global { interface Window { __calls: string[]; __saves: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[]; __provider: unknown; __providerChanged: () => void; __emit: (n: string, v: unknown) => void } }

it.skipIf(process.env.EMBER_SPEECH_CONSENT_TEST !== "1")("starts no speech download until the consent save has succeeded, and stays retryable when it fails", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  const admin = { source: null, error: null, managed: [], features: {}, provider: null as string | null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin };
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
      window.__calls = []; window.__saves = [];
      const subs: Record<string, ((v: unknown) => void)[]> = {};
      const changed: (() => void)[] = [];
      window.__providerChanged = () => changed.forEach(f => f());
      window.__emit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
      window.__provider = { allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: null, agreed: false };
      (window as unknown as { emberProvider: unknown }).emberProvider = { state: async () => window.__provider, onChanged: (fn: () => void) => { changed.push(fn); return () => undefined; } };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
        if (name === "getStatus") return async () => seed.status;
        // The models are missing, so Agree also offers to fetch them.
        if (name === "voiceStatus") return async () => ({ state: "off", detail: null, modelsReady: false, modelsMissing: ["vad"], modelsBytes: 1_000_000 });
        if (name === "updateSettings") return (patch: unknown) => new Promise((resolve, reject) => { window.__calls.push(`save:${JSON.stringify(patch)}`); window.__saves.push({ resolve, reject }); });
        if (name === "downloadVoice") return async () => { window.__calls.push("download"); };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    await page.evaluate(() => { const b = document.getElementById("voice-download") as HTMLButtonElement; b.hidden = false; });
    const calls = (prefix: string) => page.evaluate(p => window.__calls.filter(c => c.startsWith(p)).length, prefix);
    const open = async () => { await page.locator('a[href="#voice-h"]').click(); await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click()); await expect.poll(() => page.locator("#consent").isVisible()).toBe(true); };
    const settle = (i: number, how: "ok" | "reject") => page.evaluate(([i, how]) => { const s = window.__saves[i as number]; if (how === "ok") s.resolve({}); else s.reject(new Error("Error invoking remote method 'ember:update-settings': Error: Ember couldn't save your settings: the disk is full.")); }, [i, how] as const);
    const error = () => page.locator("#consent-error");

    await open();
    // (1) Pending: one save, no download, note still up. A double-click adds nothing (4).
    await page.locator("#consent-yes").click();
    await page.locator("#consent-yes").click({ force: true });
    await page.locator("#consent-yes").dispatchEvent("click");
    await expect.poll(() => calls("save:")).toBe(1);
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isVisible()).toBe(true);
    // A refused write: still no download, a visible line, Agree ready again, nothing claiming consent.
    await settle(0, "reject");
    
    await expect.poll(() => error().isVisible()).toBe(true);
    expect(await error().innerText()).toContain("couldn't save");
    expect(await page.locator("#voice-live").innerText()).toContain("couldn't save");
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isVisible()).toBe(true);
    expect(await page.locator("#consent-yes").getAttribute("aria-busy")).toBeNull();
    expect(await page.locator("#consent-yes").isEnabled()).toBe(true);
    expect(await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).checked)).toBe(false);
    // (3) Retry: one more save, which succeeds: exactly one download, note closed.
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(2);
    expect(await error().isHidden()).toBe(true);
    expect(await calls("download")).toBe(0);
    await settle(1, "ok");
    await expect.poll(() => calls("download")).toBe(1);
    await expect.poll(() => page.locator("#consent").isHidden()).toBe(true);
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(1);

    // (5) Not now while the save is pending: the download never starts.
    await page.evaluate(() => { window.__calls = []; window.__saves = []; });
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await page.locator("#consent-no").click();
    await settle(0, "ok");
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isHidden()).toBe(true);
    // And one that failed after Not now says nothing.
    await open();
    await page.locator("#consent-yes").click();
    await page.locator("#consent-no").click();
    await settle(1, "reject");
    await page.waitForTimeout(150);
    expect(await error().isHidden()).toBe(true);

    // (6) Recipient unknown (main's answer never read): Agree still waits, with no save.
    expect(errors).toEqual([]);
    const unknown = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await unknown.addInitScript(seed => {
      window.__calls = [];
      (window as unknown as { emberProvider: unknown }).emberProvider = { state: () => new Promise(() => undefined), onChanged: () => () => undefined };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return () => () => undefined;
        if (name === "getStatus") return async () => seed.status;
        if (name === "updateSettings") return async (patch: unknown) => { window.__calls.push(`save:${JSON.stringify(patch)}`); return {}; };
        if (name === "downloadVoice") return async () => { window.__calls.push("download"); };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    await unknown.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await unknown.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    await unknown.locator('a[href="#voice-h"]').click();
    await unknown.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click());
    await expect.poll(() => unknown.locator("#consent").isVisible()).toBe(true);
    await expect.poll(() => unknown.locator("#consent-yes").getAttribute("aria-disabled")).toBe("true");
    await unknown.locator("#consent-yes").dispatchEvent("click");
    await unknown.waitForTimeout(150);
    expect(await unknown.evaluate(() => window.__calls)).toEqual([]);
    expect(await unknown.locator("#consent").isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);
