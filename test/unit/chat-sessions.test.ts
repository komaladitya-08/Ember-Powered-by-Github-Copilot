/**
 * This run's native chat sessions (chat-sessions.ts) over fake sessions: the gates Ember keeps beside the SDK's
 * permission system (the setting, consent, the organisation's policy, a vault fill, a connection), the kill switch's
 * part, the organisation's cap, and the audit log's record of who decided.
 */

import { describe, expect, it } from "vitest";
import type { CopilotClient } from "@github/copilot-sdk";
import { ChatSessions, CHAT_REFUSALS, type ChatSessionLike, type ChatSessionsDeps } from "../../app/main/agent/chat-sessions";
import { ChatUnavailable, type ChatSessionOptions } from "../../app/main/agent/chat-session";
import { KillSwitch } from "../../app/main/agent/killswitch";
import type { ChatPolicy } from "../../app/main/agent/chat-policy";
import type { ChatEvent } from "../../app/shared/chat";
import type { AuditEntry } from "../../app/main/policy/audit";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };

class FakeSession implements ChatSessionLike {
  name = "";
  permissionMode: ChatSessionLike["permissionMode"] = "manual";
  agentMode: ChatSessionLike["agentMode"] = "interactive";
  busy = false;
  waiting = 0;
  sent: string[] = [];
  stops = 0;
  closed = false;
  stopMs = 0;
  constructor(readonly id: string, readonly folder: string, readonly o: ChatSessionOptions) { this.name = o.name ?? ""; }
  async send(text: string) { this.sent.push(text); this.busy = true; }
  async decide() { /* recorded by the test through the call */ }
  answer() { /* nothing to answer in a fake */ }
  async setPermissionMode(mode: ChatSessionLike["permissionMode"]) { this.permissionMode = mode; return { requested: mode, mode, applied: true }; }
  async setAgentMode(mode: ChatSessionLike["agentMode"]) { this.agentMode = mode; return { requested: mode, mode, applied: true }; }
  stop() { this.stops++; return this.stopMs ? new Promise<void>(r => setTimeout(r, this.stopMs)) : Promise.resolve(); }
  async close() { this.closed = true; }
}

function setup(over: Partial<ChatSessionsDeps> = {}) {
  const state = { consent: true, enabled: true, policy: OPEN as ChatPolicy | null, vault: false, online: true };
  const audit: AuditEntry[] = [];
  const events: ChatEvent[] = [];
  const made: FakeSession[] = [];
  const opened: ChatSessionOptions[] = [];
  let n = 0;
  const client = { listSessions: async () => [{ sessionId: "ember-chat-kept", summary: "Old chat", context: { workingDirectory: "/w/old" } }, { sessionId: "conductor-1" }],
    getSessionMetadata: async (id: string) => (id === "ember-chat-kept" ? { sessionId: id, context: { workingDirectory: "/w/old" } } : undefined) } as unknown as CopilotClient;
  const chats = new ChatSessions({
    hasConsent: () => state.consent, enabled: () => state.enabled, policy: () => state.policy, vaultFilled: () => state.vault,
    access: () => (state.online ? { gitHubToken: "gho_x", model: "m", service: false } : null), client: async () => client,
    protectedPaths: () => ["/data/ember"], audit: () => ({ write: e => { audit.push(e); } }), emit: e => events.push(e), log: quiet,
    open: async o => {
      opened.push(o);
      const s = new FakeSession(o.resumeId ?? `ember-chat-${++n}`, o.folder, o);
      made.push(s);
      return s;
    },
    ...over,
  });
  return { chats, state, audit, events, made, opened };
}

describe("native chat sessions' gates", () => {
  it("start and send nothing while the feature is off, before consent, under a policy that allows none, after a vault fill or offline", async () => {
    for (const [key, value, why] of [["enabled", false, CHAT_REFUSALS.off], ["consent", false, CHAT_REFUSALS.consent], ["policy", null, CHAT_REFUSALS.policy], ["vault", true, CHAT_REFUSALS.vault], ["online", false, CHAT_REFUSALS.offline]] as const) {
      const t = setup();
      (t.state as Record<string, unknown>)[key] = value;
      await expect(t.chats.create("/w")).rejects.toThrow(why);
      expect(t.made).toEqual([]);
    }
    const t = setup();
    const row = await t.chats.create("/w", "Mine");
    t.state.consent = false;
    await expect(t.chats.send(row.id, "hello")).rejects.toBeInstanceOf(ChatUnavailable);
    t.state.consent = true;
    t.state.online = false;
    await expect(t.chats.send(row.id, "hello")).rejects.toThrow(CHAT_REFUSALS.offline);
    expect(t.made[0].sent).toEqual([]);
  });

  it("lets a rejection through after consent is gone, but no approval", async () => {
    const t = setup();
    const row = await t.chats.create("/w");
    t.state.consent = false;
    await expect(t.chats.decide(row.id, "r1", { kind: "reject" })).resolves.toBeUndefined();
    await expect(t.chats.decide(row.id, "r1", { kind: "approve-once" })).rejects.toThrow(CHAT_REFUSALS.consent);
  });

  it("gives a session the sign-in, the policy, Ember's paths and the folder main chose, and the session alone the token", async () => {
    const t = setup();
    const row = await t.chats.create("/w/project", "Named");
    expect(row).toEqual({ id: "ember-chat-1", name: "Named", folder: "/w/project", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: true });
    expect(t.opened[0]).toMatchObject({ folder: "/w/project", gitHubToken: "gho_x", model: "m", policy: OPEN, protectedPaths: ["/data/ember"], name: "Named" });
  });

  it("closes a session that opened after consent was withdrawn", async () => {
    let release!: () => void;
    const late: FakeSession[] = [];
    const t2 = setup({ open: async o => { await new Promise<void>(r => { release = r; }); const s = new FakeSession("ember-chat-late", o.folder, o); late.push(s); return s; } });
    const making = t2.chats.create("/w");
    await new Promise(r => setTimeout(r, 0));
    t2.state.consent = false;
    release();
    await expect(making).rejects.toThrow(CHAT_REFUSALS.consent);
    expect(late[0].closed).toBe(true);
    expect(await t2.chats.list()).toEqual([]);
  });

  it("lists this run's sessions and Ember's kept ones only, and opens a kept one in its own folder", async () => {
    const t = setup();
    await t.chats.create("/w");
    expect((await t.chats.list()).map(r => [r.id, r.open])).toEqual([["ember-chat-1", true], ["ember-chat-kept", false]]);
    const resumed = await t.chats.resume("ember-chat-kept");
    expect(resumed).toMatchObject({ id: "ember-chat-kept", folder: "/w/old", open: true });
    expect(t.opened[1]).toMatchObject({ resumeId: "ember-chat-kept", folder: "/w/old" });
    await expect(t.chats.resume("conductor-1")).rejects.toThrow(CHAT_REFUSALS.unknown);
  });
});

