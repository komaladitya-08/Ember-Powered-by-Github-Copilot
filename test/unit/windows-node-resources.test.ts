/** Resource and genuine owner composition. DLLs/hash streams model Windows; no native enforcement claim. */
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import win from "node:path/win32";
import { setupWindowsNodeResources, NODE_PROJECT } from "../fixtures/windows-node-resources-fake";

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ["node:module", "node:crypto", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.resetModules();
});
const argv = ["--preserve-symlinks", "--preserve-symlinks-main", "app.ts"];
const facts = { os: "win32" as const, shells: [], shellPaths: {}, script: null, home: "C:\\host", user: "host", privileged: false, pty: false,
  ember: { paths: [], pids: [], names: /ember/i }, extraPath: [] };

it("binds with the genuine Windows path grammar captured before a shared win32 property spy", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open();
  // On Windows this property also backs node:path.isAbsolute. Never install the spy as its own implementation.
  const changed = vi.spyOn(win, "isAbsolute").mockImplementation(() => { throw new Error("The changed path property must not supply bind authority."); });
  try {
    await f.bind(owner);
    expect(owner.workspace(NODE_PROJECT)).toMatchObject({ path: "C:\\project" });
    expect(f.profileState.created).toHaveLength(0); expect(f.io.state.creates).toBe(0);
  } finally { changed.mockRestore(); await owner.close(); }
  expect(f.canonical.handles.size).toBe(0);
});

it("requires an explicit trusted resources path before admitting any Node resource storage", async () => {
  const f = await setupWindowsNodeResources(), pin = vi.spyOn(f.canonical.api, "pin");
  const owner = await f.WindowsProjectCodingResources.createNode({ ...f.options, resourcesPath: undefined });
  expect(owner.availability()).toMatchObject({ available: false, mode: "commands" }); expect(pin).not.toHaveBeenCalled();
  expect(f.profileState.created).toHaveLength(0); await owner.close();
});

