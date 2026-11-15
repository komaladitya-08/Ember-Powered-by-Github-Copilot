/**
 * What counts as the refused thing done another way (CLAUDE.md "After a deny or “Not now”, Ember never retries or works
 * around it"): the same danger to the same thing, never the same kind of thing anywhere. The second review of the
 * approval modes found the rule too narrow on one side (a deletion reworded as "Clear", a refused command done in an
 * app, a step of no kind done with a key: modes-y9-2, evalfix-x9-2, evalfix-x9-3) and too wide on the other (a no to
 * Ctrl+W refusing a later Send, "Postpone" counted as sending, a kind refused in one app refused in every other, a no
 * to a page's step refusing the user's own: modes-y9-8, evalfix-x9-1). The journeys run at the worker with a real
 * PolicyEngine, in Interactive, in Assisted and in Autopilot switched on after the no.
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { Refusals, commandActs, commandNamed, noKindName, offTaskLookup, offTaskNames, riskKinds, riskNames, stepAcrossNames, stepMarksForCommands, type CommandAsked } from "../../app/main/policy/refusals";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import { commandSha256 } from "../../app/main/commands/flow";
import { classifyCommand } from "../../app/main/commands/classify";
import { standingFindings, type ClassifyContext } from "../../app/main/commands/types";
import { Presenter } from "../../app/main/agent/presenter";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const REFUSED_BEFORE = /^The user already said no to this step in this task/;
type Mode = "interactive" | "assisted" | "autopilot";
type Step = Record<string, unknown>;

/** A worker on one window, with a real PolicyEngine. The first question is answered "Not now", every later one "Allow"; Assisted's check finds no match first, then a match. */
function mk(mode: Mode, userWords: string, app: string, win: string) {
  const asked: string[] = [], activity: Record<string, unknown>[] = [], checked: string[] = [];
  let auto = false;
  const window = { app, pid: 1, name: win, role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const seen = { window, x11Window: null, nodes: [], blocked: false, ms: 0 };
  const scopes = () => ({ ...ALL_SCOPES });
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "<screen>", capture: null }), read: async () => seen, windows: async () => [window], systemDialogOpen: async () => false } as never,
    sidecar: { readElement: async () => null, doAction: async () => ({ ok: true }) } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: scopes, autopilot: () => auto, ...(mode === "assisted" ? { trustAskedApps: () => true, assisted: () => true } : {}) }),
    autonomy: scopes,
    ...(mode === "assisted" ? { check: () => true, checkStep: async (i: { step: string }) => { checked.push(i.step); return checked.length === 1 ? "no-match" : "match"; } } : {}),
    confirmer: { ask: async (q: { prompt: string }) => { asked.push(q.prompt); return asked.length === 1 ? "deny" : "once"; } } as never,
    audit: { write: () => undefined } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    onActivity: (e: Record<string, unknown>) => { activity.push(e); },
    cursor: { borrow: { borrow: async () => undefined } as never, findWindow: () => 1, setBorrowing: () => undefined },
  } as unknown as WorkerDeps, { id: "t1", goal: userWords, userWords, target: { title: win } });
  const inner = w as unknown as { authorize(req: Step): Promise<{ textResultForLlm: string; resultType: string } | null>; refusals: Refusals };
  return { asked, activity, checked, inner, autopilotOn: () => { auto = true; } };
}

const btn = (name: string, role = "push button"): Step => ({ kind: "click", element: { role, name } });
const keys = (value: string, name: string, role = "text"): Step => ({ kind: "keys", value, element: { role, name } });

/**
 * The first step is refused by the user, then the next comes: "refused" (without a question, a check or an
 * announcement), "asked" (the question is put, with no check before it), "checked" (Assisted's check cleared it) or
 * "allowed" (Autopilot lets it go ahead: it is announced once the look right before acting has passed).
 */
