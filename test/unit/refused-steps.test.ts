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
import { ALL_SCOPES, BELOW_INTERACTIVE_HINT, belowInteractiveForCard, type AutonomyScopes } from "../../app/main/policy/autonomy";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { AdminPolicySchema } from "../../app/main/admin";
import { modeCardVersion } from "../../app/shared/approvals";
import { readFileSync } from "node:fs";
import { Refusals, commandActs, commandNamed, likeCommand, riskNames, sameCommand, stepMarksForCommands, stepNames, type CommandAsked } from "../../app/main/policy/refusals";
import { Worker, leftUndone, type WorkerDeps } from "../../app/main/agent/worker";
import { LIKE_REFUSED_LINE, LIKE_REFUSED_RULE, commandSha256, runCommandTool, setCommandJudge, type CommandFlowContext } from "../../app/main/commands/flow";
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
  const stand = standingFindings(cls.findings, undefined);
  return { sha256: commandSha256("local", shell, ctx.cwd, command), cwd: ctx.cwd, command, acts: commandActs(stand, ctx.os), named: commandNamed(stand, cls.commands), os: ctx.os, home: ctx.home };
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
    ["git push origin main", "git push origin +main", true],
    ["git push origin main", "git push origin HEAD:main", true],
    ["git push origin", "git push origin main", true],
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
    // The same kind of thing to something else is something else (modes-y9-8): another branch, another unknown
    // program, another command of a tool, another loop.
    ["git push origin main", "git push origin feature", false],
    ["git push origin main", "git push upstream main", false],
    ["frobnicate build", "othertool --version", false],
    ["frobnicate build", "kafka-topics --list", false],
    ["cargo frob", "cargo zork", false],
    ["for f in *.log; do rm $f; done", "for d in a b; do echo $d; done", false],
    // The refused thing, however the later command names it (modes-y9-9): a move's source, inline code's quoted path,
    // the branch in an API path.
    ["rm -rf build", "mv build /tmp/x", true],
    ["rm -rf build", "mv ./build/ ~/.Trash/", true],
    ["rm -rf build", "python3 -c 'import shutil; shutil.rmtree(\"build\")'", true],
    ["rm -rf build", "node -e 'require(\"fs\").rmSync(\"build\",{recursive:true})'", true],
    ["rm -rf build", "perl -e 'unlink glob \"/home/ana/proj/build/*\"'", true],
    ["git push --force origin main", "gh api -X PUT repos/o/r/git/refs/heads/main -f sha=abc -F force=true", true],
    ["rm -rf build", "mv dist /tmp/x", false],
    ["rm -rf build", "python3 -c 'print(open(\"build/log.txt\").read())'", false],
    ["rm -rf build", "python3 -c 'import shutil; shutil.rmtree(\"dist\")'", false],
    ["git push --force origin main", "gh api -X PUT repos/o/r/git/refs/heads/feature -f sha=abc", false],
    // A push of "whatever is checked out" names no branch Ember can compare: it is a push to that remote, as a bare
    // `git push origin` is (modes-y9-x9-1).
    ["git push origin main", "git push origin HEAD", true],
    ["git push origin main", "git push -u origin HEAD", true],
    ["git push origin main", "git push origin @", true],
    ["git push origin main", "git push origin HEAD~0", true],
    ["git push origin main", "git push origin 'main@{0}'", true],
    ["git push --force origin main", "git push --force origin HEAD", true],
    ["git push origin HEAD", "git push origin main", true],
    ["git push origin main", "git push upstream HEAD", false],
    ["git push origin main", "git push origin HEAD:feature", false],
  ];
  for (const [refused, next, is] of table) {
    it(`${is ? "takes" : "doesn't take"} \`${next}\` for a refused \`${refused}\``, () => {
      expect(sameCommand(asked(refused), asked(next))).toBe(is);
    });
  }

  it.each<[string, string]>([
    ["rm -rf build", "python3 -c 'print(open(\"build/log.txt\").read())'"], ["rm -rf build", "for f in *.o; do rm $f; done"], ["rm -rf build", "git clean -fdx"],
    ["git push origin main", "npm publish"], ["git push --force origin main", "gh api -X PUT repos/o/r/git/refs/heads/feature -f sha=abc"], ["rm -rf build", "frobnicate --all"],
  ])("takes `%s` then `%s` for one that may be the refused command, which Ember can't tell: it asks (modes-y9-9)", (refused, next) => {
    expect(sameCommand(asked(refused), asked(next))).toBe(false);
    expect(likeCommand(asked(refused), asked(next))).toBe(true);
  });

  it.each<[string, string]>([
    ["rm -rf build", "rm -rf dist"], ["rm -rf build", "git push origin main"], ["git push origin main", "git push origin feature"], ["rm -rf build", "ls -la"], ["ls", "for f in *.o; do rm $f; done"],
  ])("doesn't take `%s` then `%s` for one: it names what it acts on, and that is something else (modes-y9-8)", (refused, next) => {
    expect(likeCommand(asked(refused), asked(next))).toBe(false);
  });

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
function worker(answers: (string | null)[], o: { scopes?: () => AutonomyScopes | null; autopilot?: () => boolean; hint?: () => string | null } = {}) {
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
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: scopes, ...(o.autopilot ? { autopilot: o.autopilot } : {}) }),
    autonomy: scopes,
    ...(o.hint ? { belowInteractiveHint: o.hint } : {}),
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

