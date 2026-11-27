// The native chat session (app/main/agent/chat-session.ts, chat-sessions.ts) on the real bundled Copilot runtime and
// the local mock model: no account, no network. It settles how the SDK's own permission system, its modes, Stop, the
// organisation's managedSettings, the sandbox that keeps Ember's data out of reach, resume and the vault's redactor
// behave. Linux: it reads /proc for the processes a command left. Needs the SDK's sandbox (bubblewrap); without it
// the one test that runs checks that no chat starts at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
// @ts-expect-error -- plain JS test helper
import { startMockLlm } from "../mock-llm/server.mjs";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { ChatRuntime } from "../../app/main/agent/chat-runtime";
import { ChatSessions, CHAT_REFUSALS } from "../../app/main/agent/chat-sessions";
import { ChatSession, ChatUnavailable } from "../../app/main/agent/chat-session";
import { ASK_EVERYTHING, chatPolicy, type ChatPolicy } from "../../app/main/agent/chat-policy";
import { AdminPolicySchema } from "../../app/main/admin";
import { AuditLog } from "../../app/main/policy/audit";
import { KillSwitch } from "../../app/main/agent/killswitch";
import { redactingClient, type ModelRedactor } from "../../app/main/agent/redacting-client";
import type { Logger } from "../../app/main/logger";
import type { ChatEvent, ChatPermissionRequested } from "../../app/shared/chat";
import type { OS } from "../../app/shared/shortcuts";

type Mock = { baseUrl: string; requests: { messages: { role: string; content: unknown }[] }[]; close(): Promise<void> };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const { id: runtimeId, exe } = runtimeFor(process.platform as OS, process.arch);
const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId, exe }).path;
const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
const call = (name: string, args: Record<string, unknown>) => `CALLTOOL:${name}${JSON.stringify(args)}`;
const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };

let mock: Mock;
let dir: string, userData: string, work: string;
let sandboxed = false;
const runtimes: ChatRuntime[] = [];
const registries: ChatSessions[] = [];

/** Tool results only: what native tools handed the model. */
const toolResults = () => mock.requests.flatMap(r => r.messages).filter(m => m.role === "tool").map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

/** The pids of processes whose arguments are exactly `args` (Linux /proc). */
function processesOf(args: string[]): number[] {
  const out: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (argv.length === args.length && argv.every((a, i) => a === args[i])) out.push(Number(entry));
    } catch { /* gone meanwhile */ }
  }
  return out;
}

async function until(test: () => boolean, ms = 20_000, step = 20): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, step));
  }
}

/** A registry over its own chat runtime in `userData`, with every event collected. */
function harness(o: { policy?: ChatPolicy | null; vaultFilled?: () => boolean; consent?: () => boolean } = {}) {
  const runtime = new ChatRuntime({ userData, runtimePath, env });
  runtimes.push(runtime);
  const events: ChatEvent[] = [];
  const audit = new AuditLog(path.join(dir, "audit"));
  const chats = new ChatSessions({
    hasConsent: o.consent ?? (() => true), enabled: () => true, policy: () => (o.policy === undefined ? OPEN : o.policy), vaultFilled: o.vaultFilled ?? (() => false),
    access: () => ({ provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, model: "mock-model", service: "user" }),
    client: () => runtime.client(), protectedPaths: () => [userData], audit: () => audit, emit: e => events.push(e), log: quiet,
  });
  registries.push(chats);
  const of = <T extends ChatEvent["type"]>(session: string, type: T) => events.filter((e): e is Extract<ChatEvent, { type: T }> => e.session === session && e.type === type);
  const next = async <T extends ChatEvent["type"]>(session: string, type: T, from: number, pred: (e: Extract<ChatEvent, { type: T }>) => boolean = () => true) => {
    let found: Extract<ChatEvent, { type: T }> | undefined;
    await until(() => !!(found = of(session, type).slice(from).find(pred)));
    return found!;
  };
  return { runtime, chats, events, audit, of, next };
}

