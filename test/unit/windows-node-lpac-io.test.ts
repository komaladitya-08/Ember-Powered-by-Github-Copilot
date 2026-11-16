import { expect, it } from "vitest";
import { ExperimentalWindowsCreateUncertain, LPAC_ATTRIBUTES } from "../../app/main/agent/experimental-windows-lpac-api";
import { bindWindowsNodeIo, WindowsNodeIoCleanupError, windowsNodeIoSetupReceipt, WINDOWS_NODE_IO_OUTPUT, WINDOWS_NODE_IO_SETUP_STAGES, WINDOWS_NODE_IO_SETUP_OPERATIONS } from "../fixtures/windows-node-lpac-io";

const profile = { name: "Ember.Experimental.fresh", sid: 55n, sidText: "S-1-15-2-1234" };
const program = "C:\\fixture\\tools\\node.exe", state = "C:\\fixture\\state", cwd = "C:\\fixture\\work";
const command = Buffer.from(`"${program}" --eval "process.exitCode = 0"\0`, "utf16le"), env = Buffer.from("SystemRoot=C:\\Windows\0\0", "utf16le");
type Call = { name: string; args: unknown[] };
function setup(initialFault = "") {
  const calls: Call[] = [], flags = new Map<bigint, number>([[10n, 0], [11n, 0], [12n, 0], [13n, 0]]), positions = new Map<bigint, number>();
  const readBuffers: Buffer[] = [];
  let exclusiveHandle: bigint | undefined;
  const addresses = new Map<Buffer, bigint>();
  const control = { fault: initialFault, output: Buffer.alloc(0), metadata: "", mutateOnRead: false, lastError: 122 as unknown, cleanupLastError: undefined as unknown, failCleanup: false };
  const fence = { retained: [] as unknown[], failure: undefined as Error | undefined };
  const address = (buffer: Buffer) => { let pointer = addresses.get(buffer); if (!pointer) { pointer = BigInt(0x10000 + addresses.size * 0x10000); addresses.set(buffer, pointer); } return pointer; };
  const native = { sizeof: () => 8, address } as unknown as Parameters<typeof bindWindowsNodeIo>[0];
  const load = () => ({ func(prototype: string) {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1];
    return (...args: unknown[]) => {
      calls.push({ name, args: args.map(value => Buffer.isBuffer(value) ? Buffer.from(value) : value) });
      const fault = control.fault;
      if (name === "GetLastError") return control.lastError;
      if (name === "ConvertStringSecurityDescriptorToSecurityDescriptorW") {
        if (fault === "descriptor false") { (args[2] as unknown[])[0] = null; return 0; }
        (args[2] as unknown[])[0] = 300n;
        if (fault === "descriptor throw") throw new Error("native private diagnostic");
        return 1;
      }
      if (name === "LocalFree") { if (fault === "free throw") throw new Error("native private diagnostic"); return fault === "free failed" ? 300n : null; }
      if (name === "CreateFileW") {
        if (fault === "open throw" || fault === "pin throw" && args[4] !== 1) throw new Error("native private diagnostic");
        if (args[4] === 1) return fault === "invalid writer" ? 0xffffffffffffffffn : 10n;
        if ((args[0] as string).includes("GLOBALROOT")) return fault === "null open false" ? 0xffffffffffffffffn : fault === "aliased stdin" ? 10n : 12n;
        if (args[2] === 1) {
          if (fault === "remaining writer") return 0xffffffffffffffffn;
          if (fault === "exclusive open throw") throw new Error("native private diagnostic");
          exclusiveHandle = fault === "reuse writer value" ? 10n : fault === "exclusive alias" ? 11n : 13n;
          return exclusiveHandle;
        }
        return fault === "aliased pin" ? 10n : 11n;
      }
      if (name === "GetFileType") return args[0] === 12n ? fault === "disk stdin" ? 1 : 2 : 1;
      if (name === "GetFileInformationByHandle") {
        if (fault === "writer metadata undefined" && args[0] === 10n) return undefined;
        if (fault === "writer metadata false" && args[0] === 10n || fault === "pin metadata false" && args[0] === 11n) return 0;
        if (fault === "writer metadata throw" && args[0] === 10n) throw new Error("private path, credential and native exception");
        const buffer = args[1] as Buffer, meta = control.metadata || fault;
        buffer.writeUInt32LE(meta === "reparse" ? 0x400 : meta === "directory" ? 0x10 : 0x80, 0);
        buffer.writeBigUInt64LE(100n, 4); buffer.writeBigUInt64LE(meta === "write time" || fault === "exclusive changed metadata" && args[0] === exclusiveHandle ? 501n : 500n, 20);
        buffer.writeUInt32LE(meta === "wrong volume" && args[0] === 11n ? 6 : 5, 28);
        buffer.writeUInt32LE(meta === "oversize" ? 65537 : control.output.length, 36);
        buffer.writeUInt32LE(meta === "hardlink" || fault === "exclusive hardlink" && args[0] === exclusiveHandle ? 2 : 1, 40);
        buffer.writeUInt32LE(meta === "wrong ID" && args[0] === 11n || fault === "exclusive wrong ID" && args[0] === exclusiveHandle ? 8 : 7, 48);
        return 1;
      }
      if (name === "GetHandleInformation") {
        if (fault === "flags false") return 0;
        (args[1] as number[])[0] = fault === "inheritable pin" && args[0] === 11n || fault === "exclusive inheritable" && args[0] === exclusiveHandle ? 1 : flags.get(args[0] as bigint)!;
        return 1;
      }
      if (name === "SetHandleInformation") {
        if (args[2] === 0 && fault === "reset") return 0;
        if (args[2] === 1 && fault === "enable") return 0;
        if (!(args[2] === 0 && fault === "reset mismatch")) flags.set(args[0] as bigint, args[2] as number);
        return 1;
      }
      if (name === "NtQueryObject") {
        if (fault === "rights status string" && args[1] === 0) return "-1073741790";
        if (fault === "rights status" && args[1] === 0) return -1073741790;
        const buffer = args[2] as Buffer;
        if (args[1] === 0) {
          let access = args[0] === exclusiveHandle ? 0x81 : args[0] === 10n ? 2 : args[0] === 11n ? 0x81 : 0x120089;
          if (fault === "exclusive writable" && args[0] === exclusiveHandle) access |= 2;
          if (fault === "readable writer" && args[0] === 10n) access |= 1;
          if (fault === "writable pin" && args[0] === 11n) access |= 2;
          if (fault === "deletable writer" && args[0] === 10n) access |= 0x10000;
          if (fault === "executable writer" && args[0] === 10n) access |= 0x20;
          buffer.writeUInt32LE(access, 4); (args[4] as number[])[0] = 56; return 0;
        }
        const name = Buffer.from(fault === "wrong NUL name" ? "\\Device\\Other" : "\\Device\\Null", "utf16le");
        buffer.writeUInt16LE(name.length, 0); buffer.writeUInt16LE(name.length, 2);
        buffer.writeBigUInt64LE(address(buffer) + (fault === "outside NUL name" ? 8192n : 16n), 8);
        name.copy(buffer, 16); (args[4] as number[])[0] = 16 + name.length; return fault === "NUL query" ? -1 : 0;
      }
      if (name === "ReadFile") {
        if (fault === "null read false" && args[0] === 12n) return 0;
        if (args[0] === 12n) { (args[3] as number[])[0] = fault === "nonEOF stdin" ? 1 : 0; return 1; }
        if ((args[2] as number) > 1) readBuffers.push(args[1] as Buffer);
        const position = positions.get(args[0] as bigint) ?? 0, length = Math.min(args[2] as number, Math.max(0, control.output.length - position));
        control.output.copy(args[1] as Buffer, 0, position, position + length); positions.set(args[0] as bigint, position + length);
        (args[3] as number[])[0] = fault === "short read" && length ? length - 1 : length;
        if (control.mutateOnRead) control.metadata = "write time";
        return 1;
      }
      if (name === "InitializeProcThreadAttributeList") {
        (args[3] as bigint[])[0] = 256n;
        if (args[0] && fault === "initialize throw") throw new Error("native private diagnostic");
        return args[0] ? 1 : 0;
      }
      if (name === "UpdateProcThreadAttribute") return fault === "LPAC attr" && args[2] === LPAC_ATTRIBUTES.allApplicationPackagesPolicy ? 0 : 1;
      if (name === "CreateProcessW") {
        expect(flags.get(10n)).toBe(1); expect(flags.get(12n)).toBe(1); expect(flags.get(11n)).toBe(0);
        if (fault === "create false") return 0;
        const pi = args[9] as Buffer;
        pi.writeBigUInt64LE(fault === "invalid process" ? 0n : fault === "aliased process" ? 10n : 20n, 0);
        pi.writeBigUInt64LE(fault === "invalid thread" ? 0n : fault === "same PI handles" ? 20n : 30n, 8);
        pi.writeUInt32LE(fault === "invalid pid" ? 0 : 40, 16);
        if (fault === "create throw") throw new Error("native private diagnostic");
        return 1;
      }
      if (name === "DeleteProcThreadAttributeList" && (fault === "delete attrs" || fault === "unobserved" || fault === "close root")) throw new Error("native private diagnostic");
      if (name === "WaitForSingleObject") return fault === "unobserved" ? 258 : 0;
      if (name === "CloseHandle") {
        if (control.cleanupLastError !== undefined) control.lastError = control.cleanupLastError;
        if (control.failCleanup && args[0] === 10n) return 0;
        if (fault === "close writer throw" && args[0] === 10n) throw new Error("native private diagnostic");
        return fault === "close writer" && args[0] === 10n || fault === "close root" && args[0] === 20n || fault === "close original pin" && args[0] === 11n ? 0 : 1;
      }
      return 1;
    };
  } });
  const bind = () => bindWindowsNodeIo(native, load, state, profile, { ownerSid: () => "S-1-5-21-1234" }, fence);
  return { bind, calls, control, flags, fence, readBuffers };
}
function started() {
  const s = setup(), owner = s.bind();
  owner.createHost(program, command, cwd, env); owner.acceptHostControl(); owner.createLpac(profile, program, command, cwd, env);
  return { ...s, owner };
}
const closedHandles = (calls: Call[]) => calls.filter(call => call.name === "CloseHandle").map(call => call.args[0]);

