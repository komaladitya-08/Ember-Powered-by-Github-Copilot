/**
 * Storage, export and handoff for coding sessions (app/main/code/hub.ts `prune` and `exportSession`, export.ts,
 * app/renderer/code/customise-storage.ts and copy-storage.ts): old sessions found by the runtime's own dry run, never an
 * open or pinned one, then deleted as Delete deletes one; a transcript saved as Markdown only where main's save dialog
 * says and never in Ember's data, redacted, without tool output; the words, pinned. Shapes from the bundled runtime
 * (test/fixtures/code-window/real-shapes.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import { CodeHub, type CodeHubDeps } from "../../app/main/code/hub";
import { CODE_REFUSALS } from "../../app/main/code/guards";
import { exportName, transcriptMarkdown } from "../../app/main/code/export";
import { SessionIndex, indexFile } from "../../app/main/code/session-index";
import type { ChatPolicy } from "../../app/main/agent/chat-policy";
import type { AuditEntry } from "../../app/main/policy/audit";
import { bytesWords, handoffDraft, pruneQuestion } from "../../app/renderer/code/copy-storage";
import { daysFrom, sizesFrom } from "../../app/renderer/code/customise-storage";
import { REAL } from "../fixtures/code-window/real-shapes";

const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };
const HISTORY = [
  { type: "user.message", data: { content: "Fix the login with token ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  { type: "assistant.reasoning", data: { content: "secret thoughts" } },
  { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "bash", arguments: { command: "npm test ```" } } },
  { type: "tool.execution_complete", data: { toolCallId: "c1", success: false, result: { content: "FILE CONTENTS" } } },
  { type: "tool.execution_start", data: { toolCallId: "c2", toolName: "view", arguments: { path: "/w/a.ts" } } },
  { type: "assistant.message", data: { content: "Fixed." } },
  { type: "assistant.message", data: { content: "a sub-agent's words", parentToolCallId: "t" } },
];

describe("a session's transcript as Markdown", () => {
  it("keeps the messages and what each tool did, never reasoning, a tool's output or a sub-agent's words", () => {
    const md = transcriptMarkdown(HISTORY, { title: "Fix login", folder: "/w", at: new Date("2026-11-28T10:00:00Z") });
    expect(md).toContain("# Fix login");
    expect(md).toContain("## You\n\nFix the login");
    expect(md).toContain("> Copilot ran a command (bash):\n\n````sh\nnpm test ```\n````");
    expect(md).toContain("> bash didn't finish.");
    expect(md).toContain("> Copilot used view on /w/a.ts.");
    expect(md).toContain("## Copilot\n\nFixed.");
    for (const not of ["secret thoughts", "FILE CONTENTS", "sub-agent"]) expect(md).not.toContain(not);
  });
  it("names the file from the session's title, safely", () => {
    expect(exportName("Fix: the ../login/ redirect")).toBe("Fix the login redirect.md");
    expect(exportName("")).toBe("Coding session.md");
  });
});

describe("Storage's words and readers", () => {
  it("reads the runtime's sizes, largest first, and days typed", () => {
    expect(sizesFrom({ sizes: { a: 10, b: 2048, c: "x" } })).toEqual([{ id: "b", bytes: 2048 }, { id: "a", bytes: 10 }]);
    expect(sizesFrom(REAL.sizes)).toEqual([{ id: "e890b420-4884-43df-a9e5-a2bc48ce003d", bytes: 255720 }]);
    expect([daysFrom("30"), daysFrom("0"), daysFrom("2.5"), daysFrom(" 7 "), daysFrom("4000")]).toEqual([30, null, null, 7, null]);
    expect([bytesWords(900), bytesWords(255720), bytesWords(5 * 1024 * 1024 * 1024)]).toEqual(["900 bytes", "250 KB", "5 GB"]);
    expect(pruneQuestion(2, "3 MB")).toBe("Delete 2 sessions and their history (3 MB)? This can't be undone.");
    expect(handoffDraft(REAL.handoffSummary.summary)).toBe(`Carry on from this summary of an earlier session:\n\n${REAL.handoffSummary.summary}`);
  });
});

let dir = "", userData = "", work = "";
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-storage-")));
  userData = path.join(dir, "userdata");
  work = path.join(dir, "work");
  for (const d of [userData, work]) fs.mkdirSync(d);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function harness(over: Partial<CodeHubDeps> = {}) {
  const pruned: unknown[] = [];
  const deleted: string[] = [];
  let candidates: string[] = [];
  const rpc = {
    options: { update: async () => ({ success: true }) },
    permissions: { setMode: async () => ({ success: true, mode: "manual" }), getMode: async () => ({ mode: "manual" }), locations: { resolve: async () => ({ locationKey: "k" }) }, pendingRequests: async () => ({ items: [] }) },
    mode: { get: async () => "interactive" }, name: { get: async () => ({ name: "" }) }, model: { getCurrent: async () => ({}) }, cancelAllBackgroundAgents: async () => ({}),
  };
  const client = {
    rpc: {
      sandbox: { getHostSupport: async () => ({ supported: false, capabilities: [] }) },
      sessions: {
        readPersistedEvents: async () => ({ events: HISTORY, hasMore: false }),
        pruneOld: async (p: { excludeSessionIds?: string[] }) => { pruned.push(p); return { deleted: [], candidates: candidates.filter(c => !(p.excludeSessionIds ?? []).includes(c)), skipped: [], freedBytes: 0, dryRun: true }; },
        getSizes: async () => ({ sizes: Object.fromEntries(candidates.map(c => [c, 1024])) }),
      },
    },
    createSession: async (c: SessionConfig) => ({ sessionId: c.sessionId, rpc, send: async () => "m", abort: async () => undefined, disconnect: async () => undefined }),
    resumeSession: async (id: string) => ({ sessionId: id, rpc, send: async () => "m", abort: async () => undefined, disconnect: async () => undefined }),
    listSessions: async () => [], getSessionMetadata: async () => undefined, deleteSession: async (id: string) => { deleted.push(id); },
  } as unknown as CopilotClient;
  const audit: AuditEntry[] = [];
  let save: string | null = path.join(dir, "out.md");
  const deps: CodeHubDeps = {
    hasConsent: () => true, enabled: () => true, policy: () => OPEN, vaultFilled: () => false,
    access: () => ({ provider: { type: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" }, service: "user" }),
    client: async () => client, userData, runtimeHome: () => path.join(dir, "userdata-code"), protectedPaths: () => [userData], place: () => ({ os: "linux", home: dir }),
    audit: () => ({ write: e => audit.push(e) }), emit: () => undefined, pickFolder: async () => work, pickFiles: async () => [],
    pickSaveFile: async () => save,
    git: async () => { throw new Error("no git"); },
    index: new SessionIndex(indexFile(path.join(userData, "code"))).load(),
    ...over,
  };
  const hub = new CodeHub(deps);
  return { hub, audit, pruned, deleted, setCandidates: (c: string[]) => { candidates = c; }, saveTo: (p: string | null) => { save = p; } };
}

describe("deleting old sessions", () => {
  it("lists what the runtime's dry run finds, keeping open and pinned sessions out, then deletes each as Delete does", async () => {
    const h = harness();
    const a = await h.hub.dispatch({ type: "create", options: {} }, "user");
    const b = await h.hub.dispatch({ type: "create", options: {} }, "user");
    const c = await h.hub.dispatch({ type: "create", options: {} }, "user");
    if (!a.ok || !b.ok || !c.ok) throw new Error("not started");
    await h.hub.dispose();
    await h.hub.dispatch({ type: "update", sessionId: c.value.id, change: { pinned: true } }, "user");
    await h.hub.dispatch({ type: "attach", sessionId: b.value.id }, "user");
    h.setCandidates([a.value.id, b.value.id, c.value.id]);
    const dry = await h.hub.dispatch({ type: "prune", olderThanDays: 30, dryRun: true }, "user");
    expect(dry).toEqual({ ok: true, value: { sessions: [{ id: a.value.id, name: "", bytes: 1024 }], bytes: 1024, deleted: false } });
    expect(h.pruned.at(-1)).toMatchObject({ olderThanDays: 30, dryRun: true, includeNamed: true });
    expect(h.deleted).toEqual([]);
    const done = await h.hub.dispatch({ type: "prune", olderThanDays: 30, dryRun: false }, "user");
    expect(done.ok && done.value.deleted).toBe(true);
    // Never the runtime's own delete pass: every call was a dry run, and the session went through Delete.
    expect(h.pruned.every(p => (p as { dryRun: boolean }).dryRun)).toBe(true);
    expect(h.deleted).toEqual([a.value.id]);
    expect(h.audit).toContainEqual(expect.objectContaining({ phase: "prune", by: "user", removed: 1 }));
    expect((await h.hub.dispatch({ type: "prune", olderThanDays: 30, dryRun: true }, "companion")).ok).toBe(false);
  });
});

describe("exporting a session", () => {
  it("writes the redacted transcript where main's save dialog says, 0600, and audits its size only", async () => {
    const h = harness();
    const a = await h.hub.dispatch({ type: "create", options: { name: "Fix login" } }, "user");
    if (!a.ok) throw new Error(a.reason);
    await h.hub.dispose();
    expect(await h.hub.dispatch({ type: "exportSession", sessionId: a.value.id }, "user")).toEqual({ ok: true });
    const file = path.join(dir, "out.md");
    const md = fs.readFileSync(file, "utf8");
    expect(md).toContain("## Copilot\n\nFixed.");
    expect(md).not.toContain("ghu_aaaaaaaa");
    // Windows has no POSIX modes: a file there reports 0666 whatever it was created with.
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(h.audit).toContainEqual(expect.objectContaining({ phase: "export", by: "user", chars: md.length }));
    expect(JSON.stringify(h.audit)).not.toContain(file);
  });

  it("refuses a place in Ember's data, a cancelled dialog and the companion", async () => {
    const h = harness();
    const a = await h.hub.dispatch({ type: "create", options: {} }, "user");
    if (!a.ok) throw new Error(a.reason);
    h.saveTo(path.join(userData, "x.md"));
    expect(await h.hub.dispatch({ type: "exportSession", sessionId: a.value.id }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.emberData });
    expect(fs.existsSync(path.join(userData, "x.md"))).toBe(false);
    h.saveTo(null);
    expect(await h.hub.dispatch({ type: "exportSession", sessionId: a.value.id }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.picked });
    expect((await h.hub.dispatch({ type: "exportSession", sessionId: a.value.id }, "companion")).ok).toBe(false);
  });
});
