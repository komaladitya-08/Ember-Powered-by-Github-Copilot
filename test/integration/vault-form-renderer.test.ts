/**
 * The built Secure Form in Chromium (the vault; the round's brief, decision 2): its names in the accessibility tree,
 * secret parts in password boxes, the whole form by keyboard, what a slip and a failed Save say, Cancel and Esc keeping
 * nothing, and its look in light and dark and with larger text. Run with EMBER_UIUX_TEST=1 after `npm run build`; EMBER_VAULT_SHOTS names a folder for its pictures.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { formView, VAULT_FORM_SIZE } from "../../app/main/vault/form";
import { VAULT_KEYBOARD_ELSEWHERE, VAULT_NO_KEYRING, VAULT_NOTHING_TYPED, vaultSaveProblem, type VaultFormView, type VaultKind, type VaultSubmitResult } from "../../app/shared/vault";

declare global { interface Window { __vaultCalls: unknown[]; __vaultNext: VaultSubmitResult | "hang"; __vaultRelease: (r: VaultSubmitResult) => void } }

const on = process.env.EMBER_UIUX_TEST === "1";
const shots = process.env.EMBER_VAULT_SHOTS;
const CANARY = "hunter2-CANARY-9f3a";
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

const view = (kind: VaultKind, o: Partial<{ keyring: boolean; app: boolean }> = {}): VaultFormView => formView("form-1", o.app
  ? { kind, dest: { app: "thunderbird" }, where: "Thunderbird", via: null, keyring: o.keyring ?? true }
  : { kind, dest: { site: "https://github.com" }, where: "github.com", via: "Firefox", keyring: o.keyring ?? true });

async function open(v: VaultFormView | null, o: { scheme?: "light" | "dark"; textSize?: string } = {}): Promise<{ page: Page; errors: string[] }> {
  const size = VAULT_FORM_SIZE[v?.kind ?? "login"];
  const page = await browser.newPage({ viewport: size });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  // Chromium asks the fixture's server for a favicon, which it hasn't: every other failed request counts.
  page.on("response", r => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`${r.status()} ${r.url()}`); });
  await page.emulateMedia({ colorScheme: o.scheme ?? "light" });
  await page.addInitScript(seed => {
    window.__vaultCalls = [];
    window.__vaultNext = { ok: true };
    window.emberVaultForm = {
      form: async () => seed,
      submit: (id: string, values: unknown) => {
        window.__vaultCalls.push(["submit", id, values]);
        if (window.__vaultNext === "hang") return new Promise<never>(resolve => { window.__vaultRelease = resolve as never; });
        return Promise.resolve(window.__vaultNext);
      },
      cancel: (id: string) => { window.__vaultCalls.push(["cancel", id]); },
    } as never;
  }, v);
  await page.goto(`${base}/app/renderer/vault/index.html`);
  if (o.textSize) await page.evaluate(s => document.documentElement.setAttribute("data-text-size", s), o.textSize);
  if (v) await page.locator("#card").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}
const calls = (page: Page) => page.evaluate(() => window.__vaultCalls);
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
/** Nothing on the page is cut off sideways, and the buttons are inside the window. */
async function fits(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, save: document.getElementById("cancel")!.getBoundingClientRect().bottom, h: innerHeight }));
  expect(m.sw).toBeLessThanOrEqual(m.cw);
  expect(m.save).toBeLessThanOrEqual(m.h);
}

it.skipIf(!on)("names a login's form and its boxes for a screen reader, with the password in a password box (vault-2)", async () => {
  const { page, errors } = await open(view("login"));
  expect(await page.title()).toBe("Ember");
  expect(await page.locator("#card").ariaSnapshot()).toBe([
    '- dialog "Login for github.com":',
    '  - heading "Login for github.com" [level=1]',
    "  - paragraph: Asked in Firefox. Ember fills it in only on github.com, in any browser.",
    "  - paragraph: Ember keeps it locked with your computer's keyring and uses it only in Autopilot. It never shows it to you again, and the AI model never sees it.",
    "  - text: User name or email (optional)",
    '  - textbox "User name or email (optional)"',
    "  - text: Password",
    '  - textbox "Password"',
    "  - alert",
    "  - paragraph",
    '  - button "Cancel"',
    '  - button "Save in the vault"',
  ].join("\n"));
  expect(await page.locator("#card").getAttribute("aria-describedby")).toBe("where lead");
  expect(await page.locator("#f-password").evaluate((e: HTMLInputElement) => [e.type, e.autocomplete, e.maxLength, e.getAttribute("aria-required")])).toEqual(["password", "off", 1024, "true"]);
  expect(await page.locator("#f-user").evaluate((e: HTMLInputElement) => [e.type, e.getAttribute("aria-required")])).toEqual(["text", null]);
  expect(await focused(page)).toBe("f-user");
  await fits(page);
  await shot(page, "vault-form-login-light");
  expect(errors).toEqual([]);
  await page.close();
});