it.each([
  ["descriptor false", "security-descriptor", "ConvertStringSecurityDescriptorToSecurityDescriptorW"],
  ["invalid writer", "create-output-writer", "CreateFileW"],
  ["pin metadata false", "identity-pin-metadata", "GetFileInformationByHandle"],
  ["writer metadata false", "writer-metadata", "GetFileInformationByHandle"],
  ["null open false", "open-null", "CreateFileW"],
  ["null read false", "null-eof", "ReadFile"],
  ["flags false", "writer-inheritance", "GetHandleInformation"],
])("reports only the fixed setup stage and immediate failed API code: %s", (fault, stage, operation) => {
  const s = setup(fault); s.control.lastError = 5; s.control.cleanupLastError = "private cleanup state";
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  const receipt = windowsNodeIoSetupReceipt(error);
  expect(receipt).toEqual({ stage, operation, code: 5 }); expect(Object.isFrozen(receipt)).toBe(true);
  const sampling = s.calls.findIndex(call => call.name === "GetLastError");
  expect(sampling).toBeGreaterThan(0); expect(s.calls[sampling - 1].name).toBe(operation);
  expect(s.calls.filter(call => call.name === "GetLastError")).toHaveLength(1);
  const closes = closedHandles(s.calls); expect(new Set(closes).size).toBe(closes.length);
  expect(JSON.stringify(receipt)).not.toMatch(/private|C:|S-1-|handle|mask|credential/);
});

