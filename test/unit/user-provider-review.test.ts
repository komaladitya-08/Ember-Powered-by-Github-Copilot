/**
 * The own model provider's security review (PR #136): nothing goes to a host the card wasn't agreed for, Test connection
 * included (B1); the card's yes is recorded only in main, for the endpoint's host (S1); the key belongs to the host it was
 * entered for (S2); Home's changes merge into the user's own settings (S3) and the yes is for what the field says (S4);
 * the keyring is never asked at a start with the provider off, and on macOS never synchronously (the second-instance
 * hand-over hung on it in CI); the runtime gets the parsed address (N1); the key is redacted from logs (N3); a model
 * that takes no images is said so (N6).
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { SettingsSchema, SettingsStore, withOwnProvider, type Settings } from "../../app/main/settings";
import {
  PROVIDER_HOST_CHANGED, ProviderKeyStore, activeProvider, createProviderService, keyFor, ownProviderAuth, providerNotAgreed, providerStateOf, redact, redactingLogger, testConnection,
  userProviderConfig, type FetchLike, type StoredKey,
} from "../../app/main/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import type { SecretBox } from "../../app/main/agent/auth";
import type { Logger } from "../../app/main/logger";
import { friendlyError } from "../../app/main/agent/presenter";
import { settingsFromHome } from "../../app/main/windows";
import { AGREE_ARM_MS, AgreeGuard, agreeAction } from "../../app/shared/provider";

const KEY = "sk-" + "r".repeat(40); // not a real key
const NONE: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-provider-review-"));
const agreedFor = (host: string) => ({ version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-02T10:00:00Z", host });
const provider = (p: Partial<Settings["provider"]>): Settings["provider"] => SettingsSchema.shape.provider.parse({ on: true, type: "openai", conductor: "m", ...p });
const ok200 = () => vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));

/** A keyring that seals by reversing, and counts how it was asked. */
function box(o: Partial<SecretBox> = {}) {
  const asked: string[] = [];
  const b: SecretBox = {
    isEncryptionAvailable: () => { asked.push("isEncryptionAvailable"); return true; },
    encryptString: s => { asked.push("encryptString"); return Buffer.from([...s].reverse().join("")); },
    decryptString: x => { asked.push("decryptString"); return [...x.toString()].reverse().join(""); },
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...o,
  };
  return { box: b, asked };
}

function service(o: { settings?: Partial<Settings["provider"]>; keyFile?: string; consented?: boolean; fetch?: FetchLike; keyring?: ReturnType<typeof box> } = {}) {
  const dir = tmp();
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  if (o.settings) settings.update({ provider: provider(o.settings) });
  const kr = o.keyring ?? box();
  const keys = new ProviderKeyStore(o.keyFile ?? path.join(dir, "provider-key.bin"), kr.box);
  const fetch = o.fetch ?? ok200();
  const changed = vi.fn();
  const s = createProviderService({ settings, admin: () => NONE, keys, consented: () => o.consented ?? true, fetch, log: { info() {}, warn() {} }, changed });
  return { s, settings, keys, fetch, changed, asked: kr.asked, dir };
}

