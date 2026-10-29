/**
 * GitHub sign-in for Copilot.
 *
 * Order: a token Ember stored (encrypted with the OS keyring via safeStorage),
 * then COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, then `gh auth token`.
 * New sign-ins use GitHub's device flow with Ember's own app (its client id is
 * built in from github-app.ts, and EMBER_GITHUB_CLIENT_ID overrides it); a build
 * without a client id signs in through the GitHub CLI.
 * Classic `ghp_` tokens are refused: the Copilot runtime does not accept them.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type TokenSource = "stored" | "environment" | "github-cli";
/** A sign-in found, where from, and for the environment the variable that holds it (a refusal names it). */
export interface ResolvedToken { token: string; source: TokenSource; name?: string }

export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  /** Electron's asynchronous read: the keyring's key is fetched off the main process's thread (macOS's keychain prompt). */
  decryptStringAsync?(b: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  /** Electron's asynchronous write, the same way (Electron 44 has both). */
  encryptStringAsync?(s: string): Promise<Buffer>;
  /**
   * Whether the asynchronous write and read work, asked off the main process's thread too: on macOS the synchronous
   * isEncryptionAvailable fetches the keychain's key on it, which can prompt.
   */
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  /** "basic_text" means no keyring: nothing secret should be written to disk. */
  getSelectedStorageBackend?(): string;
}

/** Whether a sign-in was kept on disk, and why not: no keyring (or the keyring refused), or the file couldn't be written. */
export type SaveResult = "kept" | "no-keyring" | "write-failed";

