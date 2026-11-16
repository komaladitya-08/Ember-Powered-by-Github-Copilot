import { expect, it } from "vitest";
import { bindWindowsLibuvHostIdentity, loadWindowsLibuvHostIdentity, WindowsLibuvHostIdentityCleanupError,
  WindowsLibuvHostIdentityError, windowsLibuvHostIdentityFailure, WINDOWS_LIBUV_HOST_IDENTITY_FUNCTIONS, type WindowsLibuvHostIdentityFence } from "../fixtures/windows-libuv-host-identity";
import { WindowsNodeHostCleanupError } from "../fixtures/windows-node-lpac-startup";

type Call = { name: string; args: unknown[] };
const HOST_PROCESS = 500n, PARENT_TOKEN = 11n, HOST_TOKEN = 12n, PSEUDO_PROCESS = 0xffffffffffffffffn;
function setup() {
  const calls: Call[] = [], buffers: Buffer[] = [], addresses = new Map<Buffer, bigint>();
  const fence: WindowsLibuvHostIdentityFence = { retained: [] };
  const control = { fault: "", closeFault: "", closeToken: HOST_TOKEN, at: "parent-user", differentUser: false, parentRestricted: 0, hostRestricted: 0,
    parentIntegrity: 0x3000, hostIntegrity: 0x3000, parentAppContainer: 0, hostAppContainer: 0, pseudo: PSEUDO_PROCESS, pointerSize: 8 };
  const address = (buffer: Buffer) => {
    let value = addresses.get(buffer);
    if (!value) { value = BigInt(0x10000 + addresses.size * 0x10000); addresses.set(buffer, value); }
    return value;
  };
  const binding = { sizeof: () => control.pointerSize, address } as unknown as Parameters<typeof bindWindowsLibuvHostIdentity>[0];
  const load = (library: string) => ({ func(prototype: string) {
    expect(Object.entries(WINDOWS_LIBUV_HOST_IDENTITY_FUNCTIONS).some(([name, prototypes]) => `${name}.dll` === library && (prototypes as readonly string[]).includes(prototype))).toBe(true);
    const name = /\b(\w+)\s*\(/.exec(prototype)![1];
    return (...args: unknown[]) => {
      calls.push({ name, args });
      if (name === "GetLastError") return 5;
      if (name === "GetCurrentProcess") {
        if (control.fault === "current throw") throw new Error("private native current-process failure");
        return control.pseudo;
      }
      if (name === "CloseHandle") {
        const fault = control.closeFault || control.fault;
        if (fault === "close throw" && args[0] === control.closeToken) throw new Error("private native close failure");
        if (fault === "close false" && args[0] === control.closeToken) return 0;
        if (fault === "close ABI" && args[0] === control.closeToken) return undefined;
        return 1;
      }
      if (name === "OpenProcessToken") {
        const side = args[0] === HOST_PROCESS ? "host-open" : "parent-open", output = args[2] as unknown[];
        if (control.at === side && control.fault === "open false") return 0;
        if (control.at === side && control.fault === "open throw empty") throw new Error("private native token-open failure");
        if (control.at === side && control.fault === "open ABI empty") return undefined;
        output[0] = args[0] === HOST_PROCESS ? HOST_TOKEN : PARENT_TOKEN;
        if (control.at === side) {
          if (control.fault === "open zero") output[0] = 0n;
          if (control.fault === "open invalid") output[0] = PSEUDO_PROCESS;
          if (control.fault === "open borrowed process") output[0] = HOST_PROCESS;
          if (control.fault === "open borrowed pseudo") output[0] = PSEUDO_PROCESS;
          if (control.fault === "open duplicate") output[0] = PARENT_TOKEN;
          if (control.fault === "open false with token") return 0;
          if (control.fault === "open throw with token") throw new Error("private native token-open failure");
          if (control.fault === "open ABI with token") return "yes";
        }
        return 1;
      }
      if (name === "GetTokenInformation") {
        const [token, kind, buffer, capacity, returned] = args as [bigint, number, Buffer, number, unknown[]];
        expect(buffer.length).toBe(capacity); expect(capacity).toBe(kind === 21 || kind === 29 ? 4 : 256); buffers.push(buffer);
        const side = token === PARENT_TOKEN ? "parent" : "host", stage = `${side}-${({ 1: "user", 21: "restricted", 25: "integrity", 29: "app-container" } as Record<number, string>)[kind]}`;
        const fault = stage === control.at ? control.fault : "";
        if (fault === "query false") return 0;
        if (fault === "query throw") throw new Error("private native query failure and S-1-5-21-1001");
        if (fault === "query ABI") return true;
        if (kind === 21 || kind === 29) {
          const value = kind === 21 ? side === "parent" ? control.parentRestricted : control.hostRestricted
            : side === "parent" ? control.parentAppContainer : control.hostAppContainer;
          buffer.writeUInt32LE(fault === "boolean invalid" ? 2 : value); returned[0] = fault === "boolean short" ? 3 : 4;
        } else {
          const subAuthorities = kind === 25 ? [side === "parent" ? control.parentIntegrity : control.hostIntegrity]
            : [21, 1, 2, 3, side === "host" && control.differentUser ? 1002 : 1001];
          buffer.writeBigUInt64LE(address(buffer) + 16n); buffer.writeUInt32LE(kind === 25 ? 0x60 : 0, 8);
          buffer[16] = 1; buffer[17] = subAuthorities.length; buffer[23] = kind === 25 ? 16 : 5;
          subAuthorities.forEach((value, index) => buffer.writeUInt32LE(value, 24 + index * 4)); returned[0] = 24 + subAuthorities.length * 4;
          if (fault === "pointer zero") buffer.writeBigUInt64LE(0n);
          if (fault === "pointer before buffer") buffer.writeBigUInt64LE(address(buffer) - 4n);
          if (fault === "pointer in header") buffer.writeBigUInt64LE(address(buffer) + 8n);
          if (fault === "pointer after returned") buffer.writeBigUInt64LE(address(buffer) + BigInt(returned[0] as number));
          if (fault === "pointer misaligned") buffer.writeBigUInt64LE(address(buffer) + 17n);
          if (fault === "pointer wrap") buffer.writeBigUInt64LE(PSEUDO_PROCESS);
          if (fault === "SID revision") buffer[16] = 2;
          if (fault === "SID count") buffer[17] = 16;
          if (fault === "SID truncated") buffer[17] = 15;
          if (fault === "integrity authority") buffer[23] = 5;
          if (fault === "integrity count") { buffer[17] = 2; returned[0] = 32; }
          if (fault === "integrity attribute") buffer.writeUInt32LE(0, 8);
        }
        if (fault === "returned short") returned[0] = 23;
        if (fault === "returned oversized") returned[0] = capacity + 1;
        if (fault === "returned negative") returned[0] = -1;
        if (fault === "returned fraction") returned[0] = 3.5;
        if (fault === "returned string") returned[0] = "private returned size";
        return fault === "noncanonical BOOL" ? -1 : 1;
      }
      throw new Error("Unexpected native API in fixed token diagnostic.");
    };
  } });
  const bind = () => bindWindowsLibuvHostIdentity(binding, load, fence);
  return { calls, buffers, control, fence, bind };
}
const closes = (calls: Call[]) => calls.filter(call => call.name === "CloseHandle").map(call => call.args[0]);
const fixedError = (error: unknown) => {
  expect(error).toBeInstanceOf(Error); expect(String(error)).not.toMatch(/private|S-1-|1001|credential|C:\\/);
  expect((error as Error).cause).toBeUndefined(); expect(JSON.stringify(error)).not.toMatch(/private|S-1-|1001|credential|C:\\/);
};

it("queries the exact host and parent with TOKEN_QUERY only, returns fixed facts and closes only the two owned tokens", () => {
  const s = setup(), result = s.bind().inspect(HOST_PROCESS);
  expect(result).toEqual({ sameUser: true, parent: { restricted: false, integrityRid: 0x3000, appContainer: 0 }, host: { restricted: false, integrityRid: 0x3000, appContainer: 0 } });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.parent)).toBe(true); expect(Object.isFrozen(result.host)).toBe(true);
  expect(s.calls.filter(call => call.name === "OpenProcessToken").map(call => call.args.slice(0, 2))).toEqual([[PSEUDO_PROCESS, 8], [HOST_PROCESS, 8]]);
  expect(s.calls.filter(call => call.name === "GetTokenInformation").map(call => call.args.slice(0, 2))).toEqual([
    [PARENT_TOKEN, 1], [HOST_TOKEN, 1], [PARENT_TOKEN, 21], [PARENT_TOKEN, 25], [PARENT_TOKEN, 29], [HOST_TOKEN, 21], [HOST_TOKEN, 25], [HOST_TOKEN, 29],
  ]);
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.retained).toEqual([]);
  expect(s.buffers.every(bytes => bytes.every(value => value === 0))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/S-1-|1001|handle|buffer|sid|private/i);
});

