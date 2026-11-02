/**
 * The user's own model provider ("bring your own key", PLAN.md §2 "Model service"): which endpoint is in force, the API
 * key kept apart from the settings, and Home's "Test connection". The administrator's `provider` always wins, and
 * `features.userProvider` false (or LOCKDOWN) turns the user's off. The user's is in force only while it is on, its
 * address is usable (https, or http on this computer) and the user agreed to its card for that very host
 * (FEATURE_CONSENT_VERSION.provider): another host asks again.
 *
 * The key is sealed with the OS keyring (safeStorage) in provider-key.bin (0600), never in settings.json, and never
 * when the keyring is `basic_text`. It is never logged, audited, shown again or put in any environment: it reaches only
 * the Copilot runtime's provider config and the one request "Test connection" makes. Plain Node: Electron's objects are
 * injected.
 */

import fs from "node:fs";
import type { ProviderConfig } from "@github/copilot-sdk";
import { applyAdminPolicy, userProviderAllowed, type LoadedAdminPolicy } from "./admin";
import { lenientJson, repairSettings, type Settings } from "./settings";
import type { SaveResult, SecretBox } from "./agent/auth";
import { friendlyError } from "./agent/presenter";
import { FEATURE_CONSENT_VERSION } from "../shared/consent";
import { endpointHost, MAX_API_KEY } from "../shared/provider";

/** The user's provider settings (SettingsSchema `provider`). */
export type UserProviderSettings = Settings["provider"];

/**
 * The model endpoint a connection uses instead of Copilot: the administrator's, the user's own, or a test server
 * (EMBER_TEST_PROVIDER_URL in development). `models`: the user's own model ids (the administrator's come from the policy).
 */
export interface ActiveProvider {
  kind: "admin" | "user" | "test";
  config: ProviderConfig;
  models?: { conductor: string | null; worker: string | null };
}

/** Where a connection's model requests go, for the setup check and Home: whose, and the host only (never the key). */
export interface ProviderSummary { kind: ActiveProvider["kind"]; host: string }

/**
 * The user's own provider settings when they are in force under `loaded` (settings already have the policy applied), or
 * null: locked down, not allowed, off, no usable address, or not agreed to for this host.
 */
export function userProviderInForce(s: Settings, loaded: LoadedAdminPolicy): UserProviderSettings | null {
  if (loaded.error !== undefined || !userProviderAllowed(loaded.policy)) return null;
  const p = s.provider;
  if (!p.on) return null;
  const host = endpointHost(p.baseUrl);
  if (!host || p.consent.version < FEATURE_CONSENT_VERSION.provider || p.consent.host !== host) return null;
  return p;
}

/**
 * userProviderInForce for the settings file's text as it is on disk (`ember doctor` reads it without the settings
 * store), or null: no file, or one that can't be read.
 */
export function userProviderFromFile(text: string | null, loaded: LoadedAdminPolicy): UserProviderSettings | null {
  if (!text) return null;
  try {
    const raw = lenientJson(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return userProviderInForce(applyAdminPolicy(repairSettings(raw as Record<string, unknown>), loaded.policy), loaded);
  } catch {
    return null; // a file that can't be read: no provider of the user's to report
  }
}

/** The Copilot runtime's provider config for the user's settings and key (no key: a local server that needs none). */
export function userProviderConfig(p: UserProviderSettings, key: string | null): ProviderConfig {
  return {
    type: p.type,
    baseUrl: p.baseUrl,
    ...(key ? { apiKey: key } : {}),
    ...(p.wireApi && p.type !== "anthropic" ? { wireApi: p.wireApi } : {}),
    ...(p.type === "azure" && p.azureApiVersion ? { azure: { apiVersion: p.azureApiVersion } } : {}),
  };
}

/**
 * The endpoint in force now: a fixed one (the administrator's, or a development test server) always wins; otherwise the
 * user's own while userProviderInForce allows it; otherwise none (GitHub Copilot).
 */
export function activeProvider(o: { fixed: ActiveProvider | null; settings: Settings; admin: LoadedAdminPolicy; key: string | null }): ActiveProvider | null {
  if (o.fixed) return o.fixed;
  const p = userProviderInForce(o.settings, o.admin);
  if (!p) return null;
  return { kind: "user", config: userProviderConfig(p, o.key), models: { conductor: p.conductor, worker: p.worker } };
}

/** Whose endpoint `p` is and its host, for the setup check and Home (null: GitHub Copilot). */
export function providerSummary(p: ActiveProvider | null): ProviderSummary | null {
  if (!p) return null;
  let host: string;
  try { host = new URL(p.config.baseUrl).host; } catch { host = "?"; }
  return { kind: p.kind, host };
}

/** Why `key` can't be saved as an API key, in one plain sentence, or null when it can. */
export function apiKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !key.trim()) return "Enter the API key first.";
  if (key.length > MAX_API_KEY) return "That key is too long to be an API key.";
  // eslint-disable-next-line no-control-regex -- control characters and spaces are exactly what's refused here
  if (/[\u0000- \u007f-\u009f]/.test(key.trim())) return "An API key has no spaces or line breaks in it. Copy it again from your provider.";
  return null;
}

/** The file in Ember's data folder that holds the sealed key. */
export const PROVIDER_KEY_FILE = "provider-key.bin";

/** Home's answers when the user's own provider can't be changed or tested now. */
export const PROVIDER_MANAGED = "Your organisation decides which model service Ember uses.";
export const PROVIDER_NO_CONSENT = "Finish setting Ember up first.";

/** Why the key couldn't be kept, in plain words (Home shows it under the field). */
export const KEY_NO_KEYRING = "Ember can't keep the key safely here: this computer has no keyring for passwords, so the key would be saved as plain text. Set up a keyring (GNOME Keyring or KWallet), then try again.";
export const KEY_WRITE_FAILED = "Ember couldn't save the key: its data folder can't be written. Try again.";