export function isUsableToken(t: string | undefined | null): t is string {
  return !!t && /^(gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(t.trim());
}

export class TokenStore {
  /**
   * The last read (load, loadGrant) found a saved sign-in the keyring wouldn't open (decryptString threw: macOS's
   * keychain prompt answered Deny or Cancel, which an ad-hoc-signed Ember meets after every update). The file is kept,
   * to try again.
   */
  unreadable = false;

  /**
   * A sign-in this run couldn't write (no keyring, the keyring refused, a full or read-only disk): every read gives it
   * instead of the file's until one is written or the store is cleared (sign-out), so Ember carries on with it "for this
   * run" whoever reads it next (cross-review X13). A renewal revokes the token and refresh token the file still holds.
   */
  private held: Grant | null = null;
  /** Counts clear() and saveResult(): a saveAsync begun before either is out of date, and writes nothing. */
  private epoch = 0;
  /** saveAsync's writes, one after another in the order they were asked for. */
  private saving: Promise<unknown> = Promise.resolve();

  /**
   * `version`: this Ember's, kept beside the saved sign-in once it has read it (see firstReadSinceUpdate).
   * `asyncKeyring` (macOS): the keyring is asked off the main process's thread, so the keychain prompt holds none: every
   * read (load, loadGrant) opens the sign-in with decryptStringAsync, and saveAsync seals it with encryptStringAsync.
   */
  constructor(private file: string, private box: SecretBox, private opts: { version?: string; asyncKeyring?: boolean } = {}) {}

  /** Whether a token can be kept across restarts on this machine. */
  canPersist(): boolean {
    return this.box.isEncryptionAvailable() && this.box.getSelectedStorageBackend?.() !== "basic_text";
  }

  /**
   * canPersist, asking the keyring only off the main process's thread (saveAsync): isAsyncEncryptionAvailable, never
   * isEncryptionAvailable (macOS: it fetches the keychain's key on the main thread, so a keychain prompt would hold Ember).
   * A keyring without the question is tried: a refused encryptStringAsync means none.
   */
  private async canPersistAsync(): Promise<boolean> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text") return false;
    return (await this.box.isAsyncEncryptionAvailable?.()) ?? true;
  }

  /** Is a sign-in saved (whether or not the keyring will open it)? Reads no secret. */
  hasSaved(): boolean {
    return fs.existsSync(this.file);
  }

  /** The version of Ember that last opened or saved the sign-in, beside it. */
  private get readStamp(): string {
    return path.join(path.dirname(this.file), "token-read-version");
  }

  /**
   * Is a sign-in saved that this version of Ember hasn't opened yet? macOS's keychain asks only after an
   * ad-hoc-signed Ember's identity changed, which is an update: then reading it may ask first. Reads no secret.
   */
  firstReadSinceUpdate(): boolean {
    if (!this.hasSaved()) return false;
    try {
      return fs.readFileSync(this.readStamp, "utf8") !== this.opts.version;
    } catch {
      return true; // no stamp yet (saved by an earlier Ember)
    }
  }

  /** The keyring let this version in: noted, so its next start reads without the keychain words. */
  private stamp(): void {
    if (!this.opts.version) return;
    try {
      if (!this.firstReadSinceUpdate()) return;
      fs.writeFileSync(this.readStamp, this.opts.version, { mode: 0o600 });
    } catch { /* only the keychain words come once more */ }
  }

  async load(): Promise<string | null> {
    return (await this.loadGrant())?.token ?? null;
  }

  /**
   * The stored sign-in with what renews it (an expiring token from Ember's GitHub App), or a token alone (a file an
   * earlier Ember wrote, or an app whose tokens don't expire); null when there is none usable. Every read goes through
   * here, so on macOS none holds the main process while the keychain asks (asyncKeyring).
   */
  async loadGrant(): Promise<Grant | null> {
    if (this.held) {
      this.unreadable = false;
      return this.held;
    }
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      this.unreadable = false;
      return null; // none saved
    }
    let t: string;
    try {
      // Sealed by encryptString, opened by decryptStringAsync on macOS: the same keychain key, so shouldReEncrypt is
      // false and the file is left as it is (darwin-system checks both on a real Mac).
      t = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(raw)).result : this.box.decryptString(raw);
    } catch {
      this.unreadable = true;
      return null;
    }
    this.unreadable = false;
    this.stamp();
    try {
      if (!t.startsWith("{")) return isUsableToken(t) ? { token: t } : null;
      return parseGrant(JSON.parse(t));
    } catch {
      return null;
    }
  }

  /**
   * Keeps the token encrypted; false when it can't be kept (no keyring, or the keyring refused: macOS's Keychain
   * prompt answered "Deny" makes encryptString throw; or the file can't be written: a full, read-only or missing
   * folder), so sign-in carries on with "sign in again next time". Never throws.
   */
  save(token: string | Grant): boolean {
    return this.saveResult(token) === "kept";
  }

  /**
   * save(), saying why a token wasn't kept: "no-keyring" (nothing secret may go to disk, or the keyring refused) or
   * "write-failed". The file is written whole or not at all (a temporary file renamed over it), owner-only. One not
   * kept is still read back for the rest of this run (held).
   */
  saveResult(token: string | Grant): SaveResult {
    this.epoch++;
    let kept: SaveResult = "no-keyring";
    if (this.canPersist()) {
      try {
        kept = this.write(this.box.encryptString(sealedText(token)));
      } catch { /* the keyring refused: "no-keyring" */ }
    }
    this.held = kept === "kept" ? null : grantOf(token);
    return kept;
  }

  /**
   * saveResult, sealed off the main process's thread where the keyring is asked that way (asyncKeyring, macOS:
   * isAsyncEncryptionAvailable and encryptStringAsync, so a keychain prompt holds nothing up; the follow-up to review
   * #241); elsewhere saveResult itself. Every read meanwhile gives this sign-in. Saves are written in the order asked; a
   * sign-out (clear) while the keyring is asked wins, and nothing is written ("write-failed"). Never rejects.
   */
  saveAsync(token: string | Grant): Promise<SaveResult> {
    const encrypt = this.box.encryptStringAsync?.bind(this.box);
    if (!this.opts.asyncKeyring || !encrypt) return Promise.resolve(this.saveResult(token));
    const grant = grantOf(token);
    const epoch = this.epoch;
    this.held = grant;
    const run = this.saving.then(async (): Promise<SaveResult> => {
      let sealed: Buffer | null = null;
      try {
        if (await this.canPersistAsync()) sealed = await encrypt(sealedText(token));
      } catch { /* no keyring, or it refused: "no-keyring" */ }
      if (epoch !== this.epoch) return "write-failed";
      const kept = sealed ? this.write(sealed) : "no-keyring";
      // Read from the file from now on, unless a newer sign-in is being saved meanwhile.
      if (kept === "kept" && this.held === grant) this.held = null;
      return kept;
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  /** Writes a sealed sign-in whole or not at all (a temporary file renamed over it), owner-only. */
  private write(sealed: Buffer): SaveResult {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, sealed, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.unreadable = false;
      this.stamp();
      return "kept";
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
      return "write-failed";
    }
  }

  clear(): void {
    this.epoch++;
    this.unreadable = false;
    this.held = null;
    try { fs.rmSync(this.file); } catch { /* already gone */ }
  }
}

/** How to ask the GitHub CLI: where it is (default "gh" on PATH) and the platform's spawn options (Windows: windowsHide). */
export interface GhCliOptions {
  /** An absolute path from the platform's ghCliPath() (macOS apps started from Finder lack Homebrew on PATH). */
  path?: string;
  /** Spread into execFile (the platform's spawnDefaults: no console window flashing on Windows every 3 s of a sign-in). */
  spawn?: { windowsHide?: boolean };
  timeoutMs?: number;
}

/**
 * The GitHub CLI's token for github.com (`gh auth token --hostname github.com`: Copilot is on github.com, whatever GH_HOST
 * or gh's default host says), or null when gh is missing, isn't signed in to github.com, or gives an unusable token.
 */
export function ghCliToken(o: GhCliOptions = {}): Promise<string | null> {
  return new Promise(resolve => {
    execFile(o.path ?? "gh", ["auth", "token", "--hostname", "github.com"], { ...o.spawn, timeout: o.timeoutMs ?? 3000 }, (err, stdout) => {
      const t = stdout?.trim();
      resolve(!err && isUsableToken(t) ? t : null);
    });
  });
}

/**
 * The token Ember uses: its own stored one, then the environment's, then the GitHub CLI's. `gh` is how the CLI is
 * asked: a function (tests), or the options ghCliToken takes (main passes the platform's path and spawn options).
 * `skip`: tokens Copilot refused this run (a stale GH_TOKEN): the next source is looked at instead.
 */
export async function resolveToken(
  store: TokenStore | null,
  env: NodeJS.ProcessEnv = process.env,
  gh: (() => Promise<string | null>) | GhCliOptions = {},
  skip: ReadonlySet<string> = new Set(),
): Promise<ResolvedToken | null> {
  const stored = await store?.load();
  if (stored && !skip.has(stored)) return { token: stored, source: "stored" };
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const t = env[name]?.trim();
    if (isUsableToken(t) && !skip.has(t)) return { token: t, source: "environment", name };
  }
  const fromGh = await (typeof gh === "function" ? gh() : ghCliToken(gh));
  return fromGh && !skip.has(fromGh) ? { token: fromGh, source: "github-cli" } : null;
}

