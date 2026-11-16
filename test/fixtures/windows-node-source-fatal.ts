/** Source-build-only public signature classifier. Captured text, symbols, addresses and paths never escape. */
import { inspectWindowsNodeFatalOutput, type WindowsNodeFatalInspection } from "./windows-node-lpac-fatal";

// Node 22.23.5, commit60553651579ec33ca1aef9e1eedab2c3855f1f7e:
// src/node_errors.cc400-412 emits the assertion pair;572-606 emits FATAL ERROR.
// src/debug_utils.cc317-328 emits the native-stack header/numbered frames.
// This finite table is from the complete authenticated release tree. IDs, bounded lines and static check IDs
// are public metadata; a source suffix is diagnostic evidence, never an attestation of the failing operation.
const sites = [
  [1, "src/node.cc", 1651], [2, "src/node_platform.cc", 782], [3, "src/env.cc", 2282],
  [4, "src/node_internals.h", 483], [5, "src/util.h", 1021], [6, "src/crypto/crypto_util.cc", 750],
  [7, "src/node_main_instance.cc", 153], [8, "src/node_errors.cc", 1418], [9, "src/node_binding.cc", 723],
  [10, "src/node_snapshotable.cc", 1669], [11, "src/inspector_agent.cc", 1267], [12, "src/inspector_io.cc", 440],
  [13, "src/inspector_socket_server.cc", 563], [14, "src/node_watchdog.cc", 441], [15, "src/node_perf.cc", 425],
  [16, "src/tracing/agent.cc", 256],
] as const;
const checks = [
  [1, 2, 104, "(0) == (uv_thread_create(t.get(), start_thread, this))"],
  [2, 2, 134, "(0) == (uv_loop_init(&loop_))"],
  [3, 2, 136, "(0) == (uv_async_init(&loop_, &flush_tasks_, FlushTasks))"],
  [4, 2, 296, "(0) == (uv_async_init(loop, flush_tasks_, FlushTasks))"],
  [5, 1, 1266, "ncrypto::CSPRNG(nullptr, 0)"], [6, 1, 1273, "ncrypto::CSPRNG(buffer, length)"],
  [7, 3, 1098, "(0) == (uv_timer_init(event_loop(), timer_handle()))"],
  [8, 1, 887, "!init_called.exchange(true)"],
] as const;
const frames = [
  [1, "node::Assert"], [2, "node::DumpNativeBacktrace"], [3, "node::PlatformInit"],
  [4, "node::InitializeOncePerProcessInternal"], [5, "node::InitializeOncePerProcess"],
  [6, "node::WorkerThreadsTaskRunner"], [7, "node::MultiIsolatePlatform"], [8, "node::NodeMainInstance"],
  [9, "node::Start"], [10, "node::OnFatalError"], [11, "node::OOMErrorHandler"],
] as const;

export type WindowsNodeSourceFatalInspection = WindowsNodeFatalInspection & {
  // format1=Node assertion pair;2=Node fatal header;3=native backtrace only;4=ambiguous public headers.
  // site/check/frame codes are the fixed tables above. reason1=JS heap OOM;2=process OOM.
  nodeDiagnostic?: { format: 1 | 2 | 3 | 4; site?: number; line?: number; check?: number; reason?: 1 | 2;
    nativeFrames?: number; publicFrames?: number[] };
};

function publicSite(location: string): { site: number; line: number } | undefined {
  if (location.length > 4096) return;
  const match = /^(.*):([1-9][0-9]{0,4})$/.exec(location);
  if (!match) return;
  const parts = match[1].replaceAll("\\", "/").split("/"), root = parts.indexOf("src");
  if (root < 0) return;
  // The first src root is authoritative; never recover a safe-looking suffix after a rejected traversal.
  const suffix = parts.slice(root + 1);
  if (!suffix.length || suffix.some(part => part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) return;
  const file = "src/" + suffix.join("/"), line = Number(match[2]), known = sites.find(([, path]) => path === file);
  if (!known || line > known[2]) return;
  return { site: known[0], line };
}

function publicFrames(lines: readonly string[]) {
  const roots = lines.flatMap((line, index) => line === "----- Native stack trace -----" ? [index] : []);
  if (roots.length !== 1) return;
  const matched = new Set<number>(); let count = 0, index = roots[0] + 1;
  while (lines[index] === "") index++;
  for (; index < lines.length && lines[index] !== ""; index++) {
    // Exact Windows %2d/%p frame representation; addresses are discarded, never returned or converted.
    const frame = /^ ?([1-9][0-9]{0,2}): [A-Fa-f0-9]{16} ([\x20-\x7e]{1,4096})$/.exec(lines[index]);
    if (!frame || Number(frame[1]) !== count + 1 || count >= 255) return;
    count++;
    for (const [code, name] of frames) {
      if (frame[2].startsWith(name) && /^(?:\+|\(|::|\[| |$)/.test(frame[2].slice(name.length))) matched.add(code);
    }
  }
  return count ? { nativeFrames: count, publicFrames: [...matched].sort((a, b) => a - b) } : undefined;
}

/** Adds only finite public signature codes. The original official-output parser and acceptance rules are frozen. */
export function inspectWindowsNodeSourceFatalOutput(bytes: Buffer): WindowsNodeSourceFatalInspection {
  const base = inspectWindowsNodeFatalOutput(bytes, "22.23.5");
  if (base.output.status !== "no-location" || !Buffer.isBuffer(bytes) || bytes.length === 0) return base;
  // The base parser has already enforced its ASCII, control, size and one-pass newline policy.
  const lines = bytes.toString("ascii").replaceAll(/\r\r?\n/g, "\n").split("\n");
  const assertions = lines.flatMap((line, index) => line.startsWith("  #  Assertion failed: ") ? [index] : []);
  const fatals = lines.filter(line => line.startsWith("FATAL ERROR: "));
  const stack = publicFrames(lines);
  if (assertions.length + fatals.length > 1) return { ...base, nodeDiagnostic: { format: 4 } };
  if (assertions.length === 1) {
    const index = assertions[0], previous = lines[index - 1] ?? "", divider = previous.lastIndexOf(" at ");
    const expression = lines[index].slice("  #  Assertion failed: ".length);
    if (!previous.startsWith("  #  ") || previous.length > 8192 || divider < 6 ||
        !previous.slice(6, divider).includes(": ") || !expression || expression.length > 4096) return base;
    const site = publicSite(previous.slice(divider + 4));
    const check = site && checks.find(([, file, line, text]) => file === site.site && line === site.line && text === expression)?.[0];
    return { ...base, nodeDiagnostic: { format: 1, ...site, ...(check ? { check } : {}), ...stack } };
  }
  if (fatals.length === 1) {
    if (fatals[0].length > 4096 || fatals[0].length === "FATAL ERROR: ".length) return base;
    const reason = fatals[0].endsWith("Allocation failed - JavaScript heap out of memory") ? 1
      : fatals[0].endsWith("Allocation failed - process out of memory") ? 2 : undefined;
    return { ...base, nodeDiagnostic: { format: 2, ...(reason ? { reason } : {}), ...stack } };
  }
  return stack ? { ...base, nodeDiagnostic: { format: 3, ...stack } } : base;
}
