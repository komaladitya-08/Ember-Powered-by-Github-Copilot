import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Server, graceSeconds, type ServeDeps } from "../../app/remote/serve";
import { PolicyWatch } from "../../app/remote/admin";
import { DesktopController } from "../../app/remote/desktop";
import { CONTRACTS } from "../../app/remote/contracts";
import { GATE_WORDS } from "../../app/remote/gate";
import { AdminPolicySchema, adminSummary, parseAdminPolicy, type LoadedAdminPolicy } from "../../app/main/admin";
import { emberNamesRegExp, EV_SCHEMAS, OP_SCHEMAS, type Msg, type Op } from "../../app/main/remote/protocol";
import type { Mux } from "../../app/main/remote/types";
import type { RunExit, RunnerFacts, RunSpec } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import type { RemoteRuns } from "../../app/remote/commands";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const PC = "a".repeat(32);
const NO_POLICY: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };

/** A mux that checks what the agent sends as strictly as MX's does (results against their op's schema). */
function fakeMux() {
  const sent: Msg[] = [];
  const bytes: { channel: number; n: number }[] = [];
  let onMsg: (m: Msg) => void = () => {};
  let onClose: (why: string) => void = () => {};
  const ops = new Map<number, Op>();
  let silent = 0;
  let pings = 0;
  const mux: Mux = {
    send(msg) {
      if (msg.t === "res" && msg.ok) {
        const op = ops.get(msg.id)!;
        const r = (OP_SCHEMAS[op].result as { safeParse(v: unknown): { success: boolean; error?: unknown } }).safeParse(msg.v);
        if (!r.success) throw new Error(`${op}'s result fails its schema: ${JSON.stringify(r.error)}`);
      }
      if (msg.t === "ev") {
        const r = (EV_SCHEMAS[msg.ev] as { safeParse(v: unknown): { success: boolean } }).safeParse(msg.d);
        if (!r.success) throw new Error(`${msg.ev} fails its schema`);
      }
      sent.push(msg);
    },
    onMessage: fn => { onMsg = fn; return () => {}; },
    sendBytes: (channel, b) => { bytes.push({ channel, n: b.length }); },
    onBytes: () => () => {},
    ping: () => { pings++; },
    silentMs: () => silent,
    rttMs: 1,
    inFlight: () => ({ bytes: 0, throughput: 0 }),
    reset: () => {},
    onClose: fn => { onClose = fn; return () => {}; },
  };
  let id = 0;
  return {
    mux, sent, bytes,
    get pings() { return pings; },
    setSilent(ms: number) { silent = ms; },
    close(why: string) { onClose(why); },
    /** Sends a request and resolves with its answer. */
    async req(op: Op, a: unknown): Promise<Msg> {
      const n = ++id;
      ops.set(n, op);
      onMsg({ t: "req", id: n, op, a } as Msg);
      for (let i = 0; i < 200; i++) {
        const r = sent.find(m => m.t === "res" && m.id === n);
        if (r) return r;
        await new Promise(res => setImmediate(res));
      }
      throw new Error(`no answer to ${op}`);
    },
  };
}

const facts: RunnerFacts = {
  os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: { path: "/usr/bin/script", kind: "util-linux" }, home: "/home/deploy",
  user: "deploy", privileged: false, pty: true, ember: { paths: [], pids: [1], names: emberNamesRegExp(["ember-remote"]) }, extraPath: [],
};

