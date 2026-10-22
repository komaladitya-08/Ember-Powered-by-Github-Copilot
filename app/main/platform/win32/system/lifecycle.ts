/**
 * Ember's life cycle on Windows: its AppUserModelId (main sets it before ready; toasts and the login item's Run value
 * use it), the Start Menu shortcut toasts need (a zip build has no installer to make one), and how Windows ends a
 * session: at log-off before-quit and will-quit don't fire, so main listens for its windows' "session-end" (G10).
 * Ember's own windows are activated through the input backend (Windows' foreground rules), and the ask box, a tool
 * window, is activated as on Linux.
 */

import path from "node:path";
import type { Logger } from "../../../logger";
import type { AppLifecycle, ShellLike } from "../../types";
import { NODE_FS, samePath, type AppsFs } from "./apps";
import { AUMID } from "./identity";
import { LnkError, parseShellLink } from "./lnk";

export { AUMID };

/** What ensureShortcut needs (injected for tests). */
export interface ShortcutDeps {
  packaged: boolean;
  execPath: string;
  /** The user's Start Menu programs folder (null when Windows won't say). */
  programs: () => string | null;
  shell: Pick<ShellLike, "writeShortcutLink">;
  fs?: Pick<AppsFs, "exists" | "readFile">;
  log?: () => Logger | null;
}

/**
 * Makes sure <Start Menu>\Programs\Ember.lnk opens this Ember with Ember's AUMID (packaged only: in development the
 * program is electron.exe). Replaces a shortcut that points elsewhere or carries another AUMID. Never throws: a
 * failure is logged as platform.shortcut_failed (toasts then don't show, nothing else is affected).
 */
export function ensureShortcut(d: ShortcutDeps): void {
  if (!d.packaged) return;
  const files = d.fs ?? NODE_FS;
  const log = d.log?.() ?? null;
  try {
    const dir = d.programs();
    if (!dir) {
      log?.warn("platform.shortcut_failed", { reason: "no Start Menu folder" });
      return;
    }
    const file = path.win32.join(dir, "Ember.lnk");
    const exists = files.exists(file);
    if (exists) {
      const bytes = files.readFile(file, 1024 * 1024);
      try {
        const link = bytes ? parseShellLink(bytes) : null;
        if (link?.target && samePath(link.target, d.execPath) && link.aumid === AUMID) return;
      } catch (err) {
        if (!(err instanceof LnkError)) throw err; // an unreadable shortcut is replaced
      }
    }
    if (!d.shell.writeShortcutLink) {
      log?.warn("platform.shortcut_failed", { reason: "no shortcut writer" });
      return;
    }
    const ok = d.shell.writeShortcutLink(file, exists ? "replace" : "create", { target: d.execPath, appUserModelId: AUMID, description: "Ember" });
    if (!ok) log?.warn("platform.shortcut_failed", { reason: "Windows refused to write the shortcut" });
  } catch (err) {
    log?.warn("platform.shortcut_failed", { err });
  }
}

/** Windows' AppLifecycle. */
export function win32Lifecycle(d: ShortcutDeps): AppLifecycle {
  return {
    appUserModelId: AUMID,
    ensureShortcut: () => ensureShortcut(d),
    appMenu: false,
    reopenShowsSettings: false,
    sessionEnd: "window-session-end",
    focusOwnApp() { /* Windows activates Ember's windows through the input backend (activateOwnWithInput) */ },
    activateOwnWithInput: true,
    activateForAsk: true,
  };
}
