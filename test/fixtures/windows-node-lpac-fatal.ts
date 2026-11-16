/**
 * Test-only public V8 fatal location parser. Captured messages, stacks and build paths never leave this module.
 * Filename authority comes only from exact official release-tree metadata; missing release locations stay missing.
 */
import sources from "../../scripts/experimental/windows-node-lpac-sources.json";

export const WINDOWS_NODE_FATAL_MAX_BYTES = 64 * 1024;
export type WindowsNodeFatalOutput =
  | { status: "location"; file: string; line: number; bytes: number }
  | { status: "no-location" | "oversize" | "unreadable" | "ambiguous"; bytes: number };
export const WINDOWS_NODE_FATAL_REFUSALS = Object.freeze(["input", "release", "encoding", "newline", "header", "public-source", "line"] as const);
export type WindowsNodeFatalInspection = {
  output: WindowsNodeFatalOutput;
  refusal?: { stage: (typeof WINDOWS_NODE_FATAL_REFUSALS)[number]; representation?: "utf16le-ascii" | "utf16be-ascii" | "other";
    newlines?: { crlf: number; doubledCrlf: number; bareCr: number; lf: number } };
};

type FilesByDirectory = Readonly<Record<string, readonly string[]>>;
const knownFiles = (groups: FilesByDirectory): string[] => Object.entries(groups).flatMap(([directory, names]) =>
  names.map(name => `${sources.prefix}${directory ? directory + "/" : ""}${name}`));
const common = knownFiles(sources.commonFilesByDirectory);
const releases = new Map<string, ReadonlySet<string>>(
  (["22.23.5", "24.21.0"] as const).map(version => [version, new Set([...common, ...knownFiles(sources.versions[version].filesByDirectory)])]),
);

function publicSource(file: string, allowed: ReadonlySet<string>): string | undefined {
  if (!file || file.length > 4096) return undefined;
  const parts = file.replaceAll("\\", "/").split("/");
  // An explicit Node V8 root wins over a build ancestor named "src". Otherwise the first V8 "src" root is
  // authoritative: never skip a traversal-containing suffix to find a later, apparently safe source pathname.
  const nodeRoot = parts.findIndex((part, index) => part === "deps" && parts[index + 1] === "v8" && parts[index + 2] === "src");
  const root = nodeRoot < 0 ? parts.indexOf("src") : nodeRoot + 2;
  if (root < 0) return undefined;
  const suffix = parts.slice(root + 1);
  if (!suffix.length || suffix.some(part => part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) return undefined;
  const candidate = sources.prefix + suffix.join("/");
  return allowed.has(candidate) ? candidate : undefined;
}

/** Preserve the location parser's output contract; inspection adds only closed refusal facts, never captured text. */
export function parseWindowsNodeFatalOutput(bytes: Buffer, version: string): WindowsNodeFatalOutput {
  return inspectWindowsNodeFatalOutput(bytes, version).output;
}

/** This diagnostic does not accept additional encodings or infer a location from a rejected representation. */
export function inspectWindowsNodeFatalOutput(bytes: Buffer, version: string): WindowsNodeFatalInspection {
  const count = Buffer.isBuffer(bytes) ? Math.min(bytes.length, WINDOWS_NODE_FATAL_MAX_BYTES + 1) : 0;
  const fixed = (status: "no-location" | "oversize" | "unreadable" | "ambiguous"): WindowsNodeFatalOutput => ({ status, bytes: count });
  const refuse = (stage: NonNullable<WindowsNodeFatalInspection["refusal"]>["stage"], representation?: NonNullable<WindowsNodeFatalInspection["refusal"]>["representation"]): WindowsNodeFatalInspection =>
    ({ output: fixed("unreadable"), refusal: representation ? { stage, representation } : { stage } });
  if (!Buffer.isBuffer(bytes)) return refuse("input");
  if (bytes.length > WINDOWS_NODE_FATAL_MAX_BYTES) return { output: fixed("oversize") };
  const allowed = releases.get(version);
  if (!allowed) return refuse("release");
  // ASCII plus ordinary text whitespace is also valid UTF8; reject binary/Unicode before decoding any text.
  const ascii = (byte: number) => byte === 9 || byte === 10 || byte === 13 || byte >= 0x20 && byte <= 0x7e;
  if (bytes.some(byte => !ascii(byte))) {
    // Recognize only alternating ASCII/zero byte shapes. Do not decode their content or accept either as text.
    const wideAscii = (little: boolean) => {
      if (!bytes.length || bytes.length % 2) return false;
      for (let index = 0; index < bytes.length; index += 2) {
        if (!ascii(bytes[index + (little ? 0 : 1)]) || bytes[index + (little ? 1 : 0)] !== 0) return false;
      }
      return true;
    };
    return refuse("encoding", wideAscii(true) ? "utf16le-ascii" : wideAscii(false) ? "utf16be-ascii" : "other");
  }
  const text = bytes.toString("utf8");
  // Native receipts observed one CRCRLF and no bare CR. Normalize either supported sequence in one pass:
  // separate replacements could erase a remaining CR from a three-CR run and accidentally accept malformed input.
  const normalized = text.replaceAll(/\r\r?\n/g, "\n");
  if (normalized.includes("\r")) {
    // Fixed structural counts distinguish actual double translation from bare/mixed CR. No text is accepted.
    const newlines = { crlf: 0, doubledCrlf: 0, bareCr: 0, lf: 0 };
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] === 13) {
        if (bytes[index + 1] === 13 && bytes[index + 2] === 10) { newlines.doubledCrlf++; index += 2; }
        else if (bytes[index + 1] === 10) { newlines.crlf++; index++; }
        else newlines.bareCr++;
      } else if (bytes[index] === 10) newlines.lf++;
    }
    return { output: fixed("unreadable"), refusal: { stage: "newline", newlines } };
  }
  const headers = normalized.split("\n").filter(line => line.startsWith("# Fatal error in "));
  if (!headers.length) return { output: fixed("no-location") };
  if (headers.length !== 1) return { output: fixed("ambiguous") };
  const location = /^# Fatal error in (.*), line ([0-9]{1,6})$/.exec(headers[0]);
  if (!location) return refuse("header");
  // Non-debug V8_Fatal explicitly prints an empty filename and line zero. Do not infer a location from its body.
  if (location[1] === "" && location[2] === "0") return { output: fixed("no-location") };
  const line = Number(location[2]), file = publicSource(location[1], allowed);
  if (!file) return refuse("public-source");
  if (line < 1 || line > 100_000) return refuse("line");
  return { output: { status: "location", file, line, bytes: count } };
}
