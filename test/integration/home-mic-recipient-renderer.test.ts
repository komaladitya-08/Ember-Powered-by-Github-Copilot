/** Built Home in Chromium: the microphone note names where the text really goes (audit FE #19): Copilot, the user's own provider, or the organisation's service. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
// Its I agree takes no press until the card has been up AGREE_ARM_MS (accessibility-r9-2).
import { AGREE_ARM_MS } from "../../app/shared/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";

declare global { interface Window { __calls: string[]; __emit: (name: string, value: unknown) => void; __provider: unknown; __providerChanged: () => void; __settings: unknown; __reads: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] } }

it.skipIf(process.env.EMBER_MIC_RECIPIENT_TEST !== "1")("names the active model recipient in the microphone note, follows changes while it is open, and keeps Yes and Not now as they were", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.provider = { ...settings.provider, on: true, baseUrl: "https://models.example.com:8443/v1/secret-path", consent: { version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-04T12:00:00Z", host: "models.example.com:8443" } } as typeof settings.provider;
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
      window.__calls = [];
      window.__settings = seed.status.settings;
      const subs: Record<string, ((v: unknown) => void)[]> = {};
      let changed: (() => void)[] = [];
      window.__providerChanged = () => changed.forEach(f => f());
      window.__emit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
      // Main says the provider is allowed and in force while it is on and agreed to.
      window.__provider = { allowed: true, managed: null, keySaved: true, keyring: true, inForce: true, host: "models.example.com:8443", agreed: true };
      (window as unknown as { emberProvider: unknown }).emberProvider = { state: async () => window.__provider, onChanged: (fn: () => void) => { changed.push(fn); return () => { changed = changed.filter(f => f !== fn); }; } };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
        if (name === "getStatus") return async () => ({ ...seed.status, settings: window.__settings });
        if (name === "updateSettings") return async (patch: unknown) => { window.__calls.push(`updateSettings:${JSON.stringify(patch)}`); return { ok: true }; };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    const applyProvider = (own: Record<string, unknown>, state: Record<string, unknown>) => page.evaluate(({ own, state }) => {
      const s = structuredClone(window.__settings) as { provider: Record<string, unknown> };
      s.provider = { ...s.provider, ...own };
      window.__settings = s; window.__provider = state;
      window.__emit("onSettingsChanged", s); window.__providerChanged();
    }, { own, state });
    const note = async () => (await page.locator("#consent-text").innerText()).replace(/\s+/g, " ");
    const open = async () => { await page.locator('a[href="#voice-h"]').click(); await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click()); await expect.poll(() => page.locator("#consent").isVisible()).toBe(true); await page.waitForTimeout(AGREE_ARM_MS + 50); };

    // Personal provider in force: its host, never the path.
    await page.evaluate(() => window.__emit("onSettingsChanged", window.__settings));
    await open();
    await expect.poll(note).toContain("only that text is sent to your own model provider (models.example.com:8443).");
    expect(await note()).not.toMatch(/sent to Copilot|secret-path/);
    expect(await note()).toContain("no audio leaves it");
    expect(await page.locator("#consent-text #mic-indicator").count()).toBe(1);
    expect(await page.locator("#consent-text [data-shortcut='mute']").count()).toBe(1);
    expect(await page.locator("#consent-text .model-recipient").first().innerText()).toBe("your own model provider (models.example.com:8443)");

    // The provider is turned off while the note is open: it follows at once.
    await applyProvider({ on: false }, { allowed: true, managed: null, keySaved: true, keyring: true, inForce: false, host: "models.example.com:8443", agreed: true });
    await expect.poll(note).toContain("only that text is sent to Copilot.");

    // Toggled on but not agreed to for the host: still Copilot (main routes nothing there).
    await applyProvider({ on: true, consent: { version: 0, at: null, host: null } }, { allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: "models.example.com:8443", agreed: false });
    await expect.poll(note).toContain("only that text is sent to Copilot.");

    // Cancel keeps the old behaviour: hidden, focus on the switch, nothing saved. Yes saves consent as before.
    await page.locator("#consent-no").click();
    expect(await page.locator("#consent").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("wake");
    expect(await page.evaluate(() => window.__calls)).toEqual([]);
    await open();
    await page.locator("#consent-yes").click();
    await expect.poll(() => page.locator("#consent").isHidden()).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(1);
    expect(await page.evaluate(() => window.__calls[0])).toContain('"consent":true');

    // The organisation's service answers instead (policy is read at start): its host, and it beats a personal provider.
    const org = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const orgErrors: string[] = [];
    org.on("pageerror", error => orgErrors.push(error.message));
    await org.addInitScript(seed => {
      window.__calls = []; window.__settings = seed.status.settings;
      (window as unknown as { emberProvider: unknown }).emberProvider = { state: async () => ({ allowed: false, managed: "organisation", keySaved: false, keyring: true, inForce: false, host: null, agreed: false }), onChanged: () => () => undefined };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return () => () => undefined;
        if (name === "getStatus") return async () => seed.status;
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status: { ...status, admin: { ...admin, provider: "https://llm.corp.example:9000/v1/secret-path" } } });
    await org.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await org.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    await org.locator('a[href="#voice-h"]').click();
    await org.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click());
    await expect.poll(() => org.locator("#consent").isVisible()).toBe(true);
    const orgNote = () => org.locator("#consent-text").innerText().then(t => t.replace(/\s+/g, " "));
    await expect.poll(orgNote).toContain("only that text is sent to your organisation's model service (llm.corp.example:9000).");
    expect(await orgNote()).not.toMatch(/sent to Copilot|secret-path/);
    expect(await org.locator("#w-full #model-service").textContent()).toBe("your organisation's model service (llm.corp.example:9000)");
    expect(await org.locator("#w-full .model-recipient").first().textContent()).toBe("your organisation's model service (llm.corp.example:9000)");
    expect(orgErrors).toEqual([]);
    await page.close();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);

it.skipIf(process.env.EMBER_MIC_RECIPIENT_TEST !== "1")("never calls an unread provider Copilot: the note says it can't tell and Agree waits until main's state arrives, in whatever order reads settle", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  // The settings snapshot says the provider is off: main's provider state is the authority on where requests go.
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
      window.__calls = []; window.__reads = []; window.__settings = seed.status.settings;
      const subs: Record<string, ((v: unknown) => void)[]> = {};
      let changed: (() => void)[] = [];
      window.__providerChanged = () => changed.forEach(f => f());
      window.__emit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
      // Every state read waits until the test settles it.
      (window as unknown as { emberProvider: unknown }).emberProvider = {
        state: () => new Promise((resolve, reject) => { window.__reads.push({ resolve, reject }); }),
        onChanged: (fn: () => void) => { changed.push(fn); return () => { changed = changed.filter(f => f !== fn); }; },
      };
      window.ember = new Proxy({}, { get: (_t, name: string) => {
        if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
        if (name === "getStatus") return async () => ({ ...seed.status, settings: window.__settings });
        if (name === "updateSettings") return async (patch: unknown) => { window.__calls.push(`updateSettings:${JSON.stringify(patch)}`); return { ok: true }; };
        return () => new Promise(() => undefined);
      } }) as never;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
    const own = { allowed: true, managed: null, keySaved: true, keyring: true, inForce: true, host: "models.example.com:8443", agreed: true };
    const none = { allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: null, agreed: false };
    const reads = () => page.evaluate(() => window.__reads.length);
    // Settle the read at `i` by hand (value, or a rejection).
    const settle = (i: number, v: unknown | Error) => page.evaluate(({ i, v, bad }) => { const r = window.__reads[i]!; if (bad) r.reject(new Error("read failed")); else r.resolve(v); }, { i, v: v instanceof Error ? null : v, bad: v instanceof Error });
    const change = async () => { const n = await reads(); await page.evaluate(() => window.__providerChanged()); await expect.poll(reads).toBe(n + 1); return n; };
    const note = async () => (await page.locator("#consent-text").innerText()).replace(/\s+/g, " ");
    const listed = () => page.locator("#w-full .model-recipient").first().innerText();
    const yesDisabled = () => page.locator("#consent-yes").evaluate(el => el.getAttribute("aria-disabled") === "true");
    const open = async () => { await page.locator('a[href="#voice-h"]').click(); await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click()); await expect.poll(() => page.locator("#consent").isVisible()).toBe(true); await page.waitForTimeout(AGREE_ARM_MS + 50); };
    await page.evaluate(() => window.__emit("onSettingsChanged", window.__settings));
    await expect.poll(reads).toBeGreaterThan(0);

    // 1. Read pending: unknown, not Copilot; Agree waits and does nothing; the list says the same.
    await open();
    await expect.poll(note).toContain("only that text is sent to a model service I can't tell yet.");
    expect(await note()).not.toMatch(/Copilot/);
    expect(await listed()).toBe("a model service I can't tell yet");
    expect(await yesDisabled()).toBe(true);
    await page.locator("#consent-yes").click({ force: true });
    expect(await page.locator("#consent").isVisible()).toBe(true);
    expect(await page.evaluate(() => window.__calls)).toEqual([]);

    // 2. The read is rejected: still unknown, still waiting.
    for (let i = 0; i < await reads(); i++) await settle(i, new Error("x"));
    await expect.poll(note).toContain("a model service I can't tell yet");
    expect(await note()).not.toMatch(/Copilot/);
    expect(await yesDisabled()).toBe(true);

    // 3. A read answers: personal provider in force (settings snapshot says off): named, Agree works.
    const n3 = await change();
    await settle(n3, own);
    await expect.poll(note).toContain("only that text is sent to your own model provider (models.example.com:8443).");
    expect(await listed()).toBe("your own model provider (models.example.com:8443)");
    expect(await yesDisabled()).toBe(false);

    // 4. An older read failing after a newer success changes nothing; an older success after it is ignored too.
    const a = await change(); const b = await change();
    await settle(b, none);
    await expect.poll(note).toContain("only that text is sent to Copilot.");
    await settle(a, new Error("late"));
    expect(await note()).toContain("only that text is sent to Copilot.");
    expect(await yesDisabled()).toBe(false);
    const c = await change(); const d = await change();
    await settle(d, none); await settle(c, own);
    expect(await note()).toContain("only that text is sent to Copilot.");

    // 5. Not now keeps working while the destination is unknown, and saves nothing.
    await change();
    await expect.poll(note).toContain("a model service I can't tell yet");
    await page.locator("#consent-no").click();
    expect(await page.locator("#consent").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("wake");
    expect(await page.evaluate(() => window.__calls)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);
