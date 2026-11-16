/**
 * Host-selected PS7 portable distribution copied into fresh package-SID objects. No source ACL changes.
 * The expected manifest authenticates the entire caller-trusted distribution, not its publisher: callers must
 * select it outside model/project control. PATH, per-user/MSIX aliases and arbitrary model-selected assets are absent.
 */
import fs from "node:fs";
import path from "node:path/win32";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ExperimentalWindowsLpacFixture, experimentalWindowsSddl } from "./experimental-windows-lpac";
import { loadExperimentalWindowsLpacApi, type WindowsHandle, type WindowsLpacApi } from "./experimental-windows-lpac-api";

const MAX_FILE = 128 * 1024 * 1024, MAX_BYTES = 1024 * 1024 * 1024, MAX_ENTRIES = 4096, MAX_DEPTH = 16;
export interface WindowsCommandAssetReader { read(file: string): Buffer }
export interface WindowsPowerShellManifest { sha256: string; files: number; directories: number; bytes: number }
export interface WindowsPowerShellTrust { assetRoot: string; manifestSha256: string }
interface Asset { relative: string; kind: "file" | "directory"; bytes?: Buffer }

/** BY_HANDLE_FILE_INFORMATION: reject directories, devices, sparse/reparse/offline/encrypted files and hardlinks. */
export function ordinaryWindowsCommandAssetSize(info: Buffer): number {
  if (info.length !== 52 || (info.readUInt32LE(0) & 0x5650) !== 0 || info.readUInt32LE(40) !== 1) throw new Error("The toolchain asset is not one ordinary non-reparse file.");
  const size = BigInt(info.readUInt32LE(32)) << 32n | BigInt(info.readUInt32LE(36));
  if (size > BigInt(MAX_FILE)) throw new Error("The toolchain asset exceeds the file size bound.");
  return Number(size);
}

type NativeFunction = (...args: unknown[]) => unknown;
/** Read through an identity-checked native handle, without following a reparse point or sharing writes/deletes. */
export function bindWindowsCommandAssetReader(load: (name: string) => { func(prototype: string): unknown }): WindowsCommandAssetReader {
  const dll = load("kernel32.dll"), fn: Record<string, NativeFunction> = {};
  for (const prototype of [
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)",
    "int __stdcall ReadFile(void *file, void *bytes, uint32_t size, _Out_ uint32_t *read, void *overlapped)",
    "int __stdcall CloseHandle(void *file)", "uint32_t __stdcall GetLastError()",
  ]) fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = dll.func(prototype) as NativeFunction;
  const error = (operation: string) => new Error(`${operation} failed (Windows error ${Number(fn.GetLastError())}).`);
  return { read(file) {
    const handle = fn.CreateFileW(file, 0x80000080, 1, null, 3, 0x00200000, null);
    if (typeof handle !== "bigint" || handle === 0n || handle === 0xffffffffffffffffn) throw error("Open trusted toolchain asset");
    let result: Buffer | undefined, problem: unknown;
    try {
      const before = Buffer.alloc(52);
      if (!fn.GetFileInformationByHandle(handle, before)) throw error("Inspect trusted toolchain asset");
      const size = ordinaryWindowsCommandAssetSize(before), bytes = Buffer.alloc(size);
      for (let offset = 0; offset < size;) {
        const count = Math.min(1024 * 1024, size - offset), read = [0];
        if (!fn.ReadFile(handle, bytes.subarray(offset, offset + count), count, read, null) || read[0] < 1 || read[0] > count) throw error("Read trusted toolchain asset");
        offset += read[0];
      }
      const after = Buffer.alloc(52);
      if (!fn.GetFileInformationByHandle(handle, after) || !before.subarray(0, 12).equals(after.subarray(0, 12)) || !before.subarray(20).equals(after.subarray(20))) throw new Error("The trusted toolchain asset changed while being read.");
      result = bytes;
    } catch (cause) { problem = cause; }
    if (!fn.CloseHandle(handle)) throw new AggregateError([problem, error("Close trusted toolchain asset")].filter(Boolean), "Trusted asset cleanup failed.");
    if (problem) throw problem;
    return result!;
  } };
}

export function loadWindowsCommandAssetReader(): WindowsCommandAssetReader {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw new Error("The PowerShell LPAC proof requires Windows x64.");
  const koffi = createRequire(__filename)("koffi") as typeof Koffi;
  return bindWindowsCommandAssetReader(name => koffi.load(name));
}

