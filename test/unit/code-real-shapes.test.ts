/**
 * The coding window's readers against what the bundled runtime really answered (test/fixtures/code-window/
 * real-shapes.ts, recorded on runtime 1.0.97: docs/CODING-APP.md §7), and main's pure parts that keep its answers in
 * Ember's words: the panels' models (Changes, Plan, Files, Terminal), Customise's readers, the transcript's rewind and
 * the person's own commands, and main's sentence for a failed method and the MCP values it keeps from the window.
 */
import { describe, expect, it } from "vitest";
import { CODE_KEPT, type CodeEventEnvelope, type CodeSdkEvent } from "../../app/shared/code";
import { REAL } from "../fixtures/code-window/real-shapes";
import { changesFiles, diffFrom, previewFrom, rewindPointsFrom, rewindResultFrom, shownPath } from "../../app/renderer/code/changes-model";
import { objectiveFileFrom, objectiveStateFrom, planFrom, todosFrom } from "../../app/renderer/code/plan-model";
import { buildTree, diffFiles, fromGitRoot, visibleRows, workspaceFiles } from "../../app/renderer/code/files-model";
import { liveRowFor, shellRuns } from "../../app/renderer/code/terminal-model";
import {
  allowedPaths, compacted, contextView, currentModel, discoveryPaths, enforcement, heaviest, hookRows, hostSupport, managedDevice, managedSession,
  mcpConfigured, mcpDiscovered, mcpItems, mcpLive, mcpStatusChanged, providerInstances, providerRows, quotaRows, remedyWords, skillRows, switchOutcome, usageView,
} from "../../app/renderer/code/customise-read";
import { EMPTY_TRANSCRIPT, attachedTranscript, reduceEvent, withoutRewound } from "../../app/renderer/code/transcript";
import { CODE_REFUSALS, rpcFailure } from "../../app/main/code/guards";
import { hideMcpSecrets, keptMerged, KeptMissing } from "../../app/main/code/mcp-secrets";

let n = 0;
const ev = (type: string, data: unknown, id = `r${++n}`): CodeSdkEvent => ({ id, timestamp: "2026-11-28T02:50:00Z", type, data });
const env = (seq: number, e: CodeSdkEvent): CodeEventEnvelope => ({ sessionId: "s1", seq, event: e });

describe("the Changes tab on the runtime's answers", () => {
  it("reads workspaces.diff in each mode, its paths the repository top's (real session and branch diffs)", () => {
    const v = diffFrom(REAL.diffSession, "session")!;
    expect(v.files.map(f => [f.path, f.status, f.added, f.removed])).toEqual([["a.txt", "modified", 1, 0], ["sub/b.txt", "modified", 1, 1], ["sub/new.txt", "added", 1, 0]]);
    expect([v.mode, v.fallback, v.added, v.removed]).toEqual(["session", false, 3, 1]);
    expect(diffFrom(REAL.diffBranch, "branch")).toMatchObject({ mode: "branch", baseBranch: "main", files: [{ path: "a.txt" }] });
  });

  it("reads rewind points newest first, a preview's absolute paths as the session's folder's, and a rewind's outcome", () => {
    const list = rewindPointsFrom(REAL.rewindPoints)!;
    expect(list.tracking).toBe(true);
    expect(list.points.map(p => [p.message, p.canRestoreFiles, p.fileCount])).toEqual([["background turn", false, 0], ["second turn", true, 2], ["first turn", true, 3]]);
    const preview = previewFrom(REAL.previewRewind)!;
    expect(preview.files.map(f => [shownPath(f.path, "/tmp/p/work"), f.change])).toEqual([["sub/b.txt", "modified"], ["sub/new.txt", "created"]]);
    expect(rewindResultFrom(REAL.rewindFiles)).toEqual({ outcome: "success", restored: ["/tmp/p/work/sub/b.txt", "/tmp/p/work/sub/new.txt"], skipped: [] });
  });

  it("reads the diff again after a tool that edited a file or ran a command, not after any other (real tool.execution_complete)", () => {
    expect(changesFiles(REAL.editComplete)).toBe(true);
    expect(changesFiles(REAL.shellComplete)).toBe(true);
    expect(changesFiles({ toolCallId: "v", success: true, result: { content: "a file's text" } })).toBe(false);
    expect(changesFiles(null)).toBe(false);
  });
});

