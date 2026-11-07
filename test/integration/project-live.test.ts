import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { MemoryGraph } from "../../app/main/memory/graph";
import { AGREE_ARM_MS } from "../../app/shared/provider";
import { memoryFile } from "../../app/main/memory/store";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.env.EMBER_PROJECT_TEST !== "1")("shares only selected files and applies the exact diff after confirmation", async () => {
  const requireCjs = createRequire(import.meta.url);
  const root = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-live-"));
  const userData = path.join(dir, "profile");
  fs.mkdirSync(userData);
  const source = path.join(dir, "greeting.ts");
  const neighbour = path.join(dir, "other.ts");
  const context = Array.from({ length: 4 }, (_, index) => path.join(dir, `context-${index + 1}.ts`));
  for (const file of context) fs.writeFileSync(file, "export const context = true;\n");
  fs.writeFileSync(source, "export const greeting = 'chosen-file-marker';\n");
  fs.writeFileSync(neighbour, "export const secret = 'neighbour-file-marker';");
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() },
  }));
  const saved = new MemoryGraph();
  saved.add({ text: "Previous account memory marker", about: [{ name: "User" }], source: "user" });
  const memory = memoryFile(userData);
  memory.save(saved);
  const diff = "--- a/greeting.ts\n+++ b/greeting.ts\n@@ -1 +1 @@\n-export const greeting = 'chosen-file-marker';\n+export const greeting = 'updated-file-marker';";
  const draft = ["```diff", diff, "```"].join("\n");
  const mock = await startMockLlm({ delayMs: 800, respond: () => ({ text: draft }) });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({
      executablePath: requireCjs("electron") as string,
      args: [root, "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
    });
    // Stub the OS dialogs. The renderer, IPC, Copilot runtime and filesystem changes are real.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected });
    }, [source, neighbour, ...context]);
    const settingsPage = () => app?.windows().find(page => page.url().includes("/renderer/home/index.html"));
    await expect.poll(() => !!settingsPage(), { timeout: 20_000 }).toBe(true);
    const home = settingsPage()!;
    await home.locator('a[href="#project-h"]').click({ timeout: 15_000 });
    const request = "Draft a patch to rename the greeting.";
    await home.locator("#project-pick").click({ timeout: 30_000 });
    await home.locator("#project-files").waitFor({ state: "visible" });
    expect(await home.locator("#project-files").innerText()).toContain("greeting.ts");
    expect(await home.locator("#project-selection").innerText()).toContain("6 of 6 files");
    await home.locator("#project-question").fill(request);
    await home.getByRole("button", { name: "Remove other.ts", exact: true }).click();
    await expect.poll(() => home.locator("#project-selection").innerText()).toContain("5 of 6 files");
    expect(await home.locator("#project-question").inputValue()).toBe(request);
    expect(await home.locator("#project-files").innerText()).not.toContain("other.ts");
    expect(JSON.stringify(mock.requests)).not.toContain("chosen-file-marker");
    await home.locator("#project-mode").selectOption("patch");
    await home.locator("#project-question").fill(request);
    await home.locator("#project-send").click();
    // Hidden while the model works (Cmd+H, or minimised where a window manager reports it): the request goes on and its
    // answer is there when the window shows again, not "Project request cancelled." (integrations-6).
    const homeWindow = (show: boolean) => app!.evaluate(({ BrowserWindow }, on) => {
      const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes("/renderer/home/index.html"));
      if (on) w?.show(); else w?.hide();
    }, show);
    await homeWindow(false);
    await new Promise(resolve => setTimeout(resolve, 400));
    await homeWindow(true);
    expect(await home.locator("#project-running").innerText()).toContain(request);
    expect(await home.locator("#project-running").innerText()).toContain("greeting.ts");
    expect(await home.locator("#project-running").innerText()).not.toContain("other.ts");
    await home.locator("#project-question").fill("A draft for my next request.");
    expect(await home.locator("#project-running").innerText()).toContain(request);
    await home.locator("#project-answer").waitFor({ state: "visible", timeout: 30_000 });
    expect(await home.locator("#project-answer").innerText()).toContain(diff);
    expect(await home.locator("#project-question").inputValue()).toBe("A draft for my next request.");
    await home.locator("#project-answer").getByRole("button", { name: "Copy code", exact: true }).click();
    await expect.poll(() => home.locator("#project-output-status").innerText()).toBe("Project code copied.");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(diff);
    await home.locator("#project-copy-answer").click();
    await expect.poll(() => home.locator("#project-output-status").innerText()).toBe("Project answer copied.");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(draft);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await home.locator("#project-pick").click();
    await expect.poll(() => home.locator("#project-apply").isEnabled()).toBe(true);
    expect(await home.locator("#project-answer").innerText()).toContain(diff);
    expect(await home.locator("#project-selection").innerText()).toContain("total");
    const exportedAnswer = path.join(dir, "answer.txt");
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, exportedAnswer);
    await home.locator("#project-export-answer").click();
    await expect.poll(() => home.locator("#project-output-status").innerText()).toBe("Project answer exported.");
    expect(fs.readFileSync(exportedAnswer, "utf8")).toBe(draft);
    const sent = JSON.stringify(mock.requests);
    expect(sent).toContain(request);
    expect(sent).toContain("chosen-file-marker");
    expect(sent).not.toContain("neighbour-file-marker");
    expect(fs.readFileSync(source, "utf8")).toContain("chosen-file-marker");
    await home.locator("#project-patch summary").focus();
    await home.keyboard.press("Enter");
    expect(await home.locator("#project-diff").innerText()).toBe(diff);
    await home.locator("#project-copy-diff").click();
    await expect.poll(() => home.locator("#project-output-status").innerText()).toBe("Project diff copied.");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(diff);
    const exportedDiff = path.join(dir, "answer.diff");
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, exportedDiff);
    await home.locator("#project-export-diff").click();
    await expect.poll(() => fs.existsSync(exportedDiff)).toBe(true);
    expect(fs.readFileSync(exportedDiff, "utf8")).toBe(diff);
    for (const [width, textSize, forcedColors] of [[1000, "default", "none"], [420, "larger", "none"], [560, "larger", "active"], [728, "larger", "none"]] as const) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes("/renderer/home/"))!;
        win.setMinimumSize(320, 400);
        win.setContentSize(width, 900);
      }, width);
      await home.evaluate(size => { document.documentElement.dataset.textSize = size; }, textSize);
      await home.emulateMedia({ forcedColors });
      const dimensions = await home.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      expect(dimensions.content, `${width}px ${textSize} ${forcedColors}`).toBeLessThanOrEqual(dimensions.width);
      await home.locator("#project-copy-diff").focus();
      expect(await home.locator("#project-copy-diff").evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(24);
      if (process.env.EMBER_UI_EVIDENCE) {
        fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
        await home.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, `projects-${width}-${textSize}-${forcedColors}.png`), fullPage: true });
      }
    }
    await home.emulateMedia({ forcedColors: "none" });
    expect(fs.readFileSync(source, "utf8")).toContain("chosen-file-marker");
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await home.locator("#project-apply").click();
    await expect.poll(() => home.locator("#project-status").innerText()).toMatch(/cancelled/i);
    expect(fs.readFileSync(source, "utf8")).toContain("chosen-file-marker");
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await home.locator("#project-apply").click();
    await expect.poll(() => home.locator("#project-status").innerText()).toBe("Patch applied to greeting.ts.");
    expect(fs.readFileSync(source, "utf8")).toBe("export const greeting = 'updated-file-marker';\n");
    expect(fs.readFileSync(neighbour, "utf8")).toContain("neighbour-file-marker");
    expect(await home.locator("#project-patch-summary").innerText()).toBe("Applied diff");
    expect(await home.locator("#project-apply").isHidden()).toBe(true);
    fs.writeFileSync(source, "x".repeat(24 * 1024 + 1));
    await home.locator("#project-send").click();
    await expect.poll(() => home.locator("#project-status").innerText()).toContain("Previous output is still shown");
    expect(await home.locator("#project-answer").innerText()).toContain(diff);
    expect(await home.locator("#project-diff").innerText()).toBe(diff);
    expect(await home.locator("#project-apply").isHidden()).toBe(true);
    expect(await home.locator("#project-question").inputValue()).toBe("A draft for my next request.");
    const auditDir = path.join(userData, "audit");
    const events = fs.readdirSync(auditDir).filter(name => name.endsWith(".jsonl"))
      .flatMap(name => fs.readFileSync(path.join(auditDir, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    expect(events).toContainEqual(expect.objectContaining({ event: "confirm", kind: "project-patch", answer: "once" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "action", kind: "project-patch", ok: true }));
    const selectedCount = await home.locator("#project-files li").count();
    for (let remaining = selectedCount; remaining > 0; remaining--) {
      const remove = home.locator("#project-files button").first();
      await remove.focus();
      await home.keyboard.press("Enter");
      await expect.poll(() => home.locator("#project-files li").count()).toBe(remaining - 1);
      await expect.poll(() => home.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("aria-label"))).toBe(
        remaining === 1 ? "project-pick" : await home.locator("#project-files button").first().getAttribute("aria-label"),
      );
      expect(await home.locator("#project-question").inputValue()).toBe("A draft for my next request.");
    }
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


it.skipIf(process.env.EMBER_PROJECT_TEST !== "1")("reviews, declines, and runs project commands in the selected folder", async () => {
  const requireCjs = createRequire(import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-command-"));
  const userData = path.join(dir, "profile");
  const folder = path.join(dir, "project");
  fs.mkdirSync(userData);
  fs.mkdirSync(folder);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, consent: { version: CONSENT_VERSION, at },
    commands: { local: { on: true, askEvery: false, consent: { version: FEATURE_CONSENT_VERSION.commands, at } } },
  }));
  const mock = await startMockLlm({ delayMs: 5, respond: () => ({ text: "Ready." }) });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({
      executablePath: requireCjs("electron") as string,
      args: [process.cwd(), "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
    });
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, folder);
    const page = (name: string) => app?.windows().find(win => win.url().includes("/renderer/" + name + "/index.html"));
    await expect.poll(() => !!page("home"), { timeout: 20_000 }).toBe(true);
    const home = page("home")!;
    await home.locator('a[href="#project-h"]').click({ timeout: 15_000 });
    await home.locator("#project-commands summary").click();
    await home.locator("#project-folder-pick").click({ timeout: 30_000 });
    await expect.poll(() => home.locator("#project-folder").innerText()).toBe(fs.realpathSync(folder));
    const command = "mkdir project-command-approved";
    const marker = path.join(folder, "project-command-approved");
    await home.locator("#project-command-text").fill(command);
    const review = async () => {
      await home.locator("#project-command-send").click();
      await expect.poll(() => !!page("command"), { timeout: 15_000 }).toBe(true);
      const panel = page("command")!;
      const allow = panel.getByRole("button", { name: "Allow", exact: true });
      await expect.poll(() => allow.isEnabled(), { timeout: 15_000 }).toBe(true);
      expect(await panel.locator("#ask-cmd").innerText()).toContain(command);
      expect(await panel.locator("body").innerText()).toContain(fs.realpathSync(folder));
      expect(fs.existsSync(marker)).toBe(false);
      return { panel, allow };
    };
    const denied = await review();
    await denied.panel.getByRole("button", { name: "Not now", exact: true }).click();
    await expect.poll(() => home.locator("#project-command-status").innerText()).toMatch(/said no/i);
    expect(fs.existsSync(marker)).toBe(false);

    const stale = await review();
    fs.renameSync(folder, folder + "-old");
    fs.mkdirSync(folder);
    await stale.allow.click();
    await expect.poll(() => home.locator("#project-command-status").innerText()).toMatch(/folder changed/i);
    expect(fs.existsSync(marker)).toBe(false);

    await home.locator("#project-folder-pick").click();
    const approved = await review();
    await approved.allow.click();
    await expect.poll(() => home.locator("#project-command-status").innerText(), { timeout: 20_000 }).toMatch(/finished/i);
    expect(fs.statSync(marker).isDirectory()).toBe(true);

    const slow = process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10";
    await home.locator("#project-command-text").fill(slow + "; mkdir project-command-stopped");
    await home.locator("#project-command-send").click();
    await approved.allow.click();
    await approved.panel.getByRole("button", { name: /^Stop:/ }).waitFor({ state: "visible" });
    await home.locator("#project-command-stop").click();
    await expect.poll(() => home.locator("#project-command-status").innerText(), { timeout: 15_000 }).toMatch(/stopped/i);
    expect(fs.existsSync(path.join(folder, "project-command-stopped"))).toBe(false);
    expect(JSON.stringify(mock.requests)).not.toContain(command);
  } finally {
    await app?.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(process.env.EMBER_PROJECT_TEST !== "1")("resumes a saved workspace after restart without reusing approval or sending automatically", async () => {
  const requireCjs = createRequire(import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-resume-"));
  const userData = path.join(dir, "profile");
  const folder = path.join(dir, "work");
  const source = path.join(folder, "resume.ts");
  fs.mkdirSync(userData);
  fs.mkdirSync(folder);
  fs.writeFileSync(source, "export const mark = 'first-content';\n");
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, consent: { version: CONSENT_VERSION, at: new Date().toISOString() },
  }));
  const mock = await startMockLlm({ delayMs: 5, respond: () => ({ text: "Previous plan marker. Review the callers." }) });
  const other = await startMockLlm({ delayMs: 5, respond: () => ({ text: "Different connection." }) });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  const launch = async (url: string) => {
    app = await _electron.launch({
      executablePath: requireCjs("electron") as string,
      args: [process.cwd(), "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: url },
    });
    await app.evaluate(({ dialog, safeStorage }, data) => {
      dialog.showOpenDialog = async (_owner: unknown, opts?: { properties?: readonly string[] }) => ({
        canceled: false, filePaths: [opts?.properties?.includes("openDirectory") ? data.folder : data.source],
      });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      // Headless Linux CI does not have an unlocked desktop keyring. Windows uses its real DPAPI store.
      if (process.platform === "linux") {
        const { createCipheriv, createDecipheriv, randomBytes } = process.getBuiltinModule("node:crypto")!;
        const key = Buffer.alloc(32, 42);
        safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
        safeStorage.isEncryptionAvailable = () => true;
        safeStorage.encryptString = clear => {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const encrypted = Buffer.concat([cipher.update(clear, "utf8"), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
        };
        safeStorage.decryptString = bytes => {
          const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
        };
      }
    }, { source, folder });
    const page = () => app?.windows().find(win => win.url().includes("/renderer/home/index.html"));
    await expect.poll(() => !!page(), { timeout: 20_000 }).toBe(true);
    const home = page()!;
    await home.locator('a[href="#project-h"]').click({ timeout: 15_000 });
    await expect.poll(() => home.locator("#project-pick").isEnabled(), { timeout: 30_000 }).toBe(true);
    return home;
  };
  try {
    let home = await launch(mock.baseUrl);
    await home.locator("#project-pick").click();
    await home.locator("#project-mode").selectOption("plan");
    await home.locator("#project-question").fill("Plan the first workspace change.");
    await home.locator("#project-send").click();
    await home.locator("#project-answer").waitFor({ state: "visible", timeout: 30_000 });
    await home.locator("#project-commands summary").click();
    await home.locator("#project-folder-pick").click();
    await expect.poll(() => home.locator("#project-folder").innerText()).toBe(fs.realpathSync(folder));
    await home.locator("#project-workspaces summary").focus();
    await home.keyboard.press("Enter");
    await home.getByLabel("Workspace name").fill("Resume demo");
    await home.locator("#project-workspace-save").click();
    await expect.poll(() => home.locator("#project-workspace-status").innerText()).toContain("Saved workspace");
    const saved = fs.readdirSync(userData).find(f => /^project-workspaces-.*\.bin$/.test(f))!;
    const raw = fs.readFileSync(path.join(userData, saved), "utf8");
    expect(raw).not.toContain("Resume demo");
    expect(raw).not.toContain("Previous plan marker");
    await app?.close();

    home = await launch(other.baseUrl);
    await home.locator("#project-workspaces summary").click();
    await expect.poll(() => home.locator("#project-workspace-status").innerText()).toBe("No saved workspaces.");
    await app?.close();

    fs.writeFileSync(source, "export const mark = 'fresh-content';\n");
    home = await launch(mock.baseUrl);
    await home.locator("#project-workspaces summary").click();
    const sent = mock.requests.length;
    await home.locator("#project-workspace-open").click();
    await expect.poll(() => home.locator("#project-files").innerText()).toContain("resume.ts");
    expect(await home.locator("#project-answer").innerText()).toContain("Previous plan marker");
    expect(await home.locator("#project-question").inputValue()).toBe("");
    expect(await home.locator("#project-include-previous").isChecked()).toBe(true);
    expect(await home.locator("#project-apply").isHidden()).toBe(true);
    await home.locator("#project-commands summary").click();
    expect(await home.locator("#project-folder").innerText()).toBe(fs.realpathSync(folder));
    expect(await home.locator("#project-command-text").inputValue()).toBe("");
    expect(mock.requests.slice(sent).map((value: unknown) => JSON.stringify(value)).join("\n")).not.toContain("Previous plan marker");

    await home.locator("#project-question").fill("Continue with the current file.");
    await home.locator("#project-send").click();
    await expect.poll(() => home.locator("#project-status").innerText(), { timeout: 30_000 }).toBe("Project answer ready.");
    const follow = JSON.stringify(mock.requests.slice(sent));
    expect(follow).toContain("previous_project_exchange");
    expect(follow).toContain("Plan the first workspace change.");
    expect(follow).toContain("Previous plan marker");
    expect(follow).toContain("fresh-content");

    await home.locator("#project-include-previous").uncheck();
    const beforeNew = mock.requests.length;
    await home.locator("#project-question").fill("Review the file on its own.");
    await home.locator("#project-send").click();
    await expect.poll(() => home.locator("#project-status").innerText(), { timeout: 30_000 }).toBe("Project answer ready.");
    expect(JSON.stringify(mock.requests.slice(beforeNew))).not.toContain("previous_project_exchange untrusted");
    await home.locator("#project-workspace-forget").click();
    await expect.poll(() => home.locator("#project-workspace-status").innerText()).toContain("Forgot workspace");
    expect(fs.existsSync(path.join(userData, saved))).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
  } finally {
    await app?.close();
    await mock.close();
    await other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(process.env.EMBER_PROJECT_TEST !== "1")("keeps personalisation optional while consent and Stop guidance remain in the short first-run route", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-welcome-short-"));
  const userData = path.join(dir, "profile");
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, wakeWord: false, speak: false }));
  const mock = await startMockLlm({ delayMs: 5, respond: () => ({ text: "Ready." }) });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [process.cwd(), "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
    });
    const settingsPage = () => app?.windows().find(page => page.url().includes("/renderer/home/index.html"));
    await expect.poll(() => !!settingsPage(), { timeout: 20_000 }).toBe(true);
    const home = settingsPage()!;
    await home.locator("#welcome").waitFor({ state: "visible", timeout: 30_000 });
    await expect.poll(() => home.locator("#w-count").innerText()).toBe("Step 1 of 6");
    await home.locator("#w-alt").click();
    expect(await home.locator("#w-count").innerText()).toBe("Optional · Character");
    await home.locator("#w-back").click();
    await home.locator("#w-next").click();
    expect(await home.locator("#welcome").getAttribute("data-step")).toBe("consent");
    expect(await home.evaluate(() => window.ember.projectRun({ mode: "review", question: "Must stay blocked." }))).toEqual({ error: "Project work is unavailable right now." });
    expect(mock.requests).toHaveLength(0);
    await home.locator("#w-alt").click();
    expect(await home.locator("#welcome").getAttribute("data-step")).toBe("consent");
    expect(await home.locator("#w-consent-note").innerText()).toContain("nothing is read, heard or sent");
    expect(JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).consent?.version ?? 0).toBeLessThan(CONSENT_VERSION);
    // Agree takes a press once it has been on screen a moment, so a double click on Get started agrees to nothing.
    await home.waitForTimeout(AGREE_ARM_MS);
    await home.locator("#w-next").click();
    await expect.poll(() => home.locator("#welcome").getAttribute("data-step")).toBe("sign-in");
    await expect.poll(() => home.locator("#w-next").getAttribute("aria-disabled"), { timeout: 30_000 }).not.toBe("true");
    await home.locator("#w-next").click();
    await expect.poll(() => home.locator("#welcome").getAttribute("data-step")).toBe("checks");
    await home.locator("#w-next").click();
    expect(await home.locator("#welcome").getAttribute("data-step")).toBe("try");
    expect(await home.locator("#w-try-stop").isVisible()).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes("/renderer/home/"))!;
      win.setMinimumSize(320, 400); win.setContentSize(420, 900);
    });
    await home.evaluate(() => { document.documentElement.dataset.textSize = "larger"; });
    expect(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.EMBER_UI_EVIDENCE) {
      fs.mkdirSync(process.env.EMBER_UI_EVIDENCE, { recursive: true });
      await home.screenshot({ path: path.join(process.env.EMBER_UI_EVIDENCE, "welcome-try-420-larger.png"), fullPage: true });
    }
    await home.locator("#w-stop").click();
    await expect.poll(() => home.locator("#w-try-stop").getAttribute("class")).toContain("done");
    await home.locator("#w-alt").click();
    expect(await home.locator("#w-count").innerText()).toBe("Optional · About you");
    await home.locator("#w-back").click();
    await home.locator("#w-next").click();
    expect(await home.locator("#w-count").innerText()).toBe("Step 6 of 6");
    await home.locator("#w-next").click();
    await home.locator("#welcome").waitFor({ state: "hidden" });
    const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    expect(settings).toMatchObject({ onboarded: true, consent: { version: CONSENT_VERSION }, memory: { on: false } });
    expect(mock.requests).toHaveLength(0);
  } finally {
    await app?.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
