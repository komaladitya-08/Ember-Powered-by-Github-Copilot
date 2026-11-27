/**
 * The coding window's request cards as pure data: what each kind of SDK request shows (read from its `*.requested`
 * payload, shown in full, never summarised away), and the answer the SDK takes for it (research-copilot-sdk.md §2
 * Handlers and §6: `PermissionDecision`, `UIUserInputResponse`, `UIElicitationResponse`, `UIExitPlanModeResponse`,
 * `UIAutoModeSwitchResponse`, `UISessionLimitsExhaustedResponse`). Nothing here chooses: a permission card offers
 * exactly the `choices` main passes on, and an answer is built only from what the person picked. Main checks every
 * answer again before it reaches the SDK. Unit-tested in test/unit/code-requests.test.ts.
 */
import type { CodeRequestKind } from "../../shared/code";
import { arr, bool, num, rec, shown, str, strs, sub } from "./sdk";

/** Characters of the reason a person may give with Don't allow, and of a typed answer. */
export const FEEDBACK_MAX = 2_000;
export const ANSWER_MAX = 20_000;

/** A permission request as its card shows it: the SDK's kind and the parts it sent, as they are. */
export type PermissionView =
  | { kind: "shell"; command: string; intention?: string; commands: { identifier: string; readOnly: boolean }[]; paths: string[]; urls: string[]; writesFiles: boolean; warning?: string; sandboxBypass?: string }
  | { kind: "write"; file: string; intention?: string; diff?: string; newContents?: string; sandboxBypass?: string }
  | { kind: "read"; path: string; intention?: string }
  | { kind: "url"; url: string; intention?: string }
  | { kind: "mcp"; server: string; tool: string; title?: string; args?: string; readOnly: boolean }
  | { kind: "memory"; fact: string; reason?: string }
  | { kind: "custom-tool"; tool: string; description?: string; args?: string }
  | { kind: "hook"; tool: string; message?: string; args?: string }
  | { kind: "other"; sdkKind: string; details: string };

/** The parts of a `permission.requested` payload a card shows besides the request itself. */
export interface PermissionCard {
  view: PermissionView;
  /** The organisation's rules want a person's decision on this one. */
  managed: boolean;
  /** The assisted check's recommendation, when the SDK attached one. */
  assisted?: { recommendation: string; reason?: string; model?: string };
  /** The SDK's own risk assessment, as it sent it. */
  risk?: string;
  /** The sub-agent or session that asked, when not this session's main agent. */
  owner?: string;
}

/** A `permission.requested` payload, read. */
export function permissionCard(data: unknown): PermissionCard {
  const r = sub(data, "permissionRequest") ?? {};
  const prompt = sub(data, "promptRequest");
  const assistedRaw = sub(r, "assistedApproval") ?? sub(prompt, "assistedApproval");
  const risk = rec(data)?.riskAssessment;
  const intention = str(r, "intention");
  const bypass = bool(r, "requestSandboxBypass") ? str(r, "requestSandboxBypassReason") ?? "" : undefined;
  const at = <T extends object>(o: T) => o;
  let view: PermissionView;
  switch (str(r, "kind")) {
    case "shell":
      view = at({
        kind: "shell" as const, command: str(r, "fullCommandText", true) ?? "", ...(intention ? { intention } : {}),
        commands: arr(r, "commands").map(c => ({ identifier: str(c, "identifier") ?? "", readOnly: bool(c, "readOnly") ?? false })).filter(c => c.identifier),
        paths: strs(r, "possiblePaths"), urls: arr(r, "possibleUrls").map(u => str(u, "url") ?? "").filter(Boolean),
        writesFiles: bool(r, "hasWriteFileRedirection") ?? false, ...(str(r, "warning") ? { warning: str(r, "warning") } : {}),
        ...(bypass !== undefined ? { sandboxBypass: bypass } : {}),
      });
      break;
    case "write":
      view = {
        kind: "write", file: str(r, "fileName") ?? str(r, "resolvedPath") ?? "", ...(intention ? { intention } : {}),
        ...(str(r, "diff", true) ? { diff: str(r, "diff", true) } : {}), ...(str(r, "newFileContents", true) && !str(r, "diff") ? { newContents: str(r, "newFileContents", true) } : {}),
        ...(bypass !== undefined ? { sandboxBypass: bypass } : {}),
      };
      break;
    case "read": view = { kind: "read", path: str(r, "path") ?? "", ...(intention ? { intention } : {}) }; break;
    case "url": view = { kind: "url", url: str(r, "url") ?? "", ...(intention ? { intention } : {}) }; break;
    case "mcp": {
      const args = rec(r)?.args;
      view = { kind: "mcp", server: str(r, "serverName") ?? "", tool: str(r, "toolName") ?? "", ...(str(r, "toolTitle") ? { title: str(r, "toolTitle") } : {}), ...(args !== undefined ? { args: shown(args) } : {}), readOnly: bool(r, "readOnly") ?? false };
      break;
    }
    case "memory": view = { kind: "memory", fact: str(r, "fact") ?? "", ...(str(r, "reason") ? { reason: str(r, "reason") } : {}) }; break;
    case "custom-tool": {
      const args = rec(r)?.args;
      view = { kind: "custom-tool", tool: str(r, "toolName") ?? "", ...(str(r, "toolDescription") ? { description: str(r, "toolDescription") } : {}), ...(args !== undefined ? { args: shown(args) } : {}) };
      break;
    }
    case "hook": {
      const args = rec(r)?.toolArgs;
      view = { kind: "hook", tool: str(r, "toolName") ?? "", ...(str(r, "hookMessage") ? { message: str(r, "hookMessage") } : {}), ...(args !== undefined ? { args: shown(args) } : {}) };
      break;
    }
    default: {
      // A kind the window has no drawing for: everything the SDK sent, shown whole.
      const { kind: _k, ...rest } = r;
      view = { kind: "other", sdkKind: str(r, "kind") ?? "request", details: shown(rest) };
    }
  }
  return {
    view,
    managed: bool(r, "managedApprovalRequired") ?? false,
    ...(assistedRaw && str(assistedRaw, "recommendation") ? { assisted: { recommendation: str(assistedRaw, "recommendation")!, ...(str(assistedRaw, "reason") ? { reason: str(assistedRaw, "reason") } : {}), ...(str(assistedRaw, "model") ? { model: str(assistedRaw, "model") } : {}) } } : {}),
    ...(risk !== undefined && risk !== null ? { risk: shown(risk, 4_000) } : {}),
    ...(str(data, "ownerAgentId") ? { owner: str(data, "ownerAgentId") } : {}),
  };
}

