/**
 * Actual shipped ZIP -> ordinary Windows UI -> Main/preloads/Host/SDK/native Node.
 * No debugger, app injection, development provider, test IPC or issuing-API replacement.
 * Required: EMBER_PACKAGED_WINDOWS_NODE_TEST=1 and EMBER_WINDOWS_NODE_PACKAGE=<absolute tested ZIP>.
 * Windows execution remains blocked by the independently reviewed producer/native proof prerequisites.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { readFuses, emberFuses, fuseMismatches } from "../../scripts/package/fuses.mjs";
import { verifyWindowsNodeToolchain, WINDOWS_NODE_TOOLCHAIN } from "../../scripts/package/windows-node-toolchain.mjs";
import { openWin32Input } from "../../app/main/platform/win32/input";
import { titleOf } from "../../app/main/agent/tasks";
import { UiaBridge, bridgeEnv, type RawNode, type UiaWindow } from "./uia-client";
import {
  createWindowsNodeProductModel, windowsNodeSourceScenarios, WINDOWS_NODE_REPAIR, WINDOWS_NODE_CONTINUATION,
  WINDOWS_NODE_TEST_ARGV, WINDOWS_NODE_WRITER_ARGV, WINDOWS_NODE_WRITER_READY, WINDOWS_NODE_PRODUCT_TOOLS,
  WINDOWS_NODE_SOURCE_ORIGINAL, WINDOWS_NODE_SOURCE_WRITER,
} from "../fixtures/windows-node-product-model";

const required = process.env.EMBER_PACKAGED_WINDOWS_NODE_TEST === "1";
const outside = "PACKAGED_NODE_OUTSIDE_MUST_STAY_LOCAL", privateCanary = "gho_" + "Q".repeat(36);
const excludedGit = "PACKAGED_NODE_EXCLUDED_GIT", excludedDependency = "PACKAGED_NODE_EXCLUDED_DEPENDENCY";
const environmentCanary = "PACKAGED_NODE_HOST_ENVIRONMENT_MUST_STAY_LOCAL", readme = "Unchanged packaged Node source fixture.\n";
let quarantined = false;
type Model = Awaited<ReturnType<typeof createWindowsNodeProductModel>>;
type Selector = (node: RawNode) => boolean;
const id = (value: string): Selector => node => node.automationId === value;
const named = (value: string): Selector => node => node.name === value;
// Bridge handles address one observation. UIA runtime IDs identify the same actual element across observations.
function sameNode(left: RawNode, right: RawNode): boolean {
  return !!left.runtimeId && Number.isSafeInteger(left.pid) && left.pid! > 0 && left.runtimeId === right.runtimeId && left.pid === right.pid
    && left.automationId === right.automationId && left.controlType === right.controlType;
}
function subtree(nodes: readonly RawNode[], select: Selector): RawNode[] {
  const root = nodes.findIndex(select); if (root < 0) return [];
  const included = new Set([root]), selected: RawNode[] = [];
  for (const [index, node] of nodes.entries()) if (index === root || included.has(node.parent ?? -1)) { included.add(index); selected.push(node); }
  return selected;
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function refusal(phase: number): Error {
  const error = new Error("Windows Node packaged journey refused (phase " + phase + ").");
  error.stack = "Error: " + error.message; return error;
}
function hash(file: string): string { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function ordinary(file: string): boolean { const info = fs.lstatSync(file); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; }
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(refusal(12)), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Raw process output stays local; the outer boundary emits only the fixed phase. */
async function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, ms: number, maximum = 1024 * 1024) {
  const child = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = 0, bad = false;
  const timer = setTimeout(() => { bad = true; child.kill(); }, ms);
  child.stdout.on("data", bytes => { if (stdout.length + bytes.length > maximum) { bad = true; child.kill(); } else stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes.length; if (stderr > maximum) { bad = true; child.kill(); } });
  try {
    const result = await bounded(new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", () => reject(refusal(1))); child.once("close", (code, signal) => resolve({ code, signal }));
    }), ms + 5000);
    if (bad || result.code !== 0 || result.signal) throw refusal(1);
    return stdout;
  } finally { clearTimeout(timer); }
}

interface PackagedObservation {
  operation: number; iteration: number; welcomeStep: number; nextLabel: number; target: number;
  bridgeError: number; snapshotFlags: number; focusFlags: number; inputResult: number; bridgeStage: number; projectStage: number;
  providerStage: number; commandStage: number; commandDecision: number; repairStep: number; repairResults: number; focusIdentity: number; cardFlags: number;
}
/**
 * Pure cached observations, never action/cleanup authority. Operation is the last marked existing operation, not proof it failed.
 * 1spawn/2bridge-ready/3windows/4snapshot/5Home-marker/6welcome/7next-step/8row/9toggle/10focus/11focused/
 * 12fresh-guard/13move/14down/15up/16arming/17transition/18label-or-limit; 0 is unmarked/cleanup.
 * Snapshot bits: busy1/truncated2/cut4/empty8. Focus bits: HWND1/element2/identity4/focused8 during a focus reply;
 * present1/onscreen2/bounds4/width8/height16 during the existing fresh guard. Input result is true1/false2/unknown0
 * from an existing input call or its existing state predicate. No raw identity, coordinate, text or error is retained.
 * For operation2 ONLY, bridgeError is: unknown0/outer-ready-timeout1/PowerShell-fatal2/CSharp-fatal3/pre-ready-exit4/other-first-JSON5.
 * For operations3/4 its existing UIA codes remain busy1/gone2/denied3/bad-request4/failed5.
 * Bridge stage0 is unknown;1..17 are PowerShell bootstrap milestones,18..25 are C# startup,26 is after source path construction,
 * and27/28 bracket only the initial source SHA chain;29 is after explicit system utility import,30 after assembly loading.
 * Project/folder stage0 is unknown;1pane/2name/3add/4choose/5folder-call/6source-text/7disclosure/8dialog-wait/
 * 9dialog-block-check/10dialog-activate/11dialog-foreground/12dialog-input/13destination-read/14select-folder/15dialog-closed/16project-return.
 * These are observed boundaries, not proof a later operation failed.
 * Provider stage1pane/2switch/3endpoint/4conversation-model/5worker-model/6key/7Save/8saved-read/9agreement/10test/11idle/12settings-read.
 * Command stage1pane/2local-read/3ask-read/4ask-toggle/5ask-check/6window/7new-display/8display-focus/9command-text/10cwd/
 * 11remember-display/12remember-tabs/13answer/14returned; decision1..8 counts only the existing decide calls.
 * Repair step/results0..4 are cached local fixture counts at the first failure, never tool output or execution evidence.
 * Focus identity bits: target-runtime1/returned-runtime2/runtime-match4/target-PID8/returned-PID16/PID-match32/known-string-automation-ID-match64/known-string-control-type-match128.
 * Card bits from an existing display poll: ask-cmd-present1/nonempty-runtime2/different-from-previous4/previous-recorded8.
 */
