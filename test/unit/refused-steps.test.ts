/**
 * The refused step (round nine's tasks-approvals-r9-1 and commands-remote-r9-8; CLAUDE.md "After a deny or “Not now”,
 * Ember never retries or works around it"). Until now that was only words to the model: the same click sent again was
 * asked again and done on a yes, a refused command's card came up a second and a third time, and with the reviewer on a
 * refused `rm -rf build` ran on a retry after only an announcement. A task now keeps what the user said no to (and what
 * they left unanswered, until they next say something to it), and a repeat is refused without a question, never
 * reviewed and never announced, in every mode: for one step, for fill_cells and for commands. It only tightens.
 */

import { afterEach, describe, expect, it } from "vitest";
import { PolicyEngine, type ActionKind } from "../../app/main/policy/policy";
import { ALL_SCOPES, type AutonomyScopes } from "../../app/main/policy/autonomy";
import { Refusals, commandActs, sameCommand, stepNames, type CommandAsked } from "../../app/main/policy/refusals";
import { Worker, leftUndone, type WorkerDeps } from "../../app/main/agent/worker";
import { commandSha256, runCommandTool, setCommandJudge, type CommandFlowContext } from "../../app/main/commands/flow";
import { classifyCommand } from "../../app/main/commands/classify";
import { standingFindings, type ClassifyContext, type RunSpec } from "../../app/main/commands/types";
import { describeEntry } from "../../app/renderer/home/copy";
import type { AxNode } from "../../app/main/perception/sidecar";
import { Presenter } from "../../app/main/agent/presenter";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe("the names a step goes by in a task's refusals (tasks-approvals-r9-1)", () => {
  const W = "7\n/p/1";
  const key = (role: string, name: string, w = W) => `${w}\n${role}\n${name}`;
  const names = (kind: ActionKind, role: string, name: string, o: { value?: string; activates?: boolean; w?: string } = {}) =>
    stepNames({ kind, key: key(role, name, o.w), named: !!role, ...(o.value !== undefined ? { value: o.value } : {}), ...(o.activates ? { activates: true } : {}) });
  const same = (a: string[], b: string[]) => a.some(n => b.includes(n));

  // [what the user said no to, what the model sends next, is it the same step?]
  const table: [string, string[], string[], boolean][] = [
    ["the same click again", names("click", "push button", "Send"), names("click", "push button", "Send"), true],
    ["the click with the borrowed mouse instead", names("click", "push button", "Send"), names("cursor_click", "push button", "Send"), true],
    ["the click as a toggle instead", names("click", "check box", "Share"), names("toggle", "check box", "Share"), true],
    ["Enter on the button instead of the click", names("click", "push button", "Send"), names("keys", "push button", "Send", { value: "Return", activates: true }), true],
    ["the click after Enter on it was refused", names("keys", "push button", "Send", { value: "Return", activates: true }), names("cursor_click", "push button", "Send"), true],
    ["the same keys in the same place", names("keys", "text", "", { value: "Delete" }), names("keys", "text", "", { value: "delete" }), true],
    ["other words typed into the field", names("text", "entry", "Message"), names("cursor_text", "entry", "Message"), true],
    ["another option of the same list", names("select", "combo box", "Action"), names("select", "combo box", "Action"), true],
    ["the same app opened again", names("open_app", "", "", { value: "Calculator", w: "" }), names("open_app", "", "", { value: "calculator", w: "9\nother" }), true],
    ["another control in the window", names("click", "push button", "Send"), names("click", "push button", "Bold"), false],
    ["a control of that name in another window", names("click", "push button", "Send"), names("click", "push button", "Send", { w: "8\n/p/2" }), false],
    ["a link of that name, not the button", names("click", "push button", "Send"), names("click", "link", "Send"), false],
    ["other keys in the same place", names("keys", "text", "", { value: "Delete" }), names("keys", "text", "", { value: "Down" }), false],
    ["a key that only moves, on the refused button", names("click", "push button", "Send"), names("keys", "push button", "Send", { value: "Tab" }), false],
    ["text typed into the field whose button was refused", names("click", "push button", "Send"), names("text", "push button", "Send"), false],
    ["Enter with nothing known to have the keyboard, after a click was refused", names("click", "", ""), names("keys", "", "", { value: "Return", activates: true }), false],
    ["another app opened", names("open_app", "", "", { value: "Calculator" }), names("open_app", "", "", { value: "Notes" }), false],
    ["a scroll of the list whose row was refused", names("click", "list item", "Old"), names("scroll", "list item", "Old"), false],
  ];
  for (const [what, refused, next, is] of table) {
    it(`${is ? "takes" : "doesn't take"} ${what} for the step the user said no to`, () => {
      expect(same(refused, next)).toBe(is);
      const r = new Refusals();
      r.noteStep(refused, "refused");
      expect(r.step(next)).toBe(is ? "refused" : null);
    });
  }

  it("keeps a no for the rest of the task, and an unanswered question only until the user next says something", () => {
    const r = new Refusals();
    const send = names("click", "push button", "Send"), post = names("click", "push button", "Post");
    r.noteStep(send, "refused");
    r.noteStep(post, "waiting");
    expect([r.step(send), r.step(post)]).toEqual(["refused", "waiting"]);
    r.userSpoke();
    expect([r.step(send), r.step(post)]).toEqual(["refused", null]);
    // A question about a refused step that later ran out of time doesn't weaken the no.
    r.noteStep(send, "waiting");
    r.userSpoke();
    expect(r.step(send)).toBe("refused");
    // The first-use commands card, the same.
    r.noteConsent("waiting");
    expect(r.commandsConsent).toBe("waiting");
    r.userSpoke();
    expect(r.commandsConsent).toBeNull();
    r.noteConsent("refused");
    r.noteConsent("waiting");
    r.userSpoke();
    expect(r.commandsConsent).toBe("refused");
  });
});

