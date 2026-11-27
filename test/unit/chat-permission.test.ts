/**
 * The one piece of host logic a native chat session adds to the SDK's permission system (chat-permission.ts): what a
 * request shows, which of the SDK's own decisions it offers, and the exact runtime result each choice becomes.
 */

import { describe, expect, it } from "vitest";
import type { PermissionRequest, PermissionRequestedData } from "@github/copilot-sdk";
import { NotOffered, assistedOf, judgeApproves, permissionChoices, permissionRequested, permissionView, runtimeDecision, wireApproval } from "../../app/main/agent/chat-permission";
import { CHAT_LIMITS } from "../../app/shared/chat";

const shell = (o: Partial<Extract<PermissionRequest, { kind: "shell" }>> = {}): PermissionRequest => ({
  kind: "shell", fullCommandText: "git status", intention: "Check the tree", commands: [{ identifier: "git status", readOnly: true }],
  possiblePaths: ["/w/a.txt"], possibleUrls: [{ url: "https://example.com/" }], hasWriteFileRedirection: false, canOfferSessionApproval: true, toolCallId: "call_1", ...o,
} as PermissionRequest);
const write = (o: Record<string, unknown> = {}): PermissionRequest => ({ kind: "write", fileName: "/w/a.txt", diff: "+hello", intention: "Create file", canOfferSessionApproval: true, ...o } as PermissionRequest);
const read: PermissionRequest = { kind: "read", path: "/w/docs/a.txt", intention: "Read file" } as PermissionRequest;
const url: PermissionRequest = { kind: "url", url: "https://docs.example.com/page", intention: "Fetch" } as PermissionRequest;
const mcp: PermissionRequest = { kind: "mcp", serverName: "files", toolName: "list", toolTitle: "List files", readOnly: true, args: { dir: "/w" } } as PermissionRequest;
const memory: PermissionRequest = { kind: "memory", fact: "Uses tabs", subject: "style" } as PermissionRequest;
const custom: PermissionRequest = { kind: "custom-tool", toolName: "probe", toolDescription: "A probe", args: { n: 1 } } as PermissionRequest;
const hook: PermissionRequest = { kind: "hook", toolName: "bash", hookMessage: "Confirm?" } as PermissionRequest;
const other = { kind: "workflow", name: "w" } as unknown as PermissionRequest;
const open = { standing: true };
const held = { standing: false };

describe("a chat permission request's display", () => {
  it("shows a command's text, intention, commands, paths, URLs and warning", () => {
    expect(permissionView(shell({ warning: "Writes outside", hasWriteFileRedirection: true }))).toEqual({
      kind: "shell", command: "git status", intention: "Check the tree", commands: [{ identifier: "git status", readOnly: true }],
      paths: ["/w/a.txt"], urls: ["https://example.com/"], writesFiles: true, warning: "Writes outside",
    });
  });

  it("shows each other kind by its own fields", () => {
    expect(permissionView(write())).toEqual({ kind: "write", file: "/w/a.txt", intention: "Create file", diff: "+hello" });
    expect(permissionView(read)).toEqual({ kind: "read", path: "/w/docs/a.txt", intention: "Read file" });
    expect(permissionView(url)).toEqual({ kind: "url", url: "https://docs.example.com/page", intention: "Fetch" });
    expect(permissionView(mcp)).toEqual({ kind: "mcp", server: "files", tool: "list", title: "List files", readOnly: true, args: '{"dir":"/w"}' });
    expect(permissionView(memory)).toEqual({ kind: "memory", fact: "Uses tabs", subject: "style" });
    expect(permissionView(custom)).toEqual({ kind: "custom-tool", tool: "probe", description: "A probe", args: '{"n":1}' });
    expect(permissionView(hook)).toEqual({ kind: "hook", tool: "bash", message: "Confirm?" });
    expect(permissionView(other)).toEqual({ kind: "other", sdkKind: "workflow" });
  });

  it("cuts a diff longer than the page takes and says so", () => {
    const cut = { truncated: false };
    const view = permissionView(write({ diff: "x".repeat(CHAT_LIMITS.diff + 10) }), cut);
    expect(view.kind === "write" && view.diff.length).toBe(CHAT_LIMITS.diff);
    expect(cut.truncated).toBe(true);
  });
});

describe("the SDK decisions a chat request offers", () => {
  it("offers a session approval for a command or a write only where the request says it can be offered", () => {
    expect(permissionChoices(shell(), open)).toEqual(["approve-once", "approve-for-session", "reject"]);
    expect(permissionChoices(shell({ canOfferSessionApproval: false }), open)).toEqual(["approve-once", "reject"]);
    expect(permissionChoices(shell({ commands: [] }), open)).toEqual(["approve-once", "reject"]);
    expect(permissionChoices(write(), open)).toEqual(["approve-once", "approve-for-session", "reject"]);
    expect(permissionChoices(write({ canOfferSessionApproval: false }), open)).toEqual(["approve-once", "reject"]);
  });

  it("offers a read its folder for the session, a URL its domain for the session or for good, and MCP, memory and custom tools for the session", () => {
    expect(permissionChoices(read, open)).toEqual(["approve-once", "approve-read-only-for-session", "reject"]);
    expect(permissionChoices(url, open)).toEqual(["approve-once", "approve-for-session", "approve-permanently", "reject"]);
    for (const r of [mcp, memory, custom]) expect(permissionChoices(r, open)).toEqual(["approve-once", "approve-for-session", "reject"]);
    for (const r of [hook, other]) expect(permissionChoices(r, open)).toEqual(["approve-once", "reject"]);
  });

  it("offers only approve-once and reject where managed policy requires an explicit decision or the organisation allows nothing standing", () => {
    for (const r of [shell(), write(), read, url, mcp, memory, custom]) {
      expect(permissionChoices(r, held)).toEqual(["approve-once", "reject"]);
      expect(permissionChoices({ ...r, managedApprovalRequired: true } as PermissionRequest, open)).toEqual(["approve-once", "reject"]);
    }
  });
});

