import { expect, it } from "vitest";
import { bindWindowsUvSpawnChecks, bindWindowsUvSpawnJob, bindWindowsUvSpawnObserver } from "../fixtures/windows-uv-spawn-native";
import type { WindowsNodeSourceChildObserverFence } from "../fixtures/windows-node-source-child-observer";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";
const setup = (fault = "", reentrantAt = "") => {
  const calls: string[] = [], fence = { unsafe: false, retained: [] as unknown[] }; let metadataCalls = 0;
  const owner: ReturnType<typeof bindWindowsUvSpawnChecks> = bindWindowsUvSpawnChecks({ sizeof: () => 8 }, () => ({ func: signature => (...args: unknown[]) => {
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

const job = (fault = "") => {
  const calls: string[] = []; let requested: Buffer | undefined;
  const owner: ReturnType<typeof bindWindowsUvSpawnJob> = bindWindowsUvSpawnJob({ sizeof: () => 8 }, () => ({ func: signature => (...args: unknown[]) => {
    const name = /\b(\w+)\s*\(/.exec(signature)![1]; calls.push(name);
    if (fault === "throw") throw new Error("private job metadata");
    if (name === "SetInformationJobObject") {
      if (fault === "reentrant") try { owner.setTwo(0n); } catch { /* Native callback swallows the terminal nested failure. */ }
      requested = Buffer.from(args[2] as Buffer); return fault === "set" ? 0 : 1;
    }
    const output = args[2] as Buffer;
    if (args[1] === 4) output.writeUInt32LE(fault === "ui" ? 1 : 0);
    else if (requested) { requested.copy(output); if (fault === "mutation") output.writeUInt32LE(3, 40); }
    else { output.writeUInt32LE(fault === "breakaway" ? 0x2800 : 0x2000, 16); output.writeUInt32LE(fault === "initial-active" ? 1 : 0, 40); }
    return fault === "query" ? 0 : 1;
  } }));
  return { owner, calls, requested: () => requested };
};
it("sets only active-process2 on the existing kill-on-close outer job and reads it back before launch", () => {
  const value = job(); value.owner.setTwo(10n); expect(value.requested()!.readUInt32LE(16)).toBe(0x2008); expect(value.requested()!.readUInt32LE(40)).toBe(2);
  expect(value.calls).toEqual(["QueryInformationJobObject", "QueryInformationJobObject", "SetInformationJobObject", "QueryInformationJobObject", "QueryInformationJobObject"]);
});
it.each(["throw", "set", "query", "ui", "mutation", "breakaway", "initial-active", "reentrant"])("fences job ownership and makes no later calls after %s", fault => {
  const value = job(fault); expect(() => value.owner.setTwo(10n)).toThrow("cleanup"); const count = value.calls.length;
  expect(() => value.owner.setTwo(10n)).toThrow("cleanup"); expect(value.calls).toHaveLength(count);
  if (fault === "reentrant") expect(value.calls.at(-1)).toBe("SetInformationJobObject");
});

const childObserver = (fault: "native-throw" | "reentrant-query" | "reentrant-close") => {
  const calls: string[] = [], fence: WindowsNodeSourceChildObserverFence = { retained: [] }; let stopped = false, child = false;
  const image = "C:\\fixed.exe";
  const owner: ReturnType<typeof bindWindowsUvSpawnObserver> = bindWindowsUvSpawnObserver({ sizeof: () => 8 }, () => ({ func: signature => (...args: unknown[]) => {
    const name = /\b(\w+)\s*\(/.exec(signature)![1]; calls.push(name);
    if (name === "GetProcessId") {
      if (fault === "native-throw") throw new Error("private native PID state");
      if (fault === "reentrant-query") try { owner.requireStopped(); } catch { /* The nested wait poisons the actual observer before the native return. */ }
      return args[0] === 20n ? 4 : 5;
    }
    if (name === "WaitForSingleObject") return stopped ? 0 : 258;
    if (name === "QueryFullProcessImageNameW") { Buffer.from(image, "utf16le").copy(args[2] as Buffer); (args[3] as number[])[0] = image.length; return 1; }
    if (name === "IsProcessInJob") { (args[2] as number[])[0] = 1; return 1; }
    if (name === "QueryInformationJobObject") {
      const output = args[2] as Buffer;
      if (args[1] === 1) output.writeUInt32LE(stopped ? 0 : 1, 40);
      else if (!stopped) { output.writeUInt32LE(child ? 2 : 1, 0); output.writeUInt32LE(child ? 2 : 1, 4); output.writeBigUInt64LE(4n, 8); if (child) output.writeBigUInt64LE(5n, 16); }
      return 1;
    }
    if (name === "OpenProcess") return 30n;
    if (name === "CloseHandle") { if (fault === "reentrant-close") try { owner.waitStoppedBefore(-1); } catch { /* The nested deadline refusal terminalizes this owner. */ } return 1; }
    return 5;
  } }), fence);
  return { owner, calls, fence, bind() { owner.bind({ job: 10n, rootProcess: 20n, rootPid: 4, image, current: () => true, verifyToken() {}, grant() {} }); },
    child() { child = true; }, stop() { stopped = true; } };
};
it.each(["native-throw", "reentrant-query"] as const)("retains the actual observer binding and prevents the next native image query after %s", fault => {
  const value = childObserver(fault); expect(() => value.bind()).toThrow(WindowsNodeHostCleanupError); expect(value.calls).not.toContain("QueryFullProcessImageNameW");
  expect(value.fence.failure).toBeDefined(); expect(value.fence.retained.some(item => item !== null && typeof item === "object" && "owned" in item)).toBe(true);
});
it("refuses clean completion when the last observed child CloseHandle swallows a nested terminal failure", () => {
  const value = childObserver("reentrant-close"); value.bind(); value.child(); expect(value.owner.admit()).toBe(5); value.stop(); value.owner.waitStoppedBefore(performance.now() + 1000);
  expect(() => value.owner.closeStopped()).toThrow(WindowsNodeHostCleanupError); expect(value.calls.filter(name => name === "CloseHandle")).toHaveLength(1);
  const count = value.calls.length; expect(() => value.owner.closeStopped()).toThrow(WindowsNodeHostCleanupError); expect(value.calls).toHaveLength(count);
});
