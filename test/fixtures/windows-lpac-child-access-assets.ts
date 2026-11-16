/** Fixed-source/manual-CI witness provenance and bounded archive staging. No download, process or driver runs on import. */
import { createHash } from "node:crypto";
import path from "node:path/win32";
import { inflateRawSync } from "node:zlib";
import pins from "../../scripts/experimental/windows-lpac-procmon-pin.json";

export const CHILD_ACCESS_ISSUER = "ember.experimental.fixed-c-child-access-witness.v1";
export const CHILD_ACCESS_BASE = "a1f10fc515d312d8ae28970712fbc9f02064d9d2";
export const CHILD_ACCESS_SOURCES = Object.freeze({
  "experimental-windows-lpac.c": "e4e286b480274cb76e62777e8756a6dc6aa040b32bb984f4db2466c75adad1e5",
  "experimental-windows-lpac-inherited.c": "03cb73319dbfe0978c86382d296f5467c9f0bb3e1be9ec4e118b1bac073f6f53",
  "windows-lpac-child-sd-diagnostic.h": "b202599fe849efada01fa2c39cbf03faa4fef929a9fa58c6b25367d09fa54eb2",
});
export const CHILD_ACCESS_RECIPE = "/nologo /O1 /GS- /Zl /DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_INHERIT_CONSOLE=1 /link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib";
export const CHILD_ACCESS_TOOL = Object.freeze({ ...pins });
export const CHILD_ACCESS_ARCHIVE_MAX = 16 * 1024 * 1024;
export const CHILD_ACCESS_PML_MAX = 64 * 1024 * 1024;
export const CHILD_ACCESS_CSV_MAX = 32 * 1024 * 1024;
export const childAccessSha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export class ChildAccessAssetError extends Error {
  readonly code: number;
  constructor(code: number) { super("The fixed child-access witness asset contract was refused."); this.name = "ChildAccessAssetError";
    this.code = Number.isInteger(code) && code >= 1 && code <= 8 ? code : 0; }
}
const refuse = (code: number): never => { throw new ChildAccessAssetError(code); };
export function childAccessLocalPath(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || value.includes("/") || path.normalize(value) !== value ||
    /[%!^&|<>"\p{Cc}\p{Cf}]/u.test(value) || value.slice(3).split("\\").some(part => !part || part === "." || part === ".." || /[:?*]|[. ]$/.test(part))) return refuse(1);
  return value;
}
/** Environment declarations are a manual-lane guard, not proof of a hostile administrator's absence. */
export function childAccessManualGate(env: Readonly<NodeJS.ProcessEnv>, platform: string, arch: string): "windows-2022" | "windows-2025" {
  if (platform !== "win32" || arch !== "x64" || env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.EMBER_LPAC_CHILD_ACCESS_TEST !== "1" || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "") ||
    (env.EMBER_LPAC_CHILD_ACCESS_RUNNER !== "windows-2022" && env.EMBER_LPAC_CHILD_ACCESS_RUNNER !== "windows-2025")) return refuse(2);
  childAccessLocalPath(env.RUNNER_TEMP ?? ""); childAccessLocalPath(env.GITHUB_WORKSPACE ?? "");
  return env.EMBER_LPAC_CHILD_ACCESS_RUNNER;
}
export function childAccessCleanEnvironment(windows: string, profile: string, temporary: string): NodeJS.ProcessEnv {
  for (const value of [windows, profile, temporary]) childAccessLocalPath(value);
  return { SystemRoot: windows, WINDIR: windows, SystemDrive: path.parse(windows).root.slice(0, 2),
    PATH: `${path.join(windows, "System32")};${windows}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: path.join(windows, "System32", "cmd.exe"),
    USERPROFILE: profile, APPDATA: path.join(profile, "Roaming"), LOCALAPPDATA: path.join(profile, "Local"), TEMP: temporary, TMP: temporary,
    PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2" };
}
export function childAccessEnvironmentBlock(env: Readonly<NodeJS.ProcessEnv>): Buffer {
  const entries = Object.entries(env);
  if (!entries.length || new Set(entries.map(([key]) => key.toUpperCase())).size !== entries.length ||
    entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_()]*$/.test(key) || typeof value !== "string" || /[\0\r\n]/.test(value))) return refuse(3);
  return Buffer.from(entries.sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase(), "en")).map(([key, value]) => `${key}=${value}\0`).join("") + "\0", "utf16le");
}
export function childAccessCompileBatch(installation: string, build: string): string {
  for (const value of [installation, build]) childAccessLocalPath(value);
  return `@echo off\r\ncall "${path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat")}" >nul\r\nif errorlevel 1 exit /b 1\r\n` +
    `cl.exe /nologo /O1 /GS- /Zl /DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_INHERIT_CONSOLE=1 /Fo"${path.join(build, "fixture.obj")}" /Fe"${path.join(build, "fixture.exe")}" "${path.join(build, "experimental-windows-lpac-inherited.c")}" /link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib\r\n`;
}
const sourceCopies = new WeakSet<Map<string, Buffer>>();
export function childAccessSourceCopies(read: (file: keyof typeof CHILD_ACCESS_SOURCES) => Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  try {
    for (const file of Object.keys(CHILD_ACCESS_SOURCES) as (keyof typeof CHILD_ACCESS_SOURCES)[]) {
      const source = read(file);
      if (!Buffer.isBuffer(source) || source.length < 1 || source.length > 1024 * 1024 || childAccessSha256(source) !== CHILD_ACCESS_SOURCES[file]) return refuse(4);
      result.set(file, Buffer.from(source));
    }
    sourceCopies.add(result); return result;
  } catch { for (const value of result.values()) value.fill(0); return refuse(4); }
}
type WitnessManifest = Readonly<{ issuer: typeof CHILD_ACCESS_ISSUER; sourceBase: typeof CHILD_ACCESS_BASE; sourceCommit: string;
  sources: typeof CHILD_ACCESS_SOURCES; recipeSha256: string; executableSha256: string; toolArchiveSha256: string; toolExecutableSha256: string; microsoftSignature: true }>;
