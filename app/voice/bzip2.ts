/**
 * bzip2 decompression in TypeScript, so Ember unpacks its speech models the same way on Linux, Windows and
 * macOS without a system `bzip2` or `tar` (on Windows, `tar` may be Git's GNU tar, which has no bzip2, or an
 * old bsdtar). Every block's CRC, and each stream's combined CRC, is checked before any of its bytes are
 * passed on, so damaged input fails instead of producing a damaged model.
 *
 * bzip2 blocks are independent, so they are decoded in worker threads where possible: the models are about
 * 126 MB and bzip2 is slow (the reference C decoder manages about 8 MB/s on one core of a small cloud
 * machine), and the calling thread, which in Ember is Electron's main process, only scans for block
 * boundaries and stitches the results together. The block decoder is one self-contained function whose
 * source text is what the workers run, so the same code decodes in either place and no extra bundle entry
 * is needed. Without workers (or if one fails), blocks are decoded in the calling thread, yielding to the
 * event loop between blocks.
 */

import os from "node:os";
import { Worker } from "node:worker_threads";

/** One decoded block: where it ended (bit offset in the input given), its stored CRC and its pre-RLE1 length. */
export interface BlockHead {
  /** Bit offset just past the block. */
  end: number;
  /** The CRC the block says its output has. */
  crc: number;
  /** Bytes in `pre` (the block after the Burrows-Wheeler inversion, before the final run-length step). */
  n: number;
  /** The decoder's own buffer: valid until it decodes again. */
  pre: Uint8Array;
}

/** Where the final run-length expansion of a block is (so it can stop when its output buffer is full and resume). */
export interface UnrleState {
  n: number;
  i: number;
  last: number;
  same: number;
  left: number;
  runByte: number;
  crc: number;
  total: number;
}

/**
 * The block decoder. Self-contained: it refers to nothing outside its own body (only globals such as
 * Uint8Array), because its source text is what the worker threads run.
 */
