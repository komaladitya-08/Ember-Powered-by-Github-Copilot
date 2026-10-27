/**
 * Perception: what is on the user's screen, as text (always) and as an image
 * (for workers, on request). Text comes from the accessibility tree via the
 * sidecar; images come straight from the window system (X11 on Linux) with Ember
 * hidden and private windows and secret fields blacked out. Every position handed
 * out is in the window system's native units (physical pixels on Linux and Windows,
 * points on macOS), also for HiDPI apps that report logical ones (see windows.ts).
 * Plain Node: the window system, the OS's words and its security-window vocabulary
 * come in through PerceptionOptions, and each defaults to today's Linux behaviour.
 */

import { friendlyApp } from "../../shared/apps";
import { PLATFORM_WORDS, type PlatformWords } from "../../shared/words";
import { isSecurityWindow as linuxSecurityWindow } from "../policy/policy";
import { captureRect, type Capture } from "./capture";
import { marksSvg } from "./marks";
import { focusedElement, insideSecrets, isNeverLook, isSecretNode, secretIds, serializeElements, inferLabels, quoteUntrusted, screenWord, withheldIds } from "./elements";
import { scaleBounds, type AxNode, type AxWindow, type Bounds, type OtherWindow, type PointElement, type ReadWindowResult } from "./sidecar";
import { coveringRects, elementScales, isPopupOf, matchFrame, OVERLAY_TITLE, samePopups, scaleNodes, shellCovers, uncoveredArea, type FrameMatch } from "./windows";
import type { PerceptionWindows, PrivacyVocabulary, StackedWindow, X11Window } from "../platform/types";
import type { Logger } from "../logger";
import type { PerceptionSidecar } from "./ports";
import type { TargetId } from "../../shared/targets";

/** What Perception is given (main.ts, and the desk's own Perception in desk/place.ts). */
export interface PerceptionOptions {
  sidecar: PerceptionSidecar;
  /**
   * The window system: X11 on Linux (or the desk's remote X11), the Windows or macOS backend elsewhere; null without
   * one. The field keeps its old name so the desk and the tests keep compiling.
   */
  x11: (PerceptionWindows & ScreenAccess) | null;
  neverLook: () => string[];
  /** Full screen in native units (all displays): physical pixels on Linux and Windows, points on macOS. */
  screenBounds: () => Bounds;
  hideOverlay?: () => Promise<() => void>;
  log: Logger;
  /**
   * Ember's own process. Its windows stay out of screenshots, but the ones that take clicks
   * (handle, desk view, ask box) hide what lies under them; the click-through overlay doesn't.
   */
  ownPid?: number;
  /** The OS's words for why there is no screenshot (default: Linux's, today's text). */
  words?: Pick<PlatformWords, "shellUnchecked" | "overviewOpen" | "noScreenAccess">;
  /** Authentication and security windows on this OS (default: policy.ts's Linux vocabulary, today's check). */
  isSecurityWindow?: PrivacyVocabulary["isSecurityWindow"];
  /**
   * Is this app a remote surface (policy/remote-surface.ts; Windows: a remote desktop's or a WSLg app's window)? Those
   * are blacked out of every screenshot. Absent on Linux and macOS, which capture as before.
   */
  isRemoteSurface?: (app: string) => boolean;
  /** How a screenshot is taken (default captureRect; the remote agent passes its own, which needs no sharp). */
  capture?: typeof captureRect;
  /**
   * The first time in a run a picture is refused because the OS refused Ember the screen (macOS without Screen
   * Recording): Ember says so itself, with a way to the setting (main.ts). The worker's text says so every time.
   */
  onNoScreenAccess?: () => void;
}

/**
 * What a window system may add for Perception: macOS's window system says whether Ember has the Screen Recording
 * permission (DarwinWindowSystem.screenRecording), so a missing one is named instead of "off screen". Absent on Linux,
 * Windows and the desk, which need no permission to capture.
 */
export interface ScreenAccess { screenRecording?(): boolean }

/**
 * A window to read. `pid` with `path` (from an earlier read) names exactly one
 * window; otherwise pid and title are matched together. Never the active
 * window instead: a target that matches nothing is not found.
 */
export interface WindowTarget { pid?: number; title?: string; path?: string }

export interface QuickContext {
  /** The window the user was in; tasks start there. */
  target: WindowTarget & { app?: string };
  /** For the model, wrapped as untrusted. */
  text: string;
  /**
   * The X selection may be added (withSelection): set from what was read, never from the text (other windows' titles
   * are in it). Only when the window isn't private, the focus isn't a secret field, and the app told no selection.
   */
  takesSelection?: boolean;
  /** The target whose screen it was read on (absent: this computer's, "local"); a task starts there only on that target. */
  targetId?: TargetId;
}

export interface Seen {
  window: AxWindow | null;
  x11Window: (X11Window & { wmClass?: string }) | null;
  nodes: AxNode[];
  blocked: boolean;
  /** The app didn't answer in time, even when asked again (busy or hung): `nodes` are partial, or there is no window. */
  busy: boolean;
  /**
   * Cut short: "nodes" at the element limit, "time" when reading took too long, "depth" when something on screen is
   * nested deeper than a read goes, "loading" when a web page shows but the browser hasn't handed over what it holds.
   */
  truncated: "nodes" | "time" | "depth" | "loading" | null;
  /** The app's other windows the user is in or must answer first (an Open dialog); private ones left out. */
  others: OtherWindow[];
  ms: number;
  /** Physical pixels per pixel the app's window frame reports (2 for GDK_SCALE=2); the bounds here are already physical. */
  axScale: number;
  /** The user is in one of Ember's own windows (the ask box, settings): Ember never reads those, so nothing was read. */
  ember?: boolean;
}

export interface Perceived extends Seen {
  text: string;
  capture: Capture | null;
}

/** A busy app (a file dialog listing a big folder) is asked once more after this long. */
const BUSY_RETRY_MS = 300;
/** Secret fields whose position is checked again once the picture is taken (they can scroll meanwhile). */
const MAX_SECRET_RECHECK = 24;
/** Popups accessibility doesn't list that are logged in a run (perception.popup_unmatched). */
const UNMATCHED_POPUPS_LOGGED = 32;
/** Workers see every element a read returns (the sidecar's MAX_NODES), so every id they may need is there. */
const WORKER_LINES = 400;

