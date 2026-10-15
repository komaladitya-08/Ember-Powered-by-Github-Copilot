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
    ...(o.hooks ? { hooks: o.hooks } : {}),
    infiniteSessions: { enabled: true },
  } as SessionConfig;
}

export class UngrantedToolsError extends Error {
  constructor(readonly extra: string[]) {
    super(`Copilot session exposes tools Ember did not grant: ${extra.join(", ")}`);
  }
}

/** Throws UngrantedToolsError unless the session's tools are a subset of `granted`. */
export async function verifySessionTools(session: CopilotSession, granted: string[]): Promise<string[]> {
  await session.rpc.tools.initializeAndValidate();
  const meta = await session.rpc.tools.getCurrentMetadata();
  const names = (meta.tools ?? []).map(t => t.name);
  const extra = names.filter(n => !granted.includes(n));
  if (extra.length) throw new UngrantedToolsError(extra);
  return names;
}
