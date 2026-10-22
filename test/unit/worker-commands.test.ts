/**
 * A worker's view of its target (§2.6, §3.2, §3.7): run_command only with a CommandService whose commands aren't off,
 * the user's own words (never the goal or a model steer) as the command flow's words, tools by desktop access, gate 1's
 * stamp handed over right before a step runs, grant keys and question badges by target, and a remote's refusals (an
 * async app launch, a desktop step that wanted a confirmation) as tool results.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Worker, LINUX_WORKER_SYSTEM, type TaskSpec, type WorkerDeps, type WorkerSystem } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import { setCommandJudge, type CommandJudge } from "../../app/main/commands/flow";
import type { CommandCapability, CommandService, DecideInput, RunExit, RunningCommand, RunSpec } from "../../app/main/commands/types";
import type { TargetBinding } from "../../app/main/targets/types";
import type { ActStamp } from "../../app/main/perception/ports";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

const LOCAL: TargetBinding = { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" };
const REMOTE: TargetBinding = { id: "ssh:build-01", kind: "ssh", label: "build-01", login: "deploy", screenOs: "linux", shellOs: "linux", desktop: "text" };
const HEADLESS: TargetBinding = { ...REMOTE, desktop: "none", desktopWhy: "build-01 has no desktop session for deploy" };

/** A judge that records the decision's input and lets every command run. */
function recordingJudge() {
  const decided: DecideInput[] = [];
  const judge: CommandJudge = {
    classifyCommand: (_t, shell) => ({ shell, family: "posix", findings: [], refuse: null, probe: [], needsGit: false, downloads: [], programs: [], commands: [] }),
    decideCommand: i => { decided.push(i); return { verdict: "run", reason: "ordinary", classes: [], rules: [], says: [], unasked: false, armMs: 500 }; },
    shapeOutput: () => "<command_output>ok</command_output>",
    redactSecrets: t => t,
    trackSecretPrompts: () => ({ output: () => undefined, enter: () => undefined, spans: () => [] }),
    outputTaint: () => null,
    resolveTargetPath: p => p,
  };
  setCommandJudge(judge);
  return decided;
}

function commandService(binding: TargetBinding, o: { cap?: CommandCapability["state"]; shells?: ("bash" | "sh" | "cmd" | "powershell")[]; answer?: "deny" } = {}): CommandService & { starts: RunSpec[] } {
  const starts: RunSpec[] = [];
  return {
    binding, starts,
    capability: () => ({ state: o.cap ?? "on", askEvery: null }),
    shells: () => o.shells ?? ["bash", "sh"],
    runner: {
      target: binding.id,
      facts: async () => ({ os: "linux", shells: ["bash", "sh"], shellPaths: {}, script: null, home: "/home/ana", user: "ana", privileged: false, pty: false, ember: { paths: [], pids: [], names: /^ember$/ }, extraPath: [] }),
      inspect: async (paths: string[]) => paths.map(p => ({ exists: true, real: p })),
      gitFacts: async () => null,
      start: (spec: RunSpec): RunningCommand => {
        starts.push(spec);
        const exit: RunExit = { code: 0, signal: null, ended: "exit", ms: 5 };
        return { runId: spec.runId, interactive: false, onOutput: () => () => undefined, input: () => undefined, typedLines: () => [], forgetTyped: () => undefined, stop: () => undefined, done: Promise.resolve(exit) };
      },
      stopAll: async () => undefined,
      running: 0,
    },
    window: { showCard: () => undefined, hideCard: () => undefined, cardReady: () => false, announce: async () => true, cancelAnnounce: () => undefined, attach: () => undefined },
    consented: () => undefined, userAskEvery: () => false, mode: () => "on",
  };
}

