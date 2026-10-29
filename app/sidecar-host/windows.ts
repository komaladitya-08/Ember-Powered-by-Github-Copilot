/**
 * Top-level windows as the protocol describes them, chosen as the Python sidecar chooses them: a window by its pid and
 * path (exactly that one, or none), by pid and/or title (same pid +8, exact title +6, title inside +4, active +2,
 * showing +1), or with neither the window the user is in; Ember's own windows (ownPid) are never found, listed or read.
 * An app that didn't answer in time keeps its windows in the list as last seen, marked busy, instead of vanishing.
 * Also what the system draws over every window (Windows' credential and consent prompts, Task View): shell_overlays.
 */

import type { AxWindow, OtherWindow, ShellOverlay } from "../main/perception/sidecar";
import { isNeverLook } from "../main/perception/elements";
import type { RawWindow } from "./provider";
import { TOP, atspiRole, axOverlayRole } from "./roles";
import { boundsOf } from "./tree";

/** The protocol's description of a window (its title as the app gives it: Ember blanks private ones). */
export function describeWindow(w: RawWindow, vocabulary: "uia" | "ax"): AxWindow {
  return {
    app: w.app ?? "",
    pid: Number.isInteger(w.pid) ? w.pid : null,
    path: w.key,
    name: w.title ?? "",
    role: windowRole(w, vocabulary),
    active: !!w.active,
    bounds: boundsOf(w.bounds),
  };
}

/** A top-level window's role in AT-SPI's words, the same as its node's in a read of it. */
export function windowRole(w: RawWindow, vocabulary: "uia" | "ax"): string {
  return atspiRole(vocabulary, {
    handle: w.handle, key: w.key, parent: -1, depth: 0, platformRole: w.platformRole, platformSubrole: w.platformSubrole,
    className: w.className, name: w.title, bounds: w.bounds, modal: w.modal,
  }, TOP);
}

/** Shows on screen (or is the one the user is in): listed. */
export const showing = (w: RawWindow) => !w.offscreen || !!w.active;

/** What a read_window, at_point or secret_fields asks for. */
export interface WindowQuery { pid?: number; title?: string; path?: string; ownPid?: number }

/** The window a request means (see the module comment), or null. */
export function findWindow(windows: RawWindow[], q: WindowQuery): RawWindow | null {
  const mine = windows.filter(w => q.ownPid === undefined || w.pid !== q.ownPid);
  const title = (q.title ?? "").toLowerCase();
  if (q.pid !== undefined && q.path) return mine.find(w => w.pid === q.pid && w.key === q.path) ?? null;
  if (q.pid === undefined && !title) return mine.find(w => w.active) ?? null;
  const best = (found: RawWindow[]): { w: RawWindow | null; score: number } => {
    let w: RawWindow | null = null, top = 0;
    for (const c of found) {
      const name = (c.title ?? "").toLowerCase();
      let score = 0;
      if (q.pid !== undefined && c.pid === q.pid) score += 8;
      if (title && name === title) score += 6;
      else if (title && name.includes(title)) score += 4;
      if (score === 0) continue;
      if (c.active) score += 2;
      if (!c.offscreen) score += 1;
      if (score > top) { w = c; top = score; }
    }
    return { w, score: top };
  };
  if (q.pid !== undefined) {
    const own = best(mine.filter(w => w.pid === q.pid));
    if (!title || own.score >= 10) return own.w;
    const other = best(mine.filter(w => w.pid !== q.pid));
    return other.score > own.score ? other.w : own.w;
  }
  return best(mine).w;
}

/**
 * Is this window on the user's never-look list (by app name or title, or by process)? Then it is found but not read.
 * Judged as main judges it (perception/elements.ts isNeverLook: an everyday word such as "keeper" by the app, and by
 * the title only where a word there starts with it).
 */
export function neverLooked(w: AxWindow, neverLook: string[], skipPids: number[]): boolean {
  if (w.pid !== null && skipPids.includes(w.pid)) return true;
  return isNeverLook(w, neverLook.filter(t => typeof t === "string"));
}

/** The app's other windows the user is in or must answer first (an Open dialog over the main window), five at most. */
export function otherWindows(windows: RawWindow[], read: RawWindow, vocabulary: "uia" | "ax"): OtherWindow[] {
  return windows.filter(w => w.pid === read.pid && w.key !== read.key && !w.offscreen && (w.active || w.modal)).slice(0, 5)
    .map(w => ({ name: w.title ?? "", role: windowRole(w, vocabulary), active: !!w.active, modal: !!w.modal }));
}

/** Apps whose windows are remembered as last seen, and windows per app. */
const KNOWN_APPS = 200;
const KNOWN_WINDOWS = 20;

/** The windows each app showed when it last answered: a busy app's are listed as these, marked busy. */
export class KnownWindows {
  private apps = new Map<number, Map<string, AxWindow>>();

