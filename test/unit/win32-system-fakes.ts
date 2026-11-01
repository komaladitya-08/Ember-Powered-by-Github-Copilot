/**
 * Fakes shared by the win32-system-* tests: a registry that answers RegGetValueW/RegSetKeyValueW the way Windows does
 * (type filtering by RRF_RT_* flags, the size-then-data protocol, ERROR_MORE_DATA, access denied), wrapped in a fake
 * Win32SysApi whose other calls tests set as they need, and an in-memory file system for the app catalogue.
 */

import type { Win32SysApi } from "../../app/main/platform/win32/system/ffi";
import type { AppsFs } from "../../app/main/platform/win32/system/apps";

export const HKLM = -2147483646;
export const HKCU = -2147483647;

/** RRF_RT_* bit of each REG_* type. */
const TYPE_BIT: Record<number, number> = { 1: 0x02, 2: 0x04, 3: 0x08, 4: 0x10, 7: 0x20, 11: 0x40 };

export interface FakeValue { type: number; data: Buffer }

/** A registry: `hive\key` (case-insensitive) → value name → value; `denied` keys answer ERROR_ACCESS_DENIED. */
export class FakeRegistry {
  readonly keys = new Map<string, Map<string, FakeValue>>();
  readonly denied = new Set<string>();
  /** Called before each read: lets a test change a value between the size and the data call. */
  beforeRead?: (key: string, value: string, withData: boolean) => void;
  writes: { key: string; value: string; type: number; data: Buffer }[] = [];
  writeStatus = 0;

  private id(hive: number, key: string) {
    return `${hive === HKLM ? "HKLM" : hive === HKCU ? "HKCU" : String(hive)}\\${key}`.toLowerCase();
  }

  set(hive: number, key: string, value: string, v: FakeValue): this {
    const id = this.id(hive, key);
    if (!this.keys.has(id)) this.keys.set(id, new Map());
    this.keys.get(id)!.set(value.toLowerCase(), v);
    return this;
  }

  sz(hive: number, key: string, value: string, text: string): this {
    return this.set(hive, key, value, { type: 1, data: Buffer.from(`${text}\0`, "utf16le") });
  }

  multiSz(hive: number, key: string, value: string, lines: string[]): this {
    return this.set(hive, key, value, { type: 7, data: Buffer.from(`${lines.join("\0")}\0\0`, "utf16le") });
  }

  dword(hive: number, key: string, value: string, n: number): this {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(n >>> 0, 0);
    return this.set(hive, key, value, { type: 4, data });
  }

  deny(hive: number, key: string): this {
    this.denied.add(this.id(hive, key));
    return this;
  }

  get(hive: number, key: string, value: string): FakeValue | undefined {
    return this.keys.get(this.id(hive, key))?.get(value.toLowerCase());
  }

  regGetValue(hive: number, key: string, value: string, flags: number, data: Buffer | null): { status: number; type: number; size: number } {
    this.beforeRead?.(key, value, data !== null);
    const id = this.id(hive, key);
    if (this.denied.has(id)) return { status: 5, type: 0, size: 0 };
    const v = this.keys.get(id)?.get(value.toLowerCase());
    if (!v) return { status: 2, type: 0, size: 0 };
    if (!(flags & (TYPE_BIT[v.type] ?? 0))) return { status: 1630, type: v.type, size: 0 };
    if (!data) return { status: 0, type: v.type, size: v.data.length };
    if (data.length < v.data.length) return { status: 234, type: v.type, size: v.data.length };
    v.data.copy(data);
    return { status: 0, type: v.type, size: v.data.length };
  }

  regSetValue(hive: number, key: string, value: string, type: number, data: Buffer): number {
    this.writes.push({ key, value, type, data: Buffer.from(data) });
    if (this.writeStatus) return this.writeStatus;
    if (this.denied.has(this.id(hive, key))) return 5;
    this.set(hive, key, value, { type, data: Buffer.from(data) });
    return 0;
  }
}

