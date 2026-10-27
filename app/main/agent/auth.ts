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

export type TokenSource = "stored" | "environment" | "github-cli";
/** A sign-in found, where from, and for the environment the variable that holds it (a refusal names it). */
export interface ResolvedToken { token: string; source: TokenSource; name?: string }

export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  /** "basic_text" means no keyring: nothing secret should be written to disk. */
  getSelectedStorageBackend?(): string;
}

export function isUsableToken(t: string | undefined | null): t is string {
  return !!t && /^(gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(t.trim());
}

export class TokenStore {
  constructor(private file: string, private box: SecretBox) {}

  /** Whether a token can be kept across restarts on this machine. */
  canPersist(): boolean {
    return this.box.isEncryptionAvailable() && this.box.getSelectedStorageBackend?.() !== "basic_text";
  }

  load(): string | null {
    return this.loadGrant()?.token ?? null;
  }

  /**
   * The stored sign-in with what renews it (an expiring token from Ember's GitHub App), or a token alone (a file an
   * earlier Ember wrote, or an app whose tokens don't expire); null when there is none usable.
   */
  loadGrant(): Grant | null {
    try {
      const t = this.box.decryptString(fs.readFileSync(this.file));
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
   * "write-failed". The file is written whole or not at all (a temporary file renamed over it), owner-only.
   */
  saveResult(token: string | Grant): "kept" | "no-keyring" | "write-failed" {
    if (!this.canPersist()) return "no-keyring";
    // A token alone is written as it always was (an earlier Ember reads it); one that expires, with what renews it.
    const text = typeof token === "string" ? token : token.expiresAt === undefined ? token.token : JSON.stringify(token);
    let sealed: Buffer;
    try {
      sealed = this.box.encryptString(text);
    } catch {
      return "no-keyring";
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, sealed, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return "kept";
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
      return "write-failed";
    }
  }

  clear(): void {
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
  const stored = store?.load();
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

/** How long before an expiring sign-in runs out Ember renews it. */
export const RENEW_BEFORE_MS = 60 * 60_000;
/** A renewed sign-in waits for nothing to be under way before Copilot is reconnected with it, checking this often... */
const IDLE_CHECK_MS = 30_000;
/** ...but no closer than this to the old one's end (which would cut off what's under way anyway). */
const FORCE_BEFORE_MS = 2 * 60_000;
/** A renewal that failed in passing (no network) is tried again after this. */
const RENEW_RETRY_MS = 60_000;

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
 * Keeps Ember's own sign-in working when its token expires (review #138): an hour before the end, the grant is renewed
 * and saved, and Copilot is reconnected with the new token once nothing is under way. A grant that doesn't expire (the
 * app's "Expire user authorization tokens" off) needs none of this. One GitHub won't renew is left to run out: Copilot
 * then refuses it, and the settings window offers Sign in again.
 */
export class GrantKeeper {
  private grant: Grant | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFreshen = -Infinity;

  constructor(private d: GrantKeeperDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /**
   * Copilot connects with `token` now: its grant is kept alive (`grant`; else the one kept alive already, which may be
   * in memory only, without a keyring; else the stored one), and none when the token is another sign-in's.
   */
  use(token: string | null, grant?: Grant | null): void {
    const g = grant ?? (this.grant?.token === token ? this.grant : token ? this.d.store()?.loadGrant() ?? null : null);
    this.track(token && g?.token === token ? g : null);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.grant = null;
  }

  /**
   * Before Ember looks for a sign-in to connect with: a stored one that has run out, or is about to (Ember was off), is
   * renewed first. At most once a minute (the GitHub CLI wait looks every 3 s). Never throws.
   */
  async freshen(): Promise<void> {
    const g = this.d.store()?.loadGrant();
    if (!g || !renewable(g, this.now()) || this.now() < g.expiresAt! - RENEW_BEFORE_MS) return;
    if (this.now() - this.lastFreshen < RENEW_RETRY_MS) return;
    this.lastFreshen = this.now();
    try {
      const next = await renewGrant(this.d.fetch, g, () => this.now());
      this.d.store()?.saveResult(next);
      this.d.log?.("auth.renewed", { when: "before use" });
    } catch (err) {
      this.d.log?.("auth.renew_failed", { err, refused: err instanceof RenewalRefused });
    }
  }

  private track(grant: Grant | null): void {
    this.stop();
    if (!grant || !renewable(grant, this.now())) return;
    this.grant = grant;
    this.after(grant.expiresAt! - RENEW_BEFORE_MS - this.now(), () => void this.renew(grant));
  }

  private after(ms: number, fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    // (setTimeout can't wait longer than about 24 days: a longer wait is cut, and the time looked at again then.)
    this.timer = setTimeout(fn, Math.min(Math.max(0, ms), 2 ** 31 - 1));
    this.timer.unref?.();
  }

  private async renew(grant: Grant): Promise<void> {
    this.timer = null;
    if (this.grant !== grant || this.d.inUse() !== grant.token) return;
    if (this.now() < grant.expiresAt! - RENEW_BEFORE_MS) { this.track(grant); return; }
    let next: Grant;
    try {
      next = await renewGrant(this.d.fetch, grant, () => this.now());
    } catch (err) {
      const refused = err instanceof RenewalRefused;
      this.d.log?.("auth.renew_failed", { err, refused });
      if (!refused && this.grant === grant && renewable(grant, this.now())) this.after(RENEW_RETRY_MS, () => void this.renew(grant));
      return;
    }
    if (this.grant !== grant || this.d.inUse() !== grant.token) return;
    // Kept for the next start (the old refresh token no longer works); not kept (no keyring): for this run.
    const kept = this.d.store()?.saveResult(next) ?? "no-keyring";
    this.d.log?.("auth.renewed", { kept });
    this.switchWhenIdle(grant, next);
  }

  private switchWhenIdle(old: Grant, next: Grant): void {
    if (this.grant !== old || this.d.inUse() !== old.token) return;
    const late = old.expiresAt === undefined || this.now() >= old.expiresAt - FORCE_BEFORE_MS;
    if (!this.d.idle() && !late) { this.after(IDLE_CHECK_MS, () => this.switchWhenIdle(old, next)); return; }
    this.track(next);
    void this.d.reconnect(next.token).catch(err => this.d.log?.("auth.renew_reconnect_failed", { err }));
  }
}

/** A grant Ember can renew: it expires, comes with a refresh token and the client id, and the refresh token still works. */
function renewable(g: Grant, now: number): boolean {
  return g.expiresAt !== undefined && !!g.refreshToken && !!g.clientId && (g.refreshExpiresAt === undefined || now < g.refreshExpiresAt);
}
