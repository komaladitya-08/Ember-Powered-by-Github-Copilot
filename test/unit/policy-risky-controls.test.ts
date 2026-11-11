import { describe, expect, it } from "vitest";
import { PolicyEngine, isSecretField, type ActionRequest } from "../../app/main/policy/policy";
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

describe("a button with no name, or only a symbol for one", () => {
  const bare = (name: string, r: Partial<ActionRequest> = {}) => click(name, { window: "Chat - Mozilla Firefox", ...r });

  it.each([["form", "Send message"], ["section", "Delete account"], ["panel", "Post reply"], ["group", "Pay now"]])(
    "is judged by the named %s “%s” it sits in, and asks every time (safety-privacy-c7-2)", (role, name) => {
      asksAlways(bare("", { place: { role, name } }));
      asksAlways(bare("➤", { place: { role, name } }));
      // In a desktop app's window too.
      asksAlways(bare("", { app: "gedit", window: "notes.txt", inPage: undefined, place: { role, name } }));
    });

  it("says what it sits in when the user's words asked for that (safety-privacy-c7-2)", () => {
    expect(engine().decide(bare("", { goal: "send the message to Ana", place: { role: "form", name: "Send message" } }))).not.toHaveProperty("aligned", false);
    expect(engine().decide(bare("", { goal: "read the chat", place: { role: "form", name: "Send message" } }))).toMatchObject({ verdict: "confirm", aligned: false });
  });

  it.each(["➤", "↑", "→", "➜", "✈", "✉", "📨", "📤", "✓", "✔", "🗑", "⏎"])("in a page, named only “%s”, asks every time: it may send, confirm or delete (safety-privacy-c7-2)", name => {
    asksAlways(bare(name));
    asksAlways(bare(name, { kind: "keys", value: "Return" }));
  });

  it("in a page, with no name at all, asks as Ember's doubt: “Work without asking” announces it instead (safety-privacy-c7-2)", () => {
    for (const r of [bare(""), bare("", { place: { at: "bottom right" } }), bare("", { place: { role: "section", name: "Toolbar" } }), bare("⋮"), bare("", { kind: "keys", value: "space" })]) {
      expect(engine().decide(r)).toMatchObject({ verdict: "confirm" });
      expect(engine(true).decide(r)).toMatchObject({ verdict: "allow", autonomy: true });
    }
  });

  it("isn't judged by the page's own title, where the page's document is all that names it: only Ember's doubt (safety-privacy-c7-2)", () => {
    const r = bare("", { place: { role: "document web", name: "Send feedback" } });
    expect(engine().decide(r)).toMatchObject({ verdict: "confirm" });
    expect(engine().decide(r)).not.toHaveProperty("aligned", false);
    expect(engine(true).decide(r)).toMatchObject({ verdict: "allow", autonomy: true });
  });

  it("asks the same when the worker says the click lands in a page (`onPage`), by accessibility or the borrowed mouse (safety-privacy-c7-2)", () => {
    for (const kind of ["click", "cursor_click", "toggle"] as const) {
      expect(engine().decide(bare("", { kind, inPage: undefined, onPage: true })).verdict).toBe("confirm");
      asksAlways(bare("↑", { kind, inPage: undefined, onPage: true }));
    }
  });

  it("says in the question that it can't tell what the button does", () => {
    expect(engine().decide(bare("")).prompt).toMatch(/I can't tell what it does: it has no name\.$/);
  });

  it("leaves a named button, a page's unnamed link and a desktop app's unnamed button as they were", () => {
    expect(engine().decide(bare("Next")).verdict).toBe("allow");
    expect(engine().decide(bare("", { element: { role: "link", name: "" } })).verdict).toBe("allow");
    expect(engine().decide(bare("", { app: "gedit", window: "notes.txt", inPage: undefined, place: { role: "tool bar", name: "Tools" } })).verdict).toBe("allow");
  });
});

describe("payment and secret fields Ember never fills", () => {
  it.each(["Card details", "Card information", "Debit card", "Name on card", "Cardholder name", "Pass phrase"])("refuses to type into “%s” (safety-privacy-r7-2)", name => {
    expect(isSecretField(name)).toBe(true);
    for (const kind of ["text", "cursor_text", "keys"] as const) {
      expect(engine(true).decide(click(name, { kind, value: kind === "keys" ? "4" : "4111 1111 1111 1111", element: { role: "entry", name } })).verdict).toBe("deny");
    }
  });

  it.each(["Business card title", "Details", "Token", "Expiry", "Phrase"])("still types into “%s”", name => {
    expect(isSecretField(name)).toBe(false);
  });
});