/** What saving a key came to (`why` set when it wasn't kept). */
export type KeySave = { ok: true } | { ok: false; why: string };

/**
 * The user's API key, sealed with the OS keyring. Nothing is written when the keyring is `basic_text` (it would be plain
 * text on disk) or refuses; the file is 0600, written whole (a temporary file renamed over it), and deleted by
 * clear() ("Remove", and signing out). The key read back is kept in memory for the connection only.
 */
export class ProviderKeyStore {
  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean } = {}) {}

  /** Can a key be kept on this machine (a real keyring, not basic_text)? */
  canPersist(): boolean {
    try {
      return this.box.getSelectedStorageBackend?.() !== "basic_text" && this.box.isEncryptionAvailable();
    } catch {
      return false; // a keyring that can't answer keeps nothing
    }
  }

  /** Is a key saved (whether or not the keyring will open it)? Reads no secret. */
  has(): boolean {
    return fs.existsSync(this.file);
  }

  /** Seals and writes `key`, or says why it wasn't. Never throws. */
  async save(key: string): Promise<KeySave> {
    const problem = apiKeyProblem(key);
    if (problem) return { ok: false, why: problem };
    if (!this.canPersist()) return { ok: false, why: KEY_NO_KEYRING };
    let sealed: Buffer;
    try {
      sealed = this.opts.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(key.trim()) : this.box.encryptString(key.trim());
    } catch {
      return { ok: false, why: KEY_NO_KEYRING };
    }
    const r: SaveResult = this.write(sealed);
    return r === "kept" ? { ok: true } : { ok: false, why: KEY_WRITE_FAILED };
  }

  /** The saved key, or null (none saved, or the keyring wouldn't open it). Never throws. */
  async load(): Promise<string | null> {
    let raw: Buffer;
    try { raw = fs.readFileSync(this.file); } catch { return null; /* none saved */ }
    try {
      const key = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(raw)).result : this.box.decryptString(raw);
      return apiKeyProblem(key) === null ? key : null;
    } catch {
      return null; // the keyring refused: as if none were saved, and the file is kept to try again
    }
  }

  /** Deletes the saved key. */
  clear(): void {
    try { fs.rmSync(this.file, { force: true }); } catch { /* already gone */ }
  }

  private write(sealed: Buffer): SaveResult {
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
}

/** The part of fetch the connection test uses (main passes Electron's net.fetch, which follows the system's proxy). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** How long the connection test waits for an answer. */
export const TEST_TIMEOUT_MS = 10_000;

/** The Azure API version the test asks with when the user gave none. */
const AZURE_TEST_VERSION = "2024-10-21";

/**
 * The one small request "Test connection" makes: the service's model list (GET, no request body, nothing of the user's).
 * OpenAI-compatible: {base}/models with a bearer key; Azure: {base}/openai/models with api-key; Anthropic: {base}/v1/models
 * with x-api-key.
 */
export function testRequest(p: Pick<UserProviderSettings, "type" | "baseUrl" | "azureApiVersion">, key: string | null): { url: string; headers: Record<string, string> } {
  const base = p.baseUrl.replace(/\/+$/, "");
  if (p.type === "azure") {
    const root = /\/openai$/i.test(base) ? base : `${base}/openai`;
    return { url: `${root}/models?api-version=${encodeURIComponent(p.azureApiVersion ?? AZURE_TEST_VERSION)}`, headers: key ? { "api-key": key } : {} };
  }
  if (p.type === "anthropic") {
    const root = /\/v1$/i.test(base) ? base : `${base}/v1`;
    return { url: `${root}/models`, headers: { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) } };
  }
  return { url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
}

/** What the test found: the service answered (and how many models it lists, when it says), or why not in one sentence. */
export type TestResult = { ok: true; host: string; models: number | null } | { ok: false; why: string };

/**
 * Makes testRequest's request and says what came of it, in plain words (never the service's raw text). Redirects are
 * refused, so the key never goes to another address than the one the user entered.
 */
export async function testConnection(p: UserProviderSettings, key: string | null, fetch: FetchLike, timeoutMs = TEST_TIMEOUT_MS): Promise<TestResult> {
  const host = endpointHost(p.baseUrl);
  if (!host) return { ok: false, why: "Enter the service's address first." };
  const { url, headers } = testRequest(p, key);
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) return { ok: false, why: key ? `${host} didn't accept the API key. Check it, or replace it.` : `${host} needs an API key.` };
    if (res.status === 404) return { ok: false, why: `${host} answered, but has no model list at that address. Check the endpoint and the provider.` };
    if (!res.ok) return { ok: false, why: friendlyError(`HTTP ${res.status}`, undefined, { statusCode: res.status, provider: "user", settingsKey: null }) };
    let models: number | null = null;
    try {
      const body = await res.json() as { data?: unknown; models?: unknown };
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
      models = list ? list.length : null;
    } catch { /* answered, with a body that isn't a list: still connected */ }
    return { ok: true, host, models };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name} ${err.message} ${(err as { cause?: { code?: string } }).cause?.code ?? ""}` : String(err);
    if (/TimeoutError|AbortError/i.test(msg)) return { ok: false, why: `${host} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    if (/redirect/i.test(msg)) return { ok: false, why: `${host} sent Ember to another address. Enter the address it moved to.` };
    if (/certificate|self.signed|ERR_CERT_/i.test(msg)) return { ok: false, why: `Ember can't verify ${host}'s certificate.` };
    return { ok: false, why: `Ember can't reach ${host}. Check the address and the network.` };
  }
}
