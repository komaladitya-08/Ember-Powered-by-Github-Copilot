/**
 * Whether Ember's own files were replaced while it runs, and the offer to restart. An RPM upgrade (dnf upgrade, or
 * GNOME Software or a dnf-automatic timer, whose output nobody reads) swaps /opt/ember under a running Ember: its next
 * window would load the new version's pages and preload scripts beside the old main process. So before a window
 * opens, Ember compares its install's package.json with the one it started with (inode, size and modification time:
 * rpm renames a new file into place, so a rebuild of the same version counts too) and, once per update, offers to
 * restart. Plain Node, no Electron (main.ts asks the question; restartAfterUpdate gets Electron's app from it).
 */

import fs from "node:fs";
import { restartOptions } from "./policy/admin-watch";

export type StatLike = (file: string) => { ino: number; size: number; mtimeMs: number };

/** The file's inode, size and modification time; null when it can't be read. */
export function installStamp(file: string, stat: StatLike = fs.statSync): string | null {
  try {
    const s = stat(file);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

/** The question Ember asks when its files were replaced. */
export const UPDATED_QUESTION = {
  title: "Ember was updated",
  message: "Restart Ember to finish the update.",
  detail: "Until it starts again, some of its windows may not work as they should.",
  buttons: ["Restart Ember", "Not now"],
} as const;

/** The question's detail: what restarting would stop, in the quit question's words (quitQuestion), when anything. */
export function updatedDetail(quit: { message: string; detail: string } | null): string {
  return quit ? `${quit.message} ${quit.detail.replace(/^Quitting\b/, "Restarting")}` : UPDATED_QUESTION.detail;
}

/**
 * `beforeWindow()` (on each new window) asks, through `ask` (true: "Restart Ember"), when the install's file changed
 * since start-up; then `restart`. One question at a time, once per change ("Not now" is asked again only when the
 * files change again); nothing while the file is missing (the upgrade is still writing) or if it couldn't be read at
 * start-up.
 */
export function createUpdateCheck(o: { file: string; stat?: StatLike; ask: () => Promise<boolean>; restart: () => void }): { beforeWindow(): void } {
  const started = installStamp(o.file, o.stat);
  let askedAbout: string | null = null;
  let asking = false;
  return {
    beforeWindow() {
      if (started === null || asking) return;
      const now = installStamp(o.file, o.stat);
      if (now === null || now === started || now === askedAbout) return;
      askedAbout = now;
      asking = true;
      o.ask().then(yes => { if (yes) o.restart(); }, () => undefined).finally(() => { asking = false; });
    },
  };
}

/** What restarting needs of Electron's app (passed in, so this file stays plain Node). */
export interface Relauncher {
  relaunch(options?: { execPath?: string; args?: string[] }): void;
  quit(): void;
}

/**
 * Restarts Ember after "Restart Ember": Electron starts it again once it has quit, then it quits. When Ember runs from
 * an AppImage, that is the AppImage itself with the same arguments, as for a policy change (restartOptions):
 * `execPath` (process.execPath) is in the AppImage's mount under /tmp, which is gone once Ember quits. Everywhere else
 * (the RPM, Windows, macOS, and an RPM Ember that merely inherited another AppImage app's APPIMAGE and APPDIR) it is
 * Electron's own default, unchanged: app.relaunch() with no options, the same program with the same arguments. A start
 * that had a launcher's --ask is started again without it (restartOptions): it opened the ask box once, for that start.
 */
export function restartAfterUpdate(app: Relauncher, env: NodeJS.ProcessEnv, argv: readonly string[], execPath: string): void {
  const options = restartOptions(env, argv, execPath);
  if (options) app.relaunch(options);
  else app.relaunch();
  app.quit();
}
