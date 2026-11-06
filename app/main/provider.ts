/**
 * The user's own model provider ("bring your own key", PLAN.md §2 "Model service"): which endpoint is in force, the API
 * key kept apart from the settings, and Home's "Test connection". The administrator's `provider` always wins, and
 * `features.userProvider` false (or LOCKDOWN) turns the user's off. Nothing at all goes to the user's endpoint (no
 * request, no test, no key) until they agreed to its card for that very host (FEATURE_CONSENT_VERSION.provider,
 * `providerAgreed`): another host asks again.
 *
 * The key is sealed with the OS keyring (safeStorage) in provider-key.bin (0600), never in settings.json, and never
 * when the keyring is `basic_text`. It belongs to the host it was entered for (kept beside it, in the clear, in
 * provider-key.host; and sealed with it): a key is never sent to another host, and main deletes it when the endpoint
 * moves. It is never logged (redactingLogger), audited, shown again or put in any environment: it reaches only the
 * Copilot runtime's provider config and the one request "Test connection" makes. The keyring is asked only when the
 * user's provider needs it, never at startup otherwise, and on macOS only asynchronously (a Keychain prompt on the main
 * thread would hold Ember, and a second Ember waiting to hand over). Plain Node: Electron's objects are injected.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ProviderConfig } from "@github/copilot-sdk";
import { applyAdminPolicy, userProviderAllowed, type LoadedAdminPolicy } from "./admin";
import { lenientJson, repairSettings, type Settings, type SettingsPatch } from "./settings";
import { redactGitHubTokens, type SaveResult, type SecretBox } from "./agent/auth";
import { friendlyError } from "./agent/presenter";
import type { Fields, Logger } from "./logger";
import { FEATURE_CONSENT_VERSION } from "../shared/consent";
import { endpointHost, MAX_API_KEY } from "../shared/provider";
import type { ProviderState } from "../shared/ipc";

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
  /**
   * Which saved key `config.apiKey` is: the random, non-secret id made when the user saved it (StoredKey.keyId), never
   * derived from the key. Absent for a fixed config, or a key saved before ids existed: that key's continuity can't be
   * told (the saved conversation keeps nothing for it).
   */
  keyId?: string;
}

/**
 * The user's saved key and the endpoint host it was entered for. `keyId`: a random non-secret id made whenever a key
 * is saved (so a replaced key has another one); null for a key saved before ids existed.
 */
export interface StoredKey { key: string; host: string; keyId?: string | null }

/** Where a connection's model requests go, for the setup check and Home: whose, and the host only (never the key). */
export interface ProviderSummary { kind: ActiveProvider["kind"]; host: string }

/** The user agreed to the card for the host `p.baseUrl` names now (a usable address; the card's current version). */
export function providerAgreed(p: Pick<UserProviderSettings, "baseUrl" | "consent">): boolean {
  const host = endpointHost(p.baseUrl);
  return !!host && p.consent.version >= FEATURE_CONSENT_VERSION.provider && p.consent.host === host;
}

/**
 * The user's own provider settings when they are in force under `loaded` (settings already have the policy applied), or
 * null: locked down, not allowed, off, no usable address, or not agreed to for this host.
 */
