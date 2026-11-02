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

import { execFile } from "node:child_process";
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
import type { ConnectResult, ExtensionsApi, Installed, MarketplaceEntry, ToolInfo } from "../../shared/extensions";
import type { OS } from "../../shared/shortcuts";
import { REFUSED, classify, failureNote, gateQuestion, wrapResult } from "./gate";
import { pluginPath, readMarketplace, readPlugin, reachOf, firstFile, MARKETPLACE_PLACES, type ServerSpec } from "./manifest";
import { checkPins, isReadOnly, pinAll, shownHash, type PinnedTool } from "./pin";
import { probeHttp, probeStdio, type ProbeResult } from "./probe";
import { ExtensionStore, copyPlugin, type StoredItem, type StoredServer } from "./store";

export interface ExtensionsDeps {
  /** `<userData>/extensions`. */
  dir: string;
  /** `<userData>/copilot` (the runtime's home: its marketplace cache and plugin installs). */
  copilotHome: string;
  settings: { get(): Settings; update?(patch: SettingsPatch): unknown };
  admin: () => AdminPolicy;
  /** The connected runtime, for marketplaces (null while Ember isn't connected). */
  client: () => CopilotClient | null;
  confirmer: () => Confirmer | null;
  audit: () => AuditLog | null;
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

/** A friendly sentence for an error a marketplace operation threw (never the raw text). */
function why(err: unknown, fallback: string): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/not found|404|does not exist|no such/i.test(m)) return "Ember couldn't find that marketplace.";
  if (/already/i.test(m)) return "That marketplace is already added.";
  if (/network|ENOTFOUND|ECONN|timed? ?out|ETIMEDOUT/i.test(m)) return "Ember couldn't reach it. Check your connection and try again.";
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
  epoch: number;
  tools: Map<string, { item: StoredItem; server: StoredServer; tool: PinnedTool }>;
}

