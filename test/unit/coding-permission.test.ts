import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";
import type { ModeInForce } from "../../app/shared/approvals";
import type { Question } from "../../app/main/agent/confirm";
import { codingRecommendations, createCodingPermissionHandler, type CodingPermissionOptions } from "../../app/main/agent/coding-permission";

const shell = (command: string, extra: object = {}): PermissionRequest => ({
  kind: "shell", fullCommandText: command, commands: [], possiblePaths: [], possibleUrls: [],
  canOfferSessionApproval: false, hasWriteFileRedirection: false, intention: "Run a command", ...extra,
});
const invocation = { sessionId: "coding" };
function setup(mode: ModeInForce = "interactive") {
  const abort = new AbortController();
  const ask = vi.fn(async (_question: Question, _signal?: AbortSignal) => "allow" as string | null);
  let policy: ReturnType<CodingPermissionOptions["commandPolicy"]> = { state: "on", askEvery: false };
  let currentMode = mode;
  const options: CodingPermissionOptions = { mode: () => currentMode, signal: abort.signal, confirmer: { ask },
    task: { id: "task", title: "Coding", goal: "Fix the project" }, workspace: "/tmp/project", home: "/home/test", os: "linux",
    commandPolicy: () => policy, ember: { paths: ["/home/test/.config/ember"], pids: [], names: /^ember$/ } };
  return { options, ask, abort, policy: (p: typeof policy) => { policy = p; }, mode: (m: ModeInForce) => { currentMode = m; } };
}

describe("native coding permission bridge", () => {
  it("allows ordinary commands and asks before dangerous ones in Interactive", async () => {
    const x = setup(); const handler = createCodingPermissionHandler(x.options);
    expect(await handler(shell("printf hello"), invocation)).toEqual({ kind: "approved" });
    expect(x.ask).not.toHaveBeenCalled();
    expect(await handler(shell("rm -rf old"), invocation)).toEqual({ kind: "approved" });
    expect(x.ask).toHaveBeenCalledOnce();
    expect(x.ask.mock.calls[0][0]).toMatchObject({ task: "task", detail: "rm -rf old", risky: true });
  });

  it("asks when review is absent or negative, and accepts only an explicit positive Assisted verdict", async () => {
    const x = setup("assisted"); const req = shell("rm -rf old");
    expect(await createCodingPermissionHandler(x.options)(req, invocation)).toEqual({ kind: "approved" });
    expect(x.ask).toHaveBeenCalledOnce();
    x.options.recommendation = () => "error";
    await createCodingPermissionHandler(x.options)(req, invocation);
    expect(x.ask).toHaveBeenCalledTimes(2);
    x.options.recommendation = () => "approve";
    await createCodingPermissionHandler(x.options)(req, invocation);
    expect(x.ask).toHaveBeenCalledTimes(2);
  });

  it("correlates the SDK's later judge event to the exact request and call ID", async () => {
    const x = setup("assisted"); const reviews = codingRecommendations(); x.options.recommendation = reviews.recommendation;
    const request = shell("rm -rf old", { toolCallId: "call-1" });
    const event = (req: PermissionRequest, toolCallId: string, managed = false) => ({ type: "permission.requested", data: {
      requestId: "req-1", permissionMode: "assisted", permissionRequest: req,
      promptRequest: { kind: "commands", toolCallId, managedApprovalRequired: managed, assistedApproval: { recommendation: "approve" } },
    } }) as unknown as SessionEvent;
    // SDK invokes the permission callback, then publishes the event before the callback's microtask resumes.
    const pending = createCodingPermissionHandler(x.options)(request, invocation);
    reviews.onEvent(event(request, "call-1"));
    expect(await pending).toEqual({ kind: "approved" }); expect(x.ask).not.toHaveBeenCalled();
    const sameValue = shell("rm -rf old", { toolCallId: "call-1" });
    const second = createCodingPermissionHandler(x.options)(sameValue, invocation);
    reviews.onEvent(event(request, "call-1")); // stale request object, even with same call ID
    await second; expect(x.ask).toHaveBeenCalledOnce();
    const third = createCodingPermissionHandler(x.options)(sameValue, invocation);
    reviews.onEvent(event(sameValue, "other"));
    await third; expect(x.ask).toHaveBeenCalledTimes(2);
    const fourth = createCodingPermissionHandler(x.options)(sameValue, invocation);
    reviews.onEvent(event(sameValue, "call-1", true));
    await fourth; expect(x.ask).toHaveBeenCalledTimes(3);
  });

  it("honours managed approval present on the native prompt even in Autopilot", async () => {
    const x = setup("autopilot"); const reviews = codingRecommendations(); x.options.requiresHuman = reviews.requiresHuman;
    const request = shell("rm -rf old", { toolCallId: "call-1" });
    const pending = createCodingPermissionHandler(x.options)(request, invocation);
    reviews.onEvent(({ type: "permission.requested", data: { requestId: "req", permissionMode: "manual", permissionRequest: request,
      promptRequest: { kind: "commands", toolCallId: "call-1", managedApprovalRequired: true } } }) as unknown as SessionEvent);
    await pending;
    expect(x.ask).toHaveBeenCalledOnce();
  });

  it("honours managed asks, ask-every, off and user denial even in Autopilot", async () => {
    const x = setup("autopilot"); const handler = createCodingPermissionHandler(x.options);
    await handler(shell("rm -rf old"), invocation); expect(x.ask).not.toHaveBeenCalled();
    await handler(shell("printf hello", { managedApprovalRequired: true }), invocation); expect(x.ask).toHaveBeenCalledOnce();
    x.policy({ state: "on", askEvery: true });
    x.ask.mockResolvedValueOnce("no");
    expect(await handler(shell("printf hello"), invocation)).toEqual({ kind: "reject" });
    x.policy({ state: "off", askEvery: false });
    expect(await handler(shell("printf hello"), invocation)).toEqual({ kind: "reject" });
  });

  it("cancels an outstanding approval on Stop and rechecks a disabled command capability", async () => {
    const x = setup(); let done!: (answer: string | null) => void;
    x.ask.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const pending = createCodingPermissionHandler(x.options)(shell("rm -rf old"), invocation);
    x.abort.abort(); done("allow");
    expect(await pending).toEqual({ kind: "user-not-available" });
    const y = setup(); let resolve!: (answer: string | null) => void;
    y.ask.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending2 = createCodingPermissionHandler(y.options)(shell("rm -rf old"), invocation);
    y.policy({ state: "off", askEvery: false }); resolve("allow");
    expect(await pending2).toEqual({ kind: "reject" });
  });

  it("never silently truncates an approval and exposes disguised text", async () => {
    const x = setup("asking"); const handler = createCodingPermissionHandler(x.options);
    expect(await handler(shell("x".repeat(48_001)), invocation)).toEqual({ kind: "reject" });
    await handler(shell("printf x\u202ey"), invocation);
    expect(x.ask.mock.calls[0][0].detail).toContain("RLO");
  });
});
