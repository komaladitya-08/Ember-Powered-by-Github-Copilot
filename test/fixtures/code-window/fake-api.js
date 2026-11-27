// A scripted window.emberCode for the coding window's renderer journeys and render checks (test/integration/
// code-window-renderer.test.ts; loaded with page.addInitScript({ path })). It plays a realistic Copilot SDK session:
// SDK events as the runtime sends them, numbered per session, with main's pending table and its RPC answers. Nothing
// is read, sent or kept. window.__fake drives and inspects it: `calls` (every command in order), `emit` (an event now),
// `gap()` (the next envelope skips a number), `wait(name)` (a promise for a named step of the script).
(() => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const calls = [];
  const listeners = { event: new Set(), row: new Set(), request: new Set() };
  const projects = [
    { id: "p-app", folder: "/home/me/work/app", name: "app", gitRoot: "/home/me/work/app", repository: "me/app", branch: "main" },
    { id: "p-notes", folder: "/home/me/notes", name: "notes" },
  ];
  const row = (o) => ({
    projectId: "p-app", folder: "/home/me/work/app", isolation: "folder", permissionMode: "manual", agentMode: "interactive", model: "gpt-5.5",
    open: true, busy: false, pending: 0, unread: 0, pinned: false, archived: false, sandbox: "on", createdBy: "user", createdAt: now - 3_600_000, updatedAt: now - 600_000, ...o,
  });
  const sessions = new Map([
    ["s-login", row({ id: "s-login", name: "Fix the login redirect", pinned: true, updatedAt: now - 120_000 })],
    ["s-vitest", row({ id: "s-vitest", name: "Upgrade the test runner", isolation: "worktree", branch: "ember/upgrade-vitest", unread: 3, updatedAt: now - 1_800_000 })],
    ["s-notes", row({ id: "s-notes", projectId: "p-notes", folder: "/home/me/notes", name: "Tidy the changelog", archived: true, open: false, updatedAt: now - 86_400_000 * 3 })],
  ]);
  /** Per session: the last seq sent, the kept (non-ephemeral) envelopes, the queue, steering. */
  const logs = new Map();
  const pending = new Map();
  let ids = 0, skip = false;
  const waiters = new Map();
  const reached = new Set();
  const step = (name) => { reached.add(name); for (const fn of waiters.get(name) ?? []) fn(); waiters.delete(name); };
  const log = (sid) => { if (!logs.has(sid)) logs.set(sid, { seq: 0, kept: [], queue: [], steering: [], attached: false }); return logs.get(sid); };
  const later = (ms, fn) => setTimeout(fn, ms * (window.__fakeSpeed ?? 1));
  const uuid = () => `e${(++ids).toString(36)}`;

  function emit(sid, type, data, extra = {}) {
    const l = log(sid);
    const event = { id: uuid(), parentId: null, timestamp: new Date(now + ids * 1000).toISOString(), type, data, ...extra };
    if (skip) { skip = false; l.seq++; l.kept.push({ sessionId: sid, seq: l.seq, event }); return; }
    const env = { sessionId: sid, seq: ++l.seq, event };
    if (!extra.ephemeral) l.kept.push(env);
    if (l.attached) for (const fn of listeners.event) fn(env);
  }
  function setRow(sid, change) {
    const r = { ...sessions.get(sid), ...change, updatedAt: now + ids * 1000 };
    sessions.set(sid, r);
    for (const fn of listeners.row) fn(r);
  }
  function openRequest(sid, kind, requestId, data, choices) {
    const p = { sessionId: sid, requestId, kind, data, ...(choices ? { choices } : {}), openedAt: now + ids };
    pending.set(requestId, p);
    setRow(sid, { pending: [...pending.values()].filter(x => x.sessionId === sid).length });
    for (const fn of listeners.request) fn(p);
    step(`request:${requestId}`);
  }
  function resolve(sid, requestId, by = "user") {
    pending.delete(requestId);
    for (const fn of listeners.request) fn({ resolved: requestId, sessionId: sid, by });
    setRow(sid, { pending: [...pending.values()].filter(x => x.sessionId === sid).length });
  }
  const eph = { ephemeral: true };

  // ── History of the pinned session, as the SDK's log keeps it ──
  (() => {
    const sid = "s-login";
    emit(sid, "session.start", { sessionId: sid, selectedModel: "gpt-5.5", reasoningEffort: "medium", copilotVersion: "1.0.97", producer: "ember", startTime: new Date(now - 3_600_000).toISOString(), version: 1 });
    emit(sid, "user.message", { content: "Why does signing in send people back to the home page instead of where they were?" });
    emit(sid, "assistant.turn_start", { turnId: "t0" });
    emit(sid, "tool.execution_start", { toolCallId: "h1", toolName: "grep", arguments: { pattern: "redirectTo", path: "src" } });
    emit(sid, "tool.execution_complete", { toolCallId: "h1", success: true, result: { content: "src/login.ts:42: const redirectTo = \"/\";" } });
    emit(sid, "tool.execution_start", { toolCallId: "h2", toolName: "view", arguments: { path: "/home/me/work/app/src/login.ts" } });
    emit(sid, "tool.execution_complete", { toolCallId: "h2", success: true, result: { content: "…" } });
    emit(sid, "assistant.message", { messageId: "hm1", content: "The login handler always redirects to `/`. It never reads the `next` parameter the sign-in page passes along:\n\n```ts\nconst redirectTo = \"/\";\nres.redirect(redirectTo);\n```\n\nI can make it read `next`, and only accept paths on this site so it can't be used to send people elsewhere." });
    emit(sid, "assistant.turn_end", { turnId: "t0" });
  })();

  const DIFF = "--- a/src/login.ts\n+++ b/src/login.ts\n@@ -40,6 +40,9 @@ export async function signIn(req, res) {\n   await session.start(req, user);\n-  const redirectTo = \"/\";\n+  const next = typeof req.query.next === \"string\" ? req.query.next : \"/\";\n+  // Only a path on this site: never another host.\n+  const redirectTo = next.startsWith(\"/\") && !next.startsWith(\"//\") ? next : \"/\";\n   res.redirect(redirectTo);\n }\n";

  // ── The scripted turn: words, a command with its output, then a write that asks ──
  function firstTurn(sid, prompt) {
    emit(sid, "user.message", { content: prompt, messageId: "m-user-1" });
    setRow(sid, { busy: true });
    later(10, () => emit(sid, "assistant.turn_start", { turnId: "t1", model: "gpt-5.5" }));
    later(20, () => emit(sid, "assistant.intent", { intent: "Running the tests" }, eph));
    later(30, () => emit(sid, "assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "The redirect ignores `next`. " }, eph));
    later(40, () => emit(sid, "assistant.reasoning", { reasoningId: "r1", content: "The redirect ignores `next`. Run the tests first to see what fails, then change the handler." }));
    later(50, () => emit(sid, "assistant.message_start", { messageId: "a1" }, eph));
    const words = ["I'll run ", "the login tests ", "first, then **fix** the handler."];
    words.forEach((w, i) => later(60 + i * 20, () => emit(sid, "assistant.message_delta", { messageId: "a1", deltaContent: w }, eph)));
    later(130, () => emit(sid, "assistant.message", { messageId: "a1", content: words.join("") }));
    later(140, () => emit(sid, "tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "npm test -- login", description: "Run the login tests" }, shellToolInfo: { displayCommand: "npm test -- login", hasWriteFileRedirection: false, possiblePaths: [] } }));
    const out = ["\n> app@1.4.0 test\n> vitest run login\n\n", " ✓ test/login.test.ts > signs in (12 ms)\n", " ✗ test/login.test.ts > returns to the page it came from\n   expected \"/\" to be \"/settings\"\n", "\n Tests  1 failed | 1 passed (2)\n"];
    out.forEach((text, i) => later(160 + i * 20, () => emit(sid, "tool.shell_output", { toolCallId: "c1", text, stream: "stdout", sequence: i }, eph)));
    later(250, () => emit(sid, "tool.execution_complete", { toolCallId: "c1", success: false, shellExecution: { exitCode: 1 }, sandboxed: true }));
    later(260, () => emit(sid, "session.usage_info", { currentTokens: 48_200, tokenLimit: 128_000, messagesLength: 14 }, eph));
    later(270, () => emit(sid, "assistant.usage", { model: "gpt-5.5", inputTokens: 21_400, outputTokens: 620 }, eph));
    later(280, () => {
      const data = {
        requestId: "perm-1",
        permissionRequest: { kind: "write", fileName: "/home/me/work/app/src/login.ts", diff: DIFF, intention: "Send people back to the page they came from", canOfferSessionApproval: true, toolCallId: "c2" },
        promptRequest: { kind: "write", assistedApproval: { recommendation: "requireApproval", reason: "It changes how sign-in redirects, which you didn't ask to change in this way." } },
        permissionMode: "manual",
      };
      emit(sid, "permission.requested", data);
      openRequest(sid, "permission", "perm-1", data, ["approve-once", "approve-for-session", "reject"]);
    });
  }

  // ── After the write is allowed: the edit, a sub-agent, then the model's question ──
  function afterWrite(sid) {
    later(10, () => emit(sid, "tool.execution_start", { toolCallId: "c2", toolName: "edit", arguments: { path: "/home/me/work/app/src/login.ts" } }));
    later(30, () => emit(sid, "tool.execution_complete", { toolCallId: "c2", success: true, fileEdits: [{ path: "/home/me/work/app/src/login.ts", kind: "edit" }] }));
    later(40, () => emit(sid, "tool.execution_start", { toolCallId: "task-1", toolName: "task", arguments: { agent_type: "explore", prompt: "Find every other place that redirects after sign-in" } }));
    later(50, () => emit(sid, "subagent.started", { toolCallId: "task-1", agentName: "explore", agentDisplayName: "Explore", agentDescription: "Find every other place that redirects after sign-in", model: "gpt-5.4-mini" }, { agentId: "sub-1" }));
    later(60, () => emit(sid, "tool.execution_start", { toolCallId: "sub-g1", toolName: "grep", arguments: { pattern: "res.redirect", path: "src" } }, { agentId: "sub-1" }));
    later(70, () => emit(sid, "tool.execution_complete", { toolCallId: "sub-g1", success: true, result: { content: "src/login.ts:44\nsrc/oauth.ts:88" } }, { agentId: "sub-1" }));
    later(80, () => emit(sid, "assistant.message", { messageId: "sub-a1", content: "Two places redirect after sign-in: `src/login.ts` and `src/oauth.ts`." }, { agentId: "sub-1" }));
    later(90, () => emit(sid, "subagent.completed", { toolCallId: "task-1", agentName: "explore", agentDisplayName: "Explore", durationMs: 4200, totalToolCalls: 1 }));
    later(95, () => emit(sid, "tool.execution_complete", { toolCallId: "task-1", success: true, result: { content: "Two places." } }));
    later(110, () => {
      const data = { requestId: "ask-1", question: "The OAuth callback redirects too. Should I change it the same way?", choices: ["Yes, both", "Only the login form"], allowFreeform: true };
      emit(sid, "user_input.requested", data, eph);
      openRequest(sid, "user-input", "ask-1", data);
    });
  }

  // ── After the answer: a plan, and leaving plan mode ──
  function afterAnswer(sid) {
    later(10, () => emit(sid, "session.mode_changed", { previousMode: "interactive", newMode: "plan" }));
    later(20, () => emit(sid, "session.plan_changed", { operation: "create" }));
    later(25, () => emit(sid, "session.todos_changed", {}, eph));
    later(40, () => {
      const data = {
        requestId: "plan-1", summary: "Change both redirects to go back to `next`, with tests.",
        planContent: "## Plan\n\n1. Read `next` in the login handler\n2. Do the same in `src/oauth.ts`\n3. Add tests for both, including one that tries another host\n",
        actions: ["exit_only", "interactive", "autopilot"], recommendedAction: "interactive",
      };
      emit(sid, "exit_plan_mode.requested", data, eph);
      openRequest(sid, "exit-plan-mode", "plan-1", data);
    });
  }

  // ── After the plan: a long turn that keeps going until it is stopped ──
  let longTimer = null;
  function longTurn(sid) {
    later(10, () => emit(sid, "session.mode_changed", { previousMode: "plan", newMode: "interactive" }));
    later(20, () => emit(sid, "assistant.message_start", { messageId: "a-long" }, eph));
    let n = 0;
    const tick = () => { emit(sid, "assistant.message_delta", { messageId: "a-long", deltaContent: n++ ? " Still working." : "Working through the plan." }, eph); longTimer = setTimeout(tick, 400); };
    later(30, tick);
    step("long-turn");
  }

  // ── The panel's Changes and Plan tabs: scripted answers to workspaces.diff, history.*, plan.* and the Autopilot
  //    objective, as the SDK's generated types shape them. s-login tracks its files from its first turn; s-vitest
  //    didn't (its session diff falls back to the uncommitted one and it can't rewind); a new session has nothing yet.
  //    window.__fake.panels holds each call's params (`params`), and `fail[method]` makes that method refused with a
  //    sentence, as main refuses. ──
  const panels = { params: [], fail: {}, plans: new Map(), objectives: new Map(), rewound: new Set() };
  const app = (p) => `/home/me/work/app/${p}`;
  const OAUTH = "--- /dev/null\n+++ b/src/oauth.ts\n@@ -0,0 +1,4 @@\n+export function back(next: unknown): string {\n+  if (typeof next !== \"string\") return \"/\";\n+  return next.startsWith(\"/\") && !next.startsWith(\"//\") ? next : \"/\";\n+}\n";
  const SPACES = "--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1,3 +1,3 @@\n export const a = 1;\n-export const b  = 2;\n+export const b = 2;\n export const c = 3;\n";
  const TEST = "--- a/test/login.test.ts\n+++ b/test/login.test.ts\n@@ -10,4 +10,7 @@ describe(\"sign-in\", () => {\n   it(\"signs in\", ok);\n+  it(\"returns to the page it came from\", async () => {\n+    expect(await signIn(\"/settings\")).toBe(\"/settings\");\n+  });\n });\n";
  const PKG = "--- a/package.json\n+++ b/package.json\n@@ -5,7 +5,7 @@\n   \"devDependencies\": {\n-    \"vitest\": \"^3.2.0\"\n+    \"vitest\": \"^4.0.0\"\n   }\n";
  const file = (path, changeType, diff, extra = {}) => ({ path, changeType, diff, ...extra });
  panels.plans.set("s-login", "## Plan\n\n1. Read `next` in the login handler\n2. Do the same in `src/oauth.ts`\n3. Add tests for both, including **one that tries another host**\n\n- Keep the old behaviour for a missing `next`\n");
  panels.objectives.set("s-login", { content: "Make every sign-in path return people to where they were, with tests.", status: "active", turnCount: 3 });
  const TODOS = {
    rows: [
      { id: "read-next", title: "Read next in the login handler", status: "done", createdAt: "2026-11-27 09:40:00" },
      { id: "oauth", title: "Do the same in the OAuth callback", status: "in_progress", description: "src/oauth.ts redirects after the provider answers." },
      { id: "tests", title: "Add tests for both", status: "pending" },
      { id: "host", title: "Test another host is refused", status: "blocked" },
    ],
    dependencies: [{ todoId: "tests", dependsOn: "read-next" }, { todoId: "tests", dependsOn: "oauth" }, { todoId: "host", dependsOn: "tests" }],
  };
  const panelRpc = {
    "workspaces.diff": (c) => {
      const mode = c.params?.mode, ws = c.params?.ignoreWhitespace === true, sid = c.sessionId;
      if (sid === "s-vitest") {
        const changes = [file("package.json", "modified", PKG)];
        return mode === "branch" ? { requestedMode: "branch", mode: "branch", baseBranch: "main", isFallback: false, changes }
          : { requestedMode: mode, mode: "unstaged", isFallback: mode === "session", ...(mode === "session" ? { unavailableReason: "file-change-tracking-disabled" } : {}), changes };
      }
      if (sid !== "s-login" || panels.rewound.has(sid)) return { requestedMode: mode, mode, isFallback: false, changes: [] };
      const session = [file("src/login.ts", "modified", DIFF), file("src/oauth.ts", "added", OAUTH), file("docs/redirects.md", "renamed", "", { oldPath: "docs/old.md" }), ...(ws ? [] : [file("src/util.ts", "modified", SPACES)])];
      if (mode === "unstaged") return { requestedMode: mode, mode, isFallback: false, changes: [file("src/login.ts", "modified", DIFF), file("test/login.test.ts", "modified", TEST)] };
      if (mode === "branch") return { requestedMode: mode, mode, isFallback: false, baseBranch: "main", changes: [...session, file("vendor/huge.js", "modified", "", { isTruncated: true })] };
      return { requestedMode: mode, mode, isFallback: false, changes: session };
    },
    "history.listRewindPoints": (c, l) => {
      if (c.sessionId === "s-vitest") return { fileChangeTrackingEnabled: false, unavailableReason: "file-change-tracking-disabled", points: [] };
      const points = l.kept.filter(e => e.event.type === "user.message").map((e, i) => ({
        eventId: e.event.id, userMessage: e.event.data.content, timestamp: e.event.timestamp,
        canRestoreFiles: c.sessionId === "s-login", fileCount: c.sessionId === "s-login" ? 2 : 0, turnChangedFiles: i > 0, linesAdded: 7, linesRemoved: 1, isAutopilotContinuation: false,
      }));
      return { fileChangeTrackingEnabled: true, points };
    },
    "history.previewRewind": (c) => (c.sessionId === "s-login"
      ? { available: true, fileCount: 2, files: [{ path: app("src/login.ts"), changeType: "modified", linesAdded: 3, linesRemoved: 1 }, { path: app("src/oauth.ts"), changeType: "created", linesAdded: 4, linesRemoved: 0 }] }
      : { available: false, reason: "file-change-tracking-disabled", fileCount: 0, files: [] }),
    "history.rewind": (c, l) => {
      if (sessions.get(c.sessionId)?.busy) return { outcome: "session-busy", restoredFiles: [], skippedFiles: [] };
      const at = l.kept.findIndex(e => e.event.id === c.params.eventId);
      if (at < 0) return { outcome: "truncation-failed", restoredFiles: [], skippedFiles: [], error: "Event not found: internal detail" };
      const removed = l.kept.length - at;
      l.kept = l.kept.slice(0, at);
      const files = c.params.mode === "conversation-and-files";
      if (files) panels.rewound.add(c.sessionId);
      later(10, () => emit(c.sessionId, "session.snapshot_rewind", { eventId: c.params.eventId, eventsRemoved: removed }, eph));
      return { outcome: "success", eventsRemoved: removed, restoredFiles: files ? [app("src/login.ts"), app("src/oauth.ts")] : [], skippedFiles: files ? [{ path: app("README.md"), reason: "user-modified" }] : [] };
    },
    "plan.read": (c) => { const p = panels.plans.get(c.sessionId); return { exists: p !== undefined, content: p ?? null, path: p !== undefined ? `/home/me/.copilot/session-state/${c.sessionId}/plan.md` : null }; },
    "plan.update": (c) => { panels.plans.set(c.sessionId, c.params.content); later(5, () => emit(c.sessionId, "session.plan_changed", { operation: "update" })); return null; },
    "plan.delete": (c) => { panels.plans.delete(c.sessionId); later(5, () => emit(c.sessionId, "session.plan_changed", { operation: "delete" })); return null; },
    "plan.readSqlTodosWithDependencies": (c) => (c.sessionId === "s-login" ? TODOS : { rows: [], dependencies: [] }),
    "plan.readSqlTodos": (c) => ({ rows: c.sessionId === "s-login" ? TODOS.rows : [] }),
    "autopilotObjective.getState": (c) => {
      const o = panels.objectives.get(c.sessionId);
      return { state: o ? { id: 1, objective: o.content, status: o.status, turnCount: o.turnCount, creditCountNanoAiu: "0" } : null };
    },
    "workspaces.readAutopilotObjective": (c) => ({ content: panels.objectives.get(c.sessionId)?.content ?? null }),
    "workspaces.writeAutopilotObjective": (c) => {
      const was = panels.objectives.get(c.sessionId);
      panels.objectives.set(c.sessionId, { content: c.params.content, status: "active", turnCount: was?.turnCount ?? 0 });
      later(5, () => emit(c.sessionId, "session.autopilot_objective_changed", { id: 1, operation: was ? "update" : "create", status: "active" }));
      return { operation: was ? "updated" : "created" };
    },
    "workspaces.deleteAutopilotObjective": (c) => {
      const had = panels.objectives.delete(c.sessionId);
      later(5, () => emit(c.sessionId, "session.autopilot_objective_changed", { operation: "delete" }));
      return { deleted: had };
    },
  };

  const api = {
    async list() { calls.push("list"); return { projects: projects.slice(), sessions: [...sessions.values()] }; },
    async addProject() { calls.push("addProject"); const p = { id: "p-site", folder: "/home/me/work/site", name: "site", gitRoot: "/home/me/work/site", branch: "main" }; projects.unshift(p); return { ok: true, value: p }; },
    async removeProject(id) { calls.push(`removeProject:${id}`); return { ok: true }; },
    async create(o) {
      calls.push(`create:${JSON.stringify(o)}`);
      const id = `s-new-${sessions.size}`;
      const p = projects.find(x => x.id === o.projectId) ?? projects[0];
      const r = row({ id, projectId: p.id, folder: p.folder, name: o.name ?? "", isolation: o.isolation ?? "folder", ...(o.isolation === "worktree" ? { branch: "ember/new-session" } : {}), permissionMode: o.permissionMode ?? "manual", agentMode: o.agentMode ?? "interactive", model: o.model ?? "gpt-5.5", createdAt: now, updatedAt: now });
      sessions.set(id, r);
      emit(id, "session.start", { sessionId: id, selectedModel: r.model, reasoningEffort: o.reasoningEffort, copilotVersion: "1.0.97", producer: "ember", startTime: new Date(now).toISOString(), version: 1 });
      return { ok: true, value: r };
    },
    async attach(id, since) {
      calls.push(`attach:${id}${since !== undefined ? `:${since}` : ""}`);
      const l = log(id);
      l.attached = true;
      const events = l.kept.filter(e => since === undefined || e.seq > since);
      step(`attach:${id}`);
      return { ok: true, value: { row: sessions.get(id), events, pending: [...pending.values()].filter(p => p.sessionId === id), seq: l.seq, ...(since === undefined ? { reset: true } : {}) } };
    },
    detach(id) { calls.push(`detach:${id}`); log(id).attached = false; },
    async send(m) {
      calls.push(`send:${m.sessionId}:${m.mode ?? "-"}:${m.prompt}${m.attachments?.length ? `:+${m.attachments.length}` : ""}`);
      const l = log(m.sessionId);
      if (m.mode === "enqueue") {
        l.queue.push({ id: `q${l.queue.length + 1}`, displayText: m.prompt, kind: "message", agentMode: "interactive" });
        later(10, () => emit(m.sessionId, "pending_messages.modified", {}, eph));
      } else if (m.mode === "immediate") {
        l.steering.push(m.prompt);
        later(10, () => emit(m.sessionId, "pending_messages.modified", {}, eph));
        later(30, () => emit(m.sessionId, "user.message", { content: m.prompt, messageId: `m-steer-${l.steering.length}` }));
      } else if (!l.turns) { l.turns = 1; firstTurn(m.sessionId, m.prompt); }
      else emit(m.sessionId, "user.message", { content: m.prompt });
      return { ok: true, value: { messageId: m.mode === "immediate" ? `m-steer-${l.steering.length}` : `m-user-${calls.length}` } };
    },
    async interrupt(id) {
      calls.push(`interrupt:${id}`);
      clearTimeout(longTimer);
      later(10, () => emit(id, "abort", { reason: "user_initiated" }));
      later(20, () => { emit(id, "session.idle", { aborted: true }, eph); setRow(id, { busy: false }); step("stopped"); });
      return { ok: true };
    },
    stopAll() { calls.push("stopAll"); },
    async respond(a) {
      calls.push(`respond:${a.requestId}:${JSON.stringify(a.payload)}`);
      if (!pending.has(a.requestId)) return { ok: false, reason: "That request was already answered." };
      const sid = a.sessionId;
      resolve(sid, a.requestId);
      if (a.requestId === "perm-1") {
        const kind = a.payload.kind === "reject" ? "denied-interactively-by-user" : a.payload.kind === "approve-for-session" ? "approved-for-session" : "approved";
        emit(sid, "permission.completed", { requestId: "perm-1", result: { kind }, toolCallId: "c2" });
        if (kind !== "denied-interactively-by-user") afterWrite(sid);
      }
      if (a.requestId === "ask-1") { emit(sid, "user_input.completed", { requestId: "ask-1", answer: a.payload.answer, wasFreeform: a.payload.wasFreeform }, eph); afterAnswer(sid); }
      if (a.requestId === "plan-1") { emit(sid, "exit_plan_mode.completed", { requestId: "plan-1", ...a.payload }, eph); longTurn(sid); }
      return { ok: true };
    },
    async setPermissionMode(id, mode) {
      calls.push(`permissionMode:${id}:${mode}`);
      const inForce = mode === "allow-all" ? "manual" : mode;
      setRow(id, { permissionMode: inForce });
      return { ok: true, value: { mode: inForce } };
    },
    async setAgentMode(id, mode) { calls.push(`agentMode:${id}:${mode}`); setRow(id, { agentMode: mode }); return { ok: true, value: { mode } }; },
    async update(id, change) { calls.push(`update:${id}:${JSON.stringify(change)}`); setRow(id, change); return { ok: true, value: sessions.get(id) }; },
    async fork(id) { calls.push(`fork:${id}`); return { ok: false, reason: "Not in this test." }; },
    async remove(id) { calls.push(`remove:${id}`); return { ok: true }; },
    async pickAttachments(id) { calls.push(`pick:${id}`); return { ok: true, value: [{ type: "file", path: "/home/me/work/app/src/oauth.ts", displayName: "oauth.ts" }] }; },
    async rpc(c) {
      calls.push(`rpc:${c.scope}:${c.method}`);
      const l = c.sessionId ? log(c.sessionId) : null;
      if (panelRpc[c.method]) {
        panels.params.push({ method: c.method, sessionId: c.sessionId, params: c.params ?? null });
        if (panels.fail[c.method]) return { ok: false, reason: panels.fail[c.method] };
        return { ok: true, value: panelRpc[c.method](c, l) };
      }
      switch (c.method) {
        case "models.list": return { ok: true, value: { models: [
          { id: "gpt-5.5", name: "GPT-5.5", capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["low", "medium", "high"] },
          { id: "gpt-5.4-mini", name: "GPT-5.4 mini", capabilities: { supports: {} } },
        ] } };
        case "agents.discover": return { ok: true, value: { agents: [{ id: "reviewer", name: "reviewer", displayName: "Code reviewer", description: "Reviews a change" }] } };
        case "commands.list": return { ok: true, value: { commands: [
          { name: "plan", description: "Make a plan before changing anything", kind: "builtin", allowDuringAgentExecution: false },
          { name: "compact", description: "Make room in the context", kind: "builtin", allowDuringAgentExecution: true },
          { name: "review", description: "Review the session's changes", kind: "builtin", allowDuringAgentExecution: false },
        ] } };
        case "completions.getTriggerCharacters": return { ok: true, value: { triggerCharacters: ["@"] } };
        case "completions.request": {
          const at = c.params.text.lastIndexOf("@", c.params.offset);
          return { ok: true, value: { items: ["src/login.ts", "src/oauth.ts", "test/login.test.ts"].filter(f => f.includes(c.params.text.slice(at + 1, c.params.offset))).map(f => ({ insertText: `@${f}`, label: f, kind: "document", rangeStart: at, rangeEnd: c.params.offset })) } };
        }
        case "queue.pendingItems": return { ok: true, value: { items: l.queue.slice(), steeringMessages: l.steering.slice() } };
        case "queue.removeAt": l.queue = l.queue.filter(q => q.id !== c.params.id); return { ok: true, value: { removed: true } };
        case "queue.updateText": l.queue = l.queue.map(q => (q.id === c.params.id ? { ...q, displayText: c.params.prompt } : q)); return { ok: true, value: { updated: true } };
        case "queue.sendNow": { const q = l.queue.find(x => x.id === c.params.id); l.queue = l.queue.filter(x => x.id !== c.params.id); if (q) l.steering.push(q.displayText); return { ok: true, value: { steered: true } }; }
        case "model.switchTo": emit(c.sessionId, "session.model_change", { previousModel: "gpt-5.5", newModel: c.params.modelId, reasoningEffort: c.params.reasoningEffort ?? null }); return { ok: true, value: {} };
        case "model.setReasoningEffort": return { ok: true, value: { reasoningEffort: c.params.reasoningEffort } };
        default: return { ok: false, reason: "Not in this test." };
      }
    },
    onEvent(fn) { listeners.event.add(fn); return () => listeners.event.delete(fn); },
    onRow(fn) { listeners.row.add(fn); return () => listeners.row.delete(fn); },
    onRequest(fn) { listeners.request.add(fn); return () => listeners.request.delete(fn); },
  };
  window.emberCode = api;
  window.__fake = {
    calls, emit, sessions, pending, panels, request: openRequest, setRow,
    gap() { skip = true; },
    wait(name) { return reached.has(name) ? Promise.resolve() : new Promise(r => waiters.set(name, [...(waiters.get(name) ?? []), r])); },
    reached: (name) => reached.has(name),
  };
})();