const LINUX: ClassifyContext = { os: "linux", home: "/home/ana", cwd: "/home/ana/proj", ember: { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ }, downloaded: new Set() };
const WINDOWS: ClassifyContext = { os: "win32", home: "C:\\Users\\ana", cwd: "C:\\Users\\ana\\proj", ember: { paths: [], pids: [], names: /^ember$/ }, downloaded: new Set() };
/** A command as the flow keeps it, classified by Ember's own classifier (nothing here changes it). */
function asked(command: string, o: { shell?: "bash" | "sh" | "powershell"; ctx?: ClassifyContext } = {}): CommandAsked {
  const ctx = o.ctx ?? LINUX;
  const shell = o.shell ?? (ctx.os === "win32" ? "powershell" : "bash");
  const cls = classifyCommand(command, shell, ctx);
  return { sha256: commandSha256("local", shell, ctx.cwd, command), cwd: ctx.cwd, command, acts: commandActs(standingFindings(cls.findings, undefined), ctx.os) };
}

describe("a command the user said no to, sent again or reworded (commands-remote-r9-8)", () => {
  // [the command refused, what comes next, is it the same?]
  const table: [string, string, boolean][] = [
    ["rm -rf build", "rm -rf build", true],
    ["rm -rf build", "  rm -rf build ", true],
    ["rm -rf build", "find build -delete", true],
    ["rm -rf build", "rm -rf ./build/", true],
    ["rm -rf build", "rm -rf /home/ana/proj/build", true],
    ["rm -rf build", "rm -rf build/*", true],
    ["rm -rf build", "cd build && rm -rf *", true],
    ["rm -rf build", "rm -r build dist", true],
    ["rm -rf build", "shred -u build/a.o", true],
    ["rm -rf build", "rm -rf /home/ana/proj", true],
    ["rm -rf build", "rsync -a --delete src/ build/", true],
    ["rm -r build dist", "rm -rf dist", true],
    ["git push origin main", "git push --force origin main", true],
    ["git push origin main", "git push origin feature", true],
    ["sudo apt install nginx", "apt install nginx", true],
    ["shutdown -h now", "shutdown -r now", true],
    ["cat ~/.ssh/id_rsa", "base64 ~/.ssh/id_rsa", true],
    ["rm -rf build", "rm -rf dist", false],
    ["rm -rf build", "rm -rf builder", false],
    ["rm -rf build", "ls build", false],
    ["rm -rf build", "git push origin main", false],
    ["rm -rf build", "git clean -fdx", false],
    ["rm -rf build", "cat build/notes.txt", false],
    ["git push origin main", "npm publish", false],
    ["sudo apt install nginx", "sudo apt install vim", false],
    ["sudo rm -rf /var/cache/old", "sudo apt install vim", false],
    ["cat ~/.ssh/id_rsa", "cat ~/.ssh/config", false],
    ["ls", "ls -la", false],
  ];
  for (const [refused, next, is] of table) {
    it(`${is ? "takes" : "doesn't take"} \`${next}\` for a refused \`${refused}\``, () => {
      expect(sameCommand(asked(refused), asked(next))).toBe(is);
    });
  }

  it("takes the same bytes in another shell for the same command, but not in another folder", () => {
    expect(asked("ls -la").acts).toEqual([]);
    expect(sameCommand(asked("ls -la"), asked("ls -la", { shell: "sh" }))).toBe(true);
    expect(sameCommand(asked("ls -la"), asked("ls -la", { ctx: { ...LINUX, cwd: "/home/ana/other" } }))).toBe(false);
    // What a command acts on is the same wherever it is run from.
    expect(sameCommand(asked("rm -rf build"), asked("rm -rf proj/build", { ctx: { ...LINUX, cwd: "/home/ana" } }))).toBe(true);
  });

  it("reads a Windows path whatever its case and slashes, and a Linux path exactly", () => {
    expect(sameCommand(asked("Remove-Item -Recurse -Force build", { ctx: WINDOWS }), asked("rm -r .\\Build\\", { ctx: WINDOWS }))).toBe(true);
    expect(sameCommand(asked("Remove-Item -Recurse -Force build", { ctx: WINDOWS }), asked("Remove-Item -Recurse C:/Users/ANA/proj/build/obj", { ctx: WINDOWS }))).toBe(true);
    expect(sameCommand(asked("rm -rf build"), asked("rm -rf Build"))).toBe(false);
  });

  it("keeps a no for the rest of the task, and an unanswered card only until the user next says something", () => {
    const r = new Refusals();
    r.noteCommand(asked("rm -rf build"), "refused");
    r.noteCommand(asked("git push origin main"), "waiting");
    expect([r.command(asked("find build -delete")), r.command(asked("git push origin main")), r.command(asked("rm -rf dist"))]).toEqual(["refused", "waiting", null]);
    r.userSpoke();
    expect([r.command(asked("find build -delete")), r.command(asked("git push origin main"))]).toEqual(["refused", null]);
  });
});

