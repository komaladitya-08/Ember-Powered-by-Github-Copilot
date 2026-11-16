/** One fixed-options trusted-host PowerShell capture. Public diagnostics contain only closed process facts; stdout stays private. */
import { spawnSync } from "node:child_process";

const captures = new WeakMap();
const unknown = Object.freeze({ schema: 1, outcome: 0, status: null, signal: 255, errorPresence: 2, errorCode: 0 });
const signals = new Map(["SIGTERM", "SIGKILL", "SIGINT", "SIGBREAK", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGILL", "SIGFPE", "SIGQUIT", "SIGPIPE", "SIGALRM", "SIGTRAP", "SIGBUS"].map((name, index) => [name, index + 1]));
const codes = new Map(["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS", "E2BIG", "ENOMEM", "EINVAL", "EPERM", "ENOEXEC", "EIO", "EMFILE", "ENFILE", "ENOTDIR", "EISDIR", "EBADF", "ENOTSUP"].map((name, index) => [name, index + 1]));
const object = value => value !== null && (typeof value === "object" || typeof value === "function");

function ownData(value, key, optional = false) {
  if (!object(value)) return { valid: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { valid: optional, present: false };
  if (!Object.hasOwn(descriptor, "value")) return { valid: false };
  return { valid: true, present: true, value: descriptor.value };
}

function inspect(result) {
  try {
    const status = ownData(result, "status"), signal = ownData(result, "signal"), error = ownData(result, "error", true);
    if (!status.valid || !signal.valid || !error.valid || status.value !== null && (!Number.isInteger(status.value) || status.value < 0 || status.value > 0xffffffff)) return { diagnostic: unknown };
    const signalId = signal.value === null ? 0 : typeof signal.value === "string" ? signals.get(signal.value) : undefined;
    if (signalId === undefined) return { diagnostic: unknown };
    const errorPresence = error.present && error.value !== undefined ? 1 : 0;
    let errorCode = 0;
    if (errorPresence && object(error.value)) {
      const code = ownData(error.value, "code", true);
      if (!code.valid) return { diagnostic: unknown };
      if (code.present && typeof code.value === "string") errorCode = codes.get(code.value) ?? 0;
    }
    const outcome = errorPresence ? 4 : signalId !== 0 ? 3 : status.value !== null && status.value !== 0 ? 2 : status.value === 0 ? 1 : 0;
    if (outcome === 0) return { diagnostic: unknown };
    const diagnostic = Object.freeze({ schema: 1, outcome, status: status.value, signal: signalId, errorPresence, errorCode });
    if (outcome !== 1) return { diagnostic };
    const stdout = ownData(result, "stdout");
    if (!stdout.valid || typeof stdout.value !== "string") return { diagnostic: unknown };
    return { diagnostic, stdout: stdout.value };
  } catch { return { diagnostic: unknown }; }
}

/** Pure own-data classification for fault tests. This projection is not a branded process-capture token. */
export function classifyOwnedPowerShellResult(result) { return inspect(result).diagnostic; }

/** Exactly one process attempt with the original capture options; no retry, fallback, preflight or caller option override. */
export function captureWindowsUvSpawnPowerShell(program, args, env, cwd) {
  let observed;
  try {
    observed = inspect(spawnSync(program, args, { env, cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    if (observed.diagnostic.outcome === 1) observed = { diagnostic: observed.diagnostic, stdout: observed.stdout.trim() };
  } catch { observed = { diagnostic: unknown }; }
  const token = Object.freeze({}); captures.set(token, Object.freeze(observed)); return token;
}

/** Only this module's opaque capture tokens can supply facts; foreign values are never inspected. */
export function powerShellProcessDiagnostic(token) { return object(token) ? captures.get(token)?.diagnostic ?? unknown : unknown; }

/** Raw success stdout is available solely through the private capture record for the unchanged builder JSON path. */
export function acceptedPowerShellStdout(token) {
  const captured = object(token) ? captures.get(token) : undefined;
  if (captured?.diagnostic.outcome !== 1 || typeof captured.stdout !== "string") throw new Error("The fixed PowerShell capture was refused.");
  return captured.stdout;
}
