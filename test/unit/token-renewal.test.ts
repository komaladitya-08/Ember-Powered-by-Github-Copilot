/**
 * Ember's own sign-in when its GitHub App expires user tokens (review #138): GitHub's default for a GitHub App gives an
 * eight-hour token and a six-month refresh token. The device flow keeps both, the store keeps them, and from an hour
 * before the token runs out, once nothing is under way, Ember renews it (no client secret: a device-flow sign-in's renews
 * without one) and reconnects Copilot with the new token at once: the renewal revokes the old one (cross-review X11). An
 * app whose tokens don't expire changes nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrantKeeper, RENEW_BEFORE_MS, RenewalRefused, TokenStore, pollDeviceGrant, renewGrant, resolveToken, type DeviceCode, type Grant, type SecretBox } from "../../app/main/agent/auth";

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
  it("keeps the whole grant, encrypted", async () => {
    const store = tmpStore();
    const grant: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: 5 * HOUR, refreshExpiresAt: 4000 * HOUR, clientId: CLIENT };
    expect(store.saveResult(grant)).toBe("kept");
    expect(await store.loadGrant()).toEqual(grant);
    expect(await store.load()).toBe(OLD);
  });

  it("still reads a token an earlier Ember saved, and writes a token that doesn't expire as it always did", async () => {
    const store = tmpStore();
    expect(store.save(OLD)).toBe(true);
    expect(await store.loadGrant()).toEqual({ token: OLD });
    expect(store.saveResult({ token: NEW })).toBe("kept");
    expect(box.decryptString(fs.readFileSync((store as unknown as { file: string }).file))).toBe(NEW);
  });

  it("is none when the file is damaged or holds something that isn't a token", async () => {
    const store = tmpStore();
    const file = (store as unknown as { file: string }).file;
    fs.writeFileSync(file, "sealed:{not json");
    expect(await store.loadGrant()).toBeNull();
    fs.writeFileSync(file, `sealed:${JSON.stringify({ token: "ghp_classic", refreshToken: REFRESH })}`);
    expect(await store.loadGrant()).toBeNull();
    expect(await store.load()).toBeNull();
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
    expect(await store.loadGrant()).toMatchObject({ token: NEW, refreshToken: REFRESH2, expiresAt: T0 + 7 * HOUR + 8 * HOUR });
    keeper.stop();
  });

  it("renews only when it can switch: not while something is under way, which keeps the old token (still working) meanwhile (cross-review X11)", async () => {
    let idle = false;
    const { keeper, calls, reconnected } = setup({ idle: () => idle });
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(7 * HOUR + 1000);
    // Renewing would revoke the token Copilot is using for the task: GitHub isn't asked yet.
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(0);
    expect(reconnected).toEqual([]);
    idle = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls).toHaveLength(1);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("renews anyway just before the old token runs out, and switches at once (what's under way would fail then regardless)", async () => {
    const { keeper, calls, reconnected } = setup({ idle: () => false });
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(8 * HOUR - 3 * 60_000);
    expect(calls).toHaveLength(0);
    expect(reconnected).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls).toHaveLength(1);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("never leaves Copilot on a token the renewal revoked (GitHub: the old token stops working once its refresh token is used)", async () => {
    vi.useFakeTimers({ now: T0 });
    const valid = new Set([OLD]);
    // A pretend GitHub that does what its docs say: using the refresh token revokes the old token at once.
    const fetch = async () => { valid.delete(OLD); valid.add(NEW); return renewed(); };
    const store = tmpStore();
    const grant: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT };
    store.saveResult(grant);
    let inUse: string | null = OLD;
    let busy = true;
    /** Each time the token in use was checked, whether GitHub still took it. */
    const revokedInUse: boolean[] = [];
    // Saved only after Copilot was switched: a slow keyring doesn't hold the switch.
    const save = store.saveResult.bind(store);
    store.saveResult = g => { revokedInUse.push(!valid.has(inUse!)); return save(g); };
    const keeper = new GrantKeeper({ fetch, store: () => store, inUse: () => inUse, idle: () => !busy, reconnect: async t => { inUse = t; } });
    keeper.use(OLD, grant);
    await vi.advanceTimersByTimeAsync(7 * HOUR + 1000);
    // A task runs for 40 minutes past the renewal time, checking the token every minute (Copilot renews its own session
    // with it, and Ember's own reconnects use it).
    for (let m = 0; m < 60; m++) {
      await vi.advanceTimersByTimeAsync(60_000);
      revokedInUse.push(!valid.has(inUse!));
      if (m === 40) busy = false;
    }
    expect(inUse).toBe(NEW);
    expect(revokedInUse.filter(Boolean)).toEqual([]);
    keeper.stop();
  });

  it("asks GitHub once when Check again comes during a renewal (a refresh token works once)", async () => {
    vi.useFakeTimers({ now: T0 });
    let answer: (r: Reply) => void = () => undefined;
    const bodies: string[] = [];
    const fetch = (_url: string, init: { body: string }) => { bodies.push(init.body); return new Promise<Reply>(r => { answer = r; }); };
    const store = tmpStore();
    const grant: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT };
    store.saveResult(grant);
    let inUse: string | null = OLD;
    const keeper = new GrantKeeper({ fetch, store: () => store, inUse: () => inUse, idle: () => true, reconnect: async t => { inUse = t; } });
    keeper.use(OLD, grant);
    await vi.advanceTimersByTimeAsync(7 * HOUR + 1000);
    expect(bodies).toHaveLength(1);
    const checking = keeper.freshen();
    await vi.advanceTimersByTimeAsync(0);
    answer(renewed());
    await checking;
    expect(bodies).toHaveLength(1);
    expect(inUse).toBe(NEW);
    expect(await store.load()).toBe(NEW);
    keeper.stop();
  });

  it("renews at once when the computer wakes past the renewal time (timers stand still while it sleeps) (cross-review X12)", async () => {
    const { keeper, calls, reconnected } = setup({ idle: () => false });
    keeper.use(OLD);
    // Half an hour awake, then the lid closes for 14 hours: the wall clock moves on, the timers don't.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    vi.setSystemTime(Date.now() + 14 * HOUR);
    keeper.wake();
    await vi.advanceTimersByTimeAsync(0);
    // The token ran out while it slept: renewed and switched to at once, whatever is under way.
    expect(calls).toHaveLength(1);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("looks at the clock again every few minutes, so a wake it wasn't told about is noticed too (cross-review X12)", async () => {
    const { keeper, calls, reconnected } = setup();
    keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    vi.setSystemTime(Date.now() + 14 * HOUR);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(1);
    expect(reconnected).toEqual([NEW]);
    keeper.stop();
  });

  it("renews when Copilot refuses a sign-in whose renewal time has come, and leaves any other refusal alone (cross-review X12)", async () => {
    const early = setup();
    early.keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(60_000);
    // Hours left: the refusal is the account's (no Copilot now); a renewed token would be refused too, so none is asked.
    early.keeper.refused(OLD);
    await vi.advanceTimersByTimeAsync(0);
    expect(early.calls).toHaveLength(0);
    early.keeper.stop();

    const due = setup({ idle: () => false });
    due.keeper.use(OLD);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.setSystemTime(Date.now() + 9 * HOUR);
    // Another sign-in's refusal (the GitHub CLI's) isn't this one's.
    due.keeper.refused("gho_" + "c".repeat(36));
    await vi.advanceTimersByTimeAsync(0);
    expect(due.calls).toHaveLength(0);
    // Its own: renewed now, and Copilot reconnected with the new token, though the refused work is still winding down.
    due.keeper.refused(OLD);
    await vi.advanceTimersByTimeAsync(0);
    expect(due.calls).toHaveLength(1);
    expect(due.reconnected).toEqual([NEW]);
    // The new one refused too (the account lost Copilot): no second renewal.
    due.keeper.refused(NEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(due.calls).toHaveLength(1);
    due.keeper.stop();
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
    expect(await store.loadGrant()).toEqual(grant);
    // The GitHub CLI wait looks every 3 s: GitHub isn't asked each time.
    await keeper.freshen();
    expect(calls).toHaveLength(1);
    vi.setSystemTime(T0 + 9 * HOUR + 61_000);
    await keeper.freshen();
    expect(calls).toHaveLength(2);
    expect(await store.load()).toBe(NEW);
    // Fresh now: nothing more to do.
    vi.setSystemTime(T0 + 9 * HOUR + 3 * 60_000);
    await keeper.freshen();
    expect(calls).toHaveLength(2);
  });

  it("uses a stored sign-in renewed before use that couldn't be saved (a full or read-only disk), not the one on disk (cross-review X13)", async () => {
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    vi.useFakeTimers({ now: T0 });
    const { fetch, calls } = github(renewed(), renewed(NEW, REFRESH2));
    const store = tmpStore();
    const file = (store as unknown as { file: string }).file;
    expect(store.saveResult({ token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT })).toBe("kept");
    // The disk is full (or read-only) by the next morning: the file can't be written (TokenStore says "write-failed").
    fs.mkdirSync(`${file}.${process.pid}.tmp`);
    let inUse: string | null = null;
    const keeper = new GrantKeeper({ fetch, store: () => store, inUse: () => inUse, idle: () => true, reconnect: async t => { inUse = t; }, log: (event, data) => logs.push({ event, data }) });
    vi.setSystemTime(T0 + 9 * HOUR);
    await keeper.freshen();
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([{ event: "auth.renewed", data: { when: "before use", kept: "write-failed" } }]);
    // GitHub revoked the token and refresh token on disk with the renewal: Ember connects with the renewed one, as its own.
    expect(await resolveToken(store, {}, async () => null)).toEqual({ token: NEW, source: "stored" });
    // Check again a minute later doesn't spend the old refresh token again.
    vi.setSystemTime(T0 + 9 * HOUR + 61_000);
    await keeper.freshen();
    expect(calls).toHaveLength(1);
    // Connected with it: it is kept alive too (renewed seven hours later).
    inUse = NEW;
    keeper.use(NEW);
    await vi.advanceTimersByTimeAsync(8 * HOUR);
    expect(calls).toHaveLength(2);
    keeper.stop();
    // Signing out forgets it.
    store.clear();
    expect(await resolveToken(store, {}, async () => null)).toBeNull();
  });

  /** A stored sign-in that ran out while Ember was off, renewed before use with GitHub's answer held back. */
  function slowRenewal() {
    vi.useFakeTimers({ now: T0 });
    let answer: (r: Reply) => void = () => undefined;
    const fetch = () => new Promise<Reply>(r => { answer = r; });
    const store = tmpStore();
    store.saveResult({ token: OLD, refreshToken: REFRESH, expiresAt: T0 - HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT });
    const logs: string[] = [];
    const keeper = new GrantKeeper({ fetch, store: () => store, inUse: () => null, idle: () => true, reconnect: async () => undefined, log: event => logs.push(event) });
    return { keeper, store, logs, answer: (r: Reply) => answer(r) };
  }

  it("saves nothing back when the user signs out while a stored sign-in is renewed before use (final review S1)", async () => {
    const { keeper, store, logs, answer } = slowRenewal();
    const starting = keeper.freshen();
    await vi.advanceTimersByTimeAsync(0);
    // Sign out (main's handler): the stored sign-in goes, and the keeper keeps none alive.
    store.clear();
    keeper.use(null);
    answer(renewed());
    await starting;
    // The account the user left isn't written back, so nothing connects with it now or at the next start.
    expect(store.hasSaved()).toBe(false);
    expect(await resolveToken(store, {}, async () => null)).toBeNull();
    expect(logs).toEqual(["auth.renewal_dropped"]);
  });

  it("saves nothing back when the user signs out while the keychain is asked for the stored sign-in (macOS) (final review S1)", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fetch } = github(renewed());
    let opened: () => void = () => undefined;
    const mac: SecretBox = {
      ...box, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async s => box.encryptString(s),
      decryptStringAsync: b => new Promise(r => { opened = () => r({ result: box.decryptString(b), shouldReEncrypt: false }); }),
    };
    const store = new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-grant-")), "github-token.bin"), mac, { asyncKeyring: true });
    store.saveResult({ token: OLD, refreshToken: REFRESH, expiresAt: T0 - HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT });
    const keeper = new GrantKeeper({ fetch, store: () => store, inUse: () => null, idle: () => true, reconnect: async () => undefined });
    const starting = keeper.freshen();
    store.clear();
    keeper.use(null);
    opened();
    await starting;
    expect(store.hasSaved()).toBe(false);
    expect(await store.loadGrant()).toBeNull();
  });

  it("gives back the sign-in saved while the keychain was still opening the previous one (macOS) (final review S1)", async () => {
    vi.useFakeTimers({ now: T0 });
    let opened: () => void = () => undefined;
    const mac: SecretBox = {
      ...box, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async s => box.encryptString(s),
      decryptStringAsync: b => new Promise(r => { opened = () => r({ result: box.decryptString(b), shouldReEncrypt: false }); }),
    };
    const store = new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-grant-")), "github-token.bin"), mac, { asyncKeyring: true });
    const previous: Grant = { token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT };
    store.saveResult(previous);
    const reading = store.loadGrant();
    // The device flow lands while the keychain is still opening the account the file held.
    const other: Grant = { token: "ghu_" + "c".repeat(36), refreshToken: "ghr_" + "t".repeat(76), expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT };
    const saving = store.saveAsync(other);
    opened();
    await expect(reading).resolves.toEqual(other);
    await saving;
    // Written: the next open is the new sign-in, not the account the first open decrypted.
    const again = store.loadGrant();
    opened();
    await expect(again).resolves.toEqual(other);
  });

  it("gives back nothing when the user signs out while the keychain is still opening the stored sign-in (macOS) (final review S1)", async () => {
    vi.useFakeTimers({ now: T0 });
    let opened: () => void = () => undefined;
    const mac: SecretBox = {
      ...box, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async s => box.encryptString(s),
      decryptStringAsync: b => new Promise(r => { opened = () => r({ result: box.decryptString(b), shouldReEncrypt: false }); }),
    };
    const store = new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-grant-")), "github-token.bin"), mac, { asyncKeyring: true });
    store.saveResult({ token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT });
    const reading = store.loadGrant();
    store.clear();
    opened();
    await expect(reading).resolves.toBeNull();
    expect(store.hasSaved()).toBe(false);
  });

  it("doesn't save a renewal before use over another account's sign-in made meanwhile (final review S1)", async () => {
    const { keeper, store, answer } = slowRenewal();
    const starting = keeper.freshen();
    await vi.advanceTimersByTimeAsync(0);
    // The device flow signs in as someone else while GitHub is slow to answer.
    const other: Grant = { token: "ghu_" + "c".repeat(36), refreshToken: "ghr_" + "t".repeat(76), expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT };
    expect(await store.saveAsync(other)).toBe("kept");
    answer(renewed());
    await starting;
    expect(await store.loadGrant()).toEqual(other);
  });

  it("doesn't renew a stored sign-in with hours left", async () => {
    const { keeper, calls } = setup();
    vi.setSystemTime(T0 + 8 * HOUR - RENEW_BEFORE_MS - 60_000);
    await keeper.freshen();
    expect(calls).toHaveLength(0);
  });

  it("reads and saves the stored sign-in as the store does (macOS: asynchronously, so the keychain prompt holds no main process)", async () => {
    vi.useFakeTimers({ now: T0 });
    const { fetch, calls } = github(renewed(), renewed(NEW, REFRESH2));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ember-grant-")), "github-token.bin");
    const syncReads = vi.fn((b: Buffer) => box.decryptString(b));
    const syncSeals = vi.fn((s: string) => box.encryptString(s));
    // Whether the keyring is there, asked on the main thread: on macOS that fetches the keychain's key, and can prompt.
    const syncCheck = vi.fn(() => true);
    const mac: SecretBox = {
      ...box, decryptString: syncReads, encryptString: syncSeals, isEncryptionAvailable: syncCheck, isAsyncEncryptionAvailable: async () => true,
      decryptStringAsync: async b => ({ result: box.decryptString(b), shouldReEncrypt: false }), encryptStringAsync: async s => box.encryptString(s),
    };
    new TokenStore(file, box).saveResult({ token: OLD, refreshToken: REFRESH, expiresAt: T0 + 8 * HOUR, refreshExpiresAt: T0 + 4000 * HOUR, clientId: CLIENT });
    const store = new TokenStore(file, mac, { asyncKeyring: true });
    let inUse: string | null = OLD;
    const keeper = new GrantKeeper({ fetch, store: () => store, inUse: () => inUse, idle: () => true, reconnect: async t => { inUse = t; } });
    // A stored sign-in that ran out while Ember was off is renewed before use, read without decryptString.
    vi.setSystemTime(T0 + 9 * HOUR);
    await keeper.freshen();
    expect(calls).toHaveLength(1);
    // Connected with it: its grant is read the same way and kept alive.
    inUse = NEW;
    keeper.use(NEW);
    await vi.advanceTimersByTimeAsync(8 * HOUR);
    expect(calls).toHaveLength(2);
    expect(inUse).toBe(NEW);
    expect(syncReads).not.toHaveBeenCalled();
    // Both renewals were saved, sealed off the main thread too (follow-up to review #241).
    expect(syncSeals).not.toHaveBeenCalled();
    expect(syncCheck).not.toHaveBeenCalled();
    expect(await new TokenStore(file, box).load()).toBe(NEW);
    keeper.stop();
  });

  it("drops a stored grant read for a sign-in that is no longer the one in use", async () => {
    const { keeper, calls } = setup();
    keeper.use(OLD);
    // Signed out (or another sign-in used) before the stored one was read.
    keeper.use(null);
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(calls).toHaveLength(0);
  });
});

