/**
 * Ordinary borrowed steps in the approval modes (cause 4 of the investigation of the owner's report of 2026-11-12:
 * every step with the borrowed mouse or keyboard asked, every time; PLAN.md §2 "Approvals", the rules' "Tier 3"). In
 * Interactive an ordinary borrow is announced instead of asked (`waivable: ["cursor"]`), in an app the user asked for
 * help in and in one they didn't, on Linux, Windows and macOS alike; below Interactive every borrow asks, every time;
 * a risky one asks in both, and so does Ember's doubt about what a key does. The table below is the trace of every way
 * a borrowed click, scroll, key or typed text reaches PolicyEngine.decide() (worker.ts cursorAct, pressKeys, scroll,
 * typeInCell, fill_cells: there is no drag). After the user took the mouse back, no later borrow of the task goes
 * unasked: without a question, nothing else would stand between that and Ember taking the pointer again.
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { approvalInputs } from "../../app/main/policy/autonomy";
import { LINUX_WORKER_SYSTEM, Worker, type WorkerDeps, type WorkerSystem } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { UserTookOver, type Hand } from "../../app/main/hands/borrow";
import { KEYS, SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { friendlyApp } from "../../app/shared/apps";
import type { AxNode, Bounds } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";

type OS = "linux" | "win32" | "darwin";
const OSES: OS[] = ["linux", "win32", "darwin"];
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
/** A plain editor, a browser and an office app on each OS, as their windows name them. */
const APPS: Record<OS, { plain: string; browser: string; office: string }> = {
  linux: { plain: "gedit", browser: "firefox", office: "soffice" },
  win32: { plain: "notepad.exe", browser: "msedge.exe", office: "WINWORD.EXE" },
  darwin: { plain: "TextEdit", browser: "Safari", office: "Pages" },
};
/** The policy as main builds it for a mode in force (approvalInputs), with no "Always" in any app. */
const engine = (os: OS, mode: "asking" | "interactive") => {
  const i = approvalInputs(mode);
  return new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => i.scopes, trustAskedApps: () => i.askedApps, os, keys: KEYS[os], rateLimit: 1_000_000 });
};

/** Borrowed steps with nothing risky in them: `P` is the OS's primary modifier (Ctrl, or Command on macOS). */
const ordinary = (P: string, page: boolean): [string, Partial<ActionRequest>][] => [
  ["a click on a button", { kind: "cursor_click", element: { role: "push button", name: "Bold" }, ...(page ? { onPage: true } : {}) }],
  ["a click on a link", { kind: "cursor_click", element: { role: "link", name: "Next page" }, ...(page ? { onPage: true } : {}) }],
  ["a click on a menu", { kind: "cursor_click", element: { role: "menu", name: "File" } }],
  ["a click on a menu item", { kind: "cursor_click", element: { role: "menu item", name: "View" } }],
  ["a click on a check box", { kind: "cursor_click", element: { role: "check box", name: "Wrap lines" } }],
  ["a click on a tab", { kind: "cursor_click", element: { role: "page tab", name: "Home" } }],
  ["a click into a field", { kind: "cursor_click", element: { role: "entry", name: "Name" } }],
  ["a click on a heading", { kind: "cursor_click", element: { role: "heading", name: "Results" }, ...(page ? { onPage: true } : {}) }],
  ["a click that selects a row", { kind: "cursor_click", element: { role: "table cell", name: "Totals" }, clickSelects: true }],
  ["text typed into an empty field", { kind: "cursor_text", element: { role: "entry", name: "Name" }, value: "hello", mode: "replace", currentText: "", ...(page ? { inPage: true } : {}) }],
  ["text typed over a word in a field", { kind: "cursor_text", element: { role: "entry", name: "Search" }, value: "cats", mode: "replace", currentText: "dogs", ...(page ? { inPage: true } : {}) }],
  ["text added to a multi-line text", { kind: "cursor_text", element: { role: "text", name: "" }, value: "hello", mode: "append", currentText: "abc", multiLine: true }],
  ["text typed at the caret", { kind: "cursor_text", element: { role: "text", name: "" }, value: "hello", mode: "insert", currentText: "abc", multiLine: true }],
  ["text added to a document", { kind: "cursor_text", element: { role: "document text", name: "" }, value: "hello", mode: "append", currentText: "abc" }],
  ["text typed into a sheet's cell", { kind: "cursor_text", element: { role: "table cell", name: "B5" }, value: "4", mode: "replace", currentText: "" }],
  ["a scroll", { kind: "scroll", element: { role: "scroll pane", name: "" }, value: "down" }],
  ...["Tab", "shift+Tab", "Down", "Page_Down", "Home", `${P}+End`, "Escape", "a", "BackSpace", "shift+Down", "F5", "F2", `${P}+s`, `${P}+c`, `${P}+v`, `${P}+x`, `${P}+z`, `${P}+a`, `${P}+f`, `${P}+b`].map(
    (k): [string, Partial<ActionRequest>] => [`${k} in a text`, { kind: "keys", value: k, element: { role: "text", name: "" }, currentText: "abc", selection: "", multiLine: true }]),
  ["Enter on a button", { kind: "keys", value: "Return", element: { role: "push button", name: "Search" }, ...(page ? { inPage: true } : {}) }],
  ["Space on a check box", { kind: "keys", value: "space", element: { role: "check box", name: "Wrap lines" }, ...(page ? { inPage: true } : {}) }],
  ["Enter on a link", { kind: "keys", value: "Return", element: { role: "link", name: "Next page" }, ...(page ? { inPage: true } : {}) }],
  ["Enter on a menu item", { kind: "keys", value: "Return", element: { role: "menu item", name: "Word wrap" } }],
  ["an arrow key with nothing known to have the keyboard", { kind: "keys", value: "Down" }],
  ["a letter with nothing known to have the keyboard", { kind: "keys", value: "a" }],
];

