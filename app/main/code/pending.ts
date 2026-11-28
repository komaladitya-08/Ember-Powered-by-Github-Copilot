/**
 * The one decision path of a coding session (docs/CODING-APP.md §2 "One decision path"): every request that blocks a
 * session (a permission, the model's question, an elicitation, leaving plan mode, an auto-mode switch, session limits,
 * an MCP sign-in, sampling) is opened from its SDK `*.requested` event, answered once through `respond` with the SDK's
 * own result shape for its kind, and cleared for every window with who answered. Which SDK call each answer becomes is
 * decided here (`answerCall`), from the request as the runtime sent it, never from a window's words alone: a
 * permission's decision is built from the request (chat-permission.ts `runtimeDecision`, plus approve-for-location),
 * a question's answer must be one of its choices unless it takes free text, a plan's selected action one it offered.
 * Pure: no SDK calls, no I/O.
 */

import { z } from "zod";
import type { PermissionRequest } from "@github/copilot-sdk";
import { CODE_LIMITS, type CodeActor, type CodePendingRequest, type CodeRequestKind } from "../../shared/code";
import { CHAT_DECISIONS, CHAT_LIMITS, type ChatDecisionKind } from "../../shared/chat";
import { NotOffered, permissionChoices, runtimeDecision, type PermissionDecision } from "../agent/chat-permission";

/** The SDK event that opens each kind of request. */
export const REQUEST_EVENTS: Readonly<Record<string, CodeRequestKind>> = {
  "permission.requested": "permission",
  "user_input.requested": "user-input",
  "elicitation.requested": "elicitation",
  "exit_plan_mode.requested": "exit-plan-mode",
  "auto_mode_switch.requested": "auto-mode-switch",
  "session_limits_exhausted.requested": "session-limits",
  "mcp.oauth_required": "mcp-oauth",
  "sampling.requested": "sampling",
};

/** The SDK event that says each kind of request is over, however it was answered. */
export const COMPLETION_EVENTS: Readonly<Record<string, CodeRequestKind>> = {
  "permission.completed": "permission",
  "user_input.completed": "user-input",
  "elicitation.completed": "elicitation",
  "exit_plan_mode.completed": "exit-plan-mode",
  "auto_mode_switch.completed": "auto-mode-switch",
  "session_limits_exhausted.completed": "session-limits",
  "mcp.oauth_completed": "mcp-oauth",
  "sampling.completed": "sampling",
};

/** A refusal of an answer: a plain sentence for the person. */
export class AnswerRefused extends Error {}

/** What the permission mapping needs beyond the request. */
export interface CodePermissionContext {
  /** false: only approve-once and reject (the organisation's `allowGrants: false` or `confirmEveryAction`). */
  standing: boolean;
  /** The session's permission location (`permissions.locations.resolve`), when known: approve-for-location needs it. */
  locationKey?: string;
}

/** Whether a request is held to an explicit decision by the organisation's policy. */
const managed = (request: PermissionRequest): boolean => (request as { managedApprovalRequired?: unknown }).managedApprovalRequired === true;

/** The approval for a location the SDK takes for `request`, or null where it has none. */
function locationApproval(request: PermissionRequest): Extract<PermissionDecision, { kind: "approve-for-location" }>["approval"] | null {
  switch (request.kind) {
    case "shell": return request.canOfferSessionApproval && request.commands?.length ? { kind: "commands", commandIdentifiers: request.commands.map(c => c.identifier) } : null;
    case "write": return request.canOfferSessionApproval ? { kind: "write" } : null;
    case "read": return { kind: "read" };
    case "mcp": return { kind: "mcp", serverName: request.serverName, toolName: request.toolName };
    case "memory": return { kind: "memory" };
    case "custom-tool": return { kind: "custom-tool", toolName: request.toolName };
    default: return null;
  }
}

/**
 * The SDK decisions a permission request may be answered with, in the order to show them: the chat path's (always
 * approve-once and reject; a session, read-only or permanent approval where the request allows it), and
 * approve-for-location (this repository or folder, kept by the SDK) where the session's location is known, the
 * request's kind has a location approval and nothing holds it to a decision each time.
 */
