import { describe, expect, it } from "vitest";
import { APPROVAL_MAX_MS, gateCommand, gateStep, GATE_WORDS, sha256Hex, type CommandGateInput, type StepGateInput } from "../../app/remote/gate";
import { emberNamesRegExp } from "../../app/main/remote/protocol";
import { PolicyEngine } from "../../app/main/policy/policy";
import { isTerminalApp } from "../../app/main/hands/system";
import type { Classification, ClassifyContext, CommandStamp, DangerClass, Finding, PathFact, RunnerFacts, RunSpec } from "../../app/main/commands/types";
import type { ActStamp } from "../../app/main/perception/ports";

const facts = (o: Partial<RunnerFacts> = {}): RunnerFacts => ({
  os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null, home: "/home/deploy", user: "deploy",
  privileged: false, pty: false, ember: { paths: [], pids: [], names: emberNamesRegExp([]) }, extraPath: [], ...o,
});

const finding = (cls: DangerClass, rule: string, says: string, o: Partial<Finding> = {}): Finding =>
  ({ cls, rule, says, program: rule.split(".")[1] ?? "", objects: [], widening: [], at: 0, ...o });

/** A classifier that finds what `rules` says for the command, given the context it was called with. */
function classifier(find: (ctx: ClassifyContext) => Finding[], o: { probe?: string[]; refuse?: Classification["refuse"] } = {}) {
  const calls: ClassifyContext[] = [];
  const classify = (_text: string, shell: RunSpec["shell"], ctx: ClassifyContext): Classification => {
    calls.push(ctx);
    return { shell, family: "posix", findings: find(ctx), refuse: o.refuse ?? null, probe: o.probe ?? [], needsGit: false, downloads: [], programs: [], commands: [] };
  };
  return { classify, calls };
}

const spec = (stamp: Partial<CommandStamp> = {}, o: Partial<RunSpec> = {}): RunSpec => ({
  runId: "0123456789abcdef", taskId: "1-abc", shell: "bash", command: "rm -r build", cwd: "/home/deploy/proj", timeoutMs: 120_000, cols: 80, rows: 24,
  stamp: { taskId: "1-abc", sha256: "f".repeat(64), verdict: "run", classes: [], rules: [], approval: null, ...stamp },
  ...o,
});

const input = (o: Partial<CommandGateInput> & Pick<CommandGateInput, "spec" | "classify">): CommandGateInput => ({
  epoch: 3, agentEpoch: 3, fresh: true, targetId: null, mode: "on", facts: facts(),
  inspect: async (paths: string[]) => paths.map((): PathFact => ({ exists: true, real: null })), ...o,
});

const RM = finding("destroy", "posix.rm", "Deletes build and everything in it.");

