/**
 * The vault in main (the round's brief, decisions 3, 5 and 9): when a form may be asked for, what Home is told (never
 * a value), Forget and Forget all, Sign out and Forget everything, the kill switch, and Home's channels.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretBox } from "../../app/main/agent/auth";
import type { VaultFormRequest } from "../../app/main/vault/form";
import { VaultService, destinationLabel, entryRow, registerVaultHomeIpc, type VaultIpcEvent } from "../../app/main/vault/service";
import { VAULT_FILE, VaultStore } from "../../app/main/vault/store";
import { VAULT_IPC, type VaultDestination } from "../../app/shared/vault";
import { keepClearOf } from "../../app/main/windows";
import { vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, Menu: {}, nativeTheme: {}, screen: {} }));

const CANARY = "hunter2-CANARY-9f3a";
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
const login = { user: "ada", password: CANARY };
const appName = (key: string) => (key === "thunderbird" ? "Thunderbird" : key === "firefox" ? "Firefox" : "");

function make(o: { allowed?: boolean | (() => boolean); consented?: boolean; autopilot?: boolean; box?: Partial<SecretBox>; answer?: "saved" | "cancelled" | "unavailable" | "stopped" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-svc-"));
  dirs.push(dir);
  const file = path.join(dir, VAULT_FILE);
  const store = new VaultStore(file, box(o.box), { now: (() => { let t = 1_700_000_000_000; return () => t++; })() });
  const state = { allowed: o.allowed ?? true, consented: o.consented ?? true, autopilot: o.autopilot ?? true };
  const asked: VaultFormRequest[] = [];
  const logged: unknown[] = [];
  let stops = 0, changes = 0;
  const log = { info: (m: string, f?: unknown) => logged.push([m, f]), warn: (m: string, f?: unknown) => logged.push([m, f]), error: (m: string, f?: unknown) => logged.push([m, f]), debug: () => {} };
  const service = new VaultService({
    store, form: { ask: async req => { asked.push(req); return o.answer ?? "cancelled"; }, stop: () => { stops++; } },
    allowed: () => (typeof state.allowed === "function" ? state.allowed() : state.allowed), consented: () => state.consented, autopilot: () => state.autopilot,
    appName, log: log as never, changed: () => { changes++; },
  });
  return { service, store, file, state, asked, logged, stops: () => stops, changes: () => changes };
}

describe("the vault's Secure Form, as main asks for it", () => {
  it("is asked for only in Autopilot, after the consent, where the organisation allows the vault (vault-3)", async () => {
    for (const off of [{ autopilot: false }, { consented: false }, { allowed: false }, { allowed: () => { throw new Error("policy"); } }] as const) {
      const h = make(off);
      expect(await h.service.ask("login", GITHUB, "Firefox")).toBe("off");
      expect(h.asked).toEqual([]);
    }
    const h = make({ answer: "saved" });
    expect(await h.service.ask("login", GITHUB, "Firefox")).toBe("saved");
    expect(h.asked).toEqual([{ kind: "login", dest: GITHUB, where: "github.com", via: "Firefox", keyring: true }]);
  });

  it("names the destination itself, from the app's or the site's identity, and a browser only for a site (vault-3)", async () => {
    const h = make();
    await h.service.ask("card", MAIL, "Firefox");
    expect(h.asked[0]).toEqual({ kind: "card", dest: MAIL, where: "Thunderbird", via: null, keyring: true });
    expect(destinationLabel({ app: "unknownapp" }, appName)).toBe("unknownapp");
    expect(destinationLabel({ site: "http://intranet:8080" }, appName)).toBe("http://intranet:8080");
  });

  it("isn't asked for a destination that isn't one, or a kind it doesn't keep (vault-3)", async () => {
    const h = make();
    expect(await h.service.ask("login", { site: "https://github.com/login" }, null)).toBe("off");
    expect(await h.service.ask("login", { app: "Firefox" }, null)).toBe("off");
    expect(await h.service.ask("passkey" as "login", GITHUB, null)).toBe("off");
    expect(h.asked).toEqual([]);
  });

  it("asks once: with an entry of that kind bound there already, no form opens (vault-3)", async () => {
    const h = make();
    expect((await h.service.keep("login", GITHUB, login)).ok).toBe(true);
    expect(await h.service.ask("login", GITHUB, "Firefox")).toBe("kept");
    expect(h.asked).toEqual([]);
    // Another kind there, and the same kind elsewhere, are asked.
    await h.service.ask("card", GITHUB, "Firefox");
    await h.service.ask("login", { site: "https://github.com:8443" }, "Firefox");
    expect(h.asked.map(r => [r.kind, r.where])).toEqual([["card", "github.com"], ["login", "https://github.com:8443"]]);
  });

  it("tells the form when there is no keyring, so it says so and keeps nothing (vault-3)", async () => {
    const h = make({ box: { getSelectedStorageBackend: () => "basic_text" } });
    await h.service.ask("login", GITHUB, "Firefox");
    expect(h.asked[0].keyring).toBe(false);
    expect(await h.service.keep("login", GITHUB, login)).toEqual({ ok: false, why: "keyring" });
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it("keeps nothing from a Save once Autopilot isn't in force, the consent went or the organisation turned the vault off (vault-3)", async () => {
    for (const key of ["autopilot", "consented", "allowed"] as const) {
      const h = make();
      h.state[key] = false;
      expect(await h.service.keep("login", GITHUB, login)).toEqual({ ok: false, why: "gone" });
      expect(fs.existsSync(h.file)).toBe(false);
    }
  });

  it("closes an open form once Autopilot isn't the mode in force, the consent went or the organisation turned the vault off (vault-7)", () => {
    for (const key of ["autopilot", "consented", "allowed"] as const) {
      const h = make();
      h.service.recheck();
      expect(h.stops()).toBe(0); // still usable: a form stays up
      h.state[key] = false;
      h.service.recheck();
      expect(h.stops()).toBe(1);
    }
  });

  it("closes an open form at Stop (vault-3)", () => {
    const h = make();
    const part = h.service.stopPart();
    expect(part.name).toBe("vault");
    void part.stop();
    expect(h.stops()).toBe(1);
  });
});

describe("Home's list of the vault", () => {
  it("lists entries by kind, destination and date only, newest first (vault-3)", async () => {
    const h = make();
    const a = await h.service.keep("login", GITHUB, login);
    const b = await h.service.keep("card", MAIL, { cardNumber: "4242424242424242", expiry: "08/29", securityCode: "123" });
    if (!a.ok || !b.ok) throw new Error("not kept");
    const state = h.service.homeState();
    expect(state).toEqual({ allowed: true, entries: [
      { id: b.id, kind: "card", where: "Thunderbird", site: false, savedAt: 1_700_000_000_001 },
      { id: a.id, kind: "login", where: "github.com", site: true, savedAt: 1_700_000_000_000 },
    ] });
    const said = JSON.stringify(state);
    for (const secret of [CANARY, "ada", "4242", "08/29", "123\"", "sealed"]) expect(said).not.toContain(secret);
    expect(Object.keys(entryRow({ id: "x", kind: "login", dest: GITHUB, savedAt: 1 }, appName)).sort()).toEqual(["id", "kind", "savedAt", "site", "where"]);
    expect(h.changes()).toBe(2);
  });

  it("still lists what is kept, with Forget, where the organisation turned the vault off (vault-5)", async () => {
    const h = make();
    const a = await h.service.keep("login", GITHUB, login);
    if (!a.ok) throw new Error("not kept");
    h.state.allowed = false;
    expect(h.service.homeState()).toMatchObject({ allowed: false, entries: [{ id: a.id }] });
    expect(h.service.forget(a.id)).toBe(true);
    expect(h.service.homeState()).toEqual({ allowed: false, entries: [] });
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it("forgets one entry, says so to Home, and counts one already gone as forgotten (vault-3)", async () => {
    const h = make();
    const a = await h.service.keep("login", GITHUB, login);
    const b = await h.service.keep("login", MAIL, login);
    if (!a.ok || !b.ok) throw new Error("not kept");
    const before = h.changes();
    expect(h.service.forget(a.id)).toBe(true);
    expect(h.changes()).toBe(before + 1);
    expect(h.service.homeState().entries.map(e => e.id)).toEqual([b.id]);
    expect(h.service.forget(a.id)).toBe(true);
    expect(h.service.homeState().entries.map(e => e.id)).toEqual([b.id]);
  });

  it("forgets everything: an open form closes, the file goes, and Home is told (vault-6)", async () => {
    const h = make();
    await h.service.keep("login", GITHUB, login);
    await h.service.keep("card", MAIL, { cardNumber: "4242424242424242", expiry: "08/29", securityCode: "123" });
    const before = h.changes();
    expect(h.service.forgetAll()).toBe(true);
    expect(h.stops()).toBe(1);
    expect(fs.existsSync(h.file)).toBe(false);
    expect(h.service.homeState().entries).toEqual([]);
    expect(h.changes()).toBe(before + 1);
    // With nothing kept it is still fine, and still closes a form.
    expect(h.service.forgetAll()).toBe(true);
    expect(h.stops()).toBe(2);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says when an entry or the file couldn't be removed, and keeps listing it (vault-6)", async () => {
    const h = make();
    const a = await h.service.keep("login", GITHUB, login);
    if (!a.ok) throw new Error("not kept");
    fs.chmodSync(path.dirname(h.file), 0o500);
    try {
      expect(h.service.forget(a.id)).toBe(false);
      expect(h.service.forgetAll()).toBe(false);
      expect(h.service.homeState().entries.map(e => e.id)).toEqual([a.id]);
    } finally {
      fs.chmodSync(path.dirname(h.file), 0o700);
    }
  });

  it("logs kinds and outcomes only: never a value, a user name or a destination (vault-3)", async () => {
    const h = make();
    const a = await h.service.keep("login", GITHUB, login);
    await h.service.keep("login", GITHUB, { password: `${CANARY}\n` });
    await h.service.ask("card", GITHUB, "Firefox");
    if (a.ok) h.service.forget(a.id);
    h.service.forgetAll();
    const said = JSON.stringify(h.logged);
    expect(said).toContain("vault.kept");
    for (const secret of [CANARY, "ada", "github"]) expect(said).not.toContain(secret);
  });
});

describe("Home's vault channels", () => {
  const wire = (trusted: boolean) => {
    const h = make();
    const handlers = new Map<string, (e: VaultIpcEvent, ...a: unknown[]) => unknown>();
    registerVaultHomeIpc({ handle: (c, f) => { handlers.set(c, f); } }, () => trusted, h.service);
    const call = (c: string, ...a: unknown[]) => handlers.get(c)!({ sender: {} }, ...a);
    return { ...h, handlers, call };
  };

  it("are the list, Forget and Forget all, and answer only the settings window (vault-3)", async () => {
    const no = wire(false);
    expect([...no.handlers.keys()].sort()).toEqual([VAULT_IPC.forget, VAULT_IPC.forgetAll, VAULT_IPC.list].sort());
    for (const c of no.handlers.keys()) expect(() => no.call(c, "x")).toThrow(/untrusted IPC sender/);
    const yes = wire(true);
    const a = await yes.service.keep("login", GITHUB, login);
    if (!a.ok) throw new Error("not kept");
    expect(yes.call(VAULT_IPC.list)).toMatchObject({ allowed: true, entries: [{ id: a.id, kind: "login", where: "github.com" }] });
    expect(JSON.stringify(yes.call(VAULT_IPC.list))).not.toContain(CANARY);
  });

  it("check Forget's id before use (vault-3)", async () => {
    const h = wire(true);
    const a = await h.service.keep("login", GITHUB, login);
    if (!a.ok) throw new Error("not kept");
    for (const bad of [undefined, null, 5, "", "../vault.json", "x".repeat(10_000), { id: a.id }, [a.id]]) expect(h.call(VAULT_IPC.forget, bad)).toBe(false);
    expect(h.service.homeState().entries).toHaveLength(1);
    expect(h.call(VAULT_IPC.forget, a.id)).toBe(true);
    expect(h.call(VAULT_IPC.forgetAll)).toBe(true);
  });
});

describe("main's wiring of the vault", () => {
  const main = fs.readFileSync("app/main/main.ts", "utf8");

  it("keeps the vault in its own file, sealed by safeStorage, off the main thread on macOS (vault-1)", () => {
    expect(main).toContain('store: new VaultStore(path.join(userData, VAULT_FILE), safeStorage, { asyncKeyring: platform.os === "darwin" }),');
    expect(main).toContain("allowed: () => vaultAllowed(admin), consented: () => consented(), autopilot: () => approvalsNow().autopilot,");
  });

  it("stops the Secure Form with everything else (vault-3)", () => {
    expect(main).toContain('{ name: "vault", stop: () => vaultRef?.stopPart().stop() },');
  });

  it("forgets the vault at Sign out and at Forget everything, and says when its file couldn't be removed (vault-6)", () => {
    const signOut = main.slice(main.indexOf("ipcMain.handle(IPC.signOut"), main.indexOf("ipcMain.handle(IPC.cancelSignIn"));
    expect(signOut).toContain("const vaultGone = vault.forgetAll();");
    expect(signOut).toContain(`if (!vaultGone) throw new Error("Ember couldn't finish deleting the vault's file on this computer. You are signed out; Forget all in Apps & privacy tries again.");`);
    const forget = main.slice(main.indexOf("ipcMain.handle(IPC.memoryForgetAll"), main.indexOf("ipcMain.handle(IPC.memoryIntroduce"));
    expect(forget).toContain("const vaultGone = vault.forgetAll();");
    expect(forget).toContain(`if (!vaultGone) throw new Error("Ember couldn't finish deleting the vault's file on this computer. Try Forget again.");`);
  });

  /** Main's own handler source, run with fakes (as host.test.ts runs them with the real host). */
  const handlerOf = (src: string, deps: Record<string, unknown>) => {
    let run!: () => Promise<void>;
    const names = Object.keys(deps);
    new Function("ipcMain", "IPC", "guard", ...names, `let signOuts = 0, accountErasures = 0, signInAbort = null, currentToken = "t", askHistory = [], memoryEpoch = 0;\n${src}`)(
      { handle: (_c: string, h: () => Promise<void>) => { run = h; } }, { signOut: "s", memoryForgetAll: "m" }, (fn: unknown) => fn, ...names.map(n => deps[n]));
    return run;
  };
  const slice = (from: string, to: string) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));

  it("Sign out forgets the vault whatever else fails, finishes signing out, and then says its file couldn't be removed (vault-6)", async () => {
    const calls: string[] = [];
    const deps = (gone: boolean, o: { providers?: () => void } = {}) => ({
      agent: { forgetConversation: async () => { calls.push("conversation"); }, start: async () => { calls.push("start"); } },
      tokens: { clear: () => calls.push("tokens") }, keeper: { use() {} }, providers: { forget: o.providers ?? (() => calls.push("provider")) }, refusedTokens: { clear() {} },
      resetAnswerSpeech() {}, forgetProject() {}, forgetSessionWords: () => calls.push("session words"),
      vault: { forgetAll: () => { calls.push("vault"); return gone; } },
    });
    const src = slice("ipcMain.handle(IPC.signOut,", "ipcMain.handle(IPC.cancelSignIn,");
    await handlerOf(src, deps(true))();
    // First, before anything is awaited: a form still open closes at once.
    expect(calls).toEqual(["vault", "conversation", "tokens", "provider", "session words", "start"]);
    calls.length = 0;
    await expect(handlerOf(src, deps(false))()).rejects.toThrow("Ember couldn't finish deleting the vault's file on this computer. You are signed out; Forget all in Apps & privacy tries again.");
    expect(calls).toEqual(["vault", "conversation", "tokens", "provider", "session words", "start"]);
    // Nothing that fails afterwards keeps the vault.
    calls.length = 0;
    await expect(handlerOf(src, deps(true, { providers: () => { throw new Error("key"); } }))()).rejects.toThrow("key");
    expect(calls[0]).toBe("vault");
  });

  it("Forget everything forgets the vault and says when its file couldn't be removed (vault-6)", async () => {
    const calls: string[] = [];
    const deps = (gone: boolean) => ({
      learning: { forgetAll: () => calls.push("learning") }, agent: { forgetHistory: () => true }, forgetSessionWords: () => calls.push("session words"),
      memoryOwner: { clear: () => calls.push("owner.clear"), refresh: () => undefined }, memoryConfigured: () => true, publishMemoryOwner: () => undefined,
      vault: { forgetAll: () => { calls.push("vault"); return gone; } },
    });
    const src = slice("ipcMain.handle(IPC.memoryForgetAll,", '// "Tell Ember about you"');
    await handlerOf(src, deps(true))();
    expect(calls).toEqual(["learning", "session words", "vault", "owner.clear"]);
    expect(() => handlerOf(src, deps(false))()).toThrow("Ember couldn't finish deleting the vault's file on this computer. Try Forget again.");
  });

  it("closes the Secure Form when the mode or the settings change so that the vault can't be used, and redraws Home's list when the policy changes (vault-7)", () => {
    expect(main).toContain("settings.onChange(() => vaultRef?.recheck());");
    const changed = main.slice(main.indexOf("const unwatchPolicy = watchAdminPolicy({"), main.indexOf('void killSwitch.pull("policy")'));
    expect(changed).toContain("sendToHome(VAULT_IPC.changed, null);");
  });

  it("takes Home's vault channels only from the settings window's own page, and the form's only through the pages' adapter (vault-3)", () => {
    expect(main).toContain('registerVaultHomeIpc(ipcMain, event => {\n    const url = event.senderFrame?.url ?? "";\n    return isTrustedSender(url) && !!home && !home.isDestroyed() && event.sender === home.webContents;\n  }, vault);');
    expect(main).toContain('create: kind => keepClear("vault", createVaultWindow(platform.os, kind, {');
    expect(main).toContain("keep: (kind, dest, values) => vault.keep(kind, dest, values),");
  });

  it("keeps Ember and its bubble clear of the Secure Form while it asks (vault-2)", () => {
    const rect = (x: number) => ({ x, y: 0, width: 100, height: 100 });
    const shown = (x: number) => ({ visible: true, minimized: false, focused: true, bounds: rect(x) });
    expect(keepClearOf({ home: null, prompt: null, command: null, commandCard: false, vault: shown(5) })).toEqual({ aside: rect(5), avoid: [rect(5)] });
    expect(keepClearOf({ home: null, prompt: null, command: null, commandCard: false, vault: { ...shown(5), visible: false } })).toEqual({ aside: null, avoid: [] });
    expect(keepClearOf({ home: null, prompt: null, command: null, commandCard: false })).toEqual({ aside: null, avoid: [] });
  });
});