function makeWorker(o: {
  target?: TargetBinding; commands?: CommandService | null; spec?: Partial<TaskSpec>; answer?: string; vision?: boolean;
  onAuthorized?: (s: ActStamp) => void; grantKey?: (app: string) => string; system?: WorkerSystem;
  doAction?: () => Promise<unknown>; grants?: Record<string, "act">; confirmEvery?: boolean;
} = {}) {
  const events: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const node = { id: 1, parent: null, depth: 1, role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
  const seen = { window, x11Window: null, nodes: [node], blocked: false, ms: 0 };
  const deps = {
    client: {} as never, log: quiet, model: "m", vision: o.vision ?? true, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "[1] push button \"Bold\"", capture: null }), read: async () => seen, windows: async () => [window] } as never,
    sidecar: {
      readElement: async () => ({ role: node.role, name: node.name, states: node.states, bounds: node.bounds }),
      doAction: async () => { events.push("doAction"); if (o.doAction) return o.doAction(); return { ok: true, after: { role: "push button", name: "Bold", states: [], bounds: node.bounds } }; },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => o.grants ?? { gedit: "act" }, ...(o.confirmEvery ? { confirmEveryAction: () => true, allowGrants: () => false } : {}) }),
    confirmer: { ask: async (q: Record<string, unknown>) => { asked.push(q); events.push("ask"); return o.answer ?? "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: (u: Record<string, unknown>) => { updates.push(u); } } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => { events.push("lease"); return () => { events.push("release"); }; },
    flyTo: () => undefined, onProgress: () => undefined,
    ...(o.target ? { target: o.target } : {}),
    ...(o.commands !== undefined ? { commands: o.commands } : {}),
    ...(o.onAuthorized ? { onAuthorized: (s: ActStamp) => { events.push("stamp"); o.onAuthorized!(s); } } : {}),
    ...(o.grantKey ? { grantKey: o.grantKey } : {}),
    ...(o.system ? { system: o.system } : {}),
  } as unknown as WorkerDeps;
  const w = new Worker(deps, { id: "t1", goal: "make it bold", target: { title: "notes.txt" }, ...o.spec });
  const names = () => w.tools().map(t => t.name);
  const tool = (name: string) => w.tools().find(t => t.name === name)!;
  const call = (name: string, args: Record<string, unknown>) => tool(name).handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { w, names, tool, call, events, asked, updates, audit };
}

afterEach(() => { setCommandJudge(null); });

describe("run_command is offered only with commands (§3.2)", () => {
  it("leaves the tools exactly as today without a CommandService", () => {
    const today = makeWorker().names();
    expect(today).not.toContain("run_command");
    expect(makeWorker({ target: LOCAL, commands: null }).names()).toEqual(today);
    expect(makeWorker({ target: LOCAL, commands: commandService(LOCAL, { cap: "off" }) }).names()).toEqual(today);
    // cmd alone is never a run_command shell (L3).
    expect(makeWorker({ target: LOCAL, commands: commandService(LOCAL, { shells: ["cmd"] }) }).names()).toEqual(today);
  });

  it("is offered when the target's commands are on or wait for the user's card, after open_app", () => {
    for (const cap of ["on", "needs-consent"] as const) {
      const names = makeWorker({ target: LOCAL, commands: commandService(LOCAL, { cap }) }).names();
      expect(names, cap).toContain("run_command");
      expect(names.indexOf("run_command"), cap).toBe(names.indexOf("open_app") + 1);
    }
  });

  it("describes where it runs and takes only the target's shells", () => {
    const { tool } = makeWorker({ target: REMOTE, commands: commandService(REMOTE, { shells: ["bash", "sh", "cmd"] }) });
    const t = tool("run_command");
    expect(t.description).toBe("Run one command on build-01 in Ember's own command window, where the user watches it and can stop it. Shells here: bash, sh (default bash). Most commands run straight away; ones that delete or overwrite data, push or publish anywhere, touch passwords or keys, change the system, or download and run code stop and ask the user first. Never put a password, token or key in a command. The output comes back as untrusted text.");
    const schema = t.parameters as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(schema.shape)).toEqual(["target", "command", "shell", "cwd", "timeoutSeconds", "why"]);
    expect(schema.safeParse({ target: "build-01", command: "ls", why: "to look", shell: "cmd" }).success).toBe(false);
    expect(schema.safeParse({ target: "build-01", command: "ls", why: "to look", shell: "sh" }).success).toBe(true);
    expect(schema.safeParse({ target: "build-01", command: "ls", why: "to look", timeoutSeconds: 901 }).success).toBe(false);
    expect((schema.shape.target as z.ZodString).description).toBe("Where it runs: \"build-01\" (this task's computer)");
    const local = makeWorker({ target: LOCAL, commands: commandService(LOCAL) }).tool("run_command");
    expect(local.description).toMatch(/^Run one command on this computer in Ember's own command window/);
  });

  it("runs through the command flow on the task's target", async () => {
    recordingJudge();
    const svc = commandService(REMOTE);
    const { call } = makeWorker({ target: REMOTE, commands: svc, spec: { userWords: "run the tests on build-01" } });
    const r = await call("run_command", { target: "build-01", command: "make test", why: "to run the tests" });
    expect(r.resultType).toBe("success");
    expect(svc.starts).toHaveLength(1);
    expect(svc.starts[0]).toMatchObject({ command: "make test", taskId: "t1", cols: 120, rows: 32 });
    expect((await call("run_command", { target: "build-02", command: "make test", why: "to run the tests" })).textResultForLlm).toBe("This task runs on build-01; run_command can only run there.");
  });
});