it("keeps the genuine earlier files-only factory and its two-role cleanup without inventing an assets receipt", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(false);
  expect(owner.availability()).toMatchObject({ available: true, mode: "files-only" });
  expect([...f.canonical.nodes.values()].some(row => row.info.finalPath.endsWith("\\assets"))).toBe(false);
  await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("explicit files-only capture on the Node manager creates no profile/assets and cannot enter the Node adapter", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner);
  expect(owner.availability("files-only")).toMatchObject({ available: true, mode: "files-only", message: expect.stringContaining("Commands, tests and dependency installation are unavailable") });
  const workspace = await owner.createFileWorkspace(f.spec(owner), f.task.signal, () => true);
  expect(workspace).not.toHaveProperty("runNode"); expect(f.profileState.created).toHaveLength(0); expect(f.asset.state.writes).toBe(0);
  expect(() => owner.nodePlatform.facts(workspace as never, facts)).toThrow(expect.objectContaining({ code: "boundary" }));
  await expect(owner.nodePlatform.files(workspace, f.task.signal)).rejects.toMatchObject({ code: "boundary" });
  for (const foreign of [new Proxy(workspace, {}), { ...workspace }]) await expect(owner.filePlatform.files(foreign, f.task.signal)).rejects.toMatchObject({ code: "boundary" });
  const broker = await owner.filePlatform.files(workspace, f.task.signal); await broker.replaceText("app.ts", "41", "42");
  await broker.close(); await workspace.sealForReview!(); const output = await workspace.exportReview(owner.reviewBase);
  expect(output.review.proposed.find(entry => entry.path === "app.ts")).toMatchObject({ base64: Buffer.from("export const answer = 42;\n").toString("base64") });
  expect(f.profileState.created).toHaveLength(0); expect(f.io.state.creates).toBe(0); await workspace.close(); await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("missing assets leave real OFF/file-only source and review authority usable while Node refuses before allocation", async () => {
  const f = await setupWindowsNodeResources(); f.asset.nodes.delete("C:\\Ember\\resources\\coding\\windows-node-x64\\node.exe");
  const owner = await f.open(), metadata = vi.spyOn(fs, "lstatSync"), atMetadata = metadata.mock.calls.length;
  expect(owner.availability()).toMatchObject({ available: false, mode: "commands", message: expect.stringContaining("Bundled Node is unavailable") });
  expect(owner.availability("files-only")).toMatchObject({ available: true, mode: "files-only" }); expect(metadata).toHaveBeenCalledTimes(atMetadata);
  await f.bind(owner); const nodeSpec = f.spec(owner), creates = vi.spyOn(f.canonical.api, "create");
  await expect(owner.createNodeWorkspace(nodeSpec, f.task.signal, () => true)).rejects.toMatchObject({ code: "unavailable" });
  expect(creates).not.toHaveBeenCalled(); expect(f.profileState.created).toHaveLength(0); expect(f.asset.state.writes).toBe(0);
  const fileSpec = f.spec(owner); expect(fileSpec.id).not.toBe(nodeSpec.id);
  const workspace = await owner.createFileWorkspace(fileSpec, f.task.signal, () => true), broker = await owner.filePlatform.files(workspace, f.task.signal);
  await broker.replaceText("app.ts", "41", "42"); await broker.close(); await workspace.sealForReview!();
  expect((await workspace.exportReview(owner.reviewBase)).review.textPatch).toContain("answer = 42");
  expect(f.profileState.created).toHaveLength(0); expect(f.io.state.creates).toBe(0); await workspace.close(); await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it.each(["directory", "reparse", "hardlink"])("unsupported packaged %s metadata refuses Node before profile or canonical allocation", async kind => {
  const f = await setupWindowsNodeResources(), image = f.asset.nodes.get("C:\\Ember\\resources\\coding\\windows-node-x64\\node.exe")!;
  if (kind === "directory") image.kind = "directory"; else if (kind === "reparse") image.attributes |= 0x400; else image.links = 2;
  const owner = await f.open(); await f.bind(owner); const creates = vi.spyOn(f.canonical.api, "create");
  await expect(owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true)).rejects.toMatchObject({ code: "unavailable" });
  expect(creates).not.toHaveBeenCalled(); expect(f.profileState.created).toHaveLength(0); expect(owner.availability("files-only").available).toBe(true);
  await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("removal after the presence snapshot is a known pre-allocation Node refusal and leaves only a fresh explicit file task", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner); expect(owner.availability().available).toBe(true);
  f.asset.nodes.delete("C:\\Ember\\resources\\coding\\windows-node-x64\\LICENSE");
  const creates = vi.spyOn(f.canonical.api, "create"); await expect(owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true)).rejects.toMatchObject({ code: "unavailable" });
  expect(creates).not.toHaveBeenCalled(); expect(f.profileState.created).toHaveLength(0); expect(owner.availability().available).toBe(false);
  const workspace = await owner.createFileWorkspace(f.spec(owner), f.task.signal, () => true); await workspace.close(); await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("present metadata never attests content: tampered asset bytes fence both Node and file factories instead of downgrading", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner); expect(owner.availability().available).toBe(true); f.asset.state.sourceTamper = true;
  await expect(owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(f.asset.state.readCalls).toBeGreaterThan(0); expect(f.profileState.created).toHaveLength(1); expect(f.io.state.creates).toBe(0);
  const info = vi.spyOn(f.canonical.api, "info"), calls = [f.asset.calls.length, f.nativeCalls.length];
  expect(owner.availability("files-only").available).toBe(false); await expect(owner.createFileWorkspace(f.spec(owner), f.task.signal, () => true)).rejects.toThrow();
  await expect(owner.close()).rejects.toThrow(); expect(info).not.toHaveBeenCalled(); expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(calls); expect(f.profileState.deleted).toHaveLength(0);
});

it("owns three protected roles and resolves only its exact wrapper into the unchanged genuine Node adapter", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner);
  expect(owner.availability()).toMatchObject({ available: true, mode: "commands" });
  expect([...f.canonical.nodes.values()].filter(row => /\\(?:copies|reviews|assets)$/.test(row.info.finalPath) && row.info.finalPath.includes("\\process-")).length).toBe(3);
  const workspace = await owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true);
  await expect(owner.filePlatform.files(workspace, f.task.signal)).rejects.toMatchObject({ code: "boundary" });
  expect(owner.nodePlatform.facts(workspace, facts)).toMatchObject({ os: "win32", shells: [], home: "/work" });
  const { windowsNodeCodingPlatform } = await import("../../app/main/agent/windows-node-coding-platform");
  expect(() => windowsNodeCodingPlatform.facts(workspace, facts)).toThrow(expect.objectContaining({ code: "boundary" }));
  for (const candidate of [new Proxy(workspace, {}), { ...workspace }, Object.create(Object.getPrototypeOf(workspace))]) {
    expect(() => owner.nodePlatform.facts(candidate, facts)).toThrow(expect.objectContaining({ code: "boundary" }));
    await expect(owner.nodePlatform.files(candidate, f.task.signal)).rejects.toMatchObject({ code: "boundary" });
  }
  const broker = await owner.nodePlatform.files(workspace, f.task.signal);
  expect(await broker.inspect(["\\work\\APP.TS"])).toMatchObject([{ exists: true, real: "\\work\\app.ts" }]);
  await broker.close(); await workspace.close(); await owner.close(); expect(f.canonical.handles.size).toBe(0);
  expect(f.profileState.deleted).toHaveLength(1); expect(f.profileState.freed).toHaveLength(1);
});