it.each([
  ["wrong ID", "output-identity"], ["wrong NUL name", "null-name"], ["nonEOF stdin", "null-eof"],
  ["inheritable pin", "pin-inheritance"], ["readable writer", "writer-rights"], ["disk stdin", "null-type"],
])("reports only a stage for a failed predicate without sampling stale LastError: %s", (fault, stage) => {
  const s = setup(fault); s.control.lastError = 0xdeadbeef;
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(windowsNodeIoSetupReceipt(error)).toEqual({ stage });
  expect(s.calls.some(call => call.name === "GetLastError")).toBe(false);
});

it("uses the actual unsigned NTSTATUS rather than Win32 LastError for a failed object query", () => {
  const s = setup("rights status"); s.control.lastError = "private stale native state";
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(windowsNodeIoSetupReceipt(error)).toEqual({ stage: "writer-rights", operation: "NtQueryObject", code: 0xc0000022 });
  expect(s.calls.some(call => call.name === "GetLastError")).toBe(false);
});

it.each([NaN, -1, 0x100000000, "private native error", undefined])("discards a malformed native error value: %s", value => {
  const s = setup("writer metadata false"); s.control.lastError = value;
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(windowsNodeIoSetupReceipt(error)).toEqual({ stage: "writer-metadata" });
});