describe("the refused step done another way: what it does, not only the control (modes-x9s-3)", () => {
  const mail = { taskId: "t1", app: "thunderbird", window: "Write: Q3 report - Thunderbird" };
  const send = { ...mail, kind: "click", element: { role: "push button", name: "Send" } };
  const shortcut = { ...mail, kind: "keys", value: "ctrl+Return", element: { role: "text", name: "Message body" } };
  const menu = { ...mail, kind: "click", element: { role: "menu item", name: "Send Now" } };
  const later = { ...mail, window: "Write: Q3 report (2) - Thunderbird", kind: "click", element: { role: "push button", name: "Send" } };

  it("refuses the shortcut, the menu item and a second compose window's Send without a question, after a no to Send", async () => {
    const h = worker(["deny", "once", "once", "once"]);
    expect(await h.inner.authorize(send)).toMatchObject({ resultType: "denied", textResultForLlm: expect.stringMatching(/^The user said no\./) });
    for (const again of [shortcut, menu, later]) expect(await h.inner.authorize(again), again.element.name).toMatchObject({ resultType: "denied", textResultForLlm: REFUSED_BEFORE });
    expect(h.asked).toHaveLength(1);
  });

  it("refuses it so in Autopilot too, after a switch mid-task: never announced, never done", async () => {
    let auto = false;
    const h = worker(["deny"], { autopilot: () => auto });
    expect((await h.inner.authorize(send))?.resultType).toBe("denied");
    auto = true;
    for (const again of [send, shortcut, menu, later]) expect(await h.inner.authorize(again), again.element.name).toMatchObject({ resultType: "denied", textResultForLlm: REFUSED_BEFORE });
    expect(h.activity.some(e => e.type === "announce")).toBe(false);
    expect(h.audit.some(e => e.mode === "autopilot")).toBe(false);
  });

  it("takes a deletion done with a key, or reworded, for the refused deletion; another kind of risky step still asks", async () => {
    const h = worker(["deny", "once"]);
    const files = { taskId: "t1", app: "nautilus", window: "Documents" };
    expect((await h.inner.authorize({ ...files, kind: "click", element: { role: "menu item", name: "Move to Trash" } }))?.resultType).toBe("denied");
    expect(await h.inner.authorize({ ...files, kind: "click", element: { role: "push button", name: "Delete permanently" } })).toMatchObject({ textResultForLlm: REFUSED_BEFORE });
    expect(await h.inner.authorize({ ...files, kind: "click", element: { role: "menu item", name: "Remove" } })).toMatchObject({ textResultForLlm: REFUSED_BEFORE });
    // Sending is another thing: asked, as in any task the user said no in.
    expect(await h.inner.authorize({ ...files, kind: "click", element: { role: "menu item", name: "Send to…" } })).toBeNull();
    expect(h.asked).toHaveLength(2);
  });

  it("names a risky step by what it does; one whose words name no kind is no other step (evalfix-1)", () => {
    const named = (name: string) => riskNames({ name, about: name, reason: "this action may be hard to undo or visible to others" });
    const shortcut = riskNames({ name: "Message body", about: "", reason: "this shortcut can delete, send or close things" });
    const r = new Refusals();
    r.noteStep(named("Send"), "refused");
    expect(r.step(shortcut)).toBe("refused");
    expect(r.step(named("Send Now"))).toBe("refused");
    expect(r.step(named("Delete"))).toBeNull();
    // The same in another language policy reads: "Absenden" sends, and after a no to it so does Ctrl+Enter.
    expect(r.step(named("Absenden"))).toBe("refused");
    const de = new Refusals();
    de.noteStep(named("Absenden"), "refused");
    expect(de.step(shortcut)).toBe("refused");
    expect(de.step(named("Delete"))).toBeNull();
    // A label Ember can't put a kind to has none: it is refused again only as itself (stepNames), and refuses nothing else.
    expect(named("Add comment")).toEqual([]);
    // A borrow that is risky only because it takes the mouse and keyboard does nothing of these kinds.
    expect(riskNames({ name: "Bold", about: "", reason: "Ember needs your mouse or keyboard for this" })).toEqual([]);
    // Unanswered: until the user next says something, as for one step.
    const w = new Refusals();
    w.noteStep(named("Pay now"), "waiting");
    expect(w.step(named("Place order"))).toBe("waiting");
    w.userSpoke();
    expect(w.step(named("Place order"))).toBeNull();
  });
});

