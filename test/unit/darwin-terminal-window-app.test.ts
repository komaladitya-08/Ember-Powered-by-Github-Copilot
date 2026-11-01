/**
 * The policy's terminal check on macOS (hands/system.ts isTerminalWindowApp, as main.ts gives it to the policy): a
 * window's app is known by its name and by the bundle id of every installed app whose windows report that name, so a
 * terminal shown under another name (a renamed bundle, a preview build) is still refused, while Console, Notes and an
 * app outside the catalogue are judged by name as before. On Linux and Windows the name alone decides, and the
 * catalogue isn't even listed. The catalogue is the real macOS one (darwin/system/apps.ts) over bundles in a temporary
 * folder.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { darwinApps } from "../../app/main/platform/darwin/system/apps";
import { isTerminalApp, isTerminalWindowApp } from "../../app/main/hands/system";
import { PolicyEngine } from "../../app/main/policy/policy";
import { KEYS } from "../../app/shared/shortcuts";
import type { AppCatalog } from "../../app/main/platform/types";

/** An XML Info.plist with these string keys. */
const infoXml = (keys: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${
  Object.entries(keys).map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>`).join("\n")}\n</dict>\n</plist>\n`;

function bundle(dir: string, name: string, keys: Record<string, string>): void {
  const b = path.join(dir, name);
  fs.mkdirSync(path.join(b, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(b, "Contents", "Info.plist"), infoXml(keys));
}

describe("the policy's terminal check on macOS, by bundle id", () => {
  let root: string;
  let catalogue: AppCatalog;
  const terminal = (name: string) => isTerminalWindowApp(name, catalogue, "darwin");

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-terminal-ids-"));
    const apps = path.join(root, "Applications");
    // Terminals under names that say nothing (a renamed bundle; preview and nightly builds), each with its real bundle id.
    bundle(path.join(apps, "Utilities"), "Shell Window.app", { CFBundleExecutable: "Terminal", CFBundleIdentifier: "com.apple.Terminal" });
    bundle(apps, "Warp Preview.app", { CFBundleExecutable: "preview", CFBundleIdentifier: "dev.warp.Warp-Preview", CFBundleName: "Warp Preview" });
    bundle(apps, "Ghostty Tip.app", { CFBundleExecutable: "tip", CFBundleIdentifier: "com.mitchellh.ghostty", CFBundleName: "Ghostty Tip" });
    bundle(apps, "Sessions.app", { CFBundleExecutable: "Sessions", CFBundleIdentifier: "com.googlecode.iterm2" });
    bundle(apps, "Kitten.app", { CFBundleExecutable: "launcher", CFBundleIdentifier: "net.kovidgoyal.kitty" });
    bundle(apps, "Glass.app", { CFBundleExecutable: "glass", CFBundleIdentifier: "org.alacritty" });
    bundle(apps, "Wez.app", { CFBundleExecutable: "wez", CFBundleIdentifier: "com.github.wez.wezterm" });
    // An app with a shell built in, renamed.
    bundle(apps, "Editor.app", { CFBundleExecutable: "Editor", CFBundleIdentifier: "com.microsoft.VSCode" });
    // Ordinary apps, and the log viewer.
    bundle(apps, "Notes.app", { CFBundleExecutable: "Notes", CFBundleIdentifier: "com.apple.Notes", CFBundleName: "Notes" });
    bundle(path.join(apps, "Utilities"), "Console.app", { CFBundleExecutable: "Console", CFBundleIdentifier: "com.apple.Console", CFBundleName: "Console" });
    catalogue = darwinApps({ roots: [{ dir: apps, vendors: true }, { dir: path.join(apps, "Utilities") }], extraBundles: [], home: () => root });
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("refuses a terminal shown under another name, by its bundle id (any case, by its file or bundle name)", () => {
    for (const name of ["Shell Window", "Warp Preview", "Ghostty Tip", "Sessions", "Kitten", "Glass", "Wez", "shell window", " Kitten "]) {
      // The name alone says nothing: only the bundle id does.
      expect(isTerminalApp({ id: name, name }, "darwin"), name).toBe(false);
      expect(terminal(name), name).toBe(true);
    }
    expect(terminal("Editor")).toBe(true);
  });

  it("still knows a terminal by its name, whether or not it is installed", () => {
    for (const name of ["Terminal", "iTerm2", "Warp", "ターミナル"]) expect(terminal(name), name).toBe(true);
  });

  it("leaves ordinary apps, the Console log viewer and apps it doesn't list alone, never matching a window by an executable's name", () => {
    for (const name of ["Notes", "Console", "TextEdit", "", "  "]) expect(terminal(name), JSON.stringify(name)).toBe(false);
    // Apple's Preview isn't Warp Preview (whose executable is "preview"), nor is a window named "launcher" kitty's.
    for (const name of ["Preview", "launcher"]) expect(terminal(name), name).toBe(false);
  });

  it("refuses acting in such a window in the policy, as main.ts wires it", () => {
    const policy = new PolicyEngine({
      neverLook: () => [], grants: () => ({ "shell window": "act", notes: "act" }), keys: KEYS.darwin, os: "darwin",
      isTerminalApp: name => isTerminalWindowApp(name, catalogue, "darwin"),
    });
    const click = (app: string) => policy.decide({ taskId: "t", kind: "click", app, window: "Default", element: { role: "menu item", name: "Paste" } });
    expect(click("Shell Window")).toMatchObject({ tier: "never", reason: "Ember doesn't act in terminal windows or apps with a shell built in; it runs commands in its own command window when Commands is on" });
    expect(click("Notes").tier).not.toBe("never");
    expect(policy.decide({ taskId: "t", kind: "open_app", app: "Warp Preview", window: "" }).tier).toBe("never");
  });
});

describe("the policy's terminal check on Linux and Windows", () => {
  /** A catalogue whose list must never be read there: the name alone decides. */
  const catalogue = (os: "linux" | "win32"): Pick<AppCatalog, "list" | "isTerminalApp" | "appKey"> => ({
    list: () => { throw new Error("listed"); },
    isTerminalApp: a => isTerminalApp(a, os),
    appKey: s => s.toLowerCase(),
  });

  it("judges the name alone, exactly as isTerminalApp({ id: name, name }) does", () => {
    for (const os of ["linux", "win32"] as const) {
      for (const name of ["gnome-terminal-server", "Terminal", "cmd", "WindowsTerminal", "org.gnome.Console", "gedit", "notepad", "Shell Window", ""]) {
        expect(isTerminalWindowApp(name, catalogue(os), os), `${os} ${name}`).toBe(isTerminalApp({ id: name, name }, os));
      }
    }
    expect(isTerminalWindowApp("gnome-terminal-server", catalogue("linux"))).toBe(true);
    expect(isTerminalWindowApp("gedit", catalogue("linux"))).toBe(false);
  });
});
