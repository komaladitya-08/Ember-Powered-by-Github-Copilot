/**
 * Customise's readers (docs/CODING-APP.md §4 "Customise"): what each SDK method answers, narrowed into the plain rows its
 * section draws, and the numbers, sizes and times those rows show. The SDK's results reach the window as `unknown`
 * (app/shared/code.ts passes them through as the runtime sent them), and nearly all of its methods are experimental, so
 * every reader is total: a missing or mistyped field is left out, a row without its key is dropped, and nothing throws.
 * The shapes are those of the installed SDK's generated types (node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts).
 * No DOM: test/unit/code-customise.test.ts tests them.
 */
import { arr, bool, num, rec, str, strs, sub } from "./sdk";

// ───── Numbers, sizes and times ─────

/** A token count as a person reads it: "950", "12.5K", "128K", "1M". */
export function tokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) { const k = n / 1_000; return `${k < 100 ? trim(k, 1) : Math.round(k)}K`; }
  const m = n / 1_000_000;
  return `${m < 100 ? trim(m, 1) : Math.round(m)}M`;
}
const trim = (v: number, places: number) => String(Number(v.toFixed(places)));

/** A size in bytes: "512 bytes", "1.5 KB", "3.2 MB", "1.1 GB" (powers of 1024, as file managers show them). */
export function byteSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 bytes";
  if (n < 1024) return `${Math.round(n)} ${Math.round(n) === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? trim(v, 1) : Math.round(v)} ${units[i]}`;
}

/** A billing multiplier: "Included" at 0, else "1×", "0.33×", "10×". */
export function multiplierWords(m: number): string {
  if (!Number.isFinite(m) || m < 0) return "";
  if (m === 0) return "Included";
  return `${trim(m, 2)}×`;
}

/** A share as a whole percentage, kept in 0–100 ("0%" for nothing, never "NaN%"). */
export function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/** An interval in milliseconds as words: "every 30 seconds", "every 5 minutes", "every 2 hours", "every day". */
export function everyWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1_000, "second"]];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) { const n = ms / size; return n === 1 ? `every ${name}` : `every ${n.toLocaleString("en-GB")} ${name}s`; }
  }
  const [size, name] = units.find(([s]) => ms >= s) ?? units[3];
  const n = Math.round(ms / size);
  return n <= 1 ? `every ${name}` : `about every ${n.toLocaleString("en-GB")} ${name}s`;
}

