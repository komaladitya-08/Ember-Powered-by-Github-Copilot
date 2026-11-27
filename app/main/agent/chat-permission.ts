/**
 * The one piece of host logic the Copilot SDK leaves to the host in a native chat session: what a permission request
 * shows a person, which of the SDK's own decisions it may be answered with, and the exact runtime result a person's
 * choice becomes. Nothing here decides for anyone (owner decision: "GitHub Copilot SDK first"): a request waits for
 * the person, except where the SDK itself decided (allow-all and its rules never raise one, and `resolvedByHook` is
 * the SDK's) and where the SDK's assisted-approval judge recommends approving it, which is approved once and marked
 * as the judge's. Ember's classifier, PolicyEngine and Confirmer are not in this path. Pure: no SDK calls, no I/O.
 */

import type { CopilotSession, PermissionDecisionContext, PermissionRequest, PermissionRequestedData } from "@github/copilot-sdk";
import { CHAT_LIMITS, type ChatAssisted, type ChatDecision, type ChatDecisionKind, type ChatPermissionRequested, type ChatPermissionView } from "../../shared/chat";

/** A decision as the runtime takes it (`session.rpc.permissions.handlePendingPermissionRequest`'s `result`). */
export type PermissionDecision = Parameters<CopilotSession["rpc"]["permissions"]["handlePendingPermissionRequest"]>[0]["result"];

/** What a mapping needs beyond the request: whether the organisation lets people approve for longer than once. */
export interface ChatPermissionContext {
  /** false: only approve-once and reject (the admin's `allowGrants: false` or `confirmEveryAction`). */
  standing: boolean;
}

/** Text cut to `max` characters, noting that it was cut. */
function capped(text: unknown, max: number, cut: { truncated: boolean }): string {
  const s = typeof text === "string" ? text : text === undefined || text === null ? "" : JSON.stringify(text) ?? "";
  if (s.length <= max) return s;
  cut.truncated = true;
  return s.slice(0, max);
}

/** The folder a path is in, by either separator (OS-neutral: the runtime's own paths). */
function folderOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return null;
  return i === 0 ? p.slice(0, 1) : p.slice(0, i);
}

