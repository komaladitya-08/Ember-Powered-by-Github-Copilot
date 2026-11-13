/**
 * Built Home in Chromium, Apps & privacy › Vault (the round's brief, decision 3): the list by kind, destination and
 * date only, Forget for each and Forget all (which asks first), the organisation's switch, by keyboard, with the names
 * a screen reader gets, in light and dark and at Home's narrowest. Run with EMBER_UIUX_TEST=1 after `npm run build`; EMBER_VAULT_SHOTS names a folder for its pictures.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { VAULT_HINT, VAULT_OFF_HINT, VAULT_UNREAD } from "../../app/renderer/home/copy";
import type { VaultEntryRow } from "../../app/shared/vault";

declare global { interface Window { __vaultHome: { calls: string[]; allowed: boolean; entries: VaultEntryRow[]; fail: boolean; unread: boolean; changed: (() => void)[] } } }

const on = process.env.EMBER_UIUX_TEST === "1";
const shots = process.env.EMBER_VAULT_SHOTS;
let browser: Browser;
let server: http.Server;
let base = "";

beforeAll(async () => {
  if (!on) return;
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

const T = Date.UTC(2026, 10, 12, 12);
const ENTRIES: VaultEntryRow[] = [
  { id: "11111111-1111-4111-8111-000000000003", kind: "contact", where: "Thunderbird", site: false, savedAt: T + 2 * 86_400_000 },
  { id: "11111111-1111-4111-8111-000000000002", kind: "card", where: "shop.example", site: true, savedAt: T + 86_400_000 },
  { id: "11111111-1111-4111-8111-000000000001", kind: "login", where: "github.com", site: true, savedAt: T },
];

async function open(o: { entries?: VaultEntryRow[]; allowed?: boolean; bridge?: boolean; scheme?: "light" | "dark"; width?: number; managed?: string[] } = {}): Promise<{ page: Page; errors: string[] }> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: o.managed ?? [], features: o.allowed === false ? { vault: false } : {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
  const page = await browser.newPage({ viewport: { width: o.width ?? 760, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.emulateMedia({ colorScheme: o.scheme ?? "light" });
  await page.addInitScript(seed => {
    const subs: Record<string, ((v: unknown) => void)[]> = {};
    window.ember = new Proxy({}, { get: (_t, name: string) => {
      if (name.startsWith("on")) return (fn: (v: unknown) => void) => { (subs[name] ??= []).push(fn); return () => undefined; };
      if (name === "getStatus") return async () => seed.status;
      return () => new Promise(() => undefined);
    } }) as never;
    const v = window.__vaultHome = { calls: [] as string[], allowed: seed.allowed, entries: seed.entries, fail: false, unread: false, changed: [] as (() => void)[] };
    if (!seed.bridge) return;
    window.emberVault = {
      state: async () => { if (v.unread) throw new Error("no"); return { allowed: v.allowed, entries: v.entries }; },
      onChanged: fn => { v.changed.push(fn); return () => undefined; },
      forget: async id => { v.calls.push(`forget:${id}`); if (v.fail) return false; v.entries = v.entries.filter(e => e.id !== id); for (const f of v.changed) f(); return true; },
      forgetAll: async () => { v.calls.push("forgetAll"); if (v.fail) return false; v.entries = []; for (const f of v.changed) f(); return true; },
    };
  }, { status, entries: o.entries ?? ENTRIES, allowed: o.allowed ?? true, bridge: o.bridge ?? true });
  await page.goto(`${base}/app/renderer/home/index.html`);
  await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
  await page.locator('a[href="#privacy-h"]').click();
  await page.locator("#vault-h").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}
/** A day as the page's own locale writes it (Chromium's may differ from Node's). */
const dayIn = (page: Page, at: number) => page.evaluate(t => new Date(t).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }), at);
const calls = (page: Page) => page.evaluate(() => window.__vaultHome.calls);
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName || "");
const rows = (page: Page) => page.locator("#vault-list li > span").allInnerTexts();
const shot = async (page: Page, name: string) => { if (shots) { await page.locator("#vault-h").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };

it.skipIf(!on)("lists what the vault keeps by kind, destination and day, named for a screen reader, and never a value (vault-3)", async () => {
  const { page, errors } = await open();
  const days = await Promise.all(ENTRIES.map(e => dayIn(page, e.savedAt)));
  const vaultDay = (at: number) => days[ENTRIES.findIndex(e => e.savedAt === at)];
  expect(days[2]).toMatch(/2026/);
  await expect.poll(() => rows(page)).toEqual([
    `Contact details for Thunderbird, saved ${vaultDay(ENTRIES[0].savedAt)}`,
    `Card for shop.example, saved ${vaultDay(ENTRIES[1].savedAt)}`,
    `Login for github.com, saved ${vaultDay(ENTRIES[2].savedAt)}`,
  ]);
  expect(await page.locator("#vault-hint").innerText()).toBe(VAULT_HINT);
  expect(await page.locator("#vault-list").ariaSnapshot()).toBe([
    '- list "Vault":',
    "  - listitem:",
    `    - text: Contact details for Thunderbird, saved ${vaultDay(ENTRIES[0].savedAt)}`,
    '    - button "Forget the contact details for Thunderbird": Forget',
    "  - listitem:",
    `    - text: Card for shop.example, saved ${vaultDay(ENTRIES[1].savedAt)}`,
    '    - button "Forget the card for shop.example": Forget',
    "  - listitem:",
    `    - text: Login for github.com, saved ${vaultDay(ENTRIES[2].savedAt)}`,
    '    - button "Forget the login for github.com": Forget',
  ].join("\n"));
  expect(await page.locator("#vault-list input, #vault-list [type=password]").count()).toBe(0);
  expect(await page.locator("#vault-forget-all").isVisible()).toBe(true);
  await shot(page, "vault-home-light");
  expect(errors).toEqual([]);
  await page.close();
});

it.skipIf(!on)("forgets one entry by keyboard, says so, and keeps the keyboard in the list (vault-3)", async () => {
  const { page } = await open();
  await page.locator('#vault-list button[aria-label="Forget the card for shop.example"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => calls(page)).toEqual([`forget:${ENTRIES[1].id}`]);
  await expect.poll(() => rows(page)).toHaveLength(2);
  expect(await page.locator("#vault-msg").innerText()).toBe("Forgot the card for shop.example.");
  await expect.poll(() => focused(page)).toBe("Forget the login for github.com");
  // The last row gone: the list says nothing is saved, Forget all goes, and the keyboard is on the list.
  await page.keyboard.press("Enter");
  await expect.poll(() => rows(page)).toHaveLength(1);
  await expect.poll(() => focused(page)).toBe("Forget the contact details for Thunderbird");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.locator("#vault-list li.empty").innerText()).toBe("Nothing saved yet.");
  expect(await page.locator("#vault-forget-all").isHidden()).toBe(true);
  await expect.poll(() => focused(page)).toBe("vault-list");
  await page.close();
});

it.skipIf(!on)("asks before Forget all: Keep them and Esc call nothing, Forget all empties the list (vault-3)", async () => {
  const { page } = await open();
  await page.locator("#vault-forget-all").focus();
  await page.keyboard.press("Enter");
  expect(await page.locator("#vault-forget-scope").innerText()).toBe("Forget all 3 entries in the vault? Ember deletes them from this computer. It asks again, in Autopilot, the next time it needs one.");
  expect(await focused(page)).toBe("vault-forget-no");
  await shot(page, "vault-home-forget-all");
  await page.keyboard.press("Enter");
  expect(await page.locator("#vault-forget-confirm").isHidden()).toBe(true);
  expect(await focused(page)).toBe("vault-forget-all");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  expect(await page.locator("#vault-forget-confirm").isHidden()).toBe(true);
  expect(await focused(page)).toBe("vault-forget-all");
  expect(await calls(page)).toEqual([]);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("vault-forget-yes");
  await page.keyboard.press("Enter");
  await expect.poll(() => calls(page)).toEqual(["forgetAll"]);
  await expect.poll(() => page.locator("#vault-msg").innerText()).toBe("The vault is empty.");
  await expect.poll(() => page.locator("#vault-list li.empty").innerText()).toBe("Nothing saved yet.");
  await expect.poll(() => focused(page)).toBe("vault-list");
  await page.close();
});

it.skipIf(!on)("says when a Forget couldn't be done and keeps the entries listed (vault-6)", async () => {
  const { page } = await open();
  await page.evaluate(() => { window.__vaultHome.fail = true; });
  await page.locator('#vault-list button[aria-label="Forget the login for github.com"]').click();
  await expect.poll(() => page.locator("#vault-msg").innerText()).toBe("Ember couldn't delete that from the vault. Try Forget again.");
  expect(await rows(page)).toHaveLength(3);
  await page.locator("#vault-forget-all").click();
  await page.locator("#vault-forget-yes").click();
  await expect.poll(() => page.locator("#vault-msg").innerText()).toBe("Ember couldn't delete the vault's file. Try Forget all again.");
  expect(await rows(page)).toHaveLength(3);
  await page.close();
});

it.skipIf(!on)("draws the list again when main says it changed: an entry saved in the Secure Form appears (vault-3)", async () => {
  const { page } = await open({ entries: [] });
  await expect.poll(() => page.locator("#vault-list li.empty").innerText()).toBe("Nothing saved yet.");
  expect(await page.locator("#vault-forget-all").isHidden()).toBe(true);
  await page.evaluate(e => { window.__vaultHome.entries = [e]; for (const f of window.__vaultHome.changed) f(); }, ENTRIES[2]);
  await expect.poll(() => rows(page)).toEqual([`Login for github.com, saved ${await dayIn(page, ENTRIES[2].savedAt)}`]);
  expect(await page.locator("#vault-forget-all").isVisible()).toBe(true);
  await page.close();
});

it.skipIf(!on)("says the organisation turned the vault off, and still lists what is kept with Forget (vault-5)", async () => {
  const { page } = await open({ allowed: false, managed: ["vault"] });
  await expect.poll(() => page.locator("#vault-hint").innerText()).toBe(VAULT_OFF_HINT);
  expect(await rows(page)).toHaveLength(3);
  await page.locator('#vault-list button[aria-label="Forget the login for github.com"]').click();
  await expect.poll(() => rows(page)).toHaveLength(2);
  await shot(page, "vault-home-managed");
  await page.close();
});

it.skipIf(!on)("never shows the list as empty when it couldn't be read (vault-3)", async () => {
  const a = await open({ bridge: false });
  expect(await a.page.locator("#vault-list li.empty").innerText()).toBe(VAULT_UNREAD);
  expect(a.errors).toEqual([]);
  await a.page.close();
  const b = await open();
  await b.page.evaluate(() => { window.__vaultHome.unread = true; for (const f of window.__vaultHome.changed) f(); });
  await expect.poll(() => b.page.locator("#vault-list li.empty").innerText()).toBe(VAULT_UNREAD);
  expect(await b.page.locator("#vault-forget-all").isHidden()).toBe(true);
  await b.page.close();
});

it.skipIf(!on)("fits Home at its narrowest and in dark, with nothing cut off sideways (vault-3)", async () => {
  const long: VaultEntryRow[] = [{ id: "11111111-1111-4111-8111-000000000009", kind: "contact", where: "https://a-very-long-internal-host-name.department.example.org:8443", site: true, savedAt: T }, ...ENTRIES];
  for (const [scheme, width] of [["dark", 760], ["light", 420], ["dark", 420]] as const) {
    const { page, errors } = await open({ entries: long, scheme, width });
    await expect.poll(() => rows(page)).toHaveLength(4);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    for (const b of await page.locator("#vault-list button").all()) {
      const box = await b.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await shot(page, `vault-home-${scheme}-${width}`);
    expect(errors).toEqual([]);
    await page.close();
  }
}, 60_000);
