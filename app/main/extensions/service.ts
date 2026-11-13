/**
 * Ember's extensions runtime (ExtensionsApi, app/shared/extensions.ts): plugins from marketplaces whose MCP servers
 * become tools the conversation can use, gated by Ember on every call (gate.ts), pinned against changes (pin.ts) and
 * stopped by the kill switch. Only the user installs, enables, removes or agrees again, and only from Home; the model
 * never gets a management tool.
 *
 * What the spike proved and this builds on (docs/DEVELOPING.md "Extensions"): explicit `mcpServers` admitted one tool
 * at a time by `availableTools: ["mcp:<server>-<tool>"]`, every call seen and decidable by Ember's `onPreToolUse`, and
 * results rewritten by `onPostToolUse`. What stays off: a plugin's hooks, agents, skills and rules (passing a plugin
 * as `pluginDirectories` ran its command hooks outside every gate), `extension.mjs` extensions (bare tool names that
 * shadow Ember's, not filtered by `availableTools`), and connectors (not testable without GitHub's service).
 *
 * Marketplaces are registered with the Copilot runtime (it fetches them); Ember reads their catalogues, copies a
 * plugin into its own store and runs its own copy. Changes reach the conversation between turns: the host reconnects
 * when `generation` moves (as for memory). Plain Node: Electron's objects come in by injection.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CopilotClient, MCPServerConfig } from "@github/copilot-sdk";
import type { AdminPolicy } from "../admin";
import type { Confirmer } from "../agent/confirm";
import type { StopPart } from "../agent/killswitch";
import type { PostToolUseFailureHookInput, PostToolUseFailureHookOutput, PostToolUseHookInput, PostToolUseHookOutput, PreToolUseHookInput, PreToolUseHookOutput, SessionExtensions, ShownTool } from "../agent/session-config";
import { appEnv } from "../hands/system";
import type { Logger } from "../logger";
import { injectionSignals } from "../perception/injection";
import type { AuditLog } from "../policy/audit";
import type { Settings, SettingsPatch } from "../settings";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import type { ConnectResult, ExtensionsApi, Installed, Marketplace, MarketplaceEntry, ToolInfo } from "../../shared/extensions";
import { EXTENSION_ON_UNSAVED, MARKETPLACE_BUILT_IN_KEPT, MARKETPLACE_MANAGED_KEPT, addMarketplaceFailed, browseFailed, extensionUnsaved } from "../../renderer/home/extensions-copy";
import type { OS } from "../../shared/shortcuts";
import { REFUSED, classify, failureNote, gateAnnouncement, gateQuestion, wrapResult } from "./gate";
import { pluginPath, readMarketplace, readPlugin, reachOf, firstFile, MARKETPLACE_PLACES, type ServerSpec } from "./manifest";
import { canonical, checkPins, isReadOnly, pinAll, shownHash, toolHash, type PinnedTool } from "./pin";
import { probeHttp, probeStdio, servedTools, type ProbeResult } from "./probe";
import { SAVED_OUTPUT } from "../agent/runtime-temp";
import { ExtensionStore, copyPlugin, type StoredItem, type StoredServer } from "./store";
import { MCP_TOOL_NAME, clashingToolNames, modelToolName } from "./tool-name";

export interface ExtensionsDeps {
  /** `<userData>/extensions`. */
  dir: string;
  /** `<userData>/copilot` (the runtime's home: its marketplace cache and plugin installs). */
  copilotHome: string;
  settings: { get(): Settings; update?(patch: SettingsPatch): unknown; onChange?(fn: () => void): () => void };
  admin: () => AdminPolicy;
  /** The connected runtime, for marketplaces (null while Ember isn't connected). */
  client: () => CopilotClient | null;
  confirmer: () => Confirmer | null;
  audit: () => AuditLog | null;
  /**
   * Autopilot is the approval mode in force (policy/autonomy.ts approvalInputs().autopilot), read at each call: one
   * the gate would ask about is announced instead. Absent or false: it asks.
   */
  autopilot?: () => boolean;
  /**
   * Has Ember filled something from its vault since it started (main: VaultRedactor.active)? Read at each call: from
   * then on every extension call is denied (gate.ts VAULT_FILLED). A check that throws counts as yes. Absent: never.
   */
  vaultFilled?: () => boolean;
  /**
   * Says what Ember does without asking in the conversation's bubble (the gate's own words, gateAnnouncement); false
   * when it couldn't be said. Absent, or false: the call asks, since nothing goes ahead in Autopilot unannounced.
   */
  announce?: (words: string) => boolean;
  log: Logger;
  os: OS;
  /**
   * How the runtime starts Ember's launcher (dist/app/mcp-launch.cjs, as plain Node), or null where Ember can't run as
   * plain Node (macOS: RunAsNode is off, PLAN.md §2 "Node mode"): stdio servers then don't run at all (fail closed).
   */
  launcher: { execPath: string; script: string } | null;
  /** Ember's own environment, which appEnv() filters for servers (default process.env). */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Development and tests: a local folder may be added as a marketplace (EMBER_EXTENSIONS_LOCAL). */
  allowLocal?: boolean;
  /** Tests: probes in place of the real ones. */
  probe?: (spec: ServerSpec, cwd: string) => Promise<ProbeResult>;
}

/** A GitHub repository (owner/repo, optionally #ref) or an https address: what a user may add as a marketplace. */
const GITHUB_SOURCE = /^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}(#[\w./-]{1,200})?$/;

/** A marketplace's or plugin's name that may become part of a path: word characters, dots and dashes, no leading dot. */
const PATH_NAME = /^\w[\w.-]{0,99}$/;

/** A proxy address without the user name and password in it (servers get the proxy, never its credentials). */
export function withoutUserinfo(v: string): string {
  try {
    const u = new URL(v);
    if (!u.username && !u.password) return v;
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  }
}

/** Letters and digits only, for ids and server keys. */
const slug = (s: string, max: number) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, max) || "x";

function toolInfo(server: StoredServer, tools: PinnedTool[], review = false): ToolInfo[] {
  const clashes = clashingToolNames(server.key, tools.map(t => t.name));
  return tools.map(t => ({
    ...(review ? { server: server.name } : {}),
    name: t.name, description: t.description, readOnly: isReadOnly(t),
    ...(!review && t.changed ? { changed: true } : {}),
    ...(clashes.has(modelToolName(server.key, t.name)) ? { nameConflict: true } : {}),
  }));
}

/**
 * A marketplace the runtime couldn't reach: Node's words, or git's and curl's as the runtime passes them on from its
 * git clone (integrations-r2: "Couldn't connect to server", "Could not resolve host", a proxy's refusal, TLS inspection).
 */
const UNREACHABLE = /ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|getaddrinfo|socket hang up|offline|timed? ?out|ETIMEDOUT|could not resolve (host|proxy)|couldn't connect to server|failed to connect to|connection refused|proxy connect|from proxy after connect|ssl certificate problem|certificate verify failed|server certificate verification failed/i;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A friendly sentence for an error a marketplace operation threw (never the raw text). */
function why(err: unknown, fallback: string): string {
  const m = errorText(err);
  if (/not found|404|does not exist|no such/i.test(m)) return "Ember couldn't find that marketplace.";
  if (/already/i.test(m)) return "That marketplace is already added.";
  if (UNREACHABLE.test(m)) return "Ember couldn't reach it. Check your connection and try again.";
  return fallback;
}

