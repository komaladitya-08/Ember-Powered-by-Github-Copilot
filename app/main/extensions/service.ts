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
import type { PostToolUseHookInput, PostToolUseHookOutput, PreToolUseHookInput, PreToolUseHookOutput, SessionExtensions, ShownTool } from "../agent/session-config";
import { appEnv } from "../hands/system";
import type { Logger } from "../logger";
import { injectionSignals } from "../perception/injection";
import type { AuditLog } from "../policy/audit";
import type { Settings, SettingsPatch } from "../settings";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import type { ConnectResult, ExtensionsApi, Installed, MarketplaceEntry, ToolInfo } from "../../shared/extensions";
import type { OS } from "../../shared/shortcuts";
import { REFUSED, classify, gateQuestion, wrapResult } from "./gate";
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

/** One session's gate state: taint, the tools refused this turn, and which tools show as pinned. */
interface SessionGate { tainted: boolean; refused: Set<string>; shown: Map<string, boolean>; epoch: number; tools: Map<string, { item: StoredItem; tool: PinnedTool }> }

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

  constructor(private o: ExtensionsDeps) {
    this.store = new ExtensionStore(o.dir);
    this.items = this.store.read();
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
    let dirs: string[];
    try { dirs = fs.readdirSync(cache); } catch { return null; }
    for (const d of dirs) {
      const root = path.join(cache, d);
      try { if (readMarketplace(root).name === name) return root; } catch { /* not this one */ }
    }
    return null;
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

  async install(marketplace: string, name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
    if (!this.allowed()) return { ok: false, why: "Your organisation has turned extensions off." };
    if (typeof marketplace !== "string" || typeof name !== "string" || !marketplace || !name || name.length > 100) return { ok: false, why: "Ember couldn't find that plugin." };
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
      copyPlugin(src, dst);
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
      return { ok: false, why: (err as Error)?.message === "too big" ? "It's too big to install." : (err as Error)?.message === "not connected" ? "Ember isn't connected to Copilot yet." : "Ember couldn't install it." };
    } finally {
      // The runtime's own install is only a download: Ember runs its copy, so the runtime keeps nothing enabled.
      if (viaRuntime) { try { await this.rpc().plugins.uninstall({ name: source }); } catch (err) { this.o.log.warn("extensions.runtime_uninstall_failed", { err }); } }
      this.busy.delete(id);
      this.changed();
    }
  }

  private probe(spec: ServerSpec, cwd: string): Promise<ProbeResult> {
    if (this.o.probe) return this.o.probe(spec, cwd);
    if (spec.type === "stdio") return this.o.launcher ? probeStdio({ ...this.command(spec), cwd }) : Promise.resolve({ ok: false, why: "Ember can't run programs for extensions on this computer yet." });
    if (spec.type === "sse") return Promise.resolve({ ok: false, why: "Ember can't reach this kind of server yet." });
    return probeHttp({ url: spec.url, headers: spec.headers, fetch: this.o.fetch ?? fetch });
  }

  /** How a stdio server runs: "node" is Ember's own Node, everything else as named; the environment is appEnv()'s plus the plugin's own values. */
  private command(spec: Extract<ServerSpec, { type: "stdio" }>): { command: string; args: string[]; env: Record<string, string> } {
    const base = appEnv(this.o.env ?? process.env, { session: false, os: this.o.os }) as Record<string, string>;
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
    item.enabled = on;
    if (on) await this.check(item);
    this.save();
    this.changed();
  }

  async reagree(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (!item || !this.allowed()) return;
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
            try { process.kill(pid, "SIGTERM"); ended++; } catch { /* already gone */ }
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
    const gate: SessionGate = { tainted: false, refused: new Set(), shown: new Map(), epoch: this.epoch, tools: new Map() };
    const mcpServers: Record<string, MCPServerConfig> = {};
    for (const item of this.items) {
      if (!item.enabled || item.consentedAt === null) continue;
      for (const s of item.servers) {
        if (s.status !== "ready" || !s.spec || (s.spec.type === "stdio" && !this.o.launcher)) continue;
        const tools = s.tools.filter(t => !t.changed && /^[A-Za-z0-9_-]{1,64}$/.test(t.name));
        if (!tools.length) continue;
        for (const t of tools) gate.tools.set(`${s.key}-${t.name}`, { item, tool: t });
        mcpServers[s.key] = this.serverConfig(item, s, tools.map(t => t.name));
      }
    }
    if (!gate.tools.size) return undefined;
    return {
      mcpServers,
      tools: [...gate.tools.keys()],
      preToolUse: input => this.decide(gate, input),
      postToolUse: input => this.result(gate, input),
      verify: shown => this.verify(gate, shown),
      newTurn: () => gate.refused.clear(),
    };
  }

  private serverConfig(item: StoredItem, s: StoredServer, tools: string[]): MCPServerConfig {
    const spec = s.spec!;
    if (spec.type !== "stdio") return { type: spec.type, url: spec.url, headers: spec.headers, tools, timeout: 60_000 } as MCPServerConfig;
    const c = this.command(spec);
    const launch = { command: c.command, args: c.args, env: c.env, cwd: this.store.pluginDir(item.id), runDir: this.store.runDir };
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

  private async decide(gate: SessionGate, input: PreToolUseHookInput): Promise<PreToolUseHookOutput> {
    const e = gate.tools.get(input.toolName);
    const current = e ? this.items.find(i => i.id === e.item.id) : undefined;
    const tool = current?.servers.flatMap(s => s.tools).find(t => t.name === e?.tool.name && t.hash === e?.tool.hash);
    const { verdict, reason } = classify({
      allowed: this.active(), stopped: gate.epoch !== this.epoch,
      ...(current ? { item: { enabled: current.enabled, consented: current.consentedAt !== null } } : {}),
      ...(tool ? { tool } : {}),
      shownAsPinned: gate.shown.get(input.toolName) === true,
      tainted: gate.tainted, refused: gate.refused.has(input.toolName),
    });
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
    const question = gateQuestion(e!.item.name, e!.tool.name, input.toolArgs);
    const answer = await confirmer.ask(question, this.stopAsks.signal).catch(() => null);
    const yes = answer === "once" && gate.epoch === this.epoch && this.active();
    // A spoken answer says so, and whether Voice Match verified it (confirm.ts answerVoice).
    const how = confirmer.howAnswered?.(question);
    const channel = how?.via === "voice" ? { via: "voice", verified: how.verified === true } : {};
    try { this.audit({ phase: "answer", ...base, answer: yes ? "allow" : answer === null ? "none" : "deny", ...channel }); } catch { return deny("Ember couldn't record this step, so it didn't take it."); }
    if (yes) return { permissionDecision: "allow" };
    gate.refused.add(input.toolName);
    return deny(REFUSED);
  }

  private async result(gate: SessionGate, input: PostToolUseHookInput): Promise<PostToolUseHookOutput | void> {
    const e = gate.tools.get(input.toolName);
    const text = typeof input.toolResult?.textResultForLlm === "string" ? input.toolResult.textResultForLlm : "";
    const signals = injectionSignals(text);
    if (signals.length) gate.tainted = true;
    try { this.audit({ phase: "result", ext: e?.item.id ?? null, tool: input.toolName, chars: text.length, signals }); } catch (err) { this.o.log.warn("extensions.audit_failed", { err }); }
    // Text only (the conductor is never sent images), wrapped as untrusted.
    // Only Ember's own fields: the server's raw text (contents, its log) never rides along.
    return { modifiedResult: { textResultForLlm: wrapResult(e?.item.name ?? "an extension", e?.tool.name ?? input.toolName, text, signals.length > 0), resultType: input.toolResult?.resultType ?? "success", binaryResultsForLlm: [] } };
  }
}
