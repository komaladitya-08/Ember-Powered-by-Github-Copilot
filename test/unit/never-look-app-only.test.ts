/**
 * Never-look entries that are everyday words (review #120, cross-review S3): "keeper" (Keeper on Windows), "seahorse"
 * (GNOME's Passwords and Keys) and "strongbox" (macOS) match a window's app, and its title only where a word there starts
 * with them: a browser tab "Housekeeper wanted" is read as usual, while Keeper's web vault ("My Vault | Keeper") stays
 * private, whether the word is a default or the user typed it (the list can't tell them apart). The other entries
 * match the app or the title anywhere, as the settings window says.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNeverLook } from "../../app/main/perception/elements";
import { neverLooked } from "../../app/sidecar-host/windows";
import { NEVER_LOOK_APP_ONLY, NEVER_LOOK_DEFAULTS } from "../../app/shared/never-look";
import { PolicyEngine } from "../../app/main/policy/policy";

const all = [...new Set(Object.values(NEVER_LOOK_DEFAULTS).flat())];

describe("never-look entries that are everyday words", () => {
  it("don't make a window private by a longer word in its title", () => {
    expect(isNeverLook({ app: "firefox", name: "Housekeeper wanted - Mozilla Firefox" }, all)).toBe(false);
    expect(isNeverLook({ app: "chrome", name: "Goalkeeper gloves, bookkeeper jobs" }, all)).toBe(false);
    expect(isNeverLook({ app: "chrome", name: "Babyseahorse.org" }, all)).toBe(false);
    expect(isNeverLook({ app: "Safari", name: "MyStrongbox safes for sale" }, all)).toBe(false);
    const e = new PolicyEngine({ neverLook: () => all, grants: () => ({ firefox: "act" }), rateLimit: 1e6 });
    expect(e.decide({ taskId: "t", kind: "click", app: "firefox", window: "Housekeeper wanted - Mozilla Firefox", element: { role: "link", name: "Apply" } }).reason)
      .not.toMatch(/never-look/);
  });

  it("still keep the password managers' own windows private, by their program", () => {
    expect(isNeverLook({ app: "seahorse", name: "Passwords and Keys" }, all)).toBe(true);
    expect(isNeverLook({ app: "org.gnome.seahorse.Application", name: "Login" }, all)).toBe(true);
    expect(isNeverLook({ app: "keeperpasswordmanager", name: "Keeper" }, all)).toBe(true);
    expect(isNeverLook({ app: "Strongbox", name: "Database" }, all)).toBe(true);
    expect([...NEVER_LOOK_APP_ONLY].sort()).toEqual(["keeper", "seahorse", "strongbox"]);
  });

  it("keep a window private whose title has a word starting with them: Keeper's web vault in a browser (S3)", () => {
    // The user's own "Keeper" on Linux, where it isn't a default: the vault in Firefox isn't read, nor acted in.
    const mine = [...NEVER_LOOK_DEFAULTS.linux, "Keeper"];
    const vault = { app: "firefox", name: "My Vault | Keeper - Mozilla Firefox" };
    expect(isNeverLook(vault, mine)).toBe(true);
    const e = new PolicyEngine({ neverLook: () => mine, grants: () => ({ firefox: "act" }), rateLimit: 1e6 });
    expect(e.decide({ taskId: "t", kind: "read", app: "firefox", window: vault.name }).reason).toMatch(/never-look/);
    expect(e.decide({ taskId: "t", kind: "click", app: "firefox", window: vault.name, element: { role: "link", name: "Logins" } }).reason).toMatch(/never-look/);
    // Typed in any case, and Windows' own default: Keeper's vault in Edge, as Bitwarden's is by "bitwarden".
    expect(isNeverLook(vault, ["keeper"])).toBe(true);
    expect(isNeverLook({ app: "msedge", name: "Keeper Vault - Microsoft Edge" }, [...NEVER_LOOK_DEFAULTS.win32])).toBe(true);
    expect(isNeverLook({ app: "msedge", name: "keepersecurity.com/vault" }, [...NEVER_LOOK_DEFAULTS.win32])).toBe(true);
    expect(isNeverLook({ app: "msedge", name: "Bitwarden Web vault - Microsoft Edge" }, [...NEVER_LOOK_DEFAULTS.win32])).toBe(true);
    // A word of its own: what a title names by it is taken for the password manager.
    expect(isNeverLook({ app: "chrome", name: "Seahorse facts" }, all)).toBe(true);
    expect(isNeverLook({ app: "Safari", name: "Strongbox safes for sale" }, all)).toBe(true);
    expect(isNeverLook({ app: "firefox", name: "Zoo (seahorses) - Mozilla Firefox" }, ["Seahorse"])).toBe(true);
  });

  it("leaves the other entries matching the app or the title anywhere, as before", () => {
    expect(isNeverLook({ app: "firefox", name: "Bitwarden - Mozilla Firefox" }, all)).toBe(true);
    expect(isNeverLook({ app: "chrome", name: "My bank" }, ["bank"])).toBe(true);
    expect(isNeverLook({ app: "chrome", name: "Online banking" }, ["bank"])).toBe(true);
    expect(isNeverLook({ app: "chrome", name: "Seahorse facts" }, ["seahorse facts"])).toBe(true);
    expect(isNeverLook({ app: "keeper", name: "" }, ["Keeper"])).toBe(true);
  });
});

/**
 * The sidecars judge the list Ember sends them (read_window, at_point) the same way: Windows' and macOS's accessibility
 * host (sidecar-host/windows.ts neverLooked) and Linux's AT-SPI sidecar (ember_atspi.py never_looked, whose own test
 * covers it), so a window main would read isn't refused there as private.
 */
