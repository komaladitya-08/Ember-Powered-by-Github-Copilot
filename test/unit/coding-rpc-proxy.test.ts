import { describe, expect, it } from "vitest";
import {
  codingRpcProxyRuntimeArgs, encodeExperimentalCodingRpcProxySpec, EXPERIMENTAL_CODING_RPC_PROXY_FLAG,
  type ExperimentalCodingRpcProxySpec,
} from "../../app/main/agent/coding-rpc-proxy";
import { DEFAULT_CODING_RPC_FRAMING_LIMITS } from "../../app/main/agent/coding-rpc-framing";

function spec(): ExperimentalCodingRpcProxySpec {
  return {
    version: 1, filterPath: "/private/filter", receiptPath: "/private/receipt",
    bwrapArgs: ["--seccomp", "3", "--info-fd", "4", "--unshare-user", "--unshare-pid", "--new-session", "--die-with-parent", "--clearenv", "--", "/runtime/copilot-runtime"],
    limits: { ...DEFAULT_CODING_RPC_FRAMING_LIMITS },
  };
}
const sdkArgs = ["--headless", "--no-auto-update", "--stdio", "--no-auto-login"];

describe("the trusted experimental stdio proxy's launch contract", () => {
  it("serializes a bounded host-created launch vector without evaluating it", () => {
    const original = spec();
    original.bwrapArgs = [...original.bwrapArgs.slice(0, -2), "--setenv", "LITERAL", "$(never-run)`never-run`", ...original.bwrapArgs.slice(-2)];
    const encoded = encodeExperimentalCodingRpcProxySpec(original);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString())).toEqual(original);
    expect(EXPERIMENTAL_CODING_RPC_PROXY_FLAG).toBe("--ember-coding-rpc-proxy");
  });

  it.each([
    { version: 2 }, { filterPath: "relative" }, { receiptPath: "relative" }, { receiptPath: "/private/filter" },
    { filterPath: "/a\0b" }, { filterPath: "/" + "a".repeat(4096) },
    { bwrapArgs: ["--", "/bin/sh"] }, { bwrapArgs: ["--seccomp", "3", "--info-fd", "4", "--", "/runtime/copilot-runtime"] },
    { bwrapArgs: [...spec().bwrapArgs.slice(0, -1), "/bin/bash"] },
    { bwrapArgs: [...spec().bwrapArgs, "--auth-token-env", "SECRET"] },
    { bwrapArgs: ["--seccomp", "5", ...spec().bwrapArgs.slice(2)] },
    { bwrapArgs: [...spec().bwrapArgs.slice(0, -2), "\0", "--", "/runtime/copilot-runtime"] },
    { limits: { ...DEFAULT_CODING_RPC_FRAMING_LIMITS, totalBytes: Infinity } },
    { env: { SECRET: "must-not-enter-spec" } }, { executable: "/bin/sh" },
  ])("refuses malformed or capability-expanding specs without echoing them: %j", patch => {
    expect(() => encodeExperimentalCodingRpcProxySpec({ ...spec(), ...patch } as ExperimentalCodingRpcProxySpec)).toThrow("The coding RPC limits are invalid.");
  });

  it("accepts only the pinned SDK's tokenless stdio flag sequence", () => {
    const actual = codingRpcProxyRuntimeArgs(sdkArgs);
    sdkArgs[0] = "mutated-after-validation";
    expect(actual[0]).toBe("--headless");
    sdkArgs[0] = "--headless";
    expect(codingRpcProxyRuntimeArgs(["--headless", "--no-auto-update", "--log-level", "warning", "--stdio", "--no-auto-login"])).toEqual(
      ["--headless", "--no-auto-update", "--log-level", "warning", "--stdio", "--no-auto-login"],
    );
  });

  it.each([
    [], ["--stdio"], [...sdkArgs, "--remote"], [...sdkArgs, "--auth-token-env", "SECRET"],
    ["--headless", "--no-auto-update", "--log-level", "SECRET", "--stdio", "--no-auto-login"],
    ["--headless", "--no-auto-update", "--log-level", "warning", "--stdio"],
    ["--headless", "--no-auto-update", "--stdio", "--port", "1234", "--no-auto-login"],
    ["--headless", "--no-auto-update", "--stdio", "--auto-login"],
  ].map(args => ({ args })))("refuses arbitrary SDK/launcher flags: $args", ({ args }) => {
    expect(() => codingRpcProxyRuntimeArgs(args)).toThrow("The coding RPC limits are invalid.");
  });
});