function sourceRoot(root: string): string {
  if (!/^[A-Za-z]:\\/.test(root) || root.includes("/") || /[\0\r\n]/.test(root)) throw new Error("Select an explicit local PowerShell distribution root.");
  const parts = root.slice(3).split("\\");
  if (!parts.length || parts.some(part => !ordinaryName(part))) throw new Error("The PowerShell distribution has an unsupported path.");
  return root;
}
function ordinaryName(name: string): boolean {
  return !!name && ![...name].some(char => char.charCodeAt(0) < 32) && !/[<>:"/\\|?*]/.test(name) && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && name !== "." && name !== "..";
}

/** All source ancestors remain pinned until enumeration, hashing and fresh destination copies finish. */
function walk(root: string, api: WindowsLpacApi, reader: WindowsCommandAssetReader, accept: (asset: Asset) => void): WindowsPowerShellManifest {
  sourceRoot(root);
  if (api.volumeFileSystem(path.parse(root).root).toUpperCase() !== "NTFS") throw new Error("PowerShell toolchain assets require local NTFS.");
  const pins: WindowsHandle[] = [], records: string[] = [], names = new Set<string>();
  let files = 0, directories = 0, bytes = 0, entries = 0;
  const pin = (directory: string) => { pins.push(api.pinDirectory(directory)); };
  let result: WindowsPowerShellManifest | undefined, problem: unknown;
  try {
    let ancestor = path.parse(root).root; pin(ancestor);
    for (const part of root.slice(ancestor.length).split("\\")) { ancestor = path.join(ancestor, part); pin(ancestor); }
    const visit = (directory: string, relative: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new Error("The PowerShell toolchain exceeds the directory depth bound.");
      const listing = fs.opendirSync(directory);
      try {
        for (;;) {
          const entry = listing.readSync(); if (!entry) break;
          if (++entries > MAX_ENTRIES) throw new Error("The PowerShell toolchain exceeds the entry count bound.");
          if (!ordinaryName(entry.name)) throw new Error("Unsupported toolchain asset name.");
          const name = relative ? `${relative}\\${entry.name}` : entry.name, key = name.toLowerCase();
          if (names.has(key) || key === "fixture.exe") throw new Error("Duplicate or reserved toolchain asset name.");
          names.add(key);
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            pin(absolute); directories++; records.push(JSON.stringify(["directory", name]));
            accept({ relative: name, kind: "directory" }); visit(absolute, name, depth + 1);
          } else if (entry.isFile()) {
            const data = reader.read(absolute);
            if (data.length > MAX_FILE || (bytes += data.length) > MAX_BYTES) throw new Error("The PowerShell toolchain exceeds the byte bound.");
            files++; records.push(JSON.stringify(["file", name, data.length, createHash("sha256").update(data).digest("hex")]));
            accept({ relative: name, kind: "file", bytes: data });
          } else throw new Error("The PowerShell toolchain contains a link or special object.");
        }
      } finally { listing.closeSync(); }
    };
    visit(root, "", 0);
    for (const required of ["pwsh.exe", "pwsh.dll", "pwsh.deps.json", "pwsh.runtimeconfig.json", "hostfxr.dll", "hostpolicy.dll", "coreclr.dll", "system.management.automation.dll"])
      if (!names.has(required)) throw new Error(`The portable PowerShell distribution is incomplete: ${required}.`);
    result = { sha256: createHash("sha256").update(records.sort().join("\n") + "\n").digest("hex"), files, directories, bytes };
  } catch (cause) { problem = cause; }
  const errors: unknown[] = [];
  for (const handle of pins.reverse()) { try { api.close(handle); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError([problem, ...errors].filter(Boolean), "Trusted asset directory cleanup failed.");
  if (problem) throw problem;
  return result!;
}

/** Measurement alone does not establish trust. The caller vouches for this system distribution before passing its hash to prepare. */
export function measureWindowsPowerShellToolchain(root: string, api = loadExperimentalWindowsLpacApi(), reader = loadWindowsCommandAssetReader()): WindowsPowerShellManifest {
  return walk(root, api, reader, () => undefined);
}

export interface WindowsPowerShellProofFixture {
  fixture: ExperimentalWindowsLpacFixture;
  manifest: WindowsPowerShellManifest;
  close(): Promise<void>;
}

/** Copies only verified bytes to newly created RX package-SID files; validation never executes source assets. */
export async function prepareWindowsPowerShellProof(parent: string, trust: WindowsPowerShellTrust, api = loadExperimentalWindowsLpacApi(), reader = loadWindowsCommandAssetReader()): Promise<WindowsPowerShellProofFixture> {
  sourceRoot(trust.assetRoot);
  if (!/^[a-f0-9]{64}$/.test(trust.manifestSha256)) throw new Error("An explicit trusted toolchain manifest SHA256 is required.");
  // Inspect pwsh.exe only while all its ancestors are pinned. Full traversal also checks every companion asset.
  let executable: Buffer | undefined;
  const measured = walk(trust.assetRoot, api, reader, asset => { if (asset.relative.toLowerCase() === "pwsh.exe") executable = asset.bytes; });
  if (measured.sha256 !== trust.manifestSha256 || !executable) throw new Error("The trusted PowerShell toolchain manifest does not match.");
  let packageSid = "";
  const wrapped: WindowsLpacApi = { ...api, createProfile(name) { const profile = api.createProfile(name); packageSid = profile.sidText; return profile; } };
  const fixture = ExperimentalWindowsLpacFixture.prepare(parent, executable, wrapped), pins: WindowsHandle[] = [];
  let closing: Promise<void> | undefined;
  const closeOnce = async () => {
    await fixture.close(); // Preserve destination pins on an uncertain process shutdown.
    const errors: unknown[] = [];
    for (const handle of pins.slice().reverse()) { try { api.close(handle); } catch (error) { errors.push(error); } }
    if (errors.length) throw errors[0];
  };
  // A failed native handle close is terminal: all callers observe the same outcome, without retrying or forgetting it.
  const close = () => closing ??= closeOnce();
  try {
    const owner = api.ownerSid();
    const manifest = walk(trust.assetRoot, api, reader, asset => {
      const target = path.join(fixture.paths.tools, asset.relative);
      const sddl = experimentalWindowsSddl(owner, packageSid, "read", asset.kind === "directory");
      if (asset.kind === "directory") { api.createDirectory(target, sddl); pins.push(api.pinDirectory(target)); }
      else api.writeNewFile(target, asset.bytes!, sddl);
    });
    if (manifest.sha256 !== trust.manifestSha256) throw new Error("The trusted PowerShell toolchain changed before staging completed.");
    return { fixture, manifest, close };
  } catch (error) { await close(); throw error; }
}
