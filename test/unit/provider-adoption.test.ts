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
  it("refuses to save a draft key for a host that changed before main receives it (integrations-v7-9)", async () => {
    const h = await fixture();
    expect(await h.service.api.saveKey(NEXT, "b.example")).toMatchObject({ ok: false });
    expect(h.service.key()).toMatchObject({ key: OLD, host: "a.example" });
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
  });
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

  it("keeps the saved key when only the same host's details change (integrations-r7-1)", async () => {
    const h = await fixture();
    expect(await h.service.api.adopt({ ...request, host: "a.example", move: { ...move, baseUrl: "https://a.example/v2" }, key: undefined })).toEqual({ ok: true });
    expect(h.settings.get().provider.baseUrl).toBe("https://a.example/v2");
    expect(await h.keys.load()).toMatchObject({ key: OLD, host: "a.example" });
    expect(h.service.key()).toMatchObject({ key: OLD, host: "a.example" });
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

  it.each(["forget", "remove"] as const)("never restores a key after %s revokes it during adoption (integrations-v7-7)", async action => {
    const h = await fixture(); h.hold();
    const pending = h.adopt();
    await vi.waitFor(() => expect(h.sealing()).toBe(true));
    if (action === "forget") h.service.forget(); else h.service.api.removeKey();
    h.release();
    expect(await pending).toMatchObject({ ok: false });
    expect(h.service.key()).toBeNull();
    expect(await h.keys.load()).toBeNull();
    // Retired task credentials remain redaction-only; they must never become the active provider key again.
    expect(h.service.secrets()).toContain(OLD);
  });

  it.each([true, false])("honours an external settings edit while sealing, provider changed: %s (integrations-v7-8)", async changed => {
    const h = await fixture(); h.hold();
    const pending = h.adopt(); await vi.waitFor(() => expect(h.sealing()).toBe(true));
    const external = h.settings.own();
    const provider = changed ? { ...external.provider, baseUrl: "https://c.example/v1", consent: { ...external.provider.consent, host: "c.example" } } : external.provider;
    fs.writeFileSync(h.settings.file, JSON.stringify({ ...external, size: 72, provider }));
    const nextTime = new Date(Date.now() + 2000); fs.utimesSync(h.settings.file, nextTime, nextTime);
    h.release();
    expect(await pending).toMatchObject({ ok: !changed });
    expect(JSON.parse(fs.readFileSync(h.settings.file, "utf8"))).toMatchObject({ size: 72, provider: { baseUrl: changed ? "https://c.example/v1" : "https://b.example/v1" } });
    expect(h.settings.get()).toMatchObject({ size: 72, provider: { baseUrl: changed ? "https://c.example/v1" : "https://b.example/v1" } });
    if (changed) expect(h.service.key()).toBeNull();
    else expect(h.service.key()).toMatchObject({ key: NEXT, host: "b.example" });
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

  it.each(["key-backed-up", "both-backed-up", "new-key-only", "new-pair"] as const)("recovers the working key after an interrupted publish at %s (integrations-v7-3)", async phase => {
    const h = await fixture();
    const hostFile = h.keyFile.replace(/\.bin$/, ".host");
    const nonce = "11111111-1111-4111-8111-111111111111";
    fs.renameSync(h.keyFile, `${h.keyFile}.${nonce}.backup`);
    if (phase !== "key-backed-up") fs.renameSync(hostFile, `${hostFile}.${nonce}.backup`);
    if (phase === "new-key-only" || phase === "new-pair") {
      fs.writeFileSync(h.keyFile, JSON.stringify({ host: "b.example", key: NEXT }));
      if (phase === "new-pair") fs.writeFileSync(hostFile, "b.example");
    }
    const keys = new ProviderKeyStore(h.keyFile, h.box);
    const restarted = createProviderService({ settings: h.settings, keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({}) }),
      consented: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
    await restarted.ensureKey();
    expect(restarted.key()).toMatchObject({ host: "a.example", key: OLD });
    expect(await keys.load()).toMatchObject({ host: "a.example", key: OLD });
  });

  it("refuses volatile settings adoption without replacing the working sealed key (integrations-v7-4)", async () => {
    const h = await fixture();
    const before = h.settings.own().provider;
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === h.settings.file) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return read(...args);
    });
    const unread = new SettingsStore(h.settings.file); unread.load(); unread.update({ provider: before });
    const service = createProviderService({ settings: unread, keys: h.keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({}) }),
      consented: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
    await service.ensureKey();
    expect(await service.api.adopt(request)).toMatchObject({ ok: false });
    expect(unread.own().provider).toEqual(before);
    expect(await h.keys.load()).toMatchObject({ host: "a.example", key: OLD });
    expect(service.key()).toMatchObject({ host: "a.example", key: OLD });
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(h.settings.file, "utf8")).provider).toEqual(before);
  });

  it.each([false, true])("recovers a same-host key with the endpoint settings committed: %s (integrations-v7-5)", async committed => {
    const h = await fixture();
    const before = h.settings.own().provider;
    const after = { ...before, baseUrl: "https://a.example/v2", consent: { ...before.consent, at: "2026-11-09T00:01:00.000Z" } };
    const hostFile = h.keyFile.replace(/\.bin$/, ".host");
    const nonce = "11111111-1111-4111-8111-111111111111";
    fs.renameSync(h.keyFile, `${h.keyFile}.${nonce}.backup`);
    fs.renameSync(hostFile, `${hostFile}.${nonce}.backup`);
    fs.writeFileSync(h.keyFile, JSON.stringify({ host: "a.example", key: NEXT }));
    fs.writeFileSync(hostFile, "a.example");
    fs.writeFileSync(`${h.keyFile}.${nonce}.state`, JSON.stringify({ before: JSON.stringify(before), after: JSON.stringify(after) }));
    if (committed) h.settings.update({ provider: after });
    const keys = new ProviderKeyStore(h.keyFile, h.box);
    const restarted = createProviderService({ settings: h.settings, keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({}) }),
      consented: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
    await restarted.ensureKey();
    expect(restarted.key()).toMatchObject({ host: "a.example", key: committed ? NEXT : OLD });
    expect(fs.readdirSync(h.dir).some(f => f.endsWith(".backup") || f.endsWith(".state"))).toBe(false);
  });

  it("recovers host metadata after only that part of rollback failed (integrations-v7-6)", async () => {
    const h = await fixture();
    const before = h.settings.own().provider;
    const hostFile = h.keyFile.replace(/\.bin$/, ".host");
    const nonce = "11111111-1111-4111-8111-111111111111";
    fs.renameSync(hostFile, `${hostFile}.${nonce}.backup`);
    fs.writeFileSync(hostFile, "b.example");
    fs.writeFileSync(`${h.keyFile}.${nonce}.state`, JSON.stringify({ before: JSON.stringify(before), after: "new-settings" }));
    const keys = new ProviderKeyStore(h.keyFile, h.box);
    const restarted = createProviderService({ settings: h.settings, keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({}) }),
      consented: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
    await restarted.ensureKey();
    expect(restarted.key()).toMatchObject({ host: "a.example", key: OLD });
  });

  it("finishes an interrupted recovery without trusting unmatched primary metadata (integrations-v7-6)", async () => {
    const h = await fixture();
    const before = h.settings.own().provider;
    const hostFile = h.keyFile.replace(/\.bin$/, ".host");
    const nonce = "11111111-1111-4111-8111-111111111111";
    fs.renameSync(h.keyFile, `${h.keyFile}.${nonce}.backup`);
    fs.renameSync(hostFile, `${hostFile}.${nonce}.backup`);
    fs.writeFileSync(h.keyFile, JSON.stringify({ host: "b.example", key: NEXT }));
    fs.writeFileSync(hostFile, "b.example");
    fs.writeFileSync(`${h.keyFile}.${nonce}.state`, JSON.stringify({ before: JSON.stringify(before), after: "new-settings" }));
    const rename = fs.renameSync; let fail = true;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (fail && String(to) === hostFile) { fail = false; throw new Error("EIO"); }
      return rename(from, to);
    });
    const keys = new ProviderKeyStore(h.keyFile, h.box);
    keys.recover("a.example", false, JSON.stringify(before));
    expect(await keys.load()).toMatchObject({ key: OLD, host: "a.example" });
    expect(keys.savedHost()).toBe("b.example");
    const restarted = createProviderService({ settings: h.settings, keys, admin: () => ({ source: null, policy: AdminPolicySchema.parse({}) }),
      consented: () => true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), log: { info() {}, warn() {} }, changed() {} });
    await restarted.ensureKey();
    expect(keys.savedHost()).toBe("a.example");
    expect(restarted.key()).toMatchObject({ host: "a.example", key: OLD });
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