const BOLD: AxNode = { id: 1, parent: null, depth: 1, role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
const DELETE: AxNode = { id: 3, parent: null, depth: 1, role: "push button", name: "Delete", states: ["enabled", "sensitive"], bounds: { x: 60, y: 10, width: 40, height: 20 } };
const REFUSED_BEFORE = "The user already said no to this step in this task, so Ember refused it without asking them again. Don't retry it or work around it; finish the task and say what wasn't done.";
const STILL_UNANSWERED = "Ember already asked the user about this step and the question went unanswered; they haven't said anything to this task since, so Ember didn't ask again and the step wasn't taken. Don't retry it or work around it; finish the task now, saying that the question went unanswered and what wasn't done.";

/**
 * A worker on a window with Bold and Delete, in Interactive (every scope on) unless `scopes` says otherwise. Each
 * question is answered by `answers` in turn: null is a question that ran out of time, "deny" a "Not now".
 */
function worker(answers: (string | null)[], o: { scopes?: () => AutonomyScopes | null } = {}) {
  const audit: Record<string, unknown>[] = [];
  const askedOf: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const seen = { window, x11Window: null, nodes: [BOLD, DELETE], blocked: false, ms: 0 };
  const scopes = o.scopes ?? (() => ({ ...ALL_SCOPES }));
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "<screen>", capture: null }), read: async () => seen, windows: async () => [window], systemDialogOpen: async () => false } as never,
    sidecar: {
      readElement: async (id: number) => { const n = seen.nodes.find(x => x.id === id); return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds } : null; },
      doAction: async () => ({ ok: true, after: { role: "push button", name: "Bold", states: [], bounds: BOLD.bounds } }),
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: scopes }),
    autonomy: scopes,
    confirmer: { ask: async (q: { prompt: string }) => { askedOf.push(q.prompt); return answers.length ? answers.shift() : "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    onActivity: (e: Record<string, unknown>) => { activity.push(e); },
    cursor: { borrow: { borrow: async () => undefined } as never, findWindow: () => 1, setBorrowing: () => undefined },
  } as unknown as WorkerDeps, { id: "t1", goal: "delete the old line, then make it bold", target: { title: "notes.txt" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const inner = w as unknown as {
    authorize(req: Record<string, unknown>): Promise<{ textResultForLlm: string; resultType: string } | null>;
    authorizeCells(jobs: unknown[]): Promise<{ textResultForLlm: string; resultType: string } | null | "each">;
    commandContext(): CommandFlowContext;
    session: unknown; saidNoThisTask: boolean;
  };
  // The user says something to the task (a steer needs a session to tell: a stand-in that takes the words).
  const says = async (text: string) => { inner.session = { send: async () => undefined }; expect(await w.steer(text, text)).toBe(true); };
  const cells = (...at: string[]) => inner.authorizeCells(at.map((cell, n) => ({ cell, text: "4", place: { col: 1, row: 5 + n }, seenKey: cell, expected: undefined, listed: undefined })));
  return { audit, asked: askedOf, activity, call, inner, says, cells, actions: () => audit.filter(e => e.event === "action") };
}

describe("a step the user said no to, sent again by the model (tasks-approvals-r9-1)", () => {
  it("is refused without a question, however often it comes and whatever the next answer would be", async () => {
    // (The probe of round nine: deny, deny, once had it asked three times and clicked on the third.)
    const h = worker(["deny", "once", "once"]);
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 3 })).textResultForLlm).toBe("The user said no. Don't retry or work around it; finish the task and say what wasn't done.");
    for (let i = 0; i < 3; i++) {
      const r = await h.call("click", { id: 3 });
      expect(r).toMatchObject({ resultType: "denied", textResultForLlm: REFUSED_BEFORE });
      // Calls the model sent in the same reply do nothing behind it, as behind the no itself.
      expect(leftUndone("click", r as never)).toBe("no");
    }
    expect(h.asked).toEqual(["Click the “Delete” button in gedit?"]);
    expect(h.actions()).toEqual([]);
    // Recorded as refused, with why, in Ember's own words; its card's row says the same.
    const again = h.audit.filter(e => e.event === "decision").slice(1);
    expect(again).toHaveLength(3);
    for (const e of again) expect(e).toMatchObject({ kind: "click", verdict: "deny", reason: "the user said no to this step earlier in this task", element: { role: "push button", name: "Delete" } });
    expect(h.activity.filter(e => e.type === "refused")).toEqual(Array(3).fill({ type: "refused", reason: "the user said no to this step earlier in this task" }));
    expect(describeEntry(again[0] as never)).toMatchObject({ tag: "Refused", why: "You said no to this step earlier in this task." });
  });

  it("is refused in every mode: below Interactive too, and where the mode would now announce it", async () => {
    // Below Interactive the first step in an app asks; the user says no; then Interactive comes into force, where the
    // same click would be announced and done.
    let scopes: AutonomyScopes | null = null;
    const h = worker(["deny"], { scopes: () => scopes });
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 1 })).resultType).toBe("denied");
    expect((await h.call("click", { id: 1 })).textResultForLlm).toBe(REFUSED_BEFORE);
    scopes = { ...ALL_SCOPES };
    expect((await h.call("click", { id: 1 })).textResultForLlm).toBe(REFUSED_BEFORE);
    expect(h.asked).toHaveLength(1);
    expect(h.actions()).toEqual([]);
    expect(h.activity.some(e => e.type === "announce")).toBe(false);
    expect(h.audit.some(e => e.autonomy === true)).toBe(false);
  });

  it("is refused when it is tried another way: Enter on the button, or the click after Enter was refused", async () => {
    const h = worker(["deny"]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    const keys = { taskId: "t1", kind: "keys", app: "gedit", window: "notes.txt", element: { role: "push button", name: "Delete" }, value: "Return" };
    expect(await h.inner.authorize(keys)).toMatchObject({ resultType: "denied", textResultForLlm: REFUSED_BEFORE });
    expect(h.asked).toHaveLength(1);
    const other = worker(["deny"]);
    await other.call("perceive_window", {});
    expect(await other.inner.authorize(keys)).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(/^The user said no\./) });
    expect((await other.call("click", { id: 3 })).textResultForLlm).toBe(REFUSED_BEFORE);
    expect(other.asked).toHaveLength(1);
  });

  it("stays refused after the user says something more to the task: asking for it afresh is a new request", async () => {
    const h = worker(["deny"]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    await h.says("and make it bold too");
    expect((await h.call("click", { id: 3 })).textResultForLlm).toBe(REFUSED_BEFORE);
    expect(h.asked).toHaveLength(1);
  });

  it("leaves every other step as it was: asked about in a task the user said no in, and done on a yes", async () => {
    const h = worker(["deny", "once"]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    expect((await h.call("click", { id: 1 })).resultType).toBe("success");
    expect(h.asked).toHaveLength(2);
    expect(h.actions()).toHaveLength(1);
  });

  it("never stands in for one of Ember's own refusals: a step policy refuses says why itself", async () => {
    const h = worker(["deny"]);
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    const r = await h.inner.authorize({ taskId: "t1", kind: "click", app: "gedit", window: "notes.txt", element: { role: "password text", name: "Delete" } });
    expect(r?.textResultForLlm).toMatch(/^Not allowed: password fields are for the user only\./);
  });
});

