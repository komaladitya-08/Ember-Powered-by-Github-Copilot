/**
 * Home's native chat channels in main (chat-ipc.ts): the sender is checked first, every argument is checked by its
 * schema and size, a new chat's folder never comes from the page, and a failure answers in one plain sentence.
 */

import { describe, expect, it } from "vitest";
import { CHAT_ARGS, CHAT_BAD_ARGS, registerChatIpc, type ChatIpcApi, type ChatIpcEvent } from "../../app/main/chat-ipc";
import { CHAT_IPC } from "../../app/shared/ipc";
import { CHAT_LIMITS } from "../../app/shared/chat";
import { ChatUnavailable } from "../../app/main/agent/chat-session";

const HOME: ChatIpcEvent = { sender: "home", senderFrame: { url: "file:///app/renderer/home/index.html" } };
const OTHER: ChatIpcEvent = { sender: "overlay", senderFrame: { url: "file:///app/renderer/overlay/index.html" } };
const ID = "ember-chat-0b9c6c1e-7c2f-4f0e-8d55-6a4d1c0e2f11";

function setup(over: Partial<ChatIpcApi> = {}) {
  const handlers = new Map<string, (event: ChatIpcEvent, ...args: unknown[]) => unknown>();
  const calls: unknown[][] = [];
  const row = { id: ID, name: "", folder: "/w", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: true } as const;
  const api: ChatIpcApi = {
    list: async () => [row], create: async name => { calls.push(["create", name]); return row; }, resume: async () => row,
    send: async (id, text) => { calls.push(["send", id, text]); }, decide: async (...a) => { calls.push(["decide", ...a]); }, answer: (...a) => { calls.push(["answer", ...a]); },
    setPermissionMode: async (_id, mode) => ({ requested: mode, mode, applied: true }), setAgentMode: async (_id, mode) => ({ requested: mode, mode, applied: true }),
    stop: async id => { calls.push(["stop", id]); }, ...over,
  };
  const warnings: string[] = [];
  registerChatIpc({ handle: (channel, fn) => { handlers.set(channel, fn); } }, e => e.sender === "home", api, { log: { warn: e => warnings.push(e) } });
  const call = (channel: string, event: ChatIpcEvent, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!(event, ...args));
  return { handlers, calls, call, warnings };
}

describe("Home's native chat channels", () => {
  it("registers every request channel, and not the event push", () => {
    const t = setup();
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(CHAT_IPC).filter(c => c !== CHAT_IPC.event).sort());
    expect(Object.keys(CHAT_ARGS).sort()).toEqual(Object.keys(CHAT_IPC).filter(k => k !== "event").sort());
  });

  it("refuses any sender but the settings window before reading anything", async () => {
    const t = setup();
    for (const channel of t.handlers.keys()) await expect(t.call(channel, OTHER, ID, "x")).rejects.toThrow(/untrusted IPC sender/);
    expect(t.calls).toEqual([]);
  });

  it("takes no folder from the page: create takes at most a friendly name", async () => {
    const t = setup();
    expect(await t.call(CHAT_IPC.create, HOME)).toMatchObject({ ok: true });
    expect(await t.call(CHAT_IPC.create, HOME, "  Notes  ")).toMatchObject({ ok: true });
    expect(await t.call(CHAT_IPC.create, HOME, "/etc", "/home/user")).toEqual({ ok: false, why: CHAT_BAD_ARGS });
    expect(await t.call(CHAT_IPC.create, HOME, "x".repeat(CHAT_LIMITS.name + 1))).toEqual({ ok: false, why: CHAT_BAD_ARGS });
    expect(t.calls).toEqual([["create", undefined], ["create", "Notes"]]);
  });

  it("checks each argument's type and size, changing nothing on a bad one", async () => {
    const t = setup();
    const bad: [string, unknown[]][] = [
      [CHAT_IPC.send, [ID]], [CHAT_IPC.send, [ID, ""]], [CHAT_IPC.send, [ID, "x".repeat(CHAT_LIMITS.prompt + 1)]], [CHAT_IPC.send, [42, "hi"]], [CHAT_IPC.send, ["../../etc", "hi"]],
      [CHAT_IPC.decide, [ID, "r1", { kind: "approve-always" }]], [CHAT_IPC.decide, [ID, "r1", { kind: "approve-once", extra: 1 }]],
      [CHAT_IPC.decide, [ID, "r1", { kind: "reject", feedback: "x".repeat(CHAT_LIMITS.feedback + 1) }]], [CHAT_IPC.decide, [ID, "r1", "approve-once"]],
      [CHAT_IPC.answer, [ID, "q1", "yes"]], [CHAT_IPC.setPermissionMode, [ID, "yolo"]], [CHAT_IPC.setAgentMode, [ID, "allow-all"]],
      [CHAT_IPC.stop, ["x".repeat(CHAT_LIMITS.id + 1)]], [CHAT_IPC.list, ["extra"]], [CHAT_IPC.resume, []],
    ];
    for (const [channel, args] of bad) expect(await t.call(channel, HOME, ...args), `${channel} ${JSON.stringify(args).slice(0, 60)}`).toEqual({ ok: false, why: CHAT_BAD_ARGS });
    expect(t.calls).toEqual([]);
  });

  it("passes good arguments on as they are", async () => {
    const t = setup();
    expect(await t.call(CHAT_IPC.send, HOME, ID, "hello")).toEqual({ ok: true, value: undefined });
    await t.call(CHAT_IPC.decide, HOME, ID, "5b1f0a4e-1111-2222-3333-444455556666", { kind: "reject", feedback: "not now" });
    await t.call(CHAT_IPC.answer, HOME, ID, "q1", "the blue one", true);
    expect(await t.call(CHAT_IPC.setPermissionMode, HOME, ID, "assisted")).toEqual({ ok: true, value: { requested: "assisted", mode: "assisted", applied: true } });
    await t.call(CHAT_IPC.stop, HOME, ID);
    expect(t.calls).toEqual([
      ["send", ID, "hello"], ["decide", ID, "5b1f0a4e-1111-2222-3333-444455556666", { kind: "reject", feedback: "not now" }], ["answer", ID, "q1", "the blue one", true], ["stop", ID],
    ]);
  });

  it("answers a refusal in its own plain sentence and anything else without the raw error", async () => {
    const t = setup({ send: async () => { throw new ChatUnavailable("Chats aren't turned on."); }, stop: async () => { throw new Error("ECONNRESET at net.js:42"); } });
    expect(await t.call(CHAT_IPC.send, HOME, ID, "hi")).toEqual({ ok: false, why: "Chats aren't turned on." });
    const failed = await t.call(CHAT_IPC.stop, HOME, ID) as { ok: boolean; why: string };
    expect(failed.ok).toBe(false);
    expect(failed.why).not.toContain("net.js");
    expect(t.warnings).toEqual(["chat.ipc_failed"]);
  });
});