/** A Win32SysApi over `registry`, every other call answering "can't tell" unless `over` sets it. */
export function fakeApi(registry = new FakeRegistry(), over: Partial<Win32SysApi> = {}): Win32SysApi & { registry: FakeRegistry; broadcasts: string[] } {
  const broadcasts: string[] = [];
  return {
    registry,
    broadcasts,
    regGetValue: (h, k, v, f, d) => registry.regGetValue(h, k, v, f, d),
    regSetValue: (h, k, v, t, d) => registry.regSetValue(h, k, v, t, d),
    broadcastSettingChange: (area, _timeoutMs, done) => { broadcasts.push(area); done?.(true); return true; },
    screenReader: () => null,
    elevated: () => null,
    sessionId: () => null,
    systemDirectory: () => "C:\\Windows\\System32",
    windowsDirectory: () => "C:\\Windows",
    knownFolder: () => null,
    packageFamilyInstalled: () => null,
    monitorRect: () => null,
    ansiText: () => null,
    ...over,
  };
}

/** An in-memory file system: files with bytes and modification times, folders implied by their paths. */
export class FakeFs implements AppsFs {
  readonly files = new Map<string, { path: string; bytes: Buffer; mtime: number }>();
  readonly dirMtimes = new Map<string, number>();
  reads: string[] = [];

  private norm(p: string) {
    return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }

