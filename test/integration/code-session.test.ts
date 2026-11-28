// The coding session layer (app/main/code/, docs/CODING-APP.md step 1) on the real bundled Copilot runtime in its
// full Copilot mode and the local mock model: no account, no network. It settles what the window is built against:
// numbered events, a shell permission request with the SDK's own choices, answering it, detach and attach with
// sinceSeq, history after a restart (and a request left pending coming back), fork, rewind points, the RPC guards,
// worktrees and removal, Stop within the kill switch's budget, and the GitHub token kept out of commands. Linux: it
// needs git and, for the sandbox, bubblewrap (without it the sessions run unsandboxed and say so).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { KillSwitch } from "../../app/main/agent/killswitch";
import type { ChatPolicy } from "../../app/main/agent/chat-policy";
import { AuditLog } from "../../app/main/policy/audit";
import { CopilotClient } from "@github/copilot-sdk";
import { CodeRuntime, codeClientOptions, legacyCodeHome } from "../../app/main/code/runtime";
import { readPersistedHistory } from "../../app/main/code/session-runtime";
import { CodeHub } from "../../app/main/code/hub";
import { CODE_REFUSALS } from "../../app/main/code/guards";
import type { CodeAttached, CodeEventEnvelope, CodePendingRequest, CodeSessionRow } from "../../app/shared/code";
import type { OS } from "../../app/shared/shortcuts";

type Mock = { baseUrl: string; requests: { messages: { role: string; content: unknown }[] }[]; close(): Promise<void> };
const { id: runtimeId, exe } = runtimeFor(process.platform as OS, process.arch);
const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId, exe }).path;
const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
const call = (name: string, args: Record<string, unknown>) => `CALLTOOL:${name}${JSON.stringify(args)}`;
const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

let mock: Mock;
let dir: string, userData: string, work: string;
const runtimes: CodeRuntime[] = [];
const hubs: CodeHub[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

async function until(test: () => boolean, ms = 20_000, step = 20): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, step));
  }
}

/** A hub over its own coding runtime in `userData`, with everything it sends collected by window. */
function harness() {
  const runtime = new CodeRuntime({ userData, stateRoot: `${userData}-code`, runtimePath, env });
  runtimes.push(runtime);
  const events: CodeEventEnvelope[] = [];
  const rows: (CodeSessionRow | { removed: string })[] = [];
  const requests: (CodePendingRequest | { resolved: string; sessionId: string; by: string })[] = [];
  const audit = new AuditLog(path.join(dir, "audit"));
  const hub = new CodeHub({
    hasConsent: () => true, enabled: () => true, policy: () => OPEN, vaultFilled: () => false,
    access: () => ({ provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, model: "mock-model", service: "user" }),
    client: () => runtime.client(), userData, runtimeHome: () => runtime.home, protectedPaths: () => [userData], place: () => ({ os: "linux", home: os.homedir() }),
    audit: () => audit, log: quiet,
    emit: (channel, payload, to) => {
      if (channel === "code:event" && to === "w1") events.push(payload as CodeEventEnvelope);
      else if (channel === "code:row") rows.push(payload as CodeSessionRow);
      else if (channel === "code:request") requests.push(payload as CodePendingRequest);
    },
    pickFolder: async () => work, pickFiles: async () => [path.join(work, "a.txt")],
  });
  hubs.push(hub);
  const of = (id: string, type: string) => events.filter(e => e.sessionId === id && e.event.type === type);
  const opened = (id: string) => requests.filter((r): r is CodePendingRequest => "requestId" in r && r.sessionId === id);
  return { runtime, hub, events, rows, requests, audit, of, opened };
}

beforeAll(async () => {
  mock = await startMockLlm({ delayMs: 0 });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-session-")));
  userData = path.join(dir, "userdata");
  work = path.join(dir, "work");
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(userData, "settings.json"), "PRIVATE_EMBER_CANARY");
  git(work, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
}, 60_000);