/**
 * Connects with the first sign-in Copilot accepts. `find` gives the next one not in `refused` (null: none), `start`
 * connects with it and says whether Copilot refused that sign-in; a refused token goes into `refused` and the next
 * source is tried, so a stale token in the environment doesn't shadow a working GitHub CLI sign-in. Any other failure
 * (offline, the runtime) stands, as does the last refusal when nothing else is left (its message names it).
 */
export async function connectFirstAccepted<P>(
  find: () => Promise<ResolvedToken | null>,
  start: (found: ResolvedToken | null) => Promise<{ phase: P; refused: boolean }>,
  refused: Set<string>,
  first?: ResolvedToken | null,
): Promise<{ phase: P; found: ResolvedToken | null }> {
  let found = first === undefined ? await find() : first;
  // Each source at most once (there are five), whatever `find` answers.
  for (let n = 0; ; n++) {
    const r = await start(found);
    if (!r.refused || !found || n >= 5) return { phase: r.phase, found };
    refused.add(found.token);
    const next = await find();
    if (!next || refused.has(next.token)) return { phase: r.phase, found };
    found = next;
  }
}

// ───────────── device flow ─────────────

/**
 * A sign-in from Ember's GitHub App. When the app expires user tokens (GitHub's default for a GitHub App), the token
 * lasts eight hours and comes with a refresh token (six months) that renews it; a device-flow sign-in's renews without
 * the app's secret, which a desktop app can't keep. Times are milliseconds since the epoch.
 */
