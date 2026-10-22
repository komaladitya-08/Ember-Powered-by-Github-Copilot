/**
 * Windows UI Automation for the sidecar host: a client for Ember's C# bridge (sidecar/uia/ember_uia.cs, compiled and
 * run by sidecar/uia/ember_uia.ps1 under Windows PowerShell 5.1). Everything about the bridge's wire format is in this
 * one module (see sidecar/uia/PROTOCOL.md), so a change there is a change here only.
 *
 * The bridge speaks newline JSON over stdio: a ready line once it has started (`{"ready":true,"version":1,"dpi":…}`, or
 * `{"fatal":…}` when it can't), then `{"id","method","params"}` requests answered by id, possibly out of order. It
 * gives every UIA call a deadline and answers "busy" when an app doesn't answer in time, so one hung app never holds
 * up the rest. It is started with a clean environment (no PSModulePath, so no user modules load) and no console
 * window; its first start compiles the C# (seconds, more with antivirus scanning) and caches the assembly under
 * EMBER_UIA_CACHE, so start() waits generously, and a start that takes longer than one request keeps going in the
 * background rather than being killed and begun again. If the bridge stops answering altogether it is killed and a
 * new one started on the next request; its handles from before mean nothing (`generation`), and the host forgets
 * every read made with them.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  ProviderError, type AxProvider, type Handle, type PerformOp, type ProviderErrorCode, type RawNode, type RawWindow, type Rect,
  type Snapshot, type SnapshotOptions, type TextInfo,
} from "../provider";

/** The bridge's element, as its snapshot, element, elementsAt, focused and children answers carry it (PROTOCOL.md). */
export interface BridgeNode {
  h: number;
  parent?: number;
  depth?: number;
  controlType?: string;
  localizedControlType?: string;
  name?: string;
  automationId?: string;
  className?: string;
  frameworkId?: string;
  isPassword?: boolean;
  isEnabled?: boolean;
  isOffscreen?: boolean;
  hasKeyboardFocus?: boolean;
  isKeyboardFocusable?: boolean;
  isControlElement?: boolean;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  pid?: number;
  hwnd?: number;
  runtimeId?: string;
  labeledBy?: string;
  helpText?: string;
  gone?: boolean;
  /** Snapshots: its children couldn't be read (an error other than gone). */
  childrenFailed?: boolean;
  patterns?: {
    invoke?: boolean;
    toggle?: "On" | "Off" | "Indeterminate";
    value?: { value?: string; readOnly?: boolean };
    range?: { value: number; min: number; max: number; readOnly?: boolean; smallChange?: number };
    expand?: "Collapsed" | "Expanded" | "PartiallyExpanded" | "LeafNode";
    selectionItem?: { selected?: boolean };
    selection?: { multiple?: boolean; required?: boolean };
    window?: { modal?: boolean; state?: string };
    grid?: { rows: number; columns: number };
    gridItem?: { row: number; column: number };
    table?: boolean;
    text?: boolean;
    scrollItem?: boolean;
    legacy?: { role?: number; state?: number; defaultAction?: string };
  };
}

/**
 * The bridge's top-level window (its topWindows answer): a RawNode of the window plus Win32 facts. A window whose
 * process is busy has no handle (`h`), only what Win32 says.
 */
export interface BridgeWindow {
  h?: number;
  /** Older drafts of the protocol named the handle so. */
  handle?: number;
  hwnd?: number;
  pid: number;
  processName?: string;
  name?: string;
  className?: string;
  controlType?: string;
  frameworkId?: string;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  isOffscreen?: boolean;
  isModal?: boolean;
  windowState?: string;
  isTopmost?: boolean;
  focused?: boolean;
  busy?: boolean;
  patterns?: BridgeNode["patterns"];
}

/** Control types whose text can be typed into where the platform says so. */
const TEXT_TYPES = new Set(["Edit", "Document"]);

