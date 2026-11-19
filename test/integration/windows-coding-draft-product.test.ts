/**
 * Required single Windows SOURCE Home draft journey. Real Electron/safeStorage/Host/SDK/native resources.
 * Only the deterministic local provider and the two ordinary source/export picker answers are fixtures.
 * usage: build the reviewed composed source; EMBER_WINDOWS_CODING_DRAFT_PRODUCT_TEST=1 node scripts/run-integration.mjs test/integration/windows-coding-draft-product.test.ts
 * Unknown cleanup retains synthetic private graphs outside Vitest's unconditional temporary-root cleanup.
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
import { nodeInvocationSha256 } from "../../app/main/commands/node-invocation";
import type { CommandsApi } from "../../app/renderer/command/model";
import type { CodingResultSummary } from "../../app/shared/project-coding";
import type { CodingReviewExport } from "../../app/main/agent/coding-result-export";
import { decodeCodingReviewExport } from "../../app/main/agent/coding-result-export";
import { closeTestElectron } from "./close-electron";
import { WINDOWS_NODE_TEST_ARGV, WINDOWS_NODE_WRITER_ARGV, WINDOWS_NODE_WRITER_READY, WINDOWS_NODE_PRODUCT_TOOLS,
  WINDOWS_NODE_SOURCE_ORIGINAL, WINDOWS_NODE_SOURCE_WRITER } from "../fixtures/windows-node-product-model";
import { verifyWindowsNodeToolchain, WINDOWS_NODE_TOOLCHAIN } from "../../scripts/package/windows-node-toolchain.mjs";
// @ts-expect-error -- fixed local JavaScript provider fixture, never a real account or native issuer
import { startMockLlm } from "../mock-llm/server.mjs";

const required = process.env.EMBER_WINDOWS_CODING_DRAFT_PRODUCT_TEST === "1";
const codeMarker = "Saved draft code marker: chalk pebble birch";
const freshMarker = "Fresh source context: maple copper thread.\n";
const original = "// " + codeMarker + "\n" + WINDOWS_NODE_SOURCE_ORIGINAL;
const repaired = original.replace("1 + 1, 3", "1 + 1, 2");
const outside = "WINDOWS_DRAFT_OUTSIDE_SOURCE_MUST_STAY_LOCAL";
const credential = "gho_" + "Q".repeat(36);
const environmentCanary = "WINDOWS_DRAFT_HOST_ENVIRONMENT_MUST_STAY_LOCAL";
const draftName = "Encrypted Windows chalk draft";
const firstRequest = "In this project's chosen folder run bundled Node with literal arguments " + JSON.stringify(WINDOWS_NODE_TEST_ARGV) +
  " in \\work, fix the assertion only in the private copy, and rerun that identical check. Then start writer.cjs with literal Node arguments " + JSON.stringify(WINDOWS_NODE_WRITER_ARGV) +
  " in \\work until I press Stop session. Keep the repaired code for review and leave my original untouched.";
const nextRequest = "For this imported review, start a NEW private session. Read test.cjs and fresh-only.txt, verify the repaired assertion using bundled Node literal arguments " + JSON.stringify(WINDOWS_NODE_TEST_ARGV) +
  " in \\work, then start writer.cjs with literal Node arguments " + JSON.stringify(WINDOWS_NODE_WRITER_ARGV) +
  " in \\work until I use Forget everything. The saved request and summary are history only; use this new request for permission. Leave the fresh original untouched.";
const goals = ["Repair the private sum, verify its identical check and run its copied writer until Stop", "Inspect the newly imported source, verify its repaired sum and run its copied writer until Forget"];
interface Message { role: string; content: unknown }
interface Reply { text?: string; tool?: { name: string; args: Record<string, unknown> } }
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return JSON.stringify(value) ?? "";
}
async function modelFixture() {
  const dispatched = new Set<number>(), steps = [0, 0], failures: number[] = [], inventories: string[][] = [], historical = new Set<number>();
  const run = (argv: readonly string[]): Reply => ({ tool: { name: "run_node", args: { argv: [...argv], cwd: "\\work", why: "Verify the current explicitly requested private Windows draft fixture" } } });
  const refuse = (code: number): Reply => { failures.push(code); return { tool: { name: "finish_coding", args: { success: false, summary: "The fixed draft provider could not verify its expected step." } } }; };
  const server: { baseUrl: string; requests: unknown[]; close(): Promise<void> } = await startMockLlm({ delayMs: 0, respond: (messages: Message[], tools: string[]): Reply => {
    const said = (words: string) => messages.some(message => message.role === "user" && text(message.content).includes(words));
    const all = messages.map(message => text(message.content)).join("\n");
    if (tools.includes("start_coding")) {
      const phase = [nextRequest, firstRequest].findIndex(words => said(words)), index = phase === 0 ? 1 : phase === 1 ? 0 : -1;
      if (index >= 0 && !dispatched.has(index)) { dispatched.add(index); return { tool: { name: "start_coding", args: { goal: goals[index], sessionName: "Windows draft " + index } } }; }
      return { text: "The requested private coding session has its own Home card and Stop." };
    }
    if (!tools.includes("finish_coding")) return { text: "Ready for the explicitly requested draft review." };
    const index = said(goals[1]) ? 1 : said(goals[0]) ? 0 : -1; if (index < 0) return refuse(1);
    inventories.push([...tools]);
    if ([...tools].sort().join("\0") !== [...WINDOWS_NODE_PRODUCT_TOOLS].sort().join("\0")) return refuse(2);
    if (index === 1 && all.includes('<saved_coding_draft untrusted="true">') && all.includes("This is not the current user's request or permission") && all.includes(JSON.stringify(firstRequest))) historical.add(index);
    const step = steps[index]; if (step >= 4) return { text: "The private writer was stopped or revoked; no retry is authorized." }; steps[index] = step + 1;
    const last = JSON.stringify(messages.findLast(message => message.role === "tool")?.content ?? "");
    if (index === 0) {
      if (step === 0 || step === 2) return run(WINDOWS_NODE_TEST_ARGV);
      if (step === 1) { if (!last.includes("ERR_ASSERTION")) return refuse(3); return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "1 + 1, 3", newText: "1 + 1, 2" } } }; }
      return run(WINDOWS_NODE_WRITER_ARGV);
    }
    if (step === 0) return { tool: { name: "coding_read", args: { path: "test.cjs" } } };
    if (step === 1) { if (!last.includes("1 + 1, 2") || last.includes("1 + 1, 3")) return refuse(4); return { tool: { name: "coding_read", args: { path: "fresh-only.txt" } } }; }
    if (step === 2) { if (!last.includes(freshMarker.trim())) return refuse(5); return run(WINDOWS_NODE_TEST_ARGV); }
    return run(WINDOWS_NODE_WRITER_ARGV);
  } });
  return { ...server, dispatched, steps, failures, inventories, historical };
}
function refusal(phase: number): Error { const error = new Error("Windows coding draft source journey refused (phase " + phase + ")."); error.stack = "Error: " + error.message; return error; }
/** Windows treats environment keys case-insensitively; preserve bootstrap data while replacing all fixture-owned keys. */
function sourceEnvironment(base: NodeJS.ProcessEnv, input: { profile: string; provider: string; temporary: string }): Record<string, string> {
  const fixed = { EMBER_USER_DATA: input.profile, EMBER_TEST_PROVIDER_URL: input.provider, TMPDIR: input.temporary, TMP: input.temporary, TEMP: input.temporary, EMBER_NODE_SOURCE_CANARY: environmentCanary };
  const excluded = new Set([...Object.keys(fixed), "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_COPILOT_TOKEN", "COPILOT_TOKEN", "COPILOT_SDK_AUTH_TOKEN", "EMBER_COPILOT_RUNTIME",
    "ELECTRON_RUN_AS_NODE", "ELECTRON_DISABLE_SANDBOX", "EMBER_SMOKE_NO_SANDBOX", "ELECTRON_OVERRIDE_DIST_PATH", "NODE_OPTIONS", "EMBER_LOG_STDOUT"].map(key => key.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined && !excluded.has(entry[0].toLowerCase()))), ...fixed };
}
function ordinary(file: string): boolean { const info = fs.lstatSync(file); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; }
function preflight(): { appRoot: string; executable: string } {
  expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
  const appRoot = fs.realpathSync.native(process.cwd()), load = createRequire(import.meta.url), runtime = runtimeFor("win32", "x64");
  expect(ordinary(path.join(appRoot, "dist/app/main.cjs"))).toBe(true);
  const fixedRuntime = locateRuntime({ appPath: appRoot, runtimeId: runtime.id, exe: runtime.exe, env: {} });
  expect(fixedRuntime.exists).toBe(true); expect(ordinary(fixedRuntime.path)).toBe(true);
  const pkg = load.resolve("electron/package.json"); expect(path.resolve(pkg).toLowerCase()).toBe(path.join(appRoot, "node_modules/electron/package.json").toLowerCase());
  expect(fs.readFileSync(path.join(path.dirname(pkg), "path.txt"), "utf8")).toBe("electron.exe");
  const installed = JSON.parse(fs.readFileSync(pkg, "utf8")), owner = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")); expect(installed.version).toBe(owner.devDependencies.electron);
  const executable = path.join(path.dirname(pkg), "dist/electron.exe"); expect(ordinary(executable)).toBe(true);
  expect(WINDOWS_NODE_TOOLCHAIN.producerRun).not.toBe(43858256344);
  expect(verifyWindowsNodeToolchain(path.join(path.dirname(executable), "resources/coding/windows-node-x64")).files).toBe(3);
  return { appRoot, executable };
}

