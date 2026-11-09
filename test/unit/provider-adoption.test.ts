/** Replacing an in-use provider must preserve its endpoint and sealed key whenever adoption fails. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPolicySchema } from "../../app/main/admin";
import type { SecretBox } from "../../app/main/agent/auth";
import { createProviderService, ProviderKeyStore } from "../../app/main/provider";
import { SettingsSchema, SettingsStore } from "../../app/main/settings";
import type { ProviderMove } from "../../app/shared/ipc";

const dirs: string[] = [];
const OLD = "old-fixture-key", NEXT = "next-fixture-key";
const move: ProviderMove = { type: "openai", baseUrl: "https://b.example/v1" };
const request = { id: "draft-1", from: "a.example", host: "b.example", move, key: NEXT };

afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-adoption-")); dirs.push(dir);
  const settings = new SettingsStore(path.join(dir, "settings.json")); settings.load();
  settings.update({ provider: SettingsSchema.shape.provider.parse({ on: true, type: "openai", baseUrl: "https://a.example/v1", consent: { version: 1, at: "2026-11-09T00:00:00Z", host: "a.example" } }) });
  let fails = false, permitted = true, consented = true;
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  let sealing = false;
  const box: SecretBox = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: s => Buffer.from(s), decryptString: b => b.toString(), isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async s => { sealing = true; if (gate) await gate; if (fails) throw new Error("keyring refused"); return Buffer.from(s); },
    decryptStringAsync: async b => ({ result: b.toString(), shouldReEncrypt: false }) };
  const keyFile = path.join(dir, "provider-key.bin");
  const keys = new ProviderKeyStore(keyFile, box, { asyncKeyring: true });
  await keys.save(OLD, "a.example");
  const service = createProviderService({ settings, keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({ features: { userProvider: permitted } }) }),
    consented: () => consented, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
  settings.onChange(() => service.settingsChanged());
  await service.ensureKey();
  const adopt = () => service.api.adopt(request);
  return { settings, keys, service, adopt, box, dir, keyFile, failKey: () => { fails = true; },
    hold: () => { sealing = false; gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { release?.(); }, sealing: () => sealing,
    revoke: () => { permitted = false; }, unconsent: () => { consented = false; } };
}

describe("atomic provider adoption", () => {
  it("keeps the working endpoint and its key when the new key cannot be sealed (integrations-r7-1)", async () => {
    const h = await fixture(); h.failKey();
    expect(await h.adopt()).toMatchObject({ ok: false });
    expect(h.settings.get().provider.baseUrl).toBe("https://a.example/v1");
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
    expect(h.service.key()).toMatchObject({ key: OLD, host: "a.example" });
  });

  it("rolls back the staged key when the settings write fails (integrations-r7-1)", async () => {
    const h = await fixture();
    vi.spyOn(h.settings, "update").mockImplementation(() => { throw new Error("ENOSPC"); });
    const outcome = await h.adopt().catch(() => ({ ok: false }));
    expect(outcome).toMatchObject({ ok: false });
    expect(h.settings.get().provider.baseUrl).toBe("https://a.example/v1");
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
  });

  it("publishes the new host, consent and sealed key together on success (integrations-r7-1)", async () => {
    const h = await fixture();
    expect(await h.adopt()).toEqual({ ok: true });
    expect(h.settings.get().provider).toMatchObject({ baseUrl: move.baseUrl, consent: { host: "b.example" } });
    expect(await h.keys.load()).toMatchObject({ key: NEXT, host: "b.example" });
    expect(h.service.key()).toMatchObject({ key: NEXT, host: "b.example" });
  });

  it("keeps the old key when replacing a key on the same host cannot be published (integrations-v7-1)", async () => {
    const h = await fixture();
    const rename = fs.renameSync;
    let fail = true;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (fail && String(to).endsWith("provider-key.bin")) { fail = false; throw new Error("EIO"); }
      return rename(from, to);
    });
    expect(await h.keys.save(NEXT, "a.example")).toMatchObject({ ok: false });
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
  });


  it.each(["cancel", "policy", "consent"] as const)("keeps the provider when %s overtakes a pending keyring operation (integrations-r7-1)", async why => {
    const h = await fixture(); h.hold();
    const pending = h.adopt();
    await vi.waitFor(() => expect(h.sealing()).toBe(true));
    if (why === "cancel") h.service.api.cancelAdoption(request.id);
    else if (why === "policy") h.revoke();
    else h.unconsent();
    h.release();
    expect(await pending).toMatchObject({ ok: false });
    expect(h.settings.get().provider.baseUrl).toBe("https://a.example/v1");
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
  });

  it("does not turn a completed settings write into a failure when an observer throws (integrations-r7-1)", async () => {
    const h = await fixture();
    h.settings.onChange(() => { throw new Error("observer failed"); });
    expect(await h.adopt()).toEqual({ ok: true });
    expect(h.settings.get().provider.baseUrl).toBe(move.baseUrl);
    expect(await h.keys.load()).toMatchObject({ key: NEXT, host: "b.example" });
  });

  it("restores the old pair when publishing a staged key fails (integrations-r7-1)", async () => {
    const h = await fixture(); const rename = fs.renameSync; let fail = true;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (fail && String(to) === h.keyFile) { fail = false; throw new Error("EIO"); }
      return rename(from, to);
    });
    expect(await h.adopt()).toMatchObject({ ok: false });
    expect(h.settings.get().provider.baseUrl).toBe("https://a.example/v1");
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
  });

  it("keeps a rollback original private and recovers it on the next start (integrations-r7-1)", async () => {
    const h = await fixture(); const rename = fs.renameSync; let blocked = true;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (blocked && String(to) === h.keyFile) throw new Error("EIO");
      return rename(from, to);
    });
    expect(await h.adopt()).toMatchObject({ ok: false });
    blocked = false;
    const keys = new ProviderKeyStore(h.keyFile, h.box, { asyncKeyring: true });
    const restarted = createProviderService({ settings: h.settings, keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({}) }),
      consented: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
    await restarted.ensureKey();
    expect(restarted.key()).toMatchObject({ key: OLD, host: "a.example" });
    expect(fs.readdirSync(h.dir).some(f => f.endsWith(".backup"))).toBe(false);
  });

  it("Remove erases owned transaction remnants after a restart too (integrations-r7-1)", async () => {
    const h = await fixture();
    const nonce = "11111111-1111-4111-8111-111111111111";
    fs.copyFileSync(h.keyFile, `${h.keyFile}.${nonce}.backup`);
    const keys = new ProviderKeyStore(h.keyFile, h.box);
    keys.clear();
    expect(fs.readdirSync(h.dir).some(f => f.startsWith("provider-key"))).toBe(false);
  });

});
