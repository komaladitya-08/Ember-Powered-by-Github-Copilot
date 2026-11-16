/** Actual default workspace/profile/assets/Copy/Stop/output issuers over DLL models; no Windows execution claim. */
import path from "node:path/win32";
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsNodeWorkspace as setup } from "../fixtures/windows-node-workspace-fake";

const args = ["--preserve-symlinks", "--preserve-symlinks-main", "app.ts"];
afterEach(() => {
  for (const name of ["node:module", "node:crypto", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});
async function open() {
  const f = await setup(), workspace = await f.create(), broker = await workspace.filesBroker(f.task.signal);
  return { ...f, workspace, broker };
}
async function cleanup(f: Awaited<ReturnType<typeof open>>) {
  await f.broker.close(); await f.workspace.close(); await f.canonical.store.close(); expect(f.canonical.handles.size).toBe(0);
}
function changed(f: Awaited<ReturnType<typeof open>>, text: string) {
  const root = f.commandRoot(), file = f.io.source.objects.get(path.join(root.name, "app.ts"))!;
  file.bytes = Buffer.from(text); file.written++; file.changed++;
}

it("creates only the genuine Node capability and refuses shell/nonroot cwd before admitting any command", async () => {
  const f = await open(); expect(f.workspace.nodeAvailable).toBe(true); expect(f.profileState.created).toHaveLength(1);
  const count = f.io.state.creates;
  await expect(f.workspace.run("anything", "/work", () => undefined, new AbortController().signal, "powershell")).rejects.toMatchObject({ code: "unsupported" });
  for (const cwd of ["C:\\host", "/work/sub", "\\\\host\\share", "../work", "/work/"]) {
    await expect(f.workspace.runNode(args, cwd, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "path" });
  }
  expect(f.io.state.creates).toBe(count); expect(f.profileState.deleted).toHaveLength(0); await cleanup(f);
});

it("snapshots literal argv before the exclusive file wait, preserving punctuation/empty arguments and genuine root cwd", async () => {
  const f = await open(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { entered = resolve; });
  const files = f.workspace.files(async () => { entered(); await waiting; }); await acquired;
  let actualRoot = ""; f.control.onResume = () => { actualRoot = f.commandRoot().name; };
  const argv = ["-e", "literal &|; $()", ""], run = f.workspace.runNode(argv, "\\work", () => undefined, new AbortController().signal);
  argv.splice(0, argv.length, "MUTATED"); expect(f.io.state.creates).toBe(0); release(); await files;
  const result = await run; expect(result).toMatchObject({ observed: true, exitCode: 0, stopped: false });
  expect(f.control.command).toMatch(/ "-e" "literal &\|; \$\(\)" ""$/);
  expect(f.control.command).not.toContain("MUTATED"); expect(f.control.command).not.toContain("--preserve-symlinks");
  expect(f.control.cwd).toBe(actualRoot); expect(f.control.cwd).not.toBe("\\work"); expect(f.control.program).toContain("\\ember-node-");
  await cleanup(f);
});

it("adopts genuine nonzero edits for repair while the real runner preserves the failed check and original baseline/source", async () => {
  const f = await open(), { IsolatedCodingCommandRunner } = await import("../../app/main/agent/isolated-coding-command-runner"),
    { nodeInvocationSha256 } = await import("../../app/main/commands/node-invocation"), { windowsNodeCodingPlatform } = await import("../../app/main/agent/windows-node-coding-platform");
  const facts = windowsNodeCodingPlatform.facts(f.workspace, { os: "win32", shells: ["powershell"], shellPaths: {}, script: null, home: "C:\\host", user: "synthetic", privileged: false, pty: false, ember: { paths: [], pids: [], names: /ember/i }, extraPath: [] });
  const runner = new IsolatedCodingCommandRunner({ workspace: f.workspace, facts, signal: f.task.signal, current: () => true,
    inspect: (paths, cwd) => f.broker.inspect(paths, cwd) });
  const start = (runId: string) => runner.startNode({ kind: "node", argv: args, cwd: "\\work", runId, taskId: "task", timeoutMs: 10000,
    cols: 80, rows: 24, stamp: { taskId: "task", sha256: nodeInvocationSha256("local", "\\work", args), verdict: "run", classes: [], rules: [], approval: null } });
  f.control.onResume = () => { changed(f, "export const answer = 42;\n"); f.io.state.code = 17; };
  expect(await start("a".repeat(16)).done).toMatchObject({ code: 17, ended: "exit" });
  expect((await f.broker.readText("app.ts")).text).toContain("42"); await f.broker.replaceText("app.ts", "42", "43");
  f.control.onResume = () => { f.io.state.code = 0; };
  expect(await start("b".repeat(16)).done).toMatchObject({ code: 0, ended: "exit" });
  expect(runner.exitsAfter(0).map(item => item.exit.code)).toEqual([17, 0]); expect(f.profileState.created).toHaveLength(1);
  expect(f.profileState.deleted).toHaveLength(0); await runner.stopAll("quit"); await f.broker.close(); await f.workspace.sealForReview();
  expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
  const output = await f.workspace.exportReview(f.input.reviewBase), review = output.review;
  const before = review.baseline.find(row => row.path === "app.ts")!, after = review.proposed.find(row => row.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toContain("41");
  expect(after.kind === "file" && Buffer.from(after.base64, "base64").toString()).toContain("43");
  expect(review.current).toEqual(review.baseline); expect(review.binding).toEqual(f.canonical.binding); expect(output.cleanup).toBe("complete");
  expect(f.canonical.nodes.get(f.canonical.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toContain("41");
  f.workspace.transferReview(output); await f.workspace.close(); expect(f.canonical.store.size).toBe(1);
  await f.canonical.store.cleanup(new Set()); await f.canonical.store.close(); expect(f.canonical.handles.size).toBe(0);
});

it("Stop reaches the genuine live command outside the run queue and keeps cancelled edits private until seal", async () => {
  const f = await open(), signal = f.workspace.signal; f.control.autoFinish = false;
  f.control.onResume = () => changed(f, "export const answer = 44;\n");
  const runSignal = new AbortController(), running = f.workspace.runNode(args, "/work", () => undefined, runSignal.signal);
  await vi.waitFor(() => expect(f.io.events).toContain("resume")); runSignal.abort();
  expect(signal.aborted).toBe(true); expect(f.workspace.nodeAvailable).toBe(false);
  const result = await running; expect(result).toMatchObject({ observed: true, stopped: true });
  expect(f.io.events.some(event => event === "TerminateJobObject" || event === "TerminateProcess")).toBe(true);
  await expect(f.workspace.runNode(args, "/work", () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "cancelled" });
  await expect(f.broker.readText("app.ts")).rejects.toMatchObject({ code: "cancelled" });
  await expect(f.workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "boundary" });
  await f.broker.close(); await f.workspace.sealForReview();
  const output = await f.workspace.exportReview(f.input.reviewBase), proposed = output.review.proposed.find(row => row.path === "app.ts")!;
  expect(proposed.kind === "file" && Buffer.from(proposed.base64, "base64").toString()).toContain("44");
  expect(f.workspace.signal).toBe(signal); expect(signal.aborted).toBe(true); await cleanup(f);
});

it("Stop from a file callback rejects reentrant waiting yet records a real externally awaited proof", async () => {
  const f = await open();
  await expect(f.workspace.files(async () => {
    await expect(f.workspace.stop()).rejects.toMatchObject({ code: "boundary" }); expect(f.workspace.signal.aborted).toBe(true);
  })).rejects.toMatchObject({ code: "cancelled" });
  await f.workspace.stop(); expect(f.io.state.creates).toBe(0); await f.broker.close(); await f.workspace.sealForReview();
  const output = await f.workspace.exportReview(f.input.reviewBase); expect(output.cleanup).toBe("complete"); await cleanup(f);
});

it("publishes one seal/close proof before abort listeners can reenter, and closes the asset/profile owners once", async () => {
  const f = await open(); let nestedSeal: Promise<void> | undefined, nestedClose: Promise<void> | undefined;
  f.workspace.signal.addEventListener("abort", () => { nestedSeal = f.workspace.sealForReview(); nestedClose = f.workspace.close(); }, { once: true });
  const sealed = f.workspace.sealForReview(); expect(nestedSeal).toBe(sealed); expect(nestedClose).toBe(f.workspace.close());
  await sealed; await nestedClose;
  expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
  expect(f.asset.assets().every(row => row.removed)).toBe(true); await f.canonical.store.close(); expect(f.canonical.handles.size).toBe(0);
});

it("a callback cannot await a previously cached seal which is waiting for that callback's file lease", async () => {
  const f = await open(); let proceed!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { proceed = resolve; }), acquired = new Promise<void>(resolve => { entered = resolve; });
  const files = f.workspace.files(async () => { entered(); await wait; await expect(f.workspace.sealForReview()).rejects.toMatchObject({ code: "boundary" }); });
  await acquired; const sealed = f.workspace.sealForReview(); proceed();
  await expect(files).rejects.toMatchObject({ code: "cancelled" }); await sealed;
  expect(f.profileState.deleted).toHaveLength(1); await cleanup(f);
});

it("reentrant close observes its hidden cleanup failure and permanently fences every later native operation", async () => {
  const f = await open(), unhandled: unknown[] = []; const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let faultReached!: () => void; const fault = new Promise<void>(resolve => { faultReached = resolve; });
  f.asset.state.onCall = name => { if (name === "CloseHandle") faultReached(); };
  f.asset.state.fault = "CloseHandle";
  try {
    await expect(f.workspace.files(async () => { await expect(f.workspace.close()).rejects.toMatchObject({ code: "boundary" }); })).rejects.toMatchObject({ code: "cancelled" });
    await fault; await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]); const count = f.asset.calls.length;
    await expect(f.workspace.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
    await expect(f.workspace.runNode(args, "/work", () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
    expect(f.asset.calls).toHaveLength(count); expect(f.profileState.deleted).toHaveLength(0);
  } finally { process.removeListener("unhandledRejection", onUnhandled); }
});

it("unknown actual image attestation never resumes, adopts, publishes or retries native disposal", async () => {
  const f = await open(); f.asset.state.imageMismatch = true;
  await expect(f.workspace.runNode(args, "/work", () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(f.io.events).not.toContain("resume"); expect(f.profileState.deleted).toHaveLength(0); expect(f.canonical.store.size).toBe(0);
  const counts = [f.asset.calls.length, f.nativeCalls.length];
  await expect(f.workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(f.workspace.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(counts);
});

it("profile delete uncertainty blocks artifact publication after tools close, and never retries or frees the unknown profile", async () => {
  const f = await open(); f.profileState.fault = "DeleteAppContainerProfile";
  await expect(f.workspace.sealForReview()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(f.asset.assets().every(row => row.removed)).toBe(true); expect(f.profileState.freed).toHaveLength(0);
  const count = f.nativeCalls.length;
  await expect(f.workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(f.workspace.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(f.nativeCalls).toHaveLength(count); expect(f.canonical.store.size).toBe(0);
});

it("original publication revocation remains revoked after resource closure and permits only known cleanup", async () => {
  const f = await open(); f.profileState.onCall = name => { if (name === "DeleteAppContainerProfile") f.revoke(); };
  await f.workspace.sealForReview();
  await expect(f.workspace.exportReview(f.input.reviewBase)).rejects.toMatchObject({ code: "cancelled" });
  expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1); expect(f.canonical.store.size).toBe(0);
  await cleanup(f);
});

it("positive native cancellation before a PI preserves prior file edits through genuine no-run review recovery", async () => {
  const f = await open(); await f.broker.replaceText("app.ts", "41", "45"); let cancelled = false, directoryReads = 0;
  const contexts = await import("../../app/main/agent/windows-command-copy"), directory = contexts.windowsCommandRootOnlyLaunchDirectory;
  // Observe a genuine context read, then revoke the shared task before the asset factory enters native output.
  vi.spyOn(contexts, "windowsCommandRootOnlyLaunchDirectory").mockImplementation(function (this: unknown, context) {
    const result = directory.call(this, context); directoryReads++; if (!cancelled) { cancelled = true; f.task.abort(); } return result;
  });
  await expect(f.workspace.runNode(args, "/work", () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(cancelled).toBe(true); expect(directoryReads).toBe(1); expect(f.io.state.creates).toBe(0); expect(f.io.events).not.toContain("resume"); expect(f.io.events).toContain("root-close");
  await f.broker.close(); await f.workspace.sealForReview(); const output = await f.workspace.exportReview(f.input.reviewBase);
  const proposed = output.review.proposed.find(row => row.path === "app.ts")!;
  expect(proposed.kind === "file" && Buffer.from(proposed.base64, "base64").toString()).toContain("45");
  expect(output.review.current).toEqual(output.review.baseline); expect(f.workspace.signal.aborted).toBe(true); await cleanup(f);
});

it("a positive native PI cancelled before Resume follows genuine cancelled completion/output/snapshot review", async () => {
  const f = await open(); await f.broker.replaceText("app.ts", "41", "46");
  const original = f.io.state.onNative;
  f.io.state.onNative = (name, values) => { original?.(name, values); if (name === "CreateProcessW") f.task.abort(); };
  const result = await f.workspace.runNode(args, "/work", () => undefined, new AbortController().signal);
  expect(result).toMatchObject({ observed: true, exitCode: null, stopped: true }); expect(f.io.state.creates).toBe(1); expect(f.io.events).not.toContain("resume");
  await f.broker.close(); await f.workspace.sealForReview(); const output = await f.workspace.exportReview(f.input.reviewBase);
  const proposed = output.review.proposed.find(row => row.path === "app.ts")!;
  expect(proposed.kind === "file" && Buffer.from(proposed.base64, "base64").toString()).toContain("46");
  expect(f.profileState.deleted).toHaveLength(1); expect(f.workspace.nodeAvailable).toBe(false); await cleanup(f);
});


it("genuine typed startup resource uncertainty stays a retained cleanup failure even if future current becomes true", async () => {
  const f = await setup(), native = await import("../../app/main/agent/windows-coding-native"), privacy = await import("../../app/main/agent/coding-privacy-scanner");
  const queries = vi.spyOn(f.canonical.api, "info"), scanner = vi.spyOn(privacy, "CodingPrivacyScanner");
  let reached = 0, atCalls = 0, atQueries = 0, atScanners = 0;
  Object.defineProperty(f.control, "current", { configurable: true, get() {
    reached++; atCalls = f.nativeCalls.length; atQueries = queries.mock.calls.length; atScanners = scanner.mock.calls.length;
    throw new native.WindowsCodingCleanupError();
  } });
  const failure = await f.create().catch(error => error);
  expect(failure).toMatchObject({ code: "windows-coding-cleanup-unverified" }); expect(reached).toBe(1);
  expect(f.nativeCalls).toHaveLength(atCalls); expect(queries).toHaveBeenCalledTimes(atQueries); expect(scanner).toHaveBeenCalledTimes(atScanners);
  expect(f.profileState.created).toEqual([]); expect(f.io.state.creates).toBe(0); expect(f.canonical.store.size).toBe(0);
  expect(f.canonical.handles.size).toBeGreaterThan(0); // The genuine earlier store captures remain owned; no disposal was certified.
  Object.defineProperty(f.control, "current", { configurable: true, value: true });
  expect(await f.create().catch(error => error)).toBe(failure);
  expect(f.nativeCalls).toHaveLength(atCalls); expect(queries).toHaveBeenCalledTimes(atQueries); expect(scanner).toHaveBeenCalledTimes(atScanners);
});

it("typed publication resource uncertainty cannot become ordinary cancellation or a later publication after restoration", async () => {
  const f = await open(), artifacts = await import("../../app/main/agent/coding-artifact-store"), privacy = await import("../../app/main/agent/coding-privacy-scanner");
  await f.broker.close(); await f.workspace.sealForReview();
  expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
  const queries = vi.spyOn(f.canonical.api, "info"), scanner = vi.spyOn(privacy, "CodingPrivacyScanner");
  let reached = 0, atCalls = 0, atQueries = 0, atScanners = 0;
  Object.defineProperty(f.control, "reviewCurrent", { configurable: true, get() {
    reached++; atCalls = f.nativeCalls.length; atQueries = queries.mock.calls.length; atScanners = scanner.mock.calls.length;
    throw new artifacts.CodingArtifactCleanupError();
  } });
  const failure = await f.workspace.exportReview(f.input.reviewBase).catch(error => error);
  expect(failure).toMatchObject({ code: "windows-coding-cleanup-unverified" }); expect(reached).toBe(1);
  expect(f.canonical.store.size).toBe(0); expect(f.nativeCalls).toHaveLength(atCalls); expect(queries).toHaveBeenCalledTimes(atQueries); expect(scanner).toHaveBeenCalledTimes(atScanners);
  Object.defineProperty(f.control, "reviewCurrent", { configurable: true, value: true });
  expect(await f.workspace.exportReview(f.input.reviewBase).catch(error => error)).toBe(failure);
  expect(await f.workspace.close().catch(error => error)).toBe(failure);
  expect(f.nativeCalls).toHaveLength(atCalls); expect(queries).toHaveBeenCalledTimes(atQueries); expect(scanner).toHaveBeenCalledTimes(atScanners);
});


it("a swallowed reentrant startup cleanup failure is still thrown to the active asset guard without native disposal", async () => {
  const f = await setup(), native = await import("../../app/main/agent/windows-coding-native"), privacy = await import("../../app/main/agent/coding-privacy-scanner");
  const scanner = vi.spyOn(privacy, "CodingPrivacyScanner"), queries = vi.spyOn(f.canonical.api, "info");
  let nested: ReturnType<typeof f.create> | undefined, nestedFailure: unknown, reached = false;
  let atAsset = 0, atCalls = 0, atQueries = 0, atScanners = 0;
  Object.defineProperty(f.control, "current", { configurable: true, get() {
    if (reached) {
      atAsset = f.asset.calls.length; atCalls = f.nativeCalls.length; atQueries = queries.mock.calls.length; atScanners = scanner.mock.calls.length;
      throw new native.WindowsCodingCleanupError();
    }
    if (f.asset.state.writes > 0) {
      reached = true; nested = f.create(); void nested.catch(error => { nestedFailure = error; });
    }
    return true; // The original host callback deliberately swallows the nested rejected promise.
  } });
  const failure = await f.create().catch(error => error); await nested?.catch(() => undefined);
  expect(reached).toBe(true); expect(f.asset.state.writes).toBeGreaterThan(0); expect(nestedFailure).toBe(failure);
  expect(failure).toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(f.asset.calls).toHaveLength(atAsset); expect(f.nativeCalls).toHaveLength(atCalls); expect(queries).toHaveBeenCalledTimes(atQueries); expect(scanner).toHaveBeenCalledTimes(atScanners);
  expect(f.profileState.deleted).toHaveLength(0); expect(f.io.state.creates).toBe(0); expect(f.canonical.store.size).toBe(0);
  Object.defineProperty(f.control, "current", { configurable: true, value: true });
  expect(await f.create().catch(error => error)).toBe(failure); expect(f.asset.calls).toHaveLength(atAsset);
});
