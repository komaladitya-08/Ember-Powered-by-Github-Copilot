/**
 * Builds .bz2 and tar archives in plain TypeScript for the voice-archive tests, so they can craft multi-block,
 * damaged and hostile archives the same way on Linux, Windows and macOS (where no bzip2 or GNU tar may be
 * installed). The encoder is small and slow (it sorts rotations naively): meant for test-sized inputs only.
 */

const CRC = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  CRC[i] = c;
}

/** bzip2's CRC-32 (big-endian, polynomial 0x04c11db7) of `data`. */
export function bzip2Crc(data: Uint8Array): number {
  let crc = -1;
  for (const b of data) crc = (crc << 8) ^ CRC[(crc >>> 24) ^ b];
  return ~crc;
}

class BitWriter {
  private readonly bytes: number[] = [];
  private acc = 0;
  private n = 0;

  /** Writes the low `count` bits of `value`, most significant first (count at most 24). */
  put(count: number, value: number): void {
    for (let k = count - 1; k >= 0; k--) {
      this.acc = (this.acc << 1) | ((value >>> k) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  put32(value: number): void {
    this.put(16, (value >>> 16) & 0xffff);
    this.put(16, value & 0xffff);
  }

  /** Bits written so far. */
  get length(): number {
    return this.bytes.length * 8 + this.n;
  }

  finish(): Uint8Array {
    if (this.n) this.put(8 - this.n, 0);
    return Uint8Array.from(this.bytes);
  }
}

/** Ways to make a stream damaged or unusual, block by block. */
export interface Bzip2Options {
  /** 1-9 (default 9): the header's block size, in 100 000 bytes. */
  level?: number;
  /** Most RLE1 bytes per block (default the level's size): small values make many blocks. */
  blockBytes?: number;
  /** Code lengths for a block's symbols (default: Huffman on their frequencies). */
  lengths?: (freqs: number[], block: number) => number[];
  /** XORed into a block's stored CRC. */
  crcXor?: (block: number) => number;
  /** XORed into the stream's combined CRC. */
  streamCrcXor?: number;
  /** Replaces a block's start pointer. */
  origPtr?: (real: number, block: number) => number;
  /** Sets a block's (obsolete) randomised bit. */
  randomised?: boolean;
}

/** Huffman code lengths for `freqs` (zero frequencies count as one), or flat lengths if any would pass 20 bits. */
export function huffmanLengths(freqs: number[]): number[] {
  type Node = { w: number; syms: number[] };
  let nodes: Node[] = freqs.map((f, s) => ({ w: Math.max(1, f), syms: [s] }));
  const len = new Array<number>(freqs.length).fill(0);
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.w - b.w);
    const [a, b] = nodes;
    for (const s of [...a.syms, ...b.syms]) len[s]++;
    nodes = [{ w: a.w + b.w, syms: [...a.syms, ...b.syms] }, ...nodes.slice(2)];
  }
  if (len.some(l => l > 20)) return flatLengths(freqs.length);
  return len;
}

/** Every symbol the same length: a valid (possibly incomplete) prefix code. */
export function flatLengths(alphaSize: number): number[] {
  return new Array<number>(alphaSize).fill(Math.max(1, Math.ceil(Math.log2(alphaSize))));
}

/** The first RLE1 step: runs of 4 to 255 equal bytes become four bytes and a count. Returns units that blocks don't split. */
function rle1Units(data: Uint8Array): { encoded: number[]; raw: number }[] {
  const units: { encoded: number[]; raw: number }[] = [];
  for (let i = 0; i < data.length;) {
    const b = data[i];
    let run = 1;
    while (run < 255 && i + run < data.length && data[i + run] === b) run++;
    units.push(run >= 4 ? { encoded: [b, b, b, b, run - 4], raw: run } : { encoded: new Array<number>(run).fill(b), raw: run });
    i += run;
  }
  return units;
}

/** Sorted rotations of `s` (prefix doubling; equal rotations in any order, which bzip2 decodes the same). */
function sortRotations(s: number[]): number[] {
  const n = s.length;
  let rank = s.slice();
  const sa = Array.from({ length: n }, (_, i) => i);
  for (let k = 1; ; k *= 2) {
    const key = (i: number) => rank[(i + k) % n];
    sa.sort((a, b) => rank[a] - rank[b] || key(a) - key(b));
    const next = new Array<number>(n);
    next[sa[0]] = 0;
    for (let j = 1; j < n; j++) {
      const a = sa[j - 1];
      const b = sa[j];
      next[b] = next[a] + (rank[a] !== rank[b] || key(a) !== key(b) ? 1 : 0);
    }
    rank = next;
    if (rank[sa[n - 1]] === n - 1 || k >= n) break;
  }
  return sa;
}

/** Compresses `data` into one bzip2 stream. */
export function bzip2Compress(data: Uint8Array, opts: Bzip2Options = {}): Uint8Array {
  const level = opts.level ?? 9;
  const blockBytes = opts.blockBytes ?? level * 100_000 - 19;
  const w = new BitWriter();
  w.put(8, 0x42);
  w.put(8, 0x5a);
  w.put(8, 0x68);
  w.put(8, 0x30 + level);
  let combined = 0;
  const units = rle1Units(data);
  let u = 0;
  let offset = 0;
  for (let block = 0; u < units.length; block++) {
    const s: number[] = [];
    let raw = 0;
    while (u < units.length && s.length + units[u].encoded.length <= blockBytes) {
      s.push(...units[u].encoded);
      raw += units[u].raw;
      u++;
    }
    if (!s.length) throw new Error("blockBytes is too small for a run");
    const crc = bzip2Crc(data.subarray(offset, offset + raw));
    offset += raw;
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) | 0;

    const n = s.length;
    const sa = sortRotations(s);
    const last = sa.map(i => s[(i + n - 1) % n]);
    const realPtr = sa.indexOf(0);

    const used = [...new Set(s)].sort((a, b) => a - b);
    const mtf = used.slice();
    const syms: number[] = [];
    let zeros = 0;
    const flush = () => {
      for (let r = zeros; r > 0;) {
        if (r & 1) {
          syms.push(0);
          r = (r - 1) / 2;
        } else {
          syms.push(1);
          r = (r - 2) / 2;
        }
      }
      zeros = 0;
    };
    for (const c of last) {
      const idx = mtf.indexOf(c);
      mtf.splice(idx, 1);
      mtf.unshift(c);
      if (idx === 0) zeros++;
      else {
        flush();
        syms.push(idx + 1);
      }
    }
    flush();
    const alphaSize = used.length + 2;
    syms.push(alphaSize - 1);

    const freqs = new Array<number>(alphaSize).fill(0);
    for (const x of syms) freqs[x]++;
    const lengths = (opts.lengths ?? huffmanLengths)(freqs, block);
    const codes = new Array<number>(alphaSize).fill(0);
    let code = 0;
    for (let l = 1; l <= 20; l++) {
      for (let x = 0; x < alphaSize; x++) if (lengths[x] === l) codes[x] = code++;
      code <<= 1;
    }

    w.put(24, 0x314159);
    w.put(24, 0x265359);
    w.put32((crc ^ (opts.crcXor?.(block) ?? 0)) | 0);
    w.put(1, opts.randomised ? 1 : 0);
    w.put(24, opts.origPtr ? opts.origPtr(realPtr, block) : realPtr);
    let groups = 0;
    for (const b of used) groups |= 0x8000 >>> (b >>> 4);
    w.put(16, groups);
    for (let g = 0; g < 16; g++) {
      if (!(groups & (0x8000 >>> g))) continue;
      let m = 0;
      for (const b of used) if (b >>> 4 === g) m |= 0x8000 >>> (b & 15);
      w.put(16, m);
    }
    const nSelectors = Math.ceil(syms.length / 50);
    w.put(3, 2);
    w.put(15, nSelectors);
    for (let k = 0; k < nSelectors; k++) w.put(1, 0);
    for (let t = 0; t < 2; t++) {
      let curr = lengths[0];
      w.put(5, curr);
      for (let x = 0; x < alphaSize; x++) {
        while (curr < lengths[x]) {
          w.put(2, 2);
          curr++;
        }
        while (curr > lengths[x]) {
          w.put(2, 3);
          curr--;
        }
        w.put(1, 0);
      }
    }
    for (const x of syms) w.put(lengths[x], codes[x]);
  }
  w.put(24, 0x177245);
  w.put(24, 0x385090);
  w.put32((combined ^ (opts.streamCrcXor ?? 0)) | 0);
  return w.finish();
}

