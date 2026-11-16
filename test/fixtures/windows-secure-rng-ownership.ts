/** Terminal guard for legacy native acquisition seams in this independent prerequisite. */
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
export class WindowsSecureRngOwnershipError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsSecureRngOwnershipError"; this.message = "Secure RNG prerequisite ownership is unverified; retain every owner."; }
}
export class WindowsSecureRngOwnership {
  #unsafe = false;
  get unsafe(): boolean { return this.#unsafe; }
  guard<T>(operation: () => T): T {
    if (this.#unsafe) throw new WindowsSecureRngOwnershipError();
    try { return operation(); }
    catch { this.#unsafe = true; throw new WindowsSecureRngOwnershipError(); }
  }
}

/** The host startup helper already supplies natural-exit and job-zero witnesses; nonzero still forbids decoding. */
export function readWindowsSecureRngSuccessfulExit<T>(exitCode: number, read: () => T): T {
  if (exitCode !== 0) throw new Error("The secure RNG root did not exit successfully before report decoding.");
  return read();
}

/** Child-internal uncertainty never reaches report decoding, even if a later Stop succeeds. */
export async function readWindowsSecureRngAfterStopped<T>(input: {
  waitRootExited(): Promise<unknown>;
  waitStopped(): Promise<{ requireStopped(): void }>;
  exitCode(): number;
  read(): T;
}): Promise<{ exitCode: number; report: T }> {
  await input.waitRootExited();
  const lease = await input.waitStopped(); lease.requireStopped();
  const exitCode = input.exitCode();
  return { exitCode, report: readWindowsSecureRngSuccessfulExit(exitCode, () => input.read()) };
}
