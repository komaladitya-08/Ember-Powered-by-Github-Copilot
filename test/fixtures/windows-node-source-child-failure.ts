/** Fixed-literal first-failure observations only; no raw streams, paths, error objects or success authority. */
import type { WindowsSourceNodeChildMode } from "./windows-node-source-child-report";

export const WINDOWS_NODE_SOURCE_CHILD_FAILURE_BYTES = 48;
/** Fixed operations: setup, synchronous spawn, child error, stdin/stdout/stderr errors, grant,
 * lifecycle predicate, output predicate, entered test fixture and completion/report write. */
export const WINDOWS_NODE_SOURCE_CHILD_FAILURE_OPERATIONS = Object.freeze([
  "unknown", "setup", "spawn-call", "child-error", "stdin-error", "stdout-error", "stderr-error",
  "grant", "lifecycle", "output", "test-fixture", "completion",
] as const);
/** Labels from pinned Node22.23.5 deps/uv/include/uv.h UV_ERRNO_MAP (60553651579ec33ca1aef9e1eedab2c3855f1f7e).
 * doc/api/errors.md documents code as a string and errno as a libuv-normalised negative number on Windows.
 * Observed signed32 errno is retained independently; no code/errno correlation is inferred. */
export const WINDOWS_NODE_SOURCE_CHILD_FAILURE_CODES = Object.freeze([
  "unknown", "EACCES", "EPERM", "ENOENT", "EINVAL", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM",
  "EIO", "ENOSYS", "ENOTSUP", "UNKNOWN", "EPIPE", "ENOBUFS", "ECANCELED", "ETIMEDOUT",
] as const);
const valid = (role: unknown, mode: unknown) => (role === 0 || role === 1) && (mode === "spawn" || mode === "test");
/** A literal basename beneath this role's existing private state; no caller-supplied path is accepted. */
export function windowsNodeSourceChildFailureFileName(role: 0 | 1, mode: WindowsSourceNodeChildMode): string {
  if (!valid(role, mode)) throw new Error("Select one fixed source child failure role and mode.");
  return `${role ? "lpac" : "host"}-source-child-${mode === "spawn" ? 1 : 2}-failure.bin`;
}
/** Decode only after the native owner proves natural exit, job zero and writer exclusion; publish after cleanup.
 * A missing frame, including default node --test failure before fixture entry, remains unknown. */
export function parseWindowsNodeSourceChildFailure(bytes: Buffer, role: 0 | 1, mode: WindowsSourceNodeChildMode) {
  const fail = () => new Error("The fixed source child failure frame is malformed.");
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_NODE_SOURCE_CHILD_FAILURE_BYTES || !valid(role, mode)) throw fail();
  const words = Array.from({ length: 12 }, (_, index) => bytes.readUInt32LE(index * 4));
  if (words[0] !== 0x46434e45 || words[1] !== 1 || words[2] !== role || words[3] !== (mode === "spawn" ? 1 : 2) ||
      words[4] < 1 || words[4] > 11 || words[5] > 16 || words[6] > 1 || words[6] === 0 && words[7] !== 0 ||
      mode === "spawn" && words[4] === 10 || mode === "test" && words[4] !== 1 && words[4] !== 10 ||
      words[8] !== 22023005 || words[9] !== 0 || words[10] !== 0 || words[11] !== 0) throw fail();
  return Object.freeze({ schema: 1 as const, role, mode, operation: words[4], code: words[5],
    ...(words[6] ? { errno: bytes.readInt32LE(28) } : {}) });
}
