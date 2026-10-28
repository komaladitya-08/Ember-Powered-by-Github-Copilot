/**
 * Ember's own sign-in when its GitHub App expires user tokens (review #138): GitHub's default for a GitHub App gives an
 * eight-hour token and a six-month refresh token. The device flow keeps both, the store keeps them, and an hour before
 * the token runs out Ember renews it (no client secret: a device-flow sign-in's renews without one) and reconnects
 * Copilot with the new token once nothing is under way. An app whose tokens don't expire changes nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrantKeeper, RENEW_BEFORE_MS, RenewalRefused, TokenStore, pollDeviceGrant, renewGrant, type DeviceCode, type Grant, type SecretBox } from "../../app/main/agent/auth";

const OLD = "ghu_" + "a".repeat(36); // not a real token
const NEW = "ghu_" + "b".repeat(36); // not a real token
const REFRESH = "ghr_" + "r".repeat(76); // not a real token
const REFRESH2 = "ghr_" + "s".repeat(76); // not a real token
const CLIENT = "Iv23liTESTTESTTEST00";
const HOUR = 60 * 60_000;

type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
type Call = { url: string; body: URLSearchParams };
const json = (body: unknown, status = 200): Reply => ({ ok: status < 400, status, json: async () => body });
/** A pretend GitHub: answers each request with the next reply (an Error is thrown, as fetch does offline). */
function github(...replies: (Reply | Error)[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    const r = replies.shift() ?? json({ error: "unexpected" });
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}
const renewed = (token = NEW, refresh = REFRESH2) => json({ access_token: token, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" });

const box: SecretBox = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`sealed:${s}`), decryptString: b => b.toString().replace(/^sealed:/, "") };
const tmpStore = () => new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-grant-")), "github-token.bin"), box);

afterEach(() => { vi.useRealTimers(); });

describe("the device flow's sign-in", () => {
  const code: DeviceCode = { deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };

  it("keeps the refresh token and when each runs out (they were dropped)", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { fetch } = github(json({ access_token: OLD, expires_in: 28800, refresh_token: REFRESH, refresh_token_expires_in: 15897600, token_type: "bearer" }));
    const grant = await pollDeviceGrant(fetch, CLIENT, code, { sleep: async () => undefined });
    expect(grant).toEqual({ token: OLD, refreshToken: REFRESH, expiresAt: 1_000_000 + 8 * HOUR, refreshExpiresAt: 1_000_000 + 15897600_000, clientId: CLIENT });
  });

  it("from an app whose tokens don't expire is the token alone", async () => {
    const { fetch } = github(json({ access_token: OLD, token_type: "bearer", scope: "" }));
    expect(await pollDeviceGrant(fetch, CLIENT, code, { sleep: async () => undefined })).toEqual({ token: OLD });
  });
});

describe("the stored sign-in", () => {
  it("keeps the whole grant, encrypted", () => {
    const store = tmpStore();
    const grant: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: 5 * HOUR, refreshExpiresAt: 4000 * HOUR, clientId: CLIENT };
    expect(store.saveResult(grant)).toBe("kept");
    expect(store.loadGrant()).toEqual(grant);
    expect(store.load()).toBe(OLD);
  });

  it("still reads a token an earlier Ember saved, and writes a token that doesn't expire as it always did", () => {
    const store = tmpStore();
    expect(store.save(OLD)).toBe(true);
    expect(store.loadGrant()).toEqual({ token: OLD });
    expect(store.saveResult({ token: NEW })).toBe("kept");
    expect(box.decryptString(fs.readFileSync((store as unknown as { file: string }).file))).toBe(NEW);
  });

  it("is none when the file is damaged or holds something that isn't a token", () => {
    const store = tmpStore();
    const file = (store as unknown as { file: string }).file;
    fs.writeFileSync(file, "sealed:{not json");
    expect(store.loadGrant()).toBeNull();
    fs.writeFileSync(file, `sealed:${JSON.stringify({ token: "ghp_classic", refreshToken: REFRESH })}`);
    expect(store.loadGrant()).toBeNull();
    expect(store.load()).toBeNull();
  });
});

