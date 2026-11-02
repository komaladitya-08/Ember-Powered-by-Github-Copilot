/**
 * Reading plugins and marketplaces the way Copilot and Claude write them (Agent Plugins `plugin.json`, Claude's
 * `.claude-plugin/plugin.json`, `mcp.json`/`.mcp.json`, and `marketplace.json`), for the one part Ember loads: a
 * plugin's MCP servers. Its hooks, agents, skills, rules and extensions are never read for loading: the spike showed
 * a plugin folder passed to Copilot as `pluginDirectories` runs its command hooks inside Ember's hardened session,
 * outside every tool gate (scratchpad extensions_spike.md). Plain Node: fs and zod only.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** A stdio server: a program Ember starts on this computer (through its launcher, launch.ts). */
export interface StdioServer { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
/** A remote server Ember reaches over HTTPS (streamable HTTP or SSE). */
export interface HttpServer { type: "http" | "sse"; url: string; headers: Record<string, string> }
export type ServerSpec = StdioServer | HttpServer;

/** What a plugin says about itself, and the servers Ember can run (or why one can't). */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  publisher?: string;
  servers: { name: string; spec: ServerSpec | null; why?: string }[];
}

const Author = z.union([z.string(), z.object({ name: z.string().max(200).optional() }).passthrough()]).optional();
const Text = z.string().max(4000);
const ServerJson = z.object({
  type: z.string().max(40).optional(),
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(4000)).max(200).optional(),
  env: z.record(z.string().max(200), z.string().max(4000)).optional(),
  url: z.string().max(2000).optional(),
  headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
}).passthrough();
const Servers = z.record(z.string().max(100), ServerJson);
const ManifestJson = z.object({
  name: z.string().min(1).max(100),
  version: z.string().max(100).optional(),
  description: Text.optional(),
  author: Author,
  mcpServers: z.union([Servers, z.string().max(500), z.array(z.string().max(500)).max(20)]).optional(),
}).passthrough();
const McpFile = z.object({ mcpServers: Servers }).passthrough();

/** Where a plugin keeps its manifest (Agent Plugins, Copilot's legacy places, Claude's). */
export const MANIFEST_PLACES = ["plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json", ".plugin/plugin.json"];
/** Where a plugin keeps its MCP servers when the manifest doesn't name them. */
const MCP_PLACES = [".mcp.json", "mcp.json", ".github/plugin/mcp.json"];
/** Where a marketplace keeps its catalogue. */
export const MARKETPLACE_PLACES = [".github/plugin/marketplace.json", ".claude-plugin/marketplace.json", ".plugin/marketplace.json", "marketplace.json"];

/** The plugin root's own name for itself in commands and arguments. */
const ROOT_VARS = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|COPILOT_PLUGIN_ROOT)\}/g;
/** Any other `${VAR}`: a value from the user's environment, which Ember never hands to an extension. */
const OTHER_VAR = /\$\{[^}]*\}/;