describe("native chat sessions and the organisation's cap", () => {
  it("refuses a permission mode the policy doesn't allow, whatever the session would do", async () => {
    const t = setup();
    t.state.policy = { managedSettings: {}, permissionModes: ["manual"], standing: false };
    const row = await t.chats.create("/w");
    expect(await t.chats.setPermissionMode(row.id, "allow-all")).toEqual({ requested: "allow-all", mode: "manual", applied: false });
    expect(t.made[0].permissionMode).toBe("manual");
    expect(await t.chats.setAgentMode(row.id, "autopilot")).toMatchObject({ mode: "autopilot" });
  });
});

describe("native chat sessions and Stop", () => {
  it("stops every session through the kill switch's part within its budget", async () => {
    const t = setup();
    await t.chats.create("/w");
    await t.chats.create("/w");
    t.made[1].stopMs = 20;
    const result = await new KillSwitch(() => [t.chats.stopPart()], quiet).pull("hotkey");
    expect(result.late).toEqual([]);
    expect(result.ms).toBeLessThan(300);
    expect(t.made.map(s => s.stops)).toEqual([1, 1]);
    expect(t.chats.stopPart().name).toBe("chat");
  });

  it("reports a session that winds down past the budget as late, without waiting for it", async () => {
    const t = setup();
    await t.chats.create("/w");
    t.made[0].stopMs = 1000;
    const result = await new KillSwitch(() => [t.chats.stopPart()], quiet).pull("hotkey");
    expect(result.late).toEqual(["chat"]);
    expect(result.ms).toBeLessThan(400);
  });

  it("stops every session when the gate closes (consent withdrawn, the policy, a fill)", async () => {
    const t = setup();
    await t.chats.create("/w");
    await t.chats.changed();
    expect(t.made[0].stops).toBe(0);
    t.state.vault = true;
    await t.chats.changed();
    expect(t.made[0].stops).toBe(1);
  });
});

describe("native chat sessions' audit", () => {
  it("records each decision and each tool's end with who decided, a message by its length, and never its words", async () => {
    const t = setup();
    const row = await t.chats.create("/w");
    await t.chats.send(row.id, "please rm -rf the build folder");
    const emit = t.opened[0].onEvent;
    emit({ session: row.id, type: "permission-resolved", requestId: "r1", kind: "shell", decision: "approved", by: "user" });
    emit({ session: row.id, type: "tool-complete", toolCallId: "c1", tool: "bash", success: true, exitCode: 0, result: "secret output", fileEdits: [], approvedBy: "user" });
    emit({ session: row.id, type: "tool-complete", toolCallId: "c2", tool: "view", success: true, fileEdits: [], approvedBy: "allow-all" });
    expect(t.audit.map(({ event, phase, kind, decision, by, tool, chars }) => ({ event, phase, kind, decision, by, tool, chars }))).toEqual([
      { event: "chat", phase: "opened", kind: undefined, decision: undefined, by: undefined, tool: undefined, chars: undefined },
      { event: "chat", phase: "sent", kind: undefined, decision: undefined, by: undefined, tool: undefined, chars: 30 },
      { event: "chat", phase: "permission", kind: "shell", decision: "approved", by: "user", tool: undefined, chars: undefined },
      { event: "chat", phase: "tool", kind: undefined, decision: undefined, by: "user", tool: "bash", chars: undefined },
      { event: "chat", phase: "tool", kind: undefined, decision: undefined, by: "allow-all", tool: "view", chars: undefined },
    ]);
    const all = JSON.stringify(t.audit);
    for (const words of ["rm -rf", "secret output", "/w"]) expect(all).not.toContain(words);
    expect(t.events.map(e => e.type)).toEqual(["permission-resolved", "tool-complete", "tool-complete"]);
  });

  it("stops a session whose record can't be written, and says so (fail closed)", async () => {
    const t = setup({ audit: () => ({ write: e => { if (e.phase === "tool") throw new Error("disk full"); } }) });
    const row = await t.chats.create("/w");
    t.opened[0].onEvent({ session: row.id, type: "tool-complete", toolCallId: "c1", tool: "bash", success: true, fileEdits: [], approvedBy: "user" });
    expect(t.made[0].stops).toBe(1);
    expect(t.events.find(e => e.type === "error")).toEqual({ type: "error", session: row.id, message: CHAT_REFUSALS.audit });
  });
});
