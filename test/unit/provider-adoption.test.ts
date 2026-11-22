/**
 * The user's own provider, replaced while it works (integrations-r7-1): a new address and the key typed for it are kept
 * together or not at all, so a key that can't be saved never leaves the new host keyless and the working provider's
 * key deleted; and a same-host key whose replacement can't be written leaves the key in use as it was
 * (integrations-v7-1). Run against a real SettingsStore and ProviderKeyStore, wired as main wires them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { SettingsSchema, SettingsStore, type Settings } from "../../app/main/settings";
import { KEY_WRITE_FAILED, PROVIDER_HOST_CHANGED, ProviderKeyStore, createProviderService, providerNotRecorded, type FetchLike } from "../../app/main/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import type { SecretBox } from "../../app/main/agent/auth";

const OLD_KEY = "sk-" + "a".repeat(40); // not a real key
const NEW_KEY = "sk-" + "b".repeat(40); // not a real key
const NONE: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const agreed = (host: string) => ({ version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-09T10:00:00Z", host });
const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from([...s].reverse().join("")),
  decryptString: x => [...x.toString()].reverse().join(""),
  getSelectedStorageBackend: () => "gnome_libsecret",
};
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** The provider in force at a.example with its key saved, the service listening to the settings as main's does. */
async function working() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-provider-adoption-"));
  dirs.push(dir);
  const settings = new SettingsStore(path.join(dir, "settings.json"));
  settings.load();
  settings.update({ provider: SettingsSchema.shape.provider.parse({ on: true, type: "openai", baseUrl: "https://a.example/v1", conductor: "m", consent: agreed("a.example") }) });
  const file = path.join(dir, "provider-key.bin");
  const keys = new ProviderKeyStore(file, box);
  const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
  const recorded: string[] = [];
  // As provider-record.ts: every change of the yes goes through as(); held() once a yes couldn't be recorded (`failNext`).
  let held = false, failNext = false;
  const record = { as: <T,>(change: () => T): T => { const out = change(); recorded.push(settings.own().provider.consent.host ?? ""); held = failNext; failNext = false; return out; }, held: () => held };
  const s = createProviderService({ settings, admin: () => NONE, keys, consented: () => true, fetch, log: { info() {}, warn() {} }, changed: () => undefined, record });
  settings.onChange(() => s.settingsChanged());
  expect(await s.api.saveKey(OLD_KEY)).toEqual({ ok: true });
  /** The next write of a file in the data folder whose name starts so fails, as a full disk does. */
  const failWrites = (prefix: string) => {
    const full = (f: unknown) => typeof f === "string" && path.basename(f).startsWith(prefix);
    const write = fs.writeFileSync, open = fs.openSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (full(f)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      return (write as (...a: unknown[]) => void)(f, ...rest);
    }) as typeof fs.writeFileSync);
    // The settings are written through a descriptor (SettingsStore.save).
    vi.spyOn(fs, "openSync").mockImplementation(((f: fs.PathLike, ...rest: unknown[]) => {
      if (full(f)) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      return (open as (...a: unknown[]) => number)(f, ...rest);
    }) as typeof fs.openSync);
  };
  /** What a fresh start would find: the settings on disk and the key the keyring opens for their host. */
  const restart = async () => {
    const again = new SettingsStore(path.join(dir, "settings.json"));
    again.load();
    const loaded = await new ProviderKeyStore(file, box).load();
    return { provider: again.own().provider as Settings["provider"], key: loaded };
  };
  return { s, settings, keys, fetch, recorded, failWrites, restart, dir, failRecord: () => { failNext = true; } };
}

const MOVE = { type: "openai" as const, baseUrl: "https://b.example/v1", conductor: "m", worker: null };

