/**
 * The macOS accessibility provider of Ember's sidecar host (design §5.3): AX through koffi, in this node-mode child of
 * Ember (its own binary with ELECTRON_RUN_AS_NODE=1, so TCC holds Ember.app responsible when LaunchServices started
 * it), behind the host's AxProvider. It reports raw facts in points and does raw actions; the host maps roles
 * (roles.ts's axRole), keeps ids, secrets and wording. What it adds to AX is what makes it safe and fast enough:
 *
 * - Ember's own process (EMBER_OWNER_PID, else this process's parent) is never asked anything: no AX element is ever
 *   made for it (a request there would wait on Ember's main thread and turn Chromium's accessibility on for Ember's
 *   renderers); its windows are listed from the window server's list alone. The system's credential and consent
 *   prompts (SecurityAgent and the rest: roles.ts's axOverlayRole) are listed so too, and never read.
 * - An app that doesn't answer within the 0.8 s messaging timeout is busy for 5 s (ax-darwin-read.ts), and its windows
 *   are listed as last seen; every other app keeps answering. The window list asks apps for WINDOWS_BUDGET_MS at most
 *   (the frontmost first), so a few hung apps can't hold a request past the 5 s Ember waits.
 * - Elements are keyed `<pid>:h<CFHash>` (the exact 64-bit hash, the same in every host process for as long as the
 *   element lives in its app), so a password field found once stays secret across host restarts; two elements of one
 *   answer with the same hash get index-path keys instead (logged as ax.key_collision). KEY_MODE switches every key to
 *   the index path, should CI show the hash isn't stable.
 * - Handles are this process's numbers for retained AXUIElementRefs, given back (CFRelease) when the host releases them;
 *   the provider never restarts, so its generation stays 1.
 * - Chromium and Electron apps build their accessibility tree only when asked: the first read of an app's window sets
 *   AXManualAccessibility on its app element, once (never AXEnhancedUserInterface, which breaks window animations).
 * - No action raises a window (no AXRaise, no AXFrontmost): tier 1 works in the background.
 */

import {
  ProviderError, type AxProvider, type Handle, type PerformOp, type ProviderHealth, type RawNode, type RawWindow, type Rect,
  type Snapshot, type SnapshotOptions, type TextInfo,
} from "../provider";
import { SECURITY_OWNERS, SYSTEM_OWNERS, axWindowId, contains, isAppWindow, isDockItself, isVisible } from "../../main/platform/darwin/model";
import { AX_ERROR } from "../../main/platform/darwin/ax";
import { isAxError, type AxApi, type AxRef, type AxWindowEntry } from "./ax-darwin-api";
import {
  AxSession, BusyApps, CELL_PARENTS, CHAIN_ATTRS, CHAIN_MAX, NEEDS_PERMISSION, WINDOW_ATTRS, busyError, clipInside, clippedOut, doPerform,
  glance, lookAt, releaseFacts, releaseValue, textOf, walk, type Facts, type NodeBody, type Note,
} from "./ax-darwin-read";

/**
 * How elements are keyed: "hash" (`<pid>:h<CFHash>`, index paths only for duplicates within one answer) or "path"
 * (`<pid>:p<CGWindowID>/<child indices>:<AX role>`, stable while the window's structure is) for every element: the
 * fallback should CI show that CFHash differs between host processes (design §5.3, R4). It doesn't: on macos-15
 * (CI runs 120 to 123) a second host process gave the bench's password field the same key, and its 200 rows had 200
 * different ones, so "hash" stays.
 */
export const KEY_MODE: "hash" | "path" = "hash";
/** How long a Chromium app gets to build its tree after AXManualAccessibility is set, before its first read. */
const MANUAL_SETTLE_MS = 200;
/**
 * How long the window list may spend asking apps: past it, the apps not asked yet are listed from the window list
 * alone, as busy (last seen). Every app that doesn't answer costs the 0.8 s messaging timeout, and a request Ember
 * waits on longer than 5 s gets this process killed, which forgets which apps are busy (so the next one pays again).
 */
export const WINDOWS_BUDGET_MS = 2000;
/** One point of slack when telling whether a window covers a display (AX and CG round alike, displays don't). */
const COVER_SLACK = 1;

