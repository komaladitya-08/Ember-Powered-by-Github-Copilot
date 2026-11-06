/**
 * What Ember hands the Copilot runtime process: its client options, its environment, and the one place a GitHub
 * sign-in may be (BE audit #1). Pure, so the real SDK can be started against a fake runtime in a unit test.
 *
 * The pinned SDK (@github/copilot-sdk 1.0.21) puts `gitHubToken` in the runtime child's environment as
 * COPILOT_SDK_AUTH_TOKEN and names that variable on its command line (`--auth-token-env`; client.js buildRuntimeEnv,
 * startCLIServer). It has no stdin or RPC path for the client's own sign-in, and no option that keeps the runtime's
 * environment from its descendants. So the runtime holds the token, which Ember can't change; what Ember controls is
 * that nothing else reaches it: no other GitHub credential from Ember's own environment (it would also sign the
 * runtime in as someone else, or at all when another model service is in use), and no token in a log or message.
 */

import path from "node:path";
import { redactGitHubTokens } from "./auth";
import { withoutGitHubCredentials } from "./credential-env";
import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";

export { withoutGitHubCredentials };

export { redactGitHubTokens };

export interface RuntimeClientInput {
  userData: string;
  runtimePath: string;
  /** The sign-in to hand over (null: none). */
  token: string | null;
  /** Another model service is in use: no GitHub sign-in goes to the runtime at all. */
  provider: boolean;
  /** The environment to build the runtime's from. */
  env: NodeJS.ProcessEnv;
}

/**
 * The options for the Copilot client. The runtime's environment is `env` without any inherited GitHub credential;
 * the SDK then adds the one sign-in Ember passes as `gitHubToken` (and only when no other model service is in use).
 */
export function runtimeClientOptions(i: RuntimeClientInput): CopilotClientOptions {
  return {
    mode: "empty",
    baseDirectory: path.join(i.userData, "copilot"),
    useLoggedInUser: false,
    ...(i.token && !i.provider ? { gitHubToken: i.token } : {}),
    connection: RuntimeConnection.forStdio({ path: i.runtimePath }),
    logLevel: "warning",
    env: withoutGitHubCredentials(i.env),
  };
}