describe("Test connection and a host the card wasn't agreed for (B1)", () => {
  it("sends nothing at all, not even without a key, while the endpoint's card isn't agreed", async () => {
    const fetch = ok200();
    const p = provider({ baseUrl: "https://b.example/v1", consent: agreedFor("a.example") });
    expect(await testConnection(p, null, fetch)).toEqual({ ok: false, why: providerNotAgreed("b.example") });
    expect(await testConnection(p, { key: KEY, host: "a.example" }, fetch)).toEqual({ ok: false, why: providerNotAgreed("b.example") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses through main's channel too: agreed to a.example with a key saved, the endpoint moved to b.example, Test sends nothing", async () => {
    const { s, settings, fetch } = service({ settings: { baseUrl: "https://a.example/v1" } });
    expect(s.api.agree("a.example")).toEqual({ ok: true });
    expect(await s.api.saveKey(KEY, "a.example")).toEqual({ ok: true });
    settings.update(withOwnProvider({ provider: { baseUrl: "https://b.example/v1" } as Settings["provider"] }, settings.own().provider));
    s.settingsChanged();
    const r = await s.api.test();
    expect(r).toEqual({ ok: false, why: providerNotAgreed("b.example") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the key only to the host it was entered for", async () => {
    const fetch = ok200();
    await testConnection(provider({ baseUrl: "https://b.example/v1", consent: agreedFor("b.example") }), { key: KEY, host: "a.example" }, fetch);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(KEY);
    expect(keyFor("https://b.example/v1", { key: KEY, host: "a.example" })).toBeNull();
    expect(userProviderConfig(provider({ baseUrl: "https://b.example/v1" }), { key: KEY, host: "a.example" }).apiKey).toBeUndefined();
  });

  it("checks typed details without saving any of them: their host only, a key just typed only there, the saved key only for its own host (first-run-r2-1)", async () => {
    const { s, settings, keys, fetch } = service({ settings: { baseUrl: "https://a.example/v1" } });
    expect(s.api.agree("a.example")).toEqual({ ok: true });
    expect(await s.api.saveKey(KEY, "a.example")).toEqual({ ok: true });
    const before = JSON.stringify(settings.get().provider);
    const NEW = "sk-" + "n".repeat(40); // not a real key
    // Another host with a key just typed: that key goes there, the saved one never does, and nothing is kept.
    expect(await s.api.test({ type: "openai", baseUrl: "https://b.example/v1", host: "b.example", key: NEW })).toMatchObject({ ok: true, host: "b.example" });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://b.example/v1/models");
    expect(init.headers.authorization).toBe(`Bearer ${NEW}`);
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(KEY);
    // Another host without a key: no key at all.
    await s.api.test({ type: "openai", baseUrl: "https://b.example/v1", host: "b.example" });
    expect(vi.mocked(fetch).mock.calls[1]![1].headers.authorization).toBeUndefined();
    // The host in use without a key: its own saved key.
    await s.api.test({ type: "openai", baseUrl: "https://a.example/v2", host: "a.example" });
    expect(vi.mocked(fetch).mock.calls[2]![1].headers.authorization).toBe(`Bearer ${KEY}`);
    // The details in use, their agreement and their key are untouched.
    expect(JSON.stringify(settings.get().provider)).toBe(before);
    expect(keys.savedHost()).toBe("a.example");
    expect(s.key()?.key).toBe(KEY);
  });

  it("sends a typed draft nowhere unless its address names the host whose card was agreed, consent is given and a key could be kept (first-run-r2-1)", async () => {
    const { s, fetch } = service({ settings: { baseUrl: "https://a.example/v1" } });
    expect(await s.api.test({ type: "openai", baseUrl: "https://b.example/v1", host: "a.example", key: KEY })).toEqual({ ok: false, why: PROVIDER_HOST_CHANGED });
    expect(await s.api.test({ type: "openai", baseUrl: "http://b.example/v1", host: "b.example" })).toMatchObject({ ok: false });
    expect(await s.api.test({ type: "openai", baseUrl: "https://b.example/v1", host: "b.example", key: "has a space" })).toMatchObject({ ok: false });
    const noKeyring = service({ settings: { baseUrl: "https://a.example/v1" }, keyring: box({ getSelectedStorageBackend: () => "basic_text" }) });
    expect(await noKeyring.s.api.test({ type: "openai", baseUrl: "https://b.example/v1", host: "b.example", key: KEY })).toMatchObject({ ok: false, why: expect.stringContaining("keyring") });
    const noConsent = service({ settings: { baseUrl: "https://a.example/v1" }, consented: false });
    expect(await noConsent.s.api.test({ type: "openai", baseUrl: "https://b.example/v1", host: "b.example" })).toMatchObject({ ok: false });
    for (const f of [fetch, noKeyring.fetch, noConsent.fetch]) expect(f).not.toHaveBeenCalled();
  });

  it("keeps Home's Test connection button disabled until the card is agreed for the endpoint", () => {
    const page = readFileSync("app/renderer/home/provider.ts", "utf8");
    expect(page).toContain("test.disabled = !agreedFor(p, host) || !!managed;");
  });
});

describe("the card's yes (S1, S4)", () => {
  it("is recorded only through main's agree, for the host the endpoint names now", () => {
    const { s, settings } = service({ settings: { baseUrl: "https://a.example/v1", on: false } });
    expect(s.api.agree("b.example")).toEqual({ ok: false, why: PROVIDER_HOST_CHANGED });
    expect(settings.own().provider.consent.version).toBe(0);
    expect(s.api.agree("a.example")).toEqual({ ok: true });
    expect(settings.own().provider).toMatchObject({ on: true, consent: { version: FEATURE_CONSENT_VERSION.provider, host: "a.example" } });
  });

  it("comes with the details an edit of the provider in force moved to, all written in one change only for the host they name, so it never leaves force between (integrations-c3-1)", async () => {
    const { s, settings, keys } = service({ settings: { baseUrl: "https://a.example/v1" } });
    expect(s.api.agree("a.example")).toEqual({ ok: true });
    expect(await s.api.saveKey(KEY, "a.example")).toEqual({ ok: true });
    const inForce: (string | null)[] = [];
    settings.onChange(next => inForce.push(next.provider.on && next.provider.consent.host === new URL(next.provider.baseUrl).host ? next.provider.consent.host : null));
    // Details that name another host than the one agreed to: nothing is written.
    expect(s.api.agree("c.example", { type: "openai", baseUrl: "https://b.example/v1" })).toEqual({ ok: false, why: PROVIDER_HOST_CHANGED });
    expect(settings.own().provider).toMatchObject({ baseUrl: "https://a.example/v1", consent: { host: "a.example" } });
    expect(inForce).toEqual([]);
    expect(s.api.agree("b.example", { type: "anthropic", baseUrl: "https://b.example/v1", conductor: "claude-x", worker: null, wireApi: null, azureApiVersion: null })).toEqual({ ok: true });
    expect(settings.own().provider).toMatchObject({ on: true, type: "anthropic", baseUrl: "https://b.example/v1", conductor: "claude-x", consent: { version: FEATURE_CONSENT_VERSION.provider, host: "b.example" } });
    expect(inForce).toEqual(["b.example"]);
    // The key entered for a.example never goes with it.
    s.settingsChanged();
    expect(keys.savedHost()).toBeNull();
    expect(s.key()).toBeNull();
  });

  it("can't be sent with Home's general settings changes", () => {
    const sent = { size: 64, provider: { on: true, baseUrl: "https://evil.example/v1", consent: agreedFor("evil.example") } } as never;
    const { patch, dropped } = settingsFromHome(sent);
    expect(dropped).toEqual(["provider.consent"]);
    expect(JSON.stringify(patch)).not.toContain("consent");
    // And withOwnProvider keeps the user's own record even if one slipped through.
    const own = provider({ baseUrl: "https://a.example/v1", consent: agreedFor("a.example") });
    expect((withOwnProvider(sent, own).provider as Settings["provider"]).consent).toEqual(own.consent);
  });

  it("is given for the host the card named, never for another one the field holds by then (re-review N-S4)", () => {
    // The card named a.example; the field was changed to b.example and not yet saved: nothing is agreed, the new
    // address is saved and the card drawn again for it.
    expect(agreeAction("a.example", "https://b.example/v1")).toEqual({ save: "https://b.example/v1" });
    expect(agreeAction("a.example", "https://a.example/v2")).toEqual({ agree: "a.example" });
    expect(agreeAction("a.example", "")).toEqual({ agree: "a.example" });
    expect(agreeAction("a.example", "http://far.example/v1")).toEqual({ problem: "Use an https:// address. Only a model server on this computer (localhost) may use http://." });
    expect(agreeAction(null, "https://a.example/v1")).toBeNull();
    const page = readFileSync("app/renderer/home/provider.ts", "utf8");
    expect(page).toContain("a.agree(next.agree)");
    expect(page).toContain("cardHost = asking ? host : null;");
  });
});

describe("the key and its host (S2)", () => {
  it("is deleted when the endpoint moves to another host, so it is never inherited", async () => {
    const { s, settings, keys, changed } = service({ settings: { baseUrl: "https://a.example/v1" } });
    s.api.agree("a.example");
    await s.api.saveKey(KEY, "a.example");
    expect(keys.savedHost()).toBe("a.example");
    settings.update(withOwnProvider({ provider: { baseUrl: "https://b.example/v1" } as Settings["provider"] }, settings.own().provider));
    s.settingsChanged();
    expect(keys.savedHost()).toBeNull();
    expect(s.key()).toBeNull();
    expect(changed).toHaveBeenCalled();
    expect((await s.api.state()).keySaved).toBe(false);
  });

  it("is sealed together with its host, and a file whose host doesn't match isn't used", async () => {
    const dir = tmp();
    const file = path.join(dir, "provider-key.bin");
    const keys = new ProviderKeyStore(file, box().box);
    await keys.save(KEY, "a.example");
    expect(await keys.load()).toEqual<StoredKey>({ key: KEY, host: "a.example", keyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // Someone swaps the host beside it: the service still won't use the key for that host.
    fs.writeFileSync(path.join(dir, "provider-key.host"), "b.example");
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    settings.update({ provider: provider({ baseUrl: "https://b.example/v1", consent: agreedFor("b.example") }) });
    const s = createProviderService({ settings, admin: () => NONE, keys, consented: () => true, fetch: ok200(), log: { info() {}, warn() {} }, changed: () => undefined });
    await s.ensureKey();
    expect(s.key()).toBeNull();
  });
});

describe("Home's provider changes (S3)", () => {
  it("merge into the user's own settings, never writing back what the policy applied", () => {
    const own = provider({ baseUrl: "https://a.example/v1", conductor: "gpt-4.1", worker: "gpt-4.1", consent: agreedFor("a.example") });
    // Home's view had the policy applied (conductor nulled by models.allowed); it sends only the field it changed.
    const merged = withOwnProvider({ provider: { type: "azure" } as Settings["provider"] }, own).provider as Settings["provider"];
    expect(merged).toEqual({ ...own, type: "azure" });
    const page = readFileSync("app/renderer/home/provider.ts", "utf8");
    expect(page).toContain("return save({ provider: patch } as SettingsPatch);");
  });
});

describe("the keyring at a start (macOS second-instance hang in CI)", () => {
  it("is never asked while the user's provider is off, even with a key saved", async () => {
    const kr = box();
    const { s, keys, asked } = service({ settings: { baseUrl: "https://a.example/v1", on: false }, keyring: kr });
    await keys.save(KEY, "a.example");
    asked.length = 0;
    await s.ensureKey();
    s.settingsChanged();
    await providerStateOf({ settings: { provider: provider({ baseUrl: "https://a.example/v1", on: false }) } as Settings, admin: NONE, keys });
    expect(asked).toEqual([]);
  });

  it("a keyring that fails to answer doesn't hide whether the provider is in force and its host (the destination stays readable)", async () => {
    const own = provider({ baseUrl: "https://a.example/v1", on: true, consent: agreedFor("a.example") });
    const keys = { savedHost: () => null, canPersist: async () => { throw new Error("keyring broke"); } };
    const st = await providerStateOf({ settings: { provider: own } as Settings, admin: NONE, keys });
    expect(st).toMatchObject({ inForce: true, host: "a.example", keyring: false });
  });

  it("is never asked synchronously on macOS (asyncKeyring): isEncryptionAvailable fetches the Keychain on the main thread", async () => {
    const dir = tmp();
    const asked: string[] = [];
    const kr: SecretBox = {
      isEncryptionAvailable: () => { throw new Error("sync keychain access"); },
      encryptString: () => { throw new Error("sync keychain access"); },
      decryptString: () => { throw new Error("sync keychain access"); },
      isAsyncEncryptionAvailable: async () => { asked.push("isAsyncEncryptionAvailable"); return true; },
      encryptStringAsync: async t => { asked.push("encryptStringAsync"); return Buffer.from([...t].reverse().join("")); },
      decryptStringAsync: async b => { asked.push("decryptStringAsync"); return { result: [...b.toString()].reverse().join(""), shouldReEncrypt: false }; },
    };
    const keys = new ProviderKeyStore(path.join(dir, "provider-key.bin"), kr, { asyncKeyring: true });
    expect(await keys.canPersist()).toBe(true);
    expect(await keys.save(KEY, "a.example")).toMatchObject({ ok: true, keyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await keys.load()).toEqual({ key: KEY, host: "a.example", keyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(asked).toEqual(["isAsyncEncryptionAvailable", "isAsyncEncryptionAvailable", "encryptStringAsync", "decryptStringAsync"]);
  });

  it("reads the key only once the provider is on and agreed with a key saved for its host", async () => {
    const { s, settings, keys, asked } = service({ settings: { baseUrl: "https://a.example/v1", on: false } });
    await keys.save(KEY, "a.example");
    asked.length = 0;
    s.api.agree("a.example");
    expect(settings.own().provider.on).toBe(true);
    await s.ensureKey();
    expect(asked).toEqual(["decryptString"]);
    expect(s.key()).toEqual({ key: KEY, host: "a.example", keyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("isn't touched by main.ts before the single-instance check", () => {
    const main = readFileSync("app/main/main.ts", "utf8");
    const lock = main.indexOf("app.requestSingleInstanceLock()");
    expect(lock).toBeGreaterThan(0);
    // The key store that can ask the keyring is made inside start(), which runs only once the lock is held; the setup
    // check (its own process, --doctor) only reads the host beside the key file, which asks no keyring.
    const start = main.indexOf("function start(): void {");
    expect(main.indexOf("const providers = createProviderService({")).toBeGreaterThan(start);
    expect(main.indexOf("providers.ensureKey()")).toBeGreaterThan(start);
    const before = main.slice(0, start);
    expect(before.match(/new ProviderKeyStore\([^\n]*/g) ?? []).toEqual([expect.stringMatching(/\)\.savedHost\(\)\);$/)]);
    expect(main).not.toMatch(/providerKeys\.canPersist\(\)|safeStorage\.isEncryptionAvailable\(\)/);
  });
});

describe("the runtime's address, the logs and images (N1, N3, N6)", () => {
  it("passes the address as the URL parser writes it", () => {
    expect(userProviderConfig(provider({ baseUrl: "https://API.Example.com/v1" }), null).baseUrl).toBe("https://api.example.com/v1");
    expect(userProviderConfig(provider({ baseUrl: "https://api.anthropic.com", type: "anthropic" }), null).baseUrl).toBe("https://api.anthropic.com/");
  });

  it("redacts the key from every logged message and field, errors and children included", () => {
    const lines: unknown[] = [];
    const base: Logger = {
      debug: (m, f) => lines.push([m, f]), info: (m, f) => lines.push([m, f]), warn: (m, f) => lines.push([m, f]), error: (m, f) => lines.push([m, f]),
      child() { return base; }, file: "x",
    };
    const log = redactingLogger(base, () => KEY).child("agent");
    log.error(`agent.start_failed ${KEY}`, { err: new Error(`401 for key ${KEY}`), body: { headers: [`Bearer ${KEY}`] } });
    const text = JSON.stringify(lines, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
    expect(text).not.toContain(KEY);
    expect(text).toContain("[key]");
    expect(redact("nothing here", KEY)).toBe("nothing here");
    expect(redact(`a ${KEY} b`, null)).toBe(`a ${KEY} b`);
  });

  it("says a model can't read images instead of the service's raw refusal", () => {
    expect(friendlyError("400 Invalid content type. image_url is only supported by certain models.", undefined, { provider: "user" }))
      .toBe("This model can't read images. Choose a model for tasks that understands images in Ember's settings (Ctrl+Alt+E).");
    expect(friendlyError("400 model does not support image input", undefined, { provider: "user" }))
      .toBe("This model can't read images. Choose a model for tasks that understands images in Ember's settings (Ctrl+Alt+E).");
    expect(friendlyError("400 Invalid image: multimodal input not supported", undefined, { provider: "user" }))
      .toBe("This model can't read images. Choose a model for tasks that understands images in Ember's settings (Ctrl+Alt+E).");
  });
});

describe("the re-review's nits (#136)", () => {
  it("says a key is saved in the setup check only when it was saved for the endpoint's host", () => {
    const text = JSON.stringify(SettingsSchema.parse({ provider: provider({ baseUrl: "https://a.example/v1", consent: agreedFor("a.example") }) }));
    expect(ownProviderAuth(text, NONE, "a.example")).toEqual({ kind: "own-provider", host: "a.example", key: true });
    expect(ownProviderAuth(text, NONE, "b.example")).toEqual({ kind: "own-provider", host: "a.example", key: false });
    expect(ownProviderAuth(text, NONE, null)).toEqual({ kind: "own-provider", host: "a.example", key: false });
  });

  it("keeps redacting a key replaced or removed this run, as a task may still run on it", async () => {
    const { s } = service({ settings: { baseUrl: "https://a.example/v1" } });
    s.api.agree("a.example");
    const first = "sk-" + "1".repeat(40), second = "sk-" + "2".repeat(40);
    await s.api.saveKey(first, "a.example");
    await s.api.saveKey(second, "a.example");
    expect(s.secrets()).toEqual([second, first]);
    s.api.removeKey();
    expect([...s.secrets()].sort()).toEqual([first, second].sort());
    const lines: string[] = [];
    const base: Logger = { debug() {}, info() {}, warn() {}, error: m => lines.push(m), child() { return base; }, file: "x" };
    redactingLogger(base, () => s.secrets()).error(`refused ${first} then ${second}`);
    expect(lines).toEqual(["refused [key] then [key]"]);
  });

  it("asks main to say it is reading the key only when it is about to (the provider on, a key saved for its host)", async () => {
    const { s, settings, keys } = service({ settings: { baseUrl: "https://a.example/v1", on: false } });
    await keys.save(KEY, "a.example");
    expect(s.needsRead()).toBe(false);
    s.api.agree("a.example");
    expect(settings.own().provider.on).toBe(true);
    expect(s.needsRead()).toBe(true);
    await s.ensureKey();
    expect(s.needsRead()).toBe(false);
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain('if (!provider && providers.needsRead()) {\n        setStatus("keychain", "Reading your saved API key…");');
  });
});

describe("the card's I agree, armed as Ember's questions are (third review #136)", () => {
  const clock = () => { let t = 0; return { now: () => t, go: (ms: number) => { t += ms; } }; };

  it("agrees to nothing when the card is redrawn for another host between the press and the release", () => {
    const c = clock();
    const g = new AgreeGuard(c.now);
    g.drawn("a.example");
    c.go(AGREE_ARM_MS + 100);
    g.press();
    // Pressing blurred the address field: its save redrew the card for b.example before the click landed.
    g.drawn("b.example");
    c.go(AGREE_ARM_MS + 100);
    expect(g.activate()).toBeNull();
    // Read and pressed again for b.example: that one agrees.
    g.press();
    expect(g.activate()).toBe("b.example");
  });

  it("ignores an agree within 500 ms of a redraw for another host, as confirm.ts's arm delay does", () => {
    const c = clock();
    const g = new AgreeGuard(c.now);
    g.drawn("a.example");
    c.go(1000);
    g.drawn("b.example");
    c.go(AGREE_ARM_MS - 1);
    g.press();
    expect(g.activate()).toBeNull();
    c.go(1);
    g.press();
    expect(g.activate()).toBe("b.example");
    // Drawn again for the same host: no new delay.
    g.drawn("b.example");
    g.press();
    expect(g.activate()).toBe("b.example");
    expect(AGREE_ARM_MS).toBe(500);
  });

  it("agrees to nothing when the card was redrawn at all between the press and the click, even for the same host (fourth review #136)", () => {
    const c = clock();
    const g = new AgreeGuard(c.now);
    g.drawn("a.example");
    c.go(AGREE_ARM_MS);
    g.press();
    g.drawn("a.example");
    expect(g.activate()).toBeNull();
    g.press();
    expect(g.activate()).toBe("a.example");
  });

  it("takes an activation with no press (a screen reader's) as pressed now, and nothing with no card up", () => {
    const c = clock();
    const g = new AgreeGuard(c.now);
    expect(g.activate()).toBeNull();
    g.drawn("a.example");
    expect(g.activate()).toBeNull();
    c.go(AGREE_ARM_MS);
    expect(g.activate()).toBe("a.example");
    g.drawn(null);
    expect(g.activate()).toBeNull();
  });

  it("is wired to the button: the host taken at the press, the card's draws, and the agree only for the pressed host", () => {
    const page = readFileSync("app/renderer/home/provider.ts", "utf8");
    expect(page).toContain('$("byok-yes").addEventListener("pointerdown", () => agreeGuard.press());');
    expect(page).toContain("agreeGuard.drawn(cardHost);");
    expect(page).toContain("const pressedFor = agreeGuard.activate();");
    expect(page).toContain("const next = agreeAction(pressedFor, input(\"byok-url\").value);");
  });
});


describe("provider key lifecycle races", () => {
  it.each(["remove", "forget", "endpoint", "off"])("does not restore a pending read after %s", async action => {
    const { s, keys, settings, changed } = service({ settings: { baseUrl: "https://a.example/v1" } });
    await keys.save(KEY, "a.example");
    let release!: (key: { key: string; host: string }) => void;
    keys.load = () => new Promise(r => { release = r; });
    const pending = s.ensureKey();
    if (action === "remove") s.api.removeKey();
    if (action === "forget") s.forget();
    if (action === "endpoint") { settings.update({ provider: provider({ baseUrl: "https://b.example/v1" }) }); s.settingsChanged(); }
    if (action === "off") { settings.update({ provider: provider({ baseUrl: "https://a.example/v1", on: false }) }); s.settingsChanged(); }
    changed.mockClear();
    release({ key: KEY, host: "a.example" });
    await pending;
    expect(s.key()).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(["remove", "forget", "endpoint"])("does not restore a pending save after %s", async action => {
    const { s, keys, settings, changed } = service({ settings: { baseUrl: "https://a.example/v1" } });
    const save = keys.save.bind(keys);
    let release!: () => void;
    keys.save = async (key, host) => { await new Promise<void>(r => { release = r; }); return save(key, host); };
    const pending = s.api.saveKey(KEY, "a.example");
    await Promise.resolve();
    if (action === "remove") s.api.removeKey();
    if (action === "forget") s.forget();
    if (action === "endpoint") { settings.update({ provider: provider({ baseUrl: "https://b.example/v1" }) }); s.settingsChanged(); }
    changed.mockClear();
    release();
    expect((await pending).ok).toBe(false);
    expect(s.key()).toBeNull();
    expect(keys.savedHost()).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not write sealed bytes after clearing a keyring save", async () => {
    let release!: (bytes: Buffer) => void;
    const kr = box({ encryptStringAsync: () => new Promise(r => { release = r; }) });
    const keys = new ProviderKeyStore(path.join(tmp(), "provider-key.bin"), kr.box, { asyncKeyring: true });
    const pending = keys.save(KEY, "a.example");
    await Promise.resolve();
    keys.clear();
    release(Buffer.from("sealed"));
    expect((await pending).ok).toBe(false);
    expect(keys.savedHost()).toBeNull();
  });
});

describe("overlapping provider operations", () => {
  it("keeps the newer save when an older save finishes after Remove", async () => {
    const { s, keys } = service({ settings: { baseUrl: "https://a.example/v1" } });
    const save = keys.save.bind(keys);
    let release!: () => void;
    let first = true;
    keys.save = async (key, host) => {
      if (first) { first = false; await new Promise<void>(r => { release = r; }); }
      return save(key, host);
    };
    const old = s.api.saveKey(KEY, "a.example");
    await Promise.resolve();
    s.api.removeKey();
    const newer = s.api.saveKey(KEY + "new", "a.example");
    release();
    expect((await old).ok).toBe(false);
    expect((await newer).ok).toBe(true);
    expect(s.key()?.key).toBe(KEY + "new");
    expect((await keys.load())?.key).toBe(KEY + "new");
  });

  it("sends no connection test after consent is revoked during its key read", async () => {
    const { s, keys, settings, fetch } = service({ settings: { baseUrl: "https://a.example/v1", consent: agreedFor("a.example") } });
    await keys.save(KEY, "a.example");
    let release!: (key: null) => void;
    keys.load = () => new Promise(r => { release = r; });
    const pending = s.api.test();
    settings.update({ provider: provider({ baseUrl: "https://b.example/v1" }) });
    s.settingsChanged();
    release(null);
    expect((await pending).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("the provider keyring write boundary", () => {
  it("writes nothing when consent changes while encryption waits", async () => {
    let release!: (bytes: Buffer) => void;
    let current = true;
    const kr = box({ encryptStringAsync: () => new Promise(r => { release = r; }) });
    const file = path.join(tmp(), "provider-key.bin");
    const keys = new ProviderKeyStore(file, kr.box, { asyncKeyring: true });
    const pending = keys.save(KEY, "a.example", () => current);
    await Promise.resolve();
    current = false;
    release(Buffer.from("sealed"));
    expect((await pending).ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("the key id of a key just saved (PR #188 re-review 3)", () => {
  it("the live key carries the same id that was sealed with it, so history can be owned at once", async () => {
    const { s, keys, settings } = service({ settings: { baseUrl: "https://a.example/v1" } });
    s.api.agree("a.example");
    expect(await s.api.saveKey(KEY, "a.example")).toEqual({ ok: true }); // (the id never goes to the page)
    const sealed = await keys.load();
    expect(sealed?.keyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.key()).toEqual({ key: KEY, host: "a.example", keyId: sealed?.keyId });
    expect(activeProvider({ fixed: null, settings: settings.get(), admin: NONE, key: s.key() })?.keyId).toBe(sealed?.keyId);
  });

  it("saving the same key again makes a new id, and the live key follows it", async () => {
    const { s, keys } = service({ settings: { baseUrl: "https://a.example/v1" } });
    s.api.agree("a.example");
    await s.api.saveKey(KEY, "a.example");
    const first = s.key()?.keyId;
    await s.api.saveKey(KEY, "a.example");
    const second = s.key()?.keyId;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect((await keys.load())?.keyId).toBe(second);
  });
});
