/** Actual pinned SDK/policy with real Windows workspace issuers over DLL models. Node execution is simulated, never Windows proof. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsNodeSdkWorker, WINDOWS_SDK_ARGV, WINDOWS_SDK_ORIGINAL } from "../fixtures/windows-node-sdk-worker-fake";
// @ts-expect-error -- deterministic local JavaScript provider, no real account or provider credential
import { startMockLlm } from "../mock-llm/server.mjs";

afterEach(() => {
  for (const name of ["node:module", "node:crypto", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});
const supported = process.platform === "linux" && process.arch === "x64";

it.skipIf(!supported)("uses Node-only SDK tools for failure, file repair and the same approved check passing before genuine review publication", async () => {
  let step = 0;
  const model = await startMockLlm({ delayMs: 0, respond: () => {
    if (++step === 1 || step === 3) return { tool: { name: "run_node", args: { argv: WINDOWS_SDK_ARGV, cwd: "\\work", why: "Verify the copied assertion" } } };
    if (step === 2) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "1 + 1, 3", newText: "1 + 1, 2" } } };
    if (step === 4) return { tool: { name: "finish_coding", args: { success: true, summary: "Repaired the copied assertion and reran its exact check successfully." } } };
    return { text: "Ready for review." };
  } });
  const f = await setupWindowsNodeSdkWorker(model);
  try {
    expect(await f.worker.run(new AbortController().signal)).toEqual({ success: true, summary: "Repaired the copied assertion and reran its exact check successfully." });
    expect(await f.worker.disposed).toBe(true); expect(f.worker.handoffSafe()).toBe(true);
    expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.contexts).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([]);
    expect(f.cards).toHaveLength(2); expect(f.cards.every(card => card.kind === "node" && card.shell === undefined)).toBe(true);
    expect(f.cards.every(card => card.cwd === "\\work")).toBe(true);
    expect(f.cards[0].sha256).toBe(f.cards[1].sha256); expect(f.exits.map(exit => exit.code)).toEqual([17, 0]);
    expect(f.published).toHaveLength(1); expect(f.published[0]).toMatchObject({ status: "done", checks: { ran: 2, passed: 1, failed: 1 } });
    const review = f.published[0].output.review;
    expect(review.textPatch).toContain("1 + 1, 2"); expect(review.current).toEqual(review.baseline);
    expect(f.canonical.nodes.get(f.canonical.location("C:\\project\\test.cjs").toLowerCase())!.bytes.toString()).toBe(WINDOWS_SDK_ORIGINAL);
    expect(model.requests.every((request: { tools: string[] }) => request.tools.includes("run_node") && !request.tools.includes("run_command"))).toBe(true);
    expect(model.requests.every((request: { tools: string[] }) => !request.tools.some(name => ["bash", "task", "create", "edit"].includes(name)))).toBe(true);
    expect(model.requests.every((request: { messages: unknown }) => JSON.stringify(request.messages).includes(f.constraints))).toBe(true);
    expect(JSON.stringify(f.audit)).not.toContain('"argv"');
    expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
    expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
  } finally { try { await f.close(); } finally { await model.close(); } }
}, 60_000);

it.skipIf(!supported)("Stop closes the modeled live root and real SDK before publishing only a stopped private review", async () => {
  const model = await startMockLlm({ delayMs: 0, respond: () => ({ tool: { name: "run_node", args: { argv: WINDOWS_SDK_ARGV, cwd: "\\work", why: "Verify the copied assertion" } } }) });
  const f = await setupWindowsNodeSdkWorker(model); f.control.autoFinish = false;
  try {
    const run = f.worker.run(new AbortController().signal);
    await vi.waitFor(() => expect(f.io.events).toContain("resume"), { timeout: 30_000 }); f.worker.stop();
    expect(await run).toMatchObject({ success: false, stopped: true }); expect(await f.worker.disposed).toBe(true);
    expect(f.published).toHaveLength(1); expect(f.published[0]).toMatchObject({ status: "stopped", checks: { ran: 0, passed: 0, failed: 0 } });
    expect(f.io.events.some(name => name === "TerminateJobObject" || name === "TerminateProcess")).toBe(true);
    expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
    expect(f.nativeStart).not.toHaveBeenCalled(); expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
  } finally { try { await f.close(); } finally { await model.close(); } }
}, 60_000);

it.skipIf(!supported)("retains unknown default-factory startup and refuses publication without ever starting the SDK or a command", async () => {
  const model = await startMockLlm({ delayMs: 0, respond: () => ({ text: "No task may start after unknown resource ownership." }) });
  const f = await setupWindowsNodeSdkWorker(model); f.asset.state.fault = "NtCreateFile";
  try {
    expect(await f.worker.run(new AbortController().signal)).toMatchObject({ success: false });
    expect(await f.worker.disposed).toBe(false); expect(f.worker.handoffSafe()).toBe(false);
    expect(f.published).toEqual([]); expect(f.cards).toEqual([]); expect(f.io.state.creates).toBe(0); expect(model.requests).toEqual([]);
    expect(f.nativeStart).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(f.userData, "coding-controllers"))).toBe(false);
    const count = f.nativeCalls.length; f.asset.state.fault = ""; f.control.current = true;
    expect(f.worker.handoffSafe()).toBe(false); await expect(f.worker.dispose()).rejects.toThrow("could not be verified as closed"); expect(f.nativeCalls).toHaveLength(count);
    expect(f.profileState.freed).toHaveLength(0);
  } finally { try { await expect(f.close()).rejects.toThrow("could not be verified as closed"); expect(fs.existsSync(f.root)).toBe(true); } finally { await model.close(); } }
}, 45_000);
