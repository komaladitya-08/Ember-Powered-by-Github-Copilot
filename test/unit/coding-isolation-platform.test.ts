import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../app/main/platform/os");
  vi.resetModules();
});

describe("experimental coding isolation platform guards", () => {
  it.each(["win32", "darwin", "freebsd"] as const)("rejects snapshots on %s before accessing paths", async platform => {
    vi.resetModules();
    vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: platform, HOST_ARCH: "x64" }));
    const { createCodingSnapshot } = await import("../../app/main/agent/coding-snapshot");
    await expect(createCodingSnapshot("not-absolute", "not-absolute", [])).rejects.toThrow(/not supported on this platform/);
  });

  it.each([
    { platform: "darwin", arch: "x64" },
    { platform: "win32", arch: "x64" },
    { platform: "freebsd", arch: "x64" },
    { platform: "linux", arch: "arm64" },
  ])("rejects runtime on $platform/$arch before accessing paths", async ({ platform, arch }) => {
    vi.resetModules();
    vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: platform, HOST_ARCH: arch }));
    const { ExperimentalIsolatedRuntime } = await import("../../app/main/agent/experimental-isolated-runtime");
    await expect(ExperimentalIsolatedRuntime.start({ source: "not-absolute", baseDir: "not-absolute", protectedPaths: [], runtimePath: "not-absolute" }))
      .rejects.toThrow(/requires Linux x64/);
  });
});
