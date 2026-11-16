/** Fixed ordinary-host ACL control. Only natural completion and the same emitted closed-job receipt permit report reads. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../../app/main/platform/os";
import { loadExperimentalWindowsLpacApi, type WindowsLpacApi, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { windowsCommandCreatorTokenSid } from "../../app/main/agent/windows-command-creator-token";
import type { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyCompletion } from "../../app/main/agent/windows-command-stop";
import type { loadWindowsCommandCopyProofNative, WindowsCommandCopyProofPin } from "./windows-command-copy-proof-native";
import { parseWindowsCommandCreatorOwnerReport, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES } from "./windows-command-creator-owner-report";

type Stage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
type Predicate = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export interface WindowsCommandCreatorOwnerHostFailure { readonly stage: Stage; readonly operation: number; readonly predicate: Predicate; readonly domain: 0 | 1 | 2; readonly code: number }
const failures = new WeakMap<object, Readonly<WindowsCommandCreatorOwnerHostFailure>>();
const barriers = new WeakMap<object, WindowsCommandCreatorOwnerHostCleanupError>();
export class WindowsCommandCreatorOwnerHostCleanupError extends Error {
  constructor() { super("The fixed ordinary-host ACL control could not verify its owners or complete result."); this.name = "WindowsCommandCreatorOwnerHostCleanupError"; this.stack = `${this.name}: ${this.message}`; }
}
/** Foreign and serialised failures have no diagnostic authority; no exception properties are inspected. */
export function windowsCommandCreatorOwnerHostFailure(error: unknown): Readonly<WindowsCommandCreatorOwnerHostFailure> | undefined {
  return error !== null && typeof error === "object" ? failures.get(error) : undefined;
}
export interface WindowsCommandCreatorOwnerHostFence { failure?: WindowsCommandCreatorOwnerHostCleanupError; retained: unknown[] }
const processFence: WindowsCommandCreatorOwnerHostFence = { retained: [] };
const valid = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const dword = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
function mint(stage: Stage, operation = 0, predicate: Predicate = 1, domain: 0 | 1 | 2 = 0, code = 0) {
  const error = new WindowsCommandCreatorOwnerHostCleanupError(); failures.set(error, Object.freeze({ stage, operation, predicate, domain, code })); return error;
}
function barrier(fence: WindowsCommandCreatorOwnerHostFence): WindowsCommandCreatorOwnerHostCleanupError | undefined {
  const previous = barriers.get(fence); if (previous) return previous;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(fence, "failure"); } catch { const error = mint(10, 0, 3); barriers.set(fence, error); return error; }
  if (!descriptor || "value" in descriptor && descriptor.value === undefined) return;
  const value: unknown = "value" in descriptor ? descriptor.value : undefined;
  const error = value !== null && typeof value === "object" && failures.has(value) ? value as WindowsCommandCreatorOwnerHostCleanupError : mint(10, 0, 3);
  barriers.set(fence, error); return error;
}
function failure(fence: WindowsCommandCreatorOwnerHostFence, stage: Stage, operation = 0, predicate: Predicate = 1,
  domain: 0 | 1 | 2 = 0, code = 0): WindowsCommandCreatorOwnerHostCleanupError {
  const previous = barrier(fence); if (previous) return previous;
  const error = mint(stage, operation, predicate, domain, code); barriers.set(fence, error);
  try { fence.failure = error; } catch { /* The private permanent barrier already owns the failure. */ }
  return error;
}
type Fn = (...args: unknown[]) => unknown;
export const WINDOWS_COMMAND_CREATOR_OWNER_HOST_FUNCTIONS = {
  kernel32: [
    "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)",
    "void * __stdcall GetCurrentProcess()", "int __stdcall CloseHandle(void *handle)", "uint32_t __stdcall GetProcessId(void *process)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, _Inout_ uint32_t *characters)",
    "void * __stdcall CreateJobObjectW(void *security, const char16_t *name)", "int __stdcall AssignProcessToJobObject(void *job, void *process)",
    "uint32_t __stdcall ResumeThread(void *thread)", "int __stdcall TerminateJobObject(void *job, uint32_t code)", "int __stdcall TerminateProcess(void *process, uint32_t code)",
    "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)", "int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *code)",
  ],
  advapi32: ["int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *returned)"],
} as const;
type StopApi = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess">;
export interface WindowsCommandCreatorOwnerHostNative {
  api: StopApi;
  original(): void;
  create(program: string, command: Buffer, cwd: string, environment: Buffer): WindowsSuspendedProcess;
  verify(root: Readonly<WindowsSuspendedProcess>, program: string): void;
  exited(process: bigint): boolean;
  exitCode(process: bigint): number;
  retire(): void;
  stage(value: Stage): void;
}
/** Test seam around fixed FFI prototypes; failed/partial creation and every uncertain close retain the entire binder. */
export function bindWindowsCommandCreatorOwnerHostNative(native: Pick<typeof Koffi, "sizeof" | "address">,
  load: (name: string) => { func(prototype: string): unknown }, fence: WindowsCommandCreatorOwnerHostFence = processFence): WindowsCommandCreatorOwnerHostNative {
  const blocked = barrier(fence); if (blocked) throw blocked;
  const fn: Record<string, Fn> = {}, operations = new Map<string, number>(), retained: unknown[] = [], tokens = new Set<bigint>(), transferred = new Set<bigint>();
  let stage: Stage = 10, originalUser: string | undefined, retired = false;
  const poison = (operation = 0, predicate: Predicate = 1, domain: 0 | 1 | 2 = 0, code = 0): never => {
    const error = failure(fence, stage, operation, predicate, domain, code);
    if (!fence.retained.includes(retained)) fence.retained.push(retained, { fn, tokens, transferred }); throw error;
  };
  const usable = () => { const error = barrier(fence); if (error) throw error; if (retired) poison(0, 4); };
  try {
    if (native.sizeof("void *") !== 8) poison(0, 3);
    for (const [library, prototypes] of Object.entries(WINDOWS_COMMAND_CREATOR_OWNER_HOST_FUNCTIONS)) {
      const dll = load(`${library}.dll`);
      for (const prototype of prototypes) {
        const name = /\b(\w+)\s*\(/.exec(prototype)![1], value = dll.func(prototype); if (typeof value !== "function") poison(0, 3);
        operations.set(name, operations.size + 1); fn[name] = value as Fn;
      }
    }
  } catch { poison(0, 3); }
  const call = (name: string, args: unknown[], stopping = false): unknown => {
    if (retired) poison(0, 4); if (!stopping) usable();
    const frame = { name, args }; retained.push(frame);
    let value: unknown; try { value = fn[name](...args); } catch { return poison(operations.get(name), 1); }
    if (!stopping) usable(); retained.pop(); return value;
  };
  const yes = (name: string, args: unknown[], stopping = false) => {
    const value = call(name, args, stopping); if (!bool(value) || value === 0) poison(operations.get(name), bool(value) ? 2 : 3, bool(value) ? 1 : 0, bool(value) ? value >>> 0 : 0);
  };
  const closeToken = (token: bigint) => { if (!tokens.has(token)) poison(3, 3); yes("CloseHandle", [token]); tokens.delete(token); };
  const identity = (process: unknown): string => {
    const out: unknown[] = [null]; retained.push(out); let result: unknown;
    try { result = fn.OpenProcessToken(process, 8, out); } catch { if (valid(out[0])) tokens.add(out[0]); return poison(13, 1); }
    usable();
    if (valid(out[0]) && !tokens.has(out[0]) && !transferred.has(out[0])) tokens.add(out[0]); else if (out[0] !== null && out[0] !== 0n) poison(13, 3);
    if (!bool(result) || result === 0 || !valid(out[0]) || !tokens.has(out[0])) poison(13, bool(result) ? 2 : 3, bool(result) ? 1 : 0, bool(result) ? result >>> 0 : 0);
    const token = out[0] as bigint; retained.pop();
    const bytes = Buffer.alloc(4096), returned: unknown[] = [0]; retained.push(bytes, returned);
    yes("GetTokenInformation", [token, 1, bytes, bytes.length, returned]);
    let sid: string; try { sid = windowsCommandCreatorTokenSid(bytes, returned[0], native.address(bytes), 1); } catch { return poison(14, 3); }
    const ac = Buffer.alloc(4), acBytes: unknown[] = [0]; retained.push(ac, acBytes);
    yes("GetTokenInformation", [token, 29, ac, ac.length, acBytes]);
    if (acBytes[0] !== 4 || ac.readUInt32LE(0) !== 0) poison(14, 4);
    closeToken(token); bytes.fill(0); ac.fill(0); retained.splice(retained.length - 4, 4); return sid;
  };
  const held = (value: bigint) => { if (!valid(value) || !transferred.has(value)) poison(0, 4); };
  const partial = (information: Buffer, predicate: Predicate, created = false): never => {
    // Only positive creation completion gives a valid unique process field ownership. FALSE/throw outputs remain unknown.
    const process = information.readBigUInt64LE(0), thread = information.readBigUInt64LE(8);
    failure(fence, stage, 1, predicate, predicate === 2 ? 1 : 0); retained.push(information);
    if (created && valid(process) && process !== thread && !transferred.has(process) && !tokens.has(process)) {
      const stopped = { process, returned: undefined as unknown }; retained.push(stopped);
      try { stopped.returned = fn.TerminateProcess(process, 125); } catch { /* Unknown completion retains the same process; no query, close or retry follows. */ }
    }
    return poison(1, predicate);
  };
  const api: StopApi = {
    createJob() { const value = call("CreateJobObjectW", [null, null]); if (!valid(value) || transferred.has(value) || tokens.has(value)) return poison(6, 3); transferred.add(value); return value; },
    assign(job, process) { held(job); held(process); yes("AssignProcessToJobObject", [job, process]); },
    resume(thread) { held(thread); const value = call("ResumeThread", [thread]); if (value !== 1) poison(8, 3); },
    // These two non-disposing requests may run after a failed query. They never query, close, retry or restore authority.
    terminateJob(job) { held(job); yes("TerminateJobObject", [job, 125], true); },
    terminateProcess(process) { held(process); yes("TerminateProcess", [process, 125], true); },
  };
  return {
    api, stage(value) { const error = barrier(fence); if (error) throw error; if (!Number.isInteger(value) || value < 1 || value > 10) poison(0, 3); stage = value; },
    original() { usable(); const process = call("GetCurrentProcess", []); if (process !== -1n && process !== 0xffffffffffffffffn) poison(2, 3); originalUser = identity(process); },
    create(program, command, cwd, environment) {
      usable(); if (!originalUser || !Buffer.isBuffer(command) || !Buffer.isBuffer(environment)) poison(1, 4);
      const startup = Buffer.alloc(104), information = Buffer.alloc(24); startup.writeUInt32LE(104);
      retained.push(startup, information, command, environment); let result: unknown;
      try { result = fn.CreateProcessW(program, command, null, null, 0, 0x40c, environment, cwd, startup, information); }
      catch { return partial(information, 1); }
      usable();
      const process = information.readBigUInt64LE(0), thread = information.readBigUInt64LE(8), pid = information.readUInt32LE(16);
      if (!bool(result) || result === 0 || !valid(process) || !valid(thread) || process === thread || transferred.has(process) || transferred.has(thread) ||
          tokens.has(process) || tokens.has(thread) || !pid) return partial(information, bool(result) && result === 0 ? 2 : 3, bool(result) && result !== 0);
      transferred.add(process); transferred.add(thread); retained.splice(retained.length - 4, 4);
      return Object.freeze({ process, thread, pid });
    },
    verify(root, program) {
      usable(); held(root.process); held(root.thread);
      const pid = call("GetProcessId", [root.process]); if (pid !== root.pid || !dword(pid) || !pid) poison(4, 4);
      const image = Buffer.alloc(65536), count: unknown[] = [32768]; retained.push(image, count);
      yes("QueryFullProcessImageNameW", [root.process, 0, image, count]);
      if (!dword(count[0]) || count[0] < 1 || count[0] >= 32768 || image.toString("utf16le", 0, count[0] * 2).toLowerCase() !== program.toLowerCase()) poison(5, 4);
      image.fill(0); retained.splice(retained.length - 2, 2);
      if (identity(root.process) !== originalUser) poison(14, 4);
    },
    exited(process) { held(process); const value = call("WaitForSingleObject", [process, 0]); if (value !== 0 && value !== 258) poison(11, 3); return value === 0; },
    exitCode(process) { held(process); const value: unknown[] = [0]; retained.push(value); yes("GetExitCodeProcess", [process, value]); if (!dword(value[0])) poison(12, 3); retained.pop(); return value[0] as number; },
    retire() { const error = barrier(fence); if (error) throw error; if (retired) return; if (tokens.size || retained.length) poison(0, 3); retired = true; transferred.clear(); originalUser = undefined; },
  };
}

export interface WindowsCommandCreatorOwnerHostBundle {
  createWindowsCommandRootOnlyStopOwner: typeof createWindowsCommandRootOnlyStopOwner;
  requireWindowsCommandRootOnlyCompletion: typeof requireWindowsCommandRootOnlyCompletion;
  loadWindowsCommandCopyProofNative: typeof loadWindowsCommandCopyProofNative;
}
type FixtureApi = Pick<WindowsLpacApi, "ownerSid" | "windowsDirectory" | "volumeFileSystem" | "createDirectory" | "writeNewFile" | "pinDirectory">;
type Files = Pick<typeof fs, "lstatSync" | "existsSync" | "realpathSync" | "rmSync">;
export interface WindowsCommandCreatorOwnerHostDependencies {
  api: FixtureApi; native: WindowsCommandCreatorOwnerHostNative; files?: Files; fence?: WindowsCommandCreatorOwnerHostFence;
  now?(): number; pause?(): Promise<void>;
  managedTemporary?(): string;
}
const ordinary = (value: string) => {
  if (typeof value !== "string" || value.length < 4 || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value ||
      /[\p{Cc}\p{Cf}"/]/u.test(value) || value.slice(3).split("\\").some(part => !part || part.includes(":") || /[. ]$/.test(part))) throw new Error();
  return value;
};
const inside = (a: string, b: string) => b.toLowerCase() === a.toLowerCase() || b.toLowerCase().startsWith(a.toLowerCase() + "\\");

/** Portable orchestration seam. Production supplies only real fixed native binders and the caller's verified emitted graph. */
export function bindWindowsCommandCreatorOwnerHost(dependencies: WindowsCommandCreatorOwnerHostDependencies) {
  const { api, native } = dependencies, files = dependencies.files ?? fs, fence = dependencies.fence ?? processFence;
  const now = dependencies.now ?? (() => performance.now()), pause = dependencies.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 10)));
  return async (asset: { executable: string; module: string }, loaded: WindowsCommandCreatorOwnerHostBundle, verifyBuild: () => void, scratchParent: string): Promise<Readonly<{ aclHostPositive: 4 }>> => {
    const blocked = barrier(fence); if (blocked) throw blocked;
    let stage: Stage = 1, owner: ReturnType<typeof createWindowsCommandRootOnlyStopOwner> | undefined, root: WindowsSuspendedProcess | undefined;
    let pin: WindowsCommandCopyProofPin | undefined, report: Buffer | undefined, directory: string | undefined;
    let proofNative: ReturnType<typeof loadWindowsCommandCopyProofNative> | undefined;
    const directories: bigint[] = [], graph = { api, native, loaded, asset, verifyBuild, directories, files, fence, get proofNative() { return proofNative; }, get owner() { return owner; }, get root() { return root; }, get pin() { return pin; }, get report() { return report; }, get directory() { return directory; } };
    const usable = () => { const error = barrier(fence); if (error) throw error; };
    const enter = (value: Stage) => { usable(); stage = value; native.stage(value); usable(); };
    const callback = <T>(operation: () => T): T => { usable(); const returned = operation(); usable(); return returned; };
    const guarded = <T>(operation: () => T): T => callback(() => proofNative!.guard(operation));
    try {
      ordinary(asset.executable); ordinary(asset.module); ordinary(scratchParent);
      if (typeof verifyBuild !== "function" || [asset.executable, asset.module].some(file => inside(scratchParent, file) || inside(file, scratchParent))) throw failure(fence, stage, 0, 8);
      callback(verifyBuild);
      const ancestry = (file: string) => { for (let current = file;;) { const info = callback(() => files.lstatSync(current)); if (!info.isDirectory() || info.isSymbolicLink()) throw failure(fence, stage, 0, 8); const next = path.dirname(current); if (current === next) break; current = next; } };
      ancestry(scratchParent);
      if (callback(() => files.realpathSync.native(scratchParent)).toLowerCase() !== scratchParent.toLowerCase()) throw failure(fence, stage, 0, 8);
      const managed = ordinary(callback(() => files.realpathSync.native(callback(dependencies.managedTemporary ?? (() => os.tmpdir())))));
      ancestry(managed); if (inside(scratchParent, managed) || inside(managed, scratchParent)) throw failure(fence, stage, 0, 8);
      proofNative = callback(() => loaded.loadWindowsCommandCopyProofNative());
      enter(2); if (guarded(() => api.volumeFileSystem(path.parse(scratchParent).root)) !== "NTFS") throw failure(fence, stage, 0, 8);
      const host = guarded(() => api.ownerSid()); if (typeof host !== "string" || host.length > 184 || !/^S-1-5-(?:\d+-)*\d+$/.test(host) || host === "S-1-5-18") throw failure(fence, stage, 0, 4);
      const sddl = `O:${host}D:P(A;OICI;FA;;;${host})(A;OICI;FA;;;SY)S:(ML;OICI;NW;;;ME)`;
      directory = path.join(scratchParent, `ember-creator-owner-host-${randomUUID()}`); if (callback(() => files.existsSync(directory!))) throw failure(fence, stage, 0, 8);
      const work = path.join(directory, "work"), state = path.join(directory, "state"), source = path.join(state, "source.bin"), canary = path.join(state, "canary.bin"), output = path.join(state, "host-report.bin"), ready = path.join(state, "host-ready.bin");
      for (const selected of [directory, work, state]) { guarded(() => api.createDirectory(selected, sddl)); const held = guarded(() => api.pinDirectory(selected)); if (!valid(held) || directories.includes(held)) throw failure(fence, stage, 0, 3); directories.push(held); }
      guarded(() => api.writeNewFile(source, Buffer.from("EMBER_CREATOR_HOST_SOURCE\n"), sddl)); guarded(() => api.writeNewFile(canary, Buffer.from("EMBER_CREATOR_HOST_CANARY\n"), sddl));
      const windows = ordinary(guarded(() => api.windowsDirectory())), command = Buffer.from([asset.executable, "acl-host", work, source, canary, output, ready].map(value => `"${value}"`).join(" ") + "\0", "utf16le");
      const environment = Buffer.from([`SystemRoot=${windows}`, `TEMP=${state}`, `TMP=${state}`, `WINDIR=${windows}`, "", ""].join("\0"), "utf16le");
      guarded(() => native.original()); enter(3); const binding = Object.freeze({}); owner = callback(() => loaded.createWindowsCommandRootOnlyStopOwner(binding, native.api));
      enter(4); await owner.launch(() => { callback(verifyBuild); return root = guarded(() => native.create(asset.executable, command, work, environment)); }, selected => { enter(5); guarded(() => native.verify(selected, asset.executable)); callback(verifyBuild); }, () => !barrier(fence));
      enter(6); let previous = callback(now); if (!Number.isFinite(previous) || previous < 0) throw failure(fence, stage, 0, 5); const until = previous + 20_000;
      for (;;) { const current = callback(now); if (!Number.isFinite(current) || current < previous || current > until) throw failure(fence, stage, 0, 5); previous = current; if (guarded(() => native.exited(root!.process))) break; await callback(pause); usable(); }
      const code = guarded(() => native.exitCode(root!.process)); if (!dword(code) || code !== 0) throw failure(fence, stage, 12, 4, dword(code) ? 2 : 0, dword(code) ? code : 0);
      enter(7); const completed = await owner.stop(15_000); usable(); if (callback(() => loaded.requireWindowsCommandRootOnlyCompletion(completed, binding)).rootPresent !== 1) throw failure(fence, stage, 0, 6);
      native.retire(); usable();
      enter(8); callback(verifyBuild); pin = guarded(() => proofNative!.pin(output, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES));
      if (pin.bytes !== WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES) throw failure(fence, stage, 0, 7); report = guarded(() => pin!.read());
      const parsed = parseWindowsCommandCreatorOwnerReport(report, "acl-host"); if (parsed.status !== 1 || parsed.acl.grantedMask !== 15 || parsed.acl.validatedMask !== 15 || parsed.acl.removedMask !== 3) throw failure(fence, stage, 0, 7);
      report.fill(0); report = undefined; guarded(() => pin!.close()); pin = undefined;
      enter(9); for (const held of [...directories].reverse()) guarded(() => proofNative!.close(held)); directories.length = 0;
      guarded(() => files.rmSync(directory!, { recursive: true, force: false })); directory = undefined; callback(verifyBuild);
      return Object.freeze({ aclHostPositive: 4 as const });
    } catch {
      try { owner?.retainStop(); } catch { /* A non-disposing request never restores disposal authority. */ }
      fence.retained.push(graph); throw failure(fence, stage);
    }
  };
}

/** The normal entry point has no caller-selected native implementation or process flags. */
export async function observeWindowsCommandCreatorOwnerHost(asset: { executable: string; module: string }, loaded: WindowsCommandCreatorOwnerHostBundle,
  verifyBuild: () => void, scratchParent: string): Promise<Readonly<{ aclHostPositive: 4 }>> {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw failure(processFence, 1, 0, 8);
  const blocked = barrier(processFence); if (blocked) throw blocked;
  try {
    const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
    const native = bindWindowsCommandCreatorOwnerHostNative(koffi, name => koffi.load(name), processFence);
    return await bindWindowsCommandCreatorOwnerHost({ api: loadExperimentalWindowsLpacApi(), native, fence: processFence })(asset, loaded, verifyBuild, scratchParent);
  } catch { throw failure(processFence, 10); }
}