it("keeps a thrown native exception private and does not pretend that it was a FALSE/API-code result", () => {
  const s = setup("writer metadata throw");
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(windowsNodeIoSetupReceipt(error)).toEqual({ stage: "writer-metadata" });
  expect(String(error)).not.toMatch(/private path|credential|native exception/);
  expect(s.calls.some(call => call.name === "GetLastError")).toBe(false);
  expect(closedHandles(s.calls)).toEqual([10n, 11n]);
});

it.each([["writer metadata undefined", "writer-metadata"], ["rights status string", "writer-rights"]])("does not classify a malformed native return as a failed API status: %s", (fault, stage) => {
  const s = setup(fault);
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(windowsNodeIoSetupReceipt(error)).toEqual({ stage });
  expect(s.calls.some(call => call.name === "GetLastError")).toBe(false);
});

it("preserves typed unknown cleanup over an ordinary setup receipt and fences future admission", () => {
  const s = setup("writer metadata false"); s.control.failCleanup = true;
  let error: unknown; try { s.bind(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WindowsNodeIoCleanupError); expect(windowsNodeIoSetupReceipt(error)).toBeUndefined();
  expect(s.fence.failure).toBe(error); expect(closedHandles(s.calls)).toEqual([10n, 11n]);
  const count = s.calls.length; expect(s.bind).toThrow(WindowsNodeIoCleanupError); expect(s.calls).toHaveLength(count);
});

it("brands receipts without trusting similarly named objects and closes the setup-only diagnostic lifetime", () => {
  expect(Object.isFrozen(WINDOWS_NODE_IO_SETUP_STAGES)).toBe(true); expect(Object.isFrozen(WINDOWS_NODE_IO_SETUP_OPERATIONS)).toBe(true);
  for (const candidate of [undefined, "private", { stage: "writer-metadata", operation: "CreateFileW", code: 5 },
    new Proxy({}, { getPrototypeOf() { throw new Error("private prototype"); }, get() { throw new Error("private getter"); } }),
    Object.assign(new Error("private path"), { name: "WindowsNodeIoSetupError", receipt: { stage: "writer-metadata" } })]) {
    expect(windowsNodeIoSetupReceipt(candidate)).toBeUndefined();
  }
  const s = setup(), owner = s.bind();
  let error: unknown; try { owner.acceptHostControl(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error); expect(windowsNodeIoSetupReceipt(error)).toBeUndefined(); owner.close();
});

it("creates one fresh protected output, a separate same-file nonwritable read pin, and canonical read-only NUL", () => {
  const s = setup(), owner = s.bind(), files = s.calls.filter(call => call.name === "CreateFileW");
  expect(files.map(call => call.args.slice(0, 3))).toEqual([
    [`${state}\\${WINDOWS_NODE_IO_OUTPUT}`, 2, 3], [`${state}\\${WINDOWS_NODE_IO_OUTPUT}`, 0x81, 3], ["\\\\?\\GLOBALROOT\\Device\\Null", 0x80000000, 3],
  ]);
  expect(files.map(call => [call.args[4], call.args[5]])).toEqual([[1, 0x200000], [3, 0x200000], [3, 0]]);
  const security = files[0].args[3] as Buffer;
  expect(security.length).toBe(24); expect(security.readUInt32LE(16)).toBe(0);
  const sddl = s.calls.find(call => call.name === "ConvertStringSecurityDescriptorToSecurityDescriptorW")!.args[0] as string;
  expect(sddl).toBe("O:S-1-5-21-1234G:S-1-5-21-1234D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1234)S:(ML;;NW;;;LW)");
  expect(sddl).not.toContain("S-1-15");
  expect(s.calls.filter(call => call.name === "NtQueryObject" && call.args[1] === 0)).toHaveLength(3);
  owner.close(); owner.close(); expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n]);
});