  /** What app `pid` shows now (`merge`: these too). */
  remember(pid: number | null, windows: AxWindow[], merge = false): void {
    if (pid === null) return;
    const known = (merge ? this.apps.get(pid) : undefined) ?? new Map<string, AxWindow>();
    this.apps.delete(pid);
    for (const w of windows) {
      const k = w.path || w.name;
      known.delete(k);
      known.set(k, w);
    }
    while (known.size > KNOWN_WINDOWS) known.delete(known.keys().next().value!);
    if (known.size) this.apps.set(pid, known);
    while (this.apps.size > KNOWN_APPS) this.apps.delete(this.apps.keys().next().value!);
  }

  /** App `pid`'s windows as last seen, or none. */
  of(pid: number): AxWindow[] {
    return [...(this.apps.get(pid)?.values() ?? [])];
  }

  /** Could app `pid`, which didn't answer, have the window asked for? Its windows as last seen say (any, unknown). */
  mightHave(pid: number, title: string): boolean {
    const known = this.apps.get(pid);
    return !known || !title || [...known.values()].some(w => w.name.toLowerCase().includes(title));
  }
}

/**
 * The window list: every window that shows or is active, apart from Ember's own; the windows of apps that didn't
 * answer this time as last seen (busy, not active), after the rest.
 */
export function listWindows(windows: RawWindow[], ownPid: number | undefined, vocabulary: "uia" | "ax", known: KnownWindows): AxWindow[] {
  const out: AxWindow[] = [];
  const busy = new Map<number, RawWindow[]>();
  const answered = new Set<number>();
  for (const w of windows) {
    if (ownPid !== undefined && w.pid === ownPid) continue;
    if (w.busy) { busy.set(w.pid, [...busy.get(w.pid) ?? [], w]); continue; }
    answered.add(w.pid);
    if (showing(w)) out.push(describeWindow(w, vocabulary));
  }
  for (const pid of answered) known.remember(pid, out.filter(w => w.pid === pid));
  for (const pid of [...busy.keys()].sort((a, b) => a - b)) {
    if (answered.has(pid)) continue;
    const last = known.of(pid);
    const seen = last.length ? last : busy.get(pid)!.filter(showing).map(w => describeWindow(w, vocabulary));
    out.push(...seen.map(w => ({ ...w, active: false, busy: true })));
  }
  return out;
}

/** Windows programs and classes whose windows ask for the user's credentials or consent (never pictured, never borrowed). */
const SECURITY_APPS = new Set(["credentialuibroker", "consent", "logonui", "lockapp", "credwiz", "securityhealthsystray"]);
const SECURITY_CLASSES = new Set(["credential dialog xaml host", "$$$secure uap dummy window class for interim dialog", "lockscreencontrollerproxywindow"]);
/** Windows' views that show every window, never-look ones too: Task View, the Alt+Tab switcher, Start and Search. */
const OVERVIEW_CLASSES = new Set(["multitaskingviewframe", "taskswitcherwnd", "xamlexplorerhostislandwindow", "foregroundstaging"]);
const OVERVIEW_APPS = new Set(["startmenuexperiencehost", "searchhost", "searchapp", "searchui"]);

/**
 * What a top-level window is, of what the system draws over every window (shell_overlays): "dialog" (a credential or
 * consent prompt: no picture, no borrowing), "overview" (Task View, Alt+Tab, Start: pictures of every window), or null
 * for an ordinary window. macOS's are roles.ts's axOverlayRole (credential and consent prompts, the lock screen).
 */
export function overlayRole(w: RawWindow, vocabulary: "uia" | "ax"): "dialog" | "overview" | null {
  if (vocabulary === "ax") return showing(w) ? axOverlayRole(w) : null;
  if (!showing(w)) return null;
  const app = (w.app ?? "").toLowerCase().replace(/\.exe$/, "");
  const cls = (w.className ?? "").toLowerCase();
  if (SECURITY_APPS.has(app) || SECURITY_CLASSES.has(cls)) return "dialog";
  if (OVERVIEW_CLASSES.has(cls)) return "overview";
  // Start and Search are core windows of their own apps, cloaked (offscreen) while closed.
  if (OVERVIEW_APPS.has(app) && cls === "windows.ui.core.corewindow") return "overview";
  return null;
}

/** The overlays among the top-level windows (see overlayRole), as shell_overlays reports them. */
export function shellOverlays(windows: RawWindow[], vocabulary: "uia" | "ax"): ShellOverlay[] {
  const out: ShellOverlay[] = [];
  for (const w of windows) {
    const role = overlayRole(w, vocabulary);
    if (!role) continue;
    out.push({ role, name: (w.title ?? "").slice(0, 200), text: "", bounds: role === "overview" ? null : boundsOf(w.bounds) });
  }
  return out;
}
