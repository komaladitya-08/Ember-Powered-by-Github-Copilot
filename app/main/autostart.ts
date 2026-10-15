/**
 * "Start Ember when I log in": an XDG autostart entry in ~/.config/autostart,
 * written and removed to match the setting. It starts Ember with --autostart
 * (quietly: no settings window unless setup isn't finished).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function autostartFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "ember.desktop");
}

/** How to start this Ember: the AppImage, the installed launcher, or this Electron with this app. */
export function launchCommand(o: { packaged: boolean; execPath: string; appPath: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): string[] {
  const env = o.env ?? process.env;
  const exists = o.exists ?? fs.existsSync;
  if (env.APPIMAGE) return [env.APPIMAGE];
  if (o.packaged) return exists("/usr/bin/ember") && o.execPath.startsWith("/opt/ember/") ? ["/usr/bin/ember"] : [o.execPath];
  return [o.execPath, o.appPath];
}

/** One Exec argument, quoted per the Desktop Entry spec (and escaped again as a string value). */
export function execArg(a: string): string {
  if (/^[A-Za-z0-9_\-./=:+,@]+$/.test(a)) return a;
  const q = a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `"${q.replace(/\\/g, "\\\\")}"`;
}

export function autostartEntry(command: string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Ember",
    "Comment=Your cursor companion, powered by GitHub Copilot",
    `Exec=${[...command, "--autostart"].map(execArg).join(" ")}`,
    "Icon=ember",
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "X-GNOME-Autostart-Delay=3",
    "",
  ].join("\n");
}

/** Makes the autostart entry match the setting; returns true if the file changed. */
export function syncAutostart(on: boolean, command: string[], file = autostartFile()): boolean {
  const want = on ? autostartEntry(command) : null;
  let have: string | null = null;
  try { have = fs.readFileSync(file, "utf8"); } catch { /* none */ }
  if (have === want) return false;
  if (want) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, want, { mode: 0o644 });
  } else {
    fs.rmSync(file, { force: true });
  }
  return true;
}
