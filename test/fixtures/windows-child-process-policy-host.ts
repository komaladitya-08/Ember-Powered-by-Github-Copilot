/** Private witness host owner: missing natural completion never becomes disposal authority after Stop. */
import type { WindowsLpacApi, WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { WindowsNodeHostCleanupError, type WindowsNodeHostNative } from "./windows-node-lpac-startup";
import { brandWindowsChildPolicyFailure, preserveWindowsChildPolicyFailure } from "./windows-child-process-policy-diagnostic";
type HostApi = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess" | "exited" | "jobState" | "exitCode" | "close">;
export interface WindowsChildPolicyHostFence { unsafe: boolean; retained: unknown[] }
const defaultFence: WindowsChildPolicyHostFence = { unsafe: false, retained: [] };
export async function runWindowsChildPolicyHost(input: { program: string; command: Buffer; cwd: string; environment: Buffer; unchanged(): void },
  api: HostApi, native: WindowsNodeHostNative, fence: WindowsChildPolicyHostFence = defaultFence): Promise<{ exitCode: 0; jobStopped: true }> {
  if (fence.unsafe) throw new WindowsNodeHostCleanupError();
  let job: bigint | undefined, process: WindowsSuspendedProcess | undefined, natural = false;
  let operation = 0, firstFailure: unknown;
  const mark = (error: unknown) => { firstFailure ??= brandWindowsChildPolicyFailure(error, { phase: 2, operation, predicate: 10 }); };
  const terminalError = () => preserveWindowsChildPolicyFailure(firstFailure, new WindowsNodeHostCleanupError());
  const wait = async (milliseconds: number) => {
    const until = performance.now() + milliseconds; let previous = performance.now();
    for (;;) {
      const now = performance.now(); if (!Number.isFinite(now) || now < previous || now > until) throw new Error(); previous = now;
      if (process && api.exited(process.process)) {
        if (job === undefined) return;
        const state = api.jobState(job); if (state.active === 0 && state.listed === 0) return;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    operation = 10; input.unchanged(); operation = 6; job = api.createJob();
    if (typeof job !== "bigint" || job <= 0n || job >= 0x8000000000000000n) throw new Error();
    operation = 7; process = native.create(input.program, Buffer.from(input.command), input.cwd, Buffer.from(input.environment));
    if (!process || typeof process.process !== "bigint" || typeof process.thread !== "bigint" || process.process <= 0n || process.thread <= 0n ||
        process.process >= 0x8000000000000000n || process.thread >= 0x8000000000000000n || process.process === process.thread || process.process === job || process.thread === job || !Number.isInteger(process.pid) || process.pid <= 0 || process.pid > 0xffffffff) throw new Error();
    operation = 8; api.assign(job, process.process); operation = 9; native.verify(process, input.program);
    operation = 10; input.unchanged(); operation = 11; api.resume(process.thread);
    operation = 12; await wait(20_000); operation = 13;
    if (api.exitCode(process.process) !== 0) throw new Error();
    natural = true;
  } catch (error) { mark(error); fence.unsafe = true; }
  if (!natural || fence.unsafe) {
    // Stop is non-disposing. Even a successful later Stop cannot certify the C child's unknown owned state.
    if (process) {
      try { api.terminateProcess(process.process); } catch { /* Still stop the owned job. */ }
      try { if (job !== undefined) api.terminateJob(job); } catch { /* Never restore release authority. */ }
      try { await wait(15_000); } catch { /* Retain all known owners. */ }
    }
    fence.unsafe = true; fence.retained.push({ job, process, input, api, native });
    throw terminalError();
  }
  for (const handle of [process!.thread, process!.process, job!]) {
    operation = 14;
    try { api.close(handle); }
    catch (error) { mark(error); fence.unsafe = true; fence.retained.push({ job, process, input, api, native }); throw terminalError(); }
  }
  return { exitCode: 0, jobStopped: true };
}
