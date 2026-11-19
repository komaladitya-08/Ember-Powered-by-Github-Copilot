/** Platform selection and host capability ownership; native suites prove the selected implementations. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScopedCodingHost } from "../../app/main/agent/host";
import type { ProjectCodingResourcesOptions } from "../../app/main/agent/coding-resources";
import type { CodingReviewWorkspace } from "../../app/main/agent/coding-platform";
import type { TaskSpec } from "../../app/main/agent/worker";

const f = vi.hoisted(() => {
  class Workspace { filesBroker = vi.fn(async (_signal: AbortSignal) => ({ close: async () => undefined })); }
  return { linux: vi.fn(), windows: vi.fn(), Workspace };
});
vi.mock("../../app/main/agent/coding-resources", () => ({ ProjectCodingResources: { create: f.linux } }));
vi.mock("../../app/main/agent/windows-coding-resources", () => ({ WindowsProjectCodingResources: { createNode: f.windows } }));
vi.mock("../../app/main/agent/windows-file-only-workspace", () => ({ WindowsFileOnlyWorkspace: f.Workspace }));
beforeEach(() => { vi.resetModules(); f.linux.mockReset(); f.windows.mockReset(); });
afterEach(() => { vi.doUnmock("../../app/main/platform/os"); });
const spec = { id: "selected-task", goal: "Edit the copied app", target: {} } as TaskSpec;
const options = { userData: "/private", protectedPaths: ["/private"], currentOwner: () => "owner", projectExists: () => true,
  env: {}, execPath: "/node", isElectron: false } satisfies ProjectCodingResourcesOptions;
function common() {
  let base = "before-ready";
  const value: Omit<ScopedCodingHost, "mode" | "platform" | "createWorkspace"> = { available: () => true,
    workspace: () => null, get reviewBase() { return base; }, publish: vi.fn(async () => ({} as never)) };
  return { value, setBase: (next: string) => { base = next; } };
}
async function select(platform: string) {
  vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: platform, HOST_ARCH: "x64" }));
  return (await import("../../app/main/agent/project-coding-backend")).createProjectCodingBackend;
}

it.each(["linux", "darwin"])("preserves the existing command resource path on %s with no restricted fallback", async platform => {
  const workspace = {}, createWorkspace = vi.fn(async () => workspace), resource = { createWorkspace };
  f.linux.mockResolvedValue(resource); f.windows.mockRejectedValue(new Error("Windows must never be selected"));
  const create = await select(platform), backend = create(options), c = common(), host = backend.host(c.value), signal = new AbortController().signal, admit = () => true;
  expect(await backend.ready).toBe(resource); expect(host.mode).toBe("commands"); expect(host.platform).toBeUndefined();
  expect(await host.createWorkspace(spec, signal, admit)).toBe(workspace); expect(createWorkspace).toHaveBeenCalledExactlyOnceWith(spec, signal, admit);
  c.setBase("after-ready"); expect(host.reviewBase).toBe("after-ready");
  expect(f.linux).toHaveBeenCalledExactlyOnceWith(options); expect(f.windows).not.toHaveBeenCalled();
});

it("selects fixed Windows Node mode and delegates only exact owned wrappers to the resource adapter", async () => {
  const workspace = new f.Workspace(), foreign = new f.Workspace(), platform = { facts: vi.fn(), files: vi.fn(async (owner: typeof workspace, signal: AbortSignal) => owner.filesBroker(signal)) },
    resource = { createNodeWorkspace: vi.fn(async () => workspace), nodePlatform: platform, availability: () => ({ available: true, canContinue: false }) };
  f.windows.mockResolvedValue(resource); const create = await select("win32"), backend = create(options), c = common(), enabled = vi.fn(() => true), host = backend.host(c.value, enabled);
  expect(enabled).not.toHaveBeenCalled();
  const capability = host.captureCapability!();
  if (!capability || capability.mode !== "commands") throw new Error("Expected Node command mode");
  expect(capability.toolchain).toBe("windows-node"); expect(Object.isFrozen(capability)).toBe(true);
  expect((await backend.ready).availability()).toMatchObject({ canContinue: false });
  const signal = new AbortController().signal, admit = () => true, owned = await capability.createWorkspace(spec, signal, admit);
  const broker = await capability.platform!.files(owned, signal); expect(broker).toBe(await workspace.filesBroker.mock.results[0].value);
  expect(workspace.filesBroker).toHaveBeenCalledExactlyOnceWith(signal);
  for (const candidate of [foreign, new Proxy(workspace, {}), { ...workspace }]) {
    await expect(capability.platform!.files(candidate as unknown as CodingReviewWorkspace, signal)).rejects.toMatchObject({ code: "boundary" });
    expect(() => capability.platform!.facts(candidate as never, {} as never)).toThrow(expect.objectContaining({ code: "boundary" }));
  }
  expect(platform.files).toHaveBeenCalledExactlyOnceWith(owned, signal); expect(platform.facts).not.toHaveBeenCalled();
  expect(foreign.filesBroker).not.toHaveBeenCalled(); expect(f.windows).toHaveBeenCalledExactlyOnceWith(options); expect(f.linux).not.toHaveBeenCalled();
  c.setBase("current-review-base"); expect(host.reviewBase).toBe("current-review-base");
});

it.each(["linux", "win32"])("retains %s initialization failures without selecting another capability", async platform => {
  const failure = new Error("Owned setup failed"), own = platform === "win32" ? f.windows : f.linux, other = platform === "win32" ? f.linux : f.windows;
  own.mockRejectedValue(failure); const create = await select(platform), backend = create(options), host = backend.host(common().value, () => true);
  await expect(backend.ready).rejects.toBe(failure);
  const capability = host.captureCapability?.() ?? host;
  await expect(capability.createWorkspace(spec, new AbortController().signal, () => true)).rejects.toBe(failure);
  expect(other).not.toHaveBeenCalled(); expect(host.mode).toBe("commands");
});

it("captures the OFF choice atomically before initialization and cannot upgrade it or share Node wrappers", async () => {
  let release!: (resource: unknown) => void;
  f.windows.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const create = await select("win32"), backend = create(options), enabled = { on: false }, choose = vi.fn(() => enabled.on);
  const host = backend.host(common().value, choose), off = host.captureCapability!();
  expect(choose).toHaveBeenCalledTimes(1); if (off?.mode !== "files-only") throw new Error("Expected explicit files-only mode");
  enabled.on = true;
  const node = new f.Workspace(), file = new f.Workspace(), platform = { facts: vi.fn(), files: vi.fn(async () => ({} as never)) };
  const resource = { createNodeWorkspace: vi.fn(async () => node), createFileWorkspace: vi.fn(async () => file), nodePlatform: platform, filePlatform: platform };
  const pending = off.createWorkspace(spec, new AbortController().signal, () => true); release(resource);
  expect(await pending).toBe(file); expect(resource.createNodeWorkspace).not.toHaveBeenCalled(); expect(choose).toHaveBeenCalledTimes(1);
  const on = host.captureCapability!(); if (!on || on.mode !== "commands") throw new Error("Expected Node mode for new intake");
  const signal = new AbortController().signal, owned = await on.createWorkspace(spec, signal, () => true);
  await expect(off.platform.files(owned, signal)).rejects.toMatchObject({ code: "boundary" });
  await expect(on.platform!.files(file as unknown as CodingReviewWorkspace, signal)).rejects.toMatchObject({ code: "boundary" });
  await expect(host.createWorkspace(spec, signal, () => true)).rejects.toMatchObject({ code: "boundary" });
});

it("keeps a failed accepted Node startup in Node mode and never starts a files-only fallback", async () => {
  const failure = new Error("Owned Node startup refused"), resource = { createNodeWorkspace: vi.fn(async () => { throw failure; }),
    createFileWorkspace: vi.fn(), nodePlatform: { facts: vi.fn(), files: vi.fn() } };
  f.windows.mockResolvedValue(resource); const create = await select("win32"), host = create(options).host(common().value, () => true);
  const captured = host.captureCapability!(); if (!captured || captured.mode !== "commands") throw new Error("Expected accepted Node mode");
  await expect(captured.createWorkspace(spec, new AbortController().signal, () => true)).rejects.toBe(failure);
  expect(captured.mode).toBe("commands"); expect(resource.createFileWorkspace).not.toHaveBeenCalled();
});

it("permanently revokes an observed disabled Node snapshot and refuses pending creation without touching either factory", async () => {
  const resource = { createNodeWorkspace: vi.fn(), createFileWorkspace: vi.fn() }; f.windows.mockResolvedValue(resource);
  let on = true; const create = await select("win32"), host = create(options).host(common().value, () => on), captured = host.captureCapability!()!;
  expect(captured.current!()).toBe(true); on = false; expect(captured.current!()).toBe(false); on = true; expect(captured.current!()).toBe(false);
  await expect(captured.createWorkspace(spec, new AbortController().signal, () => true)).rejects.toMatchObject({ code: "cancelled" });
  expect(resource.createNodeWorkspace).not.toHaveBeenCalled(); expect(resource.createFileWorkspace).not.toHaveBeenCalled();
});

it.each([[false, "stop"], [false, "grant"], [true, "stop"], [true, "grant"]] as const)("keeps captured mode %s revoked after its initialization wait (%s)", async (on, changed) => {
  let release!: (resource: unknown) => void;
  f.windows.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const create = await select("win32"), host = create(options).host(common().value, () => on), capability = host.captureCapability!()!;
  const task = new AbortController(); let admitted = true;
  const pending = capability.createWorkspace(spec, task.signal, () => admitted), failure = pending.catch(error => error);
  if (changed === "stop") task.abort(); else admitted = false;
  const resource = { createNodeWorkspace: vi.fn(), createFileWorkspace: vi.fn() }; release(resource);
  expect(await failure).toMatchObject({ code: "cancelled" });
  expect(resource.createNodeWorkspace).not.toHaveBeenCalled(); expect(resource.createFileWorkspace).not.toHaveBeenCalled();
});

it.each(["missing", "throw", "nonboolean"])("refuses an unverifiable trusted command selector (%s)", async kind => {
  const resource = { createNodeWorkspace: vi.fn(), createFileWorkspace: vi.fn() }; f.windows.mockResolvedValue(resource);
  const choose = kind === "missing" ? undefined : kind === "throw" ? () => { throw new Error("Private settings failure"); } : () => "true" as unknown as boolean;
  const create = await select("win32"), host = create(options).host(common().value, choose);
  expect(host.captureCapability!()).toBeNull(); expect(resource.createNodeWorkspace).not.toHaveBeenCalled(); expect(resource.createFileWorkspace).not.toHaveBeenCalled();
});

it("captures the exact project WSL capability without consulting the local command switch or native Node factory", async () => {
  const workspace = new f.Workspace(), platform = { facts: vi.fn(), files: vi.fn(async () => ({ close: async () => undefined })) },
    resource = { createWslWorkspace: vi.fn(async () => workspace), wslPlatform: platform, createNodeWorkspace: vi.fn(), createFileWorkspace: vi.fn() };
  f.windows.mockResolvedValue(resource); const create = await select("win32"), target = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu", shellOs: "linux", screenOs: "win32", desktop: "none" } as const;
  const current = vi.fn(() => true), open = vi.fn(), binding = Object.freeze({ target, current, open }), capture = vi.fn(() => binding);
  const local = vi.fn(() => { throw new Error("Local selection must not override WSL"); }), backend = create(options, { capture }), host = backend.host(common().value, local);
  const capability = host.captureCapability!("project"); expect(capture).toHaveBeenCalledExactlyOnceWith("project"); expect(local).not.toHaveBeenCalled();
  if (!capability || capability.mode !== "commands") throw new Error("Expected WSL capability");
  expect(capability.target).toBe(target); expect(capability.toolchain).toBeUndefined(); expect(capability.current).toBe(current);
  const task = { ...spec, codingWorkspace: { projectId: "project", path: "C:\\project", current: () => true } }, signal = new AbortController().signal;
  const result = await capability.createWorkspace(task, signal, () => true); expect(result).toBe(workspace);
  expect(resource.createWslWorkspace).toHaveBeenCalledExactlyOnceWith(task, signal, expect.any(Function), binding);
  await capability.platform!.files(result, signal); expect(platform.files).toHaveBeenCalledExactlyOnceWith(workspace, signal);
  await expect(capability.platform!.files(new f.Workspace() as unknown as CodingReviewWorkspace, signal)).rejects.toMatchObject({ code: "boundary" });
  expect(resource.createNodeWorkspace).not.toHaveBeenCalled(); expect(resource.createFileWorkspace).not.toHaveBeenCalled();
});
it("preserves refusal of a blocked explicitly selected WSL backend without falling back to files or Node", async () => {
  const resource = { createWslWorkspace: vi.fn(), createNodeWorkspace: vi.fn(), createFileWorkspace: vi.fn() }; f.windows.mockResolvedValue(resource);
  const create = await select("win32"), capture = vi.fn(() => null), local = vi.fn(() => true), host = create(options, { capture }).host(common().value, local);
  expect(host.captureCapability!("project")).toBeNull(); expect(local).not.toHaveBeenCalled();
  expect(resource.createWslWorkspace).not.toHaveBeenCalled(); expect(resource.createNodeWorkspace).not.toHaveBeenCalled(); expect(resource.createFileWorkspace).not.toHaveBeenCalled();
});
