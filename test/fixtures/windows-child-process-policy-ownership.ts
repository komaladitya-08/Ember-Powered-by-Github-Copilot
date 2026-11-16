/** Terminal guard for legacy native acquisition seams in this independent prerequisite. */
import path from "node:path";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { preserveWindowsChildPolicyFailure } from "./windows-child-process-policy-diagnostic";
export class WindowsChildProcessPolicyOwnershipError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsChildProcessPolicyOwnershipError"; this.message = "Child-process policy prerequisite ownership is unverified; retain every owner."; }
}
export class WindowsChildProcessPolicyOwnership {
  #unsafe = false;
  readonly #retained: unknown[] = [];
  #firstFailure: unknown;
  get retained(): readonly unknown[] { return this.#retained.slice(); }
  get unsafe(): boolean { return this.#unsafe; }
  guard<T>(operation: () => T): T {
    if (this.#unsafe) throw new WindowsChildProcessPolicyOwnershipError();
    try {
      const value = operation();
      if (this.#unsafe) { this.#retained.push(value); throw preserveWindowsChildPolicyFailure(this.#firstFailure, new WindowsChildProcessPolicyOwnershipError()); }
      return value;
    }
    catch (error) { this.#unsafe = true; this.#firstFailure ??= error; throw preserveWindowsChildPolicyFailure(this.#firstFailure, new WindowsChildProcessPolicyOwnershipError()); }
  }
}

/** The host startup helper already supplies natural-exit and job-zero witnesses; nonzero still forbids decoding. */
export function readWindowsChildProcessPolicySuccessfulExit<T>(exitCode: number, read: () => T): T {
  if (exitCode !== 0) throw new Error("The child-process policy root did not exit successfully before report decoding.");
  return read();
}

/** Child-internal uncertainty never reaches report decoding, even if a later Stop succeeds. */
export async function readWindowsChildProcessPolicyAfterStopped<T>(input: {
  waitRootExited(): Promise<unknown>;
  waitStopped(): Promise<{ requireStopped(): void }>;
  exitCode(): number;
  read(): T;
}): Promise<{ exitCode: number; report: T }> {
  try {
    await input.waitRootExited();
    const lease = await input.waitStopped(); lease.requireStopped();
    const exitCode = input.exitCode();
    return { exitCode, report: readWindowsChildProcessPolicySuccessfulExit(exitCode, () => input.read()) };
  } catch (error) { throw preserveWindowsChildPolicyFailure(error, new WindowsChildProcessPolicyOwnershipError()); }
}

/** Hosted native scratch must survive the integration runner's unconditional managed-temp cleanup. */
export function windowsChildPolicyScratchLocation(runnerTemp: string | undefined, managedTemp: string, candidate: string): string {
  const local = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z]:\\/.test(value) &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && !value.includes("/") && path.win32.normalize(value) === value;
  if (!local(runnerTemp) || !local(managedTemp) || !local(candidate)) throw new Error("The native policy witness requires canonical hosted RUNNER_TEMP without fallback.");
  const child = (parent: string, value: string) => { const relative = path.win32.relative(parent, value); return relative === "" || !relative.startsWith("..\\") && relative !== ".." && !path.win32.isAbsolute(relative); };
  if (!child(runnerTemp, candidate) || candidate.toLowerCase() === runnerTemp.toLowerCase() ||
      child(managedTemp, candidate) || child(candidate, managedTemp)) throw new Error("Native policy scratch must be outside managed integration cleanup.");
  return candidate;
}