describe("main's sign-in wiring", () => {
  /** main.ts without line comments, every run of white space made one space (it can't be loaded in a unit test). */
  const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

  it("keeps the device flow's whole grant, and keeps the sign-in in use alive", () => {
    expect(MAIN).toContain("const grant = await pollDeviceGrant(fetch, clientId, code,");
    expect(MAIN).toContain("const saving = tokens?.saveAsync(grant) ?? Promise.resolve<SaveResult>(\"no-keyring\");");
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

  it("seals the saved sign-in off the main thread on macOS, as it reads it (follow-up to review #241)", () => {
    expect(MAIN).toContain(`safeStorage, { version: app.getVersion(), asyncKeyring: platform.os === "darwin" });`);
    // Signed out while the keyring was asked (or Copilot connected): nothing more is said or logged for this sign-in.
    expect(MAIN).toMatch(/const kept = await saving; if \(currentToken !== token\) return;/);
  });

  it("switches Copilot to a device-flow sign-in in the same step as it is put in use, the save going on beside the connection", () => {
    // With no await between them, a refusal of the connection it replaces (still on the old token) is dropped by the
    // host rather than taken for the new sign-in, and a Cancel during a macOS keychain prompt finds Ember already
    // connecting, as it always did once the code was approved.
    expect(MAIN).toContain([
      "if (ac.signal.aborted) return; currentToken = token; keeper.use(token, grant);",
      "const saving = tokens?.saveAsync(grant) ?? Promise.resolve<SaveResult>(\"no-keyring\");",
      "const phase = await agent?.start(token, \"stored\"); const kept = await saving; if (currentToken !== token) return;",
    ].join(" "));
    expect(MAIN).toContain("await connected(phase, kept === \"kept\" ? undefined : `Signed in. ${why}, so you'll need to sign in again next time.`);");
  });

  it("connects nothing a look under way found when the user signed out, so Sign out isn't undone (final review S1)", () => {
    // Counted as soon as it is clicked, before the conversation is deleted and the stored sign-in cleared.
    expect(MAIN).toMatch(/ipcMain\.handle\(IPC\.signOut, guard\(async \(\) => \{ signOuts\+\+; signInAbort\?\.abort\(\);/);
    // Signed out since the look began: nothing is connected, the first sign-in found or the next after a refusal.
    expect(MAIN).toContain([
      "const connectWith = async (found: ResolvedToken | null, how: \"user\" | \"auto\" = \"user\", since = signOuts) => {",
      "if (since !== signOuts) return { phase: agent?.getStatus().phase, found: null };",
      "return connectFirstAccepted(async () => { const next = await findToken(); return since === signOuts ? next : null; }, async f => {",
    ].join(" "));
    // Check again's look and the start's (from before the keychain pause and the renewal) count from when they began.
    expect(MAIN).toMatch(/const since = signOuts; const first = await findToken\(\) \?\? [^;]*; const \{ found \} = await connectWith\(first, "user", since\);/);
    expect(MAIN).toMatch(/const startBrain = async \(\) => \{ if \(brainStarted \|\| !consented\(\)\) return; brainStarted = true; const since = signOuts;/);
    expect(MAIN).toContain(": await connectWith(found, \"auto\", since);");
  });

  it("tells the keeper when the computer wakes or Copilot refuses the sign-in in use (cross-review X12)", () => {
    expect(MAIN).toContain(`powerMonitor.on("resume", () => { keeper.wake(); agent?.networkChanged(true); });`);
    expect(MAIN).toContain(`powerMonitor.on("unlock-screen", () => keeper.wake());`);
    expect(MAIN).toContain(`if (status.phase === "error" && status.reason === "sign-in" && currentToken) { refusedTokens.add(currentToken); keeper.refused(currentToken); }`);
  });
});
