/**
 * Actual built Electron Home/preload/IPC -> Host/conductor -> private controller -> command approval -> isolated copy
 * -> result review/export/Forget. Only the native source/export folder pickers and offline model are fixtures.
 * No production hook, fake preload, real account, desktop action, original-source write or Windows proof is used.
 * Run after npm run build, under dbus-run-session and Xvfb, with EMBER_ELECTRON_CODING_TEST=1.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import type { CommandsApi } from "../../app/renderer/command/model";
import { codingTestIsolationSupported, trustedCodingTestNode } from "../fixtures/coding/trusted-node";
import { closeTestElectron } from "./close-electron";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

const request = "In this project's chosen folder, run node --test test.cjs, fix its assertion in the private copy, rerun that exact check, and prepare a review. Leave the original unchanged.";
const continuationRequest = "In a new private session from this reviewed result, first run node --test test.cjs to verify the previous fix, rename the sum test to continued sum, rerun that exact check, and prepare a cumulative review. Leave the original unchanged.";
const firstGoal = "Repair the copied assertion and verify node --test test.cjs";
const continuationGoal = "Verify the reviewed assertion, rename its test to continued sum and verify it again";
const original = "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(1 + 1, 3));\n";

it.skipIf(process.env.EMBER_ELECTRON_CODING_TEST !== "1" || process.platform !== "linux")(
  "repairs a private project through real Electron IPC, opens its named session review and preserves exports on Forget",
  async () => {
    expect(process.arch, "This native coding journey requires Linux x64").toBe("x64");
    const node = await trustedCodingTestNode();
    if (!node) throw new Error("The explicitly enabled native coding journey requires a verified Node asset.");
    expect(codingTestIsolationSupported(), "The explicitly enabled native coding journey requires working Bubblewrap namespaces").toBe(true);
    expect(process.env.DISPLAY, "A real X display (for example Xvfb) is required").toBeTruthy();
    const appRoot = process.cwd(), requireCjs = createRequire(import.meta.url);
    expect(fs.existsSync(path.join(appRoot, "dist/app/main.cjs")), "Build the app before this native journey").toBe(true);
    const runtime = runtimeFor("linux", "x64");
    expect(locateRuntime({ appPath: appRoot, runtimeId: runtime.id, exe: runtime.exe }).exists, "The pinned controller runtime is required").toBe(true);

    // Vitest clears its ember-run-* TMPDIR even after a failure. Keep this app's private roots outside that cleanup so
    // an unverified launch/termination cannot have its source-holding files silently removed by the global fixture.
    const runTemporary = fs.realpathSync(os.tmpdir());
    const temporaryBase = path.basename(runTemporary).startsWith("ember-run-") ? path.dirname(runTemporary) : runTemporary;
    const root = fs.mkdtempSync(path.join(temporaryBase, "ember-coding-electron-"));
    const userData = path.join(root, "profile"), source = path.join(root, "source"), exported = path.join(root, "exported"), temporary = path.join(root, "temporary");
    for (const directory of [userData, source, exported, temporary]) fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(source, "test.cjs"), original);
    fs.writeFileSync(path.join(source, "README.txt"), "Unchanged project fixture.\n");
    fs.writeFileSync(path.join(root, "outside.txt"), "OUTSIDE_PROJECT_FIXTURE_MUST_STAY_LOCAL\n");
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
      version: 1, onboarded: true, wakeWord: false, speak: false, speakWithScreenReader: false, speakResults: false,
      consent: { version: CONSENT_VERSION, at },
      commands: { local: { on: true, askEvery: true, consent: { version: FEATURE_CONSENT_VERSION.commands, at } } },
    }));
    const dispatched = new Set<string>(), controllerSteps = new Map<string, number>(); let codingActions = 0;
    const model = await startMockLlm({ delayMs: 0, respond: (messages: { role: string; content: unknown }[], tools: string[]) => {
      if (tools.includes("start_coding")) {
        const next = [request, continuationRequest].find(words => !dispatched.has(words) && messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(words)));
        if (next) {
          dispatched.add(next);
          return { tool: { name: "start_coding", args: { goal: next === request ? firstGoal : continuationGoal } } };
        }
        return { text: "The coding session has its own project card and Stop." };
      }
      if (tools.includes("finish_coding")) {
        const continued = messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(continuationGoal));
        const goal = continued ? continuationGoal : firstGoal, previous = controllerSteps.get(goal) ?? 0;
        // Each fresh controller may request a final text response after finish; that tail must consume no next-session tool.
        if (previous >= 4) return { text: "The private coding session finished and its review is ready." };
        controllerSteps.set(goal, previous + 1); codingActions++;
        const step = previous + 1 + (continued ? 4 : 0);
        if (step === 1 || step === 3) return { tool: { name: "run_node", args: { argv: ["--test", "test.cjs"], why: "Verify the copied assertion" } } };
        if (step === 2) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "1 + 1, 3", newText: "1 + 1, 2" } } };
        if (step === 4) return { tool: { name: "finish_coding", args: { success: true, summary: "Fixed the copied assertion and reran the exact check successfully. Review the patch before applying it." } } };
        if (step === 5 || step === 7) return { tool: { name: "run_command", args: { target: "This computer", command: "node --test test.cjs", why: "Verify the reviewed assertion in the new private session" } } };
        if (step === 6) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "test('sum'", newText: "test('continued sum'" } } };
        if (step === 8) return { tool: { name: "finish_coding", args: { success: true, summary: "Verified the prior fix in a fresh session, renamed its test and reran the exact check successfully. Review the cumulative patch." } } };
      }
      return { text: "Ready for review." };
    } });
    let app: ElectronApplication | undefined;
    let mainProcess: ChildProcess | undefined;
    let home: Page | undefined;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: model.baseUrl, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        PATH: [path.dirname(node.nodePath), process.env.PATH].filter(Boolean).join(path.delimiter) };
      for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "ELECTRON_RUN_AS_NODE", "ELECTRON_DISABLE_SANDBOX", "EMBER_SMOKE_NO_SANDBOX"]) delete env[key];
      const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      app = await _electron.launch({ executablePath: requireCjs("electron") as string,
        args: [appRoot, "--show-settings"], env: childEnv, timeout: 45_000 });
      mainProcess = app.process();
      // The OS chooser is the only Electron API replaced. Production folder validation and IPC still own all paths.
      await app.evaluate(({ dialog }, folders) => {
        const calls: string[] = [];
        (globalThis as typeof globalThis & { __codingPickerCalls: string[] }).__codingPickerCalls = calls;
        dialog.showOpenDialog = async (...args: unknown[]) => {
          const title = (args.at(-1) as { title?: string })?.title ?? "";
          calls.push(title);
          if (title === "Choose a coding folder") return { canceled: false, filePaths: [folders.source] };
          if (title === "Export coding review") return { canceled: false, filePaths: [folders.exported] };
          throw new Error("This fixture permits only the coding source and export folder pickers.");
        };
      }, { source, exported });
      await expect.poll(() => app!.windows().some(page => page.url().includes("/renderer/home/index.html")), { timeout: 30_000 }).toBe(true);
      home = app.windows().find(page => page.url().includes("/renderer/home/index.html"))!;
      await expect.poll(() => home!.evaluate(() => window.ember.agentStatus().then(state => state?.phase)), { timeout: 40_000 }).toBe("ready");
      await home.locator('a[href="#project-h"]').click();
      expect(await home.locator("#coding-workspace").isHidden()).toBe(true);
      expect(await home.locator("#project-coding-folder").textContent()).toContain("Create or select a project above");
      await home.locator("#project-sessions-name").fill("Native copied repair");
      await home.locator("#project-sessions-add").click();
      await expect.poll(() => home!.locator("#project-coding-choose").isEnabled()).toBe(true);
      await home.locator("#project-coding-choose").click();
      await expect.poll(() => home!.locator("#project-coding-folder").textContent()).toContain(source);
      expect(await home.evaluate(() => window.ember.projectSessionsState().then(state => state.projects[0].sessions))).toEqual([]);
      expect(model.requests.length).toBe(0); // Creating/binding metadata does not send source or ask the model.
      await expect.poll(() => home!.evaluate(() => window.ember.projectSessionsState().then(state => state.selectedProjectId))).not.toBeNull();
      const projectId = (await home.evaluate(() => window.ember.projectSessionsState())).selectedProjectId!;
      await expect.poll(async () => {
        const state = await home!.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId);
        return { available: state.available, message: state.available ? "ready" : state.message };
      }, { timeout: 30_000, message: "Wait for the production toolchain and coding storage checks before sending work" }).toEqual({ available: true, message: "ready" });

      // A different webContents with the genuine preload does not inherit Home's IPC authority.
      const foreign = await app.evaluate(async ({ BrowserWindow, app: electronApp }) => {
        const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: electronApp.getAppPath() + "/dist/app/preload/home.cjs" } });
        try {
          await window.loadURL("about:blank");
          return await window.webContents.executeJavaScript('window.ember.projectSessionsState().then(() => ({ allowed: true, message: "" }), error => ({ allowed: false, message: error.message }))') as { allowed: boolean; message: string };
        } finally { window.destroy(); }
      });
      expect(foreign).toEqual({ allowed: false, message: expect.stringContaining("untrusted IPC sender") });

      await home.locator("#project-sessions-request").fill(request);
      await home.locator("#project-sessions-send").click();
      // Click the real native command panel twice, only for this exact command after its display/hash arm enables it.
      let lastApproval = 0;
      for (let approval = 0; approval < 2; approval++) {
        await expect.poll(() => app!.windows().some(page => page.url().includes("/renderer/command/index.html")), { timeout: 45_000 }).toBe(true);
        const command = app.windows().find(page => page.url().includes("/renderer/command/index.html"))!;
        await expect.poll(() => command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot?.state.card?.n ?? 0)), { timeout: 45_000 }).toBeGreaterThan(lastApproval);
        lastApproval = await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot!.state.card!.n));
        await expect.poll(() => command.locator("#ask-cmd").textContent().catch(() => ""), { timeout: 45_000 }).toBe('Node arguments: ["--test","test.cjs"]');
        expect(await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => ({ kind: snapshot!.state.card!.kind, shell: snapshot!.state.card!.shell, argv: snapshot!.state.card!.argv })))).toEqual({ kind: "node", shell: undefined, argv: ["--test", "test.cjs"] });
        const allow = command.getByRole("button", { name: "Allow", exact: true });
        await expect.poll(() => allow.isEnabled(), { timeout: 15_000 }).toBe(true);
        await allow.click();
      }
      await expect.poll(() => home!.evaluate(id => window.ember.projectSessionsState().then(state => state.projects.find(project => project.id === id)?.sessions[0]?.status), projectId), { timeout: 45_000 }).toBe("done");
      await expect.poll(() => home!.getByRole("button", { name: /^Review result:/ }).count(), { timeout: 15_000 }).toBe(1);
      const results = await home.evaluate(id => window.ember.codingResultsState(id), projectId);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ projectId, status: "done", files: 1, patchComplete: true, checks: { ran: 2, passed: 1, failed: 1 } });
      expect(results[0].message).not.toContain("retained");
      expect(JSON.stringify(model.requests)).toContain("ERR_ASSERTION");
      expect(JSON.stringify(model.requests)).not.toContain("OUTSIDE_PROJECT_FIXTURE_MUST_STAY_LOCAL");
      expect(fs.readFileSync(path.join(source, "test.cjs"), "utf8")).toBe(original);
      await expect.poll(() => home!.evaluate(() => window.ember.conversationTurn()), { timeout: 15_000 }).toBe("idle");
      const requestsBeforeReview = model.requests.length;
      const firstSession = (await home.evaluate(() => window.ember.projectSessionsState())).projects.find(project => project.id === projectId)!.sessions.find(session => session.taskId === results[0].taskId)!;
      expect(firstSession.kind).toBe("coding");
      const sessionReview = home.locator(`[data-session-review="${firstSession.id}"]`);
      await expect.poll(() => sessionReview.isEnabled()).toBe(true);
      await sessionReview.click();
      await expect.poll(() => home!.locator("#project-coding-patch").textContent()).toContain("1 + 1, 2");
      expect(await home.evaluate(() => {
        const title = document.getElementById("project-coding-review-title")!, bounds = title.getBoundingClientRect();
        return {
          title: document.activeElement === title,
          inViewport: bounds.top >= 0 && bounds.bottom <= window.innerHeight,
          session: document.activeElement instanceof HTMLElement && !!document.activeElement.dataset.sessionReview,
          body: document.activeElement === document.body,
          window: document.hasFocus(),
        };
      })).toMatchObject({ title: true, inViewport: true });
      await home.locator("#project-coding-close").click();
      await expect.poll(() => sessionReview.evaluate(button => document.activeElement === button)).toBe(true);
      await sessionReview.click();
      await expect.poll(() => home!.locator("#project-coding-patch").textContent()).toContain("1 + 1, 2");
      await home.locator("#project-coding-export").click();
      await expect.poll(() => home!.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Exported the coding review");
      expect(model.requests.length).toBe(requestsBeforeReview);
      const directories = fs.readdirSync(exported); expect(directories).toHaveLength(1);
      const destination = path.join(exported, directories[0]);
      expect(fs.readFileSync(path.join(destination, "changes.patch"), "utf8")).toContain("1 + 1, 2");
      const review = JSON.parse(fs.readFileSync(path.join(destination, "review.json"), "utf8"));
      expect(review.proposed).toContainEqual(expect.objectContaining({ path: "README.txt", base64: Buffer.from("Unchanged project fixture.\n").toString("base64") }));

      // Continue explicitly through the genuine Home form and preload. Its first check must already pass because
      // the new controller starts from the reviewed private fix, while the source still contains the failing 3.
      await home.locator("#project-coding-continue").click();
      expect(await home.locator("#project-coding-continue-form").isVisible()).toBe(true);
      expect(model.requests.length).toBe(requestsBeforeReview);
      await home.locator("#project-coding-continue-request").fill(continuationRequest);
      await expect.poll(() => home!.locator("#project-coding-continue-send").isEnabled()).toBe(true);
      await home.locator("#project-coding-continue-send").click();
      for (let approval = 0; approval < 2; approval++) {
        await expect.poll(() => app!.windows().some(page => page.url().includes("/renderer/command/index.html")), { timeout: 45_000 }).toBe(true);
        const command = app.windows().find(page => page.url().includes("/renderer/command/index.html"))!;
        await expect.poll(() => command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot?.state.card?.n ?? 0)), { timeout: 45_000 }).toBeGreaterThan(lastApproval);
        lastApproval = await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot!.state.card!.n));
        await expect.poll(() => command.locator("#ask-cmd").textContent().catch(() => ""), { timeout: 45_000 }).toBe("node --test test.cjs");
        const allow = command.getByRole("button", { name: "Allow", exact: true });
        await expect.poll(() => allow.isEnabled(), { timeout: 15_000 }).toBe(true);
        await allow.click();
      }
      await expect.poll(() => home!.evaluate(id => window.ember.projectSessionsState().then(state => state.projects.find(project => project.id === id)?.sessions[1]?.status), projectId), { timeout: 45_000 }).toBe("done");
      await expect.poll(() => home!.getByRole("button", { name: /^Review result:/ }).count(), { timeout: 15_000 }).toBe(2);
      const continuedResults = await home.evaluate(id => window.ember.codingResultsState(id), projectId);
      expect(continuedResults).toHaveLength(2);
      const continued = continuedResults.find(result => result.id !== results[0].id)!;
      expect(continued).toMatchObject({ projectId, status: "done", files: 1, conflicts: 0, patchComplete: true, checks: { ran: 2, passed: 2, failed: 0 } });
      expect(continued.taskId).not.toBe(results[0].taskId); expect(continued.message).not.toContain("retained");
      expect(codingActions).toBe(8); expect([...controllerSteps.values()]).toEqual([4, 4]); expect([...dispatched]).toEqual([request, continuationRequest]);
      expect(fs.readFileSync(path.join(source, "test.cjs"), "utf8")).toBe(original);
      await expect.poll(() => home!.evaluate(() => window.ember.conversationTurn()), { timeout: 15_000 }).toBe("idle");
      await home.locator(`[data-result-control="${continued.id}"]`).click();
      await expect.poll(() => home!.locator("#project-coding-patch").textContent()).toContain("test('continued sum'");
      const continuedReview = await home.evaluate(id => window.ember.codingResultReview(id), continued.id);
      expect(continuedReview.textPatch).toContain(`-${original.trim()}`);
      expect(continuedReview.textPatch).toContain(`+${original.replace("test('sum'", "test('continued sum'").replace("1 + 1, 3", "1 + 1, 2").trim()}`);
      const continuedHistory = await home.evaluate(() => window.ember.projectSessionsState());
      expect(continuedHistory.projects.find(project => project.id === projectId)?.sessions.map(session => session.status)).toEqual(["done", "done"]);
      await home.locator(`[data-forget-result="${continued.id}"]`).click();
      await expect.poll(() => home!.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Private coding review forgotten");
      expect(await home.evaluate(id => window.ember.codingResultsState(id), projectId)).toEqual(results);
      await expect(home.evaluate(id => window.ember.codingResultReview(id), continued.id)).rejects.toThrow("no longer available");
      expect((await home.evaluate(id => window.ember.codingResultReview(id), results[0].id)).id).toBe(results[0].id);
      expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual(continuedHistory);
      await expect.poll(() => home!.locator("[data-session-review]").count()).toBe(1);
      expect(await sessionReview.isEnabled()).toBe(true);
      await home.locator(`[data-result-control="${results[0].id}"]`).click();
      await expect.poll(() => home!.locator("#project-coding-patch").textContent()).toContain("1 + 1, 2");
      expect(await home.locator("#project-coding-patch").textContent()).not.toContain("continued sum");
      const history = await home.evaluate(() => window.ember.projectSessionsState());
      await home.getByRole("button", { name: /^Forget private result:/ }).click();
      await expect.poll(() => home!.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Private coding review forgotten");
      expect(await home.evaluate(id => window.ember.codingResultsState(id), projectId)).toEqual([]);
      await expect(home.evaluate(id => window.ember.codingResultReview(id), results[0].id)).rejects.toThrow("no longer available");
      expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual(history);
      expect(await home.locator("#project-coding-review").isHidden()).toBe(true);
      await expect.poll(() => home!.locator("[data-session-review]").count()).toBe(0);
      expect(fs.readFileSync(path.join(source, "test.cjs"), "utf8")).toBe(original);
      expect(fs.existsSync(path.join(destination, "review.json"))).toBe(true);
      expect((await home.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId)).folder?.path).toBe(source);
      // Exercise the real Home preload/main erasure barrier. The native confirmation UI is outside this IPC proof.
      await home.evaluate(() => window.ember.forgetAllMemory());
      expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null });
      await expect.poll(() => home!.locator("#project-sessions-select").inputValue()).toBe("");
      await expect.poll(() => home!.locator("#project-sessions-list h4").count()).toBe(0);
      expect(await home.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId)).toMatchObject({ folder: null, available: false, canChoose: false });
      expect(await home.evaluate(id => window.ember.codingResultsState(id), projectId)).toEqual([]);
      await expect(home.evaluate(id => window.ember.codingResultReview(id), results[0].id)).rejects.toThrow("no longer available");
      await expect.poll(() => home!.locator("#project-coding-choose").isDisabled()).toBe(true);
      expect(fs.existsSync(path.join(destination, "review.json"))).toBe(true);
      expect(fs.readFileSync(path.join(destination, "changes.patch"), "utf8")).toContain("1 + 1, 2");
      expect(fs.readFileSync(path.join(source, "test.cjs"), "utf8")).toBe(original);
      expect(fs.readdirSync(path.join(userData, "coding-controllers"))).toEqual([]);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { __codingPickerCalls: string[] }).__codingPickerCalls)).toEqual(["Choose a coding folder", "Export coding review"]);
    } finally {
      const forced = app ? await closeTestElectron(app) : false;
      await model.close();
      const exitedCleanly = !!mainProcess && !forced && mainProcess.exitCode === 0 && mainProcess.signalCode === null;
      if (exitedCleanly) fs.rmSync(root, { recursive: true, force: true });
      else console.error(`Unverified native coding test cleanup; private fixture retained at ${root}`);
      expect(forced, `The app must complete normal shutdown; uncertain private work is retained at ${root}`).toBe(false);
      if (app) { expect(mainProcess).toBeDefined(); expect(mainProcess!.exitCode).toBe(0); expect(mainProcess!.signalCode).toBeNull(); }
    }
  }, 180_000,
);
