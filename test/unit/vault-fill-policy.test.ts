/**
 * The vault's fill as the policy decides it (owner decision of 2026-11-12; PLAN.md §2 "Approvals", "The vault"; the
 * slice's decisions 4 and 5): its own kind of step, refused before any question or form wherever it may not be done.
 * Only Autopilot fills; every "never" stays never in every mode; a field binds to its page's origin or to its app, as
 * Ember reads them, and anything it can't read or tell is no fill.
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine, vaultTarget, type ActionRequest, type PolicyInputs, type VaultFill } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { VAULT_FILL, VAULT_WHATS, savedPart } from "../../app/shared/vault";

const engine = (o: Partial<PolicyInputs> = {}) => new PolicyEngine({
  neverLook: () => ["KeePassXC"], grants: () => ({}), autonomy: () => ({ ...ALL_SCOPES }), trustAskedApps: () => true,
  autopilot: () => true, vaultAllowed: () => true, isTerminalApp: n => /terminal|konsole|xterm/i.test(n), ...o,
});

const IN = { taskId: "t1", goal: "sign in to GitHub" };
const fill = (v: Partial<VaultFill> = {}): VaultFill => ({ kind: "login", part: "password", takesText: true, local: true, inPage: true, pages: ["https://github.com/login"], signIn: true, payment: true, ...v });
/** A password asked for in a site's sign-in page in Firefox. */
const SITE: ActionRequest = { ...IN, kind: "vault_fill", app: "firefox", window: "Sign in to GitHub — Mozilla Firefox", element: { role: "password text", name: "Password" }, vault: fill() };
/** A password asked for in an app's own sign-in window. */
const APP: ActionRequest = { ...IN, kind: "vault_fill", app: "Thunderbird", window: "Mail Server Password Required", element: { role: "password text", name: "" }, vault: fill({ inPage: false, pages: [] }) };

/** Every fill a task can ask for, each into a field it may go into. */
const EVERY: ActionRequest[] = VAULT_WHATS.map(what => {
  const [kind, part] = VAULT_FILL[what];
  const element = part === "password" ? { role: "password text", name: "Password" }
    : part === "cardNumber" ? { role: "entry", name: "Card number", secret: true }
      : part === "securityCode" ? { role: "entry", name: "Security code", secret: true }
        : { role: "entry", name: { user: "Username", cardName: "Name on card", expiry: "Expiry date", name: "Full name", email: "Email", phone: "Phone", address: "Street address" }[part as string] ?? "" };
  return { ...SITE, element, vault: fill({ kind, part }) };
});

