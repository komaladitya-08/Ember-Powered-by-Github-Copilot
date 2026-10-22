/**
 * How Ember's life as an app differs on a Mac (design §9.12): it has an application menu (Command+Q goes through
 * Ember's own quit, and the Edit menu makes Command+C/V work in its fields); reopening Ember.app from the Dock or
 * Finder sends "activate", not a second instance; the session ends with powerMonitor's "shutdown", not will-quit; a
 * hotkey doesn't make Ember the active app, so its own normal windows ask for that first; and its own windows are
 * never activated through AX (a call into Ember's own process from its main thread would wait for itself), least of
 * all the ask box, a non-activating panel that takes the keyboard while the user's app stays active.
 */

import type { AppLifecycle, AppLike, SystemPreferencesLike } from "../../types";

/** The macOS lifecycle facts and calls. */
export function darwinLifecycle(d: { app: Pick<AppLike, "focus">; systemPreferences: Pick<SystemPreferencesLike, "askForMediaAccess"> }): AppLifecycle {
  return {
    appUserModelId: null,
    ensureShortcut() {
      // Nothing to create: notifications on macOS need no shortcut.
    },
    appMenu: true,
    reopenShowsSettings: true,
    sessionEnd: "power-monitor-shutdown",
    focusOwnApp() {
      d.app.focus({ steal: true });
    },
    activateOwnWithInput: false,
    activateForAsk: false,
    askMicrophone: async () => {
      // macOS asks once (the answer sticks); asked after voice consent, so the prompt comes with context. main
      // doesn't await it, so it never rejects.
      const ask = d.systemPreferences.askForMediaAccess;
      try {
        return ask ? await ask.call(d.systemPreferences, "microphone") : false;
      } catch {
        return false;
      }
    },
  };
}
