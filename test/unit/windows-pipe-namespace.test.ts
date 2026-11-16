import { describe, expect, it } from "vitest";
import { experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { parseWindowsPipeNamespaceReport } from "../fixtures/windows-pipe-namespace-report";
import { WindowsPipeNamespaceOwnership, WindowsPipeNamespaceOwnershipError } from "../fixtures/windows-pipe-namespace-ownership";
import { windowsPipeNamespaceEnvironment } from "../fixtures/windows-pipe-namespace-proof";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { buildPin, selectedWindowsPipeNamespacePin, windowsPipeNamespaceRecipe, parseWindowsPipeNamespaceBuildReceipt, windowsPipeNamespaceBuildEnvironment, windowsPipeNamespaceBuildBatch, windowsPipeNamespacePeFingerprint } from "../../scripts/experimental/build-windows-pipe-namespace.mjs";

function report(role: 0 | 1, refused = false) {
  const bytes = Buffer.alloc(160), values = [0x504e5045, 1, role, 1, 5, 31, role ? 5 : 0, 0, role ? 5 : 0, role ? 5 : 0, role ? 5 : 0, 4, 0, 0, 0, 0];
  const connected = [7, 0, 1, 7, 7, 0, 1, 0, 0, 0, 0, 0];
  values.push(...(refused ? [2, 5, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0] : connected), ...connected);
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes;
}
function receipt(image = "windows-2022") {
  const fingerprint = { bytes: 100, sha256: "a".repeat(64) };
  return { schema: 1, issuer: buildPin.issuer,
    build: { ...selectedWindowsPipeNamespacePin(image), visualStudioVersion: image === "windows-2022" ? "17.14.37906.3" : "18.0.11234.1", compilerVersion: "19.44.35222.0", linkerVersion: "14.44.35222.0" },
    tools: { compiler: fingerprint, linker: fingerprint, vcvars: fingerprint, vswhere: fingerprint }, recipe: windowsPipeNamespaceRecipe(), commit: "b".repeat(40),
    asset: { name: "pipe-probe.exe", bytes: 512, sha256: "c".repeat(64) } };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
describe("fixed namespace stopped report", () => {
  it("separates connected host and access-denied LPAC observations without inventing compatibility", () => {
    expect(parseWindowsPipeNamespaceReport(report(0), 0).current).toMatchObject({ outcome: 1, code: 0, closeComplete: true });
    const value = parseWindowsPipeNamespaceReport(report(1, true), 1);
    expect(value.current).toMatchObject({ operation: 2, outcome: 2, code: 5, created: 1, closed: 1, closeComplete: true });
    expect(value.local.outcome).toBe(1); expect(Object.isFrozen(value.current)).toBe(true);
  });
  it.each([[0, 1], [1, 2], [2, 0], [3, 3], [4, 4], [5, 32], [6, 0], [8, 0], [11, 3], [12, 1], [16, 0], [18, 4], [19, 8], [20, 0], [21, 1], [22, 2], [23, 2], [24, 1], [25, 5], [26, 5], [27, 5]])("rejects forged word %i=%i", (word, value) => {
    const input = report(1); input.writeUInt32LE(value, word * 4); expect(() => parseWindowsPipeNamespaceReport(input, 1)).toThrow("numeric contract");
  });
  it("requires positively completed cancellation and all created closes", () => {
    const input = report(1), values = [6, 258, 2, 7, 7, 0, 0, 1, 1, 1168, 995, 0];
    values.forEach((value, index) => input.writeUInt32LE(value, (16 + index) * 4));
    expect(parseWindowsPipeNamespaceReport(input, 1).current).toMatchObject({ pending: 1, cancelAttempted: 1, completionCode: 995, closeComplete: true });
    input.writeUInt32LE(996, 26 * 4); expect(() => parseWindowsPipeNamespaceReport(input, 1)).toThrow();
  });
  it.each([
    [1, 5, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    [4, 5, 2, 7, 7, 0, 0, 1, 0, 0, 0, 0],
    [5, 258, 2, 7, 7, 0, 0, 1, 1, 0, 995, 0],
    [6, 258, 2, 7, 7, 0, 1, 1, 1, 0, 995, 0],
  ])("refuses impossible pending/cancel/flag combination %j", (...pair) => {
    const input = report(1); pair.forEach((value, index) => input.writeUInt32LE(value, (16 + index) * 4));
    expect(() => parseWindowsPipeNamespaceReport(input, 1)).toThrow();
  });
  it.each([0, 159, 161, 65536])("refuses nonexact report length %i", length => expect(() => parseWindowsPipeNamespaceReport(Buffer.alloc(length), 0)).toThrow());
  it("does not adopt a foreign role", () => expect(() => parseWindowsPipeNamespaceReport(report(0), 1)).toThrow());
});
describe("separate repository-source compile receipt", () => {
  it.each(["windows-2022", "windows-2025"])("binds issuer, tools, exact source recipe and selected image %s", image => {
    const value = parseWindowsPipeNamespaceBuildReceipt(bytes(receipt(image)), "b".repeat(40), image);
    expect(value.asset.name).toBe("pipe-probe.exe"); expect(Object.isFrozen(value.tools.compiler)).toBe(true);
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
    expect(() => parseWindowsPipeNamespaceBuildReceipt(bytes(value), "b".repeat(40), "windows-2022")).toThrow("exact build contract");
  });
  it("refuses oversized, malformed and foreign-image receipts", () => {
    for (const input of [Buffer.alloc(16385), Buffer.from("null"), Buffer.from("{")]) expect(() => parseWindowsPipeNamespaceBuildReceipt(input, "b".repeat(40), "windows-2022")).toThrow();
    expect(() => selectedWindowsPipeNamespacePin("self-hosted")).toThrow();
  });
  it("requires bounded x64 executable console PE headers", () => {
    const pe = Buffer.alloc(1024); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128);
    pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(1, 134); pe.writeUInt16LE(240, 148); pe.writeUInt16LE(0x22, 150); pe.writeUInt16LE(0x20b, 152); pe.writeUInt16LE(3, 220);
    pe.writeUInt32LE(0x1000, 168); pe.writeUInt32LE(0x2000, 208); pe.writeUInt32LE(512, 212);
    pe.writeUInt32LE(256, 400); pe.writeUInt32LE(0x1000, 404); pe.writeUInt32LE(512, 408); pe.writeUInt32LE(512, 412); pe.writeUInt32LE(0x60000020, 428);
    expect(windowsPipeNamespacePeFingerprint(pe).bytes).toBe(1024);
    for (const [offset, value] of [[132, 0x14c], [134, 0], [148, 0], [150, 0x2002], [152, 0x10b], [220, 2]]) {
      const changed = Buffer.from(pe); changed.writeUInt16LE(value, offset); expect(() => windowsPipeNamespacePeFingerprint(changed)).toThrow();
    }
    for (const [offset, value] of [[168, 0], [168, 0x1800], [208, 0x1000], [212, 128], [408, 4096], [412, 0], [428, 0x40000040]]) {
      const changed = Buffer.from(pe); changed.writeUInt32LE(value, offset); expect(() => windowsPipeNamespacePeFingerprint(changed)).toThrow();
    }
  });
});
describe("clean fixed launch and compilation inputs", () => {
  const directories = { profile: "C:\\Build\\Profile", temporary: "C:\\Build\\Temp", local: "C:\\Build\\Profile\\Local", roaming: "C:\\Build\\Profile\\Roaming" };
  it("discards credential/compiler/profile hooks before tool discovery or compilation", () => {
    const env = windowsPipeNamespaceBuildEnvironment({ SystemRoot: "C:\\Windows", CL: "/arbitrary", LINK: "/arbitrary", PATH: "C:\\foreign", NODE_OPTIONS: "--require evil", SECRET: "credential", USERPROFILE: "C:\\foreign" }, directories);
    expect(env.CL).toBeUndefined(); expect(env.LINK).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.SECRET).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows"); expect(env.USERPROFILE).toBe(directories.profile);
  });
  it("rejects conflicting or shell-active host paths", () => {
    expect(() => windowsPipeNamespaceBuildEnvironment({ SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\foreign" }, directories)).toThrow();
    expect(() => windowsPipeNamespaceBuildEnvironment({}, { ...directories, profile: "C:\\Build&arbitrary" })).toThrow();
  });
  it("has no caller-supplied compiler option surface", () => {
    const paths = Object.fromEntries(["vcvars", "compiler", "linker", "source", "object", "output", "compilerPath", "linkerPath", "sdkMetadata", "toolsetMetadata"].map(name => [name, `C:\\Fixed\\${name}`]));
    const batch = windowsPipeNamespaceBuildBatch(paths);
    expect(batch).toContain("amd64 10.0.26100.0 -vcvars_ver=14.44.35207"); expect(batch).toContain(" /GS /MT "); expect(batch).not.toContain("/GS-");
    expect(() => windowsPipeNamespaceBuildBatch({ ...paths, flags: "/arbitrary" })).toThrow();
  });
  const paths = { root: "C:\\Fixture", tools: "C:\\Fixture\\tools", work: "C:\\Fixture\\work", state: "C:\\Fixture\\state", program: "C:\\Fixture\\tools\\fixture.exe" };
  const base = () => experimentalWindowsEnvironment(paths, "C:\\Windows", "C:\\Profile");
  const metadata = { nonce: "a".repeat(32), canary: "C:\\Fresh\\host-only-canary.bin", parentPid: 123 };
  it("adds only fixed nonce, canary and parent fields to the existing clean environment", () => {
    const value = windowsPipeNamespaceEnvironment(base(), metadata).toString("utf16le");
    expect(value).toContain(`EMBER_PIPE_NAMESPACE_NONCE=${metadata.nonce}\0`); expect(value).toContain("EMBER_PIPE_NAMESPACE_PARENT=123\0"); expect(value.endsWith("\0\0")).toBe(true);
  });
  it.each(["", "A".repeat(32), "a".repeat(31), "a".repeat(33), "a".repeat(31) + ";"])("rejects foreign nonce %s", nonce => expect(() => windowsPipeNamespaceEnvironment(base(), { ...metadata, nonce })).toThrow());
  it("rejects arbitrary environment keys and numeric/path injection", () => {
    const poisoned = Buffer.from(base().toString("utf16le").slice(0, -1) + "SECRET=credential\0\0", "utf16le");
    expect(() => windowsPipeNamespaceEnvironment(poisoned, metadata)).toThrow();
    expect(() => windowsPipeNamespaceEnvironment(base(), { ...metadata, parentPid: 0 })).toThrow();
    expect(() => windowsPipeNamespaceEnvironment(base(), { ...metadata, canary: "\\\\server\\share\\file" })).toThrow();
  });
});
describe("terminal native ownership", () => {
  it("preserves a successful acquisition and permanently blocks calls after one uncertainty", () => {
    const owner = new WindowsPipeNamespaceOwnership(); expect(owner.guard(() => 123n)).toBe(123n);
    expect(() => owner.guard(() => { throw new Error("private native detail"); })).toThrow(WindowsPipeNamespaceOwnershipError);
    let called = false; expect(() => owner.guard(() => { called = true; })).toThrow(WindowsPipeNamespaceOwnershipError);
    expect(owner.unsafe).toBe(true); expect(called).toBe(false);
  });
});
