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
import { endpointHost, MAX_API_KEY, MODEL_ID } from "../shared/provider";
import type { ProviderDraft, ProviderMove, ProviderState, RetryResult } from "../shared/ipc";

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
 * The host whose card the user's own provider waits for: on and allowed, with a usable address that isn't agreed to;
 * null otherwise. Signed out then, agreeing to it is the way on, not a GitHub sign-in (integrations-r3-1).
 */
export function providerWaitingHost(s: Settings, loaded: LoadedAdminPolicy): string | null {
  if (loaded.error !== undefined || !userProviderAllowed(loaded.policy)) return null;
  const host = endpointHost(s.provider.baseUrl);
  return s.provider.on && host && !providerAgreed(s.provider) ? host : null;
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

/**
 * Check again (integrations-c1-1): with a model provider in force (`provider`: its host) it connects to that provider
 * again and says whether it is ready, and never looks for or names a GitHub sign-in, which that service doesn't use.
 * Not ready, it says why (`reason`: the status's, integrations-c2-2), so a missing model isn't told as "can't connect".
 * With GitHub Copilot in force, it looks for a GitHub sign-in (`github`), as it always did.
 */
export async function checkAgain(provider: { host: string } | null, o: { reconnect(): Promise<string | undefined>; reason?(): string | undefined; github(): Promise<RetryResult> }): Promise<RetryResult> {
  if (!provider) return o.github();
  const ready = await o.reconnect() === "ready";
  const reason = ready ? undefined : o.reason?.();
  return { found: false, source: null, provider: { host: provider.host, ready, ...(reason ? { reason } : {}) } };
}

/** Whose endpoint `p` is and its host, for the setup check and Home (null: GitHub Copilot). */
export function providerSummary(p: ActiveProvider | null): ProviderSummary | null {
  if (!p) return null;
  let host: string;
  try { host = new URL(p.config.baseUrl).host; } catch { host = "?"; }
  return { kind: p.kind, host };
}

/**
 * Said of a key that holds anything but printable ASCII (integrations-r9-5): a zero-width space, a word joiner, curly
 * quotes or a look-alike letter picked up from a chat message, a document or a page that wraps long strings. Such a
 * key was saved, and Electron's fetch then refused the header before sending ("Cannot convert argument to a
 * ByteString"), which every check read as nothing answering: the address and the network were blamed. Never with the
 * key or the character in it.
 */
export const KEY_HIDDEN_CHARACTER = "That key has a character an API key can't hold, such as a hidden character or curly quotes picked up in copying. Copy it again from your provider.";
/** Said of a key in use that can't go in a request's header at all: nothing was sent, and the address isn't at fault. */
export const keyUnsendable = (host: string): string => `The saved API key has a character that can't be sent to ${host}. Replace the key.`;

/** Why `key` can't be saved as an API key, in one plain sentence, or null when it can. */
export function apiKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !key.trim()) return "Enter the API key first.";
  if (key.length > MAX_API_KEY) return "That key is too long to be an API key.";
  // eslint-disable-next-line no-control-regex -- control characters and spaces are exactly what's refused here
  if (/[\u0000- \u007f-\u009f]/.test(key.trim())) return "An API key has no spaces or line breaks in it. Copy it again from your provider.";
  if (/[^\u0021-\u007e]/.test(key.trim())) return KEY_HIDDEN_CHARACTER;
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

  /**
   * Checks details typed but not saved (first run's provider step, editing a provider in use: first-run-r2-1), so a
   * failed or abandoned check leaves the details in use as they are. The card's yes for exactly the address's host
   * comes with the same press (`draft.host`); nothing goes to any other host. Nothing is saved or recorded: a key just
   * typed goes only to that host and is kept nowhere (and is refused, unsent, where it couldn't be kept on adopting the
   * details), and without one the saved key goes only when it was entered for that very host.
   */
  const testDraft = async (draft: ProviderDraft): Promise<TestResult> => {
    const host = endpointHost(draft.baseUrl);
    if (!host) return { ok: false, why: PROVIDER_NO_ADDRESS };
    if (draft.host !== host) return { ok: false, why: PROVIDER_HOST_CHANGED };
    let key: StoredKey | null = null;
    if (draft.key !== undefined) {
      const problem = apiKeyProblem(draft.key);
      if (problem) return { ok: false, why: problem };
      if (!(await d.keys.canPersist())) return { ok: false, why: KEY_NO_KEYRING };
      key = { key: draft.key.trim(), host };
    } else if (hostNow() === host && providerAgreed(d.settings.get().provider)) {
      await readKey(true);
      key = stored;
    }
    // Consent or the policy may have changed while the keyring answered.
    if (!d.consented() || !allowed()) return { ok: false, why: PROVIDER_HOST_CHANGED };
    const consent = { version: FEATURE_CONSENT_VERSION.provider, at: (d.now?.() ?? new Date()).toISOString(), host };
    const r = await testConnection({ ...d.settings.get().provider, type: draft.type, baseUrl: draft.baseUrl, consent }, key, d.fetch);
    d.log.info("provider.tested", { ok: r.ok, draft: true });
    return r;
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
      /**
       * The card's yes for `host`, the endpoint's in settings; or, with `move` (Home's edit of the provider in force,
       * held until its card was agreed and it answered: integrations-c3-1), the host those details name, written with
       * the yes in one change, so the provider in force never leaves force for Copilot between the two.
       */
      agree: (host: string, move?: ProviderMove): KeySave => {
        if (!allowed()) return { ok: false, why: PROVIDER_MANAGED };
        const own = d.settings.own().provider;
        if (endpointHost(move?.baseUrl ?? own.baseUrl) !== host) return { ok: false, why: PROVIDER_HOST_CHANGED };
        d.settings.update({ provider: { ...own, ...move, on: true, consent: { version: FEATURE_CONSENT_VERSION.provider, at: (d.now?.() ?? new Date()).toISOString(), host } } });
        d.log.info("provider.agreed", {});
        return { ok: true };
      },
      test: async (draft?: ProviderDraft): Promise<TestResult> => {
        if (!d.consented()) return { ok: false, why: PROVIDER_NO_CONSENT };
        if (!allowed()) return { ok: false, why: PROVIDER_MANAGED };
        if (draft) return testDraft(draft);
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

/**
 * What the test found: the service answered (and how many models it lists, when it says), or why not in one sentence.
 * `cause` says when nothing answered at all: "refused" (nothing listens there, as when a model server on this computer
 * isn't running), "timeout", or "unreachable" (any other network failure). Absent for an answer that refused the
 * request, a certificate or a redirect: something is there.
 */
/**
 * What a test of the endpoint found. `cause`, for a failure: nothing answered (refused, timed out, unreachable: the
 * provider is down), or it answered but has no model list at that address (`no-list`: 404, 405 or 501 on GET /models,
 * as some gateways that answer chat only do, and as a mistyped path does; or a 200 that isn't a model list, as a web
 * page is: integrations-c7-1). Something is there, so the provider isn't down, but a held edit's check adopts it only
 * on the person's own "Use it as typed" (integrations-c5-1). `more`, for an answer: the list says it goes on past
 * this page (listSaysMore), so a model it doesn't name may still be one the service has (first-run-x7-1).
 */
export type TestResult = { ok: true; host: string; models: number | null; ids?: string[]; more?: true } | { ok: false; why: string; cause?: "refused" | "timeout" | "unreachable" | "no-list" };

/** The most model ids the test passes on for the model fields' suggestions. */
export const TEST_IDS_MAX = 50;

/**
 * The model ids a model list names (`data[].id`, as OpenAI, Azure and Anthropic write them; `models[].name` or `.model`,
 * as Ollama does), each a MODEL_ID, without repeats, at most TEST_IDS_MAX (integrations-9). Anything else is left out:
 * they are shown as suggestions, never run.
 */
export function listedModelIds(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const m of list) {
    if (out.length >= TEST_IDS_MAX) break;
    const o = m && typeof m === "object" ? m as { id?: unknown; name?: unknown; model?: unknown } : null;
    const id = typeof o?.id === "string" ? o.id : typeof o?.name === "string" ? o.name : typeof o?.model === "string" ? o.model : null;
    if (id && MODEL_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** An entry that names a model as listedModelIds reads one: an object with a string `id`, `name` or `model`. */
const namesModel = (m: unknown): boolean => {
  const o = m && typeof m === "object" ? m as { id?: unknown; name?: unknown; model?: unknown } : null;
  return typeof o?.id === "string" || typeof o?.name === "string" || typeof o?.model === "string";
};

/**
 * The model list in a GET /models answer, or null when the body holds none (a web page's JSON, a greeting, an error:
 * integrations-c7-1). Services write it in several shapes, and each is a list (integrations-x7-1): an array under
 * `data` (OpenAI, Azure, Anthropic) or `models` (Ollama), whatever it holds; the body itself as an array, empty or
 * with an entry that names a model; models keyed by id under `data` or `models`; or an array under another name
 * (`result`) with an entry that names a model, never one under `error` or `errors`.
 */
export function modelList(body: unknown): unknown[] | null {
  const listed = (v: unknown): v is unknown[] => Array.isArray(v) && (v.length === 0 || v.some(namesModel));
  if (Array.isArray(body)) return listed(body) ? body : null;
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  for (const key of ["data", "models"]) {
    const v = o[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const values = Object.values(v); if (values.some(namesModel)) return values; }
  }
  for (const [key, v] of Object.entries(o)) if (!/^errors?$/i.test(key) && Array.isArray(v) && v.some(namesModel)) return v;
  return null;
}

/**
 * A model list's answer says more models follow on another page (first-run-x7-1): Anthropic's and OpenAI's `has_more`,
 * or a next page's token, cursor or address (`next_page_token`, Google's `nextPageToken`, `next_cursor`, `next`). The
 * test asks for one page only, so such a list was not read whole.
 */
export function listSaysMore(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  return o.has_more === true || ["next_page_token", "nextPageToken", "next_cursor", "next"].some(k => typeof o[k] === "string" && o[k] !== "");
}

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
  // A key that can't go in a header: said as the key's trouble, with nothing sent (integrations-r9-5).
  if (key && apiKeyProblem(key)) return { ok: false, why: keyUnsendable(host) };
  const { url, headers } = testRequest(p, key);
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) return { ok: false, why: key ? `${host} didn't accept the API key. Check it, or replace it.` : `${host} needs an API key.` };
    if (res.status === 404 || res.status === 405 || res.status === 501) return { ok: false, why: `${host} answered, but has no model list at that address. Check the endpoint and the provider.`, cause: "no-list" };
    if (!res.ok) return { ok: false, why: friendlyError(`HTTP ${res.status}`, undefined, { statusCode: res.status, provider: "user", settingsKey: null }) };
    // A 200 says only that something is there: a web front end, a sign-in page or a parked domain answers every path
    // with one. Connected means it answered as a model service does, with a model list (integrations-c7-1).
    let list: unknown[] | null = null;
    let more = false;
    try { const body: unknown = await res.json(); list = modelList(body); more = !!list && listSaysMore(body); } catch { /* a body that isn't JSON (a web page): no model list, said below */ }
    if (!list) return { ok: false, why: `${host} answered, but not as a model service does. Check the endpoint.`, cause: "no-list" };
    const ids = listedModelIds(list);
    return { ok: true, host, models: list.length, ...(ids.length ? { ids } : {}), ...(more ? { more: true as const } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name} ${err.message} ${(err as { cause?: { code?: string } }).cause?.code ?? ""}` : String(err);
    if (/TimeoutError|AbortError/i.test(msg)) return { ok: false, why: `${host} didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`, cause: "timeout" };
    if (/redirect/i.test(msg)) return { ok: false, why: `${host} sent Ember to another address. Enter the address it moved to.` };
    // The request never left: fetch refused a header's value, and the key is the only one that isn't Ember's own text.
    // No cause, so nothing downstream says the address or the network (or "Start it" for a server on this computer).
    if (/ByteString|header (?:value|content)|Invalid character in header/i.test(msg)) return { ok: false, why: keyUnsendable(host) };
    if (/certificate|self.signed|ERR_CERT_/i.test(msg)) return { ok: false, why: `Ember can't verify ${host}'s certificate.` };
    // Electron's fetch says net::ERR_CONNECTION_REFUSED (ERR_ADDRESS_UNREACHABLE for an ::1 with no IPv6), Node's ECONNREFUSED.
    const refused = /ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/.test(msg);
    return { ok: false, why: `Ember can't reach ${host}. Check the address and the network.`, cause: refused ? "refused" : "unreachable" };
  }
}

/**
 * Why the user's own provider can't take a request now, from a connection test (integrations-1): one sentence for the
 * status, or null when something answered (a refused key or a missing model list is the request's to say, and the
 * ready status's: localProviderLine, never this). `local`: the endpoint is on this computer (shared/provider.ts keyNeeded false), where nothing listening means
 * the model server (Ollama, LM Studio) isn't running. Each says Ember tries again: the host does (retryLater).
 */
export function providerDown(r: TestResult, host: string, local: boolean): string | null {
  if (r.ok || !r.cause || r.cause === "no-list") return null;
  if (r.cause === "timeout") return `${r.why} Ember will try again in a moment.`;
  if (local) return `Ember can't reach the model server on this computer (${host}). Start it, and Ember will connect in a moment.`;
  return `Ember can't reach ${host}. Check the address and the network: Ember will try again in a moment.`;
}

/**
 * The ready status for the user's own provider on this computer, by the start's connection test of it (`r`; null when
 * none was made): "Connected" only to an answer with a model list. One without (Ollama's address with no /v1, a web
 * page, or a chat-only gateway adopted with "Use it as typed") is in use, and Test connection says what it answered,
 * in words that don't call a gateway that works wrong; one that answered otherwise (a key refused, an error) is in use
 * too, and its first request says the rest. Never "Connected" to either (integrations-r8-1).
 */
export function localProviderLine(r: TestResult | null, host: string): string {
  if (!r || r.ok) return `Connected to ${host}.`;
  return r.cause === "no-list" ? `Using ${host}. It answered, but without a model list: Test connection under Model provider says more.` : `Using ${host}.`;
}