export function bzip2Kernel() {
  const CRC = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    CRC[i] = c;
  }
  const MAX_GROUPS = 6;
  const MAX_ALPHA = 258;
  // bzip2 1.0.8 reads up to 32767 selectors but uses only the first 18002 (CVE-2019-12900).
  const MAX_SELECTORS = 18002;
  const MAX_CODE = 20;
  // Codes up to FAST bits long decode with one table lookup; longer ones (rare) take the slow path.
  const FAST = 10;
  const FAST_MASK = (1 << FAST) - 1;
  const LIMITS = MAX_CODE + 2;

  /** One block's buffers: tt[j] = (T[j] << 8) | L[j] and lf[i] = (LF[i] << 8) | L[i] (the inversion's links), and its output. */
  interface Slot { tt: Int32Array; lf: Int32Array; pre: Uint8Array }
  /** A block decoded as far as its inversion, links built. */
  interface Linked { end: number; crc: number; n: number; origPtr: number; slot: Slot }
  // Two sets, so a worker can invert two blocks at once.
  const slots: Slot[] = [0, 1].map(() => ({ tt: new Int32Array(0), lf: new Int32Array(0), pre: new Uint8Array(0) }));
  const lengths = new Uint8Array(MAX_GROUPS * MAX_ALPHA);
  const fast = new Int32Array(MAX_GROUPS << FAST);
  const limit = new Int32Array(MAX_GROUPS * LIMITS);
  const first = new Int32Array(MAX_GROUPS * LIMITS);
  const offset = new Int32Array(MAX_GROUPS * LIMITS);
  const perm = new Int32Array(MAX_GROUPS * MAX_ALPHA);
  const maxLens = new Int32Array(MAX_GROUPS);
  const selectors = new Uint8Array(MAX_SELECTORS);
  const seqToUnseq = new Uint8Array(256);
  const counts = new Int32Array(256);
  const mtfa = new Uint8Array(4096);
  const mtfbase = new Int32Array(16);
  const groupMtf = new Uint8Array(MAX_GROUPS);

  const fail = (what: string): never => {
    throw new Error(`bzip2 data is damaged: ${what}`);
  };
  /** Thrown inside decode() when the input ran out: whatever looked wrong was the zeros read past its end. */
  const TRUNCATED = new Error("truncated");

  /** Canonical Huffman tables for group `g` from its code lengths (bzip2's code assignment, checked for over-subscription). */
  function buildGroup(g: number, alphaSize: number, minLen: number, maxLen: number): void {
    const lo = g * MAX_ALPHA;
    const lim = g * LIMITS;
    const tbl = g << FAST;
    fast.fill(0, tbl, tbl + (1 << FAST));
    limit.fill(-1, lim, lim + LIMITS);
    let pp = 0;
    let code = 0;
    for (let len = minLen; len <= maxLen; len++) {
      first[lim + len] = code;
      offset[lim + len] = pp - code;
      for (let s = 0; s < alphaSize; s++) {
        if (lengths[lo + s] !== len) continue;
        perm[lo + pp++] = s;
        if (len <= FAST) {
          const from = tbl + (code << (FAST - len));
          fast.fill((len << 16) | s, from, from + (1 << (FAST - len)));
        }
        code++;
      }
      if (code > 1 << len) fail("an over-full Huffman table");
      limit[lim + len] = code - 1;
      code <<= 1;
    }
    maxLens[g] = maxLen;
  }

  /**
   * Decodes the block whose 48-bit magic starts at bit `start` of `src`, as far as the Burrows-Wheeler
   * inversion (the result is in `pre`). Returns null when `src` ends before the block does; throws on
   * damaged data. `maxBlock` is the stream's block size (100 000 x its level).
   */
  function decodeBlock(src: Uint8Array, start: number, maxBlock: number): BlockHead | null {
    try {
      return invert(decode(src, start, maxBlock, slots[0]));
    } catch (err) {
      if (err === TRUNCATED) return null;
      throw err;
    }
  }

  /**
   * Decodes two blocks and inverts them together (see invertTwo). Each result is the block, null when its
   * input ended first, or the error it hit (one bad block doesn't lose the other).
   */
  function decodeTwo(a: { src: Uint8Array; bit: number; maxBlock: number }, b: { src: Uint8Array; bit: number; maxBlock: number }): (BlockHead | null | Error)[] {
    const linked = [a, b].map((x, k): Linked | null | Error => {
      try {
        return decode(x.src, x.bit, x.maxBlock, slots[k]);
      } catch (err) {
        return err === TRUNCATED ? null : err instanceof Error ? err : new Error(String(err));
      }
    });
    const ok = (l: Linked | null | Error): l is Linked => l !== null && !(l instanceof Error);
    const [la, lb] = linked;
    if (ok(la) && ok(lb)) return invertTwo(la, lb);
    return linked.map(l => (ok(l) ? invert(l) : l));
  }

  function decode(src: Uint8Array, start: number, maxBlock: number, slot: Slot): Linked {
    const len = src.length;
    const bitsIn = len * 8;
    if (slot.tt.length < maxBlock) {
      slot.tt = new Int32Array(maxBlock);
      slot.lf = new Int32Array(maxBlock);
      slot.pre = new Uint8Array(maxBlock);
    }
    // Plain locals for the hot loops: closure variables are reloaded from the heap on every use.
    const T = slot.tt;
    const LF = slot.lf;
    const table = fast;
    const mtf = mtfa;
    const mbase = mtfbase;
    const count = counts;
    let pos = start >>> 3;
    let buf = 0;
    let cnt = 0;
    if (start & 7) {
      buf = pos < len ? src[pos] : 0;
      pos++;
      cnt = 8 - (start & 7);
    }
    const bits = (n: number): number => {
      while (cnt < n) {
        buf = (buf << 8) | (pos < len ? src[pos] : 0);
        pos++;
        cnt += 8;
      }
      cnt -= n;
      return (buf >>> cnt) & ((1 << n) - 1);
    };
    // Past the end of the input every bit reads as zero, which can look like any kind of damage: that is
    // a block cut short (the caller may have more input), not a damaged one.
    const over = (): boolean => pos * 8 - cnt > bitsIn;
    const bad = (what: string): never => {
      throw over() ? TRUNCATED : new Error(`bzip2 data is damaged: ${what}`);
    };

    if (bits(24) !== 0x314159 || bits(24) !== 0x265359) bad("a block doesn't start where one should");
    const crc = ((bits(16) << 16) | bits(16)) | 0;
    if (bits(1)) throw new Error("bzip2 data uses randomised blocks (bzip2 0.9.0 and older), which aren't supported");
    const origPtr = bits(24);
    if (origPtr >= maxBlock) bad("the block's start pointer is out of range");

    // The bytes the block uses: 16 groups of 16.
    const used = bits(16);
    let nInUse = 0;
    for (let i = 0; i < 16; i++) {
      if (!(used & (0x8000 >>> i))) continue;
      const m = bits(16);
      for (let j = 0; j < 16; j++) if (m & (0x8000 >>> j)) seqToUnseq[nInUse++] = (i << 4) | j;
    }
    if (nInUse === 0) bad("a block uses no bytes");
    const alphaSize = nInUse + 2;

    const nGroups = bits(3);
    if (nGroups < 2 || nGroups > MAX_GROUPS) bad("the number of Huffman tables is out of range");
    const nSelectors = bits(15);
    if (nSelectors < 1) bad("a block has no selectors");
    for (let g = 0; g < nGroups; g++) groupMtf[g] = g;
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (bits(1)) if (++j >= nGroups) bad("a selector is out of range");
      const v = groupMtf[j];
      for (; j > 0; j--) groupMtf[j] = groupMtf[j - 1];
      groupMtf[0] = v;
      if (i < MAX_SELECTORS) selectors[i] = v;
      if (over()) throw TRUNCATED;
    }
    const usedSelectors = Math.min(nSelectors, MAX_SELECTORS);

    for (let g = 0; g < nGroups; g++) {
      let curr = bits(5);
      let minLen = MAX_CODE;
      let maxLen = 0;
      const lo = g * MAX_ALPHA;
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (curr < 1 || curr > MAX_CODE) bad("a Huffman code length is out of range");
          if (!bits(1)) break;
          curr += bits(1) ? -1 : 1;
        }
        lengths[lo + s] = curr;
        if (curr < minLen) minLen = curr;
        if (curr > maxLen) maxLen = curr;
      }
      if (over()) throw TRUNCATED;
      buildGroup(g, alphaSize, minLen, maxLen);
    }

    // Move-to-front over the block's bytes, in bzip2's 16 x 16 layout (a shift costs at most ~30 moves).
    for (let ii = 15, kk = 4095; ii >= 0; ii--) {
      for (let jj = 15; jj >= 0; jj--, kk--) mtf[kk] = seqToUnseq[(ii << 4) | jj];
      mbase[ii] = kk + 1;
    }
    count.fill(0);
    const eob = nInUse + 1;
    let nblock = 0;
    let groupLeft = 0;
    let sel = 0;
    let tbl = 0;
    let lim = 0;
    let lo = 0;
    let gmax = 0;
    let run = 0;
    let runWeight = 0;
    // The bit reader's state in plain locals for the hot loop (closure variables would live on the heap).
    let b = buf;
    let c = cnt;
    let p = pos;
    for (;;) {
      if (groupLeft === 0) {
        pos = p;
        cnt = c;
        if (over()) throw TRUNCATED;
        if (sel >= usedSelectors) bad("a block has more symbols than selectors");
        const g = selectors[sel++];
        groupLeft = 50;
        tbl = g << FAST;
        lim = g * LIMITS;
        lo = g * MAX_ALPHA;
        gmax = maxLens[g];
      }
      groupLeft--;
      while (c < MAX_CODE) {
        b = (b << 8) | (p < len ? src[p] : 0);
        p++;
        c += 8;
      }
      const e = table[tbl + ((b >>> (c - FAST)) & FAST_MASK)];
      let sym: number;
      if (e !== 0) {
        c -= e >>> 16;
        sym = e & 0xffff;
      } else {
        const v = (b >>> (c - MAX_CODE)) & 0xfffff;
        let n = FAST + 1;
        for (; n <= gmax; n++) {
          const code = v >>> (MAX_CODE - n);
          if (code <= limit[lim + n]) {
            if (code < first[lim + n]) {
              pos = p;
              cnt = c;
              bad("a Huffman code is invalid");
            }
            break;
          }
        }
        if (n > gmax) {
          pos = p;
          cnt = c - n;
          bad("a Huffman code is invalid");
        }
        c -= n;
        sym = perm[lo + (v >>> (MAX_CODE - n)) + offset[lim + n]];
      }
      if (sym <= 1) {
        // RUNA (0) and RUNB (1) spell a run of the front byte in bijective base 2.
        if (runWeight === 0) {
          runWeight = 1;
          run = 0;
        }
        run += runWeight << sym;
        runWeight <<= 1;
        if (run > maxBlock) {
          pos = p;
          cnt = c;
          bad("a run is longer than the block");
        }
        continue;
      }
      if (runWeight !== 0) {
        if (nblock + run > maxBlock) {
          pos = p;
          cnt = c;
          bad("a block is longer than its stream allows");
        }
        const uc = mtf[mbase[0]];
        count[uc] += run;
        T.fill(uc, nblock, nblock + run);
        nblock += run;
        runWeight = 0;
      }
      if (sym === eob) break;
      if (nblock >= maxBlock) {
        pos = p;
        cnt = c;
        bad("a block is longer than its stream allows");
      }
      let nn = sym - 1;
      let uc: number;
      if (nn < 16) {
        const pp = mbase[0];
        let z = pp + nn;
        uc = mtf[z];
        while (nn > 3) {
          mtf[z] = mtf[z - 1];
          mtf[z - 1] = mtf[z - 2];
          mtf[z - 2] = mtf[z - 3];
          mtf[z - 3] = mtf[z - 4];
          z -= 4;
          nn -= 4;
        }
        while (nn > 0) {
          mtf[z] = mtf[z - 1];
          z--;
          nn--;
        }
        mtf[pp] = uc;
      } else {
        let lno = nn >>> 4;
        const head = mbase[lno];
        let pp = head + (nn & 15);
        uc = mtf[pp];
        while (pp - head > 3) {
          mtf[pp] = mtf[pp - 1];
          mtf[pp - 1] = mtf[pp - 2];
          mtf[pp - 2] = mtf[pp - 3];
          mtf[pp - 3] = mtf[pp - 4];
          pp -= 4;
        }
        while (pp > head) {
          mtf[pp] = mtf[pp - 1];
          pp--;
        }
        // Each list in front of it gives its last byte to the next list and starts one place earlier.
        let below = head + 1;
        while (lno > 0) {
          const front = mbase[lno - 1];
          below--;
          mtf[below] = mtf[front + 15];
          mbase[lno] = below;
          below = front;
          lno--;
        }
        const top = mbase[0] - 1;
        mbase[0] = top;
        mtf[top] = uc;
        if (top === 0) {
          for (let ii = 15, kk = 4095; ii >= 0; ii--) {
            for (let jj = 15; jj >= 0; jj--, kk--) mtf[kk] = mtf[mbase[ii] + jj];
            mbase[ii] = kk + 1;
          }
        }
      }
      count[uc]++;
      T[nblock++] = uc;
    }
    pos = p;
    cnt = c;
    if (over()) throw TRUNCATED;
    if (origPtr >= nblock) bad("the block's start pointer is out of range");

    // The Burrows-Wheeler inversion's links: T takes each row to the next, LF to the previous.
    for (let i = 0, sum = 0; i < 256; i++) {
      const k = count[i];
      count[i] = sum;
      sum += k;
    }
    for (let i = 0; i < nblock; i++) {
      const uc = T[i] & 0xff;
      const j = count[uc]++;
      T[j] |= i << 8;
      LF[i] = (j << 8) | uc;
    }
    return { end: p * 8 - c, crc, n: nblock, origPtr, slot };
  }

  /**
   * Walks a block's links into its output. The walk is bound by cache misses, so it goes both ways at once,
   * filling the output from both ends: two independent chains of loads that the CPU overlaps.
   */
  function invert(b: Linked): BlockHead {
    const T = b.slot.tt;
    const LF = b.slot.lf;
    const out = b.slot.pre;
    const n = b.n;
    let f = T[b.origPtr] >>> 8;
    let r = b.origPtr;
    const half = n >>> 1;
    for (let k = 0, back = n - 1; k < half; k++, back--) {
      const x = T[f];
      const y = LF[r];
      out[k] = x & 0xff;
      out[back] = y & 0xff;
      f = x >>> 8;
      r = y >>> 8;
    }
    if (n & 1) out[half] = LF[r] & 0xff;
    return { end: b.end, crc: b.crc, n, pre: out };
  }

  /** Walks two blocks' links together: four chains of cache misses overlap instead of two (about 40% faster). */
  function invertTwo(a: Linked, b: Linked): BlockHead[] {
    const TA = a.slot.tt;
    const LA = a.slot.lf;
    const OA = a.slot.pre;
    const TB = b.slot.tt;
    const LB = b.slot.lf;
    const OB = b.slot.pre;
    let fa = TA[a.origPtr] >>> 8;
    let ra = a.origPtr;
    let fb = TB[b.origPtr] >>> 8;
    let rb = b.origPtr;
    const ha = a.n >>> 1;
    const hb = b.n >>> 1;
    const both = Math.min(ha, hb);
    let k = 0;
    for (let backA = a.n - 1, backB = b.n - 1; k < both; k++, backA--, backB--) {
      const x = TA[fa];
      const y = LA[ra];
      const u = TB[fb];
      const v = LB[rb];
      OA[k] = x & 0xff;
      OA[backA] = y & 0xff;
      OB[k] = u & 0xff;
      OB[backB] = v & 0xff;
      fa = x >>> 8;
      ra = y >>> 8;
      fb = u >>> 8;
      rb = v >>> 8;
    }
    // The longer block's rest, alone.
    for (let j = k; j < ha; j++) {
      const x = TA[fa];
      const y = LA[ra];
      OA[j] = x & 0xff;
      OA[a.n - 1 - j] = y & 0xff;
      fa = x >>> 8;
      ra = y >>> 8;
    }
    for (let j = k; j < hb; j++) {
      const u = TB[fb];
      const v = LB[rb];
      OB[j] = u & 0xff;
      OB[b.n - 1 - j] = v & 0xff;
      fb = u >>> 8;
      rb = v >>> 8;
    }
    if (a.n & 1) OA[ha] = LA[ra] & 0xff;
    if (b.n & 1) OB[hb] = LB[rb] & 0xff;
    return [
      { end: a.end, crc: a.crc, n: a.n, pre: OA },
      { end: b.end, crc: b.crc, n: b.n, pre: OB },
    ];
  }

  /** A fresh expansion state for a block of `n` pre-RLE1 bytes. */
  function unrleStart(n: number): UnrleState {
    return { n, i: 0, last: -1, same: 0, left: 0, runByte: 0, crc: -1, total: 0 };
  }

  /**
   * The final run-length step: four equal bytes are followed by a count of further copies. Writes into
   * `out` from `at` until it is full or the block is done (`out` null: only counts and checksums) and
   * returns where it stopped. `check` keeps the running CRC.
   */
  function unrle(src: Uint8Array, st: UnrleState, out: Uint8Array | null, at: number, check: boolean): number {
    const n = st.n;
    const end = out ? out.length : 0;
    let i = st.i;
    let last = st.last;
    let same = st.same;
    let left = st.left;
    let runByte = st.runByte;
    let crc = st.crc;
    let total = st.total;
    outer: for (;;) {
      if (left > 0) {
        let k = left;
        if (out) {
          if (end - at < k) k = end - at;
          out.fill(runByte, at, at + k);
          at += k;
        }
        if (check) for (let j = 0; j < k; j++) crc = (crc << 8) ^ CRC[(crc >>> 24) ^ runByte];
        left -= k;
        total += k;
        if (left > 0) break;
      }
      // Literal bytes, the common case, until a fourth equal byte (then a count) or the end of the block or of `out`.
      if (out) {
        for (;;) {
          if (i >= n || at >= end) break outer;
          const v = src[i++];
          if (same === 4) {
            left = v;
            runByte = last;
            last = -1;
            same = 0;
            continue outer;
          }
          if (v === last) same++;
          else {
            last = v;
            same = 1;
          }
          out[at++] = v;
          if (check) crc = (crc << 8) ^ CRC[(crc >>> 24) ^ v];
          total++;
        }
      }
      for (;;) {
        if (i >= n) break outer;
        const v = src[i++];
        if (same === 4) {
          left = v;
          runByte = last;
          last = -1;
          same = 0;
          continue outer;
        }
        if (v === last) same++;
        else {
          last = v;
          same = 1;
        }
        if (check) crc = (crc << 8) ^ CRC[(crc >>> 24) ^ v];
        total++;
      }
    }
    st.i = i;
    st.last = last;
    st.same = same;
    st.left = left;
    st.runByte = runByte;
    st.crc = crc;
    st.total = total;
    return at;
  }

  /** True once the expansion has produced everything. */
  const unrleDone = (st: UnrleState): boolean => st.i >= st.n && st.left === 0;

  /**
   * Expands a decoded block and checks its CRC (throws on a mismatch). Returns the output when it is at most
   * `cap` bytes; otherwise null, and the caller expands `pre` in pieces (already checked).
   */
  function finish(head: BlockHead, cap: number): Uint8Array | null {
    const st = unrleStart(head.n);
    const guess = Math.min(cap, head.n + (head.n >>> 2) + 1024);
    const out = new Uint8Array(guess);
    const at = unrle(head.pre, st, out, 0, true);
    const whole = unrleDone(st);
    if (!whole) unrle(head.pre, st, null, 0, true);
    if (~st.crc !== head.crc) fail("a block's CRC doesn't match");
    if (whole) return out.subarray(0, at);
    if (st.total > cap) return null;
    const exact = new Uint8Array(st.total);
    unrle(head.pre, unrleStart(head.n), exact, 0, false);
    return exact;
  }

  return { decodeBlock, decodeTwo, unrleStart, unrle, unrleDone, finish };
}

