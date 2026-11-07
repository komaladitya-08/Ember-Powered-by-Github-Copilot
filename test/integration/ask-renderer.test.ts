/**
 * The built Ask renderer in real Chromium with a controlled preload boundary. This checks pointer and keyboard
 * submission, IME, retained drafts, and measured wrapping separately from the native window-size suites. Set
 * EMBER_CHROMIUM_PATH to a browser executable; EMBER_BROWSER_TEST=1 makes a missing browser or build fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AskContext, ListenOnceStatus } from "../../app/shared/ipc";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, "dist/app");
const executable = [process.env.EMBER_CHROMIUM_PATH, chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
  .find((p): p is string => !!p && fs.existsSync(p));
const built = fs.existsSync(path.join(dist, "renderer/ask/main.js"));
const required = process.env.EMBER_BROWSER_TEST === "1";
type Typed = { text: string; submit: boolean; cancel: boolean };
interface Harness {
  rows: number;
  calls: { kind: "ask" | "suggestion"; text: string }[];
  closes: number;
  /** Presses that asked main to listen, and the way to Settings for voice. */
  listens: number;
  voiceSettings: number;
  context(c: AskContext): void;
  typed(t: Typed): void;
  hidden(): void;
  listen(s: ListenOnceStatus): void;
}
type TestWindow = Window & { askHarness: Harness };
const suggestions = [
  "Please review the current project and explain the next steps",
  "Explain this document thoroughly",
  "Suggest improvements to this app",
];

