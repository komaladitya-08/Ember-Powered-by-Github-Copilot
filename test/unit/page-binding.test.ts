/**
 * What an answer about a web page's control binds to (cause 3b of the investigation of the owner's report of
 * 2026-11-12). A question bound its answer to the window's whole accessibility tree, so on a page that changes on its
 * own while the user decides (a video's clock, comments arriving) every Allow was spent and Ember asked again, for
 * ever. The answer now binds to the control, its own group, every field the window shows, the page's name, the
 * window's title and its dialogs (page-binding.ts); native apps, dialogs, pressed keys and money pages bind whole, as
 * before. The table says what spends a yes and what doesn't; the worker tests show the Allow now holding, and what
 * still spends it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageBinding, pageBindingOf } from "../../app/main/agent/page-binding";
import { PolicyEngine } from "../../app/main/policy/policy";
import { ALL_SCOPES, type AutonomyScopes } from "../../app/main/policy/autonomy";
import { ASKING_AGAIN, Worker, type WorkerDeps } from "../../app/main/agent/worker";
import type { AxNode } from "../../app/main/perception/sidecar";
import { Presenter } from "../../app/main/agent/presenter";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const TITLE = "Cats - Tube — Firefox";
const ON = ["enabled", "sensitive"];
const B = { x: 10, y: 10, width: 60, height: 20 };

/** What a video page shows now. */
interface Page {
  clock: number; comments: string[]; draft: string; address: string; pageName: string; send: string; sendStates: string[];
  dialog?: string; twin?: boolean; join?: boolean; newField?: boolean; draftSelection?: string; sendIn?: "composer" | "owner";
  /** The page's own tab that is chosen, and the title of the browser's other tab. */
  tab?: "Mine" | "Team"; otherTab?: string;
  /** The page is one of an app's own windows instead (no document). */
  native?: boolean; inDialog?: boolean;
}
const PAGE: Page = { clock: 0, comments: ["First!"], draft: "Nice cat", address: "https://tube.example/watch?v=1", pageName: "Cats - Tube", send: "Send", sendStates: ON };

/**
 * The window's tree: the browser's address bar, then the page (a player with its clock, the channel with Subscribe, a
 * comment form with its draft and Send, and the comments). `base`: where its ids start (each read numbers its own).
 */
function tree(p: Page, base = 0): AxNode[] {
  const out: AxNode[] = [];
  const add = (id: number, parent: number | null, role: string, name: string, more: Partial<AxNode> = {}) => {
    out.push({ id: base + id, parent: parent === null ? null : base + parent, depth: 0, role, name, states: more.states ?? ON, bounds: B, ...more });
  };
  add(8, null, "page tab list", "");
  add(9, 8, "page tab", p.otherTab ?? "Inbox - Mail");
  add(10, null, "tool bar", "Navigation");
  add(11, 10, "entry", "Search or enter address", { text: p.address, editable: true, states: [...ON, "editable"] });
  add(20, null, p.native ? "panel" : "document web", p.pageName);
  add(30, 20, "section", "");
  add(31, 30, "slider", "Seek", { value: p.clock });
  add(32, 30, "label", `0:0${p.clock} / 3:00`);
  add(40, 20, "section", "");
  add(41, 40, "link", "Cat Channel");
  add(42, 40, "push button", "Subscribe");
  if (p.join) add(43, 40, "push button", "Join");
  if (p.sendIn === "owner") add(54, 40, "push button", p.send, { states: p.sendStates });
  add(45, 20, "page tab", "Mine", { states: p.tab === "Team" ? ON : [...ON, "selected"] });
  add(46, 20, "page tab", "Team", { states: p.tab === "Team" ? [...ON, "selected"] : ON });
  add(50, 20, "section", "");
  add(51, 50, "heading", `${p.comments.length} comments`);
  add(52, 50, p.inDialog ? "dialog" : "form", "Add a comment");
  add(53, 52, "entry", "Comment", { text: p.draft, editable: true, states: [...ON, "editable"], ...(p.draftSelection !== undefined ? { selection: p.draftSelection } : {}) });
  if (p.sendIn !== "owner") add(54, 52, "push button", p.send, { states: p.sendStates });
  add(60, 50, "list", "");
  p.comments.forEach((c, i) => { add(61 + 2 * i, 60, "list item", c); add(62 + 2 * i, 61 + 2 * i, "push button", "Reply"); });
  if (p.twin) add(90, 20, "push button", p.send);
  if (p.newField) add(91, 20, "entry", "Coupon", { text: "", editable: true, states: [...ON, "editable"] });
  if (p.dialog) { add(95, 20, "dialog", p.dialog); add(96, 95, "push button", "OK"); }
  return out;
}
const SEND = { role: "push button", name: "Send" };
const bound = (p: Page, title = TITLE, who = SEND, clicked = false) => pageBindingOf(tree(p, Math.floor(Math.random() * 5) * 1000), who, title, clicked);