/** A server over fakes; `policy` is this computer's. */
function server(o: { policy?: LoadedAdminPolicy; lockBusy?: boolean; auditFails?: boolean; classify?: ServeDeps["classify"] } = {}) {
  const m = fakeMux();
  const calls: string[] = [];
  const audit: Record<string, unknown>[] = [];
  let exited: number | null = null;
  let runsLive = 0;
  const runs = {
    get running() { return runsLive; },
    knows: (id: string) => id === "0123456789abcdef",
    start: (spec: RunSpec, channel: number) => { calls.push(`start ${spec.runId} ${channel}`); runsLive++; return { interactive: true }; },
    input: () => true,
    stop: (id: string, why: string) => { calls.push(`stop ${id} ${why}`); return true; },
    stopAll: async (why: string, attended: boolean) => { calls.push(`stopAll ${why} ${attended}`); },
    allEnded: () => new Promise<void>(r => setTimeout(r, 400)),
    ladders: () => Promise.resolve(),
    pids: () => [],
  } as unknown as RemoteRuns;
  const desktop = new DesktopController({
    unavailable: "headless for this test", host: "build-01", discover: async () => ({ access: "none", why: "none" }),
    spawnChild: () => { throw new Error("no child here"); }, baseEnv: {}, scripts: { atspi: "/a", notice: "/n" },
    audit: async () => {}, changed: () => {}, consoleStop: () => {}, log: quiet, now: () => Date.now(),
  });
  vi.spyOn(desktop, "stop").mockImplementation(() => { calls.push("desktop stop"); });
  vi.spyOn(desktop, "pause").mockImplementation(() => { calls.push("desktop pause"); });
  const policy = new PolicyWatch(() => o.policy ?? NO_POLICY, () => {});
  const deps: ServeDeps = {
    mux: m.mux, log: quiet, pcId: PC, partsId: "0.1.0-abc", os: "linux", arch: "x64", machineIdHash: "f".repeat(64), isWsl: false,
    uid: 1000, user: "deploy", home: "/home/deploy", host: "build-01", pid: 4242, policy,
    lock: async () => (o.lockBusy ? { ok: false, holder: { pid: 7, start: "1", pcId: "b".repeat(32) } } : { ok: true, release: () => calls.push("release"), tookOver: null }),
    facts: async () => facts,
    runs,
    inspect: async paths => paths.map(() => ({ exists: true, real: null })),
    git: async () => null,
    classify: o.classify ?? CONTRACTS.classifyCommand,
    audit: { write: e => { audit.push(e); return !o.auditFails; }, recent: () => [{ event: "x" }] },
    setAuditSource: () => {},
    consent: () => calls.push("consent"),
    desktop,
    orphans: async () => [],
    exit: code => { exited = code; },
    now: () => Date.now(),
  };
  const s = new Server(deps);
  s.start();
  return { s, m, calls, audit, get exited() { return exited; }, setRuns(n: number) { runsLive = n; } };
}

const helloArgs = (o: { pcId?: string; consent?: number; grace?: number; epoch?: number } = {}) => ({
  proto: 1, partsId: "0.1.0-abc", local: { name: "ana-laptop", os: "linux" }, pcId: o.pcId ?? PC, consent: { version: o.consent ?? 1, at: "2026-10-22T10:00:00Z" },
  neverLook: [], localAdmin: adminSummary(o.grace ? { policy: AdminPolicySchema.parse({ ssh: { commandGraceSeconds: o.grace } }), source: "/etc/ember/policy.json" } : NO_POLICY), epoch: o.epoch ?? 5,
});

const run = (text: string, o: { epoch?: number; rules?: string[]; yes?: boolean } = {}) => ({
  epoch: o.epoch ?? 5,
  spec: {
    runId: "0123456789abcdef", taskId: "1-t", shell: "bash", command: text, cwd: "/home/deploy", timeoutMs: 60_000, cols: 80, rows: 24,
    stamp: { taskId: "1-t", sha256: createHash("sha256").update(text).digest("hex"), verdict: o.yes ? "ask" : "run", classes: [], rules: o.rules ?? [], approval: o.yes ? { ageMs: 50 } : null },
  },
});

const res = (m: Msg) => (m.t === "res" ? (m.ok ? { ok: true, v: m.v } : { ok: false, code: m.e.code, m: m.e.m }) : null);