describe("renewing a sign-in", () => {
  const grant: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: 8 * HOUR, refreshExpiresAt: 4000 * HOUR, clientId: CLIENT };

  it("asks GitHub with the refresh token and the client id, and no client secret", async () => {
    const { fetch, calls } = github(renewed());
    const next = await renewGrant(fetch, grant, () => 10 * HOUR);
    expect(next).toEqual({ token: NEW, refreshToken: REFRESH2, expiresAt: 18 * HOUR, refreshExpiresAt: 10 * HOUR + 15897600_000, clientId: CLIENT });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://github.com/login/oauth/access_token");
    expect(Object.fromEntries(calls[0].body)).toEqual({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: REFRESH });
  });

  it("is refused for good when GitHub says so, and fails in passing offline or on a 5xx", async () => {
    await expect(renewGrant(github(json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." })).fetch, grant)).rejects.toBeInstanceOf(RenewalRefused);
    await expect(renewGrant(github(new TypeError("fetch failed")).fetch, grant)).rejects.not.toBeInstanceOf(RenewalRefused);
    await expect(renewGrant(github(json({}, 502)).fetch, grant)).rejects.not.toBeInstanceOf(RenewalRefused);
    // Nothing to renew it with: refused without asking.
    const { fetch, calls } = github();
    await expect(renewGrant(fetch, { token: OLD })).rejects.toBeInstanceOf(RenewalRefused);
    expect(calls).toHaveLength(0);
  });
});

describe("keeping Ember's own sign-in alive", () => {
  const T0 = 1_700_000_000_000;
  function setup(o: { replies?: (Reply | Error)[]; idle?: () => boolean; stored?: Grant | null } = {}) {
    vi.useFakeTimers({ now: T0 });
    const { fetch, calls } = github(...(o.replies ?? [renewed()]));
    const store = tmpStore();
    const grant: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT };
    if (o.stored !== null) store.saveResult(o.stored ?? grant);
    let inUse: string | null = OLD;
    const reconnected: string[] = [];
    const keeper = new GrantKeeper({
      fetch, store: () => store, inUse: () => inUse, idle: o.idle ?? (() => true),
      reconnect: async token => { reconnected.push(token); inUse = token; },
    });
    return { keeper, calls, store, grant, reconnected, signOut: () => { inUse = null; } };
  }

  it("renews it an hour before it runs out, saves it, and reconnects Copilot with the new token", async () => {
    const { keeper, calls, store, reconnected } = setup();
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(7 * HOUR - 1000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    expect(reconnected).toEqual([NEW]);
    expect(store.loadGrant()).toMatchObject({ token: NEW, refreshToken: REFRESH2, expiresAt: T0 + 7 * HOUR + 8 * HOUR });
    keeper.stop();
  });

  it("waits for nothing to be under way before reconnecting (a running task isn't cut off)", async () => {
    let idle = false;
    const { keeper, reconnected } = setup({ idle: () => idle });
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(7 * HOUR + 1000);
    expect(reconnected).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reconnected).toEqual([]);
    idle = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("reconnects anyway just before the old token runs out (what's under way would fail then regardless)", async () => {
    const { keeper, reconnected } = setup({ idle: () => false });
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(8 * HOUR - 3 * 60_000);
    expect(reconnected).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("tries again a minute later when GitHub can't be reached, and gives up when GitHub refuses", async () => {
    const offline = setup({ replies: [new TypeError("fetch failed"), renewed()] });
    offline.keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(7 * HOUR + 1000);
    expect(offline.calls).toHaveLength(1);
    expect(offline.reconnected).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(offline.calls).toHaveLength(2);
    expect(offline.reconnected).toEqual([NEW]);
    offline.keeper.stop();

    const refused = setup({ replies: [json({ error: "bad_refresh_token" })] });
    refused.keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(refused.calls).toHaveLength(1);
    expect(refused.reconnected).toEqual([]);
  });

  it("renews nothing for a sign-in no longer in use (signed out, another account), or one that doesn't expire", async () => {
    const out = setup();
    out.keeper.use(OLD);
    out.signOut();
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(out.calls).toHaveLength(0);

    const other = setup();
    other.keeper.use("gho_" + "c".repeat(36)); // the GitHub CLI's sign-in: not Ember's grant
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(other.calls).toHaveLength(0);

    const lasting = setup({ stored: { token: OLD } });
    lasting.keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(lasting.calls).toHaveLength(0);
  });

  it("keeps a sign-in that is in memory only (no keyring) alive too", async () => {
    const { keeper, calls, reconnected, grant } = setup({ stored: null });
    keeper.use(OLD, grant);
    // Connected with it again (Check again finds nothing stored): still the same grant.
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(7 * HOUR + 1000);
    expect(calls).toHaveLength(1);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("renews a stored sign-in that ran out while Ember was off before it is used, at most once a minute", async () => {
    const { keeper, calls, store, grant } = setup({ replies: [new TypeError("fetch failed"), renewed()] });
    vi.setSystemTime(T0 + 9 * HOUR);
    await keeper.freshen();
    expect(calls).toHaveLength(1);
    expect(store.loadGrant()).toEqual(grant);
    // The GitHub CLI wait looks every 3 s: GitHub isn't asked each time.
    await keeper.freshen();
    expect(calls).toHaveLength(1);
    vi.setSystemTime(T0 + 9 * HOUR + 61_000);
    await keeper.freshen();
    expect(calls).toHaveLength(2);
    expect(store.load()).toBe(NEW);
    // Fresh now: nothing more to do.
    vi.setSystemTime(T0 + 9 * HOUR + 3 * 60_000);
    await keeper.freshen();
    expect(calls).toHaveLength(2);
  });

  it("doesn't renew a stored sign-in with hours left", async () => {
    const { keeper, calls } = setup();
    vi.setSystemTime(T0 + 8 * HOUR - RENEW_BEFORE_MS - 60_000);
    await keeper.freshen();
    expect(calls).toHaveLength(0);
  });
});

describe("main's sign-in wiring", () => {
  /** main.ts without line comments, every run of white space made one space (it can't be loaded in a unit test). */
  const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

  it("keeps the device flow's whole grant, and keeps the sign-in in use alive", () => {
    expect(MAIN).toContain("const grant = await pollDeviceGrant(fetch, clientId, code,");
    expect(MAIN).toContain("tokens?.saveResult(grant)");
    expect(MAIN).toContain("keeper.use(token, grant);");
    // Every connect says which sign-in is in use; signing out keeps none alive.
    expect(MAIN).toContain("currentToken = f?.token ?? null; keeper.use(currentToken);");
    expect(MAIN).toMatch(/ipcMain\.handle\(IPC\.signOut, guard\(async \(\) => \{[^}]*currentToken = null; keeper\.use\(null\);/);
    // A stored sign-in that ran out while Ember was off is renewed before it is looked at.
    expect(MAIN).toContain("const findToken = async () => { await keeper.freshen(); return resolveToken(");
    expect(MAIN).toContain("if (!provider) await keeper.freshen();");
    // Copilot is reconnected only when nothing is under way.
    expect(MAIN).toContain("idle: () => agent?.idle ?? true,");
  });
});
