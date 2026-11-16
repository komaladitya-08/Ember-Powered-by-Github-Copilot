/** Test-only suspended-host token facts. No SID, privilege, process mutation or production launch authority. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";

type NativeFunction = (...args: unknown[]) => unknown;
type Stage = "binding" | "host-handle" | "current-process" | "parent-open" | "host-open" |
  "parent-user" | "host-user" | "parent-restricted" | "host-restricted" |
  "parent-integrity" | "host-integrity" | "parent-app-container" | "host-app-container";
type Reason = "native-false" | "abi" | "contract";
const stages = new Set<Stage>(["binding", "host-handle", "current-process", "parent-open", "host-open", "parent-user", "host-user",
  "parent-restricted", "host-restricted", "parent-integrity", "host-integrity", "parent-app-container", "host-app-container"]);
const reasons = new Set<Reason>(["native-false", "abi", "contract"]);
const failureReceipts = new WeakMap<object, Readonly<{ stage: Stage; reason: Reason; code?: number; returnedBytes?: number }>>();
export function windowsLibuvHostIdentityFailure(error: unknown) {
  return error !== null && typeof error === "object" ? failureReceipts.get(error) : undefined;
}
export interface WindowsLibuvTokenFacts { readonly hasRestrictions: number; readonly everFiltered: boolean; readonly integrityRid: number; readonly appContainer: 0 | 1 }
export interface WindowsLibuvHostIdentity {
  readonly sameUser: boolean;
  readonly parent: Readonly<WindowsLibuvTokenFacts>;
  readonly host: Readonly<WindowsLibuvTokenFacts>;
}
export class WindowsLibuvHostIdentityError extends Error {
  constructor(readonly stage: Stage, readonly reason: Reason, code?: number, returnedBytes?: unknown) {
    super("The fixed suspended-host token facts failed their native contract."); this.name = "WindowsLibuvHostIdentityError";
    if (stages.has(stage) && reasons.has(reason)) failureReceipts.set(this, Object.freeze({ stage, reason,
      ...(reason === "native-false" && typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 0xffffffff ? { code } : {}),
      ...(reason === "contract" && typeof returnedBytes === "number" && Number.isInteger(returnedBytes) && returnedBytes >= 0 && returnedBytes <= 0xffffffff ? { returnedBytes } : {}) }));
  }
}
export class WindowsLibuvHostIdentityCleanupError extends WindowsNodeHostCleanupError {
  constructor() {
    super(); this.name = "WindowsLibuvHostIdentityCleanupError";
    this.message = "The fixed token diagnostic could not verify native ownership or cleanup; retain its owner.";
  }
}
/** Injectable only so portable FFI tests can isolate terminal ownership failures. */
export interface WindowsLibuvHostIdentityFence { failure?: WindowsLibuvHostIdentityCleanupError; retained: unknown[] }
const processFence: WindowsLibuvHostIdentityFence = { retained: [] };
const INVALID_HANDLE = 0xffffffffffffffffn, MAX_POINTER = INVALID_HANDLE;
const TOKEN_QUERY = 0x8, MAX_TOKEN_BYTES = 256;
export const WINDOWS_LIBUV_HOST_IDENTITY_FUNCTIONS = {
  kernel32: ["void * __stdcall GetCurrentProcess()", "int __stdcall CloseHandle(void *handle)", "uint32_t __stdcall GetLastError()"],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *returned)",
  ],
} as const;
const isHandle = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const isBool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const isCount = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;

/** Decodes pointers only as offsets inside the returned buffer, never by following native memory. */
function sid(bytes: Buffer, returned: number, address: unknown, stage: Stage): Buffer {
  const invalid = () => new WindowsLibuvHostIdentityError(stage, "contract");
  if (returned < 24 || returned > bytes.length || typeof address !== "bigint" || address <= 0n || address > MAX_POINTER - BigInt(bytes.length)) throw invalid();
  const pointer = bytes.readBigUInt64LE(0), delta = pointer - address;
  if (delta < 16n || delta > BigInt(returned - 8) || delta % 4n !== 0n) throw invalid();
  const offset = Number(delta), count = bytes[offset + 1];
  if (bytes[offset] !== 1 || count > 15 || offset + 8 + count * 4 > returned) throw invalid();
  return bytes.subarray(offset, offset + 8 + count * 4);
}