export type Bzip2Kernel = ReturnType<typeof bzip2Kernel>;

/** Block magic (pi) and end-of-stream magic (sqrt pi), as 48-bit numbers. */
const BLOCK_MAGIC = 0x314159265359;
const END_MAGIC = 0x177245385090;
/**
 * The most bytes a valid block can take: its header, 32767 selectors, six code-length tables and 900 001
 * symbols of at most 20 bits (about 2.28 MB). A block that runs past this is treated as damaged.
 */
export const MAX_BLOCK_BYTES = 2_300_000;
/** A block whose output is larger than this (long runs) is passed back unexpanded and expanded in pieces. */
const OUTPUT_CAP = 4 << 20;
/** Pieces in which such a block is expanded. */
const PIECE = 1 << 20;

/** Where blocks were decoded, for checks and diagnostics (bunzip2 adds to it). */
export interface Bunzip2Stats {
  workerBlocks: number;
  threadBlocks: number;
  /** Why the workers stopped being used, if they did. */
  workerFailure?: string;
}

/** Options for {@link bunzip2}. */
export interface Bunzip2Options {
  /** Worker threads to decode blocks in (default: up to 4, one per spare core). 0 decodes in this thread. */
  workers?: number;
  /** Stop with an error once more than this many bytes have come out (default: no limit). */
  maxBytes?: number;
  /** Counts where blocks were decoded. */
  stats?: Bunzip2Stats;
  /** Tests only: replace the block-boundary scan (to add false boundaries) or the workers' program (to break them). */
  testing?: { findBlocks?: (bytes: Uint8Array) => number[]; workerSource?: string };
}

