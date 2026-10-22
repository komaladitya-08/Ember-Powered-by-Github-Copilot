/**
 * Tier-0 comfort settings on Windows (change_setting): only what Ember really changes and reads back (D7), which is
 * dark mode for apps (HKCU …\Themes\Personalize AppsUseLightTheme, 0 = dark). Running apps hear about the change
 * from one WM_SETTINGCHANGE "ImmersiveColorSet" broadcast, sent through koffi's asynchronous call and never awaited:
 * for HWND_BROADCAST the timeout applies per top-level window, so one slow app would otherwise freeze the overlay,
 * hover polling and the stop shortcut on Electron's main thread for seconds. The result Ember reports is the
 * registry's read-back, not the broadcast's. The taskbar's own setting (SystemUsesLightTheme) is left alone.
 * Text size, Do Not Disturb and clock seconds stay out until an integration test proves they apply live (§9.3).
 */

import { SETTINGS, type SettingName } from "../../../hands/system";
import type { Logger } from "../../../logger";
import type { SystemSettings } from "../../types";
import type { Win32SysApi } from "./ffi";
import { parseOnOff } from "./interim";
import { HKEY, readDword, writeDword } from "./registry";

/** The user's theme key (HKCU). */
export const PERSONALIZE = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
/** 0 = dark mode for apps, 1 = light. */
export const APPS_USE_LIGHT_THEME = "AppsUseLightTheme";
/** How long each top-level window gets to answer the broadcast (on koffi's worker thread, not Ember's main thread). */
export const BROADCAST_TIMEOUT_MS = 1000;

/** The settings Windows offers the model, and how they change. */
export function win32Settings(o: { api: () => Win32SysApi | null; log?: () => Logger | null }): SystemSettings {
  const available: Partial<Record<SettingName, string>> = { dark_style: "Dark mode for apps" };
  return {
    available,
    async change(name, value) {
      if (!Object.hasOwn(available, name)) throw new Error(`${Object.hasOwn(SETTINGS, name) ? SETTINGS[name] : name} isn't something Ember can change on Windows`);
      const api = o.api();
      if (!api) throw new Error("Ember can't reach Windows' settings on this computer");
      const read = () => {
        const r = readDword(api, HKEY.CURRENT_USER, PERSONALIZE, APPS_USE_LIGHT_THEME);
        if (r.ok) return r.value === 0;
        if (r.error === "not-found") throw new Error("Dark mode for apps is not available on this computer");
        throw new Error("Ember couldn't read Windows' dark mode setting");
      };
      const on = parseOnOff(value);
      const before = read();
      if (before !== on) {
        const w = writeDword(api, HKEY.CURRENT_USER, PERSONALIZE, APPS_USE_LIGHT_THEME, on ? 0 : 1);
        if (!w.ok) throw new Error("Ember couldn't change Windows' dark mode setting");
        const started = api.broadcastSettingChange("ImmersiveColorSet", BROADCAST_TIMEOUT_MS, ok => {
          if (!ok) o.log?.()?.debug("settings.broadcast_incomplete", { setting: name });
        });
        if (!started) o.log?.()?.debug("settings.broadcast_not_sent", { setting: name });
      }
      const after = read();
      return { before: String(before), after: String(after) };
    },
  };
}