/** A URL's host, or null when it isn't a web address. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch { return null; /* not a URL: no domain approval can be built */ }
}
/** The folder a path is in ("/" or "\" separated), or null at the top. */
function folderOf(path: string): string | null {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : null;
}

/**
 * The SDK's decision for `choice` on this request (`PermissionDecision`), with the scope each approval needs, built
 * from the request itself: a session approval names the request's own commands, tool or kind, a read's folder or a
 * URL's domain. null when `choice` isn't one the card offers or the scope can't be built (the card then sends nothing).
 */
export function permissionAnswer(data: unknown, choices: readonly string[], choice: string, feedback = ""): Record<string, unknown> | null {
  if (!choices.includes(choice)) return null;
  const r = sub(data, "permissionRequest") ?? {};
  const kind = str(r, "kind");
  switch (choice) {
    case "approve-once": return { kind: "approve-once" };
    case "reject": {
      const why = feedback.trim().slice(0, FEEDBACK_MAX);
      return why ? { kind: "reject", feedback: why } : { kind: "reject" };
    }
    case "user-not-available": return { kind: "user-not-available" };
    case "approve-read-only-for-session": {
      const folder = folderOf(str(r, "path") ?? "");
      return folder ? { kind: "approve-read-only-for-session", directories: [folder] } : null;
    }
    case "approve-permanently": {
      const domain = kind === "url" ? hostOf(str(r, "url") ?? "") : null;
      return domain ? { kind: "approve-permanently", domain } : null;
    }
    case "approve-for-session":
      switch (kind) {
        case "shell": {
          const ids = arr(r, "commands").map(c => str(c, "identifier")).filter((x): x is string => !!x);
          return ids.length ? { kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ids } } : null;
        }
        case "write": return { kind: "approve-for-session", approval: { kind: "write" } };
        case "read": return { kind: "approve-for-session", approval: { kind: "read" } };
        case "mcp": return str(r, "serverName") && str(r, "toolName") ? { kind: "approve-for-session", approval: { kind: "mcp", serverName: str(r, "serverName"), toolName: str(r, "toolName") } } : null;
        case "memory": return { kind: "approve-for-session", approval: { kind: "memory" } };
        case "custom-tool": return str(r, "toolName") ? { kind: "approve-for-session", approval: { kind: "custom-tool", toolName: str(r, "toolName") } } : null;
        case "url": {
          const domain = hostOf(str(r, "url") ?? "");
          return domain ? { kind: "approve-for-session", domain } : null;
        }
        default: return null;
      }
    default: return null;
  }
}

/** Whether a choice grants something (it waits until the card has been in view a moment; Don't allow never waits). */
export function grants(choice: string): boolean {
  return choice !== "reject" && choice !== "user-not-available";
}

// ───── The model's question (user_input.requested) ─────