export class Perception {
  /** The overlay hide in progress: concurrent captures share it, and Ember shows again when the last one is done. */
  private hidden: { count: number; restore: Promise<() => void> } | null = null;
  /** Scale per app (by pid): it rarely changes, and finding it takes a walk over the X window tree. */
  private scales = new Map<string, { k: number; until: number }>();
  /** This OS's security-window check (one argument only: a second one would pick another OS's vocabulary). */
  private readonly isSecurity: PrivacyVocabulary["isSecurityWindow"];
  private readonly words: Pick<PlatformWords, "shellUnchecked" | "overviewOpen" | "noScreenAccess">;
  /** onNoScreenAccess was called (once a run). */
  private toldNoScreenAccess = false;
  /** The popups accessibility didn't list that were logged (app and size), a few at most. */
  private unmatchedPopups = new Set<string>();

  constructor(private o: PerceptionOptions) {
    this.isSecurity = o.isSecurityWindow ?? (w => linuxSecurityWindow(w));
    this.words = o.words ?? PLATFORM_WORDS.linux;
  }

  /** The focused window's accessibility tree (empty when blocked or unreadable). */
  async focused(stack?: StackedWindow[] | null): Promise<Seen> {
    const x11Window = this.o.x11?.activeWindow() ?? null;
    if (x11Window && x11Window.pid === this.ownPid) {
      return { window: null, x11Window: null, nodes: [], blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1, ember: true };
    }
    return this.read(x11Window ? { pid: x11Window.pid ?? undefined, title: x11Window.title } : {}, x11Window, stack);
  }

  /** Ember's own process: its windows (the ask box, settings, the overlay) are never read or listed. */
  private get ownPid(): number {
    return this.o.ownPid ?? process.pid;
  }

  /** On the never-look list, or a password or authentication prompt (polkit, keyring…): Ember looks away (M8.3). */
  private isPrivate(app: string, title: string, list: string[]): boolean {
    return isNeverLook({ app, name: title }, list) || this.isSecurity({ app, title });
  }

  /**
   * A window's tree (see WindowTarget); with an empty target, the active window's. `stack`: the
   * X11 windows when the caller has them (undefined: looked up when needed). `keep: false`: a quick
   * look whose ids aren't acted on, which keeps the ids of the reads that are (AtspiSidecar.readWindow). `cells`: the
   * spreadsheet cells ("C62") the cell with the keyboard is expected in, asked first when a read doesn't come to it.
   */
  async read(target: WindowTarget, x11Window: (X11Window & { wmClass?: string }) | null = null, stack?: StackedWindow[] | null, o: { keep?: boolean; cells?: string[] } = {}): Promise<Seen> {
    const t0 = Date.now();
    const params = target.pid != null && target.path ? { pid: target.pid, path: target.path }
      : target.pid != null || target.title ? { ...(target.pid != null ? { pid: target.pid } : {}), ...(target.title ? { title: target.title } : {}) }
      : target.path ? null // a path means nothing without its process
      : {};
    const list = this.o.neverLook().filter(i => i.trim());
    // Never-look apps are known by their X11 class too (an Electron app's accessibility name is only
    // "electron"): those processes aren't read at all.
    if (list.length && stack === undefined) stack = this.stackNow();
    const skipPids = list.length && stack ? [...new Set(stack.filter(s => s.pid != null && isNeverLook({ app: s.wmClass, name: "" }, list)).map(s => s.pid!))] : [];
    const ask = () => params ? this.o.sidecar.readWindow({ ...params, ownPid: this.ownPid, ...(list.length ? { neverLook: list, skipPids } : {}), ...(o.keep === false ? { keep: false } : {}), ...(o.cells?.length ? { cells: o.cells } : {}) })
      : Promise.resolve<ReadWindowResult>({ window: null, nodes: [], ms: 0 });
    let res = await ask();
    if (res.busy) {
      await new Promise(r => setTimeout(r, BUSY_RETRY_MS));
      const again = await ask();
      // The second answer, unless the app answered even less of it.
      if (!again.busy || again.nodes.length >= res.nodes.length) res = again;
    }
    const window = res.window;
    const match = window && stack ? matchFrame(window, stack) : null;
    const blocked = !!res.blocked
      || !!window && this.isPrivate(window.app, window.name, list)
      || !!match && this.isPrivate(match.window.wmClass, match.window.title, list)
      || !!x11Window && this.isPrivate(x11Window.wmClass ?? "", x11Window.title, list);
    const none = { busy: false, truncated: null, others: [], axScale: 1 };
    if (blocked) {
      // A private window's title goes no further than this (not to the model, not to the logs).
      return { ...none, window: window && { ...window, name: "" }, x11Window: x11Window && { ...x11Window, title: "" }, nodes: [], blocked, ms: Date.now() - t0 };
    }
    if (!window) return { ...none, window, x11Window, nodes: [], blocked, busy: !!res.busy, ms: Date.now() - t0 };
    const k = this.frameScale(window, stack, match);
    const frame = window.bounds && scaleBounds(window.bounds, k);
    // Element by element: Chromium's web contents report physical pixels inside a frame that reports logical ones.
    const each = k !== 1 ? elementScales(res.nodes, k, frame) : null;
    if (each) {
      const groups = new Map<number, number[]>();
      for (const [id, s] of each) if (s !== 1) groups.set(s, [...groups.get(s) ?? [], id]);
      // A quick look's ids go in a slot the next quick look replaces (as in the sidecar): the kept reads' stay scaled.
      for (const [s, ids] of groups) this.o.sidecar.scaleElements(ids, s, o.keep !== false);
    }
    const nodes = await this.withSecrets(scaleNodes(res.nodes, each ?? 1));
    return {
      window: { ...window, bounds: frame }, x11Window, nodes, blocked, busy: !!res.busy,
      truncated: res.slow ? "time" : !res.truncated ? null : res.cut?.includes("loading") ? "loading"
        : res.cut?.length && !res.cut.includes("nodes") ? "depth" : "nodes",
      others: (res.others ?? []).filter(w => !this.isPrivate(window.app, w.name, list)),
      ms: Date.now() - t0, axScale: k,
    };
  }