export interface Grant {
  token: string;
  refreshToken?: string;
  /** When the token stops working (none: it doesn't expire). */
  expiresAt?: number;
  /** When the refresh token stops working: after it only signing in again helps. */
  refreshExpiresAt?: number;
  /** The client id that issued it, the only one that may renew it (EMBER_GITHUB_CLIENT_ID may differ from the built-in one). */
  clientId?: string;
}

/** A token alone is written as it always was (an earlier Ember reads it); one that expires, with what renews it. */
function sealedText(token: string | Grant): string {
  return typeof token === "string" ? token : token.expiresAt === undefined ? token.token : JSON.stringify(token);
}

const grantOf = (token: string | Grant): Grant => typeof token === "string" ? { token } : token;

/** A stored grant's fields, checked (a damaged file gives none). */
function parseGrant(j: unknown): Grant | null {
  const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  if (typeof o.token !== "string" || !isUsableToken(o.token)) return null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown) => typeof v === "string" && v ? v : undefined;
  const g: Grant = { token: o.token, refreshToken: str(o.refreshToken), expiresAt: num(o.expiresAt), refreshExpiresAt: num(o.refreshExpiresAt), clientId: str(o.clientId) };
  return Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined)) as unknown as Grant;
}

/** GitHub's token reply as a grant: the token, and when it expires with its refresh token if the app expires tokens. */
function grantFrom(j: Record<string, unknown>, clientId: string, now: number): Grant {
  const token = String(j.access_token);
  const secs = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const expires = secs(j.expires_in);
  const refreshToken = typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : undefined;
  if (expires === undefined || !refreshToken) return { token, ...(expires === undefined ? {} : { expiresAt: now + expires * 1000 }) };
  const refreshExpires = secs(j.refresh_token_expires_in);
  return { token, refreshToken, expiresAt: now + expires * 1000, ...(refreshExpires === undefined ? {} : { refreshExpiresAt: now + refreshExpires * 1000 }), clientId };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const HEADERS = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };

export async function startDeviceFlow(fetch: Fetch, clientId: string, scope = "read:user"): Promise<DeviceCode> {
  const res = await fetch("https://github.com/login/device/code", { method: "POST", headers: HEADERS, body: form({ client_id: clientId, scope }) });
  if (!res.ok) throw new Error(`GitHub refused the sign-in request (${res.status})`);
  const j = await res.json() as Record<string, unknown>;
  // A refusal can come back as 200 with an error (device_flow_disabled, incorrect_client_credentials): never a code of
  // "undefined" for the user to type.
  if (typeof j.error === "string" || typeof j.device_code !== "string" || typeof j.user_code !== "string") {
    throw new Error(`GitHub refused the sign-in request (400)${typeof j.error === "string" ? `: ${j.error}` : ""}`);
  }
  return {
    deviceCode: String(j.device_code),
    userCode: String(j.user_code),
    verificationUri: String(j.verification_uri),
    expiresIn: Number(j.expires_in ?? 900),
    interval: Number(j.interval ?? 5),
  };
}