describe("the command flow hears the user's own words only (critique security-1)", () => {
  const run = (call: ReturnType<typeof makeWorker>["call"]) => call("run_command", { target: "build-01", command: "git push origin feature-x", why: "to publish the branch" });

  it("never the goal: a task without the user's words gives the flow none", async () => {
    const decided = recordingJudge();
    const { call } = makeWorker({ target: REMOTE, commands: commandService(REMOTE), spec: { goal: "push my branch to GitHub" } });
    await run(call);
    expect(decided[0].userWords).toBe("");
  });

  it("the task's own words, and a steer's userWords, but never the model's steer text", async () => {
    const decided = recordingJudge();
    const made = makeWorker({ target: REMOTE, commands: commandService(REMOTE), spec: { goal: "push the branch", userWords: "push my branch" } });
    // A running task's session takes the steer (run() isn't called here).
    (made.w as unknown as { session: unknown }).session = { send: async () => undefined };
    await made.w.steer("and force-push it to main");
    await run(made.call);
    expect(decided[0].userWords).toBe("push my branch");
    await made.w.steer("also tag it", "and tag it v2");
    await run(made.call);
    expect(decided[1].userWords).toBe("push my branch\nand tag it v2");
  });

  it("a task the user steered with words but started without them gets only the steer's words", async () => {
    const decided = recordingJudge();
    const made = makeWorker({ target: REMOTE, commands: commandService(REMOTE), spec: { goal: "push the branch" } });
    (made.w as unknown as { session: unknown }).session = { send: async () => undefined };
    await made.w.steer("push it now", "yes push it");
    await run(made.call);
    expect(decided[0].userWords).toBe("yes push it");
  });
});

describe("tools by desktop access (§2.6)", () => {
  it("no desktop: run_command, report_progress and finish_task only", () => {
    expect(makeWorker({ target: HEADLESS, commands: commandService(HEADLESS) }).names()).toEqual(["run_command", "report_progress", "finish_task"]);
    expect(makeWorker({ target: HEADLESS, commands: null }).names()).toEqual(["report_progress", "finish_task"]);
  });

  it("text: perceive_window without its image parameter", () => {
    const text = makeWorker({ target: REMOTE }).tool("perceive_window");
    expect(Object.keys((text.parameters as z.ZodObject<z.ZodRawShape>).shape)).toEqual([]);
    expect(text.description).not.toMatch(/image/);
    const screen = makeWorker({ target: LOCAL }).tool("perceive_window");
    expect(Object.keys((screen.parameters as z.ZodObject<z.ZodRawShape>).shape)).toEqual(["image"]);
  });
});