/** A URL's host, or null when it has none. */
function hostOf(url: string): string | null {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** The display fields of `request`, by the SDK's kind, with every text capped. */
export function permissionView(request: PermissionRequest, cut: { truncated: boolean } = { truncated: false }): ChatPermissionView {
  const t = (v: unknown, max: number = CHAT_LIMITS.text) => capped(v, max, cut);
  switch (request.kind) {
    case "shell":
      return {
        kind: "shell", command: t(request.fullCommandText), intention: t(request.intention),
        commands: (request.commands ?? []).slice(0, 50).map(c => ({ identifier: t(c.identifier), readOnly: c.readOnly === true })),
        paths: (request.possiblePaths ?? []).slice(0, 50).map(p => t(p)), urls: (request.possibleUrls ?? []).slice(0, 50).map(u => t(u.url)),
        writesFiles: request.hasWriteFileRedirection === true, ...(request.warning ? { warning: t(request.warning) } : {}),
      };
    case "write": return { kind: "write", file: t(request.fileName), intention: t(request.intention), diff: t(request.diff, CHAT_LIMITS.diff) };
    case "read": return { kind: "read", path: t(request.path), intention: t(request.intention) };
    case "url": return { kind: "url", url: t(request.url), intention: t(request.intention) };
    case "mcp":
      return { kind: "mcp", server: t(request.serverName), tool: t(request.toolName), title: t(request.toolTitle), readOnly: request.readOnly === true,
        ...(request.args !== undefined ? { args: t(request.args) } : {}) };
    case "memory":
      return { kind: "memory", fact: t(request.fact), ...(request.subject ? { subject: t(request.subject) } : {}), ...(request.action ? { action: t(request.action) } : {}) };
    case "custom-tool":
      return { kind: "custom-tool", tool: t(request.toolName), description: t(request.toolDescription), ...(request.args !== undefined ? { args: t(request.args) } : {}) };
    case "hook": return { kind: "hook", tool: t(request.toolName), ...(request.hookMessage ? { message: t(request.hookMessage) } : {}) };
    default: return { kind: "other", sdkKind: t((request as { kind?: unknown }).kind ?? "unknown", 64) };
  }
}

/** Does managed policy (the organisation's) require an explicit decision for this request? */
export function managedApproval(request: PermissionRequest): boolean {
  return (request as { managedApprovalRequired?: unknown }).managedApprovalRequired === true;
}

/**
 * The SDK decisions `request` may be answered with: always approve-once and reject; then, unless managed policy
 * requires an explicit decision or the organisation allows nothing standing, what the SDK offers for that kind (a
 * session approval only where the request says it can be offered, `canOfferSessionApproval`, for a command or a
 * write; for a read, read-only access to its folder for the session; for a URL, its domain for the session or for
 * good; for MCP, memory and a custom tool, that server's tool, memory or that tool for the session).
 */
export function permissionChoices(request: PermissionRequest, ctx: ChatPermissionContext): ChatDecisionKind[] {
  const once: ChatDecisionKind[] = ["approve-once", "reject"];
  if (!ctx.standing || managedApproval(request)) return once;
  switch (request.kind) {
    case "shell": return request.canOfferSessionApproval && request.commands?.length ? ["approve-once", "approve-for-session", "reject"] : once;
    case "write": return request.canOfferSessionApproval ? ["approve-once", "approve-for-session", "reject"] : once;
    case "read": return folderOf(request.path) ? ["approve-once", "approve-read-only-for-session", "reject"] : once;
    case "url": return hostOf(request.url) ? ["approve-once", "approve-for-session", "approve-permanently", "reject"] : once;
    case "mcp": case "memory": case "custom-tool": return ["approve-once", "approve-for-session", "reject"];
    default: return once;
  }
}

/** The assisted-approval judge's note on a request, from the event (where the SDK attaches it). */
export function assistedOf(data: Pick<PermissionRequestedData, "permissionRequest"> & { promptRequest?: unknown }): ChatAssisted | undefined {
  const fromPrompt = (data.promptRequest as { assistedApproval?: unknown } | undefined)?.assistedApproval;
  const fromRequest = (data.permissionRequest as { assistedApproval?: unknown }).assistedApproval;
  const a = (fromPrompt ?? fromRequest) as { recommendation?: unknown; reason?: unknown; model?: unknown } | undefined;
  if (!a || typeof a !== "object") return undefined;
  const rec = a.recommendation;
  if (rec !== "approve" && rec !== "requireApproval" && rec !== "excluded" && rec !== "error") return undefined;
  const cut = { truncated: false };
  return { recommendation: rec, ...(typeof a.reason === "string" ? { reason: capped(a.reason, CHAT_LIMITS.text, cut) } : {}),
    ...(typeof a.model === "string" ? { model: capped(a.model, 200, cut) } : {}) };
}

/**
 * Does the SDK's judge say this request is acceptable? Only its "approve", and never for a request managed policy
 * holds to an explicit decision (the SDK says hosts must present their confirmation there).
 */
export function judgeApproves(data: Pick<PermissionRequestedData, "permissionRequest"> & { promptRequest?: unknown }): boolean {
  return assistedOf(data)?.recommendation === "approve" && !managedApproval(data.permissionRequest);
}

/** The event Home is sent for a request waiting for a person. */
export function permissionRequested(session: string, data: PermissionRequestedData & { promptRequest?: unknown }, ctx: ChatPermissionContext): ChatPermissionRequested {
  const cut = { truncated: false };
  const request = permissionView(data.permissionRequest, cut);
  const r = data.permissionRequest as { toolCallId?: unknown; requestSandboxBypass?: unknown; requestSandboxBypassReason?: unknown };
  const assisted = assistedOf(data);
  return {
    session, type: "permission-requested", requestId: data.requestId, ...(typeof r.toolCallId === "string" ? { toolCallId: r.toolCallId } : {}),
    request, managed: managedApproval(data.permissionRequest),
    ...(r.requestSandboxBypass === true ? { sandboxBypass: capped(r.requestSandboxBypassReason ?? "", CHAT_LIMITS.text, cut) } : {}),
    choices: permissionChoices(data.permissionRequest, ctx), ...(assisted ? { assisted } : {}), truncated: cut.truncated,
  };
}

/** Thrown when a decision isn't one this request offers: nothing is sent to the runtime. */
export class NotOffered extends Error {
  constructor() { super("That choice isn't offered for this request."); }
}

/**
 * The exact runtime result a person's choice becomes, built from the request itself (never from the page): the
 * session approval's command identifiers or kind, the read's folder, the URL's domain. A choice the request doesn't
 * offer throws NotOffered. This is the one place the SDK's typed `approved` becomes the runtime's `approve-once`: the
 * runtime's built-in tools take `approve-once` (runtime 1.0.97), custom tools the SDK's documented `approved`.
 */
export function runtimeDecision(request: PermissionRequest, decision: ChatDecision, ctx: ChatPermissionContext): PermissionDecision {
  if (!permissionChoices(request, ctx).includes(decision.kind)) throw new NotOffered();
  switch (decision.kind) {
    case "approve-once": return wireApproval(request);
    case "reject": {
      const feedback = typeof decision.feedback === "string" ? decision.feedback.trim().slice(0, CHAT_LIMITS.feedback) : "";
      return feedback ? { kind: "reject", feedback } : { kind: "reject" };
    }
    case "approve-read-only-for-session": {
      const folder = request.kind === "read" ? folderOf(request.path) : null;
      if (!folder) throw new NotOffered();
      return { kind: "approve-read-only-for-session", directories: [folder] };
    }
    case "approve-permanently": {
      const domain = request.kind === "url" ? hostOf(request.url) : null;
      if (!domain) throw new NotOffered();
      return { kind: "approve-permanently", domain };
    }
    case "approve-for-session":
      switch (request.kind) {
        case "shell": return { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: request.commands.map(c => c.identifier) } };
        case "write": return { kind: "approve-for-session", approval: { kind: "write" } };
        case "mcp": return { kind: "approve-for-session", approval: { kind: "mcp", serverName: request.serverName, toolName: request.toolName } };
        case "memory": return { kind: "approve-for-session", approval: { kind: "memory" } };
        case "custom-tool": return { kind: "approve-for-session", approval: { kind: "custom-tool", toolName: request.toolName } };
        case "url": {
          const domain = hostOf(request.url);
          if (!domain) throw new NotOffered();
          return { kind: "approve-for-session", domain };
        }
        default: throw new NotOffered();
      }
    default: throw new NotOffered();
  }
}

/** An approval for once, in the wire form the runtime takes for `request`'s kind (the shim, here only). */
export function wireApproval(request: Pick<PermissionRequest, "kind">): PermissionDecision {
  return request.kind === "custom-tool" ? { kind: "approved" } : { kind: "approve-once" };
}

/** The context Ember attaches to the judge's approval, so the runtime attributes it to assisted approval. */
export const JUDGE_CONTEXT: PermissionDecisionContext = { outcome: "auto_approved", source: "assisted_approval", surface: "sdk" };

/** The rejection sent for every pending request when Ember's Stop is pulled. */
export const STOPPED_DECISION: PermissionDecision = { kind: "reject", feedback: "The person stopped this session." };