describe("a person's choice as the runtime takes it", () => {
  it("is the runtime's approve-once for built-in tools and the SDK's approved for a custom tool, in one place (the shim)", () => {
    expect(runtimeDecision(shell(), { kind: "approve-once" }, open)).toEqual({ kind: "approve-once" });
    expect(runtimeDecision(custom, { kind: "approve-once" }, open)).toEqual({ kind: "approved" });
    expect(wireApproval({ kind: "write" })).toEqual({ kind: "approve-once" });
  });

  it("builds a session approval from the request itself", () => {
    expect(runtimeDecision(shell(), { kind: "approve-for-session" }, open)).toEqual({ kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ["git status"] } });
    expect(runtimeDecision(write(), { kind: "approve-for-session" }, open)).toEqual({ kind: "approve-for-session", approval: { kind: "write" } });
    expect(runtimeDecision(mcp, { kind: "approve-for-session" }, open)).toEqual({ kind: "approve-for-session", approval: { kind: "mcp", serverName: "files", toolName: "list" } });
    expect(runtimeDecision(memory, { kind: "approve-for-session" }, open)).toEqual({ kind: "approve-for-session", approval: { kind: "memory" } });
    expect(runtimeDecision(custom, { kind: "approve-for-session" }, open)).toEqual({ kind: "approve-for-session", approval: { kind: "custom-tool", toolName: "probe" } });
    expect(runtimeDecision(url, { kind: "approve-for-session" }, open)).toEqual({ kind: "approve-for-session", domain: "docs.example.com" });
    expect(runtimeDecision(url, { kind: "approve-permanently" }, open)).toEqual({ kind: "approve-permanently", domain: "docs.example.com" });
    expect(runtimeDecision(read, { kind: "approve-read-only-for-session" }, open)).toEqual({ kind: "approve-read-only-for-session", directories: ["/w/docs"] });
  });

  it("passes a rejection's words on, trimmed and capped, and none when there are none", () => {
    expect(runtimeDecision(shell(), { kind: "reject", feedback: "  not that  " }, open)).toEqual({ kind: "reject", feedback: "not that" });
    expect(runtimeDecision(shell(), { kind: "reject", feedback: "   " }, open)).toEqual({ kind: "reject" });
    const long = runtimeDecision(shell(), { kind: "reject", feedback: "x".repeat(5000) }, open);
    expect(long.kind === "reject" && long.feedback?.length).toBe(CHAT_LIMITS.feedback);
  });

  it("refuses a choice the request doesn't offer, sending nothing", () => {
    expect(() => runtimeDecision(shell({ canOfferSessionApproval: false }), { kind: "approve-for-session" }, open)).toThrow(NotOffered);
    expect(() => runtimeDecision(shell(), { kind: "approve-permanently" }, open)).toThrow(NotOffered);
    expect(() => runtimeDecision(shell(), { kind: "approve-for-session" }, held)).toThrow(NotOffered);
    expect(() => runtimeDecision({ ...url, managedApprovalRequired: true } as PermissionRequest, { kind: "approve-permanently" }, open)).toThrow(NotOffered);
    expect(() => runtimeDecision(shell(), { kind: "approve-for-location" }, open)).toThrow(NotOffered);
  });
});

describe("the SDK's assisted-approval judge", () => {
  const data = (assisted: unknown, request: PermissionRequest = shell()) => ({ requestId: "r1", permissionRequest: request, promptRequest: { kind: "commands", assistedApproval: assisted } }) as unknown as PermissionRequestedData;

  it("is read from the prompt request, or from a memory request's own", () => {
    expect(assistedOf(data({ recommendation: "approve", reason: "Read-only", model: "judge-1" }))).toEqual({ recommendation: "approve", reason: "Read-only", model: "judge-1" });
    expect(assistedOf({ requestId: "r", permissionRequest: { ...memory, assistedApproval: { recommendation: "requireApproval" } } as PermissionRequest } as PermissionRequestedData)).toEqual({ recommendation: "requireApproval" });
    expect(assistedOf(data(undefined))).toBeUndefined();
    expect(assistedOf(data({ recommendation: "maybe" }))).toBeUndefined();
  });

  it("approves only on its own approve, never for a request managed policy holds to an explicit decision", () => {
    expect(judgeApproves(data({ recommendation: "approve" }))).toBe(true);
    for (const recommendation of ["requireApproval", "excluded", "error"]) expect(judgeApproves(data({ recommendation }))).toBe(false);
    expect(judgeApproves(data({ recommendation: "approve" }, shell({ managedApprovalRequired: true })))).toBe(false);
  });

  it("is passed to Home with the request, its choices and whether anything was cut", () => {
    const event = permissionRequested("ember-chat-1", { ...data({ recommendation: "requireApproval", reason: "Writes" }), permissionRequest: shell({ requestSandboxBypass: true, requestSandboxBypassReason: "needs net" }) } as PermissionRequestedData, open);
    expect(event).toMatchObject({ session: "ember-chat-1", type: "permission-requested", requestId: "r1", toolCallId: "call_1", managed: false, sandboxBypass: "needs net",
      choices: ["approve-once", "approve-for-session", "reject"], assisted: { recommendation: "requireApproval", reason: "Writes" }, truncated: false });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