function packagedObservation() {
  const limits: PackagedObservation = { operation: 18, iteration: 12, welcomeStep: 6, nextLabel: 7, target: 7, bridgeError: 5, snapshotFlags: 15, focusFlags: 31, inputResult: 2, bridgeStage: 30, projectStage: 16, providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15 };
  const current: PackagedObservation = { operation: 0, iteration: 0, welcomeStep: 0, nextLabel: 0, target: 0, bridgeError: 0, snapshotFlags: 0, focusFlags: 0, inputResult: 0, bridgeStage: 0, projectStage: 0, providerStage: 0, commandStage: 0, commandDecision: 0, repairStep: 0, repairResults: 0, focusIdentity: 0, cardFlags: 0 };
  let captured = false, first: Readonly<PackagedObservation> | undefined;
  let decisions = 0;
  const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key); return property && Object.hasOwn(property, "value") ? property.value : undefined;
  };
  const update = (values: Partial<PackagedObservation>) => {
    try { for (const key of Object.keys(limits) as (keyof PackagedObservation)[]) {
      const value = own(values, key); if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= limits[key]) current[key] = value;
    } } catch { /* An observation cannot alter the operation being observed. */ }
  };
  return {
    update,
    decision() { try { decisions = Math.min(9, decisions + 1); update({ commandDecision: decisions <= 8 ? decisions : 0 }); } catch { /* The counter never controls a decision. */ } },
    card(value: unknown, previous: unknown) { try {
      const count = own(value, "length"); let flags = typeof previous === "string" && previous ? 8 : 0;
      if (!Array.isArray(value) || types.isProxy(value) || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 2000) { update({ cardFlags: 0 }); return; }
      for (let index = 0; index < count; index++) {
        const node = own(value, String(index)); if (own(node, "automationId") !== "ask-cmd") continue;
        const runtime = own(node, "runtimeId"), valid = typeof runtime === "string" && !!runtime;
        flags |= 1 | (valid ? 2 : 0) | (valid && runtime !== previous ? 4 : 0);
      }
      update({ cardFlags: flags });
    } catch { /* No new snapshot or runtime identity is retained. */ } },
    answer(value: unknown) { try {
      const error = own(own(value, "error"), "code"), result = own(value, "result"), cut = own(own(result, "cut"), "length"), count = own(own(result, "nodes"), "length");
      update({ bridgeError: ["busy", "gone", "denied", "bad_request", "failed"].indexOf(error as string) + 1,
        snapshotFlags: (own(result, "busy") === true ? 1 : 0) | (own(result, "truncated") === true ? 2 : 0) | (typeof cut === "number" && cut > 0 ? 4 : 0) | (count === 0 ? 8 : 0) });
    } catch { /* Cached malformed data remains unclassified. */ } },
    readyError(error: unknown) {
      let category = 0;
      try {
        if (error && typeof error === "object" && !types.isProxy(error) && types.isNativeError(error)) {
          const message = own(error, "message"), prefix = "the bridge did not start: ";
          if (message === "Windows Node packaged journey refused (phase 12).") category = 1;
          else if (typeof message === "string" && /^the bridge exited \((?:-?[0-9]{1,10}|null)\) before it was ready; stdout: /.test(message)) category = 4;
          else if (typeof message === "string" && message.startsWith(prefix) && message.length - prefix.length <= 8192) {
            const value: unknown = JSON.parse(message.slice(prefix.length));
            if (!types.isProxy(value)) {
              category = 5;
              if (value && typeof value === "object" && !Array.isArray(value)) {
                const dataOnly = ["fatal", "languageMode"].every(key => { const field = Object.getOwnPropertyDescriptor(value, key); return !field || Object.hasOwn(field, "value"); });
                if (!dataOnly) category = 0;
                else if (typeof own(value, "fatal") === "string") {
                  if (["FullLanguage", "ConstrainedLanguage", "RestrictedLanguage", "NoLanguage"].includes(own(value, "languageMode") as string)) category = 2;
                  else if (!Object.hasOwn(value, "languageMode")) category = 3;
                }
              }
            }
          }
        }
      } catch { category = 0; }
      update({ bridgeError: category });
    },
    windows(value: unknown) { try { update({ snapshotFlags: own(value, "length") === 0 ? 8 : 0 }); } catch { /* Never change the returned window list. */ } },
    node(value: unknown) { try {
      const selected = own(value, "automationId");
      const target = ["w-next", "w-alt", "w-row-memory", "w-row-voice", "w-row-screenshots", "w-row-interactive", "w-row-commands"].indexOf(selected as string) + 1;
      update({ target });
      if (target === 1 || target === 2) { const name = own(value, "name"); update({ nextLabel: typeof name === "string" ? ["Get started", "Agree and continue", "Skip for now", "Continue", "Continue anyway", "Start"].indexOf(name) + 1 || 7 : 0 }); }
    } catch { /* Never inspect unknown node accessors. */ } },
    step(value: unknown) { try { const match = typeof value === "string" ? /^Step ([1-6]) of 6$/.exec(value) : null; update({ welcomeStep: match ? Number(match[1]) : 0 }); } catch { /* No raw text is retained. */ } },
    focused(value: unknown, target: unknown, hwnd: number) { try {
      const element = own(value, "element"), pid = own(element, "pid"), runtime = own(element, "runtimeId");
      const targetRuntime = own(target, "runtimeId"), targetPid = own(target, "pid"), validRuntime = typeof runtime === "string" && !!runtime, validTargetRuntime = typeof targetRuntime === "string" && !!targetRuntime;
      const validPid = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0, validTargetPid = typeof targetPid === "number" && Number.isSafeInteger(targetPid) && targetPid > 0;
      update({ focusIdentity: (validTargetRuntime ? 1 : 0) | (validRuntime ? 2 : 0) | (validTargetRuntime && validRuntime && runtime === targetRuntime ? 4 : 0)
        | (validTargetPid ? 8 : 0) | (validPid ? 16 : 0) | (validTargetPid && validPid && pid === targetPid ? 32 : 0)
        | (typeof own(element, "automationId") === "string" && own(element, "automationId") === own(target, "automationId") ? 64 : 0)
        | (typeof own(element, "controlType") === "string" && own(element, "controlType") === own(target, "controlType") ? 128 : 0) });
      const same = typeof runtime === "string" && !!runtime && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && runtime === own(target, "runtimeId") && pid === own(target, "pid")
        && own(element, "automationId") === own(target, "automationId") && own(element, "controlType") === own(target, "controlType");
      update({ focusFlags: (own(value, "hwnd") === hwnd ? 1 : 0) | (element ? 2 : 0) | (same ? 4 : 0) | (own(element, "hasKeyboardFocus") === true ? 8 : 0) });
    } catch { /* The original focus predicate remains authoritative. */ } },
    fresh(value: unknown) { try {
      const bounds = own(value, "bounds"), width = own(bounds, "width"), height = own(bounds, "height");
      update({ focusFlags: (value ? 1 : 0) | (own(value, "isOffscreen") === false ? 2 : 0) | (bounds ? 4 : 0) | (typeof width === "number" && !(width <= 0) ? 8 : 0) | (typeof height === "number" && !(height <= 0) ? 16 : 0) });
    } catch { /* No new bounds or foreground queries. */ } },
    input<T>(value: T, rejection = false): T { try { update({ inputResult: typeof value === "boolean" ? (rejection ? !value : value) ? 1 : 2 : 0 }); } catch { /* Preserve the exact returned value. */ } return value; },
    capture() { if (captured) return; captured = true; try { first = Object.freeze({ ...current }); } catch { /* Do not retry with later cleanup state. */ } },
    value() { return first; },
  };
}