describe("a step whose question went unanswered, sent again by the model (tasks-approvals-r9-1, cause 10)", () => {
  it("isn't asked about twice: it is refused as still waiting until the user next says something to the task", async () => {
    // (The probe of round nine: after a timeout it was asked again, and clicked on the second.)
    const h = worker([null, "once"]);
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 3 })).textResultForLlm).toMatch(/^Your question went unanswered: /);
    const r = await h.call("click", { id: 3 });
    expect(r).toMatchObject({ resultType: "denied", textResultForLlm: STILL_UNANSWERED });
    expect(r.textResultForLlm).not.toMatch(/said no/);
    expect(h.asked).toHaveLength(1);
    expect(h.audit.filter(e => e.event === "decision").at(-1)).toMatchObject({ verdict: "deny", reason: "the question about this step went unanswered, and the user hasn't said anything to this task since" });
    // It is nobody's no: the task isn't held to asking for it (cause 10).
    expect(h.inner.saidNoThisTask).toBe(false);
    // The user is there again: the step may be asked about once more, and their yes does it.
    await h.says("yes, go on");
    expect((await h.call("click", { id: 3 })).resultType).toBe("success");
    expect(h.asked).toHaveLength(2);
    expect(h.actions()).toHaveLength(1);
  });

  it("isn't announced and done either, where the mode in force would now let it go ahead", async () => {
    let scopes: AutonomyScopes | null = null;
    const h = worker([null], { scopes: () => scopes });
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 1 })).resultType).toBe("denied");
    scopes = { ...ALL_SCOPES };
    expect((await h.call("click", { id: 1 })).textResultForLlm).toBe(STILL_UNANSWERED);
    expect(h.actions()).toEqual([]);
    expect(h.activity.some(e => e.type === "announce")).toBe(false);
  });
});

