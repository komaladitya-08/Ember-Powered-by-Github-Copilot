/**
 * A typing step's question carries the whole of the text it types (review #116, the rest of it): all of a text its
 * sentence cuts to two ends (Decision.detail), and fill_cells' cells each with all of its content, so the card can show
 * every character the user approves (confirm-whole-text.test.ts has the card's side).
 */

import { describe, expect, it } from "vitest";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";
import type { Question } from "../../app/main/agent/confirm";
import { Presenter } from "../../app/main/agent/presenter";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
/** A text over 160 characters whose middle the question's sentence leaves out. */
const LONG = `Dear team, ${"the figures are attached. ".repeat(4)}MIDDLE-SECRET-PAYLOAD ${"see you at lunch. ".repeat(5)}Bye`;

/** A worker whose every step is asked about, recording each question whole. */
function makeWorker() {
  const asked: Question[] = [];
  const window = { app: "gedit", pid: 1, name: "notes.txt", role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const node = { id: 1, parent: null, depth: 1, role: "entry", name: "Message", states: ["enabled", "editable", "focused"], bounds: { x: 10, y: 10, width: 200, height: 20 } };
  const seen = { window, x11Window: null, nodes: [node], blocked: false, ms: 0 };
  const deps = {
    client: {} as never, log: quiet, model: "m", vision: false, workDir: "/tmp",
    perception: { perceive: async () => ({ ...seen, text: "[1] entry \"Message\"", capture: null }), read: async () => seen, windows: async () => [window] } as never,
    sidecar: { readElement: async () => ({ role: node.role, name: node.name, states: node.states, bounds: node.bounds }) } as never,
    policy: new PolicyEngine({ neverLook: () => [], grants: () => ({}), confirmEveryAction: () => true, allowGrants: () => false }),
    confirmer: { ask: async (q: Question) => { asked.push(q); return "once"; } } as never,
    audit: { write: () => undefined } as never,
    settings: { get: () => ({ grants: {} }), update: () => undefined } as never,
    presenter: new Presenter(() => undefined),
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
  } as unknown as WorkerDeps;
  const w = new Worker(deps, { id: "t1", goal: "write to the team", target: { title: "notes.txt" } });
  const call = (name: string, args: Record<string, unknown>) => w.tools().find(t => t.name === name)!.handler!(args, {} as never);
  const authorize = (r: Partial<ActionRequest>) => (w as unknown as { authorize(r: ActionRequest): Promise<unknown> })
    .authorize({ taskId: "t1", kind: "text", app: "gedit", window: "notes.txt", element: { role: "entry", name: "Message" }, mode: "replace", currentText: "", ...r } as ActionRequest);
  const authorizeCells = (cells: { cell: string; text: string }[]) => (w as unknown as { authorizeCells(jobs: unknown[]): Promise<unknown> })
    .authorizeCells(cells.map((c, i) => ({ ...c, place: { col: 1, row: 5 + i }, seenKey: c.cell, expected: undefined, listed: undefined })));
  return { asked, call, authorize, authorizeCells };
}

describe("a typing step's question (worker)", () => {
  it("carries the whole of a text its sentence cuts to two ends, shown as the sentence shows typed text", async () => {
    const rig = makeWorker();
    await rig.call("perceive_window", {});
    expect(await rig.authorize({ value: LONG })).toBeNull();
    expect(rig.asked).toHaveLength(1);
    expect(rig.asked[0].prompt).not.toContain("MIDDLE-SECRET-PAYLOAD");
    expect(rig.asked[0].detail).toBe(LONG);
    // Borrowing the keyboard too, and shown as it will be typed: a line break as ⏎, a direction control marked.
    await rig.authorize({ kind: "cursor_text", value: `${LONG}\nline two\u{202e}` });
    expect(rig.asked[1].detail).toBe(`${LONG}⏎line two⟨RLO⟩`);
  });

  it("carries nothing more for a text its sentence shows whole", async () => {
    const rig = makeWorker();
    await rig.call("perceive_window", {});
    await rig.authorize({ value: "Hello there" });
    expect(rig.asked[0].prompt).toContain("“Hello there”");
    expect(rig.asked[0]).not.toHaveProperty("detail");
  });

  it("fill_cells: every cell with its whole content, once a value is cut short in the sentence", async () => {
    const rig = makeWorker();
    await rig.call("perceive_window", {});
    const formula = `=IF(A1>0;"${"x".repeat(40)}MIDDLE-SECRET-PAYLOAD${"y".repeat(20)}";0)`;
    await rig.authorizeCells([{ cell: "B5", text: "42" }, { cell: "B6", text: formula }, { cell: "B7", text: "" }]);
    expect(rig.asked[0].prompt).not.toContain("MIDDLE-SECRET-PAYLOAD");
    expect(rig.asked[0].detail).toBe(`B5 “42”\nB6 “${formula}”\nB7 emptied`);
    // Every value shown whole in the sentence: nothing more.
    await rig.authorizeCells([{ cell: "B5", text: "42" }, { cell: "B6", text: "=SUM(B1:B4)" }]);
    expect(rig.asked[1]).not.toHaveProperty("detail");
  });
});
