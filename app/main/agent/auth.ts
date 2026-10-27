/**
 * GitHub sign-in for Copilot.
 *
 * Order: a token Ember stored (encrypted with the OS keyring via safeStorage),
 * then COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, then `gh auth token`.
 * New sign-ins use GitHub's device flow with Ember's own app (its client id is
 * built in from github-app.ts, and EMBER_GITHUB_CLIENT_ID overrides it); until the
 * app is registered (PLAN.md §7), sign-in goes through the GitHub CLI.
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
    try {
      const raw = fs.readFileSync(this.file);
      const t = this.box.decryptString(raw);
      return isUsableToken(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * Keeps the token encrypted; false when it can't be kept (no keyring, or the keyring refused: macOS's Keychain
   * prompt answered "Deny" makes encryptString throw), so sign-in carries on with "sign in again next time".
   */
  save(token: string): boolean {
    if (!this.canPersist()) return false;
    let sealed: Buffer;
    try {
      sealed = this.box.encryptString(token);
    } catch {
      return false;
    }
    fs.writeFileSync(this.file, sealed, { mode: 0o600 });
    return true;
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
    if (typeof j.access_token === "string") return j.access_token;
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
