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
vi.mock("../../app/main/agent/windows-coding-resources", () => ({ WindowsProjectCodingResources: { create: f.windows } }));
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

it("selects fixed Windows files-only mode and permits brokers only for workspaces created by this selector", async () => {
  const workspace = new f.Workspace(), foreign = new f.Workspace(), resource = { createWorkspace: vi.fn(async () => workspace), availability: () => ({ available: true, canContinue: false }) };
  f.windows.mockResolvedValue(resource); const create = await select("win32"), backend = create(options), c = common(), host = backend.host(c.value);
  expect(host.mode).toBe("files-only"); if (host.mode !== "files-only") throw new Error("Expected restricted mode");
  expect((await backend.ready).availability()).toMatchObject({ canContinue: false });
  const signal = new AbortController().signal, admit = () => true, owned = await host.createWorkspace(spec, signal, admit);
  const broker = await host.platform.files(owned, signal); expect(broker).toBe(await workspace.filesBroker.mock.results[0].value);
  expect(workspace.filesBroker).toHaveBeenCalledExactlyOnceWith(signal);
  await expect(host.platform.files(foreign as unknown as CodingReviewWorkspace, signal)).rejects.toMatchObject({ code: "boundary" });
  expect(foreign.filesBroker).not.toHaveBeenCalled(); expect(f.windows).toHaveBeenCalledExactlyOnceWith(options); expect(f.linux).not.toHaveBeenCalled();
  c.setBase("current-review-base"); expect(host.reviewBase).toBe("current-review-base");
});

it.each(["linux", "win32"])("retains %s initialization failures without selecting another capability", async platform => {
  const failure = new Error("Owned setup failed"), own = platform === "win32" ? f.windows : f.linux, other = platform === "win32" ? f.linux : f.windows;
  own.mockRejectedValue(failure); const create = await select(platform), backend = create(options), host = backend.host(common().value);
  await expect(backend.ready).rejects.toBe(failure);
  await expect(host.createWorkspace(spec, new AbortController().signal, () => true)).rejects.toBe(failure);
  expect(other).not.toHaveBeenCalled(); expect(host.mode).toBe(platform === "win32" ? "files-only" : "commands");
});
