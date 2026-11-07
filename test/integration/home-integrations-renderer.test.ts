/**
 * Built Home in Chromium, the integrations a person sets up there (2026-11-07 product audit): Extensions' marketplaces,
 * adding and agreeing, and what the section says while Ember isn't connected. Only the preload boundary is replaced
 * (window.ember, window.emberExtensions); nothing is installed, fetched or sent.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import type { ExtensionsState } from "../../app/shared/ipc";
import type { Installed, MarketplaceEntry } from "../../app/shared/extensions";

declare global {
  interface Window {
    __ixCalls: string[];
    __ixState: ExtensionsState;
    __ixEntries: MarketplaceEntry[];
    __ixEmit: (name: string, value: unknown) => void;
    __ixExtChanged: () => void;
  }
}

const gate = process.env.EMBER_UIUX_TEST !== "1";
const READY = { phase: "ready", detail: "Signed in as octo.", login: "octo", models: [], conductorModel: "m", workerModel: "m", usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, signInWith: "github-app" };
const BUILT_IN = { name: "awesome-copilot", source: "GitHub: github/awesome-copilot", builtIn: true };
const OWN = { name: "octo-tools", source: "GitHub: octo/tools" };
const ENTRY: MarketplaceEntry = { marketplace: "awesome-copilot", name: "fake", description: "A fake.", source: "plugins/fake", kind: "plugin", installed: false };

interface Seed { extensions?: Partial<ExtensionsState>; entries?: MarketplaceEntry[]; agent?: Record<string, unknown>; settings?: Record<string, unknown> }

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

/** Home after first run, on `pane`, with Extensions answering from `seed`. */
async function open(pane: string, seed: Seed = {}): Promise<Page> {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...seed.settings };
  settings.onboarded = true;
  settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  const admin = { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] };
  const extensions: ExtensionsState = { available: true, allowed: true, consented: false, installed: [], marketplaces: [BUILT_IN, OWN], ...seed.extensions };
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  (page as Page & { errors: string[] }).errors = errors;
  await page.addInitScript(({ settings, admin, agent, extensions, entries }) => {
    window.__ixCalls = [];
    window.__ixState = extensions;
    window.__ixEntries = entries;
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    window.__ixEmit = (name, value) => { for (const fn of subs[name] ?? []) fn(value); };
    const status = () => ({ appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null, admin });
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => status();
      if (name === "agentStatus") return async () => agent;
      if (name === "updateSettings") return async (patch: Record<string, unknown>) => { window.__ixCalls.push(`save:${JSON.stringify(patch)}`); };
      if (name === "conversation") return async () => [];
      return () => new Promise(() => undefined);
    } }) as never;
    let changed = () => undefined as void;
    window.__ixExtChanged = () => changed();
    const ok = (what: string) => async (...a: unknown[]) => { window.__ixCalls.push(`${what}(${a.map(x => JSON.stringify(x)).join(",")})`); return { ok: true as const }; };
    window.emberExtensions = {
      state: async () => structuredClone(window.__ixState),
      onChanged: fn => { changed = fn; return () => undefined; },
      browse: async () => ({ ok: true, entries: window.__ixEntries }),
      connectors: async () => ({ ok: true, entries: [] }),
      addMarketplace: ok("addMarketplace"), removeMarketplace: ok("removeMarketplace"), uninstall: ok("uninstall"), setEnabled: ok("setEnabled"),
      disconnect: ok("disconnect"), connect: async () => ({ ok: true, state: "connected" }),
      agree: async () => { window.__ixCalls.push("agree"); window.__ixState = { ...window.__ixState, consented: true }; return { ok: true }; },
      install: async (m: string, n: string) => {
        window.__ixCalls.push(`install(${m},${n})`);
        const item: Installed = { id: `plugin:${n}`, kind: "plugin", name: n, source: `${n}@${m}`, enabled: true, consented: false, status: "ready", tools: [], reviewTools: [{ name: "look", description: "Looks.", readOnly: true }], reviewToken: "0".repeat(64) };
        window.__ixState = { ...window.__ixState, installed: [...window.__ixState.installed, item] };
        return { ok: true };
      },
      reagree: async (id: string) => {
        window.__ixCalls.push(`reagree(${id})`);
        window.__ixState = { ...window.__ixState, installed: window.__ixState.installed.map(i => i.id === id ? { ...i, consented: true, tools: i.reviewTools ?? [] } : i) };
        return { ok: true };
      },
    };
  }, { settings, admin, agent: seed.agent ?? READY, extensions, entries: seed.entries ?? [ENTRY] });
  await page.goto(`http://127.0.0.1:${port}/app/renderer/home/index.html`);
  await page.waitForSelector(`a[href='#${pane}-h']`);
  await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
  await page.locator(`a[href='#${pane}-h']`).first().click();
  return page;
}

const calls = (p: Page) => p.evaluate(() => window.__ixCalls);
const focused = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.key ?? document.activeElement?.tagName ?? "");
/** With EMBER_UI_EVIDENCE set, a screenshot for the render check (in light, then dark). */
async function evidence(p: Page, name: string): Promise<void> {
  const dir = process.env.EMBER_UI_EVIDENCE;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    // After a switch's knob has finished moving.
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(dir, `${name}-${scheme}.png`), fullPage: true });
  }
}

