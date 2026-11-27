/**
 * This run's native chat sessions (chat-session.ts): made, listed, sent to, answered, switched between modes,
 * stopped and let go of here. Everything Ember keeps beside the SDK's own permission system is held here, by
 * injection: nothing is read, heard or sent before consent (`hasConsent`), the feature stays dormant until its
 * setting is on (`settings.chat.native`), the organisation's policy can only tighten (chat-policy.ts; none at all
 * under LOCKDOWN or with acting off), no chat starts or is sent to after a vault fill until Ember restarts (a failed
 * native tool's text can't be rewritten before the model sees it), the kill switch stops every session at once (a
 * `StopPart`), and the audit log records each permission decision and each tool's end with who decided: the kind of
 * tool or request, the decision, and the decider (the person, the SDK's judge, the SDK's rules, allow-all, Stop),
 * never a command, a file's contents, a path or the person's words (a message is recorded as its length). A record
 * that can't be written stops that session (fail closed). Plain Node.
 */

import type { CopilotClient, ProviderConfig } from "@github/copilot-sdk";
import type { AuditEntry } from "../policy/audit";
import type { StopPart } from "./killswitch";
import type { ServiceKind } from "./presenter";
import type { ModelRedactor } from "./redacting-client";
import type { ChatPolicy } from "./chat-policy";
import { CHAT_ID_PREFIX, ChatSession, ChatUnavailable, type ChatSessionOptions } from "./chat-session";
import type { ChatAgentMode, ChatDecision, ChatEvent, ChatModeResult, ChatPermissionMode, ChatSessionRow } from "../../shared/chat";

/** How a chat signs in: the conversation's own service, while it is connected. */
export interface ChatAccess {
  gitHubToken?: string;
  provider?: ProviderConfig;
  model?: string;
  service: ServiceKind;
}

/** What the registry needs of a session (ChatSession, or a fake in tests). */
export interface ChatSessionLike {
  readonly id: string;
  readonly folder: string;
  name: string;
  permissionMode: ChatPermissionMode;
  agentMode: ChatAgentMode;
  busy: boolean;
  readonly waiting: number;
  send(text: string): Promise<void>;
  decide(requestId: string, decision: ChatDecision): Promise<void>;
  answer(requestId: string, answer: string, wasFreeform: boolean): void;
  setPermissionMode(mode: ChatPermissionMode): Promise<ChatModeResult<ChatPermissionMode>>;
  setAgentMode(mode: ChatAgentMode): Promise<ChatModeResult<ChatAgentMode>>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface ChatSessionsDeps {
  /** "Before Ember starts" agreed to (settings.ts hasConsent). */
  hasConsent(): boolean;
  /** The setting that wakes the feature (`settings.chat.native`). */
  enabled(): boolean;
  /** The organisation's policy as chats take it; null: no chat at all. */
  policy(): ChatPolicy | null;
  /** Something was filled from the vault in this run. */
  vaultFilled(): boolean;
  /** The sign-in and model; null while Ember isn't connected. */
  access(): ChatAccess | null;
  /** The chat runtime's client (chat-runtime.ts). */
  client(): Promise<CopilotClient>;
  /** Ember's own data, install and policy paths. */
  protectedPaths(): readonly string[];
  audit(): { write(e: AuditEntry): void } | null;
  /** Every session's events, for Home. */
  emit(event: ChatEvent): void;
  log?: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
  redact?: ModelRedactor;
  /** Makes a session (ChatSession.open; a fake in tests). */
  open?: (o: ChatSessionOptions) => Promise<ChatSessionLike>;
}

/** The plain sentences a refusal says (the renderer shows them as they are). */
export const CHAT_REFUSALS = {
  off: "Chats aren't turned on.",
  consent: "Ember needs your agreement before it starts a chat.",
  policy: "Your organisation doesn't allow chats with Copilot here.",
  vault: "Chats are off after a vault fill until Ember restarts.",
  offline: "Connect Ember to Copilot first.",
  unknown: "That chat isn't open.",
  audit: "Ember couldn't record what this chat did, so it stopped it.",
} as const;

export class ChatSessions {
  private readonly sessions = new Map<string, ChatSessionLike>();
  /** Opening sessions, so Stop reaches one still on its way. */
  private readonly opening = new Set<Promise<ChatSessionLike>>();