/** The default number of decoding workers: one per core but one, between 1 and 4. */
export function defaultWorkers(): number {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * Bytes read from the source, kept from the block being assembled onwards. Offsets are absolute; the
 * bytes held are buf[head..tail), and forgotten ones are only reclaimed when room is needed.
 */
class Input {
  private buf = new Uint8Array(1 << 22);
  private head = 0;
  private tail = 0;
  /** Absolute offset of buf[head]. */
  private base = 0;
  eof = false;
  private readonly it: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]();
  }

  /** Absolute offset of the first byte still held. */
  get start(): number {
    return this.base;
  }

  /** Absolute offset just past the last byte read. */
  get end(): number {
    return this.base + this.tail - this.head;
  }

  /** Reads one more chunk; false at the end of the source. */
  async more(): Promise<boolean> {
    if (this.eof) return false;
    for (;;) {
      const r = await this.it.next();
      if (r.done) {
        this.eof = true;
        return false;
      }
      const chunk = r.value;
      if (!chunk.length) continue;
      if (this.tail + chunk.length > this.buf.length) {
        const held = this.tail - this.head;
        const target = held + chunk.length > this.buf.length ? new Uint8Array(Math.max(this.buf.length * 2, held + chunk.length)) : this.buf;
        target.set(this.buf.subarray(this.head, this.tail));
        this.buf = target;
        this.head = 0;
        this.tail = held;
      }
      this.buf.set(chunk, this.tail);
      this.tail += chunk.length;
      return true;
    }
  }

  /** Reads until bytes up to absolute offset `upTo` are in (or the source ends); true if they are. */
  async need(upTo: number): Promise<boolean> {
    while (this.end < upTo) if (!(await this.more())) return false;
    return true;
  }

  /** Forgets bytes before absolute offset `from`. */
  drop(from: number): void {
    const k = Math.min(from - this.base, this.tail - this.head);
    if (k <= 0) return;
    this.head += k;
    this.base += k;
  }

  /** The bytes between two absolute offsets (a view: valid until the next read). */
  view(from: number, to: number): Uint8Array {
    return this.buf.subarray(this.head + from - this.base, this.head + Math.min(to, this.end) - this.base);
  }

  /** `n` (at most 32) bits at absolute bit offset `bit`, as an unsigned number; the bytes must be in. */
  bits(bit: number, n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const at = bit + k;
      const byte = this.buf[this.head + Math.floor(at / 8) - this.base];
      v = v * 2 + ((byte >>> (7 - (at % 8))) & 1);
    }
    return v;
  }
}