describe("gate 2 for commands (§3.16)", () => {
  it("runs what the stamp covers: an ordinary command, or a dangerous one whose class and rule the PC named", async () => {
    expect(await gateCommand(input({ spec: spec(), classify: classifier(() => []).classify }))).toMatchObject({ status: "ok", approved: false });
    const announced = spec({ verdict: "announce", classes: ["destroy"], rules: ["posix.rm"] });
    expect(await gateCommand(input({ spec: announced, classify: classifier(() => [RM]).classify }))).toMatchObject({ status: "ok" });
  });

  it("asks for any finding beyond the stamp's, for \"run\" and for \"announce\" alike (critique security-3)", async () => {
    for (const verdict of ["run", "announce"] as const) {
      const s = spec({ verdict, classes: verdict === "announce" ? ["destroy"] : [], rules: verdict === "announce" ? ["posix.rm"] : [] });
      const extra = finding("secret", "path.secret", "Reads or changes passwords, keys or other secrets.");
      const r = await gateCommand(input({ spec: s, classify: classifier(() => [RM, extra]).classify }));
      expect(r).toEqual({
        status: "needs_confirm", reason: GATE_WORDS.disagree,
        says: verdict === "run" ? [RM.says, extra.says] : [extra.says],
        rules: verdict === "run" ? ["posix.rm", "path.secret"] : ["path.secret"],
      });
    }
  });

  it("asks when the PC named the rule but not the class, unless the user said yes", async () => {
    const s = spec({ verdict: "announce", classes: ["publish"], rules: ["posix.rm"] });
    expect((await gateCommand(input({ spec: s, classify: classifier(() => [RM]).classify }))).status).toBe("needs_confirm");
    const yes = spec({ verdict: "ask", classes: ["publish"], rules: ["posix.rm"], approval: { ageMs: 2000 } });
    expect(await gateCommand(input({ spec: yes, classify: classifier(() => [RM]).classify }))).toMatchObject({ status: "ok", approved: true });
  });

  it("still asks after the user's yes for a rule the PC's card didn't carry, and runs once the PC resends with it", async () => {
    const extra = finding("system", "posix.sudo", "Runs as another user.");
    const first = spec({ verdict: "ask", classes: ["destroy"], rules: ["posix.rm"], approval: { ageMs: 1000 } });
    expect(await gateCommand(input({ spec: first, classify: classifier(() => [RM, extra]).classify }))).toMatchObject({ status: "needs_confirm", rules: ["posix.sudo"] });
    const resent = spec({ verdict: "ask", classes: ["destroy"], rules: ["posix.rm", "posix.sudo"], approval: { ageMs: 500 } });
    expect(await gateCommand(input({ spec: resent, classify: classifier(() => [RM, extra]).classify }))).toMatchObject({ status: "ok" });
  });

  it("counts an approval 120 s old or older as none", async () => {
    const s = spec({ verdict: "ask", classes: ["destroy"], rules: ["posix.rm"], approval: { ageMs: APPROVAL_MAX_MS } });
    expect(await gateCommand(input({ spec: s, classify: classifier(() => [RM]).classify }))).toMatchObject({ status: "needs_confirm", reason: GATE_WORDS.approvalMissing });
    const fresh = spec({ verdict: "ask", classes: ["destroy"], rules: ["posix.rm"], approval: { ageMs: APPROVAL_MAX_MS - 1 } });
    expect((await gateCommand(input({ spec: fresh, classify: classifier(() => [RM]).classify }))).status).toBe("ok");
  });

  it("follows this computer's own commands mode: off denies, ask wants a yes", async () => {
    const c = classifier(() => []).classify;
    expect(await gateCommand(input({ spec: spec(), classify: c, mode: "off" }))).toEqual({ status: "deny", reason: GATE_WORDS.commandsOff });
    expect(await gateCommand(input({ spec: spec(), classify: c, mode: "ask" }))).toMatchObject({ status: "needs_confirm", reason: GATE_WORDS.adminAsks });
    expect((await gateCommand(input({ spec: spec({ verdict: "ask", approval: { ageMs: 10 } }), classify: c, mode: "ask" }))).status).toBe("ok");
  });

  it("asks before every command as root, and runs it after the user's yes (D4.6)", async () => {
    const c = classifier(() => []).classify;
    expect(await gateCommand(input({ spec: spec(), classify: c, facts: facts({ privileged: true }) }))).toMatchObject({ status: "needs_confirm", reason: GATE_WORDS.root });
    expect((await gateCommand(input({ spec: spec({ verdict: "ask", approval: { ageMs: 10 } }), classify: c, facts: facts({ privileged: true }) }))).status).toBe("ok");
  });

  it("denies what its own classifier refuses (D4.5 on this computer's paths), approved or not", async () => {
    const c = classifier(() => [], { refuse: { rule: "ember.own", says: "This would change Ember itself." } }).classify;
    expect(await gateCommand(input({ spec: spec({ verdict: "ask", approval: { ageMs: 1 } }), classify: c }))).toEqual({ status: "deny", reason: "This would change Ember itself." });
  });

  it("refuses with stopped for an older epoch and stale without a fresh frame", async () => {
    const c = classifier(() => []).classify;
    expect(await gateCommand(input({ spec: spec(), classify: c, epoch: 2 }))).toEqual({ status: "stopped" });
    expect(await gateCommand(input({ spec: spec(), classify: c, fresh: false }))).toEqual({ status: "stale" });
  });

  it("binds the stamp to the spec: its task, and its hash where the target is known", async () => {
    const c = classifier(() => []).classify;
    expect(await gateCommand(input({ spec: spec({ taskId: "2-xyz" }), classify: c }))).toEqual({ status: "deny", reason: GATE_WORDS.mismatch });
    const s = spec();
    const good = { ...s, stamp: { ...s.stamp, sha256: sha256Hex(`ssh:build-01\0bash\0${s.cwd}\0${s.command}`) } };
    expect((await gateCommand(input({ spec: good, classify: c, targetId: "ssh:build-01" }))).status).toBe("ok");
    expect(await gateCommand(input({ spec: good, classify: c, targetId: "ssh:build-02" }))).toEqual({ status: "deny", reason: GATE_WORDS.mismatch });
  });

  it("judges the paths as they are here: the second pass with real paths finds a link into a secret folder", async () => {
    const secret = finding("secret", "path.secret", "Reads or changes passwords, keys or other secrets.");
    const c = classifier(ctx => (ctx.real?.get("/home/deploy/proj/keys") === "/home/deploy/.ssh" ? [secret] : []), { probe: ["/home/deploy/proj/keys"] });
    const r = await gateCommand(input({ spec: spec(), classify: c.classify, inspect: async () => [{ exists: true, real: "/home/deploy/.ssh" }] }));
    expect(r).toMatchObject({ status: "needs_confirm", rules: ["path.secret"] });
    expect(c.calls).toHaveLength(2);
  });

  it("drops an overwrite whose target doesn't exist here, and keeps it when it can't tell", async () => {
    const over = finding("destroy", "redirect.overwrite", "Overwrites out.txt.", { ifExists: "/home/deploy/proj/out.txt" });
    const c = classifier(() => [over], { probe: ["/home/deploy/proj/out.txt"] }).classify;
    expect((await gateCommand(input({ spec: spec(), classify: c, inspect: async () => [{ exists: false, real: null }] }))).status).toBe("ok");
    expect((await gateCommand(input({ spec: spec(), classify: c, inspect: async () => [{ exists: null, real: null }] }))).status).toBe("needs_confirm");
    expect((await gateCommand(input({ spec: spec(), classify: c, inspect: async () => { throw new Error("no"); } }))).status).toBe("needs_confirm");
  });
});

