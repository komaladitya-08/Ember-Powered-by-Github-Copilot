/** Test-only trusted-host control. This is deliberately outside AppContainer and is never a product fallback. */
import type { WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";

export const WINDOWS_NODE_STARTUP_ARGS: readonly string[] = Object.freeze(["--eval", "process.exitCode = 0"]);
export class WindowsNodeHostCleanupError extends Error {
  constructor() { super("The trusted Node startup control could not verify native cleanup."); this.name = "WindowsNodeHostCleanupError"; }
}
type HostResult = { exitCode: number; jobStopped: true };
/** Shared admission for one prepared diagnostic. Close revokes starts synchronously, before awaiting cleanup. */
export class WindowsNodeStartupGate {
  #closing = false;
  #host?: Promise<HostResult>;
  #launch?: Promise<number>;
  get hostCompletion(): Promise<HostResult> | undefined { return this.#host; }
  retire(): void { this.#closing = true; }
  host(start: () => Promise<HostResult>): Promise<HostResult> {
    if (this.#closing || this.#launch) return Promise.reject(new Error("The trusted-host startup control is no longer admissible."));
    return this.#host ??= Promise.resolve().then(() => {
      if (this.#closing) throw new Error("The Node proof closed before its host control could start.");
      return start();
    });
  }
  launch(start: () => Promise<number>): Promise<number> {
    if (this.#closing) return Promise.reject(new Error("The Node proof is closing; no process may start."));
    return this.#launch ??= (async () => {
      await this.#host;
      if (this.#closing) throw new Error("The Node proof closed before its LPAC launch could start.");
      return start();
    })();
  }
}
export interface WindowsNodeHostNative {
  /** Native CreateProcessW: suspended, Unicode environment, no window, no inherited handles or std-handle fields. */
  create(program: string, command: Buffer, cwd: string, environment: Buffer): WindowsSuspendedProcess;
  /** Exact image/PID on this same suspended handle, plus TokenIsAppContainer == 0. */
  verify(process: WindowsSuspendedProcess, program: string): void;
}
type HostApi = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess" | "exited" | "jobState" | "exitCode" | "close">;

/** No output/report read is supported. Completion requires both root-handle exit and an empty private job. */
export async function runWindowsNodeHostStartup(input: { program: string; command: Buffer; cwd: string; environment: Buffer; unchanged(): void },
  api: HostApi, native: WindowsNodeHostNative): Promise<HostResult> {
  let job: bigint | undefined, process: WindowsSuspendedProcess | undefined;
  let failure: { error: unknown } | undefined, result: { exitCode: number; jobStopped: true } | undefined;
  let stopped = false, uncertain = false;
  const wait = async (timeout: number, withJob: boolean) => {
    const until = performance.now() + timeout;
    for (;;) {
      if (!process || !api.exited(process.process)) { /* Root exit is required even if a job query returns zero. */ }
      else if (!withJob) return;
      else {
        const state = api.jobState(job!);
        if (state.active === 0 && state.listed === 0) return;
      }
      if (performance.now() >= until) throw new Error("The trusted Node startup control did not stop before its deadline.");
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    input.unchanged(); job = api.createJob();
    process = native.create(input.program, Buffer.from(input.command), input.cwd, Buffer.from(input.environment));
    if (!process || typeof process.process !== "bigint" || typeof process.thread !== "bigint" || process.process <= 0n || process.thread <= 0n || process.process === 0xffffffffffffffffn || process.thread === 0xffffffffffffffffn || !Number.isInteger(process.pid) || process.pid <= 0)
      throw new WindowsNodeHostCleanupError();
    api.assign(job, process.process);
    native.verify(process, input.program); input.unchanged();
    api.resume(process.thread);
    await wait(20_000, true); stopped = true;
    const exitCode = api.exitCode(process.process);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffffffff) throw new Error("The trusted Node startup control returned no bounded exit code.");
    result = { exitCode, jobStopped: true };
  } catch (error) { failure = { error }; uncertain = error instanceof WindowsNodeHostCleanupError; }
  finally {
    if (process && !stopped) {
      // An assignment failure still owns a suspended process. The exact root handle must be stopped independently.
      let rootExited = false; try { rootExited = api.exited(process.process); } catch { /* Still terminate the known root handle. */ }
      if (!rootExited) try { api.terminateProcess(process.process); } catch { /* Still attempt the private job and observe both. */ }
      try { if (job !== undefined) api.terminateJob(job); } catch { /* A positive root/job observation is still mandatory. */ }
      try {
        await wait(15_000, job !== undefined); stopped = true;
      } catch { uncertain = true; }
    }
    if (!process && job !== undefined && !uncertain) try {
      const state = api.jobState(job);
      if (state.active !== 0 || state.listed !== 0) uncertain = true;
    } catch { uncertain = true; }
    if (!uncertain && (!process || stopped)) {
      let closeFailed = false;
      for (const handle of [process?.thread, process?.process, job]) if (handle !== undefined) try { api.close(handle); } catch { closeFailed = true; }
      if (closeFailed) uncertain = true;
    }
  }
  if (uncertain) throw new WindowsNodeHostCleanupError();
  if (failure) throw failure.error;
  return result!;
}
