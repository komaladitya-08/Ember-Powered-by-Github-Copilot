/**
 * The one decision path of a coding session (app/main/code/pending.ts): which SDK call each kind of answer becomes,
 * built from the request as the runtime sent it, the SDK's own choices for a permission (approve-for-location where the
 * session's location is known), answers a request doesn't take refused, Stop's answers, and a request answered once.
 */

import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { AnswerRefused, COMPLETION_EVENTS, NotOffered, PendingTable, REQUEST_EVENTS, answerCall, codeChoices, codeDecision, stoppedAnswer, type PendingEntry } from "../../app/main/code/pending";
import type { CodeRequestKind } from "../../app/shared/code";

const shell = (over: Record<string, unknown> = {}) => ({ kind: "shell", fullCommandText: "npm test", intention: "run the tests", commands: [{ identifier: "npm test", readOnly: false }],
  possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true, ...over }) as unknown as PermissionRequest;
const entry = (kind: CodeRequestKind, raw: Record<string, unknown>): PendingEntry => ({ view: { sessionId: "s", requestId: "r1", kind, data: raw, openedAt: 0 }, raw: { requestId: "r1", ...raw } });
const CTX = { standing: true, allowAll: true, locationKey: "repo:acme/app" };

describe("a coding session's requests", () => {
  it("are opened and closed by the SDK's own events, one pair for every kind", () => {
    const kinds = ["permission", "user-input", "elicitation", "exit-plan-mode", "auto-mode-switch", "session-limits", "mcp-oauth", "sampling"];
    expect([...new Set(Object.values(REQUEST_EVENTS))].sort()).toEqual([...kinds].sort());
    expect([...new Set(Object.values(COMPLETION_EVENTS))].sort()).toEqual([...kinds].sort());
  });
});

describe("a permission request's choices", () => {
  it("are the SDK's: once, for the session, for this location, and reject last, where the request allows them", () => {
    expect(codeChoices(shell(), { standing: true, locationKey: "k" })).toEqual(["approve-once", "approve-for-session", "approve-for-location", "reject"]);
    expect(codeChoices(shell(), { standing: true })).toEqual(["approve-once", "approve-for-session", "reject"]);
    expect(codeChoices({ kind: "url", url: "https://example.com/x", intention: "" } as unknown as PermissionRequest, { standing: true, locationKey: "k" }))
      .toEqual(["approve-once", "approve-for-session", "approve-permanently", "reject"]);
  });

  it("are only once or reject where the request can't be approved for longer, the organisation allows nothing standing, or its policy holds it (managedApprovalRequired)", () => {
    expect(codeChoices(shell({ canOfferSessionApproval: false }), { standing: true, locationKey: "k" })).toEqual(["approve-once", "reject"]);
    expect(codeChoices(shell(), { standing: false, locationKey: "k" })).toEqual(["approve-once", "reject"]);
    expect(codeChoices(shell({ managedApprovalRequired: true }), { standing: true, locationKey: "k" })).toEqual(["approve-once", "reject"]);
  });

  it("become the runtime's own decisions, built from the request: approve-once on the wire, the location's key, the commands named", () => {
    expect(codeDecision(shell(), { kind: "approve-once" }, { standing: true })).toEqual({ kind: "approve-once" });
    expect(codeDecision(shell(), { kind: "approve-for-location" }, { standing: true, locationKey: "k" }))
      .toEqual({ kind: "approve-for-location", approval: { kind: "commands", commandIdentifiers: ["npm test"] }, locationKey: "k" });
    expect(codeDecision(shell(), { kind: "reject", feedback: "  not yet " }, { standing: true })).toEqual({ kind: "reject", feedback: "not yet" });
    expect(() => codeDecision(shell({ canOfferSessionApproval: false }), { kind: "approve-for-location" }, { standing: true, locationKey: "k" })).toThrow(NotOffered);
  });
});

