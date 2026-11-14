/**
 * The card's yes for the user's own model provider (app/main/provider-record.ts, safety-privacy-c10-1): settings.json
 * is a file a text editor a worker drives can write, so a yes the file gains while Ember runs is put back, a yes found
 * at start counts only where it matches the keyring's seal Ember wrote when the user agreed in Home, and every change
 * of the provider in force is a `provider` audit entry (one coming into force that can't be recorded isn't taken).
 * Run against a real SettingsStore, AuditLog and provider service.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { NO_PROVIDER_CONSENT, ProviderRecord, ProviderSeal, type ProviderConsent, type ProviderRecordDeps, type ProviderSealStore } from "../../app/main/provider-record";
import { createProviderService, userProviderInForce } from "../../app/main/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { endpointHost } from "../../app/shared/provider";
import { describeEntry } from "../../app/renderer/home/copy";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const quiet = { info: () => {}, warn: () => {} };
const loaded: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const base = { ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true };
const GOOD = "https://models.example.com/v1";
const EVIL = "https://attacker.example/v1";
const yes = (host: string, at = "2026-11-13T10:00:00.000Z"): ProviderConsent => ({ version: FEATURE_CONSENT_VERSION.provider, at, host });
const provider = (baseUrl: string, consent: ProviderConsent) => ({ ...DEFAULT_SETTINGS.provider, on: true, baseUrl, conductor: "m", consent });
const memorySeal = (value: ProviderConsent | null) => {
  let v = value;
  const store: ProviderSealStore = { read: async () => v, write: async c => { v = c; return true; } };
  return { store, value: () => v };
};

function setup(p: ReturnType<typeof provider> | null, o: { seal?: ProviderSealStore; open?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-record-")); dirs.push(dir);
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ...base, ...(p ? { provider: p } : {}) }));
  const settings = new SettingsStore(file); settings.load();
  const audit = new AuditLog(path.join(dir, "audit"));
  const inForce = () => { const u = userProviderInForce(settings.get(), loaded); return u ? endpointHost(u.baseUrl) : null; };
  const record = new ProviderRecord({ settings: settings as unknown as ProviderRecordDeps["settings"], inForce, log: quiet, ...(o.seal ? { seal: o.seal } : {}) });
  if (o.open !== false) record.opened(audit);
  /** What is in force for the connection: the user's provider's host, unless the record holds it. */
  const used = () => (record.held() ? null : inForce());
  const entries = () => audit.recent(100).filter(e => e.event === "provider").reverse().map(({ t: _t, event: _e, ...rest }) => rest);
  const service = createProviderService({
    settings, admin: () => loaded, keys: { savedHost: () => null, canPersist: async () => true, save: async () => ({ ok: true, keyId: "k" }), load: async () => null, clear: () => {} } as never,
    consented: () => true, fetch: (async () => { throw new Error("no network"); }) as never, log: quiet, changed: () => {}, record,
  });
  return { dir, file, settings, audit, record, used, entries, service };
}
/** A hand edit of settings.json, as a text editor saves it, then the watch's look. */
const handEdit = (c: ReturnType<typeof setup>, p: ReturnType<typeof provider>) => {
  fs.writeFileSync(c.file, JSON.stringify({ ...JSON.parse(fs.readFileSync(c.file, "utf8")), provider: p }));
  c.settings.reloadIfChanged();
};