  /**
   * What shows at point `p` in the window `target` names (its pid and path), outermost first: for the wheel, whether
   * a control it would change is there. Positions are as the app reports them, the same as read()'s for a window
   * whose axScale is 1; `k`: the app reports `k` physical pixels per pixel (HiDPI), and `p` and the positions
   * handed back are physical. null when that can't be told: no pid and path, a private or closed window, an app
   * that didn't answer in time.
   */
  async atPoint(target: WindowTarget, p: { x: number; y: number }, k = 1): Promise<PointElement[] | null> {
    if (target.pid == null || !target.path) return null;
    const list = this.o.neverLook().filter(i => i.trim());
    const stack = list.length ? this.stackNow() : null;
    const skipPids = list.length && stack ? [...new Set(stack.filter(s => s.pid != null && isNeverLook({ app: s.wmClass, name: "" }, list)).map(s => s.pid!))] : [];
    // An open menu is drawn in a popup window of its own: the app's menus are looked through only where one of its
    // popups covers the point (or Ember can't tell), as they take dozens of calls in a big app.
    const all = stack ?? this.stackNow();
    const menus = !all || all.some(s => s.overrideRedirect && s.pid === target.pid && p.x >= s.x && p.y >= s.y && p.x < s.x + s.width && p.y < s.y + s.height);
    const res = await this.o.sidecar.atPoint({ pid: target.pid, path: target.path, x: Math.floor(Math.round(p.x) / k), y: Math.floor(Math.round(p.y) / k), ownPid: this.ownPid, ...(menus ? {} : { menus: false }), ...(list.length ? { neverLook: list, skipPids } : {}) });
    if (res.blocked || res.busy || res.found === false) return null;
    return k === 1 ? res.chain : res.chain.map(n => (n.bounds ? { ...n, bounds: scaleBounds(n.bounds, k) } : n));
  }

  /**
   * Fields the sidecar didn't know were secret (a revealed password beside its "Show password"
   * toggle, an unnamed field under a "Card number" label): their contents are dropped here, and
   * the sidecar is told, so nothing is typed into them either. So are the names that say what they
   * hold (a table's cell named after the card number in it: see withheldIds).
   */
  private async withSecrets(nodes: AxNode[]): Promise<AxNode[]> {
    const secret = secretIds(nodes);
    // What a secret field holds goes too (Chromium lists a text box's text as static text inside it).
    const inside = insideSecrets(nodes, secret);
    const saysSelected = new Set<number>();
    const withheld = withheldIds(nodes, secret, saysSelected);
    const fresh = nodes.filter(n => secret.has(n.id) && !n.secret).map(n => n.id);
    if (!fresh.length && !inside.size && !withheld.size && !saysSelected.size) return nodes;
    if (fresh.length) await Promise.resolve().then(() => this.o.sidecar.markSecret(fresh)).catch(err => this.o.log.warn("perception.mark_secret_failed", { err }));
    return nodes.flatMap(n => {
      if (inside.has(n.id)) return [];
      if (withheld.has(n.id)) {
        // Marked, so what it is called counts as unknown (the policy asks before a click on it).
        const { text: _text, selection: _selection, selected: _selected, ...rest } = n;
        n = { ...rest, name: "", withheld: true };
      } else if (saysSelected.has(n.id)) {
        // A drop-down showing what a secret field holds: the option goes, its name stays.
        const { selected: _selected, ...rest } = n;
        n = rest;
      }
      if (!secret.has(n.id) || n.secret) return [n];
      const { text: _text, selection: _selection, selected: _selected, value: _value, ...rest } = n;
      return [{ ...rest, secret: true }];
    });
  }

  /**
   * Physical pixels per pixel this window's frame reports: its X11 top-level's size over its
   * accessibility frame's (HiDPI apps report logical pixels). From `stack` when given, else
   * remembered per app for a while.
   */
  private frameScale(window: AxWindow, stack?: StackedWindow[] | null, match?: FrameMatch | null): number {
    const key = window.pid != null ? `pid:${window.pid}` : `title:${window.name}`;
    const now = Date.now();
    if (!stack) {
      const known = this.scales.get(key);
      if (known && known.until > now) return known.k;
      stack = this.stackNow();
      if (!stack) return 1;
      match = undefined;
    }
    if (match === undefined) match = matchFrame(window, stack);
    const k = match?.scale ?? 1;
    if (k !== 1 && this.scales.get(key)?.k !== k) this.o.log.info("perception.hidpi", { pid: window.pid, scale: Math.round(k * 100) / 100 });
    this.scales.delete(key);
    this.scales.set(key, { k, until: now + (match ? 30_000 : 5_000) });
    if (this.scales.size > 200) this.scales.delete(this.scales.keys().next().value!);
    return k;
  }

  /** The X11 top-level windows, bottom to top (null without X11 or when it fails). */
  private stackNow(): StackedWindow[] | null {
    if (!this.o.x11) return null;
    try {
      return this.o.x11.stack();
    } catch (err) {
      this.o.log.warn("perception.stack_failed", { err });
      return null;
    }
  }

  /** Where the window read in `seen` is in the stack (null when it can't be found there). */
  private locate(seen: Seen, stack: StackedWindow[]): { index: number; rect: Bounds; pid: number | null } | null {
    if (seen.window) {
      // Its bounds are physical already, so it matches at scale 1.
      const m = matchFrame(seen.window, stack);
      return m && { index: m.index, rect: { x: m.window.x, y: m.window.y, width: m.window.width, height: m.window.height }, pid: m.window.pid };
    }
    const w = seen.x11Window;
    const index = w ? stack.findIndex(s => s.client === w.id || s.id === w.id) : -1;
    if (index < 0) return null;
    const s = stack[index];
    return { index, rect: { x: s.x, y: s.y, width: s.width, height: s.height }, pid: s.pid };
  }

  /**
   * Taken the moment the user calls Ember (before the ask box or anything else
   * takes focus): which window they're in, what has focus, and any selected
   * text, so "make this bold" knows what "this" is. Short; untrusted.
   */
  async quickContext(): Promise<QuickContext | null> {
    let seen: Seen;
    try {
      seen = await this.focused();
    } catch {
      return null;
    }
    // Every window, not just the focused one: "what apps are open" is answered from this context, without a read.
    // X11's list is used here because it is immediate: the sidecar answers one request at a time, and the focused
    // read already took its turn. (Listed only when the context will say it: not for a private or untitled window.)
    const title = seen.window?.name || seen.x11Window?.title || "";
    return quickContextText(seen, seen.blocked || !title ? [] : openWindowLines(this.x11Windows()));
  }

