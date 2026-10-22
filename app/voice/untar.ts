/**
 * A streaming tar reader and a safe extractor, so Ember unpacks its speech models (.tar.bz2) in-process the
 * same way on Linux, Windows and macOS instead of running a system `tar`.
 *
 * It reads ustar, GNU and pax archives: regular files and directories, long names from GNU 'L' and pax 'x'
 * headers, and skips what it doesn't create (devices, FIFOs, global pax headers, volume labels). Because the
 * archive comes from the network, extraction refuses (and stops) on anything that could write outside its
 * folder or isn't what it seems: absolute paths, `..`, symbolic and hard links, names Windows would read
 * differently (drive letters, backslashes, reserved device names), sparse or multi-volume entries, more
 * data or entries than the caps allow, and an archive that ends early.
 */

import fs from "node:fs";
import path from "node:path";
import { bunzip2, type Bunzip2Stats } from "./bzip2";

/** What a tar archive holds, as the extractor sees it (paths are checked and split into parts). */
export type TarEvent =
  | { kind: "directory"; path: string[] }
  | { kind: "file"; path: string[]; size: number }
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "file-end" };

/** Limits on what an archive may hold. */
export interface TarLimits {
  /** Most bytes of entry data in all (default 1 GiB). */
  maxBytes?: number;
  /** Most entries (default 10 000). */
  maxEntries?: number;
}

export const DEFAULT_MAX_BYTES = 1 << 30;
export const DEFAULT_MAX_ENTRIES = 10_000;
const BLOCK = 512;
/** Long-name and pax header data larger than this is refused. */
const META_LIMIT = 1 << 20;
/** Header blocks in a row that only describe the next entry (GNU 'L'/'K', pax 'x'/'g'). */
const META_RUN = 4;
/** Zero bytes allowed after the end-of-archive marker (tar pads to whole records of 10 KiB). */
const TRAILING_LIMIT = 1 << 20;

// Device names Windows reserves in every folder, with any extension ("nul.txt" is the null device too).
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Fails unpacking with a reason that names the archive's problem. */
function refuse(why: string): never {
  throw new Error(`tar archive refused: ${why}`);
}

/**
 * Splits an entry's name into the folder and file names it creates under the destination, or throws when
 * it could land outside it or would mean something else on another OS. "." parts and repeated slashes are
 * dropped; an empty result means the destination itself.
 */
