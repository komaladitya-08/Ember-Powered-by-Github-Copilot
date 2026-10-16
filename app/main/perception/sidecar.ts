/**
 * Client for the Python AT-SPI sidecar (sidecar/atspi/ember_atspi.py):
 * newline-delimited JSON-RPC over stdio, started on demand. The sidecar
 * answers one request at a time, so a request that doesn't come back in time
 * holds up every other one: that process is killed, and a fresh one starts at
 * once (as after any exit or crash), so one stays connected (see revive).
 * Element ids are only valid in the process that issued them; what it knows
 * about secret fields is kept here too and handed to every new process.
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
  /** A drop-down (combo box): the option it shows as chosen (never for a secret one). */
  selected?: string;
  value?: number;
  editable?: boolean;
  /** A password, payment or one-time-code field: its contents are never read. */
  secret?: boolean;
  /** The part of `bounds` that shows, where some of it is scrolled out of its list or lies outside its window. */
  shown?: Bounds;
  /**
   * A spreadsheet's cell (LibreOffice Calc), read from its sheet by row and column: named by its address ("B7"), its
   * text what it holds. A cell with the keyboard that is scrolled away has no `bounds`.
   */
  grid?: boolean;
  /** A spreadsheet's sheet: how many rows and columns it has (LibreOffice 6.4: 1024 columns, to AMJ; 24.2: 16384, to XFD). */
  size?: { rows: number; columns: number };
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
  /** Listed as last seen: its app didn't answer this time (busy, or hung for a while). */
  busy?: boolean;
}

/** Another window of the app read: one the user is in, or must answer first (an Open dialog). */
export interface OtherWindow { name: string; role: string; active: boolean; modal: boolean }

export interface ReadWindowResult {
  window: AxWindow | null;
  nodes: AxNode[];
  /** Cut short: at maxNodes elements, or because reading took too long. */
  truncated?: boolean;
  /** What on screen was left out for want of room: "nodes" (the element limit), "depth" (nested deeper than a read goes). */
  cut?: string[];
  /** It was the time (the app answered, slowly). */
  slow?: boolean;
  /** The app stopped answering (busy or hung): the tree is partial, or there is no window at all. */
  busy?: boolean;
  /** On the never-look list (by app name, title or process): not read. */
  blocked?: boolean;
  others?: OtherWindow[];
  ms: number;
}

/** Every secret field on screen in one window (see secretFields). */
export interface SecretFieldsResult {
  /** Ids and bounds as the app reports them (not scaled for HiDPI). */
  fields: { id: number; role: string; bounds: Bounds }[];
  /** False when the window couldn't be looked through in time (too big, busy, or gone). */
  complete: boolean;
  busy?: boolean;
  ms: number;
}

/** Something GNOME Shell draws over the windows (a system dialog, a notification), in physical pixels. */
export interface ShellOverlay { role: string; name: string; text: string; bounds: Bounds | null }

/**
 * One of the elements that show at a point of a window (see atPoint), with its bounds as the app reports them. A secret
 * field comes nameless, and last. `empty`: the last one is an empty grouping container, so the app told nothing about
 * what shows there (Chromium's hit test can end on an empty panel lying over its web page).
 */
export interface PointElement { role: string; name: string; bounds: Bounds | null; secret?: boolean; empty?: boolean }

/** What shows at a point, outermost first; `busy`: the app didn't answer in time; `found`: false when the window is gone. */
export interface AtPointResult { chain: PointElement[]; busy?: boolean; blocked?: boolean; found?: boolean; ms: number }

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
  /** readElement: the part of `bounds` that shows, where some of it is scrolled out of view or lies outside its window. */
  shown?: Bounds;
  /** A menu: whether it is open (its items show). */
  open?: boolean;
}

/**
 * Could an action be done by accessibility (tier 1), checked as the action itself checks it and without doing it.
 * `why`: why it can't (the app's own action names may be in it). `focused` and `windowActive` (asked with `caret`):
 * the element has the keyboard, and its window is the active one.
 */
export interface CanDo {
  tier1: boolean; why?: string; focused?: boolean; windowActive?: boolean;
  /** A click: the action that would do it ("clickancestor": Chromium hands it to an ancestor). */
  action?: string;
  /** A click: the control around the element that the click goes to (a link around its text, a row around its label). */
  handler?: { role: string; name: string };
  /** A click the app hands to a control around the element that lies too deep to find: what it works can't be told. */
  handlerUnknown?: boolean;
}

/**
 * `after` is null when the element went away (its dialog closed: the action worked) or the app stopped answering.
 * `unchecked`: a row chosen in a long list, whose rows after it (this many) weren't looked through for another of that name in time.
 */