describe("a rewind in the transcript", () => {
  it("draws the history again without what a rewind took away, from main's held events or the SDK's cut history (real snapshot_rewind)", () => {
    const first = ev("user.message", { content: "first turn" }, "ev-first");
    const reply1 = ev("assistant.message", { messageId: "m1", content: "one" });
    const second = ev("user.message", { content: "second turn" }, "ev-second");
    const reply2 = ev("assistant.message", { messageId: "m2", content: "two" });
    const rewind = ev("session.snapshot_rewind", REAL.snapshotRewind);
    const held = [first, reply1, second, reply2, rewind].map((e, i) => env(i + 1, e));
    expect(withoutRewound(held).map(e => e.event.id)).toEqual(["ev-first", reply1.id]);
    // The SDK's own history after the rewind no longer holds the message: the rewind event alone goes.
    expect(withoutRewound([env(1, first), env(2, reply1), env(5, rewind)]).map(e => e.event.id)).toEqual(["ev-first", reply1.id]);
    const t = attachedTranscript(undefined, held, 5);
    expect(t.items.filter(i => i.kind === "user").map(i => (i.kind === "user" ? i.text : ""))).toEqual(["first turn"]);
    expect(t.stale).toBe(false);
    expect(t.rebuild).toBeUndefined();
    // Events every real session sends that are no row of the transcript: the system prompt, a server leaving as it restarts.
    for (const type of ["system.message", "session.mcp_server_removed", "session.autopilot_objective_changed"]) expect(reduceEvent(EMPTY_TRANSCRIPT, ev(type, { content: "x" })).items, type).toEqual([]);
    // Live, the rewind still marks the transcript to be drawn again.
    expect(reduceEvent(EMPTY_TRANSCRIPT, rewind)).toMatchObject({ stale: true, rebuild: true });
  });
});

describe("the Plan tab on the runtime's answers", () => {
  it("reads plan.read with and without a plan, to-dos with dependencies and the Autopilot objective", () => {
    expect(planFrom(REAL.planNone)).toEqual({ exists: false, content: "" });
    expect(planFrom(REAL.planRead)).toEqual({ exists: true, content: "# Plan\n\n- [ ] one\n- [ ] two\n" });
    expect(todosFrom(REAL.todosWithDependencies, true)!.todos.map(t => [t.id, t.title, t.status, t.description])).toEqual([["t1", "Read the code", "pending", undefined], ["t2", "Change it", "pending", undefined]]);
    expect(objectiveStateFrom(REAL.objectiveState)).toBeNull();
    expect(objectiveFileFrom(REAL.objectiveRead)).toBe("Ship it.");
  });
});

describe("the Files tab on the runtime's answers", () => {
  it("marks a subfolder session's changes by its own paths: the diff's are the repository top's", () => {
    expect(fromGitRoot("sub/b.txt", "sub/")).toBe("b.txt");
    expect(fromGitRoot("a.txt", "sub/")).toBeNull();
    expect(fromGitRoot("a.txt", "")).toBe("a.txt");
    expect(fromGitRoot("a.txt", undefined)).toBe("a.txt");
    expect(diffFiles(REAL.diffInSubfolder).map(f => fromGitRoot(f.path, "sub/")).filter(Boolean)).toEqual(["b.txt"]);
  });

  it("lists the session's own files (workspaces.listFiles is the state folder, not the working folder) and builds folders main listed, empty ones too", () => {
    expect(workspaceFiles(REAL.listFiles)).toEqual(["notes.md"]);
    const tree = buildTree([{ root: "folder", path: "src", dir: true }, { root: "folder", path: "docs", dir: true }, { root: "folder", path: "src/a.ts" }, { root: "folder", path: "README.md" }], { folder: "work", session: "Session" });
    const rows = visibleRows(tree, new Set(["root:folder", "folder:src/"]));
    expect(rows.map(r => [r.node.name, r.node.dir, r.level])).toEqual([["work", true, 1], ["docs", true, 2], ["src", true, 2], ["a.ts", false, 3], ["README.md", false, 2], ["Session", true, 1]]);
  });
});

