/** Built Home in Chromium: a startup snapshot that resolves after a newer settings push never puts the older state back (and a failed one blanks nothing). */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";

declare global { interface Window { __emit: (name: string, value: unknown) => void; __provider: unknown; __providerChanged: () => void; __reads: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] } }

const A = { host: "a.example.com", character: "cinder", size: 36 };
const B = { host: "b.example.com", character: "wisp", size: 48 };
const settingsFor = (v: typeof A) => {
  const s = structuredClone(DEFAULT_SETTINGS) as typeof DEFAULT_SETTINGS & Record<string, unknown>;
  s.onboarded = true; s.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  s.character = v.character as typeof s.character; s.size = v.size;
  s.provider = { ...s.provider, on: true, baseUrl: `https://${v.host}/v1`, consent: { version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-04T12:00:00Z", host: v.host } } as typeof s.provider;
  return s;
};
const providerFor = (v: typeof A) => ({ allowed: true, managed: null, keySaved: true, keyring: true, inForce: true, host: v.host, agreed: true });
const admin = { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] };
const statusOf = (v: typeof A) => ({ appVersion: "0.1.1", settings: settingsFor(v), environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin });

let browser: Browser; let server: http.Server; let base = "";
beforeAll(async () => {
  if (process.env.EMBER_STATUS_RACE_TEST !== "1") return;
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
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await browser?.close(); server?.close(); });

/** Home with getStatus calls held (each resolvable or rejectable by the test), and main's provider state following `window.__provider`. */
async function openHome(initial: typeof A, statusCalls: "held" | "answer-now" = "held"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(seed => {
    const w = window as unknown as { __statusCalls: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[]; __statusMode: string; __status: unknown };
    w.__statusCalls = []; w.__statusMode = seed.mode; w.__status = seed.status;
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    let changed: (() => void)[] = [];
    window.__providerChanged = () => changed.forEach(f => f());
    window.__emit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
    window.__provider = seed.provider;
    (window as unknown as { emberProvider: unknown }).emberProvider = { state: async () => window.__provider, onChanged: (fn: () => void) => { changed.push(fn); return () => { changed = changed.filter(f => f !== fn); }; } };
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return () => w.__statusMode === "answer-now" ? Promise.resolve(w.__status) : new Promise((resolve, reject) => { w.__statusCalls.push({ resolve, reject }); });
      if (name === "updateSettings") return async () => ({ ok: true });
      return () => new Promise(() => undefined);
    } }) as never;
  }, { status: statusOf(initial), provider: providerFor(initial), mode: statusCalls });
  await page.goto(`${base}/app/renderer/home/index.html`);
  return { page, errors };
}
const held = (page: Page) => page.evaluate(() => (window as unknown as { __statusCalls: unknown[] }).__statusCalls.length);
const settle = (page: Page, i: number, how: "resolve" | "reject", value?: unknown) => page.evaluate(({ i, how, value }) => {
  const c = (window as unknown as { __statusCalls: Record<string, (v: unknown) => void>[] }).__statusCalls[i];
  c[how](how === "reject" ? new Error("Main is busy") : value);
}, { i, how, value });
/** The state a person sees: the chosen character, the size, and the microphone note's recipient (consent open). */
async function shown(page: Page) {
  await page.evaluate(() => { document.body.classList.remove("loading", "first-run"); });
  const character = await page.locator('#cards [aria-checked="true"]').getAttribute("data-id").catch(() => null);
  return { character, size: await page.locator("#size").inputValue(), recipient: await recipient(page) };
}
async function recipient(page: Page): Promise<string> {
  await page.locator('a[href="#voice-h"]').click();
  if (!(await page.locator("#consent").isVisible())) await page.evaluate(() => (document.getElementById("wake") as HTMLInputElement).click());
  await page.locator("#consent").waitFor({ state: "visible" });
  return (await page.locator("#consent-text .model-recipient").first().innerText()).trim();
}
const push = (page: Page, v: typeof A) => page.evaluate(({ s, p }) => { window.__provider = p; window.__emit("onSettingsChanged", s); window.__providerChanged(); }, { s: settingsFor(v), p: providerFor(v) });

