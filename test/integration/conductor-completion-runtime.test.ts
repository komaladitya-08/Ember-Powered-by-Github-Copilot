/** Real pinned SDK/Host, a local deterministic provider and inert workers: completion after the original20s join. */
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
import type { TaskSpec, WorkerResult } from "../../app/main/agent/worker";
// @ts-expect-error -- fixed offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

it("automatically combines long parallel work in a separate tool-free session after both workers actually retire", async () => {
  let phase = 0, turns = 0, closing = false;
  const completed: string[] = [], specs: TaskSpec[] = [], finishes = new Map<string, (result: WorkerResult) => void>();
  const gates = new Map<string, () => void>(), disposed = new Set<string>();
  const words = "Inspect both project pages independently and report a combined comparison when both finish.";
  const model = await startMockLlm({ delayMs: 0, respond: (messages: { role: string; content: unknown }[], tools: string[]) => {
    if (!tools.length) return { text: "Combined result: first observed result; second observed result." };
    if (++phase === 1) return { tools: [
      { name: "start_task", args: { goal: "Inspect the first project page", sessionName: "First inspection" } },
      { name: "start_task", args: { goal: "Inspect the second project page", sessionName: "Second inspection" } },
    ] };
    if (phase === 2) {
      const text = messages.filter(message => message.role === "tool").map(message => JSON.stringify(message.content)).join("\n");
      const ids = [...new Set([...text.matchAll(/Task ([0-9]+-[0-9a-f]{8})\b/g)].map(match => match[1]))];
      return { tool: { name: "wait_for_tasks", args: { ids } } };
    }
    return { text: "Both page checks are still running." };
  } });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ember-conductor-completion-runtime-"));
  const selected = runtimeFor(process.platform as OS, process.arch), runtime = locateRuntime({ appPath: process.cwd(), runtimeId: selected.id, exe: selected.exe });
  expect(runtime.exists).toBe(true);
  const settings = new SettingsStore(path.join(directory, "settings.json")); settings.load();
  settings.update({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
  const host = new AgentHost({ userData: directory, runtimePath: runtime.path, settings,
    provider: { type: "openai", baseUrl: model.baseUrl, apiKey: "test" },
    log: createLogger({ dir: path.join(directory, "logs") }), setState() {}, onStatus() {}, onTurnEnd: () => { turns++; }, onTaskCompletion: text => { completed.push(text); },
    hands: { perception: {} as never, sidecar: {} as never, policy: {} as never, audit: { write() {} } as never,
      confirmer: { waiting: false, cancelAll() {} } as never, flyTo() {}, currentWindow: () => null },
  });
  try {
    expect(await host.start(null), JSON.stringify(host.getStatus())).toBe("ready");
    host.projectSessionsAction({ action: "create", name: "Long parallel comparison" });
    /* eslint-disable @typescript-eslint/no-explicit-any -- only the desktop worker boundary is replaced, as in conductor-wait-runtime.test.ts */
    (host.tasks as any).d.makeWorker = (spec: TaskSpec) => {
      specs.push(spec);
      return { run: () => new Promise<WorkerResult>(resolve => { finishes.set(spec.id, resolve); if (closing) resolve({ success: false, stopped: true, summary: "Fixture shutdown." }); }),
        dispose: () => new Promise<void>(resolve => { const release = () => { disposed.add(spec.id); resolve(); }; gates.set(spec.id, release); if (closing) release(); }),
        cleanupComplete: () => disposed.has(spec.id), handoffSafe: () => disposed.has(spec.id), steer: async () => false, sessionId: null };
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    expect(await host.ask(words)).toBe(true);
    await expect.poll(() => turns, { timeout: 30_000 }).toBe(1);
    expect(specs).toHaveLength(2); expect(specs.map(spec => spec.userWords)).toEqual([words, words]);
    const foreground = model.requests.filter((request: { tools: string[] }) => request.tools.includes("wait_for_tasks"));
    expect(foreground).toHaveLength(3);
    const joined = foreground[2].messages.filter((message: { role: string }) => message.role === "tool").map((message: { content: unknown }) => JSON.stringify(message.content)).join("\n");
    expect(joined).toContain('\\"reason\\":\\"timeout\\"'); expect(completed).toEqual([]);
    finishes.get(specs[0].id)!({ success: true, summary: "first observed result" });
    finishes.get(specs[1].id)!({ success: true, summary: "second observed result" });
    await expect.poll(() => gates.size).toBe(2); expect(completed).toEqual([]);
    gates.get(specs[0].id)!(); await Promise.resolve(); expect(completed).toEqual([]);
    gates.get(specs[1].id)!(); await expect.poll(() => completed, { timeout: 20_000 }).toEqual(["Combined result: first observed result; second observed result."]);
    const synthesis = model.requests.filter((request: { tools: string[] }) => !request.tools.length);
    expect(synthesis).toHaveLength(1); expect(JSON.stringify(synthesis[0].messages)).toContain('untrusted=\\"true\\"');
    expect(JSON.stringify(synthesis[0].messages)).toContain("first observed result"); expect(JSON.stringify(synthesis[0].messages)).toContain("second observed result");
    expect(host.getTranscript().filter(entry => entry.who === "you").map(entry => entry.text)).toEqual([words]);
    expect(host.getTranscript().filter(entry => entry.who === "ember" && entry.text.startsWith("Combined result:"))).toHaveLength(1);
    expect(turns).toBe(1); expect(specs).toHaveLength(2); expect(host.tasks!.takeReports()).toHaveLength(2);
  } finally {
    closing = true;
    for (const finish of finishes.values()) finish({ success: false, stopped: true, summary: "Fixture shutdown." });
    for (const release of gates.values()) release();
    await host.stop(); await model.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
