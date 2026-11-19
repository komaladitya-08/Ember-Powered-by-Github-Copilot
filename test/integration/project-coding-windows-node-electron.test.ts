/**
 * Required source-app Windows Node journey: real normal-sandbox Electron/main/preloads/Host/SDK/native resources.
 * Only the deterministic local provider and the two ordinary OS folder-picker answers are fixtures.
 * usage: npm run build; EMBER_ELECTRON_WINDOWS_NODE_TEST=1 node scripts/run-integration.mjs test/integration/project-coding-windows-node-electron.test.ts
 * Unknown cleanup retains synthetic private graphs outside Vitest's unconditional temporary-directory cleanup.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { modeCardVersion, type ApprovalMode } from "../../app/shared/approvals";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { nodeInvocationSha256 } from "../../app/main/commands/node-invocation";
import type { CommandsApi } from "../../app/renderer/command/model";
import type { CodingResultSummary } from "../../app/shared/project-coding";
import { closeTestElectron } from "./close-electron";
import {
  createWindowsNodeProductModel, windowsNodeSourceScenarios, WINDOWS_NODE_TEST_ARGV, WINDOWS_NODE_WRITER_ARGV,
  WINDOWS_NODE_PRODUCT_TOOLS, WINDOWS_NODE_SOURCE_ORIGINAL, WINDOWS_NODE_SOURCE_WRITER, WINDOWS_NODE_WRITER_READY,
  type WindowsNodeSourceCase,
} from "../fixtures/windows-node-product-model";
import { verifyWindowsNodeToolchain, WINDOWS_NODE_TOOLCHAIN } from "../../scripts/package/windows-node-toolchain.mjs";

const required = process.env.EMBER_ELECTRON_WINDOWS_NODE_TEST === "1";
const outside = "OUTSIDE_WINDOWS_NODE_PROJECT_MUST_STAY_LOCAL";
const credential = "gho_" + "Q".repeat(36);
const environmentCanary = "WINDOWS_NODE_HOST_ENVIRONMENT_MUST_STAY_LOCAL";
const readme = "Unchanged Windows Node source journey fixture.\n";
const cases: Readonly<Record<WindowsNodeSourceCase, number>> = Object.freeze({ repair: 1, denied: 2, stop: 3, source: 4, mode: 5, forget: 6, account: 7 });
type Model = Awaited<ReturnType<typeof createWindowsNodeProductModel>>;
let quarantined = false;

/** Fixed stages deliberately replace raw Playwright/assertion/native/filesystem diagnostics. */
function refusal(kind: WindowsNodeSourceCase, phase: number): Error {
  const error = new Error("Windows Node source journey refused (case " + cases[kind] + ", phase " + phase + ").");
  error.stack = "Error: " + error.message;
  return error;
}
function ordinaryFile(file: string): boolean {
  const info = fs.lstatSync(file);
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}
function preflight(): { appRoot: string; executable: string } {
  expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
  const appRoot = fs.realpathSync.native(process.cwd()), requireCjs = createRequire(import.meta.url);
  expect(ordinaryFile(path.join(appRoot, "dist/app/main.cjs"))).toBe(true);
  const runtime = runtimeFor("win32", "x64");
  expect(locateRuntime({ appPath: appRoot, runtimeId: runtime.id, exe: runtime.exe }).exists).toBe(true);
  const electronPackage = requireCjs.resolve("electron/package.json");
  expect(path.resolve(electronPackage).toLowerCase()).toBe(path.join(appRoot, "node_modules/electron/package.json").toLowerCase());
  expect(fs.readFileSync(path.join(path.dirname(electronPackage), "path.txt"), "utf8")).toBe("electron.exe");
  const installed = JSON.parse(fs.readFileSync(electronPackage, "utf8")), owner = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  expect(installed.version).toBe(owner.devDependencies.electron);
  const executable = path.join(path.dirname(electronPackage), "dist/electron.exe"); expect(ordinaryFile(executable)).toBe(true);
  // The earlier three-patch producer cannot certify the new supported POSIX product milestone.
  expect(WINDOWS_NODE_TOOLCHAIN.producerRun).not.toBe(43858256344);
  expect(verifyWindowsNodeToolchain(path.join(path.dirname(executable), "resources/coding/windows-node-x64")).files).toBe(3);
  if (process.env.GITHUB_ACTIONS === "true") {
    expect(["windows-2022", "windows-2025"]).toContain(process.env.EMBER_WINDOWS_NODE_PRODUCT_IMAGE);
    expect(process.env.GITHUB_SHA).toMatch(/^[0-9a-f]{40}$/);
  }
  return { appRoot, executable };
}