it("reports observed user difference, restrictions and integrity independently without granting or altering anything", () => {
  const s = setup(); Object.assign(s.control, { differentUser: true, parentRestricted: 1, hostRestricted: 0, parentIntegrity: 0x2000, hostIntegrity: 0x1000, hostAppContainer: 1 });
  expect(s.bind().inspect(HOST_PROCESS)).toEqual({ sameUser: false, parent: { restricted: true, integrityRid: 0x2000, appContainer: 0 }, host: { restricted: false, integrityRid: 0x1000, appContainer: 1 } });
  expect(new Set(s.calls.map(call => call.name))).toEqual(new Set(["GetCurrentProcess", "OpenProcessToken", "GetTokenInformation", "CloseHandle"]));
});

it("accepts nonzero integer BOOL success without treating JavaScript truthiness as a native ABI", () => {
  const s = setup(); s.control.fault = "noncanonical BOOL";
  expect(s.bind().inspect(HOST_PROCESS).sameUser).toBe(true);
});

it.each([0n, -1n, PSEUDO_PROCESS, 0x8000000000000000n, 0xfffffffffffffff0n])("refuses a non-owned host process value before any native call: %s", process => {
  const s = setup(); expect(() => s.bind().inspect(process)).toThrowError(expect.objectContaining({ stage: "host-handle", reason: "contract" }));
  expect(s.calls).toEqual([]); expect(s.fence.retained).toEqual([]);
});

