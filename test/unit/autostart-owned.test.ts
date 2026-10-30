/**
 * "Start Ember when I log in" touches only what Ember made (review #85). An ember.desktop the user or an admin put in
 * ~/.config/autostart (a copy of the launcher, GNOME Tweaks, Startup Applications) is never removed or rewritten, and
 * the settings window says it is there; Ember's own entry carries a marker (older Embers' entries, made before it, are
 * still known as Ember's). Main syncs the OS's login item at start only when the setting is on, then whenever it
 * changes, so a start with the setting off (the default, another Ember's data folder) removes nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autostartEntry, autostartFile, foreignAutostartNote, loginItemFollower, syncAutostart } from "../../app/main/autostart";

const cmd = ["/usr/bin/ember"];
const fileIn = () => autostartFile({ XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ember-xdg-")) });
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** What GNOME Tweaks or a copy of the launcher leaves there. */
const USERS_OWN = [
  "[Desktop Entry]", "Type=Application", "Name=Ember", "Comment=Your cursor companion", "Exec=/usr/bin/ember %U", "Icon=ember",
  "Categories=Utility;", "X-GNOME-Autostart-enabled=true", "",
].join("\n");
/** What Ember wrote before its entries carried a marker. */
const legacy = (command: string[]) => [
  "[Desktop Entry]", "Type=Application", "Name=Ember", "Comment=Your cursor companion, powered by GitHub Copilot",
  `Exec=${command.join(" ")} --autostart`, "Icon=ember", "Terminal=false", "NoDisplay=true", "X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-Delay=3", "",
].join("\n");

describe("the XDG autostart entry (review #85)", () => {
  it("never removes an entry the user made, with the setting off", () => {
    const file = fileIn();
    put(file, USERS_OWN);
    expect(syncAutostart(false, cmd, file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(USERS_OWN);
  });

  it("never rewrites an entry the user made, with the setting on", () => {
    const file = fileIn();
    put(file, USERS_OWN);
    expect(syncAutostart(true, cmd, file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(USERS_OWN);
  });

  it("marks its own entry, and writes, keeps and removes it as before", () => {
    const file = fileIn();
    expect(autostartEntry(cmd)).toContain("\nX-Ember-Managed=true\n");
    expect(syncAutostart(true, cmd, file)).toBe(true);
    expect(syncAutostart(true, cmd, file)).toBe(false);
    // Moved (another path to this Ember): its own entry is brought up to date.
    expect(syncAutostart(true, ["/home/ada/Ember.AppImage"], file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("Exec=/home/ada/Ember.AppImage --autostart\n");
    expect(syncAutostart(false, cmd, file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("knows an older Ember's entry (made before the marker) as its own", () => {
    const file = fileIn();
    put(file, legacy(["/opt/ember/ember"]));
    expect(syncAutostart(true, cmd, file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(autostartEntry(cmd));
    put(file, legacy(cmd));
    expect(syncAutostart(false, cmd, file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("knows an older Ember's entry written with CRLF line endings as its own", () => {
    const file = fileIn();
    put(file, legacy(cmd).replace(/\n/g, "\r\n"));
    expect(foreignAutostartNote(file, path.dirname(path.dirname(path.dirname(file))))).toBeNull();
    expect(syncAutostart(false, cmd, file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("the settings window says when an entry Ember didn't make starts it at login", () => {
    const file = fileIn();
    const home = path.dirname(path.dirname(path.dirname(file)));
    expect(foreignAutostartNote(file, home)).toBeNull();
    put(file, autostartEntry(cmd));
    expect(foreignAutostartNote(file, home)).toBeNull();
    put(file, USERS_OWN);
    expect(foreignAutostartNote(file, home)).toBe(`Ember also starts when you log in from ${path.join("~", path.relative(home, file))}, which it didn't make, so this switch leaves it alone.`);
  });
});

describe("when main syncs the login item (review #85)", () => {
  const follow = (start: boolean, changes: boolean[]) => {
    const calls: boolean[] = [];
    const f = loginItemFollower(on => { calls.push(on); return true; }, () => undefined, () => undefined);
    f(start);
    for (const on of changes) f(on);
    return calls;
  };

  it("doesn't touch the OS at start while the setting is off (the default, or another Ember's data folder)", () => {
    expect(follow(false, [])).toEqual([]);
  });

  it("brings an on setting into step at start, then follows each change of it, and nothing else", () => {
    expect(follow(true, [true, true])).toEqual([true]);
    expect(follow(false, [false, true, true, false])).toEqual([true, false]);
  });

  it("tries again at the next change after a failure, and reports it", () => {
    const calls: boolean[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const f = loginItemFollower(on => { calls.push(on); if (fail) throw new Error("EACCES"); return true; }, () => undefined, err => errors.push(err));
    f(true);
    fail = false;
    f(true);
    expect(calls).toEqual([true, true]);
    expect(errors).toHaveLength(1);
  });
});
