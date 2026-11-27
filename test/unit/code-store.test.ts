/**
 * The coding window's store (app/renderer/code/store.ts) and what it reads from the SDK's list methods (catalog.ts):
 * main's list and rows, the pending table as the one source of what waits, envelopes with their gaps, attach with its
 * catch-up, drafts and the sidebar's groups.
 */
import { describe, expect, it } from "vitest";
import type { CodeAttached, CodePendingRequest, CodeProject, CodeSessionRow } from "../../app/shared/code";
import { agentsFrom, modelsFrom, queueFrom } from "../../app/renderer/code/catalog";
import {
  EMPTY_STATE, archivedCount, attached, detached, envelope, listed, pendingOf, projectAdded, requestChanged, rowChanged, sendDone, sent, setDraft,
  setNote, setQuery, setArchivedView, sidebarGroups, statusOf, type CodeState,
} from "../../app/renderer/code/store";

const project = (id: string, name: string): CodeProject => ({ id, name, folder: `/home/me/${name}` });
const row = (o: Partial<CodeSessionRow> & { id: string }): CodeSessionRow => ({
  projectId: "p1", name: o.id, folder: "/home/me/app", isolation: "folder", permissionMode: "manual", agentMode: "interactive", open: true, busy: false,
  pending: 0, unread: 0, pinned: false, archived: false, createdBy: "user", createdAt: 1, updatedAt: 1, ...o,
});
const base = (): CodeState => listed(EMPTY_STATE, {
  projects: [project("p1", "app"), project("p2", "notes")],
  sessions: [row({ id: "a", updatedAt: 5 }), row({ id: "b", pinned: true, updatedAt: 1 }), row({ id: "c", projectId: "p2", archived: true }), row({ id: "d", projectId: "gone" })],
});
let n = 0;
const env = (sessionId: string, seq: number, type: string, data: unknown) => ({ sessionId, seq, event: { id: `x${++n}`, timestamp: "t", type, data } });
const attach = (rowOf: CodeSessionRow, events: ReturnType<typeof env>[], pending: CodePendingRequest[] = [], seq = events.at(-1)?.seq ?? 0): CodeAttached => ({ row: rowOf, events, pending, seq });

