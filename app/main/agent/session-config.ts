/**
 * The one place Copilot sessions are configured. Every Ember session is
 * hardened the same way: no built-in tools (shell, edit, fetch…), no built-in
 * sub-agents, an empty working directory, and only the tools Ember grants.
 * After creation the live tool list is checked and the session is refused
 * (fail closed) if anything else is exposed.
 */

import type { CopilotSession, MCPServerConfig, PermissionHandler, ProviderConfig, SessionConfig, SessionHooks, SystemMessageConfig, Tool } from "@github/copilot-sdk";
import { MCP_TOOL_NAME, clashingToolNames, modelToolName } from "../extensions/tool-name";
import type { ReasoningEffort } from "./models";
import { blankedCredentialEnv } from "./credential-env";

// The hook types, as SessionHooks names them (the SDK doesn't export them by name).
export type PreToolUseHookInput = Parameters<NonNullable<SessionHooks["onPreToolUse"]>>[0];
export type PreToolUseHookOutput = Exclude<Awaited<ReturnType<NonNullable<SessionHooks["onPreToolUse"]>>>, void>;
export type PostToolUseHookInput = Parameters<NonNullable<SessionHooks["onPostToolUse"]>>[0];
export type PostToolUseHookOutput = Exclude<Awaited<ReturnType<NonNullable<SessionHooks["onPostToolUse"]>>>, void>;
export type PostToolUseFailureHookInput = Parameters<NonNullable<SessionHooks["onPostToolUseFailure"]>>[0];
export type PostToolUseFailureHookOutput = Exclude<Awaited<ReturnType<NonNullable<SessionHooks["onPostToolUseFailure"]>>>, void>;

export const BUILTIN_AGENTS = ["explore", "task", "general-purpose", "code-review", "research", "security-review"];

export interface HardenedOptions {
  sessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
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
  /**
   * What the session shows of its extension tools, checked against their pins (verifySessionTools). Settles once a
   * tool that differs is out of the session, so the session's first request never carries it.
   */
  verify(shown: ShownTool[]): void | Promise<void>;
  /**
   * A failed call's text (only `additionalContext` can be added: the SDK doesn't let a failure be rewritten, so the raw
   * failure reaches the model and this says it is untrusted data).
   */
  postToolUseFailure?(input: PostToolUseFailureHookInput): Promise<PostToolUseFailureHookOutput | void>;
  /**
   * Gives the gate the session's live tool list (verifySessionTools): a server may change a tool mid-session
   * (notifications/tools/list_changed), so every call is checked against what the model is shown at that moment.
   */
  bind?(shown: () => Promise<ShownTool[]>, stop?: (servers: string[]) => Promise<void>, served?: (server: string) => Promise<unknown>): void;
  /**
   * A server said its tool list changed (`mcp.tools.list_changed`): the gate asks it for its list (`served`, bound
   * above) and compares it with the pins at once, and that server's tools ask from then on in this session.
   */
  listChanged?(serverName: string): void;
  /**
   * Settles once no such comparison is under way (at once when there is none). The session's hooks wait for it, so
   * the runtime builds no request while a server that changed a tool is still in the session.
   */
  settled?(): Promise<void>;
  /** A new request from the user: the tools they refused in the last turn may be asked about again. */
  newTurn?(): void;
}

/** The extension tools a session admits beside Ember's own tools `granted`. */
export function admittedExtensionTools(granted: Iterable<string>, ext: SessionExtensions | undefined): Map<string, { server: string; tool: string }> {
  const admitted = new Map<string, { server: string; tool: string }>();
  if (!ext) return admitted;
  const own = new Set(granted);
  const requested = new Set(ext.tools);
  for (const [server, cfg] of Object.entries(ext.mcpServers)) {
    if (!/^[a-z0-9]{1,24}$/.test(server)) continue;
    const tools = cfg.tools ?? [];
    const clashes = clashingToolNames(server, tools);
    for (const tool of tools) {
      if (!MCP_TOOL_NAME.test(tool)) continue;
      const name = modelToolName(server, tool);
      if (requested.has(name) && !own.has(name) && !clashes.has(name)) admitted.set(name, { server, tool });
    }
  }
  return admitted;
}