describe("fill_cells after the user said no to a batch (tasks-approvals-r9-1)", () => {
  it("refuses a batch that holds a cell of the one they said no to, without a question; other cells ask as before", async () => {
    const h = worker(["deny", "once"], { scopes: () => null });
    await h.call("perceive_window", {});
    expect(await h.cells("B5", "B6")).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(/^The user said no\./) });
    expect(await h.cells("B6", "B7")).toMatchObject({ resultType: "denied", textResultForLlm: REFUSED_BEFORE });
    expect(await h.cells("B5")).toMatchObject({ resultType: "denied", textResultForLlm: REFUSED_BEFORE });
    expect(h.asked).toHaveLength(1);
    expect(h.audit.filter(e => e.event === "decision").at(-1)).toMatchObject({ kind: "cursor_text", verdict: "deny", reason: "the user said no to this step earlier in this task", element: { role: "table cell", name: "B5" } });
    // One of those cells typed on its own (type_text with a cell) is the same step.
    expect(await h.inner.authorize({ taskId: "t1", kind: "cursor_text", app: "gedit", window: "notes.txt", element: { role: "table cell", name: "B6" }, value: "4", mode: "replace" })).toMatchObject({ textResultForLlm: REFUSED_BEFORE });
    expect(await h.cells("C1", "C2")).toBeNull();
    expect(h.asked).toHaveLength(2);
  });

  it("doesn't ask twice about a batch nobody answered, until the user next says something", async () => {
    const h = worker([null, "once"], { scopes: () => null });
    await h.call("perceive_window", {});
    expect(await h.cells("B5", "B6")).toMatchObject({ textResultForLlm: expect.stringMatching(/^Your question went unanswered: /) });
    expect(await h.cells("B5", "B6")).toMatchObject({ resultType: "denied", textResultForLlm: STILL_UNANSWERED });
    expect(h.asked).toHaveLength(1);
    await h.says("go on");
    expect(await h.cells("B5", "B6")).toBeNull();
    expect(h.asked).toHaveLength(2);
  });
});

