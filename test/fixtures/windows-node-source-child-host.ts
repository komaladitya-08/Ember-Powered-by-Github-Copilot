/** Source-experiment host owner, retaining observed running descendants through positive whole-job Stop. */
import type { WindowsHandle, WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import type { bindWindowsNodeSourceChildObserver } from "./windows-node-source-child-observer";

type Observer = ReturnType<typeof bindWindowsNodeSourceChildObserver>;
type Api = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess" | "exited" | "jobState" | "exitCode" | "close">;
export async function runWindowsNodeSourceChildHost(input: { program: string; command: Buffer; cwd: string; environment: Buffer; unchanged(): void },
  api: Api, native: { create(program: string, command: Buffer, cwd: string, env: Buffer): WindowsSuspendedProcess;
    verify(process: WindowsSuspendedProcess, program: string): void; bind(job: WindowsHandle, process: WindowsSuspendedProcess): void }, observer: Observer) {
  let job: WindowsHandle | undefined, process: WindowsSuspendedProcess | undefined, stopped = false, unsafe = false, admitted = false;
  let failure: unknown, result: { exitCode: number; jobStopped: true; admitted: true } | undefined;
  const wait = async (deadline: number, observe: boolean) => {
    let previous = performance.now();
    for (;;) {
      const now = performance.now();
      if (!Number.isFinite(now) || now < previous || now > deadline) throw new Error("The fixed source child host exceeded its deadline.");
      previous = now;
      if (process && observe && !admitted && !api.exited(process.process)) admitted = observer.admit() !== null;
      if (process && api.exited(process.process) && (job === undefined || api.jobState(job).active === 0 && api.jobState(job).listed === 0)) return;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    input.unchanged(); job = api.createJob();
    process = native.create(input.program, Buffer.from(input.command), input.cwd, Buffer.from(input.environment));
    api.assign(job, process.process); native.verify(process, input.program); input.unchanged();
    native.bind(job, process); api.resume(process.thread);
    await wait(performance.now() + 20_000, true);
    observer.waitStoppedBefore(performance.now() + 15_000); stopped = true;
    const exitCode = api.exitCode(process.process);
    if (!admitted || exitCode !== 0) throw new Error("The fixed source child host supplied no successful observed child.");
    result = { exitCode, jobStopped: true, admitted: true };
  } catch (error) { failure = error; unsafe = error instanceof WindowsNodeHostCleanupError; }
  finally {
    if (process && !stopped) {
      const deadline = performance.now() + 15_000;
      try { api.terminateProcess(process.process); } catch { /* Positive observations below remain mandatory. */ }
      try { if (job !== undefined) api.terminateJob(job); } catch { /* Still observe every retained owner. */ }
      try { await wait(deadline, false); observer.waitStoppedBefore(deadline); stopped = true; } catch { unsafe = true; }
    }
    if (!process && job !== undefined) try { const state = api.jobState(job); if (state.active !== 0 || state.listed !== 0) unsafe = true; } catch { unsafe = true; }
    if (!unsafe) {
      try { observer.closeStopped(); } catch { unsafe = true; }
      if (!unsafe) for (const handle of [process?.thread, process?.process, job]) if (handle !== undefined) {
        try { api.close(handle); } catch { unsafe = true; break; }
      }
    }
  }
  if (unsafe) throw new WindowsNodeHostCleanupError();
  if (failure) throw new Error("The fixed source child host failed its closed native contract.");
  if (!result) throw new Error("The fixed source child host returned no stopped result.");
  return result;
}
