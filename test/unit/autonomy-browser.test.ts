import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { KEYS } from "../../app/shared/shortcuts";

/**
 * "Work without asking" in a browser (owner report of 2026-11-05: "it's still asking me" with every switch on). Each step
 * here is as the audit log had it: Enter in Edge's address bar, which Edge reports as the page having the keyboard.
 */
const engine = (on: boolean) => new PolicyEngine({ neverLook: () => [], grants: () => ({ msedge: "act" }), autonomy: () => (on ? { ...ALL_SCOPES } : null), os: "win32", keys: KEYS.win32 });
const edge = (r: Partial<ActionRequest>): ActionRequest => ({ taskId: "t1", kind: "keys", app: "msedge", window: "New tab - Profile 1 - Microsoft Edge", goal: "go to youtube", ...r });
const unasked = (r: ActionRequest) => expect(engine(true).decide(r)).toMatchObject({ verdict: "allow", autonomy: true });
const asks = (r: ActionRequest) => expect(engine(true).decide(r).verdict).toBe("confirm");

describe("what goes unasked in a browser", () => {
  it("presses Enter after typing an address: the page's document has the focus, and it takes no typing", () => {
    unasked(edge({ value: "Return", inPage: true, notEditable: true, element: { role: "document web", name: "New tab" } }));
  });

  it("presses Enter in the address bar itself", () => {
    unasked(edge({ value: "Return", inPage: false, element: { role: "entry", name: "Address and search bar" } }));
  });

  it("presses Enter in a page's search box", () => {
    unasked(edge({ value: "Return", inPage: true, element: { role: "combo box", name: "Search" } }));
  });

  it.each([["linux", "firefox", "Search with Google or enter address"], ["linux", "google-chrome", "Address and search bar"], ["darwin", "Safari", "Address and search bar"]] as const)(
    "presses Enter in the address bar on %s (%s)", (os, app, name) => {
      const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ [app.toLowerCase()]: "act" }), autonomy: () => ({ ...ALL_SCOPES }), os, keys: KEYS[os] });
      expect(e.decide(edge({ app, window: "New Tab", value: "Return", inPage: false, element: { role: "entry", name } }))).toMatchObject({ verdict: "allow", autonomy: true });
    });

  it("replaces a long address in the address bar (146 characters, audit of 2026-11-03)", () => {
    unasked(edge({ kind: "text", mode: "replace", value: "https://www.youtube.com", currentText: "x".repeat(146), element: { role: "entry", name: "Address and search bar" } }));
  });

  it.each(["alt+Left", "alt+Right", "ctrl+r", "ctrl+shift+t", "ctrl+2"])("moves between pages and tabs with %s", value => {
    unasked(edge({ value, inPage: true, notEditable: true, element: { role: "document web", name: "YouTube" } }));
  });

  it("closes a tab the user's own words asked to close", () => {
    unasked(edge({ value: "ctrl+w", goal: "close this tab", inPage: true, notEditable: true, element: { role: "document web", name: "YouTube" } }));
  });

  it("follows a link whose title merely has a risky word in it", () => {
    expect(engine(true).decide(edge({ kind: "click", inPage: true, goal: "play a song on youtube", element: { role: "link", name: "Post Malone - Circles (Official Video)" } })).verdict).toBe("allow");
  });

  it("still asks all of these without “Work without asking”", () => {
    expect(engine(false).decide(edge({ value: "Return", inPage: false, element: { role: "entry", name: "Address and search bar" } })).verdict).toBe("confirm");
  });
});

