/** Test-only, data-minimizing Application Error observation for one stopped, exact Windows Node process. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";

export const WINDOWS_NODE_EVENT_LIMIT = 32;
const MAX_BYTES = 64 * 1024;
const providerGuid = "a0e9b465-b939-57d7-b27d-95d8e925ff57";
const reason = z.enum(["event-api", "event-schema", "record-limit", "parse", "bounds", "ambiguous"]);
export type WindowsNodeEventDiagnostic = { status: "found"; code: string; module: string; offset: string } | { status: "absent" } | { status: "unavailable"; reason: z.infer<typeof reason> };
export interface WindowsNodeEventIdentity { pid: number; image: string; startedAt: number }
interface EventWindow extends WindowsNodeEventIdentity { endedAt: number }
const record = z.object({ provider: z.string().max(64), providerGuid: z.string().max(40), channel: z.string().max(32), id: z.number().int(),
  time: z.string().max(40), pid: z.string().max(10), image: z.string().max(4096), app: z.string().max(96),
  code: z.string().max(10), module: z.string().max(96), offset: z.string().max(18) }).strict();
const envelope = z.discriminatedUnion("status", [
  z.object({ version: z.literal(1), status: z.literal("records"), records: z.array(record).max(WINDOWS_NODE_EVENT_LIMIT) }).strict(),
  z.object({ version: z.literal(1), status: z.literal("unavailable"), reason }).strict(),
]);
function validWindow(expected: EventWindow): boolean {
  return Number.isInteger(expected.pid) && expected.pid > 0 && expected.pid <= 0xffffffff &&
    /^[A-Za-z]:\\(?:[^\\/\p{Cc}\p{Cf}]+\\)*node\.exe$/iu.test(expected.image) && expected.image.length <= 4096 &&
    !/[:<>"|?*]/.test(expected.image.slice(3)) && !expected.image.split("\\").some(part => part === "." || part === ".." || /[. ]$/.test(part)) &&
    Number.isSafeInteger(expected.startedAt) && Number.isSafeInteger(expected.endedAt) && expected.startedAt > 0 &&
    expected.endedAt >= expected.startedAt && expected.endedAt - expected.startedAt <= 60_000;
}
/** Revalidate captured query output before any diagnostic is printed. Unknown or malformed data never becomes text. */
export function selectWindowsNodeApplicationError(output: unknown, expected: EventWindow): WindowsNodeEventDiagnostic {
  if (!validWindow(expected) || typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_BYTES) return { status: "unavailable", reason: "bounds" };
  let parsed: z.infer<typeof envelope>;
  try { parsed = envelope.parse(JSON.parse(output)); } catch { return { status: "unavailable", reason: "parse" }; }
  if (parsed.status === "unavailable") return { status: "unavailable", reason: parsed.reason };
  const matches = new Map<string, WindowsNodeEventDiagnostic>();
  for (const event of parsed.records) {
    if (event.provider !== "Application Error" || ![providerGuid, `{${providerGuid}}`].includes(event.providerGuid.toLowerCase()) || event.channel !== "Application" || event.id !== 1000) continue;
    if (!/^0x[0-9a-f]{1,8}$/i.test(event.pid) || Number.parseInt(event.pid.slice(2), 16) !== expected.pid ||
        event.image.toLowerCase() !== expected.image.toLowerCase() || event.app.toLowerCase() !== "node.exe") continue;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(event.time)) continue;
    const time = Date.parse(event.time);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== event.time.slice(0, 19) || time < expected.startedAt || time > expected.endedAt) continue;
    if (!/^(?:0x)?[0-9a-f]{8}$/i.test(event.code) || !/^(?:0x)?[0-9a-f]{1,16}$/i.test(event.offset) ||
        !/^(?:unknown|[a-z0-9][a-z0-9_.-]{0,90}\.(?:exe|dll))$/i.test(event.module)) return { status: "unavailable", reason: "event-schema" };
    const found: WindowsNodeEventDiagnostic = { status: "found", code: `0x${event.code.replace(/^0x/i, "").toLowerCase()}`,
      module: event.module.toLowerCase(), offset: `0x${event.offset.replace(/^0x/i, "").toLowerCase().padStart(16, "0")}` };
    matches.set(JSON.stringify(found), found);
  }
  if (matches.size > 1) return { status: "unavailable", reason: "ambiguous" };
  return matches.values().next().value ?? { status: "absent" };
}

/** Availability is diagnostic only. Caller obtains identity only after exact root exit plus private job-zero proof. */
export function observeWindowsNodeApplicationError(identity: WindowsNodeEventIdentity, windows: string, state: string): WindowsNodeEventDiagnostic {
  const expected = { ...identity, startedAt: identity.startedAt - 1000, endedAt: Date.now() };
  if (!validWindow(expected) || process.platform !== "win32") return { status: "unavailable", reason: "bounds" };
  const system = path.join(windows, "System32"), powershell = path.join(system, "WindowsPowerShell", "v1.0");
  try {
    const output = execFileSync(path.join(powershell, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      path.resolve("test", "fixtures", "windows-node-lpac-events.ps1"), "-ExpectedProcessId", String(expected.pid), "-ExpectedImage", expected.image,
      "-StartUtc", new Date(expected.startedAt).toISOString(), "-EndUtc", new Date(expected.endedAt).toISOString()], {
      env: { SystemRoot: windows, WINDIR: windows, PATH: system, PSModulePath: path.join(powershell, "Modules"), TEMP: state, TMP: state },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 8000, maxBuffer: MAX_BYTES,
    });
    return selectWindowsNodeApplicationError(output, expected);
  } catch { return { status: "unavailable", reason: "event-api" }; }
}
