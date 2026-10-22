/**
 * Start at login on Windows through Electron's app.setLoginItemSettings, which writes
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<value>. The value is named after the AppUserModelId main sets
 * before ready, and no `name` is ever passed: Electron's getLoginItemSettings takes no name on Windows and computes
 * openAtLogin from the value named after the AUMID, so a value named anything else would read as "off" for ever,
 * and sync(true) would rewrite it on every settings change while sync(false) never deleted it (finding W1). The
 * same `path` and `args` are passed when reading and writing. Electron quotes each argument that has a space itself
 * (the runner's Run value showed a pre-quoted path quoted again, with escaped quotes), so paths go in unquoted. The
 * OS is touched only when it isn't already in step (main calls sync on every change).
 */

import type { AppLike, Autostart } from "../../types";
import { AUMID } from "./identity";

/** What Ember registers: its own program, plus the app folder in development (where execPath is electron.exe). */
export function loginItem(o: { packaged: boolean; execPath: string; appPath: string }): { path: string; args: string[] } {
  return { path: o.execPath, args: o.packaged ? ["--autostart"] : [o.appPath, "--autostart"] };
}

export const TURNED_OFF_NOTE = "Turned off in Task Manager's Startup apps: turn Ember on there to start it when you sign in.";

/** Windows' Autostart over Electron's login-item settings (injected `app`). */
export function win32Autostart(o: { app: Pick<AppLike, "getLoginItemSettings" | "setLoginItemSettings">; packaged: boolean; execPath: string; appPath: string; aumid?: string }): Autostart {
  const item = loginItem(o);
  const aumid = o.aumid ?? AUMID;
  const read = () => o.app.getLoginItemSettings({ path: item.path, args: item.args });
  return {
    sync(on) {
      if (read().openAtLogin === on) return false;
      o.app.setLoginItemSettings({ openAtLogin: on, path: item.path, args: item.args });
      return true;
    },
    launchedAtLogin: argv => argv.includes("--autostart"),
    note() {
      let s;
      try {
        s = read();
      } catch {
        return null; // the settings window shows the switch without a note
      }
      if (!s.openAtLogin) return null;
      const entry = s.launchItems?.find(i => i.name.toLowerCase() === aumid.toLowerCase());
      return s.executableWillLaunchAtLogin === false || entry?.enabled === false ? TURNED_OFF_NOTE : null;
    },
  };
}