/**
 * Polls until the user approves, the code expires, or `signal` aborts. A request that fails, a reply that isn't GitHub's
 * JSON (a proxy's HTML error page) or a 5xx is a blip (Wi-Fi roaming, a VPN reconnecting): it waits one interval and
 * asks again, so the code the user is entering isn't lost. `onBlip` hears each one (the log).
 */
export async function pollDeviceFlow(
  fetch: Fetch, clientId: string, code: DeviceCode,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; onBlip?: (err: unknown) => void } = {},
): Promise<string> {
  return (await pollDeviceGrant(fetch, clientId, code, opts)).token;
}

/** pollDeviceFlow's sign-in with what renews it: its refresh token and when each expires (review #138). */
export async function pollDeviceGrant(
  fetch: Fetch, clientId: string, code: DeviceCode,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; onBlip?: (err: unknown) => void } = {},
): Promise<Grant> {
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  let interval = code.interval;
  const deadline = Date.now() + code.expiresIn * 1000;
  const cancelled = () => { const e = new Error("Sign-in cancelled"); e.name = "AbortError"; return e; };
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw cancelled();
    await sleep(interval * 1000);
    // Cancelled (or signed out) while waiting: nothing more is fetched, and no token comes back.
    if (opts.signal?.aborted) throw cancelled();
    let res: Awaited<ReturnType<Fetch>>;
    let j: Record<string, unknown>;
    try {
      res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", headers: HEADERS,
        body: form({ client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      if (res.status >= 500) throw new Error(`GitHub answered ${res.status}`);
      j = await res.json() as Record<string, unknown>;
      if (!j || typeof j !== "object") throw new Error("GitHub's answer wasn't JSON");
    } catch (err) {
      if (opts.signal?.aborted) throw cancelled();
      opts.onBlip?.(err);
      continue;
    }
    if (opts.signal?.aborted) throw cancelled();
    if (typeof j.access_token === "string") return grantFrom(j, clientId, Date.now());
    switch (j.error) {
      case "authorization_pending": break;
      case "slow_down": interval = Number(j.interval ?? interval + 5); break;
      case "expired_token": throw new Error("The sign-in code expired. Start again.");
      case "access_denied": throw new Error("Sign-in was cancelled on GitHub.");
      default: throw new Error(`GitHub sign-in failed: ${String(j.error_description ?? j.error ?? res.status)}`);
    }
  }
  throw new Error("The sign-in code expired. Start again.");
}

/** GitHub won't renew this sign-in (its refresh token expired or was revoked): only signing in again helps. */
export class RenewalRefused extends Error {}

/**
 * A renewed grant for an expiring one (GitHub's refresh_token grant; a device-flow sign-in needs no client secret).
 * Throws RenewalRefused when GitHub says no; anything else it throws (no network, a 5xx, a proxy's page) passes.
 */
export async function renewGrant(fetch: Fetch, grant: Grant, now: () => number = Date.now): Promise<Grant> {
  if (!grant.refreshToken || !grant.clientId) throw new RenewalRefused("This sign-in can't be renewed.");
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: HEADERS,
    body: form({ client_id: grant.clientId, grant_type: "refresh_token", refresh_token: grant.refreshToken }),
  });
  if (res.status >= 500) throw new Error(`GitHub answered ${res.status}`);
  const j = await res.json() as Record<string, unknown>;
  if (j && typeof j.access_token === "string" && isUsableToken(j.access_token)) return grantFrom(j, grant.clientId, now());
  throw new RenewalRefused(`GitHub didn't renew the sign-in: ${String(j?.error ?? res.status)}`);
}

/** How long before an expiring sign-in runs out Ember renews it (once nothing is under way). */
export const RENEW_BEFORE_MS = 60 * 60_000;
/**
 * A sign-in due for renewal waits for nothing to be under way, checking this often: renewing it revokes the token
 * Copilot holds (GitHub: "the old user access token will no longer work"), so Copilot is reconnected with the new one at
 * once, which would cut off what's under way...
 */
