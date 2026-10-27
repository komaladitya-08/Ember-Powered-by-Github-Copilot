/**
 * Default never-look entries that are everyday words (review #120): "keeper" (Keeper on Windows), "seahorse" (GNOME's
 * Passwords and Keys) and "strongbox" (macOS) name a password manager's program, so they are matched against the
 * window's app only, never its title: a browser tab "Housekeeper wanted" or "Seahorse facts" is read as usual. The
 * user's own entries, and the other defaults, still match the app or the title.
 */

import { describe, expect, it } from "vitest";
import { isNeverLook } from "../../app/main/perception/elements";
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
