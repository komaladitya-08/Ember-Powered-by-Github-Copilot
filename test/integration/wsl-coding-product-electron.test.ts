/** Separate real normal-sandbox Windows Home -> Main/IPC/Host/SDK/native Windows custody -> actual WSL product cases.
 * Only the deterministic local model endpoint and source/export OS picker replies are fixtures.
 * Closed readiness refuses before launch. Native Node inventories are untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { modeCardVersion, type ApprovalMode } from "../../app/shared/approvals";
import { cardSha256 } from "../../app/main/commands/window";
import type { CommandsApi } from "../../app/renderer/command/model";
import type { CodingResultSummary } from "../../app/shared/project-coding";
import { closeTestElectron } from "./close-electron";
import { wslProductPreflight, wslProductScratchParent, wslProductChildEnvironment } from "../fixtures/wsl-coding-product-preflight";
import { WSL_PRODUCT_CASES, wslProductTitle, type WslSourceCase } from "../fixtures/wsl-coding-product-contract";
import { sourceSummaryKind } from "../fixtures/wsl-coding-product-observation";
import { createWslProductModel, wslProductProject, wslProductScenarios, WSL_PRODUCT_CHECK, WSL_PRODUCT_WRITER,
  WSL_PRODUCT_WRITER_READY, WSL_PRODUCT_TOOLS, WSL_PUBLIC_PRODUCT_TOOLS } from "../fixtures/wsl-coding-product-model";

const required = process.env.EMBER_ELECTRON_WSL_CODING_PRODUCT_TEST === "1";
const outside = "OUTSIDE_WSL_PRODUCT_PROJECT_MUST_STAY_LOCAL", credential = "gho_" + "Q".repeat(36);
const environmentCanary = "WSL_PRODUCT_HOST_ENVIRONMENT_MUST_STAY_LOCAL";
const excludedGit = "EXCLUDED_WSL_PRODUCT_GIT_DATA", excludedDependency = "EXCLUDED_WSL_PRODUCT_DEPENDENCY_DATA";
type Model = Awaited<ReturnType<typeof createWslProductModel>>;
let quarantined = false;
const retainedOwners = new Set<object>();
function refusal(kind: WslSourceCase, phase: number): Error {
  const error = new Error("Windows WSL source journey refused (case " + (WSL_PRODUCT_CASES.source.indexOf(kind) + 1) + ", phase " + phase + ").");
  error.stack = "Error: " + error.message; return error;
}
/** Independent expected hashes for the two fixed public test manifests, never a parser or preparation capability. */
function expectedPublicSummary(changed: boolean) {
  const files = wslProductProject(true, changed), lock = JSON.parse(files["package-lock.json"]) as { packages: Record<string, { version: string; resolved: string; integrity: string }> };
  const packages = Object.entries(lock.packages).filter(([name]) => name.startsWith("node_modules/")).map(([location, value]) => ({
    name: location.slice("node_modules/".length), version: value.version, resolved: value.resolved, integrity: value.integrity,
  })).sort((left, right) => left.resolved < right.resolved ? -1 : left.resolved > right.resolved ? 1 : 0);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return { registry: "https://registry.npmjs.org", packageJsonSha256: digest(files["package.json"]), lockSha256: digest(files["package-lock.json"]),
    setSha256: digest(JSON.stringify(packages)), packages: packages.map(value => ({ name: value.name, version: value.version })), packageCount: packages.length, compressedByteLimit: 64 * 1024 * 1024 };
}
const sourceTerminalStage = Object.freeze({ session: 1, idle: 2, results: 3 } as const);
type SourceTerminalObservation = { episode: number; stage: number; session: number; turn: number };