export interface ActionResult { ok: boolean; action?: string; option?: string; before?: ElementInfo; after: ElementInfo | null; gone?: boolean; busy?: boolean; unchecked?: number }

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
/** One sidecar process and the requests waiting on it; `answered`: it has answered something (it works). */
interface Helper { child: ChildProcessWithoutNullStreams; pending: Map<number, Pending>; done: boolean; answered: boolean }

/** A secret field's accessible: its app's bus name and its object path. */
type SecretKey = [string, string];

export class AtspiSidecar {
  private helper: Helper | null = null;
  private nextId = 1;
  /** Elements of HiDPI windows: physical pixels per pixel the app reports (see scaleElements). */
  private scales = new Map<number, number>();
  /** The ids each kept read scaled (the last few), and the latest quick look's (keep: false), as the sidecar keeps them. */
  private scaled: number[][] = [];
  private scratch: number[] = [];
  /**
   * Fields known to hold secrets. GTK's "Show password" turns a password field into a plain entry;
   * the sidecar remembers that it was one, and so does this list, for whichever process comes next.
   */
  private secrets = new Map<string, SecretKey>();
  /** Elements whose names say what a secret field holds (a table's cell named after the card number in it): withheld by whichever process comes next too. */
  private withheld = new Map<string, SecretKey>();
  /** stop() was called: no helper is started again on its own (see revive). */
  private stopped = false;
  private reviving = false;

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
    const h: Helper = { child, pending: new Map(), done: false, answered: false };
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
    // Before anything else it is asked: the secret fields earlier processes knew (its answer isn't needed).
    if (this.secrets.size || this.withheld.size) {
      const params = { keys: [...this.secrets.values()], ...(this.withheld.size ? { withheld: [...this.withheld.values()] } : {}) };
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "remember_secrets", params }) + "\n");
    }
    return h;
  }

  /** Keeps secret fields' keys (the most recent few thousand), or (`into`) those of names withheld. */
  private remember(keys: unknown, into = this.secrets): void {
    if (!Array.isArray(keys)) return;
    for (const k of keys) {
      if (!Array.isArray(k) || k.length !== 2 || typeof k[0] !== "string" || typeof k[1] !== "string") continue;
      const key = `${k[0]} ${k[1]}`;
      into.delete(key);
      into.set(key, [k[0], k[1]]);
    }
    while (into.size > 4096) into.delete(into.keys().next().value!);
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
    if (id !== null) h.answered = true;
    const p = id !== null ? h.pending.get(id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    h.pending.delete(id!);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  }

  /**
   * This process is finished with: its waiting requests fail now. The next one starts at once when this one worked
   * (see revive), else the next request starts it.
   */
  private retire(h: Helper, why: string, kill?: NodeJS.Signals): void {
    const current = this.helper === h;
    if (current) this.helper = null;
    h.done = true;
    if (kill && h.child.exitCode === null && h.child.signalCode === null) h.child.kill(kill);
    for (const p of h.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    h.pending.clear();
    if (current && h.answered) this.revive();
  }

  /**
   * A helper that worked is gone (killed for a request that took too long, or it crashed): a new one is started right
   * away and asked for its status, so one stays connected to the accessibility bus. LibreOffice (24.2) aborts, losing
   * unsaved work, when a client that read it has left, a document is opened while no client is connected, and then a
   * new client lists the desktop; one staying connected while the document opens prevents it. Never after stop(); and
   * a helper that never answered isn't started over and over (the next request starts one).
   */
  private revive(): void {
    if (this.stopped || this.reviving) return;
    this.reviving = true;
    setTimeout(() => {
      this.reviving = false;
      if (this.stopped || this.helper) return;
      this.log.info("sidecar.revive", {});
      this.request("status").catch(() => undefined);
    }, 0);
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
   * the nodes Perception hands out. (Window reads here stay as the app reports them.) `keep: false`: they come from a
   * quick look (readWindow's keep), which the next quick look replaces, as in the sidecar: quick looks never push the
   * ids of the reads acted on out of the last few.
   */
  scaleElements(ids: number[], k: number, keep = true): void {
    if (k === 1 || !ids.length) return;
    for (const id of ids) this.scales.set(id, k);
    if (!keep) { this.scratch.push(...ids); return; }
    this.scaled.push(ids);
    // Ids are only used from the last few reads (the sidecar forgets older ones too).
    while (this.scaled.length > 16) for (const id of this.scaled.shift()!) this.scales.delete(id);
  }

  /** A new quick look begins: the ids of the one before it are gone (the sidecar replaces its scratch read). */
  private newQuickLook(): void {
    for (const id of this.scratch) this.scales.delete(id);
    this.scratch = [];
  }

  /** Physical pixels per pixel element `id` reports (1 when its window isn't HiDPI, or the id isn't known). */
  scaleOf(id: number): number {
    return this.scales.get(id) ?? 1;
  }

  private physical<T extends ElementInfo | undefined>(id: number, e: T): T {
    const k = this.scales.get(id);
    return k && e?.bounds ? { ...e, bounds: scaleBounds(e.bounds, k), ...(e.shown ? { shown: scaleBounds(e.shown, k) } : {}) } : e;
  }

  private physicalResult(id: number, r: ActionResult): ActionResult {
    return this.scales.has(id) ? { ...r, before: this.physical(id, r.before), after: r.after && this.physical(id, r.after) } : r;
  }

  status(): Promise<SidecarStatus> { return this.request("status"); }
  /** Visible windows; `ownPid`'s (Ember's own) are left out. */
  listWindows(params: { ownPid?: number } = {}): Promise<{ windows: AxWindow[] }> { return this.request("list_windows", params); }
  /**
   * `pid` and `path` together name one window (no other is read if it is gone). A window whose app
   * or title matches `neverLook`, or whose process is in `skipPids`, is found but not read. `ownPid`'s
   * windows (Ember's own) are never found, not even as the active window. `keep: false`: a quick look whose ids
   * aren't acted on (what has the keyboard before a key): it doesn't push the reads acted on out of the sidecar's
   * last few, so the ids of the latest perceive_window stay known.
   */
  readWindow(params: { pid?: number; title?: string; path?: string; maxDepth?: number; maxNodes?: number; neverLook?: string[]; skipPids?: number[]; ownPid?: number; keep?: boolean; cells?: string[] } = {}): Promise<ReadWindowResult> {
    return this.request<ReadWindowResult & { secretKeys?: unknown; withheldKeys?: unknown }>("read_window", params).then(({ secretKeys, withheldKeys, ...r }) => {
      this.remember(secretKeys);
      this.remember(withheldKeys, this.withheld);
      if (params.keep === false) this.newQuickLook();
      return r;
    });
  }

  /** These elements (from the last few reads) hold secrets: the sidecar refuses to type into them from now on. */
  markSecret(ids: number[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.request<{ keys?: unknown; withheldKeys?: unknown }>("mark_secret", { ids }).then(r => {
      this.remember(r.keys);
      this.remember(r.withheldKeys, this.withheld);
    });
  }

  /**
   * Every secret field on screen in the window `pid` and `path` name, looked for on their own: after a read
   * that was cut short, before a screenshot shows what the fields it didn't reach hold.
   */
  secretFields(window: { pid: number; path: string }): Promise<SecretFieldsResult> {
    return this.request<SecretFieldsResult & { secretKeys?: unknown }>("secret_fields", window).then(({ secretKeys, ...r }) => {
      this.remember(secretKeys);
      return r;
    });
  }

  /**
   * What GNOME Shell shows over the windows right now (none without GNOME Shell). `complete` is false when the
   * shell couldn't be looked through in time: a password prompt may be up unseen.
   */
  shellOverlays(): Promise<{ overlays: ShellOverlay[]; complete?: boolean }> { return this.request("shell_overlays"); }

  /**
   * What shows at screen point (`x`, `y`) in the window `pid` and `path` name, outermost first (positions as the
   * app reports them): a few calls, where a read of the window takes hundreds. A window matching `neverLook`, or
   * whose process is in `skipPids`, is found but not looked at (`blocked`); `ownPid`'s (Ember's own) are never found.
   * `menus: false`: none of the app's popup windows covers the point, so its open menus aren't looked through.
   */
  atPoint(params: { pid: number; path: string; x: number; y: number; neverLook?: string[]; skipPids?: number[]; ownPid?: number; menus?: boolean }): Promise<AtPointResult> {
    return this.request<AtPointResult & { withheldKeys?: unknown }>("at_point", params).then(({ withheldKeys, ...r }) => {
      this.remember(withheldKeys, this.withheld);
      return r;
    });
  }

  // Tier 1 actions on element ids from a previous readWindow.
  /** `shown`: also the part of it that shows (where the mouse is to aim; a few more calls to the app). */
  readElement(id: number, o: { shown?: boolean } = {}): Promise<ElementInfo> {
    return this.request<ElementInfo>("read_element", o.shown ? { id, shown: true } : { id }).then(e => this.physical(id, e));
  }
  /** Could `kind` be done on element `id` by accessibility? Nothing is done. */
  canDo(id: number, kind: "click" | "toggle" | "text" | "value", caret = false): Promise<CanDo> {
    return this.request<CanDo>("can_do", { id, kind, caret });
  }
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
  /** `left`: rows of a long list (a folder of many files) left out, not named in time; theirs aren't among `options`. */
  listOptions(id: number): Promise<{ options: string[]; left?: number }> { return this.request("list_options", { id }); }

  /** Ember quits (or its desk closes): the helper stops, and isn't started again on its own (see revive). */
  stop(): void {
    this.stopped = true;
    if (this.helper) this.retire(this.helper, "accessibility helper stopped", "SIGTERM");
  }
}
