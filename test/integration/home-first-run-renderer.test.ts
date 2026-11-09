/**
 * Built Home in Chromium, first run (FE #2–#6): the choice between GitHub Copilot and the user's own model provider, what
 * each failure offers, the models reviewed before the first request, and a failed setup fix shown in its row. Only the
 * preload boundary is replaced, with deferred promises the test settles by hand; nothing real is signed in or sent.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { AGREE_ARM_MS } from "../../app/shared/provider";

declare global {
  interface Window {
    __frCalls: string[];
    __frEmit: (name: string, value: unknown) => void;
    __frPend: Record<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }[]>;
    __frFailOff: boolean;
    __frState: { settings: Record<string, unknown> & { provider: Record<string, unknown> }; agent: Record<string, unknown> };
  }
}

const gate = process.env.EMBER_FIRST_RUN_TEST !== "1";
const READY_MODELS = [
  { id: "mini", name: "Mini", vision: false, cost: 0 },
  { id: "big", name: "Big", vision: true, cost: 3 },
];
const SIGNED_OUT = { phase: "signed-out", detail: "Not signed in.", models: [], conductorModel: null, workerModel: null, usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, signInWith: "github-app" };

/**
 * `liveState`: as over IPC, the page holds its own copy of the settings; the provider's state follows them as main's
 * does (in force while on and agreed for the address's host; a saved key kept only for its own host), and the card's
 * yes is saved and broadcast.
 */
interface Seed { consent?: number; admin?: Record<string, unknown>; agent?: Record<string, unknown>; checks?: unknown[]; providerState?: Record<string, unknown>; noBridge?: boolean; slowAgree?: boolean; failOff?: boolean; home?: boolean; provider?: Record<string, unknown>; liveState?: boolean }

let browser: Browser;
let server: http.Server;
let port = 0;