/**
 * One session's gate state: the tools refused this turn, which tools showed as pinned at the start, the session's live
 * tool list (bound by verifySessionTools), and each model-facing name's item, server and pinned tool.
 */
interface SessionGate {
  refused: Set<string>;
  shown: Map<string, boolean>;
  live: (() => Promise<ShownTool[]>) | null;
  /** Server keys that changed their tool list this session (their hints can't be re-checked). */
  listChanged: Set<string>;
  epoch: number;
  stop?: (servers: string[]) => Promise<void>;
  /** A server's own tool list now, asked through the session (its running process, not a fresh one). */
  served?: (server: string) => Promise<unknown>;
  /**
   * Server keys Ember took out of this session: one of their tools showed differently from its pin
   * (integrations-r9-1), or the server said its list changed (integrations-x9-1). Their tools are denied here.
   */
  withdrawn: Set<string>;
  /** Servers that didn't give their list when asked after a call: not asked after later calls in this session. */
  mute: Set<string>;
  /**
   * Each withdrawn server's leaving, once asked of the runtime: whether it is out. One per server, each over within
   * STOP_WAIT_MS, so what the session's hooks wait for is bounded by Ember, never by a server (integrations-x9-4).
   */
  stops: Map<string, Promise<boolean>>;
  tools: Map<string, { item: StoredItem; server: StoredServer; tool: PinnedTool }>;
}

/** How long Ember waits for the runtime to list or disable a server in a session before it goes on without (ms). */
const STOP_WAIT_MS = 3000;

/** How long a call's result waits for its server's list (ms): a server that just answered a call answers this at once. */
const LIST_WAIT_MS = 1500;

/** `p`, or a rejection once `ms` have passed without it settling (a runtime or a server that doesn't answer). */
function inTime<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("no answer in time")), ms); timer.unref?.(); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** What the session shows of a tool is exactly what was pinned: its name, description and input schema. */
const asPinned = (pin: PinnedTool, now: ShownTool) => shownHash(pin.name, now.description ?? "", now.input_schema ?? null) === shownHash(pin.name, pin.description, pin.inputSchema);

