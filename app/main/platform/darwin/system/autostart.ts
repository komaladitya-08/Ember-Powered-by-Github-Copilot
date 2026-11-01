/**
 * "Start Ember when I log in" on a Mac: Electron's login item, which on macOS 13+ registers Ember.app itself with
 * SMAppService (no arguments reach it, so a login start is told by wasOpenedAtLogin). Every register shows macOS's
 * "Background Items Added" notification, and main syncs on every settings change, so the OS is touched only when
 * it is out of step with the setting. A copy macOS can't register for good (run from the disk image or Downloads,
 * which macOS translocates) reads back "not-found": that register isn't repeated until Ember restarts, and the
 * settings window asks the user to move Ember to Applications instead.
 */

import type { AppLike, Autostart, LoginItemSettingsLike } from "../../types";

/** Shown while macOS waits for the user to allow the login item. */
export const NEEDS_APPROVAL = "Allow Ember in System Settings › General › Login Items to start it when you log in.";
/** Shown when the login item can't stick because of where Ember is. */
export const MOVE_FIRST = "Move Ember to the Applications folder, then turn this on again.";

/** Is the login item on as far as the setting is concerned (registered, or waiting for the user's approval)? */
export function loginItemOn(s: LoginItemSettingsLike): boolean {
  return s.status ? s.status === "enabled" || s.status === "requires-approval" : s.openAtLogin;
}

/** The macOS autostart (design §9.5). */
export function darwinAutostart(app: Pick<AppLike, "getLoginItemSettings" | "setLoginItemSettings" | "isInApplicationsFolder">): Autostart {
  let notFoundThisSession = false;
  const settings = (): LoginItemSettingsLike | null => {
    try {
      return app.getLoginItemSettings();
    } catch {
      return null; // can't tell: treated as off and not opened at login
    }
  };
  return {
    sync(on: boolean): boolean {
      const s = settings();
      if (s && loginItemOn(s) === on) return false;
      if (on && notFoundThisSession) return false;
      app.setLoginItemSettings({ openAtLogin: on });
      if (on && settings()?.status === "not-found") notFoundThisSession = true;
      return true;
    },

    launchedAtLogin(argv: readonly string[]): boolean {
      return argv.includes("--autostart") || settings()?.wasOpenedAtLogin === true;
    },

    note(): string | null {
      const s = settings();
      if (s?.status === "requires-approval") return NEEDS_APPROVAL;
      if (notFoundThisSession) return MOVE_FIRST;
      // Only while the user has it on: off, there's nothing to move Ember for (the location check says it anyway).
      let inApplications: boolean | undefined;
      try {
        inApplications = app.isInApplicationsFolder?.();
      } catch {
        inApplications = undefined; // can't tell: no note
      }
      return s && loginItemOn(s) && inApplications === false ? MOVE_FIRST : null;
    },
  };
}