export function codeChoices(request: PermissionRequest, ctx: CodePermissionContext): ChatDecisionKind[] {
  const base = permissionChoices(request, { standing: ctx.standing });
  if (!ctx.standing || managed(request) || !ctx.locationKey || !locationApproval(request)) return base;
  const at = base.indexOf("reject");
  return [...base.slice(0, at), "approve-for-location", ...base.slice(at)];
}

/** The runtime result a choice becomes, built from the request; a choice it doesn't offer throws NotOffered. */
export function codeDecision(request: PermissionRequest, choice: { kind: ChatDecisionKind; feedback?: string }, ctx: CodePermissionContext): PermissionDecision {
  if (!codeChoices(request, ctx).includes(choice.kind)) throw new NotOffered();
  if (choice.kind === "approve-for-location") {
    const approval = locationApproval(request);
    if (!approval || !ctx.locationKey) throw new NotOffered();
    return { kind: "approve-for-location", approval, locationKey: ctx.locationKey };
  }
  return runtimeDecision(request, choice, { standing: ctx.standing });
}

const Choice = z.object({ kind: z.enum(CHAT_DECISIONS), feedback: z.string().max(CHAT_LIMITS.feedback).optional() }).strict();
const UserInput = z.object({ answer: z.string().max(CHAT_LIMITS.answer), wasFreeform: z.boolean() }).strict();
const Elicitation = z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string().max(200), z.unknown()).optional() }).strict();
const ExitPlan = z.object({
  approved: z.boolean(),
  selectedAction: z.enum(["exit_only", "interactive", "autopilot", "autopilot_fleet"]).optional(),
  autoApproveEdits: z.boolean().optional(),
  feedback: z.string().max(CHAT_LIMITS.feedback).optional(),
  deferImplementation: z.boolean().optional(),
}).strict();
const AutoSwitch = z.enum(["yes", "yes_always", "no"]);
const Limits = z.object({
  action: z.enum(["add", "set", "unset", "cancel"]),
  additionalAiCredits: z.number().finite().nonnegative().optional(),
  maxAiCredits: z.number().finite().nonnegative().optional(),
}).strict();
const OAuth = z.union([
  z.object({ kind: z.literal("token"), accessToken: z.string().min(1).max(16_384), tokenType: z.string().max(64).optional(), expiresIn: z.number().finite().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
]);
const Sampling = z.object({ response: z.record(z.string().max(200), z.unknown()).optional() }).strict();

/** The SDK call an answer becomes: the session RPC method and its params, or the SDK handler to settle. */
export type AnswerCall =
  | { via: "rpc"; method: "permissions.handlePendingPermissionRequest"; params: { requestId: string; result: PermissionDecision } }
  | { via: "rpc"; method: "ui.handlePendingUserInput"; params: { requestId: string; response: z.infer<typeof UserInput> } }
  | { via: "handler"; kind: "elicitation"; value: z.infer<typeof Elicitation> }
  | { via: "rpc"; method: "ui.handlePendingExitPlanMode"; params: { requestId: string; response: z.infer<typeof ExitPlan> } }
  | { via: "rpc"; method: "ui.handlePendingAutoModeSwitch"; params: { requestId: string; response: z.infer<typeof AutoSwitch> } }
  | { via: "rpc"; method: "ui.handlePendingSessionLimitsExhausted"; params: { requestId: string; response: z.infer<typeof Limits> } }
  | { via: "handler"; kind: "mcp-oauth"; value: z.infer<typeof OAuth> }
  | { via: "rpc"; method: "ui.handlePendingSampling"; params: { requestId: string; response?: Record<string, unknown> } };

/** What an answer may use beyond the request: the permission context, and whether allow-all is open to the session. */
export interface AnswerContext extends CodePermissionContext {
  /** Leaving plan mode may approve edits from then on only where the organisation leaves allow-all open. */
  allowAll: boolean;
}

/** One request as main keeps it: what windows see, and the SDK's own data (unredacted) the answer is built from. */
export interface PendingEntry {
  view: CodePendingRequest;
  raw: Record<string, unknown>;
}

const NOT_ANSWER = "That isn't an answer this request takes.";

/** Checks `payload` against what the request takes, for its kind. */
function parsed<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new AnswerRefused(NOT_ANSWER);
  return r.data;
}

/**
 * The SDK call `payload` becomes for `entry`, checked against what the request offered. Throws AnswerRefused (or
 * NotOffered) with a plain sentence when it isn't an answer the request takes.
 */
export function answerCall(entry: PendingEntry, payload: unknown, ctx: AnswerContext): AnswerCall {
  const requestId = entry.view.requestId;
  const raw = entry.raw;
  if (JSON.stringify(payload ?? null).length > CODE_LIMITS.params) throw new AnswerRefused(NOT_ANSWER);
  switch (entry.view.kind) {
    case "permission": {
      const choice = parsed(Choice, payload);
      const request = raw.permissionRequest as PermissionRequest;
      return { via: "rpc", method: "permissions.handlePendingPermissionRequest", params: { requestId, result: codeDecision(request, choice, ctx) } };
    }
    case "user-input": {
      const answer = parsed(UserInput, payload);
      const choices = Array.isArray(raw.choices) ? raw.choices.filter((c): c is string => typeof c === "string") : [];
      if (answer.wasFreeform ? raw.allowFreeform === false : !choices.includes(answer.answer)) throw new AnswerRefused(NOT_ANSWER);
      return { via: "rpc", method: "ui.handlePendingUserInput", params: { requestId, response: answer } };
    }
    case "elicitation": return { via: "handler", kind: "elicitation", value: parsed(Elicitation, payload) };
    case "exit-plan-mode": {
      const answer = parsed(ExitPlan, payload);
      const actions = Array.isArray(raw.actions) ? raw.actions : [];
      if (answer.selectedAction !== undefined && !actions.includes(answer.selectedAction)) throw new AnswerRefused(NOT_ANSWER);
      if (answer.autoApproveEdits && !ctx.allowAll) throw new AnswerRefused("Your organisation doesn't let Copilot approve its own edits here.");
      return { via: "rpc", method: "ui.handlePendingExitPlanMode", params: { requestId, response: answer } };
    }
    case "auto-mode-switch": return { via: "rpc", method: "ui.handlePendingAutoModeSwitch", params: { requestId, response: parsed(AutoSwitch, payload) } };
    case "session-limits": return { via: "rpc", method: "ui.handlePendingSessionLimitsExhausted", params: { requestId, response: parsed(Limits, payload) } };
    case "mcp-oauth": return { via: "handler", kind: "mcp-oauth", value: parsed(OAuth, payload) };
    case "sampling": {
      const answer = parsed(Sampling, payload);
      return { via: "rpc", method: "ui.handlePendingSampling", params: { requestId, ...(answer.response ? { response: answer.response } : {}) } };
    }
  }
}

/** The answer Stop gives each kind: a refusal where the SDK has one; the model's question is left to the turn's abort. */
export function stoppedAnswer(kind: CodeRequestKind): unknown {
  switch (kind) {
    case "permission": return { kind: "reject" };
    case "elicitation": return { action: "cancel" };
    case "exit-plan-mode": return { approved: false };
    case "auto-mode-switch": return "no";
    case "session-limits": return { action: "cancel" };
    case "mcp-oauth": return { kind: "cancelled" };
    case "sampling": return {};
    case "user-input": return null;
  }
}

/** A change a window is told of: a request opened, or one resolved and by whom. */
export type RequestChange = CodePendingRequest | { resolved: string; sessionId: string; by: CodeActor | "sdk" };

/**
 * The requests a session is waiting on. `take` removes a request as it is answered (so it is answered once: a
 * second answer finds nothing), and `complete` removes one the SDK says is over.
 */
export class PendingTable {
  private readonly entries = new Map<string, PendingEntry>();

  get size(): number { return this.entries.size; }

  open(entry: PendingEntry): void { this.entries.set(entry.view.requestId, entry); }

  get(requestId: string): PendingEntry | undefined { return this.entries.get(requestId); }

  /** Removes and returns the request, for answering it once. */
  take(requestId: string): PendingEntry | undefined {
    const e = this.entries.get(requestId);
    this.entries.delete(requestId);
    return e;
  }

  /** Every request still waiting, in the order they opened. */
  list(): CodePendingRequest[] { return [...this.entries.values()].map(e => e.view); }

  /** Every entry, for Stop. */
  all(): PendingEntry[] { return [...this.entries.values()]; }

  clear(): void { this.entries.clear(); }
}

export { NotOffered };