it.skipIf(!on)("saves a login by keyboard alone: what was typed goes to main once and the boxes are emptied (vault-2)", async () => {
  const { page, errors } = await open(view("login"));
  await page.keyboard.type("ada");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("f-password");
  await page.keyboard.type(CANARY);
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("cancel");
  await page.keyboard.press("Tab");
  expect(await focused(page)).toBe("save");
  await page.keyboard.press("Enter");
  await expect.poll(() => calls(page)).toEqual([["submit", "form-1", { user: "ada", password: CANARY }]]);
  await expect.poll(() => page.locator("#f-password").inputValue()).toBe("");
  expect(await page.locator("#f-user").inputValue()).toBe("");
  // The page never shows what was typed in the password box, and keeps it nowhere else.
  expect(await page.content()).not.toContain(CANARY);
  // Enter again, or Save again: nothing more is sent.
  await page.keyboard.press("Enter");
  expect(await calls(page)).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.close();
});

it.skipIf(!on)("Enter in a box saves, and a missing password is said at its box without sending anything (vault-2)", async () => {
  const { page } = await open(view("login"));
  await page.keyboard.type("ada");
  await page.keyboard.press("Enter");
  expect(await calls(page)).toEqual([]);
  expect(await focused(page)).toBe("f-password");
  expect(await page.locator("#f-password").getAttribute("aria-invalid")).toBe("true");
  expect(await page.locator("#e-password").innerText()).toBe("Type the password.");
  expect(await page.locator("#f-password").getAttribute("aria-describedby")).toBe("e-password");
  expect(await page.locator("#problem").innerText()).toBe(vaultSaveProblem("invalid"));
  await shot(page, "vault-form-login-missing");
  // Typing clears the box's own line.
  await page.keyboard.type("x");
  expect(await page.locator("#f-password").getAttribute("aria-invalid")).toBeNull();
  expect(await page.locator("#e-password").innerText()).toBe("");
  await page.keyboard.press("Enter");
  await expect.poll(() => calls(page)).toEqual([["submit", "form-1", { user: "ada", password: "x" }]]);
  await page.close();
});

it.skipIf(!on)("keeps nothing at Cancel or Esc, and empties the boxes (vault-2)", async () => {
  for (const how of ["Escape", "cancel"] as const) {
    const { page } = await open(view("login"));
    await page.locator("#f-password").fill(CANARY);
    if (how === "Escape") await page.keyboard.press("Escape"); else await page.locator("#cancel").click();
    expect(await calls(page)).toEqual([["cancel", "form-1"]]);
    expect(await page.locator("#f-password").inputValue()).toBe("");
    await page.close();
  }
});

it.skipIf(!on)("says what main refused: a part it names, a file it couldn't write, a full vault, and stays to try again (vault-2)", async () => {
  const { page } = await open(view("card"));
  await page.locator("#f-cardNumber").fill("4242 4242 4242 4242");
  await page.locator("#f-expiry").fill("08/29");
  await page.locator("#f-securityCode").fill("123");
  await page.evaluate(() => { window.__vaultNext = { ok: false, why: "invalid", part: "expiry" }; });
  await page.locator("#save").click();
  await expect.poll(() => page.locator("#e-expiry").innerText()).toBe("Type the expiry date as MM/YY, for example 08/29.");
  expect(await focused(page)).toBe("f-expiry");
  for (const why of ["write", "full"] as const) {
    await page.evaluate(w => { window.__vaultNext = { ok: false, why: w }; }, why);
    await page.locator("#save").click();
    await expect.poll(() => page.locator("#problem").innerText()).toBe(vaultSaveProblem(why));
    expect(await page.locator("#f-cardNumber").inputValue()).toBe("4242 4242 4242 4242");
    expect(await page.locator("#save").isVisible()).toBe(true);
  }
  await fits(page);
  await shot(page, "vault-form-card-full");
  // The page's own check: a card number that isn't one never leaves the page.
  const before = (await calls(page)).length;
  await page.locator("#f-cardNumber").fill("4242");
  await page.locator("#save").click();
  expect(await page.locator("#e-cardNumber").innerText()).toBe("Type the card's number: 12 to 19 digits.");
  expect((await calls(page)).length).toBe(before);
  await page.close();
});

