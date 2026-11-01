/**
 * The Windows window system with identified WSLg windows renamed "wsl:<distro>:<app>" (§4.4, critique wsl-2; owned by
 * package WB). Perception masks and the policy refuses by the window's app name: every RAIL window is "msrdc" to
 * Windows, a remote surface. Once the router has matched a RAIL window to a Linux window (at most 2 s ago), its name
 * here becomes the Linux app's, so it is judged as that app (its grants, never-look entries, terminal and security
 * checks) and no longer blacked out; a WSLg popup takes its window's name in the stack only (masking and covering, never
 * an action target). Everything the router hasn't matched keeps "msrdc". Off Windows it is the window system itself.
 */

import type { WindowSystem } from "../platform/types";
import type { WrapForWslOptions } from "./routed-sidecar";
import { routerFor, type RouterDeps, type WslRouter } from "./router";

/** A window as the lists give it: renamed when identified (its class too, which the open-windows list shows). */
function renamed<T extends { id: number; pid: number | null; wmClass: string; wmClassName?: string }>(w: T, router: WslRouter, popups: boolean): T {
  const app = router.identityNow(w.id, w.pid, popups);
  if (!app) return w;
  return { ...w, wmClass: app, ...(w.wmClassName !== undefined ? { wmClassName: app } : {}) };
}

/**
 * The Windows window system, with the program name (`wmClass`) of every RAIL window the router identified rewritten to
 * "wsl:<distro>:<app>" (critique wsl-2). Main passes the result as Perception's `x11`, to the hands' window lists and to
 * `currentWindow`/`activeWindow`, and names the window the ask box reads from it (review #78). Unidentified RAIL windows keep "msrdc", so the existing `isRemoteSurface` check keeps
 * masking and refusing exactly those. A Proxy like `platform/compose.ts`'s system-dialog wrapper: every other member is
 * the backend's own (I-win's extras survive).
 */
export function wrapWindowsForWsl(ws: WindowSystem, o: WrapForWslOptions): WindowSystem {
  return wrapWindowsWith(ws, o);
}

/** wrapWindowsForWsl with the router's parts given (tests). */
export function wrapWindowsWith<T extends WindowSystem>(ws: T, o: WrapForWslOptions, deps?: RouterDeps): T {
  if (o?.os !== "win32") return ws;
  const router = routerFor(o, deps);
  const lists: Partial<Record<PropertyKey, (...a: unknown[]) => unknown>> = {
    // The stack is what masking and covering read: a popup counts as part of the window it belongs to.
    stack: () => ws.stack().map(w => renamed(w, router, true)),
    clientWindows: () => ws.clientWindows().map(w => renamed(w, router, false)),
    activeWindow: () => { const w = ws.activeWindow(); return w && renamed(w, router, false); },
    focusWindow: () => { const w = ws.focusWindow(); return w && renamed(w, router, false); },
    // Both together, where the backend takes them in one look (review #78): renamed as the two are. Left out when the
    // backend has none, so callers make the two renamed calls.
    ...(ws.focusAndActive ? {
      focusAndActive: () => {
        const { focus, active } = ws.focusAndActive!();
        return { focus: focus && renamed(focus, router, false), active: active && renamed(active, router, false) };
      },
    } : {}),
  };
  const bound = new Map<PropertyKey, { fn: (...a: unknown[]) => unknown; bound: (...a: unknown[]) => unknown }>();
  return new Proxy(ws, {
    get(target, key) {
      const own = lists[key];
      if (own) return own;
      // The backend is the receiver, so its getters and methods see their own object, never the proxy.
      const v: unknown = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      const d = Reflect.getOwnPropertyDescriptor(target, key);
      if (d && !d.configurable && d.writable === false) return v;
      const fn = v as (...a: unknown[]) => unknown;
      const known = bound.get(key);
      if (known && known.fn === fn) return known.bound;
      const b = fn.bind(target);
      bound.set(key, { fn, bound: b });
      return b;
    },
  });
}
