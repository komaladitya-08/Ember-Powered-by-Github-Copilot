/**
 * The one place Copilot sessions are configured. Every Ember session is
 * hardened the same way: no built-in tools (shell, edit, fetch…), no built-in
 * sub-agents, an empty working directory, and only the tools Ember grants.
 * After creation the live tool list is checked and the session is refused
 * (fail closed) if anything else is exposed.
 */

import type { CopilotSession, PermissionHandler, ProviderConfig, SessionConfig, SessionHooks, SystemMessageConfig, Tool } from "@github/copilot-sdk";

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
}

export function hardenedSessionConfig(o: HardenedOptions): SessionConfig {
  // Defence in depth: even if the runtime offered a tool Ember didn't grant, it is refused before it runs.
  const granted = new Set(o.tools.map(t => t.name));
  const onPreToolUse: NonNullable<SessionHooks["onPreToolUse"]> = async (input, invocation) => {
    if (!granted.has(input.toolName)) return { permissionDecision: "deny", permissionDecisionReason: "Ember grants only its own tools." };
    return o.hooks?.onPreToolUse?.(input, invocation);
  };
  return {
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.provider ? { provider: o.provider } : {}),
    streaming: true,
    tools: o.tools,
    availableTools: [],
    excludedBuiltinAgents: BUILTIN_AGENTS,
    systemMessage: o.systemMessage,
    workingDirectory: o.workingDirectory,
    onPermissionRequest: o.onPermissionRequest,
    hooks: { ...(o.hooks ?? {}), onPreToolUse },
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

/** Throws unless the session's tools are a subset of `granted` (and the list could be read at all), or the runtime doesn't answer in time. */
export async function verifySessionTools(session: CopilotSession, granted: string[], timeoutMs = 10_000): Promise<string[]> {
  return withTimeout((async () => {
    await session.rpc.tools.initializeAndValidate();
    const meta = await session.rpc.tools.getCurrentMetadata();
    // No list means it can't be checked: fail closed.
    if (!Array.isArray(meta.tools)) throw new UngrantedToolsError(["(the runtime did not report its tools)"]);
    const names = meta.tools.map(t => t.name);
    const extra = names.filter(n => !granted.includes(n));
    if (extra.length) throw new UngrantedToolsError(extra);
    return names;
  })(), timeoutMs);
}
