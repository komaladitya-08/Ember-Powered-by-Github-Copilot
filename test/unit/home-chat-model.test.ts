/**
 * Home's native chats as a view model (app/renderer/home/chat-model.ts), its diff rows (chat-diff.ts) and its words
 * (copy.ts): built only from main's ChatEvents and what Home sent, a card offers exactly the SDK's choices and becomes
 * a record of what the SDK says was decided and by whom. Pure: no DOM, no IPC.
 */
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatSessionRow } from "../../app/shared/chat";
import {
  CHAT_OUTPUT_KEEP, NO_CHATS, chatAnswered, chatAnswering, chatDecideFailed, chatDeciding, chatEvent, chatList, chatModeSet, chatOpened,
  chatRowsInOrder, chatSendFailed, chatSent, diffFor, pendingOf, toolArgs, toolShape, type ChatCardRow, type ChatState, type ChatToolRow,
} from "../../app/renderer/home/chat-model";
import { diffRows } from "../../app/renderer/shared/diff-rows";
import {
  chatAgentName, chatAsksSaid, chatCardTitle, chatDecisionLabel, chatDiffSummary, chatModeRefused, chatPermissionHint, chatPermissionName,
  chatRecord, chatReplySaid, chatRowLabel, chatRowState, chatTitle, chatToolEnd, chatToolTitle, folderTail,
} from "../../app/renderer/home/copy";

const row = (over: Partial<ChatSessionRow> = {}): ChatSessionRow => ({ id: "ember-chat-1", name: "", folder: "/home/me/work/app", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: true, ...over });
/** An event as main sends it, without its session (each kind keeps its own fields). */
type Ev = ChatEvent extends infer T ? (T extends unknown ? Omit<T, "session"> : never) : never;
let n = 0;
const k = () => `k${++n}`;
const run = (s: ChatState, ...events: Ev[]) => events.reduce((acc, e) => chatEvent(acc, { session: "ember-chat-1", ...e } as ChatEvent, k()), s);
const opened = () => chatOpened(NO_CHATS, row());
const rows = (s: ChatState) => s.sessions["ember-chat-1"].rows;

