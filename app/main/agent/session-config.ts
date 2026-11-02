/**
 * The one place Copilot sessions are configured. Every Ember session is
 * hardened the same way: no built-in tools (shell, edit, fetch…), no built-in
 * sub-agents, an empty working directory, and only the tools Ember grants.
 * After creation the live tool list is checked and the session is refused
 * (fail closed) if anything else is exposed.
 */

import type { CopilotSession, MCPServerConfig, PermissionHandler, ProviderConfig, SessionConfig, SessionHooks, SystemMessageConfig, Tool } from "@github/copilot-sdk";

// The hook types, as SessionHooks names them (the SDK doesn't export them by name).
export type PreToolUseHookInput = Parameters<NonNullable<SessionHooks["onPreToolUse"]>>[0];
export type PreToolUseHookOutput = Exclude<Awaited<ReturnType<NonNullable<SessionHooks["onPreToolUse"]>>>, void>;
export type PostToolUseHookInput = Parameters<NonNullable<SessionHooks["onPostToolUse"]>>[0];
export type PostToolUseHookOutput = Exclude<Awaited<ReturnType<NonNullable<SessionHooks["onPostToolUse"]>>>, void>;

export const BUILTIN_AGENTS = ["explore", "task", "general-purpose", "code-review", "research", "security-review"];

export interface HardenedOptions {
  sessionId?: string;
  model?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches SessionConfig.tools
  tools: Tool<any>[];
  systemMessage: SystemMessageConfig;
  workingDirectory: string;
  onPermissionRequest: PermissionHandler;
  hooks?: SessionHooks;
  provider?: ProviderConfig;
  /** The extension tools the user agreed to (app/main/extensions/): absent or empty, the session is today's exactly. */
  extensions?: SessionExtensions;
}

/** A tool as the runtime reports it (`session.rpc.tools.getCurrentMetadata()`). */
export interface ShownTool { name: string; mcpServerName?: string; mcpToolName?: string; description?: string; input_schema?: unknown }

/**
 * The extension tools a session may have (ExtensionsService.forSession): MCP servers only, each call decided by
 * Ember's gate. The spike (docs/DEVELOPING.md "Extensions") showed an MCP tool silently replaces an Ember tool of the
 * same name, so a name Ember grants itself, or one without its `<server>-` prefix, is never admitted.
 */
export interface SessionExtensions {
  /** Server key → config; each has an explicit `tools` list of the server's own tool names. */
  mcpServers: Record<string, MCPServerConfig>;
  /** The model-facing names (`<server key>-<tool>`) the user agreed to. */
  tools: string[];
  /** Ember's gate: every call to an admitted extension tool. */
  preToolUse(input: PreToolUseHookInput): Promise<PreToolUseHookOutput>;
  /** The result as the model gets it (wrapped as untrusted, scanned). */
  postToolUse(input: PostToolUseHookInput): Promise<PostToolUseHookOutput | void>;
  /** What the session shows of its extension tools, checked against their pins (verifySessionTools). */
  verify(shown: ShownTool[]): void;
  /** A new request from the user: the tools they refused in the last turn may be asked about again. */
  newTurn?(): void;
}

/** Model-facing tool names: an extension's must carry its server prefix (letters and digits) and a plain tool name. */
const EXT_NAME = /^[a-z0-9]{1,24}-[A-Za-z0-9_-]{1,64}$/;

/** The extension tools a session admits beside Ember's own tools `granted`. */
export function admittedExtensionTools(granted: Iterable<string>, ext: SessionExtensions | undefined): string[] {
  if (!ext) return [];
  const own = new Set(granted);
  return [...new Set(ext.tools)].filter(n => EXT_NAME.test(n) && !own.has(n) && ext.mcpServers[n.slice(0, n.indexOf("-"))] !== undefined);
}

