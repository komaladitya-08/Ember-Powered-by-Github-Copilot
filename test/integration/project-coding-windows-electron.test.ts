/**
 * Actual Windows Electron Home/preload/IPC -> Host -> file-only SDK -> native copy/review/export.
 * Exact product inventory: seven file tools, finish_coding and the existing host-owned ask_coding_question.
 * Only source/export picker answers and the offline model are fixtures. Local commands stay off; no original apply,
 * SDK hook, mocked preload, command stop receipt, real account, sandbox bypass or desktop action is supplied.
 * Windows Server CI: npm run build
 * PowerShell: $env:EMBER_ELECTRON_WINDOWS_CODING_TEST = "1"
 * Then: node scripts/run-integration.mjs test/integration/project-coding-windows-electron.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { closeTestElectron } from "./close-electron";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

const required = process.env.EMBER_ELECTRON_WINDOWS_CODING_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64" && fs.existsSync(path.join(process.cwd(), "dist/app/main.cjs"));
const original = "export const answer = 41;\n";
const outside = "OUTSIDE_WINDOWS_PROJECT_MUST_STAY_LOCAL";
const credential = "gho_" + "Q".repeat(36);
const scenarios = [
  { request: "In this project's chosen folder, change the copied answer from 41 to 42 and prepare a review. Leave the original unchanged. Do not run commands or tests.",
    goal: "Change only the private app.ts answer from 41 to 42 for review", value: "42" },
  { request: "Prepare a separate fresh private alternative changing the original answer from 41 to 43 and prepare its review. Leave the original unchanged. Do not run commands or tests.",
    goal: "Prepare a fresh private app.ts alternative changing 41 to 43 for review", value: "43" },
];

it.skipIf(!available && !required)("edits copied Windows projects through real Electron IPC with commands off and preserves exports across selective and global Forget", async () => {
  expect(process.platform, "The explicitly required Windows Electron coding journey must run on Windows").toBe("win32");
  expect(process.arch, "The native Windows copied-file journey requires x64").toBe("x64");
  const appRoot = process.cwd(), requireCjs = createRequire(import.meta.url);
  expect(fs.existsSync(path.join(appRoot, "dist/app/main.cjs")), "Build the app before the Windows Electron coding journey").toBe(true);
  const runtime = runtimeFor("win32", "x64");
  expect(locateRuntime({ appPath: appRoot, runtimeId: runtime.id, exe: runtime.exe }).exists, "The pinned Windows controller runtime is required").toBe(true);

  // Vitest removes its run-temp regardless of native cleanup status. Quarantine the entire app/profile/temp beside it.
  const runTemporary = fs.realpathSync(os.tmpdir());
  const temporaryBase = path.basename(runTemporary).startsWith("ember-run-") ? path.dirname(runTemporary) : runTemporary;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryBase, "ember-windows-coding-electron-")));
  const userData = path.join(root, "profile"), source = path.join(root, "source"), exported = path.join(root, "exported"), temporary = path.join(root, "temporary");
  for (const directory of [userData, source, exported, temporary, path.join(source, ".git"), path.join(source, "node_modules")]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, "app.ts"), original);
  fs.writeFileSync(path.join(source, "README.txt"), "Unchanged Windows project fixture.\n");
  fs.writeFileSync(path.join(source, ".git", "HEAD"), "EXCLUDED_GIT_DATA_MUST_NOT_BE_ARCHIVED");
  fs.writeFileSync(path.join(source, "node_modules", "fixture.js"), "EXCLUDED_DEPENDENCY_DATA_MUST_NOT_BE_ARCHIVED");
  fs.writeFileSync(path.join(root, "outside.txt"), outside);
  // Synthetic protected-app data only: no existing credential file or live account is inspected.
  fs.writeFileSync(path.join(userData, "credential-canary.txt"), credential);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    version: 1, onboarded: true, wakeWord: false, speak: false, speakWithScreenReader: false, speakResults: false,
    consent: { version: CONSENT_VERSION, at }, commands: { local: { on: false, askEvery: true } },
  }));
  const dispatched = new Set<string>(), steps = new Map<string, number>(); let actions = 0;
  const model = await startMockLlm({ delayMs: 0, respond: (messages: { role: string; content: unknown }[], tools: string[]) => {
    if (tools.includes("start_coding")) {
      const next = scenarios.find(scenario => !dispatched.has(scenario.request) && messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(scenario.request)));
      if (next) { dispatched.add(next.request); return { tool: { name: "start_coding", args: { goal: next.goal, sessionName: `Private answer ${next.value}` } } }; }
      return { text: "The copied-file session has a project card and Stop. Commands and tests are unavailable." };
    }
    if (tools.includes("finish_coding")) {
      const scenario = scenarios.find(candidate => messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(candidate.goal)));
      if (!scenario) return { text: "No current copied-file request." };
      const step = steps.get(scenario.goal) ?? 0;
      if (step >= 3) return { text: "The private file edit is ready for review." };
      steps.set(scenario.goal, step + 1); actions++;
      if (step === 0) return { tool: { name: "coding_read", args: { path: "app.ts" } } };
      if (step === 1) return { tool: { name: "coding_replace", args: { path: "app.ts", oldText: "answer = 41", newText: `answer = ${scenario.value}` } } };
      return { tool: { name: "finish_coding", args: { success: true, summary: `Prepared the copied answer ${scenario.value} for review.` } } };
    }
    return { text: "Ready for review." };
  } });
  let app: ElectronApplication | undefined, mainProcess: ChildProcess | undefined, home: Page | undefined;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: model.baseUrl, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN", "COPILOT_TOKEN", "COPILOT_SDK_AUTH_TOKEN",
      "ELECTRON_RUN_AS_NODE", "ELECTRON_DISABLE_SANDBOX", "EMBER_SMOKE_NO_SANDBOX"]) delete env[key];
    const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    app = await _electron.launch({ executablePath: requireCjs("electron") as string, args: [appRoot, "--show-settings"], env: childEnv, timeout: 45_000 });
    mainProcess = app.process();
    expect(mainProcess.spawnargs.some(argument => argument === "--no-sandbox" || argument === "--disable-sandbox")).toBe(false);
    // Only these two OS picker answers are supplied. Production sender guards, folder validation and native ownership remain.
    await app.evaluate(({ dialog }, folders) => {
      const calls: string[] = [];
      (globalThis as typeof globalThis & { __windowsCodingPickerCalls: string[] }).__windowsCodingPickerCalls = calls;
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string })?.title ?? ""; calls.push(title);
        if (title === "Choose a coding folder") return { canceled: false, filePaths: [folders.source] };
        if (title === "Export coding review") return { canceled: false, filePaths: [folders.exported] };
        throw new Error("The Windows fixture permits only coding source and export folder pickers.");
      };
    }, { source, exported });
    await expect.poll(() => app!.windows().some(page => page.url().includes("/renderer/home/index.html")), { timeout: 30_000 }).toBe(true);
    home = app.windows().find(page => page.url().includes("/renderer/home/index.html"))!;
    await expect.poll(() => home!.evaluate(() => window.ember.agentStatus().then(state => state?.phase)), { timeout: 40_000 }).toBe("ready");
    expect(await home.evaluate(() => window.ember.getStatus().then(status => status.settings.commands.local?.on))).toBe(false);
    const local = (await home.evaluate(() => window.emberTargets!.list())).find(target => target.id === "local");
    expect(local).toBeDefined(); expect(local!.can).not.toMatch(/\b(?:and commands|commands only)\b/i);
    // Windows reports OS sandbox state in real app metrics; bind it to Home's actual renderer PID.
    await expect.poll(() => app!.evaluate(({ BrowserWindow, app: electronApp }) => {
      const homes = BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes("/renderer/home/index.html"));
      const metrics = electronApp.getAppMetrics();
      return homes.length > 0 && homes.every(window => metrics.find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true);
    }), { timeout: 15_000 }).toBe(true);
    expect(await home.evaluate(() => ({ process: typeof process, require: typeof require }))).toEqual({ process: "undefined", require: "undefined" });
    await home.locator('a[href="#project-h"]').click();
    expect(await home.locator("#coding-workspace").isHidden()).toBe(true);
    await home.locator("#project-sessions-name").fill("Native Windows copied edits");
    await home.locator("#project-sessions-add").click();
    await expect.poll(() => home!.locator("#project-coding-choose").isEnabled()).toBe(true);
    await home.locator("#project-coding-choose").click();
    await expect.poll(() => home!.locator("#project-coding-folder").textContent()).toContain(source);
    const projectId = (await home.evaluate(() => window.ember.projectSessionsState())).selectedProjectId!;
    expect(projectId).toBeTruthy(); expect(model.requests).toHaveLength(0);
    await expect.poll(async () => {
      const state = await home!.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId);
      return { available: state.available, canContinue: state.canContinue, message: state.message };
    }, { timeout: 30_000 }).toMatchObject({ available: true, canContinue: false, message: expect.stringContaining("Commands, tests and dependency installation are unavailable") });
    const foreign = await app.evaluate(async ({ BrowserWindow, app: electronApp }) => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: electronApp.getAppPath() + "/dist/app/preload/home.cjs" } });
      try {
        await window.loadURL("about:blank");
        return await window.webContents.executeJavaScript('window.ember.projectSessionsState().then(() => ({ allowed: true, message: "" }), error => ({ allowed: false, message: error.message }))') as { allowed: boolean; message: string };
      } finally { window.destroy(); }
    });
    expect(foreign).toEqual({ allowed: false, message: expect.stringContaining("untrusted IPC sender") });

    const run = async (index: number) => {
      await home!.locator("#project-sessions-request").fill(scenarios[index].request);
      await home!.locator("#project-sessions-send").click();
      await expect.poll(() => home!.evaluate(({ id, index }) => window.ember.projectSessionsState().then(state => state.projects.find(project => project.id === id)?.sessions[index]?.status),
        { id: projectId, index }), { timeout: 45_000 }).toBe("done");
      await expect.poll(() => home!.getByRole("button", { name: /^Review result:/ }).count(), { timeout: 15_000 }).toBe(index + 1);
      await expect.poll(() => home!.evaluate(() => window.ember.conversationTurn()), { timeout: 15_000 }).toBe("idle");
      const sessions = (await home!.evaluate(() => window.ember.projectSessionsState())).projects.find(project => project.id === projectId)!.sessions;
      expect(sessions[index].summary).toContain("No commands or tests were run.");
      expect(await home!.evaluate(() => window.ember.getStatus().then(status => status.settings.commands.local?.on))).toBe(false);
      expect(app!.windows().some(page => page.url().includes("/renderer/command/index.html"))).toBe(false);
      expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(original);
      return home!.evaluate(id => window.ember.codingResultsState(id), projectId);
    };
    const firstResults = await run(0); expect(firstResults).toHaveLength(1); const first = firstResults[0];
    expect(first).toMatchObject({ projectId, status: "done", files: 1, conflicts: 0, patchComplete: true, checks: { ran: 0, passed: 0, failed: 0 } });
    const both = await run(1); expect(both).toHaveLength(2); const second = both.find(result => result.id !== first.id)!;
    expect(second).toMatchObject({ projectId, status: "done", files: 1, conflicts: 0, patchComplete: true, checks: { ran: 0, passed: 0, failed: 0 } });
    expect(second.taskId).not.toBe(first.taskId); expect([first.message, second.message].some(message => message.includes("retained"))).toBe(false);
    expect(actions).toBe(6); expect([...steps.values()]).toEqual([3, 3]); expect([...dispatched]).toEqual(scenarios.map(scenario => scenario.request));
    const controllers = model.requests.filter((entry: { tools: string[] }) => entry.tools.includes("finish_coding"));
    const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding", "ask_coding_question"];
    expect(controllers.length).toBeGreaterThanOrEqual(6);
    expect(controllers.every((entry: { tools: string[] }) => entry.tools.length === allowed.length && entry.tools.every(name => allowed.includes(name)))).toBe(true);
    expect(JSON.stringify(model.requests)).not.toContain(outside); expect(JSON.stringify(model.requests)).not.toContain(credential);
    const requestsBeforeReview = model.requests.length;
    await home.locator(`[data-result-control="${first.id}"]`).click();
    await expect.poll(() => home!.locator("#project-coding-patch").textContent()).toContain("+export const answer = 42;");
    expect(await home.locator("#project-coding-continue").isDisabled()).toBe(true);
    await home.locator("#project-coding-export").click();
    await expect.poll(() => home!.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Exported the coding review");
    expect(model.requests.length).toBe(requestsBeforeReview);
    const exports = fs.readdirSync(exported); expect(exports).toHaveLength(1);
    const destination = path.join(exported, exports[0]), json = fs.readFileSync(path.join(destination, "review.json"), "utf8");
    const review = JSON.parse(json);
    expect(review).toMatchObject({ purpose: "review-only", patchComplete: true });
    for (const tree of [review.baseline, review.current]) expect(tree).toContainEqual(expect.objectContaining({ path: "app.ts", base64: Buffer.from(original).toString("base64") }));
    expect(review.proposed).toContainEqual(expect.objectContaining({ path: "app.ts", base64: Buffer.from(original.replace("41", "42")).toString("base64") }));
    expect(review.proposed).toContainEqual(expect.objectContaining({ path: "README.txt", base64: Buffer.from("Unchanged Windows project fixture.\n").toString("base64") }));
    expect([...review.baseline, ...review.proposed, ...review.current].some((entry: { path: string }) => entry.path === ".git" || entry.path.startsWith(".git/") || entry.path === "node_modules" || entry.path.startsWith("node_modules/"))).toBe(false);
    for (const canary of ["EXCLUDED_GIT_DATA_MUST_NOT_BE_ARCHIVED", "EXCLUDED_DEPENDENCY_DATA_MUST_NOT_BE_ARCHIVED", outside, credential]) {
      expect(json).not.toContain(canary); expect(json).not.toContain(Buffer.from(canary).toString("base64"));
    }
    expect(fs.readFileSync(path.join(destination, "changes.patch"), "utf8")).toContain("+export const answer = 42;");
    const history = await home.evaluate(() => window.ember.projectSessionsState());
    await home.locator(`[data-forget-result="${first.id}"]`).click();
    await expect.poll(() => home!.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Private coding review forgotten");
    expect(await home.evaluate(id => window.ember.codingResultsState(id), projectId)).toEqual([second]);
    await expect(home.evaluate(id => window.ember.codingResultReview(id), first.id)).rejects.toThrow("no longer available");
    expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual(history);
    await home.locator(`[data-result-control="${second.id}"]`).click();
    await expect.poll(() => home!.locator("#project-coding-patch").textContent()).toContain("+export const answer = 43;");
    expect(await home.locator("#project-coding-patch").textContent()).not.toContain("answer = 42");
    expect((await home.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId)).folder?.path).toBe(source);
    expect(model.requests.length).toBe(requestsBeforeReview);

    // The real Home preload/main erasure barrier owns global Forget; no model, SDK callback or test hook erases state.
    await home.evaluate(() => window.ember.forgetAllMemory());
    expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null });
    await expect.poll(() => home!.locator("#project-sessions-list h4").count()).toBe(0);
    expect(await home.evaluate(id => window.ember.codingResultsState(id), projectId)).toEqual([]);
    await expect(home.evaluate(id => window.ember.codingResultReview(id), second.id)).rejects.toThrow("no longer available");
    expect(await home.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId)).toMatchObject({ folder: null, available: false, canChoose: false });
    await expect.poll(() => home!.locator("#project-coding-choose").isDisabled()).toBe(true);
    expect(fs.readdirSync(path.join(userData, "coding-controllers"))).toEqual([]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(destination, "review.json"))).toBe(true);
    expect(fs.readFileSync(path.join(destination, "changes.patch"), "utf8")).toContain("+export const answer = 42;");
    expect(await home.evaluate(() => window.ember.getStatus().then(status => status.settings.commands.local?.on))).toBe(false);
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __windowsCodingPickerCalls: string[] }).__windowsCodingPickerCalls)).toEqual(["Choose a coding folder", "Export coding review"]);
  } finally {
    const forced = app ? await closeTestElectron(app) : false;
    await model.close();
    const clean = !!mainProcess && !forced && mainProcess.exitCode === 0 && mainProcess.signalCode === null;
    if (clean) fs.rmSync(root, { recursive: true, force: true });
    else console.error("Windows Electron coding cleanup was not verified; synthetic private scratch was retained outside Vitest cleanup.");
    expect(forced, "The Windows app must finish normal shutdown; unverified private scratch remains quarantined").toBe(false);
    if (app) { expect(mainProcess).toBeDefined(); expect(mainProcess!.exitCode).toBe(0); expect(mainProcess!.signalCode).toBeNull(); }
  }
}, 180_000);