  add(path: string, bytes: Buffer | string = Buffer.alloc(0), mtime = 1): this {
    this.files.set(this.norm(path), { path: path.replace(/\//g, "\\"), bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mtime });
    return this;
  }

  remove(path: string): this {
    this.files.delete(this.norm(path));
    return this;
  }

  /** Bumps a folder's modification time (a shortcut added or removed). */
  touch(dir: string, mtime: number): this {
    this.dirMtimes.set(this.norm(dir), mtime);
    return this;
  }

  private isDir(p: string) {
    const n = this.norm(p);
    return [...this.files.keys()].some(f => f.startsWith(`${n}\\`));
  }

  readdir(dir: string): { name: string; isFile: boolean; isDirectory: boolean }[] {
    const n = this.norm(dir);
    if (!this.isDir(n)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
    const names = new Map<string, boolean>();
    for (const [f, entry] of this.files) {
      if (!f.startsWith(`${n}\\`)) continue;
      const rest = entry.path.slice(n.length + 1); // the name as added, its case kept
      const i = rest.indexOf("\\");
      names.set(i < 0 ? rest : rest.slice(0, i), i < 0);
    }
    return [...names].map(([name, file]) => ({ name, isFile: file, isDirectory: !file }));
  }

  mtimeMs(p: string): number | null {
    const n = this.norm(p);
    const f = this.files.get(n);
    if (f) return f.mtime;
    if (this.isDir(n)) return this.dirMtimes.get(n) ?? 1;
    return null;
  }

  readFile(p: string, max: number): Buffer | null {
    this.reads.push(p);
    const f = this.files.get(this.norm(p));
    return f && f.bytes.length <= max ? f.bytes : null;
  }

  exists(p: string): boolean {
    const n = this.norm(p);
    return this.files.has(n) || this.isDir(n);
  }
}

/** What buildLnk writes. */
export interface LnkSpec {
  /** The LinkInfo local path (omitted: no LinkInfo). */
  target?: string;
  args?: string;
  description?: string;
  /** An EnvironmentVariableDataBlock target, with HasExpString. */
  envTarget?: string;
  advertised?: boolean;
  runAsUser?: boolean;
  aumid?: string;
}

/**
 * A minimal valid .lnk (MS-SHLLINK) for the catalogue's tests: header, a LinkInfo with ANSI and Unicode paths,
 * StringData, and the extra-data blocks asked for. (lnk.ts itself is tested against bytes from other tools.)
 */
export function buildLnk(s: LnkSpec): Buffer {
  const HasLinkInfo = 0x2, HasName = 0x4, HasArguments = 0x20, IsUnicode = 0x80, HasExpString = 0x200, HasDarwinID = 0x1000, RunAsUser = 0x2000;
  let flags = IsUnicode;
  if (s.target !== undefined) flags |= HasLinkInfo;
  if (s.description !== undefined) flags |= HasName;
  if (s.args !== undefined) flags |= HasArguments;
  if (s.envTarget !== undefined) flags |= HasExpString;
  if (s.advertised) flags |= HasDarwinID;
  if (s.runAsUser) flags |= RunAsUser;
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  header.writeUInt32LE(flags, 20);
  const parts: Buffer[] = [header];
  if (s.target !== undefined) {
    const vol = Buffer.concat([u32(17), u32(3), u32(0x1234), u32(16), Buffer.from([0])]);
    const ansi = Buffer.from(`${s.target.replace(/[^\x20-\x7e]/g, "?")}\0`, "latin1");
    const suffix = Buffer.from([0]);
    let wideAt = 0x24 + vol.length + ansi.length + suffix.length;
    const pad = wideAt % 2;
    wideAt += pad;
    const wide = Buffer.from(`${s.target}\0`, "utf16le");
    const wideSuffix = Buffer.from([0, 0]);
    const body = Buffer.concat([vol, ansi, suffix, Buffer.alloc(pad), wide, wideSuffix]);
    const size = 0x24 + body.length;
    parts.push(u32(size), u32(0x24), u32(1), u32(0x24), u32(0x24 + vol.length), u32(0), u32(0x24 + vol.length + ansi.length), u32(wideAt), u32(wideAt + wide.length), body);
  }
  const sized = (text: string) => { const b = Buffer.alloc(2); b.writeUInt16LE(text.length, 0); return Buffer.concat([b, Buffer.from(text, "utf16le")]); };
  if (s.description !== undefined) parts.push(sized(s.description));
  if (s.args !== undefined) parts.push(sized(s.args));
  const fixed = (text: string) => Buffer.concat([Buffer.from(text, "latin1"), Buffer.alloc(260 - text.length), Buffer.from(text, "utf16le"), Buffer.alloc(520 - text.length * 2)]);
  if (s.envTarget !== undefined) parts.push(u32(0x314), u32(0xa0000001), fixed(s.envTarget));
  if (s.advertised) parts.push(u32(0x314), u32(0xa0000006), fixed("w_1^VX!!!!!!!!!MKKSkProductFiles"));
  if (s.aumid !== undefined) {
    let v = Buffer.concat([Buffer.from([0x1f, 0, 0, 0]), u32(s.aumid.length + 1), Buffer.from(`${s.aumid}\0`, "utf16le")]);
    if (v.length % 4) v = Buffer.concat([v, Buffer.alloc(4 - (v.length % 4))]);
    const value = Buffer.concat([u32(9 + v.length), u32(5), Buffer.from([0]), v]);
    const storage = Buffer.concat([u32(24 + value.length + 4), u32(0x53505331), Buffer.from("55284c9f799f394ba8d0e1d42de1d5f3", "hex"), value, u32(0)]);
    parts.push(u32(8 + storage.length + 4), u32(0xa0000009), storage, u32(0));
  }
  parts.push(u32(0));
  return Buffer.concat(parts);
}

/** "Привет" in cp1251 (#65). */
export const CP1251_PRIVET = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);

/**
 * A non-Unicode .lnk (#65): a LinkInfo whose local path is `target`'s bytes in the system code page (NUL-terminated),
 * and optionally an ANSI description (HasName).
 */
export function ansiLink(target: Buffer, description?: Buffer): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(header, 4);
  header.writeUInt32LE(0x2 | (description ? 0x4 : 0), 20);
  const linkInfo = Buffer.concat([u32(0x1c + target.length), u32(0x1c), u32(0x1), u32(0x1c), u32(0x1c), u32(0), u32(0), target]);
  const strings = description ? Buffer.concat([u16(description.length), description]) : Buffer.alloc(0);
  return Buffer.concat([header, linkInfo, strings, u32(0)]);
}
