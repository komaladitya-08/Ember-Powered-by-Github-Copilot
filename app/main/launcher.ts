/**
 * "Ask Ember" in the OS's own launcher (owner decision D-45b), beside the ask shortcut, so the ask box opens without it
 * (another app may hold the chord and its fallback, and someone who uses the pointer may never learn it): the Windows
 * jump list, the Linux desktop entry's action (packaging/ember.desktop, for the RPM and the AppImage) and the macOS Dock
 * menu. The first two start Ember with --ask (a second start hands its arguments to the running Ember, main.ts
 * "second-instance"); the Dock menu's item runs in the running Ember. Pure, so it is unit-tested: main gives Electron
 * what these return.
 */

/** The argument a launcher entry starts Ember with: the ask box opens (once Ember is set up). */
export const ASK_ARG = "--ask";

/** The launcher entries' name: the handle menu's item, without the dots a menu item that opens a box has. */
export const ASK_ENTRY = "Ask Ember";

/** This start (or the second start handed over to the running Ember) asks for the ask box. */
export function wantsAsk(argv: readonly string[]): boolean {
  return argv.includes(ASK_ARG);
}

/** A jump-list task as Electron's app.setUserTasks takes it (Windows). */
export interface JumpListTask {
  program: string;
  arguments: string;
  title: string;
  description: string;
  iconPath: string;
  iconIndex: number;
}

/**
 * The Windows jump list's tasks: Ask Ember, which starts Ember.exe with --ask. In a development run Electron is given the
 * app's folder first, quoted (it may have spaces in it), as the login item does.
 */
export function jumpListTasks(o: { execPath: string; appPath: string; packaged: boolean }): JumpListTask[] {
  return [{
    program: o.execPath, arguments: o.packaged ? ASK_ARG : `"${o.appPath}" ${ASK_ARG}`,
    title: ASK_ENTRY, description: "Open the box to ask Ember something", iconPath: o.execPath, iconIndex: 0,
  }];
}

/** The macOS Dock menu's items (app.dock.setMenu), above the Dock's own. */
export function dockMenuItems(ask: () => void): { label: string; click: () => void }[] {
  return [{ label: ASK_ENTRY, click: ask }];
}

/**
 * What Ember shows once it has started: settings until it is set up, or when this desktop session can't work (its setup
 * check says why); the ask box for a launcher's --ask; settings for a start by the user (or --show-settings); at login,
 * only its greeting.
 */
export function startView(o: { onboarded: boolean; showSettings: boolean; atLogin: boolean; sessionProblem: boolean; ask: boolean }): "settings" | "ask" | "greet" {
  if (!o.onboarded || o.sessionProblem) return "settings";
  if (o.ask) return "ask";
  return o.showSettings || !o.atLogin ? "settings" : "greet";
}