/** Borrowed steps that ask in every mode but Autopilot: something risky, or Ember's doubt about what a key does. */
const stillAsks = (P: string): [string, Partial<ActionRequest>, RegExp][] => [
  ["a click on Delete", { kind: "cursor_click", element: { role: "push button", name: "Delete" }, goal: "delete the draft" }, /hard to undo|visible to others/],
  ["a click on Send nobody asked for", { kind: "cursor_click", element: { role: "push button", name: "Send" } }, /not something the user asked for$/],
  ["text with a line break typed outside a plain editor's document", { kind: "cursor_text", element: { role: "text", name: "Notes" }, value: "a\nb", mode: "append", currentText: "", multiLine: true }, /line break or tab/],
  ["text typed over a hundred characters", { kind: "cursor_text", element: { role: "entry", name: "Name" }, value: "hello", mode: "replace", currentText: "x".repeat(100) }, /replaces all 100 characters/],
  ["text that replaces a document's with the keyboard", { kind: "cursor_text", element: { role: "document text", name: "" }, value: "hello", mode: "replace", currentText: "" }, /may be the whole document$/],
  ["a destructive key", { kind: "keys", value: "Delete", element: { role: "text", name: "" }, currentText: "abc", selection: "" }, /can delete, send or close things$/],
  ["closing with a shortcut", { kind: "keys", value: `${P}+w`, element: { role: "text", name: "" } }, /can delete, send or close things$/],
  ["Enter with nothing known to have the keyboard", { kind: "keys", value: "Return" }, /can't tell what this key will activate$/],
  ["a letter with Alt", { kind: "keys", value: "alt+f", element: { role: "text", name: "" } }, /can't tell which$/],
  ["a shortcut Ember doesn't know", { kind: "keys", value: `${P}+k`, element: { role: "text", name: "" } }, /can't tell what this shortcut does in this app$/],
];

describe("an ordinary step with the borrowed mouse or keyboard, as policy decides it (cause 4)", () => {
  for (const os of OSES) {
    const P = KEYS[os].primary;
    for (const [kind, app] of Object.entries(APPS[os])) {
      for (const askedIn of [app, "another-app"]) {
        const where = `${os}, ${kind} app ${askedIn === app ? "the user asked for help in" : "the user didn't ask about"}`;
        const req = (r: Partial<ActionRequest>): ActionRequest => ({ taskId: "t1", kind: "cursor_click", app, window: kind === "browser" ? "Cats - YouTube" : "notes.txt", goal: "help me with this", askedIn, ...r });

        it(`is announced instead of asked in Interactive (${where})`, () => {
          const e = engine(os, "interactive");
          for (const [name, r] of ordinary(P, kind === "browser")) {
            const d = e.decide(req(r));
            expect(d, name).toMatchObject({ verdict: "allow", autonomy: true, remember: false });
            // Said in Ember's own words, with how to take the mouse and keyboard back.
            expect(d.announce, name).toMatch(/^(Using your (mouse|keyboard) to .+|Moving text .+) in .+, without asking as you let me\. Move the mouse or press a key to take it back\.$/);
            expect(d.announce, name).toContain(friendlyApp(app));
          }
        });

        it(`asks every time below Interactive, with no “Always”, and only the borrow to waive (${where})`, () => {
          const e = engine(os, "asking");
          for (const [name, r] of ordinary(P, kind === "browser")) {
            const d = e.decide(req(r));
            expect(d, name).toMatchObject({ verdict: "confirm", risky: true, everyTime: true, waivable: ["cursor"] });
            expect(d.remember, name).toBeFalsy();
            expect(d.autonomy, name).toBeUndefined();
          }
        });

        it(`asks about a risky borrow, and about Ember's doubt about a key, in both (${where})`, () => {
          for (const mode of ["interactive", "asking"] as const) {
            const e = engine(os, mode);
            for (const [name, r, why] of stillAsks(P)) {
              const d = e.decide(req(r));
              expect(d.verdict, `${mode}: ${name}`).toBe("confirm");
              expect(d.autonomy, `${mode}: ${name}`).toBeUndefined();
              expect(d.waivable, `${mode}: ${name}`).toBeUndefined();
              expect(d.reason, `${mode}: ${name}`).toMatch(why);
            }
          }
        });
      }
    }
  }

  it("still asks about a borrow in the system's Settings, whatever the mode", () => {
    const SETTINGS: Record<OS, string> = { linux: "gnome-control-center", win32: "SystemSettings.exe", darwin: "System Settings" };
    for (const os of OSES) {
      const d = engine(os, "interactive").decide({ taskId: "t1", kind: "cursor_click", app: SETTINGS[os], window: "Settings", goal: "help me with this", askedIn: SETTINGS[os], element: { role: "push button", name: "Details" } });
      expect(d, os).toMatchObject({ verdict: "confirm", waivable: ["cursor"] });
      expect(d.autonomy, os).toBeUndefined();
    }
  });
});

const FRAME: Bounds = { x: 0, y: 0, width: 800, height: 600 };
function systemOf(os: OS): WorkerSystem {
  if (os === "linux") return LINUX_WORKER_SYSTEM;
  return {
    os, keys: KEYS[os], words: PLATFORM_WORDS[os], shortcuts: SHORTCUTS[os],
    apps: { list: () => [], find: () => null, launch: () => undefined, isTerminalApp: () => false, programsOf: a => new Set([a.id.toLowerCase()]), appKey: n => n.toLowerCase().replace(/\.exe$/, "") },
    settings: { available: {}, change: async () => ({ before: "", after: "" }) }, privacy: { isSecurityWindow: () => false },
  };
}

/**
 * A worker on a plain editor none of whose controls takes a click or text by accessibility, so every step borrows the
 * user's mouse or keyboard. `takeOver`: the borrows (counted from 1) during which the user moves the mouse.
 */
function borrower(os: OS, mode: "asking" | "interactive", o: { asked?: boolean; takeOver?: number[] } = {}) {
  const st = { asked: [] as string[], audit: [] as Record<string, unknown>[], announced: [] as string[], borrows: 0 };
  const sys = systemOf(os);
  const app = APPS[os].plain;
  const frame: AxNode = { id: 1, parent: null, depth: 0, role: "frame", name: "list.txt", states: [], bounds: FRAME };
  const area: AxNode = { id: 2, parent: 1, depth: 1, role: "text", name: "Text editor", text: "", states: ["enabled", "sensitive", "editable", "focusable", "focused", "multi line"], bounds: { x: 10, y: 60, width: 700, height: 300 } };
  const bold: AxNode = { id: 3, parent: 1, depth: 1, role: "push button", name: "Bold", states: ["enabled", "sensitive"], bounds: { x: 10, y: 10, width: 60, height: 20 } };
  const pane: AxNode = { id: 5, parent: 1, depth: 1, role: "scroll pane", name: "", states: ["enabled"], bounds: { x: 10, y: 380, width: 700, height: 200 } };
  const words: AxNode = { id: 6, parent: 5, depth: 2, role: "label", name: "Some words", states: ["enabled"], bounds: { x: 20, y: 390, width: 300, height: 20 } };
  const nodes = (): AxNode[] => [frame, area, bold, pane, words];
  const window = { app, pid: 7, path: "/p/1", name: "list.txt", role: "frame", active: true, bounds: FRAME };
  const seen = () => ({ window, x11Window: null, nodes: nodes(), blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1 });
  const written: string[] = [];
  const hand: Hand = {
    glideTo: async () => undefined, click: async () => undefined, type: async () => undefined, checkTyping: () => undefined, scroll: async () => undefined,
    keys: async (k: string) => { if (k === sys.keys.edit.paste) area.text = `${area.text ?? ""}${written.at(-1) ?? ""}`; },
  };
  const i = approvalInputs(mode);
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen(), text: "<screen>", capture: null }), read: async () => seen(), windows: async () => [window], systemDialogOpen: async () => false } as never,
    sidecar: {
      readElement: async (id: number) => { const n = nodes().find(x => x.id === id); return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...(n.text !== undefined ? { text: n.text } : {}) } : null; },
      // (Asked before anything is: the mouse is the only way, so only the borrow is decided about.)
      canDo: async () => ({ tier1: false, why: "no accessible action" }),
      setText: async () => { throw new Error("background_unavailable: this app takes no text this way"); },
      doAction: async () => { throw new Error("background_unavailable: no accessible action"); },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => i.scopes, trustAskedApps: () => i.askedApps, os, keys: sys.keys }),
    autonomy: () => i.scopes,
    confirmer: { ask: async (q: { prompt: string }) => { st.asked.push(q.prompt); return "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => st.audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    onActivity: (e: { type: string; text?: string }) => { if (e.type === "announce") st.announced.push(e.text ?? ""); },
    cursor: {
      borrow: { borrow: async (fn: (h: Hand) => Promise<void>, b: { onStart?: () => void }) => {
        st.borrows++;
        if (o.takeOver?.includes(st.borrows)) throw new UserTookOver(120);
        b.onStart?.();
        await fn(hand);
      } } as never,
      findWindow: () => 1, setBorrowing: () => undefined,
    },
    clipboard: { save: async () => ({ items: [{ "text/plain": "the user's" }], look: "x" }), unchanged: async () => true, writeText: async (t: string) => { written.push(t); }, restore: async () => undefined },
    ...(os === "linux" ? {} : { system: sys }),
  } as unknown as WorkerDeps, { id: "t1", goal: "write my shopping list", userWords: "write my shopping list", target: { title: "list.txt", app: o.asked === false ? "another-app" : app } } as never);
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const authorizeCells = (cells: { cell: string; text: string }[]) => (w as unknown as { authorizeCells(jobs: unknown[]): Promise<unknown> })
    .authorizeCells(cells.map((c, n) => ({ ...c, place: { col: 1, row: 5 + n }, seenKey: c.cell, expected: undefined, listed: undefined })));
  return { st, call, authorizeCells, app: friendlyApp(app), P: sys.keys.primary };
}