export function hardenedSessionConfig(o: HardenedOptions): SessionConfig {
  // Defence in depth: even if the runtime offered a tool Ember didn't grant, it is refused before it runs.
  const granted = new Set(o.tools.map(t => t.name));
  const ext = o.extensions;
  const admitted = admittedExtensionTools(granted, ext);
  const onPreToolUse: NonNullable<SessionHooks["onPreToolUse"]> = async (input, invocation) => {
    if (ext?.settled) await ext.settled();
    if (granted.has(input.toolName)) return o.hooks?.onPreToolUse?.(input, invocation);
    // An extension tool: Ember's gate decides (allow, ask the user, or deny), never the SDK.
    if (ext && admitted.has(input.toolName)) return ext.preToolUse(input);
    return { permissionDecision: "deny", permissionDecisionReason: "Ember grants only its own tools." };
  };
  const onPostToolUse: NonNullable<SessionHooks["onPostToolUse"]> = async (input, invocation) => {
    if (ext?.settled) await ext.settled();
    if (ext && admitted.has(input.toolName)) return ext.postToolUse(input);
    return o.hooks?.onPostToolUse?.(input, invocation);
  };
  const onPostToolUseFailure: NonNullable<SessionHooks["onPostToolUseFailure"]> = async (input, invocation) => {
    if (ext?.settled) await ext.settled();
    if (ext && admitted.has(input.toolName)) return ext.postToolUseFailure?.(input);
    return o.hooks?.onPostToolUseFailure?.(input, invocation);
  };
  // A new request waits too: its first model call would carry a changed tool's text (integrations-r9-1).
  const onUserPromptSubmitted: NonNullable<SessionHooks["onUserPromptSubmitted"]> = async (input, invocation) => {
    if (ext?.settled) await ext.settled();
    return o.hooks?.onUserPromptSubmitted?.(input, invocation);
  };
  // Only the admitted tools load from each server, and only servers with one.
  const servers: Record<string, MCPServerConfig> = {};
  if (ext) {
    for (const [key, cfg] of Object.entries(ext.mcpServers)) {
      const tools = (cfg.tools ?? []).filter(t => {
        const origin = admitted.get(modelToolName(key, t));
        return origin?.server === key && origin.tool === t;
      });
      // The runtime merges `env` over its own environment, which holds the sign-in: blank every credential variable (BE audit #1).
      if (tools.length) servers[key] = { ...cfg, ...(cfg.type === "stdio" || cfg.type === undefined || cfg.type === "local" ? { env: blankedCredentialEnv((cfg as { env?: Record<string, string> }).env) } : {}), tools } as MCPServerConfig;
    }
  }
  const withExt = admitted.size > 0;
  return {
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}),
    ...(o.provider ? { provider: o.provider } : {}),
    streaming: true,
    tools: o.tools,
    enableSessionTelemetry: false,
    enableConfigDiscovery: false,
    // Never a builtin: only the exact extension tools the user agreed to, by their source-qualified names.
    availableTools: [...admitted.keys()].map(n => `mcp:${n}`),
    ...(withExt ? { mcpServers: servers } : {}),
    excludedBuiltinAgents: BUILTIN_AGENTS,
    systemMessage: o.systemMessage,
    workingDirectory: o.workingDirectory,
    onPermissionRequest: o.onPermissionRequest,
    hooks: { ...(o.hooks ?? {}), onPreToolUse, ...(withExt ? { onPostToolUse, onPostToolUseFailure, onUserPromptSubmitted } : {}) },
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
    const own = new Set(granted);
    const admitted = admittedExtensionTools(own, ext);
    const names = meta.tools.map(t => t.name);
    // An extension tool counts only as the MCP tool it was admitted as (not an extension.mjs tool of the same name).
    const isAdmitted = (t: ShownTool) => {
      const origin = admitted.get(t.name);
      return origin !== undefined && t.mcpServerName === origin.server && t.mcpToolName === origin.tool;
    };
    const isOwn = (t: ShownTool) => own.has(t.name) && t.mcpServerName === undefined && t.mcpToolName === undefined;
    const extra = meta.tools.filter(t => !isOwn(t) && !isAdmitted(t)).map(t => t.name);
    if (extra.length) throw new UngrantedToolsError(extra);
    if (ext && admitted.size) {
      // Bound first: the pins' check takes a tool that differs out of this session (it disables its server) before
      // the session is anyone's to ask.
      ext.bind?.(async () => {
        const now = await session.rpc.tools.getCurrentMetadata();
        if (!Array.isArray(now.tools)) throw new Error("the runtime did not report its tools");
        return now.tools.filter(isAdmitted);
      }, async servers => { await Promise.all(servers.map(serverName => session.rpc.mcp.disable({ serverName }))); },
      // The server's own tools/list now, as its running process answers it (name, description, schema and hints).
      serverName => session.rpc.mcp.listTools({ serverName }));
      await ext.verify(meta.tools.filter(isAdmitted));
      if (ext.listChanged && typeof session.on === "function") {
        session.on(e => { if (e.type === "mcp.tools.list_changed") ext.listChanged?.(String((e.data as { serverName?: unknown }).serverName ?? "")); });
      }
    }
    return names;
  })(), timeoutMs);
}