export function bindWindowsLibuvHostIdentity(koffi: Pick<typeof Koffi, "sizeof" | "address">,
  load: (name: string) => { func(prototype: string): unknown }, fence: WindowsLibuvHostIdentityFence = processFence): { inspect(hostProcess: WindowsHandle): WindowsLibuvHostIdentity } {
  if (fence.failure) throw fence.failure;
  const fn: Record<string, NativeFunction> = {};
  try {
    if (koffi.sizeof("void *") !== 8) throw new WindowsLibuvHostIdentityError("binding", "contract");
    for (const [library, prototypes] of Object.entries(WINDOWS_LIBUV_HOST_IDENTITY_FUNCTIONS)) {
      const dll = load(`${library}.dll`);
      for (const prototype of prototypes) {
        const value = dll.func(prototype);
        if (typeof value !== "function") throw new WindowsLibuvHostIdentityError("binding", "abi");
        fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as NativeFunction;
      }
    }
  } catch (error) {
    if (error instanceof WindowsLibuvHostIdentityError) throw error;
    throw new WindowsLibuvHostIdentityError("binding", "abi");
  }
  return { inspect(hostProcess) {
    if (fence.failure) throw fence.failure;
    if (!isHandle(hostProcess)) throw new WindowsLibuvHostIdentityError("host-handle", "contract");
    const owned = new Set<WindowsHandle>(), buffers: Buffer[] = [], outputs: unknown[][] = [];
    let uncertain = false, currentProcess: unknown, result: WindowsLibuvHostIdentity | undefined;
    let failure: WindowsLibuvHostIdentityError | undefined;
    function fail(stage: Stage, reason: Reason, code?: number, returnedBytes?: unknown): never { throw new WindowsLibuvHostIdentityError(stage, reason, code, returnedBytes); }
    const lastError = () => { try { const value = fn.GetLastError(); return typeof value === "number" ? value : undefined; } catch { return undefined; } };
    const open = (process: unknown, stage: "parent-open" | "host-open"): WindowsHandle => {
      const output: unknown[] = [null]; outputs.push(output);
      let ok: unknown, code: number | undefined;
      try { ok = fn.OpenProcessToken(process, TOKEN_QUERY, output); if (ok === 0) code = lastError(); }
      catch { uncertain = true; }
      const token = output[0];
      if (isHandle(token) && token !== hostProcess && token !== currentProcess && !owned.has(token)) owned.add(token);
      else if (token !== null && token !== 0n) uncertain = true;
      if (!isBool(ok)) uncertain = true;
      if (ok === 0 && token !== null && token !== 0n) uncertain = true;
      if (uncertain) fail(stage, "abi");
      if (ok === 0) fail(stage, "native-false", code);
      if (!isHandle(token) || !owned.has(token)) { uncertain = true; fail(stage, "abi"); }
      return token;
    };
    const query = (token: WindowsHandle, kind: 1 | 21 | 25 | 29, stage: Stage): { bytes: Buffer; returned: number } => {
      const bytes = Buffer.alloc(kind === 21 || kind === 29 ? 4 : MAX_TOKEN_BYTES), returned: unknown[] = [0]; buffers.push(bytes);
      let ok: unknown;
      try { ok = fn.GetTokenInformation(token, kind, bytes, bytes.length, returned); }
      catch { fail(stage, "abi"); }
      if (!isBool(ok)) fail(stage, "abi");
      if (ok === 0) fail(stage, "native-false", lastError());
      if (!isCount(returned[0], bytes.length) || (bytes.length === 4 && returned[0] !== 4)) fail(stage, "contract", undefined, returned[0]);
      return { bytes, returned: returned[0] };
    };
    const tokenSid = (token: WindowsHandle, kind: 1 | 25, stage: Stage): { bytes: Buffer; attributes: number } => {
      const value = query(token, kind, stage);
      let address: unknown;
      try { address = koffi.address(value.bytes); } catch { fail(stage, "abi"); }
      return { bytes: sid(value.bytes, value.returned, address, stage), attributes: value.bytes.readUInt32LE(8) };
    };
    const tokenBool = (token: WindowsHandle, stage: Stage): 0 | 1 => {
      const value = query(token, 29, stage).bytes.readUInt32LE(0);
      if (value !== 0 && value !== 1) fail(stage, "contract");
      return value;
    };
    const facts = (token: WindowsHandle, side: "parent" | "host"): Readonly<WindowsLibuvTokenFacts> => {
      // TokenHasRestrictions is a DWORD that is nonzero if the token has ever been filtered, not a canonical BOOL.
      const hasRestrictions = query(token, 21, `${side}-restricted`).bytes.readUInt32LE(0);
      const integrity = tokenSid(token, 25, `${side}-integrity`);
      if (integrity.bytes[1] !== 1 || !integrity.bytes.subarray(2, 8).equals(Buffer.from([0, 0, 0, 0, 0, 16])) || (integrity.attributes & 0x20) === 0)
        fail(`${side}-integrity`, "contract");
      const integrityRid = integrity.bytes.readUInt32LE(8), appContainer = tokenBool(token, `${side}-app-container`);
      return Object.freeze({ hasRestrictions, everFiltered: hasRestrictions !== 0, integrityRid, appContainer });
    };
    try {
      try { currentProcess = fn.GetCurrentProcess(); } catch { fail("current-process", "abi"); }
      if (currentProcess !== INVALID_HANDLE && currentProcess !== -1n) fail("current-process", "abi");
      const parent = open(currentProcess, "parent-open"), host = open(hostProcess, "host-open");
      const parentUser = tokenSid(parent, 1, "parent-user").bytes, hostUser = tokenSid(host, 1, "host-user").bytes;
      result = Object.freeze({ sameUser: parentUser.equals(hostUser), parent: facts(parent, "parent"), host: facts(host, "host") });
    } catch (error) {
      failure = error instanceof WindowsLibuvHostIdentityError ? error : new WindowsLibuvHostIdentityError("binding", "abi");
    } finally {
      // Only our two token handles are owned. The supplied process and parent pseudo-handle are borrowed.
      for (const token of [...owned].reverse()) {
        owned.delete(token); // No retry after either an unsuccessful close or an FFI exception.
        try { const ok = fn.CloseHandle(token); if (!isBool(ok) || ok === 0) { uncertain = true; owned.add(token); } }
        catch { uncertain = true; owned.add(token); }
      }
      if (uncertain) {
        fence.failure ??= new WindowsLibuvHostIdentityCleanupError();
        fence.retained.push({ owned, buffers, outputs, hostProcess, currentProcess, fn });
      } else {
        for (const buffer of buffers) buffer.fill(0);
        for (const output of outputs) output.fill(null);
      }
    }
    if (fence.failure) throw fence.failure;
    if (failure) throw failure;
    if (!result) throw new WindowsLibuvHostIdentityError("binding", "contract");
    return result;
  } };
}

/** Loaded only by the separate native experiment, never during portable test discovery or production startup. */
export function loadWindowsLibuvHostIdentity(): ReturnType<typeof bindWindowsLibuvHostIdentity> {
  if (fenceUnavailable()) throw new WindowsLibuvHostIdentityError("binding", "contract");
  if (processFence.failure) throw processFence.failure;
  try {
    const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
    return bindWindowsLibuvHostIdentity(koffi, name => koffi.load(name));
  } catch (error) {
    if (error instanceof WindowsLibuvHostIdentityError || error instanceof WindowsLibuvHostIdentityCleanupError) throw error;
    throw new WindowsLibuvHostIdentityError("binding", "abi");
  }
}
const fenceUnavailable = () => process.platform !== "win32" || process.arch !== "x64";