  /**
   * Every app's top-level window as open-window entries, Ember's own and private ones left out, each line said once.
   * `activeId`: the X11 window the user is in, marked as focused.
   */
  private x11Windows(activeId?: number): OpenWindow[] {
    let wins: (X11Window & { wmClass: string; wmClassName?: string })[];
    try {
      wins = this.o.x11?.clientWindows() ?? [];
    } catch (err) {
      this.o.log.warn("perception.list_windows_failed", { err });
      return [];
    }
    const list = this.o.neverLook().filter(i => i.trim());
    const out = wins.filter(w => w.pid !== this.ownPid
      && !isNeverLook({ app: w.wmClass, name: w.title }, list)
      && !this.isSecurity({ app: w.wmClass, title: w.title })
      // Each part of WM_CLASS on its own as well: some programs are known by one exact name ("firewall-config"),
      // which accessibility gives and the two parts joined don't match. On Windows wmClassName is the window class
      // ("Credential Dialog Xaml Host").
      && !w.wmClass.split(/\s+/).concat(w.wmClassName ?? []).some(part => part && this.isSecurity({ app: part })))
      .map((w): OpenWindow => {
        // The class part of WM_CLASS ("VirtualBox Manager"); the last word of both, where only they are known.
        const cls = w.wmClassName ?? w.wmClass.split(/\s+/).filter(Boolean).at(-1) ?? "";
        return { app: friendlyApp(cls) || "unknown app", title: w.title, active: w.id === activeId };
      });
    // Windows that read alike (two "Untitled" documents of one app) are listed once.
    const said = new Set<string>();
    return out.filter(w => { const line = openWindowLine(w); if (said.has(line)) return false; said.add(line); return true; });
  }

  /**
   * The quick context with the text the user selected, as the X selection (PRIMARY) holds it, where the app didn't
   * tell it through accessibility (or the read didn't come to it). Never in a private window or a secret field:
   * quickContext says so (takesSelection), as the text can't (other windows' titles are anyone's words).
   */
  static withSelection(ctx: QuickContext | null, selected: string): QuickContext | null {
    const text = selected.replace(/\0/g, "").trim();
    if (!ctx?.takesSelection || !text) return ctx;
    // With the focused window's lines, before the list of open windows. Screen text is quoted on one line, so
    // nothing in a title can pass for where that list starts.
    const at = ctx.text.indexOf("\n\nOpen windows:\n");
    const end = at >= 0 ? at : ctx.text.lastIndexOf("\n</context>");
    if (end < 0) return ctx;
    return { ...ctx, text: `${ctx.text.slice(0, end)}\nSelected text: ${quoteUntrusted(text, 300)}.${ctx.text.slice(end)}`, takesSelection: false };
  }

  /** Text for the conductor: where the user is and what the window contains. */
  async describe(): Promise<string> {
    let seen: Seen;
    try {
      seen = await this.focused();
    } catch (err) {
      this.o.log.warn("perception.describe_failed", { err });
      return "Ember could not read the screen right now (the accessibility service did not answer).";
    }
    // (Nothing more is listed for a private window.)
    return describeText(seen, seen.blocked ? "" : await this.openWindows(seen.x11Window?.id));
  }

  /**
   * Every open window (not just the focused one), so the conversation can answer "what apps are open". X11's list
   * where there is one, as in quickContext: it is immediate (the sidecar answers one request at a time, and the
   * focused read just took its turn), has apps that expose nothing over accessibility, and is the list the question's
   * context gave. `activeId`: the X11 window the user is in.
   */
  private async openWindows(activeId?: number): Promise<string> {
    if (this.o.x11) return openWindowsBlock(this.x11Windows(activeId));
    let wins: AxWindow[];
    try {
      wins = await this.windows();
    } catch (err) {
      this.o.log.warn("perception.list_windows_failed", { err });
      return "";
    }
    // Titles reach the model: text typed elsewhere may carry them, so they stay quoted and untrusted.
    return openWindowsBlock(wins.map(w => ({ app: w.app, title: w.name, active: w.active, ...(w.busy ? { busy: true } : {}) })));
  }