/** Finds every bit offset in `bytes` (from byte `from`) where the 48-bit block magic starts. */
export function findBlockMagic(bytes: Uint8Array, from = 0): number[] {
  const found: number[] = [];
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const hi = Math.floor(BLOCK_MAGIC / 2 ** 24);
  const lo = BLOCK_MAGIC % 2 ** 24;
  for (let s = 0; s < 8; s++) {
    // The magic at bit offset s spans 7 bytes (6 when s is 0); the bytes it covers fully make the needle.
    const p = new Uint8Array(7);
    for (let k = 0; k < 48; k++) {
      const bit = k < 24 ? (hi >>> (23 - k)) & 1 : (lo >>> (47 - k)) & 1;
      if (bit) p[(k + s) >>> 3] |= 0x80 >>> ((k + s) & 7);
    }
    const lead = s ? 1 : 0;
    const needle = Buffer.from(p.subarray(lead, 6));
    const headMask = s ? 0xff >>> s : 0;
    const tailMask = s ? (0xff << (8 - s)) & 0xff : 0;
    for (let h = view.indexOf(needle, from + lead); h !== -1; h = view.indexOf(needle, h + 1)) {
      const at = h - lead;
      if (s) {
        if (at < 0 || at + 6 >= bytes.length) continue;
        if ((bytes[at] & headMask) !== p[0] || (bytes[at + 6] & tailMask) !== p[6]) continue;
      }
      found.push(at * 8 + s);
    }
  }
  return found.sort((a, b) => a - b);
}

