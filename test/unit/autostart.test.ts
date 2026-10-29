/**
 * Linux's "Start Ember when I log in" entry once Ember is gone: its TryExec names the program Exec starts, so the desktop
 * skips the entry quietly after `dnf remove ember` (or a deleted AppImage) instead of failing to start it at each login.
 */

import { describe, expect, it } from "vitest";
import * as autostart from "../../app/main/autostart";
import { autostartEntry, launchCommand } from "../../app/main/autostart";

const field = (entry: string, key: string) => entry.split("\n").find(l => l.startsWith(`${key}=`))?.slice(key.length + 1);

/** The entry the first 0.1.0 builds (1b39bb3) wrote, for an Exec line: no TryExec, and no X-Ember-Managed marker. */
const firstBuilds = (exec: string) => [
  "[Desktop Entry]", "Type=Application", "Name=Ember", "Comment=Your cursor companion, powered by GitHub Copilot", `Exec=${exec}`,
  "Icon=ember", "Terminal=false", "NoDisplay=true", "X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-Delay=3", "",
].join("\n");
/**
 * Whether Ember made an entry, so its switch may rewrite or remove it (fix/lifecycle, review #85: it matches an entry
 * without the marker against the first builds' lines, Exec aside). Not on this branch until fix/lifecycle merges.
 */
const emberWrote = (autostart as unknown as { emberWrote?: (text: string) => boolean }).emberWrote;

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

  it("differs from the first builds' entry only by TryExec (and the marker that says Ember made it)", () => {
    const now = autostartEntry(["/usr/bin/ember"]).split("\n").filter(l => !l.startsWith("TryExec=") && l !== "X-Ember-Managed=true");
    expect(now.join("\n")).toBe(firstBuilds("/usr/bin/ember --autostart"));
  });

  it.runIf(emberWrote)("still knows the first builds' entries as its own, so the switch can rewrite or remove them", () => {
    expect(emberWrote!(firstBuilds("/usr/bin/ember --autostart"))).toBe(true);
    expect(emberWrote!(firstBuilds('"/home/ada/My Apps/Ember-0.1.0-x86_64.AppImage" --autostart'))).toBe(true);
    expect(emberWrote!(autostartEntry(["/usr/bin/ember"]))).toBe(true);
  });
});
