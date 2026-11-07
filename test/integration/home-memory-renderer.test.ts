/** Built Home in Chromium: memory outcomes, live-list focus and selectable retrieval at the preload boundary. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import type { MemoryCorrection } from "../../app/shared/memory-correction";
import type { EmberHomeApi, MemoryView, VoiceWord } from "../../app/shared/ipc";

declare global {
  interface Window {
    __memoryTest: {
      words: VoiceWord[]; rows: MemoryView["rows"]; focused: Element | null; forgetCalls: number; correctionsSent: MemoryCorrection[];
      resolveCorrection(row: MemoryView["rows"][number]): void; rejectCorrection(message: string): void;
      resolve(): void; reject(message: string): void;
      memory(view: MemoryView): void; corrections(rows: VoiceWord[]): void;
    };
  }
}

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("keeps Undo truthful, preserves live-list focus and lets users choose later search matches", async () => {
  const facts: MemoryView["rows"] = Array.from({ length: 5000 }, (_, i) => ({ id: `fact-${i}`, text: `Unique preference number ${i}`, source: i % 2 ? "conversation" : "user", at: "2026-11-04" }));
  const words: VoiceWord[] = [{ heard: "umber", meant: "Ember", at: "2026-11-04" }, { heard: "arc", meant: "Ark", at: "2026-11-04" }];
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
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
      const listeners: Record<string, (value: unknown) => void> = {};
      const test: Window["__memoryTest"] = window.__memoryTest = {
        words: seed.words, rows: seed.facts, correctionsSent: [] as MemoryCorrection[], resolveCorrection: (_row: MemoryView["rows"][number]) => undefined, rejectCorrection: (_message: string) => undefined, focused: null as Element | null, forgetCalls: 0,
        resolve: () => undefined, reject: (_message: string) => undefined,
        memory: (view: MemoryView) => { test.rows = view.rows; listeners.onMemory?.(view); },
        corrections: (rows: VoiceWord[]) => { test.words = rows; listeners.onVoiceWords?.(rows); },
      };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { listeners[name] = fn; return () => { delete listeners[name]; }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "correctMemory") return (request: MemoryCorrection) => { test.correctionsSent.push(request); return new Promise<MemoryView["rows"][number]>((resolve, reject) => { test.resolveCorrection = resolve; test.rejectCorrection = message => reject(new Error(message)); }); };
        if (name === "memory") return async () => ({ rows: seed.facts, ownership: "ready" });
        if (name === "voiceWords") return async () => seed.words;
        if (name === "reminders") return async () => [];
        if (name === "conversation") return async () => [{ t: "2026-11-04T12:00:00Z", who: "learned", text: "Prefers tea", fact: "fact-0" }];
        if (name === "forgetMemory") return () => { test.forgetCalls++; return new Promise<void>((resolve, reject) => { test.resolve = resolve; test.reject = message => reject(new Error(message)); }); };
        if (name === "forgetVoiceWord") return async (word: VoiceWord) => { test.words = test.words.filter(row => JSON.stringify(row) !== JSON.stringify(word)); return test.words; };
        if (name === "forgetVoiceWords") return async () => { throw new Error("Private filesystem detail"); };
        // Other settings calls stay pending; all real renderer listeners still mount.
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { facts, words, status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await expect.poll(() => page.locator("#conversation li.learned button").count()).toBe(1);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    const undo = page.locator("#conversation li.learned button");
    await undo.click();
    expect(await undo.innerText()).toBe("Forgetting…");
    await undo.dispatchEvent("click");
    expect(await page.evaluate(() => window.__memoryTest.forgetCalls)).toBe(1);
    await page.evaluate(() => window.__memoryTest.reject("Private filesystem detail"));
    await expect.poll(() => undo.innerText()).toBe("Undo");
    expect(await undo.getAttribute("aria-disabled")).toBeNull();
    expect(await page.locator("#conversation").innerText()).toContain("Try Undo again.");
    expect(await page.locator("#conversation").innerText()).not.toContain("Private filesystem");
    await undo.click();
    await page.evaluate(() => window.__memoryTest.resolve());
    await expect.poll(() => undo.innerText()).toBe("Forgotten");
    await page.locator('a[href="#memory-h"]').click();
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(50);
    expect(await page.locator("#memory-count").innerText()).toBe("50 of 5000 memories");
    await page.locator("#memory-list [data-memory-forget]").first().focus();
    await page.evaluate(rows => {
      window.__memoryTest.focused = document.activeElement;
      window.__memoryTest.memory({ ownership: "ready", rows: [{ id: "new", text: "New memory", source: "user", at: "2026-11-04" }, ...rows] });
    }, facts);
    expect(await page.evaluate(() => document.activeElement === window.__memoryTest.focused)).toBe(true);
    await page.locator("#memory-query").fill("UNIQUE 4999");
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(1);
    await page.locator("#memory-source").selectOption("user");
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(0);
    expect(await page.locator("#memory-list").innerText()).toContain("No memories match");
    await page.locator("#memory-source").selectOption("");
    await page.locator("#memory-query").fill("");
    await page.locator("#memory-more").click();
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(100);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Forget: Unique preference number 49");
    // The same saved row can be reinforced or corrected without replacing its focused controls.
    await page.locator('[data-memory-correct="fact-0"]').locator("..").locator("[data-memory-forget]").focus();
    await page.evaluate(() => {
      window.__memoryTest.focused = document.activeElement;
      window.__memoryTest.memory({ ownership: "ready", epoch: 0, rows: window.__memoryTest.rows.map(row => row.id === "fact-0" ? { ...row, text: "Reinforced preference", source: "user" } : row) });
    });
    expect(await page.evaluate(() => document.activeElement === window.__memoryTest.focused)).toBe(true);
    const firstFact = page.locator('[data-memory-correct="fact-0"]').locator("../..");
    expect(await firstFact.locator(".mem-fact").innerText()).toContain("Reinforced preference");
    expect(await firstFact.locator(".mem-from").innerText()).toBe("You told me");
    expect(await firstFact.locator("[data-memory-forget]").getAttribute("aria-label")).toBe("Forget: Reinforced preference");
    await page.locator('[data-memory-correct="fact-0"]').click();
    const correction = page.locator("#memory-correction-text");
    await correction.fill("Corrected preference");
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "memory-correction-form.png") });
      await page.setViewportSize({ width: 560, height: 800 });
      await page.evaluate(() => { document.documentElement.dataset.textSize = "larger"; });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "memory-correction-form-narrow.png") });
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.evaluate(() => { document.documentElement.dataset.textSize = "default"; });
    }
    await page.evaluate(() => window.__memoryTest.memory({ ownership: "ready", epoch: 0, rows: [{ id: "another", text: "Another fact", source: "task", at: "2026-11-04" }, ...window.__memoryTest.rows] }));
    expect(await correction.inputValue()).toBe("Corrected preference");
    expect(await correction.evaluate(el => document.activeElement === el)).toBe(true);
    await page.locator("#memory-correction-save").click();
    await page.evaluate(() => window.__memoryTest.rejectCorrection("Private filesystem detail"));
    await expect.poll(() => page.locator("#memory-correction-status").innerText()).toContain("Your words are still here");
    expect(await correction.inputValue()).toBe("Corrected preference");
    expect(await page.locator("#memory-correction-status").innerText()).not.toContain("Private filesystem");
    await page.locator("#memory-correction-save").click();
    await page.evaluate(() => {
      const request = window.__memoryTest.correctionsSent.at(-1)!;
      const updated = { ...request.expected, text: request.text, revision: (request.expected.revision ?? 0) + 1, correctedAt: "2026-11-04T12:01:00Z" };
      // The durable reply repairs a missed live notification without requiring another read.
      window.__memoryTest.resolveCorrection(updated);
    });
    await expect.poll(() => page.locator("#memory-correction").isHidden()).toBe(true);
    expect(await firstFact.locator(".mem-from").innerText()).toBe("You told me · Corrected by you");
    expect(await firstFact.locator(".mem-fact").innerText()).toContain("Corrected preference");
    // A newer pushed version wins over an older successful acknowledgement.
    await page.locator('[data-memory-correct="fact-0"]').click();
    await correction.fill("An acknowledged correction");
    await page.locator("#memory-correction-save").click();
    await page.evaluate(() => {
      const request = window.__memoryTest.correctionsSent.at(-1)!;
      const corrected = { ...request.expected, text: request.text, revision: (request.expected.revision ?? 0) + 1, correctedAt: "2026-11-04T12:02:00Z" };
      window.__memoryTest.memory({ ownership: "ready", epoch: 0, rows: window.__memoryTest.rows.map(row => row.id === corrected.id ? { ...corrected, text: "A newer saved edit", revision: corrected.revision + 1 } : row) });
      window.__memoryTest.resolveCorrection(corrected);
    });
    await expect.poll(() => page.locator("#memory-correction").isHidden()).toBe(true);
    expect(await firstFact.locator(".mem-fact").innerText()).toContain("A newer saved edit");
    // Cancellation does not write; a background change keeps the draft and blocks an accidental stale overwrite.
    await page.locator('[data-memory-correct="fact-1"]').click();
    await correction.fill("Unsent correction");
    const sent = await page.evaluate(() => window.__memoryTest.correctionsSent.length);
    await page.locator("#memory-correction-cancel").click();
    expect(await page.evaluate(() => window.__memoryTest.correctionsSent.length)).toBe(sent);
    await page.locator('[data-memory-correct="fact-1"]').click();
    await correction.fill("My draft survives");
    await page.evaluate(() => window.__memoryTest.memory({ ownership: "ready", epoch: 0, rows: window.__memoryTest.rows.map(row => row.id === "fact-1" ? { ...row, text: "Newer wording", revision: 1 } : row) }));
    await page.locator("#memory-correction-save").click();
    expect(await correction.inputValue()).toBe("My draft survives");
    expect(await page.locator("#memory-correction-status").innerText()).toContain("changed while you were editing");
    expect(await page.evaluate(() => window.__memoryTest.correctionsSent.length)).toBe(sent);
    await page.locator("#memory-correction-cancel").click();
    await page.locator('[data-memory-correct="fact-1"]').click();
    await correction.fill("My correction of an inferred preference");
    await page.locator("#memory-correction-save").click();
    await page.evaluate(() => {
      const request = window.__memoryTest.correctionsSent.at(-1)!;
      window.__memoryTest.resolveCorrection({ ...request.expected, text: request.text, revision: (request.expected.revision ?? 0) + 1, correctedAt: "2026-11-04T12:03:00Z" });
    });
    await expect.poll(() => page.locator("#memory-correction").isHidden()).toBe(true);
    expect(await page.locator('[data-memory-correct="fact-1"]').locator("../..").locator(".mem-from").innerText()).toBe("From our conversation · Corrected by you");
    // An old account acknowledgement cannot restore private draft text or status after ownership changes.
    await page.locator('[data-memory-correct="fact-2"]').click();
    await correction.fill("Private unfinished correction");
    await page.locator("#memory-correction-save").click();
    await page.evaluate(() => window.__memoryTest.memory({ ownership: "locked", epoch: 1, rows: [] }));
    expect(await correction.inputValue()).toBe("");
    await page.evaluate(() => window.__memoryTest.rejectCorrection("Ember couldn't save this correction. Old account response."));
    expect(await page.locator("#memory-correction-status").innerText()).toBe("");
    await page.evaluate(rows => window.__memoryTest.memory({ ownership: "ready", epoch: 2, rows }), facts);
    await page.locator('[data-memory-correct="fact-2"]').click();
    await correction.fill("An old account success response");
    await page.locator("#memory-correction-save").click();
    await page.evaluate(() => {
      const request = window.__memoryTest.correctionsSent.at(-1)!;
      window.__memoryTest.memory({ ownership: "locked", epoch: 3, rows: [] });
      window.__memoryTest.resolveCorrection({ ...request.expected, text: request.text, revision: 1, correctedAt: "2026-11-04T12:04:00Z" });
    });
    expect(await correction.inputValue()).toBe("");
    expect(await page.locator("#memory-correction").isHidden()).toBe(true);
    expect(await page.locator("#memory-correction-status").innerText()).toBe("");
    await page.evaluate(rows => window.__memoryTest.memory({ ownership: "ready", epoch: 4, rows }), facts);
    await page.locator('a[href="#voice-h"]').click();
    await page.locator("#words-list button").first().focus();
    await page.evaluate(() => {
      window.__memoryTest.focused = document.activeElement;
      window.__memoryTest.corrections([...window.__memoryTest.words, { heard: "meal", meant: "Miele", at: "2026-11-04" }]);
    });
    expect(await page.evaluate(() => document.activeElement === window.__memoryTest.focused)).toBe(true);
    await page.locator("#words-list button").first().click();
    await expect.poll(() => page.locator("#words-list button").count()).toBe(2);
    expect(await page.evaluate(() => document.activeElement === document.querySelector("#words-list button"))).toBe(true);
    await page.locator("#words-forget-all").click();
    await page.locator("#words-forget-yes").click();
    await expect.poll(() => page.locator("#words-note").innerText()).toContain("Couldn't forget");
    expect(await page.locator("#words-forget-all").getAttribute("aria-disabled")).toBeNull();
    await page.locator("#search").fill("memory");
    const later = page.locator("#search-results button.search-result").filter({ hasText: "Memory: Search memory" });
    expect(await later.count()).toBe(1);
    await later.click();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-query");
    expect(await page.locator("#search-results").isHidden()).toBe(true);
    await page.locator("#search").focus();
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => !!document.activeElement?.closest("#search-results"))).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator("#search-results").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("search");
    for (const width of [560, 1000]) for (const size of ["default", "larger"]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(textSize => { document.documentElement.dataset.textSize = textSize; document.documentElement.classList.add("calm"); }, size);
      await page.locator("#search").fill("memory");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.EMBER_UI_EVIDENCE) {
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `memory-search-${width}-${size}.png`) });
      }
    }
    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.locator("#search-results").isVisible()).toBe(true);
    await page.locator("#search").press("Escape");
    await page.locator('a[href="#memory-h"]').click();
    await page.locator("#memory-more").focus();
    await page.evaluate(() => window.__memoryTest.memory({ ownership: "locked", rows: [] }));
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-on");
    await page.evaluate(rows => window.__memoryTest.memory({ ownership: "ready", rows }), facts);
    await page.locator("#memory-query").focus();
    await page.evaluate(() => window.__memoryTest.memory({ ownership: "locked", rows: [] }));
    expect(await page.locator("#memory-count").isHidden()).toBe(true);
    expect(await page.locator("#memory-list").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-on");
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("says why saved memory is paused, never offers to erase memory that only waits, and keeps About you from failing (memory-2, integrations-2)", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
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
      const listeners: Record<string, (value: unknown) => void> = {};
      (window as unknown as { __push: (view: MemoryView) => void }).__push = view => listeners.onMemory?.(view);
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { listeners[name] = fn; return () => { delete listeners[name]; }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "memory") return async () => ({ rows: [], ownership: "locked", reason: "own-provider" });
        if (name === "voiceWords" || name === "reminders" || name === "conversation") return async () => [];
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    await expect.poll(() => page.locator("#whats-on").textContent()).toContain("Memory paused");
    await page.locator('a[href="#memory-h"]').click();
    await expect.poll(() => page.locator("#memory-owner").textContent()).toContain("paused while Ember uses your own model provider");
    const owner = page.locator("#memory-owner");
    expect(await owner.isHidden()).toBe(false);
    expect(await owner.textContent()).not.toContain("Forget everything");
    expect(await page.locator("#memory-forget-all").isHidden()).toBe(true);
    // Tell Ember about you says why instead of asking questions it can't keep the answers to.
    expect(await page.locator("#ay-name").isVisible()).toBe(false);
    expect(await page.locator("#about-you").innerText()).toContain("paused while Ember uses your own model provider");
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "memory-provider-paused.png"), fullPage: true });
    }
    // Memory that really is another account's may be cleared.
    await page.evaluate(() => (window as unknown as { __push: (view: MemoryView) => void }).__push({ rows: [], ownership: "locked", reason: "other-account" }));
    expect(await owner.textContent()).toBe("This saved memory belongs to another GitHub account, so Ember keeps it hidden. Use Forget everything to clear it.");
    expect(await page.locator("#memory-forget-all").isHidden()).toBe(false);
    await page.evaluate(() => (window as unknown as { __push: (view: MemoryView) => void }).__push({ rows: [
      { id: "s1", text: "Works on Atlas with Priya", source: "conversation", at: "2026-11-04", kind: "summary" },
      { id: "g1", text: "Is busy on Tuesdays", source: "task", at: "2026-11-04", kind: "guess" },
    ], ownership: "ready", reason: null }));
    expect(await page.locator("#ay-name").isVisible()).toBe(true);
    // Ember's own notes say they are Ember's, not the conversation's (memory-3).
    expect(await page.locator("#memory-list .mem-from").allInnerTexts()).toEqual(["Ember's summary", "Ember's guess"]);
    await page.locator('a[href="#home-h"]').click();
    await expect.poll(() => page.locator("#whats-on").textContent()).toContain("Memory on");
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("forgets one memory for two Enters, says what went with Undo, asks before forgetting every word, and undoes what Ember forgot when asked (memory-7, memory-v2)", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
  const rows: MemoryView["rows"] = [
    { id: "a", text: "Likes to be called Ram", source: "user", at: "2026-11-04" },
    { id: "b", text: "Works at Globex", source: "user", at: "2026-11-04" },
    { id: "c", text: "Uses Firefox", source: "user", at: "2026-11-04" },
  ];
  const words: VoiceWord[] = [{ heard: "umber", meant: "Ember", at: "2026-11-04" }, { heard: "arc", meant: "Ark", at: "2026-11-04" }];
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
  type Probe = { forgets: string[]; restores: string[]; wordsForgotten: number };
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(seed => {
      const listeners: Record<string, (value: unknown) => void> = {};
      const probe: Probe = (window as unknown as { __probe: Probe }).__probe = { forgets: [], restores: [], wordsForgotten: 0 };
      let shown = seed.rows;
      const push = () => listeners.onMemory?.({ rows: shown, ownership: "ready", reason: null });
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { listeners[name] = fn; return () => { delete listeners[name]; }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "memory") return async () => ({ rows: shown, ownership: "ready", reason: null });
        if (name === "conversation") return async () => [{ t: "2026-11-04T12:00:00Z", who: "learned", text: "Prefers tea", forgot: "token-forgot-1" }];
        if (name === "voiceWords") return async () => seed.words;
        if (name === "reminders") return async () => [];
        if (name === "forgetVoiceWords") return async () => { probe.wordsForgotten++; };
        if (name === "forgetMemory") return async (id: string) => {
          probe.forgets.push(id);
          const row = shown.find(r => r.id === id)!;
          shown = shown.filter(r => r.id !== id);
          // As main does: the list is pushed before the reply.
          push();
          await new Promise(resolve => setTimeout(resolve, 40));
          return { text: row.text, derived: 1, undo: `token-${id}-0001` };
        };
        if (name === "restoreMemory") return async (token: string) => {
          probe.restores.push(token);
          if (token.startsWith("token-a")) { shown = seed.rows; push(); }
          return true;
        };
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status, rows, words });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    const probe = () => page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
    // What Ember forgot when asked says so in the conversation, and its Undo puts it back.
    await expect.poll(() => page.locator("#conversation li.learned").innerText()).toContain("Ember forgot: Prefers tea");
    await page.locator("#conversation li.learned button").click();
    await expect.poll(() => page.locator("#conversation li.learned button").innerText()).toBe("Put back");
    expect((await probe()).restores).toEqual(["token-forgot-1"]);
    await page.locator('a[href="#memory-h"]').click();
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(3);
    await page.locator("#memory-list [data-memory-forget]").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(140);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect((await probe()).forgets).toEqual(["a"]);
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(2);
    const said = page.locator("#memory-forgotten-text");
    expect(await said.innerText()).toBe("Forgotten: “Likes to be called Ram”, and a note Ember made from it.");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-forgotten-text");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-undo");
    await page.keyboard.press("Enter");
    await expect.poll(() => said.innerText()).toBe("Put back: “Likes to be called Ram”.");
    expect((await probe()).restores).toEqual(["token-forgot-1", "token-a-0001"]);
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(3);
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "memory-forgotten-status.png"), fullPage: true });
    }
    // Forget all words asks first; Esc and Keep them leave the words, Forget all words forgets them.
    await page.locator('a[href="#voice-h"]').click();
    await expect.poll(() => page.locator("#words-list button").count()).toBe(2);
    await page.locator("#words-forget-all").click();
    expect(await page.locator("#words-forget-confirm").isVisible()).toBe(true);
    expect(await page.locator("#words-forget-title").innerText()).toBe("Forget the 2 words Ember learnt from your corrections? It will hear them as it did before.");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("words-forget-no");
    await page.keyboard.press("Escape");
    expect(await page.locator("#words-forget-confirm").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("words-forget-all");
    await page.locator("#words-forget-all").click();
    await page.locator("#words-forget-yes").click();
    await expect.poll(async () => (await probe()).wordsForgotten).toBe(1);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