export function userProviderInForce(s: Settings, loaded: LoadedAdminPolicy): UserProviderSettings | null {
  if (loaded.error !== undefined || !userProviderAllowed(loaded.policy)) return null;
  const p = s.provider;
  if (!p.on || !providerAgreed(p)) return null;
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

/**
 * The setup check's model row for the user's own provider (`ember doctor`), from the settings file as it is on disk and
 * the host the saved key belongs to (read beside it, no keyring asked): its host, and whether a key is saved for that
 * very host. null: the user's provider isn't in force.
 */
export function ownProviderAuth(settingsText: string | null, loaded: LoadedAdminPolicy, savedHost: string | null): { kind: "own-provider"; host: string; key: boolean } | null {
  const p = userProviderFromFile(settingsText, loaded);
  const host = p ? endpointHost(p.baseUrl) : null;
  return host ? { kind: "own-provider", host, key: savedHost === host } : null;
}

/** The key, only when it was entered for the host `baseUrl` names (never one entered for another host). */
export function keyFor(baseUrl: string, stored: StoredKey | null): string | null {
  const host = endpointHost(baseUrl);
  return stored && host && stored.host === host ? stored.key : null;
}

/**
 * The Copilot runtime's provider config for the user's settings and saved key (the key only when it was entered for this
 * host; none: a local server that needs none). The address goes as the URL parser writes it.
 */
export function userProviderConfig(p: UserProviderSettings, stored: StoredKey | null): ProviderConfig {
  const key = keyFor(p.baseUrl, stored);
  return {
    type: p.type,
    baseUrl: new URL(p.baseUrl).href,
    ...(key ? { apiKey: key } : {}),
    ...(p.wireApi && p.type !== "anthropic" ? { wireApi: p.wireApi } : {}),
    ...(p.type === "azure" && p.azureApiVersion ? { azure: { apiVersion: p.azureApiVersion } } : {}),
  };
}

/**
 * The endpoint in force now: a fixed one (the administrator's, or a development test server) always wins; otherwise the
 * user's own while userProviderInForce allows it; otherwise none (GitHub Copilot).
 */
export function activeProvider(o: { fixed: ActiveProvider | null; settings: Settings; admin: LoadedAdminPolicy; key: StoredKey | null }): ActiveProvider | null {
  if (o.fixed) return o.fixed;
  const p = userProviderInForce(o.settings, o.admin);
  if (!p) return null;
  const config = userProviderConfig(p, o.key);
  return { kind: "user", config, models: { conductor: p.conductor, worker: p.worker }, ...(config.apiKey && o.key?.keyId ? { keyId: o.key.keyId } : {}) };
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
export const PROVIDER_NO_ADDRESS = "Enter the service's address first.";
/** Test connection, or a key, for a host whose card the user hasn't agreed to: nothing goes there. */
export function providerNotAgreed(host: string): string {
  return `Agree to the note above first: Ember sends nothing to ${host} until you do.`;
}

/** Why the key couldn't be kept, in plain words (Home shows it under the field). */
export const KEY_NO_KEYRING = "Ember can't keep the key safely here: this computer has no keyring for passwords, so the key would be saved as plain text. Set up a keyring (GNOME Keyring or KWallet), then try again.";
export const KEY_WRITE_FAILED = "Ember couldn't save the key: its data folder can't be written. Try again.";

/** What saving a key came to (`why` set when it wasn't kept). */
export type KeySave = { ok: true } | { ok: false; why: string };
/** What the key store says of a save: on success, the id sealed with the key (it never goes to a page). */
export type KeyKept = { ok: true; keyId: string } | { ok: false; why: string };

/** Where the host a key belongs to is kept (not secret: the settings name it too), so no keyring is asked to know it. */
const hostFile = (file: string) => file.replace(/\.bin$/, "") + ".host";

/**
 * The user's API key, sealed with the OS keyring together with the host it was entered for. Nothing is written when the
 * keyring is `basic_text` (it would be plain text on disk) or refuses; the files are 0600, written whole (a temporary
 * file renamed over each), and deleted by clear() ("Remove", signing out, the endpoint moving). With `asyncKeyring`
 * (macOS) the keyring is asked only off the main thread (isAsyncEncryptionAvailable, encryptStringAsync,
 * decryptStringAsync): never isEncryptionAvailable, which fetches the Keychain's key on it.
 */
export class ProviderKeyStore {
  private revision = 0;
  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean } = {}) {}

  /** Can a key be kept on this machine (a real keyring, not basic_text)? Asks the keyring: only when it is needed. */
  async canPersist(): Promise<boolean> {
    try {
      if (this.box.getSelectedStorageBackend?.() === "basic_text") return false;
      if (this.opts.asyncKeyring) return this.box.isAsyncEncryptionAvailable ? await this.box.isAsyncEncryptionAvailable() : !!this.box.encryptStringAsync;
      return this.box.isEncryptionAvailable();
    } catch {
      return false; // a keyring that can't answer keeps nothing
    }
  }

  /** The host the saved key belongs to, or null when none is saved. Reads no secret and asks no keyring. */
  savedHost(): string | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const host = fs.readFileSync(hostFile(this.file), "utf8").trim();
      return host || null;
    } catch {
      return null; // no host beside it: as if none were saved
    }
  }

  /** Seals and writes `key` for `host`, or says why it wasn't. Never throws. */
  async save(key: string, host: string, current: () => boolean = () => true): Promise<KeyKept> {
    const revision = ++this.revision;
    const problem = apiKeyProblem(key);
    if (problem) return { ok: false, why: problem };
    if (!host) return { ok: false, why: PROVIDER_NO_ADDRESS };
    if (!(await this.canPersist())) return { ok: false, why: KEY_NO_KEYRING };
    if (revision !== this.revision || !current()) return { ok: false, why: PROVIDER_HOST_CHANGED };
    // The id is sealed with the key, so the two can never be of different saves.
    const keyId = randomUUID();
    const text = JSON.stringify({ v: 1, host, key: key.trim(), id: keyId });
    let sealed: Buffer;
    try {
      sealed = this.opts.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(text) : this.box.encryptString(text);
    } catch {
      return { ok: false, why: KEY_NO_KEYRING };
    }
    if (revision !== this.revision || !current()) return { ok: false, why: PROVIDER_HOST_CHANGED };
    const r: SaveResult = this.write(this.file, sealed);
    if (r !== "kept" || this.write(hostFile(this.file), Buffer.from(host)) !== "kept") { this.clear(); return { ok: false, why: KEY_WRITE_FAILED }; }
    return { ok: true, keyId };
  }

  /** The saved key and its host, or null (none saved, unreadable, or the keyring wouldn't open it). Never throws. */
  async load(): Promise<StoredKey | null> {
    const revision = this.revision;
    let raw: Buffer;
    try { raw = fs.readFileSync(this.file); } catch { return null; /* none saved */ }
    try {
      const text = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(raw)).result : this.box.decryptString(raw);
      if (revision !== this.revision) return null;
      const v = JSON.parse(text) as { host?: unknown; key?: unknown; id?: unknown };
      if (typeof v.host !== "string" || !v.host || typeof v.key !== "string" || apiKeyProblem(v.key) !== null) return null;
      return { key: v.key, host: v.host, keyId: typeof v.id === "string" && /^[0-9a-f-]{36}$/.test(v.id) ? v.id : null };
    } catch {
      return null; // the keyring refused, or the file isn't one of these: as if none were saved
    }
  }

  /** Deletes the saved key and its host. */
  clear(): void {
    ++this.revision;
    for (const f of [this.file, hostFile(this.file)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
    }
  }

  private write(file: string, data: Buffer): SaveResult {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return "kept";
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
      return "write-failed";
    }
  }
}