it.skipIf(!required)("saves an encrypted stopped repair, restarts the real app and keyring, imports against fresh source and starts only a new typed continuation before Forget drains writers", async () => {
  let phase = 1, app: ElectronApplication | undefined, proc: ChildProcess | undefined, model: Awaited<ReturnType<typeof modelFixture>> | undefined, root: string | undefined;
  let owned: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, erased = false, failed = false;
  let firstFailure = 0;
  const fail = (at = phase) => { if (!failed) firstFailure = at; failed = true; };
  try {
    const input = preflight(), temporary = fs.realpathSync.native(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-windows-draft-source-")));
    const source = path.join(root, "source"), fresh = path.join(root, "fresh-source"), profile = path.join(root, "profile"), exported = path.join(root, "exported"), scratch = path.join(root, "temporary");
    for (const folder of [source, fresh, profile, exported, scratch]) fs.mkdirSync(folder);
    for (const folder of [source, fresh]) { fs.writeFileSync(path.join(folder, "test.cjs"), original); fs.writeFileSync(path.join(folder, "writer.cjs"), WINDOWS_NODE_SOURCE_WRITER); }
    fs.writeFileSync(path.join(fresh, "fresh-only.txt"), freshMarker); fs.writeFileSync(path.join(root, "outside.txt"), outside); fs.writeFileSync(path.join(profile, "credential-canary.txt"), credential);
    const at = new Date().toISOString(); fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ version: 1, onboarded: true, wakeWord: false, speak: false, speakWithScreenReader: false, speakResults: false,
      consent: { version: CONSENT_VERSION, at }, commands: { local: { on: true, askEvery: true, consent: { version: FEATURE_CONSENT_VERSION.commands, at } } } }));
    model = await modelFixture(); const provider = model;
    const body = async () => {
      phase = 2;
      let launchEpoch = 0;
      const launchHome = async (firstFolder: string): Promise<Page> => {
        const env = sourceEnvironment(process.env, { profile, provider: provider.baseUrl, temporary: scratch });
        app = await _electron.launch({ executablePath: input.executable, args: [input.appRoot, "--show-settings"], env, timeout: 45_000 }); proc = app.process();
        expect(proc.spawnargs.some(arg => arg === "--no-sandbox" || arg === "--disable-sandbox")).toBe(false);
        // Fixed OS picker answers only. The model, IPC handlers, native issuers and real keyring stay intact.
        await app.evaluate(({ dialog }, folders) => {
          let chosen = 0;
          dialog.showOpenDialog = async (...args: unknown[]) => {
            const title = (args.at(-1) as { title?: string })?.title ?? "";
            if (title === "Choose a coding folder") return { canceled: false, filePaths: [chosen++ === 0 ? folders.source : folders.fresh] };
            if (title === "Export coding review") return { canceled: false, filePaths: [folders.exported] };
            throw new Error("The fixed draft source journey permits only its source and export pickers.");
          };
        }, { source: firstFolder, fresh, exported });
        await expect.poll(() => app!.windows().some(page => page.url().includes("/renderer/home/index.html")), { timeout: 30_000 }).toBe(true);
        const page = app.windows().find(page => page.url().includes("/renderer/home/index.html"))!;
        await expect.poll(() => page.evaluate(() => window.ember.agentStatus().then(status => status?.phase)), { timeout: 40_000 }).toBe("ready");
        expect(await page.evaluate(() => ({ process: typeof process, require: typeof require }))).toEqual({ process: "undefined", require: "undefined" });
        expect(await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text")).toBe(true);
        expect(await app.evaluate(({ BrowserWindow, app }) => { const metrics = app.getAppMetrics(), homes = BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes("/renderer/home/index.html")); return homes.length > 0 && homes.every(w => metrics.find(m => m.pid === w.webContents.getOSProcessId())?.sandboxed === true); })).toBe(true);
        launchEpoch++; return page;
      };
      let home = await launchHome(source);
      await home.locator('a[href="#project-h"]').click(); await home.locator("#project-sessions-name").fill("Actual Windows saved draft"); await home.locator("#project-sessions-add").click();
      await expect.poll(() => home.locator("#project-coding-choose").isEnabled()).toBe(true); await home.locator("#project-coding-choose").click();
      await expect.poll(() => home.locator("#project-coding-folder").textContent()).toContain(source);
      let projectId = (await home.evaluate(() => window.ember.projectSessionsState())).selectedProjectId!; expect(projectId).toBeTruthy();
      await expect.poll(() => home.evaluate(id => window.ember.projectCodingWorkspaceState(id).then(state => state.available), projectId), { timeout: 30_000 }).toBe(true);
      expect((await home.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId)).message).toContain("Shells, npm, dependency installation, network access and child processes are unavailable");
      const sessions = async () => (await home.evaluate(() => window.ember.projectSessionsState())).projects.find(p => p.id === projectId)?.sessions ?? [];
      const results = (): Promise<CodingResultSummary[]> => home.evaluate(id => window.ember.codingResultsState(id), projectId);
      const command = async (): Promise<Page> => { await expect.poll(() => app!.windows().some(p => p.url().includes("/renderer/command/index.html")), { timeout: 45_000 }).toBe(true); return app!.windows().find(p => p.url().includes("/renderer/command/index.html"))!; };
      let approval = 0; const approvals: string[] = [];
      const allow = async (argv: readonly string[]) => {
        const page = await command(); await expect.poll(() => page.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(s => s?.state.card?.n ?? 0)), { timeout: 45_000 }).toBeGreaterThan(approval);
        const card = await page.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(s => s!.state.card!));
        expect({ kind: card.kind, shell: card.shell, argv: card.argv, cwd: card.cwd }).toEqual({ kind: "node", shell: undefined, argv: [...argv], cwd: "\\work" });
        expect(card.sha256).toBe(nodeInvocationSha256("local", "\\work", argv)); approval = card.n; approvals.push(`${launchEpoch}:${card.n}`);
        const button = page.getByRole("button", { name: "Allow", exact: true }); await expect.poll(() => button.isEnabled(), { timeout: 15_000 }).toBe(true); await button.click();
      };
      const ready = async () => {
        const page = await command();
        await expect.poll(() => page.evaluate(marker => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => {
          if (!snapshot) return false;
          return snapshot.state.tabs.some(tab => !tab.ended && new TextDecoder().decode(Uint8Array.from(snapshot.replay
            .filter(message => message.runId === tab.runId && message.seq === tab.seq).flatMap(message => Array.from(message.bytes)))).includes(marker));
        }), WINDOWS_NODE_WRITER_READY), { timeout: 30_000 }).toBe(true);
      };
      const noCommands = async () => {
        await expect.poll(async () => {
          for (const page of app!.windows().filter(candidate => candidate.url().includes("/renderer/command/index.html"))) {
            if (!await page.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot =>
              !!snapshot && snapshot.state.tabs.every(tab => tab.ended) && snapshot.state.card === null && (snapshot.state.pending?.length ?? 0) === 0))) return false;
          }
          return true;
        }, { timeout: 15_000 }).toBe(true);
      };
      const unchanged = () => { for (const folder of [source, fresh]) { expect(fs.readFileSync(path.join(folder, "test.cjs"), "utf8")).toBe(original); expect(fs.readFileSync(path.join(folder, "writer.cjs"), "utf8")).toBe(WINDOWS_NODE_SOURCE_WRITER); expect(fs.existsSync(path.join(folder, "heartbeat.txt"))).toBe(false); } expect(fs.readFileSync(path.join(fresh, "fresh-only.txt"), "utf8")).toBe(freshMarker); expect(fs.readFileSync(path.join(root!, "outside.txt"), "utf8")).toBe(outside); expect(fs.readFileSync(path.join(profile, "credential-canary.txt"), "utf8")).toBe(credential); };
      const emptyRoles = () => {
        const controllers = path.join(profile, "coding-controllers"); if (fs.existsSync(controllers)) expect(fs.readdirSync(controllers)).toEqual([]);
        const common = path.join(scratch, "ember-coding-unsupported"); if (fs.existsSync(common)) for (const processRoot of fs.readdirSync(common)) { expect(processRoot).toMatch(/^process-[0-9a-f-]{36}$/); for (const role of fs.readdirSync(path.join(common, processRoot))) { expect(["copies", "reviews", "assets"]).toContain(role); expect(fs.readdirSync(path.join(common, processRoot, role))).toEqual([]); } }
      };
      const exportedIds = new Set<string>();
      const exportReview = async (): Promise<CodingReviewExport> => {
        await home.locator("#project-coding-export").click(); await expect.poll(() => home.locator("#project-coding-status").textContent(), { timeout: 15_000 }).toContain("Exported the coding review");
        const names = fs.readdirSync(exported).filter(name => !exportedIds.has(name)); expect(names).toHaveLength(1); exportedIds.add(names[0]);
        const file = path.join(exported, names[0], "review.json"); expect(ordinary(file)).toBe(true); const bytes = fs.readFileSync(file); expect(bytes.length).toBeLessThan(32 * 1024 * 1024);
        const data: CodingReviewExport = JSON.parse(bytes.toString("utf8")); decodeCodingReviewExport(bytes, data.binding); return data;
      };
      phase = 3;
      expect(provider.requests).toHaveLength(0); await home.locator("#project-sessions-request").fill(firstRequest); await home.locator("#project-sessions-send").click();
      await allow(WINDOWS_NODE_TEST_ARGV); await allow(WINDOWS_NODE_TEST_ARGV); await allow(WINDOWS_NODE_WRITER_ARGV); await ready();
      const firstSession = (await sessions())[0]; expect(firstSession.taskId).toBeTruthy(); await home.getByRole("button", { name: "Stop session: " + firstSession.title, exact: true }).click();
      await expect.poll(async () => (await sessions())[0]?.status, { timeout: 45_000 }).toBe("stopped"); await expect.poll(() => home.evaluate(() => window.ember.conversationTurn()), { timeout: 20_000 }).toBe("idle");
      const first = (await results())[0]; expect(first.status).toBe("stopped"); expect(first.checks.ran).toBeGreaterThanOrEqual(2); expect(first.message).not.toContain("retained");
      await noCommands();
      await home.locator('[data-result-control="' + first.id + '"]').click(); await expect.poll(() => home.locator("#project-coding-patch").textContent()).toContain("1 + 1, 2");
      const firstReview = await exportReview(); expect(firstReview.proposed).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(repaired).toString("base64") })); unchanged();
      phase = 4;
      const idleRequests = provider.requests.length; let idleSessions = JSON.stringify(await sessions());
      await home.locator("#coding-drafts-save-show").click(); await expect.poll(() => home.locator("#coding-drafts-save-form").isVisible()).toBe(true);
      await home.locator("#coding-drafts-name").fill(draftName); await home.locator("#coding-drafts-save").click();
      await expect.poll(() => home.evaluate(() => window.ember.codingDraftsState().then(state => state.drafts.length)), { timeout: 30_000 }).toBe(1);
      const library = await home.evaluate(() => window.ember.codingDraftsState()); expect(library).toMatchObject({ canSave: true, canOpen: true, canForget: true });
      const saved = library.drafts[0]; expect(saved.name).toBe(draftName); expect(saved.historicalChecks).toEqual(first.checks);
      const draftDir = path.join(profile, "coding-drafts"), files = fs.readdirSync(draftDir); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^coding-draft-[a-f0-9]{64}-[a-f0-9-]{36}\.bin$/);
      const encrypted = path.join(draftDir, files[0]); expect(ordinary(encrypted)).toBe(true); const ciphertext = fs.readFileSync(encrypted); expect(ciphertext.subarray(0, 12).toString()).toBe("EMBERDRAFT1\0");
      for (const marker of [draftName, firstRequest, codeMarker, repaired]) for (const bytes of [Buffer.from(marker), Buffer.from(marker, "utf16le"), Buffer.from(Buffer.from(marker).toString("base64"))]) expect(ciphertext.includes(bytes)).toBe(false);
      expect(provider.requests.length).toBe(idleRequests); expect(JSON.stringify(await sessions())).toBe(idleSessions);
      const oldProjectId = projectId, firstApp = app!, firstProcess = proc!;
      expect(await closeTestElectron(firstApp)).toBe(false);
      expect(firstProcess.exitCode).toBe(0); expect(firstProcess.signalCode).toBeNull();
      emptyRoles(); unchanged(); expect(fs.readFileSync(encrypted)).toEqual(ciphertext);
      // The same profile/keyring survives. No task, native witness, folder grant or project record is restored.
      app = undefined; proc = undefined; approval = 0;
      home = await launchHome(fresh);
      expect(app).not.toBe(firstApp); expect(proc).not.toBe(firstProcess);
      expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null });
      expect(await home.evaluate(() => window.ember.tasks())).toEqual([]);
      await expect(home.evaluate(id => window.ember.codingResultReview(id), first.id)).rejects.toThrow();
      expect(provider.requests.length).toBe(idleRequests); await noCommands();
      await home.locator('a[href="#project-h"]').click();
      await home.locator("#project-sessions-name").fill("Reopened Windows saved draft"); await home.locator("#project-sessions-add").click();
      projectId = (await home.evaluate(() => window.ember.projectSessionsState())).selectedProjectId!;
      expect(projectId).toBeTruthy(); expect(projectId).not.toBe(oldProjectId);
      expect((await home.evaluate(id => window.ember.projectCodingWorkspaceState(id), projectId)).folder).toBeNull();
      expect(await results()).toEqual([]); idleSessions = JSON.stringify(await sessions()); expect(idleSessions).toBe("[]");
      await home.locator("#coding-drafts-refresh").click();
      await expect.poll(() => home.getByRole("button", { name: "Open saved draft: " + draftName, exact: true }).isEnabled()).toBe(true);
      expect((await home.evaluate(() => window.ember.codingDraftsState())).drafts).toContainEqual(saved);
      expect(fs.readFileSync(encrypted)).toEqual(ciphertext); expect(provider.requests.length).toBe(idleRequests);
      await home.getByRole("button", { name: "Open saved draft: " + draftName, exact: true }).click();
      await expect.poll(() => home.locator("#coding-drafts-view").isVisible()).toBe(true); expect(await home.locator("#coding-drafts-request").textContent()).toBe(firstRequest);
      expect(await home.locator("#coding-drafts-preview").textContent()).toContain("1 + 1, 2"); expect(await home.locator("#coding-drafts-import").isDisabled()).toBe(true);
      expect(provider.requests.length).toBe(idleRequests); expect(JSON.stringify(await sessions())).toBe(idleSessions);
      expect(await home.evaluate(() => window.ember.tasks())).toEqual([]);
      await noCommands();
      phase = 5;
      fs.writeFileSync(path.join(fresh, "test.cjs"), original.replace("1 + 1, 3", "1 + 1, 41"));
      await home.locator("#coding-drafts-folder").click(); await expect.poll(() => home.locator("#coding-drafts-import").isEnabled()).toBe(true); await home.locator("#coding-drafts-import").click();
      await expect.poll(() => home.locator("#coding-drafts-status").textContent(), { timeout: 30_000 }).toContain("conflict"); expect(await results()).toEqual([]); expect(await home.locator("#coding-drafts-import").isDisabled()).toBe(true);
      expect(provider.requests.length).toBe(idleRequests); expect(JSON.stringify(await sessions())).toBe(idleSessions); expect(fs.readFileSync(path.join(fresh, "test.cjs"), "utf8")).toContain("1 + 1, 41");
      expect(await home.evaluate(() => window.ember.tasks())).toEqual([]);
      await noCommands();
      fs.writeFileSync(path.join(fresh, "test.cjs"), original);
      await home.locator("#coding-drafts-folder").click(); await expect.poll(() => home.locator("#coding-drafts-import").isEnabled()).toBe(true); await home.locator("#coding-drafts-import").click();
      await expect.poll(async () => (await results()).length, { timeout: 30_000 }).toBe(1);
      const imported = (await results())[0]; expect(imported).toMatchObject({ status: "done", sourcePath: fresh, checks: { ran: 0, passed: 0, failed: 0 } }); expect(imported.id).not.toBe(first.id); expect(imported.taskId).not.toBe(first.taskId);
      await expect.poll(() => home.locator("#project-coding-review-title").textContent()).toBe(imported.title);
      expect(await home.locator("#coding-drafts-status").textContent()).toContain("Historical checks must run again"); expect(provider.requests.length).toBe(idleRequests); expect(JSON.stringify(await sessions())).toBe(idleSessions);
      expect(await home.evaluate(() => window.ember.tasks())).toEqual([]);
      await noCommands();
      const importedReview = await exportReview(); expect(importedReview.binding.session).not.toBe(firstReview.binding.session); expect(importedReview.binding.snapshot).not.toBe(firstReview.binding.snapshot);
      expect(importedReview.baseline).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(original).toString("base64") }));
      for (const tree of [importedReview.baseline, importedReview.proposed]) expect(tree).toContainEqual(expect.objectContaining({ path: "fresh-only.txt", base64: Buffer.from(freshMarker).toString("base64") }));
      expect(importedReview.proposed).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(repaired).toString("base64") })); unchanged();
      phase = 6;
      await home.locator("#project-coding-continue").click(); expect(await home.locator("#project-coding-continue-request").inputValue()).toBe(""); expect(await home.locator("#project-coding-continue-send").isDisabled()).toBe(true); expect(provider.requests.length).toBe(idleRequests);
      await home.locator("#project-coding-continue-request").fill(nextRequest); await home.locator("#project-coding-continue-send").click();
      await allow(WINDOWS_NODE_TEST_ARGV); await allow(WINDOWS_NODE_WRITER_ARGV); await ready();
      const continued = (await sessions()).find(item => item.taskId !== first.taskId)!; expect(continued.taskId).not.toBe(imported.taskId); expect(continued.id).not.toBe(firstSession.id);
      expect(provider.dispatched).toEqual(new Set([0, 1])); expect(provider.steps).toEqual([4, 4]); expect(provider.historical.has(1)).toBe(true); expect(new Set(approvals).size).toBe(5);
      phase = 7;
      await home.evaluate(() => window.ember.forgetAllMemory());
      expect(await home.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null }); expect(await results()).toEqual([]);
      expect((await home.evaluate(() => window.ember.codingDraftsState())).drafts).toEqual([]); expect(fs.readdirSync(draftDir)).toEqual([]);
      await expect(home.evaluate(id => window.ember.codingDraftOpen(id), saved.id)).rejects.toThrow();
      for (const id of [first.id, imported.id]) await expect(home.evaluate(result => window.ember.codingResultReview(result), id)).rejects.toThrow();
      emptyRoles(); unchanged(); expect(provider.failures).toEqual([]); expect(provider.steps).toEqual([4, 4]);
      const sent = JSON.stringify(provider.requests); for (const marker of [outside, credential, environmentCanary]) expect(sent).not.toContain(marker);
      for (const inventory of provider.inventories) expect([...inventory].sort()).toEqual([...WINDOWS_NODE_PRODUCT_TOOLS].sort()); erased = true;
    };
    owned = body(); await Promise.race([owned, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(refusal(phase)), 210_000); })]);
  } catch { fail(); }
  finally {
    clearTimeout(timer); let clean = false;
    try { const forced = app ? await closeTestElectron(app) : false; clean = !!proc && !forced && proc.exitCode === 0 && proc.signalCode === null; } catch { fail(8); }
    try { await owned; } catch { fail(); }
    try { await model?.close(); } catch { fail(8); }
    // Retain every uncertain graph. Normal process exit alone does not certify native/keyring/worker cleanup.
    if (!failed && erased && clean && root) { try { fs.rmSync(root, { recursive: true, force: false }); } catch { fail(8); } }
    else fail(8);
  }
  if (failed) throw refusal(firstFailure);
  console.info("Windows coding draft source journey passed", JSON.stringify({ schema: 1, case: 1, phase: 8 }));
}, 240_000);