class Journey {
  phase = 1;
  app?: ElectronApplication;
  process?: ChildProcess;
  home?: Page;
  projectId = "";
  lastApproval = 0;
  readonly approved: { n: number; sha256: string; argv: string[] }[] = [];
  erased = false;
  readonly source: string;
  readonly userData: string;
  readonly exported: string;
  readonly temporary: string;
  constructor(readonly kind: WindowsNodeSourceCase, readonly root: string, readonly model: Model) {
    this.source = path.join(root, "source"); this.userData = path.join(root, "profile");
    this.exported = path.join(root, "exported"); this.temporary = path.join(root, "temporary");
    for (const directory of [this.source, this.userData, this.exported, this.temporary, path.join(this.source, ".git"), path.join(this.source, "node_modules")]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(this.source, "test.cjs"), WINDOWS_NODE_SOURCE_ORIGINAL);
    fs.writeFileSync(path.join(this.source, "writer.cjs"), WINDOWS_NODE_SOURCE_WRITER);
    fs.writeFileSync(path.join(this.source, "README.txt"), readme);
    fs.writeFileSync(path.join(this.source, ".git/HEAD"), "EXCLUDED_WINDOWS_NODE_GIT_DATA");
    fs.writeFileSync(path.join(this.source, "node_modules/fixture.js"), "EXCLUDED_WINDOWS_NODE_DEPENDENCY_DATA");
    fs.writeFileSync(path.join(root, "outside.txt"), outside);
    fs.writeFileSync(path.join(this.userData, "credential-canary.txt"), credential);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(this.userData, "settings.json"), JSON.stringify({
      version: 1, onboarded: true, wakeWord: false, speak: false, speakWithScreenReader: false, speakResults: false,
      consent: { version: CONSENT_VERSION, at },
      commands: { local: { on: true, askEvery: true, consent: { version: FEATURE_CONSENT_VERSION.commands, at } } },
    }));
  }
  async start(input: ReturnType<typeof preflight>): Promise<void> {
    this.phase = 2;
    const env: NodeJS.ProcessEnv = { ...process.env, EMBER_USER_DATA: this.userData, EMBER_TEST_PROVIDER_URL: this.model.baseUrl,
      TMPDIR: this.temporary, TMP: this.temporary, TEMP: this.temporary, EMBER_NODE_SOURCE_CANARY: environmentCanary };
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN", "COPILOT_TOKEN", "COPILOT_SDK_AUTH_TOKEN",
      "ELECTRON_RUN_AS_NODE", "ELECTRON_DISABLE_SANDBOX", "EMBER_SMOKE_NO_SANDBOX", "ELECTRON_OVERRIDE_DIST_PATH", "NODE_OPTIONS", "EMBER_LOG_STDOUT"]) delete env[key];
    const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    this.app = await _electron.launch({ executablePath: input.executable, args: [input.appRoot, "--show-settings"], env: childEnv, timeout: 45_000 });
    this.process = this.app.process();
    expect(this.process.spawnargs.some(argument => argument === "--no-sandbox" || argument === "--disable-sandbox")).toBe(false);
    // Answer only the OS pickers. No preload, native issuer, controller, policy or callback is replaced.
    await this.app.evaluate(({ dialog }, folders) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string })?.title ?? "";
        if (title === "Choose a coding folder") return { canceled: false, filePaths: [folders.source] };
        if (title === "Export coding review") return { canceled: false, filePaths: [folders.exported] };
        throw new Error("The fixed source journey permits only its source and export pickers.");
      };
    }, { source: this.source, exported: this.exported });
    await expect.poll(() => this.app!.windows().some(page => page.url().includes("/renderer/home/index.html")), { timeout: 30_000 }).toBe(true);
    this.home = this.app.windows().find(page => page.url().includes("/renderer/home/index.html"))!;
    await expect.poll(() => this.home!.evaluate(() => window.ember.agentStatus().then(status => status?.phase)), { timeout: 40_000 }).toBe("ready");
    expect(await this.home.evaluate(() => ({ process: typeof process, require: typeof require }))).toEqual({ process: "undefined", require: "undefined" });
    expect(await this.home.evaluate(() => window.ember.getStatus().then(status => status.settings.commands.local?.on))).toBe(true);
    await expect.poll(() => this.app!.evaluate(({ BrowserWindow, app }) => {
      const homes = BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes("/renderer/home/index.html"));
      const metrics = app.getAppMetrics();
      return homes.length > 0 && homes.every(window => metrics.find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true);
    }), { timeout: 15_000 }).toBe(true);
    await this.home.locator('a[href="#project-h"]').click();
    await this.home.locator("#project-sessions-name").fill("Actual Windows Node " + this.kind);
    await this.home.locator("#project-sessions-add").click();
    await expect.poll(() => this.home!.locator("#project-coding-choose").isEnabled()).toBe(true);
    await this.home.locator("#project-coding-choose").click();
    await expect.poll(() => this.home!.locator("#project-coding-folder").textContent()).toContain(this.source);
    this.projectId = (await this.home.evaluate(() => window.ember.projectSessionsState())).selectedProjectId!;
    expect(this.projectId).toBeTruthy(); expect(this.model.requests).toHaveLength(0);
    await expect.poll(() => this.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id).then(state => state.available), this.projectId), { timeout: 30_000 }).toBe(true);
    expect((await this.home.evaluate(id => window.ember.projectCodingWorkspaceState(id), this.projectId)).message).toContain("Shells, npm, dependency installation, network access and child processes are unavailable");
    const foreign = await this.app.evaluate(async ({ BrowserWindow, app }) => {
      const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: app.getAppPath() + "/dist/app/preload/home.cjs" } });
      try {
        await page.loadURL("about:blank");
        return await page.webContents.executeJavaScript('window.ember.projectSessionsState().then(()=>0,error=>String(error.message).includes("untrusted IPC sender")?1:2)') as number;
      } finally { page.destroy(); }
    });
    expect(foreign).toBe(1);
  }
  async send(words: string): Promise<void> {
    this.phase = 3;
    await this.home!.locator("#project-sessions-request").fill(words); await this.home!.locator("#project-sessions-send").click();
  }
  async command(): Promise<Page> {
    await expect.poll(() => this.app!.windows().some(page => page.url().includes("/renderer/command/index.html")), { timeout: 45_000 }).toBe(true);
    return this.app!.windows().find(page => page.url().includes("/renderer/command/index.html"))!;
  }
  async decide(argv: readonly string[], answer: "Allow" | "Not now" = "Allow"): Promise<Page> {
    this.phase = 4;
    const command = await this.command();
    await expect.poll(() => command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot?.state.card?.n ?? 0)),
      { timeout: 45_000 }).toBeGreaterThan(this.lastApproval);
    const card = await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot!.state.card!));
    this.lastApproval = card.n;
    expect({ kind: card.kind, shell: card.shell, argv: card.argv, cwd: card.cwd }).toEqual({ kind: "node", shell: undefined, argv: [...argv], cwd: "\\work" });
    expect(card.sha256).toBe(nodeInvocationSha256("local", "\\work", argv));
    await expect.poll(() => command.locator("#ask-cmd").textContent(), { timeout: 15_000 }).toBe("Node arguments: " + JSON.stringify(argv));
    const button = command.getByRole("button", { name: answer, exact: true });
    await expect.poll(() => button.isEnabled(), { timeout: 15_000 }).toBe(true);
    if (answer === "Allow") this.approved.push({ n: card.n, sha256: card.sha256, argv: [...argv] });
    await button.click(); return command;
  }
  async writerReady(): Promise<void> {
    this.phase = 5;
    const command = await this.command();
    await expect.poll(() => command.evaluate(marker => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => {
      if (!snapshot?.state.tabs.some(tab => !tab.ended)) return false;
      return new TextDecoder().decode(Uint8Array.from(snapshot.replay.flatMap(message => Array.from(message.bytes)))).includes(marker);
    }), WINDOWS_NODE_WRITER_READY), { timeout: 30_000 }).toBe(true);
  }
  async sessions() {
    return (await this.home!.evaluate(() => window.ember.projectSessionsState())).projects.find(project => project.id === this.projectId)?.sessions ?? [];
  }
  async terminal(index: number, status?: "done" | "failed" | "stopped"): Promise<void> {
    this.phase = 6;
    await expect.poll(async () => {
      const item = (await this.sessions())[index];
      return status ? item?.status === status : !!item && ["done", "failed", "stopped"].includes(item.status);
    }, { timeout: 45_000 }).toBe(true);
    if (this.kind === "denied") this.phase = 17;
    await expect.poll(() => this.home!.evaluate(() => window.ember.conversationTurn()), { timeout: 20_000 }).toBe("idle");
  }
  async results(): Promise<CodingResultSummary[]> { return this.home!.evaluate(id => window.ember.codingResultsState(id), this.projectId); }
  assertUnchanged(): void {
    expect(fs.readFileSync(path.join(this.source, "test.cjs"), "utf8")).toBe(WINDOWS_NODE_SOURCE_ORIGINAL);
    expect(fs.readFileSync(path.join(this.source, "writer.cjs"), "utf8")).toBe(WINDOWS_NODE_SOURCE_WRITER);
    expect(fs.readFileSync(path.join(this.root, "outside.txt"), "utf8")).toBe(outside);
    expect(fs.readFileSync(path.join(this.userData, "credential-canary.txt"), "utf8")).toBe(credential);
    expect(fs.existsSync(path.join(this.source, "heartbeat.txt"))).toBe(false);
    const sent = JSON.stringify(this.model.requests);
    for (const marker of [outside, credential, environmentCanary, "EXCLUDED_WINDOWS_NODE_GIT_DATA", "EXCLUDED_WINDOWS_NODE_DEPENDENCY_DATA"]) expect(sent).not.toContain(marker);
    expect(this.model.failures).toEqual([]);
    expect(sent).toContain("Only bundled Node is supplied");
    for (const inventory of this.model.inventories) expect([...inventory].sort()).toEqual([...WINDOWS_NODE_PRODUCT_TOOLS].sort());
  }
  assertPrivateRolesEmpty(): void {
    const controllers = path.join(this.userData, "coding-controllers");
    if (fs.existsSync(controllers)) expect(fs.readdirSync(controllers)).toEqual([]);
    const common = path.join(this.temporary, "ember-coding-unsupported");
    if (fs.existsSync(common)) for (const processRoot of fs.readdirSync(common)) {
      expect(processRoot).toMatch(/^process-[0-9a-f-]{36}$/);
      const roles = path.join(common, processRoot);
      for (const role of fs.readdirSync(roles)) {
        expect(["copies", "reviews", "assets"]).toContain(role); expect(fs.readdirSync(path.join(roles, role))).toEqual([]);
      }
    }
  }
  async erase(): Promise<void> {
    this.phase = 9;
    await this.home!.evaluate(() => window.ember.forgetAllMemory());
    expect(await this.home!.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null });
    expect(await this.results()).toEqual([]);
    await expect.poll(() => this.home!.locator("#project-sessions-list h4").count()).toBe(0);
    this.assertUnchanged(); this.assertPrivateRolesEmpty(); this.erased = true;
  }
}