export interface QuestionCard { question: string; choices: string[]; freeform: boolean }
export function questionCard(data: unknown): QuestionCard {
  const choices = strs(data, "choices");
  // No choices means the question can only be answered in words.
  return { question: str(data, "question", true) ?? "", choices, freeform: bool(data, "allowFreeform") ?? choices.length === 0 };
}
/** `UIUserInputResponse`: a choice as it was offered, or the person's own words. */
export function questionAnswer(card: QuestionCard, answer: string, freeform: boolean): { answer: string; wasFreeform: boolean } | null {
  if (!freeform) return card.choices.includes(answer) ? { answer, wasFreeform: false } : null;
  const words = answer.trim();
  return card.freeform && words ? { answer: words.slice(0, ANSWER_MAX), wasFreeform: true } : null;
}

// ───── Elicitation (an MCP server's form, or a URL to open) ─────

export type FieldKind = "text" | "number" | "integer" | "boolean" | "choice" | "choices";
export interface FormField {
  name: string;
  label: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  options: { value: string; label: string }[];
  default?: string | number | boolean | string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** A string format the schema names (email, uri, date, date-time): the field's input type follows it. */
  format?: string;
}
export interface ElicitationCard { message: string; mode: "form" | "url"; url?: string; source?: string; fields: FormField[] }

/** The options of an enum-like property: `enum` with `enumNames`, or `oneOf`/`anyOf` of `{ const, title }`. */
function optionsOf(p: Record<string, unknown>): { value: string; label: string }[] {
  const values = arr(p, "enum").filter((v): v is string => typeof v === "string");
  if (values.length) {
    const names = strs(p, "enumNames");
    return values.map((v, i) => ({ value: v, label: names[i] ?? v }));
  }
  const one = [...arr(p, "oneOf"), ...arr(p, "anyOf")];
  return one.map(o => ({ value: str(o, "const") ?? "", label: str(o, "title") ?? str(o, "const") ?? "" })).filter(o => o.value);
}

/** An `elicitation.requested` payload, read: its message and, in form mode, a field for each property of its schema. */
export function elicitationCard(data: unknown): ElicitationCard {
  const schema = sub(data, "requestedSchema");
  const props = sub(schema, "properties") ?? {};
  const required = new Set(strs(schema, "required"));
  const fields: FormField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const p = rec(raw);
    if (!p) continue;
    const type = str(p, "type");
    const options = optionsOf(p);
    const items = sub(p, "items");
    let kind: FieldKind = "text";
    if (type === "boolean") kind = "boolean";
    else if (type === "number") kind = "number";
    else if (type === "integer") kind = "integer";
    else if (type === "array") kind = "choices";
    else if (options.length) kind = "choice";
    const def = p.default;
    fields.push({
      name, label: str(p, "title") ?? name, ...(str(p, "description") ? { description: str(p, "description") } : {}),
      kind, required: required.has(name), options: kind === "choices" ? optionsOf(items ?? {}) : options,
      ...(typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? { default: def } : Array.isArray(def) ? { default: def.filter((x): x is string => typeof x === "string") } : {}),
      ...(num(p, "minimum") !== undefined ? { min: num(p, "minimum") } : {}), ...(num(p, "maximum") !== undefined ? { max: num(p, "maximum") } : {}),
      ...(num(p, "minLength") !== undefined ? { minLength: num(p, "minLength") } : {}), ...(num(p, "maxLength") !== undefined ? { maxLength: num(p, "maxLength") } : {}),
      ...(str(p, "format") ? { format: str(p, "format") } : {}),
    });
  }
  const url = str(data, "url");
  return {
    message: str(data, "message", true) ?? "", mode: str(data, "mode") === "url" || (url && !fields.length) ? "url" : "form",
    ...(url ? { url } : {}), ...(str(data, "elicitationSource") ? { source: str(data, "elicitationSource") } : {}), fields,
  };
}

/** A field's problem with what was entered, in a short sentence (null: fine). */
export type FieldProblem = { name: string; problem: "required" | "number" | "integer" | "range" | "length" | "option" };

/**
 * `UIElicitationResponse` for an accepted form: each value typed as its schema says, or the fields with a problem.
 * Values come as the form holds them (strings, a boolean for a check box, strings for several choices).
 */
