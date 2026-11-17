/** Real Linux SDK control plane plus actual Windows workspace factories over DLL models; no Windows execution proof. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import win32 from "node:path/win32";
import { vi } from "vitest";
import type { ScopedCodingWorkerOptions, ScopedCodingChecks } from "../../app/main/agent/scoped-coding-worker";
import type { CodingWorkspaceReview } from "../../app/main/agent/coding-platform";
import type { CommandFlowContext } from "../../app/main/commands/flow";
import type { CommandService, RunnerFacts, RunExit, CommandCard } from "../../app/main/commands/types";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { Logger } from "../../app/main/logger";
import type { CodingResultSummary } from "../../app/shared/project-coding";
import { setupWindowsNodeWorkspace } from "./windows-node-workspace-fake";

export const WINDOWS_SDK_ARGV = ["--preserve-symlinks", "--preserve-symlinks-main", "--test", "--experimental-test-isolation=none", "test.cjs"];
export const WINDOWS_SDK_ORIGINAL = "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(1 + 1, 3));\n";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

export async function setupWindowsNodeSdkWorker(model: { baseUrl: string }) {
  const dll = await setupWindowsNodeWorkspace();
  dll.canonical.put("C:\\project\\test.cjs", WINDOWS_SDK_ORIGINAL);
  // Already-loaded Windows modules retain their fixed inventory/DLL bindings. New controller/SDK imports
  // use the real Linux host and built-ins; no runtime, issuer, permission or stopped-proof API is replaced.
  for (const name of ["node:module", "node:crypto", "../../app/main/platform/os"]) vi.doUnmock(name);
  const { ScopedCodingWorker } = await import("../../app/main/agent/scoped-coding-worker");
  const { WindowsNodeWorkspace } = await import("../../app/main/agent/windows-node-workspace");
  const { windowsNodeCodingPlatform, WINDOWS_NODE_CODING_CONSTRAINTS } = await import("../../app/main/agent/windows-node-coding-platform");
  const { runtimeFor, locateRuntime } = await import("../../app/main/agent/runtime");
  const { Refusals } = await import("../../app/main/policy/refusals");
  const { Confirmer } = await import("../../app/main/agent/confirm");
  const runtime = runtimeFor("linux", process.arch), located = locateRuntime({ appPath: process.cwd(), runtimeId: runtime.id, exe: runtime.exe });
  if (!located.exists) throw Error("The pinned Linux SDK controller runtime is required.");
  const temporary = fs.realpathSync(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
  const root = fs.mkdtempSync(path.join(parent, "ember-windows-node-sdk-")), userData = path.join(root, "host"); fs.mkdirSync(userData, { mode: 0o700 });
  const cards: CommandCard[] = [], exits: RunExit[] = [], audit: unknown[] = [], errors: string[] = [], questions: unknown[] = [];
  const nativeStart = vi.fn(() => { throw Error("The host runner must never execute a project command."); });
  const facts: RunnerFacts = { os: "win32", shells: ["powershell"], shellPaths: {}, script: null, home: "C:\\host", user: "", privileged: false,
    pty: false, ember: { paths: ["C:\\protected"], pids: [process.pid], names: /^ember$/ }, extraPath: [] };
  const confirmer = new Confirmer(() => undefined, { panelReady: () => true, gapMs: 0, onChange(pending) {
    if (!pending) return; questions.push(pending.question);
    const panel = pending.question.panel;
    if (panel?.kind !== "command" || panel.card.kind !== "node" || JSON.stringify(panel.card.argv) !== JSON.stringify(WINDOWS_SDK_ARGV)) {
      errors.push("Unexpected approval request"); confirmer.answer(`q${pending.n}:deny`); return;
    }
    setTimeout(() => { if (!confirmer.answer(`q${pending.n}:once`, "panel", { sha256: panel.card.sha256 })) errors.push("The exact Node approval was refused"); }, (pending.question.armMs ?? 500) + 25);
  } });
  const service: CommandService = {
    binding: { id: "local", kind: "local", label: "This computer", screenOs: "win32", shellOs: "win32", desktop: "screen" },
    capability: () => ({ state: "on", askEvery: null }), shells: () => ["powershell"], consented() {}, userAskEvery: () => true, mode: () => "on",
    runner: { target: "local", facts: async () => facts, inspect: async paths => paths.map(() => ({ exists: null, real: null })), gitFacts: async () => null,
      start: nativeStart, stopAll: async () => undefined, running: 0 },
    window: { showCard() {}, hideCard() {}, cardReady: () => true, announce: async () => true, cancelAnnounce() {},
      attach(card, running) { cards.push(structuredClone(card)); void running.done.then(exit => { exits.push(exit); }); } },
  };
  let workspace: import("../../app/main/agent/windows-node-workspace").WindowsNodeWorkspace | undefined;
  const published: { output: CodingWorkspaceReview; status: string; checks: ScopedCodingChecks }[] = [];
  const contexts = vi.fn<ScopedCodingWorkerOptions["commandContext"]>((isolated, signal) => ({
    task: { id: "windows-sdk-worker", title: "Repair the copied Node check", commandWords: () => `Run node ${WINDOWS_SDK_ARGV.join(" ")}, repair its copied assertion and rerun that exact check.`,
      agreed: () => [], tainted: () => false, taint() {}, readFrom: () => [] },
    service: isolated, confirmer, presenter: { announce() {}, endAnnouncement() {}, progress() {} } as unknown as CommandFlowContext["presenter"],
    audit: entry => audit.push(entry), log: quiet, signal, isOver: () => signal.aborted,
    state: { cwd: null, downloaded: new Set<string>(), running: false }, size: () => ({ cols: 80, rows: 24 }), emberPids: () => [process.pid], refusals: new Refusals(),
  }));
  const options: ScopedCodingWorkerOptions = {
    runtime: { userData, runtimePath: located.path, env: process.env }, model: "mock-model", provider: { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic-local-model" },
    createWorkspace: async (signal, admit) => workspace = await WindowsNodeWorkspace.create({ ...dll.input, signal: AbortSignal.any([signal, dll.task.signal]),
      current: () => dll.control.current && admit() }),
    platform: windowsNodeCodingPlatform, toolchain: "windows-node", commandService: service, commandContext: contexts, current: () => true,
    reviewBase: dll.input.reviewBase, beforeStart: async () => undefined, progress() {},
    publish: async (output, status, checks) => {
      if (!workspace) throw Error("A genuine workspace must own this review.");
      published.push({ output, status, checks }); workspace.transferReview(output);
      return { id: "33333333-3333-4333-8333-333333333333" } as CodingResultSummary;
    },
  };
  const worker = new ScopedCodingWorker({ id: "windows-sdk-worker", goal: "Repair test.cjs in the private copy and verify its exact Node check", target: {} } as TaskSpec, options);
  dll.control.onResume = () => {
    const row = dll.io.source.objects.get(win32.join(dll.commandRoot().name, "test.cjs"));
    if (!row) throw Error("The fixed copied check is missing."); dll.io.state.code = row.bytes.toString() === WINDOWS_SDK_ORIGINAL ? 17 : 0;
  };
  const close = async () => {
    await worker.dispose(); const disposed = await worker.disposed;
    if (disposed) { await dll.canonical.store.cleanup(new Set()); await dll.canonical.store.close(); fs.rmSync(root, { recursive: true, force: true }); }
    return disposed;
  };
  return { ...dll, root, userData, options, worker, published, nativeStart, contexts, cards, exits, questions, audit, errors, close, constraints: WINDOWS_NODE_CODING_CONSTRAINTS,
    workspace: () => workspace };
}