/** What the provider holds for a handle: the element (retained) and where it was found. */
interface Held {
  ref: AxRef;
  pid: number;
  role: string;
  subrole: string;
  frame: Rect | null;
  depth: number;
  /** Child indices from its window, where known (a walk's elements and their children). */
  path: number[] | null;
  /** The CGWindowID of its window (0: unknown). */
  windowId: number;
  /** The clip it was judged against: its window and the scroll areas around it, where known. */
  clip: Rect | null;
  /** The key it was given (a later look says the same). */
  key: string;
}

/** What the provider is made with (openProvider's; a fake API and clock in the tests). */
export interface AxDarwinOptions {
  /** Opens the AX API (openAxApi on macOS; a fake in the tests); null: it can't be bound here. */
  open: () => AxApi | null;
  /** Why open() gave null, for status. */
  openError?: () => unknown;
  /** Ember's own process (see ownerPid in provider.ts): no AX element is ever made for it. */
  owner?: number;
  /** This process (default process.pid): never asked either (tests give their pretend apps' pids room). */
  self?: number;
  note?: Note;
  now?: () => number;
  /** Waits (tests pass one that doesn't). */
  sleep?: (ms: number) => Promise<void>;
}

/** One element of an answer, for its key (see answerKeys). */
export interface KeyItem {
  ref: AxRef;
  pid: number;
  /** Child indices from its window, where known. */
  path: number[] | null;
  /** Its window's CGWindowID (0: unknown). */
  windowId: number;
  role: string;
}

/**
 * The keys of one answer's elements in `mode` (KEY_MODE): "hash" gives `<pid>:h<CFHash>`, and to the elements whose
 * hash another one of the answer has too their index-path key (or, where the path isn't known, the hash and their
 * place in the answer), counted in `collisions`; "path" gives every element its index-path key
 * (`<pid>:p<CGWindowID>/<child indices>:<AX role>`), the hash key only where the path isn't known.
 */
export function answerKeys(items: readonly KeyItem[], hash: (ref: AxRef) => string, mode: "hash" | "path" = KEY_MODE): { keys: string[]; collisions: number } {
  const pathKey = (i: KeyItem) => (i.path ? `${i.pid}:p${i.windowId}/${i.path.join(".")}:${i.role}` : null);
  const hashes = items.map(i => `${i.pid}:h${hash(i.ref)}`);
  if (mode === "path") return { keys: items.map((i, k) => pathKey(i) ?? hashes[k]!), collisions: 0 };
  const count = new Map<string, number>();
  for (const k of hashes) count.set(k, (count.get(k) ?? 0) + 1);
  let collisions = 0;
  const keys = items.map((i, k) => {
    const key = hashes[k]!;
    if (count.get(key)! < 2) return key;
    collisions++;
    return pathKey(i) ?? `${key}:${k}`;
  });
  return { keys, collisions };
}

/** Does a window cover one of the displays (all of it, within a point)? */
export function coversDisplay(b: Rect, displays: readonly Rect[]): boolean {
  return displays.some(d => b.x <= d.x + COVER_SLACK && b.y <= d.y + COVER_SLACK
    && b.x + b.width >= d.x + d.width - COVER_SLACK && b.y + b.height >= d.y + d.height - COVER_SLACK);
}

/**
 * The system's windows shell_overlays reports, from the window list alone (never asked over AX): every drawn window of
 * a credential or consent prompt's process, loginwindow's while it covers a display (the lock screen), and the Dock's
 * above the normal layer while they cover a display (Mission Control, Launchpad), but not the Dock's own window, which
 * covers the display at rest (model.ts's isDockItself). null: an ordinary process.
 */
export function systemOverlays(entries: readonly AxWindowEntry[], displays: readonly Rect[]): { entries: AxWindowEntry[]; subrole: string } | null {
  const owner = entries[0]?.owner ?? "";
  if (SECURITY_OWNERS.has(owner)) return { entries: [...entries], subrole: "AXSystemDialog" };
  if (owner === "loginwindow") return { entries: entries.filter(e => coversDisplay(e.bounds, displays)), subrole: "AXSystemDialog" };
  if (owner === "Dock") return { entries: entries.filter(e => e.layer > 0 && !isDockItself(e) && coversDisplay(e.bounds, displays)), subrole: "AXSystemFloatingWindow" };
  return null;
}

/** A window listed from the window server's facts alone: no handle (nothing in it can be read). */
function listedOnly(e: AxWindowEntry, more: Partial<RawWindow> = {}): RawWindow {
  return { handle: 0, key: String(e.id), pid: e.pid, app: e.owner, title: e.title, platformRole: "AXWindow", bounds: { ...e.bounds }, native: e.id, offscreen: false, ...more };
}

