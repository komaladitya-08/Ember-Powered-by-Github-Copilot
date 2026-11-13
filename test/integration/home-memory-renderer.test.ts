/** Built Home in Chromium: memory outcomes, live-list focus and selectable retrieval at the preload boundary. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
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
    await page.locator("#words-list button").first().focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#words-list button").count()).toBe(2);
    // Focus goes to what went, never to the next word's Forget, so a second Enter forgets nothing more (memory-7).
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("words-note");
    expect(await page.locator("#words-note").innerText()).toBe("Forgotten: “umber” → “Ember”.");
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    expect(await page.locator("#words-list button").count()).toBe(2);
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
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-h");
    await page.evaluate(rows => window.__memoryTest.memory({ ownership: "ready", rows }), facts);
    await page.locator("#memory-query").focus();
    await page.evaluate(() => window.__memoryTest.memory({ ownership: "locked", rows: [] }));
    expect(await page.locator("#memory-count").isHidden()).toBe(true);
    expect(await page.locator("#memory-list").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-h");
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
      const patches: unknown[] = (window as unknown as { __patches: unknown[] }).__patches = [];
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { listeners[name] = fn; return () => { delete listeners[name]; }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "updateSettings") return async (patch: unknown) => { patches.push(patch); return {}; };
        if (name === "introduceMe") return async (answers: Record<string, unknown>) => Object.keys(answers).length;
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
    // And so does a summary's correction form (memory-r5).
    await page.locator('[data-memory-correct="s1"]').click();
    expect(await page.locator("#memory-correction-source").innerText()).toBe("Ember's summary");
    await page.keyboard.press("Escape");
    // Spoken replies is Ember's real speaking choice, and Save says so (memory-5).
    await page.locator("#ay-name").fill("Ram");
    await page.locator("#ay-spoken").selectOption("no");
    await page.locator("#about-you button.btn:not(.quiet)").click();
    await expect.poll(() => page.locator("#ay-msg").innerText()).toBe("Saved 2 answers. Ember won't speak its replies now. You can change that in Voice.");
    expect(await page.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches)).toEqual([{ speak: false, speakWithScreenReader: false }]);
    await page.locator('a[href="#home-h"]').click();
    await expect.poll(() => page.locator("#whats-on").textContent()).toContain("Memory on");
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("forgets one memory for two Enters, says what went with Undo, asks before forgetting every word, and undoes what Ember forgot or learned in the conversation's own line, where focus stays (memory-7, memory-v2, memory-c1-3)", async () => {
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
      // The conversation's memory lines, changed in place as main changes them (memory-c1-3).
      let convo: { t: string; who: "learned"; text: string; fact?: string; forgot?: string; derived?: number; again?: true }[] = [
        { t: "2026-11-04T12:00:00Z", who: "learned", text: "Prefers tea", forgot: "token-forgot-1" },
        { t: "2026-11-04T12:01:00Z", who: "learned", text: "Uses Firefox", fact: "c" },
      ];
      const pushConvo = () => listeners.onConversation?.(convo);
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { listeners[name] = fn; return () => { delete listeners[name]; }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "memory") return async () => ({ rows: shown, ownership: "ready", reason: null });
        if (name === "conversation") return async () => convo;
        if (name === "voiceWords") return async () => seed.words;
        if (name === "reminders") return async () => [];
        if (name === "forgetVoiceWords") return async () => { probe.wordsForgotten++; };
        if (name === "forgetMemory") return async (id: string) => {
          probe.forgets.push(id);
          const row = shown.find(r => r.id === id)!;
          shown = shown.filter(r => r.id !== id);
          const undo = `token-${id}-0001`;
          // As main does: the list and the conversation (its line, changed where it was) are pushed before the reply.
          push();
          convo = convo.map(l => (l.fact === id ? { t: l.t, who: "learned", text: l.text, forgot: undo, derived: 1 } : l));
          pushConvo();
          await new Promise(resolve => setTimeout(resolve, 40));
          return { text: row.text, derived: 1, undo };
        };
        if (name === "restoreMemory") return async (token: string) => {
          probe.restores.push(token);
          shown = seed.rows; push();
          convo = convo.map(l => (l.forgot === token ? { t: l.t, who: "learned", text: l.text, again: true } : l));
          pushConvo();
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
    // What Ember forgot when asked says so in the conversation, and its Undo puts it back: the line says so where it was,
    // and focus moves to its words, never to the page (memory-c1-3).
    const lines = page.locator("#conversation li.learned");
    await expect.poll(() => lines.first().innerText()).toContain("Ember forgot: Prefers tea");
    const focusedText = () => page.evaluate(() => (document.activeElement?.closest("li.learned") ? document.activeElement.textContent : document.activeElement?.tagName));
    await lines.first().locator("button").focus();
    await page.keyboard.press("Enter");
    await expect.poll(focusedText).toBe("Ember remembers “Prefers tea” again.");
    expect(await lines.first().locator("button").count()).toBe(0);
    expect((await probe()).restores).toEqual(["token-forgot-1"]);
    // The Undo of what Ember learned: the line says what went, focus is on its words, and its own Undo puts it back.
    expect(await lines.nth(1).innerText()).toContain("Ember learned: Uses Firefox");
    await lines.nth(1).locator("button").focus();
    await page.keyboard.press("Enter");
    await expect.poll(focusedText).toBe("Ember forgot: Uses Firefox (and a note Ember made from it)");
    // A second Enter lands on the words, not on another Undo or Forget.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(140);
    expect((await probe()).forgets).toEqual(["c"]);
    expect(await lines.count()).toBe(2);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Undo: remember “Uses Firefox” again");
    await page.keyboard.press("Enter");
    await expect.poll(focusedText).toBe("Ember remembers “Uses Firefox” again.");
    expect((await probe()).restores).toEqual(["token-forgot-1", "token-c-0001"]);
    await page.locator('a[href="#memory-h"]').click();
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(3);
    await page.locator("#memory-list [data-memory-forget]").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(140);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    expect((await probe()).forgets).toEqual(["c", "a"]);
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(2);
    const said = page.locator("#memory-forgotten-text");
    expect(await said.innerText()).toBe("Forgotten: “Likes to be called Ram”, and a note Ember made from it.");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-forgotten-text");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-undo");
    await page.keyboard.press("Enter");
    await expect.poll(() => said.innerText()).toBe("Put back: “Likes to be called Ram”.");
    expect((await probe()).restores).toEqual(["token-forgot-1", "token-c-0001", "token-a-0001"]);
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

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("paints only Forget red, keeps a long memory's two buttons on one line inside the group, and counts nothing in an empty list (memory-13)", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
  const rows: MemoryView["rows"] = [
    { id: "a", text: "Likes to be called Ram", source: "user", at: "2026-11-04" },
    { id: "b", text: "Priya leads the platform team and reviews the user's pull requests every Thursday afternoon before the release train leaves", source: "conversation", at: "2026-11-04" },
    { id: "c", text: "Prefers short answers", source: "user", at: "2026-11-04", revision: 1, correctedAt: "2026-11-04T12:00:00Z" },
  ];
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
        if (name === "memory") return async () => ({ rows: seed.rows, ownership: "ready", reason: null });
        if (name === "voiceWords" || name === "reminders" || name === "conversation") return async () => [];
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status, rows });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    await page.locator('a[href="#memory-h"]').click();
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(3);
    // Each row's Forget and Correct…, the list's box, and the colours they are painted in.
    const measure = () => page.evaluate(() => {
      const list = document.getElementById("memory-list")!.getBoundingClientRect();
      const probe = Object.assign(document.createElement("span"), { style: "color: var(--red-text)" });
      document.body.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return { red, fg: getComputedStyle(document.body).color, listRight: list.right, rows: [...document.querySelectorAll("#memory-list li")].map(li => {
        const forget = li.querySelector("[data-memory-forget]")!, correct = li.querySelector("[data-memory-correct]")!;
        const f = forget.getBoundingClientRect(), c = correct.getBoundingClientRect();
        return { forget: getComputedStyle(forget).color, correct: getComputedStyle(correct).color, fTop: f.top, cTop: c.top, fRight: f.right, cLeft: c.left, cRight: c.right };
      }) };
    });
    for (const width of [560, 1000]) for (const size of ["default", "larger"]) for (const forced of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ forcedColors: forced ? "active" : "none" });
      await page.evaluate(textSize => { document.documentElement.dataset.textSize = textSize; }, size);
      const m = await measure();
      const at = `${width}px, ${size}${forced ? ", forced colours" : ""}`;
      for (const [i, row] of m.rows.entries()) {
        // Correct… changes nothing until it is saved: it is never painted as destructive as Forget is.
        if (!forced) { expect(row.forget, `${at}, row ${i}`).toBe(m.red); expect(row.correct, `${at}, row ${i}`).toBe(m.fg); }
        // Side by side on one line, even beside a two-line memory.
        expect(Math.abs(row.fTop - row.cTop), `${at}, row ${i}`).toBeLessThan(1);
        // Drawn with an edge, they never touch or run past the group's edge.
        if (forced) { expect(row.cLeft - row.fRight, `${at}, row ${i}`).toBeGreaterThanOrEqual(4); expect(row.cRight, `${at}, row ${i}`).toBeLessThanOrEqual(m.listRight - 4); }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), at).toBe(true);
      if (process.env.EMBER_UI_EVIDENCE) {
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await page.locator("#memory-list").screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `memory-rows-${width}-${size}${forced ? "-forced" : ""}.png`) });
      }
    }
    await page.emulateMedia({ forcedColors: "none" });
    expect(await page.locator("#memory-count").innerText()).toBe("3 of 3 memories");
    // An empty list says only that it is empty, not "0 of 0 memories".
    await page.evaluate(() => (window as unknown as { __push: (view: MemoryView) => void }).__push({ rows: [], ownership: "ready", reason: null }));
    await expect.poll(() => page.locator("#memory-list").innerText()).toContain("Nothing yet");
    expect(await page.locator("#memory-count").isHidden()).toBe(true);
    expect(await page.locator("#memory-count").textContent()).toBe("");
    await page.evaluate(seed => (window as unknown as { __push: (view: MemoryView) => void }).__push({ rows: seed, ownership: "ready", reason: null }), rows);
    expect(await page.locator("#memory-count").isHidden()).toBe(false);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("keeps a correction draft, the search and focus while Ember checks the same account again on a reconnect, and never parks focus on the memory switch (memory-8, memory-c2-1)", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  settings.memory = { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } };
  const status = { appVersion: "0.1.1", settings, environment: { checks: [], versions: { node: "24", electron: "44", chrome: "152" } }, logFile: "/test/ember.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] } };
  const rows: MemoryView["rows"] = [
    { id: "a", text: "Likes to be called Ram", source: "user", at: "2026-11-04" },
    { id: "b", text: "Priya leads the platform team", source: "conversation", at: "2026-11-04" },
  ];
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
        if (name === "memory") return async () => ({ rows: seed.rows, ownership: "ready", reason: null, epoch: 1 });
        if (name === "voiceWords" || name === "reminders" || name === "conversation") return async () => [];
        if (name === "forgetMemory") return async (id: string) => ({ text: seed.rows.find(r => r.id === id)!.text, derived: 0, undo: `token-${id}-0001` });
        // Every settings save is recorded: a key typed while the list is out of sight must change nothing (memory-c2-1).
        if (name === "updateSettings") return async (patch: unknown) => { ((window as unknown as { __saves: unknown[] }).__saves ??= []).push(patch); return {}; };
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status, rows });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    await page.locator('a[href="#memory-h"]').click();
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(2);
    const push = (view: MemoryView) => page.evaluate(v => (window as unknown as { __push: (view: MemoryView) => void }).__push(v), view);
    const checking: MemoryView = { rows: [], ownership: "locked", reason: "checking", epoch: 1 };
    const back: MemoryView = { rows, ownership: "ready", reason: null, epoch: 1 };
    // A correction being typed when the connection drops and comes back.
    await page.locator('[data-memory-correct="b"]').click();
    const correction = page.locator("#memory-correction-text");
    await correction.fill("Priya leads the platform and billing teams");
    await push(checking);
    expect(await page.locator("#memory-owner").innerText()).toBe("Checking your GitHub account…");
    // Out of sight with the list while it checks, never closed.
    expect(await page.locator("#memory-correction").isHidden()).toBe(true);
    expect(await page.locator("#memory-list").isHidden()).toBe(true);
    // Focus waits on Memory's heading, never the switch, so the words typed on change no setting (memory-c2-1).
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-h");
    await page.keyboard.type(" billing team");
    expect(await page.evaluate(() => (window as unknown as { __saves?: unknown[] }).__saves ?? [])).toEqual([]);
    expect(await page.locator("#memory-on").isChecked()).toBe(true);
    await push(back);
    expect(await page.locator("#memory-correction").isVisible()).toBe(true);
    expect(await correction.inputValue()).toBe("Priya leads the platform and billing teams");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-correction-text");
    await page.locator("#memory-correction-cancel").click();
    // Searching when it drops: the words, the matches and focus come back with the list.
    await page.locator("#memory-query").fill("Priya");
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(1);
    await push(checking);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-h");
    await page.keyboard.press("Space");
    await push(back);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-query");
    expect(await page.locator("#memory-query").inputValue()).toBe("Priya");
    expect(await page.locator("#memory-list [data-memory-forget]").count()).toBe(1);
    // Moved on meanwhile: focus stays where the person put it.
    await push(checking);
    await page.locator("#memory-questions").focus();
    await push(back);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-questions");
    // What was just forgotten, with its Undo, comes back with the list too (memory-8).
    await page.locator("#memory-query").fill("");
    await page.locator('[data-memory-correct="b"]').locator("..").locator("[data-memory-forget]").focus();
    await page.keyboard.press("Enter");
    const forgotten = page.locator("#memory-forgotten");
    await expect.poll(() => forgotten.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-forgotten-text");
    await push(checking);
    expect(await forgotten.isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-h");
    await page.keyboard.press("Space");
    expect(await page.evaluate(() => (window as unknown as { __saves?: unknown[] }).__saves ?? [])).toEqual([]);
    await push({ ...back, rows: rows.filter(r => r.id !== "b") });
    expect(await forgotten.isVisible()).toBe(true);
    expect(await page.locator("#memory-forgotten-text").innerText()).toBe("Forgotten: “Priya leads the platform team”.");
    expect(await page.locator("#memory-undo").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("memory-forgotten-text");
    // Another account (the epoch moves on): the draft goes, as before, and so does what was forgotten.
    await push({ rows: [], ownership: "locked", reason: "other-account", epoch: 2 });
    await push({ ...back, epoch: 2 });
    expect(await forgotten.isHidden()).toBe(true);
    await push(back);
    await page.locator('[data-memory-correct="a"]').click();
    await correction.fill("A private unfinished draft");
    await push({ rows: [], ownership: "locked", reason: "checking", epoch: 1 });
    await push({ rows: [], ownership: "locked", reason: "other-account", epoch: 2 });
    expect(await correction.inputValue()).toBe("");
    await push({ rows, ownership: "ready", reason: null, epoch: 3 });
    expect(await page.locator("#memory-correction").isHidden()).toBe(true);
    // memory.json that couldn't be saved is said, never only shown as a list that will be lost (memory-r2).
    await push({ rows, ownership: "ready", reason: null, epoch: 3, trouble: "unsaved" });
    expect(await page.locator("#memory-trouble").innerText()).toBe("Ember couldn't save memory on this computer, so what it keeps now may be gone when Ember closes.");
    await push({ rows, ownership: "ready", reason: null, epoch: 3, trouble: null });
    expect(await page.locator("#memory-trouble").isHidden()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("never lands a forget or remember request on “I agree, remember”, and takes no agreement in the first moment a note is up (memory-r7)", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.onboarded = true; settings.consent = { version: 99, at: "2026-11-04T12:00:00Z" };
  // Memory off, as it is until the person turns it on.
  settings.memory = { ...settings.memory, on: false, consent: { version: 0, at: null } };
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
      // Every listener, since Home listens for settings in more than one place.
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      const w = window as unknown as { __emit: (name: string, value: unknown) => void; __saves: unknown[] };
      w.__saves = [];
      w.__emit = (name, value) => { for (const fn of listeners[name] ?? []) fn(value); };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[name] ??= []).push(fn); return () => { listeners[name] = listeners[name]!.filter(f => f !== fn); }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "memory") return async () => ({ rows: [], ownership: "ready", reason: null, epoch: 1 });
        if (name === "voiceWords" || name === "reminders" || name === "conversation") return async () => [];
        if (name === "updateSettings") return async (patch: unknown) => { w.__saves.push(patch); return {}; };
        // A mode chosen (How Ember asks): counted with the saves, so a press that agreed to its card would show.
        if (name === "chooseMode") return async (...args: unknown[]) => { w.__saves.push({ chooseMode: args }); return { ok: false, why: "unavailable", state: { chosen: "interactive", inForce: "asking", why: "card", offered: ["interactive"], agreed: [], cap: null } }; };
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    const emit = (name: string, value: unknown) => page.evaluate(([n, v]) => (window as unknown as { __emit: (name: string, value: unknown) => void }).__emit(n as string, v), [name, value]);
    const saves = () => page.evaluate(() => (window as unknown as { __saves: unknown[] }).__saves);
    const focused = () => page.evaluate(() => document.activeElement?.id);
    const consent = page.locator("#memory-consent");
    // "Forget my address" while memory is off: Memory opens at its list, never at the note or its agree button.
    await emit("onFocusSection", "memory:memory-query");
    await expect.poll(focused).toBe("memory-query");
    expect(await consent.isHidden()).toBe(true);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(await saves()).toEqual([]);
    // "Get to know me" or Open Memory: the note shows, focused on its words; a key there agrees to nothing.
    await emit("onFocusSection", "memory:memory-consent-text");
    await expect.poll(focused).toBe("memory-consent-text");
    expect(await consent.isVisible()).toBe(true);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    // Tab reaches “I agree, remember”, but a press in the first half second after the note came up is dropped.
    await page.keyboard.press("Tab");
    expect(await focused()).toBe("memory-yes");
    await page.keyboard.press("Space");
    expect(await saves()).toEqual([]);
    expect(await consent.isVisible()).toBe(true);
    await page.waitForTimeout(600);
    await page.keyboard.press("Space");
    await expect.poll(saves).toHaveLength(1);
    expect((await saves())[0]).toMatchObject({ memory: { on: true, consent: { version: expect.any(Number) } } });
    // The switch's own note (memory off again, its consent withdrawn): a repeating Space can't agree for them either.
    await emit("onSettingsChanged", { ...settings, memory: { ...settings.memory, on: false, consent: { version: 0, at: null } } });
    await page.locator("#memory-on").focus();
    await page.keyboard.press("Space");
    expect(await focused()).toBe("memory-yes");
    await page.keyboard.press("Space");
    expect(await saves()).toHaveLength(1);
    // A request that asks for the agree button by its old name lands on the note's words too.
    await page.locator("#memory-no").click();
    await emit("onFocusSection", "memory:memory-yes");
    await expect.poll(focused).toBe("memory-consent-text");
    // Memory already agreed to but saved under another account: no note for consent already given, only the section.
    await emit("onSettingsChanged", { ...settings, memory: { ...settings.memory, on: true, consent: { version: 99, at: "2026-11-04T12:00:00Z" } } });
    await page.locator("#memory-no").click();
    await emit("onMemory", { rows: [], ownership: "locked", reason: "other-account", epoch: 2 });
    await emit("onFocusSection", "memory:memory-consent-text");
    await expect.poll(focused).toBe("memory-h");
    expect(await consent.isHidden()).toBe(true);
    // Interactive's card (How Ember asks), asked for by voice, is armed the same way: an Enter typed as it opens chooses nothing.
    await emit("onFocusSection", "privacy:autonomy-yes");
    await expect.poll(focused).toBe("approvals-yes");
    expect(await page.locator("#approvals-card").isVisible()).toBe(true);
    await page.keyboard.press("Enter");
    expect(await saves()).toHaveLength(1);
    // Once it has been up half a second, the press agrees: one call to main, with the mode and its card's version.
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await saves()).length).toBe(2);
    expect((await saves())[1]).toEqual({ chooseMode: ["interactive", FEATURE_CONSENT_VERSION.autonomy] });
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

/** Built Home at Settings › Memory with `view` as main's first answer: `run` gets the page and a way to push another view. */
async function atMemory(view: MemoryView, run: (page: Page, push: (next: MemoryView) => Promise<void>) => Promise<void>): Promise<void> {
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
      const test = (window as unknown as { __c72: { push(view: MemoryView): void; forgot: string[] } }).__c72 = { push: view => listeners.onMemory?.(view), forgot: [] as string[] };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { listeners[name] = fn; return () => { delete listeners[name]; }; };
        if (name === "getStatus") return async () => seed.status;
        if (name === "memory") return async () => seed.view;
        if (name === "voiceWords" || name === "reminders" || name === "conversation") return async () => [];
        if (name === "forgetMemory") return async (id: string) => {
          test.forgot.push(id);
          if (id === "fails") throw new Error("Error invoking remote method 'memory:forget': Error: Ember couldn't finish deleting this memory. It is still listed; try Forget again.");
          return { derived: 0, undo: "tok-12345678" };
        };
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status, view });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Renderer fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.evaluate(() => document.body.classList.remove("loading", "first-run"));
    await page.locator('a[href="#memory-h"]').click();
    await run(page, next => page.evaluate(sent => (window as unknown as { __c72: { push(view: MemoryView): void } }).__c72.push(sent), next));
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("lists what is no longer true after what holds now, with its date and Forget but no Correct…, counts it, and never says “Nothing yet” while some is kept (memory-c7-2)", async () => {
  const now: MemoryView["rows"][number] = { id: "york", text: "Lives at 4 Abbey Road, York", source: "user", at: "2026-11-12T10:00:00Z" };
  const old: MemoryView["rows"][number] = { id: "leeds", text: "Lives at 12 Mill Lane, Leeds", source: "user", at: "2026-11-11T10:00:00Z", until: "2026-11-12T10:00:00Z" };
  await atMemory({ rows: [now, old], ownership: "ready", reason: null }, async (page, send) => {
    const push = (rows: MemoryView["rows"]) => send({ rows, ownership: "ready", reason: null });
    const read = () => page.evaluate(() => [...document.querySelectorAll("#memory-list li")].map(li => ({
      text: li.querySelector(".mem-fact > span")?.textContent ?? li.textContent, from: li.querySelector(".mem-from")?.textContent,
      forget: !!li.querySelector<HTMLElement>("[data-memory-forget]")?.offsetParent, correct: !!li.querySelector<HTMLElement>("[data-memory-correct]")?.offsetParent,
    })));
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(2);
    const day = await page.evaluate(() => new Date("2026-11-12T10:00:00Z").toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }));
    expect(await read()).toEqual([
      { text: "Lives at 4 Abbey Road, York", from: "You told me", forget: true, correct: true },
      { text: "Lives at 12 Mill Lane, Leeds", from: `You told me · No longer true since ${day}`, forget: true, correct: false },
    ]);
    expect(await page.locator("#memory-count").innerText()).toBe("2 of 2 memories");
    for (const width of [560, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px`).toBe(true);
      if (process.env.EMBER_UI_EVIDENCE) {
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await page.locator("#memory-list").screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `memory-no-longer-true-${width}.png`) });
      }
    }
    // The current value is forgotten: what it replaced is still kept, and still listed, with its Forget.
    await push([old]);
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(1);
    expect(await page.locator("#memory-list").innerText()).not.toContain("Nothing yet");
    expect(await page.locator("#memory-count").innerText()).toBe("1 of 1 memory");
    expect(await page.locator("#memory-forget-all").isVisible()).toBe(true);
    // A fact replaced while its Correct… has focus: focus stays in its row, on Forget.
    await push([now]);
    await page.locator('#memory-list [data-memory-correct="york"]').focus();
    await push([{ id: "new", text: "Lives at 9 High Street, Bath", source: "user", at: "2026-11-13T10:00:00Z" }, { ...now, until: "2026-11-13T10:00:00Z" }]);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Forget: Lives at 4 Abbey Road, York");
    expect((await read())[1].correct).toBe(false);
    // Forget of what is no longer true goes to main by its id.
    await page.locator("#memory-list li").nth(1).locator("[data-memory-forget]").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __c72: { forgot: string[] } }).__c72.forgot)).toEqual(["york"]);
  });
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("never invites “Remember that…” or offers Tell Ember about you's Save while memory.json can't be read, and says why in both places (memory-r7-1)", async () => {
  await atMemory({ rows: [], ownership: "ready", reason: null, trouble: "unreadable" }, async (page, send) => {
    await expect.poll(() => page.locator("#memory-list").innerText()).toBe("Ember couldn't read your saved memory, so nothing is listed.");
    expect(await page.locator("#memory-trouble").innerText()).toContain("nothing new is kept until Ember starts again");
    expect(await page.locator("#about-you .about-paused").innerText()).toContain("nothing new is kept until Ember starts again");
    expect(await page.locator("#about-you input:visible, #about-you select:visible").count()).toBe(0);
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "memory-unreadable.png"), fullPage: false });
    }
    // Readable again (a restart): the list and the questions are back.
    await send({ rows: [], ownership: "ready", reason: null, trouble: null });
    await expect.poll(() => page.locator("#memory-list").innerText()).toContain("Nothing yet");
    await expect.poll(() => page.locator("#about-you input:visible").count()).toBeGreaterThan(0);
  });
}, 60_000);

it.skipIf(process.env.EMBER_MEMORY_TEST !== "1")("takes a failed Forget's alert away once another memory action starts: a correction, or Forget everything's question (memory-r7-4)", async () => {
  const rows: MemoryView["rows"] = [{ id: "fails", text: "Likes to be called Ram", source: "user", at: "2026-11-04" }, { id: "ok", text: "Prefers short answers", source: "user", at: "2026-11-04" }];
  await atMemory({ rows, ownership: "ready", reason: null }, async page => {
    const error = page.locator("#memory-error");
    const failForget = async () => {
      await page.locator("#memory-list li").first().locator("[data-memory-forget]").click();
      await expect.poll(() => error.innerText()).toBe("Ember couldn't finish deleting this memory. It is still listed; try Forget again.");
    };
    await expect.poll(() => page.locator("#memory-list [data-memory-forget]").count()).toBe(2);
    await failForget();
    await page.locator('#memory-list [data-memory-correct="ok"]').click();
    expect(await page.locator("#memory-correction").isVisible()).toBe(true);
    expect(await error.textContent()).toBe("");
    await page.locator("#memory-correction-cancel").click();
    await failForget();
    await page.locator("#memory-forget-all").click();
    expect(await page.locator("#forget-all-confirm").isVisible()).toBe(true);
    expect(await error.textContent()).toBe("");
  });
}, 60_000);