describe("what goes unasked in the other browsers and in an app's own search box (regression review of round seven)", () => {
  const on = (os: "linux" | "win32" | "darwin", app: string) => new PolicyEngine({ neverLook: () => [], grants: () => ({ [app.toLowerCase()]: "act" }), autonomy: () => ({ ...ALL_SCOPES }), os, keys: KEYS[os] });

  it.each([["linux", "epiphany", "URL"], ["linux", "Web", "Address and search bar"], ["linux", "falkon", "Address"], ["linux", "konqueror", "Location"], ["linux", "midori", "Search or enter an address"],
    ["darwin", "Arc", "Address and search bar"], ["darwin", "Orion", "Address and search bar"], ["win32", "waterfox", "Search or enter address"], ["win32", "floorp", "Search or enter address"],
    ["win32", "thorium", "Address and search bar"], ["win32", "arc", "Address and search bar"]] as const)(
    "Enter in the address bar, and a long address replaced in it, on %s (%s) (safety-privacy-x7-3)", (os, app, name) => {
      expect(on(os, app).decide(edge({ app, window: "New Tab", value: "Return", inPage: false, element: { role: "entry", name } }))).toMatchObject({ verdict: "allow", autonomy: true });
      expect(on(os, app).decide(edge({ app, window: "New Tab", kind: "text", mode: "replace", value: "https://www.youtube.com", currentText: "x".repeat(146), element: { role: "entry", name } })))
        .toMatchObject({ verdict: "allow", autonomy: true });
    });

  it.each([["linux", "thunderbird", "Search", false], ["linux", "evolution", "Search", false], ["win32", "outlook", "Search", false], ["darwin", "Mail", "Search", false], ["win32", "slack", "Search", undefined]] as const)(
    "Enter in the app's own one-line search box on %s (%s, “%s”) (safety-privacy-x7-3)", (os, app, name, inPage) => {
      expect(on(os, app).decide(edge({ app, window: "Inbox", value: "Return", ...(inPage === undefined ? {} : { inPage }), element: { role: "entry", name } }))).toMatchObject({ verdict: "allow", autonomy: true });
    });

  it.each(["Search calls", "Search books"])("Enter in a page's search box named “%s” (safety-privacy-x7-3)", name => {
    unasked(edge({ value: "Return", inPage: true, element: { role: "entry", name } }));
  });

  it.each(["Search or call", "Search to call", "Search contacts to email", "Search or book", "Search email"])("Enter in a page's field named “%s” still asks (safety-privacy-y7-1)", name => {
    asks(edge({ value: "Return", inPage: true, element: { role: "entry", name } }));
  });

  it("a mail app's own “address” field, and a search box on a payment page or one that does more, still ask (safety-privacy-c7-1)", () => {
    for (const [os, app] of [["linux", "thunderbird"], ["linux", "evolution"], ["linux", "seamonkey"], ["darwin", "Mail"]] as const) {
      expect(on(os, app).decide(edge({ app, window: "Write: hello", value: "Return", inPage: false, element: { role: "entry", name: "To address" } })).verdict).toBe("confirm");
      expect(on(os, app).decide(edge({ app, window: "Checkout", value: "Return", inPage: false, element: { role: "entry", name: "Search" } })).verdict).toBe("confirm");
      expect(on(os, app).decide(edge({ app, window: "Inbox", value: "Return", inPage: false, element: { role: "entry", name: "Search and invite" } })).verdict).toBe("confirm");
    }
  });
});