describe.skipIf(!required && (!executable || !built))("Ask's rendered controls", () => {
  let browser: Browser;
  beforeAll(async () => {
    if (!executable || !built) throw new Error(`Ask renderer verification needs ${!executable ? "Chromium (EMBER_CHROMIUM_PATH)" : "a build (npm run build)"}`);
    browser = await chromium.launch({ executablePath: executable, headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  }, 30_000);
  afterAll(async () => { await browser?.close(); });

  async function pageAt(width = 560): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 400 }, reducedMotion: "reduce" });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      const file = path.resolve(dist, "." + url.pathname);
      if (url.origin !== "http://ember.test" || !file.startsWith(dist + path.sep) || !fs.existsSync(file)) return route.abort();
      const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
      await route.fulfill({ body: fs.readFileSync(file), contentType });
    });
    await page.addInitScript(() => {
      const state: Harness = { rows: 3, calls: [], closes: 0, listens: 0, voiceSettings: 0, context() {}, typed() {}, hidden() {}, listen() {} };
      (window as unknown as TestWindow).askHarness = state;
      window.emberAsk = {
        ask: text => { state.calls.push({ kind: "ask", text }); },
        askSuggestion: text => { state.calls.push({ kind: "suggestion", text }); },
        close: () => { state.closes++; },
        fit: rows => { state.rows = rows; },
        onContext: fn => { state.context = fn; },
        onTyped: fn => { state.typed = fn; },
        onHidden: fn => { state.hidden = fn; },
        onListenOnce: fn => { state.listen = fn; },
        listenOnce: async () => { state.listens++; return { phase: "ready", detail: "" }; },
        voiceSettings: () => { state.voiceSettings++; },
      };
    });
    await page.goto("http://ember.test/renderer/ask/index.html");
    await page.evaluate(() => (window as unknown as TestWindow).askHarness.context({ opened: true, sees: null, history: [], listenOnce: { phase: "ready", detail: "" } }));
    return page;
  }

  /** Main's row allocation, capped by the work area; resizing lets the real ResizeObserver settle the wrapped rows. */
  async function fit(page: Page, cap = 800): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const height = await page.evaluate(max => {
        const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--text-scale"));
        return Math.min(max, Math.round(92 + 63 * (scale - 1)) + Math.round(((window as unknown as TestWindow).askHarness.rows - 1) * 24 * scale));
      }, cap);
      await page.setViewportSize({ width: page.viewportSize()!.width, height });
      await page.waitForTimeout(40);
    }
  }

  it("sends once by pointer or keyboard, leaves composition alone and keeps Shift+Enter's newline", async () => {
    const page = await pageAt();
    try {
      const input = page.locator("#q"), send = page.getByRole("button", { name: "Send", exact: true });
      await input.fill("   ");
      expect(await send.isDisabled()).toBe(true);
      await input.fill("Please summarise\nthis document.");
      expect(await send.isEnabled()).toBe(true);
      await send.click();
      expect(await page.evaluate(() => (window as unknown as TestWindow).askHarness.calls)).toEqual([{ kind: "ask", text: "Please summarise\nthis document." }]);
      expect(await input.inputValue()).toBe("");
      expect(await send.isDisabled()).toBe(true);
      await input.fill("Next request");
      await input.press("Shift+Enter");
      expect(await input.inputValue()).toBe("Next request\n");
      await input.press("Enter");
      await input.fill("日本語");
      const intercepted = await input.evaluate(e => !e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
      expect(intercepted).toBe(false);
      expect(await page.evaluate(() => (window as unknown as TestWindow).askHarness.calls.length)).toBe(2);
      await input.press("Tab");
      expect(await send.evaluate(e => e === document.activeElement)).toBe(true);
      await send.press("Space");
      expect(await page.evaluate(() => (window as unknown as TestWindow).askHarness.calls)).toEqual([
        { kind: "ask", text: "Please summarise\nthis document." }, { kind: "ask", text: "Next request" }, { kind: "ask", text: "日本語" },
      ]);
    } finally { await page.close(); }
  }, 30_000);

  it("retains the draft and selection through late context, microphone updates and dismissal", async () => {
    const page = await pageAt();
    try {
      const input = page.locator("#q");
      await input.fill("A draft\nwith another line");
      await input.evaluate(e => (e as HTMLTextAreaElement).setSelectionRange(2, 7));
      await page.evaluate(() => {
        const state = (window as unknown as TestWindow).askHarness;
        state.context({ sees: "Editor · Draft", history: ["Earlier request"], carries: { selection: true, fieldText: false, windows: 2 } });
        state.listen({ phase: "blocked", detail: "The microphone is muted. Unmute it to speak one request." });
      });
      expect(await input.evaluate(e => ({ focused: e === document.activeElement, start: (e as HTMLTextAreaElement).selectionStart, end: (e as HTMLTextAreaElement).selectionEnd })))
        .toEqual({ focused: true, start: 2, end: 7 });
      expect(await page.locator("#sees-full").textContent()).toContain("the text you selected");
      await page.locator("#send").focus();
      await page.evaluate(() => (window as unknown as TestWindow).askHarness.context({ sees: "Editor · Updated draft", history: [] }));
      expect(await page.locator("#send").evaluate(e => e === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => (window as unknown as TestWindow).askHarness.closes)).toBe(1);
      await page.evaluate(() => { const state = (window as unknown as TestWindow).askHarness; state.hidden(); state.context({ opened: true, sees: null, history: [] }); });
      expect(await input.inputValue()).toBe("A draft\nwith another line");
      expect(await input.evaluate(e => ({ start: (e as HTMLTextAreaElement).selectionStart, end: (e as HTMLTextAreaElement).selectionEnd }))).toEqual({ start: 0, end: "A draft\nwith another line".length });
    } finally { await page.close(); }
  }, 30_000);

  it("shows every suggestion and comfortable controls at narrow widths, every text size and forced colours", async () => {
    const page = await pageAt();
    try {
      for (const size of ["default", "large", "larger"] as const) for (const width of [320, 460]) for (const forced of [false, true]) {
        await page.emulateMedia({ forcedColors: forced ? "active" : "none" });
        await page.setViewportSize({ width, height: 400 });
        await page.evaluate(({ size, suggestions }) => {
          document.documentElement.dataset.textSize = size;
          (window as unknown as TestWindow).askHarness.context({ opened: true, sees: null, history: [], suggestions, listenOnce: { phase: "ready", detail: "" } });
        }, { size, suggestions });
        await fit(page);
        const seen = await page.evaluate(() => {
          const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--text-scale"));
          const form = document.getElementById("form")!;
          return {
            scale, rows: (window as unknown as TestWindow).askHarness.rows, clipped: form.scrollHeight > form.clientHeight + 1,
            fieldHeight: document.querySelector(".field")!.getBoundingClientRect().height,
            controls: [...document.querySelectorAll<HTMLButtonElement>("button:not([hidden])")].map(b => {
              const r = b.getBoundingClientRect(), css = getComputedStyle(b);
              return { text: b.textContent, height: r.height, left: r.left, right: r.right, bottom: r.bottom,
                clipped: b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1, border: css.borderTopStyle };
            }),
          };
        });
        const label = `${size}, ${width}px, forced colours ${forced}: ${JSON.stringify(seen)}`;
        expect(seen.clipped, label).toBe(false);
        // Chromium's intrinsic textarea minimum includes its two border pixels; the empty field stays one line.
        expect(seen.fieldHeight, label).toBeLessThanOrEqual(46 * seen.scale + 2.1);
        expect(seen.rows, label).toBeGreaterThan(4);
        expect(seen.controls.map(c => c.text), label).toEqual(["Send", "Listen once", ...suggestions]);
        for (const control of seen.controls) {
          expect(control.height, label).toBeGreaterThanOrEqual(28 * seen.scale - 0.1);
          expect(control.clipped, label).toBe(false);
          expect(control.left, label).toBeGreaterThanOrEqual(0);
          expect(control.right, label).toBeLessThanOrEqual(width);
          expect(control.bottom, label).toBeLessThanOrEqual(page.viewportSize()!.height);
          if (forced) expect(control.border, label).toBe("solid");
        }
      }
      await page.locator("#suggest button").nth(2).click();
      expect(await page.evaluate(() => (window as unknown as TestWindow).askHarness.calls)).toEqual([{ kind: "suggestion", text: suggestions[2] }]);
    } finally { await page.close(); }
  }, 60_000);

  it("shows a blocked Listen once as unavailable, offers Settings for missing speech models and leaves it out where the organisation turned voice off (companion-3)", async () => {
    const page = await pageAt();
    try {
      const harness = () => page.evaluate(() => { const h = (window as unknown as TestWindow).askHarness; return { rows: h.rows, listens: h.listens, voiceSettings: h.voiceSettings }; });
      // Each opening: main has reserved its rows (askOpeningRows, listen-once-ui.test.ts); the page asks for others only
      // when what it shows needs them (rows stays -1 when it agrees).
      const open = (listenOnce: ListenOnceStatus) => page.evaluate(l => {
        const h = (window as unknown as TestWindow).askHarness;
        h.rows = -1;
        h.context({ opened: true, sees: null, history: [], listenOnce: l });
      }, listenOnce);
      const button = page.locator("#listen-once");
      // Waiting on something that passes (a question up): the row stays, its button announced and drawn as unavailable.
      await open({ phase: "blocked", detail: "Answer Ember's question first." });
      expect(await button.getAttribute("aria-disabled")).toBe("true");
      expect(await button.evaluate(e => getComputedStyle(e).opacity)).toBe("0.4");
      await button.click({ force: true });
      expect((await harness()).listens).toBe(0);
      expect(await page.locator("#listen-once-detail").textContent()).toBe("Answer Ember's question first.");
      expect((await harness()).rows).toBe(-1);
      // Only Settings' Download fixes this: one button that goes there, no dead control.
      await open({ phase: "blocked", detail: "Download speech models in Settings first.", fix: "settings" });
      expect(await button.isVisible()).toBe(false);
      expect(await page.locator("#listen-once-detail").isVisible()).toBe(false);
      const setup = page.getByRole("button", { name: "Set up voice in Settings…", exact: true });
      expect(await setup.isVisible()).toBe(true);
      expect(await setup.getAttribute("aria-disabled")).toBeNull();
      await setup.click();
      expect(await harness()).toMatchObject({ rows: -1, listens: 0, voiceSettings: 1 });
      // Turned off by the organisation: nothing here can change that, so the row is left out and the box is a row shorter.
      await open({ phase: "blocked", detail: "Your organisation has turned voice off.", fix: "admin" });
      expect(await page.locator("#listen-once-row").isVisible()).toBe(false);
      expect(await page.locator("#listen-once-row").evaluate(e => (e as HTMLElement).offsetHeight)).toBe(0);
      expect((await harness()).rows).toBe(-1);
      // The row going while the box is open (the organisation's policy can't change then, but a status can): one row now.
      await open({ phase: "ready", detail: "" });
      await page.evaluate(() => (window as unknown as TestWindow).askHarness.listen({ phase: "blocked", detail: "Your organisation has turned voice off.", fix: "admin" }));
      expect((await harness()).rows).toBe(1);
      // Ready again: Listen once is back and works.
      await open({ phase: "ready", detail: "" });
      expect(await button.isVisible()).toBe(true);
      expect(await setup.isVisible()).toBe(false);
      expect(await button.getAttribute("aria-disabled")).toBe("false");
      await button.click();
      expect((await harness()).listens).toBe(1);
    } finally { await page.close(); }
  }, 30_000);

  it("keeps every suggestion reachable when a small work area caps the window's height", async () => {
    const page = await pageAt(300);
    try {
      await page.evaluate(suggestions => {
        document.documentElement.dataset.textSize = "larger";
        (window as unknown as TestWindow).askHarness.context({ opened: true, sees: null, history: [], suggestions, listenOnce: { phase: "ready", detail: "" } });
      }, suggestions);
      await fit(page, 164);
      expect(await page.locator("#form").evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
      const last = page.locator("#suggest button").last();
      await last.focus();
      await last.scrollIntoViewIfNeeded();
      expect(await last.evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
      await last.click();
      expect(await page.evaluate(() => (window as unknown as TestWindow).askHarness.calls)).toEqual([{ kind: "suggestion", text: suggestions[2] }]);
    } finally { await page.close(); }
  }, 30_000);
});