async function journey(kind: WindowsNodeSourceCase, run: (fixture: Journey) => Promise<void>): Promise<void> {
  if (quarantined) throw refusal(kind, 1);
  let fixture: Journey | undefined, model: Model | undefined, root: string | undefined, failed = false, phase = 1;
  let owned: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = preflight(), temporary = fs.realpathSync.native(os.tmpdir());
    const parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-windows-node-source-")));
    model = await createWindowsNodeProductModel(windowsNodeSourceScenarios(kind)); fixture = new Journey(kind, root, model);
    const current = fixture;
    owned = (async () => { await current.start(input); await run(current); expect(current.erased).toBe(true); })();
    // Leave time inside the test's own deadline for graceful shutdown, transport rejection and owned-work drainage.
    await Promise.race([owned, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(refusal(kind, current.phase)), kind === "repair" ? 120_000 : kind === "denied" ? 60_000 : 80_000);
    })]);
  } catch { quarantined = true; failed = true; phase = fixture?.phase ?? phase; }
  finally {
    quarantined = true;
    clearTimeout(timer);
    let clean = false;
    try {
      const forced = fixture?.app ? await closeTestElectron(fixture.app) : false;
      clean = !!fixture?.process && !forced && fixture.process.exitCode === 0 && fixture.process.signalCode === null;
    } catch { failed = true; phase = 10; }
    // Closing the captured app revokes its outstanding UI/IPC work; do not leave a timed-out body racing the next case.
    try { await owned; } catch { failed = true; }
    try { await model?.close(); } catch { failed = true; phase = 10; }
    // A test failure does not turn normal main-process exit into proof of uncertain native graph cleanup.
    if (!failed && fixture?.erased && clean && root) {
      try { fs.rmSync(root, { recursive: true, force: false }); } catch { failed = true; phase = 10; }
    } else if (root) { failed = true; }
    if (!clean && fixture?.app) { failed = true; phase = 10; }
  }
  if (failed) { quarantined = true; throw refusal(kind, phase); }
  quarantined = false;
  console.info("Windows Node source journey passed", JSON.stringify({ schema: 1, case: cases[kind], phase: 10 }));
}

