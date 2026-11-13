/**
 * Using a vault entry for a fill (VaultService.has and use; the slice's decisions 4 and 6): the value is handed to the
 * one call that puts it into the field and to nothing else, only for the destination it is bound to, and only while
 * the vault may be used.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretBox } from "../../app/main/agent/auth";
import { VaultService } from "../../app/main/vault/service";
import { VAULT_FILE, VaultStore } from "../../app/main/vault/store";
import type { VaultDestination } from "../../app/shared/vault";

const CANARY = "hunter2-CANARY-77c1";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const box = (o: Partial<SecretBox> = {}): SecretBox => ({
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed:${Buffer.from(s, "utf8").toString("hex")}`),
  decryptString: b => Buffer.from(b.toString().slice(7), "hex").toString("utf8"),
  ...o,
});
const GITHUB: VaultDestination = { site: "https://github.com" };
const MAIL: VaultDestination = { app: "thunderbird" };

async function make(o: { box?: Partial<SecretBox> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-use-"));
  dirs.push(dir);
  const file = path.join(dir, VAULT_FILE);
  const store = new VaultStore(file, box(o.box));
  const state = { allowed: true, consented: true, autopilot: true };
  const logged: unknown[] = [];
  const note = (m: string, f?: unknown) => { logged.push([m, f]); };
  const service = new VaultService({
    store, form: { ask: async () => "cancelled", stop: () => {} },
    allowed: () => state.allowed, consented: () => state.consented, autopilot: () => state.autopilot,
    appName: k => k, log: { info: note, warn: note, error: note, debug: note } as never,
  });
  expect((await store.add("login", GITHUB, { user: "ada", password: CANARY })).ok).toBe(true);
  expect((await store.add("login", MAIL, { password: "other-pw" })).ok).toBe(true);
  return { service, store, file, state, logged };
}

describe("using a vault entry for a fill (vault-2)", () => {
  it("hands the part to the one call that fills, and to nothing else: not its answer, not a log line", async () => {
    const h = await make();
    const got: string[] = [];
    const r = await h.service.use("login", "password", GITHUB, async v => { got.push(v); return { took: true }; });
    expect(got).toEqual([CANARY]);
    expect(r).toEqual({ ok: true, result: { took: true } });
    expect(JSON.stringify(h.logged)).not.toContain(CANARY);
    expect(h.logged).toContainEqual(["vault.used", { kind: "login", part: "password", site: true }]);
    expect((await h.service.use("login", "user", GITHUB, async v => v.length)).ok).toBe(true);
  });

  it("opens only the entry bound to exactly that destination", async () => {
    const h = await make();
    const never = async () => { throw new Error("handed a value"); };
    for (const dest of [{ site: "https://github.com.evil.example" }, { site: "http://github.com" }, { site: "https://github.com:8443" }, { app: "github.com" }, { app: "firefox" }] as VaultDestination[]) {
      expect(h.service.has("login", dest)).toBe(false);
      expect(await h.service.use("login", "password", dest, never)).toEqual({ ok: false, why: "none" });
    }
    // Not another kind for the same place, nor a destination that isn't one.
    expect(await h.service.use("card", "cardNumber", GITHUB, never)).toEqual({ ok: false, why: "none" });
    expect(await h.service.use("login", "cardNumber", GITHUB, never)).toEqual({ ok: false, why: "none" });
    expect(await h.service.use("login", "password", { site: "https://github.com/login" } as VaultDestination, never)).toEqual({ ok: false, why: "none" });
    // The app's own entry opens for the app only.
    const got: string[] = [];
    await h.service.use("login", "password", MAIL, async v => { got.push(v); });
    expect(got).toEqual(["other-pw"]);
  });

  it("says when the entry holds no such part, without calling the fill", async () => {
    const h = await make();
    expect(await h.service.use("login", "user", MAIL, async () => { throw new Error("handed a value"); })).toEqual({ ok: false, why: "part" });
  });

  it("hands nothing over outside Autopilot, without the consent or where the organisation turned the vault off", async () => {
    const h = await make();
    const never = async () => { throw new Error("handed a value"); };
    for (const off of ["autopilot", "consented", "allowed"] as const) {
      h.state[off] = false;
      expect(h.service.has("login", GITHUB)).toBe(false);
      expect(await h.service.use("login", "password", GITHUB, never)).toEqual({ ok: false, why: "off" });
      h.state[off] = true;
    }
    expect(h.service.has("login", GITHUB)).toBe(true);
  });

  it("hands nothing over when the mode changed while the keyring was asked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-use-"));
    dirs.push(dir);
    const state = { autopilot: true };
    const slow = box({ decryptString: b => { state.autopilot = false; return box().decryptString(b); } });
    const store = new VaultStore(path.join(dir, VAULT_FILE), slow);
    const service = new VaultService({ store, form: { ask: async () => "cancelled", stop: () => {} }, allowed: () => true, consented: () => true, autopilot: () => state.autopilot,
      appName: k => k, log: { info() {}, warn() {}, error() {}, debug() {} } as never });
    expect((await store.add("login", GITHUB, { password: CANARY })).ok).toBe(true);
    expect(await service.use("login", "password", GITHUB, async () => { throw new Error("handed a value"); })).toEqual({ ok: false, why: "off" });
  });

  it("opens nothing from a file edited to move an entry to another destination", async () => {
    const h = await make();
    const file = JSON.parse(fs.readFileSync(h.file, "utf8"));
    for (const e of file.entries) if (e.dest.site) e.dest = { site: "https://evil.example" };
    fs.writeFileSync(h.file, JSON.stringify(file));
    expect(await h.service.use("login", "password", { site: "https://evil.example" }, async () => { throw new Error("handed a value"); })).toEqual({ ok: false, why: "none" });
  });

  it("opens nothing when the keyring refuses", async () => {
    const h = await make({ box: { decryptString: () => { throw new Error("locked"); } } });
    expect(await h.service.use("login", "password", GITHUB, async () => { throw new Error("handed a value"); })).toEqual({ ok: false, why: "none" });
  });
});
