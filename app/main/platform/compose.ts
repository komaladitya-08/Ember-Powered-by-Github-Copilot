/**
 * Helpers the per-OS compositions share: a window system with a system-dialog check added, the environment Ember
 * gives the helpers it starts, the hover-polling overlay shaper Windows and macOS use, the rule that puts Ember's
 * floating windows on every workspace, X11's screen bounds, and the accessibility helper's status as main keeps it.
 * Pure and Electron-free (plain Node, unit-tested on Linux): the compositions pass in what they know.
 */

import type { FloatingKind, FloatingWindow, HelperStatus, OS, OverlayShaper, Rect, ScreenLike, WindowSystem } from "./types";
import { TEST_SWITCHES } from "../../sidecar-host/launch";

/**
 * A WindowSystem whose systemDialogOpen is `check`, and which is otherwise `ws` itself: a Proxy whose `get` answers
 * systemDialogOpen with `check` and every other key with Reflect.get(ws, key) (functions bound to `ws`), so backend
 * extras (port/win32's activate, port/darwin's accessibilityTrusted) survive and `this` inside a backend method is the
 * backend. `check` may throw: the caller's own fail-closed wrapper (perception's platformDialog) takes it as "a dialog
 * may be up", so it isn't caught here.
 */
export function withSystemDialog<T extends WindowSystem>(ws: T, check: () => boolean): T & { systemDialogOpen(): boolean } {
  // Bound once per method (the overlay asks for pointer() 60 times a second), and again only if the backend swaps it.
  const bound = new Map<PropertyKey, { fn: (...a: unknown[]) => unknown; bound: (...a: unknown[]) => unknown }>();
  return new Proxy(ws, {
    get(target, key) {
      if (key === "systemDialogOpen") return check;
      // The backend is the receiver, so its getters and methods see their own object, never the proxy.
      const v: unknown = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      // A frozen method must be reported as it is (a Proxy invariant); it is called with the proxy as `this` then.
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own && !own.configurable && own.writable === false) return v;
      const fn = v as (...a: unknown[]) => unknown;
      const known = bound.get(key);
      if (known && known.fn === fn) return known.bound;
      const b = fn.bind(target);
      bound.set(key, { fn, bound: b });
      return b;
    },
    has(target, key) {
      return key === "systemDialogOpen" || Reflect.has(target, key);
    },
  }) as T & { systemDialogOpen(): boolean };
}

