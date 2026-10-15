/**
 * Client for the Python AT-SPI sidecar (sidecar/atspi/ember_atspi.py):
 * newline-delimited JSON-RPC over stdio, started on demand. The sidecar
 * answers one request at a time, so a request that doesn't come back in time
 * holds up every other one: that process is killed, and the next request
 * starts a fresh one (as after any exit or crash). Element ids are only valid
 * in the process that issued them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import type { Logger } from "../logger";

export interface Bounds { x: number; y: number; width: number; height: number }

export interface AxNode {
  id: number;
  parent: number | null;
  depth: number;
  role: string;
  name: string;
  states: string[];
  bounds: Bounds | null;
  actions?: string[];
  text?: string;
  /** Selected text, for the focused text element only (never for passwords). */
  selection?: string;
  value?: number;
  editable?: boolean;
  /** A password, payment or one-time-code field: its contents are never read. */
  secret?: boolean;
}

export interface AxWindow {
  app: string;
  pid: number | null;
  /** The frame's accessible object path: with the pid, names this window until it closes, whatever its title. */
  path?: string;
  name: string;
  role: string;
  active: boolean;
  bounds: Bounds | null;
}

export interface ReadWindowResult {
  window: AxWindow | null;
  nodes: AxNode[];
  truncated?: boolean;
  ms: number;
}

/** An element as it is right after an action (for verification). */
export interface ElementInfo {
  role: string;
  name: string;
  states: string[];
  bounds: Bounds | null;
  text?: string;
  value?: number;
  selected?: string;
  /** Contents withheld (a password or payment field). */
  secret?: boolean;
}

export interface ActionResult { ok: boolean; action?: string; option?: string; before?: ElementInfo; after: ElementInfo }

export interface SidecarStatus { version: number; python: string; toolkitAccessibility: boolean | null; apps: number }

/** A rectangle in physical pixels, from one reported by an app that draws `k` physical pixels per pixel it reports. */
export function scaleBounds(b: Bounds, k: number): Bounds {
  if (k === 1) return b;
  const x = Math.round(b.x * k), y = Math.round(b.y * k);
  return { x, y, width: Math.round((b.x + b.width) * k) - x, height: Math.round((b.y + b.height) * k) - y };
}

/** RHEL's system Python first (it has pyatspi), then python3 on PATH. */
export function pickPython(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (env.EMBER_PYTHON) return env.EMBER_PYTHON;
  if (exists("/usr/libexec/platform-python")) return "/usr/libexec/platform-python";
  return "python3";
}

/**
 * Every sidecar process (the user's display, Ember's desk, restarts) numbers
 * its elements from its own block, so an id from another process never names
 * an element by accident.
 */
export const ID_BLOCK = 10_000_000;
let idBlocks = 0;

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
/** One sidecar process and the requests waiting on it. */
interface Helper { child: ChildProcessWithoutNullStreams; pending: Map<number, Pending>; done: boolean }

export class AtspiSidecar {
  private helper: Helper | null = null;
  private nextId = 1;
  /** Elements of HiDPI windows: physical pixels per pixel the app reports (see scaleElements). */
  private scales = new Map<number, number>();
  private scaled: number[][] = [];

  /** `env`: the environment of the desktop to read (Ember's desk has its own display and bus). */
  constructor(private script: string, private log: Logger, private python = pickPython(), private env: NodeJS.ProcessEnv = process.env) {}

  private ensure(): Helper {
    const live = this.helper;
    if (live && !live.done && live.child.exitCode === null && live.child.signalCode === null) return live;
    if (live) this.retire(live, "accessibility helper stopped");
    const child = spawn(this.python, [this.script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...this.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", EMBER_ATSPI_ID_BASE: String(++idBlocks * ID_BLOCK) },
    });
    const h: Helper = { child, pending: new Map(), done: false };
    this.helper = h;
    readline.createInterface({ input: child.stdout }).on("line", line => this.answer(h, line));
    readline.createInterface({ input: child.stderr }).on("line", line => {
      if (!/dconf-WARNING|Gtk-WARNING/.test(line)) this.log.debug("sidecar.stderr", { line: line.slice(0, 300) });
    });
    child.on("exit", (code, signal) => {
      this.log.info("sidecar.exit", { code, signal });
      this.retire(h, "accessibility helper stopped");
    });
    child.on("error", err => {
      this.log.error("sidecar.error", { err });
      this.retire(h, `accessibility helper could not run (${err.message})`, "SIGKILL");
    });
    // Writing to a helper that just died fails with EPIPE: its requests fail, Ember carries on.
    child.stdin.on("error", err => {
      this.log.warn("sidecar.stdin_error", { err });
      this.retire(h, "accessibility helper stopped", "SIGKILL");
    });
    return h;
  }