/** A file inside `root` (no `..` out of it, no absolute path), or null. */
export function inside(root: string, rel: string): string | null {
  if (path.isAbsolute(rel)) return null;
  const p = path.resolve(root, rel);
  const r = path.resolve(root);
  return p === r || p.startsWith(r + path.sep) ? p : null;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

/** The first of `places` under `root` that exists, or null. */
export function firstFile(root: string, places: string[]): string | null {
  for (const p of places) {
    const f = inside(root, p);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

const authorName = (a: z.infer<typeof Author>): string | undefined => (typeof a === "string" ? a : a?.name)?.slice(0, 200) || undefined;

/**
 * A server Ember can run from its JSON, or why not. `root` replaces the plugin-root variables; any other variable,
 * a non-HTTPS address (loopback aside) or an unknown type is refused.
 */
export function serverSpec(raw: z.infer<typeof ServerJson>, root: string): { spec: ServerSpec | null; why?: string } {
  const sub = (s: string) => s.replace(ROOT_VARS, root);
  const type = (raw.type ?? (raw.url ? "http" : "stdio")).toLowerCase();
  if (type === "stdio" || type === "local") {
    if (!raw.command) return { spec: null, why: "It doesn't say what to run." };
    const command = sub(raw.command);
    const args = (raw.args ?? []).map(sub);
    const env = Object.fromEntries(Object.entries(raw.env ?? {}).map(([k, v]) => [k, sub(v)]));
    if ([command, ...args, ...Object.values(env)].some(s => OTHER_VAR.test(s))) {
      return { spec: null, why: "It needs values from your environment, which Ember never gives an extension." };
    }
    return { spec: { type: "stdio", command, args, env } };
  }
  if (type === "http" || type === "streamable-http" || type === "sse") {
    if (!raw.url) return { spec: null, why: "It doesn't say where it is." };
    let url: URL;
    try { url = new URL(sub(raw.url)); } catch { return { spec: null, why: "Its address isn't a web address." }; }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return { spec: null, why: "It isn't reached over HTTPS." };
    const headers = Object.fromEntries(Object.entries(raw.headers ?? {}).map(([k, v]) => [k, sub(v)]));
    if (Object.values(headers).some(v => OTHER_VAR.test(v))) return { spec: null, why: "It needs a key from your environment, which Ember never gives an extension." };
    return { spec: { type: type === "sse" ? "sse" : "http", url: url.href, headers } };
  }
  return { spec: null, why: "Ember can't run this kind of server." };
}

/** Reads the plugin in `root`: its manifest (any of MANIFEST_PLACES) and its MCP servers. Throws when there is no manifest. */
export function readPlugin(root: string): PluginManifest {
  const file = firstFile(root, MANIFEST_PLACES);
  if (!file) throw new Error("no plugin manifest");
  const m = ManifestJson.parse(readJson(file));
  const servers: Record<string, z.infer<typeof ServerJson>> = {};
  const fromFile = (rel: string) => {
    const f = inside(root, rel);
    if (!f || !fs.existsSync(f)) return;
    Object.assign(servers, McpFile.parse(readJson(f)).mcpServers);
  };
  if (m.mcpServers && typeof m.mcpServers === "object" && !Array.isArray(m.mcpServers)) Object.assign(servers, m.mcpServers);
  else if (typeof m.mcpServers === "string") fromFile(m.mcpServers);
  else if (Array.isArray(m.mcpServers)) m.mcpServers.forEach(fromFile);
  else {
    const f = firstFile(root, MCP_PLACES);
    if (f) Object.assign(servers, McpFile.parse(readJson(f)).mcpServers);
  }
  return {
    name: m.name,
    ...(m.version ? { version: m.version } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(authorName(m.author) ? { publisher: authorName(m.author) } : {}),
    servers: Object.entries(servers).slice(0, 20).map(([name, raw]) => ({ name, ...serverSpec(raw, root) })),
  };
}

const GitHubSource = z.object({ source: z.literal("github"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), path: z.string().max(500).optional(), ref: z.string().max(200).optional(), sha: z.string().regex(/^[0-9a-f]{40}$/).optional() }).passthrough();
const OtherSource = z.object({ source: z.string().max(40) }).passthrough();
const MarketplaceJson = z.object({
  name: z.string().min(1).max(100),
  owner: z.object({ name: z.string().max(200).optional() }).passthrough().optional(),
  metadata: z.object({ pluginRoot: z.string().max(500).optional() }).passthrough().optional(),
  plugins: z.array(z.object({
    name: z.string().min(1).max(100),
    description: Text.optional(),
    version: z.string().max(100).optional(),
    author: Author,
    source: z.union([z.string().max(500), GitHubSource, OtherSource]),
  }).passthrough()).max(2000),
}).passthrough();

/** One plugin a marketplace lists: in the marketplace's own folder (`folder`) or elsewhere (`elsewhere`, shown only). */
export interface ListedPlugin {
  name: string;
  description: string;
  version?: string;
  publisher?: string;
  /** Its folder inside the marketplace, when it is kept there. */
  folder?: string;
  /** Where it is kept instead ("owner/repo" for GitHub, or the source's kind). */
  elsewhere?: string;
}

/** The plugins the marketplace in `root` lists (any of MARKETPLACE_PLACES). Throws when there is no catalogue. */
export function readMarketplace(root: string): { name: string; publisher?: string; plugins: ListedPlugin[] } {
  const file = firstFile(root, MARKETPLACE_PLACES);
  if (!file) throw new Error("no marketplace.json");
  const m = MarketplaceJson.parse(readJson(file));
  const base = m.metadata?.pluginRoot ? inside(root, m.metadata.pluginRoot) ?? root : root;
  const plugins = m.plugins.map((p): ListedPlugin => {
    const out: ListedPlugin = { name: p.name, description: p.description ?? "", ...(p.version ? { version: p.version } : {}), ...(authorName(p.author) ?? m.owner?.name ? { publisher: authorName(p.author) ?? m.owner?.name } : {}) };
    if (typeof p.source === "string") {
      const folder = inside(base, p.source.replace(/^\.\//, "")) ?? inside(root, p.source.replace(/^\.\//, ""));
      if (folder) out.folder = folder;
      else out.elsewhere = "outside the marketplace";
    } else {
      const gh = GitHubSource.safeParse(p.source);
      out.elsewhere = gh.success ? gh.data.repo : p.source.source;
    }
    return out;
  });
  return { name: m.name, ...(m.owner?.name ? { publisher: m.owner.name } : {}), plugins };
}

/**
 * Where a server reaches, in plain words for the consent card: the command it runs (paths in the plugin's folder `root`
 * relative to it), or the address's host.
 */
export function reachOf(spec: ServerSpec, root?: string): string {
  const short = (a: string) => {
    const r = root && (a === root || a.startsWith(root + path.sep)) ? path.relative(root, a) || "." : a;
    return r.length > 60 ? `${r.slice(0, 60)}…` : r;
  };
  if (spec.type === "stdio") return `Runs ${path.basename(spec.command)}${spec.args.length ? ` ${spec.args.map(short).join(" ")}` : ""} on this computer`;
  return `Reaches ${new URL(spec.url).host}`;
}
