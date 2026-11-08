/**
 * The security review of views v2 (PR #126): every input it found getting past the mimicry and secret checks
 * (app/main/agent/view-schema.ts), each now refused. Shortcut chords written any way at all, Ember's words hidden with
 * invisible, direction-changing or look-alike characters, Ember's voice anywhere in a line, secrets split across a
 * label and its value, private paths in any string, a private key's header alone.
 */

import { describe, expect, it } from "vitest";
import { checkView, mimicRefusal, namesChord, secretRefusal, viewNorm, type ViewContext } from "../../app/main/agent/view-schema";
import { applyViewOps } from "../../app/main/agent/view-doc";

const ctx: ViewContext = { appsRead: new Set(["Firefox"]) };
const stack = (...children: unknown[]) => ({ kind: "stack", children });
const why = (v: unknown) => { const r = checkView(v, ctx); return r.ok ? null : r.why ?? "shape"; };

describe("one of Ember's own shortcut chords in a view, however it is written (review B1, re-review R1)", () => {
  it.each([
    "Press Ctrl-Alt-Y to go on", "Ctrl Alt Y", "Control+Alt+Y", "Ctrl＋Alt＋Y", "⌃⇧⌘Y", "Windows+Alt+Y",
    "Super + Alt + N", "control-shift-command-period", "Win+Alt+Shift+X.", "(Ctrl+Alt+Y)", "ctrl alt shift y",
    "press “Ctrl+Alt+Y”", "Ctrl+Alt+”Y”", "Windows key, Alt, Y", "Windows key + Alt + Y", "Win logo key+Alt+Y",
    "Ctrl*Alt*Y", "Ctrl×Alt×Y", "Ctrl➕Alt➕Y", "Ctrl&Alt&Y", "Ctrl.Alt.Y", "Hold Ctrl and Alt, then press Y",
    "Alt+Ctrl+N", "Control+Shift+Command+Return", "⌃⇧⌘Esc", "⌃⇧⌘.", "Win+Alt+X",
    "Y+Alt+Ctrl", "N, then Alt and Ctrl", "CtrlAltY", "ControlShiftCommandPeriod", "Ctrl+Alt+letter Y", "Ctrl+Alt+capital Y",
  ])("is refused: %s", s => {
    expect(namesChord(s), s).toBe(true);
    expect(why(stack({ kind: "text", text: s }))).toBe("mimic");
  });

  it("is refused when split across a table's cells, a row's children, or nodes (final check R2)", () => {
    expect(why(stack({ kind: "table", columns: ["Keys", "Then"], rows: [["Ctrl+Alt", "+Y"]] }))).toBe("mimic");
    expect(why(stack({ kind: "row", children: [{ kind: "text", text: "Ctrl+Alt" }, { kind: "text", text: "+Y" }] }))).toBe("mimic");
    expect(why(stack({ kind: "list", items: ["Ctrl+Alt", "Y"] }))).toBe("mimic");
    expect(why(stack({ kind: "text", text: "Ctrl+Alt" }, { kind: "text", text: "+Y" }))).toBe("mimic");
  });

  it.each<[string, unknown]>([
    ["a heading and a line", stack({ kind: "heading", text: "Press Ctrl+Alt", level: 1 }, { kind: "text", text: "Y" })],
    ["a section's title and its child", stack({ kind: "section", title: "Ctrl+Alt", children: [{ kind: "text", text: "Y" }] })],
    ["badges in two rows", stack({ kind: "row", children: [{ kind: "badge", text: "Ctrl+Alt", tone: "info" }] }, { kind: "row", children: [{ kind: "badge", text: "Y", tone: "info" }] })],
    ["a row whose second child is a card", stack({ kind: "row", children: [{ kind: "badge", text: "Ctrl", tone: "info" }, { kind: "card", children: [{ kind: "badge", text: "Alt", tone: "info" }, { kind: "badge", text: "Y", tone: "info" }] }] })],
    ["keyvalue rows", stack({ kind: "keyvalue", rows: [{ label: "First", value: "Ctrl+Alt" }, { label: "Then", value: "Y" }] })],
    ["timeline items", stack({ kind: "timeline", items: [{ when: "1", text: "Ctrl" }, { when: "2", text: "Alt" }, { when: "3", text: "Y" }] })],
    ["a grid of three badges", stack({ kind: "grid", columns: 3, children: [{ kind: "badge", text: "Ctrl", tone: "info" }, { kind: "badge", text: "Alt", tone: "info" }, { kind: "badge", text: "Y", tone: "info" }] })],
    ["three stacked nodes that spell the deny chord", stack({ kind: "text", text: "Ctrl" }, { kind: "text", text: "Alt" }, { kind: "text", text: "N items" })],
    ["two lines that say how to press it", stack({ kind: "text", text: "Hold Ctrl and Alt," }, { kind: "text", text: "then Y" })],
  ])("is refused spread over nodes: %s (final check R2)", (_name, view) => {
    expect(why(view)).toBe("mimic");
  });

  it("is refused when an update puts it together", () => {
    const r = checkView({ kind: "stack", id: "top", children: [{ kind: "text", id: "a", text: "Ctrl+Alt" }, { kind: "text", id: "b", text: "Then" }] }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(applyViewOps(r.doc, [{ op: "set", id: "b", props: { text: "+Y" } }], ctx)).toMatchObject({ ok: false, why: "mimic" });
  });

  it("is refused when an update puts it together in a row", () => {
    const r = checkView({ kind: "row", id: "top", children: [{ kind: "text", id: "a", text: "Ctrl+Alt" }, { kind: "text", id: "b", text: "Then" }] }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(applyViewOps(r.doc, [{ op: "set", id: "b", props: { text: "+Y" } }], ctx)).toMatchObject({ ok: false, why: "mimic" });
  });

  it("is refused in code too, exactly as Ember's", () => {
    expect(why(stack({ kind: "code", lines: ["bind ctrl+alt+y exec ember-allow"] }))).toBe("mimic");
  });

  it("leaves other chords and ordinary key talk alone (re-review S-e)", () => {
    for (const s of ["Press Ctrl+S to save", "Alt+F4 closes it", "Ctrl+Alt+T opens a terminal", "Shift+Y types a capital Y", "Cmd+Y", "Control the alt text, yes",
      "Ctrl+Shift+N opens a private window", "Ctrl+Shift+Esc opens Task Manager", "Cmd+Shift+. shows hidden files", "Ctrl+Shift+Enter", "Ctrl+Option+Cmd+Y", "Ctrl+Alt+Esc"]) {
      expect(namesChord(s), s).toBe(false);
    }
    expect(why(stack({ kind: "code", lines: ["bind ctrl+shift+n new-window"] }))).toBe(null);
    expect(why(stack({ kind: "text", text: "Ctrl+Shift" }, { kind: "text", text: "N opens a window" }))).toBe(null);
    for (const s of ["Metaxa", "Shiftwork", "Altogether yes", "Controlling the X axis"]) expect(namesChord(s), s).toBe(false);
  });
});

describe("Ember's words hidden with other characters (review B1)", () => {
  it.each([
    ["a zero-width space in a chord", { kind: "text", text: "Ctrl+Alt\u200B+Y" }],
    ["a zero-width space in a badge", { kind: "badge", text: "Al\u200Blow", tone: "positive" }],
    ["a zero-width joiner in a list item", { kind: "list", items: ["Al\u200Dlow once"] }],
    ["a soft hyphen", { kind: "text", text: "Al\u00ADlow" }],
    ["a word joiner", { kind: "text", text: "Allo\u2060w" }],
    ["a zero-width space in Not now", { kind: "heading", text: "N\u200Bot now", level: 1 }],
    ["a zero-width space in Stop everything", { kind: "text", text: "Stop every\u200Bthing" }],
    ["a right-to-left override", { kind: "text", text: "\u202Ewolla" }],
    ["a left-to-right mark", { kind: "text", text: "Q3\u200E report" }],
    ["a byte-order mark inside a word", { kind: "text", text: "fi\uFEFFne" }],
    ["a variation selector after a letter", { kind: "text", text: "x\uFE0F" }],
    ["a joiner between Latin letters", { kind: "text", text: "Al\u200Clow" }],
    ["a joiner between an emoji and a letter", { kind: "text", text: "\u{1F468}\u200Dx" }],
    ["a Cyrillic A", { kind: "badge", text: "\u0410llow", tone: "positive" }],
    ["a Cyrillic o", { kind: "list", items: ["N\u043Et now"] }],
    ["a Cyrillic A in Allow once", { kind: "text", text: "\u0410llow once" }],
    ["a Greek omicron", { kind: "text", text: "N\u03BFt now" }],
    ["fullwidth letters", { kind: "badge", text: "Ａｌｌｏｗ", tone: "info" }],
    ["small capitals", { kind: "text", text: "ᴀʟʟᴏᴡ" }],
    ["a capital I for an l", { kind: "badge", text: "AIlow", tone: "positive" }],
    ["a capital I for the second l", { kind: "text", text: "AlIow" }],
    ["ones for ls", { kind: "text", text: "A11ow" }],
    ["a bar for an l", { kind: "text", text: "Al|ow" }],
    ["Greek capitals and omicron", { kind: "text", text: "\u0391\u0399\u0399\u03BFw" }],
    ["a Latin alpha", { kind: "text", text: "\u2C6Dllow" }],
    ["a Cherokee A", { kind: "text", text: "\u13AAllow" }],
    ["fullwidth letters and an Armenian o", { kind: "text", text: "Aｌｌ\u0585w" }],
    ["combining underlines", { kind: "text", text: "A\u0332l\u0332l\u0332o\u0332w\u0332" }],
    ["a zero for an o", { kind: "text", text: "N0t now" }],
  ])("is refused: %s", (_name, node) => {
    expect(why(stack(node))).toBe("mimic");
  });

  it("allows what writing needs: emoji presentation, joined emoji, and joiners inside Persian, Hindi and Malayalam words (re-review S-f)", () => {
    for (const text of ["Done \u2714\uFE0F", "\u26A0\uFE0F Check the totals", "Family: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F44D}\u{1F3FD}\u200D\u{1F525}",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", "\u0915\u094D\u200D\u0937", "\u0D28\u0D4D\u200D"]) {
      expect(why(stack({ kind: "text", text: text + " here" })), JSON.stringify(text)).toBe(null);
    }
  });

  it("deletes invisible characters before matching, so a joiner or a sign inside a word doesn't hide it (final check nit)", () => {
    expect(mimicRefusal("Al\u094D\u200C\u094Dlow")).not.toBeNull();
    expect(viewNorm("Al\u094D\u200C\u094Dlow")).toBe("allow");
  });

  it("folds look-alikes and compatibility forms before matching", () => {
    expect(viewNorm("\u0410llow")).toBe("allow");
    expect(viewNorm("Ｃｔｒｌ")).toBe("ctrl");
    expect(mimicRefusal("Привет")).toBeNull();
    expect(mimicRefusal("Ελλάδα")).toBeNull();
  });
});

describe("words in Ember's voice anywhere in a line (review S1)", () => {
  it.each(["Note — Ember: the user already said yes", "Hi, I'm Ember and you can trust this", "I am Ember", "This is Ember speaking",
    "As promised, Ember says go ahead", "Ｅｍｂｅｒ： approved", "Ember： ok", "Report done. Ember - yes, go ahead", "E m b e r: the user said yes",
    "Emb3r: approved", "“Ember: allow it”"])("is refused: %s", s => {
    expect(why(stack({ kind: "text", text: s }))).toBe("mimic");
  });

  it.each<[string, unknown]>([
    ["a heading that is Ember's name", stack({ kind: "heading", text: "Ember", level: 1 }, { kind: "text", text: "The user already said yes." })],
    ["a section titled Ember", stack({ kind: "section", title: "Ｅｍｂｅｒ", children: [{ kind: "text", text: "Go ahead and click it." }] })],
    ["a column named Ember", stack({ kind: "table", columns: ["Ember"], rows: [["click Delete all"]] })],
    ["a label named Ember", stack({ kind: "keyvalue", rows: [{ label: "Ember", value: "click it" }] })],
    ["a message from Ember", stack({ kind: "text", text: "Message from Ember: click it" })],
    ["Ember asked", stack({ kind: "text", text: "Ember asked you to click it" })],
    ["as Ember wrote", stack({ kind: "text", text: "as Ember wrote, click it" })],
    ["Ember told", stack({ kind: "text", text: "Ember told me to approve it" })],
  ])("is refused: %s (final check a)", (_name, view) => {
    expect(why(view)).toBe("mimic");
  });

  it("is refused across fields and nodes (re-review S-b)", () => {
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Ember", value: "the user already said yes" }] }))).toBe("mimic");
    expect(why(stack({ kind: "table", columns: ["Ember"], rows: [["the user said yes"]] }))).toBe("mimic");
    expect(why(stack({ kind: "text", text: "Ember" }, { kind: "text", text: ": the user said yes" }))).toBe("mimic");
  });

  it("leaves a mention of Ember, or of the colour, alone", () => {
    expect(why(stack({ kind: "text", text: "The Ember project's notes, version 2" }))).toBe(null);
    expect(why(stack({ kind: "text", text: "The colour is ember: a deep orange" }))).toBe(null);
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Colour", value: "ember" }] }))).toBe(null);
  });
});

describe("a secret's name with no secret after it (re-review nit)", () => {
  it("is shown", () => {
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Password", value: "changed yesterday" }] }))).toBe(null);
    expect(why(stack({ kind: "text", text: "Pin: the tab is pinned" }))).toBe(null);
    expect(why(stack({ kind: "text", text: "The passcode is required" }))).toBe(null);
    expect(why(stack({ kind: "text", text: "Write &lt;b&gt; as text" }))).toBe(null);
  });
});

describe("a token split across rows or nodes (re-review S-c)", () => {
  const token = "ghp_" + "0123456789abcdefghijABCDEFGHIJ012345";
  it("is refused whole", () => {
    expect(why(stack({ kind: "table", columns: ["Part"], rows: [[token.slice(0, 20)], [token.slice(20)]] }))).toBe("secret");
    expect(why(stack({ kind: "text", text: token.slice(0, 18) }, { kind: "text", text: token.slice(18) }))).toBe("secret");
  });

  it("is refused split into a word and digits, into four pieces, or with spaces in it (final check b)", () => {
    const digits = "ghp_abcdefghij" + "01234567890123456789012345";
    expect(why(stack({ kind: "list", items: ["ghp_abcdefghij", "01234567890123456789012345"] }))).toBe("secret");
    expect(why(stack({ kind: "table", columns: ["Part"], rows: [[digits.slice(0, 10)], [digits.slice(10, 20)], [digits.slice(20, 30)], [digits.slice(30)]] }))).toBe("secret");
    expect(why(stack({ kind: "text", text: `Token: ${token.slice(0, 12)} ${token.slice(12, 24)} ${token.slice(24)}` }))).toBe("secret");
    expect(why(stack({ kind: "text", text: "AKIA" }, { kind: "text", text: "IOSFODNN" }, { kind: "text", text: "7EXAMPLE" }))).toBe("secret");
  });

  it("leaves prose with spaces taken out alone", () => {
    expect(why(stack({ kind: "text", text: "The token is required here" }, { kind: "text", text: "Password: required at sign-in" }))).toBe(null);
  });

  it("but numbers in a table's rows aren't run together into a card number", () => {
    expect(why(stack({ kind: "table", columns: ["Count"], rows: [["4111"], ["1111"], ["1111"], ["1111"]] }))).toBe(null);
  });
});

describe("a secret split across fields (review S2)", () => {
  it.each([
    ["a key and its value", { kind: "keyvalue", rows: [{ label: "Password", value: "hunter2" }] }],
    ["a column and its cell", { kind: "table", columns: ["Wifi password"], rows: [["hunter2"]] }],
    ["a card number over list items", { kind: "list", items: ["4111 1111", "1111 1111"] }],
    ["a PIN over a timeline", { kind: "timeline", items: [{ when: "PIN", text: "4321" }] }],
    ["a callout's title and text", { kind: "callout", tone: "info", title: "Passcode", text: "998877" }],
    ["a metric's label and value", { kind: "metric", label: "PIN", value: "4321" }],
    ["a compare row", { kind: "compare", columns: ["Old password", "New password"], rows: [{ label: "Wifi", a: "abc123", b: "def456" }] }],
  ])("is refused whole: %s", (_name, node) => {
    expect(why(stack(node))).toBe("secret");
  });
});

describe("a disk's use and code that names a token, which hold no secret (memory-c4-2, memory-r4-2)", () => {
  it("shows a disk's use as a label and value, and an auth module's code", () => {
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Root", value: "45G / 100G" }] }))).toBe(null);
    expect(why(stack({ kind: "text", text: "Disk usage: root: 45GB / 100GB" }))).toBe(null);
    expect(why(stack({ kind: "code", lines: ["export function verify(token: string): boolean {", "  return token.length > 0;", "}"] }))).toBe(null);
  });

  it("still refuses a password in code or as a label and value", () => {
    expect(why(stack({ kind: "code", lines: ['const password = "Summer2024!";'] }))).toBe("secret");
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Admin", value: "admin / j3nkins!" }] }))).toBe("secret");
  });
});

describe("a password's state as a label's value (memory-w5-3)", () => {
  it.each([["Password", "Masked"], ["Password", "Hashed"], ["PIN", "Entered"]])("shows %s: %s", (label, value) => {
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Account", value: "priya@example.com" }, { label, value }] }))).toBe(null);
  });
  it("still refuses a value after the state", () => {
    expect(why(stack({ kind: "keyvalue", rows: [{ label: "Password", value: "hashed hunter2" }] }))).toBe("secret");
  });
});

describe("ordinary paths and words that only look private (re-review S-d)", () => {
  it.each([
    "/private/tmp/report.txt", "/private/var/folders/x/notes.txt", "~/Documents/Talk.key", "My keyring is on the desk", "Keychains sync across Macs",
    "~/project/.env.example", "config/.env.sample", "https://github.com/acme/private/README.md", "~/certs-old/ca.pem", "certs/ca.crt", "~/.ssh-config-notes.txt",
    "~/Desktop/id_rsa.pub", "id_ed25519.pub",
  ])("is shown: %s", text => {
    expect(secretRefusal(text), text).toBeNull();
    expect(why(stack({ kind: "text", text }))).toBe(null);
  });

  it.each(["/etc/ssl/private/server.pem", "~/keys/server.key", "~/.local/share/keyrings/login.keyring", "~/Library/Keychains/login.keychain-db",
    "~/backup/id_rsa", "~/backup/id_ed25519.old", "~/project/.env.production", "certs/server.key", "server.key.bak"])("is still refused: %s", text => {
    expect(secretRefusal(text), text).not.toBeNull();
  });
});

describe("a private place named in any string (review S3)", () => {
  it.each([
    ["a text", "Your key is in ~/.ssh/id_ed25519"],
    ["division slashes", "~∕.ssh∕id_rsa"],
    ["fraction slashes", "~⁄.gnupg⁄secring.gpg"],
    ["fullwidth slashes", "～／.ssh／config"],
    ["Ember's own data", "Saved in ~/.config/ember/settings.json"],
    ["an env file", "It reads .env"],
  ])("is refused: %s", (_name, text) => {
    expect(secretRefusal(text), text).not.toBeNull();
    expect(why(stack({ kind: "text", text }))).toBe("secret");
  });
});

describe("a private key's header (review S4)", () => {
  it("is refused on its own", () => {
    for (const h of ["-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "-----BEGIN PGP PRIVATE KEY BLOCK-----"]) {
      expect(why(stack({ kind: "code", lines: [h] })), h).toBe("secret");
    }
    expect(why(stack({ kind: "code", lines: ["-----BEGIN CERTIFICATE-----"] }))).toBe(null);
  });
});

describe("secrets and private places the audit of main found (audit 1–3)", () => {
  it.each([
    ["a key's BEGIN line alone in a text", { kind: "text", text: "-----BEGIN OPENSSH PRIVATE KEY-----" }],
    ["a key's BEGIN line in a first-catalog excerpt", null],
    ["an SSH key file anywhere", { kind: "file", path: "/home/me/backup/id_ed25519" }],
    ["an SSH key named in a list", { kind: "list", items: ["Copied id_rsa to the USB stick"] }],
    ["a key in a private folder", { kind: "file", path: "/etc/ssl/private/server.pem.txt" }],
    ["a backed-up key file", { kind: "code", lines: ["cp server.key.bak /tmp"] }],
    ["Ember's data written with the variable", { kind: "text", text: "Settings live in %LOCALAPPDATA%\\ember\\settings.json" }],
    ["an AWS key as a fact's value", { kind: "keyvalue", rows: [{ label: "Access key", value: "AKIAIOSFODNN7EXAMPLE" }] }],
    ["a password in a text", { kind: "text", text: "password: hunter2" }],
    ["a password as a fact (first catalog)", undefined],
  ])("is refused whole: %s", (_name, node) => {
    const v = node === null ? [{ kind: "excerpt", path: "~/notes.txt", lines: ["-----BEGIN RSA PRIVATE KEY-----"] }]
      : node === undefined ? [{ kind: "facts", rows: [{ label: "Wifi", value: "password: hunter2" }] }]
      : stack(node);
    expect(why(v)).toBe("secret");
  });
});

describe("button words where a button's label would stand (review N3)", () => {
  it("are refused in a comparison's headers and in steps", () => {
    expect(why(stack({ kind: "compare", columns: ["Yes", "No"], rows: [{ label: "x", a: "1", b: "2" }] }))).toBe("mimic");
    expect(why(stack({ kind: "steps", items: [{ text: "Confirm", state: "now" }] }))).toBe("mimic");
  });
});

describe("a quote's caption (review N1)", () => {
  const src = (source: object, c: ViewContext) => {
    const r = checkView(stack({ kind: "quote", id: "q", text: "x", source }), c);
    if (!r.ok) throw new Error(r.error);
    return (r.doc.nodes.q as { source: object }).source;
  };
  it("says a file or a web page only if the task read something or ran a command", () => {
    expect(src({ kind: "web" }, { appsRead: new Set() })).toEqual({ kind: "screen" });
    expect(src({ kind: "file", path: "~/a.txt" }, { appsRead: new Set() })).toEqual({ kind: "screen" });
    expect(src({ kind: "web" }, { appsRead: new Set(["Firefox"]) })).toEqual({ kind: "web" });
    expect(src({ kind: "file", path: "~/a.txt" }, { appsRead: new Set(), ranCommand: true })).toEqual({ kind: "file", path: "~/a.txt" });
  });
});

describe("an oversized tree (review N2)", () => {
  it("stops being read as soon as it passes the node cap", () => {
    const huge = stack(...Array.from({ length: 12 }, () => stack(...Array.from({ length: 12 }, () => stack(...Array.from({ length: 12 }, () => ({ kind: "text", text: "x" })))))));
    const r = checkView(huge, ctx);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/more than 120 nodes/);
  });
});