async function journey(mode: Mode, j: { words: string; app: string; win: string; first: Step; next: Step; nextApp?: string; nextWin?: string }) {
  const h = mk(mode, j.words, j.app, j.win);
  const first = await h.inner.authorize({ taskId: "t1", app: j.app, window: j.win, ...j.first });
  expect(first?.resultType, "the first step is refused by the user").toBe("denied");
  expect(h.asked, "the first step asks").toHaveLength(1);
  if (mode === "autopilot") h.autopilotOn();
  const checks = h.checked.length;
  const next = await h.inner.authorize({ taskId: "t1", app: j.nextApp ?? j.app, window: j.nextWin ?? j.win, ...j.next });
  if (next !== null) return REFUSED_BEFORE.test(next.textResultForLlm) ? "refused" : `denied: ${next.textResultForLlm.slice(0, 60)}`;
  if (h.activity.some(e => e.type === "announce")) return "announced";
  if (h.asked.length > 1) return h.checked.length > checks ? "asked after a check" : "asked";
  return h.checked.length > checks ? "checked" : "allowed";
}
const MODES: Mode[] = ["interactive", "assisted", "autopilot"];
/** What a step that isn't the refused one does in each mode, in a task the user said no in. */
const OTHER: Record<Mode, string[]> = { interactive: ["asked"], assisted: ["checked", "asked after a check"], autopilot: ["announced", "allowed"] };
/** What a step that may be the refused thing does: it asks, never checked or announced; Autopilot, with no question to put for an app step, refuses it. */
const MAY_BE: Record<Mode, string> = { interactive: "asked", assisted: "asked", autopilot: "refused" };

describe("a no to a step the user didn't ask for is no word on their own request (evalfix-x9-1)", () => {
  const pairs = [
    { label: "a page's “Share report”, then the user's own “Post comment”", words: "Post the comment Looks good on the quarterly report", app: "firefox", win: "Quarterly report - Mozilla Firefox", first: btn("Share report"), next: btn("Post comment") },
    { label: "a page's “Upload files”, then the user's own “Submit”", words: "Fill in the survey and submit it", app: "firefox", win: "Survey - Mozilla Firefox", first: btn("Upload files"), next: btn("Submit") },
    { label: "“Invite contacts”, then the user's own “Reply”", words: "Reply to Ana saying thanks", app: "thunderbird", win: "Inbox - Thunderbird", first: btn("Invite contacts"), next: btn("Reply") },
  ];
  for (const j of pairs) for (const mode of MODES) {
    it(`${j.label}: in ${mode} it ${mode === "autopilot" ? "is refused, with no question to put" : "asks, and a yes does it"}; never checked or announced (modes-y9-y9-3)`, async () => expect(await journey(mode, j)).toBe(MAY_BE[mode]));
  }

  it("still refuses what isn't the user's words either: the page's next step of that kind, and the key that does it", async () => {
    for (const mode of MODES) {
      const page = { words: "Post the comment Looks good on the quarterly report", app: "firefox", win: "Quarterly report - Mozilla Firefox", first: btn("Share report") };
      expect(await journey(mode, { ...page, next: btn("Share with everyone") }), mode).toBe("refused");
      expect(await journey(mode, { ...page, next: keys("ctrl+Return", "Message") }), mode).toBe("refused");
    }
  });

  it("keeps a step the user didn't ask for under names of its own, read only for a later step that isn't theirs either", () => {
    const share = { name: "Share report", about: "Share report", reason: "this action may be hard to undo or visible to others; not something the user asked for", app: "firefox" };
    const post = { name: "Post comment", about: "Post comment", reason: "this action may be hard to undo or visible to others", app: "firefox" };
    const r = new Refusals();
    r.noteStep(offTaskNames(share), "refused");
    expect(r.step([...riskNames(post), ...offTaskLookup(post, false)])).toBeNull();
    expect(r.step([...riskNames(post), ...offTaskLookup(post, true)])).toBe("refused");
    const enter = { name: "Message", about: "", reason: "Enter in a text field can send or submit what is in it", app: "firefox" };
    expect(r.step([...riskNames(enter), ...offTaskLookup(enter, false)])).toBe("refused");
  });
});