/**
 * What Home's Model provider group shows (PROVIDER_IPC.state). The keyring is asked only while the provider is on and no
 * key is saved for its host (the one case where Home must say whether one can be kept); otherwise it is never touched.
 */
export async function providerStateOf(o: { settings: Settings; admin: LoadedAdminPolicy; keys: Pick<ProviderKeyStore, "savedHost" | "canPersist"> }): Promise<ProviderState> {
  const p = o.settings.provider;
  const allowed = o.admin.error === undefined && userProviderAllowed(o.admin.policy);
  const host = endpointHost(p.baseUrl);
  const keySaved = !!host && o.keys.savedHost() === host;
  return {
    allowed,
    managed: allowed ? null : o.admin.policy.provider ? "organisation" : "off",
    keySaved,
    keyring: allowed && p.on && !keySaved ? await o.keys.canPersist().catch(() => false) : true, // a keyring that fails must not hide inForce and host
    inForce: userProviderInForce(o.settings, o.admin) !== null,
    host,
    agreed: providerAgreed(p),
  };
}

/** `text` with every exact occurrence of each secret replaced (none, or one too short to be a key, changes nothing). */
export function redact(text: string, secret: string | null | readonly string[]): string {
  const all = secret === null ? [] : typeof secret === "string" ? [secret] : secret;
  // Anything shaped like a GitHub token goes too, whichever it is (BE audit #1): the runtime's errors may quote its environment.
  return redactGitHubTokens(all.filter(s => s.length >= 8).reduce((t, s) => t.split(s).join("[key]"), text));
}

/** Nesting past this is written as "[deep]", never raw. */
const SCRUB_DEPTH = 8;

/**
 * A copy of `v` with `secret` redacted from every string in it: values, object keys, and an error's name, message, stack,
 * code and cause. Errors become plain objects (a bare JSON.stringify of an Error is `{}`, and a logger prints these
 * fields anyway). Beyond the depth limit a value is "[deep]" and a value inside itself "[circular]", so nothing is
 * ever passed on raw and the walk is finite.
 */
function scrub(v: unknown, secret: readonly string[], depth = 0, path: object[] = []): unknown {
  if (typeof v === "string") return redact(v, secret);
  if (typeof v === "function" || typeof v === "symbol") return `[${typeof v}]`;
  if (v === null || typeof v !== "object") return v;
  if (path.includes(v)) return "[circular]";
  if (depth >= SCRUB_DEPTH) return "[deep]";
  path.push(v);
  try {
    if (v instanceof Date) return v;
    if (v instanceof Error) {
      const e = v as Error & { code?: unknown; cause?: unknown };
      const out: Record<string, unknown> = { name: scrub(e.name, secret), message: scrub(e.message, secret), stack: scrub(e.stack, secret, depth + 1, path) };
      if (e.code !== undefined) out.code = scrub(e.code, secret, depth + 1, path);
      if (e.cause !== undefined) out.cause = scrub(e.cause, secret, depth + 1, path);
      return out;
    }
    if (Array.isArray(v)) return v.map(x => scrub(x, secret, depth + 1, path));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      let x: unknown;
      try { x = (v as Record<string, unknown>)[k]; } catch { x = "[unreadable]"; } // a getter that throws
      out[redact(k, secret)] = scrub(x, secret, depth + 1, path);
    }
    return out;
  } finally {
    path.pop();
  }
}

