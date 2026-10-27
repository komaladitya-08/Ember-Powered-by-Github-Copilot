/**
 * Default never-look entries that are everyday words (review #120): "keeper" (Keeper on Windows), "seahorse" (GNOME's
 * Passwords and Keys) and "strongbox" (macOS) name a password manager's program, so they are matched against the
 * window's app only, never its title: a browser tab "Housekeeper wanted" or "Seahorse facts" is read as usual. The
 * user's own entries, and the other defaults, still match the app or the title.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNeverLook } from "../../app/main/perception/elements";
import { neverLooked } from "../../app/sidecar-host/windows";
import { NEVER_LOOK_APP_ONLY, NEVER_LOOK_DEFAULTS } from "../../app/shared/never-look";
import { PolicyEngine } from "../../app/main/policy/policy";

const all = [...new Set(Object.values(NEVER_LOOK_DEFAULTS).flat())];

describe("never-look defaults that are everyday words", () => {
  it("don't make a window private by its title", () => {
    expect(isNeverLook({ app: "firefox", name: "Housekeeper wanted - Mozilla Firefox" }, all)).toBe(false);
    expect(isNeverLook({ app: "chrome", name: "Seahorse facts" }, all)).toBe(false);
    expect(isNeverLook({ app: "Safari", name: "Strongbox safes for sale" }, all)).toBe(false);
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

  it("leaves the other defaults and the user's own entries matching the app or the title, as before", () => {
    expect(isNeverLook({ app: "firefox", name: "Bitwarden - Mozilla Firefox" }, all)).toBe(true);
    expect(isNeverLook({ app: "chrome", name: "My bank" }, ["bank"])).toBe(true);
    expect(isNeverLook({ app: "chrome", name: "Seahorse facts" }, ["seahorse facts"])).toBe(true);
    // The same word typed by the user is the default's entry (the list doesn't tell them apart): matched on the app.
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

  it("reads a page titled with an everyday word, and still keeps the password managers' windows private", () => {
    expect(neverLooked(win("msedge", "Housekeeper wanted - Microsoft Edge"), all, [])).toBe(false);
    expect(neverLooked(win("firefox", "Seahorse facts - Mozilla Firefox"), all, [])).toBe(false);
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