afterAll(async () => {
  for (const h of hubs) await h.dispose().catch(() => undefined);
  for (const r of runtimes) await r.stop();
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe.runIf(process.platform === "linux")("a coding session on the bundled runtime", () => {
  it("streams numbered events, asks for a command with the SDK's choices, runs it on approve, catches a window up, keeps history over a restart, forks, lists rewind points and is removed", async () => {
    const h = harness();
    const created = await h.hub.dispatch({ type: "create", options: { name: "Pelican" } }, "user");
    if (!created.ok) throw new Error(created.reason);
    const id = created.value.id;
    expect(created.value).toMatchObject({ name: "Pelican", folder: work, isolation: "folder", branch: "main", open: true, permissionMode: "manual", agentMode: "interactive", createdBy: "user" });
    console.log(`[code-session] sandbox: ${created.value.sandbox}`);
    expect(["on", "no-network", "off"]).toContain(created.value.sandbox);
    const listed = await h.hub.dispatch({ type: "list" }, "user");
    expect(listed.projects).toEqual([expect.objectContaining({ folder: work, name: "work", gitRoot: work, branch: "main" })]);

    const first = await h.hub.dispatch({ type: "attach", sessionId: id }, "user", "w1");
    if (!first.ok) throw new Error(first.reason);
    expect(first.value.reset).toBe(true);
    const startSeq = first.value.seq;

    // A shell command asks, with exactly the SDK's choices for it.
    const sent = await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: call("bash", { command: "echo approved-ran > ran.txt", description: "write a marker" }) } }, "user");
    expect(sent.ok).toBe(true);
    await until(() => h.opened(id).length > 0);
    const asked = h.opened(id)[0];
    expect(asked.kind).toBe("permission");
    expect(asked.choices).toEqual(expect.arrayContaining(["approve-once", "reject"]));
    expect(asked.choices?.at(-1)).toBe("reject");
    expect((asked.data as { permissionRequest: { kind: string; fullCommandText: string } }).permissionRequest).toMatchObject({ kind: "shell", fullCommandText: "echo approved-ran > ran.txt" });
    console.log(`[code-session] shell choices: ${JSON.stringify(asked.choices)}`);
    expect((await h.hub.dispatch({ type: "list" }, "user")).sessions.find(r => r.id === id)?.pending).toBe(1);
    // A choice it doesn't offer is refused; then approve once.
    const wrong = await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: asked.requestId, kind: "permission", payload: { kind: "approve-permanently" } } }, "user");
    expect(wrong.ok).toBe(false);
    const answered = await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: asked.requestId, kind: "permission", payload: { kind: "approve-once" } } }, "user");
    expect(answered).toEqual({ ok: true });
    expect(h.requests).toContainEqual({ resolved: asked.requestId, sessionId: id, by: "user" });
    const again = await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: asked.requestId, kind: "permission", payload: { kind: "approve-once" } } }, "user");
    expect(again).toMatchObject({ ok: false, reason: CODE_REFUSALS.request });
    await until(() => h.of(id, "tool.execution_complete").length > 0);
    expect((h.of(id, "tool.execution_complete")[0].event.data as { success: boolean }).success).toBe(true);
    expect(fs.readFileSync(path.join(work, "ran.txt"), "utf8").trim()).toBe("approved-ran");
    await until(() => h.of(id, "session.idle").length > 0);
    // Every envelope came, in order, one seq after another; streamed deltas among them.
    const seqs = h.events.filter(e => e.sessionId === id).map(e => e.seq);
    expect(seqs[0]).toBe(startSeq + 1);
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)).toBe(true);
    expect(h.of(id, "assistant.message_delta").length).toBeGreaterThan(0);
    expect(h.audit.recent(100).some(e => e.event === "code" && e.phase === "decision" && e.kind === "permission" && e.by === "user")).toBe(true);
    expect(JSON.stringify(h.audit.recent(100))).not.toContain("approved-ran");

    // Detached, the window gets nothing; attached again from its last seq, only what it missed.
    const lastSeen = h.events.filter(e => e.sessionId === id).at(-1)!.seq;
    await h.hub.dispatch({ type: "detach", sessionId: id }, "user", "w1");
    const before = h.events.length;
    await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: "Remember the word PELICAN." } }, "user");
    await until(() => ((h.rows.filter((r): r is CodeSessionRow => "id" in r && r.id === id).at(-1)?.busy) === false) && (h.rows.filter((r): r is CodeSessionRow => "id" in r && r.id === id).at(-1)?.unread ?? 0) > 0);
    expect(h.events.length).toBe(before);
    const caught = await h.hub.dispatch({ type: "attach", sessionId: id, sinceSeq: lastSeen }, "user", "w1");
    if (!caught.ok) throw new Error(caught.reason);
    expect(caught.value.reset).toBeUndefined();
    expect(caught.value.events[0].seq).toBe(lastSeen + 1);
    expect(caught.value.events.map(e => e.event.type)).toContain("user.message");
    expect(caught.value.seq).toBe(caught.value.events.at(-1)!.seq);
    expect(caught.value.row.unread).toBe(0);

    // Rewind points come from the SDK (file tracking on).
    const rewind = await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "history.listRewindPoints" } }, "user");
    if (!rewind.ok) throw new Error(rewind.reason);
    expect((rewind.value as { fileChangeTrackingEnabled: boolean; points: unknown[] })).toMatchObject({ fileChangeTrackingEnabled: true });
    expect((rewind.value as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(2);

    // The RPC guards: a mode change has its own command, Ember's data isn't a path a call may pass.
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "permissions.setMode", params: { mode: "allow-all" } } }, "user")).toMatchObject({ ok: false });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "session", sessionId: id, method: "permissions.paths.add", params: { path: userData } } }, "user")).toMatchObject({ ok: false, reason: CODE_REFUSALS.rpcPath });
    expect(await h.hub.dispatch({ type: "rpc", call: { scope: "client", method: "sandbox.getHostSupport" } }, "user")).toMatchObject({ ok: true });

    // A command left waiting, then the runtime goes away: it comes back when the session is opened again.
    const n = h.opened(id).length;
    await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: call("bash", { command: "echo after-restart > later.txt", description: "later" }) } }, "user");
    await until(() => h.opened(id).length > n);
    await h.runtime.stop();
    await h.hub.dispose();

    const r = harness();
    const kept = (await r.hub.dispatch({ type: "list" }, "user")).sessions.find(s => s.id === id);
    expect(kept).toMatchObject({ id, open: false, name: "Pelican", folder: work });
    const reopened = await r.hub.dispatch({ type: "attach", sessionId: id }, "user", "w1");
    if (!reopened.ok) throw new Error(reopened.reason);
    const history: CodeAttached = reopened.value;
    expect(history.reset).toBe(true);
    const said = history.events.filter(e => e.event.type === "user.message").map(e => JSON.stringify(e.event.data));
    expect(said.some(s => s.includes("PELICAN"))).toBe(true);
    expect(history.events.every((e, i) => i === 0 || e.seq > history.events[i - 1].seq)).toBe(true);
    // The command left waiting is waiting again, with its choices.
    const back = history.pending.find(p => p.sessionId === id);
    expect(back).toMatchObject({ kind: "permission", choices: expect.arrayContaining(["approve-once", "reject"]) });
    expect((back!.data as { permissionRequest: { fullCommandText: string } }).permissionRequest.fullCommandText).toBe("echo after-restart > later.txt");
    const rejected = await r.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: back!.requestId, kind: "permission", payload: { kind: "reject", feedback: "Not now." } } }, "user");
    expect(rejected).toEqual({ ok: true });
    await until(() => r.of(id, "session.idle").length > 0);
    expect(fs.existsSync(path.join(work, "later.txt"))).toBe(false);

    // Fork: a new session from this one's history.
    const forked = await r.hub.dispatch({ type: "fork", sessionId: id, name: "Pelican fork" }, "user");
    if (!forked.ok) throw new Error(forked.reason);
    expect(forked.value).toMatchObject({ parentId: id, projectId: created.value.projectId, open: false });
    expect((await r.hub.dispatch({ type: "list" }, "user")).sessions.map(s => s.id)).toContain(forked.value.id);

    // Removed: gone from the list and from the runtime.
    expect(await r.hub.dispatch({ type: "remove", sessionId: forked.value.id }, "user")).toEqual({ ok: true });
    expect(await r.hub.dispatch({ type: "remove", sessionId: id }, "user")).toEqual({ ok: true });
    const after = (await r.hub.dispatch({ type: "list" }, "user")).sessions.map(s => s.id);
    expect(after).not.toContain(id);
    expect(after).not.toContain(forked.value.id);
    expect(r.rows).toContainEqual({ removed: id });
  }, 180_000);

  it("works in a worktree of its own on a new branch, which goes with the session; a folder that isn't a repository is refused", async () => {
    const h = harness();
    const created = await h.hub.dispatch({ type: "create", options: { isolation: "worktree" } }, "user");
    if (!created.ok) throw new Error(created.reason);
    const row = created.value;
    expect(row.isolation).toBe("worktree");
    expect(row.branch).toMatch(/^ember\/[a-z0-9]{1,8}$/);
    expect(row.folder).toBe(path.join(userData, "code", "worktrees", row.id));
    expect(git(row.folder, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(row.branch);
    // A command in it works in the worktree (its own folder, though inside Ember's data folder).
    await h.hub.dispatch({ type: "attach", sessionId: row.id }, "user", "w1");
    await h.hub.dispatch({ type: "setPermissionMode", sessionId: row.id, mode: "allow-all" }, "user");
    await h.hub.dispatch({ type: "send", message: { sessionId: row.id, prompt: call("bash", { command: "echo tree > made.txt", description: "in the tree" }) } }, "user");
    await until(() => h.of(row.id, "session.idle").length > 0);
    expect(fs.readFileSync(path.join(row.folder, "made.txt"), "utf8").trim()).toBe("tree");
    // A tool whose arguments name Ember's data is refused before it runs, sandbox or none.
    await h.hub.dispatch({ type: "send", message: { sessionId: row.id, prompt: call("bash", { command: `cat ${path.join(userData, "settings.json")}`, description: "Ember's data" }) } }, "user");
    await until(() => h.of(row.id, "session.idle").length > 1);
    const refused = h.of(row.id, "tool.execution_complete").at(-1)!.event.data as { success: boolean; error?: { message: string } };
    expect(refused).toMatchObject({ success: false, error: { message: expect.stringContaining(CODE_REFUSALS.emberToolPath) } });
    expect(JSON.stringify(h.events)).not.toContain("PRIVATE_EMBER_CANARY");
    expect(await h.hub.dispatch({ type: "remove", sessionId: row.id }, "user")).toEqual({ ok: true });
    expect(fs.existsSync(row.folder)).toBe(false);
    // Not a repository: no worktree.
    const plain = path.join(dir, "plain");
    fs.mkdirSync(plain);
    const notGit = new CodeHub({ ...(h.hub as unknown as { d: ConstructorParameters<typeof CodeHub>[0] }).d, pickFolder: async () => plain, audit: () => h.audit });
    hubs.push(notGit);
    expect(await notGit.dispatch({ type: "create", options: { isolation: "worktree" } }, "user")).toMatchObject({ ok: false, reason: CODE_REFUSALS.notGit });
    // Ember's own data folder is never a project.
    const own = new CodeHub({ ...(h.hub as unknown as { d: ConstructorParameters<typeof CodeHub>[0] }).d, pickFolder: async () => userData });
    hubs.push(own);
    expect(await own.dispatch({ type: "addProject" }, "user")).toMatchObject({ ok: false, reason: CODE_REFUSALS.emberData });
  }, 120_000);

  it("stops a command waiting for its answer through the kill switch within its budget (Stop)", async () => {
    const h = harness();
    const created = await h.hub.dispatch({ type: "create", options: {} }, "user");
    if (!created.ok) throw new Error(created.reason);
    const id = created.value.id;
    await h.hub.dispatch({ type: "attach", sessionId: id }, "user", "w1");
    await h.hub.dispatch({ type: "send", message: { sessionId: id, prompt: call("bash", { command: "sleep 614", description: "never approved" }) } }, "user");
    await until(() => h.opened(id).length > 0);
    const pending = h.opened(id)[0];
    const ks = new KillSwitch(() => [h.hub.stopPart()], quiet as never);
    const pulled = await ks.pull("hotkey");
    console.log(`[code-session] stop with a request pending: ${pulled.ms} ms, late ${JSON.stringify(pulled.late)}`);
    expect(pulled.ms).toBeLessThan(300);
    expect(pulled.late).toEqual([]);
    expect(h.requests).toContainEqual({ resolved: pending.requestId, sessionId: id, by: "system" });
    expect(h.hub.waiting()).toEqual([]);
    expect(await h.hub.dispatch({ type: "respond", answer: { sessionId: id, requestId: pending.requestId, kind: "permission", payload: { kind: "approve-once" } } }, "user")).toMatchObject({ ok: false });
  }, 90_000);

  it("keeps a session's GitHub token out of every command's environment in the full Copilot mode", async ctx => {
    const script = "const f=require('fs');const x=Buffer.from('gho_'+String.fromCharCode(113).repeat(36));let found=false;for(const p of f.readdirSync('/proc'))if(/^\\d+$/.test(p))try{found ||= f.readFileSync('/proc/'+p+'/environ').includes(x)}catch{}f.writeFileSync('found.txt',String(found))";
    let calls = 0;
    const local: Mock = await startMockLlm({ delayMs: 0, respond: () => ++calls === 1 ? { tool: { name: "bash", args: { command: `node -e ${JSON.stringify(script)}` } } } : { text: "done" } });
    const home = path.join(dir, "token-home");
    fs.mkdirSync(home, { mode: 0o700 });
    const options = codeClientOptions({ userData: home, runtimePath, env }, `${home}-code`);
    expect(options.mode).toBe("copilot-cli");
    expect(options).not.toHaveProperty("gitHubToken");
    const runtime = new CodeRuntime({ userData: home, stateRoot: `${home}-code`, runtimePath, env });
    runtimes.push(runtime);
    const client = await runtime.client();
    const folder = path.join(dir, "token-work");
    fs.mkdirSync(folder);
    const session = await client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: local.baseUrl, apiKey: "test" }, workingDirectory: folder,
      enableSkills: true, memory: { enabled: true }, enableHostGitOperations: true, enableSessionStore: true, enableOnDemandInstructionDiscovery: true,
      onPermissionRequest: () => ({ kind: "approve-once" } as never) });
    try {
      const support = await client.rpc.sandbox.getHostSupport();
      if (!support.supported) { ctx.skip(); return; }
      expect(await session.rpc.gitHubAuth.setCredentials({ credentials: { type: "token", host: "github.com", token: "gho_" + "q".repeat(36) } })).toMatchObject({ success: true });
      await session.sendAndWait({ prompt: "Run the probe." }, 20_000);
      expect(fs.readFileSync(path.join(folder, "found.txt"), "utf8")).toBe("false");
    } finally { await session.disconnect(); await local.close(); }
  }, 60_000);

  it("moves an earlier build's sessions out of Ember's data folder once, and opens them again there with their history", async () => {
    const earlierData = path.join(dir, "earlier-data");
    fs.mkdirSync(earlierData, { mode: 0o700 });
    // An earlier build: the runtime's state inside the data folder.
    const old = new CopilotClient(codeClientOptions({ userData: earlierData, runtimePath, env }, legacyCodeHome(earlierData)));
    await old.start();
    const made = await old.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, workingDirectory: work, onPermissionRequest: () => ({ kind: "approve-once" } as never) });
    await made.sendAndWait({ prompt: "remember-the-pelican" }, 20_000);
    const id = made.sessionId;
    await made.disconnect();
    await old.stop();
    const stateRoot = `${earlierData}-code`;
    const runtime = new CodeRuntime({ userData: earlierData, stateRoot, runtimePath, env });
    runtimes.push(runtime);
    const client = await runtime.client();
    expect(runtime.home).toBe(stateRoot);
    expect(fs.existsSync(legacyCodeHome(earlierData))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, "session-state", id))).toBe(true);
    expect((await client.listSessions()).map(s => s.sessionId)).toContain(id);
    const history = await readPersistedHistory(client, id);
    expect(JSON.stringify(history)).toContain("remember-the-pelican");
    const again = await client.resumeSession(id, { onPermissionRequest: () => ({ kind: "approve-once" } as never), provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" } });
    await again.sendAndWait({ prompt: "and again" }, 20_000);
    await again.disconnect();
  }, 90_000);
});