describe("serve (§5.3, §5.4)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("answers nothing but hello before hello, and refuses ops it doesn't know", async () => {
    const t = server();
    expect(res(await t.m.req("cmd.facts", {}))).toMatchObject({ ok: false, code: "not_ready" });
    expect(res(await t.m.req("nope" as Op, {}))).toMatchObject({ ok: false, code: "unknown_op" });
  });

  it("checks hello: the PC's id from its argv, the parts, the consent", async () => {
    expect(res(await server().m.req("hello", helloArgs({ pcId: "b".repeat(32) })))).toMatchObject({ ok: false, code: "denied" });
    expect(res(await server().m.req("hello", { ...helloArgs(), partsId: "0.1.0-other" }))).toMatchObject({ ok: false, code: "bad_request" });
    expect(res(await server().m.req("hello", helloArgs({ consent: 0 })))).toMatchObject({ ok: false, code: "denied" });
  });

  it("says busy when another PC's agent holds the lock", async () => {
    expect(res(await server({ lockBusy: true }).m.req("hello", helloArgs()))).toEqual({ ok: false, code: "busy", m: "Ember from another computer is already working on build-01." });
  });

  it("refuses to serve under a policy that turns SSH off, and ends", async () => {
    const t = server({ policy: parseAdminPolicy('{"features":{"ssh":false}}', "/etc/ember/policy.json") });
    expect(res(await t.m.req("hello", helloArgs()))).toEqual({ ok: false, code: "denied", m: "This computer's administrator doesn't allow Ember here." });
    await vi.advanceTimersByTimeAsync(4000);
    expect(t.exited).toBe(0);
  });

  it("welcomes with its facts, the desktop as it is, and the smaller of both graces", async () => {
    const t = server({ policy: parseAdminPolicy('{"commands":{"ssh":"on"},"ssh":{"commandGraceSeconds":40}}', "/etc/ember/policy.json") });
    const w = res(await t.m.req("hello", helloArgs({ grace: 10 })));
    expect(w).toMatchObject({ ok: true, v: { proto: 1, partsId: "0.1.0-abc", user: "deploy", graceSeconds: 10, desktop: { access: "none", why: "headless for this test" }, facts: { shells: ["bash"] } } });
    expect(t.calls).toContain("consent");
    expect(res(await t.m.req("hello", helloArgs()))).toMatchObject({ ok: false, code: "bad_request" });
    expect(graceSeconds(null, adminSummary(NO_POLICY))).toBe(20);
  });

  it("runs a command only through gate 2: asks for what its own check finds, starts it after the yes, audited first", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    const first = res(await t.m.req("cmd.run", run("make")));
    expect(first).toMatchObject({ ok: true, v: { status: "needs_confirm", reason: GATE_WORDS.disagree, rules: ["remote.unchecked"] } });
    expect(t.calls.some(c => c.startsWith("start"))).toBe(false);
    const ok = res(await t.m.req("cmd.run", run("make", { yes: true, rules: ["remote.unchecked"] })));
    expect(ok).toEqual({ ok: true, v: { status: "started", channel: 1, interactive: true } });
    expect(t.audit.find(e => e.event === "command" && e.phase === "start")).toMatchObject({ command: "make", approved: true });
  });

  it("refuses a command it can't record (write-ahead)", async () => {
    const t = server({ auditFails: true });
    await t.m.req("hello", helloArgs());
    expect(res(await t.m.req("cmd.run", run("make", { yes: true, rules: ["remote.unchecked"] })))).toEqual({ ok: true, v: { status: "deny", reason: GATE_WORDS.noAudit } });
  });

  it("follows this computer's commands mode: off refuses", async () => {
    const t = server({ policy: parseAdminPolicy('{"neverLook":["x"]}', "/etc/ember/policy.json") });
    await t.m.req("hello", helloArgs());
    expect(res(await t.m.req("cmd.run", run("ls", { yes: true, rules: ["remote.unchecked"] })))).toEqual({ ok: true, v: { status: "deny", reason: GATE_WORDS.commandsOff } });
  });

  it("fences: a command from before a stop is stopped, and Stop pulls every part", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    const stop = res(await t.m.req("stop", { epoch: 6 }));
    expect(stop).toMatchObject({ ok: true, v: { late: [] } });
    expect(t.calls).toEqual(expect.arrayContaining(["stopAll killswitch true", "desktop stop"]));
    expect(res(await t.m.req("cmd.run", run("ls", { epoch: 5, yes: true, rules: ["remote.unchecked"] })))).toMatchObject({ ok: false, code: "stopped" });
    expect(res(await t.m.req("cmd.run", run("ls", { epoch: 6, yes: true, rules: ["remote.unchecked"] })))).toMatchObject({ ok: true, v: { status: "started" } });
    expect(t.audit.some(e => e.event === "stop" && e.source === "local")).toBe(true);
  });

  it("says a run's end after its start, with an error cut to 500 characters", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    const exit: RunExit = { code: null, signal: null, ended: "failed-to-start", ms: 1, error: "e".repeat(900) };
    t.s.runExited("0123456789abcdef", exit, 0);
    await vi.advanceTimersByTimeAsync(1);
    await new Promise(r => setImmediate(r));
    const ev = t.m.sent.find(m => m.t === "ev" && m.ev === "cmd.exit");
    expect((ev as { d: { exit: RunExit } }).d.exit.error).toHaveLength(500);
  });

  it("refuses steps on a silent link and from an older epoch", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    const act = { opId: "x", epoch: 5, stamp: { taskId: "1", kind: "click", app: "a", window: "w", element: { role: "push button", name: "OK" }, verdict: "confirm", approval: { given: true }, ageMs: 10 }, op: "do_action", id: 3, action: "click" };
    expect(res(await t.m.req("act", { ...act, epoch: 4 }))).toEqual({ ok: true, v: { status: "stopped" } });
    t.m.setSilent(1600);
    expect(res(await t.m.req("act", act))).toEqual({ ok: true, v: { status: "stale" } });
    t.m.setSilent(0);
    expect(res(await t.m.req("act", act))).toEqual({ ok: true, v: { status: "deny", reason: "headless for this test" } });
  });

  it("stops desktop work at 3 s of silence, and everything at the grace, exiting no sooner than 1.6 s with runs live", async () => {
    const t = server();
    await t.m.req("hello", helloArgs({ grace: 5 }));
    t.setRuns(1);
    t.m.setSilent(3000);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls).toContain("desktop pause");
    expect(t.calls.some(c => c.startsWith("stopAll"))).toBe(false);
    t.m.setSilent(5000);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls).toContain("stopAll lost false");
    expect(t.exited).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.exited).toBeNull();
    await vi.advanceTimersByTimeAsync(700);
    expect(t.exited).toBe(0);
    expect(t.calls).toContain("release");
  });

  it("stops on EOF without waiting when nothing runs", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    t.m.close("the other end closed the link");
    await vi.advanceTimersByTimeAsync(10);
    expect(t.exited).toBe(0);
    expect(t.calls).toContain("stopAll lost false");
    expect(t.audit.some(e => e.event === "stop" && e.source === "link-lost")).toBe(true);
  });

  it("passes cmd.input and cmd.stop to the run, and says gone for one it never had", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    expect(res(await t.m.req("cmd.stop", { runId: "0123456789abcdef", why: "user" }))).toEqual({ ok: true, v: {} });
    expect(t.calls).toContain("stop 0123456789abcdef user");
    expect(res(await t.m.req("cmd.input", { runId: "fedcba9876543210", data: "YQ==" }))).toMatchObject({ ok: false, code: "gone" });
  });

  it("gives the audit's newest entries", async () => {
    const t = server();
    await t.m.req("hello", helloArgs());
    expect(res(await t.m.req("audit.recent", { limit: 5 }))).toEqual({ ok: true, v: { entries: [{ event: "x" }] } });
  });
});