describe("the chat view model", () => {
  it("lists main's sessions in its order, keeps each transcript, and shows the one opened", () => {
    let s = chatList(NO_CHATS, [row(), row({ id: "ember-chat-kept", open: false, name: "Old chat" })]);
    expect(chatRowsInOrder(s).map(r => r.id)).toEqual(["ember-chat-1", "ember-chat-kept"]);
    s = chatSent(chatOpened(s, row()), "ember-chat-1", "hello", "y1");
    s = chatList(s, [row({ busy: true }), row({ id: "ember-chat-kept", open: false })]);
    expect(rows(s)).toEqual([{ kind: "you", key: "y1", text: "hello" }]);
    expect(s.shown).toBe("ember-chat-1");
  });

  it("streams Copilot's words into one row the whole message settles, and keeps reasoning apart", () => {
    let s = chatSent(opened(), "ember-chat-1", "hi", "y1");
    expect(s.sessions["ember-chat-1"].row.busy).toBe(true);
    s = run(s, { type: "reasoning-delta", reasoningId: "r1", text: "Think" }, { type: "reasoning-delta", reasoningId: "r1", text: "ing" },
      { type: "text-delta", messageId: "m1", text: "Hel" }, { type: "text-delta", messageId: "m1", text: "lo" });
    expect(rows(s).slice(1)).toMatchObject([{ kind: "reasoning", text: "Thinking" }, { kind: "reply", text: "Hello", streaming: true }]);
    s = run(s, { type: "message", messageId: "m1", text: "Hello there" }, { type: "idle", aborted: false });
    expect(rows(s)[2]).toMatchObject({ kind: "reply", text: "Hello there", streaming: false });
    expect(s.sessions["ember-chat-1"].row.busy).toBe(false);
    // A message of tool calls alone adds no row.
    expect(rows(run(s, { type: "message", messageId: "m2", text: "" })).length).toBe(3);
  });

  it("draws a command with its live output, its end and exit code, and who let it run", () => {
    let s = run(opened(), { type: "tool-start", toolCallId: "t1", tool: "bash", args: JSON.stringify({ command: "ls -la", description: "list" }) },
      { type: "tool-output", toolCallId: "t1", text: "a.txt\n" }, { type: "tool-output", toolCallId: "t1", text: "b.txt\n" });
    expect(rows(s)[0]).toMatchObject({ kind: "tool", shape: "shell", command: "ls -la", output: "a.txt\nb.txt\n", state: "running" });
    s = run(s, { type: "tool-complete", toolCallId: "t1", tool: "bash", success: false, exitCode: 2, fileEdits: [], approvedBy: "user", result: "ignored" });
    const t = rows(s)[0] as ChatToolRow;
    expect(t).toMatchObject({ state: "failed", exitCode: 2, approvedBy: "user", output: "a.txt\nb.txt\n" });
    expect(chatToolTitle(t)).toBe("Command failed");
    expect(chatToolEnd(t)).toBe("Failed, exit code 2. You allowed it.");
    expect(chatToolEnd({ state: "done", exitCode: 0, approvedBy: "allow-all" })).toBe("Finished, exit code 0. Allow everything is on, so nothing asked.");
    expect(chatToolEnd({ state: "done", approvedBy: "judge" })).toBe("Finished. The second model's check allowed it.");
  });

  it("keeps a command's output bounded, from its end", () => {
    let s = run(opened(), { type: "tool-start", toolCallId: "t1", tool: "bash", args: "{\"command\":\"yes\"}" });
    s = run(s, { type: "tool-output", toolCallId: "t1", text: "x".repeat(CHAT_OUTPUT_KEEP) }, { type: "tool-output", toolCallId: "t1", text: "END" });
    const t = rows(s)[0] as ChatToolRow;
    expect(t.output.length).toBe(CHAT_OUTPUT_KEEP);
    expect(t.output.endsWith("END")).toBe(true);
    expect(t.outputCut).toBe(true);
  });

  it("tells tools apart by name and by what they were given", () => {
    expect(toolShape("bash", {})).toBe("shell");
    expect(toolShape("edit", toolArgs("{\"path\":\"/w/a.ts\"}"))).toBe("edit");
    expect(toolShape("web_fetch", {})).toBe("fetch");
    expect(toolShape("grep", toolArgs("{\"pattern\":\"x\"}"))).toBe("other");
    expect(toolArgs("{cut")).toEqual({});
    expect(chatToolTitle({ shape: "fetch", tool: "web_fetch", url: "https://example.com/", state: "done" })).toBe("Fetched https://example.com/");
    expect(chatToolTitle({ shape: "other", tool: "grep", state: "running" })).toBe("Using grep…");
    expect(chatToolTitle({ shape: "edit", tool: "edit", path: "/home/me/work/src/a.ts", state: "done" })).toBe("Changed src/a.ts");
  });

  const write: Ev = {
    type: "permission-requested", requestId: "p1", toolCallId: "t2", request: { kind: "write", file: "/w/a.ts", intention: "Fix it", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    managed: false, choices: ["approve-once", "approve-for-session", "reject"], truncated: false,
  };

  it("holds a permission card with exactly the SDK's choices, counts it as waiting, and records the SDK's decision and who made it", () => {
    let s = run(opened(), write);
    const card = rows(s)[0] as ChatCardRow;
    expect(card.choices).toEqual(["approve-once", "approve-for-session", "reject"]);
    expect(card.choices.map(c => chatDecisionLabel(c, "write"))).toEqual(["Allow once", "Allow for this chat", "Don't allow"]);
    expect(s.sessions["ember-chat-1"].row.pending).toBe(1);
    s = chatDeciding(s, "ember-chat-1", "p1", "approve-for-session");
    expect(rows(s)[0]).toMatchObject({ state: "sending", chosen: "approve-for-session" });
    expect(pendingOf(s.sessions["ember-chat-1"])).toBe(1);
    s = run(s, { type: "permission-resolved", requestId: "p1", kind: "write", decision: "approved-for-session", by: "user" });
    const done = rows(s)[0] as ChatCardRow;
    expect(done.state).toBe("resolved");
    expect(chatRecord(done.outcome!.decision, done.outcome!.by, done.chosen, "write")).toBe("Allowed for this chat, by you.");
    expect(s.sessions["ember-chat-1"].row.pending).toBe(0);
    // The edit's row shows the diff the request carried, once the card is a record.
    s = run(s, { type: "tool-start", toolCallId: "t2", tool: "edit", args: "{\"path\":\"/w/a.ts\"}" });
    expect(diffFor(s.sessions["ember-chat-1"], rows(s)[1] as ChatToolRow)).toBe("@@ -1 +1 @@\n-old\n+new\n");
  });

  it("puts a card's buttons up again with main's sentence when a decision didn't go through", () => {
    let s = chatDeciding(run(opened(), write), "ember-chat-1", "p1", "approve-once");
    s = chatDecideFailed(s, "ember-chat-1", "p1", "That chat isn't open.");
    expect(rows(s)[0]).toMatchObject({ state: "waiting", problem: "That chat isn't open." });
    expect((rows(s)[0] as ChatCardRow).chosen).toBeUndefined();
  });

  it("records what the SDK's judge approved, which never reached Home as a card, and nothing for its own rules", () => {
    const s = run(opened(), { type: "permission-resolved", requestId: "j1", kind: "shell", decision: "approved", by: "judge" },
      { type: "permission-resolved", requestId: "r1", kind: "read", decision: "approved", by: "sdk" });
    expect(rows(s)).toHaveLength(1);
    const c = rows(s)[0] as ChatCardRow;
    expect(chatRecord(c.outcome!.decision, c.outcome!.by)).toBe("Allowed, by the second model's check.");
    expect(s.sessions["ember-chat-1"].row.pending).toBe(0);
  });

  it("says a stopped chat's records and withdrawn questions in words", () => {
    let s = run(opened(), { type: "user-input-requested", requestId: "q1", question: "Which file?", choices: ["a", "b"], allowFreeform: true });
    s = run(s, { type: "permission-resolved", requestId: "x", kind: "shell", decision: "denied-interactively-by-user", by: "stop" }, { type: "idle", aborted: true });
    expect(rows(s).map(r => r.kind)).toEqual(["question", "stopped"]);
    expect(rows(s)[0]).toMatchObject({ state: "withdrawn" });
    expect(chatRecord("denied-interactively-by-user", "stop")).toBe("Not allowed, because the chat was stopped.");
    expect(chatRecord("denied-interactively-by-user", "user", "reject")).toBe("Not allowed, by you.");
    expect(chatRecord("approved", "user", "approve-once")).toBe("Allowed once, by you.");
    expect(chatRecord("approved-permanently", "user", "approve-permanently", "url")).toBe("Always allowed this site, by you.");
    expect(chatRecord("cancelled", "sdk")).toBe("Cancelled: the request ended before a decision.");
  });

  it("answers the model's question once main took it, and puts it back with main's sentence otherwise", () => {
    let s = run(opened(), { type: "user-input-requested", requestId: "q1", question: "Which file?", choices: ["a", "b"], allowFreeform: false });
    s = chatAnswered(chatAnswering(s, "ember-chat-1", "q1", "a"), "ember-chat-1", "q1");
    expect(rows(s)[0]).toMatchObject({ state: "answered", answer: "a" });
    let t = run(opened(), { type: "user-input-requested", requestId: "q2", question: "Name?", allowFreeform: true });
    t = chatAnswered(chatAnswering(t, "ember-chat-1", "q2", "x"), "ember-chat-1", "q2", "That question isn't waiting any more.");
    expect(rows(t)[0]).toMatchObject({ state: "waiting", problem: "That question isn't waiting any more." });
  });

  it("shows the mode in force, and notes a change that wasn't applied with which mode is in force", () => {
    let s = chatModeSet(opened(), "ember-chat-1", "permission", { requested: "allow-all", mode: "manual", applied: false });
    expect(s.sessions["ember-chat-1"].row.permissionMode).toBe("manual");
    expect(s.sessions["ember-chat-1"].notes.permission).toEqual({ requested: "allow-all", mode: "manual" });
    expect(chatModeRefused("permission", "allow-all", "manual")).toBe("“Allow everything (allow-all)” isn't available for this chat, so “Ask every time (manual)” is still in force: your organisation's policy or the model service doesn't allow it.");
    s = chatModeSet(s, "ember-chat-1", "permission", { requested: "assisted", mode: "assisted", applied: true });
    expect(s.sessions["ember-chat-1"].notes.permission).toBeUndefined();
    s = run(s, { type: "mode-changed", permissionMode: "assisted", agentMode: "plan" }, { type: "title-changed", title: "Fix the build" });
    expect(s.sessions["ember-chat-1"].row).toMatchObject({ agentMode: "plan", name: "Fix the build" });
  });

  it("keeps a message that didn't go, with main's sentence, and ends the turn", () => {
    let s = chatSent(opened(), "ember-chat-1", "hello", "y1");
    s = chatSendFailed(s, "ember-chat-1", "y1", "Connect Ember to Copilot first.");
    expect(rows(s)[0]).toEqual({ kind: "you", key: "y1", text: "hello", problem: "Connect Ember to Copilot first." });
    expect(s.sessions["ember-chat-1"].row.busy).toBe(false);
  });

  it("shows an error as the one plain sentence main sent", () => {
    const s = run(opened(), { type: "error", message: "Copilot couldn't answer just now. Try again in a moment." });
    expect(rows(s)).toEqual([{ kind: "problem", key: expect.any(String), text: "Copilot couldn't answer just now. Try again in a moment." }]);
  });
});

describe("a write request's diff as rows", () => {
  it("numbers lines and tells added from removed by kind, not by colour", () => {
    const d = diffRows("--- a/x.ts\n+++ b/x.ts\n@@ -3,3 +3,3 @@ fn\n keep\n-old\n+new\n+more\n\\ No newline at end of file\n");
    expect(d.rows.map(r => [r.kind, r.text, r.oldNo, r.newNo])).toEqual([
      ["file", "--- a/x.ts", undefined, undefined], ["file", "+++ b/x.ts", undefined, undefined], ["hunk", "@@ -3,3 +3,3 @@ fn", undefined, undefined],
      ["ctx", "keep", 3, 3], ["del", "old", 4, undefined], ["add", "new", undefined, 4], ["add", "more", undefined, 5], ["note", "\\ No newline at end of file", undefined, undefined],
    ]);
    expect([d.added, d.removed, d.more]).toEqual([2, 1, 0]);
    expect(chatDiffSummary(d.added, d.removed)).toBe("2 lines added, 1 line removed");
  });

  it("counts what it leaves out past its limit", () => {
    const d = diffRows(`@@ -1,0 +1,5 @@\n${"+x\n".repeat(5)}`, 3);
    expect(d.rows).toHaveLength(3);
    expect(d.more).toBe(3);
    expect(d.added).toBe(5);
  });
});

describe("the chats' words", () => {
  it("name the SDK's modes in plain words, keeping its own term", () => {
    expect(["manual", "assisted", "allow-all"].map(chatPermissionName)).toEqual(["Ask every time (manual)", "Let a second model check (assisted)", "Allow everything (allow-all)"]);
    expect(["interactive", "plan", "autopilot"].map(chatAgentName)).toEqual(["Step by step (interactive)", "Plan first (plan)", "Keep going (autopilot)"]);
    for (const m of ["manual", "assisted", "allow-all"]) expect(chatPermissionHint(m)).toMatch(/^Copilot |^A second model/);
  });

  it("name the SDK's decisions, and never offer one it didn't", () => {
    expect(chatDecisionLabel("approve-read-only-for-session", "read")).toBe("Allow reading here for this chat");
    expect(chatDecisionLabel("approve-permanently", "url")).toBe("Always allow this site");
    expect(chatDecisionLabel("approve-for-session", "url")).toBe("Allow this site for this chat");
    expect(chatCardTitle({ kind: "mcp", tool: "search", server: "docs" })).toBe("Use “search” from “docs”?");
  });

  it("show a folder as its last one or two parts, and a chat by its name or its folder", () => {
    expect(folderTail("/home/me/work/app")).toBe("work/app");
    expect(folderTail("C:\\Users\\me\\app")).toBe("me/app");
    expect(folderTail("/app")).toBe("app");
    expect(chatTitle({ name: "", folder: "/home/me/work/app" })).toBe("Chat in work/app");
    expect(chatRowState({ busy: true, pending: 2, open: true })).toBe("Needs you: 2 requests");
    expect(chatRowLabel({ name: "Fix", folder: "/w/app", busy: true, pending: 0, open: true })).toBe("Fix, in w/app. Working");
    expect(chatRowLabel({ name: "Old", folder: "/w/app", busy: false, pending: 0, open: false })).toBe("Old, in w/app. Kept from before");
  });

  it("say a card and a reply without Ember's name (said into the wake word's microphone)", () => {
    for (const line of [chatAsksSaid("Run a command?", "Chat in work/app"), chatReplySaid(`Done.\n${"x".repeat(500)}`)]) expect(line).not.toMatch(/Ember/);
    expect(chatReplySaid(`a ${"x".repeat(500)}`).length).toBeLessThan(430);
  });

  it("use straight apostrophes, curly double quotes and British spelling", () => {
    const all = [chatModeRefused("agent", "plan", "interactive"), chatPermissionHint("allow-all"), chatAsksSaid("Change a file?", "x")].join(" ");
    expect(all).not.toMatch(/\u2019|"|organization/);
  });
});