it.each(["invalid writer", "aliased pin", "aliased stdin", "disk stdin", "wrong NUL name", "outside NUL name", "NUL query", "nonEOF stdin", "wrong ID", "wrong volume", "hardlink", "reparse", "directory", "inheritable pin", "readable writer", "writable pin", "deletable writer", "executable writer"])("rejects unsafe native construction: %s", fault => {
  const s = setup(fault); expect(s.bind).toThrow();
  const closed = closedHandles(s.calls); expect(new Set(closed).size).toBe(closed.length);
  expect(s.calls.some(call => call.name === "CreateProcessW")).toBe(false);
});

it.each(["descriptor throw", "free throw", "free failed", "open throw", "pin throw"])("fences the process and retains allocator uncertainty while independently closing known handles: %s", fault => {
  const s = setup(fault);
  let first: unknown; try { s.bind(); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(WindowsNodeIoCleanupError);
  expect(s.fence.retained).toHaveLength(1);
  const calls = s.calls.length;
  try { s.bind(); } catch (error) { expect(error).toBe(first); }
  expect(s.calls).toHaveLength(calls);
  if (["free throw", "free failed", "pin throw"].includes(fault)) expect(closedHandles(s.calls)).toEqual([10n]);
});

it("uses STARTUPINFOEX, exactly the two owned handles, and a synchronous verified inheritance window for host and LPAC", () => {
  const s = started(), creates = s.calls.filter(call => call.name === "CreateProcessW");
  expect(creates).toHaveLength(2);
  for (const call of creates) {
    expect(call.args.slice(2, 6)).toEqual([null, null, 1, 0x08080404]);
    const startup = call.args[8] as Buffer;
    expect(startup.length).toBe(112); expect(startup.readUInt32LE(0)).toBe(112); expect(startup.readUInt32LE(60)).toBe(0x100);
    expect([80, 88, 96].map(offset => startup.readBigUInt64LE(offset))).toEqual([12n, 10n, 10n]);
    expect(startup.readBigUInt64LE(104)).not.toBe(0n);
    const index = s.calls.indexOf(call);
    expect(s.calls.slice(index + 1, index + 5).map(next => next.name)).toEqual(["SetHandleInformation", "GetHandleInformation", "SetHandleInformation", "GetHandleInformation"]);
    expect(s.calls[index + 1].args).toEqual([12n, 1, 0]); expect(s.calls[index + 3].args).toEqual([10n, 1, 0]);
  }
  const lists = s.calls.filter(call => call.name === "UpdateProcThreadAttribute" && call.args[2] === 0x20002);
  expect(lists).toHaveLength(2);
  for (const list of lists) expect([list.args[4], ...(list.args[3] as Buffer).values()]).toEqual([16, 12, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0]);
  const updates = s.calls.filter(call => call.name === "UpdateProcThreadAttribute");
  expect(updates.map(call => call.args[2])).toEqual([0x20002, LPAC_ATTRIBUTES.securityCapabilities, LPAC_ATTRIBUTES.allApplicationPackagesPolicy, 0x20002]);
  expect((updates[1].args[3] as Buffer).readBigUInt64LE(0)).toBe(55n);
  expect((updates[1].args[3] as Buffer).subarray(8)).toEqual(Buffer.alloc(16));
  expect((updates[2].args[3] as Buffer).readUInt32LE(0)).toBe(1);
  expect(s.flags).toEqual(new Map([[10n, 0], [11n, 0], [12n, 0], [13n, 0]])); s.owner.close();
});

it("gates LPAC on an explicitly accepted zero-output host control and exact bound profile", () => {
  const s = setup(), owner = s.bind();
  expect(() => owner.createLpac(profile, program, command, cwd, env)).toThrow(); expect(() => owner.acceptHostControl()).toThrow();
  owner.createHost(program, command, cwd, env);
  expect(() => owner.createLpac(profile, program, command, cwd, env)).toThrow();
  s.control.output = Buffer.from("private host bytes"); expect(() => owner.acceptHostControl()).toThrow();
  s.control.output = Buffer.alloc(0); owner.acceptHostControl();
  expect(() => owner.createLpac({ ...profile, sid: 99n }, program, command, cwd, env)).toThrow();
  owner.createLpac(profile, program, command, cwd, env); expect(() => owner.createHost(program, command, cwd, env)).toThrow(); owner.close();
});

it("requires a positive stop guard before closing parent IO, then reads the held read pin with bounded stable metadata", () => {
  const s = started(); s.control.output = Buffer.from("bounded diagnostic");
  expect(() => s.owner.readAfterStopped(() => { throw new Error("not stopped"); })).toThrow("not stopped");
  expect(closedHandles(s.calls)).toEqual([]);
  let guards = 0;
  expect(s.owner.readAfterStopped(() => { guards++; })).toEqual(s.control.output); expect(guards).toBe(3);
  expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n]);
  expect(s.owner.readAfterStopped(() => undefined)).toEqual(s.control.output);
  expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n]);
  s.owner.close(); expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n, 13n]);
});

