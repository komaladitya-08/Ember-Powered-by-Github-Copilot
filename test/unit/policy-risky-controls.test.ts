import { describe, expect, it } from "vitest";
import { PolicyEngine, isSecretField, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";

/**
 * Everyday controls that grant access, commit money, change who can see or join something, turn a protection off or
 * delete: asked every time, whatever the app's standing "Always" and with "Work without asking" on (round-seven audit).
 */
const GRANTS = { firefox: "act", nautilus: "act", "org.gnome.nautilus": "act", gedit: "act", thunderbird: "act", soffice: "act", "google-chrome": "act", winword: "act" } as const;
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

/**
 * A button or link that goes past a security warning or turns a protection off by its own name, and an answer to a
 * message box or a question that doesn't back off: asked every time, never under "Always" nor announced (round eight).
 */
describe("a button or link that goes past a warning, or answers a dialog's question", () => {
  const unGranted = (autonomy: boolean) => new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => (autonomy ? { ...ALL_SCOPES } : null), isTerminalApp: () => false });
  /** Asked every time: under a standing grant, with Work without asking on, and with no grant at all but Work without asking. */
  const asksEveryTime = (r: ActionRequest) => {
    asksAlways(r);
    const d = unGranted(true).decide(r);
    expect(d.verdict).toBe("confirm");
    expect(d.autonomy).toBeUndefined();
    expect(d.risky).toBe(true);
  };
  const macros = { name: "LibreOffice - Security Warning", text: "This document contains macros. Macros may contain viruses. Disabling macros for a document is always safe." };
  const launcher = { name: "Untrusted application launcher", text: "The application launcher “x.desktop” has not been marked as trusted. If you do not know the source of this file, launching it may be unsafe.", alert: true };
  const warned: [string, string, Partial<ActionRequest>][] = [
    ["push button", "Enable Macros", { app: "soffice", window: "LibreOffice - Security Warning", inPage: undefined, dialog: macros }],
    ["push button", "Enable All Macros", { app: "soffice", window: "budget.xlsm - LibreOffice Calc", inPage: undefined }],
    ["push button", "Enable Content", { app: "soffice", window: "budget.xlsm - LibreOffice Calc", inPage: undefined }],
    ["push button", "Enable Editing", { app: "winword", window: "report.docx [Protected View] - Word", inPage: undefined }],
    ["push button", "Exit Protected View", { app: "soffice", window: "report.docx - LibreOffice Writer", inPage: undefined }],
    ["push button", "Launch Anyway", { app: "org.gnome.Nautilus", window: "Downloads", inPage: undefined, dialog: launcher }],
    ["link", "Proceed to example.com (unsafe)", { app: "google-chrome", window: "Privacy error - Google Chrome", inPage: undefined, onPage: true }],
    ["link", "Visit this unsafe site", { app: "google-chrome", window: "Security error - Google Chrome", inPage: undefined, onPage: true }],
    ["push button", "Continue to site", { app: "google-chrome", window: "Your connection is not private", inPage: undefined, onPage: true }],
    ["push button", "Keep anyway", { app: "google-chrome", window: "Downloads - Google Chrome", inPage: undefined }],
    ["push button", "Open Anyway", { window: "Downloads", inPage: undefined, dialog: { name: "", text: "The file may harm your computer." } }],
    ["push button", "Continue anyway", { inPage: undefined, onPage: true }],
    ["push button", "Proceed anyway", { inPage: undefined, onPage: true }],
    ["push button", "Turn off Safe Browsing", { inPage: undefined, onPage: true }],
    ["push button", "Ignore warning", { inPage: undefined, onPage: true }],
    ["push button", "Skip verification", { inPage: undefined, onPage: true }],
    ["push button", "Always allow", { inPage: undefined, onPage: true }],
    ["push button", "Don't block", { inPage: undefined }],
    ["push button", "Load Remote Content", { app: "thunderbird", window: "Inbox - Mozilla Thunderbird", inPage: undefined }],
    ["push button", "Show Remote Content", { app: "thunderbird", window: "Inbox - Mozilla Thunderbird", inPage: undefined }],
    ["menu item", "Show remote content in this message", { app: "thunderbird", window: "Inbox - Mozilla Thunderbird", inPage: undefined }],
    ["push button", "Trust this document", { app: "soffice", window: "report.odt - LibreOffice Writer", inPage: undefined }],
    ["push button", "Trotzdem öffnen", { window: "Downloads", inPage: undefined }],
    ["push button", "Ouvrir quand même", { window: "Downloads", inPage: undefined }],
  ];

  it.each(warned)("a %s named “%s” asks every time, by a click and by Enter (safety-privacy-r8-1)", (role, name, r) => {
    asksEveryTime(click(name, { goal: "open the file and read it", element: { role, name }, ...r }));
    asksEveryTime(click(name, { kind: "keys", value: "Return", goal: "open the file and read it", element: { role, name }, ...r, ...(r.onPage ? { inPage: true, onPage: undefined } : {}) }));
  });

  it("says why in the question (safety-privacy-r8-1)", () => {
    expect(engine().decide(click("Keep anyway", { app: "google-chrome", window: "Downloads", inPage: undefined, goal: "download the report" })).prompt)
      .toBe("Click the “Keep anyway” button in Google Chrome? It goes past a warning or turns off a protection.");
  });

  it.each(["Enable", "Editing", "Continue", "Keep", "Open", "Show content", "Enable dark mode", "Enable Editing", "Remote desktop help", "Load more"])(
    "an ordinary button named “%s” still goes without a question under “Always”", name => {
      expect(engine().decide(click(name, { app: "soffice", window: "letter.odt - LibreOffice Writer", inPage: undefined, goal: `use ${name}` })).verdict).toBe("allow");
    });

  const leave = { name: "", text: "This page is asking you to confirm that you want to leave — information you've entered may not be saved.", alert: true };
  const save = { name: "", text: "Save changes to document “notes.txt” before closing? If you don't save, changes from the last 5 minutes will be permanently lost.", alert: true };
  const tabs = { name: "Close 12 tabs?", text: "You are about to close 12 tabs. Are you sure you want to continue?" };
  const answered: [string, ActionRequest["dialog"], string][] = [
    ["Leave page", leave, "Firefox"],
    ["Leave", { name: "Leave site?", text: "Changes you made may not be saved." }, "google-chrome"],
    ["Reload", { name: "Reload site?", text: "Changes you made may not be saved." }, "google-chrome"],
    ["Resend", { name: "", text: "To display this page, Firefox must send information that will repeat any action (such as a search or order confirmation) that was performed earlier.", alert: true }, "Firefox"],
    ["Close tabs", tabs, "Firefox"],
    ["Close Anyway", save, "gedit"],
    ["Use Anyway", save, "gedit"],
    ["Exit", save, "gedit"],
  ];

  it.each(answered)("“%s” in a message box or a dialog that asks a question asks every time, by a click and by Enter (safety-privacy-c8-1)", (name, dialog, app) => {
    const r = { app, window: "Edit post", inPage: undefined, goal: "close the tab", dialog };
    asksEveryTime(click(name, r));
    asksEveryTime(click(name, { ...r, kind: "keys", value: "Return" }));
  });

  it("quotes the dialog, and doesn't call an answer to it something the user didn't ask for (safety-privacy-c8-1)", () => {
    const d = engine().decide(click("Leave page", { inPage: undefined, window: "Edit post", goal: "close the tab", dialog: leave }));
    expect(d.prompt).toMatch(/^Click the “Leave page” button in Firefox\? It says: “This page is asking you to confirm that you want to leave/);
    expect(d).not.toHaveProperty("aligned", false);
  });

  it.each(["Cancel", "Stay on page", "Stay", "Don't leave", "No", "Close", "Close dialog", "Help", "Abbrechen", "Annuler", "Schließen", "Nein", "キャンセル(C)", "取消"])(
    "“%s” backs off such a dialog and still goes without a question under “Always” (safety-privacy-c8-1)", name => {
      for (const dialog of [leave, save, tabs]) {
        expect(engine().decide(click(name, { inPage: undefined, window: "Edit post", goal: "close the tab", dialog })).verdict).toBe("allow");
      }
    });

  it("leaves a dialog that asks nothing as it was: a settings dialog's buttons, and a page's own dialog that only holds a form (safety-privacy-c8-1)", () => {
    const paths = { name: "Options - LibreOffice - Paths", text: "Paths used by LibreOffice Type Path AutoCorrect Templates Backups" };
    expect(engine().decide(click("Edit…", { app: "soffice", window: "Options - LibreOffice", inPage: undefined, goal: "change the templates folder", dialog: paths })).verdict).toBe("allow");
    // A working dialog that only names something risky in its title or labels asks nothing new either.
    for (const [name, dialog, app] of [["Find Next", { name: "Find & Replace", text: "Find: Replace:" }, "soffice"],
      ["Find All", { name: "Find and Replace", text: "Search for Replace with Match case Whole words only" }, "soffice"],
      ["Copy link", { name: "Share", text: "Share this document with people. Anyone with the link can view." }, "firefox"],
      ["Done", { name: "Share “Budget”", text: "Add people and groups" }, "firefox"], ["Save", { name: "Save As", text: "Name: Save in folder: Recent Starred Home Desktop Trash" }, "gedit"],
      ["Next", { name: "Export as PDF", text: "Sign PDF documents" }, "soffice"], ["Insert", { name: "Insert Hyperlink", text: "Internet Mail Document New Document URL: Text: Delete" }, "soffice"]] as const) {
      expect(engine().decide(click(name, { app, window: "letter.odt", inPage: undefined, goal: "tidy up the letter", dialog })).verdict, `${name} in ${dialog.name}`).toBe("allow");
    }
    const compose = { name: "New Message", text: "To Subject Formatting options Attach files Insert link Insert emoji", alert: true, page: true };
    for (const name of ["Formatting options", "Attach files", "Insert link"]) {
      expect(engine().decide(click(name, { inPage: undefined, onPage: true, window: "Inbox - Mail", goal: "write to Ana", dialog: compose })).verdict).toBe("allow");
    }
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