  private answer(h: Helper, line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      // Not protocol (a library printing to stdout, or an answer JSON can't carry): its request will time out.
      const json = line.trimStart().startsWith("{");
      this.log.warn("sidecar.bad_line", { bytes: line.length, ...(json ? {} : { start: line.slice(0, 120) }) });
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : null;
    const p = id !== null ? h.pending.get(id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    h.pending.delete(id!);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  }

  /** This process is finished with: its waiting requests fail now, and the next request starts a new one. */
  private retire(h: Helper, why: string, kill?: NodeJS.Signals): void {
    if (this.helper === h) this.helper = null;
    h.done = true;
    if (kill && h.child.exitCode === null && h.child.signalCode === null) h.child.kill(kill);
    for (const p of h.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    h.pending.clear();
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const h = this.ensure();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        h.pending.delete(id);
        reject(new Error(`accessibility helper did not answer ${method} in ${timeoutMs} ms`));
        // One request at a time: a stuck call (a hung app) would hold up every later one. Start over.
        this.log.warn("sidecar.timeout", { method, timeoutMs });
        this.retire(h, "accessibility helper was restarted (an earlier request took too long)", "SIGKILL");
      }, timeoutMs);
      h.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      h.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /**
   * Perception found that these elements' window reports logical pixels (HiDPI): `k` physical
   * pixels each. From now on their bounds in readElement and action results are physical too, like
   * the nodes Perception hands out. (Window reads here stay as the app reports them.)
   */
  scaleElements(ids: number[], k: number): void {
    if (k === 1 || !ids.length) return;
    for (const id of ids) this.scales.set(id, k);
    this.scaled.push(ids);
    // Ids are only used from the last few reads (the sidecar forgets older ones too).
    while (this.scaled.length > 16) for (const id of this.scaled.shift()!) this.scales.delete(id);
  }

  private physical<T extends ElementInfo | undefined>(id: number, e: T): T {
    const k = this.scales.get(id);
    return k && e?.bounds ? { ...e, bounds: scaleBounds(e.bounds, k) } : e;
  }

  private physicalResult(id: number, r: ActionResult): ActionResult {
    return this.scales.has(id) ? { ...r, before: this.physical(id, r.before), after: this.physical(id, r.after) } : r;
  }

  status(): Promise<SidecarStatus> { return this.request("status"); }
  listWindows(): Promise<{ windows: AxWindow[] }> { return this.request("list_windows"); }
  /** `pid` and `path` together name one window (no other is read if it is gone). */
  readWindow(params: { pid?: number; title?: string; path?: string; maxDepth?: number; maxNodes?: number } = {}): Promise<ReadWindowResult> {
    return this.request("read_window", params);
  }

  // Tier 1 actions on element ids from a previous readWindow.
  readElement(id: number): Promise<ElementInfo> { return this.request<ElementInfo>("read_element", { id }).then(e => this.physical(id, e)); }
  doAction(id: number, action = "click"): Promise<ActionResult> {
    return this.request<ActionResult>("do_action", { id, action }).then(r => this.physicalResult(id, r));
  }
  setText(id: number, text: string, mode: "replace" | "insert" | "append" = "replace"): Promise<ActionResult> {
    return this.request<ActionResult>("set_text", { id, text, mode }).then(r => this.physicalResult(id, r));
  }
  setValue(id: number, value: number): Promise<ActionResult> {
    return this.request<ActionResult>("set_value", { id, value }).then(r => this.physicalResult(id, r));
  }
  selectOption(id: number, option: string): Promise<ActionResult> {
    return this.request<ActionResult>("select_option", { id, option }).then(r => this.physicalResult(id, r));
  }
  listOptions(id: number): Promise<{ options: string[] }> { return this.request("list_options", { id }); }

  stop(): void {
    if (this.helper) this.retire(this.helper, "accessibility helper stopped", "SIGTERM");
  }
}
