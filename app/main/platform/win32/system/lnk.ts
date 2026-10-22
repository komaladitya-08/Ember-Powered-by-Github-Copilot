/**
 * A reader for Windows shortcut files (.lnk, the MS-SHLLINK format) in plain TypeScript, so listing the Start Menu
 * never calls COM on Electron's main thread (Electron's shell.readShortcutLink is a synchronous COM call per file;
 * two thousand of them cold is a visible stall). It reads what the app catalogue needs: the header's flags, the
 * LinkInfo's local or network path, the StringData (description, working folder, arguments), and three extra-data
 * blocks: EnvironmentVariableDataBlock (a target written with %VARIABLES%), DarwinDataBlock (an MSI "advertised"
 * shortcut) and the PropertyStoreDataBlock's System.AppUserModel.ID. Every read is bounds-checked: a file that
 * doesn't parse throws LnkError and the catalogue skips it. A shortcut without a LinkInfo (written by other tools) is
 * read from its LinkTargetIDList when that is a plain file-system path (This PC, a drive, file entries). Pure.
 */

/** A shortcut that isn't a valid MS-SHLLINK file (or is cut short). */
export class LnkError extends Error {}

/** What a shortcut says. */
export interface ShellLink {
  /** The program or file it opens, as written (may hold %VARIABLES%: see expandEnvironmentStrings); null when it names none (a shell item). */
  target: string | null;
  /** The command-line arguments, as one string (split with splitWindowsArgs). */
  arguments: string;
  /** The comment Explorer shows as a tooltip ("" when none). */
  description: string;
  workingDir: string | null;
  /** System.AppUserModel.ID from the property store, when set. */
  aumid: string | null;
  /** An MSI advertised shortcut: Windows Installer resolves its real target at launch (its "target" is an icon). */
  advertised: boolean;
  /** "Run as administrator" is ticked on the shortcut. */
  runAsUser: boolean;
}

const HEADER_SIZE = 0x4c;
/** {00021401-0000-0000-C000-000000000046} as stored. */
const LINK_CLSID = Buffer.from("0114020000000000c000000000000046", "hex");
const FLAG = {
  HasLinkTargetIDList: 0x1, HasLinkInfo: 0x2, HasName: 0x4, HasRelativePath: 0x8, HasWorkingDir: 0x10, HasArguments: 0x20,
  HasIconLocation: 0x40, IsUnicode: 0x80, ForceNoLinkInfo: 0x100, HasExpString: 0x200, HasDarwinID: 0x1000, RunAsUser: 0x2000,
} as const;
const BLOCK = { EnvironmentVariable: 0xa0000001, Darwin: 0xa0000006, PropertyStore: 0xa0000009 } as const;
/** EnvironmentVariableDataBlock and DarwinDataBlock: 260 ANSI bytes then 520 UTF-16 bytes. */
const ANSI_CHARS = 260;
/** System.AppUserModel.ID: format {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, property 5. */
const AUMID_FMTID = Buffer.from("55284c9f799f394ba8d0e1d42de1d5f3", "hex");
const AUMID_PID = 5;
/** The property-name format whose values are named by strings, not numbers (skipped). */
const STRING_NAMES_FMTID = Buffer.from("05d5cdd59c2e1b10939708002b2cf9ae", "hex");
const VT_LPWSTR = 0x1f;
const SPS_VERSION = 0x53505331; // "1SPS"

/** Bounds-checked reads over the file's bytes. */
class Reader {
  constructor(readonly buf: Buffer) {}
  need(at: number, n: number): void {
    if (at < 0 || n < 0 || at + n > this.buf.length) throw new LnkError("the shortcut is cut short");
  }
  u16(at: number): number { this.need(at, 2); return this.buf.readUInt16LE(at); }
  u32(at: number): number { this.need(at, 4); return this.buf.readUInt32LE(at); }
  bytes(at: number, n: number): Buffer { this.need(at, n); return this.buf.subarray(at, at + n); }
  /** A NUL-terminated single-byte string (the system code page; read as Latin-1, which is right for ASCII paths). */
  ansiz(at: number, end = this.buf.length): string {
    this.need(at, 0);
    const stop = this.buf.indexOf(0, at);
    if (stop < 0 || stop > end) throw new LnkError("a string runs past its structure");
    return this.buf.toString("latin1", at, stop);
  }
  /** A NUL-terminated UTF-16LE string. */
  wstrz(at: number, end = this.buf.length): string {
    for (let i = at; i + 1 < end; i += 2) {
      this.need(i, 2);
      if (this.buf.readUInt16LE(i) === 0) return this.buf.toString("utf16le", at, i);
    }
    throw new LnkError("a string runs past its structure");
  }
}

/** A fixed-size field holding a NUL-terminated string (the environment and Darwin blocks): "" when empty. */
function fixedString(r: Reader, at: number, chars: number, unicode: boolean): string {
  const field = r.bytes(at, unicode ? chars * 2 : chars);
  if (unicode) {
    let end = 0;
    while (end + 1 < field.length && field.readUInt16LE(end) !== 0) end += 2;
    return field.toString("utf16le", 0, end);
  }
  const stop = field.indexOf(0);
  return field.toString("latin1", 0, stop < 0 ? field.length : stop);
}