class Journey {
  terminalSummaryKind = 0;
  terminalObservation?: SourceTerminalObservation;
  phase = 1;
  app?: ElectronApplication;
  process?: ChildProcess;
  home?: Page;
  projectId = "";
  lastApproval = 0;
  readonly approved: { n: number; sha256: string; command: string }[] = [];
  readonly publicApproved: string[] = [];
  readonly originals: Readonly<Record<string, string>>;
  erased = false;
  readonly source: string;
  readonly userData: string;
  readonly exported: string;
  readonly temporary: string;
  constructor(readonly kind: WslSourceCase, readonly root: string, readonly model: Model, readonly input: ReturnType<typeof wslProductPreflight>) {
    this.originals = wslProductProject(kind.startsWith("public-"));
    this.source = path.join(root, "source"); this.userData = path.join(root, "profile");
    this.exported = path.join(root, "exported"); this.temporary = path.join(root, "temporary");
    for (const directory of [this.source, this.userData, this.exported, this.temporary, path.join(this.source, ".git"), path.join(this.source, "node_modules")]) fs.mkdirSync(directory);
    for (const [name, text] of Object.entries(this.originals)) { fs.mkdirSync(path.dirname(path.join(this.source, name)), { recursive: true }); fs.writeFileSync(path.join(this.source, name), text); }
    fs.writeFileSync(path.join(this.source, ".git/HEAD"), excludedGit);
    fs.writeFileSync(path.join(this.source, "node_modules/fixture.js"), excludedDependency);
    fs.writeFileSync(path.join(root, "outside.txt"), outside);
    fs.writeFileSync(path.join(this.userData, "credential-canary.txt"), credential);
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(this.userData, "settings.json"), JSON.stringify({
      version: 1, onboarded: true, wakeWord: false, speak: false, speakWithScreenReader: false, speakResults: false,
      consent: { version: CONSENT_VERSION, at },
      targets: { active: "local", wsl: { on: true, consent: { version: FEATURE_CONSENT_VERSION.wsl, at } } },
      commands: { local: { on: true, askEvery: true, consent: { version: FEATURE_CONSENT_VERSION.commands, at } },
        [input.target]: { on: true, askEvery: true, consent: { version: FEATURE_CONSENT_VERSION.commands, at } } },
    }));
  }
  async start(input: ReturnType<typeof wslProductPreflight>): Promise<void> {
    this.phase = 2;
    const env: NodeJS.ProcessEnv = wslProductChildEnvironment(process.env);
    const blocked = /^(?:COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|GITHUB_COPILOT_TOKEN|COPILOT_TOKEN|COPILOT_SDK_AUTH_TOKEN|ELECTRON_RUN_AS_NODE|ELECTRON_DISABLE_SANDBOX|EMBER_SMOKE_NO_SANDBOX|ELECTRON_OVERRIDE_DIST_PATH|NODE_OPTIONS|EMBER_LOG_STDOUT|EMBER_USER_DATA|EMBER_TEST_PROVIDER_URL|TMPDIR|TMP|TEMP|EMBER_WSL_PRODUCT_HOST_CANARY)$/i;
    for (const key of Object.keys(env)) if (blocked.test(key)) delete env[key];
    Object.assign(env, { EMBER_USER_DATA: this.userData, EMBER_TEST_PROVIDER_URL: this.model.baseUrl,
      TMPDIR: this.temporary, TMP: this.temporary, TEMP: this.temporary, EMBER_WSL_PRODUCT_HOST_CANARY: environmentCanary });
    const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    this.app = await _electron.launch({ executablePath: input.executable, args: [input.repository, "--show-settings"], env: childEnv, timeout: 45_000 });
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
    await this.home.locator("#project-sessions-name").fill("Actual Windows WSL " + this.kind);
    await this.home.locator("#project-sessions-add").click();
    await expect.poll(() => this.home!.locator("#project-coding-choose").isEnabled()).toBe(true);
    await this.home.locator("#project-coding-choose").click();
    await expect.poll(() => this.home!.locator("#project-coding-folder").textContent()).toContain(this.source);
    this.projectId = (await this.home.evaluate(() => window.ember.projectSessionsState())).selectedProjectId!;
    expect(this.projectId).toBeTruthy(); expect(this.model.requests).toHaveLength(0);
    await expect.poll(() => this.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id).then(state => state.available), this.projectId), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => this.home!.locator("#project-coding-execution-select option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), { timeout: 30_000 }).toContain(input.target);
    await this.home.locator("#project-coding-execution-select").selectOption(input.target); await this.home.locator("#project-coding-execution-choose").click();
    await expect.poll(() => this.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id).then(state => state.execution?.selected), this.projectId)).toBe(input.target);
    await expect.poll(() => this.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id).then(state => state.available), this.projectId), { timeout: 30_000 }).toBe(true);
    if (this.kind.startsWith("public-")) {
      await this.home.locator("#project-coding-public-dependencies-on").check();
      await expect.poll(() => this.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id).then(state => state.execution?.publicDependencies?.enabled), this.projectId)).toBe(true);
    } else expect(await this.home.locator("#project-coding-public-dependencies-on").isVisible()).toBe(true);
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
  async decide(commandText = WSL_PRODUCT_CHECK, answer: "Allow" | "Not now" = "Allow"): Promise<Page> {
    this.phase = 4; const command = await this.command();
    await expect.poll(() => command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot?.state.card?.n ?? 0)), { timeout: 45_000 }).toBeGreaterThan(this.lastApproval);
    const card = await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => snapshot!.state.card!)); this.lastApproval = card.n;
    expect(card.kind).not.toBe("node"); expect({ target: card.target, command: card.command, shell: card.shell, cwd: card.cwd }).toEqual({ target: this.input.target, command: commandText, shell: "bash", cwd: "/work" });
    expect(card.sha256).toBe(cardSha256(card)); await expect.poll(() => command.locator("#ask-cmd").textContent()).toBe(commandText);
    const button = command.getByRole("button", { name: answer, exact: true }); await expect.poll(() => button.isEnabled(), { timeout: 15_000 }).toBe(true);
    if (answer === "Allow") this.approved.push({ n: card.n, sha256: card.sha256, command: commandText }); await button.click(); return command;
  }
  async dependencies(changed: boolean, kind: "baseline" | "changed", answer: "Allow" | "Not now" | null = "Allow"): Promise<void> {
    this.phase = 18; const summary = expectedPublicSummary(changed);
    const request = { kind, registry: summary.registry, packageJsonSha256: summary.packageJsonSha256, lockSha256: summary.lockSha256,
      setSha256: summary.setSha256, packages: summary.packages, packageCount: summary.packageCount, compressedByteLimit: summary.compressedByteLimit };
    const sha256 = createHash("sha256").update("Ember/public-npm-preparation/v1\0").update(JSON.stringify({ projectId: this.projectId, target: this.input.target, request })).digest("hex");
    let page: Page | undefined;
    await expect.poll(async () => {
      for (const candidate of this.app!.windows().filter(item => /\/renderer\/(?:overlay|handle)\/index\.html/.test(item.url()))) {
        const whole = candidate.locator(".eb-whole:visible, #whole:visible");
        if (await whole.count() && (await whole.first().innerText()).includes(sha256)) { page = candidate; return true; }
      }
      return false;
    }, { timeout: 45_000 }).toBe(true);
    const whole = page!.locator(".eb-whole:visible, #whole:visible").first(), detail = await whole.innerText();
    for (const value of [summary.registry, summary.packageJsonSha256, summary.lockSha256, summary.setSha256, sha256, ...summary.packages.map(pkg => `${pkg.name}@${pkg.version}`)]) expect(detail).toContain(value);
    if (answer === null) return; // Observe the real pending question; neither answer nor mark it read.
    const button = page!.getByRole("button", { name: answer, exact: true });
    if (answer === "Allow") {
      // Read the actual full-text surface with ordinary wheel input; never mark it seen through IPC.
      for (let step = 0; step < 12 && await button.getAttribute("aria-disabled") === "true"; step++) { await whole.hover(); await page!.mouse.wheel(0, 500); await page!.waitForTimeout(150); }
      await expect.poll(() => button.getAttribute("aria-disabled"), { timeout: 15_000 }).not.toBe("true");
      await expect.poll(() => button.isEnabled(), { timeout: 15_000 }).toBe(true); this.publicApproved.push(sha256);
    }
    await button.click();
  }
  async writerReady(): Promise<void> {
    this.phase = 5;
    const command = await this.command();
    await expect.poll(() => command.evaluate(marker => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(snapshot => {
      if (!snapshot?.state.tabs.some(tab => !tab.ended)) return false;
      return new TextDecoder().decode(Uint8Array.from(snapshot.replay.flatMap(message => Array.from(message.bytes)))).includes(marker);
    }), WSL_PRODUCT_WRITER_READY), { timeout: 30_000 }).toBe(true);
  }
  async sessions() {
    return (await this.home!.evaluate(() => window.ember.projectSessionsState())).projects.find(project => project.id === this.projectId)?.sessions ?? [];
  }
  async terminal(index: number, status?: "done" | "failed" | "stopped"): Promise<void> {
    this.phase = 6;
    const observation = this.kind === "repair" && (index === 0 || index === 1)
      ? { episode: index + 1, stage: sourceTerminalStage.session, session: 0, turn: 0 } as SourceTerminalObservation : undefined;
    this.terminalObservation = observation;
    this.terminalSummaryKind = 0;
    await expect.poll(async () => {
      const item = (await this.sessions())[index];
      if (observation) {
        observation.session = ["queued", "running", "waiting", "done", "failed", "stopped"].indexOf(item?.status ?? "") + 1;
        this.terminalSummaryKind = sourceSummaryKind(item?.summary);
      }
      return status ? item?.status === status : !!item && ["done", "failed", "stopped"].includes(item.status);
    }, { timeout: 45_000 }).toBe(true);
    if (this.kind === "denied") this.phase = 17;
    if (observation) observation.stage = sourceTerminalStage.idle;
    await expect.poll(async () => {
      const turn = await this.home!.evaluate(() => window.ember.conversationTurn());
      if (observation) observation.turn = ["idle", "thinking", "slow", "held"].indexOf(turn) + 1;
      return turn;
    }, { timeout: 20_000 }).toBe("idle");
    if (observation) observation.stage = sourceTerminalStage.results;
  }
  async results(): Promise<CodingResultSummary[]> { return this.home!.evaluate(id => window.ember.codingResultsState(id), this.projectId); }
  assertUnchanged(): void {
    for (const [name, text] of Object.entries(this.originals)) expect(fs.readFileSync(path.join(this.source, name), "utf8")).toBe(text);
    for (const name of ["parent-counter", "child-counter", "hook-ran"]) expect(fs.existsSync(path.join(this.source, name))).toBe(false);
    expect(fs.readFileSync(path.join(this.root, "outside.txt"), "utf8")).toBe(outside); expect(fs.readFileSync(path.join(this.userData, "credential-canary.txt"), "utf8")).toBe(credential);
    const sent = JSON.stringify(this.model.requests);
    for (const marker of [outside, credential, environmentCanary, excludedGit, excludedDependency]) expect(sent).not.toContain(marker);
    expect(this.model.failures).toEqual([]);
    const allowed = this.kind.startsWith("public-") ? WSL_PUBLIC_PRODUCT_TOOLS : WSL_PRODUCT_TOOLS;
    for (const inventory of this.model.inventories) expect([...inventory].sort()).toEqual([...allowed].sort());
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

async function journey(kind: WslSourceCase, run: (fixture: Journey) => Promise<void>): Promise<void> {
  if (quarantined) throw refusal(kind, 1);
  let fixture: Journey | undefined, model: Model | undefined, root: string | undefined, failed = false, phase = 1;
  let refusedDetail: Readonly<{ episode: number; summaryKind: number; steps: number; command: number }> | undefined;
  let refusedTerminal: Readonly<SourceTerminalObservation> | undefined;
  let owned: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const owner: { root?: string; model?: Model; fixture?: Journey; owned?: Promise<void> } = {};
  retainedOwners.add(owner);
  try {
    const input = wslProductPreflight(required), parent = wslProductScratchParent();
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-wsl-product-source-"))); owner.root = root;
    model = await createWslProductModel(wslProductScenarios(kind), input.targetLabel); owner.model = model;
    fixture = new Journey(kind, root, model, input); owner.fixture = fixture;
    const current = fixture;
    owned = (async () => { await current.start(input); await run(current); expect(current.erased).toBe(true); })(); owner.owned = owned;
    // Leave time inside the test's own deadline for graceful shutdown, transport rejection and owned-work drainage.
    await Promise.race([owned, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(refusal(kind, current.phase)), kind === "public-repair" ? 240_000 : kind === "repair" ? 150_000 : kind === "denied" || kind === "public-denied" ? 90_000 : 120_000);
    })]);
  } catch {
    quarantined = true; failed = true; phase = fixture?.phase ?? phase;
    if (phase === 6 && fixture?.terminalObservation) {
      refusedTerminal = Object.freeze({ ...fixture.terminalObservation });
      if (model) refusedDetail = Object.freeze({ episode: refusedTerminal.episode, summaryKind: fixture.terminalSummaryKind, ...model.terminalEvidence(refusedTerminal.episode) });
    }
  }
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
  if (failed) {
    if (refusedTerminal) console.info("Windows WSL source terminal observation", JSON.stringify(refusedTerminal));
    if (refusedDetail) console.info("Windows WSL source terminal detail", JSON.stringify(refusedDetail));
    quarantined = true; throw refusal(kind, phase);
  }
  retainedOwners.delete(owner); quarantined = false;
  console.info("Windows WSL source journey passed", JSON.stringify({ schema: 1, case: WSL_PRODUCT_CASES.source.indexOf(kind) + 1, phase: 10 }));
}