  /**
   * For workers: elements with bounds, plus an optional marked screenshot. A window
   * screenshot shows only that window: whatever other windows cover of it is blacked
   * out, and so are secret fields (they get no mark either).
   */
  async perceive(opts: { image: boolean; scope: "window" | "screen"; target?: WindowTarget }): Promise<Perceived> {
    // One fresh look at the window stack serves the scale, what covers the window, and the private windows.
    const stack = opts.image ? this.stackNow() : undefined;
    const seen = opts.target ? await this.read(opts.target, null, stack) : await this.focused(stack);
    const text = perceivedText(seen);
    if (!opts.image || seen.blocked) return { ...seen, text, capture: null };
    const noShot = (why: string): Perceived => ({ ...seen, text: `${text}\n(No screenshot: ${why}.)`, capture: null });
    const x11 = this.o.x11;
    if (!x11) return noShot("screenshots aren't available on this display");
    // A window's picture needs the window: one that closed, never matched or whose app is hung (no window read), or one
    // of Ember's own, gets no picture, never one of the whole screen, which no secret-field check has looked through.
    // Not found, the text says only that (not "use the screenshot").
    if (opts.scope === "window" && !seen.window && !seen.x11Window) {
      if (seen.ember) return noShot("Ember takes no pictures of its own windows");
      if (seen.busy) return noShot("the app isn't answering");
      return { ...seen, text: WINDOW_NOT_FOUND, capture: null };
    }
    // macOS gives no picture without Screen Recording (never allowed, or taken back): say that, not "off screen".
    if (this.noScreenAccess(x11)) return noShot(this.screenRefused());
    // While a password prompt has focus anywhere on screen, no screenshots at all.
    const active = x11.focusWindow() ?? x11.activeWindow();
    if (active && this.isSecurity({ app: active.wmClass, title: active.title })) return noShot("a password prompt is open, so Ember looks away until it's done");
    // Windows and macOS say themselves when an authentication surface is up (UAC's secure desktop, a credential
    // prompt, macOS's SecurityAgent or secure keyboard entry); Linux has no such check (GNOME Shell's come next).
    if (this.platformDialog()) return noShot(SYSTEM_DIALOG);
    // GNOME Shell draws its own dialogs (polkit, keyring) and notifications: no X11 window shows where they are.
    const shell = await this.shellOverlays();
    if (shell.unchecked) return noShot(this.words.shellUnchecked);
    if (shell.dialog) return noShot(SYSTEM_DIALOG);
    if (shell.overview) return noShot(this.words.overviewOpen);
    const windowScope = opts.scope === "window" && !!(seen.window || seen.x11Window);
    let rect = this.o.screenBounds();
    // A window: blacked out wherever other windows lie on top of it (the stacking order says which).
    const own = this.ownPid;
    const covering = (s: StackedWindow[] | null): Bounds[] | null => {
      const at = s && this.locate(seen, s);
      return at ? coveringRects(s!, at.index, at.rect, [seen.window?.pid ?? seen.x11Window?.pid, at.pid], own) : null;
    };
    let covers: Bounds[] = [];
    // The app's own popups over the window are in its picture: their secret fields are blacked out, and so is a popup
    // that can't be looked through (one that opens while the picture is taken, too).
    let popups: { masks: Bounds[]; hidden: boolean } = { masks: [], hidden: false };
    const popupsSeen = new Set<number>();
    const popupsOver = (s: StackedWindow[] | null): StackedWindow[] => {
      const at = s && this.locate(seen, s);
      return at ? samePopups(s!, at.index, at.rect, [seen.window?.pid ?? seen.x11Window?.pid, at.pid], own) : [];
    };
    if (windowScope) {
      const at = stack && this.locate(seen, stack);
      if (!at) return noShot("Ember couldn't find the window on screen, so it can't tell what covers it");
      rect = at.rect;
      covers = coveringRects(stack!, at.index, rect, [seen.window?.pid ?? seen.x11Window?.pid, at.pid], own);
      if (uncoveredArea(rect, covers) <= 0.01 * rect.width * rect.height) return noShot("the window is covered by other windows");
      const over = popupsOver(stack!);
      for (const p of over) popupsSeen.add(p.id);
      if (over.length) popups = await this.popupMasks(over, seen.axScale);
    }
    const mask = await this.privateWindows(stack);
    if (mask === null) {
      // Can't tell where private windows are, so no screenshot (fail closed).
      this.o.log.warn("perception.capture_declined", { reason: "private windows could not be listed" });
      return noShot("Ember couldn't check for private windows");
    }
    // Ember's own windows (the command and prompt windows, settings, the ask box, the handle) never reach a model as
    // pixels (critique integration-4): the whole screen's picture blacks out every one of them; a window's picture, those
    // stacked over it (its covers hold them already). The overlay is hidden for the capture, and covers nothing.
    const mine = this.ownWindows(stack, windowScope);
    if (mine === null) {
      this.o.log.warn("perception.capture_declined", { reason: "Ember's own windows could not be listed" });
      return noShot("Ember couldn't check where its own windows are");
    }
    const secrets = seen.nodes.filter(n => n.secret && n.bounds);
    const k = seen.axScale;
    // Before every picture the window's secret fields are looked for on their own too (in the app's own pixels): a
    // read can miss some, cut short or not. Without all of them there is no picture.
    let unread: { id: number; bounds: Bounds }[] = [];
    if (seen.window) {
      const more = await this.unreadSecrets(seen);
      if (typeof more === "string") return noShot(more);
      // The ones the read found are blacked out (and looked at again) already.
      const known = new Set(secrets.map(n => rectKey(n.bounds!)));
      unread = more.filter(f => !physical(f.bounds, k).some(b => known.has(rectKey(b))));
    }
    const blacked = [...mask, ...covers, ...mine, ...shell.masks, ...popups.masks];
    let coveredAfter = false;
    let dialogAfter = false;
    const capture = await (this.o.capture ?? captureRect)(x11, rect, {
      mask: [...blacked, ...secrets.map(n => pad(n.bounds!)), ...unread.flatMap(f => physical(f.bounds, k).map(pad))],
      // Windows can move or open, and fields scroll, while the picture is taken: black out where they are afterwards too.
      maskAfter: async () => {
        // A system dialog may have come up while the picture was taken (macOS's capture takes 100-300 ms): then the
        // picture may show it, so there is none. Always false on Linux, which has no such check.
        if (this.platformDialog()) {
          dialogAfter = true;
          return null;
        }
        const now = this.stackNow();
        const priv = await this.privateWindows(now);
        if (priv === null) return null;
        const fields = [...await this.whereNow(secrets), ...await this.whereNow(unread, k)];
        if (seen.window) {
          // A secret field that appeared or scrolled in after the first look may be in the picture: the window is
          // looked through again now the pixels are taken, and without all of it there is no picture (as before it).
          const late = await this.unreadSecrets(seen);
          if (typeof late === "string") return null;
          const lateRects = late.flatMap(f => physical(f.bounds, k).map(pad));
          fields.push(...lateRects);
          blacked.push(...lateRects);
        }
        blacked.push(...priv);
        if (!windowScope) {
          // Ember's own windows where they are now (one may have opened or moved while the picture was taken).
          const ownNow = this.ownWindows(now, false);
          if (ownNow === null) return null;
          blacked.push(...ownNow);
          return [...priv, ...fields, ...ownNow];
        }
        const after = covering(now);
        if (after === null) return null; // the window is gone from the stack: no picture
        coveredAfter = after.length > 0;
        // A popup of the app's that opened meanwhile wasn't looked through: blacked out whole.
        const opened = popupsOver(now).filter(p => !popupsSeen.has(p.id)).map(p => ({ x: p.x, y: p.y, width: p.width, height: p.height }));
        if (opened.length) popups.hidden = true;
        blacked.push(...after, ...opened);
        return [...priv, ...fields, ...after, ...opened];
      },
      hideOverlay: this.o.hideOverlay ? () => this.hideOverlay() : undefined,
      // No marks on what is blacked out (an element under another window can't be clicked either).
      overlaySvg: (scale, w, h, origin) => seen.nodes.length ? marksSvg(seen.nodes.filter(n => !n.bounds || !blacked.some(b => holds(b, n.bounds!))), origin, scale, w, h) : null,
    });
    if (!capture) {
      return noShot(dialogAfter ? SYSTEM_DIALOG
        : this.noScreenAccess(x11) ? this.screenRefused()
        : "the window is off screen, or the screen couldn't be captured safely");
    }
    const note = covers.length || coveredAfter ? "\n(Screenshot: parts covered by other windows are hidden.)" : "";
    const unchecked = popups.hidden ? "\n(Screenshot: a popup Ember couldn't check for password fields is hidden.)" : "";
    return { ...seen, text: text + note + unchecked, capture };
  }