describe("the Terminal tab on the runtime's answers", () => {
  it("shows the person's own command live from tool.user_requested, which the runtime sends in place of tool.execution_start", () => {
    let t = EMPTY_TRANSCRIPT;
    for (const e of REAL.userShellEvents.slice(0, 3)) t = reduceEvent(t, ev(e.type, e.data));
    const live = liveRowFor(t, "echo user-shell && pwd", new Set());
    expect(live).toMatchObject({ toolCallId: "u-call", state: "running", userRequested: true, output: "user-shell\n/tmp/p/work\n" });
    t = reduceEvent(t, ev(REAL.userShellEvents[3].type, REAL.userShellEvents[3].data));
    expect(shellRuns(t)).toEqual([expect.objectContaining({ toolCallId: "u-call", state: "done", exitCode: 0, sandboxed: true, userRequested: true })]);
    // A cancelled one ends failed, with no exit code.
    let c = reduceEvent(EMPTY_TRANSCRIPT, ev("tool.user_requested", { toolCallId: "u-call-2", toolName: "local_shell", arguments: { command: "sleep 8" } }));
    c = reduceEvent(c, ev("tool.execution_complete", REAL.userShellCancelledEvent));
    expect(shellRuns(c)).toEqual([expect.objectContaining({ state: "failed", userRequested: true })]);
    expect(shellRuns(c)[0].exitCode).toBeUndefined();
  });
});

describe("Customise on the runtime's answers", () => {
  it("reads MCP's configuration as main passes it (no type for a program; values kept) and the session's servers with the runtime's host view", () => {
    const { rows } = mcpConfigured(hideMcpSecrets(REAL.mcpConfigRaw));
    expect(rows.map(r => [r.name, r.kind, r.envNames, r.headerNames])).toEqual([["probe", "stdio", ["PROBE_SECRET"], []], ["web", "http", [], ["Authorization"]]]);
    expect(JSON.stringify(rows)).not.toMatch(/s3cret|Bearer/);
    expect(mcpDiscovered(REAL.mcpDiscover).map(s => [s.name, s.enabled])).toEqual([["probe", true], ["web", true]]);
    // A server that failed to connect is only in host.failedServers: it is listed, failed, its words kept out.
    expect(mcpLive(REAL.mcpListFailed)).toEqual([{ name: "probe", status: "connected", failed: false }, { name: "web", status: "failed", failed: true }]);
    expect(mcpLive(REAL.mcpListStopped)).toEqual([{ name: "probe", status: "stopped", failed: false }]);
    expect(mcpLive({ servers: [], host: { needsAuthServers: { docs: { timestamp: 1 } }, pendingConnections: ["slow"], failedServers: {}, disabledServers: ["off"] } }).map(s => [s.name, s.status]))
      .toEqual([["docs", "needs-auth"], ["slow", "pending"], ["off", "disabled"]]);
    expect(mcpStatusChanged(mcpLive(REAL.mcpListStopped), REAL.mcpStatusChanged)).toEqual([{ name: "probe", status: "connected", failed: false }]);
    expect(mcpItems(REAL.mcpTools, "tools")).toEqual([{ name: "shout", description: "Shouts the words back." }]);
  });

  it("reads models, providers, skills, discovery paths, hooks, the organisation's settings, folders, the sandbox and usage as the runtime gives them", () => {
    expect(currentModel(REAL.modelCurrent)).toEqual({ modelId: "mock-model", effort: "low" });
    expect(switchOutcome(REAL.modelSwitch)).toEqual({ deferred: false, modelId: "mock-model" });
    expect(providerRows(REAL.providersCatalog)).toEqual([{ adapterId: "ollama", kind: "ollama", name: "Ollama", discovery: "automatic", network: "loopbackOnly", needsInput: false, needsTrust: false }]);
    expect(providerInstances(REAL.providersDiscoverAbsent)).toEqual({ outcome: "absent", instances: [] });
    expect(skillRows(REAL.skillsList)).toEqual([expect.objectContaining({ name: "customize-cloud-agent", source: "builtin", enabled: true, userInvocable: false, command: "customize-cloud-agent" })]);
    expect(discoveryPaths(REAL.skillsPaths).map(p => [p.scope, p.preferred])).toEqual([["project", true], ["personal-copilot", true]]);
    expect(discoveryPaths(REAL.instructionPaths).map(p => [p.scope, p.kind])).toEqual([["user", "file"], ["repository", "file"]]);
    // A hook loading error is counted, never shown in the runtime's words.
    expect(hookRows(REAL.hooksDiscover)).toEqual({ hooks: [], warnings: 0, errors: 1 });
    expect(managedSession(REAL.managedGet)).toEqual({ approveAllOff: false, keys: [], managed: false, failClosed: false, sandboxForced: false });
    expect(managedDevice(REAL.managedRead)).toEqual({ present: false, unreadable: false });
    expect(allowedPaths(REAL.pathsList)).toEqual({ primary: "/tmp/p/work", directories: ["/tmp", "/tmp/p/userdata/code/copilot/installed-plugins", "/tmp/p/work/sub"], approved: [] });
    const host = hostSupport(REAL.hostSupport);
    expect(host.capabilities.map(c => [c.name, c.supported])).toEqual([["network", false], ["denied_paths", true], ["shell", true], ["filesystem_enumeration", true]]);
    expect(host.capabilities[0].reason).toBe("Bubblewrap cannot start sandboxed commands or services with this policy because its private network is unavailable. (Bubblewrap: sandbox networking requires 'slirp4netns' on PATH: No such file or directory (os error 2). Install slirp4netns.)");
    expect(remedyWords("x".repeat(400))).toHaveLength(300);
    expect(enforcement(REAL.enforcement)).toEqual({ required: false, blocked: false });
    expect(usageView(REAL.usage)).toMatchObject({ premium: 0, requests: 7, apiMs: 79, linesAdded: 2, linesRemoved: 1, files: 2, currentModel: "mock-model", models: [{ id: "mock-model", requests: 16, input: 1920, output: 320 }] });
    // Without a Copilot account there are no quota rows and no plan to name.
    expect(quotaRows(REAL.quota)).toEqual({ rows: [] });
    expect(contextView(REAL.contextInfo)).toEqual({ model: "mock-model", total: 13182, limit: 128000, system: 5505, conversation: 1661, tools: 6016, mcp: 41, compactAt: 102400 });
    expect(heaviest(REAL.heaviest).map(m => [m.role, m.tokens, m.share])).toEqual([["user", 492, 4], ["tool", 106, 1]]);
    expect(compacted(REAL.compact)).toEqual({ ok: true, tokens: 27, messages: 3 });
  });
});