async function openReview(f: Journey, result: CodingResultSummary): Promise<void> {
  f.phase = 7;
  const session = (await f.sessions()).find(item => item.taskId === result.taskId); expect(session).toBeDefined();
  await f.home!.locator('[data-session-review="' + session!.id + '"]').click();
  await expect.poll(() => f.home!.locator("#project-coding-review").isVisible()).toBe(true);
}
async function exportReview(f: Journey, publicDependencies: boolean, changed: boolean): Promise<{ directory: string; json: string }> {
  const before = new Set(fs.readdirSync(f.exported)), requests = f.model.requests.length;
  await f.home!.locator("#project-coding-export").click();
  await expect.poll(() => fs.readdirSync(f.exported).length, { timeout: 15_000 }).toBe(before.size + 1);
  const fresh = fs.readdirSync(f.exported).filter(name => !before.has(name)); expect(fresh).toHaveLength(1);
  const directory = path.join(f.exported, fresh[0]), json = fs.readFileSync(path.join(directory, "review.json"), "utf8"), review = JSON.parse(json);
  expect(review.purpose).toBe("review-only");
  for (const tree of [review.baseline, review.current]) for (const [name, text] of Object.entries(f.originals)) {
    expect(tree).toContainEqual(expect.objectContaining({ path: name, base64: Buffer.from(text).toString("base64") }));
  }
  for (const tree of [review.baseline, review.current, review.proposed]) for (const entry of tree) {
    expect(entry.path === ".git" || entry.path.startsWith(".git/") || entry.path === "node_modules" || entry.path.startsWith("node_modules/")).toBe(false);
  }
  expect(review.scope).toMatchObject({ executionProfile: publicDependencies ? "wsl-public-lock" : "wsl-offline", dependencies: null });
  if (publicDependencies) {
    const summary = expectedPublicSummary(changed);
    expect(review.scope.publicDependencies).toMatchObject({ access: "verified-offline-cache-input", registry: "https://registry.npmjs.org", packages: summary.packageCount,
      packageJsonSha256: summary.packageJsonSha256, lockSha256: summary.lockSha256, setSha256: summary.setSha256 });
    expect(review.scope.publicDependencies.compressedBytes).toBeGreaterThan(0);
  }
  for (const marker of [outside, credential, environmentCanary, excludedGit, excludedDependency]) {
    expect(json).not.toContain(marker); expect(json).not.toContain(Buffer.from(marker).toString("base64"));
  }
  expect(f.model.requests.length).toBe(requests); return { directory, json };
}
async function repair(f: Journey, publicDependencies: boolean): Promise<void> {
  const scenarios = wslProductScenarios(publicDependencies ? "public-repair" : "repair");
  await f.send(scenarios[0].request);
  if (publicDependencies) await f.dependencies(false, "baseline");
  await f.decide(); await f.decide();
  if (publicDependencies) { await f.dependencies(true, "changed"); await f.decide(); }
  await f.terminal(0, "done"); const first = (await f.results())[0];
  expect(first).toMatchObject({ status: "done", checks: { ran: publicDependencies ? 3 : 2, passed: publicDependencies ? 2 : 1, failed: 1 }, patchComplete: true });
  expect(f.approved[0].sha256).toBe(f.approved[1].sha256); expect(f.approved[0].n).not.toBe(f.approved[1].n);
  expect(JSON.stringify([...f.model.results.values()])).toContain("ERR_ASSERTION");
  await openReview(f, first); await expect.poll(() => f.home!.locator("#project-coding-patch").textContent()).toContain("'ready'");
  const exported = await exportReview(f, publicDependencies, publicDependencies);
  await f.home!.locator("#project-coding-continue").click(); await f.home!.locator("#project-coding-continue-request").fill(scenarios[1].request);
  await f.home!.locator("#project-coding-continue-send").click();
  if (publicDependencies) await f.dependencies(true, "baseline");
  await f.decide(); if (!publicDependencies) await f.decide();
  await f.terminal(1, "done"); const all = await f.results(); expect(all).toHaveLength(2);
  const continued = all.find(result => result.id !== first.id)!;
  expect(continued.taskId).not.toBe(first.taskId); expect(continued).toMatchObject({ status: "done", checks: { ran: publicDependencies ? 1 : 2, passed: publicDependencies ? 1 : 2, failed: 0 } });
  expect(f.approved.every(card => card.sha256 === f.approved[0].sha256)).toBe(true); expect(new Set(f.approved.map(card => card.n)).size).toBe(4);
  expect(f.publicApproved).toHaveLength(publicDependencies ? 3 : 0);
  if (publicDependencies) expect(f.publicApproved[0]).not.toBe(f.publicApproved[1]);
  expect(f.model.steps.get(scenarios[0].key)).toBe(publicDependencies ? 9 : 4); expect(f.model.steps.get(scenarios[1].key)).toBe(publicDependencies ? 4 : 5);
  await openReview(f, continued); await exportReview(f, publicDependencies, publicDependencies);
  await f.home!.locator('[data-forget-result="' + continued.id + '"]').click(); await expect.poll(async () => (await f.results()).length).toBe(1);
  await expect(f.home!.evaluate(id => window.ember.codingResultReview(id), continued.id)).rejects.toThrow("no longer available");
  expect((await f.home!.evaluate(id => window.ember.codingResultReview(id), first.id)).id).toBe(first.id);
  f.assertUnchanged(); await f.erase(); expect(fs.readFileSync(path.join(exported.directory, "review.json"), "utf8")).toBe(exported.json);
}
async function denied(f: Journey, publicDependencies: boolean): Promise<void> {
  const kind = publicDependencies ? "public-denied" : "denied";
  await f.send(wslProductScenarios(kind)[0].request);
  const command = publicDependencies ? undefined : await f.decide(WSL_PRODUCT_CHECK, "Not now");
  if (publicDependencies) await f.dependencies(false, "baseline", "Not now");
  await f.terminal(0); expect((await f.sessions())[0].status).not.toBe("done");
  const results = await f.results(); expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ status: "failed", checks: { ran: 0, passed: 0, failed: 0 } });
  if (command) expect(await command.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(value => value!.state.tabs.length))).toBe(0);
  expect(f.model.steps.get(kind)).toBe(1); expect(f.approved).toEqual([]); expect(f.publicApproved).toEqual([]); f.assertUnchanged(); await f.erase();
}
async function stopPendingDependencies(f: Journey): Promise<void> {
  await f.send(wslProductScenarios("public-denied")[0].request); await f.dependencies(false, "baseline", null);
  const session = (await f.sessions())[0]; expect(session.taskId).toBeTruthy();
  expect(await f.home!.evaluate(id => window.ember.taskControl(id, "stop"), session.taskId)).toBe(true);
  await f.terminal(0); expect((await f.sessions())[0].status).not.toBe("done");
  const results = await f.results(); expect(results).toHaveLength(1); expect(results[0].status).not.toBe("done"); expect(results[0].checks).toEqual({ ran: 0, passed: 0, failed: 0 });
  expect(f.model.steps.get("public-denied")).toBe(1); expect(f.approved).toEqual([]); expect(f.publicApproved).toEqual([]);
  f.assertUnchanged(); await f.erase();
}
async function writer(f: Journey, key: "stop" | "source" | "selection" | "mode" | "forget" | "account"): Promise<void> {
  const scenario = wslProductScenarios(key === "mode" || key === "forget" ? "revocation" : key).find(value => value.key === key)!;
  await f.send(scenario.request); await f.decide(WSL_PRODUCT_WRITER); await f.writerReady();
  f.phase = 8; const session = (await f.sessions())[0]; expect(session.taskId).toBeTruthy();
  if (key === "source") {
    await expect(f.home!.evaluate(id => window.ember.projectCodingWorkspaceForget(id), f.projectId)).rejects.toThrow("Stop this project's coding sessions before changing its folder.");
    expect((await f.home!.evaluate(id => window.ember.projectCodingWorkspaceState(id), f.projectId)).folder?.path).toBe(f.source);
    expect(await f.home!.evaluate(id => window.ember.taskControl(id, "stop"), session.taskId)).toBe(true);
    await f.terminal(0, "stopped");
  } else if (key === "selection") {
    // A per-project edit cannot race an accepted task; the existing command-off control is an actual revocation.
    await expect(f.home!.evaluate(id => window.ember.projectCodingExecutionChoose(id, "local"), f.projectId)).rejects.toThrow();
    await f.home!.evaluate(id => window.emberTargets!.act({ kind: "commands", id, on: false }), f.input.target);
    expect(await f.home!.evaluate(id => window.ember.getStatus().then(value => value.settings.commands[id]?.on), f.input.target)).toBe(false);
  } else if (key === "mode") {
    const before = await f.home!.evaluate(() => window.ember.getStatus().then(value => value.approvals?.inForce));
    const next: ApprovalMode = before === "interactive" ? "assisted" : "interactive";
    const reply = await f.home!.evaluate(({ next, version }) => window.ember.chooseMode(next, version), { next, version: modeCardVersion(next) }); expect(reply.ok).toBe(true);
  } else if (key === "forget") await f.home!.evaluate(() => window.ember.forgetAllMemory());
  else if (key === "account") await f.home!.evaluate(() => window.ember.signOut());
  else expect(await f.home!.evaluate(id => window.ember.taskControl(id, "stop"), session.taskId)).toBe(true);
  if (key === "forget" || key === "account") {
    expect(await f.home!.evaluate(() => window.ember.projectSessionsState())).toEqual({ projects: [], selectedProjectId: null }); expect(await f.results()).toEqual([]);
  } else {
    await f.terminal(0); expect((await f.sessions())[0].status).not.toBe("done");
    const results = await f.results(); expect(results).toHaveLength(1); expect(results[0].status).not.toBe("done"); expect(results[0].checks).toEqual({ ran: 0, passed: 0, failed: 0 });
  }
  await expect.poll(async () => {
    for (const page of f.app!.windows().filter(item => item.url().includes("/renderer/command/index.html"))) {
      if (!await page.evaluate(() => (window as Window & { emberCommands: CommandsApi }).emberCommands.pull().then(value => value?.state.tabs.every(tab => tab.ended) === true))) return false;
    }
    return true;
  }, { timeout: 15_000 }).toBe(true);
  if (key === "source") expect((await f.home!.evaluate(id => window.ember.projectCodingWorkspaceForget(id), f.projectId)).folder).toBeNull();
  expect(f.model.steps.get(key)).toBe(1); expect(f.approved).toHaveLength(1); f.assertUnchanged(); await f.erase();
}

for (const kind of WSL_PRODUCT_CASES.source) it.skipIf(!required)(wslProductTitle("source", kind), async () => {
  if (kind === "repair" || kind === "public-repair") return journey(kind, f => repair(f, kind === "public-repair"));
  if (kind === "denied") return journey(kind, f => denied(f, false));
  if (kind === "public-denied") { await journey(kind, f => denied(f, true)); await journey(kind, stopPendingDependencies); return; }
  if (kind === "revocation") { await journey(kind, f => writer(f, "mode")); await journey(kind, f => writer(f, "forget")); return; }
  return journey(kind, f => writer(f, kind));
}, kind === "public-repair" || kind === "public-denied" || kind === "revocation" ? 360_000 : 240_000);
