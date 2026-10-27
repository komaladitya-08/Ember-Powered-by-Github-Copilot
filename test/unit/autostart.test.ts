/**
 * Linux's "Start Ember when I log in" entry once Ember is gone: its TryExec names the program Exec starts, so the desktop
 * skips the entry quietly after `dnf remove ember` (or a deleted AppImage) instead of failing to start it at each login.
 */

import { describe, expect, it } from "vitest";
import { autostartEntry, launchCommand } from "../../app/main/autostart";

const field = (entry: string, key: string) => entry.split("\n").find(l => l.startsWith(`${key}=`))?.slice(key.length + 1);

describe("the autostart entry", () => {
  it("gives TryExec the program Exec starts, for the installed Ember, an AppImage and a development run", () => {
    const rpm = launchCommand({ packaged: true, execPath: "/opt/ember/ember", appPath: "/opt/ember/resources/app", env: {}, exists: p => p === "/usr/bin/ember" });
    expect(field(autostartEntry(rpm), "TryExec")).toBe("/usr/bin/ember");
    expect(field(autostartEntry(rpm), "Exec")).toBe("/usr/bin/ember --autostart");
    expect(field(autostartEntry(["/home/ada/Apps/Ember-0.1.0-x86_64.AppImage"]), "TryExec")).toBe("/home/ada/Apps/Ember-0.1.0-x86_64.AppImage");
    expect(field(autostartEntry(["/repo/node_modules/electron/dist/electron", "/repo"]), "TryExec")).toBe("/repo/node_modules/electron/dist/electron");
  });

  it("writes TryExec as a plain string value: spaces and % as they are, backslashes escaped", () => {
    // TryExec is a string, not an Exec line: no quoting and no field codes, only the spec's escapes.
    expect(field(autostartEntry(["/home/ada/My Apps/100% Ember.AppImage"]), "TryExec")).toBe("/home/ada/My Apps/100% Ember.AppImage");
    expect(field(autostartEntry(["/home/ada/a\\b/Ember.AppImage"]), "TryExec")).toBe("/home/ada/a\\\\b/Ember.AppImage");
  });
});
