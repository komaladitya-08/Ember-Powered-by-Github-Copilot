/**
 * "Start Ember when I log in": an XDG autostart entry in ~/.config/autostart,
 * written and removed to match the setting. It starts Ember with --autostart
 * (quietly: no settings window unless setup isn't finished). Ember touches only
 * an entry it made (marked X-Ember-Managed): one the user or an admin put there
 * is left alone, and the settings window says it is there (review #85).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function autostartFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "ember.desktop");
}

/**
 * The entry's TryExec line: the program it starts, so the desktop skips the entry quietly once that program is gone
 * (dnf remove ember, a deleted AppImage), as the file stays in ~/.config/autostart, which no package can reach. None
 * without a program: an older Ember's entry, from before TryExec, has none.
 */
function tryExec(command: readonly string[] | null): string[] {
  const program = command?.[0];
  return program ? [`TryExec=${stringValue(program)}`] : [];
}

/** A Desktop Entry string value (TryExec): no quoting or field codes, only the spec's escapes. */
function stringValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/^ /, "\\s");
}

/** How to start this Ember: the AppImage, the installed launcher, or this Electron with this app. */
export function launchCommand(o: { packaged: boolean; execPath: string; appPath: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): string[] {
  const env = o.env ?? process.env;
  const exists = o.exists ?? fs.existsSync;
  if (env.APPIMAGE) return [env.APPIMAGE];
  if (o.packaged) return exists("/usr/bin/ember") && o.execPath.startsWith("/opt/ember/") ? ["/usr/bin/ember"] : [o.execPath];
  return [o.execPath, o.appPath];
}

/** One Exec argument, quoted per the Desktop Entry spec (and escaped again as a string value; % doubled, as field codes reserve it). */
export function execArg(a: string): string {
  if (/^[A-Za-z0-9_\-./=:+,@]+$/.test(a)) return a;
  const q = a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `"${q.replace(/\\/g, "\\\\").replace(/%/g, "%%")}"`;
}

/** The line that marks an entry as Ember's own: only such an entry is rewritten or removed. */
const MANAGED = "X-Ember-Managed=true";

/** The entry's lines, Exec aside (`Exec` stands in for it). */
function entryLines(command: string[] | null, managed: boolean): string[] {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Ember",
    "Comment=Your cursor companion, powered by GitHub Copilot",
    command ? `Exec=${[...command, "--autostart"].map(execArg).join(" ")}` : "Exec",
    "Icon=ember",
    ...tryExec(command),
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "X-GNOME-Autostart-Delay=3",
    ...(managed ? [MANAGED] : []),
    "",
  ];
}

export function autostartEntry(command: string[]): string {
  return entryLines(command, true).join("\n");
}

/** Did Ember write `text`: it carries the marker, or it is an older Ember's entry (made before the marker), any Exec. */
export function emberWrote(text: string): boolean {
  if (text.split(/\r?\n/).includes(MANAGED)) return true;
  const lines = text.split("\n").map(l => (l.startsWith("Exec=") ? "Exec" : l));
  return lines.join("\n") === entryLines(null, false).join("\n");
}

function readEntry(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/**
 * Makes Ember's autostart entry match the setting; returns true if the file changed. An entry Ember didn't make is
 * never rewritten or removed (review #85): with the setting on it already starts Ember, and off, the user's own
 * choice outranks Ember's switch (foreignAutostartNote tells them).
 */
export function syncAutostart(on: boolean, command: string[], file = autostartFile()): boolean {
  const want = on ? autostartEntry(command) : null;
  const have = readEntry(file);
  if (have === want) return false;
  if (have !== null && !emberWrote(have)) return false;
  if (want) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, want, { mode: 0o644 });
  } else {
    fs.rmSync(file, { force: true });
  }
  return true;
}

/** The settings window's note when an entry Ember didn't make is at `file` (shown with ~ for `home`), else null. */
export function foreignAutostartNote(file = autostartFile(), home = os.homedir()): string | null {
  const have = readEntry(file);
  if (have === null || emberWrote(have)) return null;
  const rel = path.relative(home, file);
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join("~", rel) : file;
  return `Ember also starts when you log in from ${shown}, which it didn't make, so this switch leaves it alone.`;
}

/**
 * What main calls with "Start Ember when I log in" at start and on every settings change: the OS's login item is
 * brought in step at start only when the setting is on, then each time the setting changes (and after a failed
 * try), never because some other setting changed. A start with it off (the default, or another Ember with its own
 * data folder) removes nothing (review #85). `onSynced(on, changed)`: after each sync; `onError`: when one throws.
 */
export function loginItemFollower(sync: (on: boolean) => boolean, onSynced: (on: boolean, changed: boolean) => void, onError: (err: unknown) => void): (on: boolean) => void {
  /** The setting the login item was last brought in step with (null: not yet, or the last try failed). */
  let inStep: boolean | null = null;
  let started = false;
  return on => {
    if (!started) {
      started = true;
      if (!on) { inStep = false; return; }
    }
    if (on === inStep) return;
    try {
      const changed = sync(on);
      inStep = on;
      onSynced(on, changed);
    } catch (err) {
      inStep = null;
      onError(err);
    }
  };
}