  /**
   * What to black out of the app's own popups over its window (`popups`, from the stack): each one accessibility lists
   * as a window of the app is looked through for secret fields like a window (secret_fields), and those are blacked
   * out; one that can't be looked through whole (the scan is cut short, its app is busy, the call fails) is blacked out
   * whole (`hidden` then). One accessibility doesn't list as a window (a macOS menu, a Windows menu's shadow) can't be
   * looked through and is left as before: blacking it out would hide every open menu. Those are logged
   * (perception.popup_unmatched, once a run for each app and size), so CI and the field show which popups go unscanned.
   * `k`: the app's scale.
   */
  private async popupMasks(popups: StackedWindow[], k: number): Promise<{ masks: Bounds[]; hidden: boolean }> {
    let listed: AxWindow[] = [];
    try {
      listed = (await this.o.sidecar.listWindows({ ownPid: this.ownPid })).windows;
    } catch (err) {
      this.o.log.warn("perception.list_windows_failed", { err });
    }
    const masks: Bounds[] = [];
    let hidden = false;
    for (const p of popups) {
      const w = listed.find(l => l.path && isPopupOf(l, p, k));
      if (!w) {
        this.popupUnmatched(p);
        continue;
      }
      const whole = { x: p.x, y: p.y, width: p.width, height: p.height };
      try {
        const r = await this.o.sidecar.secretFields({ pid: w.pid!, path: w.path! });
        if (r.complete) {
          masks.push(...r.fields.flatMap(f => physical(f.bounds, k).map(pad)));
          continue;
        }
      } catch (err) {
        this.o.log.warn("perception.secret_scan_failed", { err });
      }
      masks.push(whole);
      hidden = true;
    }
    return { masks, hidden };
  }

  /** Logs a popup of the app's that accessibility doesn't list as a window, so it went unscanned (see popupMasks). */
  private popupUnmatched(p: StackedWindow): void {
    const key = `${p.wmClass} ${p.width}x${p.height}`;
    if (this.unmatchedPopups.has(key) || this.unmatchedPopups.size >= UNMATCHED_POPUPS_LOGGED) return;
    this.unmatchedPopups.add(key);
    this.o.log.info("perception.popup_unmatched", { app: p.wmClass, width: p.width, height: p.height });
  }

  /**
   * Where these (secret) fields are now, padded; the ones that can't be read again keep their old place.
   * `k`: their bounds are as the app reports them, at this scale (both places are blacked out).
   */
  private async whereNow(fields: { id: number; bounds: Bounds | null }[], k = 1): Promise<Bounds[]> {
    const places = await Promise.all(fields.slice(0, MAX_SECRET_RECHECK).map(async n => {
      const now = await this.o.sidecar.readElement(n.id).catch(() => null);
      return physical(now?.bounds ?? n.bounds!, k).map(pad);
    }));
    return places.flat();
  }

  /**
   * The frames of Ember's own windows in `stack` (every one but the overlay, which is hidden for captures and lets clicks
   * through); `windowScope`: a window's picture, which shows only what lies over it, already among its covers (so none
   * here: an Ember window under it can't show). null when the stack can't be read for a picture of the whole screen
   * (no picture then: fail closed).
   */
  private ownWindows(stack: StackedWindow[] | null | undefined, windowScope: boolean): Bounds[] | null {
    if (windowScope) return [];
    if (!stack) return null;
    const own = this.ownPid;
    return stack.filter(w => w.pid === own && w.title !== OVERLAY_TITLE).map(w => ({ x: w.x, y: w.y, width: w.width, height: w.height }));
  }

  /**
   * The window's secret fields on screen, looked for on their own, or why they can't all be known (then no
   * picture is taken). A window without a process or path can't be looked through: then a complete read's own do.
   */
  private async unreadSecrets(seen: Seen): Promise<{ id: number; bounds: Bounds }[] | string> {
    const w = seen.window;
    const busy = "the app is busy, so Ember can't check it for password fields; try again in a moment";
    if (!w || w.pid == null || !w.path) {
      if (!seen.truncated && !seen.busy) return [];
      return seen.busy ? busy : "Ember couldn't check the whole window for password fields";
    }
    try {
      const r = await this.o.sidecar.secretFields({ pid: w.pid, path: w.path });
      if (r.complete) return r.fields;
      return r.busy ? busy : "the window is too big for Ember to check all of it for password fields in time; close what you don't need, or work in a smaller part of it";
    } catch (err) {
      this.o.log.warn("perception.secret_scan_failed", { err });
      return "Ember couldn't check the whole window for password fields";
    }
  }

  /** Why there is no picture when the OS refused Ember the screen; the first time in a run, Ember is told (onNoScreenAccess). */
  private screenRefused(): string {
    if (!this.toldNoScreenAccess) {
      this.toldNoScreenAccess = true;
      try {
        this.o.onNoScreenAccess?.();
      } catch (err) {
        this.o.log.warn("perception.no_screen_access_notice_failed", { err });
      }
    }
    return this.words.noScreenAccess ?? NO_SCREEN_ACCESS;
  }

  /**
   * Has the OS refused Ember the screen (macOS without Screen Recording)? False where there is no such permission, and
   * when the check fails: the capture then asks again itself and gives no picture without it (fail closed).
   */
  private noScreenAccess(ws: ScreenAccess): boolean {
    try {
      return ws.screenRecording?.() === false;
    } catch (err) {
      this.o.log.warn("perception.screen_access_check_failed", { err });
      return false;
    }
  }

  /**
   * GNOME Shell's dialogs and notifications now (a shell too busy to be looked through counts as a dialog;
   * best effort otherwise: nothing is known when the check fails, without GNOME Shell for one).
   */
  private async shellOverlays(): Promise<ReturnType<typeof shellCovers>> {
    try {
      const r = await this.o.sidecar.shellOverlays();
      return shellCovers(r.overlays, r.complete !== false);
    } catch (err) {
      this.o.log.warn("perception.shell_check_failed", { err });
      return shellCovers([]);
    }
  }

  /**
   * Is a system dialog (a password prompt, most likely) on screen, or may one be? GNOME Shell's (polkit, keyring), or
   * the one the window system reports on Windows and macOS.
   */
  async systemDialogOpen(): Promise<boolean> {
    return (await this.shellOverlays()).dialog || this.platformDialog();
  }

  /**
   * The window system's own answer (Windows: the secure desktop or a credential prompt; macOS: SecurityAgent or secure
   * keyboard entry). False where it has none (Linux, the desk) or there is no window system; true when the check
   * throws (fail closed).
   */
  private platformDialog(): boolean {
    try {
      return this.o.x11?.systemDialogOpen?.() ?? false;
    } catch (err) {
      this.o.log.warn("perception.system_dialog_check_failed", { err });
      return true;
    }
  }

