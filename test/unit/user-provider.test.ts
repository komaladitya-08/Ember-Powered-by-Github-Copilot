/**
 * The user's own model provider ("bring your own key"): its settings and their checks, precedence with the
 * administrator's policy (their provider always wins; `features.userProvider` and LOCKDOWN turn it off), the key kept
 * only with a real keyring and never in settings, logs or answers, Home's IPC checks, and "Test connection".
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminPolicySchema, applyAdminPolicy, managedKeys, parseAdminPolicy, userProviderAllowed, type LoadedAdminPolicy } from "../../app/main/admin";
import { DEFAULT_SETTINGS, SettingsSchema, SettingsStore, repairSettings, type Settings } from "../../app/main/settings";
import {
  KEY_NO_KEYRING, ProviderKeyStore, TEST_IDS_MAX, activeProvider, apiKeyProblem, checkAgain, listedModelIds, providerSummary, testConnection, testRequest, userProviderConfig, userProviderFromFile,
  userProviderInForce, type FetchLike,
} from "../../app/main/provider";
import { PROVIDER_BAD_REQUEST, PROVIDER_FAILED, registerProviderIpc, type ProviderApi, type ProviderIpcEvent } from "../../app/main/provider-ipc";
import { endpointHost, endpointProblem, keyNeeded } from "../../app/shared/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { PROVIDER_IPC } from "../../app/shared/ipc";
import type { SecretBox } from "../../app/main/agent/auth";
import { friendlyError, problemTitle } from "../../app/main/agent/presenter";
import { doctorChecks } from "../../app/main/doctor";
import { wslConsent } from "../../app/main/targets/consent";

const KEY = "sk-" + "k".repeat(40); // not a real key
const STORED = { key: KEY, host: "models.example.com" };
const NONE: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const policy = (p: object): LoadedAdminPolicy => parseAdminPolicy(JSON.stringify(p), "/etc/ember/policy.json");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-provider-"));

/** Settings with the user's provider on, agreed to for its host. */
function withProvider(p: Partial<Settings["provider"]> = {}): Settings {
  const baseUrl = p.baseUrl ?? "https://models.example.com/v1";
  return SettingsSchema.parse({
    provider: { on: true, type: "openai", baseUrl, conductor: "gpt-4.1", consent: { version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-02T10:00:00Z", host: endpointHost(baseUrl) }, ...p },
  });
}

/** A keyring that seals by reversing (only so the file isn't the key as written). */
const box = (o: Partial<SecretBox> = {}): SecretBox => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from([...s].reverse().join("")),
  decryptString: b => [...b.toString()].reverse().join(""),
  getSelectedStorageBackend: () => "gnome_libsecret",
  ...o,
});

describe("the own provider's endpoint", () => {
  it("takes https anywhere, and plain http only on this computer (local model servers)", () => {
    expect(endpointProblem("https://api.openai.com/v1")).toBeNull();
    expect(endpointProblem("http://localhost:11434/v1")).toBeNull();
    expect(endpointProblem("http://127.0.0.1:1234/v1")).toBeNull();
    expect(endpointProblem("http://[::1]:8080/v1")).toBeNull();
    expect(endpointProblem("http://models.example.com/v1")).toBe("Use an https:// address. Only a model server on this computer (localhost) may use http://.");
    expect(endpointProblem("http://192.168.1.5:11434")).not.toBeNull();
    expect(endpointProblem("ftp://models.example.com")).not.toBeNull();
    expect(endpointProblem("models.example.com")).not.toBeNull();
    expect(endpointProblem("")).not.toBeNull();
  });

  it("refuses a user name, a password, spaces or control characters in the address", () => {
    expect(endpointProblem(`https://user:${KEY}@models.example.com/v1`)).toBe("Leave the user name and password out of the address: put the key in API key.");
    expect(endpointProblem("https://models.example.com/v1 ")).not.toBeNull();
    expect(endpointProblem("https://models.example.com/\u0000v1")).not.toBeNull();
    expect(endpointProblem("https://x.com/" + "a".repeat(3000))).not.toBeNull();
  });

  it("needs no API key from a model server on this computer, and one from any other service (first-run-v2)", () => {
    for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1", "https://LOCALHOST:8443/v1"]) expect(keyNeeded(local), local).toBe(false);
    for (const remote of ["https://api.openai.com/v1", "https://localhost.example.com/v1", "https://127.0.0.1.example.com/v1", "", "not an address"]) expect(keyNeeded(remote), remote).toBe(true);
  });

  it("names the host with its port, lower-cased, and nothing for an address it refuses", () => {
    expect(endpointHost("https://Models.Example.com/v1")).toBe("models.example.com");
    expect(endpointHost("http://localhost:11434/v1")).toBe("localhost:11434");
    expect(endpointHost("http://evil.example.com/v1")).toBeNull();
  });
});

