import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";

/**
 * Everyday controls that grant access, commit money, change who can see or join something, turn a protection off or
 * delete: asked every time, whatever the app's standing "Always" and with "Work without asking" on (round-seven audit).
 */
const GRANTS = { firefox: "act", nautilus: "act", "org.gnome.nautilus": "act", gedit: "act", thunderbird: "act" } as const;
const engine = (autonomy = false) => new PolicyEngine({ neverLook: () => [], grants: () => ({ ...GRANTS }), autonomy: () => (autonomy ? { ...ALL_SCOPES } : null), isTerminalApp: () => false });
const click = (name: string, r: Partial<ActionRequest> = {}): ActionRequest =>
  ({ taskId: "t", kind: "click", app: "Firefox", window: "Page - Mozilla Firefox", inPage: true, goal: "tidy up", element: { role: "push button", name }, ...r });
const asksAlways = (r: ActionRequest) => {
  for (const on of [false, true]) {
    const d = engine(on).decide(r);
    expect(d.verdict).toBe("confirm");
    expect(d.autonomy).toBeUndefined();
    expect(d.risky).toBe(true);
  }
};

describe("risky controls an app's “Always” never covers", () => {
  it.each(["Allow access", "Permit", "Allow notifications", "Allow", "Place bid", "Bid", "Bid now", "Sell", "Sell now", "Book", "Book a table", "Reserve", "Reserve now",
    "Apply now", "Vote", "Mark as spam", "Purge", "Turn off firewall", "Check out", "Check out now", "Place bet", "Bet", "Deposit", "Refund", "Make public",
    "Change visibility", "Add member", "Make admin", "Email", "Call", "Continue as Sam"])("a page's button named “%s” asks (safety-privacy-r7-1)", name => {
    asksAlways(click(name));
  });

  it.each([["Allow", "Sign in - Google Accounts - Mozilla Firefox"], ["Disable", "Two-factor authentication"], ["Turn off", "Two-step verification - Google Account"],
    ["Continue as Sam", "Sign in with Google"]])("“%s” on a page titled “%s” asks (safety-privacy-r7-1)", (name, window) => {
    asksAlways(click(name, { window }));
  });

  it.each(["Move to Wastebasket", "Move to the Rubbish Bin", "Move to Bin", "Move to Trash"])("Files' “%s” asks on Linux (safety-privacy-r7-1)", name => {
    asksAlways(click(name, { app: "org.gnome.Nautilus", window: "Documents", inPage: undefined, element: { role: "menu item", name } }));
  });

  it.each([["Mark as Junk", "thunderbird", "menu item"], ["Redirect", "thunderbird", "menu item"], ["Bounce", "thunderbird", "menu item"], ["Drop Changes and Reload", "gedit", "push button"]])(
    "“%s” in %s asks (safety-privacy-r7-1)", (name, app, role) => {
      asksAlways(click(name, { app, window: "Inbox", inPage: undefined, element: { role, name } }));
    });

  it("Enter on such a button asks as a click does (safety-privacy-r7-1)", () => {
    asksAlways(click("Place bid", { kind: "keys", value: "Return" }));
    asksAlways(click("Disable", { kind: "keys", value: "Return", window: "Two-factor authentication" }));
  });

  it.each(["Bookmarks", "Books", "Bidding history", "Reserved seats", "Call history", "Email address", "Voting record", "Allowed sites", "Next", "Disable animations",
    "Turn off the lights", "Check out our blog", "Refund policy", "Seller ratings"])("an ordinary button named “%s” still goes without a question under “Always”", name => {
    expect(engine().decide(click(name)).verdict).toBe("allow");
  });
});