  /** Hides Ember for a capture. Concurrent captures share one hide; the last one to finish shows Ember again. */
  private async hideOverlay(): Promise<() => void> {
    const h = this.hidden ??= { count: 0, restore: this.o.hideOverlay!() };
    h.count++;
    const release = () => {
      if (--h.count > 0) return false;
      if (this.hidden === h) this.hidden = null;
      return true;
    };
    let restore: () => void;
    try {
      restore = await h.restore;
    } catch (err) {
      release();
      throw err;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (release()) restore();
    };
  }

  /** Visible windows (app, title, physical bounds), never-look and password-prompt ones (by app, title or X11 class) left out. */
  async windows(): Promise<AxWindow[]> {
    const { windows } = await this.o.sidecar.listWindows({ ownPid: this.ownPid });
    const list = this.o.neverLook().filter(i => i.trim());
    const stack = list.length || windows.some(w => w.bounds) ? this.stackNow() : null;
    const privatePids = new Set(list.length && stack ? stack.filter(s => s.pid != null && isNeverLook({ app: s.wmClass, name: "" }, list)).map(s => s.pid) : []);
    return windows.flatMap(w => {
      const m = stack && w.bounds ? matchFrame(w, stack) : null;
      if (isNeverLook(w, list) || this.isSecurity(w) || (w.pid != null && privatePids.has(w.pid))
        || (m && (isNeverLook({ app: m.window.wmClass, name: m.window.title }, list) || this.isSecurity({ app: m.window.wmClass, title: m.window.title })))) return [];
      const k = w.bounds && stack ? this.frameScale(w, stack, m) : 1;
      return [k !== 1 ? { ...w, bounds: scaleBounds(w.bounds!, k) } : w];
    });
  }

  /**
   * Bounds of every visible window on the never-look list (blacked out in screenshots), whole
   * frames, title bars included. Both sources are used: X11 sees every top-level window (even apps
   * that expose nothing over accessibility, e.g. started before it was turned on), AT-SPI knows
   * app names. null means neither could be listed: the caller must not capture (fail closed)
   * while anything is on the never-look list. Remote surfaces (Windows) are blacked out too, always.
   */
  async privateWindows(stack?: StackedWindow[] | null): Promise<Bounds[] | null> {
    const remote = this.remoteSurfaces(stack);
    if (remote === null) return null;
    const list = this.o.neverLook();
    if (!list.some(i => i.trim())) return remote;
    const frame = (w: StackedWindow): Bounds => ({ x: w.x, y: w.y, width: w.width, height: w.height });
    let s: StackedWindow[] | null = null;
    let x11: Bounds[] | null = null;
    try {
      s = stack ?? (this.o.x11 ? this.o.x11.stack() : null);
      x11 = s && s.filter(w => isNeverLook({ app: w.wmClass, name: w.title }, list)).map(frame);
    } catch (err) {
      this.o.log.warn("perception.x11_windows_failed", { err });
    }
    let atspi: Bounds[] | null = null;
    try {
      const { windows } = await this.o.sidecar.listWindows({ ownPid: this.ownPid });
      atspi = windows.filter(w => w.bounds && isNeverLook(w, list)).map(w => {
        // Its X11 window when it can be found (the whole frame, in physical pixels), else its own report, scaled.
        const m = s && matchFrame(w, s);
        if (m) return frame(m.window);
        return scaleBounds(w.bounds!, this.scales.get(w.pid != null ? `pid:${w.pid}` : `title:${w.name}`)?.k ?? 1);
      });
    } catch (err) {
      this.o.log.warn("perception.atspi_windows_failed", { err });
    }
    if (x11 === null && atspi === null) return null;
    return [...remote, ...(x11 ?? []), ...(atspi ?? [])];
  }

  /**
   * The whole frames of the remote surfaces on screen (Windows: a remote desktop's or a WSLg app's window), from the
   * stack, which sees every top-level window: what they show can't be checked against the never-look list or for a
   * password prompt. [] without the check; null when the stack can't be read (no picture then). A window is one by its
   * whole app name (Windows' program, macOS's "Screen Sharing") or by either part of Linux's WM_CLASS ("remmina
   * Org.remmina.Remmina"), as the security-window check reads them.
   */
  private remoteSurfaces(stack?: StackedWindow[] | null): Bounds[] | null {
    const remote = this.o.isRemoteSurface;
    if (!remote) return [];
    const s = stack ?? this.stackNow();
    const isRemote = (app: string) => remote(app) || app.split(/\s+/).some(part => !!part && part !== app && remote(part));
    return s && s.filter(w => isRemote(w.wmClass)).map(w => ({ x: w.x, y: w.y, width: w.width, height: w.height }));
  }
}

const SYSTEM_DIALOG = "a system dialog is open, so Ember looks away until it's done";
/** Why there is no screenshot when the OS refuses the screen and its words don't say more (macOS's do). */
const NO_SCREEN_ACCESS = "Ember isn't allowed to capture the screen";
const BUSY_APP = "The app is busy and didn't answer (it may be loading something). Try again in a moment.";
const WINDOW_NOT_FOUND = "That window can't be found (it may have closed, or its app isn't answering).";
const EMBERS_OWN = "The user is in one of Ember's own windows (the ask box or settings), not in an app; Ember doesn't read its own windows. If they mean an app, ask them to switch to it.";

/** One open window as the "Open windows" lists say it: its app (as the user knows it), its title, and how it is. */
export interface OpenWindow { app: string; title: string; active: boolean; busy?: boolean }

/** An open window's line: app and title quoted (screen text, untrusted), then whether the user is in it or it is busy. */
function openWindowLine(w: OpenWindow): string {
  return `- ${quoteUntrusted(w.app || "(unknown app)", 60)}: ${quoteUntrusted(w.title || "(untitled)", 100)}${w.active ? " (focused by the user)" : ""}${w.busy ? " (busy, not answering)" : ""}`;
}

/**
 * The open windows' lines for quickContextText (one per window, in order). Pure: the PC builds a remote's context
 * from its structured list with it (§5.5), so every string from there is quoted by Ember's own code.
 */
export function openWindowLines(lines: OpenWindow[]): string[] {
  return lines.map(openWindowLine);
}

/**
 * The open windows as describe() appends them: an untrusted <screen> block ("" for none). Pure (§5.5): the same text for
 * this screen's windows and a remote's.
 */