describe("replacing the provider in use (integrations-r7-1)", () => {
  it("keeps the working provider and its key when the new host's key can't be saved", async () => {
    const w = await working();
    w.failWrites("provider-key");
    const r = await w.s.api.adopt({ from: "a.example", host: "b.example", move: MOVE, key: NEW_KEY });
    expect(r).toEqual({ ok: false, why: KEY_WRITE_FAILED });
    vi.restoreAllMocks();
    expect(w.settings.own().provider).toMatchObject({ on: true, baseUrl: "https://a.example/v1", consent: { host: "a.example" } });
    expect(w.s.key()).toMatchObject({ key: OLD_KEY, host: "a.example" });
    expect(w.keys.savedHost()).toBe("a.example");
    expect(await w.restart()).toMatchObject({ provider: { baseUrl: "https://a.example/v1" }, key: { key: OLD_KEY, host: "a.example" } });
    // Nothing went to the new host as the provider in force: its yes was never written.
    expect(w.recorded).not.toContain("b.example");
  });

  it("keeps the working provider and its key when the settings can't be saved, and leaves no copy of the new key", async () => {
    const w = await working();
    w.failWrites("settings.json");
    // Thrown as agree() throws it: the IPC answers its plain sentence, and the settings store's notice says why.
    await expect(w.s.api.adopt({ from: "a.example", host: "b.example", move: MOVE, key: NEW_KEY })).rejects.toThrow();
    vi.restoreAllMocks();
    expect(w.s.key()).toMatchObject({ key: OLD_KEY, host: "a.example" });
    expect(await w.restart()).toMatchObject({ provider: { baseUrl: "https://a.example/v1" }, key: { key: OLD_KEY, host: "a.example" } });
    expect(fs.readdirSync(w.dir).filter(f => f.startsWith("provider-key"))).toEqual(["provider-key.bin", "provider-key.host"]);
  });

  it("moves to the new host and its key together once both are saved", async () => {
    const w = await working();
    expect(await w.s.api.adopt({ from: "a.example", host: "b.example", move: MOVE, key: NEW_KEY })).toEqual({ ok: true });
    expect(w.settings.own().provider).toMatchObject({ on: true, baseUrl: "https://b.example/v1", consent: { host: "b.example" } });
    expect(w.s.key()).toMatchObject({ key: NEW_KEY, host: "b.example" });
    expect(await w.restart()).toMatchObject({ provider: { baseUrl: "https://b.example/v1" }, key: { key: NEW_KEY, host: "b.example" } });
    expect(w.recorded).toContain("b.example");
    // The old key is still redacted from the log: a task may still run on it.
    expect(w.s.secrets()).toEqual([NEW_KEY, OLD_KEY]);
  });

  it("moves with no key typed, and the old host's key goes with the old host", async () => {
    const w = await working();
    expect(await w.s.api.adopt({ from: "a.example", host: "b.example", move: MOVE })).toEqual({ ok: true });
    expect(w.settings.own().provider.baseUrl).toBe("https://b.example/v1");
    expect(w.keys.savedHost()).toBeNull();
    expect(w.s.key()).toBeNull();
  });

  it("keeps the saved key for an edit of the same host with no key typed", async () => {
    const w = await working();
    expect(await w.s.api.adopt({ from: "a.example", host: "a.example", move: { ...MOVE, baseUrl: "https://a.example/v2" } })).toEqual({ ok: true });
    expect(w.settings.own().provider.baseUrl).toBe("https://a.example/v2");
    expect(w.s.key()).toMatchObject({ key: OLD_KEY, host: "a.example" });
  });

  it("puts the working provider and its key back when the record can't take the new yes (integrations-r11-1)", async () => {
    const w = await working();
    w.failRecord();
    expect(await w.s.api.adopt({ from: "a.example", host: "b.example", move: MOVE, key: NEW_KEY })).toEqual({ ok: false, why: providerNotRecorded("b.example") });
    expect(w.settings.own().provider).toMatchObject({ baseUrl: "https://a.example/v1", consent: { host: "a.example" } });
    expect(w.s.key()).toMatchObject({ key: OLD_KEY, host: "a.example" });
    expect(await w.restart()).toMatchObject({ provider: { baseUrl: "https://a.example/v1" }, key: { key: OLD_KEY, host: "a.example" } });
    // Each change of the provider in force went through the record: the move, and the move back.
    expect(w.recorded).toEqual(["b.example", "a.example"]);
  });

  it("adopts nothing once the provider in use isn't the one the edit began from", async () => {
    const w = await working();
    expect(await w.s.api.adopt({ from: "c.example", host: "b.example", move: MOVE, key: NEW_KEY })).toEqual({ ok: false, why: PROVIDER_HOST_CHANGED });
    expect(await w.s.api.adopt({ from: "a.example", host: "c.example", move: MOVE, key: NEW_KEY })).toEqual({ ok: false, why: PROVIDER_HOST_CHANGED });
    expect(w.settings.own().provider.baseUrl).toBe("https://a.example/v1");
    expect(w.s.key()).toMatchObject({ key: OLD_KEY });
  });
});

describe("an adoption a Remove overtakes while the keyring seals its key (integrations-r7-1)", () => {
  it("puts nothing in place: Remove stands, and the provider stays where it was", async () => {
    const w = await working();
    let release!: () => void;
    const sealing = new Promise<void>(r => { release = r; });
    // The keyring answers only after Remove was pressed.
    const realStage = w.keys.stage.bind(w.keys);
    vi.spyOn(w.keys, "stage").mockImplementation(async (...a) => { await sealing; return realStage(...a); });
    const pending = w.s.api.adopt({ from: "a.example", host: "b.example", move: MOVE, key: NEW_KEY });
    w.s.api.removeKey();
    release();
    expect(await pending).toEqual({ ok: false, why: PROVIDER_HOST_CHANGED });
    expect(w.keys.savedHost()).toBeNull();
    expect(w.settings.own().provider.baseUrl).toBe("https://a.example/v1");
  });
});

describe("replacing the key of the host in use (integrations-v7-1)", () => {
  it("keeps the key in use when its replacement can't be written", async () => {
    const w = await working();
    w.failWrites("provider-key");
    expect(await w.s.api.saveKey(NEW_KEY)).toEqual({ ok: false, why: KEY_WRITE_FAILED });
    vi.restoreAllMocks();
    expect(w.keys.savedHost()).toBe("a.example");
    expect(w.s.key()).toMatchObject({ key: OLD_KEY, host: "a.example" });
    expect(await w.restart()).toMatchObject({ key: { key: OLD_KEY, host: "a.example" } });
  });
});
