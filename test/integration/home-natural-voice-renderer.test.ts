/** Real voice-choice controls in Chromium, then full built Home with only the isolated preload boundary replaced. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import type { NaturalVoiceStatus, VoiceStatus, Status, EmberHomeApi } from "../../app/shared/ipc";
import type { SettingsPatch } from "../../app/main/settings";

declare global {
  interface Window {
    __fullNaturalTest: { patches: SettingsPatch[]; retries: number; downloads: number; hears: number; status(value: VoiceStatus): void };
    __naturalTest: {
      patches: SettingsPatch[]; fail: boolean; retries: number; managed: boolean;
      status(value: NaturalVoiceStatus): void;
      policy(value: boolean): void;
      models(value: ("kokoro" | "kitten")[]): void;
    };
  }
}

const browserOptions = () => ({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const serve = async (root: string, fixture?: string) => {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (fixture && url === "/app/renderer/home/main.js") { res.setHeader("content-type", "text/javascript"); res.end(fixture); return; }
    const file = path.resolve(root, `.${url}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Voice fixture didn't start.");
  return { url: `http://127.0.0.1:${address.port}/app/renderer/home/index.html`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
};

it.skipIf(process.env.EMBER_VOICE_UI_TEST !== "1")("uses the baseline voice and requires explicit confirmation for optional Kokoro", async () => {
  const root = process.cwd();
  const fixture = buildSync({
    stdin: { resolveDir: root, loader: "ts", contents: `
      import { mountNaturalVoice } from "./app/renderer/home/natural-voice";
      // A former baseline installation can still have the legacy Kokoro model field while natural is false.
      let settings = { voice: { consent: false, speakerRejection: true, muted: false, match: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true } };
      const test = window.__naturalTest = { patches: [], fail: false, retries: 0, managed: false,
        status: value => view.status(value), policy: value => { test.managed = value; view.settings(settings); },
        models: value => view.status({state: "needs-native", model: "kitten", voice: "system"}, value) };
      window.ember = { retryNaturalVoice: async () => { test.retries++; } };
      const view = mountNaturalVoice({
        save: async patch => { test.patches.push(patch); if (test.fail) return false; settings = { ...settings, ...patch }; view.settings(settings); return true; },
        live: text => { document.getElementById("voice-live").textContent = text; }, managed: () => test.managed,
      });
      for (const section of document.querySelectorAll("main > section[data-pane]")) section.classList.toggle("off-pane", section.dataset.pane !== "voice");
      document.body.classList.remove("loading", "first-run");
      view.settings(settings);
      view.status({state: "on", model: "kitten", voice: "kitten"}, ["kitten", "kokoro"]);
    ` },
    bundle: true, platform: "browser", format: "iife", write: false, target: "chrome130",
  }).outputFiles[0].text;
  const server = await serve(root, fixture);
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url);
    const model = page.locator("#natural-model"), use = page.locator("#natural-use");
    expect(await page.locator("#natural").count()).toBe(0);
    expect(await model.inputValue()).toBe("kitten");
    expect(await page.locator("#natural-text").innerText()).toBe("Ember speaks in Kitten Nano.");
    expect(await page.evaluate(() => window.__naturalTest.patches)).toEqual([]);
    await model.selectOption("kokoro");
    expect(await page.evaluate(() => window.__naturalTest.patches)).toEqual([]);
    expect(await use.innerText()).toBe("Use Kokoro (350 MB download)");
    expect(await page.locator("#natural-model-hint").innerText()).toContain("when you choose Use Kokoro");
    await page.evaluate(() => window.__naturalTest.policy(false));
    expect(await model.inputValue()).toBe("kokoro");
    await page.evaluate(() => { window.__naturalTest.fail = true; });
    await use.click();
    expect(await page.locator("#natural-choice-status").innerText()).toContain("Couldn't save");
    expect(await use.evaluate(el => el === document.activeElement)).toBe(true);
    expect(await page.locator("#natural-text").innerText()).toBe("Ember speaks in Kitten Nano.");
    await page.evaluate(() => { window.__naturalTest.fail = false; });
    await use.click();
    expect(await page.evaluate(() => window.__naturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: true, naturalModel: "kokoro" });
    expect(await model.evaluate(el => el === document.activeElement)).toBe(true);
    expect(await page.locator("#natural-text").innerText()).toContain("Kokoro is selected. Checking");
    await page.evaluate(() => window.__naturalTest.status({ state: "failed", model: "kokoro", voice: "kitten", detail: "Test connection failure." }));
    expect(await page.locator("#natural-text").innerText()).toContain("Ember uses Kitten Nano");
    await page.locator("#natural-retry").click();
    expect(await page.evaluate(() => window.__naturalTest.retries)).toBe(1);
    await page.evaluate(() => window.__naturalTest.status({ state: "too-slow", model: "kokoro", voice: "kitten" }));
    expect(await page.locator("#natural-text").innerText()).toContain("Kokoro is too slow");
    expect(await page.locator("#natural-retry").isHidden()).toBe(true);
    await model.selectOption("kitten");
    expect(await use.innerText()).toBe("Use Kitten Nano");
    await use.click();
    expect(await page.evaluate(() => window.__naturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: false, naturalModel: "kitten" });
    // Kitten stopped working, or was too slow just now: Try again times it afresh (voice-speaking-6).
    await page.evaluate(() => window.__naturalTest.status({ state: "wont-load", model: "kitten", voice: "system", stopped: true }));
    expect(await page.locator("#natural-text").innerText()).toBe("Kitten Nano stopped working, so Ember uses this computer's system voice when available. Try again, or restart Ember.");
    await page.locator("#natural-retry").click();
    expect(await page.evaluate(() => window.__naturalTest.retries)).toBe(2);
    await page.evaluate(() => window.__naturalTest.status({ state: "too-slow", model: "kitten", voice: "system" }));
    expect(await page.locator("#natural-retry").isVisible()).toBe(true);
    if (process.env.EMBER_UI_EVIDENCE) await page.locator("#natural-row").screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "kitten-too-slow-retry.png") });
    await page.evaluate(() => window.__naturalTest.status({ state: "on", model: "kitten", voice: "kitten" }));
    expect(await page.locator("#natural-retry").isHidden()).toBe(true);
    await page.evaluate(() => window.__naturalTest.models([]));
    expect(await model.isEnabled()).toBe(true);
    expect(await model.evaluate(select => [...(select as HTMLSelectElement).options].map(option => [option.value, option.disabled]))).toEqual([["kitten", false], ["kokoro", true], ["supertonic", true]]);
    expect(await page.locator("#natural-text").innerText()).toContain("system voice");
    await page.evaluate(() => window.__naturalTest.policy(true));
    expect(await model.isDisabled()).toBe(true);
    await page.evaluate(() => window.__naturalTest.policy(false));
    await page.evaluate(() => window.__naturalTest.models(["kitten", "kokoro"]));
    await model.selectOption("kokoro");
    for (const width of [420, 560, 728, 1000]) for (const size of ["default", "large", "larger"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(size => { document.documentElement.dataset.textSize = size; }, size);
      await use.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px ${size}`).toBe(true);
      expect(await use.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(24);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 560, height: 900 });
    expect(await use.isVisible()).toBe(true);
    expect(await page.locator("#natural-row").innerText()).not.toMatch(/Piper|Use a more natural voice/);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);

it.skipIf(process.env.EMBER_VOICE_UI_TEST !== "1")("keeps the default voice selectable in full Home through missing models and native fallback", async () => {
  const { DEFAULT_SETTINGS } = await import("../../app/main/settings");
  const { CONSENT_VERSION } = await import("../../app/shared/consent");
  const { SHORTCUTS, FALLBACK_SHORTCUTS, heldShortcuts, shownShortcuts } = await import("../../app/shared/shortcuts");
  const status: Status = {
    appVersion: "test", settings: { ...DEFAULT_SETTINGS, onboarded: true, consent: { version: CONSENT_VERSION, at: "2026-11-04T00:00:00.000Z" },
      voice: { ...DEFAULT_SETTINGS.voice, natural: true, naturalModel: "kokoro" } },
    environment: { os: "Windows 11", sessionType: "desktop", desktop: "Windows", display: "", glibc: "", versions: { node: "24" }, checks: [] },
    logFile: "/tmp/ember-test.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] },
    platform: { os: "win32", shortcuts: shownShortcuts(SHORTCUTS.win32, heldShortcuts(SHORTCUTS.win32, FALLBACK_SHORTCUTS.win32, [])),
      dataDir: "~/.config/ember", settingsFile: "~/.config/ember/settings.json", auditCopy: null, micIndicator: "", permissionsNote: "", speakerRejection: false, outputLevel: false,
      fixLabels: {}, desk: false, autostartNote: null },
  };
  const seedVoice: VoiceStatus = { state: "off", detail: null, modelsReady: true, modelsMissing: [], modelsBytes: 0,
    natural: { state: "needs-native", model: "kokoro", voice: "system" }, naturalModels: [], listenOnce: { phase: "blocked", detail: "Allow the microphone first." },
    match: { enrolled: false, on: false, model: true, wanted: false, enrolling: null, learnt: 0 } };
  const server = await serve(path.resolve("dist"));
  const browser = await chromium.launch(browserOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(seed => {
      const listeners: Record<string, Set<(value: unknown) => void>> = {};
      let current = seed.status;
      const emit = (name: string, value: unknown) => { for (const listener of listeners[name] ?? []) listener(value); };
      const test = window.__fullNaturalTest = { patches: [] as SettingsPatch[], retries: 0, downloads: 0, hears: 0, status: (voice: VoiceStatus) => emit("onVoiceStatus", voice) };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[name] ??= new Set()).add(fn); return () => { listeners[name]?.delete(fn); }; };
        if (name === "getStatus") return async () => current;
        if (name === "voiceStatus") return async () => seed.voice;
        if (name === "updateSettings") return async (patch: SettingsPatch) => {
          test.patches.push(patch); current = { ...current, settings: { ...current.settings, ...patch } }; emit("onSettingsChanged", current.settings); return current.settings;
        };
        if (name === "downloadVoice") return async () => { test.downloads++; };
        if (name === "retryNaturalVoice") return async () => { test.retries++; };
        if (name === "hearEmber") return async () => { test.hears++; return { spoke: true, voice: "kitten" }; };
        return () => new Promise(() => undefined);
      } }) as EmberHomeApi;
    }, { status, voice: seedVoice });
    await page.goto(server.url);
    await page.locator('a[href="#voice-h"]').click();
    const row = page.locator("#natural-row"), select = page.locator("#natural-model"), use = page.locator("#natural-use");
    await expect.poll(() => row.isVisible()).toBe(true);
    expect(await page.locator("#natural").count()).toBe(0);
    expect(await select.inputValue()).toBe("kokoro");
    expect(await select.isEnabled()).toBe(true);
    expect(await page.locator("#natural-text").innerText()).toContain("Kokoro isn't available");
    expect(await page.locator("#natural-text").innerText()).toContain("system voice");
    expect(await page.evaluate(() => window.__fullNaturalTest.patches)).toEqual([]);
    await select.selectOption("kitten"); await use.click();
    await expect.poll(() => page.evaluate(() => window.__fullNaturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: false, naturalModel: "kitten" });
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, natural: { state: "needs-native", model: "kitten", voice: "system" } }), seedVoice);
    expect(await row.isVisible()).toBe(true);
    expect(await select.inputValue()).toBe("kitten");
    expect(await select.isEnabled()).toBe(true);
    expect(await page.locator("#natural-text").innerText()).toContain("system voice");
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, naturalModels: ["kitten", "kokoro"], natural: { state: "on", model: "kitten", voice: "kitten" } }), seedVoice);
    expect(await page.locator("#natural-text").innerText()).toBe("Ember speaks in Kitten Nano.");
    // Hear Ember says which voice spoke; the speaking speed is saved as chosen; Never turns Hear Ember off (voice-speaking-7).
    const hear = page.locator("#voice-hear");
    expect(await hear.isEnabled()).toBe(true);
    await hear.click();
    await expect.poll(() => page.locator("#voice-hear-status").innerText()).toBe("Ember spoke in Kitten Nano.");
    expect(await page.evaluate(() => window.__fullNaturalTest.hears)).toBe(1);
    expect(await page.locator("#speak-rate").inputValue()).toBe("1");
    await page.locator("#speak-rate").selectOption("1.15");
    await expect.poll(() => page.evaluate(() => window.__fullNaturalTest.patches.at(-1)?.voice?.rate)).toBe(1.15);
    if (process.env.EMBER_UI_EVIDENCE) {
      await page.locator(".group.voice").screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "voice-hear-rate.png") });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.locator(".group.voice").screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "voice-hear-rate-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.locator("#speak").selectOption("never");
    await expect.poll(() => hear.isDisabled()).toBe(true);
    await page.locator("#speak").selectOption("always");
    await expect.poll(() => hear.isEnabled()).toBe(true);
    await select.selectOption("kokoro");
    const before = await page.evaluate(() => window.__fullNaturalTest.patches.length);
    expect(await use.innerText()).toBe("Use Kokoro (350 MB download)");
    expect(await page.evaluate(() => window.__fullNaturalTest.patches.length)).toBe(before);
    await use.click();
    await expect.poll(() => page.evaluate(() => window.__fullNaturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: true, naturalModel: "kokoro" });
    // A working cached Kokoro does not force a new baseline download before it can speak.
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, modelsMissing: ["tts"], modelsBytes: 63_800_000,
      naturalModels: ["kitten", "kokoro"], natural: { state: "on", model: "kokoro", voice: "kokoro" } }), seedVoice);
    expect(await page.locator("#natural-text").innerText()).toBe("Ember speaks in Kokoro.");
    expect(await page.locator("#natural-download-row").isHidden()).toBe(true);
    expect(await page.evaluate(() => window.__fullNaturalTest.downloads)).toBe(0);
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, naturalModels: ["kitten", "kokoro"], natural: { state: "too-slow", model: "kokoro", voice: "kitten" } }), seedVoice);
    expect(await page.locator("#natural-text").innerText()).toContain("Ember uses Kitten Nano");
    await page.setViewportSize({ width: 560, height: 900 }); await page.evaluate(() => { document.documentElement.dataset.textSize = "larger"; }); await page.emulateMedia({ forcedColors: "active" });
    const voiceRows = await page.locator(".group.voice").evaluate(group => [...group.children].filter((row): row is HTMLElement => {
      if (!(row instanceof HTMLElement)) return false;
      const style = getComputedStyle(row); return style.display !== "none" && style.position !== "absolute" && row.getBoundingClientRect().height > 0;
    }).map(row => ({ id: row.id || row.className, text: row.innerText.trim(), control: [...row.querySelectorAll("button, input, select, textarea, progress")].some(control => control.getClientRects().length > 0) })));
    expect(voiceRows.filter(row => !row.text && !row.control)).toEqual([]);
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "default-voice-560-larger-forced.png"), fullPage: true });
      await page.emulateMedia({ forcedColors: "none" }); await page.setViewportSize({ width: 1000, height: 900 });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "default-voice-1000-larger.png"), fullPage: true });
    }
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, naturalModels: [], natural: { state: "needs-native", model: "kokoro", voice: "system" } }), seedVoice);
    expect(await row.isVisible()).toBe(true);
    await select.selectOption("kitten"); await use.click();
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, natural: { state: "needs-voice", model: "kitten", voice: "system" }, modelsMissing: ["tts"], modelsBytes: 63_800_000 }), seedVoice);
    expect(await page.locator("#natural-text").innerText()).toContain("Show speech model download");
    expect(await page.locator("#natural-retry").isHidden()).toBe(true);
    await page.locator("#natural-download").click();
    expect(await page.locator("#voice-download").evaluate(el => el === document.activeElement)).toBe(true);
    expect(await page.locator("#voice-download").innerText()).toBe("Download Kitten Nano (63.8 MB)");
    await page.locator("#voice-download").click();
    expect(await page.evaluate(() => window.__fullNaturalTest.downloads)).toBe(1);
    expect(await page.evaluate(() => window.__fullNaturalTest.retries)).toBe(0);
    expect(await row.innerText()).not.toMatch(/Piper|Use a more natural voice/);
    expect(await select.isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.close(); }
}, 60_000);
