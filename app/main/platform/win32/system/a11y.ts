/**
 * Windows' accessibility probes. A screen reader is running when SPI_GETSCREENREADER says so (Narrator, NVDA and JAWS
 * set it), asked at most once a minute. Never app.isAccessibilitySupportEnabled(): any UI Automation client, Ember's
 * own accessibility helper included, switches Chromium's accessibility on, and Ember would then speak everything
 * (system.md §11.1). Less motion is what Windows' "Animation effects" setting says, through Electron.
 */

import type { A11yProbes, SystemPreferencesLike } from "../../types";
import type { Win32SysApi } from "./ffi";

/** How long a screen-reader answer is kept (maySpeak asks often; the flag changes rarely). */
export const SCREEN_READER_MS = 60_000;

/** Windows' A11yProbes. */
export function win32A11y(o: { api: () => Win32SysApi | null; systemPreferences: Pick<SystemPreferencesLike, "getAnimationSettings">; now?: () => number }): A11yProbes {
  const now = o.now ?? Date.now;
  let last: { at: number; on: boolean } | null = null;
  return {
    screenReaderOn() {
      if (last && now() - last.at < SCREEN_READER_MS) return last.on;
      let on: boolean;
      try {
        on = o.api()?.screenReader() === true;
      } catch {
        on = false; // can't ask: Ember behaves as without a screen reader
      }
      last = { at: now(), on };
      return on;
    },
    systemReducedMotion() {
      try {
        return o.systemPreferences.getAnimationSettings().prefersReducedMotion;
      } catch {
        return false;
      }
    },
  };
}