describe.skipIf(!required)("actual Windows Node source Home product", () => {
  it("repairs the identical approved check, reviews/exports and continues a fresh cumulative copy before Forget", async () => journey("repair", async f => {
    const scenarios = windowsNodeSourceScenarios("repair");
    await f.send(scenarios[0].request); await f.decide(WINDOWS_NODE_TEST_ARGV); await f.decide(WINDOWS_NODE_TEST_ARGV);
    await f.terminal(0, "done");
    const first = (await f.results())[0]; expect(first).toMatchObject({ status: "done", checks: { ran: 2, passed: 1, failed: 1 }, patchComplete: true });
    expect(first.message).not.toContain("retained"); expect(f.approved[0].sha256).toBe(f.approved[1].sha256); expect(f.approved[0].n).not.toBe(f.approved[1].n);
    expect(JSON.stringify(f.model.requests)).toContain("ERR_ASSERTION"); f.assertUnchanged();
    f.phase = 7;
    const beforeReview = f.model.requests.length;
    const session = (await f.sessions()).find(item => item.taskId === first.taskId)!;
    await f.home!.locator('[data-session-review="' + session.id + '"]').click();
    await expect.poll(() => f.home!.locator("#project-coding-patch").textContent()).toContain("1 + 1, 2");
    await f.home!.locator("#project-coding-export").click();
    await expect.poll(() => f.home!.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Exported the coding review");
    expect(f.model.requests.length).toBe(beforeReview);
    const directories = fs.readdirSync(f.exported); expect(directories).toHaveLength(1);
    const exported = path.join(f.exported, directories[0]), json = fs.readFileSync(path.join(exported, "review.json"), "utf8"), review = JSON.parse(json);
    expect(review.purpose).toBe("review-only");
    for (const tree of [review.baseline, review.current]) expect(tree).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(WINDOWS_NODE_SOURCE_ORIGINAL).toString("base64") }));
    expect(review.proposed).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(WINDOWS_NODE_SOURCE_ORIGINAL.replace("1 + 1, 3", "1 + 1, 2")).toString("base64") }));
    expect(review.proposed).toContainEqual(expect.objectContaining({ path: "README.txt", base64: Buffer.from(readme).toString("base64") }));
    for (const marker of [outside, credential, environmentCanary, "EXCLUDED_WINDOWS_NODE_GIT_DATA", "EXCLUDED_WINDOWS_NODE_DEPENDENCY_DATA"]) {
      expect(json).not.toContain(marker); expect(json).not.toContain(Buffer.from(marker).toString("base64"));
    }
    const exportedPatch = fs.readFileSync(path.join(exported, "changes.patch"), "utf8");
    expect(exportedPatch).toContain("1 + 1, 2");
    f.phase = 8;
    await f.home!.locator("#project-coding-continue").click();
    await f.home!.locator("#project-coding-continue-request").fill(scenarios[1].request);
    await expect.poll(() => f.home!.locator("#project-coding-continue-send").isEnabled()).toBe(true);
    await f.home!.locator("#project-coding-continue-send").click();
    await f.decide(WINDOWS_NODE_TEST_ARGV); await f.decide(WINDOWS_NODE_TEST_ARGV); await f.terminal(1, "done");
    const both = await f.results(); expect(both).toHaveLength(2);
    const continued = both.find(item => item.id !== first.id)!;
    expect(continued).toMatchObject({ status: "done", checks: { ran: 2, passed: 2, failed: 0 }, patchComplete: true });
    expect(continued.taskId).not.toBe(first.taskId); expect(continued.message).not.toContain("retained");
    expect(f.approved.every(card => card.sha256 === f.approved[0].sha256)).toBe(true); expect(new Set(f.approved.map(card => card.n)).size).toBe(4);
    expect(f.model.steps.get("repair")).toBe(4); expect(f.model.steps.get("continuation")).toBe(5);
    await f.home!.locator('[data-result-control="' + continued.id + '"]').click();
    const cumulative = await f.home!.evaluate(id => window.ember.codingResultReview(id), continued.id);
    expect(cumulative.textPatch).toContain("-" + WINDOWS_NODE_SOURCE_ORIGINAL.trim());
    expect(cumulative.textPatch).toContain("test('continued sum'");
    await f.home!.locator('[data-forget-result="' + continued.id + '"]').click();
    await expect.poll(async () => (await f.results()).length).toBe(1);
    await expect(f.home!.evaluate(id => window.ember.codingResultReview(id), continued.id)).rejects.toThrow("no longer available");
    expect((await f.home!.evaluate(id => window.ember.codingResultReview(id), first.id)).id).toBe(first.id);
    f.assertUnchanged(); await f.erase();
    expect(fs.readFileSync(path.join(exported, "review.json"), "utf8")).toBe(json); expect(fs.readFileSync(path.join(exported, "changes.patch"), "utf8")).toBe(exportedPatch);
  }), 180_000);

  it("honors a real Not now without executing or retrying the refused Node command", async () => journey("denied", async f => {
    await f.send(windowsNodeSourceScenarios("denied")[0].request);
    const command = await f.decide(WINDOWS_NODE_TEST_ARGV, "Not now"); await f.terminal(0);
    f.phase = 11;
    expect((await f.sessions())[0].status).not.toBe("done");
    f.phase = 12;
    const results = await f.results(); expect(results).toHaveLength(1);
    f.phase = 13;
    expect(results[0]).toMatchObject({ status: "failed", checks: { ran: 0, passed: 0, failed: 0 } });
    f.phase = 14;
    expect(await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot!.state.tabs.length))).toBe(0);
    f.phase = 15;
    expect(f.model.steps.get("denied")).toBe(1);
    f.phase = 16;
    expect(f.approved).toEqual([]); await f.erase();
  }), 120_000);

  it.each(["stop", "source", "mode", "forget", "account"] as const)("keeps a real running writer contained across %s controls without late success, retry or source writes", async kind => journey(kind, async f => {
    await f.send(windowsNodeSourceScenarios(kind)[0].request); await f.decide(WINDOWS_NODE_WRITER_ARGV); await f.writerReady();
    f.phase = 8;
    const session = (await f.sessions())[0]; expect(session.taskId).toBeTruthy();
    if (kind === "stop") expect(await f.home!.evaluate(id => window.ember.taskControl(id, "stop"), session.taskId)).toBe(true);
    else if (kind === "source") {
      await expect.poll(() => f.home!.locator("#project-coding-forget").isEnabled()).toBe(false);
      await expect(f.home!.evaluate(id => window.ember.projectCodingWorkspaceForget(id), f.projectId))
        .rejects.toThrow("Stop this project's coding sessions before changing its folder.");
      const live = await f.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id), f.projectId);
      expect(live.canChoose).toBe(false); expect(live.folder?.path).toBe(f.source);
      expect((await f.sessions())[0].status).not.toBe("stopped");
      expect(await f.home!.evaluate(id => window.ember.taskControl(id, "stop"), session.taskId)).toBe(true);
      await f.terminal(0, "stopped");
      const workspace = await f.home!.evaluate(id => window.ember.projectCodingWorkspaceForget(id), f.projectId); expect(workspace.folder).toBeNull();
    } else if (kind === "mode") {
      const before = await f.home!.evaluate(() => window.ember.getStatus().then(status => status.approvals?.inForce));
      const next: ApprovalMode = before === "interactive" ? "assisted" : "interactive", version = modeCardVersion(next);
      const changed = await f.home!.evaluate(({ next, version }) => window.ember.chooseMode(next, version), { next, version });
      expect(changed.ok).toBe(true); expect(changed.state.inForce).not.toBe(before);
    } else if (kind === "forget") await f.home!.evaluate(() => window.ember.forgetAllMemory());
    else await f.home!.evaluate(() => window.ember.signOut());
    if (kind === "forget" || kind === "account") {
      expect(await f.home!.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null });
      expect(await f.results()).toEqual([]);
    } else {
      await f.terminal(0); expect((await f.sessions())[0].status).not.toBe("done");
      expect((await f.results()).every(result => result.status !== "done" && result.checks.ran === 0)).toBe(true);
    }
    await expect.poll(async () => {
      for (const command of f.app!.windows().filter(page => page.url().includes("/renderer/command/index.html"))) {
        if (!await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot?.state.tabs.every(tab => tab.ended) === true))) return false;
      }
      return true;
    }, { timeout: 15_000 }).toBe(true);
    expect(f.model.steps.get(kind)).toBe(1); expect(f.approved).toHaveLength(1); f.assertUnchanged(); await f.erase();
  }), 150_000);
});