it("opens the exact artifact with READ-only sharing only after stop and both parent IO closes, then reads only the new verified pin", () => {
  const s = started(); s.control.output = Buffer.from("bounded diagnostic");
  expect(s.calls.filter(call => call.name === "CreateFileW")).toHaveLength(3);
  let guards = 0;
  s.owner.readAfterStopped(() => {
    guards++;
    if (guards <= 2) expect(s.calls.filter(call => call.name === "CreateFileW")).toHaveLength(3);
    if (guards === 2) expect(closedHandles(s.calls)).toEqual([10n, 12n]);
  });
  const index = s.calls.findIndex(call => call.name === "CreateFileW" && call.args[2] === 1);
  expect(s.calls[index].args).toEqual([`${state}\\${WINDOWS_NODE_IO_OUTPUT}`, 0x81, 1, null, 3, 0x200000, null]);
  expect(s.calls.slice(0, index).some(call => call.name === "CloseHandle" && call.args[0] === 11n)).toBe(false);
  const oldClose = s.calls.findIndex(call => call.name === "CloseHandle" && call.args[0] === 11n);
  const firstPayloadRead = s.calls.findIndex(call => call.name === "ReadFile" && call.args[0] === 13n);
  expect(oldClose).toBeGreaterThan(index); expect(firstPayloadRead).toBeGreaterThan(oldClose);
  expect(s.calls.slice(index, oldClose).some(call => call.name === "GetHandleInformation" && call.args[0] === 13n)).toBe(true);
  expect(s.calls.slice(index, oldClose).some(call => call.name === "NtQueryObject" && call.args[0] === 13n && call.args[1] === 0)).toBe(true);
  expect(s.calls.some(call => call.name === "ReadFile" && call.args[0] === 11n)).toBe(false);
  s.owner.close();
});

it.each(["remaining writer", "exclusive open throw", "exclusive alias", "exclusive wrong ID", "exclusive hardlink", "exclusive changed metadata", "exclusive inheritable", "exclusive writable", "close original pin"])("retains publication uncertainty without reading payload: %s", fault => {
  const s = started(); s.control.output = Buffer.from("private diagnostic bytes"); s.control.fault = fault;
  expect(() => s.owner.readAfterStopped(() => undefined)).toThrow(WindowsNodeIoCleanupError);
  expect(s.calls.some(call => call.name === "ReadFile" && call.args[0] !== 12n)).toBe(false);
  expect(s.bind).toThrow(WindowsNodeIoCleanupError); expect(() => s.owner.close()).toThrow(WindowsNodeIoCleanupError);
  expect(closedHandles(s.calls)).toEqual(fault === "close original pin" ? [10n, 12n, 11n] : [10n, 12n]);
});