export function openWindowsBlock(lines: OpenWindow[]): string {
  if (!lines.length) return "";
  return `\n<screen source="open-windows" untrusted="true">\nOpen windows:\n${openWindowLines(lines).join("\n")}\n</screen>`;
}

/** What a worker's perceive_window says about what was read (before any screenshot note). Pure (§5.5). */
export function perceivedText(seen: Seen): string {
  return seen.blocked
    ? "This window is private (on the user's never-look list, or a password prompt). Do not interact with it."
    : seen.window ? serializeElements(seen.window, seen.nodes, { withBounds: true, maxLines: WORKER_LINES, header: othersLine(seen) }) + notes(seen)
    : seen.busy ? BUSY_APP
    : seen.ember ? EMBERS_OWN
    : "The focused window exposes no accessibility information; use the screenshot.";
}

/**
 * describe_screen's text for what was read, with `openBlock` (openWindowsBlock's text, or "") after it. Pure (§5.5):
 * everything read from the screen (titles, names, text) stays inside the untrusted <screen> wrapper, quoted.
 */
export function describeText(seen: Seen, openBlock: string): string {
  if (seen.blocked) return `The user is in a private window (on their "never look at" list, or a password prompt). Do not read or describe it.`;
  if (seen.ember) return `${EMBERS_OWN}${openBlock}`;
  const title = seen.window?.name || seen.x11Window?.title || "";
  if (!seen.window) {
    if (seen.busy) return `${BUSY_APP}${openBlock}`;
    const named = title ? `\n<screen source="window-title" untrusted="true">\nWindow: ${quoteUntrusted(title, 100)}\n</screen>` : "";
    return `The focused window does not expose accessibility information, so its contents can't be read as text.${named}${openBlock}`;
  }
  const focus = focusedElement(seen.nodes);
  const label = focus ? focus.name || inferLabels(seen.nodes).get(focus.id) || "" : "";
  const focusLine = focus ? `Focused element: [${focus.id}] ${screenWord(focus.role)}${label ? ` ${quoteUntrusted(label, 80)}` : ""}.` : "No element has keyboard focus.";
  return `The user's focused window, read through accessibility:\n${serializeElements(seen.window, seen.nodes, { maxLines: 120, header: [focusLine, ...othersLine(seen)] })}${notes(seen)}${openBlock}`;
}

/**
 * The quick context for what was read (the window the user is in, what has focus, its selection or text), with
 * `openLines` (openWindowLines's lines) as its list of open windows; null for a window with no title. Pure (§5.5).
 */
export function quickContextText(seen: Seen, openLines: string[]): QuickContext | null {
  const pid = seen.window?.pid ?? seen.x11Window?.pid ?? undefined;
  // A private window: only its process (a task started there is refused), never its title.
  if (seen.blocked) return { target: { pid }, text: `<context untrusted="true">The user is in a private window (on their never-look list, or a password prompt).</context>` };
  const title = seen.window?.name || seen.x11Window?.title || "";
  if (!title) return null;
  const app = seen.window?.app ?? "";
  const target = { pid, title, app, ...(seen.window?.path ? { path: seen.window.path } : {}) };
  const focus = focusedElement(seen.nodes);
  const label = focus ? focus.name || inferLabels(seen.nodes).get(focus.id) || "" : "";
  const secret = !!focus && isSecretNode(focus, label);
  const lines = [`App: ${quoteUntrusted(app || "unknown", 60)}, window: ${quoteUntrusted(title, 100)}.`];
  if (focus) lines.push(`Focused: ${screenWord(focus.role)}${label ? ` ${quoteUntrusted(label, 60)}` : ""}${secret ? " (a secret field; its contents are not shown)" : ""}.`);
  if (focus && !secret) {
    if (focus.selection) lines.push(`Selected text: ${quoteUntrusted(focus.selection, 300)}.`);
    else if (focus.text) lines.push(`Its text begins: ${quoteUntrusted(focus.text, 120)}.`);
  }
  if (openLines.length) lines.push("", "Open windows:", ...openLines);
  return { target, text: `<context source="focused-window" untrusted="true">\n${lines.join("\n")}\n</context>`, takesSelection: !secret && !focus?.selection };
}

const rectKey = (b: Bounds) => `${b.x},${b.y},${b.width},${b.height}`;

/** A secret field's rectangle, a little larger: its border and focus ring go too. */
const pad = (b: Bounds): Bounds => ({ x: b.x - 3, y: b.y - 3, width: b.width + 6, height: b.height + 6 });

/**
 * Where a rectangle an app reported may be on screen: at a scale other than 1 both as reported and
 * scaled (Chromium's pages report physical pixels inside a frame that reports logical ones).
 */
const physical = (b: Bounds, k: number): Bounds[] => (k === 1 ? [b] : [b, scaleBounds(b, k)]);

/** Is the middle of `r` inside `b`? */
const holds = (b: Bounds, r: Bounds) => {
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
};

/** The app's other windows (an Open dialog over the window read), for the header inside the <screen> wrapper. */
function othersLine(seen: Seen): string[] {
  if (!seen.others.length) return [];
  const list = seen.others.map(w => `${quoteUntrusted(w.name || "(untitled)", 80)} (${[screenWord(w.role), w.modal ? "modal" : "", w.active ? "the user is in it" : ""].filter(Boolean).join(", ")})`);
  return [`Also open in this app: ${list.join("; ")}. To work there, switch to it by its title.`];
}

/** What Ember says about a read that is incomplete (after the <screen> wrapper: these are Ember's words). */
function notes(seen: Seen): string {
  const out: string[] = [];
  if (seen.busy) out.push("(The app was busy and stopped answering partway, so this list may be incomplete. Try again in a moment.)");
  if (seen.truncated === "nodes") out.push(`(The window has more elements than Ember reads at once; only the first ${seen.nodes.length} are listed. Scroll to the part you need, open it, or work in a smaller window, then look again.)`);
  if (seen.truncated === "time") out.push("(Reading the window took too long, so only part of it is listed. Scroll to the part you need or close what you don't need, then look again.)");
  if (seen.truncated === "depth") out.push("(Part of the window is nested too deeply for Ember to read, so elements there are missing from this list. Use the screenshot for that part.)");
  if (seen.truncated === "loading") out.push("(The page is still loading, so its content isn't listed yet. Try again in a moment.)");
  return out.length ? `\n${out.join("\n")}` : "";
}