it("requires Win64 at bind time and keeps the native loader lazy off Windows", () => {
  const s = setup(); s.control.pointerSize = 4;
  expect(() => s.bind()).toThrowError(expect.objectContaining({ stage: "binding", reason: "contract" })); expect(s.calls).toEqual([]);
  if (process.platform !== "win32" || process.arch !== "x64") expect(() => loadWindowsLibuvHostIdentity()).toThrow(WindowsLibuvHostIdentityError);
});

it.each(["parent-open", "host-open"])("a definite failed open closes earlier owned tokens without poisoning: %s", at => {
  const s = setup(); Object.assign(s.control, { at, fault: "open false" });
  let error: unknown; try { s.bind().inspect(HOST_PROCESS); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ stage: at, reason: "native-false" });
  expect(windowsLibuvHostIdentityFailure(error)).toEqual({ stage: at, reason: "native-false", code: 5 });
  expect(closes(s.calls)).toEqual(at === "host-open" ? [PARENT_TOKEN] : []); expect(s.fence.failure).toBeUndefined();
});

it("publishes only branded closed failure facts without reading foreign getters", () => {
  const foreign = Object.defineProperty({}, "stage", { get() { throw new Error("private getter"); } });
  expect(windowsLibuvHostIdentityFailure(foreign)).toBeUndefined();
  expect(windowsLibuvHostIdentityFailure(new Error("private error"))).toBeUndefined();
  expect(windowsLibuvHostIdentityFailure(new WindowsLibuvHostIdentityError("host-user", "contract"))).toEqual({ stage: "host-user", reason: "contract" });
  expect(windowsLibuvHostIdentityFailure(new WindowsLibuvHostIdentityError("private" as "binding", "contract"))).toBeUndefined();
});

it.each(["query false", "query throw", "query ABI"])("query-only failure still closes both known token handles safely: %s", fault => {
  const s = setup(); Object.assign(s.control, { at: "host-user", fault }); let error: unknown;
  try { s.bind().inspect(HOST_PROCESS); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ stage: "host-user", reason: fault === "query false" ? "native-false" : "abi" }); fixedError(error);
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.failure).toBeUndefined();
  expect(s.buffers.every(bytes => bytes.every(value => value === 0))).toBe(true);
});

