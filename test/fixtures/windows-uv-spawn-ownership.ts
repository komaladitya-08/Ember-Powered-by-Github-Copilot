/** Independent fixed-spawn ownership: a later Stop never restores missing natural-completion authority. */
import path from "node:path";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";

export class WindowsUvSpawnCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsUvSpawnCleanupError"; this.message = "Fixed uv-spawn ownership is unverified; retain every private owner."; }
}

/** Retain a returned acquisition when a nested failure was swallowed by a native callback. */
export class WindowsUvSpawnOwnership {
  #unsafe = false;
  readonly #retained: unknown[] = [];
  get unsafe(): boolean { return this.#unsafe; }
  get retained(): readonly unknown[] { return this.#retained.slice(); }
  guard<T>(operation: () => T): T {
    if (this.#unsafe) throw new WindowsUvSpawnCleanupError();
    try {
      const value = operation();
      if (this.#unsafe) { this.#retained.push(value); throw new WindowsUvSpawnCleanupError(); }
      return value;
    } catch { this.#unsafe = true; throw new WindowsUvSpawnCleanupError(); }
  }
}

/** Fixed reports require natural root completion and held-job/child Stop before their first read. */
export async function readWindowsUvSpawnAfterStopped<T>(input: {
  waitRootExited(): Promise<unknown>;
  waitStopped(): Promise<{ requireStopped(): void }>;
  requireChildStopped(): void;
  exitCode(): number;
  read(): T;
}): Promise<{ exitCode: 0; report: T }> {
  try {
    await input.waitRootExited();
    const lease = await input.waitStopped(); lease.requireStopped(); input.requireChildStopped();
    const exitCode = input.exitCode();
    if (exitCode !== 0) throw new Error();
  } catch { throw new WindowsUvSpawnCleanupError(); }
  // Malformed content does not revoke already proven native cleanup authority.
  return { exitCode: 0, report: input.read() };
}

/** Retained hosted scratch must be disjoint from the integration runner's managed-temp deletion. */
export function windowsUvSpawnScratchLocation(runnerTemp: string | undefined, managedTemp: string, candidate: string): string {
  const local = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z]:\\/.test(value) &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && !value.includes("/") && path.win32.normalize(value) === value;
  if (!local(runnerTemp) || !local(managedTemp) || !local(candidate)) throw new Error("The fixed spawn witness requires canonical hosted RUNNER_TEMP without fallback.");
  const contains = (parent: string, value: string) => { const relative = path.win32.relative(parent, value); return relative === "" || relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative); };
  if (!contains(runnerTemp, candidate) || candidate.toLowerCase() === runnerTemp.toLowerCase() || contains(managedTemp, candidate) || contains(candidate, managedTemp))
    throw new Error("Fixed spawn scratch must be outside managed integration cleanup.");
  return candidate;
}
