/**
 * What the bundled Copilot runtime (SDK 1.0.21, runtime 1.0.97) really answered, trimmed: recorded through main's hub
 * on 28 November 2026 against the mock model in a temporary git repository (docs/CODING-APP.md §7), with its folders
 * written as /tmp/p/work (the repository), /tmp/p/userdata (Ember's data) and session ids shortened. The unit tests
 * read the window's readers against these, so a reader built only from the SDK's generated types can't pass for true.
 */

const W = "/tmp/p/work";
const STATE = "/tmp/p/userdata/code/copilot/session-state/s1";

export const REAL = {
  /**
   * The view tool's answer for a 2×2 PNG (`tool.execution_complete` data, telemetry left out), and what
   * `history.truncate` emits (28 November 2026, SDK 1.0.21, runtime 1.0.97, the mock model). A short provider key is a
   * secret the runtime masks everywhere (stars in the base64 too), so this one was recorded with a long key.
   */
  viewImageComplete: {
    toolCallId: "call_2", model: "mock-model", turnId: "0", rte: false, success: true,
    result: {
      content: "Viewed image file successfully.", detailedContent: `Viewed image file at path ${W}/pic.png`,
      binaryResultsForLlm: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM////ZwAAHu8E/KPItPcAAAAASUVORK5CYII=", mimeType: "image/png", description: `Image file at path ${W}/pic.png` }],
    },
  },
  truncateRewind: { type: "session.snapshot_rewind", data: { upToEventId: "61d50fa0-4d0d-4a98-8b1a-bbbf051fca8e", eventsRemoved: 5 } },
  /** `sessions.getSizes` and `sessions.pruneOld({ olderThanDays: 0, dryRun: true })`, client scope. */
  sizes: { sizes: { "e890b420-4884-43df-a9e5-a2bc48ce003d": 255720 } },
  pruneDry: { deleted: [], candidates: ["e890b420-4884-43df-a9e5-a2bc48ce003d"], skipped: [], freedBytes: 255720, dryRun: true },
  /** `history.summarizeForHandoff` after two turns (the mock model's words). */
  handoffSummary: { summary: "You said: f the appropriate sections, with special emphasis on the most recent operations." },
  diffSession: {
    requestedMode: "session", mode: "session", isFallback: false, changes: [
      { path: "a.txt", diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n alpha\n beta\n gamma\n+delta", changeType: "modified" },
      { path: "sub/b.txt", diff: "diff --git a/sub/b.txt b/sub/b.txt\n--- a/sub/b.txt\n+++ b/sub/b.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO", changeType: "modified" },
      { path: "sub/new.txt", diff: "diff --git a/sub/new.txt b/sub/new.txt\n--- /dev/null\n+++ b/sub/new.txt\n@@ -0,0 +1,1 @@\n+brand new", changeType: "added" },
    ],
  },
  diffSessionContents: {
    requestedMode: "session", mode: "session", isFallback: false, changes: [
      { path: "sub/b.txt", diff: "diff --git a/sub/b.txt b/sub/b.txt\n--- a/sub/b.txt\n+++ b/sub/b.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO", changeType: "modified", contents: { before: "one\ntwo\n", after: "one\nTWO\n" } },
      { path: "sub/new.txt", diff: "diff --git a/sub/new.txt b/sub/new.txt\n--- /dev/null\n+++ b/sub/new.txt\n@@ -0,0 +1,1 @@\n+brand new", changeType: "added", contents: { after: "brand new\n" } },
    ],
  },
  diffBranch: {
    requestedMode: "branch", mode: "branch", baseBranch: "main", isFallback: false, changes: [
      { path: "a.txt", diff: "diff --git a/a.txt b/a.txt\nindex 85c3040..7a28df3 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n alpha\n beta\n gamma\n+delta", changeType: "modified" },
    ],
  },
  /** `workspaces.diff` of a session whose folder is the repository's sub/: its paths are the repository top's. */
  diffInSubfolder: {
    requestedMode: "unstaged", mode: "unstaged", isFallback: false, changes: [
      { path: "a.txt", diff: "", changeType: "modified" },
      { path: "sub/b.txt", diff: "diff --git a/sub/b.txt b/sub/b.txt\nindex 814f4a4..4cb29ea 100644\n--- a/sub/b.txt\n+++ b/sub/b.txt\n@@ -1,2 +1,3 @@\n one\n two\n+three", changeType: "modified" },
      { path: "f2.txt", diff: "", changeType: "added" },
    ],
  },
  /** The runtime's refusal of `includeContents` outside the session mode, and of the other methods probed. */
  errors: {
    includeContents: "Request session.workspaces.diff failed with message: includeContents is only supported for session diffs",
    statFile: "Request session.workspaces.statFile failed with message: Session memory v2 is disabled for this session. Turn on the `contextManagementTools` setting and restart to enable it.",
    readFile: "Request session.workspaces.readFile failed with message: ENOENT: No such file or directory (os error 2)",
    signedOut: "Request models.list failed with message: Not authenticated. Please authenticate first.",
    providerStatus: "missing field `providerKind`",
    scheduleStop: "Request session.schedule.stop failed with message: missing numeric parameter 'id'",
    noMcpHost: "Request session.mcp.resources.list failed with message: No MCP host initialized",
  },
  rewindPoints: {
    fileChangeTrackingEnabled: true, points: [
      { eventId: "ev-first", userMessage: "first turn", timestamp: "2026-11-28T02:49:48.988Z", canRestoreFiles: true, fileCount: 3, turnChangedFiles: true, linesAdded: 1, linesRemoved: 0, isAutopilotContinuation: false },
      { eventId: "ev-second", userMessage: "second turn", timestamp: "2026-11-28T02:49:49.116Z", canRestoreFiles: true, fileCount: 2, turnChangedFiles: true, linesAdded: 1, linesRemoved: 1, isAutopilotContinuation: false },
      { eventId: "ev-bg", userMessage: "background turn", timestamp: "2026-11-28T02:50:07.174Z", canRestoreFiles: false, fileCount: 0, turnChangedFiles: false, linesAdded: 0, linesRemoved: 0, isAutopilotContinuation: false },
    ],
  },
  previewRewind: {
    available: true, fileCount: 2, files: [
      { path: `${W}/sub/b.txt`, changeType: "modified", linesAdded: 1, linesRemoved: 1 },
      { path: `${W}/sub/new.txt`, changeType: "created", linesAdded: 1, linesRemoved: 0 },
    ],
  },
  rewindFiles: { outcome: "success", restoredFiles: [`${W}/sub/b.txt`, `${W}/sub/new.txt`], skippedFiles: [], eventsRemoved: 190 },
  /** The event a rewind sends (it isn't ephemeral, and the run's log still holds what it removed). */
  snapshotRewind: { upToEventId: "ev-second", eventsRemoved: 190 },
  planNone: { exists: false, content: null, path: `${STATE}/plan.md` },
  planRead: { exists: true, content: "# Plan\n\n- [ ] one\n- [ ] two\n", path: `${STATE}/plan.md` },
  planUpdate: null,
  todosWithDependencies: {
    rows: [
      { id: "t1", title: "Read the code", description: null, status: "pending", createdAt: "2026-11-28 02:53:08" },
      { id: "t2", title: "Change it", description: null, status: "pending", createdAt: "2026-11-28 02:53:08" },
    ],
    dependencies: [],
  },
  objectiveState: { state: null },
  objectiveRead: { content: "Ship it." },
  objectiveWrite: { operation: "create" },
  objectiveDelete: { deleted: true },
  exitPlanMode: {
    requestId: "r-plan", summary: "Do the thing", actions: ["autopilot", "interactive", "exit_only"], recommendedAction: "autopilot",
    toolCallId: "call_11", model: "mock-model", planContent: "",
  },
  exitPlanModeCompleted: { approved: true, selectedAction: "interactive", requestId: "r-plan" },
  /** The session's own files (its state folder), not the working folder. */
  listFiles: { files: ["notes.md"] },
  readSessionFile: { content: "hello" },
  /** A command the person ran (`shell.executeUserRequested`): its events in order, and the call's answer. */
  userShellEvents: [
    { type: "tool.user_requested", data: { toolCallId: "u-call", toolName: "local_shell", arguments: { command: "echo user-shell && pwd", description: "Execute shell command: echo user-shell && pwd" } } },
    { type: "tool.execution_partial_result", data: { toolCallId: "u-call", partialOutput: `user-shell\n${W}` } },
    { type: "tool.shell_output", data: { toolCallId: "u-call", stream: "stdout", text: `user-shell\n${W}\n`, sequence: 0 } },
    { type: "tool.execution_complete", data: { toolCallId: "u-call", isUserRequested: true, success: true, shellExecution: { exitCode: 0 }, result: { content: `user-shell\n${W}` }, sandboxed: true } },
  ],
  userShellResult: { toolCallId: "u-call", success: true, output: `user-shell\n${W}`, exitCode: 0 },
  userShellCancelled: { toolCallId: "u-call-2", success: false, output: "", error: "Shell command canceled." },
  userShellCancelledEvent: { toolCallId: "u-call-2", isUserRequested: true, success: false, error: { message: "Shell command canceled." }, sandboxed: true },
  /** A tool that edited a file (`fileEdits`, no shell) and a command (`shellExecution`), as `tool.execution_complete` sends them. */
  editComplete: { toolCallId: "call_3", success: true, fileEdits: [{ path: `${W}/sub/b.txt`, kind: "edit" }], result: { content: `File ${W}/sub/b.txt updated with changes.` }, sandboxed: true },
  shellComplete: { toolCallId: "call_1", success: true, shellExecution: { exitCode: 0 }, result: { content: "ran\n<shellId: 0 completed with exit code 0>" }, sandboxed: true },
  tasksList: {
    tasks: [
      { type: "agent", id: "a-helper", toolCallId: "a-helper", displayName: "helper", description: "helper", status: "idle", agentType: "general-purpose", prompt: "say hi", resolvedModel: "mock-model", executionMode: "background", canPromoteToBackground: false, latestResponse: "Hello from the mock model.", activeTimeMs: 60, model: "mock-model", startedAt: "2026-11-28T02:50:17.283Z", idleSince: "2026-11-28T02:50:17.343Z" },
      { type: "shell", id: "1", description: "wait in the background", status: "completed", command: "sleep 40", attachmentMode: "attached", executionMode: "background", pid: 26883, startedAt: "2026-11-28T02:50:07.189Z", completedAt: "2026-11-28T02:50:17.208Z" },
    ],
  },
  shellProgress: { progress: { type: "shell", recentOutput: "(no output yet)", pid: 26883 } },
  agentProgress: { progress: { type: "agent", recentActivity: [] } },
  startAgent: { agentId: "a-helper" },
  agentList: { agents: [] },
  agentCurrent: { agent: null },
  scheduleList: { entries: [] },
  modelCurrent: { modelId: "mock-model", reasoningEffort: "low" },
  modelSwitch: { status: "applied", deferred: false, modelId: "mock-model", deprecationWarnings: [], modelState: { modelId: "mock-model" } },
  providersCatalog: { providers: [{ adapterId: "ollama", providerKind: "ollama", displayName: "Ollama", provenance: { source: "builtIn" }, automaticDiscovery: { mode: "automatic", networkScope: "loopbackOnly", requiresInput: false, requiresTrust: false }, operations: [{ name: "discover" }, { name: "getStatus" }, { name: "models.list" }] }] },
  providersDiscoverAbsent: { outcome: { code: "absent", message: "Ollama is not listening at http://127.0.0.1:11434" }, instances: [] },
  /** `mcp.config.list` as the runtime answers it, before main hides the values: a stdio server has no `type`. */
  mcpConfigRaw: {
    servers: {
      probe: { tools: ["*"], env: { PROBE_SECRET: "s3cret" }, command: "/usr/bin/node", args: ["/tmp/p/mcp-server.cjs"] },
      web: { tools: ["*"], type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } },
    },
  },
  mcpDiscover: { servers: [{ name: "probe", type: "stdio", source: "user", enabled: true }, { name: "web", type: "http", source: "user", enabled: true }] },
  /** Session `mcp.list`: a failed server only in `host.failedServers`, never in `servers`. */
  mcpListFailed: {
    servers: [{ name: "probe", status: "connected", serverMetadata: { instructions: null } }],
    host: {
      clients: ["probe"], disabledServers: [], filteredServers: [], pendingConnections: [], needsAuthServers: {}, mcp3pEnabled: true,
      failedServers: { web: { message: "MCP server 'web': Sandbox policy denies outbound network access, so remote MCP servers cannot be reached.", timestamp: 1795834221932 } },
    },
  },
  mcpListStopped: { servers: [{ name: "probe", status: "stopped" }], host: { clients: [], disabledServers: [], filteredServers: [], pendingConnections: [], failedServers: {}, needsAuthServers: {}, mcp3pEnabled: true } },
  mcpStatusChanged: { serverName: "probe", status: "connected", configSource: "user" },
  mcpTools: { tools: [{ name: "shout", description: "Shouts the words back.", inputSchema: { type: "object", properties: { words: { type: "string" } }, required: ["words"] } }] },
  skillsList: { skills: [{ name: "customize-cloud-agent", commandName: "customize-cloud-agent", description: "Skill for customizing the Copilot cloud agent.", source: "builtin", userInvocable: false, enabled: true, path: "/opt/copilot/builtin/customize-cloud-agent/SKILL.md" }] },
  skillsPaths: { paths: [{ path: `${W}/.github/skills`, scope: "project", preferredForCreation: true, projectPath: W }, { path: "/tmp/p/userdata/code/copilot/skills", scope: "personal-copilot", preferredForCreation: true }] },
  instructionPaths: { paths: [{ path: "/tmp/p/userdata/code/copilot/copilot-instructions.md", location: "user", kind: "file", preferredForCreation: true }, { path: `${W}/.github/copilot-instructions.md`, location: "repository", kind: "file", preferredForCreation: true, projectPath: W }] },
  hooksDiscover: { hooks: [], warnings: [], errors: ["Explicit hook plugins could not be loaded: Standalone server does not support server effect 'hooks_explicit_plugins'"] },
  pluginsMarketplaces: { marketplaces: [{ name: "awesome-copilot", source: "GitHub: github/awesome-copilot", isDefault: true }] },
  managedGet: { source: "none", serverManaged: false, deviceManaged: false, clientManaged: false, policyHelperManaged: false, failClosed: false, sandboxEnabledByUndeterminedPolicy: false, bypassPermissionsDisabled: false, managedKeys: [], permissionsContext: { failClosed: false } },
  managedRead: {},
  pathsList: { directories: [W, "/tmp", "/tmp/p/userdata/code/copilot/installed-plugins", `${W}/sub`], sessionApprovedPaths: [], primary: W },
  hostSupport: {
    supported: true, capabilities: [
      { name: "network", supported: false, reason: "Bubblewrap cannot start sandboxed commands or services with this policy because its private network is unavailable. (Bubblewrap: sandbox networking requires 'slirp4netns' on PATH: No such file or directory (os error 2). Install slirp4netns.) Resolve the reported host requirement before retrying. See https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes" },
      { name: "denied_paths", supported: true }, { name: "shell", supported: true }, { name: "filesystem_enumeration", supported: true },
    ],
  },
  enforcement: { required: false, blocked: false },
  usage: {
    totalPremiumRequestCost: 0, totalUserRequests: 7, totalNanoAiu: 0, aiCreditsStatus: "unavailable", totalApiDurationMs: 79, sessionStartTime: "2026-11-28T02:49:48.920Z",
    codeChanges: { linesAdded: 2, linesRemoved: 1, filesModifiedCount: 2, filesModified: [`${W}/sub/b.txt`, `${W}/sub/new.txt`] },
    modelMetrics: { "mock-model": { requests: { count: 16, cost: 0 }, usage: { inputTokens: 1920, outputTokens: 320, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalNanoAiu: 0, aiCreditsStatus: "unavailable" } },
    currentModel: "mock-model", lastCallInputTokens: 120, lastCallOutputTokens: 20,
  },
  quota: { snapshots: {}, isFreeUser: false, isTbbUser: false, planTier: "unknown", premiumRequestsBillable: true, modelCostColumnVisible: true, delegateAvailable: true, canSignupForCopilotFree: false, dynamicWorkflowsEnabled: false, dynamicWorkflowsUiVisible: false },
  contextInfo: { contextInfo: { modelName: "mock-model", systemTokens: 5505, customInstructionsTokens: null, conversationTokens: 1661, toolDefinitionsTokens: 6016, mcpToolsTokens: 41, totalTokens: 13182, promptTokenLimit: 128000, compactionThreshold: 102400, limit: 128000, bufferTokens: 6400 } },
  heaviest: { totalTokens: 13182, messages: [{ id: "message-27", label: "user: <current_datetime>2026-11-28T02:50:20.110+00:00</…", role: "user", tokens: 492 }, { id: "message-25", label: "tool: read_agent", role: "tool", tokens: 106 }] },
  compact: { success: true, tokensRemoved: 27, messagesRemoved: 3, summaryContent: "Hello from the mock model.", contextWindow: { tokenLimit: 128000, currentTokens: 11531, messagesLength: 1, systemTokens: 5487, conversationTokens: 66, toolDefinitionsTokens: 5975 } },
} as const;
