/**
 * Customise's forms, checked before anything is sent (docs/CODING-APP.md §4 "Customise"): an MCP server's settings, a
 * permission rule in the SDK's syntax, a plugin or marketplace source, a folder. Each check returns the error for each
 * field in Ember's words (copy-customise.ts) and, when there is none, exactly what the SDK method takes.
 *
 * Secrets: an MCP server's environment and header values are write-only. The page never shows one back; an edit sends
 * the value typed, and for a name whose value was left empty, the value the config already holds (`kept`, read from
 * `mcp.config.list` and never drawn). No DOM: test/unit/code-customise.test.ts tests them.
 */
import {
  E_COMMAND, E_DUPLICATE, E_FOLDER, E_HEADER_NAME, E_MARKET_SOURCE, E_NAME_CHARS, E_NAME_EMPTY, E_NAME_TAKEN, E_ONE_LINE, E_PLUGIN_SPEC,
  E_RULE_EMPTY, E_RULE_SHAPE, E_URL, E_URL_PLAIN, E_VALUE_NEEDED, E_VAR_NAME,
} from "./copy-customise";
import type { McpKind } from "./customise-read";

/** One name and value row of the form (a variable or a header). The value is what was typed now, never one kept. */
export interface Pair { name: string; value: string }
export interface McpForm { name: string; kind: McpKind; command: string; args: string; cwd: string; env: Pair[]; url: string; headers: Pair[] }
export type McpField = "name" | "command" | "args" | "cwd" | "url" | `env.${number}.name` | `env.${number}.value` | `header.${number}.name` | `header.${number}.value`;
export interface McpChecked { errors: Partial<Record<McpField, string>>; config?: Record<string, unknown> }

export const EMPTY_MCP_FORM: McpForm = { name: "", kind: "stdio", command: "", args: "", cwd: "", env: [], url: "", headers: [] };

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Arguments as the form takes them: one a line, blank lines left out. */
export function argsFrom(text: string): string[] { return text.split(/\r?\n/).map(a => a.trim()).filter(Boolean); }

/** Whether `p` is a whole path on any of the three systems (main judges it again; this only says what to write). */
export function isWholePath(p: string): boolean { return /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(p.trim()) && !/[\r\n\0]/.test(p); }

/** An address the form takes for a remote server: https, or http only on this computer. */
export function urlError(raw: string): string | null {
  const s = raw.trim();
  let u: URL;
  try { u = new URL(s); } catch { return E_URL; /* not an address at all */ }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:") return LOCAL_HOSTS.has(u.hostname) ? null : E_URL_PLAIN;
  return E_URL;
}

/**
 * Checks the form and builds `mcp.config.add`/`update`'s `config`. `taken` are the names already set up (a new server's
 * may not be one); `editing` is the server being edited, whose `kept` values stand for names left empty.
 */
export function checkMcpForm(f: McpForm, taken: readonly string[], editing: string | null = null, kept: { env?: Readonly<Record<string, unknown>>; headers?: Readonly<Record<string, unknown>> } = {}): McpChecked {
  const errors: McpChecked["errors"] = {};
  const name = f.name.trim();
  if (!name) errors.name = E_NAME_EMPTY;
  else if (!NAME.test(name)) errors.name = E_NAME_CHARS;
  else if (name !== editing && taken.includes(name)) errors.name = E_NAME_TAKEN;
  const pairs = (list: Pair[], kind: "env" | "header", re: RegExp, nameError: string, was: Readonly<Record<string, unknown>> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    list.forEach((p, i) => {
      const n = p.name.trim();
      if (!n && !p.value) return;
      const key = `${kind}.${i}.name` as McpField;
      if (!re.test(n)) { errors[key] = nameError; return; }
      if (seen.has(n)) { errors[key] = E_DUPLICATE; return; }
      seen.add(n);
      if (/[\r\n\0]/.test(p.value)) { errors[`${kind}.${i}.value` as McpField] = E_ONE_LINE; return; }
      const old = was?.[n];
      if (p.value) out[n] = p.value;
      else if (typeof old === "string") out[n] = old;
      else errors[`${kind}.${i}.value` as McpField] = E_VALUE_NEEDED;
    });
    return out;
  };
  let config: Record<string, unknown> | undefined;
  if (f.kind === "stdio") {
    const command = f.command.trim();
    if (!command) errors.command = E_COMMAND;
    else if (/[\r\n\0]/.test(command)) errors.command = E_ONE_LINE;
    if (f.cwd.trim() && !isWholePath(f.cwd)) errors.cwd = E_FOLDER;
    const env = pairs(f.env, "env", VAR, E_VAR_NAME, kept.env);
    config = { type: "stdio", command, args: argsFrom(f.args), ...(Object.keys(env).length ? { env } : {}), ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}) };
  } else {
    const why = urlError(f.url);
    if (why) errors.url = why;
    const headers = pairs(f.headers, "header", HEADER, E_HEADER_NAME, kept.headers);
    config = { type: f.kind, url: f.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
  }
  return Object.keys(errors).length ? { errors } : { errors, config };
}

