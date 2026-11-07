/** The Sign out and Forget everything questions say exactly what goes, with live counts. */
import { describe, expect, it } from "vitest";
import { forgetEverythingScope, signOutScope } from "../../app/renderer/home/copy";
import { factsCount } from "../../app/renderer/home/forget-confirm";

describe("Sign out and Forget everything copy", () => {
  it("tells the user Sign out stops tasks and clears conversation, facts, reminders and routines, with counts", () => {
    const t = signOutScope({ tasks: 2, facts: 5, reminders: 1, routines: 3 });
    expect(t).toBe("Sign out? This stops 2 tasks that are running or waiting, and clears this conversation (and the copy saved on this computer, if you keep one), 5 saved facts, 1 reminder and 3 routines.");
  });
  it("uses the singular and says 0 plainly", () => {
    expect(signOutScope({ tasks: 1, facts: 1, reminders: 0, routines: 1 })).toContain("1 task that is running or waiting");
    expect(signOutScope({ tasks: 1, facts: 1, reminders: 0, routines: 1 })).toContain("0 reminders and 1 routine.");
  });
  it("tells the user Forget everything removes only saved memory and leaves the rest", () => {
    expect(forgetEverythingScope({ tasks: 2, facts: 5, reminders: 1, routines: 0 }))
      .toBe("Forget everything? This removes 5 saved facts, what Ember learned from them and the conversation saved on this computer, if you keep one. 2 tasks, 1 reminder and 0 routines stay as they are, and so do the lines on screen now, but they aren't saved again.");
  });
  it("says a count is unknown, not zero, when it couldn't be read", () => {
    const t = signOutScope({ tasks: 0, facts: null, reminders: 1, routines: 0 });
    expect(t).toContain("an unknown number of saved facts");
    expect(t).not.toContain("0 saved facts");
    expect(t).toContain("unknown, not zero");
    expect(forgetEverythingScope({ tasks: 0, facts: null, reminders: 0, routines: 0 })).toContain("removes an unknown number of saved facts");
  });
  it("says saved memory Ember can't match to this account stays, rather than promising to clear it (memory-11)", () => {
    const t = signOutScope({ tasks: 0, facts: null, reminders: 1, routines: 0, kept: true });
    expect(t).toBe("Sign out? This stops 0 tasks that are running or waiting, and clears this conversation (and the copy saved on this computer, if you keep one), 1 reminder and 0 routines. Saved memory Ember can't match to this account stays on this computer; Forget everything in Memory removes it.");
    expect(t).not.toContain("unknown");
  });
  it("counts kept memory only from a view that says sign-out leaves it (memory-11)", () => {
    expect(factsCount({ rows: [], ownership: "locked", erasesOnSignOut: false })).toEqual({ state: "kept" });
    expect(factsCount({ rows: [], ownership: "waiting", erasesOnSignOut: false })).toEqual({ state: "known", n: 0 });
    // Verified earlier in this run and reconnecting: sign-out still erases it, so it stays an unknown count.
    expect(factsCount({ rows: [], ownership: "locked", erasesOnSignOut: true })).toEqual({ state: "unknown" });
    expect(factsCount({ rows: [{ id: "f1", text: "x", source: "user", at: "2026-11-07" }], ownership: "ready", erasesOnSignOut: true })).toEqual({ state: "known", n: 1 });
    expect(factsCount({ rows: [], ownership: "locked" })).toEqual({ state: "unknown" });
    expect(factsCount(null)).toEqual({ state: "unknown" });
  });
});