  constructor(private readonly d: ChatSessionsDeps) {}

  /** Why a chat can't start or be sent to now, or null. */
  refusal(): string | null {
    if (!this.d.enabled()) return CHAT_REFUSALS.off;
    if (!this.d.hasConsent()) return CHAT_REFUSALS.consent;
    if (!this.d.policy()) return CHAT_REFUSALS.policy;
    if (this.d.vaultFilled()) return CHAT_REFUSALS.vault;
    return null;
  }

  private gate(): ChatPolicy {
    const why = this.refusal();
    if (why) throw new ChatUnavailable(why);
    return this.d.policy()!;
  }

  /** A new session in `folder` (chosen by the person in main's own picker), with an optional friendly name. */
  create(folder: string, name?: string): Promise<ChatSessionRow> {
    return this.openSession(folder, { ...(name ? { name } : {}) });
  }

  /** Opens a kept session again, with its history, in the folder it was made for. */
  async resume(id: string): Promise<ChatSessionRow> {
    this.gate();
    const open = this.sessions.get(id);
    if (open) return this.row(open);
    if (!id.startsWith(CHAT_ID_PREFIX)) throw new ChatUnavailable(CHAT_REFUSALS.unknown);
    const meta = await (await this.d.client()).getSessionMetadata(id);
    const folder = meta?.context?.workingDirectory;
    if (!folder) throw new ChatUnavailable(CHAT_REFUSALS.unknown);
    return this.openSession(folder, { resumeId: id });
  }

  private async openSession(folder: string, extra: { name?: string; resumeId?: string }): Promise<ChatSessionRow> {
    const policy = this.gate();
    const access = this.d.access();
    if (!access) throw new ChatUnavailable(CHAT_REFUSALS.offline);
    const client = await this.d.client();
    const making = (this.d.open ?? ChatSession.open)({
      client, folder, protectedPaths: this.d.protectedPaths(), policy, ...extra,
      ...(access.model ? { model: access.model } : {}), ...(access.provider ? { provider: access.provider } : {}),
      ...(!access.provider && access.gitHubToken ? { gitHubToken: access.gitHubToken } : {}), service: access.service,
      ...(this.d.redact ? { redact: this.d.redact } : {}),
      onEvent: event => this.onEvent(event),
    });
    this.opening.add(making);
    let session: ChatSessionLike;
    try { session = await making; } finally { this.opening.delete(making); }
    // Consent, the policy or the vault changed while it opened: it doesn't stay.
    if (this.refusal()) { await session.close().catch(() => undefined); this.gate(); }
    this.sessions.set(session.id, session);
    this.record(session, { phase: extra.resumeId ? "resumed" : "opened", permissionMode: session.permissionMode, agentMode: session.agentMode });
    return this.row(session);
  }

  /** The sessions open in this run, then the ones kept from earlier runs (only once the feature may run). */
  async list(): Promise<ChatSessionRow[]> {
    const rows = [...this.sessions.values()].map(s => this.row(s));
    if (this.refusal()) return rows;
    const kept = await (await this.d.client()).listSessions().catch(() => []);
    for (const k of kept) {
      if (!k.sessionId.startsWith(CHAT_ID_PREFIX) || this.sessions.has(k.sessionId)) continue;
      rows.push({ id: k.sessionId, name: k.summary ?? "", folder: k.context?.workingDirectory ?? "", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: false });
    }
    return rows;
  }

  /** Sends a message (its length is audited, never its words). */
  async send(id: string, text: string): Promise<void> {
    this.gate();
    // Signed out (or not connected) since it opened: nothing more goes under the sign-in it was opened with.
    if (!this.d.access()) throw new ChatUnavailable(CHAT_REFUSALS.offline);
    const s = this.get(id);
    this.record(s, { phase: "sent", chars: text.length });
    await s.send(text);
  }

  /** A person's decision on a pending request; without consent, or under a refusal, only a rejection goes through. */
  async decide(id: string, requestId: string, decision: ChatDecision): Promise<void> {
    if (decision.kind !== "reject") this.gate();
    return this.get(id).decide(requestId, decision);
  }