describe("the sidecars' never-look check", () => {
  const win = (app: string, name: string, pid = 30) => ({ app, name, pid, path: "w1", role: "frame", active: true, bounds: null });

  it("reads a page titled with a longer word, and still keeps the password managers' windows and vaults private", () => {
    expect(neverLooked(win("msedge", "Housekeeper wanted - Microsoft Edge"), all, [])).toBe(false);
    expect(neverLooked(win("firefox", "Goalkeeper gloves - Mozilla Firefox"), all, [])).toBe(false);
    expect(neverLooked(win("msedge", "My Vault | Keeper - Microsoft Edge"), all, [])).toBe(true);
    expect(neverLooked(win("firefox", "My Vault | Keeper - Mozilla Firefox"), ["Keeper"], [])).toBe(true);
    expect(neverLooked(win("keeperpasswordmanager", "Keeper"), all, [])).toBe(true);
    expect(neverLooked(win("seahorse", "Passwords and Keys"), all, [])).toBe(true);
    expect(neverLooked(win("firefox", "Bitwarden - Mozilla Firefox"), all, [])).toBe(true);
    expect(neverLooked(win("msedge", "Seahorse facts"), ["seahorse facts"], [])).toBe(true);
    // By process (Ember found it by its window class), and an entry that isn't text is passed over.
    expect(neverLooked(win("msedge", "Anything"), all, [30])).toBe(true);
    expect(neverLooked(win("msedge", "Anything"), [42 as unknown as string, "bitwarden"], [])).toBe(false);
  });

  it("knows the same everyday words as main", () => {
    const py = fs.readFileSync(path.join(__dirname, "../../sidecar/atspi/ember_atspi.py"), "utf8");
    const m = /^NEVER_LOOK_APP_ONLY = frozenset\(\[([^\]]*)\]\)/m.exec(py);
    expect(m).not.toBeNull();
    const words = [...m![1].matchAll(/"([^"]+)"/g)].map(x => x[1]).sort();
    expect(words).toEqual([...NEVER_LOOK_APP_ONLY].sort());
  });
});