const manifests = new WeakSet<object>();
/** Minted only by the fixed build/verified-tool pipeline; a JSON lookalike never becomes an admitted artifact. */
export function childAccessManifest(sourceCommit: string, executable: Uint8Array, signature: Buffer, sources: Map<string, Buffer>): WitnessManifest {
  if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit) || !(executable instanceof Uint8Array) || executable.buffer instanceof SharedArrayBuffer ||
    executable.length < 2 || executable.length > CHILD_ACCESS_ARCHIVE_MAX || executable[0] !== 0x4d || executable[1] !== 0x5a ||
    !Buffer.isBuffer(signature) || signature.length !== 4 || signature.readUInt32LE() !== 1 || !sourceCopies.has(sources) ||
    sources.size !== 3 || Object.entries(CHILD_ACCESS_SOURCES).some(([file, hash]) => !Buffer.isBuffer(sources.get(file)) || childAccessSha256(sources.get(file)!) !== hash)) return refuse(5);
  const result: WitnessManifest = Object.freeze({ issuer: CHILD_ACCESS_ISSUER, sourceBase: CHILD_ACCESS_BASE, sourceCommit,
    sources: CHILD_ACCESS_SOURCES, recipeSha256: childAccessSha256(CHILD_ACCESS_RECIPE), executableSha256: childAccessSha256(executable),
    toolArchiveSha256: pins.archiveSha256, toolExecutableSha256: pins.executableSha256, microsoftSignature: true });
  manifests.add(result); return result;
}
export function childAccessManifestCurrent(manifest: unknown, sourceCommit: string, executable: Uint8Array): boolean {
  if (!manifest || typeof manifest !== "object" || !manifests.has(manifest)) return false;
  const value = manifest as WitnessManifest;
  return value.sourceCommit === sourceCommit && value.executableSha256 === childAccessSha256(executable) && value.recipeSha256 === childAccessSha256(CHILD_ACCESS_RECIPE) &&
    value.toolArchiveSha256 === pins.archiveSha256 && value.toolExecutableSha256 === pins.executableSha256;
}
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
};
/** Read one fixed entry only: no archive path is ever used as a host output path. */
export function childAccessZipEntry(archive: Buffer): Buffer {
  let output: Buffer | undefined;
  try {
    if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > CHILD_ACCESS_ARCHIVE_MAX) return refuse(6);
    let end = -1;
    for (let at = archive.length - 22; at >= Math.max(0, archive.length - 65557); at--) {
      if (archive.readUInt32LE(at) === 0x06054b50 && at + 22 + archive.readUInt16LE(at + 20) === archive.length) { end = at; break; }
    }
    if (end < 0 || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0) return refuse(6);
    const count = archive.readUInt16LE(end + 10), directorySize = archive.readUInt32LE(end + 12), directoryAt = archive.readUInt32LE(end + 16);
    if (count < 1 || count > 32 || archive.readUInt16LE(end + 8) !== count || directoryAt + directorySize !== end) return refuse(6);
    let cursor = directoryAt;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) return refuse(6);
      const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10), checksum = archive.readUInt32LE(cursor + 16);
      const compressed = archive.readUInt32LE(cursor + 20), size = archive.readUInt32LE(cursor + 24), nameBytes = archive.readUInt16LE(cursor + 28);
      const extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32), external = archive.readUInt32LE(cursor + 38), local = archive.readUInt32LE(cursor + 42);
      if (nameBytes < 1 || nameBytes > 128 || cursor + 46 + nameBytes + extra + comment > end || archive.readUInt16LE(cursor + 34) !== 0 ||
        (flags & ~0x80e) !== 0 || (method !== 0 && method !== 8) || (method === 0 && (flags & 6) !== 0) || compressed > CHILD_ACCESS_ARCHIVE_MAX || size > CHILD_ACCESS_ARCHIVE_MAX) return refuse(6);
      const name = archive.toString("ascii", cursor + 46, cursor + 46 + nameBytes);
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || name.includes("..") || !Buffer.from(name, "ascii").equals(archive.subarray(cursor + 46, cursor + 46 + nameBytes))) return refuse(6);
      if (name === "Procmon64.exe") {
        const unixType = (external >>> 16) & 0xf000;
        if (output || (external & 0x10) !== 0 || (unixType !== 0 && unixType !== 0x8000) || local + 30 > directoryAt || archive.readUInt32LE(local) !== 0x04034b50 ||
          archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method || archive.readUInt16LE(local + 26) !== nameBytes) return refuse(6);
        const localExtra = archive.readUInt16LE(local + 28), data = local + 30 + nameBytes + localExtra;
        if (data + compressed > directoryAt || !archive.subarray(local + 30, local + 30 + nameBytes).equals(Buffer.from(name, "ascii")) || size < 2) return refuse(6);
        if (!(flags & 8) && (archive.readUInt32LE(local + 14) !== checksum || archive.readUInt32LE(local + 18) !== compressed || archive.readUInt32LE(local + 22) !== size)) return refuse(6);
        if (flags & 8) {
          let descriptor = data + compressed;
          if (descriptor + 4 <= directoryAt && archive.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
          if (descriptor + 12 > directoryAt || archive.readUInt32LE(descriptor) !== checksum || archive.readUInt32LE(descriptor + 4) !== compressed || archive.readUInt32LE(descriptor + 8) !== size) return refuse(6);
        }
        output = method === 0 ? Buffer.from(archive.subarray(data, data + compressed)) : inflateRawSync(archive.subarray(data, data + compressed), { maxOutputLength: CHILD_ACCESS_ARCHIVE_MAX });
        if (output.length !== size || crc32(output) !== checksum || output[0] !== 0x4d || output[1] !== 0x5a) return refuse(6);
      }
      cursor += 46 + nameBytes + extra + comment;
    }
    if (cursor !== end || !output) return refuse(6);
    return output;
  } catch { output?.fill(0); return refuse(6); }
}
export function childAccessPinnedProcmon(archive: Buffer): Buffer {
  if (childAccessSha256(archive) !== pins.archiveSha256) return refuse(7);
  const executable = childAccessZipEntry(archive);
  if (childAccessSha256(executable) !== pins.executableSha256) { executable.fill(0); return refuse(7); }
  return executable;
}
export function childAccessCommand(program: string, args: readonly string[]): Buffer {
  childAccessLocalPath(program);
  if (args.length > 20 || args.some(value => typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value))) return refuse(8);
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
  const command = [program, ...args].map(quote).join(" ");
  if (command.length >= 32767) return refuse(8);
  return Buffer.from(command + "\0", "utf16le");
}
/** This undocumented PMC format reduces capture volume only; CSV native-owner/lifetime checks remain mandatory. */
export function childAccessProcmonConfiguration(pid: number): Buffer {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) return refuse(8);
  const dword = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const rules = [Buffer.from([1]), dword(2)];
  for (const [field, value, number] of [[40054, String(pid), pid], [40053, "fixture.exe", 0]] as const) {
    const text = Buffer.from(value + "\0", "utf16le"); rules.push(dword(field), dword(0), Buffer.from([1]), dword(text.length), text, dword(number), dword(0));
  }
  return Buffer.concat([["FilterRules", Buffer.concat(rules)], ["DestructiveFilter", dword(1)]].map(([name, data]) => {
    const text = Buffer.from(name + "\0", "utf16le"), bytes = data as Buffer;
    return Buffer.concat([dword(16 + text.length + bytes.length), dword(16), dword(16 + text.length), dword(bytes.length), text, bytes]);
  }));
}