/**
 * `base` with the user's provider key (`secret()`, asked at each line) replaced in every message, scope and field, errors
 * included: a model service's error text may quote the request it refused. Its children redact too. (The logger itself
 * then replaces anything shaped like a GitHub token in the finished line: logger.ts.)
 */
export function redactingLogger(base: Logger, secret: () => string | null | readonly string[]): Logger {
  const list = (): string[] => { const s = secret(); return (s === null ? [] : typeof s === "string" ? [s] : [...s]).filter(x => x.length >= 8); };
  const clean = (fields?: Fields): Fields | undefined => {
    return fields ? scrub(fields, list()) as Fields : fields;
  };
  const msg = (m: string) => redact(m, list());
  return {
    debug: (m, f) => base.debug(msg(m), clean(f)),
    info: (m, f) => base.info(msg(m), clean(f)),
    warn: (m, f) => base.warn(msg(m), clean(f)),
    error: (m, f) => base.error(msg(m), clean(f)),
    child: scope => redactingLogger(base.child(redact(scope, list())), secret),
    get file() { return base.file; },
  };
}

/** What the provider service needs from main (the settings store, the policy, the key store, the network). */
export interface ProviderServiceDeps {
  settings: { get(): Settings; own(): Settings; update(patch: SettingsPatch): Settings };
  admin: () => LoadedAdminPolicy;
  keys: Pick<ProviderKeyStore, "savedHost" | "canPersist" | "save" | "load" | "clear">;
  /** The user agreed to Ember at all (hasConsent): until then nothing is sent anywhere. */
  consented: () => boolean;
  fetch: FetchLike;
  log: Pick<Logger, "info" | "warn">;
  /** The endpoint in force may have changed (a key saved, removed, read or deleted): main reconnects and tells Home. */
  changed: () => void;
  now?: () => Date;
}

/** Said when the card's yes names another host than the endpoint in settings now (it changed meanwhile). */
export const PROVIDER_HOST_CHANGED = "The address changed: check it, then agree again.";

/**
 * Main's side of the user's own provider: the key in memory (read from the keyring only when the provider is on and a
 * key is saved for its host), Home's channels (PROVIDER_IPC), and keeping the key with its host (a key saved for
 * another host than the endpoint now is deleted). The card's yes is recorded only here, for the host the endpoint names.
 */