export class ExtensionsService implements ExtensionsApi {
  private store: ExtensionStore;
  private items: StoredItem[];
  private listeners = new Set<() => void>();
  private busy = new Set<string>();
  /** Bumped whenever what a conversation would load changes: the host reconnects between turns. */
  private gen = 0;
  /** Bumped by the kill switch: sessions loaded before it deny every call until reloaded. */
  private epoch = 0;
  private stopAsks = new AbortController();
  /**
   * An extension's result or failure read as instructions (or a call failed) in this conversation: every later call
   * asks. Kept here, not per session, so a reconnect (which builds a new session) keeps it; conversationEnded() clears it.
   */
  private tainted = false;
  /** Installs and agreements run one at a time (two at once could take the same server key or copy into one folder). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private o: ExtensionsDeps) {
    this.store = new ExtensionStore(o.dir);
    this.items = this.store.read();
    // Process ids left by an earlier run belong to processes that have ended (or been reused): never killed, dropped.
    try { for (const f of fs.readdirSync(this.store.runDir)) fs.rmSync(path.join(this.store.runDir, f), { force: true }); } catch { /* no run folder yet */ }
  }

  /** The conversation was forgotten (sign-out, another account, a new conversation): its taint goes with it. */
  conversationEnded(): void {
    this.tainted = false;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
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

  /** The user agreed to extensions' first-use card at its current version. */
  consented(): boolean {
    return this.o.settings.get().extensions.consent.version >= FEATURE_CONSENT_VERSION.extensions;
  }

  /** The card's yes in Home (a click there, never the model): records the agreement and turns extensions on. */
  async agree(): Promise<void> {
    if (!this.allowed() || !this.o.settings.update) return;
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
    const tools: ToolInfo[] = i.servers.flatMap(s => s.tools.map(t => ({ name: t.name, description: t.description, readOnly: isReadOnly(t), ...(t.changed ? { changed: true } : {}) })));
    const failed = i.servers.find(s => s.status === "failed");
    const auth = i.servers.find(s => s.status === "needs-auth");
    const status: Installed["status"] = this.busy.has(i.id) ? "starting" : !i.enabled ? "disabled" : failed ? "failed" : auth ? "needs-auth" : "ready";
    const detail = status === "failed" ? failed?.detail : status === "needs-auth" ? auth?.detail : tools.some(t => t.changed) ? "A tool changed since you agreed to it. It stays off until you agree again." : undefined;
    return {
      id: i.id, kind: i.kind, name: i.name, source: i.source, enabled: i.enabled, consented: i.consentedAt !== null, status, tools,
      ...(i.publisher ? { publisher: i.publisher } : {}), ...(i.version ? { version: i.version } : {}), ...(detail ? { detail } : {}),
      reaches: i.servers.filter(s => s.spec).map(s => reachOf(s.spec!, this.store.pluginDir(i.id))),
    };
  }

  // ---- Marketplaces (registered with the runtime, which fetches them) ----

  private rpc() {
    const c = this.o.client();
    if (!c) throw new Error("not connected");
    return c.rpc;
  }

  async marketplaces(): Promise<{ name: string; source: string }[]> {
    if (!this.allowed()) return [];
    try {
      const r = await this.rpc().plugins.marketplaces.list();
      return r.marketplaces.map(m => ({ name: m.name, source: m.source }));
    } catch (err) {
      this.o.log.warn("extensions.marketplaces_failed", { err });
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
      return { ok: false, why: (err as Error)?.message === "not connected" ? "Ember isn't connected to Copilot yet." : why(err, "Ember couldn't add that marketplace.") };
    }
  }

  async removeMarketplace(name: string): Promise<void> {
    if (typeof name !== "string" || !name) return;
    try { await this.rpc().plugins.marketplaces.remove({ name, force: true }); } catch (err) { this.o.log.warn("extensions.marketplace_remove_failed", { err }); }
    this.changed(false);
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

  async browse(marketplace: string): Promise<MarketplaceEntry[]> {
    if (!this.allowed() || typeof marketplace !== "string") return [];
    try {
      // The runtime fetches (or refreshes) the catalogue; Ember reads it for what it offers.
      await this.rpc().plugins.marketplaces.browse({ name: marketplace });
      const root = await this.marketplaceRoot(marketplace);
      if (!root) return [];
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
      return [];
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
        let key = slug(s.name, 20);
        for (let n = 2; taken.has(key); n++) key = `${slug(s.name, 18)}${n}`;
        taken.add(key);
        if (!s.spec) { servers.push({ key, name: s.name, spec: null, status: "failed", detail: s.why, tools: [] }); continue; }
        const r = await this.probe(s.spec, dst);
        servers.push(r.ok ? { key, name: s.name, spec: s.spec, status: "ready", tools: pinAll(r.tools) } : { key, name: s.name, spec: s.spec, status: r.needsAuth ? "needs-auth" : "failed", detail: r.why, tools: [] });
      }
      const item: StoredItem = {
        id, kind: "plugin", name: manifest.name || name, marketplace, source, enabled: true, consentedAt: new Date().toISOString(), servers,
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
    if (spec.type === "stdio") return this.o.launcher ? probeStdio({ ...this.command(spec), cwd, signal }) : Promise.resolve({ ok: false, why: "Ember can't run programs for extensions on this computer yet." });
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
    this.items = this.items.filter(i => i.id !== id);
    this.save();
    try { fs.rmSync(this.store.pluginDir(id), { recursive: true, force: true }); } catch (err) { this.o.log.warn("extensions.remove_files_failed", { err }); }
    try { this.audit({ phase: "removed", ext: id }); } catch { /* removing makes Ember stricter: it goes ahead */ }
    this.changed();
  }

  async setEnabled(id: string, on: boolean): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item || typeof on !== "boolean" || item.enabled === on) return;
    if (on && (!this.allowed() || !this.consented())) return;
    item.enabled = on;
    if (on) await this.check(item);
    this.save();
    this.changed();
  }

  reagree(id: string): Promise<void> {
    return this.serial(() => this.reagreeNow(id));
  }

  private async reagreeNow(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item || !this.allowed() || !this.consented()) return;
    this.busy.add(id);
    try {
      for (const s of item.servers) {
        if (!s.spec) continue;
        const r = await this.probe(s.spec, this.store.pluginDir(id));
        if (r.ok) { s.tools = pinAll(r.tools); s.status = "ready"; delete s.detail; } else { s.status = r.needsAuth ? "needs-auth" : "failed"; s.detail = r.why; }
      }
      item.consentedAt = new Date().toISOString();
      this.save();
      this.audit({ phase: "reagreed", ext: id });
    } finally {
      this.busy.delete(id);
      this.changed();
    }
  }

  /** Lists an item's tools again and checks them against their pins: a changed tool is off (rug pull). */
  private async check(item: StoredItem): Promise<void> {
    for (const s of item.servers) {
      if (!s.spec) continue;
      const r = await this.probe(s.spec, this.store.pluginDir(item.id));
      if (!r.ok) { s.status = r.needsAuth ? "needs-auth" : "failed"; s.detail = r.why; continue; }
      const before = s.tools.filter(t => t.changed).length;
      s.tools = checkPins(s.tools, r.tools);
      s.status = "ready";
      delete s.detail;
      const after = s.tools.filter(t => t.changed).length;
      if (after > before) this.o.log.warn("extensions.tool_changed", { ext: item.id, server: s.key, changed: after - before });
    }
  }

  /** At start (and when extensions are turned on): every enabled item's tools are checked against their pins. */
  async refresh(): Promise<void> {
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
        this.epoch++;
        this.stopAsks.abort();
        this.stopAsks = new AbortController();
        let ended = 0;
        let files: string[] = [];
        try { files = fs.readdirSync(this.store.runDir).filter(f => /^\d+\.pid$/.test(f)); } catch { /* none running */ }
        for (const f of files) {
          const launcher = Number(f.slice(0, -4));
          let server = NaN;
          try { server = Number(fs.readFileSync(path.join(this.store.runDir, f), "utf8")); } catch { /* the launcher alone */ }
          for (const pid of [server, launcher]) {
            if (!Number.isInteger(pid) || pid <= 1) continue;
            if (this.o.os === "win32") {
              // The whole tree the server started (taskkill /T), at once.
              execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => undefined);
              ended++;
              continue;
            }
            // The server leads its own process group (launch.ts): everything it started ends with it.
            try { process.kill(pid === server ? -pid : pid, "SIGTERM"); ended++; } catch {
              try { process.kill(pid, "SIGTERM"); ended++; } catch { /* already gone */ }
            }
          }
          try { fs.rmSync(path.join(this.store.runDir, f), { force: true }); } catch { /* the launcher removes it too */ }
        }
        this.o.log.info("extensions.stopped", { ended });
        // The next conversation starts the servers again (between turns, after a new request).
        this.gen++;
      },
    };
  }

  // ---- A session's tools and gate ----

  /** The extension tools for a new session (the conductor's), or undefined while extensions aren't active or none is ready. */
  forSession(): SessionExtensions | undefined {
    if (!this.active()) return undefined;
    const gate: SessionGate = { refused: new Set(), shown: new Map(), live: null, epoch: this.epoch, tools: new Map() };
    const mcpServers: Record<string, MCPServerConfig> = {};
    for (const item of this.items) {
      if (!item.enabled || item.consentedAt === null) continue;
      for (const s of item.servers) {
        if (s.status !== "ready" || !s.spec || (s.spec.type === "stdio" && !this.o.launcher)) continue;
        const tools = s.tools.filter(t => !t.changed && /^[A-Za-z0-9_-]{1,64}$/.test(t.name));
        if (!tools.length) continue;
        for (const t of tools) gate.tools.set(`${s.key}-${t.name}`, { item, server: s, tool: t });
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
      bind: live => { gate.live = live; },
      newTurn: () => gate.refused.clear(),
    };
  }

  private serverConfig(item: StoredItem, s: StoredServer, tools: string[]): MCPServerConfig {
    const spec = s.spec!;
    if (spec.type !== "stdio") return { type: spec.type, url: spec.url, headers: spec.headers, tools, timeout: 60_000 } as MCPServerConfig;
    const c = this.command(spec);
    const launch = { command: c.command, args: c.args, env: c.env, cwd: this.store.pluginDir(item.id), runDir: this.store.runDir, group: this.o.os !== "win32" };
    // The runtime starts Ember's launcher, which starts the server with exactly this environment (launch.ts).
    return { type: "stdio", command: this.o.launcher!.execPath, args: [this.o.launcher!.script], env: { ELECTRON_RUN_AS_NODE: "1", EMBER_MCP_SPEC: JSON.stringify(launch) }, workingDirectory: launch.cwd, tools, timeout: 60_000 };
  }

  private verify(gate: SessionGate, shown: ShownTool[]): void {
    for (const t of shown) {
      const e = gate.tools.get(t.name);
      if (!e) continue;
      const ok = shownHash(e.tool.name, t.description ?? "", t.input_schema ?? null) === shownHash(e.tool.name, e.tool.description, e.tool.inputSchema);
      gate.shown.set(t.name, ok);
      if (!ok) this.o.log.warn("extensions.shown_differs", { ext: e.item.id, tool: e.tool.name });
    }
  }

  /**
   * Whether the session shows `name` now exactly as pinned. A server may change a tool mid-session (tools/list_changed),
   * so this is read from the live list at every call; a tool that differs is marked changed for good (off until the
   * user agrees again). No live list (not bound, or it can't be read): not as pinned (fail closed).
   */
  private async shownNow(gate: SessionGate, name: string): Promise<boolean> {
    const e = gate.tools.get(name);
    if (!e || !gate.live || gate.shown.get(name) !== true) return false;
    let now: ShownTool | undefined;
    try { now = (await gate.live()).find(t => t.name === name); } catch (err) { this.o.log.warn("extensions.live_tools_failed", { err }); return false; }
    if (now && shownHash(e.tool.name, now.description ?? "", now.input_schema ?? null) === shownHash(e.tool.name, e.tool.description, e.tool.inputSchema)) return true;
    gate.shown.set(name, false);
    this.o.log.warn("extensions.tool_changed_live", { ext: e.item.id, tool: e.tool.name });
    const stored = this.items.find(i => i.id === e.item.id)?.servers.find(s => s.key === e.server.key)?.tools.find(t => t.name === e.tool.name);
    if (stored && !stored.changed) {
      stored.changed = true;
      try { this.save(); } catch (err) { this.o.log.warn("extensions.save_failed", { err }); }
      try { this.audit({ phase: "changed", ext: e.item.id, tool: name }); } catch { /* the call is denied either way */ }
      this.changed();
    }
    return false;
  }

  /** The gate's inputs for `name` as things are now (the store may have changed while a question was up). */
  private async gateInput(gate: SessionGate, name: string) {
    const e = gate.tools.get(name);
    const current = e ? this.items.find(i => i.id === e.item.id) : undefined;
    const tool = current?.servers.flatMap(s => s.tools).find(t => t.name === e?.tool.name && t.hash === e?.tool.hash);
    return classify({
      allowed: this.active(), stopped: gate.epoch !== this.epoch,
      ...(current ? { item: { enabled: current.enabled, consented: current.consentedAt !== null } } : {}),
      ...(tool ? { tool } : {}),
      shownAsPinned: await this.shownNow(gate, name),
      tainted: this.tainted, refused: gate.refused.has(name), remote: e?.server.spec?.type !== "stdio",
    });
  }

  private async decide(gate: SessionGate, input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    const e = gate.tools.get(input.toolName);
    const { verdict, reason } = await this.gateInput(gate, input.toolName);
    const argChars = (() => { try { return JSON.stringify(input.toolArgs ?? {}).length; } catch { return 0; } })();
    const base = { ext: e?.item.id ?? null, tool: input.toolName, argChars };
    const deny = (r: string): PreToolUseHookOutput => ({ permissionDecision: "deny", permissionDecisionReason: r });
    try {
      this.audit({ phase: "decision", ...base, verdict, reason });
    } catch (err) {
      // Not recorded, not run (fail closed).
      this.o.log.warn("extensions.audit_failed", { err });
      return deny("Ember couldn't record this step, so it didn't take it.");
    }
    if (verdict === "deny") return deny(reason);
    if (verdict === "allow") return { permissionDecision: "allow" };
    const confirmer = this.o.confirmer();
    if (!confirmer) return deny("Ember can't ask the user right now, so it didn't do this.");
    const answer = await confirmer.ask(gateQuestion(e!.item.name, e!.tool.name, input.toolArgs), this.stopAsks.signal).catch(() => null);
    // The question may have been up a while: the item, its pin and the live tool are checked again before a yes counts.
    const after = answer === "once" ? await this.gateInput(gate, input.toolName) : null;
    const yes = answer === "once" && after !== null && after.verdict !== "deny";
    try { this.audit({ phase: "answer", ...base, answer: yes ? "allow" : answer === null ? "none" : answer === "once" ? "stale" : "deny" }); } catch { return deny("Ember couldn't record this step, so it didn't take it."); }
    if (yes) return { permissionDecision: "allow" };
    if (answer === "once" && after) return deny(after.reason);
    gate.refused.add(input.toolName);
    return deny(REFUSED);
  }

  /**
   * A failed call: the SDK passes its text to the model as it is (a failure can't be rewritten), so Ember says it is
   * untrusted, and the conversation is tainted (a failure is an easy way to smuggle text): every later call asks.
   */
  private async failure(gate: SessionGate, input: PostToolUseFailureHookInput): Promise<PostToolUseFailureHookOutput> {
    const e = gate.tools.get(input.toolName);
    const text = typeof input.error === "string" ? input.error : "";
    const signals = injectionSignals(text);
    this.tainted = true;
    try { this.audit({ phase: "failed", ext: e?.item.id ?? null, tool: input.toolName, chars: text.length, signals }); } catch (err) { this.o.log.warn("extensions.audit_failed", { err }); }
    return { additionalContext: failureNote(e?.item.name ?? "an extension", e?.tool.name ?? input.toolName) };
  }

  private async result(gate: SessionGate, input: PostToolUseHookInput): Promise<PostToolUseHookOutput | void> {
    const e = gate.tools.get(input.toolName);
    const text = typeof input.toolResult?.textResultForLlm === "string" ? input.toolResult.textResultForLlm : "";
    const signals = injectionSignals(text);
    if (signals.length) this.tainted = true;
    try { this.audit({ phase: "result", ext: e?.item.id ?? null, tool: input.toolName, chars: text.length, signals }); } catch (err) { this.o.log.warn("extensions.audit_failed", { err }); }
    // Text only (the conductor is never sent images), wrapped as untrusted.
    // Only Ember's own fields: the server's raw text (contents, its log) never rides along.
    return { modifiedResult: { textResultForLlm: wrapResult(e?.item.name ?? "an extension", e?.tool.name ?? input.toolName, text, signals.length > 0), resultType: input.toolResult?.resultType ?? "success", binaryResultsForLlm: [] } };
  }
}