/** A rectangle the bridge reported, or null (empty or infinite: no position). */
export function rectOf(b: BridgeNode["bounds"]): Rect | null {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 0 || b.height < 0) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** A bridge element as the host's RawNode (the host's action words; never a password field's value). */
export function fromBridgeNode(b: BridgeNode): RawNode {
  const p = b.patterns ?? {};
  const actions: string[] = [];
  if (p.invoke) actions.push("invoke");
  if (p.toggle !== undefined) actions.push("toggle");
  if (p.selectionItem) actions.push("select", "addToSelection", "removeFromSelection");
  if (p.expand && p.expand !== "LeafNode") actions.push("expand", "collapse");
  if (p.value && !p.value.readOnly) actions.push("setValue");
  if (p.range && !p.range.readOnly) actions.push("setRange");
  if (b.isKeyboardFocusable) actions.push("focus");
  if (p.legacy?.defaultAction) actions.push("legacy");
  if (p.scrollItem) actions.push("scrollIntoView");
  const type = b.controlType ?? "Custom";
  const n: RawNode = {
    handle: b.h,
    key: b.runtimeId ? `${b.pid ?? 0}:${b.runtimeId}` : "",
    parent: typeof b.parent === "number" ? b.parent : -1,
    depth: typeof b.depth === "number" ? b.depth : 0,
    platformRole: type,
    name: b.name ?? "",
    bounds: rectOf(b.bounds),
    actions,
  };
  const set = <K extends keyof RawNode>(k: K, v: RawNode[K] | undefined) => { if (v !== undefined) n[k] = v; };
  set("platformSubrole", b.localizedControlType);
  set("className", b.className);
  set("framework", b.frameworkId);
  set("pid", b.pid);
  set("labelledBy", b.labeledBy);
  set("help", b.helpText);
  set("enabled", b.isEnabled);
  set("focused", b.hasKeyboardFocus);
  set("focusable", b.isKeyboardFocusable);
  set("offscreen", b.isOffscreen);
  set("password", b.isPassword);
  set("toggle", p.toggle === "On" ? "on" : p.toggle === "Off" ? "off" : p.toggle === "Indeterminate" ? "mixed" : undefined);
  set("expanded", p.expand === "Expanded" || p.expand === "PartiallyExpanded" ? true : p.expand === "Collapsed" ? false : p.expand === "LeafNode" ? null : undefined);
  set("selected", p.selectionItem ? !!p.selectionItem.selected : undefined);
  set("modal", p.window?.modal);
  if (!b.isPassword && typeof p.value?.value === "string") n.value = p.value.value.slice(0, 2000);
  if (p.text) n.hasText = true;
  if (p.range && [p.range.value, p.range.min, p.range.max].every(Number.isFinite)) {
    n.range = { value: p.range.value, min: p.range.min, max: p.range.max, ...(Number.isFinite(p.range.smallChange) ? { step: p.range.smallChange } : {}), ...(p.range.readOnly ? { readOnly: true } : {}) };
  }
  if (p.selection) n.selection = { multiple: !!p.selection.multiple };
  // Editable by what every look says alike (a snapshot doesn't read LegacyIAccessible, a look at one element does): a
  // writable value, or a text field or document that takes the keyboard.
  if ((p.value && !p.value.readOnly) || (p.text && !p.value && TEXT_TYPES.has(type) && b.isEnabled !== false && !!b.isKeyboardFocusable)) n.editable = true;
  set("grid", p.grid);
  set("cell", p.gridItem ? { row: p.gridItem.row, column: p.gridItem.column } : undefined);
  if (b.hwnd) n.native = b.hwnd;
  if (b.gone) n.gone = true;
  return n;
}

/** A bridge window as the host's RawWindow (its key on the wire is its HWND). */
export function fromBridgeWindow(w: BridgeWindow): RawWindow {
  const handle = w.h ?? w.handle ?? 0;
  const out: RawWindow = {
    handle,
    key: w.hwnd ? String(w.hwnd) : `uia-${w.pid}-${handle}`,
    pid: w.pid,
    app: (w.processName ?? "").replace(/\.exe$/i, ""),
    title: w.name ?? "",
    platformRole: w.controlType ?? "Window",
    bounds: rectOf(w.bounds),
    active: !!w.focused,
    offscreen: !!w.isOffscreen || w.windowState === "Minimized",
  };
  if (w.className !== undefined) out.className = w.className;
  if (w.isModal || w.patterns?.window?.modal) out.modal = true;
  if (w.busy) out.busy = true;
  if (w.hwnd) out.native = w.hwnd;
  return out;
}