export function safeEntryPath(name: string): string[] {
  if (!name) refuse("an entry has no name");
  if (name.startsWith("/")) refuse(`an entry has an absolute path (${JSON.stringify(name)})`);
  // A backslash separates folders on Windows, so "a\..\..\x" would escape there.
  if (name.includes("\\")) refuse(`an entry's name has a backslash (${JSON.stringify(name)})`);
  const parts = name.split("/").filter(p => p !== "" && p !== ".");
  for (const p of parts) {
    if (p === "..") refuse(`an entry's path goes up a folder (${JSON.stringify(name)})`);
    // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused here
    if (/[\u0000-\u001f<>:"|?*]/.test(p)) refuse(`an entry's name has a character Windows can't use (${JSON.stringify(name)})`);
    if (/[. ]$/.test(p)) refuse(`an entry's name ends with a dot or a space (${JSON.stringify(name)})`);
    if (RESERVED.test(p)) refuse(`an entry's name is reserved on Windows (${JSON.stringify(name)})`);
  }
  return parts;
}

/** A NUL-terminated string field. */
function cstring(b: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  try {
    return utf8.decode(b.subarray(off, end));
  } catch {
    return refuse("an entry's name isn't valid UTF-8");
  }
}

/** A numeric header field: octal digits (space or NUL padded), or GNU's base-256 for large values. */
function number(b: Uint8Array, off: number, len: number, what: string): number {
  if (b[off] & 0x80) {
    if (b[off] & 0x40) refuse(`an entry's ${what} is negative`);
    let v = b[off] & 0x3f;
    for (let i = 1; i < len; i++) v = v * 256 + b[off + i];
    if (!Number.isSafeInteger(v)) refuse(`an entry's ${what} is too large`);
    return v;
  }
  let i = off;
  const end = off + len;
  while (i < end && b[i] === 0x20) i++;
  let v = 0;
  for (; i < end && b[i] >= 0x30 && b[i] <= 0x37; i++) v = v * 8 + (b[i] - 0x30);
  for (; i < end; i++) if (b[i] !== 0x20 && b[i] !== 0) refuse(`an entry's ${what} isn't a number`);
  return v;
}

/** Whether a header's stored checksum matches (bytes summed unsigned, or signed as some old tars did). */
function checksumOk(h: Uint8Array): boolean {
  const stored = number(h, 148, 8, "checksum");
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const v = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += v;
    signed += v > 127 ? v - 256 : v;
  }
  return stored === unsigned || stored === signed;
}

/** pax extended header records ("<length> <key>=<value>\n"). */
export function parsePax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    if (data[i] === 0) {
      // Some writers pad the data with NULs.
      for (; i < data.length; i++) if (data[i] !== 0) refuse("a pax header is malformed");
      break;
    }
    let j = i;
    let len = 0;
    for (; j < data.length && data[j] >= 0x30 && data[j] <= 0x39; j++) {
      len = len * 10 + (data[j] - 0x30);
      if (len > data.length) refuse("a pax header is malformed");
    }
    if (j === i || data[j] !== 0x20 || i + len > data.length || len < j - i + 3 || data[i + len - 1] !== 0x0a) refuse("a pax header is malformed");
    let rec: string;
    try {
      rec = utf8.decode(data.subarray(j + 1, i + len - 1));
    } catch {
      return refuse("a pax header isn't valid UTF-8");
    }
    const eq = rec.indexOf("=");
    if (eq <= 0) refuse("a pax header is malformed");
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

type Mode = "header" | "data" | "meta" | "skip" | "pad" | "end";

/**
 * A push parser: give it the archive's bytes in any pieces, take the events each piece completes. Data
 * events are views of the pieces given, so use them before changing those buffers.
 */
export class TarReader {
  private mode: Mode = "header";
  private readonly header = new Uint8Array(BLOCK);
  private have = 0;
  /** Bytes of the current entry's data (or padding) still to come. */
  private left = 0;
  private padding = 0;
  private meta: Uint8Array | null = null;
  private metaAt = 0;
  private metaType = 0;
  private metaRun = 0;
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax: Map<string, string> | null = null;
  private bytes = 0;
  private entries = 0;
  private trailing = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(limits: TarLimits = {}) {
    this.maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** True once the end-of-archive marker has been read. */
  get ended(): boolean {
    return this.mode === "end";
  }

  push(chunk: Uint8Array): TarEvent[] {
    const events: TarEvent[] = [];
    let i = 0;
    while (i < chunk.length) {
      switch (this.mode) {
        case "header": {
          const k = Math.min(BLOCK - this.have, chunk.length - i);
          this.header.set(chunk.subarray(i, i + k), this.have);
          this.have += k;
          i += k;
          if (this.have === BLOCK) {
            this.have = 0;
            this.onHeader(events);
          }
          break;
        }
        case "data": {
          const k = Math.min(this.left, chunk.length - i);
          events.push({ kind: "data", bytes: chunk.subarray(i, i + k) });
          i += k;
          this.left -= k;
          if (this.left === 0) {
            events.push({ kind: "file-end" });
            this.toPadding();
          }
          break;
        }
        case "meta": {
          const k = Math.min(this.left, chunk.length - i);
          this.meta!.set(chunk.subarray(i, i + k), this.metaAt);
          this.metaAt += k;
          i += k;
          this.left -= k;
          if (this.left === 0) {
            this.onMeta();
            this.toPadding();
          }
          break;
        }
        case "skip":
        case "pad": {
          const k = Math.min(this.left, chunk.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) {
            if (this.mode === "skip") this.toPadding();
            else this.mode = "header";
          }
          break;
        }
        case "end": {
          for (; i < chunk.length; i++) if (chunk[i] !== 0) refuse("it has data after its end marker");
          this.trailing += chunk.length;
          if (this.trailing > TRAILING_LIMIT) refuse("it has too much padding after its end marker");
          break;
        }
      }
    }
    return events;
  }

  /** Checks that the archive was complete (call after the last push). */
  finish(): void {
    if (this.mode !== "end") refuse("it ends before its end marker (truncated)");
  }

  private toPadding(): void {
    this.left = this.padding;
    this.mode = this.left ? "pad" : "header";
  }

  private onHeader(events: TarEvent[]): void {
    const h = this.header;
    if (h.every(v => v === 0)) {
      if (this.metaRun) refuse("it ends right after a long-name or pax header");
      this.mode = "end";
      return;
    }
    if (!checksumOk(h)) refuse("a header's checksum doesn't match (damaged or not a tar archive)");
    const type = h[156];
    let size = number(h, 124, 12, "size");
    const ustar = h[257] === 0x75 && h[258] === 0x73 && h[259] === 0x74 && h[260] === 0x61 && h[261] === 0x72;
    const posix = ustar && h[262] === 0;

    // Headers that describe the next entry: GNU long name ('L') and long link ('K'), pax ('x', 'g').
    if (type === 0x4c || type === 0x4b || type === 0x78 || type === 0x67) {
      if (++this.metaRun > META_RUN) refuse("it has too many long-name or pax headers in a row");
      if (size > META_LIMIT) refuse("a long-name or pax header is too large");
      this.count(size);
      this.metaType = type;
      this.meta = new Uint8Array(size);
      this.metaAt = 0;
      this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
      this.left = size;
      if (size === 0) {
        this.onMeta();
        this.toPadding();
      } else this.mode = "meta";
      return;
    }

    const pax = this.pax;
    let name = this.longName ?? pax?.get("path") ?? null;
    if (name === null) {
      name = cstring(h, 0, 100);
      if (posix) {
        const prefix = cstring(h, 345, 155);
        if (prefix) name = `${prefix}/${name}`;
      }
    }
    const paxSize = pax?.get("size");
    if (paxSize !== undefined) {
      if (!/^\d+$/.test(paxSize) || !Number.isSafeInteger(Number(paxSize))) refuse("a pax size isn't a number");
      size = Number(paxSize);
    }
    if (pax && [...pax.keys()].some(k => k.startsWith("GNU.sparse."))) refuse(`${JSON.stringify(name)} is a sparse file, which isn't supported`);
    const link = this.longLink ?? pax?.get("linkpath") ?? null;
    this.longName = null;
    this.longLink = null;
    this.pax = null;
    this.metaRun = 0;

    if (++this.entries > this.maxEntries) refuse(`it has more than ${this.maxEntries} entries`);
    this.count(size);
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.left = size;

    if (type === 0x30 || type === 0 || type === 0x37) {
      events.push({ kind: "file", path: safeEntryPath(name), size });
      if (size === 0) {
        events.push({ kind: "file-end" });
        this.toPadding();
      } else this.mode = "data";
      return;
    }
    if (type === 0x35) {
      events.push({ kind: "directory", path: safeEntryPath(name) });
    } else if (type === 0x31 || type === 0x32) {
      const to = link ?? cstring(h, 157, 100);
      refuse(`${JSON.stringify(name)} is a ${type === 0x31 ? "hard" : "symbolic"} link (to ${JSON.stringify(to)}), and links aren't allowed`);
    } else if (type === 0x53 || type === 0x4d) {
      refuse(`${JSON.stringify(name)} is a ${type === 0x53 ? "sparse" : "multi-volume"} entry, which isn't supported`);
    }
    // Directories normally have no data; anything else (devices, FIFOs, volume labels, unknown types) is skipped.
    if (size === 0) this.toPadding();
    else this.mode = "skip";
  }

  private onMeta(): void {
    const data = this.meta!;
    this.meta = null;
    if (this.metaType === 0x4c) this.longName = cstring(data, 0, data.length);
    else if (this.metaType === 0x4b) this.longLink = cstring(data, 0, data.length);
    else if (this.metaType === 0x78) this.pax = new Map([...(this.pax ?? []), ...parsePax(data)]);
    else parsePax(data); // A global pax header: checked, but nothing in it changes what is extracted.
  }

  private count(size: number): void {
    this.bytes += size;
    if (this.bytes > this.maxBytes) refuse(`it holds more than ${this.maxBytes} bytes`);
  }
}

/** Options for {@link extractTar}. */
export interface ExtractOptions extends TarLimits {
  /** Every entry must be inside this top folder of the archive (anything else is refused). */
  topFolder?: string;
  /** Worker threads for the bzip2 decoder (see bunzip2). */
  workers?: number;
  /** Counts where the bzip2 decoder decoded blocks. */
  stats?: Bunzip2Stats;
}

/** What an extraction wrote. */
export interface ExtractSummary {
  files: number;
  directories: number;
  bytes: number;
}

/** Writes all of `bytes` (a FileHandle may write less than asked). */
async function writeAll(fh: fs.promises.FileHandle, bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await fh.write(bytes, at, bytes.length - at);
    at += bytesWritten;
  }
}

/**
 * Extracts a tar archive (its bytes, in pieces) into `dest`, which should be a new, empty folder: files are
 * created exclusively (an entry that would overwrite anything fails), with modes 0644 and 0755, and links
 * are never made. On failure, what was written so far stays for the caller to remove.
 */
export async function extractTar(chunks: AsyncIterable<Uint8Array>, dest: string, options: ExtractOptions = {}): Promise<ExtractSummary> {
  const reader = new TarReader(options);
  const root = path.resolve(dest);
  const summary: ExtractSummary = { files: 0, directories: 0, bytes: 0 };
  let file: fs.promises.FileHandle | null = null;
  const made = new Set<string>();
  const mkdir = async (dir: string) => {
    if (made.has(dir)) return;
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
    made.add(dir);
  };
  const target = (parts: string[]): string => {
    if (options.topFolder !== undefined && parts[0] !== options.topFolder) {
      refuse(`${JSON.stringify(parts.join("/"))} is outside ${JSON.stringify(options.topFolder)}`);
    }
    const t = path.join(root, ...parts);
    const rel = path.relative(root, t);
    if (rel.startsWith("..") || path.isAbsolute(rel)) refuse(`${JSON.stringify(parts.join("/"))} would land outside the destination`);
    return t;
  };
  try {
    for await (const chunk of chunks) {
      for (const ev of reader.push(chunk)) {
        if (ev.kind === "data") {
          await writeAll(file!, ev.bytes);
          summary.bytes += ev.bytes.length;
        } else if (ev.kind === "file-end") {
          await file!.close();
          file = null;
          summary.files++;
        } else if (ev.kind === "directory") {
          // The archive's own top entry ("./") is the destination itself.
          if (!ev.path.length) continue;
          await mkdir(target(ev.path));
          summary.directories++;
        } else {
          if (!ev.path.length) refuse("a file entry names the destination folder itself");
          const t = target(ev.path);
          await mkdir(path.dirname(t));
          file = await fs.promises.open(t, "wx", 0o644);
        }
      }
      // After the end marker only zero padding may follow; reading it all also lets the decompressor check its CRCs.
    }
    reader.finish();
  } finally {
    await file?.close().catch(() => undefined);
  }
  return summary;
}

/** Extracts a .tar.bz2 file into `dest` (see extractTar), decompressing in-process. */
export async function extractTarBz2(archive: string, dest: string, options: ExtractOptions = {}): Promise<ExtractSummary> {
  const source = fs.createReadStream(archive, { highWaterMark: 1 << 20 });
  try {
    return await extractTar(bunzip2(source, { workers: options.workers, stats: options.stats }), dest, options);
  } finally {
    source.destroy();
  }
}
