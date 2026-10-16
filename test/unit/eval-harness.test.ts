/**
 * M10: the evaluation harness drives Ember's real worker, so its scripts and its simulated user must
 * match what the worker and Ember's Confirmer accept today: every scripted tool call is checked against
 * the worker's own tool schemas, and the simulated user's answers are never dropped as too early.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { TaskSchema, type Task } from "../../eval/src/schema";
import { SIMULATED_ANSWER_MS, SIMULATED_USER_TIMING, simulatedUser } from "../../eval/src/runner";
import { MISSED_WAKES_MIN_CLIPS, missedWakesStatus } from "../../eval/src/gates";
import { Worker, type WorkerDeps } from "../../app/main/agent/worker";

const dir = path.resolve("eval/tasks");
const tasks = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().map(f => TaskSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
const task = (over: Partial<Task> = {}): Task => TaskSchema.parse({ id: "t", title: "T", instruction: "Do it", app: { none: true }, expect: [{ answer: { success: true } }], ...over });

/** The tools a worker offers the model for this task, as the runner sets it up (its hands decide the extras). */
function toolsFor(t: Task) {
  const deps = {
    client: {}, log: {}, model: "mock-model", vision: true, workDir: "/nonexistent",
    perception: {}, sidecar: {}, policy: {}, confirmer: {}, audit: {}, settings: {}, presenter: {},
    lease: async () => () => undefined, flyTo: () => undefined, onProgress: () => undefined,
    ...(t.hands.includes("cursor") ? { cursor: { borrow: {}, findWindow: () => 0, setBorrowing: () => undefined } } : {}),
    ...(t.hands.includes("desk") ? { desk: async () => ({}), onDesk: () => undefined } : {}),
  } as unknown as WorkerDeps;
  const worker = new Worker(deps, { id: t.id, goal: t.instruction, target: {}, mode: t.mode });
  return new Map(worker.tools().map(tool => [tool.name, tool.parameters as unknown as z.ZodObject<z.ZodRawShape>]));
}

describe("every task script", () => {
  it.each(tasks.filter(t => t.script.length).map(t => [t.id, t] as const))("%s calls only the worker's tools, with arguments they accept", (_id, t) => {
    const tools = toolsFor(t);
    t.script.forEach((call, step) => {
      const where = `${t.id} step ${step} (${call.tool})`;
      const schema = tools.get(call.tool);
      expect(schema, `${where}: no such tool for this task (mode ${t.mode}, hands ${t.hands.join(", ") || "none"})`).toBeDefined();
      // {find: regex} stands for an element id from the latest screen read.
      const args = Object.fromEntries(Object.entries(call.args).map(([k, v]) => [k, v && typeof v === "object" && "find" in v ? 1 : v]));
      const parsed = schema!.safeParse(args);
      expect(parsed.success, `${where}: ${parsed.success ? "" : parsed.error.issues.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")}`).toBe(true);
      // A misspelt optional argument would otherwise just be ignored.
      const unknown = Object.keys(args).filter(k => !(k in schema!.shape));
      expect(unknown, `${where}: arguments the tool doesn't take`).toEqual([]);
    });
  });
});

describe("the simulated user", () => {
  const options = [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }];

  it("can answer as soon as a question shows (Ember's Confirmer would drop an answer this early otherwise)", () => {
    expect(SIMULATED_USER_TIMING.armMs).toBeLessThanOrEqual(SIMULATED_ANSWER_MS);
    expect(SIMULATED_USER_TIMING.gapMs).toBe(0);
  });

  it("answers each question the way the task says, quickly, one after another", async () => {
    const questions: string[] = [];
    const confirmer = simulatedUser(task({ user: { answer: "allow", answers: [{ prompt: "Delete", answer: "deny" }], grants: [] } }), questions);
    const t0 = Date.now();
    const answers = await Promise.all([
      confirmer.ask({ title: "May I?", prompt: "Click “Save”?", options }),
      confirmer.ask({ title: "May I?", prompt: "Click “Delete all”?", options }),
      confirmer.ask({ title: "May I?", prompt: "Type “Hi”?", options }),
    ]);
    expect(answers).toEqual(["once", "deny", "once"]);
    expect(questions).toEqual(["Click “Save”?", "Click “Delete all”?", "Type “Hi”?"]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("the missed-wakes gate (target < 5 %)", () => {
  it("passes only when the 95 % upper bound is under 5 %, fails when the lower one is over, and otherwise can't tell", () => {
    expect(missedWakesStatus(0, 3)).toBe("not-measured"); // the test clips alone prove nothing
    expect(missedWakesStatus(0, 0)).toBe("not-measured");
    expect(MISSED_WAKES_MIN_CLIPS).toBe(73);
    expect(missedWakesStatus(0, 78)).toBe("pass"); // the full synthesized corpus, none missed
    expect(missedWakesStatus(1, 78)).toBe("not-measured");
    expect(missedWakesStatus(2, 3)).toBe("fail");
    expect(missedWakesStatus(20, 100)).toBe("fail");
  });
});
