/** Independent fixed-spawn host owner; missing natural completion permanently revokes disposal. */
import type { WindowsHandle, WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import type { bindWindowsNodeSourceChildObserver } from "./windows-node-source-child-observer";
import { WindowsUvSpawnCleanupError } from "./windows-uv-spawn-ownership";

type Observer = ReturnType<typeof bindWindowsNodeSourceChildObserver>;
type Api = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess" | "exited" | "jobState" | "exitCode" | "close">;
export interface WindowsUvSpawnHostFence { unsafe: boolean; retained: unknown[] }
const defaultFence: WindowsUvSpawnHostFence = { unsafe: false, retained: [] };

/** A closed synchronous spawn refusal may be read; the caller separately requires a useful host control. */
export async function runWindowsUvSpawnHost(input: { program: string; command: Buffer; cwd: string; environment: Buffer; unchanged(): void },
  api: Api, native: {
    create(program: string, command: Buffer, cwd: string, environment: Buffer): WindowsSuspendedProcess;
    verify(process: WindowsSuspendedProcess, program: string): void;
    bind(job: WindowsHandle, process: WindowsSuspendedProcess): void;
  }, observer: Observer, fence: WindowsUvSpawnHostFence = defaultFence): Promise<{ exitCode: 0; jobStopped: true; admitted: boolean }> {
  if (fence.unsafe) throw new WindowsUvSpawnCleanupError();
  let job: WindowsHandle | undefined, process: WindowsSuspendedProcess | undefined, natural = false, admitted = false;
  const valid = (handle: unknown): handle is WindowsHandle => typeof handle === "bigint" && handle > 0n && handle < 0x8000000000000000n;
  const wait = async (deadline: number, observe: boolean) => {
    let previous = performance.now();
    for (;;) {
      const now = performance.now(); if (!Number.isFinite(now) || now < previous || now > deadline) throw new Error(); previous = now;
      if (process) {
        const exited = api.exited(process.process);
        if (!exited && observe && !admitted) admitted = observer.admit() !== null;
        if (exited && job !== undefined) { const state = api.jobState(job); if (state.active === 0 && state.listed === 0) return; }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    input.unchanged(); job = api.createJob(); if (!valid(job)) throw new Error();
    process = native.create(input.program, Buffer.from(input.command), input.cwd, Buffer.from(input.environment));
    if (!process || !valid(process.process) || !valid(process.thread) || process.process === process.thread || process.process === job || process.thread === job ||
      !Number.isInteger(process.pid) || process.pid < 1 || process.pid > 0xffffffff) throw new Error();
    api.assign(job, process.process); native.verify(process, input.program); input.unchanged(); native.bind(job, process); api.resume(process.thread);
    await wait(performance.now() + 20_000, true); observer.waitStoppedBefore(performance.now() + 15_000);
    if (api.exitCode(process.process) !== 0) throw new Error();
    natural = true;
  } catch { fence.unsafe = true; }
  if (!natural || fence.unsafe) {
    // A successful later Stop proves containment, not the C root's unknown natural-completion contract.
    const deadline = performance.now() + 15_000;
    try { if (process) api.terminateProcess(process.process); } catch { /* Continue the non-disposing job Stop. */ }
    try { if (job !== undefined) api.terminateJob(job); } catch { /* Preserve every owner. */ }
    try { if (process) { await wait(deadline, false); observer.waitStoppedBefore(deadline); } } catch { /* Never regain release authority. */ }
    fence.unsafe = true; fence.retained.push({ job, process, input, api, native, observer });
    throw new WindowsUvSpawnCleanupError();
  }
  try {
    observer.closeStopped();
    for (const handle of [process!.thread, process!.process, job!]) api.close(handle);
  } catch {
    fence.unsafe = true; fence.retained.push({ job, process, input, api, native, observer });
    throw new WindowsUvSpawnCleanupError();
  }
  return { exitCode: 0, jobStopped: true, admitted };
}
