import { describe, expect, it } from "vitest";
import { experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { WindowsChildProcessPolicyOwnership, WindowsChildProcessPolicyOwnershipError, readWindowsChildProcessPolicyAfterStopped, readWindowsChildProcessPolicySuccessfulExit, windowsChildPolicyScratchLocation } from "../fixtures/windows-child-process-policy-ownership";
import { windowsChildProcessPolicyEnvironment } from "../fixtures/windows-child-process-policy-proof";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { buildPin, selectedWindowsChildProcessPolicyPin, windowsChildProcessPolicyRecipe, parseWindowsChildProcessPolicyBuildReceipt, windowsChildProcessPolicyBuildEnvironment, windowsChildProcessPolicyBuildBatch, windowsChildProcessPolicyPeFingerprint } from "../../scripts/experimental/build-windows-child-process-policy.mjs";

function receipt(image = "windows-2022") {
  const fingerprint = { bytes: 100, sha256: "a".repeat(64) };
  return { schema: 1, issuer: buildPin.issuer,
    build: { ...selectedWindowsChildProcessPolicyPin(image), visualStudioVersion: image === "windows-2022" ? "17.14.37906.3" : "18.0.11234.1", compilerVersion: "19.44.35222.0", linkerVersion: "14.44.35222.0" },
    tools: { compiler: fingerprint, linker: fingerprint, vcvars: fingerprint, vswhere: fingerprint }, recipe: windowsChildProcessPolicyRecipe(), commit: "b".repeat(40),
    asset: { name: "child-process-policy-probe.exe", bytes: 512, sha256: "c".repeat(64) } };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("separate repository-source compile receipt", () => {
  it.each(["windows-2022", "windows-2025"])("binds issuer, tools, exact source recipe and selected image %s", image => {
    const value = parseWindowsChildProcessPolicyBuildReceipt(bytes(receipt(image)), "b".repeat(40), image);
    expect(value.asset.name).toBe("child-process-policy-probe.exe"); expect(Object.isFrozen(value.tools.compiler)).toBe(true);
  });
  it.each(["issuer", "schema", "commit", "extra", "tool", "source", "image", "version", "size", "name", "hash"])("refuses modified %s", change => {
    const value = receipt();
    if (change === "issuer") value.issuer = "OpenJS";
    if (change === "schema") value.schema = 2;
    if (change === "commit") value.commit = "d".repeat(40);
    if (change === "extra") Object.assign(value, { arbitrary: true });
    if (change === "tool") value.tools.compiler.bytes = 0;
    if (change === "source") value.recipe[0].sha256 = "d".repeat(64);
    if (change === "image") value.build.image = "windows-2025";
    if (change === "version") value.build.compilerVersion = "20.1";
    if (change === "size") value.asset.bytes = 16 * 1024 * 1024 + 1;
    if (change === "name") value.asset.name = "node.exe";
    if (change === "hash") value.asset.sha256 = "not-a-hash";
    expect(() => parseWindowsChildProcessPolicyBuildReceipt(bytes(value), "b".repeat(40), "windows-2022")).toThrow("exact build contract");
  });
  it("refuses oversized, malformed and foreign-image receipts", () => {
    for (const input of [Buffer.alloc(16385), Buffer.from("null"), Buffer.from("{")]) expect(() => parseWindowsChildProcessPolicyBuildReceipt(input, "b".repeat(40), "windows-2022")).toThrow();
    expect(() => selectedWindowsChildProcessPolicyPin("self-hosted")).toThrow();
  });
  it("requires bounded x64 executable console PE headers", () => {
    const pe = Buffer.alloc(1024); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128);
    pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(1, 134); pe.writeUInt16LE(240, 148); pe.writeUInt16LE(0x22, 150); pe.writeUInt16LE(0x20b, 152); pe.writeUInt16LE(3, 220);
    pe.writeUInt32LE(0x1000, 168); pe.writeUInt32LE(0x2000, 208); pe.writeUInt32LE(512, 212);
    pe.writeUInt32LE(256, 400); pe.writeUInt32LE(0x1000, 404); pe.writeUInt32LE(512, 408); pe.writeUInt32LE(512, 412); pe.writeUInt32LE(0x60000020, 428);
    expect(windowsChildProcessPolicyPeFingerprint(pe).bytes).toBe(1024);
    for (const [offset, value] of [[132, 0x14c], [134, 0], [148, 0], [150, 0x2002], [152, 0x10b], [220, 2]]) {
      const changed = Buffer.from(pe); changed.writeUInt16LE(value, offset); expect(() => windowsChildProcessPolicyPeFingerprint(changed)).toThrow();
    }
    for (const [offset, value] of [[168, 0], [168, 0x1800], [208, 0x1000], [212, 128], [408, 4096], [412, 0], [428, 0x40000040]]) {
      const changed = Buffer.from(pe); changed.writeUInt32LE(value, offset); expect(() => windowsChildProcessPolicyPeFingerprint(changed)).toThrow();
    }
  });
});
describe("clean fixed launch and compilation inputs", () => {
  const directories = { profile: "C:\\Build\\Profile", temporary: "C:\\Build\\Temp", local: "C:\\Build\\Profile\\Local", roaming: "C:\\Build\\Profile\\Roaming" };
  it("discards credential/compiler/profile hooks before tool discovery or compilation", () => {
    const env = windowsChildProcessPolicyBuildEnvironment({ SystemRoot: "C:\\Windows", CL: "/arbitrary", LINK: "/arbitrary", PATH: "C:\\foreign", NODE_OPTIONS: "--require evil", SECRET: "credential", USERPROFILE: "C:\\foreign" }, directories);
    expect(env.CL).toBeUndefined(); expect(env.LINK).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.SECRET).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows"); expect(env.USERPROFILE).toBe(directories.profile);
  });
  it("rejects conflicting or shell-active host paths", () => {
    expect(() => windowsChildProcessPolicyBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\foreign" }, directories)).toThrow();
    expect(() => windowsChildProcessPolicyBuildEnvironment({}, { ...directories, profile: "C:\\Build&arbitrary" })).toThrow();
  });
  it("has no caller-supplied compiler option surface", () => {
    const paths = Object.fromEntries(["vcvars", "compiler", "linker", "source", "object", "output", "compilerPath", "linkerPath", "sdkMetadata", "toolsetMetadata"].map(name => [name, `C:\\Fixed\\${name}`]));
    const batch = windowsChildProcessPolicyBuildBatch(paths);
    expect(batch).toContain("amd64 10.0.26100.0 -vcvars_ver=14.44.35207"); expect(batch).toContain(" /GS /MT "); expect(batch).not.toContain("/GS-");
    expect(() => windowsChildProcessPolicyBuildBatch({ ...paths, flags: "/arbitrary" })).toThrow();
  });
  const paths = { root: "C:\\Fixture", tools: "C:\\Fixture\\tools", work: "C:\\Fixture\\work", state: "C:\\Fixture\\state", program: "C:\\Fixture\\tools\\fixture.exe" };
  const base = () => experimentalWindowsEnvironment(paths, "C:\\Windows", "C:\\Profile");
  const metadata = { caseId: 0 as const, canary: "C:\\Fresh\\host-only-canary.bin", parentPid: 123 };
  it("adds only fixed canary and parent fields to the existing clean environment", () => {
    const value = windowsChildProcessPolicyEnvironment(base(), metadata).toString("utf16le");
    expect(value).toContain(`EMBER_CHILD_POLICY_CANARY=${metadata.canary}\0`); expect(value).toContain("EMBER_CHILD_POLICY_PARENT=123\0"); expect(value).toContain("EMBER_CHILD_POLICY_CASE=0\0"); expect(value.endsWith("\0\0")).toBe(true);
  });
  it("rejects arbitrary environment keys and numeric/path injection", () => {
    const poisoned = Buffer.from(base().toString("utf16le").slice(0, -1) + "SECRET=credential\0\0", "utf16le");
    expect(() => windowsChildProcessPolicyEnvironment(poisoned, metadata)).toThrow();
    expect(() => windowsChildProcessPolicyEnvironment(base(), { ...metadata, parentPid: 0 })).toThrow();
    expect(() => windowsChildProcessPolicyEnvironment(base(), { ...metadata, canary: "\\\\server\\share\\file" })).toThrow();
  });
});
describe("terminal native ownership", () => {
  it("preserves a successful acquisition and permanently blocks calls after one uncertainty", () => {
    const owner = new WindowsChildProcessPolicyOwnership(); expect(owner.guard(() => 123n)).toBe(123n);
    expect(() => owner.guard(() => { throw new Error("private native detail"); })).toThrow(WindowsChildProcessPolicyOwnershipError);
    let called = false; expect(() => owner.guard(() => { called = true; })).toThrow(WindowsChildProcessPolicyOwnershipError);
    expect(owner.unsafe).toBe(true); expect(called).toBe(false);
  });
});

describe("no native read after uncertain child ownership", () => {
  it("rejects a nonzero ordinary host exit before acquiring or decoding its report", () => {
    let reads = 0;
    expect(() => readWindowsChildProcessPolicySuccessfulExit(1, () => { reads++; })).toThrow("before report decoding");
    expect(reads).toBe(0);
    expect(readWindowsChildProcessPolicySuccessfulExit(0, () => { reads++; return 123; })).toBe(123); expect(reads).toBe(1);
  });
  it("reads only after natural root exit, job zero and exit0 witnesses", async () => {
    const calls: string[] = [];
    expect(await readWindowsChildProcessPolicyAfterStopped({ async waitRootExited() { calls.push("root-exit"); },
      async waitStopped() { calls.push("job-zero"); return { requireStopped() { calls.push("require-zero"); } }; },
      exitCode() { calls.push("exit-code"); return 0; }, read() { calls.push("read"); return 123; } })).toEqual({ exitCode: 0, report: 123 });
    expect(calls).toEqual(["root-exit", "job-zero", "require-zero", "exit-code", "read"]);
  });
  it.each(["child-retains-context", "unknown-job", "no-stopped-lease", "nonzero-exit"])("never decodes a report after %s", async fault => {
    let read = false;
    await expect(readWindowsChildProcessPolicyAfterStopped({
      async waitRootExited() { if (fault === "child-retains-context") throw new Error("root deadline"); },
      async waitStopped() { if (fault === "unknown-job") throw new Error("job deadline"); return { requireStopped() { if (fault === "no-stopped-lease") throw new Error("no job zero"); } }; },
      exitCode: () => fault === "nonzero-exit" ? 1 : 0, read() { read = true; },
    })).rejects.toThrow();
    expect(read).toBe(false);
  });
});

it("requires canonical hosted native scratch outside the managed integration directory without fallback", () => {
  const runner = "D:\\a\\_temp", managed = runner + "\\ember-run-managed", native = runner + "\\ember-child-policy-native-unique";
  expect(windowsChildPolicyScratchLocation(runner, managed, native)).toBe(native);
  for (const [base, target] of [[undefined, native], ["relative", native], [runner, managed], [runner, managed + "\\nested"], [runner, runner], [runner, "D:\\a"], [runner, "C:\\foreign"]] as const)
    expect(() => windowsChildPolicyScratchLocation(base, managed, target)).toThrow();
});

it("retains a returned owner and rejects a swallowed reentrant native failure", () => {
  const guard = new WindowsChildProcessPolicyOwnership(), returned = { process: 123n, thread: 124n, pid: 125 };
  expect(() => guard.guard(() => {
    try { guard.guard(() => { throw new Error("private reentrant failure"); }); } catch { /* A native callback must not restore authority. */ }
    return returned;
  })).toThrow(WindowsChildProcessPolicyOwnershipError);
  expect(guard.retained).toEqual([returned]); expect(guard.unsafe).toBe(true);
  let entered = false; expect(() => guard.guard(() => { entered = true; })).toThrow(); expect(entered).toBe(false);
});