const stamp = (o: Partial<ActStamp> = {}): ActStamp => ({
  taskId: "1-abc", kind: "click", app: "gedit", window: "notes.txt - gedit", element: { role: "push button", name: "Save" },
  verdict: "confirm", approval: { given: true }, ageMs: 800, ...o,
});
const engine = new PolicyEngine({ neverLook: () => ["KeePassXC"], grants: () => ({}), allowGrants: () => false, isTerminalApp: n => isTerminalApp({ id: n, name: n }) });
const step = (o: Partial<StepGateInput> = {}): StepGateInput => ({
  stamp: stamp(), op: "do_action", element: { role: "push button", name: "Save" }, window: { app: "gedit", title: "notes.txt - gedit" },
  actionsAllowed: true, decide: r => engine.decide(r), ...o,
});

describe("gate 2 for desktop steps (§5.3.7)", () => {
  it("lets a confirmed step through when everything still matches", () => {
    expect(gateStep(step())).toEqual({ status: "ok" });
  });

  it("calls a stamp 10 s old stale", () => {
    expect(gateStep(step({ stamp: stamp({ ageMs: 10_000 }) }))).toEqual({ status: "stale" });
  });

  it("says changed when the element or its window isn't what the PC saw", () => {
    expect(gateStep(step({ element: { role: "push button", name: "Delete" } }))).toEqual({ status: "changed" });
    expect(gateStep(step({ element: null }))).toEqual({ status: "changed" });
    expect(gateStep(step({ window: { app: "gedit", title: "other.txt - gedit" } }))).toEqual({ status: "changed" });
    // The same words told apart only by case or look-alike letters are the same.
    expect(gateStep(step({ element: { role: "push button", name: "SAVE" } }))).toEqual({ status: "ok" });
  });

  it("refuses a step whose kind or value isn't the stamp's", () => {
    expect(gateStep(step({ op: "set_text", value: "hi", stamp: stamp({ kind: "click" }) }))).toEqual({ status: "deny", reason: GATE_WORDS.stepMismatch });
    const text = stamp({ kind: "text", element: { role: "text", name: "Body" }, valueSha256: sha256Hex("hello") });
    const at = { element: { role: "text", name: "Body" }, stamp: text, op: "set_text" as const };
    expect(gateStep(step({ ...at, value: "hello" }))).toEqual({ status: "ok" });
    expect(gateStep(step({ ...at, value: "hello!" }))).toEqual({ status: "deny", reason: GATE_WORDS.stepMismatch });
  });

  it("refuses everything when this computer's administrator turned actions off", () => {
    expect(gateStep(step({ actionsAllowed: false }))).toEqual({ status: "deny", reason: GATE_WORDS.actionsOff });
  });

  it("wants a yes the stamp doesn't carry, and refuses what this computer's policy never allows", () => {
    expect(gateStep(step({ stamp: stamp({ approval: null }) })).status).toBe("needs_confirm");
    const never = gateStep(step({ window: { app: "KeePassXC", title: "Passwords" }, stamp: stamp({ app: "KeePassXC", window: "Passwords" }) }));
    expect(never.status).toBe("deny");
  });

  it("never opens a terminal on the remote, whatever the PC said", () => {
    const r = gateStep(step({ op: "open_app", value: "GNOME Terminal", element: null, window: null, stamp: stamp({ kind: "open_app", app: "GNOME Terminal", window: "", element: null }) }));
    expect(r.status).toBe("deny");
    const ok = gateStep(step({ op: "open_app", value: "Text Editor", element: null, window: null, stamp: stamp({ kind: "open_app", app: "Text Editor", window: "", element: null }) }));
    expect(ok).toEqual({ status: "ok" });
  });
});