/** A list the bridge answered (an array, or one wrapped as {windows} / {nodes} / {chain} / {children}). */
function listOf<T>(v: unknown, key: string): T[] {
  if (Array.isArray(v)) return v as T[];
  const inner = v && typeof v === "object" ? (v as Record<string, unknown>)[key] ?? (v as Record<string, unknown>).nodes : undefined;
  return Array.isArray(inner) ? inner as T[] : [];
}

/** The bridge's error code as the host's. */
export function codeOf(code: unknown, message: string): ProviderErrorCode {
  switch (code) {
    case "busy": return "busy";
    case "gone": return "gone";
    case "denied": return "denied";
    default: return message.startsWith("unsupported:") ? "unsupported" : "failed";
  }
}

/**
 * The bridge's bootstrap script: EMBER_UIA_SCRIPT (Ember's launch sets it), else beside the host as built (a
 * development tree: dist/app/ → sidecar/uia/; a packaged Ember: resources/app/dist/app/ → resources/sidecar/uia/).
 */
export function uiaScript(env: NodeJS.ProcessEnv, file: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (env.EMBER_UIA_SCRIPT) return env.EMBER_UIA_SCRIPT;
  const dir = path.dirname(file || ".");
  const candidates = [path.resolve(dir, "../../sidecar/uia/ember_uia.ps1"), path.resolve(dir, "../../../sidecar/uia/ember_uia.ps1")];
  return candidates.find(c => exists(c)) ?? candidates[0];
}

/** Windows PowerShell 5.1, by its full path (never one on PATH). */
export function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The bridge's environment: the host's without PSModulePath (no user or system modules load into it). */
export function bridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() !== "psmodulepath" && v !== undefined) out[k] = v;
  return out;
}

export interface UiaOptions {
  /** ember_uia.ps1. */
  script: string;
  /** The host's environment (EMBER_UIA_CACHE and SystemRoot come from it). */
  env?: NodeJS.ProcessEnv;
  /** Tests: a stand-in bridge to run instead of Windows PowerShell. */
  command?: string;
  args?: string[];
  /** How long one start() waits for the ready line (the start goes on after that). */
  startMs?: number;
  /** A UIA call's deadline in the bridge. */
  deadlineMs?: number;
  /** How long past its deadline an answer may take before the bridge counts as stuck (killed, started again). */
  graceMs?: number;
  /**
   * How soon a bridge that couldn't start is tried again (a fatal line, or PowerShell refusing the script): not in a
   * loop, since what stops it (a Group Policy execution policy, Constrained Language mode) doesn't go away by itself.
   */
  retryMs?: number;
  spawn?: typeof nodeSpawn;
  note?: (event: string, fields?: Record<string, unknown>) => void;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Bridge { child: ChildProcessWithoutNullStreams; pending: Map<number, Pending>; ready: Promise<void>; isReady: boolean; done: boolean; dpi?: string }

/** The bridge's longest deadline for one call. */
const MAX_DEADLINE_MS = 4000;
/** Children listed under one element in a snapshot (the on-screen ones first), as the Python sidecar's MAX_CHILDREN. */
const MAX_CHILDREN = 200;
/** The window list is given a little longer than one call (many windows, each a few properties). */
const WINDOWS_DEADLINE_MS = 1500;

/** Windows UI Automation through the C# bridge (see the module comment). */
export class UiaProvider implements AxProvider {
  readonly kind = "uia" as const;
  readonly vocabulary = "uia" as const;
  generation = 1;
  private bridge: Bridge | null = null;
  private starts = 0;
  private nextId = 1;
  private failedAt = 0;
  private failure = "";
  private stopped = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startMs: number;
  private readonly deadlineMs: number;
  private readonly graceMs: number;
  private readonly retryMs: number;
  private readonly spawn: typeof nodeSpawn;
  private readonly note: (event: string, fields?: Record<string, unknown>) => void;

  constructor(private o: UiaOptions) {
    this.env = o.env ?? process.env;
    this.startMs = o.startMs ?? 18_000;
    this.deadlineMs = o.deadlineMs ?? 800;
    this.graceMs = o.graceMs ?? 2000;
    this.retryMs = o.retryMs ?? 60_000;
    this.spawn = o.spawn ?? nodeSpawn;
    this.note = o.note ?? (() => undefined);
  }

