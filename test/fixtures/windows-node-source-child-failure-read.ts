/** Diagnostic only: a fixed frame never supplies success, admission, Stop or cleanup authority. */
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { parseWindowsNodeSourceChildFailure, windowsNodeSourceChildFailureFileName, WINDOWS_NODE_SOURCE_CHILD_FAILURE_BYTES } from "./windows-node-source-child-failure";
import type { WindowsSourceNodeChildMode } from "./windows-node-source-child-report";
export class WindowsNodeSourceChildFailureReadCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsNodeSourceChildFailureReadCleanupError"; this.message = "The fixed child failure read lacks its stopped-owner proof; retain all owners."; }
}
/** Caller pins the literal path with writer/delete exclusion before returning bounded ordinary-file bytes.
 * Only the caller's positively identified ENOENT may return null. Content refusal is not ownership uncertainty. */
export function readStoppedWindowsNodeSourceChildFailure(input: {
  role: 0 | 1; mode: WindowsSourceNodeChildMode;
  requireStopped(): unknown;
  readFrame(basename: string, maximum: number): Buffer | null;
}): ReturnType<typeof parseWindowsNodeSourceChildFailure> | null {
  const stopped = () => {
    try { if (input.requireStopped() !== undefined) throw new WindowsNodeSourceChildFailureReadCleanupError(); }
    catch (error) { if (error instanceof WindowsNodeHostCleanupError) throw error; throw new WindowsNodeSourceChildFailureReadCleanupError(); }
  };
  stopped();
  let bytes: Buffer | null;
  try { bytes = input.readFrame(windowsNodeSourceChildFailureFileName(input.role, input.mode), WINDOWS_NODE_SOURCE_CHILD_FAILURE_BYTES); }
  catch (error) { if (error instanceof WindowsNodeHostCleanupError) throw error; return null; }
  try {
    stopped();
    if (bytes === null) return null;
    try { return parseWindowsNodeSourceChildFailure(bytes, input.role, input.mode); }
    catch { return null; }
  } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}
