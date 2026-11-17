/** Captures the real worker's default Linux policy facts without starting a model/runtime. */
import { expect, it, vi } from "vitest";
import { ScopedCodingWorker, type ScopedCodingWorkerOptions } from "../../app/main/agent/scoped-coding-worker";
import type { CodingCommandWorkspace } from "../../app/main/agent/coding-platform";
import type { CommandService, RunnerFacts } from "../../app/main/commands/types";
import type { TaskSpec } from "../../app/main/agent/worker";
import { resolveTargetPath } from "../../app/main/commands/paths";
import { classifyNativeReadPath } from "../../app/main/commands/classify";

it("expands and classifies home operands using the default engine HOME instead of the host home", async () => {
  const host: RunnerFacts = { os: "linux", home: "/host-home", user: "host", privileged: false, pty: false, shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null, ember: { paths: [], pids: [], names: /ember/ }, extraPath: [] };
  const workspace = { executionRoot: "/work", nodeAvailable: false, files: async () => { throw new Error("No file operation needed."); }, run: async () => { throw new Error("No command may start."); }, runNode: async () => { throw new Error("No command may start."); }, stop: vi.fn(async () => undefined), close: vi.fn(async () => undefined), exportReview: async () => { throw new Error("No review is minted."); } } satisfies CodingCommandWorkspace;
  const hostStart = vi.fn(async () => { throw new Error("Host commands must not start."); });
  const service = { binding: { id: "local", kind: "local" }, runner: { facts: async () => host, start: hostStart }, target: "This computer", shells: ["bash"] } as unknown as CommandService;
  let facts: RunnerFacts | undefined;
  const options: ScopedCodingWorkerOptions = { runtime: { userData: "/unused", runtimePath: "/unused", env: {} }, createWorkspace: async () => workspace, commandService: service,
    commandContext: isolated => { void isolated.runner.facts().then(value => { facts = value; }); throw new Error("Stop before starting SDK runtime."); }, current: () => true,
    reviewBase: "/unused", publish: async () => { throw new Error("No publication."); }, progress: () => undefined, beforeStart: async () => undefined, onRetiring: () => undefined };
  const spec = { id: "linux-home-facts", goal: "Inspect default isolated facts", target: { xid: 1, pid: 1, title: "fixture", bounds: { x: 0, y: 0, width: 1, height: 1 } } } as TaskSpec;
  const worker = new ScopedCodingWorker(spec, options); expect((await worker.run(new AbortController().signal)).success).toBe(false); await worker.dispose();
  expect(facts?.home).toBe("/tmp"); expect(hostStart).not.toHaveBeenCalled();
  expect(resolveTargetPath("~/home-control", { ...facts!, cwd: "/work" })).toBe("/tmp/home-control");
  expect(classifyNativeReadPath("~/home-control", { os: facts!.os, home: facts!.home, cwd: "/work", ember: facts!.ember, downloaded: new Set() }).probe).toContain("/tmp/home-control");
});
