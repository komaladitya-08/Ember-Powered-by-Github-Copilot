/**
 * Windows job objects for commands (§3.3, §3.13; package RUN): the koffi bindings Ember's job host uses to put itself,
 * and so every process a command starts, into a job whose last closed handle ends the whole tree
 * (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE), and the job host's argv. koffi is required lazily inside loadJobApi() and only
 * on Windows, so this module imports cleanly everywhere: the remote agent bundles the runner, and a macOS remote ships
 * no koffi. Bound once per process. Win32 BOOL is `int`; the limit structure goes in a Buffer passed as `void *`.
 */

import { createRequire } from "node:module";
import type { JobHostRef } from "../types";

/** The exit code of a job host that couldn't make or join its job, or start the program: the run failed to start. */
export const JOB_FAILED = 125;

/** What the job host writes first on stderr when it exits with JOB_FAILED. */
export const JOB_FAILED_PREFIX = "job:";

/**
 * The job host's argv (§3.3): Ember's own binary run as plain Node (ELECTRON_RUN_AS_NODE=1) on job-host.cjs, then
 * `--interactive` (its stdin relayed to the program) or `--batch`, `--`, the program and its arguments. Never the
 * command text: that travels in the environment.
 */
export function jobHostArgv(ref: JobHostRef, program: string, args: string[], interactive: boolean): string[] {
  return [ref.execPath, ref.script, interactive ? "--interactive" : "--batch", "--", program, ...args];
}

/** The Win32 functions bound, in koffi's prototype syntax. */
export const JOB_FUNCTIONS: readonly string[] = [
  "void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)",
  "int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32_t size)",
  "int __stdcall AssignProcessToJobObject(void *job, void *process)",
  "void * __stdcall GetCurrentProcess()",
  "int __stdcall TerminateJobObject(void *job, uint32_t exitCode)",
  "uint32_t __stdcall GetLastError()",
];

/** JobObjectExtendedLimitInformation (JOBOBJECTINFOCLASS). */
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
/** JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags: every process in the job ends when its last handle closes. */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on 64-bit Windows. */
export const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
/** offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation.LimitFlags) on 64-bit Windows. */
const LIMIT_FLAGS_OFFSET = 16;

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only KILL_ON_JOB_CLOSE set (no breakaway: children stay in the job). */
export function killOnCloseInfo(): Buffer {
  const info = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_SIZE);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  return info;
}

/** A job object's handle (koffi's pointer; opaque). */
export type JobHandle = unknown;

/** The calls the job host makes. */
export interface JobApi {
  /** CreateJobObjectW, then SetInformationJobObject with KILL_ON_JOB_CLOSE. Throws when either fails. */
  createKillOnCloseJob(): JobHandle;
  /** AssignProcessToJobObject(job, GetCurrentProcess()): the job host joins its own job. Throws when it fails. */
  assignSelf(job: JobHandle): void;
  /** TerminateJobObject: every process in the job ends (the caller too, when it is in it). False when it failed. */
  terminate(job: JobHandle, exitCode: number): boolean;
}

/** A koffi function as bound (results are untyped). */
type Fn = (...args: unknown[]) => unknown;
/** The part of koffi bindJobApi needs. */
export interface KoffiLike {
  sizeof(type: string): number;
}

/** Binds the job calls from `load`'s kernel32 (fakes in the tests; loadJobApi() for the real thing). */
export function bindJobApi(koffi: KoffiLike, load: (library: string) => { func(declaration: string): unknown }): JobApi {
  if (koffi.sizeof("void *") !== 8) throw new Error("the job host needs a 64-bit process");
  const lib = load("kernel32.dll");
  const [create, setInfo, assign, current, terminate, lastError] = JOB_FUNCTIONS.map(d => lib.func(d) as Fn);
  const why = (call: string) => {
    let code = 0;
    try {
      code = Number(lastError());
    } catch {
      // the error number is only for the message
    }
    return new Error(`${call} failed (error ${code})`);
  };
  return {
    createKillOnCloseJob() {
      const job = create(null, null);
      if (!job) throw why("CreateJobObjectW");
      if (!setInfo(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, killOnCloseInfo(), EXTENDED_LIMIT_INFORMATION_SIZE)) throw why("SetInformationJobObject");
      return job;
    },
    assignSelf(job) {
      if (!assign(job, current())) throw why("AssignProcessToJobObject");
    },
    terminate(job, exitCode) {
      return Boolean(terminate(job, exitCode >>> 0));
    },
  };
}

/** The bound API, once per process (undefined: not tried; null: not available). */
let loaded: JobApi | null | undefined;
/** Why the last loadJobApi() gave null. */
export let jobApiError: unknown = null;

/** The job calls, or null off Windows or when koffi or kernel32 can't be loaded. koffi is required here, lazily. */
export function loadJobApi(): JobApi | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "win32") {
    jobApiError = new Error("not Windows");
    return null;
  }
  try {
    const koffi = createRequire(__filename)("koffi") as typeof import("koffi");
    loaded = bindJobApi(koffi, name => koffi.load(name));
  } catch (err) {
    jobApiError = err;
  }
  return loaded;
}