describe("the card's yes for the user's own model provider (safety-privacy-c10-1)", () => {
  it("puts back a yes that settings.json gains while Ember runs: nothing goes to that address, and nothing is recorded as agreed (safety-privacy-c10-1)", () => {
    const c = setup(null);
    handEdit(c, provider(EVIL, yes("attacker.example")));
    expect(c.used()).toBeNull();
    expect(c.settings.own().provider.consent).toEqual(DEFAULT_SETTINGS.provider.consent);
    expect(JSON.parse(fs.readFileSync(c.file, "utf8")).provider.consent).toEqual(DEFAULT_SETTINGS.provider.consent);
    expect(c.entries()).toEqual([]);
  });

  it("puts back a yes moved to another host, keeping the user's own provider's agreement as Home recorded it (safety-privacy-c10-1)", () => {
    const c = setup(provider(GOOD, NO_PROVIDER_CONSENT));
    expect(c.service.api.agree("models.example.com").ok).toBe(true);
    expect(c.used()).toBe("models.example.com");
    const agreed = c.settings.own().provider.consent;
    handEdit(c, provider(EVIL, yes("attacker.example", "2026-11-13T11:00:00.000Z")));
    expect(c.settings.own().provider.consent).toEqual(agreed);
    expect(c.used()).toBeNull();
    expect(c.entries()).toEqual([
      { host: "models.example.com", before: null, via: "home" },
      { host: null, before: "models.example.com", via: "settings" },
    ]);
  });

  it("takes a yes at start only as Ember sealed it: a forged one waits for nothing and is withdrawn, so Home asks again (safety-privacy-c10-1)", async () => {
    const forged = setup(provider(EVIL, yes("attacker.example")), { seal: memorySeal(null).store });
    // Until the seal is read, no provider of the user's.
    expect(forged.used()).toBeNull();
    await forged.record.sealed;
    expect(forged.used()).toBeNull();
    expect(forged.settings.own().provider.consent).toEqual(NO_PROVIDER_CONSENT);
    // Another time than the sealed one is another yes.
    const other = setup(provider(GOOD, yes("models.example.com")), { seal: memorySeal(yes("models.example.com", "2026-01-01T00:00:00.000Z")).store });
    await other.record.sealed;
    expect(other.used()).toBeNull();
    // As sealed: in force, and recorded as found at start.
    const sealed = setup(provider(GOOD, yes("models.example.com")), { seal: memorySeal(yes("models.example.com")).store });
    await sealed.record.sealed;
    expect(sealed.used()).toBe("models.example.com");
    expect(sealed.entries()).toEqual([{ host: "models.example.com", before: null, via: "start" }]);
    // Without a seal store at all (no keyring), none is taken from the file either.
    const none = setup(provider(GOOD, yes("models.example.com")));
    await none.record.sealed;
    expect(none.used()).toBeNull();
  });

  it("seals Home's yes, and a yes it seals is taken at the next start (safety-privacy-c10-1)", async () => {
    const seal = memorySeal(null);
    const c = setup(provider(GOOD, NO_PROVIDER_CONSENT), { seal: seal.store });
    c.service.api.agree("models.example.com");
    await new Promise(r => setTimeout(r, 0));
    expect(seal.value()).toEqual(c.settings.own().provider.consent);
    const next = setup(provider(GOOD, c.settings.own().provider.consent), { seal: seal.store });
    await next.record.sealed;
    expect(next.used()).toBe("models.example.com");
  });

  it("forgets the seal when the user takes their yes back, so the old yes in the file isn't taken at the next start (r10-safety-y10-4)", async () => {
    const seal = memorySeal(null);
    const c = setup(provider(GOOD, NO_PROVIDER_CONSENT), { seal: seal.store });
    c.service.api.agree("models.example.com");
    await new Promise(r => setTimeout(r, 0));
    const agreed = c.settings.own().provider.consent;
    c.settings.update({ provider: { ...c.settings.own().provider, consent: NO_PROVIDER_CONSENT } as never });
    await new Promise(r => setTimeout(r, 0));
    expect(seal.value()).toEqual(NO_PROVIDER_CONSENT);
    const next = setup(provider(GOOD, agreed), { seal: seal.store });
    await next.record.sealed;
    expect(next.used()).toBeNull();
    expect(next.settings.own().provider.consent).toEqual(NO_PROVIDER_CONSENT);
  });

  it("doesn't put a provider in force that the audit log can't record (safety-privacy-c10-1)", async () => {
    const c = setup(provider(GOOD, yes("models.example.com")), { seal: memorySeal(yes("models.example.com")).store, open: false });
    await c.record.sealed;
    expect(c.used()).toBeNull();
    c.record.opened({ write: () => { throw new Error("disk full"); } });
    expect(c.used()).toBeNull();
    c.record.opened(c.audit);
    expect(c.used()).toBe("models.example.com");
  });

  it("says the change in What Ember did by host only (safety-privacy-c10-1)", () => {
    expect(describeEntry({ t: "x", event: "provider", host: "models.example.com", via: "home" } as never)?.what).toBe("Model service: models.example.com");
    expect(describeEntry({ t: "x", event: "provider", host: null, via: "settings" } as never)?.what).toBe("Model service: your own provider is no longer in use");
  });
});

describe("the keyring's seal of the provider's yes (provider-record.ts ProviderSeal)", () => {
  const box = (backend = "gnome_libsecret") => ({
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
    encryptString: (t: string) => Buffer.from(`sealed:${Buffer.from(t).toString("base64")}`),
    decryptString: (b: Buffer) => { const t = b.toString(); if (!t.startsWith("sealed:")) throw new Error("not ours"); return Buffer.from(t.slice(7), "base64").toString(); },
  });
  it("gives back what it sealed, owner-only, nothing for a file it didn't seal, and seals nothing without a keyring (safety-privacy-c10-1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-seal-")); dirs.push(dir);
    const file = path.join(dir, "provider-seal.bin");
    const s = new ProviderSeal(file, box());
    expect(await s.read()).toBeNull();
    expect(await s.write(yes("models.example.com"))).toBe(true);
    expect(await s.read()).toEqual(yes("models.example.com"));
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, JSON.stringify(yes("attacker.example")));
    expect(await s.read()).toBeNull();
    const plain = new ProviderSeal(path.join(dir, "other.bin"), box("basic_text"));
    expect(await plain.write(yes("models.example.com"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "other.bin"))).toBe(false);
  });
});