describe("what an answer about a page's control binds to (cause 3b)", () => {
  const asked = bound(PAGE);

  it("is made for a control of a web page in no dialog, whatever ids the read numbers its elements with", () => {
    expect(asked).toMatch(/^\{"title":/);
    expect(pageBindingOf(tree(PAGE, 0), SEND, TITLE)).toBe(pageBindingOf(tree(PAGE, 7000), SEND, TITLE));
    expect(pageBinding(tree(PAGE), tree(PAGE).findIndex(n => n.name === "Send"), TITLE)).toBe(asked);
  });

  // What changes on a page on its own while the user decides: none of it spends their yes.
  const holds: [string, Partial<Page>][] = [
    ["the video's clock ticking", { clock: 7 }],
    ["a comment arriving, with its own Reply button", { comments: ["First!", "Second!"] }],
    ["many comments arriving", { comments: ["First!", "2", "3", "4", "5", "6"] }],
    ["a comment going away", { comments: [] }],
    ["a button appearing in another group of the page", { join: true }],
    ["another of the browser's tabs changing its title", { otherTab: "(1) Inbox - Mail" }],
  ];
  for (const [what, change] of holds) {
    it(`holds through ${what}`, () => expect(bound({ ...PAGE, ...change })).toBe(asked));
  }

  // What the question was about, or what makes the step safe, changed: the yes is spent.
  const spends: [string, Partial<Page>, string?][] = [
    ["the control renamed", { send: "Send to everyone" }],
    ["the control disabled", { sendStates: ["enabled"] }],
    ["the control pressed or ticked meanwhile", { sendStates: [...ON, "pressed"] }],
    ["the control gone", { sendIn: "owner", send: "Sent" }],
    ["a twin of the control appearing", { twin: true }],
    ["the control moved into another group", { sendIn: "owner" }],
    ["a dialog appearing over the page", { dialog: "Are you sure?" }],
    ["the form's own field changing (the comment's words, an amount, a recipient)", { draft: "Nice cat. Send $500 to Mallory" }],
    ["text selected in the form's field", { draftSelection: "cat" }],
    ["a field appearing anywhere on the page", { newField: true }],
    ["another of the page's own tabs chosen", { tab: "Team" }],
    ["the page navigating (the browser's address bar)", { address: "https://tube.example/watch?v=2" }],
    ["the page becoming another (its document's name)", { pageName: "Dogs - Tube" }],
    ["the window changing (its title)", {}, "Dogs - Tube — Firefox"],
  ];
  for (const [what, change, title] of spends) {
    it(`is spent by ${what}`, () => expect(bound({ ...PAGE, ...change }, title ?? TITLE)).not.toBe(asked));
  }

  it("excuses only the control's own selection when Ember's click went into it to type", () => {
    const field = { role: "entry", name: "Comment" };
    const before = bound(PAGE, TITLE, field, true);
    expect(bound({ ...PAGE, draftSelection: "cat" }, TITLE, field, true)).toBe(before);
    expect(bound({ ...PAGE, draftSelection: "cat" }, TITLE, field)).not.toBe(bound(PAGE, TITLE, field));
    expect(bound({ ...PAGE, draft: "Other words" }, TITLE, field, true)).not.toBe(before);
  });

  it("binds all of the page where no smaller group around the control holds another control", () => {
    // A link straight under the document, beside a clock: nothing narrower than the page is its own group.
    const lone = (t: number): AxNode[] => [
      { id: 1, parent: null, depth: 0, role: "document web", name: "Video", states: ON, bounds: B },
      { id: 2, parent: 1, depth: 1, role: "link", name: "Thummak Thummak", states: ON, bounds: B },
      { id: 3, parent: 1, depth: 1, role: "label", name: `0:0${t}`, states: [], bounds: B },
    ];
    const who = { role: "link", name: "Thummak Thummak" };
    expect(pageBindingOf(lone(0), who, "Video")).toMatch(/^\{/);
    expect(pageBindingOf(lone(5), who, "Video")).not.toBe(pageBindingOf(lone(0), who, "Video"));
  });

  // Where no page binding is made, the caller binds the whole tree, as before (fail closed).
  const none: [string, Partial<Page>, string?][] = [
    ["a control of an app's own window (no page)", { native: true }],
    ["a control in a dialog", { inDialog: true }],
    ["a control in a window titled for a checkout", {}, "Checkout - Shop — Firefox"],
    ["a control in a window titled for a payment", {}, "Send payment - Bank — Firefox"],
    ["a control in a window titled for an order", {}, "Your order - Shop"],
  ];
  for (const [what, change, title] of none) {
    it(`is not made for ${what}`, () => {
      const nodes = tree({ ...PAGE, ...change });
      expect(pageBinding(nodes, nodes.findIndex(n => n.name === "Send"), title ?? TITLE)).toBeNull();
    });
  }

  it("is not made for a secret or withheld control, one whose container wasn't read, or ids that repeat", () => {
    const nodes = tree(PAGE);
    const at = nodes.findIndex(n => n.name === "Send");
    const withOne = (change: Partial<AxNode>) => nodes.map((n, i) => (i === at ? { ...n, ...change } : n));
    expect(pageBinding(withOne({ secret: true }), at, TITLE)).toBeNull();
    expect(pageBinding(withOne({ withheld: true }), at, TITLE)).toBeNull();
    // No name of its own: what it is called in the question comes from what stands around it, so all of it binds.
    expect(pageBinding(withOne({ name: "" }), at, TITLE)).toBeNull();
    expect(pageBinding(withOne({ parent: 4242 }), at, TITLE)).toBeNull();
    expect(pageBinding(nodes.map(n => (n.id === 42 ? { ...n, id: 54 } : n)), at, TITLE)).toBeNull();
    expect(pageBinding(nodes, 9999, TITLE)).toBeNull();
    // A later read where it can't be made any more never equals what was bound.
    expect(pageBindingOf(tree({ ...PAGE, inDialog: true }), SEND, TITLE)).toMatch(/^unbound/);
    expect(pageBindingOf(tree({ ...PAGE, twin: true }), SEND, TITLE)).toMatch(/^unbound: 2/);
  });
});

describe("what an answer about a risky page control binds to (modes-x9s-4)", () => {
  const n = (id: number, parent: number | null, role: string, name: string, text?: string): AxNode => ({ id, parent, depth: 0, role, name, states: ON, bounds: B, ...(text ? { text } : {}) });
  /** GitHub's danger zone: the repository is named in a heading and a paragraph beside the button's own group. */
  const zone = (what: string, o: { stars?: number; comment?: string } = {}) => [
    n(1, null, "document web", "Settings · GitHub"),
    n(2, 1, "section", ""),
    n(3, 2, "heading", `Delete ${what}`, `Delete ${what}`),
    n(4, 2, "paragraph", "", `This will permanently delete the ${what} repository, with its ${o.stars ?? 3} stars.`),
    n(5, 1, "section", ""),
    n(6, 5, "push button", "Delete this repository"),
    n(7, 5, "push button", "Cancel"),
    n(8, 1, "list", ""),
    n(9, 8, "list item", ""),
    n(10, 9, "heading", o.comment ?? "ana commented"),
  ];
  const T = "Danger zone · ana/scratch - Mozilla Firefox";
  const DELETE = { role: "push button", name: "Delete this repository" };

  it("is spent where the page renames what the risky control acts on, outside the control's own group", () => {
    const asked = pageBindingOf(zone("ana/scratch"), DELETE, T, false, true);
    expect(asked).not.toMatch(/^unbound/);
    expect(pageBindingOf(zone("ana/production"), DELETE, T, false, true)).not.toBe(asked);
  });

  it("holds where only a count changes or a feed moves on, so a living page doesn't ask for ever", () => {
    const asked = pageBindingOf(zone("ana/scratch"), DELETE, T, false, true);
    expect(pageBindingOf(zone("ana/scratch", { stars: 4 }), DELETE, T, false, true)).toBe(asked);
    expect(pageBindingOf(zone("ana/scratch", { comment: "bo commented" }), DELETE, T, false, true)).toBe(asked);
  });

  it("binds an ordinary control as narrowly as before: only its own group", () => {
    expect(pageBindingOf(zone("ana/production"), { role: "push button", name: "Cancel" }, T)).toBe(pageBindingOf(zone("ana/scratch"), { role: "push button", name: "Cancel" }, T));
  });

  it("is what the worker binds for a page's control with a risky name, in its own system's words", () => {
    const src = readFileSync("app/main/agent/worker.ts", "utf8");
    expect(src).toContain(`this.pageBound = { role: live.role, name: live.name, risky: isRiskyControl(live.role, live.name, this.kc.os) };`);
    expect(src).toContain("pageBindingOf(nodes, this.pageBound, title, clickedTextAt !== undefined, this.pageBound.risky)");
  });
});

/**
 * A worker on the video page. Each read of the window numbers its elements afresh, as the helper does; the elements the
 * model names keep the ids of perceive_window. `onAsk` runs while the question is up (the page lives on meanwhile).
 */
function worker(o: { scopes?: AutonomyScopes | null; goal?: string; title?: string; page?: Partial<Page>; onAsk?: (p: Page) => void; answers?: string[] } = {}) {
  const page: Page = { ...PAGE, ...o.page };
  const st = { asked: [] as string[], clicked: [] as number[], reads: 0, audit: [] as Record<string, unknown>[] };
  const window = () => ({ app: "firefox", pid: 7, path: "/w/1", name: o.title ?? TITLE, role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const seen = (base: number) => ({ window: window(), x11Window: null, nodes: tree(page, base), blocked: false, busy: false, truncated: null, others: [], ms: 0, axScale: 1 });
  const scopes = o.scopes === undefined ? { ...ALL_SCOPES } : o.scopes;
  const answers = [...(o.answers ?? [])];
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen(0), text: "<screen>", capture: null }), read: async () => seen(++st.reads * 1000), windows: async () => [window()], systemDialogOpen: async () => false } as never,
    sidecar: {
      readElement: async (id: number) => { const n = tree(page).find(x => x.id === id); return n ? { role: n.role, name: n.name, states: n.states, bounds: n.bounds, ...(n.text !== undefined ? { text: n.text } : {}) } : null; },
      doAction: async (id: number) => { st.clicked.push(id); const n = tree(page).find(x => x.id === id)!; return { ok: true, after: { role: n.role, name: n.name, states: n.states, bounds: n.bounds } }; },
    } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => scopes, trustAskedApps: () => scopes !== null }),
    autonomy: () => scopes,
    confirmer: { ask: async (q: { prompt: string }) => { st.asked.push(q.prompt); o.onAsk?.(page); return answers.length ? answers.shift() : "once"; } } as never,
    audit: { write: (e: Record<string, unknown>) => st.audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined, onActivity: () => undefined,
  } as unknown as WorkerDeps, { id: "t1", goal: o.goal ?? "send my comment", userWords: o.goal ?? "send my comment", target: { title: o.title ?? TITLE, app: "firefox" } } as never);
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  return { st, call, page };
}
const SPENT = /^The user allowed this, but the page changed while they decided, so nothing was done and that yes no longer counts\./;