const sleeper = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The macOS AX provider (see the module comment). */
export class AxDarwinProvider implements AxProvider {
  readonly kind = "ax" as const;
  readonly vocabulary = "ax" as const;
  readonly generation = 1;
  private api: AxApi | null = null;
  private opened = false;
  /** Why the last start failed (status's detail), null after one that worked. */
  private failure: string | null = null;
  private started = false;
  private stopped = false;
  private untrustedNoted = false;
  private handles = new Map<Handle, Held>();
  private nextHandle = 1;
  private readonly busy: BusyApps;
  /** Never asked anything: Ember's own process, and this one. */
  private readonly skip: ReadonlySet<number>;
  /** Apps AXManualAccessibility was set on (or tried). */
  private manual = new Set<number>();
  private readonly note: Note;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private o: AxDarwinOptions) {
    this.note = o.note ?? (() => undefined);
    this.busy = new BusyApps(o.now ?? Date.now);
    this.sleep = o.sleep ?? sleeper;
    this.skip = new Set([o.owner, o.self ?? process.pid].filter((p): p is number => p !== undefined && Number.isSafeInteger(p) && p > 0));
  }

  /** Handles given out and not given back (tests). */
  get live(): number {
    return this.handles.size;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("the accessibility provider was stopped");
    if (!this.opened) {
      this.opened = true;
      this.api = this.o.open();
    }
    if (!this.api) {
      const why = this.o.openError?.();
      this.failure = `the macOS accessibility API couldn't be loaded${why instanceof Error ? ` (${why.message})` : ""}`;
      throw new ProviderError("failed", this.failure);
    }
    if (!this.api.trusted()) {
      this.failure = "macOS hasn't given Ember the Accessibility permission";
      if (!this.untrustedNoted) {
        this.untrustedNoted = true;
        this.note("ax.untrusted");
      }
      throw new ProviderError("denied", NEEDS_PERMISSION);
    }
    this.failure = null;
    this.started = true;
  }

  async accessibility(): Promise<boolean | null> {
    return this.api ? this.api.trusted() : null;
  }

  health(): ProviderHealth {
    if (this.failure) return { ok: false, detail: this.failure };
    return { ok: this.started ? true : null };
  }

  async topWindows(): Promise<RawWindow[]> {
    const api = this.ready();
    const entries = api.onScreenWindows().filter(isVisible);
    const z = new Map(entries.map((e, i) => [e.id, i]));
    const byPid = new Map<number, AxWindowEntry[]>();
    for (const e of entries) {
      const list = byPid.get(e.pid);
      if (list) list.push(e);
      else byPid.set(e.pid, [e]);
    }
    let displays: Rect[] | null = null;
    const now = this.o.now ?? Date.now;
    const until = now() + WINDOWS_BUDGET_MS;
    const late = () => now() >= until;
    const frontmost = this.frontmostPid(api);
    const out: RawWindow[] = [];
    let cut = 0;
    // The frontmost app first: its window is the one the user is in, which a request without a window means.
    const order = [...byPid.keys()].sort((a, b) => Number(b === frontmost) - Number(a === frontmost));
    for (const pid of order) {
      const list = byPid.get(pid)!;
      const system = systemOverlays(list, (displays ??= api.displays()));
      if (system) {
        out.push(...system.entries.map(e => listedOnly(e, { platformSubrole: system.subrole })));
        continue;
      }
      if (this.skip.has(pid)) {
        // Ember's own: every window it draws, from the window list alone (the host never finds, reads or hit-tests them).
        out.push(...list.map(e => listedOnly(e)));
        continue;
      }
      const shown = list.filter(isAppWindow);
      if (!shown.length || SYSTEM_OWNERS.has(list[0]!.owner)) continue;
      if (this.busy.isBusy(pid)) {
        out.push(...shown.map(e => listedOnly(e, { busy: true })));
        continue;
      }
      if (late()) {
        cut++;
        out.push(...shown.map(e => listedOnly(e, { busy: true })));
        continue;
      }
      try {
        out.push(...this.appWindows(api, pid, list, frontmost === pid, late));
      } catch (err) {
        if (err instanceof ProviderError && err.code === "denied") throw err;
        // Busy: listed as last seen. Anything else (an app with no accessibility): listed, with nothing to read.
        const busy = err instanceof ProviderError && err.code === "busy";
        out.push(...shown.map(e => listedOnly(e, busy ? { busy: true } : {})));
      }
    }
    if (cut) this.note("ax.windows_cut", { apps: cut });
    // Front to back as the window server stacks them; a window it doesn't list (minimised) after its app's others.
    const rank = (w: RawWindow) => (w.native !== undefined && z.has(w.native) ? z.get(w.native)! : entries.length);
    return out.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map(x => x.w);
  }

  /**
   * An app's windows from AXWindows (one batched read each), each matched to its CGWindowID by _AXUIElementGetWindow,
   * else by its frame (then its title) among the app's on-screen windows; any on-screen window AX didn't list comes
   * from the window list alone. `frontmost`: the app is the system-wide AXFocusedApplication. Past `late`, the AX windows
   * not read yet are let go (their on-screen ones are listed from the window list).
   */
  private appWindows(api: AxApi, pid: number, list: AxWindowEntry[], frontmost: boolean, late: () => boolean = () => false): RawWindow[] {
    const s = new AxSession(api, pid, this.busy, this.note);
    const app = api.app(pid);
    if (!app) throw new ProviderError("failed", "the app's accessibility element couldn't be made");
    const value = s.attr(app, "AXWindows");
    const wins: AxRef[] = [];
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "bigint") wins.push(v);
        else releaseValue(api, v);
      }
    } else releaseValue(api, value);
    const owner = list[0]!.owner;
    const out: RawWindow[] = [];
    const matched = new Set<number>();
    let i = 0;
    try {
      for (; i < wins.length; i++) {
        const win = wins[i]!;
        if (late()) {
          for (; i < wins.length; i++) api.release(wins[i]!);
          break;
        }
        let f: Facts;
        try {
          f = s.facts(win, WINDOW_ATTRS);
        } catch (err) {
          if (err instanceof ProviderError && err.code !== "gone" && err.code !== "unsupported" && err.code !== "failed") throw err;
          api.release(win);
          continue; // closed while it was listed
        }
        releaseFacts(api, f);
        const id = api.windowId(win) || axWindowId({ id: 0, title: f.title, frame: f.frame }, list, pid);
        const cg = id ? list.find(e => e.id === id) : undefined;
        if (id) matched.add(id);
        const key = id ? String(id) : `${pid}:h${api.hash(win)}`;
        const handle = this.give(win, { pid, role: f.role || "AXWindow", subrole: f.subrole, frame: f.frame, depth: 0, path: [], windowId: id, clip: null, key });
        const w: RawWindow = {
          handle, key, pid, app: owner, title: f.title, platformRole: f.role || "AXWindow", bounds: f.frame ?? (cg ? { ...cg.bounds } : null),
          active: frontmost && f.main === true, offscreen: f.minimized === true || !cg,
        };
        if (f.subrole) w.platformSubrole = f.subrole;
        if (f.modal !== undefined) w.modal = f.modal;
        if (id) w.native = id;
        out.push(w);
      }
    } catch (err) {
      // The app stopped answering partway: none of what it gave is kept (its windows are listed as last seen).
      for (; i < wins.length; i++) api.release(wins[i]!);
      this.release(out.map(w => w.handle));
      throw err;
    }
    for (const e of list) if (isAppWindow(e) && !matched.has(e.id)) out.push(listedOnly(e));
    return out;
  }

  /** The frontmost app's pid (the system-wide AXFocusedApplication), or null when AX can't say. */
  private frontmostPid(api: AxApi): number | null {
    const system = api.systemWide();
    if (!system) return null;
    const v = api.attr(system, "AXFocusedApplication");
    if (isAxError(v)) return null;
    const pid = typeof v === "bigint" ? api.pid(v) : 0;
    releaseValue(api, v);
    return pid > 0 ? pid : null;
  }

  async snapshot(window: Handle, o: SnapshotOptions): Promise<Snapshot> {
    const api = this.ready();
    const held = this.held(window);
    const s = this.session(api, held.pid);
    await this.manualAccessibility(api, held.pid);
    const r = walk(s, held.ref, { maxDepth: o.maxDepth, maxNodes: o.maxNodes, deadlineMs: o.deadlineMs, now: this.o.now });
    const keys = this.keysFor(api, r.nodes.map(n => ({ ref: n.ref, pid: held.pid, path: n.path, windowId: held.windowId, role: n.node.platformRole })));
    const nodes = r.nodes.map((n, i): RawNode => {
      const key = keys[i]!;
      const handle = this.give(n.ref, {
        pid: held.pid, role: n.node.platformRole, subrole: n.node.platformSubrole ?? "", frame: n.node.bounds, depth: n.depth, path: n.path,
        windowId: held.windowId, clip: n.clip, key,
      });
      return this.raw(n.node, { handle, key, parent: n.parent, depth: n.depth, pid: held.pid, native: i === 0 && held.windowId ? held.windowId : undefined });
    });
    return { nodes, truncated: r.truncated, cut: r.cut, ...(r.busy ? { busy: true } : {}) };
  }

  async element(h: Handle): Promise<RawNode | null> {
    const api = this.ready();
    const held = this.handles.get(h);
    if (!held) return null;
    const s = this.session(api, held.pid);
    let looked: ReturnType<typeof lookAt>;
    try {
      looked = lookAt(s, held.ref);
    } catch (err) {
      if (err instanceof ProviderError && err.code === "gone") return null;
      throw err;
    }
    const node = looked.node;
    if (held.depth > 0 && clippedOut(looked.facts, held.clip)) node.offscreen = true;
    return this.raw(node, { handle: h, key: held.key, parent: -1, depth: held.depth, pid: held.pid, native: held.depth === 0 && held.windowId ? held.windowId : undefined });
  }

  async elementsAt(x: number, y: number, pid?: number): Promise<RawNode[]> {
    const api = this.ready();
    let target = pid;
    if (target === undefined) {
      // No app named: the one whose window is drawn at the point, never Ember (its overlay included). It is asked
      // app-scoped too, so a click-through window of Ember's the window list and AX see differently can't route the
      // request to Ember.
      const top = api.onScreenWindows().find(e => isVisible(e) && contains(e.bounds, x, y));
      if (!top) return [];
      target = top.pid;
    }
    if (this.skip.has(target)) return [];
    const s = this.session(api, target);
    s.calls++;
    const hit = api.at(x, y, target);
    if (isAxError(hit)) {
      if (hit.axError === AX_ERROR.cannotComplete || hit.axError === AX_ERROR.apiDisabled) s.raise(hit.axError, "hit-test");
      return []; // nothing there AX can name
    }
    const hitPid = api.pid(hit);
    if (this.skip.has(hitPid) || hitPid !== target) {
      api.release(hit);
      return [];
    }
    // Up from the element at the point to its window (each with its parent in the same round trip), then reversed.
    const up: { ref: AxRef; node: NodeBody; facts: Facts }[] = [];
    const seen = new Set<string>();
    let cur: AxRef | null = hit;
    try {
      while (cur && up.length < CHAIN_MAX) {
        const ref: AxRef = cur;
        cur = null;
        const hash = api.hash(ref);
        if (seen.has(hash)) { api.release(ref); break; }
        seen.add(hash);
        let g: ReturnType<typeof glance>;
        try {
          g = glance(s, ref, CHAIN_ATTRS);
        } catch (err) {
          api.release(ref);
          // Gone while it was climbed: what was read so far is the chain (none: nothing there now).
          if (err instanceof ProviderError && err.code === "gone") break;
          throw err;
        }
        const parent = g.facts.parent;
        g.facts.parent = null;
        if (g.facts.role === "AXApplication") {
          api.release(ref);
          if (parent) api.release(parent);
          break;
        }
        up.push({ ref, node: g.node, facts: g.facts });
        if (g.facts.role === "AXWindow") {
          if (parent) api.release(parent);
          break;
        }
        cur = parent;
      }
    } catch (err) {
      for (const u of up) api.release(u.ref);
      if (cur) api.release(cur);
      throw err;
    }
    if (cur) api.release(cur);
    const chain = up.reverse();
    if (!chain.length) return [];
    const windowId = chain[0]!.facts.role === "AXWindow" ? api.windowId(chain[0]!.ref) : 0;
    const keys = this.keysFor(api, chain.map(c => ({ ref: c.ref, pid: target!, path: null, windowId, role: c.node.platformRole })));
    let clip: Rect | null = null;
    return chain.map((c, i): RawNode => {
      const judged = clip;
      if (i > 0 && clippedOut(c.facts, judged)) c.node.offscreen = true;
      clip = clipInside(c.facts, judged, i);
      const key = keys[i]!;
      const handle = this.give(c.ref, {
        pid: target!, role: c.node.platformRole, subrole: c.node.platformSubrole ?? "", frame: c.node.bounds, depth: i, path: null,
        windowId, clip: judged, key,
      });
      return this.raw(c.node, { handle, key, parent: i - 1, depth: i, pid: target!, native: i === 0 && windowId ? windowId : undefined });
    });
  }

  async focused(): Promise<{ element: RawNode | null; window: Handle | null }> {
    const api = this.ready();
    const pid = this.frontmostPid(api);
    if (pid === null || this.skip.has(pid)) return { element: null, window: null };
    const s = this.session(api, pid);
    const app = api.app(pid);
    if (!app) return { element: null, window: null };
    const el = s.attr(app, "AXFocusedUIElement");
    if (typeof el !== "bigint") {
      releaseValue(api, el);
      return { element: null, window: null };
    }
    let win: AxRef | null = null;
    let g: ReturnType<typeof glance>;
    try {
      const w = s.attr(el, "AXWindow");
      if (typeof w === "bigint") win = w;
      else releaseValue(api, w);
      g = glance(s, el);
    } catch (err) {
      if (win) api.release(win);
      api.release(el);
      throw err;
    }
    const windowId = win ? api.windowId(win) : 0;
    const key = this.keysFor(api, [{ ref: el, pid, path: null, windowId, role: g.node.platformRole }])[0]!;
    const handle = this.give(el, { pid, role: g.node.platformRole, subrole: g.node.platformSubrole ?? "", frame: g.node.bounds, depth: 1, path: null, windowId, clip: null, key });
    const element = this.raw(g.node, { handle, key, parent: -1, depth: 1, pid });
    if (!win) return { element, window: null };
    const wkey = windowId ? String(windowId) : `${pid}:h${api.hash(win)}`;
    return { element, window: this.give(win, { pid, role: "AXWindow", subrole: "", frame: null, depth: 0, path: [], windowId, clip: null, key: wkey }) };
  }

  async children(h: Handle, max: number): Promise<RawNode[]> {
    const api = this.ready();
    const held = this.held(h);
    const s = this.session(api, held.pid);
    let from = held.ref;
    let menu: AxRef | null = null;
    let base = held.path;
    let depth = held.depth + 1;
    if (held.role === "AXPopUpButton") {
      // A pop-up's options are its menu's items, which exist only while it is open (closed, it has none to give).
      const first = s.children(held.ref, ["AXChildren"], 1).kids;
      let role: unknown;
      try {
        role = first[0] ? s.attr(first[0], "AXRole") : undefined;
      } catch (err) {
        for (const k of first) api.release(k);
        throw err;
      }
      if (role !== "AXMenu") {
        for (const k of first) api.release(k);
        return [];
      }
      menu = from = first[0]!;
      base = base ? [...base, 0] : null;
      depth++;
    }
    let kids: AxRef[];
    try {
      kids = s.children(from, ["AXChildren"], Math.max(0, max)).kids;
    } finally {
      if (menu) api.release(menu);
    }
    // An open menu is drawn in a window of its own, over the pop-up's window: that window doesn't clip its items.
    const clip = menu ? null : clipInside({ role: held.role, frame: held.frame }, held.clip, held.depth);
    const read: { ref: AxRef; node: NodeBody; facts: Facts; index: number }[] = [];
    for (let index = 0; index < kids.length; index++) {
      const k = kids[index]!;
      try {
        const g = glance(s, k, undefined, CELL_PARENTS.has(menu ? "AXMenu" : held.role));
        read.push({ ref: k, node: g.node, facts: g.facts, index });
      } catch (err) {
        api.release(k);
        if (err instanceof ProviderError && (err.code === "gone" || err.code === "unsupported" || err.code === "failed")) continue; // left out
        // Busy or denied: nothing of this answer is kept.
        for (const r of read) api.release(r.ref);
        for (const rest of kids.slice(index + 1)) api.release(rest);
        throw err;
      }
    }
    const keys = this.keysFor(api, read.map(r => ({ ref: r.ref, pid: held.pid, path: base ? [...base, r.index] : null, windowId: held.windowId, role: r.node.platformRole })));
    return read.map((r, i): RawNode => {
      // Closed menus' items and the like have no frame: offscreen, as UI Automation says of a closed drop-down's options.
      if (!r.facts.frame || clippedOut(r.facts, clip)) r.node.offscreen = true;
      const key = keys[i]!;
      const handle = this.give(r.ref, {
        pid: held.pid, role: r.node.platformRole, subrole: r.node.platformSubrole ?? "", frame: r.node.bounds, depth,
        path: base ? [...base, r.index] : null, windowId: held.windowId, clip, key,
      });
      return this.raw(r.node, { handle, key, parent: -1, depth, pid: held.pid });
    });
  }

  async perform(h: Handle, op: PerformOp, value?: unknown): Promise<void> {
    const api = this.ready();
    const held = this.held(h);
    if (op === "setValue" && held.subrole === "AXSecureTextField") throw new ProviderError("denied", "a password field's value isn't set");
    const s = this.session(api, held.pid);
    const f = s.facts(held.ref);
    try {
      doPerform(s, held.ref, f, op, value);
    } finally {
      releaseFacts(api, f);
    }
  }

  async textInfo(h: Handle, maxChars: number): Promise<TextInfo> {
    const api = this.ready();
    const held = this.held(h);
    if (held.subrole === "AXSecureTextField") return { secret: true };
    return textOf(this.session(api, held.pid), held.ref, maxChars);
  }

  release(hs: Handle[]): void {
    for (const h of hs) {
      const held = this.handles.get(h);
      if (!held) continue;
      this.handles.delete(h);
      this.api?.release(held.ref);
    }
  }

  stop(): void {
    this.stopped = true;
    this.release([...this.handles.keys()]);
  }

  /** The API, once started (every request starts the provider first). */
  private ready(): AxApi {
    if (this.stopped) throw new ProviderError("failed", "the accessibility provider was stopped");
    if (!this.api || !this.started) throw new ProviderError("failed", "the accessibility provider hasn't started");
    return this.api;
  }

  /** The element behind a handle (gone: one given back, or never given). */
  private held(h: Handle): Held {
    const held = this.handles.get(h);
    if (!held) throw new ProviderError("gone", "the element isn't there any more");
    if (this.skip.has(held.pid)) throw new ProviderError("gone", "Ember's own windows aren't read");
    return held;
  }

  /** The calls for app `pid` in this request (busy at once while it is remembered as busy; never Ember's). */
  private session(api: AxApi, pid: number): AxSession {
    if (this.skip.has(pid)) throw new ProviderError("gone", "Ember's own windows aren't read");
    if (this.busy.isBusy(pid)) throw busyError(pid);
    return new AxSession(api, pid, this.busy, this.note);
  }

  /** Gives a handle for an element (its reference is the provider's from now on). */
  private give(ref: AxRef, held: Omit<Held, "ref">): Handle {
    const h = this.nextHandle++;
    this.handles.set(h, { ref, ...held });
    return h;
  }

  /** A RawNode from what was read and where it sits. */
  private raw(node: NodeBody, at: { handle: Handle; key: string; parent: number; depth: number; pid: number; native?: number }): RawNode {
    const n: RawNode = { ...node, handle: at.handle, key: at.key, parent: at.parent, depth: at.depth, pid: at.pid };
    if (at.native) n.native = at.native;
    return n;
  }

  /** The keys of one answer's elements (answerKeys in KEY_MODE), a collision noted in the log. */
  private keysFor(api: AxApi, items: KeyItem[]): string[] {
    const { keys, collisions } = answerKeys(items, ref => api.hash(ref));
    if (collisions) this.note("ax.key_collision", { count: collisions });
    return keys;
  }

  /**
   * Turns Chromium's (and Electron's) accessibility on for an app, once, at its first read: AXManualAccessibility on its
   * app element. Any other app answers that it has no such attribute, which costs one round trip once. When an app
   * took it, its tree is built in the background: the first read waits a moment for it.
   */
  private async manualAccessibility(api: AxApi, pid: number): Promise<void> {
    if (this.manual.has(pid)) return;
    this.manual.add(pid);
    const app = api.app(pid);
    if (!app) return;
    const error = api.set(app, "AXManualAccessibility", true);
    if (error?.axError === AX_ERROR.cannotComplete) {
      // It didn't answer: the read would wait just as long.
      this.busy.mark(pid);
      this.note("ax.busy", { pid });
      throw busyError(pid);
    }
    if (error) return;
    this.note("ax.manual_accessibility", { pid });
    await this.sleep(MANUAL_SETTLE_MS);
  }
}