  /** A person's answer to the model's question. */
  answer(id: string, requestId: string, answer: string, wasFreeform: boolean): void {
    this.gate();
    this.get(id).answer(requestId, answer, wasFreeform);
  }

  async setPermissionMode(id: string, mode: ChatPermissionMode): Promise<ChatModeResult<ChatPermissionMode>> {
    const policy = this.gate();
    const s = this.get(id);
    // The organisation's cap is Ember's to keep too, whatever the runtime does with managedSettings.
    if (!policy.permissionModes.includes(mode)) return { requested: mode, mode: s.permissionMode, applied: false };
    const result = await s.setPermissionMode(mode);
    this.record(s, { phase: "mode", permissionMode: result.mode, agentMode: s.agentMode });
    return result;
  }

  async setAgentMode(id: string, mode: ChatAgentMode): Promise<ChatModeResult<ChatAgentMode>> {
    this.gate();
    const s = this.get(id);
    const result = await s.setAgentMode(mode);
    this.record(s, { phase: "mode", permissionMode: s.permissionMode, agentMode: result.mode });
    return result;
  }

  /** Stops one session's turn. */
  async stop(id: string): Promise<void> { await this.get(id).stop(); }

  /** Stops every session at once (and any still opening, once it opens). */
  stopAll(): Promise<void> {
    const work: Promise<unknown>[] = [...this.sessions.values()].map(s => s.stop());
    for (const making of this.opening) work.push(making.then(s => s.stop()).catch(() => undefined));
    return Promise.all(work).then(() => undefined);
  }

  /** The kill switch's part: every chat's turn ends, its background agents are cancelled and what waits is rejected. */
  stopPart(): StopPart {
    return { name: "chat", stop: () => this.stopAll() };
  }

  /**
   * Something the gate reads changed (consent, the setting, the policy, a vault fill): where chats may no longer run,
   * every one is stopped.
   */
  changed(): Promise<void> {
    return this.refusal() ? this.stopAll() : Promise.resolve();
  }

  /**
   * Sign-out or another account: every session's turn stops (what waits is rejected) and every session is let go,
   * since each was opened under the sign-in that has ended. Nothing more goes under it; one is opened again only by a
   * resume under the sign-in in force then. What the runtime keeps on disk stays. Never rejects: sign-out goes on
   * whatever a session does as it goes (a failure is logged).
   */
  async accountEnded(): Promise<void> {
    try {
      await this.stopAll();
    } catch (err) {
      this.d.log?.warn("chat.stop_failed", { err: err instanceof Error ? err.name : "unknown" });
    }
    await this.dispose();
  }

  /** Lets every session go (what the runtime keeps on disk stays). */
  async dispose(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map(s => s.close().catch(() => undefined)));
  }

  private get(id: string): ChatSessionLike {
    const s = this.sessions.get(id);
    if (!s) throw new ChatUnavailable(CHAT_REFUSALS.unknown);
    return s;
  }

  private row(s: ChatSessionLike): ChatSessionRow {
    return { id: s.id, name: s.name, folder: s.folder, permissionMode: s.permissionMode, agentMode: s.agentMode, busy: s.busy, pending: s.waiting, open: true };
  }

  /** One audit entry for `s`; one that can't be written stops the session (fail closed). */
  private record(s: { id: string; stop(): Promise<void> } | string, fields: Record<string, unknown>): boolean {
    const id = typeof s === "string" ? s : s.id;
    try {
      const audit = this.d.audit();
      if (!audit) throw new Error("no audit log");
      audit.write({ event: "chat", session: id, ...fields });
      return true;
    } catch (err) {
      this.d.log?.warn("chat.audit_failed", { err: err instanceof Error ? err.name : "unknown" });
      const session = typeof s === "string" ? this.sessions.get(s) : s;
      void session?.stop().catch(() => undefined);
      this.d.emit({ type: "error", session: id, message: CHAT_REFUSALS.audit });
      return false;
    }
  }

  private onEvent(event: ChatEvent): void {
    if (event.type === "permission-resolved") this.record(event.session, { phase: "permission", kind: event.kind, decision: event.decision, by: event.by });
    else if (event.type === "tool-complete") {
      this.record(event.session, { phase: "tool", tool: event.tool, success: event.success, by: event.approvedBy, ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}) });
    }
    this.d.emit(event);
  }
}
