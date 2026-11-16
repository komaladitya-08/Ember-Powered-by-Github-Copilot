/** Invokes the actual detached-root proof; native/file boundaries are synthetic and the original compilation issuer stays exact. */
import { beforeEach, expect, it, vi } from "vitest";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
const state = vi.hoisted(() => ({
  caseId: 0, compiledIssuer: "ember-experimental-windows-child-process-policy-fixed-probe", launchArguments: undefined as readonly string[] | undefined, descriptors: new Map<number, string>(), nextDescriptor: 1, hostFailure: undefined as unknown, closeCalls: 0,
  asset: Buffer.from("fixed public image"), profile: { name: "fixed-package", sid: 100n, sidText: "S-1-15-2-123" },
}));
vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>(); return { ...actual, default: actual.win32 };
});
vi.mock("node:fs", () => {
  const content = (file: string) => file.endsWith("build-receipt.json") ? Buffer.from("{}") : file.endsWith("child-policy.bin") ? Buffer.alloc(320) : state.asset;
  const stat = (file: string) => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: content(file).length, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1 });
  return { default: { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
    realpathSync: { native: (file: string) => file }, lstatSync: stat,
    openSync(file: string) { const fd = state.nextDescriptor++; state.descriptors.set(fd, file); return fd; },
    fstatSync: (fd: number) => stat(state.descriptors.get(fd)!), closeSync: (fd: number) => { state.descriptors.delete(fd); },
    readSync(fd: number, target: Buffer, offset: number, length: number, position: number) { return content(state.descriptors.get(fd)!).copy(target, offset, position, position + length); },
  } };
});
vi.mock("../../scripts/experimental/build-windows-child-process-policy.mjs", async () => {
  const { createHash } = await import("node:crypto");
  return { buildPin: { get issuer() { return state.compiledIssuer; }, maximumExecutableBytes: 16 * 1024 * 1024 },
    parseWindowsChildProcessPolicyBuildReceipt: () => ({ asset: { name: "child-process-policy-probe.exe", bytes: state.asset.length, sha256: createHash("sha256").update(state.asset).digest("hex") } }),
  };
});
vi.mock("../fixtures/windows-child-process-policy-checks", () => ({ loadWindowsChildPolicyChecks: () => ({
  pin: () => ({ unchanged() {}, close() {} }), image() {},
}) }));
vi.mock("../fixtures/windows-child-process-policy-job", () => ({ loadWindowsChildPolicyJob: () => ({ setTwo() {} }) }));
vi.mock("../fixtures/windows-child-process-policy-host-identity", () => ({ loadWindowsChildPolicyHostIdentity: () => ({ inspect: () => ({
  sameUser: true, parent: { hasRestrictingSids: false, integrityRid: 12288, appContainer: 0 }, host: { hasRestrictingSids: false, integrityRid: 12288, appContainer: 0 },
}) }) }));
vi.mock("../fixtures/windows-child-process-policy-report", () => ({ WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES: 320,
  parseWindowsChildProcessPolicyReport: () => ({ status: 1, controls: 15, plain: { created: 1 }, override: { created: 1 } }),
}));
vi.mock("../fixtures/windows-child-process-policy-detached-io", () => {
  return {
  WindowsChildProcessPolicyIoCleanupError: class extends Error {},
  loadWindowsChildProcessPolicyDetachedIo: () => ({ createHost: () => {
    if (state.hostFailure !== undefined) throw state.hostFailure;
    return { process: 20n, thread: 21n, pid: 22 };
  },
    processPolicy: () => state.caseId === 1 || state.caseId >= 3 && state.caseId <= 7 ? 1 : 0,
    acceptHostControl() {}, close() {},
  }),
  };
});
vi.mock("../fixtures/windows-child-process-policy-host", () => ({ runWindowsChildPolicyHost: async (input: { program: string; command: Buffer; cwd: string; environment: Buffer; unchanged(): void },
  _api: unknown, native: { create(...args: unknown[]): unknown; verify(process: unknown, program: string): void }) => {
  input.unchanged(); const child = native.create(input.program, input.command, input.cwd, input.environment); native.verify(child, input.program);
  return { exitCode: 0, jobStopped: true };
} }));
vi.mock("../../app/main/agent/experimental-windows-lpac", async original => {
  const actual = await original<typeof import("../../app/main/agent/experimental-windows-lpac")>();
  return { ...actual, ExperimentalWindowsLpacFixture: { prepare(_parent: string, _bytes: Buffer, api: WindowsLpacApi) {
    api.createProfile("fixed-package");
    return { paths: { root: "C:\\Native\\package", tools: "C:\\Native\\package\\tools", work: "C:\\Native\\package\\work", state: "C:\\Native\\package\\state", program: "C:\\Native\\package\\tools\\fixture.exe" },
      async launch(args: readonly string[] = []) { state.launchArguments = [...args]; throw new Error("fixed test intercept at actual launch boundary"); }, async close() { state.closeCalls++; },
    };
  } } };
});
beforeEach(() => { vi.resetModules(); state.compiledIssuer = "ember-experimental-windows-child-process-policy-fixed-probe"; state.launchArguments = undefined; state.descriptors.clear(); state.nextDescriptor = 1; state.hostFailure = undefined; state.closeCalls = 0; });
it.each([0, 1, 2, 3, 4, 5, 6, 7, 8] as const)("actual detached-root proof forwards only the fixed case %s arguments into canonical launch", async caseId => {
  state.caseId = caseId;
  const { runWindowsChildProcessPolicyDetachedProbe: runWindowsChildProcessPolicyProbe } = await import("../fixtures/windows-child-process-policy-detached-proof");
  const api = { createProfile: () => state.profile, ownerSid: () => "S-1-5-21-123", profileLocalAppDataBase: () => "C:\\Profile", volumeFileSystem: () => "NTFS",
    windowsDirectory: () => "C:\\Windows", pinDirectory: () => 30n, writeNewFile() {}, close() {},
  } as unknown as WindowsLpacApi;
  await expect(runWindowsChildProcessPolicyProbe({ parent: "C:\\Native", buildRoot: "C:\\Build", commit: "b".repeat(40), image: "windows-2022", caseId }, api)).rejects.toThrow("failed during lpac");
  expect(state.launchArguments).toEqual(caseId === 8 ? ["--leaf"] : []);
  expect(state.descriptors.size).toBe(0);
});
it("carries first host attribute facts through actual owned and final terminal wrapping without acquiring cleanup authority", async () => {
  state.caseId = 1;
  const { runWindowsChildProcessPolicyDetachedProbe: runWindowsChildProcessPolicyProbe, WindowsChildProcessPolicyCleanupError } = await import("../fixtures/windows-child-process-policy-detached-proof");
  const { brandWindowsChildPolicyFailure, windowsChildPolicyFailure } = await import("../fixtures/windows-child-process-policy-diagnostic");
  state.hostFailure = brandWindowsChildPolicyFailure(new Error("private attribute path and native error"), { phase: 2, operation: 3, predicate: 7 }, 0);
  const api = { createProfile: () => state.profile, ownerSid: () => "S-1-5-21-123", profileLocalAppDataBase: () => "C:\\Profile", volumeFileSystem: () => "NTFS",
    windowsDirectory: () => "C:\\Windows", pinDirectory: () => 30n, writeNewFile() {}, close() {},
  } as unknown as WindowsLpacApi;
  let error: unknown;
  try { await runWindowsChildProcessPolicyProbe({ parent: "C:\\Native", buildRoot: "C:\\Build", commit: "b".repeat(40), image: "windows-2022", caseId: 1 }, api); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WindowsChildProcessPolicyCleanupError);
  expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, phase: 2, operation: 3, predicate: 7, domain: 1, returnedBool: 0 });
  expect(state.closeCalls).toBe(0); expect(state.launchArguments).toBeUndefined(); expect(state.descriptors.size).toBe(0);
});

it("refuses a foreign compilation issuer before native admission", async () => {
  state.compiledIssuer = "foreign-compilation";
  const { runWindowsChildProcessPolicyDetachedProbe } = await import("../fixtures/windows-child-process-policy-detached-proof");
  const createProfile = vi.fn();
  await expect(runWindowsChildProcessPolicyDetachedProbe({ parent: "C:\\Native", buildRoot: "C:\\Build", commit: "b".repeat(40), image: "windows-2022", caseId: 0 }, { createProfile } as unknown as WindowsLpacApi)).rejects.toThrow("original compiled-source issuer");
  expect(createProfile).not.toHaveBeenCalled(); expect(state.launchArguments).toBeUndefined(); expect(state.descriptors.size).toBe(0);
});
