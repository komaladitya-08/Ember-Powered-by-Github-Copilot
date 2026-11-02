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

describe("a shortcut chord in a view, however it is written (review B1)", () => {
  it.each([
    "Press Ctrl-Alt-Y to go on", "Ctrl Alt Y", "Control+Alt+Y", "Ctrl＋Alt＋Y", "⌃⇧⌘Y", "Ctrl+Option+Cmd+Y", "Windows+Alt+Y",
    "Super + Alt + N", "control-shift-command-period", "Win+Alt+Shift+X.", "(Ctrl+Alt+Y)", "ctrl alt shift y", "Ctrl+Alt+Esc",
  ])("is refused: %s", s => {
    expect(namesChord(s), s).toBe(true);
    expect(why(stack({ kind: "text", text: s }))).toBe("mimic");
  });

  it("is refused when split across a table's cells, or across nodes", () => {
    expect(why(stack({ kind: "table", columns: ["Keys", "Then"], rows: [["Ctrl+Alt", "+Y"]] }))).toBe("mimic");
    expect(why(stack({ kind: "text", text: "Hold Ctrl and Alt," }, { kind: "text", text: "then Y" }))).toBe(null);
    expect(why(stack({ kind: "text", text: "Ctrl+Alt" }, { kind: "text", text: "+Y" }))).toBe("mimic");
  });

  it("is refused when an update puts it together", () => {
    const r = checkView({ kind: "stack", id: "top", children: [{ kind: "text", id: "a", text: "Ctrl+Alt" }, { kind: "text", id: "b", text: "Then" }] }, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(applyViewOps(r.doc, [{ op: "set", id: "b", props: { text: "+Y" } }], ctx)).toMatchObject({ ok: false, why: "mimic" });
  });

  it("leaves ordinary key talk alone", () => {
    for (const s of ["Press Ctrl+S to save", "Alt+F4 closes it", "Ctrl+Alt+T opens a terminal", "Shift+Y types a capital Y", "Cmd+Y", "Control the alt text, yes"]) {
      expect(namesChord(s), s).toBe(false);
    }
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
    ["a variation selector", { kind: "text", text: "x\uFE0F" }],
    ["a Cyrillic A", { kind: "badge", text: "\u0410llow", tone: "positive" }],
    ["a Cyrillic o", { kind: "list", items: ["N\u043Et now"] }],
    ["a Cyrillic A in Allow once", { kind: "text", text: "\u0410llow once" }],
    ["a Greek omicron", { kind: "text", text: "N\u03BFt now" }],
    ["fullwidth letters", { kind: "badge", text: "Ａｌｌｏｗ", tone: "info" }],
    ["small capitals", { kind: "text", text: "ᴀʟʟᴏᴡ" }],
  ])("is refused: %s", (_name, node) => {
    expect(why(stack(node))).toBe("mimic");
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
    "As promised, Ember says go ahead", "Ｅｍｂｅｒ： approved", "Ember： ok"])("is refused: %s", s => {
    expect(why(stack({ kind: "text", text: s }))).toBe("mimic");
  });

  it("leaves a mention of Ember alone", () => {
    expect(why(stack({ kind: "text", text: "The Ember project's notes, version 2" }))).toBe(null);
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
