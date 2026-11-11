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

/**
 * The words that grant or commit are also the first words of headlines, tabs and menu items: what names a place, a
 * setting or what a link leads to isn't asked as something the user didn't ask for (regression review of round seven).
 */
describe("labels that only start with a word that grants or commits", () => {
  const plain = (r: ActionRequest) => {
    for (const on of [false, true]) {
      const d = engine(on).decide(r);
      expect(d.verdict).toBe("allow");
      expect(d.aligned).not.toBe(false);
    }
  };
  // As the worker sends a click: `onPage`, never `inPage`.
  const onPage = (role: string, name: string): ActionRequest => click(name, { inPage: undefined, onPage: true, goal: "Open the first article about interest rates", element: { role, name } });

  it.each(["Reserve Bank raises interest rates again", "Call the Midwife - Series 13 Trailer", "Allow Me to Reintroduce Myself", "Sell-off deepens as markets tumble",
    "Permit applications open for summer events", "Book a demo", "Email", "Call"])("a page's link named “%s” goes without a question (safety-privacy-x7-1)", name => {
    plain(onPage("link", name));
    plain(click(name, { element: { role: "link", name } }));
  });

  it.each(["Email", "Call", "Book", "Allow"])("a tab named “%s” goes without a question (safety-privacy-x7-1)", name => {
    plain(onPage("page tab", name));
  });

  it.each(["Allow Editing", "Allow Text Wrapping"])("a menu's “%s” goes without a question (safety-privacy-x7-1)", name => {
    plain(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined, element: { role: "menu item", name } }));
  });

  it.each(["Reserve space", "Sell by date"])("a button named “%s” goes without a question (safety-privacy-x7-1)", name => {
    plain(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined }));
  });

  it("a click on a headline's own text goes without a question (safety-privacy-x7-1)", () => {
    plain(onPage("static", "Reserve Bank raises interest rates again"));
  });

  it("an OK on a page titled with a headline isn't asked for the title's first word (safety-privacy-x7-1)", () => {
    plain(click("OK", { window: "Call the Midwife - Series 13 Trailer - Mozilla Firefox" }));
  });

  it.each(["Allow", "Allow access", "Permit", "Sell", "Reserve now", "Bid", "Vote", "Book now"])("a link named “%s” still asks every time (safety-privacy-r7-1)", name => {
    asksAlways(click(name, { inPage: undefined, onPage: true, element: { role: "link", name } }));
    asksAlways(click(name, { element: { role: "link", name } }));
  });

  it.each(["Allow", "Allow all", "Purge", "Email the file", "Book a table"])("a menu's or button's “%s” still asks every time (safety-privacy-r7-1)", name => {
    asksAlways(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined, element: { role: "menu item", name } }));
    asksAlways(click(name, { app: "gedit", window: "notes.txt - gedit", inPage: undefined }));
  });
});

/** A page that takes payment is told by its own title, not by any title with "payment" or "billing" somewhere in it. */
describe("a click in a window whose title only mentions a payment (regression review of round seven)", () => {
  const onPage = (role: string, name: string, window: string, app = "Firefox"): ActionRequest =>
    click(name, { app, window, inPage: undefined, onPage: true, goal: `use ${name}`, element: { role, name } });
  const grants = () => new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act", code: "act", slack: "act" }), autonomy: () => ({ ...ALL_SCOPES }), isTerminalApp: () => false });

  it.each([["link", "View invoice", "Payment received - bob@example.com - Gmail — Mozilla Firefox", "Firefox"], ["link", "Next page", "About billing on GitHub - GitHub Docs — Mozilla Firefox", "Firefox"],
    ["link", "Questions", "git - How to check out a branch - Stack Overflow — Mozilla Firefox", "Firefox"], ["push button", "Explorer", "billing.ts - app - Visual Studio Code", "code"],
    ["page tab", "payment.py", "payment.py - app - Visual Studio Code", "code"], ["push button", "Threads", "billing (Channel) - Acme - Slack", "slack"],
    ["check box", "Show legend", "Billing dashboard - Grafana — Mozilla Firefox", "Firefox"]])("a %s “%s” in “%s” goes without a question (safety-privacy-x7-4)", (role, name, window, app) => {
    expect(grants().decide(onPage(role, name, window, app)).verdict).toBe("allow");
  });

  it.each(["Billing - Example", "Checkout - Shop", "Checkout", "Payment", "Acme Store | Secure checkout", "Payment details - Example — Mozilla Firefox", "Billing and plans - Example",
    "Checkout: Payment method"])("any button of a page titled “%s” asks every time, and the question says why (safety-privacy-c7-2)", window => {
    const d = grants().decide(onPage("push button", "Continue", window));
    expect(d).toMatchObject({ verdict: "confirm", risky: true });
    expect(d.autonomy).toBeUndefined();
    expect(d.prompt).toBe("Click the “Continue” button in Firefox? It is on a payment page, so it may buy something.");
  });

  it("with the element known to be in a page, any title that mentions payment still asks, as it did (safety-privacy-x7-4)", () => {
    expect(grants().decide(click("Continue", { window: "Complete your payment today - Example" })).verdict).toBe("confirm");
  });
});

/** "Disable" and "Turn off" answer for a protection only as a bare answer, or where the label itself names the protection. */
describe("a longer label that starts with “Turn off” or “Disable” in a window titled for a protection (regression review of round seven)", () => {
  const apps = () => new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act", soffice: "act", evince: "act", firefox: "act" }), autonomy: () => null, isTerminalApp: () => false });

  it.each([["menu item", "Disable Line Numbers", "Security review notes.txt - gedit", "gedit"], ["menu item", "Turn off Track Changes", "Crop protection.docx - Writer", "soffice"],
    ["push button", "Turn Off Bullets and Numbering", "Verification report.odt - LibreOffice Writer", "soffice"], ["check box", "Turn off notifications", "Email verification - Firefox", "firefox"],
    ["toggle button", "Disable Night Mode", "Data Protection Policy.pdf - Evince", "evince"], ["link", "Turn off the lights", "Eye protection tips - Blog", "firefox"]])(
    "a %s “%s” in “%s” goes under “Always” (safety-privacy-x7-8)", (role, name, window, app) => {
      expect(apps().decide(click(name, { app, window, inPage: undefined, element: { role, name } })).verdict).toBe("allow");
    });

  it.each([["Disable", "Two-factor authentication"], ["Turn off", "Two-step verification - Google Account"], ["Turn it off", "Firewall"], ["Disable now", "Security"],
    ["Disable passkeys", "Account security"], ["Turn off verification", "Two-step verification"]])("“%s” in “%s” still asks every time (safety-privacy-r7-1)", (name, window) => {
    asksAlways(click(name, { window }));
  });
});