describe("a deletion reworded as emptying or clearing is the refused deletion (evalfix-x9-2)", () => {
  const pairs = [
    { label: "“Delete history”, then “Clear history”", words: "tidy up my browser", app: "firefox", win: "History - Mozilla Firefox", first: btn("Delete history"), next: btn("Clear history") },
    { label: "“Delete all”, then “Empty Junk”", words: "tidy up the junk folder", app: "thunderbird", win: "Junk - Thunderbird", first: btn("Delete all"), next: btn("Empty Junk") },
    { label: "“Publish”, then “Deploy”", words: "check the site", app: "firefox", win: "Site - Mozilla Firefox", first: btn("Publish"), next: btn("Deploy") },
  ];
  for (const j of pairs) for (const mode of MODES) {
    it(`${j.label}: refused without a question in ${mode}`, async () => expect(await journey(mode, j)).toBe("refused"));
  }

  it("reads emptying and clearing as deleting in the languages policy lists them in", () => {
    const kinds = (name: string) => riskKinds({ name, about: name, reason: "this action may be hard to undo or visible to others" }).said;
    for (const name of ["Empty Trash", "Clear all", "Clear history", "Papierkorb leeren", "Vider la corbeille", "Vaciar papelera", "Svuota cestino", "Esvaziar lixeira", "Opróżnij kosz", "Очистить корзину", "Tøm papirkurven",
      "Tyhjennä roskakori", "清空回收站", "ゴミ箱を空にする", "휴지통 비우기"]) expect(kinds(name), name).toContain("delete");
  });
});

describe("a risky step of no kind done another way is never checked or announced (evalfix-x9-3)", () => {
  const j = { words: "review the document", app: "firefox", win: "Doc - Mozilla Firefox", first: btn("Add comment"), next: keys("ctrl+Return", "Comment") };
  it("asks in Interactive, asks without a check in Assisted, and is refused in Autopilot, which has no question to put", async () => {
    expect(await journey("interactive", j)).toBe("asked");
    expect(await journey("assisted", j)).toBe("asked");
    expect(await journey("autopilot", j)).toBe("refused");
  });
  it("leaves a step that names its own kind as it was: after a no to “Add comment”, a “Delete all” is another thing", async () => {
    for (const mode of MODES) expect(OTHER[mode], mode).toContain(await journey(mode, { ...j, next: btn("Delete all") }));
  });
  it("is bound to its app: a step of no kind in another app is another thing", async () => {
    for (const mode of MODES) expect(OTHER[mode], mode).toContain(await journey(mode, { ...j, next: btn("Confirm"), nextApp: "gedit", nextWin: "notes.txt" }));
    expect(noKindName("Firefox")).toBe(noKindName("firefox"));
    expect(noKindName("firefox")).not.toBe(noKindName("gedit"));
  });
});