it("starts a fresh close lease if the exclusive read pin reuses the successfully closed writer value", () => {
  const s = started(); s.control.output = Buffer.from("bounded diagnostic"); s.control.fault = "reuse writer value";
  expect(s.owner.readAfterStopped(() => undefined)).toEqual(s.control.output);
  s.owner.close(); s.owner.close(); expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n, 10n]);
});

it.each([1, 2, 3])("rechecks admission immediately after a self-revoking stop callback at check %s", revokeAt => {
  const s = started(); s.control.output = Buffer.from("private diagnostic bytes"); let guards = 0;
  expect(() => s.owner.readAfterStopped(() => { if (++guards === revokeAt) s.owner.close(); })).toThrow();
  if (revokeAt <= 2) expect(s.calls.filter(call => call.name === "CreateFileW")).toHaveLength(3);
  for (const bytes of s.readBuffers) expect(bytes).toEqual(Buffer.alloc(bytes.length));
  expect(() => s.owner.readAfterStopped(() => undefined)).toThrow();
});

it("zeroes the cached raw payload on close and rejects a cached read whose callback revokes admission", () => {
  const s = started(); s.control.output = Buffer.from("private diagnostic bytes");
  const callerCopy = s.owner.readAfterStopped(() => undefined);
  expect(s.readBuffers).toHaveLength(1); expect(s.readBuffers[0]).toEqual(callerCopy);
  expect(() => s.owner.readAfterStopped(() => { s.owner.close(); })).toThrow();
  expect(s.readBuffers[0]).toEqual(Buffer.alloc(callerCopy.length)); expect(callerCopy).toEqual(s.control.output);
  expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n, 13n]);
});

it("rejects reads before any completed host and LPAC creation without invoking the stop guard", () => {
  const s = setup(), owner = s.bind(); let guards = 0;
  expect(() => owner.readAfterStopped(() => { guards++; })).toThrow(); expect(guards).toBe(0); owner.close();
});

