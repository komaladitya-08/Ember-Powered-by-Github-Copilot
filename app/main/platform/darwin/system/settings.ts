/**
 * The comfort settings Ember changes on a Mac (tier 0): only Dark Mode, the one with a public way to set it and read
 * it back (decision D7: only what is verified is offered). It is set through System Events (osascript), which needs the
 * user's Automation consent for Ember → System Events (macOS asks on first use; Info.plist carries
 * NSAppleEventsUsageDescription), and read back with `defaults read -g AppleInterfaceStyle`, because
 * systemPreferences.getUserDefault is cached and would report the old value. Night Shift, Focus, the clock and the
 * battery percentage have no public API, so they are not offered.
 */

import { parseOnOff, type SettingName } from "../../../hands/system";
import type { SystemSettings } from "../../types";
import { execRun, type Run } from "./exec";

/** The settings this Mac changes, with the words the model sees. */
export const DARWIN_SETTINGS: Partial<Record<SettingName, string>> = { dark_style: "Dark Mode" };

/** Shown when the user hasn't allowed Ember to control System Events (AppleEvent error -1743). */
export const AUTOMATION_DENIED =
  "Ember isn't allowed to change the appearance: allow Ember to control System Events in System Settings › Privacy & Security › Automation.";
/** Shown when System Events didn't answer (-600 not running, -1712 timed out, or the 10 s limit). */
export const NO_ANSWER = "System Events didn't answer; try again.";

/** Is Dark Mode on? `defaults` prints "Dark" when it is, and exits 1 when the key isn't set (Light). */
async function darkModeOn(run: Run): Promise<boolean> {
  const r = await run("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"], { timeout: 5000 });
  if (r.code === 0) return r.stdout.trim() === "Dark";
  if (r.code === 1) return false;
  throw new Error("Ember couldn't read the appearance setting on this Mac.");
}

/** The macOS tier-0 settings (design §9.3). */
export function darwinSettings(d: { run?: Run } = {}): SystemSettings {
  const run = d.run ?? execRun;
  return {
    available: DARWIN_SETTINGS,
    async change(name: SettingName, value: string) {
      if (name !== "dark_style") throw new Error(`Ember can't change ${name.replace(/_/g, " ")} on a Mac.`);
      const on = parseOnOff(value);
      const before = await darkModeOn(run);
      const r = await run("/usr/bin/osascript", ["-e", `tell application "System Events" to tell appearance preferences to set dark mode to ${on}`], { timeout: 10_000 });
      if (r.code !== 0) {
        if (/-1743\b/.test(r.stderr)) throw new Error(AUTOMATION_DENIED);
        if (r.failure === "timeout" || /-(600|1712)\b/.test(r.stderr)) throw new Error(NO_ANSWER);
        throw new Error("macOS didn't change Dark Mode.");
      }
      const after = await darkModeOn(run);
      return { before: String(before), after: String(after) };
    },
  };
}