describe.skipIf(gate)("Home's Extensions, as the person sets them up (2026-11-07 product audit)", () => {
  it("shows Copilot's built-in marketplace as built in with no Remove, and says what a built-in plugin's card agrees to (integrations-4)", async () => {
    const page = await open("extensions");
    const rows = page.locator("#ext-markets li.ext-market");
    await expect.poll(() => rows.count()).toBe(2);
    expect(await rows.nth(0).locator(".ext-meta").innerText()).toBe("Built into Copilot · GitHub: github/awesome-copilot");
    expect(await rows.nth(0).getByRole("button", { name: "Remove the marketplace awesome-copilot" }).count()).toBe(0);
    expect(await rows.nth(1).getByRole("button", { name: "Remove the marketplace octo-tools" }).count()).toBe(1);
    expect(await page.locator("#ext-markets-hint").innerText()).toBe("Browse fetches a marketplace's list: from GitHub for one built into Copilot, else from the address you added. Nothing from it runs until you add an item and agree.");
    // A plugin from it: the card never says the user added that marketplace.
    await rows.nth(0).getByRole("button", { name: "Browse awesome-copilot" }).click();
    await page.getByRole("button", { name: "Add fake" }).click();
    const card = page.locator(".ext-consent");
    await expect.poll(() => card.count()).toBe(1);
    expect(await card.innerText()).toContain("listed in “awesome-copilot”, a marketplace built into Copilot.");
    expect(await card.innerText()).not.toContain("you added");
    await evidence(page, "ext-built-in");
    // Removing one of the user's own says that it was removed.
    page.once("dialog", d => void d.accept());
    await rows.nth(1).getByRole("button", { name: "Remove the marketplace octo-tools" }).click();
    await expect.poll(() => page.locator("#extensions-msg").innerText()).toBe("Removed the marketplace “octo-tools”.");
    expect(await calls(page)).toContain('removeMarketplace("octo-tools")');
    expect((page as Page & { errors: string[] }).errors).toEqual([]);
    await page.close();
  });

  it("keeps keyboard focus on the item after Agree and use tools, and says Ember can use it now, not again (integrations-8)", async () => {
    const page = await open("extensions");
    await page.getByRole("button", { name: "Browse awesome-copilot" }).click();
    await page.getByRole("button", { name: "Add fake" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toBe("consent-yes");
    await page.keyboard.press("Enter");
    // Added: the tools are listed for review, and the card's yes has focus.
    await expect.poll(() => page.locator(".ext-consent").innerText()).toContain("Review the tools in “fake”");
    await expect.poll(() => focused(page)).toBe("consent-yes");
    expect(await page.locator("[data-key='consent-yes']").innerText()).toBe("Agree and use tools");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#extensions-msg").innerText()).toBe("Ember can use “fake” now.");
    await expect.poll(() => focused(page)).toBe("item:plugin:fake:switch");
    expect(await calls(page)).toEqual(["agree", "install(awesome-copilot,fake)", "reagree(plugin:fake)"]);
    await page.close();
  });

  it("turns extensions off as a whole, shows an unagreed item's switch off, and points an empty list at the marketplaces (integrations-11)", async () => {
    const empty = await open("extensions");
    await expect.poll(() => empty.locator("#ext-installed").innerText()).toBe("Nothing added yet. Browse a marketplace below.");
    // Not agreed to yet: no switch for the section (the first add's card turns extensions on).
    expect(await empty.locator("#ext-on").isVisible()).toBe(false);
    await empty.close();
    const agreed = { version: 3, at: "2026-11-07T12:00:00Z" };
    const ready: Installed = { id: "plugin:notes", kind: "plugin", name: "Notes", source: "notes@octo-tools", enabled: true, consented: true, status: "ready", tools: [{ name: "list", description: "Lists.", readOnly: true }] };
    const waiting: Installed = { ...ready, id: "plugin:new", name: "New", consented: false };
    const page = await open("extensions", { settings: { extensions: { on: true, consent: agreed } }, extensions: { consented: true, installed: [ready, waiting] } });
    const sw = page.getByRole("switch", { name: "Use extensions" });
    await expect.poll(() => sw.isChecked()).toBe(true);
    expect(await page.locator("#ext-on-hint").innerText()).toBe("Ember may use the tools you agreed to. Turn this off to stop them all: what you added stays here.");
    expect(await page.getByRole("switch", { name: "Use New" }).isChecked()).toBe(false);
    expect(await page.getByRole("switch", { name: "Use Notes" }).isChecked()).toBe(true);
    await sw.click();
    await expect.poll(() => page.locator("#ext-on-hint").innerText()).toBe("Off: Ember uses no extension's tools and runs nothing you added. What you added stays here.");
    expect(await calls(page)).toEqual([`save:${JSON.stringify({ extensions: { on: false, consent: agreed } })}`]);
    expect(await page.locator("#ext-installed li").first().locator(".ext-status").innerText()).toBe("Off: extensions are off");
    await evidence(page, "ext-off");
    await page.close();
  });
});