export function createProviderService(d: ProviderServiceDeps) {
  let stored: StoredKey | null = null;
  let reading: Promise<void> | null = null;
  let revision = 0;
  let saving: Promise<unknown> = Promise.resolve();
  const invalidate = () => { ++revision; reading = null; };
  /**
   * Keys replaced or removed this run: still redacted from the log, since a task may still run on one (tasks keep the
   * config they started with). In memory only, like the key in use.
   */
  const retired: string[] = [];
  /** The key in use goes out of use (replaced, removed, deleted with its host, or signing out). */
  const retire = () => { if (stored && !retired.includes(stored.key)) retired.push(stored.key); stored = null; };
  const allowed = () => { const a = d.admin(); return a.error === undefined && userProviderAllowed(a.policy); };
  const hostNow = () => endpointHost(d.settings.get().provider.baseUrl);

  /** Reads the saved key when it is for the endpoint now and not read yet; `always`: even with the provider off (a test). */
  const readKey = (always = false): Promise<void> => {
    const host = hostNow();
    if (stored || !host || !allowed() || (!always && !d.settings.get().provider.on) || d.keys.savedHost() !== host) return Promise.resolve();
    const started = revision;
    const pending = reading ?? d.keys.load().then(k => {
      // A key sealed for another host than the one beside it is no key at all.
      if (started === revision && allowed() && (always || d.settings.get().provider.on) && k && k.host === host && host === hostNow()) { stored = k; d.log.info("provider.key_read", {}); d.changed(); }
    }).finally(() => { if (reading === pending) reading = null; });
    reading = pending;
    return pending;
  };

  return {
    /** The saved key and its host, once read (null: none, or not needed yet). */
    key: (): StoredKey | null => stored,
    /** Every key this run has used, for redactingLogger: the one in use and those a running task may still hold. */
    secrets: (): string[] => [...(stored ? [stored.key] : []), ...retired],
    /** Reads the key if the provider in force needs it. Touches no keyring otherwise (never at a start with it off). */
    ensureKey: () => readKey(),
    /** ensureKey would ask the keyring now (main says so on screen meanwhile: the Keychain may ask the user). */
    needsRead: (): boolean => {
      const host = hostNow();
      return !stored && !!host && allowed() && d.settings.get().provider.on && d.keys.savedHost() === host;
    },
    /** The settings changed: a key saved for another host than the endpoint now is deleted, and one now needed is read. */
    settingsChanged(): void {
      invalidate();
      if (!allowed() || !d.settings.get().provider.on) retire();
      const saved = d.keys.savedHost();
      const host = endpointHost(d.settings.own().provider.baseUrl);
      if (saved && saved !== host) {
        d.keys.clear();
        retire();
        d.log.info("provider.key_cleared", { why: "endpoint_changed" });
        d.changed();
      }
      void readKey();
    },
    /** Signing out: the key goes. */
    forget(): void {
      invalidate();
      d.keys.clear();
      retire();
    },
    api: {
      state: () => providerStateOf({ settings: d.settings.get(), admin: d.admin(), keys: d.keys }),
      saveKey: async (key: string): Promise<KeySave> => {
        if (!allowed()) return { ok: false, why: PROVIDER_MANAGED };
        const host = hostNow();
        if (!host) return { ok: false, why: PROVIDER_NO_ADDRESS };
        invalidate();
        const started = revision;
        // Serialise writes so cancelling an old save cannot erase a newer key.
        const operation = saving.then(async (): Promise<KeySave> => {
          if (started !== revision || host !== hostNow() || !allowed()) return { ok: false, why: PROVIDER_HOST_CHANGED };
          const r = await d.keys.save(key, host, () => started === revision && host === hostNow() && allowed());
          if (started !== revision || host !== hostNow() || !allowed()) {
            d.keys.clear();
            return { ok: false, why: PROVIDER_HOST_CHANGED };
          }
          if (!r.ok) return r;
          invalidate();
          retire();
          // The id sealed with this very key: without it the saved conversation has no owner to be saved for.
          stored = { key: key.trim(), host, keyId: r.keyId };
          d.log.info("provider.key_saved", {});
          d.changed();
          return { ok: true };
        });
        saving = operation.catch(() => undefined);
        return operation;
      },
      removeKey: (): KeySave => {
        invalidate();
        d.keys.clear();
        retire();
        d.log.info("provider.key_removed", {});
        d.changed();
        return { ok: true };
      },
      agree: (host: string): KeySave => {
        if (!allowed()) return { ok: false, why: PROVIDER_MANAGED };
        const own = d.settings.own().provider;
        if (endpointHost(own.baseUrl) !== host) return { ok: false, why: PROVIDER_HOST_CHANGED };
        d.settings.update({ provider: { ...own, on: true, consent: { version: FEATURE_CONSENT_VERSION.provider, at: (d.now?.() ?? new Date()).toISOString(), host } } });
        d.log.info("provider.agreed", {});
        return { ok: true };
      },
      test: async (): Promise<TestResult> => {
        if (!d.consented()) return { ok: false, why: PROVIDER_NO_CONSENT };
        if (!allowed()) return { ok: false, why: PROVIDER_MANAGED };
        const started = revision;
        const p = d.settings.get().provider;
        // Checked before the keyring is asked: nothing at all for a host whose card isn't agreed.
        if (providerAgreed(p)) await readKey(true);
        if (started !== revision || !d.consented() || !allowed() || p !== d.settings.get().provider) return { ok: false, why: PROVIDER_HOST_CHANGED };
        const r = await testConnection(p, stored, d.fetch);
        d.log.info("provider.tested", { ok: r.ok });
        return r;
      },
    },
  };
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
 * Makes testRequest's request and says what came of it, in plain words (never the service's raw text). Nothing at all is
 * sent to a host whose card the user hasn't agreed to, and the key goes only to the host it was entered for. Redirects
 * are refused: a redirected fetch keeps custom headers such as x-api-key and api-key (only Authorization is dropped
 * across origins), so the key would otherwise reach whatever address the service names.
 */
export async function testConnection(p: UserProviderSettings, stored: StoredKey | null, fetch: FetchLike, timeoutMs = TEST_TIMEOUT_MS): Promise<TestResult> {
  const host = endpointHost(p.baseUrl);
  if (!host) return { ok: false, why: PROVIDER_NO_ADDRESS };
  if (!providerAgreed(p)) return { ok: false, why: providerNotAgreed(host) };
  const key = keyFor(p.baseUrl, stored);
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
