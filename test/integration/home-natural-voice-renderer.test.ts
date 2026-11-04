/** Real Home markup/styles and natural-voice controller in Chromium; only settings/native voice are replaced. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import type { NaturalVoiceStatus } from "../../app/shared/ipc";
import type { SettingsPatch } from "../../app/main/settings";

declare global {
  interface Window {
    __fullNaturalTest: {
      patches: SettingsPatch[]; retries: number;
      status(value: import("../../app/shared/ipc").VoiceStatus): void;
    };
    __naturalTest: {
      patches: SettingsPatch[]; fail: boolean; retries: number; managed: boolean;
      status(value: NaturalVoiceStatus): void;
      policy(value: boolean): void;
      models(value: ("kokoro" | "kitten")[]): void;
    };
  }
}

it.skipIf(process.env.EMBER_VOICE_UI_TEST !== "1")("requires an explicit local voice choice, preserves off and recovers truthful state after failure", async () => {
  const root = process.cwd();
  const fixture = buildSync({
    stdin: { resolveDir: root, loader: "ts", contents: `
      import { mountNaturalVoice } from "./app/renderer/home/natural-voice";
      let settings = { voice: { consent: false, speakerRejection: true, muted: false, match: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true } };
      const test = window.__naturalTest = { patches: [], fail: false, retries: 0, managed: false, status: value => view.status(value), policy: value => { test.managed = value; view.settings(settings); }, models: value => view.status({state: "on"}, value) };
      window.ember = { retryNaturalVoice: async () => { test.retries++; } };
      const view = mountNaturalVoice({
        save: async patch => { test.patches.push(patch); if (test.fail) return false; settings = { ...settings, ...patch }; view.settings(settings); return true; },
        live: text => { document.getElementById("voice-live").textContent = text; },
        managed: () => test.managed,
      });
      for (const section of document.querySelectorAll("main > section[data-pane]")) section.classList.toggle("off-pane", section.dataset.pane !== "voice");
      document.body.classList.remove("loading", "first-run");
      document.getElementById("natural-row").hidden = false;
      view.settings(settings);
    ` },
    bundle: true, platform: "browser", format: "iife", write: false, target: "chrome130",
  }).outputFiles[0].text;
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (url === "/app/renderer/home/main.js") { res.setHeader("content-type", "text/javascript"); res.end(fixture); return; }
    const file = path.resolve(root, `.${url}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Natural voice fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    const model = page.locator("#natural-model"), toggle = page.locator("#natural"), use = page.locator("#natural-use");
    expect(await model.inputValue()).toBe("kokoro");
    expect(await toggle.isChecked()).toBe(false);
    await model.selectOption("kitten");
    expect(await page.evaluate(() => window.__naturalTest.patches)).toEqual([]);
    expect(await page.locator("#natural-model-hint").innerText()).toContain("downloads 63.8 MB when enabled");
    expect(await use.innerText()).toBe("Save voice choice");
    await use.click();
    expect(await page.evaluate(() => window.__naturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: false, naturalModel: "kitten" });
    expect(await toggle.isChecked()).toBe(false);
    expect(await model.evaluate(el => el === document.activeElement)).toBe(true);
    await toggle.check();
    expect(await page.evaluate(() => window.__naturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: true, naturalModel: "kitten" });
    await page.evaluate(() => window.__naturalTest.status({ state: "checking" }));
    expect(await page.locator("#natural-text").innerText()).toContain("Kitten Nano: Checking");
    await page.evaluate(() => window.__naturalTest.status({ state: "failed", detail: "Test connection failure." }));
    await page.locator("#natural-retry").click();
    expect(await page.evaluate(() => window.__naturalTest.retries)).toBe(1);
    const before = await page.evaluate(() => window.__naturalTest.patches.length);
    await model.selectOption("kokoro");
    expect(await page.evaluate(() => window.__naturalTest.patches.length)).toBe(before);
    expect(await use.innerText()).toBe("Use Kokoro (350 MB download)");
    await page.evaluate(() => window.__naturalTest.policy(false));
    expect(await model.inputValue()).toBe("kokoro");
    expect(await page.evaluate(() => window.__naturalTest.patches.length)).toBe(before);
    expect(await page.locator("#natural-choice-status").innerText()).toContain("Current choice: Kitten Nano");
    await page.evaluate(() => { window.__naturalTest.fail = true; });
    await use.click();
    expect(await page.locator("#natural-choice-status").innerText()).toContain("Couldn't save");
    expect(await use.evaluate(el => el === document.activeElement)).toBe(true);
    expect(await page.locator("#natural-text").innerText()).toContain("Kitten Nano:");
    expect(await toggle.isChecked()).toBe(true);
    await page.evaluate(() => { window.__naturalTest.fail = false; });
    await use.click();
    expect(await page.evaluate(() => window.__naturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: true, naturalModel: "kokoro" });
    await page.evaluate(() => window.__naturalTest.status({ state: "too-slow" }));
    expect(await page.locator("#natural-text").innerText()).toContain("keeps its usual voice");
    await model.selectOption("kitten");
    await toggle.uncheck();
    expect(await page.evaluate(() => window.__naturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: false, naturalModel: "kitten" });
    await page.evaluate(() => window.__naturalTest.policy(true));
    expect(await toggle.isDisabled()).toBe(true);
    expect(await model.isDisabled()).toBe(true);
    await page.evaluate(() => window.__naturalTest.policy(false));
    await toggle.check();
    await page.evaluate(() => window.__naturalTest.status({ state: "on" }));
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
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "natural-voice-controller-560-larger-forced.png"), fullPage: true });
      await page.emulateMedia({ forcedColors: "none" });
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "natural-voice-controller-1000-larger.png"), fullPage: true });
    }
    await page.evaluate(() => window.__naturalTest.models(["kitten"]));
    expect(await model.evaluate(select => [...(select as HTMLSelectElement).options].map(option => [option.value, option.disabled]))).toEqual([["kokoro", true], ["kitten", false]]);
    // A previously enabled voice can always be turned off when its backend becomes unavailable.
    expect(await toggle.isEnabled()).toBe(true);
    expect(await use.isDisabled()).toBe(true);
    expect(await page.locator("#natural-model-hint").innerText()).toContain("isn't available on this computer");
    await model.selectOption("kitten");
    expect(await toggle.isEnabled()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 60_000);

it.skipIf(process.env.EMBER_VOICE_UI_TEST !== "1")("keeps an enabled voice inspectable and turnable off in full Home after native capability loss", async () => {
  const { DEFAULT_SETTINGS } = await import("../../app/main/settings");
  const { CONSENT_VERSION } = await import("../../app/shared/consent");
  const { SHORTCUTS, FALLBACK_SHORTCUTS, heldShortcuts, shownShortcuts } = await import("../../app/shared/shortcuts");
  const status: import("../../app/shared/ipc").Status = {
    appVersion: "test", settings: { ...DEFAULT_SETTINGS, onboarded: true, consent: { version: CONSENT_VERSION, at: "2026-11-04T00:00:00.000Z" },
      voice: { ...DEFAULT_SETTINGS.voice, natural: true, naturalModel: "kokoro" } },
    environment: { os: "Linux", sessionType: "x11", desktop: "GNOME", display: ":47", glibc: "2.36", versions: { node: "24" }, checks: [] },
    logFile: "/tmp/ember-test.log", settingsNotice: null,
    admin: { source: null, error: null, managed: [], features: {}, provider: null, confirmEveryAction: false, allowGrants: true, retentionDays: 30, neverLook: [] },
    platform: { os: "linux", shortcuts: shownShortcuts(SHORTCUTS.linux, heldShortcuts(SHORTCUTS.linux, FALLBACK_SHORTCUTS.linux, [])),
      dataDir: "~/.config/ember", settingsFile: "~/.config/ember/settings.json", auditCopy: null, micIndicator: "", permissionsNote: "", speakerRejection: true,
      fixLabels: {}, desk: false, autostartNote: null },
  };
  const seedVoice: import("../../app/shared/ipc").VoiceStatus = { state: "off", detail: null, modelsReady: true, modelsMissing: [], modelsBytes: 0,
    natural: { state: "off" }, naturalModels: ["kitten"], listenOnce: { phase: "blocked", detail: "Allow the microphone first." },
    match: { enrolled: false, on: false, model: true, wanted: false, enrolling: null, learnt: 0 } };
  const dist = path.resolve("dist");
  const server = http.createServer((req, res) => {
    const file = path.resolve(dist, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
    res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.EMBER_CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(seed => {
      const listeners: Record<string, ((value: unknown) => void)[]> = {};
      let current = seed.status;
      const emit = (name: string, value: unknown) => { for (const listener of listeners[name] ?? []) listener(value); };
      const test = window.__fullNaturalTest = {
        patches: [] as SettingsPatch[], retries: 0,
        status: (voice: import("../../app/shared/ipc").VoiceStatus) => { emit("onVoiceStatus", voice); },
      };
      window.ember = new Proxy({}, { get: (_target, name: string) => {
        if (name.startsWith("on")) return (fn: (value: unknown) => void) => { (listeners[name] ??= []).push(fn); return () => undefined; };
        if (name === "getStatus") return async () => current;
        if (name === "voiceStatus") return async () => seed.voice;
        if (name === "updateSettings") return async (patch: SettingsPatch) => {
          test.patches.push(patch);
          current = { ...current, settings: { ...current.settings, ...patch } };
          emit("onSettingsChanged", current.settings);
          return current.settings;
        };
        if (name === "retryNaturalVoice") return async () => { test.retries++; };
        return () => new Promise(() => undefined);
      } }) as import("../../app/shared/ipc").EmberHomeApi;
    }, { status, voice: seedVoice });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Full Home fixture didn't start.");
    await page.goto(`http://127.0.0.1:${address.port}/app/renderer/home/index.html`);
    await page.locator('a[href="#voice-h"]').click();
    const row = page.locator("#natural-row"), toggle = page.locator("#natural"), select = page.locator("#natural-model");
    await expect.poll(() => row.isVisible()).toBe(true);
    expect(await toggle.isChecked()).toBe(true);
    expect(await toggle.isEnabled()).toBe(true);
    expect(await select.inputValue()).toBe("kokoro");
    expect(await page.locator("#natural-text").innerText()).toContain("Kokoro isn't available");
    expect(await page.locator("#natural-text").innerText()).toContain("usual voice (Piper when available)");
    expect(await page.locator("#natural-text").innerText()).not.toContain("downloads");
    expect(await page.evaluate(() => window.__fullNaturalTest.patches)).toEqual([]);
    await select.selectOption("kitten");
    expect(await page.evaluate(() => window.__fullNaturalTest.patches)).toEqual([]);
    expect(await page.locator("#natural-use").innerText()).toBe("Use Kitten Nano (63.8 MB download)");
    await page.locator("#natural-use").click();
    await expect.poll(() => page.evaluate(() => window.__fullNaturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: true, naturalModel: "kitten" });
    expect(await page.locator("#natural-text").innerText()).toContain("Kitten Nano isn't active");
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, natural: { state: "on" } }), seedVoice);
    expect(await page.locator("#natural-text").innerText()).toContain("Kitten Nano: On");
    // Full Home fills status rows even while optional voice setup controls are unavailable.
    await page.setViewportSize({ width: 560, height: 900 });
    await page.evaluate(() => { document.documentElement.dataset.textSize = "larger"; });
    await page.emulateMedia({ forcedColors: "active" });
    const voiceRows = await page.locator(".group.voice").evaluate(group => [...group.children].filter((row): row is HTMLElement => {
      if (!(row instanceof HTMLElement)) return false;
      const style = getComputedStyle(row);
      return style.display !== "none" && style.position !== "absolute" && row.getBoundingClientRect().height > 0;
    }).map(row => ({
      id: row.id || row.className, height: row.getBoundingClientRect().height, text: row.innerText.trim(),
      control: [...row.querySelectorAll("button, input, select, textarea, progress")].some(control => control.getClientRects().length > 0),
    })));
    expect(voiceRows.filter(row => !row.text && !row.control)).toEqual([]);
    expect(await page.locator("#voice-listen-once-detail").innerText()).toBe("Allow the microphone first.");
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.EMBER_UI_EVIDENCE, "natural-voice-full-home-rows.json"), JSON.stringify(voiceRows, null, 2));
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "natural-voice-560-larger-forced.png"), fullPage: true });
      await page.emulateMedia({ forcedColors: "none" });
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "natural-voice-1000-larger.png"), fullPage: true });
    }
    await page.evaluate(voice => window.__fullNaturalTest.status(voice), seedVoice);
    expect(await page.locator("#natural-text").innerText()).toContain("Kitten Nano isn't active");
    await page.evaluate(voice => window.__fullNaturalTest.status({ ...voice, naturalModels: [], natural: { state: "off" } }), seedVoice);
    expect(await row.isVisible()).toBe(true);
    expect(await toggle.isChecked()).toBe(true);
    expect(await toggle.isEnabled()).toBe(true);
    expect(await select.isDisabled()).toBe(true);
    expect(await page.locator("#natural-retry").isHidden()).toBe(true);
    expect(await page.locator("#natural-text").innerText()).toContain("Kitten Nano isn't available");
    expect(await page.locator("#voice-live").innerText()).toContain("Kitten Nano isn't available");
    expect(await page.locator("#natural-text").innerText()).toContain("usual voice (Piper when available)");
    await toggle.uncheck();
    await expect.poll(() => page.evaluate(() => window.__fullNaturalTest.patches.at(-1)?.voice)).toMatchObject({ natural: false, naturalModel: "kitten" });
    expect(await page.evaluate(() => window.__fullNaturalTest.retries)).toBe(0);
    expect(await row.isHidden()).toBe(true);
    expect(await page.locator("#speak").evaluate(el => el === document.activeElement)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 60_000);
