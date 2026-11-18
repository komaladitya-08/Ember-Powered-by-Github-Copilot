/** Shipped ZIP, ordinary native UI and fixed public programs only. No debugger, app injection or issuing-API replacement. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { expect } from "vitest";
import { readFuses, emberFuses, fuseMismatches } from "../../scripts/package/fuses.mjs";
import { verifyWindowsNodeToolchain } from "../../scripts/package/windows-node-toolchain.mjs";
import { verifyWslCodingTools, WSL_CODING_TOOLS } from "../../scripts/package/wsl-coding-tools.mjs";
import { openWin32Input } from "../../app/main/platform/win32/input";
import { titleOf } from "../../app/main/agent/tasks";
import { PublicNpmPlan } from "../../app/main/agent/public-npm-lock";
import { CONSENT_READ_HINT } from "../../app/renderer/prompt/copy";
import { UiaBridge, bridgeEnv, type RawNode } from "../integration/uia-client";
import { WslPackagedUi, wslUiId as id, wslUiName as named, sameWslUiNode, type WslUiSelector } from "./wsl-coding-packaged-uia";
import { wslProductRefusal } from "./wsl-coding-product-preflight";
import { createWslProductModel, wslProductScenarios, wslProductProject, WSL_PRODUCT_CHECK, WSL_PRODUCT_TOOLS, WSL_PUBLIC_PRODUCT_TOOLS } from "./wsl-coding-product-model";

export type WslPackagedModel = Awaited<ReturnType<typeof createWslProductModel>>;
const environmentCanary = "PACKAGED_WSL_HOST_ENVIRONMENT_MUST_STAY_LOCAL", outside = "PACKAGED_WSL_OUTSIDE_SOURCE_MUST_STAY_LOCAL";
const privateCanary = "gho_" + "Q".repeat(36), excludedGit = "PACKAGED_WSL_EXCLUDED_GIT", excludedDependency = "PACKAGED_WSL_EXCLUDED_NODE_MODULES";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const retainedUtilities = new Set<ChildProcess>();
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ordinary = (file: string) => { const value = fs.lstatSync(file); return value.isFile() && !value.isSymbolicLink() && value.nlink === 1; };
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(wslProductRefusal(40)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, ms: number, maximum = 1024 * 1024) {
  const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  retainedUtilities.add(child); child.once("close", () => retainedUtilities.delete(child));
  let stdout = "", stderr = 0, bad = false;
  const timer = setTimeout(() => { bad = true; child.kill(); }, ms);
  child.stdout.on("data", bytes => { if (stdout.length + bytes.length > maximum) { bad = true; child.kill(); } else stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes.length; if (stderr > maximum) { bad = true; child.kill(); } });
  try {
    const value = await bounded(new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", () => reject(wslProductRefusal(1))); child.once("close", (code, signal) => resolve({ code, signal }));
    }), ms + 5000);
    if (bad || value.code !== 0 || value.signal) throw wslProductRefusal(1);
    return stdout;
  } finally { clearTimeout(timer); }
}
function environment(temporary: string, profile: string, github: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (/^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES)$/i.test(name)) env[name] = value;
  return { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, EMBER_USER_DATA: profile, GH_CONFIG_DIR: github,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", EMBER_WSL_PRODUCT_HOST_CANARY: environmentCanary };
}

export class WslPackagedJourney {
  phase = 1;
  assertionsComplete = false;
  readonly key = "synthetic_packaged_wsl_" + randomUUID();
  readonly profile: string;
  readonly temporary: string;
  readonly exported: string;
  readonly source: string;
  readonly publicSource: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly deadline = Date.now() + 300_000;
  private input: ReturnType<typeof openWin32Input> = null;
  private bridge?: UiaBridge;
  private ui?: WslPackagedUi;
  private app?: ChildProcess;
  private appClosed?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private forced = false;
  private home = 0;
  private executable = "";
  private executableHash = "";
  private readonly assets: { path: string; sha256: string }[] = [];
  private previousCard = "";
  private projectStage = 0;
  /** Failure-only: which selection guard refused (1–13) times 16, plus the Down count so far (0–11); 0 when none did. */
  private selection = 0;
  private selectionStep = 0;
  /**
   * Failure-only, when no or several options read as selected: what the snapshot held under the combo. Descendants
   * (0–15, capped) + 16 × those with a selection-item pattern (0–15, capped) + 256 when the combo has a value pattern
   * + 512 × its expand state (0 none, 1 collapsed, 2 expanded, 3 other). Counts only: no names, values or identities.
   */
  private selectionShape = 0;
  private readonly privateFailures: unknown[] = [];
  private captured?: Readonly<{ phase: number; operation: number; bridgeStage: number; projectStage: number; selection: number; selectionShape: number }>;
  constructor(readonly root: string, readonly model: WslPackagedModel, readonly distro: string, readonly targetLabel: string) {
    this.profile = path.join(root, "profile"); this.temporary = path.join(root, "temporary"); this.exported = path.join(root, "exported");
    this.source = path.join(root, "source"); this.publicSource = path.join(root, "public-source");
    for (const dir of [this.profile, this.temporary, this.exported, path.join(root, "github"), path.join(root, "bridge-cache"), path.join(root, "extracted"), this.source, this.publicSource]) fs.mkdirSync(dir);
    for (const [base, data] of [[this.source, wslProductProject()], [this.publicSource, wslProductProject(true)]] as const) {
      for (const [name, text] of Object.entries(data)) { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
      for (const name of [".git", "node_modules"]) fs.mkdirSync(path.join(base, name));
      fs.writeFileSync(path.join(base, ".git/HEAD"), excludedGit); fs.writeFileSync(path.join(base, "node_modules/excluded.js"), excludedDependency);
    }
    fs.writeFileSync(path.join(root, "outside.txt"), outside); fs.writeFileSync(path.join(this.profile, "credential-canary.txt"), privateCanary);
    this.env = environment(this.temporary, this.profile, path.join(root, "github"));
  }
  private fail(): never { throw wslProductRefusal(this.phase); }
  private refuseSelection(guard: number): never { this.selection = guard * 16 + this.selectionStep; this.fail(); }
  private current(): void { if (this.stopped || this.forced || Date.now() >= this.deadline) this.fail(); }
  private get u(): WslPackagedUi { if (!this.ui) this.fail(); return this.ui; }
  capture(error?: unknown): void {
    if (this.captured) return; this.privateFailures.push(error);
    this.captured = Object.freeze({ phase: this.phase, operation: this.ui?.operation ?? 0, bridgeStage: this.bridge?.startupStage ?? 0, projectStage: this.phase === 6 ? this.projectStage : 0,
      selection: this.phase === 6 && this.projectStage === 15 ? this.selection : 0,
      selectionShape: this.phase === 6 && this.projectStage === 15 && (this.selection >> 4 === 7 || this.selection >> 4 === 8) ? this.selectionShape : 0 });
  }
  observation(): Readonly<{ phase: number; operation: number; bridgeStage: number; projectStage: number; selection: number; selectionShape: number }> | undefined { return this.captured; }
  private async pane(name: string): Promise<void> { await this.u.click(this.home, node => node.controlType === "Hyperlink" && node.name === name); }
  private async accessible(accepts: (value: string) => boolean, ms = 30_000): Promise<string> {
    const value = await this.u.until(async () => (await this.u.nodes(this.home)).filter(node => node.controlType === "Text" && !node.isPassword && typeof node.name === "string")
      .map(node => node.name!).find(text => { if (text.length > 32_000) this.fail(); return accepts(text); }), value => value !== undefined, ms);
    return value!;
  }
  private async idle(): Promise<void> {
    await this.pane("Home"); await this.accessible(text => text === "Ready", 45_000);
    await this.u.until(async () => this.model.requests.every((request: { doneAt?: number }) => typeof request.doneAt === "number"), Boolean);
    await this.pane("Projects");
  }
  private async armed(hwnd: number, select: WslUiSelector): Promise<void> {
    const before = await this.u.node(hwnd, select); await pause(600); this.current();
    if (!sameWslUiNode(before, await this.u.node(hwnd, select))) this.fail(); await this.u.click(hwnd, select);
  }
  async start(): Promise<void> {
    this.phase = 1;
    const selected = process.env.EMBER_WSL_CODING_PACKAGE;
    if (!selected || !path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== ".zip" || !ordinary(selected)) this.fail();
    const archive = fs.realpathSync.native(selected), systemRoot = Object.entries(this.env).find(([name]) => name.toLowerCase() === "systemroot")?.[1];
    if (!systemRoot) this.fail();
    const tar = path.join(systemRoot, "System32/tar.exe"), extracted = path.join(this.root, "extracted");
    const names = (await run(tar, ["-t", "-f", archive], this.env, 30_000, 16 * 1024 * 1024)).split(/\r?\n/).filter(Boolean);
    expect(names).toContain("Ember/Ember.exe"); expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    expect(names.every(name => name.startsWith("Ember/") && !name.includes("\\") && !name.includes(":") && !name.split("/").some(part => part === "." || part === ".."))).toBe(true);
    await run(tar, ["-x", "-f", archive, "-C", extracted], this.env, 45_000);
    this.executable = path.join(extracted, "Ember/Ember.exe"); const resources = path.join(extracted, "Ember/resources"), appRoot = path.join(resources, "app");
    expect(ordinary(this.executable)).toBe(true); expect(fuseMismatches(readFuses(fs.readFileSync(this.executable)), emberFuses("win32"))).toEqual([]);
    this.executableHash = hash(this.executable); expect(hash(path.join(appRoot, "dist/app/main.cjs"))).toBe(hash("dist/app/main.cjs"));
    expect(verifyWindowsNodeToolchain(path.join(resources, "coding/windows-node-x64")).files).toBe(3);
    const typescript = path.join(resources, "wsl-coding/typescript-5.9.3.tgz"); expect(verifyWslCodingTools(typescript).files).toBe(1);
    for (const name of ["node.exe", "LICENSE", "build-receipt.json"]) { const file = path.join(resources, "coding/windows-node-x64", name); this.assets.push({ path: file, sha256: hash(file) }); }
    this.assets.push({ path: typescript, sha256: hash(typescript) });
    for (const [name, size, digest] of [["LICENSE.txt", WSL_CODING_TOOLS.licenseBytes, WSL_CODING_TOOLS.licenseSha256],
      ["ThirdPartyNoticeText.txt", WSL_CODING_TOOLS.noticeBytes, WSL_CODING_TOOLS.noticeSha256]] as const) {
      const file = path.join(resources, "wsl-coding", name); expect(ordinary(file)).toBe(true); expect(fs.statSync(file).size).toBe(size); expect(hash(file)).toBe(digest);
      this.assets.push({ path: file, sha256: digest });
    }
    const script = path.join(resources, "sidecar/uia/ember_uia.ps1"); expect(ordinary(script)).toBe(true); expect(ordinary(path.join(resources, "sidecar/uia/ember_uia.cs"))).toBe(true);
    this.phase = 2; this.input = openWin32Input(); if (!this.input) this.fail();
    this.app = spawn(this.executable, ["--show-settings"], { cwd: path.dirname(this.executable), env: this.env, stdio: "ignore", windowsHide: false });
    this.appClosed = new Promise((resolve, reject) => { this.app!.once("error", () => reject(wslProductRefusal(2))); this.app!.once("close", (code, signal) => resolve({ code, signal })); }); void this.appClosed.catch(() => undefined);
    if (!this.app.pid) this.fail();
    this.watchdog = setTimeout(() => { this.forced = true; this.stopped = true; this.app?.kill(); }, 305_000);
    this.bridge = new UiaBridge(script, bridgeEnv(this.env, { EMBER_UIA_CACHE: path.join(this.root, "bridge-cache"), EMBER_UIA_STARTUP_OBSERVE: "1" }));
    await bounded(this.bridge.ready, 30_000);
    this.ui = new WslPackagedUi({ bridge: this.bridge, input: this.input, pid: this.app.pid, deadline: this.deadline, current: () => this.current(), refuse: () => wslProductRefusal(this.phase) });
    this.home = await this.u.until(async () => {
      for (const window of await this.u.windows()) if (window.name === "Ember") {
        const nodes = await this.u.nodes(window.hwnd);
        if (nodes.some(node => node.automationId === "w-next" || node.controlType === "Hyperlink" && node.name === "Projects")) return window.hwnd;
      }
      return 0;
    }, hwnd => hwnd !== 0, 45_000);
    await this.welcome(); await this.configureProvider(); await this.configureWsl();
  }
  private async welcome(): Promise<void> {
    this.phase = 3;
    for (let transition = 0; transition < 12; transition++) {
      const nodes = await this.u.nodes(this.home); if (nodes.some(node => node.controlType === "Hyperlink" && node.name === "Projects")) return;
      const next = nodes.find(id("w-next")), step = nodes.find(node => node.controlType === "Text" && /^Step \d+ of \d+$/.test(node.name ?? ""))?.name;
      if (!next || !step) this.fail();
      if (next.name === "Agree and continue") {
        let anchor = id("w-next");
        for (const row of ["memory", "voice", "screenshots", "interactive"]) {
          const select = id("w-row-" + row); await this.u.reveal(this.home, anchor, select, false, false); await this.u.toggle(this.home, select, "Off"); anchor = select;
        }
        await this.u.reveal(this.home, anchor, id("w-row-commands"), true, false); expect((await this.u.node(this.home, id("w-row-commands"), false)).patterns.toggle).toBe("On");
      }
      const skip = nodes.find(node => node.automationId === "w-alt" && node.name === "Skip for now" && node.isEnabled), selected = skip ?? next;
      expect(["Get started", "Agree and continue", "Skip for now", "Continue", "Continue anyway", "Start"]).toContain(selected.name);
      if (selected.name === "Agree and continue") await this.armed(this.home, id(selected.automationId!)); else await this.u.click(this.home, id(selected.automationId!));
      await this.u.until(() => this.u.nodes(this.home), fresh => fresh.some(node => node.controlType === "Hyperlink" && node.name === "Projects") || fresh.some(node => node.controlType === "Text" && /^Step \d+ of \d+$/.test(node.name ?? "") && node.name !== step));
    }
    this.fail();
  }
  private async configureProvider(): Promise<void> {
    this.phase = 4; await this.pane("Models & connections"); await this.u.click(this.home, id("byok-on"));
    await this.u.fill(this.home, id("byok-url"), this.model.baseUrl); await this.u.fill(this.home, id("byok-conductor"), "mock-model"); await this.u.fill(this.home, id("byok-worker"), "mock-model");
    await this.u.fill(this.home, id("byok-key"), this.key, true); await this.u.click(this.home, node => node.controlType === "Button" && node.name === "Save");
    await this.u.node(this.home, named("Key saved"), false); await this.armed(this.home, id("byok-yes")); await this.u.click(this.home, id("byok-test")); await this.idle();
    expect(fs.readFileSync(path.join(this.profile, "settings.json"), "utf8")).not.toContain(this.key);
  }
  private async prompt(title: string): Promise<void> {
    const window = (await this.u.until(() => this.u.windows(), windows => windows.some(window => window.name === "Ember needs you"), 20_000)).find(window => window.name === "Ember needs you")!;
    expect(await this.u.text(window.hwnd, id("title"))).toBe(title);
    const yes: WslUiSelector = node => node.controlType === "Button" && node.name === "Turn on" && node.isOffscreen === false && node.isEnabled === true;
    const scrollBody: WslUiSelector = node => node.automationId === "body" && node.isOffscreen === false && node.isEnabled === true && node.isKeyboardFocusable === true;
    const scrollHint: WslUiSelector = node => node.controlType === "Text" && node.name === CONSENT_READ_HINT && node.isOffscreen === false;
    // The window and its controls are reused when a different card reaches the front of the queue.
    const guard = (nodes: readonly RawNode[]) => {
      const headings = nodes.flatMap((node, index) => node.automationId === "title" && node.isOffscreen === false ? [index] : []);
      if (headings.length !== 1) this.fail();
      const [heading] = headings;
      if (nodes[heading].isPassword) this.fail();
      const name = nodes[heading].name;
      if (name) {
        if (name !== title) this.fail();
        return;
      }
      const visible = new Set([heading]);
      const words: string[] = [];
      // Snapshot parents precede their descendants. Read the whole visible heading subtree after the unnamed heading.
      for (const [index, node] of nodes.entries()) {
        if (!visible.has(node.parent ?? -1) || node.isOffscreen !== false || node.isPassword) continue;
        visible.add(index);
        if (node.controlType === "Text" && node.name) words.push(node.name);
      }
      if (words.length !== 1 || words[0] !== title) this.fail();
    };
    // A fitting card still disables Turn on while it arms. Only the card's read hint and a focusable body call for End.
    const ready = await this.u.until(async () => {
      const nodes = await this.u.nodes(window.hwnd);
      if (!nodes.length) return undefined;
      guard(nodes);
      if (nodes.some(yes)) return { body: undefined };
      const body = nodes.some(scrollHint) ? nodes.find(scrollBody) : undefined;
      return body ? { body } : undefined;
    }, value => value !== undefined);
    if (ready?.body) {
      const body = await this.u.focus(window.hwnd, ready.body);
      const nodes = await this.u.nodes(window.hwnd);
      guard(nodes);
      if (!nodes.some(yes) && nodes.some(scrollHint)) {
        if (!nodes.some(node => sameWslUiNode(node, body) && scrollBody(node) && node.hasKeyboardFocus === true)) this.fail();
        this.u.key(window.hwnd, "End");
      }
    }
    await this.u.click(window.hwnd, yes, guard); await this.u.until(() => this.u.windows(), windows => !windows.some(value => value.hwnd === window.hwnd));
  }
  private async configureWsl(): Promise<void> {
    this.phase = 5; await this.pane("Computers"); await this.u.click(this.home, id("wsl-on")); await this.prompt("Use Ember with WSL?");
    expect((await this.u.node(this.home, id("wsl-on"), false)).patterns.toggle).toBe("On");
    await this.pane("Commands"); const run = named("Run commands in " + this.targetLabel);
    await this.u.node(this.home, run, false); await this.u.click(this.home, run);
    await this.prompt("Let Ember run commands on " + this.targetLabel + "?");
    expect((await this.u.node(this.home, run, false)).patterns.toggle).toBe("On");
    const ask = named("Ask me before every command in " + this.targetLabel); await this.u.reveal(this.home, run, ask); await this.u.toggle(this.home, ask, "On");
    await this.idle();
  }
  private async folder(title: string, destination: string): Promise<void> {
    this.projectStage = 6; const dialog = (await this.u.until(() => this.u.windows(), windows => windows.some(window => window.name === title), 20_000)).find(window => window.name === title)!;
    this.projectStage = 7; if (!this.input || this.input.blockedReason?.(dialog.hwnd)) this.fail(); this.input.activate(dialog.hwnd);
    await this.u.until(async () => this.input!.activeWindow(), hwnd => hwnd === dialog.hwnd, 5000);
    this.projectStage = 8; this.u.chord(dialog.hwnd, "Alt_L", "d");
    try { this.u.type(dialog.hwnd, destination); this.u.key(dialog.hwnd, "Return"); }
    finally { this.input.releaseAll(); }
    this.projectStage = 9; await this.u.until(() => this.u.nodes(dialog.hwnd), nodes => nodes.some(node => (node.name ?? "").toLowerCase().includes(path.basename(destination).toLowerCase())));
    this.projectStage = 10; await this.u.click(dialog.hwnd, node => node.controlType === "Button" && /^Select Folder$/i.test(node.name ?? ""));
    this.projectStage = 11; await this.u.until(() => this.u.windows(), windows => !windows.some(window => window.hwnd === dialog.hwnd));
  }
  /**
   * The combo's one current choice. An open or listed drop-down names it by its single selected option. Chromium
   * lists nothing under a closed list (measured on both Windows images: no descendants, a value pattern, collapsed),
   * so there the choice is the combo's own value, read in the same snapshot.
   */
  private selectedWslOption(nodes: readonly RawNode[], combo: RawNode): { control: RawNode; option: RawNode; name: string } {
    const incomplete = (node: RawNode & { omitted?: boolean; childrenFailed?: boolean; childrenCut?: boolean }) =>
      node.gone || node.omitted || node.childrenFailed || node.childrenCut;
    const roots = nodes.flatMap((node, at) => sameWslUiNode(node, combo) ? [at] : []);
    if (roots.length !== 1) this.refuseSelection(roots.length ? 2 : 1);
    const [root] = roots, control = nodes[root];
    if (control.isEnabled !== true) this.refuseSelection(3);
    if (incomplete(control)) this.refuseSelection(4);
    const descendants = new Set([root]);
    const selected: RawNode[] = [];
    if (!nodes.some(node => node.parent === root) && control.patterns.expand === "Collapsed" && control.patterns.value) {
      const value = control.patterns.value.value;
      if (typeof value !== "string" || !value || control.isPassword || (control.patterns.value as { truncated?: boolean }).truncated) this.refuseSelection(13);
      return { control, option: control, name: value };
    }
    for (const [at, node] of nodes.entries()) {
      if (!descendants.has(node.parent ?? -1)) continue;
      if (incomplete(node)) this.refuseSelection(5);
      descendants.add(at);
      const item = node.patterns.selectionItem;
      if (!item) continue;
      if (typeof item.selected !== "boolean") this.refuseSelection(6);
      if (item.selected) selected.push(node);
    }
    if (selected.length !== 1) {
      const items = [...descendants].filter(at => at !== root && nodes[at].patterns?.selectionItem).length, expand = control.patterns?.expand;
      this.selectionShape = Math.min(descendants.size - 1, 15) + 16 * Math.min(items, 15) + (control.patterns?.value ? 256 : 0)
        + 512 * (expand === undefined ? 0 : expand === "Collapsed" ? 1 : expand === "Expanded" ? 2 : 3);
      this.refuseSelection(selected.length ? 8 : 7);
    }
    if (!selected[0].name || selected[0].isPassword) this.refuseSelection(9);
    return { control, option: selected[0], name: selected[0].name! };
  }
  private async chooseWslOption(combo: RawNode): Promise<RawNode> {
    const label = this.distro + " (WSL2)";
    for (let index = 0; index < 12; index++) {
      this.selectionStep = index;
      const { control, option, name } = this.selectedWslOption(await this.u.nodes(this.home, true), combo);
      if (name === label) {
        if (option.isEnabled !== true || !option.runtimeId || option.pid !== control.pid) this.refuseSelection(10);
        return option;
      }
      if (control.isOffscreen !== false) this.refuseSelection(11);
      if (control.hasKeyboardFocus !== true) this.refuseSelection(12);
      this.u.key(this.home, "Down");
    }
    this.fail();
  }
  private async commitWslOption(combo: RawNode, expected: RawNode): Promise<void> {
    await this.u.press(this.home, id("project-coding-execution-choose"), nodes => {
      const { option, name } = this.selectedWslOption(nodes, combo);
      if (!sameWslUiNode(option, expected) || name !== this.distro + " (WSL2)" || option.isEnabled !== true) this.fail();
    }, true);
  }
  async project(publicDependencies: boolean, suffix: string): Promise<void> {
    this.phase = 6; this.projectStage = 1; await this.pane("Projects");
    this.projectStage = 2; await this.u.fill(this.home, id("project-sessions-name"), "Packaged WSL " + suffix);
    this.projectStage = 3; await this.u.click(this.home, id("project-sessions-add"));
    this.projectStage = 4; await this.u.reveal(this.home, id("project-sessions-add"), id("project-coding-choose"));
    this.projectStage = 5; await this.u.press(this.home, id("project-coding-choose"));
    await this.folder("Choose a coding folder", publicDependencies ? this.publicSource : this.source);
    this.projectStage = 12; await this.accessible(text => text.includes(publicDependencies ? this.publicSource : this.source));
    const combo: WslUiSelector = node => node.automationId === "project-coding-execution-select" && node.controlType === "ComboBox";
    this.projectStage = 13; await this.u.reveal(this.home, id("project-coding-choose"), combo);
    this.projectStage = 14; const focusedCombo = await this.u.focus(this.home, await this.u.node(this.home, combo));
    if (focusedCombo.hasKeyboardFocus !== true) this.fail();
    this.u.key(this.home, "Home");
    this.projectStage = 15; this.selection = 0; this.selectionStep = 0; this.selectionShape = 0; const desired = await this.chooseWslOption(focusedCombo);
    this.projectStage = 16; await this.u.reveal(this.home, combo, id("project-coding-execution-choose"));
    this.projectStage = 17; await this.commitWslOption(focusedCombo, desired);
    this.projectStage = 18; await this.accessible(text => text.includes("isolated copy") && text.includes("offline"));
    const preference = id("project-coding-public-dependencies-on");
    // Home disables the commit button once its choice is the saved one, so the Tab search starts from the combo.
    this.projectStage = 19; await this.u.reveal(this.home, combo, preference);
    this.projectStage = 20; await this.u.toggle(this.home, preference, publicDependencies ? "On" : "Off");
    // UI Automation lists the hint's words as a Text node, not the paragraph that carries its id.
    this.projectStage = 21; expect(await this.accessible(text => text.includes("registry.npmjs.org"))).toContain("registry.npmjs.org"); expect(this.model.requests).toBeDefined();
  }
  async send(request: string): Promise<void> {
    this.projectStage = 22; await this.u.reveal(this.home, id("project-coding-public-dependencies-on"), id("project-sessions-request"), true);
    this.projectStage = 23; await this.u.fill(this.home, id("project-sessions-request"), request);
    this.projectStage = 24; await this.u.click(this.home, id("project-sessions-send"));
  }
  private async command(): Promise<number> { return (await this.u.until(() => this.u.windows(), windows => windows.some(window => window.name === "Ember commands"), 45_000)).find(window => window.name === "Ember commands")!.hwnd; }
  async allowCommand(): Promise<void> {
    this.phase = 7; const hwnd = await this.command();
    const node = (await this.u.until(() => this.u.nodes(hwnd), nodes => nodes.some(node => node.automationId === "ask-cmd" && !!node.runtimeId && node.runtimeId !== this.previousCard), 45_000)).find(id("ask-cmd"))!;
    await this.u.focus(hwnd, node); expect(await this.u.text(hwnd, id("ask-cmd"))).toBe(WSL_PRODUCT_CHECK);
    const words = (await this.u.nodes(hwnd)).map(node => node.name ?? "").join("\n");
    expect(words).toContain("/work"); expect(words).toContain(this.targetLabel); this.previousCard = node.runtimeId!;
    await this.u.click(hwnd, named("Allow"));
  }
  async publicDecision(changed: boolean, answer: "Allow" | "Not now" = "Allow"): Promise<void> {
    this.phase = 8; await this.pane("Home"); await this.u.click(this.home, id("tasks-open-approval"));
    const window = (await this.u.until(() => this.u.windows(), windows => windows.some(window => window.name === "Ember needs you"), 30_000)).find(window => window.name === "Ember needs you")!;
    expect(await this.u.text(window.hwnd, id("title"))).toBe("May I prepare public dependencies?");
    const data = wslProductProject(true, changed), expected = PublicNpmPlan.create({ packageJson: Buffer.from(data["package.json"]), packageLock: Buffer.from(data["package-lock.json"]) }).summary;
    const body = await this.u.text(window.hwnd, id("body")); expect(body).toContain(this.targetLabel); expect(body).toContain(expected.packageJsonSha256); expect(body).toContain(expected.lockSha256); expect(body).toContain(expected.setSha256);
    for (const pkg of expected.packages) expect(body).toContain(pkg.name + "@" + pkg.version);
    if (answer === "Allow") {
      if (!(await this.u.nodes(window.hwnd)).some(node => node.name === "Allow" && node.isEnabled)) { await this.u.focus(window.hwnd, await this.u.node(window.hwnd, id("body"), false)); this.u.key(window.hwnd, "End"); }
      await this.u.node(window.hwnd, node => node.name === "Allow" && node.isEnabled === true);
      // Whole-text completion starts a fresh Confirmer arm. The scroll that reveals it cannot also grant it.
      await pause(1600); this.current();
    }
    await this.u.click(window.hwnd, named(answer)); await this.pane("Projects");
  }
  private async review(goal: string, counts: string): Promise<string> {
    // A snapshot leaves out whatever is scrolled out of view, with everything under it, so the result's button is
    // listed only once it shows: ordinary Tab navigation from the request box above the Coding group brings it there.
    this.phase = 9; await this.pane("Projects"); const result = named("Review result: " + titleOf(goal));
    // Up to fifteen controls lie between the request box and the results, so the search goes by way of the Coding
    // group's folder button: twelve Tabs to it, twelve more from it.
    await this.u.reveal(this.home, id("project-sessions-request"), id("project-coding-choose"), false, false);
    await this.u.reveal(this.home, id("project-coding-choose"), result); await this.u.click(this.home, result);
    const region: WslUiSelector = node => node.automationId === "project-coding-review" || ["Group", "Pane"].includes(node.controlType ?? "") && node.name === titleOf(goal);
    return this.u.until(() => this.u.text(this.home, region), text => text.includes(counts), 45_000);
  }
  private assertUnchanged(): void {
    for (const [base, programs] of [[this.source, wslProductProject()], [this.publicSource, wslProductProject(true)]] as const) for (const [name, text] of Object.entries(programs)) expect(fs.readFileSync(path.join(base, name), "utf8")).toBe(text);
    expect(fs.readFileSync(path.join(this.root, "outside.txt"), "utf8")).toBe(outside); expect(fs.readFileSync(path.join(this.profile, "credential-canary.txt"), "utf8")).toBe(privateCanary);
  }
  private assertExport(folder: string, publicDependencies: boolean, cumulative: boolean): void {
    const json = fs.readFileSync(path.join(folder, "review.json"), "utf8"), found = { folder, json, data: JSON.parse(json) };
    expect(found.data.proposed.some((entry: { path: string; base64?: string }) => entry.path === "src/result.ts" && Buffer.from(entry.base64 ?? "", "base64").toString().includes(publicDependencies ? "picocolors" : "result: string"))).toBe(true);
    expect(found.data.proposed.some((entry: { path: string; base64?: string }) => entry.path === "test.cjs" && Buffer.from(entry.base64 ?? "", "base64").toString().includes(cumulative && !publicDependencies ? "continued WSL result" : "copied WSL result"))).toBe(true);
    if (publicDependencies) expect(found.data.proposed.some((entry: { path: string; base64?: string }) => entry.path === "package.json" && Buffer.from(entry.base64 ?? "", "base64").toString().includes("yocto-queue"))).toBe(true);
    expect(found.data.purpose).toBe("review-only");
    const originals = wslProductProject(publicDependencies);
    for (const tree of [found!.data.baseline, found!.data.current]) for (const [name, text] of Object.entries(originals)) {
      expect(tree).toContainEqual(expect.objectContaining({ path: name, base64: Buffer.from(text).toString("base64") }));
    }
    for (const tree of [found!.data.baseline, found!.data.current, found!.data.proposed]) {
      expect(tree.some((entry: { path: string }) => entry.path === "node_modules" || entry.path.startsWith("node_modules/") || entry.path === ".git" || entry.path.startsWith(".git/"))).toBe(false);
    }
    expect(found!.data.scope).toMatchObject({ executionProfile: publicDependencies ? "wsl-public-lock" : "wsl-offline", dependencies: null });
    if (publicDependencies) {
      const files = wslProductProject(true, true), expected = PublicNpmPlan.create({ packageJson: Buffer.from(files["package.json"]), packageLock: Buffer.from(files["package-lock.json"]) }).summary;
      expect(found!.data.scope.publicDependencies).toMatchObject({ access: "verified-offline-cache-input", registry: expected.registry,
        packages: expected.packageCount, packageJsonSha256: expected.packageJsonSha256, lockSha256: expected.lockSha256, setSha256: expected.setSha256 });
      expect(found!.data.scope.publicDependencies.compressedBytes).toBeGreaterThan(0);
    }
    const src = found!.data.proposed.find((entry: { path: string }) => entry.path === "src/result.ts"); expect(Buffer.from(src.base64, "base64").toString()).toContain("'ready'");
    expect(fs.readFileSync(path.join(found!.folder, "changes.patch"), "utf8")).toContain("'ready'");
    for (const value of [outside, privateCanary, environmentCanary, excludedGit, excludedDependency, this.key]) { expect(found!.json).not.toContain(value); expect(found!.json).not.toContain(Buffer.from(value).toString("base64")); }
    this.assertUnchanged();
  }
  private async exportReview(publicDependencies: boolean, cumulative: boolean): Promise<void> {
    await this.idle(); const before = this.model.requests.length, existing = new Set(fs.readdirSync(this.exported));
    await this.u.click(this.home, id("project-coding-export")); await this.folder("Export coding review", this.exported);
    await this.accessible(text => text.includes("Exported the coding review")); expect(this.model.requests.length).toBe(before);
    const fresh = fs.readdirSync(this.exported).filter(name => !existing.has(name)); expect(fresh).toHaveLength(1);
    this.assertExport(path.join(this.exported, fresh[0]), publicDependencies, cumulative);
  }
  private async continueWith(request: string): Promise<void> {
    await this.u.click(this.home, id("project-coding-continue")); await this.u.fill(this.home, id("project-coding-continue-request"), request); await this.u.click(this.home, id("project-coding-continue-send"));
  }
  async offline(): Promise<void> {
    const [first, next] = wslProductScenarios("repair"); await this.project(false, "offline"); await this.send(first.request); await this.allowCommand(); await this.allowCommand();
    expect(await this.review(first.goal, "Checks: 2 run, 1 passed, 1 failed")).toContain("Done ·"); expect(await this.u.text(this.home, id("project-coding-patch"))).toContain("'ready'"); await this.exportReview(false, false);
    await this.continueWith(next.request); await this.allowCommand(); await this.allowCommand(); expect(await this.review(next.goal, "Checks: 2 run, 2 passed, 0 failed")).toContain("Done ·"); await this.exportReview(false, true);
    expect(this.model.steps.get("repair")).toBe(4); expect(this.model.steps.get("continuation")).toBe(5); expect(JSON.stringify(this.model.results.get("repair"))).toContain("ERR_ASSERTION"); await this.forget();
  }
  async public(): Promise<void> {
    const [first, next] = wslProductScenarios("public-repair"); await this.project(true, "public"); await this.send(first.request); await this.publicDecision(false); await this.allowCommand(); await this.allowCommand();
    await this.publicDecision(true); await this.allowCommand(); expect(await this.review(first.goal, "Checks: 3 run, 2 passed, 1 failed")).toContain("Done ·"); await this.exportReview(true, false);
    await this.continueWith(next.request); await this.publicDecision(true); await this.allowCommand(); expect(await this.review(next.goal, "Checks: 1 run, 1 passed, 0 failed")).toContain("Done ·"); await this.exportReview(true, true);
    expect(this.model.steps.get("public-repair")).toBe(9); expect(this.model.steps.get("public-continuation")).toBe(4); await this.forget();
  }
  async denyPublic(): Promise<void> {
    const scenario = wslProductScenarios("public-denied")[0]; await this.project(true, "denied"); await this.send(scenario.request); await this.publicDecision(false, "Not now");
    expect(await this.review(scenario.goal, "Checks: 0 run, 0 passed, 0 failed")).toContain("Didn't finish ·"); expect(this.model.steps.get("public-denied")).toBe(1); await this.forget();
  }
  private async rolesEmpty(): Promise<void> {
    await this.u.until(async () => {
      const controllers = path.join(this.profile, "coding-controllers"); if (fs.existsSync(controllers) && fs.readdirSync(controllers).length) return false;
      const common = path.join(this.temporary, "ember-coding-unsupported");
      if (fs.existsSync(common)) for (const entry of fs.readdirSync(common)) {
        if (!/^process-[0-9a-f-]{36}$/.test(entry)) this.fail();
        for (const role of fs.readdirSync(path.join(common, entry))) { if (!["copies", "reviews", "assets"].includes(role)) this.fail(); if (fs.readdirSync(path.join(common, entry, role)).length) return false; }
      }
      return true;
    }, Boolean, 20_000);
  }
  private async forget(): Promise<void> {
    this.phase = 10; await this.idle();
    for (let removed = 0; removed < 4; removed++) {
      const nodes = await this.u.nodes(this.home), before = nodes.filter(node => (node.name ?? "").startsWith("Forget private result:")).length; if (!before) break;
      await this.u.click(this.home, node => (node.name ?? "").startsWith("Forget private result:")); await this.u.until(() => this.u.nodes(this.home), fresh => fresh.filter(node => (node.name ?? "").startsWith("Forget private result:")).length < before);
    }
    expect((await this.u.nodes(this.home)).some(node => (node.name ?? "").startsWith("Forget private result:"))).toBe(false);
    await this.u.click(this.home, id("project-coding-forget")); await this.accessible(text => text.includes("No coding folder selected")); await this.u.click(this.home, id("project-sessions-forget"));
    await this.u.until(() => this.u.nodes(this.home), nodes => nodes.some(node => node.automationId === "project-sessions-request" && node.isEnabled === false)); this.assertUnchanged(); await this.rolesEmpty();
  }
  async finish(): Promise<void> {
    this.phase = 11; this.assertUnchanged(); expect(this.model.failures).toEqual([]);
    for (const inventory of this.model.inventories) expect([[...WSL_PRODUCT_TOOLS].sort().join("|"), [...WSL_PUBLIC_PRODUCT_TOOLS].sort().join("|")]).toContain([...inventory].sort().join("|"));
    expect(this.model.inventories.some((list: readonly string[]) => list.includes("prepare_public_dependencies"))).toBe(true); expect(this.model.inventories.some((list: readonly string[]) => !list.includes("prepare_public_dependencies"))).toBe(true);
    expect(this.model.requests.every((request: { authorization: string | null }) => request.authorization === "Bearer " + this.key)).toBe(true);
    const messages = JSON.stringify(this.model.requests.map((request: { messages: unknown }) => request.messages)); for (const marker of [outside, privateCanary, environmentCanary, excludedGit, excludedDependency, this.key]) expect(messages).not.toContain(marker);
    await this.pane("Your Ember"); await this.u.click(this.home, id("p-quit")); expect(await bounded(this.appClosed!, 20_000)).toEqual({ code: 0, signal: null }); expect(this.forced).toBe(false);
    expect(hash(this.executable)).toBe(this.executableHash); for (const file of this.assets) expect(hash(file.path)).toBe(file.sha256);
    expect(fuseMismatches(readFuses(fs.readFileSync(this.executable)), emberFuses("win32"))).toEqual([]); this.assertionsComplete = true;
  }
  async close(): Promise<boolean> {
    clearTimeout(this.watchdog); let clean = this.assertionsComplete && !this.forced && retainedUtilities.size === 0;
    if (this.app && this.app.exitCode === null && this.app.signalCode === null) { this.stopped = true; this.forced = true; this.app.kill(); clean = false; }
    try { if (this.appClosed) { const result = await bounded(this.appClosed, 10_000); clean &&= result.code === 0 && result.signal === null; } } catch { clean = false; }
    try { this.input?.releaseAll(); this.input?.close(); } catch { clean = false; }
    try { if (this.bridge) { const result = await bounded(this.bridge.close(), 10_000); clean &&= result.code === 0; } } catch { this.bridge?.kill(); clean = false; }
    return clean;
  }
}
