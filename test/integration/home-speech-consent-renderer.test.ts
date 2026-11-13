/** Built Home in Chromium: "I agree, start listening" fetches the speech models only after consent is saved (audit FE #20). */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
// Its I agree takes no press until the card has been up AGREE_ARM_MS (accessibility-r9-2).
import { AGREE_ARM_MS } from "../../app/shared/provider";

declare global { interface Window { __calls: string[]; __saves: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[]; __provider: unknown; __providerChanged: () => void; __emit: (n: string, v: unknown) => void } }

const settings = structuredClone(DEFAULT_SETTINGS);
settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
const admin = { source: null, error: null, managed: [], features: {}, provider: null as string | null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] };
const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin };

describe.skipIf(process.env.EMBER_SPEECH_CONSENT_TEST !== "1")("Home speech consent (audit FE #20)", () => {
  let browser: Browser;
  let server: http.Server;
  let port = 0;
  const pages: Page[] = [];

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
    const dist = path.resolve("dist");
    server = http.createServer((req, res) => {
      const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
      res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    port = address.port;
  });
  afterEach(async () => { for (const page of pages.splice(0)) await page.close(); });
  afterAll(async () => { await browser?.close(); server?.close(); });

  /** A fresh Home page whose saves stay pending until the test settles them. */
  async function freshHome() {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    pages.push(page);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
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
        if (name === "cancelVoiceDownload") return async () => { window.__calls.push("cancel-download"); };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    await page.goto(`http://127.0.0.1:${port}/app/renderer/home/index.html`);
    await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    await page.evaluate(() => { const b = document.getElementById("voice-download") as HTMLButtonElement; b.hidden = false; });
    const calls = (prefix: string) => page.evaluate(p => window.__calls.filter(c => c.startsWith(p)).length, prefix);
    const open = async () => { await page.locator('a[href="#voice-h"]').click(); await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click()); await expect.poll(() => page.locator("#consent").isVisible()).toBe(true); await page.waitForTimeout(AGREE_ARM_MS + 50); };
    const settle = (i: number, how: "ok" | "reject" | "false") => page.evaluate(([i, how]) => { const s = window.__saves[i as number]; if (how === "ok") s.resolve({}); else if (how === "false") s.resolve(false); else s.reject(new Error("Error invoking remote method 'ember:update-settings': Error: Ember couldn't save your settings: the disk is full.")); }, [i, how] as const);
    return { page, errors, calls, open, settle, error: () => page.locator("#consent-error") };
  }

  it("starts no download while the save is pending or after it is refused, and shows the failure", async () => {
    const { page, errors, calls, open, settle, error } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isVisible()).toBe(true);
    // A refused write: still no download, a visible line, Agree ready again, nothing claiming consent.
    await settle(0, "reject");
    await expect.poll(() => error().isVisible()).toBe(true);
    expect(await error().innerText()).toContain("couldn't be saved");
    expect(await page.locator("#voice-live").innerText()).toContain("couldn't be saved");
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isVisible()).toBe(true);
    expect(await page.locator("#consent-yes").getAttribute("aria-busy")).toBeNull();
    expect(await page.locator("#consent-yes").isEnabled()).toBe(true);
    expect(await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).checked)).toBe(false);
    expect(errors).toEqual([]);
  }, 60_000);

  it("treats a response that is not a Settings object (a literal false) as a refused save: no download, Agree ready again", async () => {
    const { page, errors, calls, open, settle, error } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await settle(0, "false");
    await expect.poll(() => error().isVisible()).toBe(true);
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isVisible()).toBe(true);
    expect(await page.locator("#consent-yes").isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);

  it("moves focus to Listen once, not to the “Hey Ember” switch, after Agree and when a download ends with focus on its Cancel (voice-listening-r7-2)", async () => {
    // "Listen for “Hey Ember”, switch, on", read by a screen reader as listening started, woke Ember.
    const { page, errors, calls, open, settle } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await settle(0, "ok");
    await expect.poll(() => page.locator("#consent").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("voice-listen-once");
    // Its download, with focus on Cancel, ends with every model in: Download is gone, so Listen once takes focus.
    await page.evaluate(() => window.__emit("onVoiceStatus", { state: "downloading", detail: null, modelsReady: false, modelsMissing: ["vad"], modelsBytes: 1_000_000, downloading: true }));
    await page.locator("#voice-download-cancel").focus();
    await page.evaluate(() => window.__emit("onVoiceStatus", { state: "starting", detail: null, modelsReady: true, modelsMissing: [], modelsBytes: 0 }));
    expect(await page.locator("#voice-download-cancel").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("voice-listen-once");
    expect(errors).toEqual([]);
  }, 60_000);

  it("says on the consent card that agreeing downloads the models, and offers Cancel while they download (voice-listening-6)", async () => {
    const { page, errors, calls, open } = await freshHome();
    await open();
    const card = (await page.locator("#consent-text").innerText()).replace(/\s+/g, " ");
    expect(card).toContain("Voice settings can turn this off. Agreeing also downloads the speech models (1 MB), once. If you teach Ember your voice,");
    // Download pressed: its Cancel shows at once and takes focus.
    await page.evaluate(() => { const b = document.getElementById("voice-download") as HTMLButtonElement; b.hidden = false; b.focus(); });
    await page.locator("#voice-download").click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("voice-download-cancel");
    expect(await page.locator("#voice-download-cancel").innerText()).toBe("Cancel download");
    await page.evaluate(() => window.__emit("onVoiceStatus", { state: "downloading", detail: null, modelsReady: false, modelsMissing: ["vad"], modelsBytes: 1_000_000, downloading: true }));
    expect(await page.locator("#voice-download-cancel").isVisible()).toBe(true);
    await page.locator("#voice-download-cancel").click();
    await expect.poll(() => calls("cancel-download")).toBe(1);
    // Cancelled: the bar and Cancel go, the line says so, and focus goes back to Download.
    await page.evaluate(() => window.__emit("onVoiceStatus", { state: "needs-models", detail: "Download cancelled.", modelsReady: false, modelsMissing: ["vad"], modelsBytes: 1_000_000 }));
    expect(await page.locator("#voice-download-cancel").isHidden()).toBe(true);
    expect(await page.locator("#voice-progress").isHidden()).toBe(true);
    expect(await page.locator("#voice-text").innerText()).toBe("Download cancelled.");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("voice-download");
    // Nothing missing: the card says nothing of a download.
    await page.evaluate(() => window.__emit("onVoiceStatus", { state: "off", detail: null, modelsReady: true, modelsMissing: [], modelsBytes: 0 }));
    expect(await page.locator("#consent-models").isHidden()).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);

  it("downloads exactly once when Agree is retried after a refused save", async () => {
    const { page, errors, calls, open, settle, error } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await settle(0, "reject");
    await expect.poll(() => error().isVisible()).toBe(true);
    expect(await calls("download")).toBe(0);
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(2);
    expect(await error().isHidden()).toBe(true);
    expect(await calls("download")).toBe(0);
    await settle(1, "ok");
    await expect.poll(() => calls("download")).toBe(1);
    await expect.poll(() => page.locator("#consent").isHidden()).toBe(true);
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(1);
    expect(errors).toEqual([]);
  }, 60_000);

  it("saves once and downloads once when Agree is clicked repeatedly while the save is pending", async () => {
    const { page, errors, calls, open, settle } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await page.locator("#consent-yes").click({ force: true });
    await page.locator("#consent-yes").dispatchEvent("click");
    await expect.poll(() => calls("save:")).toBe(1);
    await page.waitForTimeout(150);
    expect(await calls("save:")).toBe(1);
    expect(await calls("download")).toBe(0);
    await settle(0, "ok");
    await expect.poll(() => calls("download")).toBe(1);
    await page.waitForTimeout(150);
    expect(await calls("save:")).toBe(1);
    expect(await calls("download")).toBe(1);
    expect(errors).toEqual([]);
  }, 60_000);

  it("starts no download when Not now is pressed while the save is pending and then succeeds", async () => {
    const { page, errors, calls, open, settle } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await page.locator("#consent-no").click();
    await settle(0, "ok");
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(0);
    expect(await page.locator("#consent").isHidden()).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);

  it("starts no download and shows no error when Not now is pressed while the save is pending and then fails", async () => {
    const { page, errors, calls, open, settle, error } = await freshHome();
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => calls("save:")).toBe(1);
    await page.locator("#consent-no").click();
    await settle(0, "reject");
    await page.waitForTimeout(150);
    expect(await calls("download")).toBe(0);
    expect(await error().isHidden()).toBe(true);
    expect(errors).toEqual([]);
  }, 60_000);

  it("keeps Agree blocked and saves nothing while Ember doesn't yet know who the recipient is", async () => {
    const errors: string[] = [];
    const unknown = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    pages.push(unknown);
    unknown.on("pageerror", e => errors.push(e.message));
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
    await unknown.goto(`http://127.0.0.1:${port}/app/renderer/home/index.html`);
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
  }, 60_000);
});