/** One tar entry to write. */
export interface TarSpec {
  name: string;
  /** Type flag (default "0", a regular file). */
  type?: string;
  data?: Uint8Array | string;
  linkname?: string;
  /** Splits a long name into the ustar prefix field instead of putting it all in name. */
  prefix?: string;
  /** "ustar\0" + "00" (POSIX, default) or "ustar " + " \0" (GNU). */
  format?: "posix" | "gnu";
  mode?: number;
  /** Writes the size in GNU base-256. */
  base256?: boolean;
  /** XORed into the stored checksum. */
  checksumXor?: number;
}

const encoder = new TextEncoder();

function field(h: Uint8Array, off: number, len: number, value: string): void {
  const b = encoder.encode(value);
  if (b.length > len) throw new Error(`${JSON.stringify(value)} doesn't fit a ${len}-byte field`);
  h.set(b, off);
}

const octal = (v: number, len: number): string => v.toString(8).padStart(len - 1, "0");

/** One 512-byte tar header (and its data, padded) for `spec`. */
export function tarEntry(spec: TarSpec): Uint8Array {
  const data = typeof spec.data === "string" ? encoder.encode(spec.data) : (spec.data ?? new Uint8Array(0));
  const h = new Uint8Array(512);
  field(h, 0, 100, spec.name);
  field(h, 100, 8, octal(spec.mode ?? 0o644, 8));
  field(h, 108, 8, octal(1000, 8));
  field(h, 116, 8, octal(1000, 8));
  if (spec.base256) {
    h[124] = 0x80;
    let v = data.length;
    for (let i = 135; i > 124; i--) {
      h[i] = v % 256;
      v = Math.floor(v / 256);
    }
  } else field(h, 124, 12, octal(data.length, 12));
  field(h, 136, 12, octal(1_700_000_000, 12));
  h[156] = (spec.type ?? "0").charCodeAt(0);
  if (spec.type === "\0") h[156] = 0;
  field(h, 157, 100, spec.linkname ?? "");
  if (spec.format === "gnu") field(h, 257, 8, "ustar  ");
  else {
    field(h, 257, 6, "ustar");
    field(h, 263, 2, "00");
  }
  field(h, 265, 32, "ember");
  field(h, 297, 32, "ember");
  if (spec.prefix) field(h, 345, 155, spec.prefix);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const v of h) sum += v;
  field(h, 148, 8, `${octal(sum ^ (spec.checksumXor ?? 0), 7)}\0`);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  padded.set(h);
  padded.set(data, 512);
  return padded;
}