it.skipIf(!on)("holds a second Save and Cancel while one is being kept, and leaves only Close once main has closed the request (vault-2)", async () => {
  const { page } = await open(view("login"));
  await page.locator("#f-password").fill(CANARY);
  await page.evaluate(() => { window.__vaultNext = "hang"; });
  await page.locator("#save").click();
  await expect.poll(() => page.locator("#problem").innerText()).toBe("Saving…");
  expect(await page.locator("#save").getAttribute("aria-disabled")).toBe("true");
  expect(await focused(page)).toBe("save");
  await page.keyboard.press("Enter");
  await page.locator("#save").click({ force: true });
  await page.keyboard.press("Escape");
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(() => window.__vaultRelease({ ok: false, why: "gone" }));
  await expect.poll(() => page.locator("#problem").innerText()).toBe(vaultSaveProblem("gone"));
  expect(await page.locator("#save").isVisible()).toBe(false);
  expect(await page.locator("#cancel").innerText()).toBe("Close");
  expect(await page.locator("#f-password").inputValue()).toBe("");
  expect(await focused(page)).toBe("cancel");
  await page.close();
});

it.skipIf(!on)("says the vault can't be used without a keyring, asks for nothing and offers only Close (vault-2)", async () => {
  const { page, errors } = await open(view("login", { keyring: false }));
  expect(await page.locator("#lead").innerText()).toBe(VAULT_NO_KEYRING);
  expect(await page.locator("input, textarea").count()).toBe(0);
  expect(await page.locator("#save").isVisible()).toBe(false);
  expect(await page.locator("#cancel").innerText()).toBe("Close");
  expect(await focused(page)).toBe("cancel");
  await page.keyboard.press("Enter");
  await expect.poll(() => calls(page)).toEqual([["cancel", "form-1"]]);
  await shot(page, "vault-form-no-keyring");
  expect(errors).toEqual([]);
  await page.close();
});

it.skipIf(!on)("asks for contact details with every box optional, an address on several lines, and nothing typed is said (vault-2)", async () => {
  const { page } = await open(view("contact", { app: true }));
  expect(await page.locator("#where").innerText()).toBe("Ember fills them in only in Thunderbird.");
  expect(await page.locator(".field label").allInnerTexts()).toEqual(["Full name (optional)", "Email (optional)", "Phone (optional)", "Address (optional)"]);
  await page.locator("#save").click();
  expect(await page.locator("#problem").innerText()).toBe(VAULT_NOTHING_TYPED);
  expect(await focused(page)).toBe("f-name");
  await page.locator("#f-address").focus();
  await page.keyboard.type("1 Main St");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Springfield");
  expect(await calls(page)).toEqual([]);
  await page.locator("#f-email").fill("not an email");
  await page.locator("#save").click();
  expect(await page.locator("#e-email").innerText()).toBe("Type an email address, or leave it empty.");
  await page.locator("#f-email").fill("ada@example.org");
  await page.locator("#save").click();
  await expect.poll(() => calls(page)).toEqual([["submit", "form-1", { email: "ada@example.org", address: "1 Main St\nSpringfield" }]]);
  await page.close();
});

it.skipIf(!on)("says the keyboard is elsewhere when its window hasn't got it (vault-2)", async () => {
  const { page } = await open(view("login"));
  await page.evaluate(() => { Object.defineProperty(document, "hasFocus", { value: () => false }); window.dispatchEvent(new Event("blur")); });
  await expect.poll(() => page.locator("#hint").innerText(), { timeout: 3000 }).toBe(VAULT_KEYBOARD_ELSEWHERE);
  await page.close();
});

it.skipIf(!on)("stays empty with no form for its window (vault-2)", async () => {
  const { page, errors } = await open(null);
  expect(await page.locator("#card").isHidden()).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
});

it.skipIf(!on)("fits its window in light and dark, for each kind, and with the largest text (vault-2)", async () => {
  for (const kind of ["login", "card", "contact"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      const { page, errors } = await open(view(kind), { scheme });
      await fits(page);
      // Every box is reachable: none lies under the buttons.
      const last = await page.locator(".field").last().boundingBox();
      const buttons = await page.locator(".buttons").boundingBox();
      expect(last!.y + last!.height).toBeLessThanOrEqual(buttons!.y);
      await shot(page, `vault-form-${kind}-${scheme}`);
      expect(errors).toEqual([]);
      await page.close();
    }
  }
  const { page } = await open(view("card"), { textSize: "larger" });
  await fits(page);
  await shot(page, "vault-form-card-larger-text");
  await page.close();
}, 60_000);