/** The LinkInfo structure's path: a local base path plus suffix, or a network share plus suffix; null when neither. */
function linkInfoPath(r: Reader, at: number): string | null {
  const size = r.u32(at), headerSize = r.u32(at + 4), flags = r.u32(at + 8);
  r.need(at, size);
  const end = at + size;
  if (headerSize < 0x1c || headerSize > size) throw new LnkError("bad LinkInfo header");
  const localOffset = r.u32(at + 16), networkOffset = r.u32(at + 20), suffixOffset = r.u32(at + 24);
  const unicode = headerSize >= 0x24;
  const localOffsetW = unicode ? r.u32(at + 28) : 0, suffixOffsetW = unicode ? r.u32(at + 32) : 0;
  const suffix = suffixOffsetW ? r.wstrz(at + suffixOffsetW, end) : suffixOffset ? r.ansiz(at + suffixOffset, end) : "";
  if (flags & 0x1) {
    const base = localOffsetW ? r.wstrz(at + localOffsetW, end) : r.ansiz(at + localOffset, end);
    if (base) return joinSuffix(base, suffix);
  }
  if ((flags & 0x2) && networkOffset) {
    // CommonNetworkRelativeLink: size, flags, NetNameOffset, DeviceNameOffset, provider, [NetNameOffsetUnicode, DeviceNameOffsetUnicode].
    const net = at + networkOffset;
    const netEnd = net + r.u32(net);
    if (netEnd > end) throw new LnkError("bad CommonNetworkRelativeLink");
    const nameOffset = r.u32(net + 8);
    const nameOffsetW = nameOffset > 0x14 ? r.u32(net + 20) : 0;
    const share = nameOffsetW ? r.wstrz(net + nameOffsetW, netEnd) : r.ansiz(net + nameOffset, netEnd);
    if (share) return joinSuffix(share, suffix);
  }
  return null;
}

const joinSuffix = (base: string, suffix: string) => (!suffix ? base : base.endsWith("\\") ? base + suffix : `${base}\\${suffix}`);

/** {20D04FE0-3AEA-1069-A2D8-08002B30309D} (This PC) as stored in a root folder shell item. */
const MY_COMPUTER = Buffer.from("e04fd020ea3a6910a2d808002b30309d", "hex");
const BEEF0004 = 0xbeef0004;

/**
 * A file entry shell item's long name: the 0xBEEF0004 extension block's Unicode name (whose position depends on the
 * block's version), else the item's own short name. null when the item isn't a file entry.
 */
function fileEntryName(r: Reader, at: number, end: number): string | null {
  const type = r.buf[at + 2];
  if ((type & 0x70) !== 0x30) return null; // not a file entry (0x31 folder, 0x32 file, 0x35/0x36 with a Unicode short name)
  const unicodeShort = (type & 0x04) !== 0;
  const nameAt = at + 2 + 12; // size(2) type(1) unknown(1) file size(4) modified(4) attributes(2)
  // The last two bytes of the item give the extension block's offset from the item's start.
  const extAt = at + r.u16(end - 2);
  if (extAt + 8 <= end - 2 && r.u32(extAt + 4) === BEEF0004) {
    const version = r.u16(extAt + 2);
    if (version >= 3) {
      let p = extAt + 8 + 4 + 4 + 2; // signature, created, accessed, identifier
      if (version >= 7) p += 2 + 8 + 8;
      p += 2; // long string size
      if (version >= 9) p += 4;
      if (version >= 8) p += 4;
      const name = r.wstrz(p, end);
      if (name) return name;
    }
  }
  return unicodeShort ? r.wstrz(nameAt, end) : r.ansiz(nameAt, end);
}

/**
 * The file-system path a LinkTargetIDList points at, for the shape shortcuts to programs take: This PC, a drive
 * ("C:\"), then file entries. null for anything else (a known folder, a control panel item, a packaged app).
 */
function idListPath(r: Reader, at: number, end: number): string | null {
  let p = at;
  let drive: string | null = null;
  const names: string[] = [];
  let first = true;
  while (p + 2 <= end) {
    const size = r.u16(p);
    if (size === 0) break;
    if (size < 3 || p + size > end) throw new LnkError("bad shell item");
    const type = r.buf[p + 2];
    if (first) {
      first = false;
      if (type !== 0x1f || size < 20 || !r.bytes(p + 4, 16).equals(MY_COMPUTER)) return null;
    } else if (drive === null) {
      if ((type & 0x70) !== 0x20) return null; // a volume item ("C:\")
      const letter = r.ansiz(p + 3, p + size);
      if (!/^[A-Za-z]:\\?$/.test(letter)) return null;
      drive = letter.endsWith("\\") ? letter : `${letter}\\`;
    } else {
      const name = fileEntryName(r, p, p + size);
      if (name === null) return null;
      names.push(name);
    }
    p += size;
  }
  return drive && names.length ? drive + names.join("\\") : null;
}

