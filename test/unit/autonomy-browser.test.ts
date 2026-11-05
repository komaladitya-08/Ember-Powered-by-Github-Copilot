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

describe("what still asks in a browser, whatever is on", () => {
  it("Enter in a chat box or a form's field: it may send", () => {
    asks(edge({ value: "Return", inPage: true, element: { role: "entry", name: "Message" } }));
    asks(edge({ value: "Return", inPage: true, multiLine: true, element: { role: "entry", name: "Write a comment" } }));
  });

  it("Enter in a multi-line box or a dialog's field, even one that says search", () => {
    asks(edge({ value: "Return", inPage: true, multiLine: true, element: { role: "entry", name: "Search" } }));
    asks(edge({ value: "Return", inPage: true, dialog: { name: "Sign in", text: "" }, element: { role: "entry", name: "Search" } }));
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
  });
});
