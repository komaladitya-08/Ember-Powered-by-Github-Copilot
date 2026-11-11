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

/** The words that grant or commit count wherever they lead a label that acts: on a button, a link and a menu item alike. */
describe("labels that start with a word that grants or commits", () => {
  it.each(["Allow", "Allow access", "Permit", "Sell", "Reserve now", "Bid", "Vote", "Book now"])("a link named “%s” still asks every time (safety-privacy-r7-1)", name => {
    asksAlways(click(name, { inPage: undefined, onPage: true, element: { role: "link", name } }));
    asksAlways(click(name, { element: { role: "link", name } }));
  });

  it.each(["Allow", "Allow all", "Purge", "Email the file", "Book a table"])("a menu's or button's “%s” still asks every time (safety-privacy-r7-1)", name => {
    asksAlways(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined, element: { role: "menu item", name } }));
    asksAlways(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined }));
  });

  it.each(["Sell BTC", "Sell shares", "Sell at market", "Sell 10 shares of AAPL", "Reserve table", "Reserve 2 tickets", "Reserve for $20", "Purge cache", "Purge Everything",
    "Purge history"])("a button named “%s” asks every time, on a page and off one (safety-privacy-y7-1)", name => {
    asksAlways(click(name, { inPage: undefined, onPage: true, goal: "look at my account" }));
    asksAlways(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined, goal: "look at my account", element: { role: "toggle button", name } }));
  });

  it.each([["link", "Sell all"], ["link", "Purge all"], ["link", "Reserve a table"], ["link", "Email the file"], ["menu item", "Allow once"], ["menu item", "Allow while using the app"],
    ["menu item", "Purge cache"]])("a %s named “%s” asks every time (safety-privacy-y7-1)", (role, name) => {
    asksAlways(click(name, { inPage: undefined, onPage: true, goal: "look at my account", element: { role, name } }));
  });
});

/** A page that takes payment is told by any mention of one in its window's title: a button there may buy something. */
describe("a click on a page whose title mentions a payment", () => {
  const onPage = (role: string, name: string, window: string, app = "Firefox"): ActionRequest =>
    click(name, { app, window, inPage: undefined, onPage: true, goal: `use ${name}`, element: { role, name } });
  const grants = () => new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act", code: "act", slack: "act" }), autonomy: () => ({ ...ALL_SCOPES }), isTerminalApp: () => false });

  it.each(["Billing - Example", "Checkout - Shop", "Checkout", "Payment", "Acme Store | Secure checkout", "Payment details - Example — Mozilla Firefox", "Billing and plans - Example",
    "Checkout: Payment method"])("any button of a page titled “%s” asks every time (safety-privacy-c7-2)", window => {
    const d = grants().decide(onPage("push button", "Continue", window));
    expect(d).toMatchObject({ verdict: "confirm", risky: true });
    expect(d.autonomy).toBeUndefined();
  });

  it.each(["Select a Payment Method - Amazon.com Checkout - Google Chrome", "PayPal Checkout", "Stripe Checkout", "Shopping Cart & Checkout - Best Buy", "Checkout (2 items) - Shop",
    "Checkout :: Shop", "Complete your payment", "Make a payment - Barclays", "Confirm payment - Google Pay", "Billing overview - Azure",
    "Add payment method - Google Play"])("a button “Start my plan” of a page titled “%s” asks every time, as the worker sends a click (safety-privacy-y7-2)", window => {
    const d = grants().decide(onPage("push button", "Start my plan", window));
    expect(d).toMatchObject({ verdict: "confirm", risky: true });
    expect(d.autonomy).toBeUndefined();
  });

  it("with the element known to be in a page, any title that mentions payment asks too", () => {
    expect(grants().decide(click("Continue", { window: "Complete your payment today - Example" })).verdict).toBe("confirm");
  });
});

/** "Disable" and "Turn off" answer for a protection in a window or dialog titled for one, whatever follows them. */
describe("a label that starts with “Turn off” or “Disable” in a window titled for a protection", () => {
  it.each([["Disable", "Two-factor authentication"], ["Turn off", "Two-step verification - Google Account"], ["Turn it off", "Firewall"], ["Disable now", "Security"],
    ["Disable passkeys", "Account security"], ["Turn off verification", "Two-step verification"]])("“%s” in “%s” still asks every time (safety-privacy-r7-1)", (name, window) => {
    asksAlways(click(name, { window }));
  });

  it.each(["Turn off anyway", "Disable anyway", "Turn off for now", "Disable permanently", "Turn off for 1 hour", "Disable authenticator app", "Disable login approvals",
    "Turn off real-time scanning", "Disable Secure Boot", "Disable SMS codes"])("“%s” asks every time there, and in a dialog so titled (safety-privacy-y7-3)", name => {
    asksAlways(click(name, { window: "Two-factor authentication - GitHub", inPage: undefined, onPage: true }));
    asksAlways(click(name, { window: "Settings", dialog: { name: "Two-factor authentication", text: "Your account will be less secure." } }));
  });
});

/** A row is named by what it holds: an unnamed button in it isn't a button named by a mail's subject. */
describe("an unnamed button in a row, cell or item named by its content (regression review of round seven)", () => {
  it.each([["list item", "Re: please delete the old report"], ["table row", "Your order has shipped"], ["list item", "Ana - Can you send me the notes?"], ["tree item", "Trash"],
    ["table cell", "Delete the draft?"], ["link", "Send feedback"], ["heading", "Remove old files"]])("in the %s “%s” isn't asked as something the user didn't ask for (safety-privacy-x7-5)", (role, name) => {
    const r = click("", { app: "gedit", window: "Inbox", inPage: undefined, goal: "Open the message from Ana about lunch", place: { role, name } });
    expect(engine().decide(r)).toMatchObject({ verdict: "allow" });
    expect(engine().decide(r)).not.toHaveProperty("aligned", false);
  });

  it("in a page asks only as Ember's doubt, never as off-task (safety-privacy-x7-5)", () => {
    const r = click("", { goal: "Open the message from Ana about lunch", place: { role: "list item", name: "Re: please delete the old report" } });
    expect(engine().decide(r)).toMatchObject({ verdict: "confirm" });
    expect(engine().decide(r)).not.toHaveProperty("aligned", false);
    expect(engine(true).decide(r)).toMatchObject({ verdict: "allow", autonomy: true });
  });

  it("calls the page around an unnamed button a page (safety-privacy-x7-7)", () => {
    expect(engine().decide(click("", { window: "Opening hours - Example", place: { role: "document web", name: "Opening hours - Example" } })).prompt)
      .toBe("Click the button on the “Opening hours - Example” page in Firefox? I can't tell what it does: it has no name.");
    expect(engine().decide(click("", { app: "soffice", window: "Letter.odt", place: { role: "document text", name: "Letter" } })).prompt).toContain("on the “Letter” document in ");
  });
});