/** System.AppUserModel.ID from a serialized property store (MS-PROPSTORE), or null. */
function aumidOf(r: Reader, at: number, end: number): string | null {
  let p = at;
  while (p + 4 <= end) {
    const storageSize = r.u32(p);
    if (storageSize === 0) break;
    if (storageSize < 24 || p + storageSize > end) throw new LnkError("bad property storage");
    const storageEnd = p + storageSize;
    if (r.u32(p + 4) !== SPS_VERSION) throw new LnkError("bad property storage version");
    const fmtid = r.bytes(p + 8, 16);
    if (!fmtid.equals(STRING_NAMES_FMTID)) {
      let v = p + 24;
      while (v + 4 <= storageEnd) {
        const valueSize = r.u32(v);
        if (valueSize === 0) break;
        if (valueSize < 9 || v + valueSize > storageEnd) throw new LnkError("bad property value");
        const id = r.u32(v + 4);
        // Then a reserved byte and a TypedPropertyValue: type (2), padding (2), the value.
        if (fmtid.equals(AUMID_FMTID) && id === AUMID_PID && valueSize >= 17 && r.u16(v + 9) === VT_LPWSTR) {
          const chars = r.u32(v + 13); // including the NUL
          const text = r.bytes(v + 17, Math.min(chars * 2, valueSize - 17)).toString("utf16le");
          const nul = text.indexOf("\0");
          return (nul < 0 ? text : text.slice(0, nul)) || null;
        }
        v += valueSize;
      }
    }
    p = storageEnd;
  }
  return null;
}

/** Parses a .lnk file's bytes. Throws LnkError when they aren't a shortcut. */
export function parseShellLink(buf: Buffer): ShellLink {
  const r = new Reader(buf);
  if (r.u32(0) !== HEADER_SIZE || !r.bytes(4, 16).equals(LINK_CLSID)) throw new LnkError("not a shortcut");
  const flags = r.u32(20);
  let p = HEADER_SIZE;
  let idTarget: string | null = null;
  if (flags & FLAG.HasLinkTargetIDList) {
    const size = r.u16(p);
    r.need(p + 2, size);
    try {
      idTarget = idListPath(r, p + 2, p + 2 + size);
    } catch (err) {
      if (!(err instanceof LnkError)) throw err;
      idTarget = null; // a shell item Ember doesn't know: the LinkInfo may still name the target
    }
    p += 2 + size;
  }

  let target: string | null = null;
  if ((flags & FLAG.HasLinkInfo) && !(flags & FLAG.ForceNoLinkInfo)) {
    const size = r.u32(p);
    target = linkInfoPath(r, p);
    p += size;
  } else if (flags & FLAG.HasLinkInfo) {
    p += r.u32(p); // present but to be ignored
  }

  const unicode = (flags & FLAG.IsUnicode) !== 0;
  const stringData = (flag: number): string | null => {
    if (!(flags & flag)) return null;
    const count = r.u16(p);
    const bytes = r.bytes(p + 2, unicode ? count * 2 : count);
    p += 2 + bytes.length;
    return bytes.toString(unicode ? "utf16le" : "latin1");
  };
  const description = stringData(FLAG.HasName) ?? "";
  stringData(FLAG.HasRelativePath);
  const workingDir = stringData(FLAG.HasWorkingDir);
  const args = stringData(FLAG.HasArguments) ?? "";
  stringData(FLAG.HasIconLocation);

  let envTarget: string | null = null, darwin = false, aumid: string | null = null;
  while (p + 4 <= buf.length) {
    const size = r.u32(p);
    if (size < 4) break; // the terminal block
    if (size < 8) throw new LnkError("bad extra data block");
    r.need(p, size);
    const signature = r.u32(p + 4);
    if (signature === BLOCK.EnvironmentVariable && size >= 8 + ANSI_CHARS * 3) {
      envTarget = fixedString(r, p + 8 + ANSI_CHARS, ANSI_CHARS, true) || fixedString(r, p + 8, ANSI_CHARS, false) || null;
    } else if (signature === BLOCK.Darwin) {
      darwin = true;
    } else if (signature === BLOCK.PropertyStore) {
      aumid = aumidOf(r, p + 8, p + size) ?? aumid;
    }
    p += size;
  }

  return {
    target: (flags & FLAG.HasExpString) && envTarget ? envTarget : target ?? idTarget ?? envTarget,
    arguments: args,
    description,
    workingDir,
    aumid,
    advertised: darwin || (flags & FLAG.HasDarwinID) !== 0,
    runAsUser: (flags & FLAG.RunAsUser) !== 0,
  };
}

/**
 * %NAME% references replaced from `env` (names compared case-insensitively, as Windows does); an unknown name is
 * left as it is, as ExpandEnvironmentStrings leaves it.
 */
export function expandEnvironmentStrings(s: string, env: NodeJS.ProcessEnv): string {
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !lookup.has(k.toUpperCase())) lookup.set(k.toUpperCase(), v);
  return s.replace(/%([^%\s]+)%/g, (whole, name: string) => lookup.get(name.toUpperCase()) ?? whole);
}