/** The form for an existing server: names only, every value empty (kept unless a new one is typed). */
export function formFromConfig(name: string, c: Readonly<Record<string, unknown>>): McpForm {
  const names = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).sort().map(n => ({ name: n, value: "" })) : []);
  const type = c.type;
  const kind: McpKind = type === "sse" ? "sse" : type === "http" || (typeof c.url === "string" && typeof c.command !== "string") ? "http" : "stdio";
  return {
    name, kind, command: typeof c.command === "string" ? c.command : "", args: Array.isArray(c.args) ? c.args.filter(a => typeof a === "string").join("\n") : "",
    cwd: typeof c.cwd === "string" ? c.cwd : "", env: names(c.env), url: typeof c.url === "string" ? c.url : "", headers: names(c.headers),
  };
}

/**
 * The config an edit sends: the form's, over the fields of the old config the form doesn't show (tools, timeouts,
 * auth), so editing a command keeps the rest. Variables and headers are the form's whole list: one taken out goes.
 */
export function mergedConfig(old: Readonly<Record<string, unknown>>, next: Record<string, unknown>): Record<string, unknown> {
  const keep = { ...old };
  for (const k of ["type", "command", "args", "cwd", "env", "url", "headers", "configWarnings", "source", "sourcePath", "sourcePlugin", "sourcePluginVersion", "sourcePluginSpec"]) delete keep[k];
  return { ...keep, ...next };
}

// ───── Permission rules ─────

/** A rule as the SDK takes it (`PermissionRule`): a kind, and what it may be given (null for kinds that take nothing). */
export interface Rule { kind: string; argument: string | null }

/**
 * Copilot's own rule kinds, which the runtime matches only as it writes them, in lower case (probed on runtime 1.0.97:
 * `{ kind: "shell", argument: "npm test" }` lets `npm test` run unasked, `{ kind: "Shell", … }` does nothing); a kind
 * written another way is taken as one of these. Any other kind (an MCP server's name) is kept as written.
 */
export const RULE_KINDS: readonly string[] = ["shell", "write", "read", "url", "memory"];

/**
 * "shell(npm test)", "shell(git:*)" (every git command) or "write" as a rule; an error in Ember's words for anything
 * else. A shell rule's argument is the whole command, or a command's first words and ":*" for every command they start.
 */
export function parseRule(text: string): { rule: Rule } | { error: string } {
  const t = text.trim();
  if (!t) return { error: E_RULE_EMPTY };
  const m = /^([A-Za-z][A-Za-z0-9_-]{0,63})(?:\((.*)\))?$/s.exec(t);
  if (!m || /[\r\n\0]/.test(t)) return { error: E_RULE_SHAPE };
  const arg = m[2];
  if (arg !== undefined && (!arg.trim() || arg.length > 1_000)) return { error: E_RULE_SHAPE };
  const known = RULE_KINDS.find(k => k === m[1].toLowerCase());
  return { rule: { kind: known ?? m[1], argument: arg === undefined ? null : arg.trim() } };
}
/** A rule written back as the person writes it. */
export function ruleText(r: Rule): string { return r.argument === null ? r.kind : `${r.kind}(${r.argument})`; }
/** Rules added from this window, kept per session and scope without repeats (Copilot has no method that lists them). */
export function withRule(list: readonly Rule[], r: Rule): Rule[] { return list.some(x => x.kind === r.kind && x.argument === r.argument) ? list.slice() : [...list, r]; }
export function withoutRule(list: readonly Rule[], r: Rule): Rule[] { return list.filter(x => !(x.kind === r.kind && x.argument === r.argument)); }

// ───── Plugins and marketplaces ─────

/** A plugin's install source: "name@marketplace", "owner/repo" or "owner/repo:sub/path", an address, or a whole path. */
export function pluginSourceError(s: string): string | null {
  const t = s.trim();
  if (/^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/.test(t)) return null;
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(:[\w./-]+)?$/.test(t)) return null;
  if (/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(t)) return null;
  if (isWholePath(t)) return null;
  return E_PLUGIN_SPEC;
}
/** A marketplace's source: "owner/repo" (with "#ref"), an https, ssh or scp-style git address, or a whole path. */
export function marketplaceSourceError(s: string): string | null {
  const t = s.trim();
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(#[\w./-]+)?$/.test(t)) return null;
  if (/^(https:\/\/|ssh:\/\/)[^\s]+$/.test(t) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(t)) return null;
  if (isWholePath(t)) return null;
  return E_MARKET_SOURCE;
}
/** A folder the person typed to allow: a whole path. */
export function folderError(s: string): string | null { return isWholePath(s) ? null : E_FOLDER; }