/** What a block decode in a worker (or this thread) produced. */
type BlockResult =
  | { kind: "block"; end: number; crc: number; n: number; out?: Uint8Array; pre?: Uint8Array }
  | { kind: "truncated" }
  | { kind: "error"; message: string }
  | { kind: "worker-failed"; message: string };

interface BlockTask {
  id: number;
  src: Uint8Array;
  bit: number;
  maxBlock: number;
  cap: number;
}

/** The worker's whole program: the kernel's source plus a message loop. A message is one task or a pair. */
const WORKER_SOURCE = `"use strict";
const { parentPort } = require("node:worker_threads");
const kernel = (${bzip2Kernel.toString()})();
const reply = (task, head) => {
  try {
    if (head instanceof Error) throw head;
    if (!head) return parentPort.postMessage({ id: task.id, kind: "truncated" });
    const out = kernel.finish(head, task.cap);
    if (out) return parentPort.postMessage({ id: task.id, kind: "block", end: head.end, crc: head.crc, n: head.n, out }, [out.buffer]);
    const pre = head.pre.slice(0, head.n);
    parentPort.postMessage({ id: task.id, kind: "block", end: head.end, crc: head.crc, n: head.n, pre }, [pre.buffer]);
  } catch (err) {
    parentPort.postMessage({ id: task.id, kind: "error", message: String(err && err.message || err) });
  }
};
parentPort.on("message", job => {
  if (Array.isArray(job)) {
    const heads = kernel.decodeTwo(job[0], job[1]);
    job.forEach((task, k) => reply(task, heads[k]));
    return;
  }
  let head;
  try {
    head = kernel.decodeBlock(job.src, job.bit, job.maxBlock);
  } catch (err) {
    head = err instanceof Error ? err : new Error(String(err));
  }
  reply(job, head);
});
`;

/** Worker threads that decode blocks; a worker that dies fails its tasks with "worker-failed". */
class BlockPool {
  private readonly idle: Worker[] = [];
  private readonly all: Worker[] = [];
  private readonly queue: BlockTask[] = [];
  private readonly waiting = new Map<number, (r: BlockResult) => void>();
  private readonly busy = new Map<Worker, number[]>();
  private closing = false;
  broken = false;