describe("settings › provider", () => {
  it("is off by default, with no address, models or agreement", () => {
    expect(DEFAULT_SETTINGS.provider).toEqual({ on: false, type: "openai", baseUrl: "", wireApi: null, azureApiVersion: null, conductor: null, worker: null, consent: { version: 0, at: null, host: "" } });
  });

  it("rejects an endpoint the rules refuse, a model id with spaces and an unknown type", () => {
    const base = DEFAULT_SETTINGS.provider;
    expect(SettingsSchema.shape.provider.safeParse({ ...base, baseUrl: "http://models.example.com/v1" }).success).toBe(false);
    expect(SettingsSchema.shape.provider.safeParse({ ...base, conductor: "gpt 4" }).success).toBe(false);
    expect(SettingsSchema.shape.provider.safeParse({ ...base, type: "gemini" }).success).toBe(false);
    expect(SettingsSchema.shape.provider.safeParse({ ...base, azureApiVersion: "2024-10-21; rm" }).success).toBe(false);
    expect(SettingsSchema.shape.provider.safeParse({ ...base, baseUrl: "http://127.0.0.1:11434/v1", conductor: "llama3.2:3b" }).success).toBe(true);
  });

  it("repairs a bad address alone, keeping the rest of the group", () => {
    const s = repairSettings({ provider: { on: true, type: "anthropic", baseUrl: "http://far.example.com", conductor: "claude-sonnet-4-5" } });
    expect(s.provider).toMatchObject({ on: true, type: "anthropic", baseUrl: "", conductor: "claude-sonnet-4-5" });
  });

  it("never keeps an API key in settings.json, even one sent with the group", () => {
    const dir = tmp();
    const store = new SettingsStore(path.join(dir, "settings.json"));
    store.load();
    store.update({ provider: { ...withProvider().provider, apiKey: KEY } as Settings["provider"] });
    const text = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
    expect(text).not.toContain(KEY);
    expect(text).toContain("models.example.com");
    expect(JSON.stringify(store.get())).not.toContain(KEY);
  });
});