it.each(["wrong ID", "wrong volume", "hardlink", "reparse", "directory", "oversize", "short read"])("rejects unsafe stopped output without exposing its bytes: %s", fault => {
  const s = started(); s.control.output = Buffer.from("private diagnostic bytes"); s.control.fault = fault;
  let error: unknown; try { s.owner.readAfterStopped(() => undefined); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain("private");
  if (["wrong ID", "wrong volume", "hardlink", "reparse", "directory"].includes(fault)) {
    expect(error).toBeInstanceOf(WindowsNodeIoCleanupError);
    expect(() => s.owner.close()).toThrow(WindowsNodeIoCleanupError);
    expect(() => s.owner.readAfterStopped(() => undefined)).toThrow(WindowsNodeIoCleanupError);
    expect(() => s.owner.createHost(program, command, cwd, env)).toThrow(WindowsNodeIoCleanupError);
    expect(s.bind).toThrow(WindowsNodeIoCleanupError); expect(closedHandles(s.calls)).toEqual([10n, 12n]);
  } else s.owner.close();
});

it("rejects output metadata changed by a writer while reading", () => {
  const s = started(); s.control.output = Buffer.from("private diagnostic bytes"); s.control.mutateOnRead = true;
  expect(() => s.owner.readAfterStopped(() => undefined)).toThrow(WindowsNodeIoCleanupError);
  expect(() => s.owner.close()).toThrow(WindowsNodeIoCleanupError); expect(closedHandles(s.calls)).toEqual([10n, 12n, 11n]);
});

it.each(["close writer", "close writer throw"])("caches parent writer close uncertainty, attempts stdin close independently, and never releases the read pin or retries handles: %s", fault => {
  const s = started(); s.control.fault = fault;
  let first: unknown; try { s.owner.readAfterStopped(() => undefined); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(WindowsNodeIoCleanupError); expect(closedHandles(s.calls)).toEqual([10n, 12n]);
  try { s.owner.close(); } catch (error) { expect(error).toBe(first); }
  expect(() => s.owner.readAfterStopped(() => undefined)).toThrow(WindowsNodeIoCleanupError); expect(closedHandles(s.calls)).toEqual([10n, 12n]);
});

it.each(["invalid pid", "invalid thread", "same PI handles"])("independently terminates and observes a created root on invalid PI: %s", fault => {
  const s = setup(), owner = s.bind(); s.control.fault = fault;
  expect(() => owner.createHost(program, command, cwd, env)).toThrow();
  expect(s.calls.some(call => call.name === "TerminateProcess" && call.args[0] === 20n)).toBe(true);
  expect(s.calls.some(call => call.name === "WaitForSingleObject" && call.args[0] === 20n && call.args[1] === 3000)).toBe(true);
  const closed = closedHandles(s.calls); expect(closed).toContain(20n); expect(new Set(closed).size).toBe(closed.length); owner.close();
});

it.each(["invalid process", "aliased process", "create throw", "unobserved", "close root"])("preserves assets when exact created root cleanup is uncertain: %s", fault => {
  const s = setup(), owner = s.bind(); s.control.fault = fault;
  expect(() => owner.createHost(program, command, cwd, env)).toThrow(ExperimentalWindowsCreateUncertain);
  expect(() => owner.close()).toThrow(ExperimentalWindowsCreateUncertain);
  expect(closedHandles(s.calls)).not.toContain(10n); expect(closedHandles(s.calls)).not.toContain(11n);
});

it.each(["reset", "reset mismatch"])("terminally caches inheritance reset failure even after independently observing the created process stopped: %s", fault => {
  const s = setup(), owner = s.bind(); s.control.fault = fault;
  expect(() => owner.createHost(program, command, cwd, env)).toThrow(WindowsNodeIoCleanupError);
  expect(s.calls.some(call => call.name === "WaitForSingleObject" && call.args[0] === 20n)).toBe(true);
  expect(closedHandles(s.calls)).toEqual([30n, 20n]);
  expect(() => owner.close()).toThrow(WindowsNodeIoCleanupError); expect(closedHandles(s.calls)).toEqual([30n, 20n]);
});

it("keeps attribute backing buffers alive and terminally retains IO on unknown DeleteProcThreadAttributeList cleanup", () => {
  const s = setup(), owner = s.bind(); s.control.fault = "delete attrs";
  expect(() => owner.createHost(program, command, cwd, env)).toThrow(WindowsNodeIoCleanupError);
  expect(s.calls.some(call => call.name === "WaitForSingleObject" && call.args[0] === 20n)).toBe(true);
  expect(() => owner.close()).toThrow(WindowsNodeIoCleanupError); expect(closedHandles(s.calls)).toEqual([30n, 20n]);
});

it("does not infer a process from a normal FALSE CreateProcess return and resets both inheritance flags", () => {
  const s = setup(), owner = s.bind(); s.control.fault = "create false";
  expect(() => owner.createHost(program, command, cwd, env)).toThrow("native contract");
  expect(s.calls.some(call => call.name === "TerminateProcess")).toBe(false);
  expect(s.flags.get(10n)).toBe(0); expect(s.flags.get(12n)).toBe(0); owner.close();
});

it("retains an attribute buffer and fences future owners if native attribute initialization throws", () => {
  const s = setup(), owner = s.bind(); s.control.fault = "initialize throw";
  expect(() => owner.createHost(program, command, cwd, env)).toThrow(WindowsNodeIoCleanupError);
  expect(s.fence.retained).toHaveLength(1);
  expect(s.calls.some(call => call.name === "CreateProcessW")).toBe(false);
  expect(() => owner.close()).toThrow(WindowsNodeIoCleanupError); expect(s.bind).toThrow(WindowsNodeIoCleanupError);
  expect(closedHandles(s.calls)).toEqual([]);
});
