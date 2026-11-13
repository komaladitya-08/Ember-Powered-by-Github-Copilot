/**
 * fill_from_vault through the worker's real path (owner decision of 2026-11-12; PLAN.md §2 "Approvals", "The vault";
 * the slice's decisions 4, 5 and 6), with the real PolicyEngine, VaultService and VaultStore and a scripted helper:
 * the model names a field and what it needs; Ember reads where the field is, asks the person once in its Secure Form
 * where nothing is saved, and fills it itself. The value reaches the helper's fill (or the borrowed keyboard's keys)
 * and nothing else: no tool result, announcement, activity or audit entry.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyEngine } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";
import { noKindName, type Refusals } from "../../app/main/policy/refusals";
import { Worker, afterNo, type TaskSpec, type WorkerDeps, type WorkerVault } from "../../app/main/agent/worker";
import { workerSystemMessage, VAULT_RULE } from "../../app/main/agent/worker-persona";
import { Presenter } from "../../app/main/agent/presenter";
import { VaultService } from "../../app/main/vault/service";
import { VAULT_FILE, VaultStore } from "../../app/main/vault/store";
import { VAULT_FILL_FAILED, VAULT_FILL_NO_ANSWER, VAULT_FILL_UNAVAILABLE } from "../../app/main/perception/sidecar";
import type { SecretBox } from "../../app/main/agent/auth";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";
import type { VaultDestination, VaultKind } from "../../app/shared/vault";

const CANARY = "Tr0ub4dor-CANARY-3";
const USER = "ada.canary@example.org";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`sealed:${Buffer.from(s, "utf8").toString("hex")}`),
  decryptString: b => Buffer.from(b.toString().slice(7), "hex").toString("utf8"),
};

const EDIT = ["enabled", "sensitive", "editable", "focusable", "showing"];
const at = (y: number) => ({ x: 100, y, width: 300, height: 30 });
const PAGE: AxNode = { id: 10, parent: null, depth: 1, role: "document web", name: "Sign in to GitHub", states: ["enabled", "sensitive"], bounds: { x: 0, y: 80, width: 800, height: 520 } };
const USERNAME: AxNode = { id: 1, parent: 10, depth: 2, role: "entry", name: "Username or email address", states: EDIT, bounds: at(200) };
const PASSWORD: AxNode = { id: 2, parent: 10, depth: 2, role: "password text", name: "Password", states: EDIT, bounds: at(250) };
const SIGN_IN: AxNode = { id: 3, parent: 10, depth: 2, role: "push button", name: "Sign in", states: ["enabled", "sensitive"], bounds: at(300) };
const SEARCH: AxNode = { id: 4, parent: 10, depth: 2, role: "entry", name: "Search", states: EDIT, bounds: at(100) };
const BAR: AxNode = { id: 5, parent: null, depth: 1, role: "entry", name: "Search with Google or enter address", states: EDIT, bounds: { x: 100, y: 40, width: 500, height: 30 } };
const GITHUB: VaultDestination = { site: "https://github.com" };

interface Opts {
  app?: string; title?: string; nodes?: AxNode[];
  /** What the helper says of the pages around a field (null: it can't tell). */
  pages?: (id: number) => string[] | null;
  /** What is saved before the task starts. */
  saved?: [VaultKind, VaultDestination, Record<string, string>][];
  /** What the person does in the Secure Form, in turn: values they save, null for a form they close, or "unavailable" for one that could keep nothing. */
  form?: (Record<string, string> | null | "unavailable")[];
  autopilot?: () => boolean; vaultAllowed?: () => boolean; consented?: () => boolean;
  promptOpen?: () => boolean | "unchecked";
  /** How the helper's fill goes. */
  put?: (id: number, text: string) => Promise<{ ok: boolean; took?: boolean }>;
  spec?: Partial<TaskSpec>; target?: unknown; desk?: boolean; neverLook?: string[];
  /** What the borrowed keyboard's own check says of text. */
  checkTyping?: (text: string) => void;
  /** How telling the helper a field is secret goes (before keys are typed into it). */
  mark?: (id: number) => Promise<void>;
  /** What a read with a picture says of the window's elements (default: as the harness's nodes), with a picture. */
  pictured?: () => AxNode[];
}