describe("which endpoint is in force", () => {
  it("is the user's while it is on, has a usable address and was agreed to for that very host", () => {
    expect(userProviderInForce(withProvider(), NONE)?.baseUrl).toBe("https://models.example.com/v1");
    expect(userProviderInForce(withProvider({ on: false }), NONE)).toBeNull();
    expect(userProviderInForce(withProvider({ consent: { version: 0, at: null, host: "models.example.com" } }), NONE)).toBeNull();
    // Agreed to for another host: the card asks again before anything goes to this one.
    expect(userProviderInForce(withProvider({ consent: { version: 1, at: "x", host: "other.example.com" } }), NONE)).toBeNull();
    expect(userProviderInForce(SettingsSchema.parse({ provider: { on: true, consent: { version: 1, at: "x", host: "" } } }), NONE)).toBeNull();
  });

  it("gives way to the organisation's own provider, which always wins", () => {
    const admin = policy({ provider: { type: "azure", baseUrl: "https://corp.openai.azure.com" } });
    const fixed = { kind: "admin" as const, config: { type: "azure" as const, baseUrl: "https://corp.openai.azure.com" } };
    expect(userProviderAllowed(admin.policy)).toBe(false);
    expect(userProviderInForce(withProvider(), admin)).toBeNull();
    expect(activeProvider({ fixed, settings: withProvider(), admin, key: STORED })).toBe(fixed);
    expect(managedKeys(admin.policy)).toEqual(expect.arrayContaining(["provider", "userProvider"]));
    expect(applyAdminPolicy(withProvider(), admin.policy).provider.on).toBe(false);
  });

  it("is off and managed where the administrator turned it off", () => {
    const admin = policy({ features: { userProvider: false } });
    expect(userProviderInForce(applyAdminPolicy(withProvider(), admin.policy), admin)).toBeNull();
    expect(applyAdminPolicy(withProvider(), admin.policy).provider.on).toBe(false);
    expect(managedKeys(admin.policy)).toContain("userProvider");
    expect(managedKeys(NONE.policy)).not.toContain("userProvider");
  });

  it("is off under LOCKDOWN, from a policy that can't be read (fail closed)", () => {
    const broken = parseAdminPolicy("{ not json", "/etc/ember/policy.json");
    expect(broken.error).toBeDefined();
    expect(broken.policy.features.userProvider).toBe(false);
    expect(userProviderInForce(withProvider(), broken)).toBeNull();
    // Even a lockdown whose features said nothing: a policy with a problem never lets the user's provider in.
    expect(userProviderInForce(withProvider(), { ...NONE, error: "broken" })).toBeNull();
  });

  it("holds the user's model ids to the administrator's allowed list and pinned models", () => {
    const allowed = policy({ models: { allowed: ["gpt-4.1-mini"] } });
    const s = applyAdminPolicy(withProvider({ conductor: "gpt-4.1", worker: "gpt-4.1-mini" }), allowed.policy);
    expect(s.provider).toMatchObject({ conductor: null, worker: "gpt-4.1-mini" });
    const pinned = policy({ models: { conductor: "gpt-4.1-mini" } });
    expect(applyAdminPolicy(withProvider(), pinned.policy).provider.conductor).toBe("gpt-4.1-mini");
  });

  it("builds the runtime's provider config with the key only there, and summarises it by host alone", () => {
    const p = activeProvider({ fixed: null, settings: withProvider({ wireApi: "responses" }), admin: NONE, key: STORED })!;
    expect(p).toEqual({ kind: "user", config: { type: "openai", baseUrl: "https://models.example.com/v1", apiKey: KEY, wireApi: "responses" }, models: { conductor: "gpt-4.1", worker: null } });
    expect(JSON.stringify(providerSummary(p))).not.toContain(KEY);
    expect(providerSummary(p)).toEqual({ kind: "user", host: "models.example.com" });
    // A local server that needs no key: none is sent.
    expect(userProviderConfig(withProvider({ baseUrl: "http://127.0.0.1:11434/v1" }).provider, null)).toEqual({ type: "openai", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(userProviderConfig(withProvider({ type: "azure", azureApiVersion: "2024-10-21" }).provider, STORED).azure).toEqual({ apiVersion: "2024-10-21" });
    expect(userProviderConfig(withProvider({ type: "anthropic", wireApi: "responses" }).provider, STORED).wireApi).toBeUndefined();
  });

  it("is what the setup check reads from the settings file on disk", () => {
    expect(userProviderFromFile(JSON.stringify(withProvider()), NONE)?.baseUrl).toBe("https://models.example.com/v1");
    expect(userProviderFromFile(JSON.stringify(withProvider()), policy({ features: { userProvider: false } }))).toBeNull();
    expect(userProviderFromFile("{ not json", NONE)).toBeNull();
    expect(userProviderFromFile(null, NONE)).toBeNull();
  });
});

describe("the API key's store", () => {
  it("refuses to keep a key where the keyring is basic_text, saying why in plain words, and writes nothing", async () => {
    const dir = tmp();
    const store = new ProviderKeyStore(path.join(dir, "provider-key.bin"), box({ getSelectedStorageBackend: () => "basic_text" }));
    expect(await store.canPersist()).toBe(false);
    expect(await store.save(KEY, "models.example.com")).toEqual({ ok: false, why: KEY_NO_KEYRING });
    expect(KEY_NO_KEYRING).toMatch(/no keyring/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses where the keyring isn't available, or refuses to seal", async () => {
    const dir = tmp();
    expect(await new ProviderKeyStore(path.join(dir, "k.bin"), box({ isEncryptionAvailable: () => false })).save(KEY, "models.example.com")).toEqual({ ok: false, why: KEY_NO_KEYRING });
    expect(await new ProviderKeyStore(path.join(dir, "k.bin"), box({ encryptString: () => { throw new Error("denied"); } })).save(KEY, "models.example.com")).toEqual({ ok: false, why: KEY_NO_KEYRING });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("seals the key in an owner-only file, reads it back, and Remove deletes it", async () => {
    const dir = tmp();
    const file = path.join(dir, "provider-key.bin");
    const store = new ProviderKeyStore(file, box());
    expect(await store.save(`  ${KEY}\n`, "models.example.com")).toMatchObject({ ok: true, keyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(store.savedHost()).toBe("models.example.com");
    expect(fs.readFileSync(file, "utf8")).not.toContain(KEY);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const loaded = await store.load();
    expect(loaded).toEqual({ ...STORED, keyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // Saving again makes another id (a replaced key never shares one with the old), and the id isn't derived from the key.
    await store.save(KEY, "models.example.com");
    expect((await store.load())!.keyId).not.toBe(loaded!.keyId);
    store.clear();
    expect(store.savedHost()).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await store.load()).toBeNull();
  });

  it("refuses what can't be a key: empty, with spaces or line breaks inside, or too long", async () => {
    expect(apiKeyProblem("")).not.toBeNull();
    expect(apiKeyProblem("sk-abc def")).toMatch(/no spaces or line breaks/);
    expect(apiKeyProblem("k".repeat(9000))).not.toBeNull();
    expect(apiKeyProblem(42)).not.toBeNull();
    expect(apiKeyProblem(KEY)).toBeNull();
  });

  it("gives null for a key the keyring won't open, keeping the file to try again", async () => {
    const dir = tmp();
    const file = path.join(dir, "k.bin");
    await new ProviderKeyStore(file, box()).save(KEY, "models.example.com");
    expect(await new ProviderKeyStore(file, box({ decryptString: () => { throw new Error("locked"); } })).load()).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("Home's provider channels", () => {
  const HOME = { sender: "home" };
  function wire(api: Partial<ProviderApi> = {}) {
    const handlers = new Map<string, (e: ProviderIpcEvent, ...a: unknown[]) => unknown>();
    const logs: unknown[] = [];
    const calls: string[] = [];
    const full: ProviderApi = {
      state: () => ({ allowed: true, managed: null, keySaved: false, keyring: true, inForce: false, host: null, agreed: false }),
      agree: () => { calls.push("agree"); return { ok: true }; },
      saveKey: async () => { calls.push("save"); return { ok: true }; },
      removeKey: () => { calls.push("remove"); return { ok: true }; },
      test: async () => ({ ok: true, host: "models.example.com", models: 3 }),
      ...api,
    };
    registerProviderIpc({ handle: (c, fn) => { handlers.set(c, fn); } }, e => e.sender === "home", full, { log: { warn: (ev, f) => logs.push([ev, f]) } });
    const call = (c: string, e: ProviderIpcEvent, ...a: unknown[]) => Promise.resolve(handlers.get(c)!(e, ...a));
    return { call, logs, calls };
  }

  it("answers only the settings window's own page", async () => {
    const { call, calls } = wire();
    for (const c of Object.values(PROVIDER_IPC).filter(c => c !== PROVIDER_IPC.changed)) {
      await expect(call(c, { sender: "overlay" }, KEY)).rejects.toThrow(/untrusted IPC sender/);
    }
    expect(calls).toEqual([]);
  });

  it("takes one string of key-like size for saveKey, and nothing for the others", async () => {
    const { call, calls } = wire();
    for (const bad of [[], [42], [""], ["k".repeat(9000)], [KEY, "extra"], [{ key: KEY }]]) {
      expect(await call(PROVIDER_IPC.saveKey, HOME, ...bad)).toEqual({ ok: false, why: PROVIDER_BAD_REQUEST });
    }
    expect(await call(PROVIDER_IPC.removeKey, HOME, "x")).toEqual({ ok: false, why: PROVIDER_BAD_REQUEST });
    expect(await call(PROVIDER_IPC.test, HOME, { url: "https://evil.example.com" })).toEqual({ ok: false, why: PROVIDER_BAD_REQUEST });
    // A draft of typed details (first-run-r2-1): its kind, address and agreed host, a key at most, and nothing else.
    const draft = { type: "openai", baseUrl: "https://b.example/v1", host: "b.example" };
    for (const bad of [{ ...draft, type: "other" }, { ...draft, host: "B EXAMPLE" }, { ...draft, baseUrl: "x".repeat(3000) }, { ...draft, key: "" }, { ...draft, key: "k".repeat(9000) }, { ...draft, on: true }, [draft, draft]]) {
      expect(await call(PROVIDER_IPC.test, HOME, ...(Array.isArray(bad) ? bad : [bad]))).toEqual({ ok: false, why: PROVIDER_BAD_REQUEST });
    }
    expect(await call(PROVIDER_IPC.state, HOME, 1)).toBeNull();
    expect(calls).toEqual([]);
    expect(await call(PROVIDER_IPC.saveKey, HOME, KEY)).toEqual({ ok: true });
    expect(await call(PROVIDER_IPC.removeKey, HOME)).toEqual({ ok: true });
    expect(calls).toEqual(["save", "remove"]);
  });

  it("passes a draft of typed details to the check, and none when there is none (first-run-r2-1)", async () => {
    const seen: unknown[] = [];
    const { call } = wire({ test: async d => { seen.push(d); return { ok: true, host: "b.example", models: 1 }; } });
    const draft = { type: "anthropic", baseUrl: "https://b.example/v1", host: "b.example", key: KEY };
    expect(await call(PROVIDER_IPC.test, HOME, draft)).toEqual({ ok: true, host: "b.example", models: 1 });
    expect(await call(PROVIDER_IPC.test, HOME)).toEqual({ ok: true, host: "b.example", models: 1 });
    expect(seen).toEqual([draft, undefined]);
  });

  it("never sends the key back, and never logs it, even when saving it fails", async () => {
    const { call, logs } = wire({ saveKey: async k => { throw new Error(`keyring refused ${k}`); } });
    const r = await call(PROVIDER_IPC.saveKey, HOME, KEY);
    expect(r).toEqual({ ok: false, why: PROVIDER_FAILED });
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).toContain("provider.ipc_failed");
    const state = await call(PROVIDER_IPC.state, HOME);
    expect(JSON.stringify(state)).not.toContain(KEY);
  });
});

describe("Check again", () => {
  it("connects to the model provider in force again, and never looks for or names a GitHub sign-in (integrations-c1-1)", async () => {
    const github = vi.fn(async () => ({ found: false, source: null, hint: "No GitHub sign-in found on this computer." }));
    const reconnect = vi.fn(async () => "error");
    expect(await checkAgain({ host: "127.0.0.1:18408" }, { reconnect, github })).toEqual({ found: false, source: null, provider: { host: "127.0.0.1:18408", ready: false } });
    reconnect.mockResolvedValueOnce("ready");
    expect(await checkAgain({ host: "127.0.0.1:18408" }, { reconnect, github })).toEqual({ found: false, source: null, provider: { host: "127.0.0.1:18408", ready: true } });
    expect(github).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledTimes(2);
    // GitHub Copilot in force: a GitHub sign-in is what it looks for.
    expect(await checkAgain(null, { reconnect, github })).toEqual({ found: false, source: null, hint: "No GitHub sign-in found on this computer." });
    expect(reconnect).toHaveBeenCalledTimes(2);
  });
});

describe("Test connection", () => {
  const settings = (p: Partial<Settings["provider"]> = {}) => withProvider(p).provider;
  const answer = (status: number, body: unknown = {}) => vi.fn<FetchLike>(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

  it("asks each kind of service for its model list, with its own key header", () => {
    expect(testRequest(settings(), KEY)).toEqual({ url: "https://models.example.com/v1/models", headers: { authorization: `Bearer ${KEY}` } });
    expect(testRequest(settings({ baseUrl: "https://corp.openai.azure.com/", type: "azure", azureApiVersion: "2025-04-01-preview" }), KEY))
      .toEqual({ url: "https://corp.openai.azure.com/openai/models?api-version=2025-04-01-preview", headers: { "api-key": KEY } });
    expect(testRequest(settings({ baseUrl: "https://api.anthropic.com", type: "anthropic" }), KEY))
      .toEqual({ url: "https://api.anthropic.com/v1/models", headers: { "anthropic-version": "2023-06-01", "x-api-key": KEY } });
    expect(testRequest(settings({ baseUrl: "http://localhost:11434/v1" }), null)).toEqual({ url: "http://localhost:11434/v1/models", headers: {} });
  });

  it("makes one GET that refuses redirects, so the key goes nowhere but the address entered", async () => {
    const fetch = answer(200, { data: [{ id: "a" }, { id: "b" }] });
    expect(await testConnection(settings(), STORED, fetch)).toEqual({ ok: true, host: "models.example.com", models: 2, ids: ["a", "b"] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("says in one sentence why it failed, never with the service's raw text or the key", async () => {
    expect(await testConnection(settings(), STORED, answer(401))).toEqual({ ok: false, why: "models.example.com didn't accept the API key. Check it, or replace it." });
    expect(await testConnection(settings(), null, answer(403))).toEqual({ ok: false, why: "models.example.com needs an API key." });
    expect(await testConnection(settings(), STORED, answer(404))).toEqual({ ok: false, why: "models.example.com answered, but has no model list at that address. Check the endpoint and the provider." });
    expect(await testConnection(settings(), STORED, answer(503))).toEqual({ ok: false, why: "Your model service had a problem on its side. Try again in a moment." });
    const thrown = vi.fn<FetchLike>(async () => { throw Object.assign(new TypeError(`fetch failed for ${KEY}`), { cause: { code: "ECONNREFUSED" } }); });
    const r = await testConnection(settings(), STORED, thrown);
    // Nothing listens there: said so as a cause too, which the status uses (integrations-1).
    expect(r).toEqual({ ok: false, why: "Ember can't reach models.example.com. Check the address and the network.", cause: "refused" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    const late = vi.fn<FetchLike>(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); });
    expect(await testConnection(settings(), STORED, late)).toEqual({ ok: false, why: "models.example.com didn't answer within 10 seconds.", cause: "timeout" });
    const lost = vi.fn<FetchLike>(async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); });
    expect(await testConnection(settings(), STORED, lost)).toMatchObject({ ok: false, cause: "unreachable" });
    const electron = vi.fn<FetchLike>(async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); });
    expect(await testConnection(settings(), STORED, electron)).toMatchObject({ ok: false, cause: "refused" });
  });

  it("names the models it lists, as suggestions, keeping only real ids and at most 50 (integrations-9)", async () => {
    const shown = await testConnection(settings(), STORED, answer(200, { data: [{ id: "gpt-4.1" }, { id: "has space" }, { id: "<b>x</b>" }, { id: "gpt-4.1" }, { id: 7 }, {}, { id: "o3-mini" }] }));
    expect(shown).toEqual({ ok: true, host: "models.example.com", models: 7, ids: ["gpt-4.1", "o3-mini"] });
    // Ollama's own list names them by name.
    expect(listedModelIds([{ name: "llama3.2:3b" }, { model: "qwen2.5:7b" }])).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `m-${i}` }));
    expect(listedModelIds(many)).toHaveLength(TEST_IDS_MAX);
    expect(TEST_IDS_MAX).toBe(50);
    // A list with none it can name says only how many.
    expect(await testConnection(settings(), STORED, answer(200, { data: [{ object: "model" }] }))).toEqual({ ok: true, host: "models.example.com", models: 1 });
  });

  it("makes no request without a usable address", async () => {
    const fetch = answer(200);
    expect(await testConnection({ ...settings(), baseUrl: "" }, STORED, fetch)).toEqual({ ok: false, why: "Enter the service's address first." });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("errors with the user's own provider", () => {
  it("point at the key in Ember's settings, not at a GitHub sign-in or an administrator", () => {
    expect(friendlyError("401 Unauthorized", undefined, { provider: "user" })).toBe("Your model service refused the request. Check its API key in Ember's settings (Ctrl+Alt+E).");
    expect(friendlyError("HTTP 502 bad gateway", undefined, { provider: "user" })).toBe("Your model service had a problem on its side. Try again in a moment.");
    expect(friendlyError("fetch failed ECONNREFUSED", undefined, { provider: "user" })).toBe("I can't reach your model service right now. Check the network, then ask again.");
    expect(problemTitle("I can't reach your model service right now.", "user")).toBe("I can't reach the model service");
    // A model server on this computer: is it running, not the network (integrations-1).
    const local = "I can't reach the model server on this computer. Is it running? Start it, then ask again.";
    expect(friendlyError("connect ECONNREFUSED 127.0.0.1:11434", undefined, { provider: "user", local: true })).toBe(local);
    expect(problemTitle(local, "user")).toBe("I can't reach the model service");
    expect(friendlyError("connect ECONNREFUSED 10.0.0.5:443", undefined, { provider: true, local: true })).toBe("I can't reach your organisation's model service right now. Check the network, then ask again.");
    // The organisation's wording is unchanged.
    expect(friendlyError("401 Unauthorized", undefined, { provider: true })).toBe("Your organisation's model service refused the request. Ask your administrator to check Ember's model service settings.");
  });
});

describe("ember doctor with the user's own provider", () => {
  it("names the provider by its host only, and whether a key is saved", () => {
    const checks = doctorChecks({
      os: "linux", env: { checks: [] } as never, compositor: true, xtest: true, speechDispatcher: true, microphones: null, voiceModels: "bundled", runtime: true,
      auth: { kind: "own-provider", host: "models.example.com", key: true }, admin: NONE,
    } as never);
    const row = checks.find(c => c.id === "copilot")!;
    expect(row).toMatchObject({ status: "ok", label: "Model service", detail: "Your own model provider (models.example.com), with its API key saved." });
  });

  it("warns when a provider elsewhere has no API key saved, and not for a model server on this computer (integrations-r3)", () => {
    const row = (host: string) => doctorChecks({
      os: "linux", env: { checks: [] } as never, compositor: true, xtest: true, speechDispatcher: true, microphones: null, voiceModels: "bundled", runtime: true,
      auth: { kind: "own-provider", host, key: false }, admin: NONE,
    } as never).find(c => c.id === "copilot")!;
    expect(row("api.openai.com")).toMatchObject({
      status: "warn", label: "Model service", detail: "Your own model provider (api.openai.com), with no API key saved.",
      fix: "If it needs a key, save it in Ember's settings, under Models & connections › Model provider.",
    });
    expect(row("127.0.0.1:11434")).toMatchObject({ status: "ok", detail: "Your own model provider (127.0.0.1:11434), with no API key saved." });
    expect(row("127.0.0.1:11434").fix).toBeUndefined();
  });
});

describe("the WSL, commands and SSH cards while the user's own provider is in force", () => {
  it("name the user's service by its host, not GitHub Copilot or the organisation's", () => {
    const body = (byok?: boolean | string) => wslConsent({ target: "local", targetLabel: "WSL", byok }).body.join(" ");
    expect(body("models.example.com")).toContain("goes to your model service (models.example.com)");
    expect(body(true)).toContain("goes to your organisation's model service");
    expect(body(false)).toContain("goes to GitHub Copilot");
  });
});
