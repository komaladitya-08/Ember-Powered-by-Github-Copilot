/** Actual pinned SDK, guest/isolated engine, public registry and normal policy. The Windows interop boundary is not exercised here. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createWslPublicDependencyFixture } from "../fixtures/coding/wsl-public-dependencies";
import { ScopedCodingWorker } from "../../app/main/agent/scoped-coding-worker";
import { wslCodingPlatform } from "../../app/main/agent/wsl-coding-workspace";
import { authorizePublicNpmPreparation } from "../../app/main/agent/public-npm-approval";
import { Confirmer, type Question } from "../../app/main/agent/confirm";
import { runtimeFor, locateRuntime } from "../../app/main/agent/runtime";
import { Refusals } from "../../app/main/policy/refusals";
import type { CodingWorkspaceReview } from "../../app/main/agent/coding-platform";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { CommandFlowContext } from "../../app/main/commands/flow";
import type { CommandService, RunnerFacts } from "../../app/main/commands/types";
import type { Logger } from "../../app/main/logger";
import type { CodingResultSummary } from "../../app/shared/project-coding";
// @ts-expect-error -- deterministic local model fixture; no live account or credential
import { startMockLlm } from "../mock-llm/server.mjs";

const required = process.env.EMBER_WSL_PUBLIC_DEPENDENCIES_TEST === "1";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const CHECK = "npm ci --offline && npm run build && npm test";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
let quarantined = false;
const retained = new Set<object>();

async function fixture(ctx: { skip(note?: string): never }, decision: "once" | "deny" = "once") {
  if (quarantined) throw new Error("A previous SDK dependency journey did not establish complete cleanup.");
  quarantined = true;
  const f = await createWslPublicDependencyFixture(ctx);
  const owner: { workspace: typeof f; model?: { close(): Promise<void> }; worker?: ScopedCodingWorker } = { workspace: f }; retained.add(owner);
  let failedModel: { close(): Promise<void> } | null = null;
  try {
    const userData = path.join(f.root, "sdk-private"); fs.mkdirSync(userData, { mode: 0o700 });
    const runtime = runtimeFor("linux", process.arch), located = locateRuntime({ appPath: process.cwd(), runtimeId: runtime.id, exe: runtime.exe });
    expect(located.exists).toBe(true);
    let step = 0;
    const model = await startMockLlm({ delayMs: 0, respond: () => {
      if (++step === 1) return { tool: { name: "prepare_public_dependencies", args: {} } };
      if (step === 2 || step === 4) return { tool: { name: "run_command", args: { target: "Ubuntu (WSL)", command: CHECK, why: "Install from the prepared offline cache, build and verify the copied check" } } };
      if (step === 3) return { tool: { name: "coding_replace", args: { path: "src/result.ts", oldText: "'wrong'", newText: "'ready'" } } };
      if (step === 5) return { tool: { name: "finish_coding", args: { success: true, summary: "Repaired the copied dependency check and reran its exact offline command successfully." } } };
      return { text: "Private review ready." };
    } });
    failedModel = model; owner.model = model;
    const questions: Question[] = [], failures: string[] = [], audit: Record<string, unknown>[] = [], cards: { sha256: string }[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>(), seen = new Set<number>();
    const confirmer = new Confirmer(() => undefined, { panelReady: () => true, gapMs: 0, onChange(pending) {
      if (!pending || seen.has(pending.n)) return; seen.add(pending.n); questions.push(pending.question);
      const panel = pending.question.panel;
      if (panel?.kind !== "command" && !pending.question.detail?.includes("picocolors@1.1.1")) { failures.push("Unexpected approval"); confirmer.answer(`q${pending.n}:deny`); return; }
      if (!panel) confirmer.wholeSeen(pending.n);
      const timer = setTimeout(() => {
        timers.delete(timer);
        const accepted = panel?.kind === "command" ? confirmer.answer(`q${pending.n}:${decision}`, "panel", { sha256: panel.card.sha256 }) : confirmer.answer(`q${pending.n}:${decision}`);
        if (!accepted) failures.push("Exact approval refused");
      }, (pending.question.armMs ?? 500) + 25); timers.add(timer);
    } });
    const hostStart = vi.fn(() => { throw new Error("The host runner must not execute project work."); });
    const binding = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", screenOs: "win32", shellOs: "linux", desktop: "none" } as const;
    const facts: RunnerFacts = { os: "linux", home: "/host", user: "fixture", privileged: false, shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" },
      script: null, pty: false, extraPath: [], ember: { paths: [userData], pids: [process.pid], names: /^ember$/ } };
    const service: CommandService = { binding, mode: () => "on", userAskEvery: () => true, capability: () => ({ state: "on", askEvery: "user" }),
      shells: () => ["bash"], consented() {}, runner: { target: binding.id, facts: async () => facts, inspect: async paths => paths.map(() => ({ exists: null, real: null })),
        gitFacts: async () => null, start: hostStart, stopAll: async () => undefined, running: 0 },
      window: { showCard() {}, hideCard() {}, cardReady: () => true, announce: async () => true, cancelAnnounce() {}, attach(card) { cards.push(card); } } };
    const request = "Install this project's public locked dependencies, fix its failing check, and rerun the same offline check.";
    const published: { output: CodingWorkspaceReview; status: string; checks: { ran: number; passed: number; failed: number } }[] = [];
    const worker = new ScopedCodingWorker({ id: "public-sdk-worker", goal: request, target: {} } as TaskSpec, {
      runtime: { userData, runtimePath: located.path, env: process.env }, model: "mock-model", provider: { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic-local-provider" },
      target: binding, platform: wslCodingPlatform, createWorkspace: async () => f.workspace, commandService: service,
      current: () => !f.task.signal.aborted, beforeStart: async () => undefined, reviewBase: f.reviews, progress() {},
      publicDependencies: { current: () => !f.task.signal.aborted, authorize: (request, context, signal) => authorizePublicNpmPreparation(request, context, PROJECT, signal) },
      commandContext: (isolated, signal): CommandFlowContext => ({ service: isolated, signal, confirmer, log: quiet,
        isOver: () => signal.aborted, task: { id: "public-sdk-worker", title: "Repair the copied public dependency check", commandWords: () => request, checkWords: () => request,
          agreed: () => [], tainted: () => false, taint() {}, readFrom: () => [] },
        presenter: { workedWithoutAsking() {}, progress() {}, announce() {}, endAnnouncement() {} } as unknown as CommandFlowContext["presenter"],
        audit: entry => { audit.push(entry); if (entry.phase === "dependencies-authorized") f.events.push("approved:normal-policy"); },
        state: { cwd: null, downloaded: new Set(), running: false }, refusals: new Refusals(), size: () => ({ cols: 80, rows: 24 }), emberPids: () => [process.pid] }),
      publish: async (output, status, checks) => { published.push({ output, status, checks }); f.workspace.transferReview(output); return { id: randomUUID() } as CodingResultSummary; },
    });
    owner.worker = worker;
    return { f, worker, questions, failures, cards, audit, model, hostStart, userData, published, get step() { return step; },
      async close() {
        for (const timer of timers) clearTimeout(timer); confirmer.cancelAll();
        await worker.dispose(); await f.close(); await model.close(); retained.delete(owner); quarantined = false;
      } };
  } catch (error) {
    try { await f.close(); } finally { await failedModel?.close(); }
    retained.delete(owner); quarantined = false;
    throw error;
  }
}

it.skipIf(!required)("prepares through real SDK/normal approvals before fetching, repairs and reruns the identical offline check, then publishes only a private review", async ctx => {
  const h = await fixture(ctx), { f, worker, questions, failures, cards, audit, model, hostStart, userData, published } = h;
  try {
    expect(f.fetches).toBe(0);
    expect(await worker.run(f.task.signal)).toEqual({ success: true, summary: "Repaired the copied dependency check and reran its exact offline command successfully." });
    expect(await worker.disposed).toBe(true); expect(worker.handoffSafe()).toBe(true); expect(failures).toEqual([]); expect(hostStart).not.toHaveBeenCalled();
    expect(questions).toHaveLength(3); expect(questions[0].panel).toBeUndefined(); expect(questions[0].detail).toContain("picocolors@1.1.1");
    expect(f.events.slice(0, 2)).toEqual(["approved:normal-policy", "fetch:picocolors"]);
    expect(cards).toHaveLength(2); expect(cards[0].sha256).toBe(cards[1].sha256);
    expect(published).toHaveLength(1); expect(published[0]).toMatchObject({ status: "done", checks: { ran: 2, passed: 1, failed: 1 } });
    expect(published[0].output.review.textPatch).toContain("'ready'");
    expect(published[0].output.review.proposed.some(entry => entry.path === "node_modules" || entry.path.startsWith("node_modules/"))).toBe(false);
    for (const [file, text] of f.original) expect(fs.readFileSync(path.join(f.sourceDir, file), "utf8")).toBe(text);
    expect(fs.readdirSync(path.join(userData, "coding-controllers"))).toEqual([]);
    expect(audit.filter(entry => entry.phase === "dependencies-authorized")).toHaveLength(1);
    const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding", "run_command", "run_node", "prepare_public_dependencies"];
    expect(model.requests.every((input: { tools: string[] }) => input.tools.length === allowed.length && input.tools.every(tool => allowed.includes(tool)))).toBe(true);
    expect(model.requests.every((input: { messages: unknown }) => JSON.stringify(input.messages).includes("prepare_public_dependencies"))).toBe(true);
    await f.store.discard(published[0].output);
  } finally { await h.close(); }
}, 90_000);

it.skipIf(!required)("stops a declined exact-set SDK preparation without fetching, running a command or retrying, then preserves the unchanged private review", async ctx => {
  const h = await fixture(ctx, "deny"), { f, worker } = h;
  try {
    expect(await worker.run(f.task.signal)).toMatchObject({ success: false });
    expect(await worker.disposed).toBe(true); expect(worker.handoffSafe()).toBe(false);
    expect(h.questions).toHaveLength(1); expect(h.questions[0].detail).toContain("picocolors@1.1.1");
    expect(h.failures).toEqual([]); expect(h.hostStart).not.toHaveBeenCalled(); expect(h.cards).toEqual([]);
    expect(h.step).toBe(1); expect(f.fetches).toBe(0); expect(f.events).toEqual([]);
    expect(h.audit.some(entry => entry.phase === "dependencies-authorized")).toBe(false);
    expect(h.published).toHaveLength(1); expect(h.published[0]).toMatchObject({ status: "failed", checks: { ran: 0, passed: 0, failed: 0 } });
    expect(h.published[0].output.review.changes).toEqual([]); expect(h.published[0].output.review.textPatch).toBe("");
    for (const [file, text] of f.original) expect(fs.readFileSync(path.join(f.sourceDir, file), "utf8")).toBe(text);
    expect(fs.readdirSync(path.join(h.userData, "coding-controllers"))).toEqual([]);
    await f.store.discard(h.published[0].output);
  } finally { await h.close(); }
}, 45_000);