/** A task's ordinary steps, each with the user's mouse or keyboard. */
const steps = (P: string): [string, Record<string, unknown>][] => [
  ["click", { id: 3 }], ["type_text", { id: 2, text: "milk", mode: "append" }], ["type_text", { id: 2, text: " and eggs", mode: "insert" }],
  ["press_keys", { keys: "Down" }], ["press_keys", { keys: `${P}+End` }], ["press_keys", { keys: "a" }], ["press_keys", { keys: `${P}+s` }],
  ["scroll", { id: 5, direction: "down", steps: 2 }],
];

describe("a worker's ordinary borrowed steps (cause 4)", () => {
  for (const os of OSES) {
    for (const asked of [true, false]) {
      it(`go ahead in Interactive with no question, each announced once and recorded as the mode's (${os}, ${asked ? "an app asked about" : "an app not asked about"})`, async () => {
        const h = borrower(os, "interactive", { asked });
        await h.call("perceive_window", {});
        for (const [name, args] of steps(h.P)) expect((await h.call(name, args)).resultType, `${name} ${JSON.stringify(args)}`).toBe("success");
        expect(h.st.asked).toEqual([]);
        expect(h.st.borrows).toBe(8);
        expect(h.st.announced).toHaveLength(8);
        for (const said of h.st.announced) expect(said).toMatch(new RegExp(`^Using your (mouse|keyboard) to .+ in ${h.app}, without asking as you let me\\. Move the mouse or press a key to take it back\\.$`));
        const decisions = h.st.audit.filter(e => e.event === "decision");
        expect(decisions.map(e => [e.verdict, e.autonomy])).toEqual(Array(8).fill(["allow", true]));
        expect(h.st.audit.filter(e => e.event === "action" && e.ok === true && e.tier === 3)).toHaveLength(8);
      });
    }

    it(`ask every time below Interactive, as before the modes (${os})`, async () => {
      const h = borrower(os, "asking");
      await h.call("perceive_window", {});
      for (const [name, args] of steps(h.P)) expect((await h.call(name, args)).resultType, name).toBe("success");
      // Each borrow has its own question: an Allow earlier in the task never covers the next one, but for a key that only
      // moves right after the user said yes to one (Down, then to the end: "Keys that only move there after this one
      // won't be asked about.").
      expect(h.st.asked).toHaveLength(7);
      for (const q of h.st.asked) expect(q).toMatch(/^Borrow your (mouse|keyboard) /);
      expect(h.st.asked.filter(q => /Keys that only move there after this one won't be asked about\.$/.test(q))).toHaveLength(1);
      expect(h.st.announced).toEqual([]);
      expect(h.st.audit.some(e => e.autonomy === true)).toBe(false);
    });
  }
});

describe("after the user took the mouse back from a step that went ahead unasked (cause 4)", () => {
  for (const os of OSES) {
    it(`asks before borrowing again in that task, saying why (${os})`, async () => {
      const h = borrower(os, "interactive", { takeOver: [1] });
      await h.call("perceive_window", {});
      const first = await h.call("click", { id: 3 });
      expect(first).toMatchObject({ resultType: "denied", textResultForLlm: "The user took the mouse back, so you stopped. Don't try again; finish the task and say what's left." });
      expect(h.st.asked).toEqual([]);
      // The model tries again all the same: Ember asks, and takes nothing until the user says yes.
      for (const [name, args] of steps(h.P)) expect((await h.call(name, args)).resultType, name).toBe("success");
      // (Seven questions for eight steps: a key that only moves, right after a yes to one, is covered by that yes.)
      expect(h.st.asked).toHaveLength(7);
      for (const q of h.st.asked) expect(q).toMatch(/^Borrow your (mouse|keyboard) .+\? \(You took the mouse back earlier, so I'm asking before I use it again\.\)( Keys that only move there after this one won't be asked about\.)?$/);
      // Nothing more was announced after the borrow the user took back, and nothing went ahead as the mode's.
      expect(h.st.announced).toHaveLength(1);
      const later = h.st.audit.filter(e => e.event === "decision").slice(1);
      expect(later).toHaveLength(8);
      for (const e of later) expect(e.autonomy).toBeUndefined();
      expect(later.filter(e => e.verdict === "confirm")).toHaveLength(7);
      for (const e of later.filter(x => x.verdict === "confirm")) expect(e.reason).toMatch(/; the user took the mouse back earlier in this task$/);
      expect(later.find(e => e.verdict === "allow")?.reason).toBe("a key that only moves, after the user said yes to moving there");
    });
  }

  it("asks before filling cells with the keyboard too", async () => {
    const h = borrower("win32", "interactive", { takeOver: [1] });
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    expect(await h.authorizeCells([{ cell: "B5", text: "4" }, { cell: "B6", text: "5" }])).toBeNull();
    expect(h.st.asked).toEqual([`Borrow your keyboard to fill 2 cells in ${h.app}: B5 “4”, B6 “5”? (You took the mouse back earlier, so I'm asking before I use it again.)`]);
    expect(h.st.audit.filter(e => e.event === "decision" && e.kind === "cursor_text").every(e => e.verdict === "confirm" && e.autonomy === undefined)).toBe(true);
  });

  it("goes on announcing borrows the user didn't take back", async () => {
    const h = borrower("linux", "interactive");
    await h.call("perceive_window", {});
    await h.call("click", { id: 3 });
    await h.call("click", { id: 3 });
    expect(h.st.asked).toEqual([]);
    expect(h.st.announced).toHaveLength(2);
  });
});