export function hardenedSessionConfig(o: HardenedOptions): SessionConfig {
  // Defence in depth: even if the runtime offered a tool Ember didn't grant, it is refused before it runs.
  const granted = new Set(o.tools.map(t => t.name));
  const ext = o.extensions;
  const admitted = new Set(admittedExtensionTools(granted, ext));
  const onPreToolUse: NonNullable<SessionHooks["onPreToolUse"]> = async (input, invocation) => {
    if (granted.has(input.toolName)) return o.hooks?.onPreToolUse?.(input, invocation);
    // An extension tool: Ember's gate decides (allow, ask the user, or deny), never the SDK.
    if (ext && admitted.has(input.toolName)) return ext.preToolUse(input);
    return { permissionDecision: "deny", permissionDecisionReason: "Ember grants only its own tools." };
  };
  const onPostToolUse: NonNullable<SessionHooks["onPostToolUse"]> = async (input, invocation) => {
    if (ext && admitted.has(input.toolName)) return ext.postToolUse(input);
    return o.hooks?.onPostToolUse?.(input, invocation);
  };
  // Only the admitted tools load from each server, and only servers with one.
  const servers: Record<string, MCPServerConfig> = {};
  if (ext) {
    for (const [key, cfg] of Object.entries(ext.mcpServers)) {
      const tools = (cfg.tools ?? []).filter(t => admitted.has(`${key}-${t}`));
      if (tools.length) servers[key] = { ...cfg, tools };
    }
  }
  const withExt = admitted.size > 0;
  return {
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.provider ? { provider: o.provider } : {}),
    streaming: true,
    tools: o.tools,
    // Never a builtin: only the exact extension tools the user agreed to, by their source-qualified names.
    availableTools: withExt ? [...admitted].map(n => `mcp:${n}`) : [],
    ...(withExt ? { mcpServers: servers } : {}),
    excludedBuiltinAgents: BUILTIN_AGENTS,
    systemMessage: o.systemMessage,
    workingDirectory: o.workingDirectory,
    onPermissionRequest: o.onPermissionRequest,
    hooks: { ...(o.hooks ?? {}), onPreToolUse, ...(withExt ? { onPostToolUse } : {}) },
    infiniteSessions: { enabled: true },
  } as SessionConfig;
}

export class UngrantedToolsError extends Error {
  constructor(readonly extra: string[]) {
    super(`Copilot session exposes tools Ember did not grant: ${extra.join(", ")}`);
  }
}

export class SessionToolsTimeoutError extends Error {
  constructor(ms: number) {
    super(`Copilot didn't report its session tools within ${Math.round(ms / 1000)} s.`);
  }
}

/** `p`, or a SessionToolsTimeoutError if it hasn't settled within `ms` (a hung runtime never answers). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SessionToolsTimeoutError(ms)), ms);
    timer.unref?.();
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), late]);
}

/**
 * Throws unless the session's tools are a subset of `granted` plus the extension tools `ext` admits (and the list
 * could be read at all), or the runtime doesn't answer in time. The extension tools it shows go to `ext.verify`,
 * which turns off any that differ from their pins.
 */
export async function verifySessionTools(session: CopilotSession, granted: string[], timeoutMs = 10_000, ext?: SessionExtensions): Promise<string[]> {
  return withTimeout((async () => {
    await session.rpc.tools.initializeAndValidate();
    const meta = await session.rpc.tools.getCurrentMetadata();
    // No list means it can't be checked: fail closed.
    if (!Array.isArray(meta.tools)) throw new UngrantedToolsError(["(the runtime did not report its tools)"]);
    const admitted = new Set(admittedExtensionTools(granted, ext));
    const names = meta.tools.map(t => t.name);
    // An extension tool counts only as the MCP tool it was admitted as (not an extension.mjs tool of the same name).
    const isAdmitted = (t: ShownTool) => admitted.has(t.name) && !!t.mcpServerName && t.name === `${t.mcpServerName}-${t.mcpToolName}`;
    const extra = meta.tools.filter(t => !granted.includes(t.name) && !isAdmitted(t)).map(t => t.name);
    if (extra.length) throw new UngrantedToolsError(extra);
    if (ext && admitted.size) ext.verify(meta.tools.filter(isAdmitted));
    return names;
  })(), timeoutMs);
}