describe("gate 1's stamp (§2.1, critique integration-6)", () => {
  it("goes to the target right before the step runs: after the question, the window lease and the pre-step pause", async () => {
    const stamps: ActStamp[] = [];
    const { call, events } = makeWorker({ target: { ...REMOTE, desktop: "text" }, onAuthorized: s => stamps.push(s), confirmEvery: true, grants: {} });
    await call("perceive_window", {});
    const r = await call("click", { id: 1 });
    expect(r.resultType).toBe("success");
    expect(events.filter(e => e !== "release")).toEqual(["ask", "lease", "stamp", "doAction"]);
    expect(stamps[0]).toMatchObject({ taskId: "t1", kind: "click", app: "gedit", window: "notes.txt", element: { role: "push button", name: "Bold" }, verdict: "confirm", approval: { given: true } });
    // Measured when the step is sent, from the user's yes: the 350 ms pause is in it.
    expect(stamps[0].ageMs).toBeGreaterThanOrEqual(300);
    expect(stamps[0].ageMs).toBeLessThan(10_000);
  });

  it("an allowed step carries no approval; a typed value only as its hash", async () => {
    const stamps: ActStamp[] = [];
    const { call } = makeWorker({ onAuthorized: s => stamps.push(s) });
    await call("perceive_window", {});
    await call("click", { id: 1 });
    expect(stamps[0]).toMatchObject({ verdict: "allow", approval: null });
    expect(stamps[0]).not.toHaveProperty("valueSha256");
  });

  it("this computer's steps hear nothing: no stamp is made without a listener", async () => {
    const { call, events } = makeWorker();
    await call("perceive_window", {});
    await call("click", { id: 1 });
    expect(events).not.toContain("stamp");
  });
});