describe("what a risky step does is one thing, in one app (modes-y9-8)", () => {
  const named = (name: string, reason = "this choice may be hard to undo or visible to others") => riskKinds({ name, about: name, reason }).said;

  it("never takes a word that only begins like one for the act", () => {
    for (const name of ["Postpone", "Shared drive", "Order by date", "Blockquote", "Exit full screen", "Posterize", "Formatting", "Closed captions", "Sender", "Updated today"]) expect(named(name), name).toEqual([]);
    // The acts themselves, in the forms a control names them.
    expect(named("Send")).toEqual(["send"]);
    expect(named("Sending…")).toEqual(["send"]);
    expect(named("Post reply")).toEqual(["send"]);
    expect(named("Removes 3 files")).toEqual(["delete"]);
    expect(named("Place order")).toEqual(["pay"]);
    expect(named("Exit")).toEqual(["close"]);
    expect(named("Block user")).toEqual(["block"]);
  });

  it("reads a shortcut that can delete, send or close by its key, so a no to closing a window is no word on a later Send", async () => {
    const reason = "this shortcut can delete, send or close things";
    const of = (k?: string) => riskKinds({ name: "Message body", about: "", reason, ...(k !== undefined ? { keys: k } : {}) }).why;
    expect(of("ctrl+w")).toEqual(["close"]);
    expect(of("alt+F4")).toEqual(["close"]);
    expect(of("Delete")).toEqual(["delete"]);
    expect(of("shift+Delete")).toEqual(["delete"]);
    expect(of("cmd+BackSpace")).toEqual(["delete"]);
    expect(of("ctrl+Return")).toEqual(["send"]);
    // A key it can't place, or none given: all three, as before.
    expect(of("ctrl+shift+k").sort()).toEqual(["close", "delete", "send"]);
    expect(of().sort()).toEqual(["close", "delete", "send"]);
    const mail = { words: "write to Ana about Q3", app: "thunderbird", win: "Write: Q3 report - Thunderbird" };
    for (const mode of MODES) {
      expect(OTHER[mode], `${mode}: Send after a no to Ctrl+W`).toContain(await journey(mode, { ...mail, first: keys("ctrl+w", "Message body"), next: btn("Send") }));
      expect(OTHER[mode], `${mode}: Send after a no to the Delete key`).toContain(await journey(mode, { ...mail, first: keys("Delete", "Message body"), next: btn("Send") }));
      // The same thing done another way is still refused.
      expect(await journey(mode, { ...mail, first: btn("Send"), next: keys("ctrl+Return", "Message body") }), mode).toBe("refused");
      expect(await journey(mode, { ...mail, first: btn("Send"), next: btn("Send Later", "menu item") }), mode).toBe("refused");
    }
  });

  it("binds a refused kind to the app it was refused in: the same kind of step in another app is another thing", async () => {
    const files = { words: "tidy up", app: "nautilus", win: "Documents", first: btn("Move to Trash", "menu item") };
    for (const mode of MODES) {
      expect(await journey(mode, { ...files, next: btn("Delete permanently") }), mode).toBe("refused");
      expect(await journey(mode, { ...files, next: btn("Delete permanently"), nextWin: "Downloads" }), mode).toBe("refused");
      expect(OTHER[mode], mode).toContain(await journey(mode, { ...files, next: btn("Delete"), nextApp: "thunderbird", nextWin: "Inbox - Thunderbird" }));
    }
    expect(riskNames({ name: "Delete", about: "Delete", reason: "", app: "Nautilus" })).toEqual(["risk\ndelete\nnautilus"]);
    expect(riskNames({ name: "Delete", about: "Delete", reason: "" })).toEqual(["risk\ndelete"]);
  });
});

