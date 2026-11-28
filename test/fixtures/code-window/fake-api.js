// A scripted window.emberCode for the coding window's renderer journeys and render checks (test/integration/
// code-window-renderer.test.ts; loaded with page.addInitScript({ path })). It plays a realistic Copilot SDK session:
// SDK events as the runtime sends them, numbered per session, with main's pending table and its RPC answers, in the
// shapes probed on the bundled runtime 1.0.97 (docs/CODING-APP.md §7) and as main passes them on (an MCP server's
// secret values replaced by CODE_KEPT, a failed method answered with main's sentence). Nothing is read, sent or kept. window.__fake drives and inspects it: `calls` (every command in order), `emit` (an event now),
// `gap()` (the next envelope skips a number), `wait(name)` (a promise for a named step of the script).
(() => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const calls = [];
  const listeners = { event: new Set(), row: new Set(), request: new Set(), mic: new Set() };
  let micHeld = false;
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
  /** What main puts in place of an MCP server's secret values (app/shared/code.ts CODE_KEPT). */
  const KEPT = "\u2022\u2022\u2022 kept by Ember \u2022\u2022\u2022";

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
      later(10, () => emit(c.sessionId, "session.snapshot_rewind", { upToEventId: c.params.eventId, eventsRemoved: removed }));
      return { outcome: "success", eventsRemoved: removed, restoredFiles: files ? [app("src/login.ts"), app("src/oauth.ts")] : [], skippedFiles: files ? [{ path: app("README.md"), reason: "user-modified" }] : [] };
    },
    "plan.read": (c) => { const p = panels.plans.get(c.sessionId); return { exists: p !== undefined, content: p ?? null, path: `/home/me/.copilot/session-state/${c.sessionId}/plan.md` }; },
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
      return { operation: was ? "update" : "create" };
    },
    "workspaces.deleteAutopilotObjective": (c) => {
      const had = panels.objectives.delete(c.sessionId);
      later(5, () => emit(c.sessionId, "session.autopilot_objective_changed", { operation: "delete" }));
      return { deleted: had };
    },
  };
  // ── The panel's Files, Terminal and Agents and tasks tabs: the session's files, background tasks, schedules, agents ──
  const LOGIN = "import { session } from \"./session\";\n\nexport async function signIn(req, res) {\n  await session.start(req, user);\n  const next = typeof req.query.next === \"string\" ? req.query.next : \"/\";\n  // Only a path on this site: never another host.\n  const redirectTo = next.startsWith(\"/\") && !next.startsWith(\"//\") ? next : \"/\";\n  res.redirect(redirectTo);\n}\n";
  const sessionFiles = { "plan.md": "# Plan\n\n1. Read next\n2. Test it\n", "paste-1.txt": "a pasted log\n", "shot.png": "\u0089PNG\u0000\u0000\u0001" };
  const iso = (ms) => new Date(ms).toISOString();
  const tasks = () => ({ tasks: [
    { type: "agent", id: "bg-1", toolCallId: "bg-call-1", displayName: "Check the OAuth flow", description: "Check the OAuth callback redirects", status: "running", startedAt: iso(Date.now() - 125_000), activeTimeMs: 120_000, activeStartedAt: iso(Date.now() - 5_000), agentType: "explore", prompt: "Check the OAuth callback", resolvedModel: "gpt-5.4-mini", executionMode: "background", latestResponse: "Reading src/oauth.ts" },
    { type: "shell", id: "sh-1", description: "Watch the tests", command: "npm test -- --watch", status: "running", startedAt: iso(Date.now() - 60_000), attachmentMode: "detached", executionMode: "background" },
    ...taskLog,
  ] });
  const taskLog = [{ type: "agent", id: "bg-0", toolCallId: "bg-call-0", displayName: "Read the docs", description: "Read the auth docs", status: "completed", startedAt: iso(now - 900_000), completedAt: iso(now - 840_000), agentType: "explore", prompt: "Read", result: "Done." }];
  let schedules = [{ id: 1, intervalMs: 600_000, prompt: "Check CI", displayPrompt: "Check CI", recurring: true, nextRunAt: iso(now + 600_000) }];
  const userRuns = new Map();
  // The working folder of /home/me/work/app as main lists it (folders first, then files, each by name; what git
  // ignores and .git left out) and reads it (text, or binary, or too large).
  const workTree = {
    "": [{ name: "assets", kind: "folder" }, { name: "docs", kind: "folder" }, { name: "src", kind: "folder" }, { name: "test", kind: "folder" }, { name: "package.json", kind: "file", size: 212 }, { name: "README.md", kind: "file", size: 64 }],
    assets: [{ name: "logo.png", kind: "file", size: 9 }],
    docs: [],
    src: [{ name: "login.ts", kind: "file", size: 330 }, { name: "oauth.ts", kind: "file", size: 160 }, { name: "session.ts", kind: "file", size: 40 }],
    test: [{ name: "login.test.ts", kind: "file", size: 180 }],
  };
  const workFiles = {
    "src/login.ts": LOGIN,
    "src/oauth.ts": "export function back(next: unknown): string {\n  if (typeof next !== \"string\") return \"/\";\n  return next.startsWith(\"/\") && !next.startsWith(\"//\") ? next : \"/\";\n}\n",
    "src/session.ts": "export const session = { start() {} };\n",
    "test/login.test.ts": "describe(\"sign-in\", () => {\n  it(\"signs in\", ok);\n});\n",
    "package.json": "{\n  \"name\": \"app\",\n  \"private\": true\n}\n",
    "README.md": "# app\n\nThe sign-in app.\n",
    "assets/logo.png": { binary: true, size: 9 },
  };
  // ── Customise's methods (test/integration/code-customise-renderer.test.ts): this computer's settings and the
  // session's, as the SDK's generated types shape them. `refuse` holds methods that answer with a refusal. ──
  const refuse = new Set();
  const params = [];
  const mcp = {
    servers: {
      "issues": { tools: ["*"], command: "npx", args: ["-y", "@acme/issues-mcp"], env: { ISSUES_TOKEN: "fake-secret-value-123" }, timeout: 30_000 },
      "docs": { tools: ["*"], type: "http", url: "https://mcp.example.com/docs", headers: { Authorization: "Bearer fake-header-secret" } },
    },
    disabled: new Set(),
    live: [{ name: "issues", status: "connected", source: "user" }, { name: "docs", status: "needs-auth", source: "user", url: "https://mcp.example.com/docs" }, { name: "browser", status: "connected", source: "plugin", sourcePlugin: "github-copilot-browser" }],
  };
  const skills = [
    { name: "release-notes", description: "Writes release notes from the merged pull requests", source: "project", userInvocable: true, enabled: true, path: "/home/me/work/app/.github/skills/release-notes/SKILL.md", argumentHint: "[version]" },
    { name: "pdf", description: "Reads and fills PDF forms", source: "personal-copilot", userInvocable: true, enabled: false, path: "/home/me/.copilot/skills/pdf/SKILL.md" },
    { name: "browser-testing", description: "Drives a browser to check a page", source: "plugin", pluginName: "github-copilot-browser", userInvocable: false, enabled: true },
  ];
  const plugins = [
    { name: "github-copilot-browser", marketplace: "copilot-plugins", version: "1.4.0", enabled: true },
    { name: "linear", marketplace: "copilot-plugins", version: "0.9.2", enabled: false },
  ];
  const markets = [{ name: "copilot-plugins", source: "GitHub: github/copilot-plugins", isDefault: true }, { name: "acme-tools", source: "GitHub: acme/tools" }];
  const agents = [
    { id: "explore", name: "explore", displayName: "Explore", description: "Finds things in the code base quickly", source: "builtin", userInvocable: false, tools: ["grep", "glob", "view"] },
    { id: "reviewer", name: "reviewer", displayName: "Code reviewer", description: "Reviews a change", source: "project", path: "/home/me/work/app/.github/agents/reviewer.agent.md", model: "claude-sonnet-5", tools: ["view", "grep"] },
  ];
  let agentNow = null;
  const trusted = new Set();
  const allowed = ["/home/me/work/app"];
  const customiseSchedules = [{ id: 1, intervalMs: 1_800_000, prompt: "Check the build and tell me if it failed", recurring: true, nextRunAt: "2026-11-27T10:30:00Z" }, { id: 2, at: Date.parse("2026-11-27T17:00:00Z"), prompt: "/release-notes 1.5.0", displayPrompt: "/release-notes 1.5.0", recurring: false, nextRunAt: "2026-11-27T17:00:00Z" }];
  const ok = (value) => ({ ok: true, value });
  const sidOf = (c) => c.sessionId;
  function liveStatus(c, name, status) {
    mcp.live = mcp.live.map(s => (s.name === name ? { ...s, status } : s));
    later(10, () => emit(sidOf(c), "session.mcp_server_status_changed", { serverName: name, status }, eph));
  }
  function customise(c) {
    const key = `${c.scope}:${c.method}`;
    if (refuse.has(key) || refuse.has(c.method)) return { ok: false, reason: "Copilot couldn't read that just now." };
    const p = c.params ?? {};
    switch (key) {
      case "session:model.getCurrent": return ok({ modelId: sessions.get(c.sessionId)?.model ?? "gpt-5.5", reasoningEffort: "medium" });
      case "session:providers.getCatalog": return ok({ providers: [{ adapterId: "ollama", providerKind: "ollama", displayName: "Ollama", provenance: {}, automaticDiscovery: { mode: "automatic", networkScope: "loopbackOnly", requiresInput: false, requiresTrust: false }, operations: [] }] });
      case "session:providers.discover": params.push({ method: c.method, params: p }); return ok({ outcome: { code: "success" }, instances: [{ reference: { adapterId: "ollama", providerKind: "ollama", id: "ollama:http://127.0.0.1:11434", managementEndpoint: "http://127.0.0.1:11434" }, displayName: "Ollama on this computer", provenance: {} }] });
      case "session:providers.getStatus": return ok({ outcome: { code: "success" }, status: "healthy", version: "0.12.3" });
      case "session:providers.models.list": return ok({ outcome: { code: "success" }, models: [{ id: "qwen3-coder:30b", name: "qwen3-coder:30b", sizeBytes: 18_600_000_000, details: {}, capabilities: {}, warnings: [] }] });
      // MCP: this computer's configuration.
      // Main replaces every variable's and header's value with CODE_KEPT (app/main/code/mcp-secrets.ts).
      case "client:mcp.config.list": return ok({ servers: Object.fromEntries(Object.entries(mcp.servers).map(([n, cfg]) => [n, {
        ...cfg, ...(cfg.env ? { env: Object.fromEntries(Object.keys(cfg.env).map(k => [k, KEPT])) } : {}), ...(cfg.headers ? { headers: Object.fromEntries(Object.keys(cfg.headers).map(k => [k, KEPT])) } : {}),
      }])) });
      case "client:mcp.discover": return ok({ servers: [...Object.keys(mcp.servers).map(name => ({ name, source: "user", enabled: !mcp.disabled.has(name) })), { name: "browser", source: "plugin", sourcePlugin: "github-copilot-browser", enabled: true }] });
      case "client:mcp.config.add": params.push({ method: c.method, params: p }); if (mcp.servers[p.name]) return { ok: false, reason: "There's a server with that name already." }; mcp.servers[p.name] = p.config; return ok(null);
      // Main puts the stored value back where the window sent CODE_KEPT (and refuses one it doesn't hold).
      case "client:mcp.config.update": {
        params.push({ method: c.method, params: p });
        const was = mcp.servers[p.name] ?? {};
        const back = (o, old) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === KEPT ? old?.[k] : v])) : o);
        const cfg = { ...p.config, ...(p.config.env ? { env: back(p.config.env, was.env) } : {}), ...(p.config.headers ? { headers: back(p.config.headers, was.headers) } : {}) };
        if (JSON.stringify(cfg).includes("undefined") || Object.values({ ...cfg.env, ...cfg.headers }).some(v => v === undefined)) return { ok: false, reason: "Ember couldn't keep a value it doesn't hold. Type the value again." };
        mcp.servers[p.name] = cfg; return ok(null);
      }
      case "client:mcp.config.remove": params.push({ method: c.method, params: p }); delete mcp.servers[p.name]; return ok(null);
      case "client:mcp.config.enable": for (const n of p.names) mcp.disabled.delete(n); return ok(null);
      case "client:mcp.config.disable": for (const n of p.names) mcp.disabled.add(n); return ok(null);
      case "client:mcp.config.reload": return ok(null);
      // MCP: the session's servers.
      // The runtime lists the servers it has a client for, and those waiting to sign in or failed only in `host`.
      case "session:mcp.list": return ok({
        servers: mcp.live.filter(s => s.status !== "needs-auth" && s.status !== "failed").map(s => ({ name: s.name, status: s.status, ...(s.status === "connected" ? { serverMetadata: { instructions: null } } : {}) })),
        host: { clients: mcp.live.filter(s => s.status === "connected").map(s => s.name), disabledServers: [], filteredServers: [], pendingConnections: [],
          failedServers: Object.fromEntries(mcp.live.filter(s => s.status === "failed").map(s => [s.name, { message: "MCP server failed: internal detail", timestamp: now }])),
          needsAuthServers: Object.fromEntries(mcp.live.filter(s => s.status === "needs-auth").map(s => [s.name, { timestamp: now }])), mcp3pEnabled: true },
      });
      case "session:mcp.listTools": return ok({ tools: p.serverName === "issues" ? [{ name: "create_issue", description: "Opens an issue" }, { name: "search_issues", description: "Finds issues by words" }] : [] });
      case "session:mcp.resources.list": return ok({ resources: p.serverName === "issues" ? [{ uri: "issues://open", name: "open", title: "Open issues", mimeType: "application/json" }] : [] });
      case "session:mcp.prompts.list": return ok({ prompts: p.serverName === "issues" ? [{ name: "triage", description: "Sorts new issues", arguments: [{ name: "label" }] }] : [] });
      case "session:mcp.startServer": liveStatus(c, p.serverName, "connected"); return ok({});
      case "session:mcp.restartServer": liveStatus(c, p.serverName, "pending"); later(40, () => liveStatus(c, p.serverName, "connected")); return ok({});
      case "session:mcp.stopServer": liveStatus(c, p.serverName, "stopped"); return ok({});
      case "session:mcp.oauth.login": return ok({ loginId: "login-1", status: "awaiting-browser", authorizationUrl: "https://mcp.example.com/oauth/authorize?client_id=ember&state=abc" });
      // Skills.
      case "session:skills.list": return ok({ skills: skills.map(s => ({ ...s })) });
      case "client:skills.discover": return ok({ skills: skills.map(s => ({ ...s, projectPath: "/home/me/work/app" })) });
      case "session:skills.enable": case "session:skills.disable": { const s = skills.find(x => x.name === p.name); if (s) s.enabled = c.method === "skills.enable"; return ok(null); }
      case "client:skills.config.setSkillDisabled": { const s = skills.find(x => x.name === p.name); if (s) s.enabled = !p.disabled; return ok(null); }
      case "session:skills.reload": return ok({ warnings: ["A skill has no description."], errors: [] });
      case "client:skills.getDiscoveryPaths": return ok({ paths: [{ path: "/home/me/work/app/.github/skills", scope: "project", preferredForCreation: true, projectPath: "/home/me/work/app" }, { path: "/home/me/.copilot/skills", scope: "personal-copilot", preferredForCreation: true }] });
      // Plugins.
      case "client:plugins.list": return ok({ plugins: plugins.map(x => ({ ...x })) });
      case "client:plugins.enable": case "client:plugins.disable": for (const n of p.names) { const x = plugins.find(y => `${y.name}@${y.marketplace}` === n); if (x) x.enabled = c.method === "plugins.enable"; } return ok(null);
      case "client:plugins.install": params.push({ method: c.method, params: p }); { const [name, market = ""] = p.source.split("@"); plugins.push({ name, marketplace: market, version: "1.0.0", enabled: true }); return ok({ plugin: { name, marketplace: market, enabled: true }, skillsInstalled: 2 }); }
      case "client:plugins.uninstall": { const i = plugins.findIndex(y => `${y.name}@${y.marketplace}` === p.name); if (i >= 0) plugins.splice(i, 1); return ok(null); }
      case "client:plugins.update": return ok({ previousVersion: "0.9.2", newVersion: "0.9.3", skillsInstalled: 0 });
      case "client:plugins.updateAll": return ok({ results: [] });
      case "client:plugins.marketplaces.list": return ok({ marketplaces: markets.map(m => ({ ...m })) });
      case "client:plugins.marketplaces.add": { const name = p.source.split("/").pop().replace(/#.*/, ""); markets.push({ name, source: `GitHub: ${p.source}` }); return ok({ name }); }
      case "client:plugins.marketplaces.remove": { const i = markets.findIndex(m => m.name === p.name); if (i >= 0) markets.splice(i, 1); return ok({ removed: true }); }
      case "client:plugins.marketplaces.browse": return ok({ plugins: [{ name: "deploy-helper", description: "Deploys to the staging site" }, { name: "changelog", description: "Keeps CHANGELOG.md tidy" }] });
      case "client:plugins.marketplaces.refresh": return ok({ results: markets.map(m => ({ name: m.name, success: true })) });
      // Agents.
      case "session:agent.list": return ok({ agents: agents.map(a => ({ ...a })) });
      case "session:agent.getCurrent": return ok({ agent: agentNow ? agents.find(a => a.name === agentNow) : null });
      case "session:agent.select": agentNow = p.name; return ok({ agent: agents.find(a => a.name === p.name) });
      case "session:agent.deselect": agentNow = null; return ok(null);
      case "session:agent.reload": return ok({ agents: agents.filter(a => a.source !== "builtin") });
      case "client:agents.getDiscoveryPaths": return ok({ paths: [{ path: "/home/me/work/app/.github/agents", scope: "project", preferredForCreation: true }, { path: "/home/me/.copilot/agents", scope: "user", preferredForCreation: true }] });
      // Instructions.
      case "session:instructions.getSources": case "session:instructions.reload": return ok({ sources: [{ id: "repo", label: "Copilot instructions", sourcePath: ".github/copilot-instructions.md", content: "# How we work\n\nRun npm test before you push.\n", type: "repo", location: "repository" }] });
      case "client:instructions.discover": return ok({ sources: [
        { id: "repo", label: "Copilot instructions", sourcePath: ".github/copilot-instructions.md", content: "# How we work\n\nRun npm test before you push.\n", type: "repo", location: "repository" },
        { id: "tests", label: "Tests", sourcePath: ".github/instructions/tests.instructions.md", content: "Use vitest.", type: "child-instructions", location: "repository", applyTo: ["test/**"], defaultDisabled: true },
      ] });
      case "client:instructions.getDiscoveryPaths": return ok({ paths: [{ path: "/home/me/work/app/.github/copilot-instructions.md", location: "repository", kind: "file", preferredForCreation: true }, { path: "/home/me/.copilot/copilot-instructions.md", location: "user", kind: "file", preferredForCreation: true }] });
      // Hooks.
      case "client:hooks.discover": return ok({ hooks: [
        { id: "h1", hookType: "preToolUse", origin: "repository", source: ".github/hooks/check.json", enabled: true },
        { id: "h2", hookType: "sessionEnd", origin: "user", source: "~/.copilot/hooks/notify.json", enabled: false },
      ], warnings: [], errors: ["A hook file couldn't be read."] });
      // Permissions.
      case "session:managedSettings.get": return ok({ bypassPermissionsDisabled: true, deviceManaged: false, serverManaged: true, failClosed: false, managedKeys: ["permissions"], source: "server" });
      case "client:managedSettings.read": return ok({});
      case "session:permissions.modifyRules": params.push({ method: c.method, params: p }); return ok({ success: true });
      case "session:permissions.resetSessionApprovals": params.push({ method: c.method, params: p }); return ok({ success: true });
      case "session:permissions.paths.list": return ok({ primary: allowed[0], directories: allowed.slice(), sessionApprovedPaths: [] });
      case "session:permissions.paths.add": allowed.push(p.path); return ok({ success: true });
      case "session:permissions.folderTrust.isTrusted": return ok({ trusted: trusted.has(p.path) });
      case "session:permissions.folderTrust.addTrusted": trusted.add(p.path); return ok({ success: true });
      // The sandbox.
      case "client:sandbox.getHostSupport": return ok({ supported: true, capabilities: [
        { name: "network", supported: false, reason: "Bubblewrap cannot start sandboxed commands or services with this policy because its private network is unavailable. (Bubblewrap: sandbox networking requires 'slirp4netns' on PATH: No such file or directory (os error 2). Install slirp4netns.) Resolve the reported host requirement before retrying. See https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes" },
        { name: "denied_paths", supported: true }, { name: "shell", supported: true }, { name: "filesystem_enumeration", supported: true },
      ] });
      case "session:sandbox.getEnforcementStatus": return ok({ required: false, blocked: false });
      // Schedules.
      case "session:schedule.list": return ok({ entries: customiseSchedules.map(s => ({ ...s })) });
      case "session:schedule.stop": { const i = customiseSchedules.findIndex(s => s.id === p.id); const [entry] = i >= 0 ? customiseSchedules.splice(i, 1) : []; return ok({ entry }); }
      // Usage.
      case "session:usage.getMetrics": return ok({ totalPremiumRequestCost: 7, totalUserRequests: 9, totalApiDurationMs: 312_000, lastCallInputTokens: 21_400, lastCallOutputTokens: 620, sessionStartTime: new Date(now - 3_600_000).toISOString(), currentModel: "gpt-5.5",
        codeChanges: { filesModified: ["src/login.ts", "src/oauth.ts"], filesModifiedCount: 2, linesAdded: 24, linesRemoved: 6 },
        modelMetrics: { "gpt-5.5": { requests: { count: 7, cost: 7 }, usage: { inputTokens: 148_000, outputTokens: 5_200, cacheReadTokens: 96_000, cacheWriteTokens: 0 } }, "gpt-5.4-mini": { requests: { count: 3, cost: 0 }, usage: { inputTokens: 12_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 } } } });
      case "session:quota.get": case "session:quota.refresh": return ok({ snapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 87, usageAllowedWithExhaustedQuota: false, overage: 0, overageAllowedWithExhaustedQuota: false, remainingPercentage: 71, resetDateEpochMs: Date.parse("2026-12-01T00:00:00Z") }, chat: { isUnlimitedEntitlement: true, entitlementRequests: -1, usedRequests: 0, usageAllowedWithExhaustedQuota: true, overage: 0, overageAllowedWithExhaustedQuota: true, remainingPercentage: 100 } }, isFreeUser: false, isTbbUser: false, planTier: "pro", premiumRequestsBillable: true, modelCostColumnVisible: true, delegateAvailable: true, canSignupForCopilotFree: false, dynamicWorkflowsEnabled: false, dynamicWorkflowsUiVisible: false });
      case "client:account.getQuota": return ok({ quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 87, usageAllowedWithExhaustedQuota: false, remainingPercentage: 71, overage: 0, overageAllowedWithExhaustedQuota: false, resetDate: "2026-12-01T00:00:00Z" } } });
      case "session:metadata.contextInfo": return ok({ contextInfo: { modelName: "gpt-5.5", systemTokens: 9_800, conversationTokens: 31_400, toolDefinitionsTokens: 7_000, mcpToolsTokens: 2_100, totalTokens: 48_200, promptTokenLimit: 128_000, compactionThreshold: 102_400, limit: 128_000, bufferTokens: 6_400 } });
      case "session:metadata.getContextHeaviestMessages": return ok({ totalTokens: 48_200, messages: [{ id: "m1", label: "tool: bash", role: "tool", tokens: 9_100 }, { id: "m2", label: "tool: view", role: "tool", tokens: 4_300 }] });
      case "session:history.compact": params.push({ method: c.method, params: p }); return ok({ success: true, tokensRemoved: 28_000, messagesRemoved: 12 });
      default: return null;
    }
  }

  const api = {
    async list() { calls.push("list"); return { projects: projects.slice(), sessions: [...sessions.values()] }; },
    async addProject() { calls.push("addProject"); const p = { id: "p-site", folder: "/home/me/work/site", name: "site", gitRoot: "/home/me/work/site", branch: "main" }; projects.unshift(p); return { ok: true, value: p }; },
    // Main refuses while any session, an archived one too, is under the project, in its own sentence.
    async removeProject(id) {
      calls.push(`removeProject:${id}`);
      if ([...sessions.values()].some(r => r.projectId === id)) return { ok: false, reason: "This project still has sessions. Delete them first, then remove the project.", code: "has-sessions" };
      const i = projects.findIndex(p => p.id === id);
      if (i >= 0) projects.splice(i, 1);
      return { ok: true };
    },
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
      // Two journeys script workspaces.diff differently: the Changes tab's (panelRpc) by default, and the Files tab's
      // (below) when its journey sets window.__fakeFilesDiff before this script loads.
      if (panelRpc[c.method] && !(c.method === "workspaces.diff" && window.__fakeFilesDiff)) {
        panels.params.push({ method: c.method, sessionId: c.sessionId, params: c.params ?? null });
        if (panels.fail[c.method]) return { ok: false, reason: panels.fail[c.method] };
        return { ok: true, value: panelRpc[c.method](c, l) };
      }
      // Customise's journey scripted some of the methods the panel tabs' journey scripted below (schedules, agents):
      // the panel tabs' journey (window.__fakeFilesDiff) gets its own answers.
      const cz = window.__fakeFilesDiff ? null : customise(c);
      if (cz) return cz;
      switch (c.method) {
        case "models.list": return { ok: true, value: { models: [
          { id: "gpt-5.5", name: "GPT-5.5", vendor: "OpenAI", capabilities: { supports: { reasoningEffort: true, vision: true }, limits: { max_context_window_tokens: 400_000, max_output_tokens: 128_000 } }, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", billing: { multiplier: 1 }, policy: { state: "enabled" } },
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", vendor: "Anthropic", capabilities: { supports: { reasoningEffort: true, vision: true }, limits: { max_context_window_tokens: 200_000 } }, supportedReasoningEfforts: ["low", "medium", "high"], billing: { multiplier: 1 }, policy: { state: "enabled" } },
          { id: "gpt-5.4-mini", name: "GPT-5.4 mini", vendor: "OpenAI", capabilities: { supports: {}, limits: { max_context_window_tokens: 128_000 } }, billing: { multiplier: 0 } },
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
        case "workspaces.diff":
          if (c.params?.mode === "session") return { ok: true, value: { requestedMode: "session", mode: "session", isFallback: false, changes: [
            { path: "src/login.ts", diff: "", changeType: "modified", contents: { before: "", after: LOGIN } },
            { path: "assets/logo.png", diff: "", changeType: "added", contents: { after: "\u0089PNG\r\n\u0000\u0000" } },
          ] } };
          return { ok: true, value: { requestedMode: c.params?.mode, mode: "unstaged", isFallback: false, changes: [
            { path: "src/login.ts", diff: DIFF, changeType: "modified" },
            { path: "assets/logo.png", diff: "", changeType: "added" },
            { path: "docs/old.md", diff: "", changeType: "deleted" },
            { path: "../outside.txt", diff: "", changeType: "modified" },
          ] } };
        case "workspaces.listFiles": return { ok: true, value: { files: Object.keys(sessionFiles) } };
        // The runtime answers statFile only with its "session memory v2" on, which it isn't: main says so.
        case "workspaces.statFile": return { ok: false, reason: "This version of Copilot can't do that here." };
        case "workspaces.readFile": { const f = sessionFiles[c.params.path]; return f === undefined ? { ok: false, reason: "That file isn't there." } : { ok: true, value: { content: f } }; }
        case "shell.executeUserRequested": {
          const sid = c.sessionId, id = c.params.requestId, command = c.params.command, call = `user-${id}`;
          emit(sid, "tool.user_requested", { toolCallId: call, toolName: "local_shell", arguments: { command, description: `Execute shell command: ${command}` } });
          if (command.startsWith("sleep")) {
            later(30, () => emit(sid, "tool.shell_output", { toolCallId: call, text: "waiting…\n", stream: "stdout", sequence: 0 }, eph));
            return new Promise(res => userRuns.set(id, () => { emit(sid, "tool.execution_complete", { toolCallId: call, isUserRequested: true, success: false, error: { message: "Shell command canceled." }, sandboxed: true }); res({ ok: true, value: { toolCallId: call, success: false, output: "", error: "Shell command canceled." } }); }));
          }
          const output = command === "git status" ? "On branch main\n\u001b[31mmodified:   src/login.ts\u001b[0m\n\u001b[32m\u001b[1mnew file:   assets/logo.png\u001b[0m\n\u001b]0;title\u0007" : `${command}: done\n`;
          await new Promise(r => later(40, r));
          emit(sid, "tool.shell_output", { toolCallId: call, text: output, stream: "stdout", sequence: 0 }, eph);
          emit(sid, "tool.execution_partial_result", { toolCallId: call, partialOutput: output.trimEnd() }, eph);
          emit(sid, "tool.execution_complete", { toolCallId: call, isUserRequested: true, success: true, shellExecution: { exitCode: 0 }, result: { content: output.trimEnd() }, sandboxed: true });
          return { ok: true, value: { toolCallId: call, success: true, output, exitCode: 0 } };
        }
        case "shell.cancelUserRequested": { const fn = userRuns.get(c.params.requestId); userRuns.delete(c.params.requestId); if (fn) fn(); return { ok: true, value: { cancelled: !!fn } }; }
        case "tasks.list": return { ok: true, value: tasks() };
        case "tasks.getProgress": return { ok: true, value: { progress: c.params.id === "bg-1" ? { type: "agent", recentActivity: [{ message: "▸ view src/oauth.ts", timestamp: iso(now) }], latestIntent: "Reading the OAuth callback" } : c.params.id === "sh-1" ? { type: "shell", recentOutput: "PASS test/login.test.ts\nWaiting for file changes…\n" } : null } };
        case "tasks.sendMessage": return { ok: true, value: { sent: true } };
        case "tasks.cancel": return { ok: true, value: { cancelled: true } };
        case "tasks.remove": { const i = taskLog.findIndex(t => t.id === c.params.id); if (i >= 0) taskLog.splice(i, 1); return { ok: true, value: { removed: i >= 0 } }; }
        case "tasks.getCurrentPromotable": return { ok: true, value: {} };
        case "tasks.promoteCurrentToBackground": return { ok: true, value: {} };
        case "tasks.promoteToBackground": return { ok: true, value: { promoted: true } };
        case "tasks.startAgent": taskLog.unshift({ type: "agent", id: `bg-${taskLog.length + 9}`, toolCallId: "", displayName: c.params.name, description: c.params.prompt, status: "running", startedAt: iso(Date.now()), agentType: c.params.agentType, prompt: c.params.prompt, executionMode: "background" }); later(5, () => emit(c.sessionId, "session.background_tasks_changed", {}, eph)); return { ok: true, value: { agentId: "agent-new" } };
        case "fleet.start": return { ok: true, value: { started: true } };
        case "agent.list": return { ok: true, value: { agents: [
          { id: "reviewer", name: "reviewer", displayName: "Code reviewer", description: "Reviews a change", source: "project" },
          { id: "hidden", name: "hidden", displayName: "Hidden", description: "Sub-agent only", userInvocable: false },
        ] } };
        case "schedule.list": return { ok: true, value: { entries: schedules.slice() } };
        case "schedule.stop": { const e = schedules.find(x => x.id === c.params.id); schedules = schedules.filter(x => x.id !== c.params.id); return { ok: true, value: e ? { entry: e } : {} }; }
        default: return { ok: false, reason: "Not in this test." };
      }
    },
    onEvent(fn) { listeners.event.add(fn); return () => listeners.event.delete(fn); },
    onRow(fn) { listeners.row.add(fn); return () => listeners.row.delete(fn); },
    onRequest(fn) { listeners.request.add(fn); return () => listeners.request.delete(fn); },
    async openLink(url) { calls.push(`openLink:${url}`); return /^https?:\/\//.test(url) ? { ok: true } : { ok: false, reason: "Ember opens only web addresses (http or https) from here." }; },
    async listFolder(id, rel) {
      calls.push(`listFolder:${id}:${rel}`);
      const r = sessions.get(id);
      const tree = r?.folder === "/home/me/work/app" ? workTree : { "": [{ name: "package.json", kind: "file", size: 212 }] };
      const entries = tree[rel];
      if (!r || !entries) return { ok: false, reason: "That isn't a file or folder in this session's folder." };
      return { ok: true, value: { entries: entries.map(e => ({ ...e, path: `${r.folder}/${rel ? `${rel}/` : ""}${e.name}` })), gitPrefix: "" } };
    },
    async readFile(id, rel) {
      calls.push(`readFile:${id}:${rel}`);
      const f = workFiles[rel];
      if (f === undefined) return { ok: false, reason: "That isn't a file or folder in this session's folder." };
      if (typeof f !== "string") return { ok: true, value: f };
      return { ok: true, value: { text: f, size: new TextEncoder().encode(f).length } };
    },
    markRead(id) { calls.push(`markRead:${id}`); const r = sessions.get(id); if (r?.unread) { sessions.set(id, { ...r, unread: 0 }); for (const fn of listeners.row) fn(sessions.get(id)); } },
    onMicHeld(fn) { listeners.mic.add(fn); fn(micHeld); return () => listeners.mic.delete(fn); },
    openSignIn() { calls.push("openSignIn"); },
  };
  window.emberCode = api;
  window.__fake = {
    calls, emit, sessions, pending, panels, request: openRequest, setRow,
    refuse, params, mcp,
    gap() { skip = true; },
    /** Main's word that the microphone opened or closed for a request. */
    mic(on) { micHeld = on; for (const fn of listeners.mic) fn(on); },
    wait(name) { return reached.has(name) ? Promise.resolve() : new Promise(r => waiters.set(name, [...(waiters.get(name) ?? []), r])); },
    reached: (name) => reached.has(name),
  };
})();