it.each(["returned short", "returned oversized", "returned negative", "returned fraction", "returned string", "pointer zero", "pointer before buffer", "pointer in header", "pointer after returned", "pointer misaligned", "pointer wrap", "SID revision", "SID count", "SID truncated"])("refuses a token-user buffer without following native pointers: %s", fault => {
  const s = setup(); s.control.fault = fault; let error: unknown;
  try { s.bind().inspect(HOST_PROCESS); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ stage: "parent-user", reason: "contract" }); fixedError(error);
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.failure).toBeUndefined();
});

it.each(["integrity authority", "integrity count", "integrity attribute"])("requires a bounded mandatory-label SID before reporting an integrity RID: %s", fault => {
  const s = setup(); Object.assign(s.control, { at: "host-integrity", fault });
  expect(() => s.bind().inspect(HOST_PROCESS)).toThrowError(expect.objectContaining({ stage: "host-integrity", reason: "contract" }));
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.failure).toBeUndefined();
});

it.each(["parent-restricted", "host-restricted", "parent-app-container", "host-app-container"])("requires an exact four-byte 0/1 DWORD for %s", at => {
  const s = setup(); Object.assign(s.control, { at, fault: "boolean invalid" });
  expect(() => s.bind().inspect(HOST_PROCESS)).toThrowError(expect.objectContaining({ stage: at, reason: "contract" }));
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.failure).toBeUndefined();
  s.control.fault = "boolean short";
  expect(() => s.bind().inspect(HOST_PROCESS)).toThrowError(expect.objectContaining({ stage: at, reason: "contract" }));
});

it.each(["open throw empty", "open ABI empty", "open zero", "open invalid", "open borrowed process", "open borrowed pseudo", "open duplicate", "open false with token", "open throw with token", "open ABI with token"])("retains and fences ambiguous token ownership, closing only known nonborrowed tokens once: %s", fault => {
  const s = setup(); Object.assign(s.control, { at: "host-open", fault }); const diagnostic = s.bind(); let error: unknown;
  try { diagnostic.inspect(HOST_PROCESS); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(WindowsLibuvHostIdentityCleanupError); expect(error).toBeInstanceOf(WindowsNodeHostCleanupError); fixedError(error);
  expect(s.fence.retained).toHaveLength(1); expect(s.fence.failure).toBe(error);
  const closed = closes(s.calls); expect(new Set(closed).size).toBe(closed.length); expect(closed).not.toContain(HOST_PROCESS); expect(closed).not.toContain(PSEUDO_PROCESS);
  expect(closed).toContain(PARENT_TOKEN);
  if (["open false with token", "open throw with token", "open ABI with token"].includes(fault)) expect(closed).toEqual([HOST_TOKEN, PARENT_TOKEN]);
  const count = s.calls.length;
  expect(() => diagnostic.inspect(HOST_PROCESS)).toThrow(error as Error); expect(() => s.bind()).toThrow(error as Error); expect(s.calls).toHaveLength(count);
});

it.each(["close false", "close throw", "close ABI"])("attempts every owned token close once and fences any unverified close: %s", fault => {
  const s = setup(); s.control.fault = fault; const diagnostic = s.bind();
  expect(() => diagnostic.inspect(HOST_PROCESS)).toThrow(WindowsLibuvHostIdentityCleanupError);
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.retained).toHaveLength(1);
  const count = s.calls.length; expect(() => diagnostic.inspect(HOST_PROCESS)).toThrow(WindowsLibuvHostIdentityCleanupError); expect(s.calls).toHaveLength(count);
});

it.each([HOST_TOKEN, PARENT_TOKEN])("a query failure cannot mask an unsuccessful token close (%s)", closeToken => {
  const s = setup(); Object.assign(s.control, { at: "parent-user", fault: "query false", closeFault: "close false", closeToken });
  expect(() => s.bind().inspect(HOST_PROCESS)).toThrow(WindowsLibuvHostIdentityCleanupError);
  expect(closes(s.calls)).toEqual([HOST_TOKEN, PARENT_TOKEN]); expect(s.fence.retained).toHaveLength(1);
});
