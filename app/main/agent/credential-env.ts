/**
 * Which environment variables hold a GitHub, Copilot or model-service credential, and how Ember keeps them out of
 * the MCP servers it configures (BE audit #1). No imports from the SDK, so session-config.ts and the tests load it alone.
 *
 * The Copilot runtime MERGES a stdio MCP server's configured `env` over its own environment, and an explicit empty
 * string clears the variable (observed on the real pinned runtime, offline: test/integration/runtime-env-live.test.ts).
 * So Ember sets every name below to "" in every stdio server it configures, and the runtime's own COPILOT_SDK_AUTH_TOKEN
 * does not reach it. The names are those the pinned SDK (1.0.21) and its runtime read or set; a credential variable of
 * another name is not covered (STATUS.md lists alias completeness as open).
 */

/** Names the runtime reads or sets as a credential, read from the pinned SDK and runtime. */
export const CREDENTIAL_VARS = [
  "COPILOT_SDK_AUTH_TOKEN", "COPILOT_CONNECTION_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN",
] as const;

/** Any variable named like a GitHub or Copilot credential, whichever the alias (compared without regard to case, as Windows does). */
export const CREDENTIAL_NAME = /^((GH|GITHUB|COPILOT)_([A-Z0-9]+_)*TOKEN|GITHUB_PAT|GH_PAT|COPILOT_([A-Z0-9]+_)*API_KEY)$/i;

/** `env` without any credential variable. */
export function withoutGitHubCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CREDENTIAL_NAME.test(k)));
}

/**
 * `env` for an MCP server, with every credential variable set to "" (also any in `env` itself, which the user's
 * extension can't opt back in to: no contract needs it). The runtime merges this over its own environment.
 */
export function blankedCredentialEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = CREDENTIAL_NAME.test(k) ? "" : v;
  for (const k of CREDENTIAL_VARS) out[k] = "";
  return out;
}
