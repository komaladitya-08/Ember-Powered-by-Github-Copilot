/**
 * Test connection and Home's provider state while the record of the card's yes holds it back (provider-record.ts:
 * the seal not read yet, a forged yes that couldn't be put back, a coming into force that couldn't be audited). The yes
 * settings.json still holds then is no yes: nothing goes to its host, the saved key included, and Home is told it isn't
 * agreed, so it shows the card (integ-x-1). Run against a real SettingsStore, AuditLog, ProviderRecord and service.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { ProviderRecord, type ProviderConsent, type ProviderRecordDeps, type ProviderSealStore } from "../../app/main/provider-record";
import { createProviderService, userProviderInForce } from "../../app/main/provider";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { endpointHost } from "../../app/shared/provider";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const quiet = { info: () => {}, warn: () => {} };
const loaded: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const base = { ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true };
const EVIL = "https://attacker.example/v1";
const HOST = "attacker.example";
const yes = (host: string): ProviderConsent => ({ version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-13T10:00:00.000Z", host });
const provider = (consent: ProviderConsent) => ({ ...DEFAULT_SETTINGS.provider, on: true, baseUrl: EVIL, conductor: "m", consent });
const sealOf = (v: ProviderConsent | null): ProviderSealStore => ({ read: async () => v, write: async () => true });

/** The record as main builds it, `start` the file's provider; `failPutBack`: a yes put back can't be saved. */
function setup(start: ReturnType<typeof provider> | null, o: { seal: ProviderSealStore; open: boolean; failPutBack?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-held-")); dirs.push(dir);
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ...base, ...(start ? { provider: start } : {}) }));
  const settings = new SettingsStore(file); settings.load();
  const inForce = () => { const u = userProviderInForce(settings.get(), loaded); return u ? endpointHost(u.baseUrl) : null; };
  let failing = false;
  const recordSettings = {
    own: () => settings.own(),
    update: (patch: never) => { if (failing) throw new Error("disk full"); return settings.update(patch); },
    onChange: (fn: () => void) => settings.onChange(fn),
  } as unknown as ProviderRecordDeps["settings"];
  const record = new ProviderRecord({ settings: recordSettings, inForce, log: quiet, seal: o.seal });
  if (o.open) record.opened(new AuditLog(path.join(dir, "audit")));
  failing = !!o.failPutBack;
  const fetched: { url: string; headers: Record<string, string> }[] = [];
  const service = createProviderService({
    settings, admin: () => loaded,
    keys: { savedHost: () => HOST, canPersist: async () => true, save: async () => ({ ok: true, keyId: "k" }), load: async () => ({ key: "sk-saved-key-0123456789", host: HOST }), clear: () => {} } as never,
    consented: () => true,
    fetch: (async (url: string, init: { headers: Record<string, string> }) => { fetched.push({ url, headers: init.headers }); return { ok: true, status: 200, json: async () => ({ data: [{ id: "x" }] }) }; }) as never,
    log: quiet, changed: () => {}, record,
  });
  const handEdit = (p: ReturnType<typeof provider>) => {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), provider: p }));
    settings.reloadIfChanged();
  };
  return { settings, record, service, fetched, handEdit };
}

const held = {
  "its seal not read yet (a Keychain prompt waiting)": () => setup(provider(yes(HOST)), { seal: { read: () => new Promise(() => {}), write: async () => true }, open: true }),
  "its coming into force not audited (no audit log open)": () => setup(provider(yes(HOST)), { seal: sealOf(yes(HOST)), open: false }),
  "a forged yes it couldn't put back": () => {
    const c = setup(null, { seal: sealOf(null), open: true, failPutBack: true });
    c.handEdit(provider(yes(HOST)));
    return c;
  },
};

describe("Test connection while the record holds the provider's yes back (integ-x-1)", () => {
  for (const [why, make] of Object.entries(held)) {
    it(`sends nothing to the host, and Home is told it isn't agreed, with ${why} (integ-x-1)`, async () => {
      const c = make();
      await Promise.resolve();
      expect(c.record.held()).toBe(true);
      expect(c.settings.get().provider.consent.host).toBe(HOST);
      const state = await c.service.api.state();
      expect(state).toMatchObject({ host: HOST, agreed: false, inForce: false, held: true });
      const r = await c.service.api.test();
      expect(r.ok).toBe(false);
      expect(c.fetched).toEqual([]);
      // A draft's own press agrees for its host, but the saved key goes only with a yes Ember recorded.
      await c.service.api.test({ type: "openai", baseUrl: EVIL, host: HOST } as never);
      expect(c.fetched.flatMap(f => Object.values(f.headers)).filter(v => v.includes("sk-saved-key"))).toEqual([]);
    });
  }

  it("tests the host as before once the yes is recorded and sealed (integ-x-1)", async () => {
    const c = setup(provider(yes(HOST)), { seal: sealOf(yes(HOST)), open: true });
    await c.record.sealed;
    expect(c.record.held()).toBe(false);
    expect(await c.service.api.state()).toMatchObject({ agreed: true, inForce: true, held: false });
    const r = await c.service.api.test();
    expect(r.ok).toBe(true);
    expect(c.fetched.map(f => f.url)).toEqual(["https://attacker.example/v1/models"]);
  });
});