export function elicitationAccept(card: ElicitationCard, values: Readonly<Record<string, string | boolean | string[]>>):
  { ok: true; answer: { action: "accept"; content: Record<string, string | number | boolean | string[]> } } | { ok: false; problems: FieldProblem[] } {
  const content: Record<string, string | number | boolean | string[]> = {};
  const problems: FieldProblem[] = [];
  for (const f of card.fields) {
    const v = values[f.name];
    if (f.kind === "boolean") { content[f.name] = v === true; continue; }
    if (f.kind === "choices") {
      const picked = Array.isArray(v) ? v.filter(x => f.options.some(o => o.value === x)) : [];
      if (f.required && !picked.length) problems.push({ name: f.name, problem: "required" });
      else if (picked.length) content[f.name] = picked;
      continue;
    }
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) { if (f.required) problems.push({ name: f.name, problem: "required" }); continue; }
    if (f.kind === "number" || f.kind === "integer") {
      const n = Number(text);
      if (!Number.isFinite(n)) { problems.push({ name: f.name, problem: "number" }); continue; }
      if (f.kind === "integer" && !Number.isInteger(n)) { problems.push({ name: f.name, problem: "integer" }); continue; }
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) { problems.push({ name: f.name, problem: "range" }); continue; }
      content[f.name] = n;
      continue;
    }
    if (f.kind === "choice" && !f.options.some(o => o.value === text)) { problems.push({ name: f.name, problem: "option" }); continue; }
    if ((f.minLength !== undefined && text.length < f.minLength) || (f.maxLength !== undefined && text.length > f.maxLength)) { problems.push({ name: f.name, problem: "length" }); continue; }
    content[f.name] = text.slice(0, ANSWER_MAX);
  }
  return problems.length ? { ok: false, problems } : { ok: true, answer: { action: "accept", content } };
}

/** Declining (the person said no) and cancelling (they dismissed it), as the SDK tells them apart. */
export const ELICITATION_DECLINE = { action: "decline" } as const;
export const ELICITATION_CANCEL = { action: "cancel" } as const;

// ───── Leaving plan mode ─────

export interface PlanExitCard { summary: string; plan: string; actions: string[]; recommended?: string }
export function planExitCard(data: unknown): PlanExitCard {
  return { summary: str(data, "summary", true) ?? "", plan: str(data, "planContent", true) ?? "", actions: strs(data, "actions"), ...(str(data, "recommendedAction") ? { recommended: str(data, "recommendedAction") } : {}) };
}
/** `UIExitPlanModeResponse`: approved with one of the offered actions, or not approved with the person's feedback. */
export function planExitAnswer(card: PlanExitCard, action: string | null, feedback = ""): Record<string, unknown> | null {
  const words = feedback.trim().slice(0, FEEDBACK_MAX);
  if (action === null) return { approved: false, ...(words ? { feedback: words } : {}) };
  if (!card.actions.includes(action)) return null;
  return { approved: true, selectedAction: action, ...(words ? { feedback: words } : {}) };
}

// ───── Auto mode, session limits, MCP sign-in, sampling ─────

/** `UIAutoModeSwitchResponse`. */
export const AUTO_MODE_ANSWERS = ["yes", "yes_always", "no"] as const;
export interface AutoModeCard { errorCode?: string; retryAfterSeconds?: number }
export function autoModeCard(data: unknown): AutoModeCard {
  return { ...(str(data, "errorCode") ? { errorCode: str(data, "errorCode") } : {}), ...(num(data, "retryAfterSeconds") !== undefined ? { retryAfterSeconds: num(data, "retryAfterSeconds") } : {}) };
}

export interface LimitsCard { used: number; max: number }
export function limitsCard(data: unknown): LimitsCard { return { used: num(data, "usedAiCredits") ?? 0, max: num(data, "maxAiCredits") ?? 0 }; }
/** `UISessionLimitsExhaustedResponse`: add credits to the limit, set a new one, remove it, or leave it and cancel. */
export function limitsAnswer(action: "add" | "set" | "unset" | "cancel", amount?: number): Record<string, unknown> | null {
  if (action === "unset" || action === "cancel") return { action };
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  return action === "add" ? { action, additionalAiCredits: amount } : { action, maxAiCredits: amount };
}

export interface OauthCard { server: string; url: string; reason?: string }
export function oauthCard(data: unknown): OauthCard {
  return { server: str(data, "serverName") ?? "", url: str(data, "serverUrl") ?? "", ...(str(data, "reason") ? { reason: str(data, "reason") } : {}) };
}
/**
 * An MCP sign-in has no answer the window can make itself (the token comes from the sign-in main runs): it asks main
 * to sign in, or says not now (`McpAuthHandler`'s `{ kind: "cancelled" }`).
 */
export const OAUTH_SIGN_IN = { kind: "sign-in" } as const;
export const OAUTH_CANCEL = { kind: "cancelled" } as const;

/** A sampling request: an MCP server asks to use the session's model. The window offers only to refuse it for now. */
export function samplingServer(data: unknown): string { return str(data, "serverName") ?? ""; }
export const SAMPLING_REFUSE = {} as const;

/** The request kinds that a press grants something by (their granting answers wait until the card was in view). */
export const GRANTING_KINDS: readonly CodeRequestKind[] = ["permission", "exit-plan-mode", "auto-mode-switch", "session-limits", "mcp-oauth"];