  constructor(n: number, source: string) {
    for (let k = 0; k < n; k++) {
      let w: Worker;
      try {
        w = new Worker(source, { eval: true });
      } catch (err) {
        // Out of threads part-way: carry on with the workers there are (none: the caller decodes itself).
        if (!this.all.length) throw err;
        break;
      }
      w.on("message", (r: BlockResult & { id: number }) => {
        const left = (this.busy.get(w) ?? []).filter(id => id !== r.id);
        this.settle(r.id, r);
        if (left.length) {
          this.busy.set(w, left);
          return;
        }
        this.busy.delete(w);
        this.idle.push(w);
        this.next();
      });
      const lost = (why: string) => {
        this.broken = true;
        const ids = this.busy.get(w) ?? [];
        this.busy.delete(w);
        for (const id of ids) this.settle(id, { kind: "worker-failed", message: why });
        // Everything still queued fails too: the caller decodes it in its own thread.
        for (const t of this.queue.splice(0)) this.settle(t.id, { kind: "worker-failed", message: why });
      };
      w.on("error", err => lost(err.message));
      w.on("exit", code => { if (!this.closing) lost(`a decoding worker exited (${code})`); });
      this.all.push(w);
      this.idle.push(w);
    }
  }

  private settle(id: number, r: BlockResult): void {
    const done = this.waiting.get(id);
    this.waiting.delete(id);
    done?.(r);
  }

  private next(): void {
    while (this.idle.length && this.queue.length && !this.broken) {
      const w = this.idle.pop()!;
      // Two blocks at a time once there's enough work for every idle worker to take two (see invertTwo).
      const job = this.queue.splice(0, this.queue.length >= 2 * (this.idle.length + 1) ? 2 : 1);
      this.busy.set(w, job.map(t => t.id));
      w.postMessage(job.length === 1 ? job[0] : job, job.map(t => t.src.buffer as ArrayBuffer));
    }
  }

