/** Bridge native Copilot permission requests to Ember's approval modes and existing voice/keyboard confirmer. */
import type { PermissionHandler, PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { ModeInForce } from "../../shared/approvals";
import type { OS } from "../../shared/shortcuts";
import { visibleText } from "../../shared/visible-text";
import { classifyCommand } from "../commands/classify";
import type { ClassifyContext, ShellId } from "../commands/types";
import type { Confirmer, Question } from "./confirm";

export interface CodingPermissionOptions {
  mode: () => ModeInForce;
  confirmer: Pick<Confirmer, "ask">;
  signal: AbortSignal;
  task: { id: string; title: string; goal: string };
  workspace: string;
  home: string;
  os: OS;
  /** Current local command switch and organisation/user requirement, read again after a question. */
  commandPolicy: () => { state: "on" | "off" | "needs-consent"; askEvery: boolean };
  /** Ember's protected paths and process identifiers on this machine. */
  ember: ClassifyContext["ember"];
  /** Only a verdict correlated to this exact SDK request may return approve. Missing or failed review asks. */
  recommendation?: (request: PermissionRequest) => Promise<"approve" | "requireApproval" | "excluded" | "error" | undefined> | "approve" | "requireApproval" | "excluded" | "error" | undefined;
  /** Managed or sandbox restrictions reported on the SDK's associated prompt. */
  requiresHuman?: (request: PermissionRequest) => Promise<boolean>;
}

const approved: PermissionRequestResult = { kind: "approved" };
const denied: PermissionRequestResult = { kind: "reject" };
const unavailable: PermissionRequestResult = { kind: "user-not-available" };
const MAX_DETAIL = 48_000;

/**
 * The SDK passes the request to its permission handler immediately before it publishes the same event to listeners.
 * Correlate the separate native judge verdict by object identity and tool call ID, never by command or path text.
 */
export function codingRecommendations(): {
  onEvent(event: SessionEvent): void;
  recommendation(request: PermissionRequest): Promise<"approve" | "requireApproval" | "excluded" | "error" | undefined>;
  requiresHuman(request: PermissionRequest): Promise<boolean>;
} {
  const results = new WeakMap<PermissionRequest, "approve" | "requireApproval" | "excluded" | "error">();
  const managed = new WeakSet<PermissionRequest>();
  return {
    onEvent(event) {
      if (event.type !== "permission.requested") return;
      const { permissionRequest: request, promptRequest: prompt } = event.data;
      if (!prompt || !request.toolCallId || request.toolCallId !== prompt.toolCallId) return;
      const expected = request.kind === "shell" ? "commands" : request.kind;
      if (prompt.kind !== expected) return;
      if (request.managedApprovalRequired || ("managedApprovalRequired" in prompt && prompt.managedApprovalRequired) ||
          ("requestSandboxBypass" in prompt && prompt.requestSandboxBypass)) { managed.add(request); return; }
      if (event.data.permissionMode !== "assisted" || !("assistedApproval" in prompt)) return;
      const result = prompt.assistedApproval?.recommendation;
      if (result === "approve" || result === "requireApproval" || result === "excluded" || result === "error") results.set(request, result);
    },
    async recommendation(request) {
      // The SDK invokes the callback first; its listener runs before this microtask resumes.
      await Promise.resolve();
      const result = results.get(request);
      results.delete(request);
      return result;
    },
    async requiresHuman(request) { await Promise.resolve(); return managed.has(request); },
  };
}

/** Render control and bidi characters visibly; preserve the whole operation for an informed answer. */
function visible(value: string): string {
  return visibleText(value).map(part => part.kind === "mixed" ? `[mixed:${part.text}]` : part.text).join("");
}

function shellFor(request: PermissionRequest, os: OS): ShellId {
  // The bundled runtime sends shellType, though the SDK's generated request type omits it.
  const raw = (request as PermissionRequest & { shellType?: unknown }).shellType;
  if (raw === "bash" || raw === "zsh" || raw === "sh" || raw === "powershell" || raw === "cmd") return raw;
  return os === "win32" ? "powershell" : "bash";
}

/** Exact operation shown on the confirmation. Missing or excessively large details cannot be approved. */
function details(r: PermissionRequest): string | null {
  let text: string;
  if (r.kind === "shell") text = r.fullCommandText;
  else if (r.kind === "write") text = `${r.fileName}\n\n${r.diff}`;
  else if (r.kind === "read") text = r.path;
  else if (r.kind === "url") text = r.url;
  else text = JSON.stringify(r);
  if (!text || text.length > MAX_DETAIL) return null;
  const shown = visible(text);
  return shown.length <= MAX_DETAIL ? shown : null;
}

/**
 * Native SDK permission handler. The session owns the native mode; the host keeps the callback active so changing
 * settings, managed asks and Stop take effect while a decision is pending. The SDK's "approved" result is translated
 * to the bundled runtime's native wire variant by CodingSession, not here.
 */
export function createCodingPermissionHandler(o: CodingPermissionOptions): PermissionHandler {
  return async request => {
    if (o.signal.aborted) return unavailable;
    const eventForces = o.requiresHuman ? await o.requiresHuman(request) : false;
    if (o.signal.aborted) return unavailable;
    const policy = o.commandPolicy();
    if (request.kind === "shell" && policy.state !== "on") return denied;
    const text = details(request);
    if (!text) return denied;
    const bypass = "requestSandboxBypass" in request && request.requestSandboxBypass === true;
    let dangerous = bypass;
    if (request.kind === "shell") {
      const cls = classifyCommand(request.fullCommandText, shellFor(request, o.os), {
        os: o.os, home: o.home, cwd: o.workspace, ember: o.ember, downloaded: new Set(),
      });
      if (cls.refuse) return denied;
      // Script contents were not inspected here: do not let a known launcher hide dangerous steps.
      dangerous ||= cls.findings.some(f => f.cls !== "unknown") || ("scripts" in cls && Array.isArray(cls.scripts) && cls.scripts.length > 0);
    } else if (request.kind === "write") {
      dangerous ||= request.fileEdits?.some(edit => !!edit.before && !edit.after) === true;
    } else if (request.kind !== "read" && request.kind !== "url") dangerous = true;

    const mode = o.mode();
    const forced = eventForces || request.managedApprovalRequired === true || bypass || (request.kind === "shell" && policy.askEvery);
    let ask = forced || mode === "asking" || (mode !== "autopilot" && dangerous);
    if (ask && !forced && mode === "assisted" && o.recommendation) {
      const recommendation = await o.recommendation(request);
      if (o.signal.aborted) return unavailable;
      const live = o.commandPolicy();
      if (request.kind === "shell" && live.state !== "on") return denied;
      if (o.mode() === "assisted" && !(request.kind === "shell" && live.askEvery) && recommendation === "approve") ask = false;
    }
    if (!ask) return o.signal.aborted ? unavailable : approved;

    const label = request.kind === "shell" ? "run this command" : request.kind === "write" ? "change this file"
      : request.kind === "read" ? "read this file" : request.kind === "url" ? "access this address" : "use this capability";
    const q: Question = {
      title: o.task.title, task: o.task.id, taskLine: o.task.goal, where: "on this computer",
      prompt: `May I ${label}? Review the full details below.`, detail: text, risky: true,
      options: [{ id: "allow", label: "Allow", primary: true }, { id: "no", label: "Not now" }],
    };
    const answer = await o.confirmer.ask(q, o.signal);
    if (o.signal.aborted) return unavailable;
    if (request.kind === "shell" && o.commandPolicy().state !== "on") return denied;
    return answer === "allow" ? approved : denied;
  };
}