describe("an answer to a pending request", () => {
  it("to a permission goes by id through handlePendingPermissionRequest, and a choice it doesn't offer is refused", () => {
    expect(answerCall(entry("permission", { permissionRequest: shell() }), { kind: "approve-for-session" }, CTX)).toEqual({ via: "rpc", method: "permissions.handlePendingPermissionRequest",
      params: { requestId: "r1", result: { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ["npm test"] } } } });
    expect(() => answerCall(entry("permission", { permissionRequest: shell() }), { kind: "approve-permanently" }, CTX)).toThrow(NotOffered);
    expect(() => answerCall(entry("permission", { permissionRequest: shell() }), { kind: "approved" }, CTX)).toThrow(AnswerRefused);
  });

  it("to the model's question must be one of its choices, or free text only where it takes free text", () => {
    const q = entry("user-input", { question: "Which?", choices: ["a", "b"], allowFreeform: false });
    expect(answerCall(q, { answer: "b", wasFreeform: false }, CTX)).toEqual({ via: "rpc", method: "ui.handlePendingUserInput", params: { requestId: "r1", response: { answer: "b", wasFreeform: false } } });
    expect(() => answerCall(q, { answer: "c", wasFreeform: false }, CTX)).toThrow(AnswerRefused);
    expect(() => answerCall(q, { answer: "anything", wasFreeform: true }, CTX)).toThrow(AnswerRefused);
    expect(answerCall(entry("user-input", { question: "Name?" }), { answer: "Ana", wasFreeform: true }, CTX).via).toBe("rpc");
  });

  it("to leaving plan mode takes only an action it offered, and approving its own edits only where allow-all is open", () => {
    const plan = entry("exit-plan-mode", { summary: "s", actions: ["interactive", "exit_only"], recommendedAction: "interactive" });
    expect(answerCall(plan, { approved: true, selectedAction: "interactive" }, CTX)).toMatchObject({ method: "ui.handlePendingExitPlanMode", params: { response: { approved: true, selectedAction: "interactive" } } });
    expect(() => answerCall(plan, { approved: true, selectedAction: "autopilot" }, CTX)).toThrow(AnswerRefused);
    expect(() => answerCall(plan, { approved: true, autoApproveEdits: true }, { ...CTX, allowAll: false })).toThrow("Your organisation doesn't let Copilot approve its own edits here.");
  });

  it("to every other kind is the SDK's own shape for it, through its own handler or RPC", () => {
    expect(answerCall(entry("elicitation", { message: "m" }), { action: "accept", content: { x: 1 } }, CTX)).toEqual({ via: "handler", kind: "elicitation", value: { action: "accept", content: { x: 1 } } });
    expect(answerCall(entry("auto-mode-switch", {}), "yes_always", CTX)).toEqual({ via: "rpc", method: "ui.handlePendingAutoModeSwitch", params: { requestId: "r1", response: "yes_always" } });
    expect(answerCall(entry("session-limits", { maxAiCredits: 5, usedAiCredits: 5 }), { action: "add", additionalAiCredits: 2 }, CTX))
      .toEqual({ via: "rpc", method: "ui.handlePendingSessionLimitsExhausted", params: { requestId: "r1", response: { action: "add", additionalAiCredits: 2 } } });
    expect(answerCall(entry("mcp-oauth", { serverName: "x" }), { kind: "cancelled" }, CTX)).toEqual({ via: "handler", kind: "mcp-oauth", value: { kind: "cancelled" } });
    expect(answerCall(entry("sampling", { serverName: "x" }), {}, CTX)).toEqual({ via: "rpc", method: "ui.handlePendingSampling", params: { requestId: "r1" } });
    expect(() => answerCall(entry("auto-mode-switch", {}), "maybe", CTX)).toThrow(AnswerRefused);
    expect(() => answerCall(entry("elicitation", {}), { action: "accept", extra: true }, CTX)).toThrow(AnswerRefused);
  });

  it("is refused whole when it is larger than CODE_LIMITS.params", () => {
    expect(() => answerCall(entry("user-input", { question: "q" }), { answer: "x".repeat(300_000), wasFreeform: true }, CTX)).toThrow(AnswerRefused);
  });
});

describe("Stop's answers", () => {
  it("refuse every kind the SDK has a refusal for, and leave the model's question to the turn's abort", () => {
    expect(stoppedAnswer("permission")).toEqual({ kind: "reject" });
    expect(stoppedAnswer("exit-plan-mode")).toEqual({ approved: false });
    expect(stoppedAnswer("auto-mode-switch")).toBe("no");
    expect(stoppedAnswer("session-limits")).toEqual({ action: "cancel" });
    expect(stoppedAnswer("mcp-oauth")).toEqual({ kind: "cancelled" });
    expect(stoppedAnswer("elicitation")).toEqual({ action: "cancel" });
    expect(stoppedAnswer("user-input")).toBeNull();
    for (const kind of ["exit-plan-mode", "auto-mode-switch", "session-limits", "mcp-oauth", "elicitation", "sampling"] as const) {
      expect(() => answerCall(entry(kind, { actions: [] }), stoppedAnswer(kind), { standing: false, allowAll: false }), kind).not.toThrow();
    }
  });
});

describe("the pending table", () => {
  it("gives a request out once to be answered: a second answer finds nothing", () => {
    const t = new PendingTable();
    t.open(entry("user-input", { question: "q" }));
    expect(t.list().map(r => r.requestId)).toEqual(["r1"]);
    expect(t.take("r1")?.view.kind).toBe("user-input");
    expect(t.take("r1")).toBeUndefined();
    expect(t.size).toBe(0);
  });
});