/** Recomputes the checksum of the header at the start of `entry` (after a test edited its bytes). */
export function withChecksum(entry: Uint8Array): Uint8Array {
  entry.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += entry[i];
  field(entry, 148, 8, `${octal(sum, 7)}\0`);
  return entry;
}

/** A pax extended header ('x') entry holding `records`. */
export function paxEntry(records: Record<string, string>, type = "x"): Uint8Array {
  let body = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let n = encoder.encode(rest).length;
    n += String(n + String(n).length).length;
    body += `${n}${rest}`;
  }
  return tarEntry({ name: "PaxHeaders/x", type, data: body });
}

/** A GNU long-name ('L') entry for the next header. */
export function longNameEntry(name: string, type = "L"): Uint8Array {
  return tarEntry({ name: "././@LongLink", type, data: `${name}\0`, format: "gnu" });
}

/** Concatenates entries and adds the end-of-archive marker (two zero blocks) unless `end` is false. */
export function tarArchive(parts: Uint8Array[], end = true): Uint8Array {
  const all = [...parts, ...(end ? [new Uint8Array(1024)] : [])];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Deterministic bytes: a small xorshift generator. */
export function prng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

/** Text-like bytes from a small vocabulary (compresses well, so multi-block fixtures stay small). */
export function wordsText(seed: number, bytes: number): Uint8Array {
  const words = ["ember", "voice", "model", "wake", "word", "listen", "speak", "quiet", "night", "light", "\n", "the", "a", "on"];
  const next = prng(seed);
  const out = new Uint8Array(bytes);
  let at = 0;
  while (at < bytes) {
    const w = encoder.encode(`${words[Math.floor(next() * words.length)]} `);
    out.set(w.subarray(0, Math.min(w.length, bytes - at)), at);
    at += w.length;
  }
  return out;
}

/** Random bytes. */
export function randomBytes(seed: number, bytes: number): Uint8Array {
  const next = prng(seed);
  return Uint8Array.from({ length: bytes }, () => Math.floor(next() * 256));
}

/** Bytes with runs of every length from 1 to `max` (the RLE1 step's edge cases) between random bytes. */
export function runsBytes(seed: number, max = 300): Uint8Array {
  const next = prng(seed);
  const out: number[] = [];
  for (let len = 1; len <= max; len++) {
    const b = Math.floor(next() * 256);
    for (let k = 0; k < len; k++) out.push(b);
    out.push((b + 1) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Feeds `data` in pieces of `size` bytes (an async source like a file stream). */
export async function* pieces(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.slice(i, i + size);
}

/** Collects an async byte source into one array. */
export async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of source) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
