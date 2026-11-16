/** Real pinned SDK + AgentHost/conductor, deterministic local model and inert workers with held disposal gates.
 * This proves a same-request parallel join and summary, not desktop execution, provider acceptance or native isolation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AgentHost } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { createLogger } from "../../app/main/logger";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import type { OS } from "../../app/shared/shortcuts";
import type { TaskSpec } from "../../app/main/agent/worker";
// @ts-expect-error -- fixed offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

it("delegates two independent workers, awaits their positive disposal and summarizes in the same real SDK turn", async () => {
  let phase = 0, turns = 0, closing = false;
  const answers: string[] = [], specs: TaskSpec[] = [], gates = new Map<string, () => void>(), disposed = new Set<string>();
  const userWords = "Inspect the two independent project pages in parallel and summarize both results.";
  const model = await startMockLlm({ delayMs: 0, respond: (messages: { role: string; content: unknown }[], tools: string[]) => {
    if (!tools.includes("wait_for_tasks")) return { text: "Only the fixed conductor fixture is expected." };
    if (++phase === 1) return { tools: [
      { name: "start_task", args: { goal: "Inspect the first project page", sessionName: "First inspection" } },
      { name: "start_task", args: { goal: "Inspect the second project page", sessionName: "Second inspection" } },
    ] };
    if (phase === 2) {
      const text = messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)).join("\n");
      const ids = [...new Set([...text.matchAll(/Task ([0-9]+-[0-9a-f]{8})\b/g)].map(match => match[1]))];
      return { tool: { name: "wait_for_tasks", args: { ids, timeoutMs: 10_000 } } };
    }
    return { text: "Both observations are complete: first observed result; second observed result." };
  } });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ember-conductor-join-runtime-"));
  const selected = runtimeFor(process.platform as OS, process.arch), runtime = locateRuntime({ appPath: process.cwd(), runtimeId: selected.id, exe: selected.exe });
  expect(runtime.exists).toBe(true);
  const settings = new SettingsStore(path.join(directory, "settings.json")); settings.load();
  settings.update({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
  const host = new AgentHost({ userData: directory, runtimePath: runtime.path, settings,
    log: createLogger({ dir: path.join(directory, "logs") }), setState() {}, onStatus() {}, onAnswer: answer => { answers.push(answer); }, onTurnEnd: () => { turns++; },
    provider: { type: "openai", baseUrl: model.baseUrl, apiKey: "test" },
    hands: { perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
      confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null },
  });
  try {
    expect(await host.start(null), JSON.stringify(host.getStatus())).toBe("ready");
    host.projectSessionsAction({ action: "create", name: "Parallel inspection" });
    // The actual manager/Host tool callbacks run; only application work is inert and disposal is controlled here.
    /* eslint-disable @typescript-eslint/no-explicit-any -- same SDK/worker injection boundary as project-session-host.test.ts */
    (host.tasks as any).d.makeWorker = (spec: TaskSpec) => {
      specs.push(spec); const index = specs.length;
      return { run: async () => ({ success: true, summary: index === 1 ? "first observed result" : "second observed result" }),
        dispose: () => new Promise<void>(resolve => { const release = () => { disposed.add(spec.id); resolve(); }; gates.set(spec.id, release); if (closing) release(); }),
        cleanupComplete: () => disposed.has(spec.id), handoffSafe: () => disposed.has(spec.id), steer: async () => false, sessionId: null };
    };
    expect(await host.ask(userWords)).toBe(true);
    await expect.poll(() => (host.tasks as any).waitListeners.size, { timeout: 20_000 }).toBe(1);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(specs).toHaveLength(2); expect(specs.map(spec => spec.userWords)).toEqual([userWords, userWords]);
    expect(host.tasks!.list().map(task => host.tasks!.observeSettlement(task))).toMatchObject([{ status: "done", cleanup: "pending" }, { status: "done", cleanup: "pending" }]);
    expect(turns).toBe(0);
    for (const release of gates.values()) release();
    await expect.poll(() => turns, { timeout: 20_000 }).toBe(1);
    expect(answers.at(-1)).toContain("Both observations are complete");
    const wire = model.requests.filter((request: { tools: string[] }) => request.tools.includes("wait_for_tasks"));
    expect(wire).toHaveLength(3);
    const text = wire[2].messages.filter((message: { role: string }) => message.role === "tool")
      .map((message: { content: unknown }) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    const observed = /<task_wait untrusted="true">([\s\S]*?)<\/task_wait>/.exec(text);
    expect(observed).not.toBeNull();
    expect(JSON.parse(observed![1])).toMatchObject({ reason: "settled", dependentSuccess: true,
      tasks: [{ cleanup: "complete", handoffSafe: true, summary: "first observed result" }, { cleanup: "complete", handoffSafe: true, summary: "second observed result" }] });
    expect(host.tasks!.takeReports()).toHaveLength(2); expect(specs).toHaveLength(2);
  } finally {
    closing = true;
    for (const release of gates.values()) release();
    await host.stop(); await model.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
