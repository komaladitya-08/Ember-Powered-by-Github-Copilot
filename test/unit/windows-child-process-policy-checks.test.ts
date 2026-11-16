import { expect, it } from "vitest";
import { bindWindowsChildPolicyChecks } from "../fixtures/windows-child-process-policy-checks";
const setup = (fault = "", reentrantAt = "") => {
  const calls: string[] = [], fence = { unsafe: false, retained: [] as unknown[] }; let metadataCalls = 0;
  const owner: ReturnType<typeof bindWindowsChildPolicyChecks> = bindWindowsChildPolicyChecks({ sizeof: () => 8 }, () => ({ func: signature => (...args: unknown[]) => {
    const name = /\b(\w+)\s*\(/.exec(signature)![1]; calls.push(name);
    if (name === reentrantAt) try { owner.image(0n, 4, "C:\\fixed.exe"); } catch { /* Native callback swallows the nested owner failure. */ }
    if (fault === "throw" && name === "CreateFileW") throw new Error("private native path");
    if (name === "CreateFileW") return fault === "invalid" ? 0xffffffffffffffffn : 10n;
    if (name === "CloseHandle") return fault === "close" ? 0 : 1;
    if (name === "GetFileInformationByHandle") {
      metadataCalls++; const bytes = args[1] as Buffer;
      bytes.writeUInt32LE(0x80, 0); bytes.writeUInt32LE(256, 36); bytes.writeUInt32LE(fault === "links" ? 2 : 1, 40);
      bytes.writeUInt32LE(fault === "mutation" && metadataCalls > 1 ? 2 : 1, 48); return fault === "metadata" ? 0 : 1;
    }
    if (name === "GetProcessId") return fault === "pid" ? 5 : 4;
    if (name === "QueryFullProcessImageNameW") { const text = fault === "image" ? "C:\\foreign.exe" : "C:\\fixed.exe"; Buffer.from(text, "utf16le").copy(args[2] as Buffer); (args[3] as number[])[0] = fault === "count" ? text.length + 0.1 : text.length; return 1; }
    return 1;
  } }), fence);
  return { owner, calls, fence };
};
it("pins ordinary bounded bytes and verifies the exact suspended image/PID without launching any process", () => {
  const value = setup(), pin = value.owner.pin("C:\\fixed.exe", 1024); expect(pin.bytes).toBe(256); pin.unchanged(); value.owner.image(11n, 4, "C:\\fixed.exe"); pin.close(); pin.close();
  expect(value.calls.filter(name => name === "CloseHandle")).toHaveLength(1); expect(value.fence.unsafe).toBe(false);
});
it.each(["throw", "invalid", "metadata", "links"])("retires a malformed or unverified file acquisition: %s", fault => {
  const value = setup(fault); expect(() => value.owner.pin("C:\\fixed.exe", 1024)).toThrow("cleanup"); expect(value.fence.unsafe).toBe(true);
});
it("never retries a failed native pin close or permits another use after mutation", () => {
  for (const fault of ["close", "mutation"]) {
    const value = setup(fault), pin = value.owner.pin("C:\\fixed.exe", 1024);
    expect(() => fault === "close" ? pin.close() : pin.unchanged()).toThrow("cleanup");
    const count = value.calls.length; expect(() => pin.close()).toThrow("cleanup"); expect(value.calls).toHaveLength(count); expect(value.fence.retained.length).toBeGreaterThan(0);
  }
});
it.each(["pid", "image", "count"])("refuses a foreign or malformed same-handle process observation: %s", fault => expect(() => setup(fault).owner.image(11n, 4, "C:\\fixed.exe")).toThrow("cleanup"));
it("retains an already owned pin when a later acquisition aliases its handle", () => {
  const value = setup(), pin = value.owner.pin("C:\\fixed.exe", 1024);
  expect(() => value.owner.pin("C:\\other.exe", 1024)).toThrow("cleanup");
  expect(value.calls.filter(name => name === "CloseHandle")).toHaveLength(0);
  expect(() => pin.close()).toThrow("cleanup");
  expect(value.calls.filter(name => name === "CloseHandle")).toHaveLength(0);
});
it.each(["CreateFileW", "GetFileInformationByHandle", "CloseHandle", "GetProcessId", "QueryFullProcessImageNameW"])("rejects a swallowed reentrant failure before any next native call or success: %s", name => {
  const value = setup("", name);
  if (name === "CloseHandle") {
    const pin = value.owner.pin("C:\\fixed.exe", 1024);
    expect(() => pin.close()).toThrow("cleanup");
    expect(value.calls.filter(call => call === name)).toHaveLength(1);
    expect(() => pin.close()).toThrow("cleanup");
  } else if (name === "GetProcessId" || name === "QueryFullProcessImageNameW") {
    expect(() => value.owner.image(11n, 4, "C:\\fixed.exe")).toThrow("cleanup");
  } else expect(() => value.owner.pin("C:\\fixed.exe", 1024)).toThrow("cleanup");
  expect(value.calls.at(-1)).toBe(name);
  expect(value.fence.unsafe).toBe(true);
  expect(value.fence.retained.length).toBeGreaterThan(0);
});
