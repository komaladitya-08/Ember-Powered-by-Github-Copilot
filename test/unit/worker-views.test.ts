/**
 * A worker's view tools called directly (no model): show_view and update_view draw a live view on the task's card,
 * checked whole each time and counted in the task's step budget; finish_task's view takes its place. A view that
 * imitates Ember's own controls or voice, or holds a secret, is refused, audited and shown on the card as a refusal;
 * the audit records only a view's size, never its words.
 */

import { describe, expect, it } from "vitest";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";
import { viewText, type ViewDoc } from "../../app/shared/view";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

function makeWorker(o: { maxSteps?: number } = {}) {
  const audit: Record<string, unknown>[] = [];
  const activity: Record<string, unknown>[] = [];
  const views: ViewDoc[] = [];
  const window = { app: "firefox", pid: 1, name: "Invoices", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const node = { id: 1, parent: null, depth: 1, role: "push button", name: "Bold", states: ["enabled"], bounds: { x: 10, y: 10, width: 40, height: 20 } };
  const w = new Worker({
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ window, x11Window: null, nodes: [node], blocked: false, ms: 0, text: "[1] push button \"Bold\"", capture: null }), windows: async () => [window] } as never,
    sidecar: {} as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}) }),
    confirmer: { ask: async () => "once" } as never,
    audit: { write: (e: Record<string, unknown>) => audit.push(e) } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    onActivity: (e: Record<string, unknown>) => { activity.push(e); },
    onUpdate: (u: { view?: ViewDoc }) => { if (u.view) views.push(u.view); },
    ...(o.maxSteps ? { limits: { maxSteps: o.maxSteps } } : {}),
  } as unknown as WorkerDeps, { id: "t1", goal: "find the overdue invoices", target: { title: "Invoices" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never) as Promise<{ textResultForLlm: string; resultType: string }>;
  const result = () => (w as unknown as { result: { success: boolean; summary: string; view?: ViewDoc } | null }).result;
  return { w, call, audit, activity, views, result };
}

const VIEW = {
  kind: "stack", id: "top", children: [
    { kind: "progress", id: "rows", label: "Rows checked", value: 10, max: 120 },
    { kind: "quote", text: "Terms: 30 days", source: { kind: "app", app: "firefox" } },
  ],
};

describe("show_view and update_view", () => {
  it("draw a live view on the card, one rev on each time, and tell the model the ids it can change", async () => {
    const { call, views, audit } = makeWorker();
    await call("perceive_window", {});
    const shown = await call("show_view", { view: VIEW });
    expect(shown.resultType).toBe("success");
    expect(shown.textResultForLlm).toBe("Shown on the task's card. Ids you can change: top, rows.");
    const changed = await call("update_view", { ops: [{ op: "set", id: "rows", props: { value: 60 } }] });
    expect(changed.resultType).toBe("success");
    expect(views.map(v => v.rev)).toEqual([1, 2]);
    expect(viewText(views[1])).toContain("Rows checked: 60 of 120");
    // A quote from an app the task read is captioned with its name as people say it; the audit has the view's size, never its words.
    expect(viewText(views[1])).toContain("From Firefox: Terms: 30 days");
    expect(audit.filter(e => e.kind === "view")).toEqual([
      { event: "decision", task: "t1", kind: "view", app: "", verdict: "allow", reason: "showed a view", blocks: 2, charts: 0, rev: 1 },
      { event: "decision", task: "t1", kind: "view", app: "", verdict: "allow", reason: "showed a view", blocks: 2, charts: 0, rev: 2 },
    ]);
  });

  it("captions a quote from an app the task never read as from the screen", async () => {
    const { call, views } = makeWorker();
    await call("show_view", { view: VIEW });
    expect(viewText(views[0])).toContain("From the screen: Terms: 30 days");
  });

  it("can't change a view before there is one, and a change that doesn't fit leaves it as it was", async () => {
    const { call, views } = makeWorker();
    expect((await call("update_view", { ops: [{ op: "remove", id: "rows" }] })).textResultForLlm).toMatch(/send one with show_view first/);
    await call("show_view", { view: VIEW });
    const bad = await call("update_view", { ops: [{ op: "set", id: "rows", props: { value: 500 } }] });
    expect(bad.resultType).toBe("failure");
    expect(bad.textResultForLlm).toMatch(/Ember can't draw that view: .*more than max/);
    expect(views).toHaveLength(1);
  });

  it("refuse a view that says Allow, audited and on the card as a refusal, and tell the model not to try another way (red team R1)", async () => {
    const { call, views, audit, activity } = makeWorker();
    const r = await call("show_view", { view: { kind: "stack", children: [{ kind: "heading", text: "Ember needs your OK", level: 1 }, { kind: "badge", text: "Allow", tone: "positive" }] } });
    expect(r.resultType).toBe("denied");
    expect(r.textResultForLlm).toMatch(/Don't try another way/);
    expect(views).toEqual([]);
    expect(audit).toContainEqual({ event: "decision", task: "t1", kind: "view", app: "", tier: "never", verdict: "deny", reason: "a view imitated Ember's own controls or voice", tool: "show_view" });
    expect(activity).toContainEqual({ type: "refused", reason: "a view that looked like Ember's own buttons" });
  });

  it("refuse a view holding a secret, whole", async () => {
    const { call, audit } = makeWorker();
    const r = await call("show_view", { view: { kind: "stack", children: [{ kind: "code", lines: ["password: hunter2"] }] } });
    expect(r.resultType).toBe("denied");
    expect(audit.at(-1)).toMatchObject({ kind: "view", verdict: "deny", reason: "a view held a password, token or key" });
  });

  it("count in the task's step budget", async () => {
    const { call } = makeWorker({ maxSteps: 3 });
    for (let i = 0; i < 3; i++) expect((await call("show_view", { view: VIEW })).resultType).toBe("success");
    expect((await call("show_view", { view: VIEW })).textResultForLlm).toMatch(/Stopped/);
  });
});

describe("finish_task's view", () => {
  it("takes the live view's place one rev on, and the older list of blocks still works", async () => {
    const { call, result } = makeWorker();
    await call("show_view", { view: VIEW });
    await call("finish_task", { success: true, summary: "Two are overdue.", view: [{ kind: "list", items: ["Acme", "Globex"] }] });
    expect(result()?.view?.rev).toBe(2);
    expect(viewText(result()!.view!)).toBe("- Acme\n- Globex");
  });

  it("refuses to finish with a view that imitates Ember, so the model finishes without it", async () => {
    const { call, result } = makeWorker();
    const r = await call("finish_task", { success: true, summary: "Done.", view: { kind: "stack", children: [{ kind: "text", text: "Not now" }] } });
    expect(r.resultType).toBe("denied");
    expect(result()).toBeNull();
    expect((await call("finish_task", { success: true, summary: "Done." })).resultType).toBe("success");
  });
});