describe("what still asks in a browser, whatever is on", () => {
  it("Enter in a chat box or a form's field: it may send", () => {
    asks(edge({ value: "Return", inPage: true, element: { role: "entry", name: "Message" } }));
    asks(edge({ value: "Return", inPage: true, multiLine: true, element: { role: "entry", name: "Write a comment" } }));
  });

  it("Enter in a multi-line box or a dialog's field, even one that says search", () => {
    asks(edge({ value: "Return", inPage: true, multiLine: true, element: { role: "entry", name: "Search" } }));
    asks(edge({ value: "Return", inPage: true, dialog: { name: "Sign in", text: "" }, element: { role: "entry", name: "Search" } }));
  });

  it.each([
    ["Email address", "Subscribe to our newsletter"], ["Your email address", "Forgot password"], ["Add people by email address", "Budget 2026 - Google Sheets"],
    ["Delivery address", "Order"], ["Wallet address", "Send Bitcoin"], ["Recipient address", "Transfer"], ["To address", "Webmail"], ["Webhook URL", "Settings"],
    ["Location", "Check in"], ["Address", "Contact us"], ["URL", "Submit a link"],
  ])("Enter in a page's form field named “%s” (%s): it submits the form (safety-privacy-c7-1)", (name, window) => {
    const d = engine(true).decide(edge({ value: "Return", inPage: true, window, element: { role: "entry", name } }));
    expect(d).toMatchObject({ verdict: "confirm" });
    expect(d.autonomy).toBeUndefined();
  });

  it.each([["Email address", "Checkout - Shop"], ["Billing address", "Payment"], ["Search", "Checkout - Shop"], ["Search coupons", "Billing - Example"]])(
    "Enter in “%s” on a payment page (%s), a search box included (safety-privacy-c7-1)", (name, window) => {
      asks(edge({ value: "Return", inPage: true, window, element: { role: "entry", name } }));
    });

  it.each(["Search people to share with", "Search and invite", "Search or send a message"])("Enter in a search box whose name says it does more: “%s” (safety-privacy-c7-1)", name => {
    asks(edge({ value: "Return", inPage: true, element: { role: "entry", name } }));
  });

  it.each([["Search or type a message", "Chat - Example"], ["Search people to add", "Members - Example"], ["Search for a recipient", "New transfer - Example"],
    ["Search", "Send money - PayPal"], ["Search", "Share with people - Example"]])(
    "Enter in “%s” on “%s”: it may send or pick someone, or its window is about something risky (safety-privacy-r8-3)", (name, window) => {
      asks(edge({ value: "Return", inPage: true, window, element: { role: "entry", name } }));
    });

  it.each(["Search", "Search mail", "Search or jump to…", "Search Acme"])("Enter in a page's search box named “%s” still goes unasked (safety-privacy-r8-3)", name => {
    unasked(edge({ value: "Return", inPage: true, window: "Inbox - Example", element: { role: "entry", name } }));
  });

  // A page's title is what it shows: a video's, a folder's, an issue's. Only one about sending money or sharing asks.
  it.each(["Post Malone - Circles (Official Video)", "Send Me On My Way - Rusted Root", "How to Remove Malware from Windows 11", "Delete Your Facebook Account in 2026",
    "How to Install Python on Windows", "Unboxing the new Pixel - should you buy it?"])(
    "Enter in YouTube's “Search” on a video titled “%s” goes unasked, as the owner asked (safety-privacy-x8-3)", title => {
      unasked(edge({ value: "Return", inPage: true, window: `${title} - YouTube - Profile 1 - Microsoft Edge`, element: { role: "combo box", name: "Search" } }));
    });

  it.each([["Search mail", "Trash - ana@example.com - Gmail - Profile 1 - Microsoft Edge"], ["Search or jump to…", "Delete old branches · Issue #12 · acme/app - Profile 1 - Microsoft Edge"],
    ["Search messages", "Inbox | Proton Mail - Profile 1 - Microsoft Edge"], ["Search chats", "Telegram Web - Profile 1 - Microsoft Edge"],
    ["Search add-ons", "Add-ons - Profile 1 - Microsoft Edge"], ["Search people", "People - Example - Profile 1 - Microsoft Edge"]])(
    "Enter in “%s” on “%s” searches and goes unasked (safety-privacy-x8-3)", (name, window) => {
      unasked(edge({ value: "Return", inPage: true, window, element: { role: "entry", name } }));
    });

  it.each([["Search or start a new chat", "Chats - Example"], ["Search and add people", "Members - Example"], ["Search", "Request money - PayPal"],
    ["Search", "Share “Budget” - Example"], ["Search", "Invite people - Example"]])(
    "Enter in “%s” on “%s” asks: it may send or pick someone, or its window is about sending money or sharing (safety-privacy-x8-3)", (name, window) => {
      asks(edge({ value: "Return", inPage: true, window, element: { role: "entry", name } }));
    });

  it("Enter in an “address” field of an app that isn't a browser, in a page or not (safety-privacy-c7-1)", () => {
    const mail = new PolicyEngine({ neverLook: () => [], grants: () => ({ thunderbird: "act", slack: "act" }), autonomy: () => ({ ...ALL_SCOPES }), os: "win32", keys: KEYS.win32 });
    expect(mail.decide(edge({ app: "thunderbird", window: "Write: hello", value: "Return", inPage: false, element: { role: "entry", name: "To address" } })).verdict).toBe("confirm");
    expect(mail.decide(edge({ app: "slack", window: "Slack", value: "Return", element: { role: "entry", name: "Email address" } })).verdict).toBe("confirm");
  });

  it("a long text replaced in a page's “address” field, or in a mail app's (safety-privacy-c7-1)", () => {
    asks(edge({ kind: "text", mode: "replace", value: "1 High Street", currentText: "x".repeat(146), inPage: true, element: { role: "entry", name: "Delivery address" } }));
    const mail = new PolicyEngine({ neverLook: () => [], grants: () => ({ thunderbird: "act" }), autonomy: () => ({ ...ALL_SCOPES }), os: "win32", keys: KEYS.win32 });
    expect(mail.decide(edge({ app: "thunderbird", window: "Write: hello", kind: "text", mode: "replace", value: "a@example.com", currentText: "x".repeat(146), element: { role: "entry", name: "To address" } })).verdict).toBe("confirm");
  });

  it("Enter on an editable document: a rich text composer", () => {
    asks(edge({ value: "Return", inPage: true, element: { role: "document web", name: "Compose" } }));
  });

  it("Ctrl+W when nobody asked to close anything", () => {
    asks(edge({ value: "ctrl+w", inPage: true, notEditable: true, element: { role: "document web", name: "YouTube" } }));
  });

  it("a browser key in an app that isn't a browser", () => {
    asks(edge({ app: "slack", window: "Slack", value: "ctrl+shift+t", inPage: true, notEditable: true, element: { role: "document web", name: "general" } }));
  });

  it("a shortcut Ember doesn't know", () => {
    asks(edge({ value: "ctrl+shift+y", inPage: true, notEditable: true, element: { role: "document web", name: "YouTube" } }));
  });

  it.each(["Delete my account", "Delete my account (permanently)", "Delete: my account", "Delete my account - Settings", "Delete Account - Settings", "Delete Repository - GitHub", "Please delete my account", "Buy now | Shop", "Post All - Blog", "Send Money - PayPal"])("a link that says what it does: “%s” (review of #180)", name => {
    asks(edge({ kind: "click", inPage: true, element: { role: "link", name } }));
  });

  it.each(["Post Malone - Circles (Official Video)", "How to install Node", "Why people share passwords"])("not a link that only names what it leads to: “%s”", name => {
    expect(engine(true).decide(edge({ kind: "click", inPage: true, goal: "play a song", element: { role: "link", name } })).verdict).toBe("allow");
  });

  it("a button that pays, whatever its label says (“Activate now”, audit of 2026-11-01)", () => {
    const d = engine(true).decide(edge({ kind: "click", inPage: true, window: "GitHub Copilot Pro Checkout", goal: "sign up for copilot", element: { role: "push button", name: "Activate now" } }));
    expect(d).toMatchObject({ verdict: "confirm", risky: true });
    expect(d.autonomy).toBeUndefined();
  });

  it.each(["Activate now", "Start free trial", "Start my subscription", "Upgrade now", "Complete purchase"])("“%s” anywhere", name => {
    const d = engine(true).decide(edge({ kind: "click", inPage: true, window: "Plans - Example", element: { role: "push button", name } }));
    expect(d).toMatchObject({ verdict: "confirm", risky: true });
  });

  it("any button on a payment page", () => {
    asks(edge({ kind: "click", inPage: true, window: "Billing - Example", element: { role: "push button", name: "Continue" } }));
    // As the worker says it for a click: `onPage`, from the tree (safety-privacy-c7-2).
    for (const kind of ["click", "cursor_click"] as const) asks(edge({ kind, onPage: true, window: "Billing - Example", element: { role: "push button", name: "Continue" } }));
  });
});