export class ExtensionsService implements ExtensionsApi {
  private store: ExtensionStore;
  private items: StoredItem[];
  private listeners = new Set<() => void>();
  private busy = new Set<string>();
  /** Bumped whenever what a conversation would load changes: the host reconnects between turns. */
  private gen = 0;
  /** Bumped by the kill switch: sessions loaded before it deny every call until reloaded. */
  private epoch = 0;
  /** Revocable files, never process ids. Each launcher stops its own child when its lease disappears. */
  private leases = new Map<string, Set<string>>();
  private session: SessionGate | null = null;
  private stopAsks = new AbortController();
  /**
   * An extension's result or failure read as instructions (or a call failed) in this conversation: every later call
   * asks. Kept here, not per session, so a reconnect (which builds a new session) keeps it; conversationEnded() clears it.
   */
  private tainted = false;
  /**
   * Server keys that said their tool list changed in this conversation (integrations-x9-1). Kept here as the taint
   * is, across the reload such a word causes: a server that says it again has all its tools turned off.
   */
  private announcers = new Set<string>();
  /** Installs and agreements run one at a time (two at once could take the same server key or copy into one folder). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private o: ExtensionsDeps) {
    this.store = new ExtensionStore(o.dir);
    this.items = this.store.read();
    // Turned off or removed while the list couldn't be written (integrations-r9-4): off before anything loads, and
    // the marks go once the list says so itself.
    const off = new Set(this.store.markedOff());
    if (off.size) {
      for (const item of this.items) if (off.has(item.id)) item.enabled = false;
      try { this.save(); } catch (err) { o.log.warn("extensions.save_failed", { err }); }
    }
    let active = this.active();
    o.settings.onChange?.(() => {
      const next = this.active();
      if (active && !next) this.stopPart().stop();
      active = next;
    });
    // Revoke an earlier run's leases. Legacy pid files are dropped too; their numbers are never signalled.
    try { for (const f of fs.readdirSync(this.store.runDir)) fs.rmSync(path.join(this.store.runDir, f), { force: true }); } catch { /* no run folder yet */ }
  }

  /** The conversation was forgotten (sign-out, another account, a new conversation): its taint goes with it. */
  conversationEnded(): void {
    this.stopPart().stop();
    this.session = null;
    this.tainted = false;
    this.announcers.clear();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const current = () => {
      if (epoch !== this.epoch) throw new Error("It was stopped. Review its tools before trying again.");
      return run();
    };
    const next = this.queue.then(current, current);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Moves with every change to what a session would load, including extensions being turned on or off. */
  get generation(): number { return this.gen * 2 + (this.active() ? 1 : 0); }

  allowed(): boolean {
    return this.o.admin().features.extensions !== false;
  }

  /** Allowed, turned on, and agreed to (FEATURE_CONSENT_VERSION.extensions): only then does a session get tools. */
  active(): boolean {
    const e = this.o.settings.get().extensions;
    return this.allowed() && e.on && e.consent.version >= FEATURE_CONSENT_VERSION.extensions;
  }

  /** The runtime is connected (Copilot or a model provider is ready): only then are marketplaces listed (integrations-v2). */
  connected(): boolean {
    return this.o.client() !== null;
  }

  /** The user agreed to extensions' first-use card at its current version. */
  consented(): boolean {
    return this.o.settings.get().extensions.consent.version >= FEATURE_CONSENT_VERSION.extensions;
  }

  /** The card's yes in Home (a click there, never the model): records the agreement and turns extensions on. */
  async agree(): Promise<void> {
    if (!this.allowed() || !this.o.settings.update) return;
    if (!this.consented()) {
      for (const item of this.items) item.consentedAt = null;
      this.save();
    }
    this.o.settings.update({ extensions: { on: true, consent: { version: FEATURE_CONSENT_VERSION.extensions, at: new Date().toISOString() } } });
    try { this.audit({ phase: "agreed", version: FEATURE_CONSENT_VERSION.extensions }); } catch (err) { this.o.log.warn("extensions.audit_failed", { err }); }
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private changed(reload = true): void {
    if (reload) this.gen++;
    for (const fn of this.listeners) { try { fn(); } catch (err) { this.o.log.warn("extensions.listener_failed", { err }); } }
  }

  private save(): void {
    this.store.write(this.items);
    // The list on disk is the whole truth again: no mark beside it is needed.
    this.store.clearOff();
  }

  /**
   * An item the user turned off or removed while the list couldn't be written (integrations-r9-4: Remove answered ok
   * at the second press and the item came back, on and agreed, at the next start). It is off for the rest of this run
   * whatever can be saved, a mark beside the list keeps it off at the next start where even that can be written, Home
   * is told, and the request fails in words that say the change wasn't saved.
   */
  private heldOff(item: StoredItem, what: "removed" | "off", err: unknown): never {
    this.o.log.warn("extensions.save_failed", { err, ext: item.id });
    item.enabled = false;
    const kept = this.store.markOff(item.id);
    this.changed();
    throw new Error(extensionUnsaved(what, kept), { cause: err });
  }

  private audit(e: Record<string, unknown>): void {
    const a = this.o.audit();
    if (!a) throw new Error("no audit log");
    a.write({ event: "extension", ...e });
  }

  // ---- What Home shows ----

  async list(): Promise<Installed[]> {
    return this.items.map(i => this.view(i));
  }

  private view(i: StoredItem): Installed {
    const tools = i.servers.flatMap(s => toolInfo(s, s.tools));
    const needsReview = i.servers.some(s => s.reviewTools && canonical(s.reviewTools.map(t => t.hash)) !== canonical(s.tools.map(t => t.hash)));
    const failed = i.servers.find(s => s.status === "failed");
    const auth = i.servers.find(s => s.status === "needs-auth");
    const status: Installed["status"] = this.busy.has(i.id) ? "starting" : !i.enabled ? "disabled" : failed ? "failed" : auth ? "needs-auth" : "ready";
    const detail = status === "failed" ? failed?.detail : status === "needs-auth" ? auth?.detail : tools.some(t => t.changed) ? "A tool changed since you agreed to it. It stays off until you agree again." : undefined;
    return {
      id: i.id, kind: i.kind, name: i.name, source: i.source, enabled: i.enabled, consented: i.consentedAt !== null && this.consented(), status, tools, needsReview,
      reviewToken: this.reviewToken(i),
      reviewTools: i.servers.flatMap(s => toolInfo(s, s.reviewTools ?? s.tools, true)),
      ...(i.publisher ? { publisher: i.publisher } : {}), ...(i.version ? { version: i.version } : {}), ...(detail ? { detail } : {}),
      reaches: i.servers.filter(s => s.spec).map(s => reachOf(s.spec!, this.store.pluginDir(i.id))),
    };
  }

  /** Binds a click to the exact server specs, state and tool metadata shown, including schemas and hints. */
  private reviewToken(item: StoredItem): string {
    return crypto.createHash("sha256").update(canonical(item.servers.map(s => ({ key: s.key, spec: s.spec, status: s.status, tools: (s.reviewTools ?? s.tools).map(t => t.hash) })))).digest("hex");
  }

  // ---- Marketplaces (registered with the runtime, which fetches them) ----

  private rpc() {
    const c = this.o.client();
    if (!c) throw new Error("not connected");
    return c.rpc;
  }

  async marketplaces(): Promise<Marketplace[]> {
    // Before the runtime is connected (Home opens first on a fresh start) there is nothing to ask: `connected()` tells
    // Home why the list is empty, and a warning with a stack at every such start was only noise in the log.
    if (!this.allowed() || !this.o.client()) return [];
    try {
      const r = await this.rpc().plugins.marketplaces.list();
      // Copilot's own (isDefault) and the organisation's (managed) can't be removed: Home shows them so (integrations-4).
      return r.marketplaces.map(m => ({ name: m.name, source: m.source, ...(m.isDefault ? { builtIn: true } : {}), ...(m.managed ? { managed: true } : {}) }));
    } catch (err) {
      // A runtime that went away between the check above and the call (a reconnect): expected, so no warning with a
      // stack (13 in 90 s of reconnects before the check, reliability-r7-4).
      if ((err as Error)?.message === "not connected") this.o.log.debug("extensions.marketplaces_not_connected");
      else this.o.log.warn("extensions.marketplaces_failed", { err });
      return [];
    }
  }

  /** Checks what a user typed as a marketplace: a GitHub repository or an https address (a local folder in development). */
  marketplaceSource(source: string): string | null {
    const s = source.trim();
    if (!s || s.length > 500) return null;
    if (GITHUB_SOURCE.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.protocol === "https:" && !u.username && !u.password) return u.href;
    } catch { /* not an address */ }
    if (this.o.allowLocal && path.isAbsolute(s) && fs.existsSync(s) && firstFile(s, MARKETPLACE_PLACES)) return s;
    return null;
  }

  async addMarketplace(source: string): Promise<{ ok: true } | { ok: false; why: string }> {
    if (!this.allowed()) return { ok: false, why: "Your organisation has turned extensions off." };
    const s = typeof source === "string" ? this.marketplaceSource(source) : null;
    if (!s) return { ok: false, why: "Enter a GitHub repository (owner/name) or an https address." };
    try {
      const r = await this.rpc().plugins.marketplaces.add({ source: s });
      this.o.log.info("extensions.marketplace_added", { name: r.name });
      this.changed(false);
      return { ok: true };
    } catch (err) {
      this.o.log.warn("extensions.marketplace_add_failed", { err });
      if ((err as Error)?.message === "not connected") return { ok: false, why: "Ember isn't connected to Copilot yet." };
      // Said with the address and what to check (integrations-r2-3): out of reach, or reached but no marketplace came.
      const m = errorText(err);
      if (UNREACHABLE.test(m)) return { ok: false, why: addMarketplaceFailed(source.trim(), "offline") };
      const known = why(err, "");
      if (known) return { ok: false, why: known };
      if (/failed to fetch|git clone|unable to access|could not read username|authentication failed/i.test(m)) return { ok: false, why: addMarketplaceFailed(source.trim(), "fetch") };
      return { ok: false, why: "Ember couldn't add that marketplace." };
    }
  }

  /** Removes a marketplace the user added; one built into Copilot or set by the organisation is refused, saying so. */
  async removeMarketplace(name: string): Promise<{ ok: true } | { ok: false; why: string }> {
    if (typeof name !== "string" || !name) return { ok: false, why: "Ember couldn't remove that marketplace." };
    try {
      await this.rpc().plugins.marketplaces.remove({ name, force: true });
      this.changed(false);
      return { ok: true };
    } catch (err) {
      this.o.log.warn("extensions.marketplace_remove_failed", { err });
      const msg = (err as Error)?.message ?? "";
      if (msg === "not connected") return { ok: false, why: "Ember isn't connected to Copilot yet." };
      // The runtime refuses its own defaults ("… is a default marketplace and cannot be removed").
      if (/\bdefault marketplace\b/i.test(msg)) return { ok: false, why: MARKETPLACE_BUILT_IN_KEPT };
      if (/\bmanaged\b/i.test(msg)) return { ok: false, why: MARKETPLACE_MANAGED_KEPT };
      return { ok: false, why: why(err, "Ember couldn't remove that marketplace.") };
    }
  }

  /** The folder the runtime keeps a marketplace's catalogue in: a local one's own, else its cache (found by name). */
  private async marketplaceRoot(name: string): Promise<string | null> {
    const list = await this.rpc().plugins.marketplaces.list();
    const m = list.marketplaces.find(x => x.name === name);
    if (!m) return null;
    const local = /^Local: (.+)$/.exec(m.source)?.[1];
    if (local && path.isAbsolute(local)) return local;
    const cache = path.join(this.o.copilotHome, ".cache", "copilot", "marketplaces");
    // The runtime names a GitHub marketplace's folder "<owner>-<repo>": that one first, so another cached catalogue
    // that happens to call itself the same can't stand in for it.
    const gh = /^GitHub: ([\w.-]+)\/([\w.-]+)$/.exec(m.source);
    if (gh) {
      const own = path.join(cache, `${gh[1]}-${gh[2]}`);
      try { if (readMarketplace(own).name === name) return own; } catch { /* not cached under that name */ }
      return null;
    }
    let dirs: string[];
    try { dirs = fs.readdirSync(cache); } catch { return null; }
    const found: string[] = [];
    for (const d of dirs) {
      const root = path.join(cache, d);
      try { if (readMarketplace(root).name === name) found.push(root); } catch { /* not this one */ }
    }
    // Two catalogues with one name: Ember can't tell which is the user's, so it uses neither.
    return found.length === 1 ? found[0] : null;
  }

  /** What `marketplace` offers, or why its list couldn't be fetched or read (integrations-r2): never an empty list for that. */
  async browse(marketplace: string): Promise<MarketplaceEntry[] | { ok: false; why: string }> {
    if (!this.allowed() || typeof marketplace !== "string") return [];
    try {
      // The runtime fetches (or refreshes) the catalogue; Ember reads it for what it offers.
      try {
        await this.rpc().plugins.marketplaces.browse({ name: marketplace });
      } catch (err) {
        this.o.log.warn("extensions.browse_failed", { err });
        return { ok: false, why: browseFailed(marketplace, UNREACHABLE.test(errorText(err)) ? "offline" : "fetch") };
      }
      const root = await this.marketplaceRoot(marketplace);
      if (!root) return { ok: false, why: browseFailed(marketplace, "read") };
      const m = readMarketplace(root);
      const installed = new Set(this.items.map(i => i.source));
      const out: MarketplaceEntry[] = [];
      for (const p of m.plugins) {
        const base = { marketplace, name: p.name, description: p.description, kind: "plugin" as const, installed: installed.has(`${p.name}@${marketplace}`), ...(p.publisher ? { publisher: p.publisher } : {}), ...(p.version ? { version: p.version } : {}) };
        if (p.folder) {
          // Kept in the marketplace: listed only if it has a server Ember can run (skills, agents and hooks never load).
          let reaches: string[] = [];
          try { reaches = readPlugin(p.folder).servers.filter(s => s.spec).map(s => reachOf(s.spec!, p.folder)); } catch { continue; }
          if (!reaches.length) continue;
          out.push({ ...base, source: pluginPath(root, p.folder) ?? ".", reaches });
        } else if (p.elsewhere) {
          out.push({ ...base, source: p.elsewhere });
        }
      }
      return out;
    } catch (err) {
      this.o.log.warn("extensions.browse_failed", { err });
      return { ok: false, why: browseFailed(marketplace, "read") };
    }
  }

  // ---- Install, remove, enable, agree again ----

  install(marketplace: string, name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
    return this.serial(() => this.installNow(marketplace, name));
  }

  private async installNow(marketplace: string, name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
    if (!this.allowed()) return { ok: false, why: "Your organisation has turned extensions off." };
    if (!this.consented()) return { ok: false, why: "Agree to extensions in settings first." };
    if (typeof marketplace !== "string" || typeof name !== "string" || !PATH_NAME.test(marketplace) || !PATH_NAME.test(name)) return { ok: false, why: "Ember couldn't find that plugin." };
    const source = `${name}@${marketplace}`;
    if (this.items.some(i => i.source === source)) return { ok: false, why: "It's already installed." };
    const id = `${slug(name, 40)}-${slug(marketplace, 40)}-${crypto.randomBytes(3).toString("hex")}`;
    const dst = this.store.pluginDir(id);
    let viaRuntime = false;
    const epoch = this.epoch;
    try {
      const root = await this.marketplaceRoot(marketplace);
      const listed = root ? readMarketplace(root).plugins.find(p => p.name === name) : undefined;
      if (!listed) return { ok: false, why: "Ember couldn't find that plugin." };
      let src = listed.folder;
      if (!src) {
        // Kept elsewhere (a GitHub repository at a pinned commit): the runtime fetches it, and Ember copies it.
        await this.rpc().plugins.install({ source });
        viaRuntime = true;
        src = path.join(this.o.copilotHome, "installed-plugins", marketplace, name);
        if (!fs.existsSync(src)) return { ok: false, why: "Ember couldn't fetch that plugin." };
      }
      this.store.ensure();
      copyPlugin(src, dst, undefined, listed.folder ? root! : path.join(this.o.copilotHome, "installed-plugins"));
      const manifest = readPlugin(dst);
      const usable = manifest.servers.filter(s => s.spec);
      if (!usable.length) {
        fs.rmSync(dst, { recursive: true, force: true });
        return { ok: false, why: manifest.servers.length ? manifest.servers[0].why ?? "Ember can't run its tools." : "It has no tools Ember can use. Ember uses only a plugin's MCP servers." };
      }
      this.busy.add(id);
      const taken = new Set(this.items.flatMap(i => i.servers.map(s => s.key)));
      const servers: StoredServer[] = [];
      for (const s of manifest.servers) {
        if (epoch !== this.epoch || !this.active()) throw new Error("extensions stopped");
        let key = slug(s.name, 20);
        for (let n = 2; taken.has(key); n++) key = `${slug(s.name, 18)}${n}`;
        taken.add(key);
        if (!s.spec) { servers.push({ key, name: s.name, spec: null, status: "failed", detail: s.why, tools: [] }); continue; }
        const r = await this.probe(s.spec, dst);
        servers.push(r.ok ? { key, name: s.name, spec: s.spec, status: "ready", tools: pinAll(r.tools) } : { key, name: s.name, spec: s.spec, status: r.needsAuth ? "needs-auth" : "failed", detail: r.why, tools: [] });
      }
      if (epoch !== this.epoch || !this.active()) throw new Error("extensions stopped");
      const item: StoredItem = {
        id, kind: "plugin", name: manifest.name || name, marketplace, source, enabled: true, consentedAt: null, servers,
        ...(manifest.publisher ?? listed.publisher ? { publisher: manifest.publisher ?? listed.publisher } : {}),
        ...(manifest.version ?? listed.version ? { version: manifest.version ?? listed.version } : {}),
        ...(manifest.description ? { description: manifest.description } : {}),
      };
      this.items.push(item);
      this.save();
      this.audit({ phase: "installed", ext: id, servers: servers.length, tools: servers.reduce((n, s) => n + s.tools.length, 0) });
      this.o.log.info("extensions.installed", { id, servers: servers.length });
      return { ok: true, id };
    } catch (err) {
      this.o.log.warn("extensions.install_failed", { err });
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* nothing was copied */ }
      this.items = this.items.filter(i => i.id !== id);
      const m = (err as Error)?.message;
      return { ok: false, why: m === "too big" ? "It's too big to install." : m === "not connected" ? "Ember isn't connected to Copilot yet." : m === "outside its marketplace" || m === "not a folder" ? "Its files aren't in its marketplace, so Ember didn't install it." : "Ember couldn't install it." };
    } finally {
      // The runtime's own install is only a download: Ember runs its copy, so the runtime keeps nothing enabled.
      if (viaRuntime) { try { await this.rpc().plugins.uninstall({ name: source }); } catch (err) { this.o.log.warn("extensions.runtime_uninstall_failed", { err }); } }
      this.busy.delete(id);
      this.changed();
    }
  }

  private probe(spec: ServerSpec, cwd: string): Promise<ProbeResult> {
    if (this.o.probe) return this.o.probe(spec, cwd);
    // The kill switch ends a probe under way (its signal is replaced at each stop).
    const signal = this.stopAsks.signal;
    if (spec.type === "stdio") {
      if (!this.o.launcher) return Promise.resolve({ ok: false, why: "Ember can't run programs for extensions on this computer yet." });
      const launch = this.launch(path.basename(cwd), spec, cwd);
      return probeStdio({ command: this.o.launcher.execPath, args: [this.o.launcher.script], env: { ELECTRON_RUN_AS_NODE: "1", EMBER_MCP_SPEC: JSON.stringify(launch) }, cwd, signal })
        .finally(() => { try { fs.rmSync(launch.leaseFile, { force: true }); } catch { /* already revoked */ } this.leases.get(path.basename(cwd))?.delete(launch.leaseFile); });
    }
    if (spec.type === "sse") return Promise.resolve({ ok: false, why: "Ember can't reach this kind of server yet." });
    return probeHttp({ url: spec.url, headers: spec.headers, fetch: this.o.fetch ?? fetch, signal });
  }

  /** How a stdio server runs: "node" is Ember's own Node, everything else as named; the environment is appEnv()'s plus the plugin's own values. */
  private command(spec: Extract<ServerSpec, { type: "stdio" }>): { command: string; args: string[]; env: Record<string, string> } {
    const base = appEnv(this.o.env ?? process.env, { session: false, os: this.o.os }) as Record<string, string>;
    for (const k of Object.keys(base)) if (/_proxy$/i.test(k)) base[k] = withoutUserinfo(base[k]);
    const env: Record<string, string> = { ...base, ...spec.env };
    if (spec.command === "node" && this.o.launcher) return { command: this.o.launcher.execPath, args: spec.args, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
    return { command: spec.command, args: spec.args, env };
  }

  async uninstall(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item) return;
    // Stopped at once; gone from the list only once the list on disk no longer holds it.
    this.stopServers(id);
    const all = this.items;
    this.items = all.filter(i => i.id !== id);
    try {
      this.save();
    } catch (err) {
      this.items = all;
      this.heldOff(item, "removed", err);
    }
    try { fs.rmSync(this.store.pluginDir(id), { recursive: true, force: true }); } catch (err) { this.o.log.warn("extensions.remove_files_failed", { err }); }
    try { this.audit({ phase: "removed", ext: id }); } catch { /* removing makes Ember stricter: it goes ahead */ }
    this.changed();
  }

  async setEnabled(id: string, on: boolean): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item || typeof on !== "boolean" || item.enabled === on) return;
    if (on && (!this.allowed() || !this.consented())) return;
    item.enabled = on;
    if (!on) this.stopServers(id);
    if (on) await this.serial(() => this.check(item));
    try {
      this.save();
    } catch (err) {
      if (!on) this.heldOff(item, "off", err);
      // On only once that is saved: what can't be recorded isn't started.
      this.o.log.warn("extensions.save_failed", { err, ext: id });
      item.enabled = false;
      this.stopServers(id);
      this.changed();
      throw new Error(EXTENSION_ON_UNSAVED, { cause: err });
    }
    this.changed();
  }

  reagree(id: string, reviewToken: string): Promise<void> {
    return this.serial(() => this.reagreeNow(id, reviewToken));
  }

  private async reagreeNow(id: string, reviewToken: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item || !this.allowed() || !this.consented()) return;
    if (reviewToken !== this.reviewToken(item)) throw new Error("Its tools changed. Check the new list and agree again.");
    this.busy.add(id);
    const epoch = this.epoch;
    try {
      await this.check(item);
      this.save();
      // A changed server or a newer Home card cannot turn this click into approval of an unseen list.
      if (!this.items.includes(item) || !this.allowed() || !this.consented() || epoch !== this.epoch) throw new Error("It was stopped. Review its tools before trying again.");
      if (reviewToken !== this.reviewToken(item)) throw new Error("Its tools changed. Check the new list and agree again.");
      if (item.servers.some(s => s.status !== "ready")) throw new Error("Its tools couldn't be checked. Try again when the server is ready.");
      this.audit({ phase: "reagreed", ext: id });
      for (const server of item.servers) {
        server.tools = pinAll(server.reviewTools ?? server.tools);
        delete server.reviewTools;
      }
      item.consentedAt = new Date().toISOString();
      this.save();
    } finally {
      this.busy.delete(id);
      this.changed();
    }
  }

  /** Lists an item's tools again and checks them against their pins: a changed tool is off (rug pull). */
  private async check(item: StoredItem): Promise<void> {
    const epoch = this.epoch;
    for (const s of item.servers) {
      if (epoch !== this.epoch || !this.items.includes(item) || !this.active()) return;
      if (!s.spec) continue;
      const r = await this.probe(s.spec, this.store.pluginDir(item.id));
      if (!r.ok) { s.status = r.needsAuth ? "needs-auth" : "failed"; s.detail = r.why; continue; }
      const before = s.tools.filter(t => t.changed).length;
      s.tools = checkPins(s.tools, r.tools);
      s.reviewTools = pinAll(r.tools);
      s.status = "ready";
      delete s.detail;
      const after = s.tools.filter(t => t.changed).length;
      if (after > before) this.o.log.warn("extensions.tool_changed", { ext: item.id, server: s.key, changed: after - before });
    }
  }

  /** At start (and when extensions are turned on): every enabled item's tools are checked against their pins. */
  refresh(): Promise<void> {
    return this.serial(() => this.refreshNow());
  }

  private async refreshNow(): Promise<void> {
    if (!this.active()) return;
    for (const item of this.items.filter(i => i.enabled)) {
      this.busy.add(item.id);
      try { await this.check(item); } catch (err) { this.o.log.warn("extensions.check_failed", { ext: item.id, err }); } finally { this.busy.delete(item.id); }
    }
    this.save();
    this.changed();
  }

  // ---- Connectors: off (not proven gated without GitHub's service; see the module comment) ----

  async connectors(): Promise<MarketplaceEntry[]> { return []; }
  async connect(_name: string): Promise<ConnectResult> { return { ok: false, why: "Connectors aren't available in Ember yet." }; }
  async disconnect(_id: string): Promise<void> { /* nothing is ever connected */ }

  // ---- The kill switch ----

  /** Stops every call (sessions loaded before deny until reloaded), drops questions, and ends every server process. */
  stopPart(): StopPart {
    return {
      name: "extensions",
      stop: () => {
        // Only a conversation that loaded extension tools (or launched a server) needs them again: with none, or with
        // extensions off (the switch reloaded it already), a reconnect would only cost the next request a resume and
        // Home its Task activity (tasks-approvals-c2-1).
        const loaded = this.active() && (this.leases.size > 0 || (this.session?.tools.size ?? 0) > 0);
        this.epoch++;
        this.stopAsks.abort();
        this.stopAsks = new AbortController();
        this.stopServers();
        // The next conversation starts the servers again (between turns, after a new request).
        if (loaded) this.gen++;
      },
    };
  }

  /**
   * Stopping a session's servers failed. A session whose connection is already gone took its servers with it (each
   * change of model service disposes the old one first, and so does quitting): a note, not a warning with a stack
   * (integrations-r9-13: 3 of 3 changes logged one).
   */
  private stopFailed(err: unknown): void {
    if (/connection is (?:disposed|closed)/i.test(errorText(err))) this.o.log.debug("extensions.stop_moot");
    else this.o.log.warn("extensions.stop_failed", { err });
  }

  /** Revoke each selected launch, even one the runtime has not started yet; never signal a pid read from disk. */
  private stopServers(id?: string): void {
    for (const [item, leases] of this.leases) {
      if (id !== undefined && item !== id) continue;
      for (const lease of leases) {
        try { fs.rmSync(lease, { force: true }); } catch (err) { this.o.log.warn("extensions.stop_failed", { err }); }
      }
      this.leases.delete(item);
    }
    const gate = this.session;
    const keys = gate ? [...new Set([...gate.tools.values()].filter(e => id === undefined || e.item.id === id).map(e => e.server.key))] : [];
    if (keys.length && gate?.stop) void gate.stop(keys).catch(err => this.stopFailed(err));
    // Old versions left pid files. Dropping them is safe; their numbers never identify a process to kill.
    try { for (const f of fs.readdirSync(this.store.runDir)) if (/^\d+\.pid$/.test(f)) fs.rmSync(path.join(this.store.runDir, f), { force: true }); } catch { /* no run folder */ }
    this.o.log.info("extensions.stopped", { servers: keys.length });
  }

  // ---- A session's tools and gate ----

  /** The extension tools for a new session (the conductor's), or undefined while extensions aren't active or none is ready. */
  forSession(): SessionExtensions | undefined {
    if (!this.active()) return undefined;
    const gate: SessionGate = { refused: new Set(), shown: new Map(), live: null, listChanged: new Set(), epoch: this.epoch, withdrawn: new Set(), mute: new Set(), stops: new Map(), tools: new Map() };
    this.session = gate;
    const mcpServers: Record<string, MCPServerConfig> = {};
    for (const item of this.items) {
      if (!item.enabled || item.consentedAt === null) continue;
      for (const s of item.servers) {
        if (s.status !== "ready" || !s.spec || (s.spec.type === "stdio" && !this.o.launcher)) continue;
        const clashes = clashingToolNames(s.key, s.tools.map(t => t.name));
        const tools = s.tools.filter(t => !t.changed && MCP_TOOL_NAME.test(t.name) && !clashes.has(modelToolName(s.key, t.name)));
        if (!tools.length) continue;
        for (const t of tools) gate.tools.set(modelToolName(s.key, t.name), { item, server: s, tool: t });
        mcpServers[s.key] = this.serverConfig(item, s, tools.map(t => t.name));
      }
    }
    if (!gate.tools.size) return undefined;
    return {
      mcpServers,
      tools: [...gate.tools.keys()],
      preToolUse: input => this.decide(gate, input),
      postToolUse: input => this.result(gate, input),
      postToolUseFailure: input => this.failure(gate, input),
      verify: shown => this.verify(gate, shown),
      bind: (live, stop, served) => {
        gate.live = live;
        gate.stop = stop;
        gate.served = served;
        // Removal/Stop can win the race with session startup; the late binding must not restart anything.
        const stale = [...new Set([...gate.tools.values()].filter(e => !this.active() || gate.epoch !== this.epoch || !this.items.some(i => i.id === e.item.id && i.enabled)).map(e => e.server.key))];
        if (stale.length && stop) void stop(stale).catch(err => this.stopFailed(err));
        // A server taken out before the session was bound (it said its list changed as the session loaded) leaves
        // it now, and the session's hooks wait for that.
        if (gate.withdrawn.size) void this.stopIn(gate, [...gate.withdrawn]);
      },
      listChanged: server => this.announced(gate, server),
      settled: () => this.settle(gate),
      newTurn: () => gate.refused.clear(),
    };
  }

  private serverConfig(item: StoredItem, s: StoredServer, tools: string[]): MCPServerConfig {
    const spec = s.spec!;
    if (spec.type !== "stdio") return { type: spec.type, url: spec.url, headers: spec.headers, tools, timeout: 60_000 } as MCPServerConfig;
    const launch = this.launch(item.id, spec, this.store.pluginDir(item.id));
    return { type: "stdio", command: this.o.launcher!.execPath, args: [this.o.launcher!.script], env: { ELECTRON_RUN_AS_NODE: "1", EMBER_MCP_SPEC: JSON.stringify(launch) }, workingDirectory: launch.cwd, tools, timeout: 60_000 };
  }

  private launch(id: string, spec: Extract<ServerSpec, { type: "stdio" }>, cwd: string) {
    const c = this.command(spec);
    this.store.ensure();
    const leaseFile = path.join(this.store.runDir, `${crypto.randomUUID()}.lease`);
    fs.writeFileSync(leaseFile, "", { mode: 0o600, flag: "wx" });
    const leases = this.leases.get(id) ?? new Set<string>();
    leases.add(leaseFile);
    this.leases.set(id, leases);
    return { command: c.command, args: c.args, env: c.env, cwd, runDir: this.store.runDir, leaseFile, group: this.o.os !== "win32" };
  }

  /**
   * What a session shows of its extension tools as it loads, against their pins. A tool that differs is taken out of
   * the session before its first request (integrations-r9-1: the pin was compared only to decide calls, so the model
   * was shown a description nobody agreed to for the whole conversation while Home said "Ready").
   */
  private async verify(gate: SessionGate, shown: ShownTool[]): Promise<void> {
    const differ: string[] = [];
    for (const t of shown) {
      const e = gate.tools.get(t.name);
      if (!e) continue;
      const ok = asPinned(e.tool, t);
      gate.shown.set(t.name, ok);
      if (!ok) { differ.push(t.name); this.o.log.warn("extensions.shown_differs", { ext: e.item.id, tool: e.tool.name }); }
    }
    if (differ.length) await this.withdraw(gate, differ, false);
  }

  /**
   * A server said its tool list changed (`mcp.tools.list_changed`). The runtime asks the server again as it builds
   * its next request and shows the model what it gets, with no word to Ember first, so nothing Ember could ask the
   * server now says what the model will be shown (integrations-x9-1: a server that answered Ember's own question as
   * agreed and the runtime's with new text kept that text in every request of the conversation, Home saying
   * "Ready"). The word itself is the change. The server leaves this session at once, unasked; the conversation is
   * tainted (the notice may have reached the runtime a moment before a request was built) and reloads between
   * turns, where the runtime's own first list is checked against the pins as at every load. A server that says it
   * again in the same conversation has every tool it had in the session turned off until the user agrees again
   * (PLAN.md §2 "Connectors"). A stdio server's notice doesn't get this far: Ember's launcher never passes it to
   * the runtime (launch.ts), so this is for a remote server, and for anything that got past.
   */
  private announced(gate: SessionGate, server: string): void {
    // Logged once a session for each server: how often it says so is the server's choice, and the log isn't its to fill.
    if (!gate.listChanged.has(server)) this.o.log.info("extensions.list_changed", { server });
    gate.listChanged.add(server);
    // An old session is nobody's, and a server already on its way out has nothing more to lose.
    if (gate !== this.session || gate.epoch !== this.epoch || gate.withdrawn.has(server)) return;
    const names = [...gate.tools].filter(([, e]) => e.server.key === server).map(([name]) => name);
    if (!names.length) return;
    if (this.announcers.has(server)) {
      void this.withdraw(gate, names, true).catch(err => this.o.log.warn("extensions.withdraw_failed", { err }));
      return;
    }
    this.announcers.add(server);
    this.tainted = true;
    void this.stopIn(gate, [server]);
    this.changed();
  }

  /**
   * A server's own list after one of its calls, against the pins, before the result goes back
   * (integrations-r9-1): a head start on a server that changes a tool as it answers and says so, since its notice
   * and the result's hook reach Ember in either order (the hook first in 1 run of 14). Only ever a reason to turn
   * something off: a list that matches proves nothing about what the runtime will be given (integrations-x9-1).
   * Bounded by LIST_WAIT_MS, and a server that doesn't give its list isn't asked again in this session. A tool the
   * server no longer lists isn't shown any more: nothing to take away, and the next start's check turns it off.
   */
  private async afterCall(gate: SessionGate, server: string): Promise<void> {
    if (gate !== this.session || gate.epoch !== this.epoch || gate.withdrawn.has(server) || !gate.served || gate.mute.has(server)) return;
    let now: Map<string, string>;
    try {
      const listed = await inTime(gate.served(server), LIST_WAIT_MS);
      if (!Array.isArray((listed as { tools?: unknown })?.tools)) throw new Error("the runtime did not report the server's tools");
      now = new Map(servedTools([listed]).map(t => [t.name, toolHash(t)]));
    } catch {
      gate.mute.add(server);
      this.o.log.info("extensions.served_tools_unread", { server });
      return;
    }
    // An old session's list must not change the pins of a newer conversation. A server that said meanwhile that its
    // list changed is on its way out already: what its list shows to differ is still marked.
    if (gate !== this.session || gate.epoch !== this.epoch) return;
    const differ = [...gate.tools].filter(([, e]) => e.server.key === server && now.has(e.tool.name) && now.get(e.tool.name) !== e.tool.hash).map(([name]) => name);
    if (differ.length) await this.withdraw(gate, differ, true);
  }

  /**
   * Settles once every server Ember is taking out of this session is out, or the runtime's time to do it has run out
   * (at once when there is none). Each leaving is asked for once and bounded by STOP_WAIT_MS on its own, so one wait
   * here is at most that long whatever a server sends and however often (integrations-x9-4: each notice queued a
   * question to the server, 27 s for one ordinary request).
   */
  private async settle(gate: SessionGate): Promise<void> {
    if (gate.stops.size) await Promise.all(gate.stops.values());
  }

  /**
   * Disables `servers` in the gate's own session (never another), each once, saying whether the runtime did it. From
   * here on their tools are denied in this session whatever the runtime answers. A runtime that doesn't answer
   * counts as not done after STOP_WAIT_MS: the call or the start waiting on this goes on (denied, tainted).
   */
  private async stopIn(gate: SessionGate, servers: string[]): Promise<boolean> {
    const stops = servers.map(server => {
      gate.withdrawn.add(server);
      let stop = gate.stops.get(server);
      if (!stop && gate.stop) {
        // Asked of the runtime now, in this very step: nothing may be built in between.
        let asked: Promise<void>;
        try { asked = gate.stop([server]); } catch (err) { asked = Promise.reject(err); }
        stop = inTime(asked, STOP_WAIT_MS).then(() => true, err => { this.stopFailed(err); return false; });
        gate.stops.set(server, stop);
      }
      return stop ?? Promise.resolve(false);
    });
    return stops.length > 0 && (await Promise.all(stops)).every(Boolean);
  }

  /**
   * Tools the session shows differently from their pins: each is marked changed for good (off until the user agrees
   * again; Home says "Changed since you agreed"), audited without its text, and its server is disabled in that session
   * so the model is no longer shown it; the conversation then reloads between turns without the tool. `seen`: the
   * model may have been sent the text already (a change mid-session, or a server that said twice that its list
   * changed), so every later extension call in this conversation asks; the same when the server couldn't be taken
   * out. This only ever turns something off.
   */
  private async withdraw(gate: SessionGate, names: string[], seen: boolean): Promise<void> {
    let marked = false;
    // A replaced session or a pulled kill switch: the session is nobody's, and its list says nothing of today's pins.
    const current = gate === this.session && gate.epoch === this.epoch;
    // The server first (the runtime may be about to build a request), the record while the runtime works on it.
    const stopping = this.stopIn(gate, [...new Set(names.flatMap(n => gate.tools.get(n)?.server.key ?? []))]);
    for (const name of names) {
      const e = gate.tools.get(name);
      if (!e) continue;
      gate.shown.set(name, false);
      // The pin it was compared with, not one the user agreed to since (agreeing again pins the new text).
      const stored = current && this.items.includes(e.item) ? e.item.servers.find(s => s === e.server)?.tools.find(t => t.name === e.tool.name && t.hash === e.tool.hash) : undefined;
      if (!stored || stored.changed) continue;
      stored.changed = true;
      marked = true;
      this.o.log.warn("extensions.tool_changed_live", { ext: e.item.id, tool: e.tool.name });
      try { this.audit({ phase: "changed", ext: e.item.id, tool: name }); } catch { /* it is turned off either way */ }
    }
    if (marked) { try { this.save(); } catch (err) { this.o.log.warn("extensions.save_failed", { err }); } }
    const out = await stopping;
    if (current && (seen || !out)) this.tainted = true;
    if (marked) this.changed();
  }

  /**
   * Whether the session shows `name` now exactly as pinned. A server may change a tool mid-session (tools/list_changed),
   * so this is read from the live list at every call; a tool that differs is marked changed for good (off until the
   * user agrees again). No live list (not bound, or it can't be read): not as pinned (fail closed).
   */
  private async shownNow(gate: SessionGate, name: string, generation: number): Promise<boolean> {
    const e = gate.tools.get(name);
    // A server Ember took out of this session: its tools are denied here whatever the runtime still shows of them.
    if (!e || !gate.live || gate.shown.get(name) !== true || gate.withdrawn.has(e.server.key)) return false;
    let now: ShownTool | undefined;
    try { now = (await gate.live()).find(t => t.name === name); } catch (err) { this.o.log.warn("extensions.live_tools_failed", { err }); return false; }
    // An old lookup must not change the pins of a replacement item or a newer conversation.
    if (gate !== this.session || gate.epoch !== this.epoch || generation !== this.generation || !this.items.includes(e.item)) return false;
    if (now && asPinned(e.tool, now)) return true;
    // Its server left this session while the list was read: denied until the conversation reloads.
    if (gate.withdrawn.has(e.server.key)) return false;
    // Shown differently, or no longer shown: off for good, and its server leaves this session (integrations-r9-1).
    await this.withdraw(gate, [name], true);
    return false;
  }

  /** Read policy synchronously, after metadata awaits and again immediately before returning Allow. */
  private gateInput(gate: SessionGate, name: string, shownAsPinned: boolean, generation: number) {
    const e = gate.tools.get(name);
    const current = e && this.items.includes(e.item) ? e.item : undefined;
    const server = current?.servers.find(s => s === e?.server && s.status === "ready");
    const tool = server?.tools.find(t => t.name === e?.tool.name && t.hash === e?.tool.hash);
    const decision = classify({
      allowed: this.active(), stopped: gate.epoch !== this.epoch,
      ...(current ? { item: { enabled: current.enabled, consented: current.consentedAt !== null } } : {}),
      ...(tool ? { tool } : {}),
      shownAsPinned: shownAsPinned && gate.shown.get(name) === true,
      tainted: this.tainted, refused: gate.refused.has(name), remote: e?.server.spec?.type !== "stdio",
      hintsStale: !!e && gate.listChanged.has(e.server.key), serverStopped: !!e && gate.withdrawn.has(e.server.key),
      autopilot: this.o.autopilot?.() === true,
      vaultFilled: this.vaultFilled(),
    });
    if (decision.verdict === "deny") return decision;
    if (gate !== this.session || generation !== this.generation) return { verdict: "deny" as const, reason: "Extensions changed. Wait for the conversation to reload before trying again." };
    return decision;
  }

  /** Has the vault filled something in this run? A check that fails says yes (fail closed). */
  private vaultFilled(): boolean {
    try { return this.o.vaultFilled?.() === true; } catch { return true; }
  }

  private async decide(gate: SessionGate, input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    const e = gate.tools.get(input.toolName);
    // A server is leaving the session: the decision waits until it is out (its tools are denied).
    await this.settle(gate);
    const generation = this.generation;
    const shownAsPinned = await this.shownNow(gate, input.toolName, generation);
    const { verdict, reason } = this.gateInput(gate, input.toolName, shownAsPinned, generation);
    const argChars = (() => { try { return JSON.stringify(input.toolArgs ?? {}).length; } catch { return 0; } })();
    const base = { ext: e?.item.id ?? null, tool: input.toolName, argChars };
    const deny = (r: string): PreToolUseHookOutput => ({ permissionDecision: "deny", permissionDecisionReason: r });
    try {
      this.audit({ phase: "decision", ...base, verdict, reason, ...(verdict === "announce" ? { autonomy: true, mode: "autopilot" } : {}) });
    } catch (err) {
      // Not recorded, not run (fail closed).
      this.o.log.warn("extensions.audit_failed", { err });
      return deny("Ember couldn't record this step, so it didn't take it.");
    }
    if (verdict === "deny") return deny(reason);
    const before = this.gateInput(gate, input.toolName, shownAsPinned, generation);
    if (before.verdict === "deny") return deny(before.reason);
    if (verdict === "allow" && before.verdict === "allow") return { permissionDecision: "allow" };
    // Autopilot: said in the conversation's bubble instead of asked, and only once it was said (a call that can't be
    // announced asks, as it does when Autopilot went out of force between the two looks).
    if (verdict === "announce" && before.verdict === "announce" && this.said(gateAnnouncement(e!.item.name))) return { permissionDecision: "allow" };
    const confirmer = this.o.confirmer();
    if (!confirmer) return deny("Ember can't ask the user right now, so it didn't do this.");
    const question = gateQuestion(e!.item.name, e!.tool.name, input.toolArgs);
    const answer = await confirmer.ask(question, this.stopAsks.signal).catch(() => null);
    // The question may have been up a while: the item, its pin and the live tool are checked again before a yes counts.
    const shownAfter = answer === "once" && await this.shownNow(gate, input.toolName, generation);
    const after = answer === "once" ? this.gateInput(gate, input.toolName, shownAfter, generation) : null;
    const yes = answer === "once" && after !== null && after.verdict !== "deny";
    // A spoken answer says so, and whether Voice Match verified it (confirm.ts answerVoice).
    const how = confirmer.howAnswered?.(question);
    const channel = how?.via === "voice" ? { via: "voice", verified: how.verified === true, ...(how.trust ? { trust: how.trust } : {}) } : {};
    try { this.audit({ phase: "answer", ...base, answer: yes ? "allow" : answer === null ? "none" : answer === "once" ? "stale" : "deny", ...channel }); } catch { return deny("Ember couldn't record this step, so it didn't take it."); }
    if (yes) {
      const current = this.gateInput(gate, input.toolName, shownAfter, generation);
      return current.verdict === "deny" ? deny(current.reason) : { permissionDecision: "allow" };
    }
    if (answer === "once" && after) return deny(after.reason);
    gate.refused.add(input.toolName);
    return deny(REFUSED);
  }

  /** After a call of `server`'s (or of none): its list against the pins, then every server on its way out is out. */
  private async checked(gate: SessionGate, server: string | undefined): Promise<void> {
    if (server) await this.afterCall(gate, server).catch(err => this.o.log.warn("extensions.recheck_failed", { err }));
    await this.settle(gate);
  }

  /** Says an Autopilot announcement; whether it was said (no announcer, or one that failed: not said). */
  private said(words: string): boolean {
    try {
      return this.o.announce?.(words) === true;
    } catch (err) {
      this.o.log.warn("extensions.announce_failed", { err });
      return false;
    }
  }

  /**
   * A failed call: the SDK passes its text to the model as it is (a failure can't be rewritten), so Ember says it is
   * untrusted, and the conversation is tainted (a failure is an easy way to smuggle text): every later call asks.
   * Because it can't be rewritten, no extension is called once the vault has filled something (gate.ts VAULT_FILLED).
   */
  private async failure(gate: SessionGate, input: PostToolUseFailureHookInput): Promise<PostToolUseFailureHookOutput> {
    const e = gate.tools.get(input.toolName);
    // As for a result: its server's list is compared with the pins before the runtime builds its next request.
    await this.checked(gate, e?.server.key);
    const text = typeof input.error === "string" ? input.error : "";
    const signals = injectionSignals(text);
    this.tainted = true;
    try { this.audit({ phase: "failed", ext: e?.item.id ?? null, tool: input.toolName, chars: text.length, signals, ...(SAVED_OUTPUT.test(text) ? { truncated: true } : {}) }); } catch (err) { this.o.log.warn("extensions.audit_failed", { err }); }
    return { additionalContext: failureNote(e?.item.name ?? "an extension", e?.tool.name ?? input.toolName) };
  }

  private async result(gate: SessionGate, input: PostToolUseHookInput): Promise<PostToolUseHookOutput | void> {
    const e = gate.tools.get(input.toolName);
    // A server that changes its list as it answers (a rug pull after a call): the runtime builds its next request
    // only once this hook returns. So Ember asks the server for its list now, and this returns once a server that
    // changed a tool, or said meanwhile that its list changed, is out of the session.
    await this.checked(gate, e?.server.key);
    const text = typeof input.toolResult?.textResultForLlm === "string" ? input.toolResult.textResultForLlm : "";
    const signals = injectionSignals(text);
    // Output too big to pass on: the runtime saved it to a file and passes a pointer and a preview, so most of it was
    // never scanned. Treated as flagged.
    const truncated = SAVED_OUTPUT.test(text);
    if (signals.length || truncated) this.tainted = true;
    try { this.audit({ phase: "result", ext: e?.item.id ?? null, tool: input.toolName, chars: text.length, signals, ...(truncated ? { truncated: true } : {}) }); } catch (err) { this.o.log.warn("extensions.audit_failed", { err }); }
    // Text only (the conductor is never sent images), wrapped as untrusted.
    // Only Ember's own fields: the server's raw text (contents, its log) never rides along.
    return { modifiedResult: { textResultForLlm: wrapResult(e?.item.name ?? "an extension", e?.tool.name ?? input.toolName, text, signals.length > 0 || truncated), resultType: input.toolResult?.resultType ?? "success", binaryResultsForLlm: [] } };
  }
}
