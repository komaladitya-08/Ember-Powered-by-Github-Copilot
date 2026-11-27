/**
 * Home's Chats end to end in the real app: with “Chat with Copilot in a folder” on, a person starts a chat in a folder
 * (the folder picker answered by replacing main's dialog, as the coding journeys do), the model asks to run a command,
 * the person allows it once on its card in Home, and its output shows in the chat and its file in the folder. Real
 * Electron, renderer, IPC, chat runtime and SDK sandbox; only the model is a mock server. Runs with EMBER_CHAT_LIVE=1
 * under a display (xvfb-run) on Linux with bubblewrap.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION } from "../../app/shared/consent";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.env.EMBER_CHAT_LIVE !== "1")("runs a command the person allowed on its card in Home, and shows its output", async () => {
  const requireCjs = createRequire(import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-chat-live-"));
  const userData = path.join(dir, "profile");
  const work = path.join(dir, "work");
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, speak: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() }, chat: { native: true },
  }));
  const mock = await startMockLlm({ delayMs: 5 });
  const app = await _electron.launch({
    executablePath: requireCjs("electron") as string,
    args: [process.cwd(), "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
  });
  try {
    const page = () => app.windows().find(win => win.url().includes("/renderer/home/index.html"));
    await expect.poll(() => !!page(), { timeout: 30_000 }).toBe(true);
    const home = page()!;
    // Main's own folder picker, answered with the work folder.
    await app.evaluate(({ dialog }, folder) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, work);
    await home.locator("#jump-chats").waitFor({ state: "visible", timeout: 30_000 });
    await home.locator("#jump-chats").click();
    // New chat once Ember is connected (before, main says to connect first, in place).
    await expect.poll(async () => {
      if (await home.locator("#chat-main").isVisible()) return true;
      await home.getByRole("button", { name: "New chat…" }).click();
      await home.waitForTimeout(1500);
      return home.locator("#chat-main").isVisible();
    }, { timeout: 90_000, interval: 500 }).toBe(true);
    expect(await home.locator("#chat-folder").textContent()).toContain(fs.realpathSync(work).split(path.sep).pop()!);

    const command = "echo live-chat-marker > marker.txt && echo printed-chat-marker";
    await home.locator("#chat-message").fill(`CALLTOOL:bash${JSON.stringify({ command, description: "write a marker" })}`);
    await home.locator("#chat-message").press("Enter");
    const card = home.locator("#chat-log li.chat-card:not(.resolved)");
    await card.waitFor({ timeout: 90_000 });
    expect(await card.locator(".chat-code").textContent()).toBe(command);
    expect(await card.locator(".chat-choices button").allTextContents()).toContain("Allow once");
    expect(fs.existsSync(path.join(work, "marker.txt"))).toBe(false);
    // Its approvals take a press once the card has been in view for a moment.
    await card.scrollIntoViewIfNeeded();
    await home.waitForTimeout(700);
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect.poll(() => home.locator("#chat-log .chat-record").first().textContent(), { timeout: 30_000 }).toBe("Allowed once, by you.");
    const row = home.locator("#chat-log li.chat-tool").first();
    await expect.poll(() => row.innerText(), { timeout: 60_000 }).toContain("printed-chat-marker");
    await expect.poll(() => row.locator(".chat-tool-end").textContent(), { timeout: 30_000 }).toBe("Finished, exit code 0. You allowed it.");
    expect(fs.readFileSync(path.join(work, "marker.txt"), "utf8").trim()).toBe("live-chat-marker");
    await expect.poll(() => home.locator("#chat-log").innerText(), { timeout: 30_000 }).toContain("Done. I used my tool.");
  } finally {
    const closed = new Promise<void>(done => app.process().once("exit", () => done()));
    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
    await Promise.race([closed, new Promise(r => setTimeout(r, 15_000))]);
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 240_000);