/** Sign-ins and keys (appEnv's NEVER list): never handed to a helper, whatever their case. */
const SECRET = /^(GH_|GITHUB_|COPILOT_)|(_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;
/** Node and Electron switches that would change how a helper run as Ember's own binary starts or logs. */
const RUNTIME_SWITCHES = ["NODE_OPTIONS", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_ENABLE_LOGGING"];

/**
 * An environment for a helper Ember starts: `env` minus tokens (appEnv's NEVER list: GH_*, GITHUB_*, COPILOT_*,
 * *_TOKEN, *_KEY, *_SECRET, *_PASSWORD), minus EMBER_* except EMBER_LOG_LEVEL and the names in `keep`, minus
 * NODE_OPTIONS, ELECTRON_NO_ATTACH_CONSOLE and ELECTRON_ENABLE_LOGGING (keys deleted, not set to "undefined"). On win32
 * every name is compared case-insensitively (`Path`/`PATH`, `Node_Options`), as Windows' environment is; elsewhere
 * only the secret patterns are (a token is a token whatever its case), and the rest exactly as the OS reads them.
 * Everything else is kept, `__PSLockdownPolicy` included: an administrator's Constrained Language Mode is honoured.
 */
export function cleanEnv(env: NodeJS.ProcessEnv, o: { os: OS; keep?: readonly string[] }): NodeJS.ProcessEnv {
  const fold = (k: string) => (o.os === "win32" ? k.toUpperCase() : k);
  const keep = new Set([...(o.keep ?? []), "EMBER_LOG_LEVEL"].map(fold));
  const runtime = new Set(RUNTIME_SWITCHES.map(fold));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || SECRET.test(k)) continue;
    const name = fold(k);
    if (runtime.has(name)) continue;
    if (name.startsWith("EMBER_") && !keep.has(name)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The host's environment: cleanEnv(env, { os, keep: packaged ? [] : TEST_SWITCHES }) plus EMBER_OWNER_PID, Ember's
 * main process id (the host and its provider never send an accessibility request into it: that would switch
 * Chromium's accessibility on for Ember's own renderers, and on macOS wait on Ember's own main thread). The test
 * switches (port/host's TEST_SWITCHES: the fake provider and its desktop) stay only unpackaged, so Ember-level tests
 * can still pick the fake; hostLaunch drops them again for a packaged host.
 */
export function hostEnv(env: NodeJS.ProcessEnv, o: { os: OS; packaged: boolean; ownerPid: number }): NodeJS.ProcessEnv {
  return { ...cleanEnv(env, { os: o.os, keep: o.packaged ? [] : TEST_SWITCHES }), EMBER_OWNER_PID: String(o.ownerPid) };
}

/**
 * How Ember's floating windows are made where there is no input region (window-system §11.2, design §8.3).
 * Windows: tool windows (`type: "toolbar"`, no taskbar button, not tracked by the virtual-desktop manager, so they show
 * on every desktop), no thick frame or rounded corners on the transparent ones. macOS: panels (Electron's panel joins
 * every Space and floats over full-screen apps, and a click on one never activates Ember over the user's app;
 * `acceptFirstMouse` makes that first click count). allWorkspaces is null on both: Electron's macOS
 * setVisibleOnAllWorkspaces transforms the process (Dock icon, menu bar, a focus steal) unless it is told not to, and a
 * panel doesn't need it.
 */
const HOVER_FLOATING: Readonly<Record<"win32" | "darwin", Readonly<Record<FloatingKind, FloatingWindow>>>> = {
  win32: {
    overlay: { options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null },
    handle: { options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null },
    // A tool window can still be activated and take the keyboard; a normal one would drag the user back to the
    // virtual desktop it was made on.
    ask: { options: { type: "toolbar", thickFrame: false, roundedCorners: false }, allWorkspaces: null },
    // The desk is Linux only: never shown here.
    "desk-view": { options: {}, allWorkspaces: null },
  },
  darwin: {
    overlay: { options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false }, allWorkspaces: null },
    handle: { options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false }, allWorkspaces: null },
    // Focusable: it becomes key without activating Ember, so the user's app stays active and `blur` still hides it.
    ask: { options: { type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true }, allWorkspaces: null },
    "desk-view": { options: {}, allWorkspaces: null },
  },
};

/**
 * The overlay shaper for Windows and macOS: no input region exists (no XShape analogue), so setInputRegion answers
 * false and OverlayManager decides click-through by hover polling from the window system's pointer (real button state:
 * nothing flips while a button is held). `forward` is true only on macOS: on Windows it would install a low-level mouse
 * hook on Electron's UI thread, and every app's mouse would wait for Ember's main thread.
 */
export function hoverShaper(os: "win32" | "darwin"): OverlayShaper {
  const table = HOVER_FLOATING[os];
  return {
    setInputRegion: () => false,
    release: () => undefined,
    forward: os === "darwin",
    floating: kind => ({ options: { ...table[kind].options }, allWorkspaces: table[kind].allWorkspaces }),
  };
}

/**
 * The union of every display's DIP bounds, times the primary display's scale factor: the whole screen in physical
 * pixels as X11 counts them (one global scale). The Linux window system's screenBounds, and main's fallback for
 * perception when no window system opened.
 */
export function primaryScaledUnion(screen: ScreenLike): Rect {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const all = screen.getAllDisplays().map(d => d.bounds);
  const x0 = Math.min(...all.map(b => b.x)), y0 = Math.min(...all.map(b => b.y));
  const x1 = Math.max(...all.map(b => b.x + b.width)), y1 = Math.max(...all.map(b => b.y + b.height));
  return { x: x0 * scale, y: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale };
}

/** What setVisibleOnAllWorkspaces takes (Electron's BrowserWindow, structurally). */
export interface AllWorkspacesTarget {
  setVisibleOnAllWorkspaces(visible: boolean, o?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void;
}

/**
 * Applies a FloatingWindow's allWorkspaces rule in place of the window class's own setVisibleOnAllWorkspaces call:
 * null → no call, "plain" → setVisibleOnAllWorkspaces(true), an object → setVisibleOnAllWorkspaces(true, object).
 */
export function applyAllWorkspaces(win: AllWorkspacesTarget, rule: FloatingWindow["allWorkspaces"]): void {
  if (rule === null) return;
  if (rule === "plain") win.setVisibleOnAllWorkspaces(true);
  else win.setVisibleOnAllWorkspaces(true, rule);
}

/**
 * The shared host's `status` answer as main keeps it (EnvContext.helper). The host is another process, so its answer
 * is data: only fields of the expected type are kept, and toolkitAccessibility is null when it isn't a boolean.
 */
export function toHelperStatus(s: { toolkitAccessibility?: unknown; detail?: unknown; languageMode?: unknown; dpi?: unknown; processDpi?: unknown }): HelperStatus {
  const out: HelperStatus = { toolkitAccessibility: typeof s.toolkitAccessibility === "boolean" ? s.toolkitAccessibility : null };
  if (typeof s.detail === "string") out.detail = s.detail;
  if (typeof s.languageMode === "string") out.languageMode = s.languageMode;
  if (typeof s.dpi === "string") out.dpi = s.dpi;
  if (typeof s.processDpi === "string") out.processDpi = s.processDpi;
  return out;
}