beforeAll(async () => {
  mock = await startMockLlm({ delayMs: 0 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-chat-session-"));
  userData = path.join(dir, "userdata");
  work = path.join(dir, "work");
  fs.mkdirSync(userData, { mode: 0o700 });
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(userData, "settings.json"), "PRIVATE_EMBER_CANARY");
  const probe = new CopilotClient({ mode: "empty", baseDirectory: path.join(dir, "probe"), useLoggedInUser: false, connection: RuntimeConnection.forStdio({ path: runtimePath }), env });
  await probe.start();
  const support = await probe.rpc.sandbox.getHostSupport();
  sandboxed = support.supported && ["shell", "denied_paths"].every(n => support.capabilities.some(c => c.name === n && c.supported));
  await probe.stop();
}, 60_000);

afterAll(async () => {
  for (const r of registries) await r.dispose().catch(() => undefined);
  for (const r of runtimes) await r.stop();
  await mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe.runIf(process.platform === "linux")("a native chat session on the bundled runtime", () => {
  it("starts no chat on a computer whose sandbox can't keep Ember's data out of reach (fail closed)", async ctx => {
    if (sandboxed) ctx.skip();
    const h = harness();
    await expect(h.chats.create(work)).rejects.toBeInstanceOf(ChatUnavailable);
  }, 60_000);

  describe("with the SDK's sandbox", () => {
    /** A test that needs the SDK's sandbox (bubblewrap): skipped where the host has none, as sdk-sandbox-protection's. */
    const sandboxedIt = (name: string, fn: () => Promise<void>, timeout: number) => it(name, async ctx => { if (!sandboxed) ctx.skip(); await fn(); }, timeout);

    sandboxedIt("asks before a command with its text, runs it on approve-once and not on reject, telling the model; a write shows its diff and a session approval isn't asked again (a)", async () => {
      const h = harness();
      const row = await h.chats.create(work, "Permissions");
      expect(row).toMatchObject({ name: "Permissions", folder: fs.realpathSync(work), permissionMode: "manual", agentMode: "interactive", open: true });
      // approve-once runs it
      let n = h.of(row.id, "permission-requested").length;
      await h.chats.send(row.id, call("bash", { command: "echo approved-ran > ran.txt", description: "write a marker" }));
      const asked = await h.next(row.id, "permission-requested", n);
      expect(asked.request).toMatchObject({ kind: "shell", command: "echo approved-ran > ran.txt", intention: "write a marker" });
      expect(asked.choices).toContain("approve-once");
      expect(asked.choices).toContain("reject");
      await h.chats.decide(row.id, asked.requestId, { kind: "approve-once" });
      const done = await h.next(row.id, "tool-complete", 0, e => e.tool === "bash");
      expect(done).toMatchObject({ success: true, exitCode: 0, approvedBy: "user" });
      expect(fs.readFileSync(path.join(work, "ran.txt"), "utf8").trim()).toBe("approved-ran");
      await h.next(row.id, "idle", 0);
      // reject doesn't, and the model hears of it
      n = h.of(row.id, "permission-requested").length;
      const idles = h.of(row.id, "idle").length;
      await h.chats.send(row.id, call("bash", { command: "echo must-not > not.txt", description: "should not run" }));
      const second = await h.next(row.id, "permission-requested", n);
      await h.chats.decide(row.id, second.requestId, { kind: "reject", feedback: "No thanks, leave it." });
      await h.next(row.id, "idle", idles);
      expect(fs.existsSync(path.join(work, "not.txt"))).toBe(false);
      expect(toolResults().some(t => t.includes("No thanks, leave it."))).toBe(true);
      // a write raises a write request with its diff; approved for the session, the next write isn't asked about
      n = h.of(row.id, "permission-requested").length;
      await h.chats.send(row.id, call("create", { path: path.join(work, "first.txt"), file_text: "hello chat\n" }));
      const write = await h.next(row.id, "permission-requested", n);
      expect(write.request.kind).toBe("write");
      expect(write.request.kind === "write" && write.request.diff).toContain("+hello chat");
      expect(write.choices).toContain("approve-for-session");
      await h.chats.decide(row.id, write.requestId, { kind: "approve-for-session" });
      await h.next(row.id, "tool-complete", 0, e => e.tool === "create");
      await h.next(row.id, "idle", idles + 1);
      expect(fs.readFileSync(path.join(work, "first.txt"), "utf8")).toBe("hello chat\n");
      const before = h.of(row.id, "permission-requested").length;
      const completes = h.of(row.id, "tool-complete").length;
      await h.chats.send(row.id, call("create", { path: path.join(work, "second.txt"), file_text: "again\n" }));
      await h.next(row.id, "tool-complete", completes);
      expect(fs.readFileSync(path.join(work, "second.txt"), "utf8")).toBe("again\n");
      expect(h.of(row.id, "permission-requested").length).toBe(before);
      // The audit has who decided and the kind of tool, never the command or the file's words.
      const entries = h.audit.recent(100).filter(e => e.event === "chat" && e.session === row.id);
      expect(entries.some(e => e.phase === "permission" && e.kind === "shell" && e.by === "user")).toBe(true);
      expect(entries.some(e => e.phase === "tool" && e.tool === "bash" && e.by === "user")).toBe(true);
      expect(entries.some(e => e.phase === "sent" && typeof e.chars === "number")).toBe(true);
      const written = JSON.stringify(entries);
      for (const secret of ["approved-ran", "must-not", "hello chat", "No thanks", work]) expect(written).not.toContain(secret);
    }, 90_000);

    sandboxedIt("asks in manual, not in allow-all, reports assisted as the SDK has it, and sets plan and autopilot apart from the permission mode (b)", async () => {
      const h = harness();
      const row = await h.chats.create(work);
      const allow = await h.chats.setPermissionMode(row.id, "allow-all");
      expect(allow).toEqual({ requested: "allow-all", mode: "allow-all", applied: true });
      const asked = h.of(row.id, "permission-requested").length;
      await h.chats.send(row.id, call("bash", { command: "echo unasked > allow-all.txt", description: "allow-all" }));
      const done = await h.next(row.id, "tool-complete", 0);
      expect(done).toMatchObject({ success: true, approvedBy: "allow-all" });
      expect(h.of(row.id, "permission-requested").length).toBe(asked);
      await h.next(row.id, "idle", 0);
      const assisted = await h.chats.setPermissionMode(row.id, "assisted");
      console.log(`[chat-session] assisted with the mock provider: ${JSON.stringify(assisted)}`);
      expect(["assisted", "manual"]).toContain(assisted.mode);
      expect(assisted.applied).toBe(assisted.mode === "assisted");
      expect((await h.chats.list()).find(r => r.id === row.id)?.permissionMode).toBe(assisted.mode);
      const plan = await h.chats.setAgentMode(row.id, "plan");
      expect(plan).toEqual({ requested: "plan", mode: "plan", applied: true });
      const auto = await h.chats.setAgentMode(row.id, "autopilot");
      expect(auto).toEqual({ requested: "autopilot", mode: "autopilot", applied: true });
      expect((await h.chats.list()).find(r => r.id === row.id)).toMatchObject({ agentMode: "autopilot", permissionMode: assisted.mode });
      expect(h.of(row.id, "mode-changed").at(-1)).toMatchObject({ agentMode: "autopilot" });
      await h.chats.setAgentMode(row.id, "interactive");
      await h.chats.setPermissionMode(row.id, "manual");
      const n = h.of(row.id, "permission-requested").length;
      await h.chats.send(row.id, call("bash", { command: "echo manual-again", description: "manual" }));
      const again = await h.next(row.id, "permission-requested", n);
      await h.chats.decide(row.id, again.requestId, { kind: "approve-once" });
    }, 90_000);

    sandboxedIt("stops a running command and a pending request through the kill switch within its budget, leaving no process (c)", async () => {
      const h = harness();
      const row = await h.chats.create(work);
      const ks = new KillSwitch(() => [h.chats.stopPart()], quiet);
      // A command approved and running.
      let n = h.of(row.id, "permission-requested").length;
      await h.chats.send(row.id, call("bash", { command: "sleep 612", description: "a long sleep" }));
      const asked = await h.next(row.id, "permission-requested", n);
      await h.chats.decide(row.id, asked.requestId, { kind: "approve-once" });
      await until(() => processesOf(["sleep", "612"]).length > 0, 20_000);
      const idles = h.of(row.id, "idle").length;
      const t0 = performance.now();
      const pulled = await ks.pull("hotkey");
      const idleAt = (await h.next(row.id, "idle", idles), performance.now() - t0);
      await until(() => processesOf(["sleep", "612"]).length === 0, 5_000, 5);
      const goneAt = performance.now() - t0;
      console.log(`[chat-session] stop with sleep running: kill switch ${pulled.ms} ms, late ${JSON.stringify(pulled.late)}, idle after ${Math.round(idleAt)} ms, sleep gone after ${Math.round(goneAt)} ms`);
      expect(pulled.ms).toBeLessThan(300);
      expect(pulled.late).toEqual([]);
      expect(h.of(row.id, "idle").at(-1)).toMatchObject({ aborted: true });
      expect(processesOf(["sleep", "612"])).toEqual([]);
      // A request waiting for the person (a session of its own: the mock model reads an aborted turn as finished).
      const waits = await h.chats.create(work);
      n = h.of(waits.id, "permission-requested").length;
      await h.chats.send(waits.id, call("bash", { command: "sleep 613", description: "never approved" }));
      const pending = await h.next(waits.id, "permission-requested", n);
      expect((await h.chats.list()).find(r => r.id === waits.id)?.pending).toBe(1);
      const resolved = h.of(waits.id, "permission-resolved").length;
      const t1 = performance.now();
      const second = await ks.pull("hotkey");
      const settled = await h.next(waits.id, "permission-resolved", resolved, e => e.requestId === pending.requestId);
      const settledAt = performance.now() - t1;
      console.log(`[chat-session] stop with a request pending: kill switch ${second.ms} ms, late ${JSON.stringify(second.late)}, request ${settled.decision} by ${settled.by} after ${Math.round(settledAt)} ms`);
      expect(second.ms).toBeLessThan(300);
      expect(second.late).toEqual([]);
      expect(settled.decision).not.toMatch(/^approved/);
      expect((await h.chats.list()).find(r => r.id === waits.id)?.pending).toBe(0);
      await new Promise(r => setTimeout(r, 300));
      expect(processesOf(["sleep", "613"])).toEqual([]);
      // Nothing is approved after Stop: the request is gone, and a late answer is refused.
      await expect(h.chats.decide(waits.id, pending.requestId, { kind: "approve-once" })).rejects.toBeInstanceOf(ChatUnavailable);
    }, 90_000);

    sandboxedIt("keeps the organisation's cap: managedSettings refuses allow-all, an ask rule asks in allow-all, and the registry holds the cap itself (d)", async () => {
      const h = harness();
      // The SDK itself, with Ember's own cap out of the way: disableBypassPermissionsMode keeps allow-all off.
      const noBypass: ChatPolicy = { managedSettings: { permissions: { disableBypassPermissionsMode: "disable", disableAssistedPermissionsMode: true } }, permissionModes: ["manual", "assisted", "allow-all"], standing: true };
      const events: ChatEvent[] = [];
      const client = await h.runtime.client();
      const raw = await ChatSession.open({ client, folder: work, protectedPaths: [userData], policy: noBypass, model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, onEvent: e => events.push(e) });
      try {
        expect(await raw.setPermissionMode("allow-all")).toEqual({ requested: "allow-all", mode: "manual", applied: false });
        expect(await raw.setPermissionMode("assisted")).toEqual({ requested: "assisted", mode: "manual", applied: false });
      } finally { await raw.close(); }
      // An ask-everything rule raises a request even in allow-all, offering only approve-once and reject.
      const askAll: ChatPolicy = { managedSettings: { permissions: { ask: [...ASK_EVERYTHING] } }, permissionModes: ["manual", "assisted", "allow-all"], standing: true };
      const asks = harness({ policy: askAll });
      const row = await asks.chats.create(work);
      expect(await asks.chats.setPermissionMode(row.id, "allow-all")).toMatchObject({ mode: "allow-all", applied: true });
      await asks.chats.send(row.id, call("bash", { command: "echo asked-anyway", description: "managed" }));
      const asked: ChatPermissionRequested = await asks.next(row.id, "permission-requested", 0);
      expect(asked).toMatchObject({ managed: true, choices: ["approve-once", "reject"] });
      await asks.chats.decide(row.id, asked.requestId, { kind: "approve-once" });
      await asks.next(row.id, "tool-complete", 0);
      // Ember's own policy mapping: accepted by the runtime, and the registry refuses what the cap forbids.
      const capped = chatPolicy({ policy: AdminPolicySchema.parse({ confirmEveryAction: true, commands: { local: "on" }, features: { extensions: false } }), source: "/test/policy.json" })!;
      const held = harness({ policy: capped });
      const heldRow = await held.chats.create(work);
      expect(await held.chats.setPermissionMode(heldRow.id, "allow-all")).toEqual({ requested: "allow-all", mode: "manual", applied: false });
      await held.chats.send(heldRow.id, call("view", { path: path.join(work, "ran.txt") }));
      const view = await held.next(heldRow.id, "permission-requested", 0);
      expect(view).toMatchObject({ managed: true, choices: ["approve-once", "reject"] });
      await held.chats.decide(heldRow.id, view.requestId, { kind: "reject" });
      // Commands off in the organisation's policy: the shell is denied by the runtime, unasked.
      const off = harness({ policy: chatPolicy({ policy: AdminPolicySchema.parse({}), source: "/test/policy.json" }) });
      const offRow = await off.chats.create(work);
      await off.chats.send(offRow.id, call("bash", { command: "echo denied > denied.txt", description: "denied" }));
      await off.next(offRow.id, "idle", 0);
      expect(fs.existsSync(path.join(work, "denied.txt"))).toBe(false);
      expect(off.of(offRow.id, "permission-requested")).toEqual([]);
      // No chat at all under LOCKDOWN.
      const locked = harness({ policy: chatPolicy({ policy: AdminPolicySchema.parse({}), source: "/x", error: "broken" }) });
      await expect(locked.chats.create(work)).rejects.toThrow(CHAT_REFUSALS.policy);
    }, 120_000);

    sandboxedIt("keeps Ember's data folder out of every tool's reach in manual, assisted and allow-all (e)", async () => {
      const h = harness();
      const row = await h.chats.create(work);
      // Whatever asks is approved: only the sandbox stands between the tools and the folder.
      const approveAll = setInterval(() => {
        for (const e of h.of(row.id, "permission-requested")) void h.chats.decide(row.id, e.requestId, { kind: "approve-once" }).catch(() => undefined);
      }, 20);
      try {
        for (const mode of ["manual", "assisted", "allow-all"] as const) {
          await h.chats.setPermissionMode(row.id, mode);
          for (const prompt of [call("view", { path: path.join(userData, "settings.json") }), call("bash", { command: `cat ${path.join(userData, "settings.json")}`, description: "read" }),
            call("grep", { pattern: "PRIVATE", path: userData }), call("create", { path: path.join(userData, "planted.txt"), file_text: "x" })]) {
            const completes = h.of(row.id, "tool-complete").length, idles = h.of(row.id, "idle").length;
            await h.chats.send(row.id, prompt);
            const done = await h.next(row.id, "tool-complete", completes);
            const refused = !done.success || (done.exitCode !== undefined && done.exitCode !== 0);
            expect(refused ? "refused" : `${mode}: ${prompt.slice(0, 40)} went through`).toBe("refused");
            await h.next(row.id, "idle", idles);
          }
        }
      } finally { clearInterval(approveAll); }
      expect(toolResults().some(t => t.includes("PRIVATE_EMBER_CANARY"))).toBe(false);
      expect(fs.existsSync(path.join(userData, "planted.txt"))).toBe(false);
    }, 120_000);

    sandboxedIt("lists a named session, and opens it again with its history after the runtime restarts (f)", async () => {
      const h = harness();
      const row = await h.chats.create(work, "Pelican chat");
      await h.chats.send(row.id, "Remember the word PELICAN.");
      await h.next(row.id, "idle", 0);
      expect((await h.chats.list()).find(r => r.id === row.id)).toMatchObject({ name: "Pelican chat", open: true });
      await h.chats.dispose();
      await h.runtime.stop();
      const again = harness();
      const kept = (await again.chats.list()).find(r => r.id === row.id);
      expect(kept).toMatchObject({ name: "Pelican chat", open: false, folder: fs.realpathSync(work) });
      const resumed = await again.chats.resume(row.id);
      expect(resumed).toMatchObject({ id: row.id, open: true, permissionMode: "manual", name: "Pelican chat" });
      const from = mock.requests.length;
      await again.chats.send(row.id, "What was the word?");
      await again.next(row.id, "idle", 0);
      const sent = mock.requests.slice(from).flatMap(r => r.messages).map(m => JSON.stringify(m.content)).join("\n");
      expect(sent).toContain("PELICAN");
    }, 90_000);

    sandboxedIt("keeps a value the vault filled out of a native tool's result only through the chat's own hook, and no chat starts after a fill (g)", async () => {
      const canary = "VAULTCANARY-8c41f2";
      fs.writeFileSync(path.join(work, "pasted.txt"), `token ${canary}\n`);
      const redactor: ModelRedactor = {
        active: true,
        holds: t => JSON.stringify(t ?? "").includes(canary),
        text: s => s.split(canary).join("[vault]"),
        deep: <T>(v: T) => JSON.parse(JSON.stringify(v).split(canary).join("[vault]")) as T,
      };
      const h = harness();
      const client = await h.runtime.client();
      const wrapped = redactingClient(client, redactor);
      // The shared client's redactor alone: the native tool's output reaches the model as it is.
      const plain = await wrapped.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, workingDirectory: work,
        availableTools: ["builtin:*"], enableConfigDiscovery: false, onPermissionRequest: () => ({ kind: "approve-once" }) as never });
      const from = mock.requests.length;
      await plain.sendAndWait({ prompt: call("bash", { command: "cat pasted.txt", description: "read" }) }, 20_000);
      const leaked = mock.requests.slice(from).flatMap(r => r.messages).filter(m => m.role === "tool").some(m => JSON.stringify(m.content).includes(canary));
      console.log(`[chat-session] native tool output through redactingClient alone reached the model unredacted: ${leaked}`);
      expect(leaked).toBe(true);
      await plain.disconnect();
      // The chat session's own hook takes it out of the result before the model sees it.
      const events: ChatEvent[] = [];
      const chat = await ChatSession.open({ client: wrapped, folder: work, protectedPaths: [userData], policy: OPEN, model: "mock-model",
        provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" }, redact: redactor, onEvent: e => events.push(e) });
      try {
        await chat.setPermissionMode("allow-all");
        const at = mock.requests.length;
        await chat.send(call("bash", { command: "cat pasted.txt", description: "read" }));
        await until(() => events.some(e => e.type === "idle"));
        const results = mock.requests.slice(at).flatMap(r => r.messages).filter(m => m.role === "tool").map(m => JSON.stringify(m.content));
        expect(results.length).toBeGreaterThan(0);
        expect(results.some(t => t.includes(canary))).toBe(false);
        expect(results.some(t => t.includes("[vault]"))).toBe(true);
      } finally { await chat.close(); }
      // And the registry starts and sends nothing once something was filled.
      const filled = harness({ vaultFilled: () => true });
      await expect(filled.chats.create(work)).rejects.toThrow(CHAT_REFUSALS.vault);
    }, 90_000);
  });
});
