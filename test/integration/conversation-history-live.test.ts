/**
 * "Keep my recent conversation after Ember closes", end to end in the real app: a person finds the switch by its label,
 * talks to Ember (a mock model), quits, and on the next launch sees the conversation again; turning the switch off
 * deletes the saved file, and with it off a relaunch shows nothing. Real Electron, renderer, IPC, Copilot runtime and
 * files; only the model is a mock server. Runs with EMBER_CONVERSATION_LIVE=1 (CI's el8 job).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { CONVERSATION_KEEP_LABEL } from "../../app/renderer/home/copy";
import { HISTORY_FILE } from "../../app/main/agent/conversation-store";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.env.EMBER_CONVERSATION_LIVE !== "1")("keeps the conversation across a normal quit only while the switch is on, and deletes it when it is turned off", async () => {
  const requireCjs = createRequire(import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-history-live-"));
  const userData = path.join(dir, "profile");
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() },
  }));
  const saved = path.join(userData, HISTORY_FILE);
  // Not a request to remember: with memory off, Ember adds its own note after the answer to one (memory-c1-1).
  const ASKED = "Please repeat the word pineapple-history-marker.";
  const ANSWERED = "Noted: answer-history-marker.";
  const mock = await startMockLlm({ delayMs: 5, respond: () => ({ text: ANSWERED }) });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  const launch = async () => {
    app = await _electron.launch({
      executablePath: requireCjs("electron") as string,
      args: [process.cwd(), "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
    });
    const page = () => app?.windows().find(win => win.url().includes("/renderer/home/index.html"));
    await expect.poll(() => !!page(), { timeout: 20_000 }).toBe(true);
    const home = page()!;
    await home.locator("#conversation-message").waitFor({ state: "visible", timeout: 20_000 });
    return home;
  };
  /** A normal quit (the app's own quit path, so Ember flushes what it keeps), then the process is gone. */
  const quit = async () => {
    const closed = new Promise<void>(done => app!.process().once("exit", () => done()));
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
    await closed;
    app = undefined;
  };
  const conversation = (home: Awaited<ReturnType<typeof launch>>) => home.locator("#conversation");
  try {
    // First run: the switch is off by default and found by its label.
    let home = await launch();
    const keep = home.getByLabel(CONVERSATION_KEEP_LABEL);
    expect(await keep.isChecked()).toBe(false);
    await keep.check();
    await expect.poll(() => keep.isChecked()).toBe(true);

    await home.locator("#conversation-message").fill(ASKED);
    await home.locator("#conversation-send").click();
    await expect.poll(() => conversation(home).innerText(), { timeout: 60_000 }).toContain(ANSWERED);
    // Quit straight away: what was said last is flushed by the quit itself.
    await quit();
    if (process.platform !== "win32") expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    const file = fs.readFileSync(saved, "utf8");
    expect(file).toContain("pineapple-history-marker");
    expect(file).toContain("answer-history-marker");
    expect(file).not.toMatch(/answerId|heardId/);

    // Second run: both lines are back, for reading, and nothing was sent to the model for them.
    const sentBefore = mock.requests.length;
    home = await launch();
    await expect.poll(() => conversation(home).innerText(), { timeout: 60_000 }).toContain("pineapple-history-marker");
    expect(await conversation(home).innerText()).toContain(ANSWERED);
    expect(await home.getByLabel(CONVERSATION_KEEP_LABEL).isChecked()).toBe(true);
    expect(mock.requests.length).toBe(sentBefore);

    // Turning it off deletes the file at once.
    await home.getByLabel(CONVERSATION_KEEP_LABEL).uncheck();
    await expect.poll(() => fs.existsSync(saved), { timeout: 10_000 }).toBe(false);
    await quit();
    expect(fs.existsSync(saved)).toBe(false);

    // Third run, off: nothing is shown and nothing is written, even after talking.
    home = await launch();
    expect(await home.getByLabel(CONVERSATION_KEEP_LABEL).isChecked()).toBe(false);
    expect(await conversation(home).innerText()).not.toContain("pineapple-history-marker");
    await home.locator("#conversation-message").fill("One more thing, kept nowhere.");
    await home.locator("#conversation-send").click();
    await expect.poll(() => conversation(home).innerText(), { timeout: 60_000 }).toContain(ANSWERED);
    await quit();
    expect(fs.existsSync(saved)).toBe(false);
  } finally {
    await app?.close().catch(() => undefined);
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 240_000);
