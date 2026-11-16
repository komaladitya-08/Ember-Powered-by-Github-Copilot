import { describe, expect, it } from "vitest";
import { experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { parseWindowsSecureRngReport } from "../fixtures/windows-secure-rng-report";
import { WindowsSecureRngOwnership, WindowsSecureRngOwnershipError, readWindowsSecureRngAfterStopped, readWindowsSecureRngSuccessfulExit } from "../fixtures/windows-secure-rng-ownership";
import { windowsSecureRngEnvironment } from "../fixtures/windows-secure-rng-proof";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { buildPin, selectedWindowsSecureRngPin, windowsSecureRngRecipe, parseWindowsSecureRngBuildReceipt, windowsSecureRngBuildEnvironment, windowsSecureRngBuildBatch, windowsSecureRngPeFingerprint } from "../../scripts/experimental/build-windows-secure-rng.mjs";

function report(role: 0 | 1, legacyDenied = false, cngStatus = 0) {
  const header = [0x47525345, 1, role, 1, 6, 31, role ? 5 : 0, 0, role ? 5 : 0, role ? 5 : 0, role ? 5 : 0, 6, 1, 0, 0, 0];
  const useful = [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0], denied = [1, 0, 0x80090016, 0, 0, 0, 0, 0, 0, 1, 0, 0];
  const words = [...header, ...(legacyDenied ? denied : useful), ...(legacyDenied ? denied : Array(12).fill(0)), 1, cngStatus, cngStatus === 0 ? 1 : 0, 1, 0, 0, 0, 0];
  const bytes = Buffer.alloc(192); words.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes;
}
function receipt(image = "windows-2022") {
  const fingerprint = { bytes: 100, sha256: "a".repeat(64) };
  return { schema: 1, issuer: buildPin.issuer,
    build: { ...selectedWindowsSecureRngPin(image), visualStudioVersion: image === "windows-2022" ? "17.14.37906.3" : "18.0.11234.1", compilerVersion: "19.44.35222.0", linkerVersion: "14.44.35222.0" },
    tools: { compiler: fingerprint, linker: fingerprint, vcvars: fingerprint, vswhere: fingerprint }, recipe: windowsSecureRngRecipe(), commit: "b".repeat(40),
    asset: { name: "secure-rng-probe.exe", bytes: 512, sha256: "c".repeat(64) } };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("fixed secure API stopped report", () => {
  it("separates useful ordinary host, denied legacy providers and independent CNG observations", () => {
    const host = parseWindowsSecureRngReport(report(0), 0);
    expect(host.defaultProvider).toMatchObject({ acquired: 1, generated: 1, released: 1, knownClosed: true });
    expect(host.conditionalIntel.attempted).toBe(0);
    const lpac = parseWindowsSecureRngReport(report(1, true, 0xc0000022), 1);
    expect(lpac.defaultProvider).toMatchObject({ acquireCode: 0x80090016, generated: 0, knownClosed: true });
    expect(lpac.conditionalIntel.attempted).toBe(1); expect(lpac.cng).toMatchObject({ status: 0xc0000022, generated: 0, wiped: 1 });
    expect(Object.isFrozen(lpac.defaultProvider)).toBe(true); expect(Object.isFrozen(lpac.cng)).toBe(true);
  });
  it("preserves failed BOOL code zero honestly instead of inventing an OS error", () => {
    const input = report(1, true); input.writeUInt32LE(0, 18 * 4);
    expect(parseWindowsSecureRngReport(input, 1).defaultProvider.acquireCode).toBe(0);
  });
  it("allows conditional Intel only after no default entropy, with every acquired context released once", () => {
    const input = report(1, true), useful = [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0];
    useful.forEach((v, i) => input.writeUInt32LE(v, (28 + i) * 4));
    expect(parseWindowsSecureRngReport(input, 1).conditionalIntel.generated).toBe(1);
    input.writeUInt32LE(1, 17 * 4); expect(() => parseWindowsSecureRngReport(input, 1)).toThrow();
  });
  it("permits a known-closed failed generation followed by the conditional source path", () => {
    const input = report(1, true), failed = [1, 1, 0, 1, 0, 5, 1, 1, 0, 1, 0, 0];
    failed.forEach((v, i) => input.writeUInt32LE(v, (16 + i) * 4));
    expect(parseWindowsSecureRngReport(input, 1).defaultProvider).toMatchObject({ generated: 0, generateCode: 5, released: 1, knownClosed: true });
  });
  it.each([[0, 0], [1, 2], [2, 0], [3, 0], [3, 3], [4, 5], [5, 32], [6, 0], [8, 0], [11, 5], [12, 0], [13, 1], [14, 1],
    [16, 0], [17, 0], [18, 5], [19, 0], [21, 5], [22, 0], [23, 0], [24, 5], [25, 0], [26, 1], [26, 2], [27, 1], [28, 1], [40, 0], [41, 5], [42, 0], [43, 0], [44, 1]])(
    "rejects impossible/unknown ownership or unwiped word %i=%i", (word, value) => {
      const input = report(1); input.writeUInt32LE(value, word * 4); expect(() => parseWindowsSecureRngReport(input, 1)).toThrow("numeric contract");
    });
  it.each([0, 191, 193, 65536])("refuses nonexact report length %i", length => expect(() => parseWindowsSecureRngReport(Buffer.alloc(length), 0)).toThrow());
  it("does not adopt a foreign role", () => expect(() => parseWindowsSecureRngReport(report(0), 1)).toThrow());
});
describe("separate repository-source compile receipt", () => {
  it.each(["windows-2022", "windows-2025"])("binds issuer, tools, exact source recipe and selected image %s", image => {
    const value = parseWindowsSecureRngBuildReceipt(bytes(receipt(image)), "b".repeat(40), image);
    expect(value.asset.name).toBe("secure-rng-probe.exe"); expect(Object.isFrozen(value.tools.compiler)).toBe(true);
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
    expect(() => parseWindowsSecureRngBuildReceipt(bytes(value), "b".repeat(40), "windows-2022")).toThrow("exact build contract");
  });
  it("refuses oversized, malformed and foreign-image receipts", () => {
    for (const input of [Buffer.alloc(16385), Buffer.from("null"), Buffer.from("{")]) expect(() => parseWindowsSecureRngBuildReceipt(input, "b".repeat(40), "windows-2022")).toThrow();
    expect(() => selectedWindowsSecureRngPin("self-hosted")).toThrow();
  });
  it("requires bounded x64 executable console PE headers", () => {
    const pe = Buffer.alloc(1024); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128);
    pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(1, 134); pe.writeUInt16LE(240, 148); pe.writeUInt16LE(0x22, 150); pe.writeUInt16LE(0x20b, 152); pe.writeUInt16LE(3, 220);
    pe.writeUInt32LE(0x1000, 168); pe.writeUInt32LE(0x2000, 208); pe.writeUInt32LE(512, 212);
    pe.writeUInt32LE(256, 400); pe.writeUInt32LE(0x1000, 404); pe.writeUInt32LE(512, 408); pe.writeUInt32LE(512, 412); pe.writeUInt32LE(0x60000020, 428);
    expect(windowsSecureRngPeFingerprint(pe).bytes).toBe(1024);
    for (const [offset, value] of [[132, 0x14c], [134, 0], [148, 0], [150, 0x2002], [152, 0x10b], [220, 2]]) {
      const changed = Buffer.from(pe); changed.writeUInt16LE(value, offset); expect(() => windowsSecureRngPeFingerprint(changed)).toThrow();
    }
    for (const [offset, value] of [[168, 0], [168, 0x1800], [208, 0x1000], [212, 128], [408, 4096], [412, 0], [428, 0x40000040]]) {
      const changed = Buffer.from(pe); changed.writeUInt32LE(value, offset); expect(() => windowsSecureRngPeFingerprint(changed)).toThrow();
    }
  });
});
describe("clean fixed launch and compilation inputs", () => {
  const directories = { profile: "C:\\Build\\Profile", temporary: "C:\\Build\\Temp", local: "C:\\Build\\Profile\\Local", roaming: "C:\\Build\\Profile\\Roaming" };
  it("discards credential/compiler/profile hooks before tool discovery or compilation", () => {
    const env = windowsSecureRngBuildEnvironment({ SystemRoot: "C:\\Windows", CL: "/arbitrary", LINK: "/arbitrary", PATH: "C:\\foreign", NODE_OPTIONS: "--require evil", SECRET: "credential", USERPROFILE: "C:\\foreign" }, directories);
    expect(env.CL).toBeUndefined(); expect(env.LINK).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.SECRET).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows"); expect(env.USERPROFILE).toBe(directories.profile);
  });
  it("rejects conflicting or shell-active host paths", () => {
    expect(() => windowsSecureRngBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\foreign" }, directories)).toThrow();
    expect(() => windowsSecureRngBuildEnvironment({}, { ...directories, profile: "C:\\Build&arbitrary" })).toThrow();
  });
  it("has no caller-supplied compiler option surface", () => {
    const paths = Object.fromEntries(["vcvars", "compiler", "linker", "source", "object", "output", "compilerPath", "linkerPath", "sdkMetadata", "toolsetMetadata"].map(name => [name, `C:\\Fixed\\${name}`]));
    const batch = windowsSecureRngBuildBatch(paths);
    expect(batch).toContain("amd64 10.0.26100.0 -vcvars_ver=14.44.35207"); expect(batch).toContain(" /GS /MT "); expect(batch).not.toContain("/GS-");
    expect(() => windowsSecureRngBuildBatch({ ...paths, flags: "/arbitrary" })).toThrow();
  });
  const paths = { root: "C:\\Fixture", tools: "C:\\Fixture\\tools", work: "C:\\Fixture\\work", state: "C:\\Fixture\\state", program: "C:\\Fixture\\tools\\fixture.exe" };
  const base = () => experimentalWindowsEnvironment(paths, "C:\\Windows", "C:\\Profile");
  const metadata = { canary: "C:\\Fresh\\host-only-canary.bin", parentPid: 123 };
  it("adds only fixed canary and parent fields to the existing clean environment", () => {
    const value = windowsSecureRngEnvironment(base(), metadata).toString("utf16le");
    expect(value).toContain(`EMBER_SECURE_RNG_CANARY=${metadata.canary}\0`); expect(value).toContain("EMBER_SECURE_RNG_PARENT=123\0"); expect(value.endsWith("\0\0")).toBe(true);
  });
  it("rejects arbitrary environment keys and numeric/path injection", () => {
    const poisoned = Buffer.from(base().toString("utf16le").slice(0, -1) + "SECRET=credential\0\0", "utf16le");
    expect(() => windowsSecureRngEnvironment(poisoned, metadata)).toThrow();
    expect(() => windowsSecureRngEnvironment(base(), { ...metadata, parentPid: 0 })).toThrow();
    expect(() => windowsSecureRngEnvironment(base(), { ...metadata, canary: "\\\\server\\share\\file" })).toThrow();
  });
});
describe("terminal native ownership", () => {
  it("preserves a successful acquisition and permanently blocks calls after one uncertainty", () => {
    const owner = new WindowsSecureRngOwnership(); expect(owner.guard(() => 123n)).toBe(123n);
    expect(() => owner.guard(() => { throw new Error("private native detail"); })).toThrow(WindowsSecureRngOwnershipError);
    let called = false; expect(() => owner.guard(() => { called = true; })).toThrow(WindowsSecureRngOwnershipError);
    expect(owner.unsafe).toBe(true); expect(called).toBe(false);
  });
});

describe("no native read after uncertain child ownership", () => {
  it("rejects a nonzero ordinary host exit before acquiring or decoding its report", () => {
    let reads = 0;
    expect(() => readWindowsSecureRngSuccessfulExit(1, () => { reads++; })).toThrow("before report decoding");
    expect(reads).toBe(0);
    expect(readWindowsSecureRngSuccessfulExit(0, () => { reads++; return 123; })).toBe(123); expect(reads).toBe(1);
  });
  it("reads only after natural root exit, job zero and exit0 witnesses", async () => {
    const calls: string[] = [];
    expect(await readWindowsSecureRngAfterStopped({ async waitRootExited() { calls.push("root-exit"); },
      async waitStopped() { calls.push("job-zero"); return { requireStopped() { calls.push("require-zero"); } }; },
      exitCode() { calls.push("exit-code"); return 0; }, read() { calls.push("read"); return 123; } })).toEqual({ exitCode: 0, report: 123 });
    expect(calls).toEqual(["root-exit", "job-zero", "require-zero", "exit-code", "read"]);
  });
  it.each(["child-retains-context", "unknown-job", "no-stopped-lease", "nonzero-exit"])("never decodes a report after %s", async fault => {
    let read = false;
    await expect(readWindowsSecureRngAfterStopped({
      async waitRootExited() { if (fault === "child-retains-context") throw new Error("root deadline"); },
      async waitStopped() { if (fault === "unknown-job") throw new Error("job deadline"); return { requireStopped() { if (fault === "no-stopped-lease") throw new Error("no job zero"); } }; },
      exitCode: () => fault === "nonzero-exit" ? 1 : 0, read() { read = true; },
    })).rejects.toThrow();
    expect(read).toBe(false);
  });
});