beforeAll(async () => {
  if (gate) return;
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
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { if (gate) return; await browser.close(); server.close(); });

async function open(seed: Seed = {}): Promise<Page> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = !!seed.home;
  if (seed.provider) settings.provider = { ...settings.provider, ...seed.provider } as typeof settings.provider;
  settings.consent = { version: seed.consent ?? 99, at: "2026-11-04T12:00:00Z" };
  const admin = { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [], ...seed.admin };
  const environment = { checks: seed.checks ?? [], versions: { node: "24", electron: "44", chrome: "152" } };
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  (page as Page & { errors: string[] }).errors = errors;
  await page.addInitScript(({ settings, admin, environment, agent, providerState, noBridge, slowAgree, failOff, liveState }) => {
    window.__frFailOff = failOff;
    window.__frCalls = []; window.__frPend = {};
    window.__frState = { settings, agent };
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    window.__frEmit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
    const defer = (name: string) => new Promise((resolve, reject) => { (window.__frPend[name] ??= []).push({ resolve, reject }); });
    const copy = <T>(v: T): T => (liveState ? structuredClone(v) : v);
    const hostOf = (url: unknown) => { try { return new URL(String(url)).host; } catch { return null; } };
    /** The host the saved key is for (liveState): main deletes a key saved for another host than the address. */
    let keyHost = liveState && providerState.keySaved ? hostOf(settings.provider.baseUrl) : null;
    const status = () => ({ appVersion: "0.1.1", settings: copy(window.__frState.settings), environment, logFile: "/test/ember.log", settingsNotice: null, admin });
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => status();
      if (name === "agentStatus") return async () => window.__frState.agent;
      if (name === "updateSettings") return async (patch: Record<string, unknown>) => {
        window.__frCalls.push(`save:${JSON.stringify(patch)}`);
        if (window.__frFailOff && (patch.provider as { on?: boolean } | undefined)?.on === false) throw new Error("disk full");
        const s = window.__frState.settings;
        for (const [k, v] of Object.entries(patch)) s[k] = v && typeof v === "object" && !Array.isArray(v) && typeof s[k] === "object" ? { ...(s[k] as object), ...v } : v;
        if (keyHost && keyHost !== hostOf(s.provider.baseUrl)) keyHost = null;
        window.__frEmit("onSettingsChanged", copy(s));
      };
      if (name === "signIn") return () => { window.__frCalls.push("signIn"); return defer("signIn"); };
      if (name === "retrySignIn") return () => { window.__frCalls.push("retry"); return defer("retry"); };
      if (name === "applyFix") return (fix: string) => { window.__frCalls.push(`fix:${fix}`); return defer("fix"); };
      if (name === "recheckSetup") return () => { window.__frCalls.push("recheck"); return defer("recheck"); };
      if (name === "conversation") return async () => [];
      if (name === "copyText") return async (text: string) => { window.__frCalls.push(`copy:${text}`); };
      if (name === "openAsk") return async () => { window.__frCalls.push("openAsk"); };
      if (name === "quit") return async () => { window.__frCalls.push("quit"); };
      if (name === "cancelSignIn") return async () => { window.__frCalls.push("cancelSignIn"); };
      return () => new Promise(() => undefined);
    } }) as never;
    if (!noBridge) {
      window.emberProvider = {
        state: async () => {
          const p = window.__frState.settings.provider as { on: boolean; baseUrl: string; consent?: { host?: string } };
          const host = hostOf(p.baseUrl);
          const agreed = !!host && p.consent?.host === host;
          const live = liveState ? { inForce: p.on && agreed, host, agreed, keySaved: !!host && keyHost === host } : {};
          return { allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: null, agreed: false, ...providerState, ...live };
        },
        onChanged: () => () => undefined,
        saveKey: () => { window.__frCalls.push("saveKey"); keyHost = hostOf(window.__frState.settings.provider.baseUrl); return Promise.resolve({ ok: true }); },
        removeKey: async () => ({ ok: true }),
        agree: (host: string, move?: object) => {
          window.__frCalls.push(`agree:${host}`);
          // Home's held edit of the provider in use comes with its details, saved with the yes (integrations-c3-1).
          if (move) window.__frCalls.push(`move:${JSON.stringify(move)}`);
          if (liveState) {
            window.__frState.settings.provider = { ...window.__frState.settings.provider, ...move, on: true, consent: { version: 1, at: "2026-11-08T12:00:00Z", host } };
            window.__frEmit("onSettingsChanged", copy(window.__frState.settings));
            return Promise.resolve({ ok: true });
          }
          if (slowAgree) return (defer("agree") as Promise<unknown>).then(r => { window.__frState.settings.provider = { ...window.__frState.settings.provider, ...move, on: true }; return r; }) as never; window.__frState.settings.provider = { ...window.__frState.settings.provider, ...move, on: true }; return Promise.resolve({ ok: true }); },
        // A draft of typed details (first-run-r2-1) is told apart by its host, and whether a key came with it (never the key).
        test: (draft?: { host: string; key?: string }) => { window.__frCalls.push(draft ? `test-draft:${draft.host}${draft.key ? "+key" : ""}` : "test"); return defer("test") as never; },
      };
    }
  }, { settings, admin, environment, agent: seed.agent ?? SIGNED_OUT, providerState: seed.providerState ?? {}, noBridge: !!seed.noBridge, slowAgree: !!seed.slowAgree, failOff: !!seed.failOff, liveState: !!seed.liveState });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/home/index.html`);
  if (seed.home) { await page.waitForSelector("a[href='#copilot-h']"); await page.locator("a[href='#copilot-h']").first().click(); } else await page.waitForSelector("#welcome:not([hidden])");
  return page;
}

const calls = (p: Page) => p.evaluate(() => window.__frCalls);
const settle = (p: Page, name: string, ok: unknown, i = 0) => p.evaluate(([n, v, k]) => window.__frPend[n as string][k as number].resolve(v), [name, ok, i] as const);
const fail = (p: Page, name: string, message: string, i = 0) => p.evaluate(([n, m, k]) => window.__frPend[n as string][k as number].reject(new Error(m as string)), [name, message, i] as const);
const emit = (p: Page, name: string, v: unknown) => p.evaluate(([n, x]) => window.__frEmit(n as string, x), [name, v] as const);
const focusedId = (p: Page) => p.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("data-action") || "");
const buttons = (p: Page) => p.locator("#welcome button:visible").allInnerTexts();
const readyAgent = (extra: Record<string, unknown> = {}) => ({ ...SIGNED_OUT, phase: "ready", detail: "Connected.", login: "octo", models: READY_MODELS, conductorModel: "mini", workerModel: "big", ...extra });
const next = (p: Page) => p.locator("#w-next");
/** The element is drawn at more than a screen reader's 1 px (the `.sr` class), so a sighted user sees it. */
const seen = (p: Page, sel: string) => p.locator(sel).evaluate(e => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 8 && getComputedStyle(e).clipPath === "none"; });

describe.skipIf(gate)("first run: connection, own provider and models (FE #2–#6)", () => {
  it("(a) Copilot: a failed sign-in is visible, retry works, the models are reviewed, then the first answer", async () => {
    const p = await open();
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("signIn");
    await fail(p, "signIn", "GitHub didn't answer.");
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toContain("didn't answer");
    // Main's own words for a sign-in that failed, said as mine (first-run-r4-2).
    await emit(p, "onSignInProgress", { state: "error", message: "Ember can't reach GitHub right now. Check the network, then sign in again." });
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toBe("I can't reach GitHub right now. Check the network, then sign in again.");
    expect(await p.locator("#w-models").isHidden()).toBe(true);
    // Retry: the same primary button; the connection then comes up and the models are shown, not assumed.
    await next(p).click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "signIn").length).toBe(2);
    await settle(p, "signIn", undefined, 1);
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, readyAgent());
    await expect.poll(() => p.locator("#w-models").isVisible()).toBe(true);
    const list = await p.locator("#w-models-list").innerText();
    expect(list).toContain("Mini (no premium requests)");
    expect(list).toContain("Big (3× premium requests a message)");
    // Change is optional and reachable by keyboard; the choice is saved.
    await p.locator("#w-models-change").focus();
    await p.keyboard.press("Enter");
    expect(await focusedId(p)).toBe("w-m-conductor");
    await p.selectOption("#w-m-conductor", "big");
    await expect.poll(async () => (await calls(p)).some(c => c.includes('"conductor":"big"'))).toBe(true);
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    expect(await focusedId(p)).toBe("w-title");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Try me out");
    await p.locator("#w-ask").click();
    await expect.poll(() => calls(p)).toContain("openAsk");
    await emit(p, "onConversation", [{ t: "1", who: "you", text: "What can you do?" }, { t: "2", who: "ember", text: "Plenty." }]);
    await expect.poll(() => p.locator("#w-try-ask.done").count()).toBe(1);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(b) own provider: no GitHub, a failed model check is visible and fixable, then the first answer", async () => {
    const p = await open();
    expect(await buttons(p)).toContain("Use my own provider");
    await p.getByRole("button", { name: "Use my own provider" }).click();
    expect(await p.locator("#w-title").innerText()).toBe("Use your own model provider");
    expect(await focusedId(p)).toBe("w-p-url");
    expect(await p.locator("#w-count").innerText()).toBe("Step 3 of 6");
    // Prerequisites, and what is sent where, are said before anything is entered.
    expect(await p.locator("#w-p-needs").innerText()).toContain("API key");
    await p.fill("#w-p-url", "https://api.example.com/v1");
    expect(await p.locator("#w-p-consent").innerText()).toContain("api.example.com");
    // The step has no switch to turn off: its Back is the way to Copilot (first-run-10).
    expect(await p.locator("#w-p-consent").innerText()).toMatch(/Back takes you to GitHub Copilot instead\.$/);
    expect(await p.locator("#w-p-consent").innerText()).not.toContain("Turn this off");
    // Empty fields are told what to fill, and nothing is saved or sent.
    await next(p).click();
    expect(await p.locator("#w-p-result").innerText()).toBe("Paste the API key first.");
    expect(await focusedId(p)).toBe("w-p-key");
    expect(await calls(p)).toEqual([]);
    await p.fill("#w-p-key", "sk-test-not-real");
    await p.fill("#w-p-conductor", "gpt-4.1");
    await next(p).click();
    expect(await next(p).getAttribute("aria-disabled")).toBe("true");
    await expect.poll(() => calls(p)).toContain("test");
    const order = await calls(p);
    expect(order.findIndex(c => c.startsWith("agree:"))).toBeLessThan(order.indexOf("test"));
    expect(order.indexOf("saveKey")).toBeLessThan(order.indexOf("test"));
    // Until the service answers, nothing says it works.
    expect(await p.locator("#w-p-result").innerText()).toBe("Checking the service…");
    await settle(p, "test", { ok: false, why: "The service refused the key." });
    await expect.poll(() => p.locator("#w-p-result").innerText()).toBe("The service refused the key.");
    expect(await p.locator("#w-p-result").getAttribute("role")).toBe("status");
    expect(await focusedId(p)).toBe("w-p-key");
    expect(await next(p).innerText()).toBe("Check again");
    // A service that didn't answer is not left switched on.
    await expect.poll(() => p.evaluate(() => window.__frState.settings.provider.on)).toBe(false);
    await expect.poll(async () => (await calls(p)).some(c => c === 'save:{"provider":{"on":false}}')).toBe(true);
    await p.fill("#w-p-key", "sk-test-fixed");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "test").length).toBe(2);
    await settle(p, "test", { ok: true, host: "api.example.com", models: 2 }, 1);
    await expect.poll(() => p.locator("#w-p-result").innerText()).toBe("Connected to api.example.com. It lists 2 models.");
    // Connected, but Ember is not yet: Continue says it is waiting.
    expect(await p.locator("#w-why").innerText()).toContain("Connecting to api.example.com");
    // It can't connect yet: why, beside the waiting Continue, said as mine (first-run-r4-2).
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, { ...SIGNED_OUT, phase: "error", reason: "network", detail: "Ember can't reach api.example.com. Check the address and the network: Ember will try again in a moment.", service: { kind: "user", host: "api.example.com" } });
    await expect.poll(() => p.locator("#w-why").innerText()).toBe("I can't reach api.example.com. Check the address and the network: I'll try again in a moment.");
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service: { kind: "user", host: "api.example.com" } }));
    await expect.poll(() => next(p).getAttribute("aria-disabled")).toBeNull();
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    // Back returns to the provider's step, not to a Copilot sign-in that isn't in use (first-run-1), and shows the
    // provider as in use, never as a form still to agree to (first-run-c1-2).
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider's details");
    expect(await p.locator("#w-p-result").innerText()).toBe("Using your own provider (api.example.com).");
    expect(await p.evaluate(() => window.__frState.settings.provider.on)).toBe(true);
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await next(p).click();
    await p.locator("#w-ask").click();
    await emit(p, "onConversation", [{ t: "1", who: "you", text: "Hi" }, { t: "2", who: "ember", text: "Hello." }]);
    await expect.poll(() => p.locator("#w-try-ask.done").count()).toBe(1);
    expect((await calls(p)).includes("signIn")).toBe(false);
    // The summary names the provider under its own label, never as Copilot (first-run-1).
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your Ember");
    const summary = await p.locator("#w-summary").innerText();
    expect(summary).toContain("Model service");
    expect(summary).toContain("Your own provider (api.example.com)");
    expect(summary).not.toContain("Copilot");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(c) an entitlement failure offers account, access and provider remedies, not signing in again", async () => {
    for (const [detail, word] of [["Copilot isn't available to this account.", "github.com/features/copilot"], ["Copilot is disabled by your organisation's policy.", "administrator"]] as const) {
      const p = await open({ agent: { ...SIGNED_OUT, phase: "error", reason: "no-access", detail } });
      expect(await next(p).innerText()).toBe("Use my own provider");
      const shown = await buttons(p);
      expect(shown).toContain("Try a different GitHub account");
      expect(shown).toContain("Try again");
      expect(shown).not.toContain("Sign in with GitHub");
      expect(await p.locator("#w-signin-help").innerText()).toContain(word);
      // Choosing another provider works from here; Back returns and puts the provider away.
      await next(p).click();
      expect(await p.locator("#w-title").innerText()).toBe("Use your own model provider");
      await p.locator("#w-back").click();
      expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
      expect(await focusedId(p)).toBe("w-title");
      await p.close();
    }
    // Where the organisation forbids a provider of one's own, the remedy is a different account, never the same sign-in.
    const q = await open({ agent: { ...SIGNED_OUT, phase: "error", reason: "no-access", detail: "No seat." }, admin: { features: { userProvider: false } } });
    expect(await next(q).innerText()).toBe("Try a different GitHub account");
    expect(await buttons(q)).not.toContain("Use my own provider");
  });

  it("(d) admin policy that forbids or fixes the provider removes the choice and says why", async () => {
    const off = await open({ admin: { features: { userProvider: false } } });
    expect(await buttons(off)).not.toContain("Use my own provider");
    expect(await off.locator("#w-signin-help").innerText()).toContain("turned off using your own model provider");
    // The lead doesn't offer what the line under it says is turned off (first-run-7).
    expect(await off.locator("#w-lead").innerText()).not.toContain("own model provider");
    const fixed = await open({ admin: { provider: "https://models.corp.example/v1" } });
    expect(await buttons(fixed)).not.toContain("Use my own provider");
    expect(await fixed.locator("#w-title").innerText()).toBe("Connecting to your organisation's service");
    const providerOff = await open({ providerState: { allowed: false, managed: "off" } });
    await expect.poll(() => providerOff.locator("#w-signin-help").innerText()).toContain("turned off");
    expect(await buttons(providerOff)).not.toContain("Use my own provider");
    const none = await open({ noBridge: true });
    expect(await buttons(none)).not.toContain("Use my own provider");
  });

  it("(e) a slow failed check that arrives after the user left, or edited, doesn't overwrite newer state", async () => {
    const p = await open();
    await p.getByRole("button", { name: "Use my own provider" }).click();
    await p.fill("#w-p-url", "https://api.example.com/v1");
    await p.fill("#w-p-key", "sk-x");
    await p.fill("#w-p-conductor", "gpt-4.1");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "test").length).toBe(1);
    // Edit the address while the first check is out, and check again: that one answers first, with success.
    await p.fill("#w-p-url", "https://other.example.com/v1");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "test").length).toBe(2);
    await settle(p, "test", { ok: true, host: "other.example.com", models: 1 }, 1);
    await expect.poll(() => p.locator("#w-p-result").innerText()).toBe("Connected to other.example.com. It lists 1 model.");
    await settle(p, "test", { ok: false, why: "Old failure." }, 0);
    await p.waitForTimeout(150);
    expect(await p.locator("#w-p-result").innerText()).toBe("Connected to other.example.com. It lists 1 model.");
    // Leave for Copilot, start another check, leave again before it answers: its failure is not shown anywhere.
    await p.fill("#w-p-key", "sk-y");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "test").length).toBe(3);
    await p.locator("#w-back").click();
    await settle(p, "test", { ok: false, why: "Too late." }, 2);
    await p.waitForTimeout(150);
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    expect(await p.locator("#w-signin-line").innerText()).not.toContain("Too late");
    await p.getByRole("button", { name: "Use my own provider" }).click();
    expect(await p.locator("#w-p-result").innerText()).toBe("");
  });

  it("(f) a text-only fallback is explained, never an empty selector (FE #5), in the review and in Home's selector", async () => {
    const p = await open({ agent: readyAgent({ models: [{ id: "mini", name: "Mini", vision: false, cost: 0 }], conductorModel: "mini", workerModel: "mini" }) });
    await expect.poll(() => p.locator("#w-models").isVisible()).toBe(true);
    expect(await p.locator("#w-models-list").innerText()).toContain("text only");
    await p.locator("#w-models-change").click();
    expect(await p.locator("#w-m-worker option").count()).toBe(1);
    expect(await p.locator("#w-m-worker-label").innerText()).not.toContain("must understand images");
    expect(await p.locator("#w-m-worker-note").innerText()).toContain("work from text");
    expect(await p.locator("#m-worker option").count()).toBe(1);
    expect(await p.locator("#m-worker-note").innerText()).toContain("work from text");
    expect(await p.locator("#m-worker-label").innerText()).toBe("Model for tasks (text only)");
  });

  it("(g) a rejected setup fix shows in its row, is announced, and can be retried (FE #6); one that took keeps what is left to do (first-run-3)", async () => {
    const check = { id: "accessibility", label: "Screen reading", status: "warn", detail: "Accessibility is off.", fix: "enable-accessibility" };
    const p = await open({ agent: readyAgent(), checks: [check] });
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    const fix = p.locator("#w-checks [data-fix='enable-accessibility']");
    await fix.click();
    await fail(p, "fix", "Permission denied.");
    const row = p.locator("#w-checks .w-check-fail");
    await expect.poll(() => row.innerText()).toContain("couldn't change it");
    expect(await row.isVisible()).toBe(true);
    // Still announced, and the retry button is back, enabled and focused. Read out only: the row shows it (first-run-r2).
    expect(await p.locator("#w-checks-msg").innerText()).toContain("couldn't change it");
    expect(await seen(p, "#w-checks-msg")).toBe(false);
    expect(await fix.getAttribute("aria-disabled")).toBeNull();
    expect(await p.evaluate(() => document.activeElement?.getAttribute("data-fix"))).toBe("enable-accessibility");
    await fix.click();
    await expect.poll(async () => (await calls(p)).filter(c => c.startsWith("fix:")).length).toBe(2);
    // A new attempt clears the old failure from the row until it fails again.
    expect(await p.locator("#w-checks .w-check-fail").count()).toBe(0);
    await settle(p, "fix", { checks: [{ ...check, status: "ok", detail: "On. Restart apps that were already open, or log out and in, so Ember can read them.", next: true }], versions: {} }, 1);
    await expect.poll(() => p.locator("#w-checks .w-check-fail").count()).toBe(0);
    // It took, and the restart it still needs stays on the step, not only in the closed details (first-run-3).
    await expect.poll(() => p.locator("#w-checks-head").innerText()).toBe("Ready, with one thing left for you to do.");
    expect(await p.locator("#w-checks").isVisible()).toBe(true);
    expect(await p.locator("#w-checks").innerText()).toContain("Restart apps that were already open");
    expect(await p.locator("#w-checks [data-fix='enable-accessibility']").count()).toBe(0);
  });

  it("(h) Back while the card's yes is on its way: the provider is turned off again and nothing is tested", async () => {
    const p = await open({ slowAgree: true });
    await p.getByRole("button", { name: "Use my own provider" }).click();
    await p.fill("#w-p-url", "https://api.example.com/v1");
    await p.fill("#w-p-key", "sk-x");
    await p.fill("#w-p-conductor", "gpt-4.1");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).some(c => c.startsWith("agree:"))).toBe(true);
    await p.locator("#w-back").click();
    await settle(p, "agree", { ok: true });
    await expect.poll(async () => (await calls(p)).some(c => c === `save:${JSON.stringify({ provider: { on: false } })}`)).toBe(true);
    expect(await calls(p)).not.toContain("test");
    expect(await p.evaluate(() => window.__frState.settings.provider.on)).toBe(false);
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
  });

  it("(i) Home's connection area leads an entitlement failure with the provider, never with signing in (FE #3)", async () => {
    const p = await open({ home: true, agent: { ...SIGNED_OUT, phase: "error", reason: "no-access", detail: "Copilot isn't available to this account." } });
    const shown = (id: string) => p.evaluate(i => !(document.getElementById(i) as HTMLElement).hidden, id);
    await expect.poll(() => shown("own-provider")).toBe(true);
    expect(await shown("sign-in")).toBe(false);
    expect(await shown("switch-account")).toBe(true);
    expect(await shown("retry")).toBe(true);
    expect(await p.locator("#own-provider").getAttribute("class")).not.toContain("quiet");
    expect(await p.locator("#connection-help").innerText()).toContain("github.com/features/copilot");
    // Where the organisation forbids a provider of one's own: a different account leads.
    const q = await open({ home: true, agent: { ...SIGNED_OUT, phase: "error", reason: "no-access", detail: "Copilot is disabled by your organisation's policy." }, admin: { features: { userProvider: false } } });
    await expect.poll(() => q.evaluate(() => !(document.getElementById("switch-account") as HTMLElement).hidden)).toBe(true);
    expect(await q.evaluate(() => (document.getElementById("own-provider") as HTMLElement).hidden)).toBe(true);
    expect(await q.evaluate(() => (document.getElementById("sign-in") as HTMLElement).hidden)).toBe(true);
    expect(await q.locator("#connection-help").innerText()).toContain("administrator");
    // A plain signed-out Copilot still signs in first.
    const r = await open({ home: true });
    await expect.poll(() => r.evaluate(() => !(document.getElementById("sign-in") as HTMLElement).hidden)).toBe(true);
    expect(await r.locator("#connection-help").isVisible()).toBe(false);
  });

  it("(s) Home explains a failing own provider as the provider's: its details lead, with no GitHub account or Copilot words (integrations-3)", async () => {
    const p = await open({ home: true, provider: { on: true, baseUrl: "https://api.example.com/v1" }, agent: { ...SIGNED_OUT, phase: "error", reason: "models", detail: "Enter the model your provider should use in Ember's settings, under Models & connections.", service: { kind: "user", host: "api.example.com" } } });
    const shown = (id: string) => p.evaluate(i => !(document.getElementById(i) as HTMLElement).hidden, id);
    await expect.poll(() => shown("provider-details")).toBe(true);
    expect(await p.locator("#provider-details").getAttribute("class")).not.toContain("quiet");
    for (const id of ["own-provider", "switch-account", "sign-in", "connection-help"]) expect(await shown(id), id).toBe(false);
    expect(await shown("retry")).toBe(true);
    // The status panel's connect button names the provider's details, never Copilot (first-run-r1).
    expect(await shown("p-connect")).toBe(true);
    expect(await p.locator("#p-connect").textContent()).toBe("Check my provider…");
    await p.locator("#provider-details").click();
    expect(await focusedId(p)).toBe("byok-conductor");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(ab) Check again under a failing own provider says it checked the provider, never that no GitHub sign-in was found (integrations-c1-1)", async () => {
    const service = { kind: "user", host: "127.0.0.1:18408" };
    const down = { ...SIGNED_OUT, phase: "error", reason: "network", detail: "Ember can't reach the model server on this computer (127.0.0.1:18408). Start it, and Ember will connect in a moment.", service };
    const p = await open({ home: true, provider: { on: true, baseUrl: "http://127.0.0.1:18408/v1" }, agent: down });
    await expect.poll(() => p.locator("#retry").isVisible()).toBe(true);
    await p.locator("#retry").click();
    await settle(p, "retry", { found: false, source: null, provider: { host: "127.0.0.1:18408", ready: false } });
    await expect.poll(() => p.locator("#sign-in-msg").innerText()).toBe("Checked again: Ember still can't connect to 127.0.0.1:18408.");
    // The server started and the background retry connected: the line goes, rather than sit under Connected.
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, readyAgent({ login: undefined, detail: "Connected to 127.0.0.1:18408.", service }));
    await expect.poll(() => p.locator("#sign-in-msg").isVisible()).toBe(false);
    // Pressed once it connects: the status line says Connected, and nothing beside it names GitHub.
    await p.locator("#retry").evaluate(b => (b as HTMLButtonElement).click());
    await settle(p, "retry", { found: false, source: null, provider: { host: "127.0.0.1:18408", ready: true } }, 1);
    await expect.poll(() => p.locator("#sign-in-msg").isVisible()).toBe(false);
    expect(await p.locator("#sign-in-msg").innerText()).not.toMatch(/GitHub|gh auth/);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(al) Home's status panel says Ember reconnects when its own model connection stopped under my provider, and once it gave up points to Models & connections, never my provider's details (accessibility-visual-c1-2)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const crashed = { ...SIGNED_OUT, phase: "error", reason: "runtime", detail: "Ember's model connection stopped unexpectedly. Reconnecting…", service };
    const p = await open({ home: true, provider: { on: true, baseUrl: "https://api.example.com/v1" }, agent: crashed });
    const text = (id: string) => p.evaluate(i => document.getElementById(i)?.textContent ?? "", id);
    const connect = () => p.evaluate(() => { const b = document.getElementById("p-connect")!; return { hidden: b.hidden, text: b.textContent }; });
    // Before: "Not connected", "Ember can't connect to your model provider yet…" and "Check my provider…", while the
    // handle and the Ask box said "Reconnecting…".
    await expect.poll(() => text("state-word")).toBe("Reconnecting…");
    expect(await p.evaluate(() => document.getElementById("ring")?.dataset.ring)).toBe("starting");
    expect(await text("tagline")).toBe("Beside your cursor. Reconnecting to your model provider…");
    expect(await connect()).toEqual({ hidden: false, text: "Models & connections…" });
    // It gave up: not connected, with the way to Check again, still never the provider's details.
    await emit(p, "onAgentStatus", { ...crashed, detail: "Ember's model connection keeps stopping. Press Check again to retry, or restart Ember." });
    await expect.poll(() => text("state-word")).toBe("Not connected");
    expect(await text("tagline")).toBe("Beside your cursor. Ember's model connection isn't running: Models & connections says why.");
    expect(await connect()).toEqual({ hidden: false, text: "Models & connections…" });
    // The provider itself refusing is still the provider's, as before (first-run-r1).
    await emit(p, "onAgentStatus", { ...crashed, reason: "models", detail: "Enter the model your provider should use in Ember's settings, under Models & connections." });
    await expect.poll(() => connect()).toEqual({ hidden: false, text: "Check my provider…" });
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(ae) while my own provider's note waits for a new address with no GitHub sign-in, Models & connections points to the note, not to a GitHub sign-in (integrations-c2-3)", async () => {
    const signedOut = { ...SIGNED_OUT, detail: "Not connected to Copilot: sign in with GitHub below." };
    const p = await open({ home: true, provider: { on: true, baseUrl: "http://127.0.0.1:18409/v1" }, agent: signedOut });
    const shown = (id: string) => p.locator(`#${id}`).isVisible();
    await expect.poll(() => shown("byok-consent")).toBe(true);
    await expect.poll(() => p.locator("#agent-text").innerText()).toBe("Not connected: Ember is waiting for you to agree to use 127.0.0.1:18409.");
    expect(await p.locator("#connection-help").innerText()).toBe("Agree in the note under Model provider below, or turn off “Use my own model provider” to use GitHub Copilot instead.");
    for (const id of ["sign-in", "own-provider", "retry", "switch-account", "provider-details"]) expect(await shown(id), id).toBe(false);
    // The card's I agree is the one prominent button in view.
    expect(await p.locator(".copilot .btn:not(.quiet):visible, #byok .btn:not(.quiet):visible").count()).toBe(1);
    // Nor does the rest of Home point to Copilot: the hint, the tagline and the status panel's button (integrations-r3-1).
    expect(await p.locator("#byok-hint").innerText()).toBe("Ember can't answer until you agree to use 127.0.0.1:18409.");
    expect(await p.evaluate(() => document.getElementById("tagline")?.textContent)).toBe("Beside your cursor. Agree to use 127.0.0.1:18409 in Models & connections to start asking.");
    expect(await p.evaluate(() => document.getElementById("p-connect")?.textContent)).toBe("Check my provider…");
    await p.locator("#byok-no").click();
    await expect.poll(() => shown("byok-consent")).toBe(false);
    await expect.poll(() => shown("sign-in")).toBe(true);
    expect(await p.locator("#agent-text").innerText()).toBe(signedOut.detail);
    expect(await shown("own-provider")).toBe(true);
    expect(await shown("connection-help")).toBe(false);
    expect(await p.evaluate(() => document.getElementById("tagline")?.textContent)).toBe("Beside your cursor. Connect Copilot to start asking.");
    expect(await p.evaluate(() => document.getElementById("p-connect")?.textContent)).toBe("Connect Copilot…");
    // Turned on again with no address yet: no note, so signing in leads, and the switch already on isn't offered.
    await p.evaluate(() => { const s = window.__frState.settings as { provider: Record<string, unknown> }; s.provider = { ...s.provider, on: true, baseUrl: "" }; window.__frEmit("onSettingsChanged", s); });
    await expect.poll(() => shown("own-provider")).toBe(false);
    expect(await shown("sign-in")).toBe(true);
    expect(await shown("byok-consent")).toBe(false);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(ad) Check again under an own provider with no model named says it still can't use it, never that it can't connect (integrations-c2-2)", async () => {
    const service = { kind: "user", host: "127.0.0.1:18408" };
    const noModel = { ...SIGNED_OUT, phase: "error", reason: "models", detail: "Enter the model your provider should use in Ember's settings, under Models & connections.", service };
    const p = await open({ home: true, provider: { on: true, baseUrl: "http://127.0.0.1:18408/v1" }, agent: noModel });
    await expect.poll(() => p.locator("#retry").isVisible()).toBe(true);
    await p.locator("#retry").click();
    await settle(p, "retry", { found: false, source: null, provider: { host: "127.0.0.1:18408", ready: false, reason: "models" } });
    await expect.poll(() => p.locator("#sign-in-msg").innerText()).toBe("Checked again: Ember still can't use 127.0.0.1:18408. The line above says why.");
    expect(await p.locator("#agent-text").innerText()).toBe(noModel.detail);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(v) Home says the provider's note came up when the endpoint is entered, and why Test connection waits (integrations-7, WCAG 4.1.3)", async () => {
    const p = await open({ home: true, provider: { on: true, baseUrl: "" } });
    const test = p.locator("#byok-test");
    await expect.poll(() => test.isVisible()).toBe(true);
    expect(await test.isDisabled()).toBe(true);
    expect(await test.getAttribute("aria-describedby")).toBe("byok-test-why");
    expect(await p.locator("#byok-test-why").innerText()).toBe("Enter the endpoint to test it.");
    await p.locator("#byok-url").fill("http://127.0.0.1:18108/v1");
    await p.keyboard.press("Tab");
    // Focus moved on to the next field while the card came up above: it is said, in the status line.
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(true);
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe("Read the note above: Ember sends nothing to 127.0.0.1:18108 until you agree.");
    expect(await p.locator("#byok-msg").getAttribute("role")).toBe("status");
    expect(await focusedId(p)).not.toBe("byok-url");
    expect(await test.isDisabled()).toBe(true);
    expect(await p.locator("#byok-test-why").innerText()).toBe("Test connection works once you agree to the note above for 127.0.0.1:18108.");
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await p.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "byok-card-announced.png"), fullPage: true });
    }
    // Agreed: the line no longer says nothing goes there until then (integrations-r4).
    await p.waitForTimeout(AGREE_ARM_MS + 100);
    await p.locator("#byok-yes").click();
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(false);
    expect(await calls(p)).toContain("agree:127.0.0.1:18108");
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe("Agreed. Ember now sends your requests to 127.0.0.1:18108.");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(aj) Home holds an edit of my provider in use to another host until its note is agreed and it answers: requests stay with the one in use, and a failed check or Keep using changes nothing (integrations-c3-1)", async () => {
    const using = "127.0.0.1:18308";
    const service = { kind: "user", host: using };
    const p = await open({ home: true, liveState: true, agent: readyAgent({ login: undefined, service, detail: `Connected to your own provider (${using}).` }), provider: { on: true, baseUrl: `http://${using}/v1`, conductor: "mock-model", consent: { version: 1, at: "2026-11-08T12:00:00Z", host: using } } });
    await expect.poll(() => p.locator("#byok-hint").innerText()).toBe(`Ember sends your requests to ${using} instead of Copilot. A change applies from your next message; tasks already running finish where they started.`);
    const saves = async () => (await calls(p)).filter(c => c.startsWith("save:"));
    const provider = () => p.evaluate(() => window.__frState.settings.provider as { baseUrl: string; conductor: string | null; consent: { host: string } });
    // Another port: held, never saved, so the provider in use stays in force; the note comes up for the new host.
    await p.locator("#byok-url").fill("http://127.0.0.1:18309/v1");
    await p.keyboard.press("Tab");
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(true);
    expect(await p.locator("#byok-consent-text").innerText()).toContain("to 127.0.0.1:18309 instead");
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe(`Read the note above: Ember still uses ${using}, and sends nothing to 127.0.0.1:18309 until you agree.`);
    expect(await p.locator("#byok-hint").innerText()).toBe(`Ember still uses ${using}. Agree to use 127.0.0.1:18309 to switch.`);
    expect(await p.locator("#byok-no").innerText()).toBe(`Keep using ${using}`);
    expect(await p.locator("#byok-test").isDisabled()).toBe(true);
    // A model typed meanwhile is held with it.
    await p.locator("#byok-conductor").fill("other-model");
    await p.keyboard.press("Tab");
    expect(await saves()).toEqual([]);
    expect(await provider()).toMatchObject({ baseUrl: `http://${using}/v1`, conductor: "mock-model", consent: { host: using } });
    // I agree asks the new details first; nothing answers there: nothing has changed, and the address takes the focus.
    await p.waitForTimeout(AGREE_ARM_MS + 100);
    await p.locator("#byok-yes").click();
    await expect.poll(() => calls(p)).toContain("test-draft:127.0.0.1:18309");
    expect(await p.locator("#byok-msg").innerText()).toBe("Checking 127.0.0.1:18309…");
    expect(await p.locator("#byok-yes").getAttribute("aria-disabled")).toBe("true");
    await settle(p, "test", { ok: false, why: "Ember can't reach 127.0.0.1:18309. Check the address and the network.", cause: "refused" });
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe(`Ember can't reach 127.0.0.1:18309. Check the address and the network. Nothing has changed: Ember still uses ${using}.`);
    expect(await focusedId(p)).toBe("byok-url");
    expect(await p.locator("#byok-consent").isVisible()).toBe(true);
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      for (const scheme of ["light", "dark"] as const) {
        await p.emulateMedia({ colorScheme: scheme });
        await p.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `byok-held-${scheme}.png`), fullPage: true });
      }
    }
    expect(await saves()).toEqual([]);
    expect((await calls(p)).filter(c => c.startsWith("agree:"))).toEqual([]);
    expect(await provider()).toMatchObject({ baseUrl: `http://${using}/v1`, conductor: "mock-model", consent: { host: using } });
    // Again, and it answers: the details and the yes are saved together, and the note goes.
    await p.locator("#byok-yes").click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "test-draft:127.0.0.1:18309").length).toBe(2);
    await settle(p, "test", { ok: true, host: "127.0.0.1:18309", models: 1, ids: ["other-model"] }, 1);
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe("Agreed. Ember now sends your requests to 127.0.0.1:18309.");
    expect(await calls(p)).toContain("agree:127.0.0.1:18309");
    expect(await calls(p)).toContain(`move:${JSON.stringify({ type: "openai", baseUrl: "http://127.0.0.1:18309/v1", conductor: "other-model", worker: null, wireApi: null, azureApiVersion: null })}`);
    expect(await saves()).toEqual([]);
    expect(await provider()).toMatchObject({ baseUrl: "http://127.0.0.1:18309/v1", conductor: "other-model", consent: { host: "127.0.0.1:18309" } });
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(false);
    expect(await focusedId(p)).toBe("byok-url");
    // Another edit, put away with Keep using: the address in use comes back, nothing is asked or saved.
    await p.locator("#byok-url").fill("http://127.0.0.1:18310/v1");
    await p.keyboard.press("Tab");
    await expect.poll(() => p.locator("#byok-no").innerText()).toBe("Keep using 127.0.0.1:18309");
    await p.locator("#byok-no").click();
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(false);
    expect(await p.locator("#byok-url").inputValue()).toBe("http://127.0.0.1:18309/v1");
    expect(await p.locator("#byok-msg").innerText()).toBe("Nothing has changed: Ember still uses 127.0.0.1:18309.");
    expect(await focusedId(p)).toBe("byok-url");
    expect(await p.locator("#byok-on").isChecked()).toBe(true);
    expect((await calls(p)).filter(c => c.startsWith("test-draft:127.0.0.1:18310"))).toEqual([]);
    expect(await saves()).toEqual([]);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(ak) turning my provider off while an edit of it is held keeps the one in use, its address and its key, and its note never says turning off goes back to Copilot (integrations-v4-1)", async () => {
    const using = "127.0.0.1:18308";
    const service = { kind: "user", host: using };
    const p = await open({ home: true, liveState: true, providerState: { keySaved: true }, agent: readyAgent({ login: undefined, service, detail: `Connected to your own provider (${using}).` }), provider: { on: true, baseUrl: `http://${using}/v1`, conductor: "mock-model", consent: { version: 1, at: "2026-11-08T12:00:00Z", host: using } } });
    await expect.poll(() => p.locator("#byok-key-saved").isVisible()).toBe(true);
    const saves = async () => (await calls(p)).filter(c => c.startsWith("save:"));
    const provider = () => p.evaluate(() => window.__frState.settings.provider as { on: boolean; baseUrl: string; consent: { host: string } });
    // An edit to another host is held: its note says what goes there, and nothing about turning the switch off, which
    // keeps the provider in use (as first run's step for it does).
    await p.locator("#byok-url").fill("http://127.0.0.1:18309/v1");
    await p.keyboard.press("Tab");
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(true);
    expect(await p.locator("#byok-consent-text").innerText()).toMatch(/goes only to 127\.0\.0\.1:18309\.$/);
    expect(await p.locator("#byok-consent-text").innerText()).not.toMatch(/Copilot\.$|Turn this off/);
    expect(await p.locator("#byok-no").innerText()).toBe(`Keep using ${using}`);
    await p.locator("#byok-key").fill("sk-typed-for-the-new-host");
    // Off: only the switch is saved; the address in use and its key stay, and nothing goes to the new host.
    await p.locator("#byok-on").click();
    await expect.poll(saves).toEqual([`save:${JSON.stringify({ provider: { on: false } })}`]);
    expect(await provider()).toMatchObject({ on: false, baseUrl: `http://${using}/v1`, consent: { host: using } });
    expect(await p.evaluate(() => window.emberProvider!.state().then(s => s.keySaved))).toBe(true);
    expect((await calls(p)).filter(c => c.startsWith("test-draft:") || c.startsWith("agree:") || c === "saveKey")).toEqual([]);
    // On again: the provider that was in use, as it was, with no note to agree to again and its key still saved.
    await p.locator("#byok-on").click();
    await expect.poll(() => p.locator("#byok-hint").innerText()).toBe(`Ember sends your requests to ${using} instead of Copilot. A change applies from your next message; tasks already running finish where they started.`);
    expect(await p.locator("#byok-consent").isVisible()).toBe(false);
    expect(await p.locator("#byok-url").inputValue()).toBe(`http://${using}/v1`);
    expect(await p.locator("#byok-key-saved").isVisible()).toBe(true);
    expect(await p.locator("#byok-key").inputValue()).toBe("");
    expect(await saves()).toEqual([`save:${JSON.stringify({ provider: { on: false } })}`, `save:${JSON.stringify({ provider: { on: true } })}`]);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(x) Test connection names the provider's models and offers them in both model fields (integrations-9)", async () => {
    const consent = { version: 1, at: "2026-11-07T12:00:00Z", host: "127.0.0.1:11434" };
    const p = await open({ home: true, provider: { on: true, baseUrl: "http://127.0.0.1:11434/v1", consent } });
    const test = p.locator("#byok-test");
    await expect.poll(() => test.isDisabled()).toBe(false);
    expect(await p.locator("#byok-test-why").isVisible()).toBe(false);
    await test.click();
    await settle(p, "test", { ok: true, host: "127.0.0.1:11434", models: 3, ids: ["llama3.2:3b", "qwen2.5:7b", "phi4"] });
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe("Connected to 127.0.0.1:11434. It lists 3 models, such as llama3.2:3b and qwen2.5:7b.");
    expect(await p.locator("#byok-models option").evaluateAll(os => os.map(o => (o as HTMLOptionElement).value))).toEqual(["llama3.2:3b", "qwen2.5:7b", "phi4"]);
    expect(await p.locator("#byok-conductor").getAttribute("list")).toBe("byok-models");
    expect(await p.locator("#byok-worker").getAttribute("list")).toBe("byok-models");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(w) Home's key row on a computer with no keyring says how to get one (integrations-13)", async () => {
    const p = await open({ home: true, provider: { on: true, baseUrl: "https://api.example.com/v1" }, providerState: { keyring: false } });
    await expect.poll(() => p.locator("#byok-no-keyring").isVisible()).toBe(true);
    expect(await p.locator("#byok-no-keyring").innerText()).toBe("This computer has no keyring for passwords, so Ember can't keep a key safely here. Set up a keyring (GNOME Keyring or KWallet), then come back to save one. A model server on this computer that needs no key still works.");
    expect(await p.locator("#byok-key-form").isVisible()).toBe(false);
  });

  it("(j) Copilot's own default is reviewed as Copilot's, not as an inactive provider's models (FE #4)", async () => {
    const p = await open({ agent: readyAgent({ models: [], conductorModel: null, workerModel: null }), provider: { on: false, conductor: "gpt-own-a", worker: "gpt-own-b" } });
    await expect.poll(() => p.locator("#w-models").isVisible()).toBe(true);
    const list = await p.locator("#w-models-list").innerText();
    expect(list).toContain("The default model");
    expect(list).not.toContain("gpt-own");
    // Nothing to choose from: no Change button and no empty selectors.
    expect(await p.locator("#w-models-change").isVisible()).toBe(false);
  });

  it("(k) a setup fix pending keeps its button disabled when an earlier failure is cleared (FE #6)", async () => {
    const check = { id: "accessibility", label: "Screen reading", status: "warn", detail: "Accessibility is off.", fix: "enable-accessibility" };
    const p = await open({ agent: readyAgent(), checks: [check] });
    await next(p).click();
    const fix = p.locator("#w-checks [data-fix='enable-accessibility']");
    await fix.click();
    await fail(p, "fix", "Permission denied.");
    await expect.poll(() => p.locator("#w-checks .w-check-fail").count()).toBe(1);
    await fix.click();
    await expect.poll(async () => (await calls(p)).filter(c => c.startsWith("fix:")).length).toBe(2);
    expect(await fix.getAttribute("aria-disabled")).toBe("true");
    await fix.click({ force: true });
    await p.waitForTimeout(100);
    expect((await calls(p)).filter(c => c.startsWith("fix:")).length).toBe(2);
  });

  it("(l) Back while the card's yes is on its way and the switch-off cannot be saved: the provider is still on, says so, and a retry switches it off (PR #191 re-review)", async () => {
    const p = await open({ slowAgree: true, failOff: true });
    await p.getByRole("button", { name: "Use my own provider" }).click();
    await p.fill("#w-p-url", "https://api.example.com/v1");
    await p.fill("#w-p-key", "sk-x");
    await p.fill("#w-p-conductor", "gpt-4.1");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).some(c => c.startsWith("agree:"))).toBe(true);
    await p.locator("#w-back").click();
    await settle(p, "agree", { ok: true });
    await expect.poll(() => p.locator("#provider-off").isVisible()).toBe(true);
    expect(await p.locator("#provider-off").innerText()).toContain("still on");
    expect(await p.evaluate(() => window.__frState.settings.provider.on)).toBe(true);
    await p.evaluate(() => { window.__frFailOff = false; });
    await p.locator("#provider-off-retry").click();
    await expect.poll(() => p.evaluate(() => window.__frState.settings.provider.on)).toBe(false);
    await expect.poll(() => p.locator("#provider-off").isVisible()).toBe(false);
  });

  it("(n) reopened with the user's own provider in force, the sign-in step names it and Back from the checks returns to it (first-run-1)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const p = await open({ agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service }), provider: { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1" } });
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toBe("Using your own provider (api.example.com).");
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider");
    expect(await p.locator("#w-lead").innerText()).toContain("api.example.com");
    for (const id of ["#w-title", "#w-lead", "#w-signin-line"]) expect(await p.locator(id).innerText(), id).not.toContain("Copilot");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider's details");
    expect(await p.inputValue("#w-p-url")).toBe("https://api.example.com/v1");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(aa) a provider already in use is shown as in use on its step, and only “Use GitHub Copilot instead” switches it off (first-run-c1-2)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const inForce = { inForce: true, host: "api.example.com", agreed: true, keySaved: true };
    const p = await open({ provider, providerState: inForce, agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service }) });
    const off = `save:${JSON.stringify({ provider: { on: false } })}`;
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    // In use: connected, nothing to agree to again, Continue goes on without a check.
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider's details");
    expect(await p.locator("#w-lead").innerText()).toBe("I'm using the model provider you set up (api.example.com) instead of GitHub Copilot. You can change its details here.");
    expect(await p.locator("#w-p-result").innerText()).toBe("Using your own provider (api.example.com).");
    expect(await p.locator("#w-p-consent").innerText()).not.toMatch(/Back takes you|Turn this off/);
    expect(await next(p).innerText()).toBe("Continue");
    expect(await next(p).getAttribute("aria-disabled")).toBeNull();
    expect(await p.locator("#w-alt").innerText()).toBe("Use GitHub Copilot instead");
    // Back goes back and leaves it on.
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider");
    await p.waitForTimeout(100);
    expect(await calls(p)).not.toContain(off);
    expect(await p.evaluate(() => window.__frState.settings.provider.on)).toBe(true);
    // Continue from its step checks nothing and agrees to nothing again.
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    expect((await calls(p)).filter(c => c === "test" || c.startsWith("agree:"))).toEqual([]);
    // An edit is checked before it counts, and leaves the provider in use until then.
    await p.locator("#w-back").click();
    await p.fill("#w-p-conductor", "gpt-4.1-mini");
    expect(await next(p).innerText()).toBe("Agree and check the models");
    await p.waitForTimeout(100);
    expect(await calls(p)).not.toContain(off);
    // The saved key is said only for the address it was saved for: another one asks for its own (first-run follow-up:
    // key placeholder).
    expect(await p.getAttribute("#w-p-key", "placeholder")).toBe("A key is saved. Paste a new one to replace it");
    await p.fill("#w-p-url", "https://api2.example.com/v1");
    expect(await p.getAttribute("#w-p-key", "placeholder")).toBe("Paste your key");
    await p.fill("#w-p-url", "https://api.example.com/v1");
    expect(await p.getAttribute("#w-p-key", "placeholder")).toBe("A key is saved. Paste a new one to replace it");
    // Left unchecked, the edit isn't shown as the details in use on the next visit.
    await p.locator("#w-back").click();
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    expect(await p.inputValue("#w-p-conductor")).toBe("gpt-4.1");
    expect(await p.locator("#w-p-result").innerText()).toBe("Using your own provider (api.example.com).");
    // The one way back to Copilot from here says so, and switches it off.
    await p.locator("#w-alt").click();
    await expect.poll(() => calls(p)).toContain(off);
    expect(await p.locator("#welcome").getAttribute("data-step")).toBe("sign-in");
    // Failing: its details, opened from the sign-in step, show the connection's own words, as mine (first-run-r4-2);
    // Back leaves it on.
    const detail = "Ember can't reach the model server on this computer (localhost:11434). Start it, and Ember will connect in a moment.";
    const mine = "I can't reach the model server on this computer (localhost:11434). Start it, and I'll connect in a moment.";
    const local = { ...provider, baseUrl: "http://localhost:11434/v1", consent: { ...provider.consent, host: "localhost:11434" } };
    const q = await open({ provider: local, providerState: { ...inForce, host: "localhost:11434", keySaved: false }, agent: { ...SIGNED_OUT, phase: "error", reason: "network", detail, service: { kind: "user", host: "localhost:11434" } } });
    await expect.poll(() => buttons(q)).toContain("Check my provider's details");
    await q.getByRole("button", { name: "Check my provider's details" }).click();
    expect(await q.locator("#w-title").innerText()).toBe("Your own model provider's details");
    expect(await q.locator("#w-p-result").innerText()).toBe(mine);
    expect(await q.locator("#w-lead").innerText()).not.toContain("Nothing is sent");
    await q.locator("#w-back").click();
    expect(await q.locator("#w-title").innerText()).toBe("Your own model provider");
    await q.waitForTimeout(100);
    expect(await calls(q)).not.toContain(off);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    expect((q as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(ac) an edit of a provider in use is checked before it replaces the details that work: a slip, a failed check, Back or Copilot while it checks leave it in use as it was (first-run-r2-1)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const inForce = { inForce: true, host: "api.example.com", agreed: true, keySaved: true };
    const off = `save:${JSON.stringify({ provider: { on: false } })}`;
    const lead = "I'm using the model provider you set up (api.example.com) instead of GitHub Copilot. You can change its details here.";
    const inUse = async () => {
      const p = await open({ provider, providerState: inForce, agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service }) });
      await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
      await next(p).click();
      await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
      await p.locator("#w-back").click();
      expect(await p.locator("#w-title").innerText()).toBe("Your own model provider's details");
      return p;
    };
    const kept = (p: Page) => p.evaluate(() => ({ on: window.__frState.settings.provider.on, baseUrl: window.__frState.settings.provider.baseUrl }));
    const working = { on: true, baseUrl: "https://api.example.com/v1" };
    const changed = (p: Page) => calls(p).then(c => c.filter(x => x.startsWith("save:") || x === "saveKey" || x.startsWith("agree:") || x === "test"));

    // A slip: a field cleared and the button pressed says what to fill; typing it back switches nothing off.
    const a = await inUse();
    await a.fill("#w-p-conductor", "");
    await next(a).click();
    expect(await a.locator("#w-p-result").innerText()).toBe("Enter the name of a model first.");
    await a.fill("#w-p-conductor", "gpt-4.1");
    await a.waitForTimeout(100);
    expect(await changed(a)).toEqual([]);
    expect(await kept(a)).toEqual(working);
    expect(await a.locator("#w-lead").innerText()).toBe(lead);

    // A new address whose check fails: checked as typed, nothing saved or agreed, and the step says it kept the old one.
    const b = await inUse();
    await b.fill("#w-p-url", "https://api2.example.com/v1");
    await b.fill("#w-p-key", "sk-new-not-real");
    await next(b).click();
    await expect.poll(() => calls(b)).toContain("test-draft:api2.example.com+key");
    expect(await changed(b)).toEqual([]);
    await settle(b, "test", { ok: false, why: "Ember can't reach api2.example.com. Check the address and the network.", cause: "unreachable" });
    await expect.poll(() => b.locator("#w-p-result").innerText()).toBe("I can't reach api2.example.com. Check the address and the network. Nothing has changed: I'm still using api.example.com.");
    // The failure names the address, so the address takes the focus.
    expect(await focusedId(b)).toBe("w-p-url");
    await b.waitForTimeout(100);
    expect(await changed(b)).toEqual([]);
    expect(await kept(b)).toEqual(working);
    expect(await b.locator("#w-lead").innerText()).toBe(lead);
    // A refused key names the key.
    await b.fill("#w-p-url", "https://api.example.com/v1");
    await next(b).click();
    await expect.poll(async () => (await calls(b)).filter(c => c.startsWith("test-draft:")).length).toBe(2);
    await settle(b, "test", { ok: false, why: "api.example.com didn't accept the API key. Check it, or replace it." }, 1);
    await expect.poll(() => focusedId(b)).toBe("w-p-key");
    // Back to the sign-in step: still my provider, never "Sign in to GitHub".
    await b.locator("#w-back").click();
    expect(await b.locator("#w-title").innerText()).toBe("Your own model provider");
    expect(await changed(b)).toEqual([]);

    // Back while the check runs: whatever it answers later, nothing changes.
    const c = await inUse();
    await c.fill("#w-p-key", "sk-another-not-real");
    await next(c).click();
    await expect.poll(() => calls(c)).toContain("test-draft:api.example.com+key");
    await c.locator("#w-back").click();
    await settle(c, "test", { ok: true, host: "api.example.com", models: 3 });
    await c.waitForTimeout(200);
    expect(await changed(c)).toEqual([]);
    expect(await kept(c)).toEqual(working);
    expect(await c.locator("#w-title").innerText()).toBe("Your own model provider");

    // “Use GitHub Copilot instead” while it checks switches it off, and a late answer turns nothing on again.
    const d = await inUse();
    await d.fill("#w-p-url", "https://api2.example.com/v1");
    await next(d).click();
    await expect.poll(() => calls(d)).toContain("test-draft:api2.example.com");
    await d.locator("#w-alt").click();
    await expect.poll(() => calls(d)).toContain(off);
    await settle(d, "test", { ok: true, host: "api2.example.com", models: 1 });
    await d.waitForTimeout(200);
    expect((await calls(d)).filter(x => x.startsWith("agree:") || x === "saveKey")).toEqual([]);
    expect(await d.evaluate(() => window.__frState.settings.provider.on)).toBe(false);

    // Details that answer replace the old ones: written with the card's yes for the new host in one change, so the
    // provider in use never leaves force for Copilot between (first-run-r4-3), then the key for it.
    const e = await inUse();
    await e.fill("#w-p-url", "https://api2.example.com/v1");
    await e.fill("#w-p-key", "sk-good-not-real");
    await next(e).click();
    await expect.poll(() => calls(e)).toContain("test-draft:api2.example.com+key");
    await settle(e, "test", { ok: true, host: "api2.example.com", models: 2 });
    await expect.poll(() => e.locator("#w-p-result").innerText()).toBe("Connected to api2.example.com. It lists 2 models.");
    expect(await changed(e)).toEqual(["agree:api2.example.com", "saveKey"]);
    expect(await calls(e)).toContain(`move:${JSON.stringify({ type: "openai", baseUrl: "https://api2.example.com/v1", conductor: "gpt-4.1", worker: null })}`);
    expect(await kept(e)).toEqual({ on: true, baseUrl: "https://api2.example.com/v1" });
    expect(await calls(e)).not.toContain(off);

    // Switched off by any other way while its step shows: the step no longer says it is in use.
    const f = await inUse();
    await f.evaluate(() => { window.__frState.settings.provider = { ...window.__frState.settings.provider, on: false }; window.__frEmit("onSettingsChanged", window.__frState.settings); });
    await expect.poll(() => f.locator("#w-lead").innerText()).not.toContain("I'm using");
    for (const page of [a, b, c, d, e, f]) expect((page as Page & { errors: string[] }).errors).toEqual([]);
  }, 30_000);

  it("(af) after “Use GitHub Copilot instead”, my provider's step opened again isn't in use: a failed check switches it off, never says “I'm using” it, and Back is Copilot's sign-in (first-run-r3-1)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const off = `save:${JSON.stringify({ provider: { on: false } })}`;
    const p = await open({ provider, liveState: true, providerState: { keySaved: true }, agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service }) });
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider's details");
    await p.locator("#w-alt").click();
    await expect.poll(() => calls(p)).toContain(off);
    // The connection follows, as main's does: no Copilot sign-in yet.
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, SIGNED_OUT);
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    // No Copilot after all: my own provider again, as a step to set up, not one in use.
    await p.getByRole("button", { name: "Use my own provider" }).click();
    expect(await p.locator("#w-title").innerText()).toBe("Use your own model provider");
    expect(await p.locator("#w-alt").isHidden()).toBe(true);
    await p.fill("#w-p-url", "https://api3.example.com/v1");
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("test");
    expect(await calls(p)).not.toContain("test-draft:api3.example.com");
    const why = "Ember can't reach api3.example.com. Check the address and the network.";
    await settle(p, "test", { ok: false, why, cause: "unreachable" });
    // In my voice, as after a failed edit of the provider in use (first-run-r4-2).
    await expect.poll(() => p.locator("#w-p-result").innerText()).toBe("I can't reach api3.example.com. Check the address and the network.");
    // Not verified: nothing stays pointed at it, and nothing says it is in use.
    await expect.poll(() => p.evaluate(() => window.__frState.settings.provider.on)).toBe(false);
    expect((await calls(p)).lastIndexOf(off)).toBeGreaterThan((await calls(p)).indexOf("test"));
    expect(await p.locator("#w-title").innerText()).toBe("Use your own model provider");
    expect(await p.locator("#w-lead").innerText()).not.toContain("I'm using");
    // Back is the way to Copilot again.
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    expect(await next(p).innerText()).toBe("Sign in with GitHub");
    // Opened again, it goes on main's state as it is now: the key saved for the old address went with it.
    await p.getByRole("button", { name: "Use my own provider" }).click();
    expect(await p.inputValue("#w-p-url")).toBe("https://api3.example.com/v1");
    expect(await p.getAttribute("#w-p-key", "placeholder")).toBe("Paste your key");
    await next(p).click();
    expect(await p.locator("#w-p-result").innerText()).toBe("Paste the API key first.");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(ah) after a failed edit of my provider in use, “Keep using <host>” puts back the details in use and Continue, and changes nothing (first-run-c3-1)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const p = await open({ provider, providerState: { inForce: true, host: "api.example.com", agreed: true, keySaved: true }, agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service }) });
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    const keep = p.locator("#w-p-keep");
    expect(await keep.isHidden()).toBe(true);
    await p.fill("#w-p-url", "https://api2.example.com/v1");
    await p.fill("#w-p-key", "sk-new-not-real");
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("test-draft:api2.example.com+key");
    await settle(p, "test", { ok: false, why: "Ember can't reach api2.example.com. Check the address and the network.", cause: "unreachable" });
    // One voice, mine, and a way on with the details that work.
    await expect.poll(() => p.locator("#w-p-result").innerText()).toBe("I can't reach api2.example.com. Check the address and the network. Nothing has changed: I'm still using api.example.com.");
    expect(await keep.innerText()).toBe("Keep using api.example.com");
    expect(await next(p).innerText()).toBe("Check again");
    await keep.click();
    expect(await p.inputValue("#w-p-url")).toBe("https://api.example.com/v1");
    expect(await p.inputValue("#w-p-key")).toBe("");
    expect(await p.locator("#w-p-result").innerText()).toBe("Using your own provider (api.example.com).");
    expect(await next(p).innerText()).toBe("Continue");
    expect(await next(p).getAttribute("aria-disabled")).toBeNull();
    // The button went, so the focus is on the way on, not on the page.
    expect(await focusedId(p)).toBe("w-next");
    expect(await keep.isHidden()).toBe(true);
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    expect((await calls(p)).filter(c => c.startsWith("save:") || c === "saveKey" || c.startsWith("agree:") || c === "test")).toEqual([]);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(ag) “Use GitHub Copilot instead” draws Copilot's sign-in as the focus lands on its title, before the connection follows; one that can't be saved says my provider is still in use (first-run-c3-2)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const inForce = { inForce: true, host: "api.example.com", agreed: true, keySaved: true };
    const details = async (failOff = false) => {
      const p = await open({ provider, providerState: inForce, failOff, agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service }) });
      await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
      await next(p).click();
      await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
      await p.locator("#w-back").click();
      expect(await p.locator("#w-title").innerText()).toBe("Your own model provider's details");
      return p;
    };
    // What the step says the moment the press moves the focus (a screen reader reads it then), while main's status
    // still names my provider: the mock sends none of its own.
    const press = (p: Page) => p.evaluate(() => {
      document.getElementById("w-alt")!.click();
      const text = (id: string) => document.getElementById(id)!.textContent;
      return { focus: document.activeElement?.id, title: text("w-title"), lead: text("w-lead"), line: text("w-signin-line"), next: text("w-next"), why: text("w-why") };
    });
    const p = await details();
    const at = await press(p);
    expect(at).toEqual({ focus: "w-title", title: "Sign in to GitHub", lead: expect.not.stringContaining("you set up") as unknown as string, line: "Connecting to Copilot…", next: "Continue", why: "Still connecting to Copilot." });
    expect(await p.locator("#w-models").isHidden()).toBe(true);
    // Main's status follows: Copilot's sign-in, the focus still on the title.
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, SIGNED_OUT);
    await expect.poll(() => next(p).innerText()).toBe("Sign in with GitHub");
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    expect(await focusedId(p)).toBe("w-title");
    // A switch-off that couldn't be saved: my provider is still on and in use, and the step and the notice say so.
    const q = await details(true);
    expect((await press(q)).title).toBe("Sign in to GitHub");
    await expect.poll(() => q.locator("#provider-off").isVisible()).toBe(true);
    await expect.poll(() => q.locator("#w-title").innerText()).toBe("Your own model provider");
    expect(await q.locator("#w-signin-line").innerText()).toBe("Using your own provider (api.example.com).");
    for (const page of [p, q]) expect((page as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(al) Home adopts an edit of my provider in use to a host that answers but lists no models, saying it asks for the model as typed; one that refuses the key changes nothing (integrations-r4-2)", async () => {
    const using = "127.0.0.1:18308";
    const service = { kind: "user", host: using };
    const p = await open({ home: true, liveState: true, agent: readyAgent({ login: undefined, service, detail: `Connected to your own provider (${using}).` }), provider: { on: true, baseUrl: `http://${using}/v1`, conductor: "mock-model", consent: { version: 1, at: "2026-11-08T12:00:00Z", host: using } } });
    const provider = () => p.evaluate(() => window.__frState.settings.provider as { baseUrl: string; consent: { host: string } });
    await p.locator("#byok-url").fill("http://127.0.0.1:18309/v1");
    await p.keyboard.press("Tab");
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(true);
    await p.waitForTimeout(AGREE_ARM_MS + 100);
    // A key it refuses: nothing has changed.
    await p.locator("#byok-yes").click();
    await expect.poll(() => calls(p)).toContain("test-draft:127.0.0.1:18309");
    await settle(p, "test", { ok: false, why: "127.0.0.1:18309 needs an API key." });
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe(`127.0.0.1:18309 needs an API key. Nothing has changed: Ember still uses ${using}.`);
    expect((await calls(p)).filter(c => c.startsWith("agree:"))).toEqual([]);
    // It answers, with no model list there: adopted with the yes, in one change, saying what Ember asks it for.
    await p.locator("#byok-yes").click();
    await expect.poll(async () => (await calls(p)).filter(c => c === "test-draft:127.0.0.1:18309").length).toBe(2);
    await settle(p, "test", { ok: false, why: "127.0.0.1:18309 answered, but has no model list at that address. Check the endpoint and the provider.", cause: "no-list" }, 1);
    await expect.poll(() => p.locator("#byok-msg").innerText()).toBe("Agreed. 127.0.0.1:18309 answered but lists no models, so Ember asks it for mock-model as typed.");
    expect(await calls(p)).toContain("agree:127.0.0.1:18309");
    expect(await provider()).toMatchObject({ baseUrl: "http://127.0.0.1:18309/v1", consent: { host: "127.0.0.1:18309" } });
    await expect.poll(() => p.locator("#byok-consent").isVisible()).toBe(false);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(ai) “Use GitHub Copilot instead” while I'm busy says I'll switch once I've finished, keeps Continue, and offers Copilot's sign-in once the switch is made (first-run-v4-1)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const own = readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service });
    const p = await open({ provider, providerState: { inForce: true, host: "api.example.com", agreed: true, keySaved: true }, agent: own });
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    await p.locator("#w-alt").click();
    await expect.poll(() => calls(p)).toContain(`save:${JSON.stringify({ provider: { on: false } })}`);
    // A turn or a task is under way: main puts the switch off and says so, and no other status comes until it's done.
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, { ...own, switchPending: true });
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toBe("I'll switch to Copilot once I've finished what I'm doing.");
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    expect(await next(p).innerText()).toBe("Continue");
    expect(await next(p).getAttribute("aria-disabled")).toBeNull();
    expect(await p.locator("#w-why").innerText()).not.toContain("connecting");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Try me out");
    // Ask waits for the switch, never behind a sign-in nothing offers yet.
    expect(await p.locator("#w-try-ask p").innerText()).toBe("Once I'm connected, you can ask me something.");
    expect(await p.locator("#w-ask").getAttribute("aria-disabled")).toBe("true");
    // The switch is made once main is done: Copilot, not signed in yet, and the sign-in step offers it.
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, SIGNED_OUT);
    await expect.poll(() => p.locator("#w-try-ask p").innerText()).toBe("Sign in first, then you can ask me something.");
    await p.locator("#w-back").click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    expect(await next(p).innerText()).toBe("Sign in with GitHub");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(ak) while the switch waits, the sign-in step still offers my own provider, and once the switch is made under my focus on Continue, Enter starts no sign-in and the line says what changed (first-run-r4-1, first-run-c4-1)", async () => {
    const service = { kind: "user", host: "api.example.com" };
    const provider = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const own = readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service });
    const p = await open({ provider, providerState: { inForce: true, host: "api.example.com", agreed: true, keySaved: true }, agent: own });
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    await p.locator("#w-alt").click();
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, { ...own, switchPending: true });
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toBe("I'll switch to Copilot once I've finished what I'm doing.");
    // The lead's "No Copilot? You can use your own model provider instead." has its button while the switch waits.
    expect(await p.locator("#w-lead").innerText()).toContain("No Copilot? You can use your own model provider instead.");
    await expect.poll(() => p.getByRole("button", { name: "Use my own provider" }).isVisible()).toBe(true);
    const shot = async (name: string) => { if (process.env.EMBER_UI_EVIDENCE) { fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true }); await p.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `${name}.png`), fullPage: true }); } };
    await shot("switch-waits-own-offer");
    // My focus is on Continue when the work ends: Ember connects to Copilot, and finds no sign-in.
    await next(p).focus();
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, { ...SIGNED_OUT, phase: "starting", detail: "Connecting to Copilot…" });
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, SIGNED_OUT);
    await expect.poll(() => next(p).innerText()).toBe("Sign in with GitHub");
    // The press meant for Continue lands on the title, and the status line says what changed.
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("w-title");
    expect(await p.locator("#w-signin-line").innerText()).toBe("I've switched to Copilot. Sign in with GitHub to go on, or skip for now.");
    await shot("switch-made-sign-in");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(200);
    expect(await calls(p)).not.toContain("signIn");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(z) resumed while the user's own provider connects or fails, the sign-in step names it, with no Copilot or sign-in words (first-run-1, first-run-c1-3)", async () => {
    const service = { kind: "user", host: "localhost:11434" };
    const own = { on: true, baseUrl: "http://localhost:11434/v1", conductor: "llama3.2:3b", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "localhost:11434" } };
    const p = await open({ provider: own, providerState: { inForce: true, host: "localhost:11434", agreed: true }, agent: { ...SIGNED_OUT, phase: "starting", detail: "Connecting…", service } });
    const words = async () => [await p.locator("#w-title").innerText(), await p.locator("#w-lead").innerText(), ...(await p.locator("#w-signin-later:visible, #w-signin-help:visible, #w-signin-line").allInnerTexts())].join(" | ");
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your own model provider");
    expect(await p.locator("#w-lead").innerText()).toBe("I'm connecting to the model provider you set up (localhost:11434). You can change it later in Settings › Models & connections.");
    expect(await p.locator("#w-signin-line").innerText()).toBe("Connecting to your own provider (localhost:11434)…");
    expect(await words()).not.toMatch(/Copilot|GitHub|sign in|sign-in/i);
    expect(await buttons(p)).not.toContain("Use my own provider");
    expect(await buttons(p)).toContain("Check my provider's details");
    // The local server isn't running: the provider's own words, and what can be done about it.
    const detail = "Ember can't reach the model server on this computer (localhost:11434). Start it, and Ember will connect in a moment.";
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, { ...SIGNED_OUT, phase: "error", reason: "network", detail, service });
    // Said as mine, under a lead that is (first-run-r4-2).
    const mine = "I can't reach the model server on this computer (localhost:11434). Start it, and I'll connect in a moment.";
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toBe(mine);
    expect(await p.locator("#w-lead").innerText()).toBe("I can't connect to the model provider you set up (localhost:11434) yet: the line below says why. You can check its details here, or later in Settings › Models & connections.");
    expect(await words()).not.toMatch(/Copilot|GitHub|sign in|sign-in/i);
    const shown = await buttons(p);
    expect(shown).toEqual(expect.arrayContaining(["Try again", "Check my provider's details", "Skip for now"]));
    expect(shown).not.toContain("Use my own provider");
    expect(shown).not.toContain("Check again");
    // Try again reconnects; what it found of a GitHub sign-in says nothing about this provider.
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("retry");
    await settle(p, "retry", { found: false, source: null, hint: "Ember signs in through the GitHub CLI. Install it, then press Check again." });
    await p.waitForTimeout(50);
    expect(await words()).not.toMatch(/Copilot|GitHub|sign in|sign-in/i);
    expect(await p.locator("#w-signin-line").innerText()).toBe(mine);
    // Skip, then on to Your Ember: the provider by name, not "Not signed in yet" (first-run-c1-3).
    await p.locator("#w-alt").click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Try me out");
    expect(await p.locator("#w-try-ask-text").innerText()).toBe("Once I'm connected, you can ask me something.");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your Ember");
    const summary = await p.locator("#w-summary").innerText();
    expect(summary).toContain("Your own provider (localhost:11434), not connected yet");
    expect(summary).not.toMatch(/Copilot|signed in/i);
    // The organisation's service that isn't answering: named too.
    const q = await open({ admin: { provider: "https://models.corp.example/v1" }, agent: { ...SIGNED_OUT, phase: "error", reason: "network", detail: "Ember can't reach models.corp.example.", service: { kind: "admin", host: "models.corp.example" } } });
    await next(q).click();
    await expect.poll(() => q.locator("#w-title").innerText()).toBe("Checking this computer");
    await next(q).click();
    await next(q).click();
    await expect.poll(() => q.locator("#w-title").innerText()).toBe("Your Ember");
    expect(await q.locator("#w-summary").innerText()).toContain("Your organisation's model service, not connected yet");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    expect((q as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(al) the sign-in step's line names only buttons the step shows: Try again for main's Check again, the GitHub CLI's Check again where it is shown (first-run-w5-2)", async () => {
    /** Every button the line tells me to press is on the step. */
    const pressable = async (p: Page) => {
      const said = await p.locator("#w-signin-line").innerText();
      const shown = await buttons(p);
      for (const [, name] of said.matchAll(/\b[Pp]ress (Try again|Check again|Sign in with GitHub)\b/g)) expect(shown, `${said} | ${shown.join(", ")}`).toContain(name);
      return said;
    };
    // A file of mine that can't be found, on a build with Ember's own GitHub App: no Check again here, so Try again.
    const files = await open({ agent: { ...SIGNED_OUT, phase: "error", reason: "other", detail: "Ember couldn't find one of its files. Press Check again; if it keeps happening, restart Ember." } });
    await expect.poll(() => files.locator("#w-signin-line").innerText()).toBe("I couldn't find one of my files. Press Try again; if it keeps happening, restart me.");
    await pressable(files);
    expect(await buttons(files)).not.toContain("Check again");
    // A token in the environment that Copilot refused: Sign in with GitHub leads, and Try again is there for the line.
    const token = await open({ agent: { ...SIGNED_OUT, phase: "error", reason: "sign-in", detail: "Copilot didn't accept the GitHub token in COPILOT_GITHUB_TOKEN (set in Ember's environment). It may have expired, lack the Copilot permission, or belong to an account without Copilot. Replace it or remove COPILOT_GITHUB_TOKEN, then restart Ember; or run “gh auth login” in a terminal and press Check again." } });
    await expect.poll(() => token.locator("#w-signin-line").innerText()).toContain("then restart me; or run “gh auth login” in a terminal and press Try again.");
    await pressable(token);
    expect(await next(token).innerText()).toBe("Sign in with GitHub");
    await token.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => calls(token)).toContain("retry");
    // My own provider in use, its connection that keeps stopping: Try again, and its details' step says the way to it.
    const service = { kind: "user", host: "localhost:11434" };
    const local = { on: true, baseUrl: "http://localhost:11434/v1", conductor: "llama3.2:3b", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "localhost:11434" } };
    const own = await open({ provider: local, providerState: { inForce: true, host: "localhost:11434", agreed: true }, agent: { ...SIGNED_OUT, phase: "error", reason: "runtime", detail: "Ember's model connection keeps stopping. Press Check again to retry, or restart Ember.", service } });
    await expect.poll(() => own.locator("#w-signin-line").innerText()).toBe("My model connection keeps stopping. Press Try again, or restart me.");
    await pressable(own);
    await own.getByRole("button", { name: "Check my provider's details" }).click();
    expect(await own.locator("#w-title").innerText()).toBe("Your own model provider's details");
    expect(await own.locator("#w-p-result").innerText()).toBe("My model connection keeps stopping. Go back and press Try again, or restart me.");
    expect(await buttons(own)).toContain("Back");
    await own.locator("#w-back").click();
    expect(await own.locator("#w-title").innerText()).toBe("Your own model provider");
    expect(await buttons(own)).toContain("Try again");
    // The organisation's service that keeps stopping: nothing to sign in to, and Try again for the line.
    const org = await open({ admin: { provider: "https://models.corp.example/v1" }, agent: { ...SIGNED_OUT, phase: "error", reason: "runtime", detail: "Ember's model connection keeps stopping. Press Check again to retry, or restart Ember.", service: { kind: "admin", host: "models.corp.example" } } });
    await expect.poll(() => org.locator("#w-signin-line").innerText()).toBe("My model connection keeps stopping. Press Try again, or restart me.");
    await pressable(org);
    // A build that signs in through the GitHub CLI shows Check again: the line keeps it, and no second button is added.
    const cli = await open({ agent: { ...SIGNED_OUT, signInWith: "github-cli", phase: "error", reason: "other", detail: "Ember couldn't find one of its files. Press Check again; if it keeps happening, restart Ember." } });
    await expect.poll(() => cli.locator("#w-signin-line").innerText()).toBe("I couldn't find one of my files. Press Check again; if it keeps happening, restart me.");
    await pressable(cli);
    expect((await buttons(cli)).filter(b => b === "Try again")).toHaveLength(1);
    for (const p of [files, token, own, org, cli]) expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(o) under the organisation's lockdown the steps say so, never that a service runs or to sign in (first-run-v1)", async () => {
    const p = await open({ admin: { error: "The policy file is writable by others.", provider: null }, agent: { ...SIGNED_OUT, phase: "error", reason: "policy", detail: "Your organisation's policy stops me from connecting." } });
    expect(await p.locator("#w-title").innerText()).toBe("Your organisation has locked me down");
    const lead = await p.locator("#w-lead").innerText();
    expect(lead).toContain("Ask your administrator");
    expect(lead).not.toMatch(/its own model service|nothing to sign in to/);
    expect(await buttons(p)).not.toContain("Sign in with GitHub");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Try me out");
    expect(await p.locator("#w-try-ask-text").innerText()).toBe("While your organisation's policy locks me down, I can't answer.");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your Ember");
    const summary = await p.locator("#w-summary").innerText();
    expect(summary).toContain("Locked down by your organisation");
    expect(summary).not.toMatch(/Not signed in|Copilot/);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(p) the step's quiet button keeps keyboard focus through every redraw, and never turns under it into another (first-run-2, first-run-r3, WCAG 2.4.3)", async () => {
    // Skip for now, focused, while a status arrives.
    const p = await open();
    await p.locator("#w-alt").focus();
    expect(await p.locator("#w-alt").innerText()).toBe("Skip for now");
    await p.evaluate(a => window.__frEmit("onAgentStatus", a), { ...SIGNED_OUT, detail: "Still not signed in." });
    await p.waitForTimeout(50);
    expect(await focusedId(p)).toBe("w-alt");
    // Sign in keeps focus on its own button, now waiting (a second Enter there does nothing: first-run-r3), and the
    // device code arriving keeps it there.
    await next(p).focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => calls(p)).toContain("signIn");
    expect(await p.locator("#w-alt").innerText()).toBe("Cancel");
    expect(await focusedId(p)).toBe("w-next");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(50);
    expect(await calls(p)).toEqual(["signIn"]);
    await emit(p, "onSignInProgress", { state: "code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    await expect.poll(() => p.locator("#w-code").isVisible()).toBe(true);
    expect(await focusedId(p)).toBe("w-next");
    // Cancel: the same button becomes Skip for now, so focus goes to the step's title, and a second Enter skips nothing.
    await p.locator("#w-alt").focus();
    await p.keyboard.press("Enter");
    await expect.poll(() => calls(p)).toContain("cancelSignIn");
    await emit(p, "onSignInProgress", { state: "cancelled" });
    await expect.poll(() => p.locator("#w-alt").innerText()).toBe("Skip for now");
    expect(await focusedId(p)).toBe("w-title");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(50);
    expect(await p.locator("#welcome").getAttribute("data-step")).toBe("sign-in");
    // Personalise memory…, focused on the try step, while the voice status arrives.
    const t = await open({ agent: readyAgent() });
    await next(t).click();
    await next(t).click();
    await expect.poll(() => t.locator("#w-title").innerText()).toBe("Try me out");
    await t.locator("#w-alt").focus();
    await emit(t, "onVoiceStatus", { state: "off", detail: null, modelsReady: false, modelsMissing: [], modelsBytes: 0 });
    await t.waitForTimeout(50);
    expect(await focusedId(t)).toBe("w-alt");
  });

  it("(y) a second Enter, a held Enter or a double click after Not now neither agrees nor quits (first-run-c1-1)", async () => {
    // Not now: focus goes to the note that says what it did, never to Agree (the next Enter would agree) nor to the
    // same button, now Quit Ember.
    const c = await open({ consent: 0 });
    await next(c).click();
    await expect.poll(() => c.locator("#w-title").innerText()).toBe("What I do, and what I don't");
    await c.waitForTimeout(AGREE_ARM_MS + 100);
    await c.locator("#w-alt").focus();
    await c.keyboard.press("Enter");
    await expect.poll(() => c.locator("#w-alt").innerText()).toBe("Quit Ember");
    expect(await focusedId(c)).toBe("w-consent-note");
    expect(await c.locator("#w-consent-note").innerText()).toContain("I'll stay off");
    await c.keyboard.press("Enter");
    // A held Enter: the key repeats.
    await c.keyboard.down("Enter");
    await c.keyboard.down("Enter");
    await c.keyboard.up("Enter");
    await c.waitForTimeout(100);
    expect(await calls(c)).toEqual([]);
    expect(await c.locator("#welcome").getAttribute("data-step")).toBe("consent");
    // Agree is still one deliberate Tab and Enter away (Back, then Quit Ember, then Agree).
    await c.keyboard.press("Tab");
    await c.keyboard.press("Tab");
    await c.keyboard.press("Tab");
    expect(await focusedId(c)).toBe("w-next");
    // A double click on Get started lands its second click on Agree, drawn where it was: dropped, nothing agreed.
    const d = await open({ consent: 0 });
    await next(d).dblclick();
    await expect.poll(() => d.locator("#welcome").getAttribute("data-step")).toBe("consent");
    await d.waitForTimeout(100);
    expect(await calls(d)).toEqual([]);
    // A double click on Not now doesn't quit through the same button, now Quit Ember.
    await d.waitForTimeout(AGREE_ARM_MS);
    await d.locator("#w-alt").dblclick();
    await d.waitForTimeout(100);
    expect(await calls(d)).toEqual([]);
    expect(await d.locator("#w-alt").innerText()).toBe("Quit Ember");
    // Pressed once it has been on screen a moment, each does what it says.
    await d.waitForTimeout(AGREE_ARM_MS);
    await d.locator("#w-alt").click();
    await expect.poll(() => calls(d)).toEqual(["quit"]);
    await next(d).click();
    await expect.poll(async () => (await calls(d)).some(x => x.startsWith('save:{"consent":{"version":'))).toBe(true);
    expect((c as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(q2) tells me about you says why memory is paused under a model service, shows no answers it couldn't keep, and goes on with Continue (memory-c1-2)", async () => {
    const p = await open({ agent: readyAgent() });
    await next(p).click();
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Try me out");
    await emit(p, "onMemory", { rows: [], ownership: "waiting", reason: "org-provider", epoch: 1 });
    await p.locator("#w-alt").click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Tell me about you");
    await expect.poll(() => p.locator("#w-about .about-paused").innerText()).toBe("Memory works only with GitHub Copilot, so it's paused while Ember uses your organisation's model service. What Ember remembers stays on this computer.");
    expect(await p.locator("#w-ay-name").isVisible()).toBe(false);
    expect(await p.locator("#w-about").getByRole("button", { name: "I agree, remember" }).count()).toBe(0);
    expect(await next(p).innerText()).toBe("Continue");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Your Ember");
    expect((await calls(p)).some(c => c.startsWith("introduce"))).toBe(false);
    // Memory on and agreed to, still paused: the same, never "Couldn't save your answers".
    const on = await open({ agent: readyAgent() });
    await on.evaluate(() => { window.__frState.settings.memory = { on: true, questions: true, askedAt: null, consent: { version: 99, at: "2026-11-04T12:00:00Z" } }; window.__frEmit("onSettingsChanged", window.__frState.settings); });
    await next(on).click();
    await next(on).click();
    await expect.poll(() => on.locator("#w-title").innerText()).toBe("Try me out");
    await on.locator("#w-alt").click();
    await emit(on, "onMemory", { rows: [], ownership: "waiting", reason: "own-provider", epoch: 1 });
    await expect.poll(() => on.locator("#w-about .about-paused").innerText()).toContain("your own model provider");
    expect(await on.locator("#w-ay-name").isVisible()).toBe(false);
    expect(await next(on).innerText()).toBe("Continue");
    expect([...(p as Page & { errors: string[] }).errors, ...(on as Page & { errors: string[] }).errors]).toEqual([]);
  });

  it("(q) someone who agreed to an earlier version starts at the consent and is told what changed (first-run-4, safety-privacy-8)", async () => {
    const p = await open({ consent: 6, agent: readyAgent() });
    expect(await p.locator("#w-title").innerText()).toBe("What's changed since you last agreed");
    expect(await p.locator("#w-count").innerText()).toBe("Step 2 of 6");
    expect(await p.locator("#w-changes").isVisible()).toBe(true);
    const changed = await p.locator("#w-changes-list li").allInnerTexts();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain("“Keep my recent conversation”");
    // The usual points and the full text are still there; nothing goes on until Agree is saved.
    expect(await p.locator("#w-points li").count()).toBe(5);
    expect(await next(p).innerText()).toBe("Agree and continue");
    // Agree takes a press once it has been on screen a moment (first-run-c1-1).
    await p.waitForTimeout(AGREE_ARM_MS + 100);
    await next(p).click();
    await expect.poll(async () => (await calls(p)).some(c => c.startsWith('save:{"consent":{"version":7'))).toBe(true);
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    // Back: agreed now, so the step is the usual one and lists no changes.
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("What I do, and what I don't");
    expect(await p.locator("#w-changes").isHidden()).toBe(true);
    // A first agreement starts at hello, with no changes to tell.
    const first = await open({ consent: 0 });
    expect(await first.locator("#w-title").innerText()).toBe("Hi, I'm Ember.");
    await next(first).click();
    await expect.poll(() => first.locator("#w-title").innerText()).toBe("What I do, and what I don't");
    expect(await first.locator("#w-changes").isHidden()).toBe(true);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(q3) with my own provider in force, the consent's short form says my requests go to it, as the full text does, never to Copilot (first-run-r2-2)", async () => {
    const own = { on: true, baseUrl: "https://api.example.com/v1", conductor: "gpt-4.1", consent: { version: 1, at: "2026-11-07T12:00:00Z", host: "api.example.com" } };
    const inForce = { inForce: true, host: "api.example.com", agreed: true, keySaved: true };
    const send = (q: Page) => q.locator("#w-points li[data-icon='send']").innerText();
    const full = (q: Page) => q.locator("#w-full #model-service").evaluate(e => e.textContent ?? "");
    // A returning user after a consent bump: Ember isn't connected yet (nothing is, before the consent).
    const p = await open({ consent: 6, provider: own, providerState: inForce });
    expect(await p.locator("#w-title").innerText()).toBe("What's changed since you last agreed");
    await expect.poll(() => send(p)).toBe("When you ask something, your request and what I read go to your own model provider (api.example.com). Nothing is sent before you ask.");
    expect(await full(p)).toBe("your own model provider (api.example.com)");
    expect(await send(p)).not.toContain("Copilot");
    // Agreed, and Back to the consent from the sign-in step: the same recipient.
    const q = await open({ provider: own, providerState: inForce, agent: readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service: { kind: "user", host: "api.example.com" } }) });
    await expect.poll(() => q.locator("#w-title").innerText()).toBe("Your own model provider");
    await q.locator("#w-back").click();
    expect(await q.locator("#w-title").innerText()).toBe("What I do, and what I don't");
    await expect.poll(() => send(q)).toContain("go to your own model provider (api.example.com).");
    // The organisation's own service, and GitHub Copilot when nothing else is in force, are named as before.
    const org = await open({ consent: 6, admin: { provider: "https://llm.example.org/v1" } });
    await expect.poll(() => send(org)).toContain("go to your organisation's model service (llm.example.org).");
    const copilot = await open({ consent: 6 });
    await expect.poll(() => send(copilot)).toContain("go to GitHub Copilot.");
    for (const page of [p, q, org, copilot]) expect((page as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(r) a model server on this computer is checked without an API key, also on a computer with no keyring (first-run-v2)", async () => {
    const p = await open();
    await p.getByRole("button", { name: "Use my own provider" }).click();
    await p.fill("#w-p-url", "http://localhost:11434/v1");
    await p.fill("#w-p-conductor", "llama3.2:3b");
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("test");
    const order = await calls(p);
    expect(order).toContain("agree:localhost:11434");
    expect(order).not.toContain("saveKey");
    expect(await p.locator("#w-p-result").innerText()).not.toBe("Paste the API key first.");
    // Another service still needs its key.
    const q = await open();
    await q.getByRole("button", { name: "Use my own provider" }).click();
    await q.fill("#w-p-url", "https://api.example.com/v1");
    await q.fill("#w-p-conductor", "gpt-4.1");
    await next(q).click();
    expect(await q.locator("#w-p-result").innerText()).toBe("Paste the API key first.");
    expect(await calls(q)).toEqual([]);
    // No keyring: a local server with no key can still be checked; another service, or a typed key, can't, and says why.
    const r = await open({ providerState: { keyring: false } });
    await r.getByRole("button", { name: "Use my own provider" }).click();
    await r.fill("#w-p-url", "http://127.0.0.1:1234/v1");
    await r.fill("#w-p-conductor", "local-model");
    expect(await next(r).getAttribute("aria-disabled")).toBeNull();
    expect(await r.locator("#w-why").innerText()).not.toContain("keyring");
    await r.fill("#w-p-key", "sk-x");
    await expect.poll(() => next(r).getAttribute("aria-disabled")).toBe("true");
    // The line says it whole; the waiting button, in short (first-run follow-up: w-why).
    expect(await r.locator("#w-p-result").innerText()).toContain("A model server on this computer that needs no key still works");
    expect(await r.locator("#w-why").innerText()).toBe("I can't keep a key safely on this computer.");
    await r.fill("#w-p-key", "");
    await r.fill("#w-p-url", "https://api.example.com/v1");
    await expect.poll(() => next(r).getAttribute("aria-disabled")).toBe("true");
    await r.fill("#w-p-url", "http://127.0.0.1:1234/v1");
    await expect.poll(() => next(r).getAttribute("aria-disabled")).toBeNull();
    await next(r).click();
    await expect.poll(() => calls(r)).toContain("agree:127.0.0.1:1234");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(t) Check again reads the setup rows anew after a fix made outside Ember, in first run and Home, and shows what it found (first-run-6, first-run-r2)", async () => {
    const missing = { id: "accessibility", label: "Screen reading", status: "warn", detail: "Python accessibility bindings are missing: sudo dnf install python3-pyatspi python3-gobject" };
    const ok = { id: "accessibility", label: "Screen reading", status: "ok", detail: "Accessibility is on" };
    const p = await open({ agent: readyAgent(), checks: [missing] });
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    const again = p.locator("#w-checks-again");
    expect(await again.isVisible()).toBe(true);
    // Nothing changed yet: said, shown under the button as well as read out (first-run-r2), and the row stays.
    await again.click();
    await expect.poll(() => calls(p)).toContain("recheck");
    expect(await p.locator("#w-checks-msg").innerText()).toBe("Checking…");
    expect(await seen(p, "#w-checks-msg")).toBe(true);
    await settle(p, "recheck", { checks: [missing], versions: {} });
    await expect.poll(() => p.locator("#w-checks-msg").innerText()).toBe("I checked again. Nothing has changed yet.");
    expect(await seen(p, "#w-checks-msg")).toBe(true);
    expect(await p.locator("#w-checks-msg").getAttribute("role")).toBe("status");
    expect(await p.locator("#w-checks .w-check").count()).toBe(1);
    // The command was run: the row goes, and the step says so.
    await again.click();
    await settle(p, "recheck", { checks: [ok], versions: {} }, 1);
    await expect.poll(() => p.locator("#w-checks-msg").innerText()).toBe("I checked again. Screen reading is ready now.");
    expect(await seen(p, "#w-checks-msg")).toBe(true);
    expect(await p.locator("#w-checks-head").innerText()).toBe("Everything I need is ready.");
    expect(await again.isVisible()).toBe(false);
    expect(await focusedId(p)).toBe("w-title");
    // Home's setup check offers the same.
    const h = await open({ home: true, agent: readyAgent(), checks: [missing] });
    await h.locator("a[href='#checks-h']").first().click();
    await expect.poll(() => h.locator("#checks-again").isVisible()).toBe(true);
    await h.locator("#checks-again").click();
    expect(await seen(h, "#checks-msg")).toBe(true);
    await settle(h, "recheck", { checks: [ok], versions: {} });
    await expect.poll(() => h.locator("#checks-msg").innerText()).toBe("I checked again. Screen reading is ready now.");
    expect(await seen(h, "#checks-msg")).toBe(true);
    expect(await h.locator("#checks-again").isVisible()).toBe(false);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    expect((h as Page & { errors: string[] }).errors).toEqual([]);
  }, 20_000);

  it("(u) Home's setup check says each row's state in first run's words and offers the command to copy (first-run-9)", async () => {
    const missing = { id: "accessibility", label: "Screen reading", status: "warn", detail: "Python accessibility bindings are missing: sudo dnf install python3-pyatspi python3-gobject" };
    const os = { id: "os", label: "Operating system", status: "warn", detail: "Rocky Linux 8.9" };
    const ok = { id: "session", label: "Desktop session", status: "ok", detail: "X11 on :0" };
    const p = await open({ home: true, agent: readyAgent(), checks: [missing, os, ok] });
    await p.locator("a[href='#checks-h']").first().click();
    await expect.poll(() => p.locator("#checks li").count()).toBe(3);
    expect(await p.locator("#checks .pill").allInnerTexts()).toEqual(["Needs fixing", "Worth a look", "Ready"]);
    const copy = p.locator("#checks li[data-check='accessibility'] .check-copy");
    expect(await copy.getAttribute("aria-label")).toBe("Copy the command: sudo dnf install python3-pyatspi python3-gobject");
    expect(await p.locator("#checks .check-copy").count()).toBe(1);
    await copy.click();
    await expect.poll(() => copy.innerText()).toBe("Copied");
    // The labels line up whatever the state's word.
    const left = await p.locator("#checks .check-label").evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(left).size).toBe(1);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

  it("(m) Back, then Home turns the provider on itself: the late switch-off of the abandoned check leaves it on (PR #191 re-review)", async () => {
    const p = await open({ slowAgree: true });
    await p.getByRole("button", { name: "Use my own provider" }).click();
    await p.fill("#w-p-url", "https://api.example.com/v1");
    await p.fill("#w-p-key", "sk-x");
    await p.fill("#w-p-conductor", "gpt-4.1");
    await next(p).click();
    await expect.poll(async () => (await calls(p)).some(c => c.startsWith("agree:"))).toBe(true);
    await p.locator("#w-back").click();
    // Home's switch, through its own handler.
    await p.evaluate(() => { const sw = document.getElementById("byok-on") as HTMLInputElement; sw.checked = true; sw.dispatchEvent(new Event("change")); });
    await expect.poll(() => p.evaluate(() => window.__frState.settings.provider.on)).toBe(true);
    await settle(p, "agree", { ok: true });
    await p.waitForTimeout(300);
    expect(await p.evaluate(() => window.__frState.settings.provider.on)).toBe(true);
    expect(await calls(p)).not.toContain(`save:${JSON.stringify({ provider: { on: false } })}`);
  });
});