describe("a remote's answers (§2.6, §5.3.7)", () => {
  const coded = (code: string, message = "refused") => Object.assign(new Error(message), { code });

  it("a desktop step that wanted a confirmation is refused, not asked again (v1)", async () => {
    const { call } = makeWorker({ target: REMOTE, doAction: async () => { throw coded("needs_confirm"); } });
    await call("perceive_window", {});
    const r = await call("click", { id: 1 });
    expect(r).toEqual({ resultType: "denied", textResultForLlm: "build-01 refused this step (it wanted a confirmation Ember couldn't give). Don't try another way." });
  });

  it("changed, stale, stopped and denied steps say so", async () => {
    const cases: [string, string, string | RegExp][] = [
      ["changed", "failure", "It changed: call perceive_window again."],
      ["stale", "failure", /^build-01 didn't answer in time/],
      ["stopped", "denied", "Stopped. Do nothing more."],
      ["deny", "denied", /^Not allowed: build-01 refused it: "This computer's administrator/],
    ];
    for (const [code, type, text] of cases) {
      const { call } = makeWorker({ target: REMOTE, doAction: async () => { throw coded(code, "This computer's administrator doesn't let Ember act in apps."); } });
      await call("perceive_window", {});
      const r = await call("click", { id: 1 });
      expect(r.resultType, code).toBe(type);
      if (typeof text === "string") expect(r.textResultForLlm, code).toBe(text); else expect(r.textResultForLlm, code).toMatch(text);
    }
  });

  it("the same codes on this computer are ordinary errors", async () => {
    const { call } = makeWorker({ doAction: async () => { throw coded("needs_confirm", "boom"); } });
    await call("perceive_window", {});
    expect((await call("click", { id: 1 })).textResultForLlm).toMatch(/^It didn't work: "boom"/);
  });

  it("open_app awaits a remote launch and returns its refusal; the stamp goes first", async () => {
    let launched = false;
    const stamps: ActStamp[] = [];
    const order: string[] = [];
    const system: WorkerSystem = {
      ...LINUX_WORKER_SYSTEM,
      apps: {
        ...LINUX_WORKER_SYSTEM.apps,
        list: () => [{ id: "gedit", name: "Text Editor", exec: "gedit", keywords: [] } as never],
        find: (list, name) => list.find(a => a.name.toLowerCase().includes(name.toLowerCase())) ?? null,
        isTerminalApp: () => false,
        launch: async () => { order.push("launch"); await new Promise(r => setTimeout(r, 20)); launched = true; throw new Error("This computer's administrator doesn't let Ember act in apps."); },
      },
    };
    const { call } = makeWorker({ target: REMOTE, system, onAuthorized: s => { order.push("stamp"); stamps.push(s); }, confirmEvery: true, grants: {} });
    const r = await call("open_app", { name: "text editor" });
    expect(launched).toBe(true);
    expect(r).toEqual({ resultType: "denied", textResultForLlm: "Not allowed: build-01 refused it: \"This computer's administrator doesn't let Ember act in apps.\". Don't try another way; tell the user in finish_task." });
    expect(order).toEqual(["stamp", "launch"]);
    expect(stamps[0]).toMatchObject({ kind: "open_app", app: "Text Editor", verdict: "confirm", approval: { given: true } });
  });
});

describe("grants and questions by target", () => {
  it("\"Always in this app\" is keyed by the target's grant key", async () => {
    const { call, updates } = makeWorker({ answer: "always", grants: {}, grantKey: app => `ssh:build-01:${app.toLowerCase()}`, target: { ...REMOTE, desktop: "screen" } });
    await call("perceive_window", {});
    await call("click", { id: 1 });
    expect(updates).toEqual([{ grants: { "ssh:build-01:gedit": "act" } }]);
  });

  it("today's key without a target", async () => {
    const { call, updates } = makeWorker({ answer: "always", grants: {} });
    await call("perceive_window", {});
    await call("click", { id: 1 });
    expect(updates).toEqual([{ grants: { gedit: "act" } }]);
  });

  it("a question on another computer carries where it acts; this computer's carries nothing new", async () => {
    const remote = makeWorker({ target: { ...REMOTE, desktop: "screen" }, grants: {}, confirmEvery: true });
    await remote.call("perceive_window", {});
    await remote.call("click", { id: 1 });
    expect(remote.asked[0]).toMatchObject({ where: "on build-01", title: "May I?" });
    const local = makeWorker({ grants: {} });
    await local.call("perceive_window", {});
    await local.call("click", { id: 1 });
    expect(local.asked[0]).not.toHaveProperty("where");
  });
});

describe("a no to a command is the task's no", () => {
  it("marks the task declined until a command runs", async () => {
    const decided: DecideInput[] = [];
    setCommandJudge({
      classifyCommand: (_t, shell) => ({ shell, family: "posix", findings: [], refuse: null, probe: [], needsGit: false, downloads: [], programs: [], commands: [] }),
      decideCommand: i => { decided.push(i); return { verdict: decided.length === 1 ? "ask" : "run", reason: "x", classes: [], rules: [], says: ["Deletes build."], unasked: true, armMs: 1500 }; },
      shapeOutput: () => "ok", redactSecrets: t => t, trackSecretPrompts: () => ({ output: () => undefined, enter: () => undefined, spans: () => [] }),
      outputTaint: () => null, resolveTargetPath: p => p,
    });
    const { w, call } = makeWorker({ target: REMOTE, commands: commandService(REMOTE), answer: "deny" });
    const declined = () => (w as unknown as { declined: boolean }).declined;
    const r = await call("run_command", { target: "build-01", command: "rm -r build", why: "to clean" });
    expect(r.resultType).toBe("denied");
    expect(declined()).toBe(true);
    await call("run_command", { target: "build-01", command: "ls", why: "to look" });
    expect(declined()).toBe(false);
  });
});