const IDLE_CHECK_MS = 30_000;
/** ...but no closer than this to the old one's end: it is renewed then anyway (what's under way would fail regardless). */
const FORCE_BEFORE_MS = 2 * 60_000;
/** A renewal that failed in passing (no network) is tried again after this. */
const RENEW_RETRY_MS = 60_000;
/**
 * The keeper's timer waits at most this long before the clock is looked at again: timers stand still while the computer
 * sleeps (Linux, macOS), so one armed for hours could fire long after the token ran out (cross-review X12).
 */
const RECHECK_MS = 5 * 60_000;

export interface GrantKeeperDeps {
  fetch: Fetch;
  store: () => TokenStore | null;
  /** The token Copilot is connected with now: only that one's grant is kept alive. */
  inUse: () => string | null;
  /** Nothing a reconnect would cut off (no answer, request or task under way). */
  idle: () => boolean;
  /** Reconnects Copilot with the renewed token (the same account: the conversation carries on). */
  reconnect: (token: string) => Promise<unknown>;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * Keeps Ember's own sign-in working when its token expires (review #138): from an hour before the end, once nothing is
 * under way (or two minutes before the end regardless), the grant is renewed, Copilot is reconnected with the new token
 * at once, and the new grant is saved. Renewing first and switching later would leave Copilot, and every reconnect it
 * makes on its own, on a token GitHub revoked at the renewal (cross-review X11). A grant that doesn't expire (the app's
 * "Expire user authorization tokens" off) needs none of this. One GitHub won't renew is left to run out: Copilot then
 * refuses it, and the settings window offers Sign in again.
 */
export class GrantKeeper {
  private grant: Grant | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFreshen = -Infinity;
  /** Counts use() and stop() calls: a stored grant read for an earlier use() is dropped when another came meanwhile. */
  private turn = 0;
  /** Renewals under way, by refresh token (see renewed). */
  private readonly renewals = new Map<string, Promise<Grant>>();