async function worker(o: Opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-fill-"));
  dirs.push(dir);
  const audit: Record<string, unknown>[] = [];
  const activity: Record<string, unknown>[] = [];
  const said: string[] = [];
  const logged: unknown[] = [];
  const progress: string[] = [];
  /** Every place a value was handed to: the helper's fill, or keys. */
  const put: { id: number; text: string; how: "accessibility" | "keys" }[] = [];
  const hand: string[] = [];
  const forms: { kind: string; dest: VaultDestination; where: string; via: string | null }[] = [];
  const pagesAsked: number[] = [];
  const state = { focused: 0, clipboard: 0, borrows: 0 };
  const note = (m: string, f?: unknown) => { logged.push([m, f]); };
  const log = { debug: note, info: note, warn: note, error: note, child() { return log; } } as unknown as Logger;
  const on = o.autopilot ?? (() => true);
  const allowed = o.vaultAllowed ?? (() => true);
  const store = new VaultStore(path.join(dir, VAULT_FILE), box);
  for (const [kind, dest, values] of o.saved ?? []) expect((await store.add(kind, dest, values)).ok).toBe(true);
  const answers = [...(o.form ?? [])];
  const service: VaultService = new VaultService({
    store, allowed, consented: o.consented ?? (() => true), autopilot: on, appName: k => k, log,
    form: {
      ask: async req => {
        forms.push({ kind: req.kind, dest: req.dest, where: req.where, via: req.via });
        const typed = answers.shift() ?? null;
        if (typed === "unavailable") return "unavailable";
        if (!typed) return "cancelled";
        return (await service.keep(req.kind, req.dest, typed)).ok ? "saved" : "cancelled";
      },
      stop: () => {},
    },
  });
  const nodes = o.nodes ?? [BAR, PAGE, SEARCH, USERNAME, PASSWORD, SIGN_IN];
  const window = { app: o.app ?? "firefox", pid: 7, name: o.title ?? "Sign in to GitHub — Mozilla Firefox", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const seen = { window, x11Window: null, nodes, blocked: false, ms: 0 };
  const pages = o.pages ?? ((id: number) => (nodes.find(n => n.id === id)?.parent === 10 ? ["https://github.com/login"] : []));
  const vault: WorkerVault = {
    usable: () => service.usable(), has: (k, d) => service.has(k, d), ask: (k, d, via) => service.ask(k, d, via), use: (k, p, d, fn) => service.use(k, p, d, fn),
    pages: async id => { pagesAsked.push(id); const p = pages(id); if (p === null) throw new Error("the helper can't tell"); return p; },
    put: async (id, text) => { put.push({ id, text, how: "accessibility" }); return o.put ? o.put(id, text) : { ok: true, took: true }; },
    mark: async id => { hand.push(`mark ${id}`); await o.mark?.(id); },
  };
  const presenter = new Presenter(() => undefined);
  vi.spyOn(presenter, "workedWithoutAsking").mockImplementation(text => { said.push(text); });
  const fakeHand = {
    glideTo: async (x: number, y: number) => { hand.push(`glide ${x},${y}`); },
    click: async () => { hand.push("click"); state.focused = 2; },
    keys: async (k: string) => { hand.push(`keys ${k}`); },
    type: async (t: string) => { put.push({ id: state.focused, text: t, how: "keys" }); hand.push("type"); },
    checkTyping: (t: string) => { o.checkTyping?.(t); },
    checkKeys: () => {},
    scroll: async () => {},
  };
  const w = new Worker({
    client: {} as never, log, model: "m", vision: !!o.pictured, workDir: "/tmp",
    perception: {
      perceive: async (q: { image: boolean }) => ({ ...seen, ...(o.pictured ? { nodes: o.pictured() } : {}), text: "<screen>",
        capture: o.pictured && q.image ? { rect: window.bounds, data: Buffer.from("pixels"), mimeType: "image/jpeg", width: 800, height: 600, scale: 1 } : null }), read: async () => seen, windows: async () => [window], systemDialogOpen: async () => false,
      ...(o.promptOpen ? { promptOpen: async () => o.promptOpen!() } : {}),
    } as never,
    sidecar: {
      readElement: async (id: number) => {
        const n = nodes.find(x => x.id === id);
        return n ? { role: n.role, name: n.name, states: state.focused === id ? [...n.states, "focused"] : n.states, bounds: n.bounds, ...(n.secret ? { secret: true } : {}) } : null;
      },
      setText: async () => { throw new Error("ordinary typing reached the helper"); },
    } as never,
    policy: new PolicyEngine({ neverLook: () => o.neverLook ?? [], grants: () => ({}), autonomy: () => ({ ...ALL_SCOPES }), trustAskedApps: () => true, autopilot: on, vaultAllowed: allowed,
      isTerminalApp: n => /terminal/i.test(n) }),
    autonomy: () => ({ ...ALL_SCOPES }), autopilot: on,
    confirmer: { ask: async () => { throw new Error("a question was asked"); } } as never,
    audit: { write: (e: Record<string, unknown>) => { audit.push(e); } } as never,
    settings: { get: () => ({ grants: {}, screenImages: true }), update: () => undefined } as never,
    presenter,
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: (t: string) => { progress.push(t); },
    onActivity: (e: Record<string, unknown>) => { activity.push(e); },
    cursor: {
      borrow: { borrow: async (fn: (h: typeof fakeHand) => Promise<void>, opts: { preflight?: (h: typeof fakeHand) => void }) => { state.borrows++; opts.preflight?.(fakeHand); await fn(fakeHand); } } as never,
      findWindow: () => 1, setBorrowing: () => undefined,
    },
    clipboard: { save: async () => { state.clipboard++; return { items: [] }; }, writeText: async () => { state.clipboard++; }, restore: async () => { state.clipboard++; }, unchanged: async () => true } as never,
    vault,
    ...(o.target ? { target: o.target } : {}),
    ...(o.desk ? { desk: async () => { throw new Error("no desk in this test"); } } : {}),
  } as unknown as WorkerDeps, { id: "t1", goal: "Sign in to GitHub", userWords: "sign me in to github", target: { title: window.name }, ...o.spec });
  const tool = (name: string) => w.tools().find(t => t.name === name);
  const call = (name: string, args: Record<string, unknown>) => tool(name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const inner = w as unknown as { userTookOver: boolean; tainted: boolean; stopNow(why?: string): void };
  /** Everything a model, a person looking at the card, the audit log or Ember's log could be shown. */
  const everything = (results: unknown[] = []) => JSON.stringify([results, audit, activity, said, logged, progress, hand]);
  return { w, tool, call, inner, service, store, audit, activity, said, logged, progress, put, hand, forms, pagesAsked, state, nodes, everything,
    decisions: () => audit.filter(e => e.event === "decision"), actions: () => audit.filter(e => e.event === "action") };
}

const LOGIN: [VaultKind, VaultDestination, Record<string, string>] = ["login", GITHUB, { user: USER, password: CANARY }];

describe("fill_from_vault, where an entry is bound to the field's own site (vault-2)", () => {
  it("fills a password field by the helper's own fill, announced by kind and app, audited with kind and destination, and tells the model only that it was filled", async () => {
    const h = await worker({ saved: [LOGIN] });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("success");
    expect(r.textResultForLlm).toMatch(/^Filled from the vault\./);
    expect(h.put).toEqual([{ id: 2, text: CANARY, how: "accessibility" }]);
    expect(h.said).toEqual(["Filling a saved password in Firefox, from the vault: Autopilot is on."]);
    expect(h.forms).toEqual([]);
    expect(h.decisions()).toHaveLength(1);
    expect(h.decisions()[0]).toMatchObject({ kind: "vault_fill", verdict: "allow", autonomy: true, mode: "autopilot", element: { role: "password text", name: "Password" } });
    expect(h.actions()).toEqual([{ event: "action", task: "t1", kind: "vault_fill", app: "firefox", window: "Sign in to GitHub — Mozilla Firefox",
      element: { role: "password text", name: "Password" }, ok: true, vault: { kind: "login", part: "password", site: "https://github.com" }, via: "accessibility" }]);
    // The decision is written before the fill, the fill after it.
    expect(h.audit.map(e => e.event)).toEqual(["decision", "action"]);
    // Never the value, nor its length, anywhere but the helper's fill.
    expect(h.everything([r])).not.toContain(CANARY);
    expect(h.everything([r])).not.toMatch(new RegExp(`\\b${CANARY.length}\\b`));
    expect(h.state.clipboard).toBe(0);
    expect(h.state.borrows).toBe(0);
  });

  it("fills the user name beside it, and a field it filled is secret to the task from then on", async () => {
    const h = await worker({ saved: [LOGIN] });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 1, what: "user name" });
    expect(r.resultType).toBe("success");
    expect(h.put).toEqual([{ id: 1, text: USER, how: "accessibility" }]);
    expect(h.said).toEqual(["Filling a saved user name in Firefox, from the vault: Autopilot is on."]);
    expect(h.everything([r])).not.toContain("canary");
    // Typing over it, or reading it back by typing, is refused as for any secret field.
    const typed = await h.call("type_text", { id: 1, text: "x", mode: "append" });
    expect(typed.resultType).toBe("denied");
    expect(h.decisions().at(-1)).toMatchObject({ kind: "text", verdict: "deny", tier: "never" });
    // Filling the same detail there again (the form came back) is still the vault's to do.
    expect((await h.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("success");
    expect((await h.call("fill_from_vault", { id: 1, what: "password" })).resultType).toBe("denied");
  });

  it("offers the tool with its own rule only where the vault may be used when the task starts", async () => {
    const on = await worker({ saved: [LOGIN] });
    expect(on.tool("fill_from_vault")).toBeDefined();
    expect(Object.keys((on.tool("fill_from_vault")!.parameters as { shape: Record<string, unknown> }).shape).sort()).toEqual(["id", "what"]);
    for (const o of [{ autopilot: () => false }, { vaultAllowed: () => false }, { consented: () => false }, { spec: { mode: "guide" as const } },
      { target: { id: "ssh:1", kind: "ssh", label: "build-01", screenOs: "linux", shellOs: "linux", desktop: "screen" } },
      { target: { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu", screenOs: "win32", shellOs: "linux", desktop: "screen" } }] as Opts[]) {
      expect((await worker({ saved: [LOGIN], ...o })).tool("fill_from_vault")).toBeUndefined();
    }
    const rules = JSON.stringify(workerSystemMessage({ vault: true }));
    expect(rules).toContain(VAULT_RULE.slice(0, 60));
    expect(JSON.stringify(workerSystemMessage())).toContain("Never fill in passwords or payment details, and never act in password or authentication dialogs: those are for the user.");
    expect(JSON.stringify(workerSystemMessage())).not.toContain("fill_from_vault");
  });
});

describe("fill_from_vault, in every mode but Autopilot (vault-2)", () => {
  it("fills nothing once Autopilot is no longer the mode in force, with no form and no helper call", async () => {
    for (const drop of ["mode", "organisation"] as const) {
      let on = true;
      const h = await worker({ saved: [LOGIN], ...(drop === "mode" ? { autopilot: () => on } : { vaultAllowed: () => on }) });
      await h.call("perceive_window", {});
      const tools = h.w.tools();
      on = false;
      const r = await (tools.find(t => t.name === "fill_from_vault")!.handler!({ id: 2, what: "password" }, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>);
      expect(r.resultType).toBe("denied");
      expect(h.put).toEqual([]);
      expect(h.forms).toEqual([]);
      expect(h.said).toEqual([]);
      expect(h.decisions()).toEqual([expect.objectContaining({ kind: "vault_fill", verdict: "deny", tier: "never" })]);
      expect(h.everything([r])).not.toContain(CANARY);
    }
  });

  it("fills nothing when the mode changes while the Secure Form is up, though the person saved", async () => {
    let on = true;
    const h = await worker({ autopilot: () => on, form: [{ user: USER, password: CANARY }] });
    await h.call("perceive_window", {});
    const ask = h.service.ask.bind(h.service);
    h.service.ask = async (...a) => { const r = await ask(...a); on = false; return r; };
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("denied");
    expect(h.put).toEqual([]);
    expect(h.said).toEqual([]);
  });
});

describe("fill_from_vault and what a field belongs to (vault-2)", () => {
  it("never fills an entry into another site: a look-alike host is another destination, which the form names as it is", async () => {
    for (const page of ["https://github.com.evil.example/login", "https://xn--gthub-cta.com/login", "http://github.com/login", "https://github.com:8443/login"]) {
      const h = await worker({ saved: [LOGIN], pages: id => (id === 5 ? [] : [page]) });
      await h.call("perceive_window", {});
      const r = await h.call("fill_from_vault", { id: 2, what: "password" });
      expect([page, r.resultType]).toEqual([page, "denied"]);
      expect(h.put).toEqual([]);
      // Nothing is saved for that place, so the person is asked, and sees the place it really is.
      expect(h.forms).toHaveLength(1);
      expect(h.forms[0].dest).toEqual({ site: new URL(page).origin });
      expect(h.forms[0].where).not.toBe("github.com");
      expect(h.said).toEqual([]);
      expect(h.everything([r])).not.toContain(CANARY);
    }
  });

  it("fills nothing where the page's address can't be read, isn't a web address, or a frame is from another site, before any form", async () => {
    const cases: ((id: number) => string[] | null)[] = [() => null, () => [], () => [""], () => ["about:blank"], () => ["file:///home/u/login.html"],
      () => ["https://github.com/session", "https://evil.example/wrapper"], () => ["https://evil.example/frame", "https://github.com/login"]];
    for (const pages of cases) {
      const h = await worker({ saved: [LOGIN], pages });
      await h.call("perceive_window", {});
      const r = await h.call("fill_from_vault", { id: 2, what: "password" });
      expect(r.resultType).toBe("denied");
      expect(h.put).toEqual([]);
      expect(h.forms).toEqual([]);
      expect(h.decisions()).toEqual([expect.objectContaining({ kind: "vault_fill", verdict: "deny", tier: "never" })]);
      // The reason is Ember's own words: no address from the screen is in the record.
      expect(JSON.stringify(h.decisions())).not.toMatch(/evil\.example|about:blank|login\.html/);
    }
  });

  it("never fills an app's entry into another app, or a site's entry into an app's own window", async () => {
    const field: AxNode = { ...PASSWORD, id: 2, parent: null, depth: 1 };
    const saved: Opts["saved"] = [["login", { app: "thunderbird" }, { password: CANARY }], LOGIN];
    const other = await worker({ saved, app: "evolution", title: "Mail account password", nodes: [field], pages: () => [] });
    await other.call("perceive_window", {});
    expect((await other.call("fill_from_vault", { id: 2, what: "password" })).resultType).toBe("denied");
    expect(other.put).toEqual([]);
    expect(other.forms.map(f => f.dest)).toEqual([{ app: "evolution" }]);
    // The app it was given for takes it.
    const own = await worker({ saved, app: "Thunderbird", title: "Mail account password", nodes: [field], pages: () => [] });
    await own.call("perceive_window", {});
    expect((await own.call("fill_from_vault", { id: 2, what: "password" })).resultType).toBe("success");
    expect(own.put).toEqual([{ id: 2, text: CANARY, how: "accessibility" }]);
    expect(own.actions()[0]).toMatchObject({ vault: { kind: "login", part: "password", app: "thunderbird" } });
    // A browser's own field belongs to no site and to no app's sign-in.
    const browser = await worker({ saved: [["login", { app: "firefox" }, { password: CANARY }]], nodes: [field], pages: () => [] });
    await browser.call("perceive_window", {});
    expect((await browser.call("fill_from_vault", { id: 2, what: "password" })).resultType).toBe("denied");
    expect(browser.put).toEqual([]);
    expect(browser.forms).toEqual([]);
  });

  it("fills nothing when the page changed between the decision and the fill", async () => {
    // The page as decided on is GitHub's; by the look right before the fill it is another site's.
    let reads = 0;
    const h = await worker({ saved: [LOGIN], pages: () => (++reads <= 1 ? ["https://github.com/login"] : ["https://evil.example/login"]) });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("denied");
    expect(r.textResultForLlm).toMatch(/changed before Ember could fill it/);
    expect(h.put).toEqual([]);
    expect(h.said).toEqual([]);
    expect(h.decisions().at(-1)).toMatchObject({ kind: "vault_fill", verdict: "deny" });
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("fills nothing when the field itself changed while the Secure Form was up", async () => {
    const h = await worker({ form: [{ user: USER, password: CANARY }] });
    await h.call("perceive_window", {});
    const ask = h.service.ask.bind(h.service);
    // While the person types in the form, the page swaps the field for another one under the same id.
    h.service.ask = async (...a) => { const r = await ask(...a); h.nodes[h.nodes.findIndex(n => n.id === 2)] = { ...PASSWORD, name: "Confirm your bank PIN" }; return r; };
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("denied");
    expect(h.put).toEqual([]);
    expect(h.forms).toHaveLength(1);
  });
});

describe("fill_from_vault and the Secure Form (vault-2)", () => {
  it("asks the person once where nothing is saved, then fills what they saved, which the model never sees", async () => {
    const h = await worker({ form: [{ user: USER, password: CANARY }] });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("success");
    expect(h.forms).toEqual([{ kind: "login", dest: GITHUB, where: "github.com", via: "firefox" }]);
    expect(h.put).toEqual([{ id: 2, text: CANARY, how: "accessibility" }]);
    // The user name comes from the same entry: no second form.
    expect((await h.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("success");
    expect(h.forms).toHaveLength(1);
    expect(h.everything([r])).not.toContain(CANARY);
  });

  it("keeps a form closed without an answer as a refusal for the task: never asked again in it, and the model told only that nothing was filled", async () => {
    const h = await worker({ form: [null, { password: CANARY }] });
    await h.call("perceive_window", {});
    const first = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(first.resultType).toBe("denied");
    expect(first.textResultForLlm).toMatch(/closed Ember's Secure Form without saving, so nothing was filled/);
    expect(h.forms).toHaveLength(1);
    // Again, and by another part of the same entry: no form.
    await h.call("perceive_window", {});
    const again = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(again.resultType).toBe("denied");
    await h.call("perceive_window", {});
    expect((await h.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("denied");
    expect(h.forms).toHaveLength(1);
    expect(h.put).toEqual([]);
    expect(h.decisions().filter(d => d.verdict === "deny").map(d => d.reason)).toEqual([
      "the user closed Ember's Secure Form without saving", "the user closed Ember's Secure Form for this earlier in the task", "the user closed Ember's Secure Form for this earlier in the task"]);
  });

  it("says when the entry holds no such part, without announcing a fill", async () => {
    const h = await worker({ saved: [["login", GITHUB, { password: CANARY }]] });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 1, what: "user name" });
    expect(r.resultType).toBe("denied");
    expect(r.textResultForLlm).toMatch(/no such detail saved/);
    expect(h.put).toEqual([]);
    expect(h.said).toEqual([]);
  });
});

describe("fill_from_vault and what the user turned down earlier in the task (the vault with the refused-step book)", () => {
  it("fills nothing and opens no Secure Form where the fill may be a step the user said no to in this app, since Autopilot has no question to put", async () => {
    for (const saved of [[LOGIN], []]) {
      const h = await worker({ saved, form: [{ user: USER, password: CANARY }] });
      // A risky step that names no kind was refused in Firefox earlier in this task (Refusals: "may be" that step).
      (h.w as unknown as { refusals: Refusals }).refusals.noteStep([noKindName("firefox")], "refused");
      await h.call("perceive_window", {});
      const r = await h.call("fill_from_vault", { id: 2, what: "password" });
      expect(r.resultType).toBe("denied");
      expect(h.put).toEqual([]);
      expect(h.forms).toEqual([]);
      expect(h.said).toEqual([]);
      expect(h.decisions().map(d => d.verdict)).toEqual(["deny"]);
      expect(h.everything([r])).not.toContain(CANARY);
    }
  });

  it("refuses the same detail typed into the field after the user closed the Secure Form for it, with no question or announcement (integ-x-2)", async () => {
    const h = await worker({ form: [null] });
    await h.call("perceive_window", {});
    expect((await h.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("denied");
    // The model types what the form was for itself: the same thing done another way.
    const typed = await h.call("type_text", { id: 1, text: USER, mode: "replace" });
    expect(typed.resultType).toBe("denied");
    expect(typed.textResultForLlm).toMatch(/already said no to this step/);
    expect(h.decisions().map(d => [d.kind, d.verdict, d.reason])).toEqual([
      ["vault_fill", "deny", "the user closed Ember's Secure Form without saving"],
      ["text", "deny", "the user said no to this step earlier in this task"]]);
    expect(h.said).toEqual([]);
    expect(h.actions()).toEqual([]);
    // Key by key into that field is the same step too; a key that types nothing there, and typing elsewhere, are not.
    const field = { role: USERNAME.role, name: USERNAME.name };
    const names = (kind: string, element: unknown, value?: string) =>
      (h.w as unknown as { namesFor(r: unknown): string[]; refusals: Refusals }).namesFor({ kind, element, value });
    const book = (h.w as unknown as { refusals: Refusals }).refusals;
    expect(book.step(names("keys", field, "a"))).toBe("refused");
    expect(book.step(names("cursor_text", field, USER))).toBe("refused");
    expect(book.step(names("keys", field, "Tab"))).toBeNull();
    expect(book.step(names("text", { role: SEARCH.role, name: SEARCH.name }, "github"))).toBeNull();
    expect(book.step(names("keys", { role: SEARCH.role, name: SEARCH.name }, "a"))).toBeNull();
  });

  it("ends the task as the user's no, never as done, after they closed the Secure Form and nothing was done since (integ-x-3)", async () => {
    const h = await worker({ form: [null] });
    await h.call("perceive_window", {});
    await h.call("fill_from_vault", { id: 2, what: "password" });
    const flags = h.w as unknown as { declined: boolean; expired: boolean; worked: boolean; saidNoThisTask: boolean };
    expect(flags.saidNoThisTask).toBe(true);
    expect(afterNo({ declined: flags.declined, expired: flags.expired, worked: flags.worked }, { success: true, summary: "Signed you in." }))
      .toEqual({ success: false, stopped: true, declined: true, summary: "You said not now, so I left it. Signed you in." });
    // A fill refused for any other reason is nobody's no.
    const other = await worker({ saved: [["login", GITHUB, { password: CANARY }]] });
    await other.call("perceive_window", {});
    expect((await other.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("denied");
    const kept = other.w as unknown as { declined: boolean; saidNoThisTask: boolean };
    expect([kept.declined, kept.saidNoThisTask]).toEqual([false, false]);
  });
});

describe("fill_from_vault and a Secure Form that could keep nothing (integ-y-2)", () => {
  it("is nobody's no: the task isn't held as one the user said no in, the field isn't kept as refused, and the audit says the form couldn't keep anything (integ-y-2)", async () => {
    // The form was shown without a keyring, or its Save was refused by the keyring or the disk, and then closed.
    const h = await worker({ form: ["unavailable", { user: USER, password: CANARY }] });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 1, what: "user name" });
    expect(r.resultType).toBe("denied");
    expect(r.textResultForLlm).not.toMatch(/user closed|said no/i);
    const flags = h.w as unknown as { declined: boolean; expired: boolean; worked: boolean; saidNoThisTask: boolean };
    expect([flags.declined, flags.saidNoThisTask]).toEqual([false, false]);
    // The task ends in the worker's own words, never as "You said not now".
    expect(afterNo({ declined: flags.declined, expired: flags.expired, worked: flags.worked }, { success: false, summary: "This computer can't keep your login." })).toBeNull();
    expect(h.decisions().map(d => [d.kind, d.verdict, d.reason])).toEqual([
      ["vault_fill", "deny", "Ember's Secure Form couldn't keep anything on this computer: it has no keyring, couldn't save or couldn't be shown"]]);
    // Nothing is kept as refused: the form may be asked again in this task, and typing into the field is judged as any typing.
    const book = (h.w as unknown as { refusals: Refusals; namesFor(r: unknown): string[] });
    expect(book.refusals.step(book.namesFor({ kind: "text", element: { role: USERNAME.role, name: USERNAME.name }, value: USER }))).toBeNull();
    expect((await h.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("success");
    expect(h.forms).toHaveLength(2);
    expect(h.everything([r])).not.toContain(CANARY);
  });

  it("stays the user's no where the form could keep values and was closed without a Save (integ-y-2, integ-x-3)", async () => {
    const h = await worker({ form: [null] });
    await h.call("perceive_window", {});
    await h.call("fill_from_vault", { id: 1, what: "user name" });
    const flags = h.w as unknown as { declined: boolean; saidNoThisTask: boolean };
    expect([flags.declined, flags.saidNoThisTask]).toEqual([true, true]);
    expect(h.decisions().map(d => d.reason)).toEqual(["the user closed Ember's Secure Form without saving"]);
  });
});

describe("fill_from_vault and every \"never\" (vault-2)", () => {
  it("fills nothing in the system's own authentication prompts, Ember's windows, never-look windows or terminals, in Autopilot", async () => {
    const field: AxNode = { ...PASSWORD, parent: null, depth: 1 };
    const cases: Opts[] = [
      { app: "polkit-gnome-authentication-agent-1", title: "Authentication Required" },
      { app: "gcr-prompter", title: "Unlock Login Keyring" },
      { app: "pinentry-gnome3", title: "pinentry" },
      { app: "ssh-askpass", title: "OpenSSH Authentication Passphrase request" },
      { app: "ember", title: "Ember" },
      { app: "keepassxc", title: "Passwords - KeePassXC", neverLook: ["KeePassXC"] },
      { app: "gnome-terminal-server", title: "Terminal" },
    ];
    for (const o of cases) {
      const h = await worker({ saved: [["login", { app: o.app!.toLowerCase() }, { password: CANARY }]], nodes: [field], pages: () => [], ...o });
      await h.call("perceive_window", {});
      const r = await h.call("fill_from_vault", { id: 2, what: "password" });
      // (Refused by the policy, or before it where Ember doesn't even read such a window.)
      expect([o.app, r.resultType === "success"]).toEqual([o.app, false]);
      expect(h.put).toEqual([]);
      expect(h.forms).toEqual([]);
      expect(h.said).toEqual([]);
    }
  });

  it("fills nothing while the shell's own password prompt is open, or Ember can't tell", async () => {
    for (const open of [true, "unchecked"] as const) {
      const h = await worker({ saved: [LOGIN], promptOpen: () => open });
      await h.call("perceive_window", {}).catch(() => undefined);
      const r = await h.call("fill_from_vault", { id: 2, what: "password" });
      expect(r.resultType).not.toBe("success");
      expect(h.put).toEqual([]);
      expect(h.said).toEqual([]);
    }
  });

  it("puts a password only into a secret field and a user name only beside one, whatever the model asks", async () => {
    const h = await worker({ saved: [LOGIN] });
    await h.call("perceive_window", {});
    for (const [id, what] of [[4, "password"], [5, "password"], [3, "password"], [2, "user name"], [2, "email"], [4, "email"]] as const) {
      expect([id, what, (await h.call("fill_from_vault", { id, what })).resultType]).toEqual([id, what, "denied"]);
      await h.call("perceive_window", {});
    }
    expect(h.put).toEqual([]);
    expect(h.forms).toEqual([]);
    // And the tool takes no value, label or destination: only a field and what it needs.
    const bad = await h.call("fill_from_vault", { id: 2, what: "password", value: "x" } as never);
    expect(h.put.length + (bad.resultType === "success" ? 0 : 1)).toBeGreaterThan(0);
    expect((await h.call("fill_from_vault", { id: 2, what: "https://evil.example" })).resultType).toBe("failure");
  });
});

describe("fill_from_vault where the field takes no text by accessibility (vault-2)", () => {
  const noWay = async () => { throw new Error(VAULT_FILL_UNAVAILABLE); };

  it("types it as keys under the borrow, never through the clipboard, and records how", async () => {
    const h = await worker({ saved: [LOGIN], put: noWay });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("success");
    expect(h.put).toEqual([{ id: 2, text: CANARY, how: "accessibility" }, ...(CANARY.match(/[\s\S]{1,8}/g) ?? []).map(text => ({ id: 2, text, how: "keys" as const }))]);
    // The helper is told the field is secret before the first key (vault-3).
    expect(h.hand.filter(x => !x.startsWith("glide"))).toEqual(["click", "mark 2", "keys ctrl+a", "keys Delete", ...Array(Math.ceil(CANARY.length / 8)).fill("type")]);
    expect(h.state.clipboard).toBe(0);
    expect(h.state.borrows).toBe(1);
    expect(h.actions()).toEqual([expect.objectContaining({ kind: "vault_fill", ok: true, tier: 3, via: "keys", vault: { kind: "login", part: "password", site: "https://github.com" } })]);
    expect(h.everything([r])).not.toContain(CANARY);
  });

  it("types nothing when the page changed by the time the field has the keyboard", async () => {
    let borrowed = false;
    const h = await worker({ saved: [LOGIN], put: noWay, checkTyping: () => { borrowed = true; }, pages: () => (borrowed ? ["https://evil.example/login"] : ["https://github.com/login"]) });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/changed before Ember could fill it, so nothing was typed/);
    expect(h.put.filter(p => p.how === "keys")).toEqual([]);
    expect(h.hand.some(x => x.startsWith("keys") || x === "type")).toBe(false);
    expect(h.actions()).toEqual([expect.objectContaining({ kind: "vault_fill", ok: false, tier: 3, via: "keys" })]);
  });

  it("types nothing the keyboard can't type, and passes on nothing the keyboard says of it", async () => {
    const h = await worker({ saved: [["login", GITHUB, { password: "pässwörd-CANARY" }]], put: noWay });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("denied");
    expect(h.state.borrows).toBe(0);
    expect(h.put.filter(p => p.how === "keys")).toEqual([]);
    // A layout that can't type one of its characters says which: that never reaches the model or the record.
    const layout = await worker({ saved: [LOGIN], put: noWay, checkTyping: t => { throw new Error(`The keyboard layout in use can't type “${t[0]}${t.slice(1)}”, so Ember typed nothing.`); } });
    await layout.call("perceive_window", {});
    const said = await layout.call("fill_from_vault", { id: 2, what: "password" });
    expect(said.resultType).toBe("failure");
    expect(layout.put.filter(p => p.how === "keys")).toEqual([]);
    expect(layout.everything([said])).not.toContain(CANARY);
  });

  it("borrows nothing for it after the user took the mouse back in this task", async () => {
    const h = await worker({ saved: [LOGIN], put: noWay });
    await h.call("perceive_window", {});
    h.inner.userTookOver = true;
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("denied");
    expect(h.state.borrows).toBe(0);
    expect(h.put.filter(p => p.how === "keys")).toEqual([]);
  });

  it("doesn't type after an app that didn't answer or refused: it says so, and never what the helper said", async () => {
    for (const [msg, words] of [[VAULT_FILL_NO_ANSWER, /unknown whether the field was filled/], [VAULT_FILL_FAILED, /didn't take it/]] as const) {
      const h = await worker({ saved: [LOGIN], put: async () => { throw new Error(msg); } });
      await h.call("perceive_window", {});
      const r = await h.call("fill_from_vault", { id: 2, what: "password" });
      expect(r.resultType).toBe("failure");
      expect(r.textResultForLlm).toMatch(words);
      expect(h.state.borrows).toBe(0);
      expect(h.actions()).toEqual([expect.objectContaining({ kind: "vault_fill", ok: false, via: "accessibility" })]);
    }
    const short = await worker({ saved: [LOGIN], put: async () => ({ ok: true, took: false }) });
    await short.call("perceive_window", {});
    expect((await short.call("fill_from_vault", { id: 2, what: "password" })).textResultForLlm).toMatch(/didn't take all of what the vault holds/);
  });
});

describe("after a fill from the vault (vault-3)", () => {
  it("types nothing into a field the helper couldn't be told is secret: no read or picture could be kept clear of it", async () => {
    const h = await worker({ saved: [LOGIN], put: async () => { throw new Error(VAULT_FILL_UNAVAILABLE); }, mark: async () => { throw new Error("the helper is down"); } });
    await h.call("perceive_window", {});
    const r = await h.call("fill_from_vault", { id: 2, what: "password" });
    expect(r.resultType).toBe("failure");
    expect(r.textResultForLlm).toMatch(/so nothing was typed/);
    expect(h.put.filter(p => p.how === "keys")).toEqual([]);
    expect(h.hand).not.toContain("keys ctrl+a");
    expect(h.everything([r])).not.toContain(CANARY);
  });

  it("sends no picture in which a field it filled shows as an ordinary field, and sends one where the read found it secret", async () => {
    let secret = false;
    const h = await worker({ saved: [LOGIN], pictured: () => [BAR, PAGE, SEARCH, { ...USERNAME, ...(secret ? { secret: true } : {}) }, PASSWORD, SIGN_IN] });
    const look = () => h.call("perceive_window", { image: true }) as Promise<{ textResultForLlm: string; resultType: string; binaryResultsForLlm?: unknown[] }>;
    expect((await look()).binaryResultsForLlm).toHaveLength(1); // before any fill, pictures go as ever
    expect((await h.call("fill_from_vault", { id: 1, what: "user name" })).resultType).toBe("success");
    const shown = await look();
    expect(shown.binaryResultsForLlm).toBeUndefined();
    expect(shown.textResultForLlm).toContain("(No screenshot: a field Ember filled from its vault couldn't be hidden in it. Work from the text.)");
    expect(h.audit.filter(e => e.kind === "screenshot")).toHaveLength(1);
    secret = true;
    expect((await look()).binaryResultsForLlm).toHaveLength(1);
  });
});