describe("main's words for the runtime's failures, and the MCP values it keeps", () => {
  it("says each failed method in Ember's words, never the runtime's or the model service's (real messages)", () => {
    expect(rpcFailure(REAL.errors.includeContents)).toBe(CODE_REFUSALS.rpcUnsupported);
    expect(rpcFailure(REAL.errors.statFile)).toBe(CODE_REFUSALS.rpcUnsupported);
    expect(rpcFailure(REAL.errors.readFile)).toBe(CODE_REFUSALS.rpcMissing);
    expect(rpcFailure(REAL.errors.signedOut)).toBe(CODE_REFUSALS.rpcSignIn);
    expect(rpcFailure(REAL.errors.providerStatus)).toBe(CODE_REFUSALS.rpcBadRequest);
    expect(rpcFailure(REAL.errors.scheduleStop)).toBe(CODE_REFUSALS.rpcBadRequest);
    expect(rpcFailure(REAL.errors.noMcpHost)).toBe(CODE_REFUSALS.rpcNoMcp);
    expect(rpcFailure("something new")).toBe(CODE_REFUSALS.rpcFailed);
  });

  it("hides every variable, header and secret-named value, and puts back only values it holds", () => {
    const hidden = hideMcpSecrets({ servers: { s: { command: "x", env: { A: "1" }, auth: { clientSecret: "cs", clientId: "id" }, headers: { H: "h" } } } }) as { servers: Record<string, Record<string, unknown>> };
    expect(hidden.servers.s).toEqual({ command: "x", env: { A: CODE_KEPT }, auth: { clientSecret: CODE_KEPT, clientId: "id" }, headers: { H: CODE_KEPT } });
    expect(hideMcpSecrets({ servers: [] })).toEqual({ servers: {} });
    const stored = { servers: { s: { command: "x", env: { A: "1" }, auth: { clientSecret: "cs" } } } };
    expect(keptMerged({ name: "s", config: { command: "y", env: { A: CODE_KEPT, B: "2" }, auth: { clientSecret: CODE_KEPT } } }, stored)).toEqual({ name: "s", config: { command: "y", env: { A: "1", B: "2" }, auth: { clientSecret: "cs" } } });
    expect(keptMerged({ name: "s", config: { command: "y" } }, stored)).toEqual({ name: "s", config: { command: "y" } });
    expect(() => keptMerged({ name: "s", config: { env: { Z: CODE_KEPT } } }, stored)).toThrow(KeptMissing);
    expect(() => keptMerged({ name: "new", config: { env: { A: CODE_KEPT } } }, stored)).toThrow(KeptMissing);
    expect(() => keptMerged({ name: CODE_KEPT, config: {} }, stored)).toThrow(KeptMissing);
  });
});
