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

interface Seed { consent?: number; admin?: Record<string, unknown>; agent?: Record<string, unknown>; checks?: unknown[]; providerState?: Record<string, unknown>; noBridge?: boolean; slowAgree?: boolean; failOff?: boolean; home?: boolean; provider?: Record<string, unknown> }

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
  await page.addInitScript(({ settings, admin, environment, agent, providerState, noBridge, slowAgree, failOff }) => {
    window.__frFailOff = failOff;
    window.__frCalls = []; window.__frPend = {};
    window.__frState = { settings, agent };
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    window.__frEmit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
    const defer = (name: string) => new Promise((resolve, reject) => { (window.__frPend[name] ??= []).push({ resolve, reject }); });
    const status = () => ({ appVersion: "0.1.1", settings: window.__frState.settings, environment, logFile: "/test/ember.log", settingsNotice: null, admin });
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => status();
      if (name === "agentStatus") return async () => window.__frState.agent;
      if (name === "updateSettings") return async (patch: Record<string, unknown>) => {
        window.__frCalls.push(`save:${JSON.stringify(patch)}`);
        if (window.__frFailOff && (patch.provider as { on?: boolean } | undefined)?.on === false) throw new Error("disk full");
        const s = window.__frState.settings;
        for (const [k, v] of Object.entries(patch)) s[k] = v && typeof v === "object" && !Array.isArray(v) && typeof s[k] === "object" ? { ...(s[k] as object), ...v } : v;
        window.__frEmit("onSettingsChanged", s);
      };
      if (name === "signIn") return () => { window.__frCalls.push("signIn"); return defer("signIn"); };
      if (name === "retrySignIn") return () => { window.__frCalls.push("retry"); return defer("retry"); };
      if (name === "applyFix") return (fix: string) => { window.__frCalls.push(`fix:${fix}`); return defer("fix"); };
      if (name === "conversation") return async () => [];
      if (name === "openAsk") return async () => { window.__frCalls.push("openAsk"); };
      return () => new Promise(() => undefined);
    } }) as never;
    if (!noBridge) {
      window.emberProvider = {
        state: async () => ({ allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: null, agreed: false, ...providerState }),
        onChanged: () => () => undefined,
        saveKey: () => { window.__frCalls.push("saveKey"); return Promise.resolve({ ok: true }); },
        removeKey: async () => ({ ok: true }),
        agree: (host: string) => { window.__frCalls.push(`agree:${host}`); if (slowAgree) return (defer("agree") as Promise<unknown>).then(r => { window.__frState.settings.provider = { ...window.__frState.settings.provider, on: true }; return r; }) as never; window.__frState.settings.provider = { ...window.__frState.settings.provider, on: true }; return Promise.resolve({ ok: true }); },
        test: () => { window.__frCalls.push("test"); return defer("test") as never; },
      };
    }
  }, { settings, admin, environment, agent: seed.agent ?? SIGNED_OUT, providerState: seed.providerState ?? {}, noBridge: !!seed.noBridge, slowAgree: !!seed.slowAgree, failOff: !!seed.failOff });
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

describe.skipIf(gate)("first run: connection, own provider and models (FE #2–#6)", () => {
  it("(a) Copilot: a failed sign-in is visible, retry works, the models are reviewed, then the first answer", async () => {
    const p = await open();
    expect(await p.locator("#w-title").innerText()).toBe("Sign in to GitHub");
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("signIn");
    await fail(p, "signIn", "GitHub didn't answer.");
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toContain("didn't answer");
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
    await p.evaluate(a => { window.__frState.agent = a; window.__frEmit("onAgentStatus", a); }, readyAgent({ login: undefined, models: [], conductorModel: "gpt-4.1", workerModel: null, service: { kind: "user", host: "api.example.com" } }));
    await expect.poll(() => next(p).getAttribute("aria-disabled")).toBeNull();
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    // Back returns to the provider's step as it was left, not to a Copilot sign-in that isn't in use (first-run-1).
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Use your own model provider");
    expect(await p.locator("#w-p-result").innerText()).toBe("Connected to api.example.com. It lists 2 models.");
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
    // Still announced, and the retry button is back, enabled and focused.
    expect(await p.locator("#w-checks-msg").innerText()).toContain("couldn't change it");
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
    await expect.poll(() => p.locator("#w-signin-line").innerText()).toBe("Connected to your own provider (api.example.com).");
    expect(await p.locator("#w-title").innerText()).toBe("Your own model provider");
    expect(await p.locator("#w-lead").innerText()).toContain("api.example.com");
    for (const id of ["#w-title", "#w-lead", "#w-signin-line"]) expect(await p.locator(id).innerText(), id).not.toContain("Copilot");
    await next(p).click();
    await expect.poll(() => p.locator("#w-title").innerText()).toBe("Checking this computer");
    await p.locator("#w-back").click();
    expect(await p.locator("#w-title").innerText()).toBe("Use your own model provider");
    expect(await p.inputValue("#w-p-url")).toBe("https://api.example.com/v1");
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
  });

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

  it("(p) the step's quiet button keeps keyboard focus through every redraw (first-run-2, WCAG 2.4.3)", async () => {
    // Skip for now, focused, while a status arrives.
    const p = await open();
    await p.locator("#w-alt").focus();
    expect(await p.locator("#w-alt").innerText()).toBe("Skip for now");
    await p.evaluate(a => window.__frEmit("onAgentStatus", a), { ...SIGNED_OUT, detail: "Still not signed in." });
    await p.waitForTimeout(50);
    expect(await focusedId(p)).toBe("w-alt");
    // Sign in puts focus on Cancel, and the device code arriving keeps it there.
    await next(p).click();
    await expect.poll(() => calls(p)).toContain("signIn");
    expect(await p.locator("#w-alt").innerText()).toBe("Cancel");
    expect(await focusedId(p)).toBe("w-alt");
    await emit(p, "onSignInProgress", { state: "code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
    await expect.poll(() => p.locator("#w-code").isVisible()).toBe(true);
    expect(await focusedId(p)).toBe("w-alt");
    // Personalise memory…, focused on the try step, while the voice status arrives.
    const t = await open({ agent: readyAgent() });
    await next(t).click();
    await next(t).click();
    await expect.poll(() => t.locator("#w-title").innerText()).toBe("Try me out");
    await t.locator("#w-alt").focus();
    await emit(t, "onVoiceStatus", { state: "off", detail: null, modelsReady: false, modelsMissing: [], modelsBytes: 0 });
    await t.waitForTimeout(50);
    expect(await focusedId(t)).toBe("w-alt");
    // Not now on the consent step: focus goes to Agree, never to the page, and a second Enter doesn't quit.
    const c = await open({ consent: 0 });
    await next(c).click();
    await expect.poll(() => c.locator("#w-title").innerText()).toBe("What I do, and what I don't");
    await c.locator("#w-alt").focus();
    await c.keyboard.press("Enter");
    await expect.poll(() => c.locator("#w-alt").innerText()).toBe("Quit Ember");
    expect(await focusedId(c)).toBe("w-next");
    expect(await c.locator("#w-consent-note").innerText()).toContain("I'll stay off");
    expect(await calls(c)).not.toContain("quit");
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
