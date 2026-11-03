import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { MemoryGraph } from "../../app/main/memory/graph";
import { memoryFile } from "../../app/main/memory/store";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.env.EMBER_PROJECT_TEST !== "1")("shares only the files chosen in the native picker and shows a draft in Home", async () => {
  const requireCjs = createRequire(import.meta.url);
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-live-"));
  const userData = path.join(dir, "profile");
  fs.mkdirSync(userData);
  const source = path.join(dir, "greeting.ts");
  const neighbour = path.join(dir, "other.ts");
  fs.writeFileSync(source, "export const greeting = 'chosen-file-marker';");
  fs.writeFileSync(neighbour, "export const secret = 'neighbour-file-marker';");
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() },
  }));
  const saved = new MemoryGraph();
  saved.add({ text: "Previous account memory marker", about: [{ name: "User" }], source: "user" });
  const memory = memoryFile(userData);
  memory.save(saved);
  const mock = await startMockLlm({ delayMs: 5, respond: () => ({ text: "Draft ready for inspection." }) });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({
      executablePath: requireCjs("electron") as string,
      args: [root, "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
    });
    // The only seam is the OS dialog result. The renderer, IPC, local file read and Copilot runtime are real.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, source);
    const settingsPage = () => app?.windows().find(page => page.url().includes("/renderer/home/index.html"));
    await expect.poll(() => !!settingsPage(), { timeout: 20_000 }).toBe(true);
    const home = settingsPage()!;
    await home.locator('a[href="#copilot-h"]').click({ timeout: 15_000 });
    const request = "Draft a patch to rename the greeting.";
    await home.locator("#project-pick").click({ timeout: 30_000 });
    await home.locator("#project-files").waitFor({ state: "visible" });
    expect(await home.locator("#project-files").innerText()).toBe("greeting.ts");
    expect(JSON.stringify(mock.requests)).not.toContain("chosen-file-marker");
    await home.locator("#project-mode").selectOption("patch");
    await home.locator("#project-question").fill(request);
    await home.locator("#project-send").click();
    await home.locator("#project-answer").waitFor({ state: "visible", timeout: 30_000 });
    expect(await home.locator("#project-answer").innerText()).toBe("Draft ready for inspection.");
    const sent = JSON.stringify(mock.requests);
    expect(sent).toContain(request);
    expect(sent).toContain("chosen-file-marker");
    expect(sent).not.toContain("neighbour-file-marker");
    expect(fs.readFileSync(source, "utf8")).toContain("chosen-file-marker");
    await home.locator("#project-clear").click();
    expect(await home.locator("#project-answer").isHidden()).toBe(true);
    expect(await home.locator("#project-files").isHidden()).toBe(true);
    await home.locator('a[href="#memory-h"]').click();
    await home.locator("#memory-owner").waitFor({ state: "visible" });
    expect(await home.locator("#memory-list").innerText()).not.toContain("Previous account memory marker");
    expect(fs.readFileSync(memory.path, "utf8")).toContain("Previous account memory marker");
    expect(JSON.stringify(mock.requests)).not.toContain("Previous account memory marker");
  } finally {
    await app?.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
