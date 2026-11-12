import { describe, expect, it } from "vitest";
import { PolicyEngine, isSecretField, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { KEYS } from "../../app/shared/shortcuts";

/**
 * Everyday controls that grant access, commit money, change who can see or join something, turn a protection off or
 * delete: asked every time, whatever the app's standing "Always" and with "Work without asking" on (round-seven audit).
 */
const GRANTS = { firefox: "act", nautilus: "act", "org.gnome.nautilus": "act", gedit: "act", thunderbird: "act", soffice: "act", "google-chrome": "act", winword: "act", evince: "act" } as const;
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

  // Those words also lead headlines, tabs and settings: such a step still asks every time, but isn't called something
  // the user didn't ask for, which put the rest of the task back to asking (regression review of round seven).
  it.each([["link", "Reserve Bank raises interest rates again", "read the top story"], ["link", "Sell-off deepens as markets slide", "read the top story"],
    ["link", "Purge of officials continues", "read the top story"], ["link", "Permit applications open on Monday", "read the top story"],
    ["link", "Book a demo", "find out what it costs"], ["page tab", "Email", "open the email settings tab"],
    ["page tab", "Book", "open the reading list"], ["menu item", "Allow Editing", "edit the document"], ["menu item", "Email", "look at the menus"]])(
    "a %s named “%s” asks every time, and isn't flagged as unasked for “%s” (safety-privacy-x7-1)", (role, name, goal) => {
      // (Enter on a tab goes as before: only a click on one is judged by its name.)
      const enter = role === "page tab" ? [] : [click(name, { kind: "keys", value: "Return", goal, element: { role, name } })];
      for (const r of [click(name, { inPage: undefined, onPage: true, goal, element: { role, name } }), ...enter]) {
        asksAlways(r);
        expect(engine().decide(r)).not.toHaveProperty("aligned", false);
        expect(engine().decide(r).prompt).not.toMatch(/You didn't ask for this/);
      }
    });

  it.each([["push button", "Sell BTC"], ["push button", "Reserve table"], ["toggle button", "Purge cache"], ["link", "Delete account"], ["menu item", "Send now"],
    ["link", "Turn off firewall"], ["menu item", "Allow remote content in messages from Ana"]])(
    "a %s named “%s” the user didn't ask for is still flagged as unasked (safety-privacy-x7-1)", (role, name) => {
      expect(engine().decide(click(name, { inPage: undefined, onPage: true, goal: "read the top story", element: { role, name } }))).toMatchObject({ verdict: "confirm", aligned: false });
    });

  // Only a word that leads headlines, tabs and settings ("Reserve…", "Email", "Allow Editing") spares the flag: a phrase
  // that grants rights, changes who can see something, drops work or turns a protection off, or a lone "Allow", keeps it.
  it.each([["menu item", "Make admin"], ["menu item", "Add member"], ["menu item", "Change visibility"], ["menu item", "Make public"], ["menu item", "Allow"],
    ["menu item", "Mark as spam"], ["menu item", "Drop changes"], ["menu item", "Pause protection"], ["menu item", "Turn off antivirus"], ["menu item", "Disable screen lock"],
    ["menu item", "Pause real-time protection"], ["link", "Continue as Ana"], ["page tab", "Make public"], ["link", "Permit"],
    ["link", "Make public transport free, says mayor"]])(
    "a %s named “%s” the user didn't ask for asks every time and is flagged as unasked (safety-privacy-x8-4)", (role, name) => {
      // (Enter on a page's link is judged by what it leads to, as before; on a menu item, by its name.)
      const enter = role === "menu item" ? [click(name, { kind: "keys", value: "Return", goal: "look at the team page", element: { role, name } })] : [];
      for (const r of [click(name, { inPage: undefined, onPage: true, window: "Members - Acme — Mozilla Firefox", goal: "look at the team page", element: { role, name } }), ...enter]) {
        asksAlways(r);
        const d = engine().decide(r);
        expect(d).toMatchObject({ verdict: "confirm", aligned: false });
        expect(d.prompt).toMatch(/You didn't ask for this, so say no if it looks wrong\.$/);
      }
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

  it.each([["page tab", "Explorer", "billing.ts - shop - Visual Studio Code", "code", "Click the “Explorer” tab in Visual Studio Code? The window's title mentions billing, so this may pay for something."],
    ["push button", "Threads", "billing (Channel) - Acme - Slack", "slack", "Click the “Threads” button in Slack? The window's title mentions billing, so this may pay for something."],
    ["link", "Next", "git - How to check out a branch - Stack Overflow — Mozilla Firefox", "Firefox", "Click the “Next” link in Firefox? The window's title mentions a checkout, so this may pay for something."],
    ["push button", "Start my plan", "PayPal Checkout", "Firefox", "Click the “Start my plan” button in Firefox? The window's title mentions a checkout, so this may pay for something."],
    ["link", "Help", "How to make a payment - Wikipedia — Mozilla Firefox", "Firefox", "Click the “Help” link in Firefox? The window's title mentions a payment, so this may pay for something."]])(
    "a %s “%s” in “%s” says why it asks, in words true of any title that mentions a payment (safety-privacy-x7-4)", (role, name, window, app, prompt) => {
      const d = grants().decide(onPage(role, name, window, app));
      expect(d).toMatchObject({ verdict: "confirm", risky: true, prompt });
      expect(d.reason).not.toContain(window);
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

  // Names that only look like one: a list's pages, a business's site, spelling, a polite refusal (regression review of round eight).
  const shop = { window: "Orders - Shop — Mozilla Firefox", inPage: undefined, onPage: true };
  const lookalikes: [string, string, Partial<ActionRequest>][] = [
    ["push button", "Go to page 2", shop], ["link", "Go to page 3", shop], ["push button", "Go to page", { app: "evince", window: "manual.pdf", inPage: undefined }],
    ["link", "Go to website", shop], ["push button", "Go to site", shop], ["link", "Continue to page 2", shop], ["push button", "Go to the page", shop],
    ["push button", "Disable spell check", { app: "thunderbird", window: "Write: hello", inPage: undefined }],
    ["menu item", "Turn off spell checking", { app: "soffice", window: "letter.odt - LibreOffice Writer", inPage: undefined }],
    ["push button", "Disable grammar checking", { app: "soffice", window: "letter.odt - LibreOffice Writer", inPage: undefined }], ["push button", "Thanks anyway", shop]];

  it.each(lookalikes)("a %s named “%s” goes without a question under “Always”, and is announced with Work without asking (safety-privacy-x8-1)", (role, name, r) => {
    const step = click(name, { goal: "find my oldest order", element: { role, name }, ...r });
    expect(engine().decide(step).verdict).toBe("allow");
    expect(unGranted(true).decide(step)).toMatchObject({ verdict: "allow", autonomy: true });
  });

  it.each([["linux", "Firefox"], ["win32", "msedge"], ["darwin", "Safari"]] as const)(
    "a list's “Go to page 2” on %s goes without a question under “Always”, and Enter on it (a borrow) is announced with Work without asking (safety-privacy-x8-1)", (os, app) => {
      const e = (autonomy: boolean) => new PolicyEngine({ neverLook: () => [], grants: () => ({ [app.toLowerCase()]: "act" }), autonomy: () => (autonomy ? { ...ALL_SCOPES } : null),
        isTerminalApp: () => false, os, keys: KEYS[os] });
      expect(e(false).decide(click("Go to page 2", { app, ...shop })).verdict).toBe("allow");
      expect(e(true).decide(click("Go to page 2", { app, window: shop.window, kind: "keys", value: "Return" }))).toMatchObject({ verdict: "allow", autonomy: true });
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

  // Windows and macOS report Firefox's prompt as a plain dialog, never an alert: its words say it sends again.
  it.each([["linux", "Firefox", "push button"], ["win32", "firefox", "push button"], ["win32", "firefox", "button"], ["darwin", "Firefox", "push button"],
    ["darwin", "Firefox", "button"]] as const)("Firefox's “Resend” on %s (%s, a %s) asks every time though the dialog isn't an alert (safety-privacy-x8-5)", (os, app, role) => {
    const resend = { name: "", text: "To display this page, Firefox must send information that will repeat any action (such as a search or order confirmation) that was performed earlier." };
    for (const [grant, autonomy] of [[true, false], [true, true], [false, true]]) {
      const e = new PolicyEngine({ neverLook: () => [], grants: () => (grant ? { [app.toLowerCase()]: "act" } : {}), autonomy: () => (autonomy ? { ...ALL_SCOPES } : null),
        isTerminalApp: () => false, os, keys: KEYS[os] });
      for (const step of [click("Resend", { app, window: "Mozilla Firefox", inPage: undefined, goal: "reload the page", dialog: resend, element: { role, name: "Resend" } }),
        click("Resend", { app, window: "Mozilla Firefox", inPage: undefined, goal: "reload the page", kind: "keys", value: "Return", dialog: resend, element: { role, name: "Resend" } })]) {
        expect(e.decide(step), `grant=${grant} autonomy=${autonomy} ${step.kind}`).toMatchObject({ verdict: "confirm", risky: true });
        expect(e.decide(step).autonomy).toBeUndefined();
        expect(e.decide(step).remember).toBe(false);
      }
    }
  });

  it("a page's own dialog that warns it sends a form again asks when a whole read shows nothing to type in, or its title asks (safety-privacy-x8-5)", () => {
    const r = { app: "Firefox", inPage: undefined, onPage: true, window: "Orders - Shop — Mozilla Firefox", goal: "reload the page", element: { role: "button", name: "Resubmit" } };
    asksEveryTime(click("Resubmit", { ...r, dialog: { name: "", text: "Going on will resubmit your order.", alert: true, page: true, controls: [{ role: "button", name: "Resubmit" }, { role: "button", name: "Cancel" }] } }));
    asksEveryTime(click("Resubmit", { ...r, dialog: { name: "Resubmit the form?", text: "", alert: true, page: true } }));
  });

  it("quotes the dialog, and doesn't call an answer to it something the user didn't ask for (safety-privacy-c8-1)", () => {
    const d = engine().decide(click("Leave page", { inPage: undefined, window: "Edit post", goal: "close the tab", dialog: leave }));
    expect(d.prompt).toMatch(/^Click the “Leave page” button in Firefox\? It says: “This page is asking you to confirm that you want to leave/);
    expect(d).not.toHaveProperty("aligned", false);
  });

  it.each(["Cancel", "Stay on page", "Stay", "Don't leave", "No", "Close", "Close dialog", "Help", "Abbrechen", "Annuler", "Schließen", "Nein", "キャンセル(C)", "取消"])(
    "“%s” backs off such a dialog and still goes without a question under “Always” (safety-privacy-c8-1)", name => {
      // (Not "No" where the dialog asks to save: there it throws the changes away, safety-privacy-x8-7.)
      for (const dialog of /^(no|nein)$/i.test(name) ? [leave, tabs] : [leave, save, tabs]) {
        expect(engine().decide(click(name, { inPage: undefined, window: "Edit post", goal: "close the tab", dialog })).verdict).toBe("allow");
      }
    });

  const update = { name: "Software Update", text: "A new version of Example is available. Would you like to download it now?", alert: true };
  const notify = { name: "", text: "“Example” would like to send you notifications. Allow?", alert: true };
  it.each([["Not right now", update], ["Not yet", update], ["Later", update], ["Maybe later", update], ["Remind Me Later", update], ["Ask me later", update],
    ["Skip for now", update], ["No, thank you", update], ["No thank you", update], ["Später", update], ["Plus tard", update], ["後で", update], ["Don't Allow", notify],
    ["Don't allow", update], ["Nicht erlauben", notify]] as const)(
    "“%s” puts off or refuses a dialog's question and goes without a question under “Always”, and is announced with Work without asking (safety-privacy-x8-6)", (name, dialog) => {
      const step = click(name, { app: "soffice", window: "Software Update", inPage: undefined, goal: "tidy up the letter", dialog });
      expect(engine().decide(step).verdict).toBe("allow");
      expect(unGranted(true).decide(step)).toMatchObject({ verdict: "allow", autonomy: true });
    });

  it.each(["Ignore", "Skip", "Skip This Version", "Start New Session"])("“%s” in a dialog's question still asks every time: it may not back off (safety-privacy-x8-6)", name => {
    asksEveryTime(click(name, { app: "soffice", window: "Software Update", inPage: undefined, goal: "tidy up the letter", dialog: update }));
  });

  // In a dialog that asks to save, "No" throws the changes away.
  it.each([["gedit", "push button", "No", save, "linux"], ["gedit", "push button", "Nein", { name: "", text: "Änderungen am Dokument „notes.txt“ vor dem Schließen speichern?", alert: true }, "linux"],
    ["soffice", "push button", "No", { name: "", text: "Save changes to document “Untitled 1” before closing? Your changes will be lost if you don't save them.", alert: true }, "linux"],
    ["wordpad", "button", "No", { name: "WordPad", text: "Do you want to save changes to Document?", messageBox: true }, "win32"],
    ["TextEdit", "push button", "No", { name: "", text: "Do you want to keep this new document “Untitled”?" }, "darwin"]] as const)(
    "%s's %s “%s” in a dialog that asks to save asks every time, by a click and by Enter (safety-privacy-x8-7)", (app, role, name, dialog, os) => {
      for (const [grant, autonomy] of [[true, false], [true, true], [false, true]]) {
        const e = new PolicyEngine({ neverLook: () => [], grants: () => (grant ? { [app.toLowerCase()]: "act" } : {}), autonomy: () => (autonomy ? { ...ALL_SCOPES } : null),
          isTerminalApp: () => false, os, keys: KEYS[os] });
        for (const kind of ["click", "keys"] as const) {
          const d = e.decide(click(name, { app, window: "notes.txt", inPage: undefined, goal: "close the editor", dialog, element: { role, name }, kind, ...(kind === "keys" ? { value: "Return" } : {}) }));
          expect(d, `grant=${grant} autonomy=${autonomy} ${kind}`).toMatchObject({ verdict: "confirm", risky: true, remember: false });
          expect(d.autonomy).toBeUndefined();
        }
      }
    });

  it("“No” in a dialog that asks to discard or delete still backs off (safety-privacy-x8-7)", () => {
    for (const text of ["Discard changes to “notes.txt”?", "Are you sure you want to delete 3 files? Your changes may not be saved."]) {
      expect(engine().decide(click("No", { app: "gedit", window: "notes.txt", inPage: undefined, goal: "close the editor", dialog: { name: "", text, alert: true } })).verdict).toBe("allow");
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

  // What was written or typed in a working dialog isn't its question: a mail's body, a card's description, the text being found.
  const fields = [{ role: "entry", name: "To", editable: true }, { role: "entry", name: "Subject", editable: true }, { role: "section", name: "Message Body", editable: true },
    { role: "push button", name: "Attach files" },
    { role: "push button", name: "Formatting options" }, { role: "push button", name: "Bold" }, { role: "push button", name: "Send" }];
  const written: [string, string, ActionRequest["dialog"], Partial<ActionRequest>][] = [
    ...["Attach files", "Formatting options", "Bold"].flatMap((name): [string, string, ActionRequest["dialog"], Partial<ActionRequest>][] => [
      [name, "a mail's body asks", { name: "New Message", text: "To Subject Lunch Hi Ana, are you free on Friday?", alert: true, page: true }, {}],
      [name, "a mail's body says “do you want to”", { name: "New Message", text: "To Subject Lunch Hi Ana, do you want to meet on Friday", alert: true, page: true, controls: fields }, {}]]),
    ...["Checklist", "Members"].map((name): [string, string, ActionRequest["dialog"], Partial<ActionRequest>] =>
      [name, "a card's description asks", { name: "Plan the trip", text: "in list To do Description Where should we go this year? Activity", alert: true, page: true }, { window: "Plan the trip | Trello — Mozilla Firefox" }]),
    ["Find Next", "the text being found has a question mark", { name: "Find and Replace", text: "Find why?", controls: [{ role: "text", name: "", editable: true }, { role: "push button", name: "Find Next" },
      { role: "push button", name: "Close" }] }, { app: "soffice", window: "letter.odt - LibreOffice Writer", onPage: undefined }],
  ];

  it.each(written)("“%s” in a working dialog where %s goes without a question under “Always”, and is announced with Work without asking (safety-privacy-x8-2)", (name, _what, dialog, r) => {
    const step = click(name, { inPage: undefined, onPage: true, window: "Inbox - Mail — Mozilla Firefox", goal: "write to Ana and attach the agenda", dialog, ...r });
    expect(engine().decide(step).verdict).toBe("allow");
    expect(unGranted(true).decide(step)).toMatchObject({ verdict: "allow", autonomy: true });
  });

  it("a page's own dialog still asks when a whole read shows nothing to type in, or its title asks (safety-privacy-x8-2)", () => {
    const leaving = { name: "Unsaved changes", text: "Are you sure you want to leave? Your edits will be lost.", alert: true, page: true,
      controls: [{ role: "push button", name: "Leave" }, { role: "push button", name: "Stay" }] };
    asksEveryTime(click("Leave", { inPage: undefined, onPage: true, window: "Edit post - Blog — Mozilla Firefox", goal: "close the tab", dialog: leaving }));
    asksEveryTime(click("Leave", { inPage: undefined, onPage: true, window: "Edit post - Blog — Mozilla Firefox", goal: "close the tab",
      dialog: { name: "Leave without saving?", text: "Title Body", alert: true, page: true } }));
  });

  // A whole read of a question box lists its buttons, and may list a document or text it shows (Firefox's prompt is a
  // document): none of them is typed into, so its words still count.
  const shown = [{ role: "document frame", name: "" }, { role: "text", name: "" }, { role: "section", name: "" }];
  const buttons = (...names: string[]) => names.map(name => ({ role: "push button", name }));
  const resendText = "To display this page, Firefox must send information that will repeat any action (such as a search or order confirmation) that was performed earlier.";
  it.each([
    ["Resend", "win32", "firefox", { name: "", text: resendText, controls: buttons("Resend", "Cancel") }],
    ["Resend", "darwin", "Firefox", { name: "", text: resendText, controls: [...shown, ...buttons("Resend", "Cancel")] }],
    ["Resend", "linux", "Firefox", { name: "", text: resendText, alert: true, controls: [...shown, ...buttons("Resend", "Cancel")] }],
    ["Leave page", "win32", "firefox", { name: "", text: "This page is asking you to confirm that you want to leave — information you've entered may not be saved.",
      controls: [...shown, ...buttons("Leave page", "Stay on page")] }],
    ["No", "win32", "wordpad", { name: "WordPad", text: "Do you want to save changes to Document?", messageBox: true, controls: buttons("Yes", "No", "Cancel") }],
    ["No", "darwin", "TextEdit", { name: "", text: "Do you want to keep this new document “Untitled”?", controls: [...shown, ...buttons("Yes", "No")] }],
  ] as const)("“%s” on %s (%s) asks every time when a whole read lists the box's buttons and what it shows (safety-privacy-x8-2, x8-5, x8-7)", (name, os, app, dialog) => {
    for (const [grant, autonomy] of [[true, false], [false, true]]) {
      const e = new PolicyEngine({ neverLook: () => [], grants: () => (grant ? { [app.toLowerCase()]: "act" } : {}), autonomy: () => (autonomy ? { ...ALL_SCOPES } : null),
        isTerminalApp: () => false, os, keys: KEYS[os] });
      const d = e.decide(click(name, { app, window: "Mozilla Firefox", inPage: undefined, goal: "close the window", dialog: { ...dialog, controls: [...dialog.controls] } }));
      expect(d, `grant=${grant} autonomy=${autonomy}`).toMatchObject({ verdict: "confirm", risky: true, remember: false });
      expect(d.autonomy).toBeUndefined();
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