describe.skipIf(process.env.EMBER_STATUS_RACE_TEST !== "1")("Home startup snapshot against newer pushes", () => {
  it("(a) shows the snapshot on a normal first load", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    await settle(page, 0, "resolve", statusOf(A));
    await expect.poll(() => shown(page).then(s => s.recipient)).toContain(A.host);
    expect((await shown(page)).size).toBe(String(A.size));
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it("(b) keeps the pushed settings and provider when the older snapshot resolves late", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    await push(page, B);
    await settle(page, 0, "resolve", statusOf(A));
    // Every held request answers with the older snapshot.
    for (let i = 1; i < await held(page); i++) await settle(page, i, "resolve", statusOf(A));
    await page.waitForTimeout(300);
    const now = await shown(page);
    expect(now.recipient).toContain(B.host);
    expect(now.recipient).not.toContain(A.host);
    expect(now.size).toBe(String(B.size));
    expect(now.character).toBe(B.character);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it("(c) keeps the pushed state when the snapshot fails after a push, and blanks nothing", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    await push(page, B);
    const first = await held(page);
    for (let i = 0; i < first; i++) await settle(page, i, "reject");
    await page.waitForTimeout(300);
    // Nothing blank or older: the pushed settings stand. (The recipient is named from the policy a status carries, so until one arrives it is not A's.)
    const now = await shown(page);
    expect(now.recipient).not.toContain(A.host);
    expect(now.size).toBe(String(B.size));
    expect(now.character).toBe(B.character);
    // The retry's snapshot, requested after the push, names the pushed provider.
    await expect.poll(() => held(page), { timeout: 5000 }).toBeGreaterThan(first);
    await settle(page, first, "resolve", statusOf(B));
    await expect.poll(() => page.locator("#consent-text .model-recipient").first().innerText()).toContain(B.host);
    expect((await shown(page)).size).toBe(String(B.size));
    await page.close();
    expect(errors.filter(e => !/Main is busy/.test(e))).toEqual([]);
  }, 30_000);

  it("(d) asks again after an initial failure and shows the state when the retry succeeds", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    const first = await held(page);
    for (let i = 0; i < first; i++) await settle(page, i, "reject");
    await expect.poll(() => held(page), { timeout: 5000 }).toBeGreaterThan(first);
    await settle(page, first, "resolve", statusOf(B));
    await expect.poll(async () => (await shown(page)).size, { timeout: 5000 }).toBe(String(B.size));
    expect((await shown(page)).character).toBe(B.character);
    await page.close();
    expect(errors.filter(e => !/Main is busy/.test(e))).toEqual([]);
  }, 30_000);

  it("restores the saved microphone switch and consent after every initial status request fails", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    const first = await held(page);
    for (let i = 0; i < first; i++) await settle(page, i, "reject");
    await expect.poll(() => held(page), { timeout: 5000 }).toBeGreaterThan(first);
    const recovered = statusOf(B);
    recovered.settings.wakeWord = true;
    recovered.settings.voice.consent = true;
    recovered.settings.speakResults = true;
    await settle(page, first, "resolve", recovered);
    await expect.poll(() => page.locator("#wake").isChecked()).toBe(true);
    expect(await page.locator("#speak-results").isChecked()).toBe(true);
    await page.locator('a[href="#voice-h"]').click();
    // Turn listening off and back on. Saved consent must not be requested again.
    await page.locator("#wake").click();
    await page.locator("#wake").click();
    expect(await page.locator("#consent").isHidden()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it("keeps voice settings and the provider pushed while a retry is pending", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    const first = await held(page);
    for (let i = 0; i < first; i++) await settle(page, i, "reject");
    await expect.poll(() => held(page), { timeout: 5000 }).toBeGreaterThan(first);
    const newer = settingsFor(B);
    newer.wakeWord = true;
    newer.voice.consent = true;
    await page.evaluate(({ s, p }) => {
      window.__provider = p;
      window.__emit("onSettingsChanged", s);
      window.__providerChanged();
    }, { s: newer, p: providerFor(B) });
    await settle(page, first, "resolve", statusOf(A));
    await expect.poll(() => page.locator("#size").inputValue()).toBe(String(B.size));
    expect(await page.locator("#wake").isChecked()).toBe(true);
    expect(await page.locator("#consent-text .model-recipient").first().textContent()).toContain(B.host);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it("(e) treats the recipient as unknown, and Agree waits, until a status has arrived", async () => {
    const { page, errors } = await openHome(A);
    await expect.poll(() => held(page)).toBeGreaterThan(0);
    const note = await recipient(page);
    expect(note).toBe("a model service I can't tell yet");
    expect(note).not.toContain("Copilot");
    expect(await page.locator("#consent-yes").getAttribute("aria-disabled")).toBe("true");
    // A failed status changes nothing; the retry's success names the recipient and enables Agree.
    const first = await held(page);
    for (let i = 0; i < first; i++) await settle(page, i, "reject");
    await page.waitForTimeout(300);
    expect(await page.locator("#consent-text .model-recipient").first().innerText()).not.toContain("Copilot");
    expect(await page.locator("#consent-yes").getAttribute("aria-disabled")).toBe("true");
    await expect.poll(() => held(page), { timeout: 5000 }).toBeGreaterThan(first);
    await settle(page, first, "resolve", statusOf(A));
    await expect.poll(() => page.locator("#consent-text .model-recipient").first().innerText()).toContain(A.host);
    expect(await page.locator("#consent-yes").getAttribute("aria-disabled")).toBeNull();
    await page.close();
    expect(errors.filter(e => !/Main is busy/.test(e))).toEqual([]);
  }, 30_000);
});
