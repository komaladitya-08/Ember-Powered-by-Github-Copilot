/** Real policy/Confirmer composition for exact public-lock decisions; this never downloads or runs a package. */
import { afterEach, expect, it, vi } from "vitest";
import { authorizePublicNpmPreparation } from "../../app/main/agent/public-npm-approval";
import { PUBLIC_NPM_LIMITS, PUBLIC_NPM_REGISTRY, PublicNpmPlan, type PublicNpmPreparationRequest } from "../../app/main/agent/public-npm-lock";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import type { EmberState } from "../../app/shared/overlay";
import type { CommandFlowContext } from "../../app/main/commands/flow";
import type { CommandCapability, CommandMode, CommandService, RunnerFacts } from "../../app/main/commands/types";
import { classifyCommand } from "../../app/main/commands/classify";
import { commandActs, commandNamed, Refusals } from "../../app/main/policy/refusals";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const facts: RunnerFacts = { os: "linux", home: "/state", user: "sandbox", privileged: false, shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" },
  pty: false, script: null, extraPath: [], ember: { paths: [], pids: [], names: /^ember$/ } };
function request(extra: Partial<PublicNpmPreparationRequest> = {}): Readonly<PublicNpmPreparationRequest> {
  return Object.freeze({ kind: "changed", registry: PUBLIC_NPM_REGISTRY, packageJsonSha256: "a".repeat(64), lockSha256: "b".repeat(64), setSha256: "c".repeat(64),
    packages: Object.freeze([Object.freeze({ name: "react", version: "19.0.0" })]), packageCount: 1, compressedByteLimit: PUBLIC_NPM_LIMITS.compressedBytes, ...extra });
}
function fixture() {
  const state = { current: true, mode: "on" as CommandMode, consent: true, askEvery: false, approval: "interactive", words: "Build this app and install its dependencies.", tainted: false };
  const abort = new AbortController(), audit = vi.fn(), announced = vi.fn(), declined = vi.fn();
  const ask = vi.fn(async (_question: Question): Promise<string | null> => "once");
  const review = vi.fn(async (_input: Parameters<NonNullable<CommandFlowContext["review"]>>[0]) => ({ run: true, does: "Prepare these public dependencies", why: "The original request asks for the app's dependencies." }));
  const start = vi.fn(() => { throw new Error("No runner may be launched by an approval."); }), inspect = vi.fn(() => { throw new Error("No paths may be probed by an approval."); });
  const service = { binding: { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", shellOs: "linux", screenOs: "win32", desktop: "none" },
    runner: { facts: vi.fn(async () => structuredClone(facts)), start, inspect }, mode: () => state.mode, userAskEvery: () => state.askEvery,
    capability: (): CommandCapability => ({ state: state.consent ? "on" : "needs-consent", askEvery: state.mode === "ask" ? "admin" : state.askEvery ? "user" : null }),
  } as unknown as CommandService;
  const ctx: CommandFlowContext = { service, signal: abort.signal, isOver: () => !state.current, audit, presenter: { workedWithoutAsking: announced } as unknown as CommandFlowContext["presenter"],
    task: { id: "task", title: "Build the app", commandWords: () => state.words, checkWords: () => state.words, ownWords: () => state.words,
      agreed: () => [], tainted: () => state.tainted, taint() {}, readFrom: () => [] },
    confirmer: { ask }, review, reviewActive: () => state.approval === "assisted", autopilot: () => state.approval === "autopilot", onDeclined: declined,
    refusals: new Refusals(), state: { cwd: "/work", downloaded: new Set(), running: false }, size: () => ({ cols: 80, rows: 24 }), emberPids: () => [], log: {} as CommandFlowContext["log"] };
  return { state, abort, ctx, ask, review, audit, announced, declined, start, inspect, run: (value = request()) => authorizePublicNpmPreparation(value, ctx, PROJECT, abort.signal) };
}
afterEach(() => { vi.useRealTimers(); });

it.each(["baseline", "changed"] as const)("uses the same exact whole-text normal approval for a %s set without launching a shell", async kind => {
  const f = fixture(); expect(await f.run(request({ kind }))).toBe(true);
  expect(f.ask).toHaveBeenCalledOnce(); const q = f.ask.mock.calls[0][0];
  expect(q.detail).toContain("react@19.0.0"); expect(q.detail).toContain("package-lock.json SHA-256: " + "b".repeat(64));
  expect(q.detail).toMatch(/Preparation SHA-256: [0-9a-f]{64}/); expect(q.panel).toBeUndefined(); expect(q.armMs).toBe(1500);
  expect(q.options.map(option => option.id)).toEqual(["once", "deny"]);
  expect(f.start).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
  expect(f.audit.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "dependencies-authorized", packageCount: 1 });
});
it("binds a different lockfile/set to different whole-text approval bytes", async () => {
  const f = fixture(); await f.run(); await f.run(request({ lockSha256: "d".repeat(64), setSha256: "e".repeat(64) }));
  const [first, second] = f.ask.mock.calls.map(call => call[0]);
  expect(first.detail).not.toBe(second.detail); expect(second.detail).toContain("e".repeat(64));
});
it("accepts the genuine core parser's frozen projection while keeping source bodies out of the question", async () => {
  const plan = PublicNpmPlan.create({ packageJson: Buffer.from(JSON.stringify({ name: "app", version: "1.0.0", dependencies: { react: "19.0.0" }, description: "PRIVATE source metadata" })),
    packageLock: Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0" }, "node_modules/react": {
      version: "19.0.0", resolved: PUBLIC_NPM_REGISTRY + "/react/-/react-19.0.0.tgz", integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
    } } })) });
  const f = fixture(); expect(await f.run(Object.freeze({ kind: "baseline", ...plan.summary }))).toBe(true);
  expect(f.ask.mock.calls[0][0].detail).toContain(plan.summary.setSha256); expect(f.ask.mock.calls[0][0].detail).not.toContain("PRIVATE source metadata");
  expect(JSON.stringify(f.audit.mock.calls)).not.toContain("PRIVATE");
});
it("uses Assisted's actual bounded review against original words and announces a cleared preparation", async () => {
  const f = fixture(); f.state.approval = "assisted";
  expect(await f.run()).toBe(true); expect(f.review).toHaveBeenCalledOnce(); expect(f.ask).not.toHaveBeenCalled(); expect(f.announced).toHaveBeenCalledOnce();
  expect(f.review.mock.calls[0][0]).toMatchObject({ userWords: f.state.words, cwd: "/work", os: "linux" });
  expect(f.review.mock.calls[0][0]).not.toHaveProperty("shell"); expect(f.start).not.toHaveBeenCalled();
});
it.each(["preparation", "task"] as const)("settles a held Assisted review promptly after %s Stop without accepting its late answer", async which => {
  const f = fixture(); f.state.approval = "assisted";
  let release!: (answer: { run: boolean; does: string; why: string }) => void;
  f.review.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const preparation = new AbortController(); let observed: boolean | null = null;
  const pending = authorizePublicNpmPreparation(request(), f.ctx, PROJECT, preparation.signal).then(answer => { observed = answer; return answer; });
  await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
  (which === "preparation" ? preparation : f.abort).abort();
  try {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(observed).toBe(false); expect(f.ask).not.toHaveBeenCalled(); expect(f.announced).not.toHaveBeenCalled();
  } finally { release({ run: true, does: "Prepare the set", why: "A late response grants nothing" }); await pending; }
  expect(observed).toBe(false); expect(f.audit.mock.calls.some(call => call[0].phase === "dependencies-authorized")).toBe(false);
});
it.each(["review-failed", "review-declined", "no-original-words"])("keeps the ordinary question after %s instead of treating opt-in as permission", async reason => {
  const f = fixture(); f.state.approval = "assisted";
  if (reason === "review-failed") f.review.mockRejectedValueOnce(new Error("PRIVATE reviewer failure"));
  if (reason === "review-declined") f.review.mockResolvedValueOnce({ run: false, does: "", why: "Not in the original request" });
  if (reason === "no-original-words") f.state.words = "";
  expect(await f.run()).toBe(true); expect(f.ask).toHaveBeenCalledOnce(); expect(JSON.stringify(f.audit.mock.calls)).not.toContain("PRIVATE");
});
it("Autopilot announces without an unconditional question", async () => {
  const f = fixture(); f.state.approval = "autopilot";
  expect(await f.run()).toBe(true); expect(f.ask).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled(); expect(f.announced).toHaveBeenCalledOnce();
});
it.each(["assisted", "autopilot"])("uses the actual Presenter policy announcement before authorizing in %s", async mode => {
  const f = fixture(); f.state.approval = mode;
  const states: Partial<EmberState>[] = [], presenter = new Presenter(state => { states.push(state); }); f.ctx.presenter = presenter;
  try {
    expect(await f.run()).toBe(true); expect(f.ask).not.toHaveBeenCalled();
    expect(states.at(-1)?.bubble).toMatchObject({ visible: true, autonomous: true, streaming: false });
    expect(states.at(-1)?.bubble?.thought).toContain("Preparing 1 locked public dependencies");
    expect(f.audit.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "dependencies-authorized" });
  } finally { presenter.reset(); }
});
it("does not authorize if the actual announcement reenters task retirement", async () => {
  const f = fixture(); f.state.approval = "autopilot";
  const presenter = new Presenter(state => { if (state.bubble?.autonomous) f.state.current = false; }); f.ctx.presenter = presenter;
  try {
    expect(await f.run()).toBe(false); expect(f.ask).not.toHaveBeenCalled();
    expect(f.audit.mock.calls.some(call => call[0].phase === "dependencies-authorized")).toBe(false);
  } finally { presenter.reset(); }
});
it.each(["admin", "user"] as const)("preserves explicit %s ask-every settings in Autopilot", async who => {
  const f = fixture(); f.state.approval = "autopilot"; if (who === "admin") f.state.mode = "ask"; else f.state.askEvery = true;
  expect(await f.run()).toBe(true); expect(f.ask).toHaveBeenCalledOnce(); expect(f.review).not.toHaveBeenCalled();
});
it.each(["admin-off", "withdrawn-consent"] as const)("refuses %s without silently opening a new feature consent or granting preparation", async reason => {
  const f = fixture(); f.state.approval = "autopilot";
  if (reason === "admin-off") f.state.mode = "off"; else f.state.consent = false;
  expect(await f.run()).toBe(false); expect(f.ask).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled(); expect(f.announced).not.toHaveBeenCalled();
});
it.each(["deny", null] as const)("holds %s for the task and refuses another set without retrying a question", async answer => {
  const f = fixture(); f.ask.mockResolvedValueOnce(answer); expect(await f.run()).toBe(false);
  expect(f.declined).toHaveBeenCalledWith(answer === null);
  expect(await f.run(request({ setSha256: "d".repeat(64) }))).toBe(false); expect(f.ask).toHaveBeenCalledOnce();
});
it("shares an actual npm-install refusal with the semantic preparation decision", async () => {
  const f = fixture(), command = "npm install react";
  const cls = classifyCommand(command, "bash", { os: "linux", home: "/state", cwd: "/work", ember: facts.ember, downloaded: new Set() });
  f.ctx.refusals!.noteCommand({ sha256: "f".repeat(64), cwd: "/work", command, os: "linux", home: "/state",
    acts: commandActs(cls.findings, "linux"), named: commandNamed(cls.findings, cls.commands) }, "refused");
  expect(await f.run()).toBe(false); expect(f.ask).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled();
});
it("honors the user's original no to installing packages even in Autopilot", async () => {
  const f = fixture(); f.state.approval = "autopilot"; f.state.words = "Inspect the app, but do not install packages.";
  expect(await f.run()).toBe(false); expect(f.ask).not.toHaveBeenCalled(); expect(f.announced).not.toHaveBeenCalled();
});
it("does not ask for a zero-download ordinary set unless policy asks for every operation", async () => {
  const f = fixture(); expect(await f.run(request({ packages: Object.freeze([]), packageCount: 0 }))).toBe(true); expect(f.ask).not.toHaveBeenCalled();
});
it.each(["lost-owner", "stop", "new-policy", "audit", "presentation"] as const)("does not authorize after %s at an external boundary", async point => {
  const f = fixture();
  if (point === "audit") f.audit.mockImplementation(() => { throw new Error("PRIVATE audit failure"); });
  else if (point === "presentation") { f.state.approval = "autopilot"; f.announced.mockImplementation(() => { f.state.current = false; }); }
  else f.ask.mockImplementationOnce(async () => { if (point === "stop") f.abort.abort(); else if (point === "new-policy") f.state.askEvery = true; else f.state.current = false; return "once"; });
  expect(await f.run()).toBe(false); expect(f.start).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
  expect(JSON.stringify(f.audit.mock.calls)).not.toContain("PRIVATE");
});
it("rejects malformed projections and accessor/proxy traps before policy callbacks", async () => {
  let trapped = 0;
  const guarded = new Proxy(request(), { get() { trapped++; throw new Error("PRIVATE trap"); }, ownKeys() { trapped++; throw new Error("PRIVATE trap"); } });
  const packages: unknown[] = []; Object.defineProperty(packages, "0", { enumerable: true, get() { trapped++; throw new Error("PRIVATE getter"); } }); Object.freeze(packages);
  for (const value of [guarded, request({ registry: "https://foreign.example" as typeof PUBLIC_NPM_REGISTRY }), request({ packageCount: 2 }),
    request({ packages: packages as PublicNpmPreparationRequest["packages"] }), request({ compressedByteLimit: Infinity }), Object.freeze({ ...request(), extra: true })]) {
    const f = fixture(); expect(await f.run(value)).toBe(false); expect(f.ask).not.toHaveBeenCalled(); expect(f.review).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
  }
  expect(trapped).toBe(0);
});
it("keeps the complete bounded set visible and declines an overlong Assisted review rather than truncating it", async () => {
  const f = fixture(); f.state.approval = "assisted";
  const packages = Object.freeze(Array.from({ length: 512 }, (_, index) => Object.freeze({ name: "package-" + index, version: "1.0.0" })));
  expect(await f.run(request({ packages, packageCount: 512 }))).toBe(true);
  expect(f.review).not.toHaveBeenCalled(); expect(f.ask.mock.calls[0][0].detail).toContain("package-511@1.0.0");
  expect(f.ask.mock.calls[0][0].detail!.split("\n").filter(line => /^package-\d+@/.test(line))).toHaveLength(512);
});
it("uses the real Confirmer's whole-text, arm and borrowed-mouse gates for this exact set", async () => {
  vi.useFakeTimers(); const f = fixture(); let blocked = false;
  const c = new Confirmer(() => undefined, { armMs: 0, gapMs: 0, blocked: () => blocked }); f.ctx.confirmer = c;
  try {
    const pending = f.run(); for (let count = 0; count < 5; count++) await Promise.resolve();
    expect(c.currentNumber).toBe(1); expect(c.answer("q1:once")).toBe(false);
    expect(c.wholeSeen(2)).toBe(false); expect(c.wholeSeen(1)).toBe(true);
    expect(c.answer("q1:once")).toBe(false); await vi.advanceTimersByTimeAsync(1501);
    blocked = true; expect(c.answer("q1:once")).toBe(false); blocked = false;
    expect(c.answer("q1:once")).toBe(true); expect(await pending).toBe(true);
  } finally { c.cancelAll(); }
});