describe("a refused command done as a step in an app, and a refused step done as a command (modes-y9-2)", () => {
  const LINUX: ClassifyContext = { os: "linux", home: "/home/ana", cwd: "/home/ana/proj", ember: { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ }, downloaded: new Set() };
  const command = (text: string): CommandAsked => {
    const cls = classifyCommand(text, "bash", LINUX);
    const stand = standingFindings(cls.findings, undefined);
    return { sha256: commandSha256("local", "bash", LINUX.cwd, text), cwd: LINUX.cwd, command: text, acts: commandActs(stand, "linux"), named: commandNamed(stand, cls.commands), os: "linux", home: LINUX.home };
  };
  /** A worker whose task already holds a no to `refused`, a command; then the step comes. */
  async function after(mode: Mode, refused: string, step: Step, app = "nautilus", win = "proj") {
    const h = mk(mode, "clean up the build folder", app, win);
    h.inner.refusals.noteCommand(command(refused), "refused");
    if (mode === "autopilot") h.autopilotOn();
    const r = await h.inner.authorize({ taskId: "t1", app, window: win, ...step });
    if (r !== null && REFUSED_BEFORE.test(r.textResultForLlm)) return "refused";
    // (This task's first question is answered "Not now": the step was asked about.)
    if (r !== null && !/^The user said no\./.test(r.textResultForLlm)) return `denied: ${r.textResultForLlm.slice(0, 60)}`;
    return h.asked.length ? (h.checked.length ? "asked after a check" : "asked") : h.checked.length ? "checked" : "allowed";
  }

  it("never refuses a deletion in an app for a word it shares with a refused command, nor checks or announces it: it asks, and Autopilot, with no question to put, refuses it (modes-y9-y9-4)", async () => {
    const mail = "Re: build failed - Inbox - Thunderbird";
    for (const mode of MODES) {
      // (Refused without a question in Interactive and Assisted before: the email's subject holds "build".)
      expect(await after(mode, "rm -rf build", btn("Delete"), "thunderbird", mail), `${mode}: an email`).toBe(MAY_BE[mode]);
      expect(await after(mode, "rm -rf build", btn("Delete"), "thunderbird", "Draft: weekly notes - Thunderbird"), `${mode}: a draft`).toBe(MAY_BE[mode]);
      expect(await after(mode, "rm -rf build", keys("Delete", "build", "icon")), `${mode}: the folder in Files`).toBe(MAY_BE[mode]);
      expect(await after(mode, "rm -rf build", btn("Delete “build” permanently")), mode).toBe(MAY_BE[mode]);
      expect(await after(mode, "rm -rf build", btn("Move to Trash", "menu item"), "nautilus", "build"), mode).toBe(MAY_BE[mode]);
      expect(await after(mode, "rm -rf build", btn("Move to Trash", "menu item")), mode).toBe(MAY_BE[mode]);
    }
  });

  it("leaves another kind of step, and a task with no such no, as they were", async () => {
    // (No question has been answered no in these tasks, so each mode does what it does with a risky step.)
    const fresh: Record<Mode, string[]> = { interactive: ["asked"], assisted: ["asked after a check"], autopilot: ["allowed"] };
    for (const mode of MODES) {
      expect(fresh[mode], `${mode}: Send after a refused deletion`).toContain(await after(mode, "rm -rf build", btn("Send"), "thunderbird", "Write: hello - Thunderbird"));
      expect(fresh[mode], `${mode}: Delete after a refused push`).toContain(await after(mode, "git push origin main", btn("Move to Trash", "menu item")));
    }
  });

  it("names a refused command's danger for app steps by its kinds alone: deleting and overwriting, or sending", () => {
    const r = new Refusals();
    r.noteCommand(command("rm -rf build"), "refused");
    r.noteCommand(command("git push origin main"), "waiting");
    expect(r.step(stepAcrossNames(["delete"]))).toBe("refused");
    expect(r.step(stepAcrossNames(["overwrite"]))).toBe("refused");
    expect(r.step(stepAcrossNames(["send"]))).toBeNull();
    // A card nobody answered is nobody's no: it leaves nothing for app steps.
    expect(stepAcrossNames(["delete", "send"])).toEqual(["command-did\ndelete", "command-did\nsend"]);
  });

  it("asks about any deletion by command after a no to deleting report.pdf in Files, `rm ~/report.pdf` too: none is refused by a word (modes-y9-y9-3)", () => {
    const r = new Refusals();
    r.noteStep(stepMarksForCommands(["delete"]), "refused");
    for (const c of ["rm ~/report.pdf", "shred -u /home/ana/report.pdf", "rm ~/notes.txt", "python3 -c 'import os; os.remove(\"x\")'"]) expect([r.command(command(c)), r.commandLike(command(c))], c).toEqual([null, true]);
    // Another kind of danger, and an ordinary command, are as they were.
    expect(r.commandLike(command("git push origin main"))).toBe(false);
    expect(r.commandLike(command("ls -la"))).toBe(false);
    // A step whose question nobody answered leaves nothing for commands.
    const waiting = new Refusals();
    waiting.noteStep(stepMarksForCommands(["delete"]), "waiting");
    expect([waiting.command(command("rm ~/report.pdf")), waiting.commandLike(command("rm ~/report.pdf"))]).toEqual([null, false]);
  });

  it("keeps a refused risky step for commands at the worker by its kind alone, the user's own and one a page came up with alike (modes-y9-y9-3)", async () => {
    const win = "build-tools · GitHub — Mozilla Firefox";
    for (const words of ["delete the build-tools repository", "Post the comment Looks good on the quarterly report"]) {
      const h = mk("interactive", words, "firefox", win);
      expect((await h.inner.authorize({ taskId: "t1", app: "firefox", window: win, ...btn("Delete repository") }))?.resultType).toBe("denied");
      // (Refused without a question in every mode before: each is a word of the window's title.)
      for (const c of ["rm -rf build-tools", "rm -rf firefox", "rm -rf github", "rm -rf repository", "rm notes.txt"]) {
        expect([h.inner.refusals.command(command(c)), h.inner.refusals.commandLike(command(c))], c).toEqual([null, true]);
      }
      expect(h.inner.refusals.commandLike(command("git push origin main"))).toBe(false);
    }
  });
});
