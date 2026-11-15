/**
 * Win64 bindings for an offline, fixture-only LPAC experiment. Not connected to codingAvailable().
 * Contracts/constants: Microsoft Learn implementing-an-appcontainer, UpdateProcThreadAttribute,
 * TOKEN_INFORMATION_CLASS, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION and CreateProcessW.
 * No ordinary AppContainer fallback; attribute buffers stay alive through DeleteProcThreadAttributeList.
 */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_PLATFORM } from "../platform/os";

export type WindowsHandle = bigint;
/** A native process was created but its termination could not be independently observed. */
export class ExperimentalWindowsCreateUncertain extends Error {}
export const LPAC_ATTRIBUTES = { securityCapabilities: 0x20009, allApplicationPackagesPolicy: 0x2000f } as const;
export const LPAC_OPT_OUT = 1;
export const LPAC_CREATE_FLAGS = 0x4 | 0x400 | 0x80000 | 0x08000000;
export const LPAC_KILL_ON_CLOSE = 0x2000;
const INVALID_HANDLE = 0xffffffffffffffffn;
const TOKEN_QUERY = 0x8;
type NativeFunction = (...args: unknown[]) => unknown;
export interface WindowsLpacProfile { name: string; sid: WindowsHandle; sidText: string }
export interface WindowsSuspendedProcess { process: WindowsHandle; thread: WindowsHandle; pid: number }
export interface WindowsJobState { active: number; listed: number }

/** Actual native operations, replaceable only for lifecycle failure tests. */
export interface WindowsLpacApi {
  createProfile(name: string): WindowsLpacProfile;
  deleteProfile(profile: WindowsLpacProfile): void;
  ownerSid(): string;
  windowsDirectory(): string;
  profileLocalAppDataBase(profile: WindowsLpacProfile): string;
  volumeFileSystem(root: string): string;
  createDirectory(file: string, sddl: string): void;
  writeNewFile(file: string, bytes: Buffer, sddl: string): void;
  pinDirectory(file: string): WindowsHandle;
  createJob(): WindowsHandle;
  createSuspended(profile: WindowsLpacProfile, program: string, command: Buffer, cwd: string, env: Buffer): WindowsSuspendedProcess;
  assign(job: WindowsHandle, process: WindowsHandle): void;
  verifyToken(profile: WindowsLpacProfile, process: WindowsHandle): void;
  resume(thread: WindowsHandle): void;
  terminateJob(job: WindowsHandle): void;
  terminateProcess(process: WindowsHandle): void;
  exited(process: WindowsHandle): boolean;
  jobState(job: WindowsHandle): WindowsJobState;
  exitCode(process: WindowsHandle): number;
  close(handle: WindowsHandle): void;
}

export const WINDOWS_LPAC_FUNCTIONS = {
  kernel32: [
    "uint32_t __stdcall GetLastError()", "int __stdcall CloseHandle(void *handle)",
    "void * __stdcall LocalFree(void *memory)", "void * __stdcall GetCurrentProcess()",
    "uint32_t __stdcall GetWindowsDirectoryW(void *text, uint32_t size)",
    "uint32_t __stdcall GetDriveTypeW(const char16_t *root)",
    "int __stdcall GetVolumeInformationW(const char16_t *root, void *volume, uint32_t volumeSize, void *serial, void *componentLength, void *flags, void *fileSystem, uint32_t fileSystemSize)",
    "int __stdcall CreateDirectoryW(const char16_t *name, void *security)",
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall WriteFile(void *file, void *bytes, uint32_t size, _Out_ uint32_t *written, void *overlapped)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)",
    "void * __stdcall CreateJobObjectW(void *security, const char16_t *name)",
    "int __stdcall SetInformationJobObject(void *job, int kind, void *information, uint32_t size)",
    "int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)",
    "int __stdcall AssignProcessToJobObject(void *job, void *process)",
    "int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *inside)",
    "int __stdcall TerminateJobObject(void *job, uint32_t code)",
    "int __stdcall TerminateProcess(void *process, uint32_t code)",
    "uint32_t __stdcall ResumeThread(void *thread)",
    "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)",
    "int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *code)",
    "int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ size_t *size)",
    "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t key, void *value, size_t size, void *previous, void *returned)",
    "void __stdcall DeleteProcThreadAttributeList(void *list)",
    "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)",
  ],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall DuplicateTokenEx(void *existing, uint32_t access, void *security, int level, int kind, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *returned)",
    "int __stdcall AccessCheck(void *descriptor, void *token, uint32_t desired, void *mapping, void *privileges, _Inout_ uint32_t *privilegeSize, _Out_ uint32_t *granted, _Out_ int *allowed)",
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)",
    "void * __stdcall FreeSid(void *sid)",
  ],
  userenv: [
    "int32_t __stdcall CreateAppContainerProfile(const char16_t *name, const char16_t *display, const char16_t *description, void *capabilities, uint32_t count, _Out_ void **sid)",
    "int32_t __stdcall DeleteAppContainerProfile(const char16_t *name)",
    "int32_t __stdcall GetAppContainerFolderPath(const char16_t *sidText, _Out_ void **path)",
  ],
  ole32: ["void __stdcall CoTaskMemFree(void *memory)"],
} as const;

