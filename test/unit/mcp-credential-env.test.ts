// BE audit #1 (P1): every stdio MCP server Ember configures has each credential variable set to "" (the runtime merges
// `env` over its own environment, where COPILOT_SDK_AUTH_TOKEN lives; the real runtime is probed in
// test/integration/runtime-env-live.test.ts). Dummy markers only.
import { describe, it, expect } from "vitest";
import { CREDENTIAL_VARS, blankedCredentialEnv } from "../../app/main/agent/credential-env";
import { hardenedSessionConfig } from "../../app/main/agent/session-config";

describe("credential variables of an MCP server's environment (BE audit #1)", () => {
  it("blanks every named credential variable and keeps the rest", () => {
    const env = blankedCredentialEnv({ PATH: "/bin", GH_TOKEN: "ghp_TESTMARKER_0123456789", github_token: "x", COPILOT_ALT_TOKEN: "y" });
    expect(env.PATH).toBe("/bin");
    for (const k of CREDENTIAL_VARS) expect(env[k], k).toBe("");
    expect(env).toMatchObject({ GH_TOKEN: "", github_token: "", COPILOT_ALT_TOKEN: "" });
    expect(Object.values(env).join("")).toBe("/bin");
  });

  it("names the SDK's own variable and the aliases Ember and the runtime read", () => {
    for (const k of ["COPILOT_SDK_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) expect(CREDENTIAL_VARS).toContain(k);
  });

  it("is applied to every stdio server in a session's config, and leaves a remote server alone", () => {
    const ext = {
      mcpServers: {
        launched: { type: "stdio" as const, command: "node", args: ["l.cjs"], env: { EMBER_MCP_SPEC: "{}", GITHUB_TOKEN: "ghu_TESTMARKER_0123456789" }, tools: ["x"] },
        plain: { command: "node", args: [], tools: ["x"] },
        remote: { type: "http" as const, url: "https://example.invalid/mcp", tools: ["x"] },
      },
      tools: ["launched-x", "plain-x", "remote-x"],
      preToolUse: async () => ({ permissionDecision: "deny" as const }),
      postToolUse: async () => undefined,
      verify: () => undefined,
    };
    const cfg = hardenedSessionConfig({ tools: [], systemMessage: { mode: "replace", content: "t" }, workingDirectory: "/tmp", onPermissionRequest: () => ({ kind: "reject" }) as never, extensions: ext as never });
    const servers = cfg.mcpServers as Record<string, { env?: Record<string, string> }>;
    expect(Object.keys(servers).sort()).toEqual(["launched", "plain", "remote"]);
    for (const k of ["launched", "plain"]) {
      for (const v of CREDENTIAL_VARS) expect(servers[k]!.env![v], `${k}.${v}`).toBe("");
    }
    expect(servers.launched!.env!.EMBER_MCP_SPEC).toBe("{}");
    expect(servers.remote!.env).toBeUndefined();
  });
});
