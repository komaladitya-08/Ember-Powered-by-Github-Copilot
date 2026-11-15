/**
 * Trusted host helper for the Linux Bubblewrap experiment only. Tests bundle this entry into a private .cjs file;
 * it is not a packaged product launcher. The host supplies its launch spec once in argv, never through runtime RPC.
 * No credential belongs in the spec. The child receives only fixed non-secret environment values and explicit fds.
 */
import fs from "node:fs";
import path from "node:path/posix";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { HOST_PLATFORM } from "../platform/os";
import {
  CodingRpcFrameGuard, CodingRpcFramingError, codingRpcFramingLimits, type CodingRpcFramingLimits,
} from "./coding-rpc-framing";

export const EXPERIMENTAL_CODING_RPC_PROXY_FLAG = "--ember-coding-rpc-proxy";
export interface ExperimentalCodingRpcProxySpec {
  version: 1;
  /** Host-built Bubblewrap vector ending in -- /runtime/copilot-runtime; SDK flags are validated separately. */
  bwrapArgs: readonly string[];
  filterPath: string;
  receiptPath: string;
  limits: CodingRpcFramingLimits;
}

function validateSpec(input: ExperimentalCodingRpcProxySpec): ExperimentalCodingRpcProxySpec {
  try {
    if (!input || input.version !== 1 || Object.keys(input).some(field => !["version", "bwrapArgs", "filterPath", "receiptPath", "limits"].includes(field)) ||
        !Array.isArray(input.bwrapArgs) || input.bwrapArgs.length > 512 || input.bwrapArgs.length < 10 ||
        input.bwrapArgs.some(value => typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 4096) ||
        input.bwrapArgs.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 32 * 1024 ||
        input.bwrapArgs.slice(0, 4).join("\0") !== "--seccomp\u00003\u0000--info-fd\u00004" ||
        input.bwrapArgs.at(-2) !== "--" || input.bwrapArgs.at(-1) !== "/runtime/copilot-runtime" ||
        ["--unshare-user", "--unshare-pid", "--new-session", "--die-with-parent", "--clearenv"].some(flag => !input.bwrapArgs.includes(flag)) ||
        [input.filterPath, input.receiptPath].some(value => typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value) > 4096) ||
        input.filterPath === input.receiptPath) throw new Error();
    return Object.freeze({ version: 1, bwrapArgs: Object.freeze([...input.bwrapArgs]), filterPath: input.filterPath,
      receiptPath: input.receiptPath, limits: codingRpcFramingLimits(input.limits) });
  } catch { throw new CodingRpcFramingError("limits"); }
}

/** Host-created non-secret argv data only; this is not a request/session authority accepted from the runtime. */
export function encodeExperimentalCodingRpcProxySpec(input: ExperimentalCodingRpcProxySpec): string {
  const encoded = Buffer.from(JSON.stringify(validateSpec(input))).toString("base64url");
  if (encoded.length > 64 * 1024) throw new CodingRpcFramingError("limits");
  return encoded;
}

function decodeSpec(encoded: string): ExperimentalCodingRpcProxySpec {
  try {
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,65536}$/.test(encoded)) throw new Error();
    return validateSpec(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ExperimentalCodingRpcProxySpec);
  } catch { throw new CodingRpcFramingError("limits"); }
}

/** Only the fixed flags SDK 1.0.21 appends for an empty, tokenless stdio runtime are admitted. */
export function codingRpcProxyRuntimeArgs(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) throw new CodingRpcFramingError("limits");
  let index = 0;
  if (args[index++] !== "--headless" || args[index++] !== "--no-auto-update") throw new CodingRpcFramingError("limits");
  if (args[index] === "--log-level") {
    index++;
    if (!["none", "error", "warning", "info", "debug", "all"].includes(args[index++])) throw new CodingRpcFramingError("limits");
  }
  if (args[index++] !== "--stdio" || args[index++] !== "--no-auto-login" || index !== args.length) throw new CodingRpcFramingError("limits");
  return Object.freeze([...args]);
}