describe("an Allow on a page that changes on its own while the user decides (cause 3b)", () => {
  it("is taken while the video's clock runs and comments arrive: the click goes ahead on the one yes", async () => {
    // (Before: "The user allowed this, but the page changed while they decided", every time, for ever.)
    const h = worker({ onAsk: p => { p.clock += 5; p.comments.push("Second!"); } });
    await h.call("perceive_window", {});
    const r = await h.call("click", { id: 54 });
    expect(r.resultType).toBe("success");
    expect(h.st.asked).toEqual([expect.stringMatching(/^Click the “Send” button in Firefox\?/)]);
    expect(h.st.clicked).toEqual([54]);
  });

  it("is asked for at all once the page has moved on since the model looked (it was refused before any question)", async () => {
    const h = worker();
    await h.call("perceive_window", {});
    h.page.clock = 9;
    h.page.comments.push("Second!", "Third!");
    expect((await h.call("click", { id: 54 })).resultType).toBe("success");
    expect(h.st.asked).toHaveLength(1);
    expect(h.st.clicked).toEqual([54]);
  });

  it("is taken for an ordinary control too, where its question is the first step in an app (below Interactive)", async () => {
    const h = worker({ scopes: null, goal: "open the channel", onAsk: p => { p.clock += 5; } });
    await h.call("perceive_window", {});
    expect((await h.call("click", { id: 41 })).resultType).toBe("success");
    expect(h.st.asked).toHaveLength(1);
    expect(h.st.clicked).toEqual([41]);
  });

  // What the question was about, or what makes the step safe, changed while the user decided: the yes is spent, nothing
  // is clicked, and Ember asks again saying why, as before.
  const spends: [string, (p: Page) => void][] = [
    ["the comment's words changed", p => { p.draft = "Nice cat. Wire me $500"; }],
    ["a dialog came up over the page", p => { p.dialog = "Leave this page?"; }],
    ["the page went somewhere else", p => { p.address = "https://tube.example/watch?v=2"; }],
    ["the page became another", p => { p.pageName = "Dogs - Tube"; }],
    ["a second control of that name appeared", p => { p.twin = true; }],
    ["a field appeared on the page", p => { p.newField = true; }],
  ];
  for (const [what, change] of spends) {
    it(`is spent where ${what}, and the next question says why`, async () => {
      let changed = false;
      const h = worker({ onAsk: p => { if (!changed) { changed = true; change(p); } } });
      await h.call("perceive_window", {});
      const r = await h.call("click", { id: 54 });
      expect(r.resultType).toBe("failure");
      expect(r.textResultForLlm).toMatch(SPENT);
      expect(h.st.clicked).toEqual([]);
      // (The twin can't be told from the control, so the retry is refused before any question, as before.)
      if (h.page.twin) return;
      await h.call("perceive_window", {});
      await h.call("click", { id: 54 });
      expect(h.st.asked).toHaveLength(2);
      expect(h.st.asked[1].startsWith(`${ASKING_AGAIN.page} `)).toBe(true);
    });
  }

  it("is spent where the control itself changed or went", async () => {
    for (const change of [(p: Page) => { p.send = "Send to everyone"; }, (p: Page) => { p.sendStates = ["enabled"]; }]) {
      const h = worker({ onAsk: change });
      await h.call("perceive_window", {});
      expect((await h.call("click", { id: 54 })).resultType).toBe("failure");
      expect(h.st.clicked).toEqual([]);
    }
  });

  it("still binds the whole window where the page's title speaks of money: a clock ticking there spends the yes", async () => {
    const h = worker({ title: "Checkout - Shop — Firefox", goal: "send my order", onAsk: p => { p.clock += 5; } });
    await h.call("perceive_window", {});
    const r = await h.call("click", { id: 54 });
    expect(r.textResultForLlm).toMatch(SPENT);
    expect(h.st.clicked).toEqual([]);
  });

  it("still binds the whole window in an app's own window: a label changing there spends the yes", async () => {
    const h = worker({ page: { native: true }, onAsk: p => { p.clock += 5; } });
    await h.call("perceive_window", {});
    const r = await h.call("click", { id: 54 });
    expect(r.textResultForLlm).toMatch(/^The user allowed this, but the window changed while they decided/);
    expect(h.st.clicked).toEqual([]);
  });

  it("still refuses a risky-named control whose page moved on where its surroundings can't be bound", async () => {
    const h = worker({ title: "Checkout - Shop — Firefox", goal: "send my order" });
    await h.call("perceive_window", {});
    h.page.comments.push("Second!");
    const r = await h.call("click", { id: 54 });
    expect(r.textResultForLlm).toBe("The window's controls changed, so nothing was done. Call perceive_window and use its new ids.");
    expect(h.st.asked).toEqual([]);
  });

  it("goes on taking an ordinary control with no question while the page lives, as before", async () => {
    const h = worker({ goal: "open the channel" });
    await h.call("perceive_window", {});
    h.page.clock = 4;
    expect((await h.call("click", { id: 41 })).resultType).toBe("success");
    expect(h.st.asked).toEqual([]);
  });
});