it("transfers a genuine failed Node check's repaired review through the original resource registry without source writes", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner); const spec = f.spec(owner);
  const workspace = await owner.createNodeWorkspace(spec, f.task.signal, () => true), broker = await owner.nodePlatform.files(workspace, f.task.signal);
  f.control.onResume = () => { f.io.state.code = 17; };
  expect(await workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).toMatchObject({ observed: true, exitCode: 17 });
  await broker.replaceText("app.ts", "41", "42"); await broker.close(); await workspace.sealForReview!();
  const output = await workspace.exportReview(owner.reviewBase), result = await owner.publish(spec, output, "failed", { ran: 1, passed: 0, failed: 1 });
  expect(result).toMatchObject({ projectId: NODE_PROJECT, status: "failed", checks: { ran: 1, passed: 0, failed: 1 } });
  expect((await owner.results()).state(NODE_PROJECT)).toHaveLength(1);
  expect(f.canonical.nodes.get(f.canonical.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toContain("41");
  await workspace.close(); await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("invalidates a real active Node owner before queued cleanup and never revives its account or publication authority", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner);
  const spec = f.spec(owner), workspace = await owner.createNodeWorkspace(spec, f.task.signal, () => true); f.control.autoFinish = false;
  const run = workspace.runNode!(argv, "\\work", () => undefined, f.task.signal).catch(error => error);
  await vi.waitFor(() => expect(f.io.events).toContain("resume")); const invalidated = owner.invalidate();
  expect((Reflect.get(workspace, "signal") as AbortSignal).aborted).toBe(true); await run; await invalidated;
  expect(f.io.events).toContain("TerminateJobObject"); expect(f.profileState.deleted).toHaveLength(1);
  await expect(owner.createNodeWorkspace(spec, f.task.signal, () => true)).rejects.toThrow();
  expect((await owner.results()).state(NODE_PROJECT)).toEqual([]); await owner.close(); expect(f.canonical.handles.size).toBe(0);
});

it("retains an unknown image owner and fences resource admission and cleanup without later native queries", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(); await f.bind(owner);
  const workspace = await owner.createNodeWorkspace(f.spec(owner), f.task.signal, () => true); f.asset.state.imageMismatch = true;
  await expect(workspace.runNode!(argv, "\\work", () => undefined, f.task.signal)).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(f.io.state.creates).toBe(1); expect(f.asset.calls.some(call => call.name === "QueryFullProcessImageNameW")).toBe(true);
  expect(owner.availability().available).toBe(false); const counts = [f.asset.calls.length, f.nativeCalls.length], queries = vi.spyOn(f.canonical.api, "info");
  await expect(workspace.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(owner.close()).rejects.toThrow(); expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(counts);
  expect(queries).not.toHaveBeenCalled();
  expect(f.profileState.deleted).toHaveLength(0); expect(f.canonical.handles.size).toBeGreaterThan(0);
});

it("preserves a genuine storage cleanup rejection and performs no later native info or close after its resource fence", async () => {
  const f = await setupWindowsNodeResources(), owner = await f.open(), native = await import("../../app/main/agent/windows-coding-native");
  const original = new native.WindowsCodingCleanupError(), queries = vi.spyOn(f.canonical.api, "info").mockImplementationOnce(() => { throw original; });
  await expect(owner.validateSource({ path: "C:\\project", current: () => true })).rejects.toBe(original);
  expect(owner.availability().available).toBe(false); const atQueries = queries.mock.calls.length, atCalls = [f.asset.calls.length, f.nativeCalls.length];
  await expect(owner.close()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  await expect(owner.invalidate()).rejects.toMatchObject({ code: "windows-coding-cleanup-unverified" });
  expect(queries).toHaveBeenCalledTimes(atQueries); expect([f.asset.calls.length, f.nativeCalls.length]).toEqual(atCalls);
  expect(f.canonical.handles.size).toBeGreaterThan(0); expect(f.profileState.created).toHaveLength(0);
});