  /** The DPI awareness the bridge got ("per-monitor-v2" for physical pixels everywhere), once it is ready. */
  get dpi(): string | undefined {
    return this.bridge?.dpi;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("the accessibility bridge was stopped");
    if (this.bridge?.isReady && !this.bridge.done) return;
    if (!this.bridge || this.bridge.done) {
      if (this.failure && Date.now() - this.failedAt < this.retryMs) throw new Error(this.failure);
      this.bridge = this.launch();
    }
    const b = this.bridge;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the accessibility bridge is still starting (Windows PowerShell compiles it on its first start); try again in a moment`)), this.startMs);
    });
    try {
      await Promise.race([b.ready, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  private launch(): Bridge {
    const command = this.o.command ?? powershellPath(this.env);
    const args = this.o.args ?? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.o.script];
    const child = this.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: bridgeEnv(this.env), windowsHide: true });
    let settle!: { resolve: () => void; reject: (e: Error) => void };
    const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    // Nobody may be waiting when a start fails in the background: that is no unhandled rejection.
    ready.catch(() => undefined);
    const b: Bridge = { child, pending: new Map(), ready, isReady: false, done: false };
    const first = this.starts++ === 0;
    const fail = (why: string) => {
      if (b.done) return;
      b.done = true;
      if (!b.isReady) { this.failure = why; this.failedAt = Date.now(); }
      settle.reject(new Error(why));
      for (const p of b.pending.values()) { clearTimeout(p.timer); p.reject(new ProviderError("failed", why)); }
      b.pending.clear();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    readline.createInterface({ input: child.stdout }).on("line", line => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        this.note("uia.bad_line", { bytes: line.length });
        return;
      }
      if (!b.isReady) {
        if (msg.ready === true) {
          b.isReady = true;
          b.dpi = typeof msg.dpi === "string" ? msg.dpi : undefined;
          this.failure = "";
          if (!first) this.generation++;
          this.note("uia.ready", { dpi: b.dpi, generation: this.generation });
          settle.resolve();
        } else if (typeof msg.fatal === "string") {
          fail(`the accessibility bridge could not start (${msg.fatal})`);
        }
        return;
      }
      const id = typeof msg.id === "number" ? msg.id : null;
      const p = id !== null ? b.pending.get(id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      b.pending.delete(id!);
      const err = msg.error as { code?: unknown; message?: unknown } | undefined;
      if (err) {
        const message = typeof err.message === "string" ? err.message : "the accessibility bridge failed";
        p.reject(new ProviderError(codeOf(err.code, message), message));
      } else p.resolve(msg.result);
    });
    readline.createInterface({ input: child.stderr }).on("line", line => this.note("uia.stderr", { bytes: line.length }));
    child.on("exit", (code, signal) => {
      this.note("uia.exit", { code, signal });
      fail(`the accessibility bridge stopped (${signal ?? `exit code ${code}`})`);
    });
    child.on("error", err => fail(`the accessibility bridge could not run (${err.message})`));
    child.stdin.on("error", () => fail("the accessibility bridge stopped"));
    return b;
  }

  /** One bridge request, answered within its deadline (a bridge that doesn't answer at all is killed: see the module comment). */
  private async call<T>(method: string, params: Record<string, unknown> = {}, deadlineMs = this.deadlineMs): Promise<T> {
    await this.start();
    const b = this.bridge!;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        b.pending.delete(id);
        reject(new ProviderError("busy", `the accessibility bridge didn't answer ${method} in time`));
        // It promised an answer by the deadline: it is stuck, and is started again on the next request.
        this.note("uia.stuck", { method, deadlineMs });
        b.done = true;
        for (const p of b.pending.values()) { clearTimeout(p.timer); p.reject(new ProviderError("busy", "the accessibility bridge was restarted")); }
        b.pending.clear();
        if (b.child.exitCode === null && b.child.signalCode === null) b.child.kill();
      }, deadlineMs + this.graceMs);
      b.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      b.child.stdin.write(JSON.stringify({ id, method, params: { ...params, deadlineMs } }) + "\n");
    });
  }

  async accessibility(): Promise<boolean | null> {
    // UI Automation needs no permission: it is always on.
    return true;
  }

  async topWindows(): Promise<RawWindow[]> {
    return listOf<BridgeWindow>(await this.call("topWindows", {}, WINDOWS_DEADLINE_MS), "windows").map(fromBridgeWindow);
  }

  async snapshot(window: Handle, o: SnapshotOptions): Promise<Snapshot> {
    const deadline = Math.min(MAX_DEADLINE_MS, Math.max(100, Math.round(o.deadlineMs)));
    // Values are read (a field's text); LegacyIAccessible isn't (three calls an element): a look at one element reads it.
    const r = await this.call<{ nodes?: BridgeNode[]; truncated?: boolean; cut?: unknown; busy?: boolean }>("snapshot", {
      handle: window, maxDepth: o.maxDepth, maxNodes: o.maxNodes, maxChildren: MAX_CHILDREN, values: true, legacy: false,
    }, deadline);
    const cut = Array.isArray(r?.cut) ? r.cut.filter((c): c is string => typeof c === "string") : [];
    const nodes = r?.nodes ?? [];
    // What an element held couldn't be read: the read isn't whole (no picture is taken of what it may hide).
    if (nodes.some(n => n.childrenFailed) && !cut.includes("nodes")) cut.unshift("nodes");
    return { nodes: nodes.map(fromBridgeNode), truncated: !!r?.truncated || cut.length > 0, cut, ...(r?.busy ? { busy: true } : {}) };
  }

  async element(h: Handle): Promise<RawNode | null> {
    try {
      const r = await this.call<BridgeNode | null>("element", { handle: h, values: true, legacy: true });
      return r ? fromBridgeNode(r) : null;
    } catch (err) {
      if (err instanceof ProviderError && err.code === "gone") return null;
      throw err;
    }
  }

  async elementsAt(x: number, y: number): Promise<RawNode[]> {
    return listOf<BridgeNode>(await this.call("elementsAt", { x: Math.round(x), y: Math.round(y) }), "chain").map(fromBridgeNode);
  }

  async focused(): Promise<{ element: RawNode | null; window: Handle | null }> {
    const r = await this.call<{ element?: BridgeNode | null; window?: number | null }>("focused");
    return { element: r?.element ? fromBridgeNode(r.element) : null, window: typeof r?.window === "number" ? r.window : null };
  }

  async children(h: Handle, max: number): Promise<RawNode[]> {
    return listOf<BridgeNode>(await this.call("children", { handle: h, max }), "children").map(fromBridgeNode);
  }

  async perform(h: Handle, op: PerformOp, value?: unknown): Promise<void> {
    // The bridge names LegacyIAccessible's default action in full.
    const bridgeOp = op === "legacy" ? "legacyDefaultAction" : op;
    await this.call("perform", { handle: h, op: bridgeOp, ...(value !== undefined ? { value } : {}) });
  }

  async textInfo(h: Handle, maxChars: number): Promise<TextInfo> {
    const r = await this.call<TextInfo | null>("textInfo", { handle: h, maxChars: Math.min(100_000, Math.max(1, maxChars)) });
    if (!r) return {};
    if (r.secret) return { secret: true };
    const out: TextInfo = {};
    if (typeof r.text === "string") out.text = r.text;
    if (r.truncated === true) out.truncated = true;
    if (typeof r.selection === "string") out.selection = r.selection;
    if (typeof r.caret === "number" && Number.isInteger(r.caret) && r.caret >= 0) out.caret = r.caret;
    if (typeof r.caretAtEnd === "boolean") out.caretAtEnd = r.caretAtEnd;
    return out;
  }

  release(hs: Handle[]): void {
    const b = this.bridge;
    if (!hs.length || !b?.isReady || b.done) return;
    const id = this.nextId++;
    // Nothing waits on the answer (its id has no pending entry, so it is dropped).
    b.child.stdin.write(JSON.stringify({ id, method: "release", params: { handles: hs } }) + "\n");
  }

  stop(): void {
    this.stopped = true;
    const b = this.bridge;
    if (!b) return;
    b.done = true;
    for (const p of b.pending.values()) { clearTimeout(p.timer); p.reject(new ProviderError("failed", "the accessibility bridge was stopped")); }
    b.pending.clear();
    try {
      b.child.stdin.end();
    } catch {
      // Already closed: the kill below ends it.
    }
    if (b.child.exitCode === null && b.child.signalCode === null) b.child.kill();
  }
}