  run(task: BlockTask): Promise<BlockResult> {
    if (this.broken) return Promise.resolve({ kind: "worker-failed", message: "the decoding workers stopped" });
    return new Promise(resolve => {
      this.waiting.set(task.id, resolve);
      this.queue.push(task);
      this.next();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.all.map(w => w.terminate().catch(() => 0)));
  }
}

/** Starts a pool, or returns null when worker threads aren't available here. */
function openPool(n: number, source: string): BlockPool | null {
  if (n <= 0) return null;
  try {
    return new BlockPool(n, source);
  } catch {
    // No worker threads (or eval'd workers are refused): blocks are decoded in this thread instead.
    return null;
  }
}

/**
 * Decompresses a .bz2 byte stream (one or more concatenated bzip2 streams), yielding the output in order.
 * Each block is passed on only after its CRC matched, and the stream's combined CRC is checked at its end;
 * damaged, truncated or trailing data throws.
 */
export async function* bunzip2(source: AsyncIterable<Uint8Array>, options: Bunzip2Options = {}): AsyncGenerator<Uint8Array> {
  const input = new Input(source);
  const kernel = bzip2Kernel();
  const maxBytes = options.maxBytes ?? Infinity;
  const workers = options.workers ?? defaultWorkers();
  let pool = openPool(workers, options.testing?.workerSource ?? WORKER_SOURCE);
  const findBlocks = options.testing?.findBlocks ?? findBlockMagic;
  // Decodes under way, keyed by the bit offset they start at, with the input they were given (up to `to`).
  const tasks = new Map<number, { p: Promise<BlockResult>; to: number }>();
  // Block-magic offsets found but not yet started, ascending; scanned is how far the scan has got (bytes).
  let candidates: number[] = [];
  let scanned = 0;
  let lastCandidate = -1;
  let nextId = 0;
  let produced = 0;
  // Decodes under way or done but not yet used: four per worker keeps them busy (taking two at a time) and
  // bounds the memory held (about 1.7 MB each).
  const limit = 4 * workers;

  /** Scans newly read input for block magic. */
  const scan = (): void => {
    const from = Math.max(input.start, scanned - 7);
    const view = input.view(from, input.end);
    for (const bit of findBlocks(view)) {
      const abs = from * 8 + bit;
      if (abs > lastCandidate) {
        candidates.push(abs);
        lastCandidate = abs;
      }
    }
    scanned = input.end;
  };

  /** Starts a decode of the block at absolute bit `at`, with input up to absolute byte `to`. */
  const start = (at: number, to: number, maxBlock: number): Promise<BlockResult> => {
    const from = Math.floor(at / 8);
    to = Math.min(to, input.end);
    const src = input.view(from, to).slice();
    const task: BlockTask = { id: nextId++, src, bit: at % 8, maxBlock, cap: OUTPUT_CAP };
    const p = pool!.run(task).then((r): BlockResult => (r.kind === "block" ? { ...r, end: from * 8 + r.end } : r));
    tasks.set(at, { p, to });
    return p;
  };

  /** Keeps the workers busy with the blocks ahead of `head`, reading ahead as far as that needs. */
  const pump = async (head: number): Promise<void> => {
    candidates = candidates.filter(c => c >= head && !tasks.has(c));
    while (pool && !pool.broken && tasks.size < limit) {
      if (!candidates.length) {
        if (input.end - Math.floor(head / 8) > 16 * MAX_BLOCK_BYTES || !(await input.more())) return;
        scan();
        continue;
      }
      const c = candidates[0];
      const cByte = Math.floor(c / 8);
      // Its decode needs input up to the next block's start (or the most a block can take).
      let to: number;
      if (candidates.length > 1) to = Math.floor(candidates[1] / 8) + 8;
      else if (input.eof || input.end >= cByte + MAX_BLOCK_BYTES) to = Math.min(input.end, cByte + MAX_BLOCK_BYTES);
      else {
        await input.more();
        scan();
        continue;
      }
      candidates.shift();
      start(c, to, 900_000);
    }
  };

  /** The block at absolute bit `at`, decoded (by a worker when there are any). */
  const blockAt = async (at: number, maxBlock: number): Promise<Extract<BlockResult, { kind: "block" }>> => {
    let r: BlockResult | undefined;
    const full = Math.floor(at / 8) + MAX_BLOCK_BYTES;
    if (pool && !pool.broken) {
      await pump(at);
      let task = tasks.get(at);
      if (!task) {
        await input.need(full);
        start(at, full, maxBlock);
        task = tasks.get(at)!;
      }
      r = await task.p;
      tasks.delete(at);
      if (r.kind === "truncated" && task.to < Math.min(full, input.end)) {
        // Its input stopped at a false block boundary (the magic occurring by chance inside it): retry with all it could need.
        await input.need(full);
        r = await start(at, full, maxBlock);
        tasks.delete(at);
      }
      if (r.kind === "worker-failed") {
        if (options.stats) options.stats.workerFailure = r.message;
        await pool.close();
        pool = null;
        tasks.clear();
        r = undefined;
      }
    }
    if (r && options.stats) options.stats.workerBlocks++;
    if (!r) {
      if (options.stats) options.stats.threadBlocks++;
      // In this thread: let the event loop run between blocks.
      await new Promise<void>(resolve => setImmediate(resolve));
      await input.need(full);
      const from = Math.floor(at / 8);
      const head = kernel.decodeBlock(input.view(from, full), at % 8, maxBlock);
      if (!head) r = { kind: "truncated" };
      else {
        const out = kernel.finish(head, OUTPUT_CAP);
        r = { kind: "block", end: from * 8 + head.end, crc: head.crc, n: head.n, ...(out ? { out } : { pre: head.pre.slice(0, head.n) }) };
      }
    }
    if (r.kind === "truncated") throw new Error("bzip2 data is truncated (it ends inside a block)");
    if (r.kind !== "block") throw new Error(r.message);
    if (r.n > maxBlock) throw new Error("bzip2 data is damaged: a block is longer than its stream allows");
    // Decodes that started inside this block began at a false boundary: forget them.
    for (const k of [...tasks.keys()]) if (k < r.end) tasks.delete(k);
    return r;
  };

  const count = (k: number): void => {
    produced += k;
    if (produced > maxBytes) throw new Error(`bzip2 data expands to more than ${maxBytes} bytes`);
  };

  try {
    let at = 0;
    let streams = 0;
    for (;;) {
      const byte = at / 8;
      if (!(await input.need(byte + 4))) {
        if (streams > 0 && input.end === byte) return;
        throw new Error(streams ? "bzip2 data has trailing bytes that aren't a stream" : "this isn't bzip2 data (it's too short)");
      }
      const h = input.view(byte, byte + 4);
      if (h[0] !== 0x42 || h[1] !== 0x5a || h[2] !== 0x68 || h[3] < 0x31 || h[3] > 0x39) {
        throw new Error(streams ? "bzip2 data has trailing bytes that aren't a stream" : "this isn't bzip2 data (no BZh header)");
      }
      const maxBlock = (h[3] - 0x30) * 100_000;
      at += 32;
      let combined = 0;
      for (;;) {
        if (!(await input.need(Math.ceil((at + 48) / 8)))) throw new Error("bzip2 data is truncated");
        const magic = input.bits(at, 48);
        if (magic === END_MAGIC) {
          if (!(await input.need(Math.ceil((at + 80) / 8)))) throw new Error("bzip2 data is truncated");
          if (input.bits(at + 48, 32) !== combined >>> 0) throw new Error("bzip2 data is damaged: the stream's CRC doesn't match");
          at = Math.ceil((at + 80) / 8) * 8;
          break;
        }
        if (magic !== BLOCK_MAGIC) throw new Error("bzip2 data is damaged: a block doesn't start where one should");
        const r = await blockAt(at, maxBlock);
        combined = (((combined << 1) | (combined >>> 31)) ^ r.crc) | 0;
        if (r.out) {
          count(r.out.length);
          yield r.out;
        } else {
          const st = kernel.unrleStart(r.n);
          while (!kernel.unrleDone(st)) {
            const piece = new Uint8Array(PIECE);
            const k = kernel.unrle(r.pre!, st, piece, 0, false);
            count(k);
            yield piece.subarray(0, k);
          }
        }
        at = r.end;
        input.drop(Math.floor(at / 8));
      }
      streams++;
      input.drop(at / 8);
    }
  } finally {
    await pool?.close();
  }
}
