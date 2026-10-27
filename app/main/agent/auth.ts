/**
 * GitHub sign-in for Copilot.
 *
 * Order: a token Ember stored (encrypted with the OS keyring via safeStorage),
 * then COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, then `gh auth token`.
 * New sign-ins use GitHub's device flow with Ember's own app (client id from
 * EMBER_GITHUB_CLIENT_ID until the app is registered, see PLAN.md §7).
 * Classic `ghp_` tokens are refused: the Copilot runtime does not accept them.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";

export type TokenSource = "stored" | "environment" | "github-cli";
export interface ResolvedToken { token: string; source: TokenSource }

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
  /**
   * The last load() found a saved sign-in the keyring wouldn't open (decryptString threw: macOS's keychain prompt
   * answered Deny or Cancel, which an ad-hoc-signed Ember meets after every update). The file is kept, to try again.
   */
  unreadable = false;

  constructor(private file: string, private box: SecretBox) {}

  /** Whether a token can be kept across restarts on this machine. */
  canPersist(): boolean {
    return this.box.isEncryptionAvailable() && this.box.getSelectedStorageBackend?.() !== "basic_text";
  }

  /** Is a sign-in saved (whether or not the keyring will open it)? Reads no secret. */
  hasSaved(): boolean {
    return fs.existsSync(this.file);
  }

  load(): string | null {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      this.unreadable = false;
      return null; // none saved
    }
    try {
      const t = this.box.decryptString(raw);
      this.unreadable = false;
      return isUsableToken(t) ? t : null;
    } catch {
      this.unreadable = true;
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
    this.unreadable = false;
    return true;
  }

  clear(): void {
    this.unreadable = false;
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

/** The GitHub CLI's token (`gh auth token`), or null when gh is missing, signed out or gives an unusable token. */
export function ghCliToken(o: GhCliOptions = {}): Promise<string | null> {
  return new Promise(resolve => {
    execFile(o.path ?? "gh", ["auth", "token"], { ...o.spawn, timeout: o.timeoutMs ?? 3000 }, (err, stdout) => {
      const t = stdout?.trim();
      resolve(!err && isUsableToken(t) ? t : null);
    });
  });
}

/**
 * The token Ember uses: its own stored one, then the environment's, then the GitHub CLI's. `gh` is how the CLI is
 * asked: a function (tests), or the options ghCliToken takes (main passes the platform's path and spawn options).
 */
export async function resolveToken(
  store: TokenStore | null,
  env: NodeJS.ProcessEnv = process.env,
  gh: (() => Promise<string | null>) | GhCliOptions = {},
): Promise<ResolvedToken | null> {
  const stored = store?.load();
  if (stored) return { token: stored, source: "stored" };
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (isUsableToken(env[name])) return { token: env[name]!.trim(), source: "environment" };
  }
  const fromGh = await (typeof gh === "function" ? gh() : ghCliToken(gh));
  return fromGh ? { token: fromGh, source: "github-cli" } : null;
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

/** Polls until the user approves, the code expires, or `signal` aborts. */
export async function pollDeviceFlow(
  fetch: Fetch, clientId: string, code: DeviceCode,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
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
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: HEADERS,
      body: form({ client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = await res.json() as Record<string, unknown>;
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