describe("below Interactive after the update: why Ember asks, said once (modes-x9p-3)", () => {
  it("adds to the first question Interactive would have announced how to stop such questions, once a run, and to no risky one", async () => {
    let told = false;
    const hint = () => { if (told) return null; told = true; return BELOW_INTERACTIVE_HINT; };
    const h = worker(["once", "once", "once"], { scopes: () => null, hint });
    await h.call("perceive_window", {});
    await h.call("click", { id: 1 });
    await h.call("click", { id: 3 });
    expect(h.asked[0]).toBe(`Let me work in gedit? First step: click the “Bold” button. ${BELOW_INTERACTIVE_HINT}`);
    expect(h.asked[1]).not.toContain(BELOW_INTERACTIVE_HINT);
    // A risky step (Delete) isn't what Interactive changes: no hint there, and it isn't spent on it.
    let spent = false;
    const r = worker(["once", "once"], { scopes: () => null, hint: () => { spent = true; return BELOW_INTERACTIVE_HINT; } });
    await r.call("perceive_window", {});
    await r.inner.authorize({ taskId: "t1", kind: "click", app: "gedit", window: "notes.txt", element: { role: "push button", name: "Delete" } });
    expect(r.asked[0]).not.toContain(BELOW_INTERACTIVE_HINT);
    expect(spent).toBe(false);
  });

  it("is given only below Interactive for want of its card, never where the organisation keeps Ember there", () => {
    const own = DEFAULT_SETTINGS.approvals;
    expect(belowInteractiveForCard(own, null)).toBe(true);
    expect(belowInteractiveForCard({ ...own, consent: { ...own.consent, interactive: { version: modeCardVersion("interactive"), at: "t" } } }, null)).toBe(false);
    expect(belowInteractiveForCard(own, AdminPolicySchema.parse({ features: { autonomy: false } }))).toBe(false);
    expect(BELOW_INTERACTIVE_HINT).toBe("(I ask before ordinary steps like this until you agree to Interactive in Settings, under Apps & privacy. Then I tell you about them as I go instead.)");
    expect(readFileSync("app/main/agent/host.ts", "utf8")).toContain("belowInteractiveHint: () => this.belowInteractiveHint(),");
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
function commands(answers: (string | null)[], o: { words?: string; go?: boolean; review?: boolean; consent?: boolean; refusals?: Refusals | null; remoteAsks?: boolean; autopilot?: boolean } = {}) {
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
    ...(o.autopilot ? { autopilot: () => true } : {}),
  } as unknown as CommandFlowContext;
  const run = (command: string, shell = "bash") => runCommandTool({ target: "this computer", command, shell, why: "clean" } as never, ctx) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { st, run, refusals, ctx };
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

  it("refuses the refused deletion or push however the later command names it: a move, inline code, an API path (modes-y9-9)", async () => {
    for (const mode of [{ review: true }, { review: false, autopilot: true }]) {
      const h = commands(["deny"], { review: false });
      expect((await h.run("rm -rf build")).textResultForLlm).toMatch(/^The user said no\./);
      const again = commands([], { refusals: h.refusals, ...mode });
      for (const c of ["mv build /tmp/x", "python3 -c 'import shutil; shutil.rmtree(\"build\")'", "node -e 'require(\"fs\").rmSync(\"build\",{recursive:true})'"]) {
        expect(await again.run(c), c).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
      }
      expect([again.st.asked, again.st.reviewed, again.st.announced, again.st.starts]).toEqual([[], [], [], []]);
    }
    const push = commands(["deny"], { review: false, words: "update main on github" });
    expect((await push.run("git push --force origin main")).textResultForLlm).toMatch(/^The user said no\./);
    for (const mode of [{ review: true }, { review: false, autopilot: true }]) {
      const again = commands([], { refusals: push.refusals, words: "update main on github", ...mode });
      expect(await again.run("gh api -X PUT repos/o/r/git/refs/heads/main -f sha=abc -F force=true")).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
      expect([again.st.asked, again.st.reviewed, again.st.announced, again.st.starts]).toEqual([[], [], [], []]);
    }
  });

  it("refuses a refused push of main sent again as a push of HEAD or @, with no check and no announcement (modes-y9-x9-1)", async () => {
    for (const first of ["git push origin main", "git push --force origin main"]) {
      const h = commands(["deny"], { review: false, words: "update main on github" });
      expect((await h.run(first)).textResultForLlm).toMatch(/^The user said no\./);
      for (const mode of [{ review: true }, { review: false, autopilot: true }, { review: false }]) {
        const again = commands([], { refusals: h.refusals, words: "update main on github", ...mode });
        for (const c of [first.replace("main", "HEAD"), first.replace("main", "@"), first.replace("origin main", "-u origin HEAD")]) {
          expect(await again.run(c), c).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
        }
        expect([again.st.asked, again.st.reviewed, again.st.announced, again.st.starts]).toEqual([[], [], [], []]);
      }
    }
  });

  it("refuses a refused push of main sent again to a remote written as a URL or a path, in either order (modes-y9-y9-1)", async () => {
    const urls = ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "../mirror.git", "."];
    for (const [first, later] of urls.flatMap(u => [["git push origin main", `git push ${u} main`], [`git push ${u} main`, "git push origin main"], ["git push origin main", `git push ${u} HEAD`]])) {
      const h = commands(["deny"], { review: false, words: "update main on github" });
      expect((await h.run(first)).textResultForLlm, first).toMatch(/^The user said no\./);
      for (const mode of [{ review: true }, { review: false, autopilot: true }, { review: false }]) {
        const again = commands([], { refusals: h.refusals, words: "update main on github", ...mode });
        expect(await again.run(later), `${first} => ${later}`).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
        expect([again.st.asked, again.st.reviewed, again.st.announced, again.st.starts]).toEqual([[], [], [], []]);
      }
    }
    // Two remotes Ember knows by name are two places, as before (modes-y9-8).
    const h = commands(["deny"], { review: false, words: "" });
    await h.run("git push origin main");
    const auto = commands([], { refusals: h.refusals, autopilot: true, review: false, words: "" });
    expect((await auto.run("git push backup main")).resultType).toBe("success");
    expect(auto.st.announced).toEqual(["git push backup main"]);
  });

  it("refuses `rm -rf build` after a no to that deletion written as inline code or for a program Ember doesn't know (modes-y9-y9-2)", async () => {
    for (const first of ["python3 -c \"import shutil; shutil.rmtree('build')\"", "node -e \"require('fs').rmSync('build',{recursive:true})\"", "frob --delete build"]) {
      const h = commands(["deny"], { review: false });
      expect((await h.run(first)).textResultForLlm, first).toMatch(/^The user said no\./);
      for (const mode of [{ review: true }, { review: false, autopilot: true }, { review: false }]) {
        const again = commands([], { refusals: h.refusals, ...mode });
        for (const c of ["rm -rf build", "find build -delete", "rm -rf ./build/out"]) expect(await again.run(c), `${first} => ${c}`).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
        expect([again.st.asked, again.st.reviewed, again.st.announced, again.st.starts]).toEqual([[], [], [], []]);
      }
    }
  });

  it.each<[string, string]>([
    // A loop's deletion names what it deletes only by a variable: any later deletion may be it.
    ["for d in build dist; do rm -rf $d; done", "rm -rf build"],
    // Code that names the folder without saying what it does to it.
    ["python3 -c \"import helper; helper.tidy('build')\"", "rm -rf build"],
    // Two pieces of code Ember can't read.
    ["python3 -c \"import shutil; shutil.rmtree('build')\"", "perl -e 'system(\"rm -rf build\")'"],
  ])("asks, without a check or an announcement, where it can't tell: after a no to `%s`, `%s` (modes-y9-y9-2)", async (refused, next) => {
    const h = commands(["deny"], { review: false });
    expect((await h.run(refused)).textResultForLlm).toMatch(/^The user said no\./);
    for (const mode of [{ review: true }, { review: false, autopilot: true }, { review: false }]) {
      const again = commands(["once"], { refusals: h.refusals, ...mode });
      expect((await again.run(next)).resultType, next).toBe("success");
      expect([again.st.asked, again.st.reviewed, again.st.announced], next).toEqual([[next], [], []]);
      expect(again.st.audit.find(e => e.phase === "decided")!.rules as string[]).toContain(LIKE_REFUSED_RULE);
    }
  });

  it("leaves a deletion of something else as it was after a no to code Ember can't read (modes-y9-y9-2)", async () => {
    const h = commands(["deny"], { review: false });
    await h.run("python3 -c \"import shutil; shutil.rmtree('build')\"");
    const auto = commands([], { refusals: h.refusals, autopilot: true, review: false });
    expect((await auto.run("rm -rf dist")).resultType).toBe("success");
    expect([auto.st.asked, auto.st.announced]).toEqual([[], ["rm -rf dist"]]);
  });

  it.each<[string, string]>([
    ["rm -rf build", "for f in *.o; do rm $f; done"], ["rm -rf build", "python3 -c 'print(open(\"build/log.txt\").read())'"], ["rm -rf build", "git clean -fdx"], ["git push origin main", "npm publish"],
    ["git push --force origin main", "gh api -X PUT repos/o/r/git/refs/heads/feature -f sha=abc"],
  ])("asks about a command that may be the refused one, which Ember can't tell: after a no to `%s`, `%s` is never reviewed or announced (modes-y9-9)", async (refused, next) => {
    const h = commands(["deny"], { review: false });
    expect((await h.run(refused)).textResultForLlm).toMatch(/^The user said no\./);
    for (const mode of [{ review: true }, { review: false, autopilot: true }, { review: false }]) {
      const again = commands(["once"], { refusals: h.refusals, words: "clean up and publish the package", ...mode });
      expect((await again.run(next)).resultType, next).toBe("success");
      expect([again.st.asked, again.st.reviewed, again.st.announced], next).toEqual([[next], [], []]);
      const decided = again.st.audit.find(e => e.phase === "decided")!;
      expect(decided).toMatchObject({ verdict: "ask" });
      expect(decided.rules as string[]).toContain(LIKE_REFUSED_RULE);
    }
  });

  it("says on such a card that the user said no to something like it", async () => {
    setCommandJudge(null);
    const h = commands(["deny"], { review: false });
    await h.run("rm -rf build");
    const cards: string[][] = [];
    const again = commands([], { refusals: h.refusals, autopilot: true, review: false });
    (again.ctx.confirmer as unknown as { ask: unknown }).ask = (async (q: { panel: { card: { says: string[] } } }) => { cards.push(q.panel.card.says); return "deny"; }) as never;
    await again.run("git clean -fdx");
    expect(cards[0][0]).toBe(LIKE_REFUSED_LINE);
  });

  it("leaves the same kind of thing done to something else as it was: another branch is announced in Autopilot, another unknown program asks (modes-y9-8)", async () => {
    const push = commands(["deny"], { review: false, words: "" });
    expect((await push.run("git push origin main")).textResultForLlm).toMatch(/^The user said no\./);
    const auto = commands([], { refusals: push.refusals, autopilot: true, review: false, words: "" });
    expect((await auto.run("git push origin feature")).resultType).toBe("success");
    expect([auto.st.asked, auto.st.announced]).toEqual([[], ["git push origin feature"]]);
    for (const [refused, next] of [["frobnicate build", "othertool --version"], ["cargo frob", "cargo zork"]]) {
      const h = commands(["deny"], { review: false });
      expect((await h.run(refused)).textResultForLlm).toMatch(/^The user said no\./);
      const again = commands(["once"], { refusals: h.refusals, review: false });
      expect((await again.run(next)).resultType, next).toBe("success");
      expect(again.st.asked, next).toEqual([next]);
    }
  });

  it("asks about a deletion by command after a no to a deletion in an app, and refuses the one that names what was refused there (modes-y9-2)", async () => {
    const refusals = new Refusals();
    refusals.noteStep(stepMarksForCommands(["delete"], "Delete permanently Delete “report.pdf” permanently? Home - Files"), "refused");
    for (const mode of [{ review: true }, { review: false, autopilot: true }]) {
      const h = commands(["once"], { refusals, ...mode });
      expect(await h.run("rm ~/report.pdf")).toMatchObject({ resultType: "denied", textResultForLlm: CMD_REFUSED });
      expect((await h.run("rm -rf build")).resultType).toBe("success");
      expect([h.st.asked, h.st.reviewed, h.st.announced]).toEqual([["rm -rf build"], [], []]);
    }
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