  constructor(private d: GrantKeeperDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /**
   * Copilot connects with `token` now: its grant is kept alive (`grant`; else the one kept alive already, which may be
   * in memory only, without a keyring; else the stored one), and none when the token is another sign-in's.
   */
  use(token: string | null, grant?: Grant | null): void {
    const g = grant ?? (this.grant?.token === token ? this.grant : null);
    const store = token && !g ? this.d.store() : null;
    if (!store) { this.track(token && g?.token === token ? g : null); return; }
    this.stop();
    // The stored one is read as every read of it is (on macOS without holding the main process while the keychain asks).
    const turn = this.turn;
    void store.loadGrant().then(s => {
      if (turn === this.turn && this.d.inUse() === token) this.track(s?.token === token ? s : null);
    }, () => undefined);
  }

  stop(): void {
    this.turn++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.grant = null;
  }

  /**
   * Before Ember looks for a sign-in to connect with: a stored one that has run out, or is about to (Ember was off), is
   * renewed first. At most once a minute (the GitHub CLI wait looks every 3 s). Never throws.
   */
  async freshen(): Promise<void> {
    const store = this.d.store();
    const g = await store?.loadGrant();
    if (!store || !g || !renewable(g, this.now()) || this.now() < g.expiresAt! - RENEW_BEFORE_MS) return;
    if (this.now() - this.lastFreshen < RENEW_RETRY_MS) return;
    this.lastFreshen = this.now();
    try {
      const next = await this.renewed(g);
      // The stored one stopped working with the renewal: the store gives the new one from now on, from the file or, not
      // kept (a full or read-only disk), for this run (cross-review X13). Sealed off the main thread on macOS.
      const kept = await store.saveAsync(next);
      this.d.log?.("auth.renewed", { when: "before use", kept });
    } catch (err) {
      this.d.log?.("auth.renew_failed", { err, refused: err instanceof RenewalRefused });
    }
  }

  private track(grant: Grant | null): void {
    this.stop();
    if (!grant || !renewable(grant, this.now())) return;
    this.grant = grant;
    this.after(grant.expiresAt! - RENEW_BEFORE_MS - this.now(), () => this.due(grant));
  }

  private after(ms: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    // A longer wait is cut, and the time looked at again then (due() re-arms when it fires early).
    this.timer = setTimeout(fn, Math.min(Math.max(0, ms), RECHECK_MS));
    this.timer.unref?.();
  }

  /**
   * The computer woke from sleep, or its screen was unlocked: timers stood still while it slept, so the renewal time may
   * have passed unnoticed (the token may even have run out). The clock is looked at now (cross-review X12).
   */
  wake(): void {
    if (this.grant) this.due(this.grant);
  }

  /**
   * Copilot refused the sign-in in use. Ember's own whose renewal time has come (it ran out while the computer slept,
   * before the clock was looked at) is renewed now and Copilot reconnected with the new one, without waiting for what's
   * under way: that failed already. Any other refusal stands: the account may have lost Copilot, and a renewed token
   * would be refused too (cross-review X12).
   */
  refused(token: string): void {
    const g = this.grant;
    if (!g || g.token !== token || this.d.inUse() !== token || this.now() < g.expiresAt! - RENEW_BEFORE_MS) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.renew(g);
  }

  /**
   * The grant's renewal time came (or a check since). It is renewed only when Copilot can be switched to the new token
   * at once: nothing under way, or the old token about to run out. Until then the old one, which still works, stays.
   */
  private due(grant: Grant): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.grant !== grant || this.d.inUse() !== grant.token) return;
    const now = this.now();
    if (now < grant.expiresAt! - RENEW_BEFORE_MS) { this.after(grant.expiresAt! - RENEW_BEFORE_MS - now, () => this.due(grant)); return; }
    if (now < grant.expiresAt! - FORCE_BEFORE_MS && !this.d.idle()) { this.after(IDLE_CHECK_MS, () => this.due(grant)); return; }
    void this.renew(grant);
  }

  private async renew(grant: Grant): Promise<void> {
    let next: Grant;
    try {
      next = await this.renewed(grant);
    } catch (err) {
      const refused = err instanceof RenewalRefused;
      this.d.log?.("auth.renew_failed", { err, refused });
      if (!refused && this.grant === grant && renewable(grant, this.now())) this.after(RENEW_RETRY_MS, () => this.due(grant));
      return;
    }
    if (this.grant !== grant || this.d.inUse() !== grant.token) return;
    // The old token stopped working with the renewal: Copilot is reconnected with the new one at once (with no await
    // between, so the reconnects Copilot makes on its own use it too), and only then is it saved, so a slow keyring
    // doesn't hold the switch (on macOS it is sealed off the main thread). Kept for the next start; not kept (no keyring,
    // a full disk): for this run.
    this.track(next);
    void this.d.reconnect(next.token).catch(err => this.d.log?.("auth.renew_reconnect_failed", { err }));
    const kept = (await this.d.store()?.saveAsync(next)) ?? "no-keyring";
    this.d.log?.("auth.renewed", { kept });
  }

  /**
   * The grant renewed, asking GitHub once however many ask at a time (the timer, freshen): a refresh token works only
   * once, so a second request with it would be refused.
   */
  private renewed(grant: Grant): Promise<Grant> {
    const key = grant.refreshToken ?? "";
    let p = this.renewals.get(key);
    if (!p) {
      p = renewGrant(this.d.fetch, grant, () => this.now()).finally(() => this.renewals.delete(key));
      this.renewals.set(key, p);
    }
    return p;
  }
}

/** A grant Ember can renew: it expires, comes with a refresh token and the client id, and the refresh token still works. */
function renewable(g: Grant, now: number): boolean {
  return g.expiresAt !== undefined && !!g.refreshToken && !!g.clientId && (g.refreshExpiresAt === undefined || now < g.refreshExpiresAt);
}