describe("the coding window's store", () => {
  it("lists projects and sessions as main says, and groups the sidebar: pinned first, archived apart, an unknown project's on their own", () => {
    const s = base();
    expect(s.listed).toBe(true);
    const groups = sidebarGroups(s);
    expect(groups.map(g => [g.projectId, g.rows.map(r => r.id)])).toEqual([["p1", ["b", "a"]], ["p2", []], ["", ["d"]]]);
    expect(archivedCount(s)).toBe(1);
    expect(sidebarGroups(setArchivedView(s, true)).map(g => [g.projectId, g.rows.map(r => r.id)])).toEqual([["p2", ["c"]]]);
    // A search matches names, folders and branches, and drops groups with nothing to show.
    expect(sidebarGroups(setQuery(s, "notes")).map(g => g.projectId)).toEqual([]);
    expect(sidebarGroups(setQuery(rowChanged(s, row({ id: "e", branch: "ember/fix-login", isolation: "worktree" })), "fix-login")).map(g => g.rows.map(r => r.id))).toEqual([["e"]]);
  });

  it("takes a changed row and a removed one; a removed session's requests, transcript and draft go with it", () => {
    let s = attached(base(), "a", attach(row({ id: "a" }), [env("a", 1, "user.message", { content: "hi" })]));
    s = setDraft(s, "a", { text: "half", attachments: [] });
    s = requestChanged(s, { sessionId: "a", requestId: "r", kind: "permission", data: {}, choices: ["approve-once", "reject"], openedAt: 1 });
    s = rowChanged(s, { removed: "a" });
    expect(s.sessions.byId.a).toBeUndefined();
    expect([s.transcripts.a, s.drafts.a, s.pending.r]).toEqual([undefined, undefined, undefined]);
    expect(rowChanged(s, row({ id: "new" })).sessions.order[0]).toBe("new");
    expect(projectAdded(s, project("p3", "site")).projects.order[0]).toBe("p3");
  });

  it("says a session needs you from main's pending table, then working, then unread", () => {
    let s = base();
    expect(statusOf(s, row({ id: "a" }))).toBe("idle");
    expect(statusOf(s, row({ id: "a", unread: 2 }))).toBe("unread");
    expect(statusOf(s, row({ id: "a", busy: true, unread: 2 }))).toBe("working");
    s = requestChanged(s, { sessionId: "a", requestId: "r", kind: "user-input", data: {}, openedAt: 2 });
    expect(statusOf(s, row({ id: "a", busy: true }))).toBe("needs-you");
    expect(pendingOf(s, "a").map(p => p.requestId)).toEqual(["r"]);
    s = requestChanged(s, { resolved: "r", sessionId: "a", by: "companion" });
    expect(pendingOf(s, "a")).toEqual([]);
  });

  it("applies envelopes only to attached sessions, and asks to attach again after a gap", () => {
    let s = base();
    expect(envelope(s, env("a", 1, "user.message", { content: "x" }))).toBe(s);
    s = attached(s, "a", attach(row({ id: "a" }), [env("a", 1, "user.message", { content: "x" })]));
    const e2 = env("a", 2, "assistant.message", { messageId: "m", content: "y" });
    const next = envelope(s, e2);
    expect(next.transcripts.a.items).toHaveLength(2);
    expect(envelope(next, e2)).toBe(next);
    const gap = envelope(next, env("a", 4, "abort", {}));
    expect(gap.resync).toEqual(["a"]);
    // The catch-up: the events since the window's last seq; the resync is done.
    const caught = attached(gap, "a", attach(row({ id: "a" }), [env("a", 3, "user.message", { content: "z" }), env("a", 4, "abort", {})]), 2);
    expect(caught.resync).toEqual([]);
    expect(caught.transcripts.a.items.map(i => i.kind)).toEqual(["user", "assistant", "user", "note"]);
  });

  it("draws the whole history afresh when main says the attach is a reset, whatever seq the window had", () => {
    let s = attached(base(), "a", attach(row({ id: "a" }), [env("a", 1, "user.message", { content: "old" }), env("a", 2, "user.message", { content: "gone" })]));
    s = attached(s, "a", { ...attach(row({ id: "a" }), [env("a", 1, "user.message", { content: "old" })], [], 9), reset: true } as never, 2);
    expect(s.transcripts.a.items.map(i => i.kind === "user" && i.text)).toEqual(["old"]);
    expect(s.transcripts.a.lastSeq).toBe(9);
  });

  it("takes main's word on whether a turn runs, and on what still waits, when it attaches", () => {
    const history = [env("a", 1, "assistant.turn_start", { turnId: "t" }), env("a", 2, "permission.requested", { requestId: "old" }), env("a", 3, "user_input.requested", { requestId: "live" })];
    const s = attached(base(), "a", attach(row({ id: "a", busy: false }), history, [{ sessionId: "a", requestId: "live", kind: "user-input", data: { question: "?" }, openedAt: 3 }, { sessionId: "a", requestId: "replayed", kind: "sampling", data: {}, openedAt: 4 }]));
    const t = s.transcripts.a;
    expect(t.busy).toBe(false);
    const requests = t.items.filter(i => i.kind === "request");
    expect(requests.map(r => [r.kind === "request" && r.requestId, r.kind === "request" && r.done])).toEqual([["old", true], ["live", false], ["replayed", false]]);
    expect(Object.keys(s.pending).sort()).toEqual(["live", "replayed"]);
    expect(detached(s, "a").transcripts.a).toBeUndefined();
  });

  it("shows a message as sent at once and keeps main's answer to it", () => {
    let s = attached(base(), "a", attach(row({ id: "a" }), []));
    s = sent(s, "a", "k1", "go", [{ type: "file", path: "/x/y.ts" }, { type: "blob", data: "AA", mimeType: "image/png" }], "enqueue");
    expect(s.transcripts.a.items[0]).toMatchObject({ kind: "user", text: "go", attachments: ["y.ts", "image"], delivery: "enqueue", local: true });
    s = sendDone(s, "a", "k1", { ok: false, reason: "No." });
    expect(s.transcripts.a.items[0]).toMatchObject({ problem: "No." });
    expect(setNote(s, "a", "agent", "")).toBe(s);
    expect(setNote(s, "a", "agent", "x").notes.a).toEqual({ agent: "x" });
    expect(setDraft(setDraft(s, "a", { text: "x", attachments: [] }), "a", { text: "", attachments: [] }).drafts.a).toBeUndefined();
  });
});

describe("what the SDK's lists say, read", () => {
  it("reads models with their reasoning efforts and policy, agents a person may pick, and the queue", () => {
    expect(modelsFrom({ models: [
      { id: "a", name: "A", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", capabilities: {} },
      { id: "b", name: "B", capabilities: { supports: { reasoningEffort: true } }, policy: { state: "disabled" } },
      { name: "no id" },
    ] })).toEqual([
      { id: "a", name: "A", efforts: ["low", "high"], defaultEffort: "low", enabled: true },
      { id: "b", name: "B", efforts: ["low", "medium", "high"], enabled: false },
    ]);
    expect(modelsFrom(null)).toEqual([]);
    expect(agentsFrom({ agents: [{ id: "r", name: "r", displayName: "Reviewer" }, { id: "s", name: "s", userInvocable: false }] })).toEqual([{ id: "r", name: "Reviewer" }]);
    expect(queueFrom({ items: [{ id: "q1", displayText: "next", kind: "message" }, { displayText: "no id" }], steeringMessages: ["now", 3] })).toEqual({ items: [{ id: "q1", text: "next", kind: "message" }], steering: ["now"] });
  });
});
