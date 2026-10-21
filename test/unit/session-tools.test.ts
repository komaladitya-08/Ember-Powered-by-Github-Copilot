/** The tools the Copilot runtime reports are checked before Ember trusts a session, and a silent runtime is refused. */

import { describe, expect, it } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { SessionToolsTimeoutError, UngrantedToolsError, verifySessionTools } from "../../app/main/agent/session-config";

function session(metadata: () => Promise<{ tools?: { name: string }[] }>, validate: () => Promise<void> = async () => {}): CopilotSession {
  return {
    rpc: { tools: { initializeAndValidate: validate, getCurrentMetadata: metadata } },
  } as unknown as CopilotSession;
}

describe("verifySessionTools", () => {
  it("accepts only the tools Ember granted and returns their names", async () => {
    const s = session(async () => ({ tools: [{ name: "open_app" }, { name: "click" }] }));
    expect(await verifySessionTools(s, ["open_app", "click", "type_text"])).toEqual(["open_app", "click"]);
  });

  it("refuses a session that exposes a tool Ember didn't grant", async () => {
    const s = session(async () => ({ tools: [{ name: "open_app" }, { name: "shell" }] }));
    await expect(verifySessionTools(s, ["open_app"])).rejects.toBeInstanceOf(UngrantedToolsError);
  });

  it("fails closed when the runtime reports no tool list", async () => {
    const s = session(async () => ({}));
    await expect(verifySessionTools(s, [])).rejects.toBeInstanceOf(UngrantedToolsError);
  });

  it("gives up on a runtime that never answers instead of hanging the start", async () => {
    const s = session(() => new Promise(() => {}));
    const t0 = Date.now();
    await expect(verifySessionTools(s, [], 50)).rejects.toBeInstanceOf(SessionToolsTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
