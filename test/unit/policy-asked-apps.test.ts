/** No "Let me work in …?" in an app the user asked for help in (Settings › Apps & privacy, on by default). */

import { describe, expect, it } from "vitest";
import { PolicyEngine, askedFor, type ActionRequest } from "../../app/main/policy/policy";

const req = (o: Partial<ActionRequest> = {}): ActionRequest => ({ taskId: "t", kind: "click", app: "mousepad", window: "notes.txt - Mousepad", element: { role: "push button", name: "Bold" }, ...o });
const engine = (o: { trust?: boolean; allowGrants?: boolean; confirmEvery?: boolean } = {}) => new PolicyEngine({
  neverLook: () => [], grants: () => ({}), now: () => 0,
  trustAskedApps: () => o.trust ?? true, allowGrants: () => o.allowGrants ?? true, confirmEveryAction: () => o.confirmEvery ?? false,
});

describe("askedFor", () => {
  it("is the app the user was in when they asked", () => {
    expect(askedFor({ app: "mousepad", askedIn: "Mousepad", goal: "make the title bold" })).toBe(true);
    expect(askedFor({ app: "soffice", askedIn: "mousepad", goal: "make the title bold" })).toBe(false);
  });

  it("is an app the user's own words name, as a whole word", () => {
    expect(askedFor({ app: "firefox", goal: "open Firefox and find the train times" })).toBe(true);
    expect(askedFor({ app: "mousepad", goal: "in mousepad, make the title bold" })).toBe(true);
    expect(askedFor({ app: "gedit", goal: "I hate ungedited text" })).toBe(false);
    expect(askedFor({ app: "firefox", goal: "" })).toBe(false);
  });
});

describe("the first action in an app the user asked for help in", () => {
  it("doesn't ask whether Ember may work there", () => {
    const d = engine().decide(req({ askedIn: "mousepad", goal: "make the title bold" }));
    expect(d).toMatchObject({ verdict: "allow", reason: "the user asked for help in Mousepad" });
  });

  it("still asks before anything hard to undo there", () => {
    const d = engine().decide(req({ askedIn: "mousepad", goal: "tidy my notes", element: { role: "push button", name: "Delete" } }));
    expect(d.verdict).toBe("confirm");
  });

  it("asks as before in an app the user didn't ask about, with the switch off, or where the organisation says so", () => {
    expect(engine().decide(req({ askedIn: "firefox", goal: "make the title bold" }))).toMatchObject({ verdict: "confirm", needsGrant: true });
    expect(engine({ trust: false }).decide(req({ askedIn: "mousepad", goal: "make it bold" })).verdict).toBe("confirm");
    expect(engine({ allowGrants: false }).decide(req({ askedIn: "mousepad", goal: "make it bold" })).verdict).toBe("confirm");
    expect(engine({ confirmEvery: true }).decide(req({ askedIn: "mousepad", goal: "make it bold" })).verdict).toBe("confirm");
  });
});
