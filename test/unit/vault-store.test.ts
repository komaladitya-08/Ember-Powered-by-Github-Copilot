/**
 * The vault's file and what it may hold (owner decision of 2026-11-12, PLAN.md §2 "Approvals"; the round's brief,
 * decisions 1 and 3): three kinds of entry, each bound to one app or one site's origin, sealed with the keyring, never
 * kept on basic_text, in a 0600 file of its own, and nothing a list or a failure says ever holds a value.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretBox } from "../../app/main/agent/auth";
import { VAULT_FILE, VaultStore } from "../../app/main/vault/store";
import {
  PART_SPEC, SECRET_PARTS, VAULT_KINDS, VAULT_MAX_ENTRIES, VAULT_PARTS, checkValues, formWords, partProblem, sameDestination, siteLabel, siteOrigin,
  validDestination, vaultAppKey, type VaultDestination,
} from "../../app/shared/vault";

const CANARY = "hunter2-CANARY-9f3a";
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A keyring that seals reversibly without leaving the text readable (as safeStorage's blob isn't). */
const box = (o: Partial<SecretBox> = {}): SecretBox => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed:${Buffer.from(s, "utf8").toString("hex")}`),
  decryptString: b => {
    const t = b.toString();
    if (!t.startsWith("sealed:")) throw new Error("not sealed by this keyring");
    return Buffer.from(t.slice(7), "hex").toString("utf8");
  },
  getSelectedStorageBackend: () => "gnome_libsecret",
  ...o,
});
const GITHUB: VaultDestination = { site: "https://github.com" };
const MAIL: VaultDestination = { app: "thunderbird" };
const login = { user: "quillon", password: CANARY };
const card = { cardName: "Ada L", cardNumber: "4242 4242 4242 4242", expiry: "08/2029", securityCode: "123" };

describe("a vault destination", () => {
  it("is one app by its folded program name, the same for its .desktop and .exe names (vault-1)", () => {
    expect(vaultAppKey("Firefox")).toBe("firefox");
    expect(vaultAppKey("firefox.desktop")).toBe("firefox");
    expect(vaultAppKey("Firefox.exe")).toBe("firefox");
    expect(vaultAppKey("org.gnome.Nautilus")).toBe("org.gnome.nautilus");
    expect(vaultAppKey("Visual Studio Code")).toBe("visual studio code");
  });

  it("is nothing for a name that is empty, a path, or only looks like another through invisible characters (vault-1)", () => {
    for (const bad of ["", "   ", "/usr/bin/firefox", "C:\\x\\firefox", "a:b", "x".repeat(201), "tab\there"]) expect(vaultAppKey(bad), JSON.stringify(bad)).toBeNull();
    expect(vaultAppKey(7 as unknown as string)).toBeNull();
    // A zero-width joiner or a soft hyphen in the name gives the same key as the plain name, never a second entry's.
    expect(vaultAppKey("fire\u200dfox")).toBe("firefox");
    expect(vaultAppKey("fire\u00adfox")).toBe("firefox");
  });

  it("is one site by its origin: scheme, host and port, as the URL parser gives them (vault-1)", () => {
    expect(siteOrigin("https://github.com/login?return_to=x#y")).toBe("https://github.com");
    expect(siteOrigin("HTTPS://GitHub.COM:443/")).toBe("https://github.com");
    expect(siteOrigin("http://intranet:8080/a")).toBe("http://intranet:8080");
    expect(siteOrigin("https://github.com:8443/")).toBe("https://github.com:8443");
  });

  it("never takes a look-alike host for the real one (vault-1)", () => {
    // Cyrillic "і" in the name: its origin is the xn-- form, not github.com's.
    const fake = siteOrigin("https://g\u0456thub.com/login");
    expect(fake).not.toBe("https://github.com");
    expect(fake).toMatch(/^https:\/\/xn--/);
    expect(siteOrigin("https://github.com.evil.example/")).toBe("https://github.com.evil.example");
    expect(sameDestination({ site: "https://github.com" }, { site: "http://github.com" })).toBe(false);
    expect(sameDestination({ site: "https://github.com" }, { site: "https://github.com:8443" })).toBe(false);
    expect(sameDestination({ app: "github.com" }, { site: "https://github.com" })).toBe(false);
  });

  it("is nothing for what isn't a page with a host, or carries a user name or password in its address (vault-1)", () => {
    for (const bad of ["", "github.com", "file:///etc/passwd", "data:text/html,x", "about:blank", "javascript:alert(1)", "https://user:pw@github.com/", "https://user@github.com/", "chrome://settings", `https://a.example/${"x".repeat(4100)}`]) {
      expect(siteOrigin(bad), bad.slice(0, 40)).toBeNull();
    }
  });

  it("is well formed only as exactly one app key or one origin (vault-1)", () => {
    expect(validDestination(GITHUB)).toBe(true);
    expect(validDestination(MAIL)).toBe(true);
    for (const bad of [null, [], "https://github.com", {}, { app: "Firefox" }, { site: "https://github.com/" }, { site: "github.com" }, { app: "firefox", site: "https://github.com" }, { app: 1 }, { origin: "https://github.com" }]) {
      expect(validDestination(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("names a site by its host on https, and by its whole origin otherwise (vault-1)", () => {
    expect(siteLabel("https://github.com")).toBe("github.com");
    expect(siteLabel("https://github.com:8443")).toBe("https://github.com:8443");
    expect(siteLabel("http://intranet")).toBe("http://intranet");
  });
});

describe("what the vault keeps", () => {
  it("is three kinds: a login, a card and contact details, with their parts (vault-1)", () => {
    expect(VAULT_KINDS).toEqual(["login", "card", "contact"]);
    expect(VAULT_PARTS).toEqual({ login: ["user", "password"], card: ["cardName", "cardNumber", "expiry", "securityCode"], contact: ["name", "email", "phone", "address"] });
    expect([...SECRET_PARTS].sort()).toEqual(["cardNumber", "password", "securityCode"]);
    for (const k of VAULT_KINDS) for (const p of VAULT_PARTS[k]) expect(PART_SPEC[p].label, p).toMatch(/^[A-Z][^.]+$/);
  });

  it("takes only that kind's parts, each a bounded string, and says which part fails without its value (vault-1)", () => {
    expect(checkValues("login", login)).toEqual({ ok: true, values: login });
    expect(checkValues("login", { password: "  spaces kept  " })).toEqual({ ok: true, values: { password: "  spaces kept  " } });
    expect(checkValues("login", { user: "  ada  ", password: "p" })).toEqual({ ok: true, values: { user: "ada", password: "p" } });
    expect(checkValues("login", { user: "ada" })).toEqual({ ok: false, part: "password" });
    expect(checkValues("login", { user: "ada", password: "" })).toEqual({ ok: false, part: "password" });
    expect(checkValues("login", { ...login, cardNumber: "4242424242424242" })).toEqual({ ok: false });
    expect(checkValues("login", { ...login, extra: 1 })).toEqual({ ok: false });
    expect(checkValues("login", { password: 5 })).toEqual({ ok: false, part: "password" });
    expect(checkValues("login", { password: "x".repeat(1025) })).toEqual({ ok: false, part: "password" });
    expect(checkValues("login", { password: "a\nb" })).toEqual({ ok: false, part: "password" });
    expect(checkValues("login", { password: "a\u0000b" })).toEqual({ ok: false, part: "password" });
    for (const bad of [null, undefined, "x", 3, [], [login]]) expect(checkValues("login", bad)).toEqual({ ok: false });
    expect(JSON.stringify(checkValues("login", { password: `${CANARY}\n` }))).not.toContain(CANARY);
  });

  it("keeps a card's number as digits and its expiry as MM/YY, and refuses what isn't one (vault-1)", () => {
    expect(checkValues("card", card)).toEqual({ ok: true, values: { cardName: "Ada L", cardNumber: "4242424242424242", expiry: "08/29", securityCode: "123" } });
    expect(checkValues("card", { ...card, cardNumber: "4242-4242" })).toEqual({ ok: false, part: "cardNumber" });
    expect(checkValues("card", { ...card, cardNumber: "4242 4242 4242 424x" })).toEqual({ ok: false, part: "cardNumber" });
    expect(checkValues("card", { ...card, expiry: "13/29" })).toEqual({ ok: false, part: "expiry" });
    expect(checkValues("card", { ...card, expiry: "8/29" })).toEqual({ ok: false, part: "expiry" });
    expect(checkValues("card", { ...card, securityCode: "12" })).toEqual({ ok: false, part: "securityCode" });
    expect(checkValues("card", { ...card, securityCode: "12345" })).toEqual({ ok: false, part: "securityCode" });
    const { cardName: _n, ...bare } = card;
    expect(checkValues("card", bare).ok).toBe(true);
  });

  it("takes contact details with any one part, an address on several lines, and refuses none at all (vault-1)", () => {
    expect(checkValues("contact", { email: "ada@example.org" })).toEqual({ ok: true, values: { email: "ada@example.org" } });
    expect(checkValues("contact", { address: "1 Main St\nSpringfield" })).toEqual({ ok: true, values: { address: "1 Main St\nSpringfield" } });
    expect(checkValues("contact", {})).toEqual({ ok: false });
    expect(checkValues("contact", { name: "   " })).toEqual({ ok: false });
    expect(checkValues("contact", { email: "not an email" })).toEqual({ ok: false, part: "email" });
    expect(checkValues("contact", { name: "a\nb" })).toEqual({ ok: false, part: "name" });
    expect(partProblem("phone", "x".repeat(41))).toBe("long");
  });

  it("words the Secure Form from the kind and the destination alone (vault-1)", () => {
    expect(formWords("login", "github.com", true, "Firefox")).toEqual({
      title: "Login for github.com",
      where: "Asked in Firefox. Ember fills it in only on github.com, in any browser.",
      lead: "Ember keeps it locked with your computer's keyring and uses it only in Autopilot. It never shows it to you again, and the AI model never sees it.",
    });
    expect(formWords("card", "github.com", true, null).where).toBe("Ember fills it in only on github.com, in any browser.");
    expect(formWords("contact", "Thunderbird", false, "Firefox")).toMatchObject({ title: "Contact details for Thunderbird", where: "Ember fills them in only in Thunderbird." });
  });
});

describe("VaultStore", () => {
  const make = (o: Partial<SecretBox> = {}, opts: { asyncKeyring?: boolean; now?: () => number } = {}) => {
    const file = path.join(tmp(), VAULT_FILE);
    return { file, store: new VaultStore(file, box(o), opts) };
  };

  it("keeps an entry sealed in vault.json, mode 0600, with only its kind, destination and date in the clear (vault-1)", async () => {
    const { file, store } = make({}, { now: () => 1_700_000_000_000 });
    const kept = await store.add("login", GITHUB, login);
    expect(kept).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(path.basename(file)).toBe("vault.json");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("quillon");
    const parsed = JSON.parse(text) as { v: number; entries: Record<string, unknown>[] };
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.entries[0]).sort()).toEqual(["dest", "id", "kind", "savedAt", "sealed"]);
    expect(store.list()).toEqual([{ id: kept.ok ? kept.id : "", kind: "login", dest: GITHUB, savedAt: 1_700_000_000_000 }]);
    expect(JSON.stringify(store.list())).not.toContain("sealed");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["vault.json"]);
  });

  it("gives the values back only through open(), for main's fill, checked again (vault-1)", async () => {
    const { store } = make();
    const kept = await store.add("card", MAIL, card);
    if (!kept.ok) throw new Error("not kept");
    expect(await store.open(kept.id)).toEqual({ meta: { id: kept.id, kind: "card", dest: MAIL, savedAt: expect.any(Number) }, values: { cardName: "Ada L", cardNumber: "4242424242424242", expiry: "08/29", securityCode: "123" } });
    expect(await store.open("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("keeps nothing where the keyring is basic_text, unknown, unavailable or throws, and writes no file (vault-1)", async () => {
    for (const o of [
      { getSelectedStorageBackend: () => "basic_text" }, { getSelectedStorageBackend: () => "unknown" }, { isEncryptionAvailable: () => false },
      { isEncryptionAvailable: () => { throw new Error("dbus"); } }, { encryptString: () => { throw new Error(`refused ${CANARY}`); } },
    ] as Partial<SecretBox>[]) {
      const { file, store } = make(o);
      expect(await store.add("login", GITHUB, login)).toEqual({ ok: false, why: "keyring" });
      expect(fs.existsSync(file)).toBe(false);
      expect(store.list()).toEqual([]);
    }
    expect(await make({ getSelectedStorageBackend: () => "basic_text" }).store.canPersist()).toBe(false);
    expect(await make().store.canPersist()).toBe(true);
    // Windows and macOS have no backend to name: the keyring's own answer counts.
    expect(await make({ getSelectedStorageBackend: undefined }).store.canPersist()).toBe(true);
  });

  it("asks the keyring only off the main thread where asked to (macOS), and keeps nothing when it says no (vault-1)", async () => {
    const calls: string[] = [];
    const asyncBox: Partial<SecretBox> = {
      isEncryptionAvailable: () => { calls.push("sync-available"); return true; },
      isAsyncEncryptionAvailable: async () => { calls.push("async-available"); return true; },
      encryptStringAsync: async s => { calls.push("async-encrypt"); return box().encryptString(s); },
      decryptStringAsync: async b => { calls.push("async-decrypt"); return { result: box().decryptString(b), shouldReEncrypt: false }; },
      encryptString: () => { calls.push("sync-encrypt"); throw new Error("on the main thread"); },
      decryptString: () => { calls.push("sync-decrypt"); throw new Error("on the main thread"); },
      getSelectedStorageBackend: undefined,
    };
    const { store } = make(asyncBox, { asyncKeyring: true });
    const kept = await store.add("login", GITHUB, login);
    if (!kept.ok) throw new Error("not kept");
    expect((await store.open(kept.id))?.values).toEqual(login);
    expect(calls).toEqual(["async-available", "async-encrypt", "async-decrypt"]);
    const no = make({ ...asyncBox, isAsyncEncryptionAvailable: async () => false }, { asyncKeyring: true });
    expect(await no.store.add("login", GITHUB, login)).toEqual({ ok: false, why: "keyring" });
  });

  it("refuses values that aren't that kind's and a destination that isn't one, before the keyring is asked (vault-1)", async () => {
    let asked = 0;
    const { file, store } = make({ isEncryptionAvailable: () => { asked++; return true; } });
    expect(await store.add("login", GITHUB, { user: "ada" })).toEqual({ ok: false, why: "invalid" });
    expect(await store.add("login", { site: "https://github.com/login" }, login)).toEqual({ ok: false, why: "invalid" });
    expect(await store.add("login", { app: "Firefox" }, login)).toEqual({ ok: false, why: "invalid" });
    expect(await store.add("passkey" as "login", GITHUB, login)).toEqual({ ok: false, why: "invalid" });
    expect(asked).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps one entry of a kind for a destination: a new one takes the old one's place (vault-1)", async () => {
    let t = 1000;
    const { store } = make({}, { now: () => t++ });
    const first = await store.add("login", GITHUB, login);
    await store.add("card", GITHUB, card);
    await store.add("login", MAIL, login);
    const second = await store.add("login", GITHUB, { password: "other" });
    if (!first.ok || !second.ok) throw new Error("not kept");
    expect(store.list().map(e => [e.kind, e.dest])).toEqual([["login", GITHUB], ["login", MAIL], ["card", GITHUB]]);
    expect(await store.open(first.id)).toBeNull();
    expect((await store.open(second.id))?.values).toEqual({ password: "other" });
    expect(store.find("login", GITHUB)?.id).toBe(second.id);
    expect(store.find("contact", GITHUB)).toBeNull();
    expect(store.find("login", { site: "https://github.com:8443" })).toBeNull();
  });

  it("opens nothing for an entry whose file was edited to another destination, kind or id (vault-1)", async () => {
    const { file, store } = make();
    const kept = await store.add("login", GITHUB, login);
    if (!kept.ok) throw new Error("not kept");
    const edit = (f: (e: Record<string, unknown>) => void) => {
      const v = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, unknown>[] };
      f(v.entries[0]);
      fs.writeFileSync(file, JSON.stringify(v));
    };
    edit(e => { e.dest = { site: "https://evil.example" }; });
    expect(store.list()[0].dest).toEqual({ site: "https://evil.example" });
    expect(await store.open(kept.id)).toBeNull();
    edit(e => { e.dest = GITHUB; e.kind = "contact"; });
    expect(await store.open(kept.id)).toBeNull();
    edit(e => { e.kind = "login"; e.id = "00000000-0000-4000-8000-000000000000"; });
    expect(await store.open("00000000-0000-4000-8000-000000000000")).toBeNull();
    edit(e => { e.id = kept.id; });
    expect((await store.open(kept.id))?.values).toEqual(login);
    edit(e => { e.sealed = Buffer.from("garbage").toString("base64"); });
    expect(await store.open(kept.id)).toBeNull();
  });

  it("reads a missing, broken or foreign file as empty and drops entries that aren't well formed (vault-1)", async () => {
    const { file, store } = make();
    expect(store.list()).toEqual([]);
    for (const text of ["", "{", "[]", JSON.stringify({ v: 2, entries: [] }), JSON.stringify({ v: 1, entries: "x" })]) {
      fs.writeFileSync(file, text);
      expect(store.list(), text).toEqual([]);
    }
    const good = { id: "11111111-1111-4111-8111-111111111111", kind: "login", dest: GITHUB, savedAt: 5, sealed: "AAAA" };
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [good, { ...good, kind: "passkey" }, { ...good, dest: { site: "github.com" } }, { ...good, sealed: "" }, { ...good, id: "x" }, null, "x"] }));
    expect(store.list()).toEqual([{ id: good.id, kind: "login", dest: GITHUB, savedAt: 5 }]);
  });

  it("keeps at most 200 entries and says the vault is full (vault-1)", async () => {
    const { file, store } = make();
    const entries = Array.from({ length: VAULT_MAX_ENTRIES }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, kind: "login", dest: { site: `https://s${i}.example` }, savedAt: i, sealed: "AAAA" }));
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries }));
    expect(await store.add("login", GITHUB, login)).toEqual({ ok: false, why: "full" });
    // In place of one already there is no new entry.
    expect((await store.add("login", { site: "https://s3.example" }, login)).ok).toBe(true);
    expect(store.list()).toHaveLength(VAULT_MAX_ENTRIES);
  });

  it("forgets one entry, and the file goes with the last one (vault-1)", async () => {
    const { file, store } = make();
    const a = await store.add("login", GITHUB, login);
    const b = await store.add("card", GITHUB, card);
    if (!a.ok || !b.ok) throw new Error("not kept");
    expect(store.forget(a.id)).toBe(true);
    expect(store.forget(a.id)).toBe(false);
    expect(store.list().map(e => e.id)).toEqual([b.id]);
    expect(fs.readFileSync(file, "utf8")).not.toContain(a.id);
    expect(store.forget(b.id)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("forgets everything by removing the file, and is fine with none (vault-1)", async () => {
    const { file, store } = make();
    expect(store.forgetAll()).toBe(true);
    await store.add("login", GITHUB, login);
    await store.add("card", MAIL, card);
    expect(store.forgetAll()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("keeps nothing from a Save still being sealed when everything is forgotten meanwhile (vault-1)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const { file, store } = make({
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async s => { await gate; return box().encryptString(s); },
    }, { asyncKeyring: true });
    const pending = store.add("login", GITHUB, login);
    await new Promise(r => setTimeout(r, 5));
    expect(store.forgetAll()).toBe(true); // Sign out, or Forget everything
    release();
    expect(await pending).toEqual({ ok: false, why: "write" });
    expect(fs.existsSync(file)).toBe(false);
    // And the vault works again afterwards.
    expect((await store.add("login", GITHUB, login)).ok).toBe(true);
  });

  it("says a write failed, keeps what was there and leaves no temporary file (vault-1)", async () => {
    const dir = tmp();
    const file = path.join(dir, "gone", VAULT_FILE);
    const store = new VaultStore(file, box());
    expect(await store.add("login", GITHUB, login)).toEqual({ ok: false, why: "write" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says so when the folder can't be written, and keeps the entries it had (vault-1)", async () => {
    const { file, store } = make();
    const a = await store.add("login", GITHUB, login);
    if (!a.ok) throw new Error("not kept");
    fs.chmodSync(path.dirname(file), 0o500);
    try {
      expect(await store.add("card", GITHUB, card)).toEqual({ ok: false, why: "write" });
      expect(store.forget(a.id)).toBe(false);
      expect(store.forgetAll()).toBe(false);
      expect(store.list().map(e => e.id)).toEqual([a.id]);
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
  });

  it("never throws a value: nothing an add, a list or a failure returns holds one (vault-1)", async () => {
    const said: unknown[] = [];
    for (const o of [{}, { getSelectedStorageBackend: () => "basic_text" }, { encryptString: (s: string): Buffer => { throw new Error(s); } }] as Partial<SecretBox>[]) {
      const { store } = make(o);
      said.push(await store.add("login", GITHUB, login), store.list(), store.find("login", GITHUB), await store.canPersist());
    }
    expect(JSON.stringify(said)).not.toContain(CANARY);
  });
});