function privateFd(file: string, writable: boolean): number {
  const fd = fs.openSync(file, (writable ? fs.constants.O_WRONLY : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
        stat.size > (writable ? 4096 : 64 * 1024)) throw new CodingRpcFramingError("limits");
    if (writable) fs.ftruncateSync(fd, 0);
    return fd;
  } catch { fs.closeSync(fd); throw new CodingRpcFramingError("limits"); }
}

/** Runs only inside the separately spawned trusted helper; never call this in Ember's main process. */
export async function runExperimentalCodingRpcProxy(argv: readonly string[]): Promise<number> {
  if (HOST_PLATFORM !== "linux") throw new CodingRpcFramingError("limits");
  const spec = decodeSpec(argv[0]);
  const runtimeArgs = codingRpcProxyRuntimeArgs(argv.slice(1));
  const wrapper = fs.lstatSync("/usr/bin/bwrap");
  if (!wrapper.isFile() || wrapper.uid !== 0 || (wrapper.mode & 0o022) !== 0) throw new CodingRpcFramingError("limits");
  let filter = -1, receipt = -1;
  const abort = new AbortController();
  const incoming = new CodingRpcFrameGuard(spec.limits, abort.signal), outgoing = new CodingRpcFrameGuard(spec.limits, abort.signal);
  let child: ReturnType<typeof spawn>;
  try {
    filter = privateFd(spec.filterPath, false);
    receipt = privateFd(spec.receiptPath, true);
    child = spawn("/usr/bin/bwrap", [...spec.bwrapArgs, ...runtimeArgs], {
      shell: false, cwd: "/", env: { HOME: "/state", PATH: "/usr/bin:/bin" },
      // Only the two host-opened control files are inherited beyond stdio. Child stderr never reaches SDK buffers.
      stdio: ["pipe", "pipe", "ignore", filter, receipt], windowsHide: true,
    });
  } catch {
    incoming.destroy(); outgoing.destroy();
    throw new CodingRpcFramingError("transport");
  } finally {
    if (filter >= 0) fs.closeSync(filter);
    if (receipt >= 0) fs.closeSync(receipt);
  }
  let failed = false, closing = false, retiringInput = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (closing) return;
    closing = true;
    failed = true;
    abort.abort();
    child.kill("SIGKILL");
    child.stdin?.destroy();
    child.stdout?.destroy();
    process.stdin.destroy();
    process.stdout.destroy();
  };
  const ended = () => {
    if (!grace && !closing) grace = setTimeout(stop, 3000);
  };
  const exited = new Promise<number>(resolve => {
    child.once("error", () => { stop(); resolve(1); });
    child.once("close", code => resolve(code ?? 1));
  });
  // Keep the helper deadline active even if a guard has ended while its final bytes wait on a blocked SDK pipe.
  const lifetime = setTimeout(stop, spec.limits.lifetimeMs);
  lifetime.unref?.();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const toChild = pipeline(process.stdin, incoming, child.stdin!).then(ended, () => { if (!retiringInput) stop(); });
  const fromChild = pipeline(child.stdout!, outgoing, process.stdout).then(ended, stop);
  try {
    const code = await exited;
    if (code !== 0) stop();
    // A closed child cannot consume input. Retire the input side without waiting for a parent to close its pipe.
    retiringInput = true;
    process.stdin.destroy();
    incoming.destroy();
    await Promise.allSettled([toChild, fromChild]);
    return failed ? 1 : code;
  } finally {
    clearTimeout(lifetime);
    if (grace) clearTimeout(grace);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    abort.abort();
  }
}

// The unique flag permits safe imports in tests. SDK extra arguments follow the one immutable host spec.
if (process.argv[2] === EXPERIMENTAL_CODING_RPC_PROXY_FLAG) {
  void runExperimentalCodingRpcProxy(process.argv.slice(3)).then(code => { process.exitCode = code; }, () => {
    process.stderr.write("The experimental coding RPC proxy failed.\n");
    process.exitCode = 1;
  });
}