/** Keep the real OS profile for AppContainer creation, while excluding account credentials and injected loaders. */
function environment(temporary: string, userData: string, github: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES)$/i.test(key)) env[key] = value;
  return { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, EMBER_USER_DATA: userData, GH_CONFIG_DIR: github,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", EMBER_NODE_SOURCE_CANARY: environmentCanary };
}

class Journey {
  phase = 1;
  readonly source: string;
  readonly profile: string;
  readonly temporary: string;
  readonly exported: string;
  readonly env: NodeJS.ProcessEnv;
  readonly key = "synthetic_packaged_" + randomUUID();
  readonly replacementKey = "synthetic_rotated_" + randomUUID();
  private input: ReturnType<typeof openWin32Input> = null;
  readonly archive: string;
  executable = "";
  resources = "";
  appRoot = "";
  executableHash = "";
  private assets: readonly { path: string; sha256: string }[] = [];
  private app?: ChildProcess;
  private appClosed?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private bridge?: UiaBridge;
  private home = 0;
  private previousCard = "";
  private previousTabs = new Set<string>();
  private stopped = false;
  private forced = false;
  private deadline = Date.now() + 300_000;
  private watchdog?: ReturnType<typeof setTimeout>;
  private readonly observation = packagedObservation();
  private failureCaptured = false;
  assertionsComplete = false;
  private observe(values: Partial<PackagedObservation>): void { try { this.observation.update(values); } catch { /* Observation cannot change control flow. */ } }
  private observeInput<T>(value: T, rejection = false): T { try { this.observation.input(value, rejection); } catch { /* Preserve the exact result. */ } return value; }
  captureFailure(): void { if (this.failureCaptured) return; this.failureCaptured = true; try { this.observe({ repairStep: this.model.steps.get("repair") ?? 0, repairResults: this.model.results.get("repair")?.length ?? 0 }); } catch { /* Cached local fixture counts only. */ } try { this.observation.capture(); } catch { /* Never retry with later cleanup state. */ } }
  failureObservation(): Readonly<PackagedObservation> | undefined { try { return this.observation.value(); } catch { return undefined; } }
  constructor(readonly root: string, readonly model: Model) {
    const selected = process.env.EMBER_WINDOWS_NODE_PACKAGE;
    if (!selected || !path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== ".zip" || !ordinary(selected)) throw refusal(1);
    this.archive = fs.realpathSync.native(selected);
    this.source = path.join(root, "source"); this.profile = path.join(root, "profile"); this.temporary = path.join(root, "temporary"); this.exported = path.join(root, "exported");
    for (const directory of [this.source, this.profile, this.temporary, this.exported, path.join(root, "github"), path.join(root, "bridge-cache"), path.join(root, "extracted"), path.join(this.source, ".git"), path.join(this.source, "node_modules")]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(this.source, "test.cjs"), WINDOWS_NODE_SOURCE_ORIGINAL);
    fs.writeFileSync(path.join(this.source, "writer.cjs"), WINDOWS_NODE_SOURCE_WRITER);
    fs.writeFileSync(path.join(this.source, "README.txt"), readme);
    fs.writeFileSync(path.join(this.source, ".git/HEAD"), excludedGit);
    fs.writeFileSync(path.join(this.source, "node_modules/fixture.js"), excludedDependency);
    fs.writeFileSync(path.join(root, "outside.txt"), outside); fs.writeFileSync(path.join(this.profile, "credential-canary.txt"), privateCanary);
    // No settings, provider agreement, API-key store or commands agreement is pre-seeded.
    this.env = environment(this.temporary, this.profile, path.join(root, "github"));
  }
  private current(): void { if (this.stopped || this.forced || Date.now() >= this.deadline) throw refusal(this.phase); }
  private async until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Math.min(this.deadline, Date.now() + ms);
    while (Date.now() < end) { this.current(); const value = await read(); if (accepts(value)) return value; await pause(150); }
    throw refusal(this.phase);
  }
  private async windows(): Promise<UiaWindow[]> {
    this.current();
    this.observe({ operation: 3, bridgeError: 0, snapshotFlags: 0 });
    const answer = await this.bridge!.request("topWindows", { pid: this.app!.pid, deadlineMs: 3000 }, 5000);
    try { this.observation.answer(answer); } catch { /* Do not change the bridge response. */ }
    if (answer.error?.code === "busy" || answer.error?.code === "gone") return [];
    if (answer.error) throw refusal(this.phase);
    const windows = (answer.result as { windows: UiaWindow[] }).windows.filter(window => window.pid === this.app!.pid && !window.busy && !window.skipped);
    try { this.observation.windows(windows); } catch { /* Preserve the exact returned array. */ } return windows;
  }
  private async nodes(hwnd: number): Promise<RawNode[]> {
    this.current();
    this.observe({ operation: 4, bridgeError: 0, snapshotFlags: 0 });
    const answer = await this.bridge!.request("snapshot", { hwnd, values: false, maxNodes: 2000, maxChildren: 500, deadlineMs: 3000 }, 5000);
    try { this.observation.answer(answer); } catch { /* Do not change snapshot admission. */ }
    if (answer.error?.code === "busy" || answer.error?.code === "gone") return [];
    if (answer.error) throw refusal(this.phase);
    const result = answer.result as { nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] };
    if (result.busy) return [];
    if (result.truncated || result.cut.length || !result.nodes.length) throw refusal(this.phase);
    return result.nodes;
  }
  private async node(hwnd: number, select: Selector, enabled = true): Promise<RawNode> {
    const found = await this.until(async () => (await this.nodes(hwnd)).find(node => select(node) && (!enabled || node.isEnabled === true)), value => !!value);
    return found!;
  }
  private async text(hwnd: number, select: Selector): Promise<string> {
    const node = await this.node(hwnd, select, false); if (node.isPassword) throw refusal(this.phase);
    const result = await this.bridge!.call<{ text?: string; secret?: boolean; truncated?: boolean }>("textInfo", { handle: node.h, maxChars: 32_000, deadlineMs: 2500 }, 5000);
    if (result.secret || result.truncated) throw refusal(this.phase);
    if (result.text) return result.text;
    // A paragraph/group may expose only descendant StaticText. Read this exact subtree, never the whole document.
    const snapshot = await this.bridge!.call<{ nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] }>("snapshot", { handle: node.h, values: false, maxNodes: 500, maxChildren: 500, deadlineMs: 2500 }, 5000);
    if (snapshot.busy || snapshot.truncated || snapshot.cut.length) throw refusal(this.phase);
    const blocked = new Set<number>(), texts: string[] = [];
    for (const [index, child] of snapshot.nodes.entries()) {
      if (child.isPassword || blocked.has(child.parent ?? -1)) { blocked.add(index); continue; }
      if (child.controlType === "Text" && child.name) texts.push(child.name);
    }
    const text = texts.join("\n"); if (text.length > 32_000) throw refusal(this.phase);
    return text || node.name || "";
  }
  private async focus(hwnd: number, node: RawNode): Promise<RawNode> {
    this.observe({ operation: 10, focusFlags: 0, inputResult: 0, focusIdentity: 0 }); try { this.observation.node(node); } catch { /* Cached target only. */ }
    if (!this.input || this.input.blockedReason?.(hwnd)) throw refusal(this.phase);
    this.observeInput(this.input.activate(hwnd));
    await this.bridge!.call("perform", { handle: node.h, op: "focus", deadlineMs: 2500 }, 5000);
    this.observe({ operation: 11, focusFlags: 0 });
    await this.until(() => this.bridge!.call<{ element: RawNode | null; hwnd: number | null }>("focused", { values: false, deadlineMs: 2500 }, 5000),
      result => { try { this.observation.focused(result, node, hwnd); } catch { /* Preserve the original predicate. */ }
        return result.hwnd === hwnd && !!result.element && sameNode(result.element, node) && result.element.hasKeyboardFocus === true; }, 10_000);
    const fresh = (await this.nodes(hwnd)).find(value => sameNode(value, node));
    this.observe({ operation: 12 }); try { this.observation.fresh(fresh); } catch { /* Cached guard fields only. */ }
    if (!fresh || fresh.isOffscreen || !fresh.bounds || fresh.bounds.width <= 0 || fresh.bounds.height <= 0 || this.observeInput(this.input.activeWindow() !== hwnd, true)) throw refusal(this.phase);
    return fresh;
  }
  private pressKey(name: string): void {
    const key = this.input!.keysymOf(name); if (!key) throw refusal(this.phase);
    try { if (!this.input!.keysym(key, true)) throw refusal(this.phase); } finally { this.input!.keysym(key, false); }
  }
  private chord(modifier: string, key: string): void {
    const symbol = this.input!.keysymOf(modifier); if (!symbol || !this.input!.keysym(symbol, true)) throw refusal(this.phase);
    try { this.pressKey(key); } finally { this.input!.keysym(symbol, false); }
  }
  private type(value: string): void {
    if (!this.input?.textKey) throw refusal(this.phase);
    for (const character of value) { this.current(); if (!this.input.textKey(character, true) || !this.input.textKey(character, false)) throw refusal(this.phase); }
  }
  private async click(hwnd: number, select: Selector): Promise<void> {
    const node = await this.focus(hwnd, await this.node(hwnd, select)), box = node.bounds!;
    this.observe({ operation: 13, inputResult: 0 }); this.observeInput(this.input!.move(box.x + Math.floor(box.width / 2), box.y + Math.floor(box.height / 2)));
    try { this.observe({ operation: 14, inputResult: 0 }); this.observeInput(this.input!.button(1, true)); }
    catch (error) { this.captureFailure(); throw error; }
    finally { this.observe({ operation: 15, inputResult: 0 }); this.observeInput(this.input!.button(1, false)); this.input!.releaseAll(); }
  }
  private async fill(hwnd: number, select: Selector, value: string, password = false): Promise<void> {
    const node = await this.focus(hwnd, await this.node(hwnd, select));
    if (!!node.isPassword !== password) throw refusal(this.phase);
    try { this.chord("Control_L", "a"); this.type(value); this.pressKey("Tab"); } finally { this.input!.releaseAll(); }
  }
  private async homeText(select: Selector): Promise<string> { return this.text(this.home, select); }
  private async accessibleText(accepts: (value: string) => boolean, ms = 30_000): Promise<string> {
    const found = await this.until(async () => (await this.nodes(this.home)).filter(node => node.controlType === "Text" && !node.isPassword && typeof node.name === "string")
      .map(node => node.name!).find(value => { if (value.length > 32_000) throw refusal(this.phase); return accepts(value); }), value => value !== undefined, ms);
    return found!;
  }
  private async idle(): Promise<void> {
    await this.pane("Home"); await this.accessibleText(text => text === "Ready", 45_000);
    await this.until(async () => this.model.requests.every((request: { doneAt?: number }) => typeof request.doneAt === "number"), Boolean);
    await this.pane("Projects");
  }
  private async pane(name: string): Promise<void> { await this.click(this.home, node => node.controlType === "Hyperlink" && node.name === name); }
  private async armed(hwnd: number, select: Selector): Promise<void> {
    const before = await this.node(hwnd, select); this.observe({ operation: 16 }); await pause(600); this.current();
    if (!sameNode(await this.node(hwnd, select), before)) throw refusal(this.phase);
    await this.click(hwnd, select);
  }
  /** UIA does not descend an offscreen group: reveal Home controls with ordinary forward or reverse Tab navigation. */
  private async revealHomeControl(select: Selector, enabled = true, backwards = false): Promise<RawNode> {
    this.current();
    if (!this.input || this.input.blockedReason?.(this.home)) throw refusal(this.phase);
    this.input.activate(this.home);
    if (this.input.activeWindow() !== this.home) throw refusal(this.phase);
    let tabs = 0;
    return this.until(async () => {
      const found = (await this.nodes(this.home)).find(node => select(node) && node.isOffscreen === false && (!enabled || node.isEnabled === true));
      if (found) return found;
      this.current();
      if (++tabs > 12 || this.input!.blockedReason?.(this.home) || this.input!.activeWindow() !== this.home) throw refusal(this.phase);
      try { if (backwards) this.chord("Shift_L", "Tab"); else this.pressKey("Tab"); } finally { this.input!.releaseAll(); }
      return undefined;
    }, value => !!value).then(value => value!);
  }
  async start(): Promise<void> {
    this.phase = 1;
    expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
    // The old three-patch asset cannot certify the supported POSIX product milestone.
    expect(WINDOWS_NODE_TOOLCHAIN.producerRun).not.toBe(43858256344);
    this.input = openWin32Input(); expect(this.input).not.toBeNull();
    const systemRoot = Object.entries(this.env).find(([key]) => key.toLowerCase() === "systemroot")?.[1]; if (!systemRoot) throw refusal(1);
    const tar = path.join(systemRoot, "System32/tar.exe"), extracted = path.join(this.root, "extracted");
    const names = (await run(tar, ["-t", "-f", this.archive], this.env, 30_000, 16 * 1024 * 1024)).split(/\r?\n/).filter(Boolean);
    expect(names).toContain("Ember/Ember.exe"); expect(new Set(names.map(name => name.toLowerCase())).size).toBe(names.length);
    expect(names.every(name => name.startsWith("Ember/") && !name.includes("\\") && !name.includes(":") && !name.split("/").some(part => part === ".." || part === "."))).toBe(true);
    await run(tar, ["-x", "-f", this.archive, "-C", extracted], this.env, 45_000);
    this.executable = path.join(extracted, "Ember/Ember.exe"); this.resources = path.join(extracted, "Ember/resources"); this.appRoot = path.join(this.resources, "app");
    expect(ordinary(this.executable)).toBe(true); expect(fuseMismatches(readFuses(fs.readFileSync(this.executable)), emberFuses("win32"))).toEqual([]);
    this.executableHash = hash(this.executable);
    expect(hash(path.join(this.appRoot, "dist/app/main.cjs"))).toBe(hash(path.join(process.cwd(), "dist/app/main.cjs")));
    expect(verifyWindowsNodeToolchain(path.join(this.resources, "coding/windows-node-x64")).files).toBe(3);
    this.assets = ["node.exe", "LICENSE", "build-receipt.json"].map(name => { const file = path.join(this.resources, "coding/windows-node-x64", name); return { path: file, sha256: hash(file) }; });
    const script = path.join(this.resources, "sidecar/uia/ember_uia.ps1");
    expect(ordinary(script)).toBe(true); expect(ordinary(path.join(this.resources, "sidecar/uia/ember_uia.cs"))).toBe(true);
    this.phase = 2;
    this.observe({ operation: 1 });
    this.app = spawn(this.executable, ["--show-settings"], { cwd: path.dirname(this.executable), env: this.env, stdio: "ignore", windowsHide: false });
    this.appClosed = new Promise((resolve, reject) => { this.app!.once("error", () => reject(refusal(2))); this.app!.once("close", (code, signal) => resolve({ code, signal })); });
    void this.appClosed.catch(() => undefined);
    if (!this.app.pid) throw refusal(2);
    this.watchdog = setTimeout(() => { this.forced = true; this.stopped = true; this.app?.kill(); }, 305_000);
    this.bridge = new UiaBridge(script, bridgeEnv(this.env, { EMBER_UIA_CACHE: path.join(this.root, "bridge-cache"), EMBER_UIA_STARTUP_OBSERVE: "1" }));
    this.observe({ operation: 2, bridgeError: 0 });
    try { await bounded(this.bridge.ready, 30_000); }
    catch (error) {
      try { this.observe({ bridgeStage: this.bridge.startupStage }); } catch { /* Only cached stderr is inspected; keep the original ready failure. */ }
      try { this.observation.readyError(error); } catch { /* Classification never replaces the same ready failure. */ }
      this.captureFailure(); throw error;
    }
    await this.until(async () => {
      for (const window of await this.windows()) if (window.name === "Ember") {
        const nodes = await this.nodes(window.hwnd);
        this.observe({ operation: 5 });
        if (nodes.some(node => node.automationId === "w-next" || (node.controlType === "Hyperlink" && node.name === "Projects"))) return window.hwnd;
      }
      return 0;
    }, hwnd => { if (hwnd) this.home = hwnd; return !!hwnd; }, 45_000);
    await this.welcome(); await this.configureProvider(); await this.configureCommands();
  }
  private async welcome(): Promise<void> {
    this.phase = 3;
    for (let transition = 0; transition < 12; transition++) {
      this.observe({ iteration: transition + 1, welcomeStep: 0, nextLabel: 0, target: 0 });
      const nodes = await this.nodes(this.home);
      this.observe({ operation: 6 });
      if (nodes.some(node => node.controlType === "Hyperlink" && node.name === "Projects")) return;
      this.observe({ operation: 7, target: 1 });
      const next = nodes.find(id("w-next")); try { this.observation.node(next); } catch { /* Cached welcome controls only. */ } if (!next) throw refusal(3);
      const step = nodes.find(node => node.controlType === "Text" && /^Step \d+ of \d+$/.test(node.name ?? ""))?.name;
      if (!step) throw refusal(3);
      try { this.observation.step(step); } catch { /* No text is retained. */ }
      if (next.name === "Agree and continue") {
        for (const row of ["memory", "voice", "screenshots", "interactive"]) {
          this.observe({ operation: 8, target: ["memory", "voice", "screenshots", "interactive"].indexOf(row) + 3 });
          const field = await this.revealHomeControl(id("w-row-" + row), false);
          this.observe({ operation: 8 });
          if (field.patterns.toggle === "On" && field.isEnabled) await this.click(this.home, id("w-row-" + row));
          const checked = await this.node(this.home, id("w-row-" + row), false); this.observe({ operation: 9 });
          const toggle = checked.patterns.toggle; this.observeInput(toggle === "Off"); expect(toggle).toBe("Off");
        }
        this.observe({ target: 7 }); const checked = await this.revealHomeControl(id("w-row-commands"), true, true); this.observe({ operation: 9 });
        const toggle = checked.patterns.toggle; this.observeInput(toggle === "On"); expect(toggle).toBe("On");
      }
      const skip = nodes.find(node => node.automationId === "w-alt" && node.name === "Skip for now" && node.isEnabled);
      const selected = skip ?? next;
      this.observe({ operation: 18 }); try { this.observation.node(selected); } catch { /* Cached selected control only. */ }
      expect(["Get started", "Agree and continue", "Skip for now", "Continue", "Continue anyway", "Start"]).toContain(selected.name);
      if (selected.name === "Agree and continue") await this.armed(this.home, id(selected.automationId!));
      else await this.click(this.home, id(selected.automationId!));
      this.observe({ operation: 17 }); await this.until(() => this.nodes(this.home), fresh => { this.observe({ operation: 17 }); return fresh.some(node => node.controlType === "Hyperlink" && node.name === "Projects")
        || fresh.some(node => node.controlType === "Text" && /^Step \d+ of \d+$/.test(node.name ?? "") && node.name !== step); });
    }
    this.observe({ operation: 18 }); throw refusal(3);
  }
  private async configureProvider(): Promise<void> {
    this.phase = 4; this.observe({ providerStage: 1 }); await this.pane("Models & connections");
    this.observe({ providerStage: 2 }); await this.click(this.home, id("byok-on"));
    this.observe({ providerStage: 3 }); await this.fill(this.home, id("byok-url"), this.model.baseUrl);
    this.observe({ providerStage: 4 }); await this.fill(this.home, id("byok-conductor"), "mock-model"); this.observe({ providerStage: 5 }); await this.fill(this.home, id("byok-worker"), "mock-model");
    this.observe({ providerStage: 6 }); await this.fill(this.home, id("byok-key"), this.key, true); this.observe({ providerStage: 7 }); await this.click(this.home, node => node.controlType === "Button" && node.name === "Save");
    this.observe({ providerStage: 8 }); await this.node(this.home, named("Key saved"), false); this.observe({ providerStage: 9 }); await this.armed(this.home, id("byok-yes"));
    this.observe({ providerStage: 10 }); await this.click(this.home, id("byok-test"));
    this.observe({ providerStage: 11 }); await this.idle();
    this.observe({ providerStage: 12 }); expect(fs.readFileSync(path.join(this.profile, "settings.json"), "utf8")).not.toContain(this.key);
  }
  private async configureCommands(): Promise<void> {
    this.observe({ commandStage: 1 }); await this.pane("Commands");
    this.observe({ commandStage: 2 }); expect((await this.node(this.home, named("Run commands on this computer"), false)).patterns.toggle).toBe("On");
    this.observe({ commandStage: 3 }); const ask = named("Ask me before every command on this computer"), node = await this.node(this.home, ask, false);
    if (node.patterns.toggle === "Off" && node.isEnabled) { this.observe({ commandStage: 4 }); await this.click(this.home, ask); }
    this.observe({ commandStage: 5 }); expect((await this.node(this.home, ask, false)).patterns.toggle).toBe("On");
  }
  private async folder(title: string, destination: string): Promise<void> {
    this.observe({ projectStage: 8 }); const dialog = (await this.until(() => this.windows(), windows => windows.some(window => window.name === title), 20_000)).find(window => window.name === title)!;
    this.observe({ projectStage: 9 }); if (!this.input || this.input.blockedReason?.(dialog.hwnd)) throw refusal(this.phase);
    this.observe({ projectStage: 10 }); this.input.activate(dialog.hwnd);
    this.observe({ projectStage: 11 }); await this.until(async () => this.input!.activeWindow(), hwnd => hwnd === dialog.hwnd, 5000);
    this.observe({ projectStage: 12 }); try { this.chord("Alt_L", "d"); this.type(destination); this.pressKey("Return"); } finally { this.input.releaseAll(); }
    // Inspect the actual dialog after navigation; no hard-coded control ID or simulated dialog result.
    this.observe({ projectStage: 13 }); await this.until(() => this.nodes(dialog.hwnd), nodes => nodes.some(node => (node.name ?? "").toLowerCase().includes(path.basename(destination).toLowerCase())));
    this.observe({ projectStage: 14 }); await this.click(dialog.hwnd, node => node.controlType === "Button" && /^Select Folder$/i.test(node.name ?? ""));
    this.observe({ projectStage: 15 }); await this.until(() => this.windows(), windows => !windows.some(window => window.hwnd === dialog.hwnd));
  }
  async project(name: string): Promise<void> {
    this.phase = 5; this.observe({ projectStage: 1 }); await this.pane("Projects");
    this.observe({ projectStage: 2 }); await this.fill(this.home, id("project-sessions-name"), "Packaged Node " + name); this.observe({ projectStage: 3 }); await this.click(this.home, id("project-sessions-add"));
    this.observe({ projectStage: 4 }); await this.revealHomeControl(id("project-coding-choose")); await this.click(this.home, id("project-coding-choose")); this.observe({ projectStage: 5 }); await this.folder("Choose a coding folder", this.source);
    this.observe({ projectStage: 6 }); await this.accessibleText(text => text.includes(this.source));
    this.observe({ projectStage: 7 }); await this.accessibleText(text => text.includes("Shells, npm, dependency installation, network access and child processes are unavailable")); this.observe({ projectStage: 16 });
  }
  async send(request: string): Promise<void> { await this.revealHomeControl(id("project-sessions-request"), true, true); await this.fill(this.home, id("project-sessions-request"), request); await this.click(this.home, id("project-sessions-send")); }
  private async command(): Promise<number> { return (await this.until(() => this.windows(), windows => windows.some(window => window.name === "Ember commands"), 45_000)).find(window => window.name === "Ember commands")!.hwnd; }
  async decide(argv: readonly string[], answer: "Allow" | "Not now" = "Allow"): Promise<void> {
    this.phase = 6; try { this.observation.decision(); } catch { /* Count only this existing call. */ } this.observe({ commandStage: 6, cardFlags: 0 }); const hwnd = await this.command();
    this.observe({ commandStage: 7 });
    const display = (await this.until(() => this.nodes(hwnd), nodes => { try { this.observation.card(nodes, this.previousCard); } catch { /* Cached poll only. */ } return nodes.some(node => node.automationId === "ask-cmd" && !!node.runtimeId && node.runtimeId !== this.previousCard); }, 45_000)).find(id("ask-cmd"))!;
    this.observe({ commandStage: 8 }); await this.focus(hwnd, display);
    this.observe({ commandStage: 9 }); expect(await this.text(hwnd, id("ask-cmd"))).toBe("Node arguments: " + JSON.stringify(argv));
    this.observe({ commandStage: 10 }); expect((await this.nodes(hwnd)).map(node => node.name ?? "").join("\n")).toContain("\\work");
    this.observe({ commandStage: 11 }); this.previousCard = display.runtimeId!;
    this.observe({ commandStage: 12 }); this.previousTabs = new Set((await this.nodes(hwnd)).filter(node => node.controlType === "TabItem" && node.runtimeId).map(node => node.runtimeId!));
    this.observe({ commandStage: 13 }); await this.click(hwnd, named(answer)); this.observe({ commandStage: 14 });
  }
  private async review(goal: string, counts: string): Promise<string> {
    this.phase = 7; await this.pane("Projects");
    await this.revealHomeControl(id("project-coding"), false); await this.revealHomeControl(named("Review result: " + titleOf(goal)));
    await this.click(this.home, named("Review result: " + titleOf(goal)));
    const region: Selector = node => node.automationId === "project-coding-review" || (["Group", "Pane"].includes(node.controlType ?? "") && node.name === titleOf(goal));
    return this.until(() => this.homeText(region), text => text.includes(counts), 45_000);
  }
  private assertExport(cumulative: boolean): void {
    const directories = fs.readdirSync(this.exported); expect(directories).toHaveLength(cumulative ? 2 : 1);
    const newest = directories.map(name => path.join(this.exported, name)).find(directory => {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, "review.json"), "utf8"));
      return parsed.proposed.some((entry: { path: string; base64?: string }) => entry.path === "test.cjs" && Buffer.from(entry.base64 ?? "", "base64").toString().includes(cumulative ? "continued sum" : "test('sum'"));
    });
    expect(newest).toBeTruthy(); const json = fs.readFileSync(path.join(newest!, "review.json"), "utf8"), review = JSON.parse(json);
    expect(review.purpose).toBe("review-only");
    for (const tree of [review.baseline, review.current]) expect(tree).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(WINDOWS_NODE_SOURCE_ORIGINAL).toString("base64") }));
    const proposed = WINDOWS_NODE_SOURCE_ORIGINAL.replace("1 + 1, 3", "1 + 1, 2").replace("test('sum'", cumulative ? "test('continued sum'" : "test('sum'");
    expect(review.proposed).toContainEqual(expect.objectContaining({ path: "test.cjs", base64: Buffer.from(proposed).toString("base64") }));
    expect(review.proposed).toContainEqual(expect.objectContaining({ path: "README.txt", base64: Buffer.from(readme).toString("base64") }));
    expect(fs.readFileSync(path.join(newest!, "changes.patch"), "utf8")).toContain(proposed.trim());
    for (const marker of [outside, privateCanary, environmentCanary, excludedGit, excludedDependency, this.key, this.replacementKey]) {
      expect(json).not.toContain(marker); expect(json).not.toContain(Buffer.from(marker).toString("base64"));
    }
  }
  private async exportReview(cumulative: boolean): Promise<void> {
    await this.idle();
    const before = this.model.requests.length;
    await this.revealHomeControl(id("project-coding"), false); await this.revealHomeControl(id("project-coding-export"));
    await this.click(this.home, id("project-coding-export")); await this.folder("Export coding review", this.exported);
    await this.accessibleText(text => text.includes("Exported the coding review"));
    expect(this.model.requests.length).toBe(before); this.assertExport(cumulative);
  }
  async repair(): Promise<void> {
    await this.project("repair"); await this.send(WINDOWS_NODE_REPAIR.request); await this.decide(WINDOWS_NODE_TEST_ARGV); await this.decide(WINDOWS_NODE_TEST_ARGV);
    expect(await this.review(WINDOWS_NODE_REPAIR.goal, "Checks: 2 run, 1 passed, 1 failed")).toContain("Done ·");
    expect(await this.homeText(id("project-coding-patch"))).toContain("1 + 1, 2"); await this.exportReview(false); this.assertUnchanged();
    await this.click(this.home, id("project-coding-continue")); await this.revealHomeControl(id("project-coding-continue-request")); await this.fill(this.home, id("project-coding-continue-request"), WINDOWS_NODE_CONTINUATION.request);
    await this.click(this.home, id("project-coding-continue-send")); await this.decide(WINDOWS_NODE_TEST_ARGV); await this.decide(WINDOWS_NODE_TEST_ARGV);
    expect(await this.review(WINDOWS_NODE_CONTINUATION.goal, "Checks: 2 run, 2 passed, 0 failed")).toContain("Done ·");
    expect(await this.homeText(id("project-coding-patch"))).toContain("continued sum"); await this.exportReview(true);
    expect(this.model.steps.get("repair")).toBe(4); expect(this.model.steps.get("continuation")).toBe(5);
    expect(JSON.stringify(this.model.results.get("repair"))).toContain("ERR_ASSERTION");
    await this.forget();
  }
  async deny(): Promise<void> {
    const scenario = windowsNodeSourceScenarios("denied")[0]; await this.project("denied"); await this.send(scenario.request); await this.decide(WINDOWS_NODE_TEST_ARGV, "Not now");
    expect(await this.review(scenario.goal, "Checks: 0 run, 0 passed, 0 failed")).toMatch(/Didn't finish ·[^\n]*Checks: 0 run, 0 passed, 0 failed/);
    expect(this.model.steps.get("denied")).toBe(1); await this.forget();
  }
  private async clipboard(mode: "clear" | "ready"): Promise<boolean> {
    const systemRoot = Object.entries(this.env).find(([key]) => key.toLowerCase() === "systemroot")?.[1]; if (!systemRoot) throw refusal(this.phase);
    const script = mode === "clear" ? "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::SetText('PACKAGED_NODE_CLIPBOARD_FRESH');[Console]::Write('1')"
      : "Add-Type -AssemblyName System.Windows.Forms;$s=[System.Windows.Forms.Clipboard]::GetText();if($s.Contains('" + WINDOWS_NODE_WRITER_READY + "')){[Console]::Write('1')}else{[Console]::Write('0')}";
    return await run(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", script], bridgeEnv(this.env), 10_000, 4096) === "1";
  }
  private async writerReady(): Promise<void> {
    const hwnd = await this.command(); expect(await this.clipboard("clear")).toBe(true);
    const freshTab = (node: RawNode) => node.controlType === "TabItem" && !!node.runtimeId && !this.previousTabs.has(node.runtimeId) && node.patterns.selectionItem?.selected === true;
    const panelFor = (nodes: readonly RawNode[], tab: RawNode) => {
      if (!/^tab-\d+$/.test(tab.automationId ?? "")) throw refusal(this.phase);
      return subtree(nodes, id(tab.automationId!.replace(/^tab-/, "panel-")));
    };
    const live = (node: RawNode) => node.controlType === "Button" && (node.name ?? "").startsWith("Stop: ") && node.isEnabled === true;
    const selected = (await this.until(() => this.nodes(hwnd), nodes => {
      const tab = nodes.find(freshTab); return !!tab && panelFor(nodes, tab).some(live);
    })).find(freshTab)!;
    await this.until(async () => {
      const nodes = await this.nodes(hwnd);
      const panel = panelFor(nodes, selected);
      if (!nodes.some(node => sameNode(node, selected) && node.patterns.selectionItem?.selected === true) || !panel.some(live)) throw refusal(this.phase);
      const command = panel.find(named("The command")); if (!command) throw refusal(this.phase);
      expect(await this.text(hwnd, node => sameNode(node, command))).toBe("Node arguments: " + JSON.stringify(WINDOWS_NODE_WRITER_ARGV));
      const copy = panel.find(node => node.name === "Copy output" && node.isEnabled);
      if (!copy) return false;
      await this.click(hwnd, node => sameNode(node, copy)); return this.clipboard("ready");
    }, Boolean, 30_000);
  }
  async writer(kind: "stop" | "mode" | "account"): Promise<void> {
    const scenario = windowsNodeSourceScenarios(kind)[0]; await this.project(kind); await this.send(scenario.request); await this.decide(WINDOWS_NODE_WRITER_ARGV); await this.writerReady();
    this.phase = 8; await this.pane("Projects");
    expect((await this.node(this.home, id("project-coding-forget"), false)).isEnabled).toBe(false);
    expect((await this.node(this.home, id("project-sessions-forget"), false)).isEnabled).toBe(false);
    if (kind === "stop") await this.click(this.home, node => (node.name ?? "").startsWith("Stop session:"));
    else if (kind === "mode") {
      await this.pane("Apps & privacy"); await this.click(this.home, id("mode-assisted")); await this.armed(this.home, id("approvals-yes")); await this.pane("Projects");
    } else {
      await this.pane("Models & connections"); await this.click(this.home, id("byok-key-replace"));
      await this.fill(this.home, id("byok-key"), this.replacementKey, true); await this.click(this.home, node => node.controlType === "Button" && node.name === "Save");
      await this.node(this.home, named("Key saved"), false); await this.pane("Projects");
    }
    if (kind === "account") {
      await this.idle();
      await this.until(() => this.nodes(this.home), nodes => nodes.some(node => node.automationId === "project-sessions-request" && node.isEnabled === false)
        && nodes.some(node => node.automationId === "project-sessions-forget" && node.isEnabled === false)
        && !nodes.some(node => /^(?:Review result:|Stop session:)/.test(node.name ?? "")));
    }
    else {
      expect(await this.review(scenario.goal, "Checks: 0 run, 0 passed, 0 failed")).toMatch(/Stopped ·[^\n]*Checks: 0 run, 0 passed, 0 failed/);
      await this.forget();
    }
    expect(this.model.steps.get(kind)).toBe(1); this.assertUnchanged(); await this.rolesEmpty();
    // Assisted can remove an elevated host's forced ask state; establish the real editable preference before the next card.
    if (kind === "mode") await this.configureCommands();
  }
  private async forget(): Promise<void> {
    this.phase = 9; await this.pane("Projects");
    // Only actual stopped results and inactive folder/project controls are used.
    while ((await this.nodes(this.home)).some(node => (node.name ?? "").startsWith("Forget private result:"))) {
      const before = (await this.nodes(this.home)).filter(node => (node.name ?? "").startsWith("Forget private result:")).length;
      await this.click(this.home, node => (node.name ?? "").startsWith("Forget private result:"));
      await this.until(() => this.nodes(this.home), nodes => nodes.filter(node => (node.name ?? "").startsWith("Forget private result:")).length < before);
    }
    await this.click(this.home, id("project-coding-forget")); await this.accessibleText(text => text.includes("No coding folder selected"));
    await this.click(this.home, id("project-sessions-forget"));
    await this.until(() => this.nodes(this.home), nodes => nodes.some(node => node.automationId === "project-sessions-request" && node.isEnabled === false));
    this.assertUnchanged(); await this.rolesEmpty();
  }
  private async rolesEmpty(): Promise<void> {
    await this.until(async () => {
      const controllers = path.join(this.profile, "coding-controllers"); if (fs.existsSync(controllers) && fs.readdirSync(controllers).length) return false;
      const common = path.join(this.temporary, "ember-coding-unsupported");
      if (fs.existsSync(common)) for (const entry of fs.readdirSync(common)) {
        if (!/^process-[0-9a-f-]{36}$/.test(entry)) throw refusal(this.phase);
        for (const role of fs.readdirSync(path.join(common, entry))) {
          if (!["copies", "reviews", "assets"].includes(role)) throw refusal(this.phase);
          if (fs.readdirSync(path.join(common, entry, role)).length) return false;
        }
      }
      return true;
    }, Boolean, 20_000);
  }
  private assertUnchanged(): void {
    expect(fs.readFileSync(path.join(this.source, "test.cjs"), "utf8")).toBe(WINDOWS_NODE_SOURCE_ORIGINAL);
    expect(fs.readFileSync(path.join(this.source, "writer.cjs"), "utf8")).toBe(WINDOWS_NODE_SOURCE_WRITER);
    expect(fs.readFileSync(path.join(this.source, "README.txt"), "utf8")).toBe(readme);
    expect(fs.existsSync(path.join(this.source, "heartbeat.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(this.root, "outside.txt"), "utf8")).toBe(outside);
    expect(fs.readFileSync(path.join(this.profile, "credential-canary.txt"), "utf8")).toBe(privateCanary);
    const messages = JSON.stringify(this.model.requests.map((request: { messages: unknown }) => request.messages));
    for (const marker of [outside, privateCanary, environmentCanary, excludedGit, excludedDependency, this.key, this.replacementKey]) expect(messages).not.toContain(marker);
    expect(this.model.failures).toEqual([]);
    for (const inventory of this.model.inventories) expect([...inventory].sort()).toEqual([...WINDOWS_NODE_PRODUCT_TOOLS].sort());
  }
  async finish(): Promise<void> {
    this.phase = 10; this.assertUnchanged(); expect(this.model.requests.length).toBeGreaterThan(0);
    expect(this.model.requests.every((request: { authorization: string | null }) => request.authorization === "Bearer " + this.key || request.authorization === "Bearer " + this.replacementKey)).toBe(true);
    expect(JSON.stringify(this.model.requests.map((request: { messages: unknown }) => request.messages))).toContain("Only bundled Node is supplied");
    await this.pane("Your Ember"); await this.click(this.home, id("p-quit"));
    const exited = await bounded(this.appClosed!, 20_000); expect(exited).toEqual({ code: 0, signal: null });
    expect(this.forced).toBe(false); expect(fs.existsSync(path.join(this.temporary, "ember-coding-unsupported"))).toBe(false);
    const controllers = path.join(this.profile, "coding-controllers"); if (fs.existsSync(controllers)) expect(fs.readdirSync(controllers)).toEqual([]);
    expect(hash(this.executable)).toBe(this.executableHash);
    for (const member of this.assets) expect(hash(member.path)).toBe(member.sha256);
    expect(fuseMismatches(readFuses(fs.readFileSync(this.executable)), emberFuses("win32"))).toEqual([]);
    this.assertionsComplete = true;
  }
  /** Failure never converts a forced process stop into a successful private-owner cleanup receipt. */
  async close(): Promise<boolean> {
    this.observe({ operation: 0 });
    clearTimeout(this.watchdog); let clean = this.assertionsComplete && !this.forced;
    if (this.app && this.app.exitCode === null && this.app.signalCode === null) { this.stopped = true; this.forced = true; this.app.kill(); clean = false; }
    try { if (this.appClosed) { const result = await bounded(this.appClosed, 10_000); clean &&= result.code === 0 && result.signal === null; } } catch { clean = false; }
    this.input?.releaseAll(); this.input?.close();
    try { if (this.bridge) { const result = await bounded(this.bridge.close(), 10_000); clean &&= result.code === 0; } } catch { this.bridge?.kill(); clean = false; }
    return clean;
  }
}

it.skipIf(!required)("uses the shipped Windows Home for normal provider setup, exact Node repair/continuation, denial, Stop and revocation with verified cleanup", async () => {
  if (quarantined) throw refusal(1);
  quarantined = true;
  let root: string | undefined, model: Model | undefined, fixture: Journey | undefined, failed = false, phase = 1;
  try {
    expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
    if (process.env.GITHUB_ACTIONS === "true") { expect(["windows-2022", "windows-2025"]).toContain(process.env.EMBER_WINDOWS_NODE_PRODUCT_IMAGE); expect(process.env.GITHUB_SHA).toMatch(/^[0-9a-f]{40}$/); }
    const temporary = fs.realpathSync.native(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-packaged-node-product-")));
    const scenarios = [...windowsNodeSourceScenarios("repair"), ...windowsNodeSourceScenarios("denied"), ...windowsNodeSourceScenarios("stop"), ...windowsNodeSourceScenarios("mode"), ...windowsNodeSourceScenarios("account")];
    model = await createWindowsNodeProductModel(scenarios); fixture = new Journey(root, model);
    await fixture.start(); await fixture.repair(); await fixture.deny(); await fixture.writer("stop"); await fixture.writer("mode"); await fixture.writer("account"); await fixture.finish();
  } catch { try { fixture?.captureFailure(); } catch { /* Failure observation cannot replace the original path. */ } failed = true; phase = fixture?.phase ?? phase; }
  finally {
    let clean = false; try { clean = !!fixture && await fixture.close(); } catch { failed = true; phase = 12; }
    try { await model?.close(); } catch { failed = true; phase = 12; }
    if (!failed && clean && root) { try { fs.rmSync(root, { recursive: true, force: false }); } catch { failed = true; phase = 12; } }
    else if (root) failed = true;
  }
  if (failed) {
    try { fixture?.captureFailure(); const observation = fixture?.failureObservation(); if (observation) console.info("Windows Node packaged cached observation", JSON.stringify(observation)); }
    catch { /* No diagnostic fault changes the original refusal or retained state. */ }
    throw refusal(phase);
  }
  quarantined = false;
  console.info("Windows Node packaged journey passed", JSON.stringify({ schema: 1, phase: 12 }));
}, 360_000);