const functionName = (prototype: string) => /\b(\w+)\s*\(/.exec(prototype)![1];
export function bindExperimentalWindowsLpacApi(koffi: Pick<typeof Koffi, "sizeof" | "address" | "decode">, load: (name: string) => { func(prototype: string): unknown }): WindowsLpacApi {
  if (koffi.sizeof("void *") !== 8) throw new Error("The LPAC experiment requires a 64-bit Windows process.");
  const fn: Record<string, NativeFunction> = {};
  for (const [library, prototypes] of Object.entries(WINDOWS_LPAC_FUNCTIONS)) {
    const dll = load(`${library}.dll`);
    for (const prototype of prototypes) fn[functionName(prototype)] = dll.func(prototype) as NativeFunction;
  }
  const error = (operation: string) => new Error(`${operation} failed (Windows error ${Number(fn.GetLastError())}).`);
  const handle = (value: unknown, operation: string): WindowsHandle => {
    if (typeof value !== "bigint" || value === 0n || value === INVALID_HANDLE) throw error(operation);
    return value;
  };
  const close = (value: WindowsHandle) => { if (!fn.CloseHandle(value)) throw error("CloseHandle"); };
  const sidText = (sid: WindowsHandle, keepAlive?: Buffer) => {
    const output: unknown[] = [null];
    if (!fn.ConvertSidToStringSidW(sid, output)) throw error("ConvertSidToStringSidW");
    const pointer = handle(output[0], "ConvertSidToStringSidW");
    try { return koffi.decode.string16(pointer); } finally { fn.LocalFree(pointer); keepAlive?.fill(0); }
  };
  const withToken = <T>(process: unknown, action: (token: WindowsHandle) => T, access = TOKEN_QUERY): T => {
    const output: unknown[] = [null];
    if (!fn.OpenProcessToken(process, access, output)) throw error("OpenProcessToken");
    const token = handle(output[0], "OpenProcessToken");
    try { return action(token); } finally { close(token); }
  };
  const tokenInfo = (token: WindowsHandle, kind: number, size: number): Buffer => {
    const bytes = Buffer.alloc(size), returned = [0];
    if (!fn.GetTokenInformation(token, kind, bytes, size, returned) || returned[0] > size) throw error(`GetTokenInformation(${kind})`);
    return bytes;
  };
  const withDescriptor = <T>(sddl: string, action: (descriptor: WindowsHandle) => T): T => {
    const output: unknown[] = [null];
    if (!fn.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, output, null)) throw error("ConvertStringSecurityDescriptorToSecurityDescriptorW");
    const descriptor = handle(output[0], "security descriptor");
    try { return action(descriptor); } finally { fn.LocalFree(descriptor); }
  };
  const withSecurity = <T>(sddl: string, action: (security: Buffer) => T): T => withDescriptor(sddl, descriptor => {
    const security = Buffer.alloc(24); security.writeUInt32LE(24, 0); security.writeBigUInt64LE(descriptor, 8);
    return action(security);
  });
  const accessWitness = (token: WindowsHandle, userSid: string, packageSid: string): void => {
    const output: unknown[] = [null];
    // AccessCheck requires an impersonation token. Its handle has QUERY only; we never impersonate this token.
    if (!fn.DuplicateTokenEx(token, TOKEN_QUERY, null, 2, 2, output)) throw error("DuplicateTokenEx(access witness)");
    const duplicate = handle(output[0], "DuplicateTokenEx");
    try {
      const check = (packageGrant: string) => withDescriptor(`O:SYG:SYD:P(A;;0x1;;;${userSid})(A;;0x1;;;${packageGrant})`, descriptor => {
        const mapping = Buffer.alloc(16);
        for (const [index, value] of [1, 2, 4, 7].entries()) mapping.writeUInt32LE(value, index * 4);
        const privileges = Buffer.alloc(1024), size = [privileges.length], granted = [0], allowed = [0];
        if (!fn.AccessCheck(descriptor, duplicate, 1, mapping, privileges, size, granted, allowed)) throw error("AccessCheck(LPAC witness)");
        return { allowed: allowed[0], granted: granted[0] };
      });
      const ownPackage = check(packageSid), allPackages = check("S-1-15-2-1");
      if (ownPackage.allowed !== 1 || ownPackage.granted !== 1 || allPackages.allowed !== 0 || allPackages.granted !== 0)
        throw new Error("The suspended token did not satisfy the own-package/AAP access witness.");
    } finally { close(duplicate); }
  };
  return {
    createProfile(name) {
      const output: unknown[] = [null];
      const hr = Number(fn.CreateAppContainerProfile(name, name, "Disposable offline Ember fixture", null, 0, output));
      if (hr !== 0) throw new Error(`CreateAppContainerProfile failed (HRESULT ${hr >>> 0}); no profile is adopted.`);
      const sid = handle(output[0], "CreateAppContainerProfile");
      try { return { name, sid, sidText: sidText(sid) }; }
      catch (err) { fn.DeleteAppContainerProfile(name); fn.FreeSid(sid); throw err; }
    },
    deleteProfile(profile) {
      const hr = Number(fn.DeleteAppContainerProfile(profile.name));
      if (hr !== 0) throw new Error(`DeleteAppContainerProfile failed (HRESULT ${hr >>> 0}).`);
      fn.FreeSid(profile.sid);
    },
    ownerSid: () => withToken(fn.GetCurrentProcess(), token => { const info = tokenInfo(token, 1, 4096); return sidText(info.readBigUInt64LE(0), info); }),
    windowsDirectory() {
      const text = Buffer.alloc(32768 * 2), size = Number(fn.GetWindowsDirectoryW(text, 32768));
      if (size < 1 || size >= 32768) throw error("GetWindowsDirectoryW");
      return text.toString("utf16le", 0, size * 2);
    },
    profileLocalAppDataBase(profile) {
      const output: unknown[] = [null];
      const hr = Number(fn.GetAppContainerFolderPath(profile.sidText, output));
      if (hr !== 0) throw new Error(`GetAppContainerFolderPath failed (HRESULT ${hr >>> 0}).`);
      const pointer = handle(output[0], "AppContainer profile path");
      try {
        const folder = koffi.decode.string16(pointer), suffix = `\\Packages\\${profile.name}\\AC`;
        if (!/^[A-Za-z]:\\/.test(folder) || /[\0\r\n]/.test(folder) || !folder.toLowerCase().endsWith(suffix.toLowerCase()))
          throw new Error("The AppContainer profile path does not match this newly created profile.");
        const base = folder.slice(0, -suffix.length);
        if (base.length <= 3) throw new Error("The AppContainer profile has no ordinary local app-data base.");
        // Windows requires this entry to construct the child's redirected profile environment. A path string
        // grants no access: never change ACLs on this base, its ancestors, or the shared Packages directory.
        return base;
      } finally { fn.CoTaskMemFree(pointer); }
    },
    volumeFileSystem(root) {
      if (Number(fn.GetDriveTypeW(root)) !== 3) throw new Error("The fixture requires a local fixed volume.");
      const text = Buffer.alloc(64);
      if (!fn.GetVolumeInformationW(root, null, 0, null, null, null, text, 32)) throw error("GetVolumeInformationW");
      return text.toString("utf16le").split("\0", 1)[0];
    },
    createDirectory(file, sddl) { withSecurity(sddl, security => { if (!fn.CreateDirectoryW(file, security)) throw error("CreateDirectoryW"); }); },
    writeNewFile(file, bytes, sddl) {
      withSecurity(sddl, security => {
        const fileHandle = handle(fn.CreateFileW(file, 0x40000080, 0, security, 1, 0x00200000, null), "CreateFileW(CREATE_NEW)");
        try {
          const information = Buffer.alloc(52);
          if (!fn.GetFileInformationByHandle(fileHandle, information) || (information.readUInt32LE(0) & 0x410) !== 0 || information.readUInt32LE(40) !== 1) throw new Error("The new fixture file is not a single ordinary file.");
          const written = [0];
          if (!fn.WriteFile(fileHandle, bytes, bytes.length, written, null) || written[0] !== bytes.length) throw error("WriteFile");
        } finally { close(fileHandle); }
      });
    },
    pinDirectory(file) {
      const directory = handle(fn.CreateFileW(file, 0x80, 3, null, 3, 0x02200000, null), "CreateFileW(directory)");
      try {
        const information = Buffer.alloc(52);
        if (!fn.GetFileInformationByHandle(directory, information) || !(information.readUInt32LE(0) & 0x10) || (information.readUInt32LE(0) & 0x400)) throw new Error("The fixture directory is not an ordinary directory.");
        return directory;
      } catch (err) { close(directory); throw err; }
    },
    createJob() {
      const job = handle(fn.CreateJobObjectW(null, null), "CreateJobObjectW");
      const limits = Buffer.alloc(144); limits.writeUInt32LE(LPAC_KILL_ON_CLOSE, 16);
      try { if (!fn.SetInformationJobObject(job, 9, limits, limits.length)) throw error("SetInformationJobObject"); return job; }
      catch (err) { close(job); throw err; }
    },
    createSuspended(profile, program, command, cwd, env) {
      const size = [0n];
      const sizing = fn.InitializeProcThreadAttributeList(null, 2, 0, size);
      const sizingError = Number(fn.GetLastError());
      if (sizing || sizingError !== 122) throw new Error("InitializeProcThreadAttributeList did not establish its required size.");
      const length = Number(size[0]);
      if (!Number.isSafeInteger(length) || length < 1 || length > 65536) throw error("InitializeProcThreadAttributeList(size)");
      const attributes = Buffer.alloc(length);
      if (!fn.InitializeProcThreadAttributeList(attributes, 2, 0, size)) throw error("InitializeProcThreadAttributeList");
      const capabilities = Buffer.alloc(24); capabilities.writeBigUInt64LE(profile.sid, 0);
      const policy = Buffer.alloc(4); policy.writeUInt32LE(LPAC_OPT_OUT, 0);
      let created = false, result: WindowsSuspendedProcess | null = null;
      let rawProcess = 0n, rawThread = 0n, failure: unknown, failed = false;
      try {
        for (const [key, value] of [[LPAC_ATTRIBUTES.securityCapabilities, capabilities], [LPAC_ATTRIBUTES.allApplicationPackagesPolicy, policy]] as const) {
          if (!fn.UpdateProcThreadAttribute(attributes, 0, key, value, value.length, null, null)) throw error("UpdateProcThreadAttribute(LPAC)");
        }
        const startup = Buffer.alloc(112); startup.writeUInt32LE(112, 0); startup.writeBigUInt64LE(koffi.address(attributes), 104);
        const information = Buffer.alloc(24);
        // No HANDLE_LIST is supplied because the allow-list is empty. FALSE is mandatory: no parent handle is inherited.
        if (!fn.CreateProcessW(program, command, null, null, 0, LPAC_CREATE_FLAGS, env, cwd, startup, information)) throw error("CreateProcessW(LPAC,suspended)");
        created = true; rawProcess = information.readBigUInt64LE(0); rawThread = information.readBigUInt64LE(8);
        result = { process: handle(rawProcess, "process"), thread: handle(rawThread, "thread"), pid: information.readUInt32LE(16) };
        if (!result.pid) throw new Error("CreateProcessW returned an invalid process identity.");
      } catch (err) { failed = true; failure = err; }
      try { fn.DeleteProcThreadAttributeList(attributes); }
      catch (err) { failed = true; failure ??= err; }
      // Their addresses, not copies, are retained by the attribute list. Keep both buffers rooted until deletion.
      capabilities.fill(0); policy.fill(0);
      if (failed) {
        if (created) {
          try {
            handle(rawProcess, "created process");
            if (!fn.TerminateProcess(rawProcess, 125) && Number(fn.WaitForSingleObject(rawProcess, 0)) !== 0) throw error("TerminateProcess");
            if (Number(fn.WaitForSingleObject(rawProcess, 3000)) !== 0) throw error("WaitForSingleObject(created process)");
            if (rawThread !== 0n && rawThread !== INVALID_HANDLE) close(rawThread);
            close(rawProcess);
          } catch {
            // Never let a PI/FFI anomaly make the fixture owner assume that no suspended process was created.
            throw new ExperimentalWindowsCreateUncertain("A created suspended LPAC process could not be observed terminated; keep its profile and scratch for diagnosis.");
          }
        }
        throw failure;
      }
      return result!;
    },
    assign(job, process) {
      if (!fn.AssignProcessToJobObject(job, process)) throw error("AssignProcessToJobObject");
      const inside = [0];
      if (!fn.IsProcessInJob(process, job, inside) || inside[0] !== 1) throw new Error("The suspended fixture did not join its private job.");
    },
    verifyToken(profile, process) {
      withToken(process, token => {
        const info = tokenInfo(token, 31, 64);
        if (tokenInfo(token, 29, 4).readUInt32LE(0) !== 1 || tokenInfo(token, 30, 4096).readUInt32LE(0) !== 0 ||
            sidText(info.readBigUInt64LE(0), info) !== profile.sidText) throw new Error("The suspended token is not the expected capability-free AppContainer.");
        const user = tokenInfo(token, 1, 4096);
        // Win32 class 46 is rejected on the native CI target. This witnesses the documented AAP exclusion
        // behavior with positive own-package control; it is not a formal token-class identity query.
        accessWitness(token, sidText(user.readBigUInt64LE(0), user), profile.sidText);
      }, TOKEN_QUERY | 0x2);
    },
    resume(thread) { if (Number(fn.ResumeThread(thread)) !== 1) throw error("ResumeThread"); },
    terminateJob(job) { if (!fn.TerminateJobObject(job, 125)) throw error("TerminateJobObject"); },
    terminateProcess(process) { if (!fn.TerminateProcess(process, 125)) throw error("TerminateProcess"); },
    exited(process) {
      const status = Number(fn.WaitForSingleObject(process, 0));
      if (status !== 0 && status !== 258) throw error("WaitForSingleObject");
      return status === 0;
    },
    jobState(job) {
      const accounting = Buffer.alloc(48), pids = Buffer.alloc(8 + 4096 * 8);
      if (!fn.QueryInformationJobObject(job, 1, accounting, accounting.length, null) || !fn.QueryInformationJobObject(job, 3, pids, pids.length, null)) throw error("QueryInformationJobObject");
      const assigned = pids.readUInt32LE(0), listed = pids.readUInt32LE(4);
      if (assigned !== listed || listed > 4096) throw new Error("The job process list is incomplete.");
      return { active: accounting.readUInt32LE(40), listed };
    },
    exitCode(process) { const code = [0]; if (!fn.GetExitCodeProcess(process, code)) throw error("GetExitCodeProcess"); return code[0]; },
    close,
  };
}

/** Lazy and importable on Linux; native evidence must come from the Windows-only fixture suite. */
export function loadExperimentalWindowsLpacApi(): WindowsLpacApi {
  if (HOST_PLATFORM !== "win32") throw new Error("The LPAC experiment requires Windows.");
  const koffi = createRequire(__filename)("koffi") as typeof Koffi;
  return bindExperimentalWindowsLpacApi(koffi, name => koffi.load(name));
}