/** A moment as a date and time in the person's own locale (empty for one that can't be read). */
export function whenWords(at: string | number | undefined): string {
  if (at === undefined) return "";
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** An id or a camelCase or kebab name as words with a capital: "networkAccess" is "Network access". */
export function wordsOf(name: string): string {
  const w = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim().toLowerCase();
  return w ? w[0].toUpperCase() + w.slice(1) : name;
}

// ───── Models and providers ─────

export type PolicyState = "enabled" | "disabled" | "unconfigured";
export interface ModelRow {
  id: string; name: string; vendor?: string; context?: number; output?: number; vision?: boolean; thinking?: boolean;
  efforts: string[]; defaultEffort?: string; multiplier?: number; policy?: PolicyState; terms?: string; notices: string[];
  /** The provider's id where the catalog names one (a provider-qualified entry). */
  providerId?: string;
}

/** `models.list`'s models (client or session scope). */
export function modelRows(v: unknown): ModelRow[] {
  const out: ModelRow[] = [];
  for (const m of arr(v, "models")) {
    const id = str(m, "id");
    if (!id) continue;
    const caps = sub(m, "capabilities");
    const limits = sub(caps, "limits"), supports = sub(caps, "supports");
    const policy = str(sub(m, "policy"), "state");
    const notices = [...arr(m, "warningMessages"), ...arr(m, "infoMessages")].map(x => typeof x === "string" ? x : str(x, "message") ?? str(x, "text") ?? "").filter(Boolean);
    const warning = str(sub(m, "warningText"), "text") ?? (typeof rec(m)?.warningText === "string" ? (rec(m)!.warningText as string) : undefined);
    out.push({
      id, name: str(m, "name") ?? id,
      ...(str(m, "vendor") ? { vendor: str(m, "vendor") } : {}),
      ...(num(limits, "max_context_window_tokens") ?? num(limits, "max_prompt_tokens") ? { context: num(limits, "max_context_window_tokens") ?? num(limits, "max_prompt_tokens") } : {}),
      ...(num(limits, "max_output_tokens") !== undefined ? { output: num(limits, "max_output_tokens") } : {}),
      ...(bool(supports, "vision") !== undefined ? { vision: bool(supports, "vision") } : {}),
      ...(bool(supports, "thinking") !== undefined ? { thinking: bool(supports, "thinking") } : {}),
      efforts: strs(m, "supportedReasoningEfforts"),
      ...(str(m, "defaultReasoningEffort") ? { defaultEffort: str(m, "defaultReasoningEffort") } : {}),
      ...(num(sub(m, "billing"), "multiplier") !== undefined ? { multiplier: num(sub(m, "billing"), "multiplier") } : {}),
      ...(policy === "enabled" || policy === "disabled" || policy === "unconfigured" ? { policy } : {}),
      ...(str(sub(m, "policy"), "terms") ? { terms: str(sub(m, "policy"), "terms") } : {}),
      notices: warning ? [warning, ...notices] : notices,
      ...(str(sub(m, "provider"), "id") ?? str(sub(m, "provider"), "providerId") ? { providerId: str(sub(m, "provider"), "id") ?? str(sub(m, "provider"), "providerId") } : {}),
    });
  }
  return out;
}

/** `model.getCurrent`: the session's model and reasoning effort. */
export function currentModel(v: unknown): { modelId?: string; effort?: string; providerId?: string } {
  return {
    ...(str(v, "modelId") ? { modelId: str(v, "modelId") } : {}),
    ...(str(v, "reasoningEffort") ? { effort: str(v, "reasoningEffort") } : {}),
    ...(str(v, "providerId") ? { providerId: str(v, "providerId") } : {}),
  };
}

/** `model.switchTo`'s answer: whether it was put off until the turn ends, and its own words where it gave any. */
export function switchOutcome(v: unknown): { deferred: boolean; modelId?: string; warning?: string } {
  const w = str(v, "warning") ?? strs(v, "deprecationWarnings")[0];
  return { deferred: bool(v, "deferred") === true, ...(str(v, "modelId") ? { modelId: str(v, "modelId") } : {}), ...(w ? { warning: w } : {}) };
}

export interface ProviderRow { adapterId: string; kind: string; name: string; discovery?: string; network?: string; needsInput: boolean; needsTrust: boolean }
/** `providers.getCatalog`'s adapters. */
export function providerRows(v: unknown): ProviderRow[] {
  return arr(v, "providers").flatMap(p => {
    const adapterId = str(p, "adapterId");
    if (!adapterId) return [];
    const auto = sub(p, "automaticDiscovery");
    return [{
      adapterId, kind: str(p, "providerKind") ?? "", name: str(p, "displayName") ?? str(p, "providerKind") ?? adapterId,
      ...(str(auto, "mode") ? { discovery: str(auto, "mode") } : {}), ...(str(auto, "networkScope") ? { network: str(auto, "networkScope") } : {}),
      needsInput: bool(auto, "requiresInput") === true, needsTrust: bool(auto, "requiresTrust") === true,
    }];
  });
}

export interface ProviderInstance { reference: Record<string, unknown>; id: string; name: string; endpoint?: string }
/** `providers.discover`: the outcome's code and the instances it found. */
export function providerInstances(v: unknown): { outcome: string; instances: ProviderInstance[] } {
  const instances = arr(v, "instances").flatMap(i => {
    const reference = sub(i, "reference");
    const id = str(reference, "id");
    if (!reference || !id) return [];
    return [{ reference, id, name: str(i, "displayName") ?? id, ...(str(reference, "managementEndpoint") ? { endpoint: str(reference, "managementEndpoint") } : {}) }];
  });
  return { outcome: str(sub(v, "outcome"), "code") ?? "failed", instances };
}

/** `providers.getStatus`: its open status word ("healthy", "unreachable", "notInstalled") and version. */
export function providerStatus(v: unknown): { status: string; version?: string } {
  return { status: str(v, "status") ?? "unknown", ...(str(v, "version") ? { version: str(v, "version") } : {}) };
}

/** `providers.models.list`: the provider's own models. */
export function providerModels(v: unknown): { id: string; name: string; size?: number }[] {
  return arr(v, "models").flatMap(m => {
    const id = str(m, "id");
    return id ? [{ id, name: str(m, "name") ?? id, ...(num(m, "sizeBytes") !== undefined ? { size: num(m, "sizeBytes") } : {}) }] : [];
  });
}

// ───── MCP servers ─────

export type McpKind = "stdio" | "http" | "sse";
/** A configured server as the page shows it: env and header names only, never their values. */
export interface McpConfigured {
  name: string; kind: McpKind; command?: string; args: string[]; cwd?: string; envNames: string[]; url?: string; headerNames: string[];
  tools?: string[]; source?: string; plugin?: string; warnings: string[];
}

/** `mcp.config.list`: the user's configured servers, keyed by name, with the raw config kept apart for an edit. */
export function mcpConfigured(v: unknown): { rows: McpConfigured[]; raw: Record<string, Record<string, unknown>> } {
  const servers = sub(v, "servers") ?? {};
  const rows: McpConfigured[] = [];
  const raw: Record<string, Record<string, unknown>> = {};
  for (const [name, c] of Object.entries(servers)) {
    const o = rec(c);
    if (!o) continue;
    const type = str(o, "type");
    const url = str(o, "url");
    const kind: McpKind = type === "sse" ? "sse" : type === "http" || (url && !str(o, "command")) ? "http" : "stdio";
    raw[name] = o;
    rows.push({
      name, kind, args: strs(o, "args"), envNames: Object.keys(sub(o, "env") ?? {}).sort(), headerNames: Object.keys(sub(o, "headers") ?? {}).sort(), warnings: strs(o, "configWarnings"),
      ...(str(o, "command") ? { command: str(o, "command") } : {}), ...(str(o, "cwd") ? { cwd: str(o, "cwd") } : {}), ...(url ? { url } : {}),
      ...(Array.isArray(o.tools) ? { tools: strs(o, "tools") } : {}), ...(str(o, "source") ? { source: str(o, "source") } : {}), ...(str(o, "sourcePlugin") ? { plugin: str(o, "sourcePlugin") } : {}),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, raw };
}

/** `mcp.discover`: servers from every source, with whether each is enabled. */
export function mcpDiscovered(v: unknown): { name: string; source: string; enabled: boolean; plugin?: string }[] {
  return arr(v, "servers").flatMap(s => {
    const name = str(s, "name");
    return name ? [{ name, source: str(s, "source") ?? "", enabled: bool(s, "enabled") !== false, ...(str(s, "sourcePlugin") ? { plugin: str(s, "sourcePlugin") } : {}) }] : [];
  });
}

export type McpStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "stopped" | "not_configured" | "unknown";
const MCP_STATUSES = new Set(["connected", "failed", "needs-auth", "pending", "disabled", "stopped", "not_configured"]);
export interface McpLive { name: string; status: McpStatus; source?: string; url?: string; displayName?: string; failed: boolean; plugin?: string }
const statusOf = (s: unknown): McpStatus => (typeof s === "string" && MCP_STATUSES.has(s) ? (s as McpStatus) : "unknown");

/** Session `mcp.list`: each server's status (its error text is kept out: a failure is said in Ember's words). */
export function mcpLive(v: unknown): McpLive[] {
  return arr(v, "servers").flatMap(s => {
    const name = str(s, "name");
    if (!name) return [];
    return [{ name, status: statusOf(rec(s)?.status), failed: !!str(s, "error"), ...(str(s, "source") ? { source: str(s, "source") } : {}), ...(str(s, "url") ? { url: str(s, "url") } : {}), ...(str(s, "displayName") ? { displayName: str(s, "displayName") } : {}), ...(str(s, "sourcePlugin") ? { plugin: str(s, "sourcePlugin") } : {}) }];
  });
}

/** `session.mcp_server_status_changed` applied to the list: the server's new status (a new server is added). */
export function mcpStatusChanged(list: readonly McpLive[], data: unknown): McpLive[] {
  const name = str(data, "serverName");
  if (!name) return list.slice();
  const status = statusOf(rec(data)?.status);
  const failed = !!str(data, "error");
  if (!list.some(s => s.name === name)) return [...list, { name, status, failed }];
  return list.map(s => (s.name === name ? { ...s, status, failed } : s));
}

/** A server's tools, resources or prompts (`mcp.listTools`, `mcp.resources.list`, `mcp.prompts.list`). */
export function mcpItems(v: unknown, kind: "tools" | "resources" | "prompts"): { name: string; title?: string; description?: string; detail?: string }[] {
  return arr(v, kind).flatMap(t => {
    const name = str(t, "name") ?? str(t, "uri");
    if (!name) return [];
    const detail = kind === "resources" ? [str(t, "uri"), str(t, "mimeType")].filter(Boolean).join(" · ") : kind === "prompts" ? arr(t, "arguments").map(a => str(a, "name")).filter(Boolean).join(", ") : "";
    return [{ name, ...(str(t, "title") ? { title: str(t, "title") } : {}), ...(str(t, "description") ? { description: str(t, "description") } : {}), ...(detail ? { detail } : {}) }];
  });
}

/** `mcp.oauth.login`: an https address to open in a browser, or none: connected when no address came (signed in already). */
export function oauthLogin(v: unknown): { url?: string; connected: boolean } {
  const url = str(v, "authorizationUrl");
  return { ...(url && /^https:\/\//i.test(url) ? { url } : {}), connected: !url || str(v, "status") === "connected" };
}

// ───── Skills, plugins, agents, instructions, hooks ─────

export interface SkillRow { name: string; description: string; source: string; enabled: boolean; path?: string; plugin?: string; command?: string; hint?: string; userInvocable: boolean }
/** Session `skills.list` or client `skills.discover`. */
export function skillRows(v: unknown): SkillRow[] {
  return arr(v, "skills").flatMap(s => {
    const name = str(s, "name");
    if (!name) return [];
    return [{
      name, description: str(s, "description") ?? "", source: str(s, "source") ?? "", enabled: bool(s, "enabled") !== false, userInvocable: bool(s, "userInvocable") === true,
      ...(str(s, "path") ? { path: str(s, "path") } : {}), ...(str(s, "pluginName") ? { plugin: str(s, "pluginName") } : {}),
      ...(str(s, "commandName") ? { command: str(s, "commandName") } : {}), ...(str(s, "argumentHint") ? { hint: str(s, "argumentHint") } : {}),
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** `skills.reload` (or `customizations.reload`): how many warnings and errors loading gave. */
export function loadDiagnostics(v: unknown): { warnings: number; errors: number } {
  return { warnings: arr(v, "warnings").length, errors: arr(v, "errors").length };
}

/** `skills.getDiscoveryPaths`, `agents.getDiscoveryPaths`, `instructions.getDiscoveryPaths`: where files go. */
export function discoveryPaths(v: unknown): { path: string; scope: string; preferred: boolean; kind?: string }[] {
  return arr(v, "paths").flatMap(p => {
    const path = str(p, "path");
    return path ? [{ path, scope: str(p, "scope") ?? str(p, "location") ?? "", preferred: bool(p, "preferredForCreation") === true, ...(str(p, "kind") ? { kind: str(p, "kind") } : {}) }] : [];
  });
}

export interface PluginRow { name: string; marketplace: string; version?: string; enabled: boolean; directSourceId?: string; managed: boolean; builtin: boolean; installed: boolean }
/** Client or session `plugins.list`. */
export function pluginRows(v: unknown): PluginRow[] {
  return arr(v, "plugins").flatMap(p => {
    const name = str(p, "name");
    if (!name) return [];
    return [{
      name, marketplace: str(p, "marketplace", true) ?? "", enabled: bool(p, "enabled") !== false, managed: bool(p, "managed") === true,
      builtin: str(p, "source") === "builtin", installed: bool(p, "installed") !== false,
      ...(str(p, "version") ? { version: str(p, "version") } : {}), ...(str(p, "directSourceId") ? { directSourceId: str(p, "directSourceId") } : {}),
    }];
  });
}
/** A plugin's spec as the SDK takes it: "name@marketplace", or the bare name for a direct install. */
export const pluginSpec = (p: { name: string; marketplace: string }): string => (p.marketplace ? `${p.name}@${p.marketplace}` : p.name);

export interface MarketplaceRow { name: string; source: string; isDefault: boolean; managed: boolean; available: boolean }
export function marketplaceRows(v: unknown): MarketplaceRow[] {
  return arr(v, "marketplaces").flatMap(m => {
    const name = str(m, "name");
    return name ? [{ name, source: str(m, "source") ?? "", isDefault: bool(m, "isDefault") === true, managed: bool(m, "managed") === true, available: bool(m, "available") !== false }] : [];
  });
}
/** `plugins.marketplaces.browse`: the plugins a marketplace offers. */
export function marketplacePlugins(v: unknown): { name: string; description?: string }[] {
  return arr(v, "plugins").flatMap(p => { const name = str(p, "name"); return name ? [{ name, ...(str(p, "description") ? { description: str(p, "description") } : {}) }] : []; });
}
/** `plugins.marketplaces.remove`: removed, or held back by the plugins installed from it. */
export function marketplaceRemoved(v: unknown): { removed: boolean; dependents: string[] } {
  return { removed: bool(v, "removed") !== false, dependents: strs(v, "dependentPlugins") };
}
/** `plugins.marketplaces.refresh`: the names that failed. */
export function refreshFailures(v: unknown): string[] {
  return arr(v, "results").filter(r => bool(r, "success") === false).map(r => str(r, "name") ?? "").filter(Boolean);
}
/** `plugins.install`'s answer: its name, how many skills it brought, and whether the SDK calls the way it came deprecated. */
export function pluginInstalled(v: unknown): { name?: string; skills: number; deprecated: boolean } {
  return { ...(str(sub(v, "plugin"), "name") ? { name: str(sub(v, "plugin"), "name") } : {}), skills: num(v, "skillsInstalled") ?? 0, deprecated: !!str(v, "deprecationWarning") };
}
/** `plugins.update`'s answer: the version before and after. */
export function pluginUpdated(v: unknown): { from?: string; to?: string } {
  return { ...(str(v, "previousVersion") ? { from: str(v, "previousVersion") } : {}), ...(str(v, "newVersion") ? { to: str(v, "newVersion") } : {}) };
}

export interface AgentRow { id: string; name: string; displayName: string; description: string; source: string; tools?: string[]; model?: string; path?: string; selectable: boolean }
/** Client `agents.discover`, session `agent.list` and `agent.reload`. */
export function agentRows(v: unknown, key = "agents"): AgentRow[] {
  return arr(v, key).flatMap(a => {
    const name = str(a, "name");
    if (!name) return [];
    const tools = rec(a)?.tools;
    return [{
      id: str(a, "id") ?? name, name, displayName: str(a, "displayName") ?? name, description: str(a, "description") ?? "", source: str(a, "source") ?? "",
      selectable: bool(a, "userInvocable") !== false,
      ...(Array.isArray(tools) ? { tools: strs(a, "tools") } : {}), ...(str(a, "model") ?? strs(a, "models")[0] ? { model: str(a, "model") ?? strs(a, "models")[0] } : {}),
      ...(str(a, "path") ? { path: str(a, "path") } : {}),
    }];
  });
}
/** `agent.getCurrent`: the custom agent in use, or null for the default one. */
export function currentAgent(v: unknown): string | null {
  const a = sub(v, "agent");
  return a ? str(a, "name") ?? str(a, "id") ?? null : null;
}

export interface InstructionRow { id: string; label: string; path: string; type: string; location: string; applyTo: string[]; description?: string; startsOff: boolean; content: string }
/** Client `instructions.discover`, session `instructions.getSources` and `instructions.reload`. */
export function instructionRows(v: unknown): InstructionRow[] {
  return arr(v, "sources").flatMap(s => {
    const id = str(s, "id");
    if (!id) return [];
    return [{
      id, label: str(s, "label") ?? str(s, "sourcePath") ?? id, path: str(s, "sourcePath") ?? "", type: str(s, "type") ?? "", location: str(s, "location") ?? "",
      applyTo: strs(s, "applyTo"), startsOff: bool(s, "defaultDisabled") === true, content: str(s, "content", true) ?? "",
      ...(str(s, "description") ? { description: str(s, "description") } : {}),
    }];
  });
}

export interface HookRow { id: string; event: string; origin: string; source?: string; enabled: boolean }
/** `hooks.discover`: each hook with its event and where it came from, and how many warnings and errors loading gave. */
export function hookRows(v: unknown): { hooks: HookRow[]; warnings: number; errors: number } {
  const hooks = arr(v, "hooks").flatMap(h => {
    const id = str(h, "id");
    if (!id) return [];
    return [{ id, event: str(h, "hookType") ?? "", origin: str(h, "origin") ?? "", enabled: bool(h, "enabled") !== false, ...(str(h, "source") ? { source: str(h, "source") } : {}) }];
  });
  return { hooks, warnings: arr(v, "warnings").length, errors: arr(v, "errors").length };
}

// ───── Permissions and the sandbox ─────

/** `permissions.paths.list`: the session's folder and the others its tools may reach. */
export function allowedPaths(v: unknown): { primary: string; directories: string[]; approved: string[] } {
  const primary = str(v, "primary") ?? "";
  return { primary, directories: strs(v, "directories").filter(d => d !== primary), approved: strs(v, "sessionApprovedPaths") };
}

/** Session `managedSettings.get`: what the organisation manages, and whether "Approve all" is turned off. */
export function managedSession(v: unknown): { approveAllOff: boolean; keys: string[]; managed: boolean; failClosed: boolean; sandboxForced: boolean } {
  const keys = strs(v, "managedKeys");
  const managed = bool(v, "deviceManaged") === true || bool(v, "serverManaged") === true || keys.length > 0;
  return { approveAllOff: bool(v, "bypassPermissionsDisabled") === true, keys, managed, failClosed: bool(v, "failClosed") === true, sandboxForced: bool(v, "sandboxEnabledByUndeterminedPolicy") === true };
}
/** Client `managedSettings.read`: whether the device has managed settings, and whether they could be read. */
export function managedDevice(v: unknown): { present: boolean; unreadable: boolean } {
  const s = rec(v)?.settingsJson;
  return { present: s !== undefined && s !== null, unreadable: !!str(v, "errorMessage") };
}

/** `sandbox.getHostSupport`: whether this computer has a sandbox, and each capability that varies between hosts. */
export function hostSupport(v: unknown): { supported: boolean; reason?: string; capabilities: { name: string; supported: boolean; reason?: string }[] } {
  return {
    supported: bool(v, "supported") === true, ...(str(v, "reason") ? { reason: str(v, "reason") } : {}),
    capabilities: arr(v, "capabilities").flatMap(c => {
      const name = str(c, "name");
      return name ? [{ name, supported: bool(c, "supported") === true, ...(str(c, "reason") ? { reason: str(c, "reason") } : {}) }] : [];
    }),
  };
}
/** `sandbox.getEnforcementStatus`. */
export function enforcement(v: unknown): { required: boolean; blocked: boolean } {
  return { required: bool(v, "required") === true, blocked: bool(v, "blocked") === true };
}

// ───── Schedules and usage ─────

export interface ScheduleRow { id: number; prompt: string; recurring: boolean; every?: number; cron?: string; tz?: string; at?: number; next?: string; selfPaced: boolean }
export function scheduleRows(v: unknown): ScheduleRow[] {
  return arr(v, "entries").flatMap(e => {
    const id = num(e, "id");
    if (id === undefined) return [];
    return [{
      id, prompt: str(e, "displayPrompt") ?? str(e, "prompt") ?? "", recurring: bool(e, "recurring") === true, selfPaced: bool(e, "selfPaced") === true,
      ...(num(e, "intervalMs") !== undefined ? { every: num(e, "intervalMs") } : {}), ...(str(e, "cron") ? { cron: str(e, "cron") } : {}),
      ...(str(e, "tz") ? { tz: str(e, "tz") } : {}), ...(num(e, "at") !== undefined ? { at: num(e, "at") } : {}), ...(str(e, "nextRunAt") ? { next: str(e, "nextRunAt") } : {}),
    }];
  });
}

export interface UsageView {
  premium: number; requests: number; apiMs: number; linesAdded: number; linesRemoved: number; files: number; currentModel?: string;
  models: { id: string; requests: number; cost: number; input: number; output: number; cached: number }[];
}
/** `usage.getMetrics`. */
export function usageView(v: unknown): UsageView {
  const models = Object.entries(sub(v, "modelMetrics") ?? {}).flatMap(([id, m]) => {
    if (!rec(m)) return [];
    const req = sub(m, "requests"), use = sub(m, "usage");
    return [{ id, requests: num(req, "count") ?? 0, cost: num(req, "cost") ?? 0, input: num(use, "inputTokens") ?? 0, output: num(use, "outputTokens") ?? 0, cached: num(use, "cacheReadTokens") ?? 0 }];
  }).sort((a, b) => b.requests - a.requests);
  const changes = sub(v, "codeChanges");
  return {
    premium: num(v, "totalPremiumRequestCost") ?? 0, requests: num(v, "totalUserRequests") ?? 0, apiMs: num(v, "totalApiDurationMs") ?? 0,
    linesAdded: num(changes, "linesAdded") ?? 0, linesRemoved: num(changes, "linesRemoved") ?? 0, files: num(changes, "filesModifiedCount") ?? strs(changes, "filesModified").length,
    ...(str(v, "currentModel") ? { currentModel: str(v, "currentModel") } : {}), models,
  };
}

export interface QuotaRow { type: string; unlimited: boolean; used: number; entitled: number; remaining: number; resets?: string | number; overage: number }
/** Session `quota.get`/`quota.refresh` (`snapshots`) or client `account.getQuota` (`quotaSnapshots`). */
export function quotaRows(v: unknown): { rows: QuotaRow[]; plan?: string } {
  const snaps = sub(v, "snapshots") ?? sub(v, "quotaSnapshots") ?? {};
  const rows = Object.entries(snaps).flatMap(([type, s]) => {
    if (!rec(s)) return [];
    const resets = num(s, "resetDateEpochMs") ?? str(s, "resetDate");
    return [{
      type, unlimited: bool(s, "isUnlimitedEntitlement") === true, used: num(s, "usedRequests") ?? 0, entitled: num(s, "entitlementRequests") ?? 0,
      remaining: Math.max(0, Math.min(100, num(s, "remainingPercentage") ?? 0)), overage: num(s, "overage") ?? 0, ...(resets !== undefined ? { resets } : {}),
    }];
  });
  const plan = str(v, "planTier");
  return { rows, ...(plan && plan !== "unknown" ? { plan } : {}) };
}

export interface ContextView { model: string; total: number; limit: number; system: number; conversation: number; tools: number; mcp: number; compactAt: number }
/** `metadata.contextInfo`: the context window's parts, or null before the session has a context. */
export function contextView(v: unknown): ContextView | null {
  const c = sub(v, "contextInfo");
  if (!c) return null;
  const limit = num(c, "limit") ?? num(c, "promptTokenLimit") ?? 0;
  return {
    model: str(c, "displayModelName") ?? str(c, "modelName") ?? "", total: num(c, "totalTokens") ?? 0, limit,
    system: num(c, "systemTokens") ?? 0, conversation: num(c, "conversationTokens") ?? 0, tools: num(c, "toolDefinitionsTokens") ?? 0, mcp: num(c, "mcpToolsTokens") ?? 0,
    compactAt: num(c, "compactionThreshold") ?? 0,
  };
}
/** `metadata.getContextHeaviestMessages`: the largest messages, with their share of the whole. */
export function heaviest(v: unknown): { label: string; role: string; tokens: number; share: number }[] {
  const total = num(v, "totalTokens") ?? 0;
  return arr(v, "messages").flatMap(m => {
    const tokens = num(m, "tokens");
    return tokens === undefined ? [] : [{ label: str(m, "label") ?? str(m, "role") ?? "", role: str(m, "role") ?? "", tokens, share: percent(tokens, total) }];
  });
}
/** `history.compact`: whether it compacted, and what it freed. */
export function compacted(v: unknown): { ok: boolean; tokens: number; messages: number } {
  return { ok: bool(v, "success") !== false, tokens: num(v, "tokensRemoved") ?? 0, messages: num(v, "messagesRemoved") ?? 0 };
}