const CMD_REFUSED = "The user already said no to this command in this task, or to one that does the same to the same thing, so Ember refused it without asking them again. Don't run it another way; finish the task saying what wasn't done.";
const CMD_UNANSWERED = "Ember already asked the user about this command, or one that does the same to the same thing, and the question went unanswered; they haven't said anything to this task since, so Ember didn't ask again and it didn't run. Don't run it another way; finish the task now, saying that the question went unanswered and what wasn't done.";

/**
 * The real flow and classifier on this computer, with a reviewer that finds everything routine (as Assisted's check
 * may) unless `review` is false. `answers`: each card's answer in turn; `go`: whether an announcement's countdown ends
 * without the user's Stop; `words`: the user's own words.
 */
function commands(answers: (string | null)[], o: { words?: string; go?: boolean; review?: boolean; consent?: boolean; refusals?: Refusals | null; remoteAsks?: boolean } = {}) {
  setCommandJudge(null);
  const facts = { os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/bin/bash" }, script: { path: "/usr/bin/script", kind: "util-linux" }, home: "/home/ana", user: "ana", privileged: false, pty: true, ember: { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ }, extraPath: [] };
  const st = { starts: [] as string[], asked: [] as string[], consentAsked: 0, reviewed: [] as string[], announced: [] as string[], audit: [] as Record<string, unknown>[], declined: [] as (boolean | undefined)[] };
  let consented = o.consent !== true;
  const runner = {
    target: "local", facts: async () => facts, inspect: async (p: string[]) => p.map(x => ({ exists: true, real: x })), gitFacts: async () => null, stopAll: async () => undefined, running: 0,
    start: (spec: RunSpec) => {
      st.starts.push(spec.command);
      const sentBack = o.remoteAsks && st.starts.length === 1;
      return { runId: spec.runId, interactive: true, onOutput: () => () => undefined, input() {}, typedLines: () => [], forgetTyped() {}, stop() {},
        done: Promise.resolve(sentBack ? { code: null, signal: null, ended: "refused-remote", ms: 5, needsConfirm: true, remoteSays: ["It deletes files."] } : { code: 0, signal: null, ended: "exit", ms: 5 }) };
    },
  };
  const refusals = o.refusals === null ? undefined : o.refusals ?? new Refusals();
  const ctx = {
    task: { id: "t1", title: "Task", commandWords: () => o.words ?? "clean up the project", agreed: () => [], tainted: () => false, taint() {}, readFrom: () => [] },
    service: {
      binding: { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" },
      capability: () => (consented ? { state: "on", askEvery: null } : { state: "needs-consent", askEvery: null }), shells: () => facts.shells, runner,
      consentPanel: () => ({ title: "Commands", text: "…", sha256: "x" }), consented: () => { consented = true; }, userAskEvery: () => false, mode: () => "on",
      window: { showCard() {}, hideCard() {}, cardReady: () => true, cancelAnnounce() {}, attach() {}, announce: async (card: { command: string }) => { st.announced.push(card.command); return o.go !== false; } },
    },
    confirmer: { ask: async (q: { panel: { kind: string; card?: { command: string } } }) => { if (q.panel.kind === "consent") st.consentAsked++; else st.asked.push(q.panel.card!.command); return answers.length ? answers.shift() : "once"; } },
    presenter: { announce() {}, endAnnouncement() {}, progress() {} }, audit: (e: Record<string, unknown>) => { st.audit.push(e); }, log: quiet, signal: new AbortController().signal, isOver: () => false,
    state: { cwd: "/home/ana/proj", downloaded: new Set<string>(), running: false }, size: () => ({ cols: 100, rows: 30 }), emberPids: () => [4242],
    onDeclined: (expired?: boolean) => { st.declined.push(expired); },
    ...(o.review === false ? {} : { review: async (i: { command: string }) => { st.reviewed.push(i.command); return { run: true, does: "deletes the build folder", why: "routine clean-up" }; } }),
    ...(refusals ? { refusals } : {}),
  } as unknown as CommandFlowContext;
  const run = (command: string, shell = "bash") => runCommandTool({ target: "this computer", command, shell, why: "clean" } as never, ctx) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { st, run, refusals };
}

describe("a command the user said no to, through the flow (commands-remote-r9-8)", () => {
  afterEach(() => setCommandJudge(null));

  it("isn't asked about again, reviewed, announced or run, sent again or reworded, with the reviewer on", async () => {
    // (The probe of round nine: the retry was reviewed, announced and run, and so was `find build -delete`.) The first
    // card is put up because the reviewer has no say yet: the task's words don't name the folder, and a no answers it.
    const h = commands(["deny"], { review: false });
    expect((await h.run("rm -rf build")).textResultForLlm).toMatch(/^The user said no\./);
    const again = commands([], { refusals: h.refusals });
    for (const c of ["rm -rf build", "find build -delete", "rm -rf ./build/", "rm -rf build/*"]) {
      expect(await again.run(c), c).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
    }
    expect(await again.run("rm -rf build", "sh")).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
    expect([again.st.asked, again.st.reviewed, again.st.announced, again.st.starts]).toEqual([[], [], [], []]);
    // Recorded as refused, with why: the audit keeps the rule, and "What Ember did" says it in the user's terms.
    const decided = again.st.audit.filter(e => e.phase === "decided");
    expect(decided).toHaveLength(5);
    for (const e of decided) expect(e).toMatchObject({ verdict: "refuse", classes: ["destroy"], reason: "The user said no to this command, or to one that does the same, earlier in this task." });
    expect((decided[0].rules as string[]).at(-1)).toBe("refused-before");
    expect(decided[0].command).toBeUndefined();
    expect(describeEntry({ event: "command", ...decided[0] } as never)).toMatchObject({ tag: "Refused", why: "You said no to this command, or to one that does the same, earlier in this task." });
    // Without the list (as before this change), the reviewer clears the retry and it runs after an announcement.
    const before = commands([], { refusals: null });
    expect((await before.run("rm -rf build")).resultType).toBe("success");
    expect([before.st.reviewed, before.st.announced, before.st.starts]).toEqual([["rm -rf build"], ["rm -rf build"], ["rm -rf build"]]);
  });

  it("puts the card up once: a second and a third try are refused, and another deletion still asks", async () => {
    const h = commands(["deny", "deny"], { review: false });
    await h.run("rm -rf build");
    expect((await h.run("rm -rf build")).textResultForLlm).toBe(CMD_REFUSED);
    expect((await h.run("rm -rf build")).textResultForLlm).toBe(CMD_REFUSED);
    expect(h.st.asked).toEqual(["rm -rf build"]);
    expect((await h.run("rm -rf dist")).textResultForLlm).toMatch(/^The user said no\./);
    expect(h.st.asked).toEqual(["rm -rf build", "rm -rf dist"]);
    // Only the user's own no counts as one for the task (onDeclined): a refused repeat isn't a new no.
    expect(h.st.declined).toEqual([false, false]);
    expect(h.st.starts).toEqual([]);
  });

  it("takes a Stop during the countdown for a no: the command isn't announced again", async () => {
    const h = commands([], { words: "delete the build folder", go: false, review: false });
    expect((await h.run("rm -rf build")).textResultForLlm).toMatch(/^The user stopped it before it ran\./);
    expect(h.st.announced).toEqual(["rm -rf build"]);
    expect((await h.run("rm -rf build")).textResultForLlm).toBe(CMD_REFUSED);
    expect((await h.run("find build -delete")).textResultForLlm).toBe(CMD_REFUSED);
    expect([h.st.announced, h.st.asked, h.st.starts]).toEqual([["rm -rf build"], [], []]);
  });

  it("doesn't put up twice a card nobody answered, until the user next says something to the task", async () => {
    const h = commands([null, "once"], { review: false });
    expect((await h.run("rm -rf build")).textResultForLlm).toMatch(/^Your question went unanswered: /);
    expect(await h.run("find build -delete")).toMatchObject({ resultType: "denied", textResultForLlm: CMD_UNANSWERED });
    expect(h.st.asked).toEqual(["rm -rf build"]);
    expect(h.st.audit.filter(e => e.phase === "decided").at(-1)).toMatchObject({ verdict: "refuse", reason: "The question about this command, or one that does the same, went unanswered, and the user hasn't said anything to this task since." });
    h.refusals!.userSpoke();
    expect((await h.run("rm -rf build")).resultType).toBe("success");
    expect([h.st.asked, h.st.starts]).toEqual([["rm -rf build", "rm -rf build"], ["rm -rf build"]]);
  });

  it("keeps the no to another computer's own check (gate 2) the same way", async () => {
    const h = commands(["once", "deny"], { review: false, remoteAsks: true });
    expect((await h.run("rm -rf build")).textResultForLlm).toMatch(/^The user said no\./);
    expect(h.st.asked).toEqual(["rm -rf build", "rm -rf build"]);
    expect((await h.run("rm -rf build")).textResultForLlm).toBe(CMD_REFUSED);
    expect(h.st.asked).toHaveLength(2);
    expect(h.st.starts).toHaveLength(1);
  });

  it("doesn't put the first-use commands card up again in a task where the user said no to it", async () => {
    const h = commands(["deny"], { consent: true });
    expect((await h.run("ls")).textResultForLlm).toBe("The user didn't turn on commands on this computer. Finish the task saying so.");
    expect((await h.run("ls -la")).textResultForLlm).toBe("The user already said no to turning on commands on this computer in this task, so Ember didn't ask again. Finish the task saying so.");
    expect(h.st.consentAsked).toBe(1);
    expect(h.st.audit.at(-1)).toMatchObject({ phase: "decided", verdict: "refuse", rules: ["refused-before"] });
    expect(h.st.starts).toEqual([]);
  });

  it("leaves Ember's own refusals to say why themselves", async () => {
    const h = commands(["deny"], { review: false });
    await h.run("rm -rf /home/ana/.config");
    const r = await h.run("rm -rf /home/ana/.config/ember");
    expect(r.textResultForLlm).toMatch(/^Not allowed: /);
    expect(r.textResultForLlm).not.toBe(CMD_REFUSED);
  });
});

describe("the worker and its commands share one list (tasks-approvals-r9-1, commands-remote-r9-8)", () => {
  it("hands the flow the task's own refusals, which a word from the user clears of what went unanswered", async () => {
    const h = worker([]);
    const ctx = h.inner.commandContext();
    expect(ctx.refusals).toBeInstanceOf(Refusals);
    ctx.refusals!.noteCommand(asked("git push origin main"), "waiting");
    ctx.refusals!.noteCommand(asked("rm -rf build"), "refused");
    await h.says("push it");
    expect([h.inner.commandContext().refusals!.command(asked("git push origin main")), ctx.refusals!.command(asked("find build -delete"))]).toEqual([null, "refused"]);
  });
});