describe("the vault's fill, as the policy decides it (vault-2)", () => {
  it("goes ahead in Autopilot without a question, announced by the kind of thing and the app alone", () => {
    for (const r of EVERY) {
      const d = engine().decide(r);
      expect([r.vault!.part, d.verdict]).toEqual([r.vault!.part, "allow"]);
      expect(d.autonomy).toBe(true);
      expect(d.mode).toBe("autopilot");
      expect(d.remember).toBe(false);
      expect(d.announce).toBe(`Filling ${savedPart(r.vault!.part)} in Firefox, from the vault: Autopilot is on.`);
      // Nothing from the screen is in what is said or recorded: not the field's name, the window's title or the address.
      for (const words of [d.announce!, d.reason]) expect(words).not.toMatch(/GitHub|github|Password|Username|Card number|Street/);
    }
    expect(engine().decide(SITE).announce).toBe("Filling a saved password in Firefox, from the vault: Autopilot is on.");
    expect(engine().decide(APP).verdict).toBe("allow");
  });

  it("is refused in every mode but Autopilot, for every part and every field (a hard check: no other mode ever fills)", () => {
    const others: Record<string, Partial<PolicyInputs>> = {
      "below Interactive": { autopilot: () => false, autonomy: () => null },
      "Interactive": { autopilot: () => false },
      "Assisted": { autopilot: () => false, assisted: () => true },
      "no mode said": { autopilot: undefined },
      "Autopilot where the organisation confirms every action": { confirmEveryAction: () => true },
      "Autopilot where the organisation turned acting off": { actionsAllowed: () => false },
      "Autopilot where the organisation turned the vault off": { vaultAllowed: () => false },
      "Autopilot with nothing said about the vault": { vaultAllowed: undefined },
    };
    for (const [mode, o] of Object.entries(others)) {
      const p = engine(o);
      for (const r of [...EVERY, APP]) {
        for (const d of [p.decide(r), p.recheck(r), p.autopilotStep(r, p.decide(r))]) {
          expect([mode, r.vault!.part, d.verdict, d.tier]).toEqual([mode, r.vault!.part, "deny", "never"]);
          expect(d.announce).toBeUndefined();
        }
      }
    }
  });

  it("keeps every \"never\" a never in Autopilot, decided before anything about the vault", () => {
    const nevers: Record<string, [ActionRequest, RegExp]> = {
      "polkit's prompt": [{ ...APP, app: "polkit-gnome-authentication-agent-1", window: "Authentication Required" }, /authentication and security windows/],
      "the keyring's prompt": [{ ...APP, app: "gcr-prompter", window: "Unlock Login Keyring" }, /authentication and security windows/],
      "pinentry": [{ ...APP, app: "pinentry-gnome3", window: "pinentry" }, /authentication and security windows/],
      "ssh-askpass": [{ ...APP, app: "ssh-askpass", window: "OpenSSH Authentication Passphrase request" }, /authentication and security windows/],
      "Ember's own window": [{ ...APP, app: "ember", window: "Ember" }, /Ember's own windows/],
      "a never-look window": [{ ...APP, app: "keepassxc", window: "Passwords - KeePassXC" }, /never-look/],
      "the user's terminal": [{ ...APP, app: "gnome-terminal-server", window: "Terminal" }, /terminal/],
      "a terminal's own text": [{ ...APP, app: "code", window: "x", element: { role: "terminal", name: "" } }, /terminal/],
    };
    for (const [name, [r, why]] of Object.entries(nevers)) {
      const d = engine().decide(r);
      expect([name, d.verdict, d.tier]).toEqual([name, "deny", "never"]);
      expect(d.reason).toMatch(why);
    }
    // Windows' and macOS's credential prompts, by their own vocabulary.
    expect(engine({ os: "win32" }).decide({ ...APP, app: "CredentialUIBroker", window: "Windows Security" }).verdict).toBe("deny");
    expect(engine({ os: "darwin" }).decide({ ...APP, app: "SecurityAgent", window: "" }).verdict).toBe("deny");
  });

  it("leaves ordinary typing into a password or secret field refused in Autopilot, as before", () => {
    const p = engine();
    expect(p.decide({ ...IN, kind: "text", app: "firefox", window: "w", value: "hunter2", element: { role: "password text", name: "Password" } }).verdict).toBe("deny");
    expect(p.decide({ ...IN, kind: "cursor_text", app: "firefox", window: "w", value: "4111", element: { role: "entry", name: "Card number", secret: true } }).verdict).toBe("deny");
    expect(p.decide({ ...IN, kind: "keys", app: "firefox", window: "w", value: "a", element: { role: "password text", name: "Password" } }).verdict).toBe("deny");
  });

  it("fills only on this computer's own screen: not on Ember's desk, in WSL or over SSH", () => {
    expect(engine().decide({ ...SITE, onDesk: true }).verdict).toBe("deny");
    expect(engine().decide({ ...SITE, vault: fill({ local: false }) }).verdict).toBe("deny");
  });

  it("puts a secret only into a secret field, and nothing else into a password field", () => {
    const p = engine();
    // A password into a search box, a chat's field or a document: never.
    for (const element of [{ role: "entry", name: "Search" }, { role: "entry", name: "Message" }, { role: "text", name: "" }]) {
      expect(p.decide({ ...SITE, element }).verdict).toBe("deny");
      expect(p.decide({ ...SITE, element, vault: fill({ kind: "card", part: "cardNumber" }) }).verdict).toBe("deny");
    }
    // A password into a field that is secret only by its label or by what Ember knows of it (it shows what is typed): never.
    expect(p.decide({ ...SITE, element: { role: "entry", name: "Password" } }).verdict).toBe("deny");
    expect(p.decide({ ...SITE, element: { role: "entry", name: "Email", secret: true } }).verdict).toBe("deny");
    // A card's number into one that is: yes.
    expect(p.decide({ ...SITE, element: { role: "entry", name: "Card number" }, vault: fill({ kind: "card", part: "cardNumber" }) }).verdict).toBe("allow");
    // A user name, a card's name or an email into a password field: never.
    for (const [kind, part] of [["login", "user"], ["card", "cardName"], ["card", "expiry"], ["contact", "email"]] as const) {
      expect(p.decide({ ...SITE, vault: fill({ kind, part }) }).verdict).toBe("deny");
    }
    // What isn't a field that takes text: never.
    expect(p.decide({ ...SITE, vault: fill({ takesText: false }) }).verdict).toBe("deny");
    expect(p.decide({ ...SITE, element: undefined }).verdict).toBe("deny");
    expect(p.decide({ ...SITE, vault: undefined }).verdict).toBe("deny");
  });

  it("fills a user name only in a sign-in window, a card's other parts only beside its secret fields, contact details only into a field named for them", () => {
    const p = engine();
    const user: ActionRequest = { ...SITE, element: { role: "entry", name: "Username or email address" }, vault: fill({ part: "user" }) };
    expect(p.decide(user).verdict).toBe("allow");
    expect(p.decide({ ...user, vault: fill({ part: "user", signIn: false }) }).verdict).toBe("deny");
    const holder: ActionRequest = { ...SITE, element: { role: "entry", name: "Billing name" }, vault: fill({ kind: "card", part: "cardName", signIn: false }) };
    expect(p.decide(holder).verdict).toBe("allow");
    expect(p.decide({ ...holder, vault: fill({ kind: "card", part: "cardName", signIn: false, payment: false }) }).verdict).toBe("deny");
    const contact = (part: "name" | "email" | "phone" | "address", name: string, o: Partial<VaultFill> = {}): ActionRequest =>
      ({ ...SITE, element: { role: "entry", name }, vault: fill({ kind: "contact", part, signIn: false, payment: false, ...o }) });
    expect(p.decide(contact("email", "Email")).verdict).toBe("allow");
    expect(p.decide(contact("email", "E-mail address")).verdict).toBe("allow");
    expect(p.decide(contact("phone", "Mobile phone")).verdict).toBe("allow");
    expect(p.decide(contact("address", "Street address")).verdict).toBe("allow");
    expect(p.decide(contact("name", "Full name")).verdict).toBe("allow");
    // A field that doesn't say it is for that detail, or says nothing: no fill.
    for (const r of [contact("email", "Comment"), contact("email", ""), contact("address", "Email address"), contact("address", "Web address"),
      contact("name", "Username"), contact("name", "User name"), contact("name", "Card name"), contact("phone", "Search")]) {
      expect([r.element!.name, p.decide(r).verdict]).toEqual([r.element!.name, "deny"]);
    }
    // Nor a field whose name the reader withheld, or one that is secret.
    expect(p.decide({ ...contact("email", "Email"), element: { role: "entry", name: "Email", withheld: true } }).verdict).toBe("deny");
    expect(p.decide({ ...contact("email", "Email"), element: { role: "entry", name: "Email", secret: true } }).verdict).toBe("deny");
  });

  it("is paced by the limit on actions a minute like any step, and a refused fill counts for nothing", () => {
    const p = engine({ rateLimit: 2, now: () => 1000 });
    for (let i = 0; i < 5; i++) expect(p.decide({ ...SITE, onDesk: true }).verdict).toBe("deny");
    expect(p.decide(SITE).verdict).toBe("allow");
    expect(p.decide(SITE).verdict).toBe("allow");
    const third = p.decide(SITE);
    expect([third.verdict, third.paced]).toEqual(["deny", true]);
  });
});

describe("what a field belongs to (vaultTarget, vault-2)", () => {
  const at = (pages: string[] | null, o: Partial<VaultFill> = {}, app = "firefox") => vaultTarget({ app, vault: fill({ pages, ...o }) });

  it("binds a page's field to the page's origin: scheme, host and port, whatever the browser", () => {
    expect(at(["https://github.com/login?return_to=%2F"])).toEqual({ dest: { site: "https://github.com" } });
    expect(at(["https://github.com/login"], {}, "google-chrome")).toEqual({ dest: { site: "https://github.com" } });
    expect(at(["http://intranet:8080/x"])).toEqual({ dest: { site: "http://intranet:8080" } });
    // A frame of the same site as the page around it.
    expect(at(["https://github.com/session", "https://github.com/login"])).toEqual({ dest: { site: "https://github.com" } });
    // A web view in an app that is no browser: still the page's own origin, never the app.
    expect(at(["https://login.example.com/"], {}, "slack")).toEqual({ dest: { site: "https://login.example.com" } });
  });

  it("never takes a look-alike host, another port or another scheme for the site", () => {
    const real = "https://github.com";
    for (const page of ["https://github.com.evil.example/login", "https://githubcom.example/login", "https://xn--gthub-cta.com/login", "https://gíthub.com/login",
      "https://github.com:8443/login", "http://github.com/login", "https://login.github.com/", "https://github.com@evil.example/login", "https://GITHUB.COM.evil.example/"]) {
      const t = at([page]);
      expect("dest" in t && "site" in t.dest ? t.dest.site : null).not.toBe(real);
    }
  });

  it("gives no answer where the page's address can't be read or is no web address", () => {
    for (const t of [at(null), at([], { inPage: true }), at([""]), at(["about:blank"]), at(["file:///home/u/login.html"]), at(["data:text/html,<input type=password>"]),
      at(["mailbox:///home/u/Mail/Inbox?number=1"]), at(["chrome://settings/passwords"]), at(["javascript:alert(1)"]), at(["https://user:pw@github.com/"]), at(["not an address"])]) {
      expect("dest" in t).toBe(false);
    }
  });

  it("gives no answer for a frame from another site than the page around it, or one whose address can't be read", () => {
    expect("dest" in at(["https://pay.example/frame", "https://shop.example/checkout"])).toBe(false);
    expect("dest" in at(["https://github.com/login", "https://evil.example/wrapper"])).toBe(false);
    expect("dest" in at(["about:srcdoc", "https://github.com/login"])).toBe(false);
    expect("dest" in at(["https://github.com/login", ""])).toBe(false);
  });

  it("binds a field outside any page to its app, by the program's folded name, and never to a browser", () => {
    expect(at([], { inPage: false }, "Thunderbird")).toEqual({ dest: { app: "thunderbird" } });
    expect(at([], { inPage: false }, "thunderbird.exe")).toEqual({ dest: { app: "thunderbird" } });
    for (const browser of ["firefox", "Google-chrome", "chromium-browser", "msedge", "Safari", "brave-browser", "epiphany", "Web"]) {
      expect([browser, "dest" in at([], { inPage: false }, browser)]).toEqual([browser, false]);
    }
    expect("dest" in at([], { inPage: false }, "")).toBe(false);
    expect("dest" in at([], { inPage: false }, "/usr/bin/x")).toBe(false);
  });

  it("refuses the fill, in Ember's own words, wherever no destination can be told", () => {
    const p = engine();
    const cases: Partial<VaultFill>[] = [{ pages: null }, { pages: [] }, { pages: ["about:blank"] }, { pages: ["https://a.example/", "https://b.example/"] }];
    for (const v of cases) {
      const d = p.decide({ ...SITE, vault: fill(v) });
      expect([d.verdict, d.tier]).toEqual(["deny", "never"]);
      expect(d.reason).not.toMatch(/example|about:/);
    }
    expect(p.decide({ ...APP, app: "firefox", window: "Firefox" }).verdict).toBe("deny");
  });
});
