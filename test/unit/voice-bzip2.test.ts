/**
 * The in-process bzip2 decoder that unpacks the speech models (app/voice/bzip2.ts): real bzip2 output (the
 * committed fixtures in test/fixtures/voice-archive, made with bzip2 1.0.8, and the system bzip2 where there
 * is one), and streams built in the test (many blocks, 20-bit codes, damage), decoded in worker threads and
 * in this thread, fed in awkward pieces.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bunzip2, bzip2Kernel, findBlockMagic, type BlockHead, type Bunzip2Options, type Bunzip2Stats } from "../../app/voice/bzip2";
import { bzip2Compress, collect, flatLengths, pieces, prng, randomBytes, runsBytes, wordsText } from "../fixtures/voice-archive/make";

const fixture = (name: string): Uint8Array => fs.readFileSync(path.resolve("test/fixtures/voice-archive", name));
const decode = (data: Uint8Array, options: Bunzip2Options = {}, size = 64 * 1024) => collect(bunzip2(pieces(data, size), options));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const systemBzip2 = (() => {
  try {
    execFileSync("bzip2", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    // No bzip2 installed (Windows): the committed fixtures still cover real bzip2 output.
    return false;
  }
})();

/** Everything a decode yields before it fails, and the error. */
async function untilError(data: Uint8Array, options: Bunzip2Options = {}): Promise<{ got: Uint8Array; error: Error | null }> {
  const parts: Uint8Array[] = [];
  let error: Error | null = null;
  try {
    for await (const p of bunzip2(pieces(data, 4096), options)) parts.push(p);
  } catch (err) {
    error = err as Error;
  }
  return { got: Buffer.concat(parts), error };
}

/** A complete prefix code with lengths 1, 2, ... 20, 20 by frequency rank: needs exactly 21 symbols. */
const deepLengths = (freqs: number[]): number[] => {
  const order = freqs.map((_, s) => s).sort((a, b) => freqs[b] - freqs[a]);
  const lengths: number[] = [];
  order.forEach((s, rank) => (lengths[s] = Math.min(rank + 1, 20)));
  return lengths;
};

describe("bunzip2 on real bzip2 output", () => {
  for (const workers of [0, 3]) {
    it(`decodes a four-block stream (bzip2 -1) to the exact bytes (${workers} workers)`, async () => {
      const data = fixture("words-l1.bz2");
      expect(findBlockMagic(data).length).toBeGreaterThanOrEqual(4);
      expect(same(await decode(data, { workers }), wordsText(1, 350_000))).toBe(true);
    });
  }

  it("decodes random bytes (every byte value, long codes, deep move-to-front)", async () => {
    expect(same(await decode(fixture("random.bz2"), { workers: 2 }), randomBytes(2, 30_000))).toBe(true);
  });

  it("decodes runs of every length from 1 to 300 (the final run-length step's edge cases)", async () => {
    expect(same(await decode(fixture("runs.bz2"), { workers: 0 }), runsBytes(3, 300))).toBe(true);
  });

  it("decodes an empty stream to nothing", async () => {
    expect((await decode(fixture("empty.bz2"))).length).toBe(0);
  });

  it("decodes concatenated streams one after the other", async () => {
    const want = Buffer.concat([wordsText(4, 1000), randomBytes(5, 1000)]);
    expect(same(await decode(fixture("two-streams.bz2"), { workers: 2 }), want)).toBe(true);
  });

  it("gives the same bytes however the input is split", async () => {
    const runs = fixture("runs.bz2");
    expect(same(await decode(runs, { workers: 0 }, 1), runsBytes(3, 300))).toBe(true);
    expect(same(await decode(runs, { workers: 2 }, 1), runsBytes(3, 300))).toBe(true);
    expect(same(await decode(fixture("words-l1.bz2"), { workers: 2 }, 7777), wordsText(1, 350_000))).toBe(true);
  });
});

describe.skipIf(!systemBzip2)("bunzip2 against the system bzip2", () => {
  const next = prng(42);
  // Text with random stretches and long runs: every stage of the format gets work.
  const data = Buffer.concat([wordsText(8, 250_000), randomBytes(9, 60_000), new Uint8Array(70_000).fill(7), wordsText(10, 120_000)]);
  for (const level of [1, 5, 9]) {
    it(`decodes what bzip2 -${level} makes`, async () => {
      const packed = execFileSync("bzip2", [`-${level}`, "-c"], { input: data, maxBuffer: 1 << 26 });
      const size = 1000 + Math.floor(next() * 60_000);
      expect(same(await decode(packed, { workers: 2 }, size), data)).toBe(true);
    });
  }

  it("agrees with the test encoder (which builds the damaged streams below)", () => {
    const data2 = wordsText(11, 20_000);
    const back = execFileSync("bzip2", ["-dc"], { input: bzip2Compress(data2, { blockBytes: 3000 }) });
    expect(same(back, data2)).toBe(true);
  });
});

describe("bunzip2 on built streams", () => {
  const words = wordsText(7, 30_000);
  const blocks = bzip2Compress(words, { blockBytes: 2000 });

  for (const workers of [0, 4]) {
    it(`decodes sixteen small blocks in order (${workers} workers)`, async () => {
      const n = findBlockMagic(blocks).length;
      expect(n).toBeGreaterThanOrEqual(15);
      const stats: Bunzip2Stats = { workerBlocks: 0, threadBlocks: 0 };
      expect(same(await decode(blocks, { workers, stats }, 333), words)).toBe(true);
      // The workers really ran the kernel's source (a broken one would fall back to this thread and still pass).
      expect(stats).toEqual(workers ? { workerBlocks: n, threadBlocks: 0 } : { workerBlocks: 0, threadBlocks: n });
    });
  }

  it("decodes Huffman codes up to 20 bits long (the slow path past the lookup table)", async () => {
    const next = prng(3);
    // 19 byte values and no runs (whose counts would add more): 21 symbols, so lengths 1 to 20 make a complete code.
    let prev = -1;
    const data = Uint8Array.from({ length: 6000 }, () => {
      let v = Math.floor(next() ** 3 * 19);
      if (v === prev) v = (v + 1) % 19;
      prev = v;
      return 65 + v;
    });
    expect(new Set(data).size).toBe(19);
    const packed = bzip2Compress(data, { lengths: deepLengths });
    expect(same(await decode(packed, { workers: 0 }), data)).toBe(true);
  });

  it("decodes an incomplete code (every symbol the same length)", async () => {
    const data = randomBytes(5, 3000).map(b => b % 5);
    expect(same(await decode(bzip2Compress(data, { lengths: f => flatLengths(f.length) })), data)).toBe(true);
  });

  it("passes on a block that expands past 4 MB in pieces, still checked (long runs)", async () => {
    const next = prng(9);
    const raw: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      for (let k = 0; k < 255; k++) raw.push(0);
      raw.push(1 + Math.floor(next() * 250));
    }
    const data = Uint8Array.from(raw);
    const packed = bzip2Compress(data);
    expect(findBlockMagic(packed)).toHaveLength(1);
    for (const workers of [0, 2]) {
      const sizes: number[] = [];
      const parts: Uint8Array[] = [];
      for await (const p of bunzip2(pieces(packed, 4096), { workers })) {
        sizes.push(p.length);
        parts.push(p);
      }
      expect(same(Buffer.concat(parts), data)).toBe(true);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1 << 20);
    }
  });

  it("refuses a block whose CRC doesn't match, passing on none of its bytes", async () => {
    const damaged = bzip2Compress(words, { blockBytes: 2000, crcXor: block => (block === 1 ? 0x10 : 0) });
    for (const workers of [0, 3]) {
      const { got, error } = await untilError(damaged, { workers });
      expect(error?.message).toMatch(/block's CRC doesn't match/);
      // Only the first block came out: a prefix of the data, at most one block long.
      expect(got.length).toBeGreaterThan(0);
      expect(got.length).toBeLessThanOrEqual(2000);
      expect(same(got, words.subarray(0, got.length))).toBe(true);
    }
  });

  it("refuses a stream whose combined CRC doesn't match", async () => {
    const { error } = await untilError(bzip2Compress(words, { blockBytes: 2000, streamCrcXor: 1 }), { workers: 2 });
    expect(error?.message).toMatch(/stream's CRC doesn't match/);
  });

  it("refuses a block with a damaged byte in the middle", async () => {
    const data = Uint8Array.from(fixture("words-l1.bz2"));
    data[20_000] ^= 0x04;
    for (const workers of [0, 2]) {
      const { error } = await untilError(data, { workers });
      expect(error?.message).toMatch(/^bzip2 data is (damaged|truncated)/);
    }
  });

  it("refuses an over-full Huffman table", async () => {
    const { error } = await untilError(bzip2Compress(words.subarray(0, 500), { lengths: f => f.map(() => 1) }));
    expect(error?.message).toMatch(/over-full Huffman table/);
  });

  it("refuses a start pointer outside the block", async () => {
    const { error } = await untilError(bzip2Compress(words.subarray(0, 500), { origPtr: () => 600 }));
    expect(error?.message).toMatch(/start pointer is out of range/);
  });

  it("refuses obsolete randomised blocks", async () => {
    const { error } = await untilError(bzip2Compress(words.subarray(0, 500), { randomised: true }));
    expect(error?.message).toMatch(/randomised blocks/);
  });

  it("refuses truncated input", async () => {
    const data = fixture("words-l1.bz2");
    for (const workers of [0, 2]) {
      const { error } = await untilError(data.subarray(0, data.length >> 1), { workers });
      expect(error?.message).toMatch(/truncated/);
    }
    const { error } = await untilError(data.subarray(0, data.length - 3));
    expect(error?.message).toMatch(/truncated/);
  });

  it("refuses trailing bytes that aren't another stream, and input that isn't bzip2", async () => {
    const tail = Buffer.concat([fixture("empty.bz2"), Buffer.from("junk")]);
    expect((await untilError(tail)).error?.message).toMatch(/trailing bytes/);
    expect((await untilError(Buffer.from("PK\u0003\u0004 not bzip2"))).error?.message).toMatch(/isn't bzip2 data/);
    expect((await untilError(new Uint8Array(0))).error?.message).toMatch(/isn't bzip2 data/);
  });

  it("stops once the output passes maxBytes", async () => {
    const { got, error } = await untilError(blocks, { workers: 2, maxBytes: 10_000 });
    expect(error?.message).toMatch(/expands to more than 10000 bytes/);
    expect(got.length).toBeLessThanOrEqual(10_000);
  });
});

describe("bunzip2's block boundaries and workers", () => {
  const words = wordsText(12, 40_000);
  const blocks = bzip2Compress(words, { blockBytes: 3000 });

  it("decodes correctly when the scan also finds false block boundaries (the magic by chance inside a block)", async () => {
    // A false boundary every 997 bits: each real block's first decode stops short and is retried.
    const findBlocks = (bytes: Uint8Array) => [...new Set([...findBlockMagic(bytes), ...Array.from({ length: Math.floor((bytes.length * 8) / 997) }, (_, k) => (k + 1) * 997)])].sort((a, b) => a - b);
    expect(same(await decode(blocks, { workers: 3, testing: { findBlocks } }, 1500), words)).toBe(true);
  });

  it("finishes in this thread when a worker dies", async () => {
    const workerSource = "require('node:worker_threads').parentPort.on('message', () => process.exit(3));";
    const stats: Bunzip2Stats = { workerBlocks: 0, threadBlocks: 0 };
    expect(same(await decode(blocks, { workers: 2, testing: { workerSource }, stats }), words)).toBe(true);
    expect(stats).toMatchObject({ workerBlocks: 0, threadBlocks: findBlockMagic(blocks).length, workerFailure: "a decoding worker exited (3)" });
  });

  it("finishes in this thread when the workers can't start", async () => {
    const stats: Bunzip2Stats = { workerBlocks: 0, threadBlocks: 0 };
    expect(same(await decode(blocks, { workers: 2, testing: { workerSource: "this is not JavaScript" }, stats }), words)).toBe(true);
    expect(stats.threadBlocks).toBe(findBlockMagic(blocks).length);
    expect(stats.workerFailure).toMatch(/Unexpected identifier|SyntaxError/);
  });
});

describe("findBlockMagic", () => {
  it("finds the block magic at every bit offset", () => {
    for (let shift = 0; shift < 8; shift++) {
      const bytes = new Uint8Array(32);
      const bitAt = 8 * 5 + shift;
      const magic = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
      for (let k = 0; k < 48; k++) {
        if ((magic[k >> 3] >> (7 - (k & 7))) & 1) bytes[(bitAt + k) >> 3] |= 0x80 >> ((bitAt + k) & 7);
      }
      expect(findBlockMagic(bytes)).toEqual([bitAt]);
    }
  });

  it("finds none in data without it", () => {
    expect(findBlockMagic(randomBytes(1, 100_000))).toEqual([]);
  });
});

describe("bzip2Kernel", () => {
  it("expands a block in pieces after checking it when its output passes the cap", () => {
    const data = runsBytes(4, 300);
    const packed = bzip2Compress(data);
    const kernel = bzip2Kernel();
    const head = kernel.decodeBlock(packed, 32, 900_000)!;
    expect(kernel.finish(head, 1000)).toBeNull();
    const st = kernel.unrleStart(head.n);
    const parts: Uint8Array[] = [];
    while (!kernel.unrleDone(st)) {
      const piece = new Uint8Array(777);
      parts.push(piece.subarray(0, kernel.unrle(head.pre, st, piece, 0, false)));
    }
    expect(same(Buffer.concat(parts), data)).toBe(true);
    expect(same(kernel.finish(kernel.decodeBlock(packed, 32, 900_000)!, 1 << 22)!, data)).toBe(true);
  });

  it("inverts two blocks together exactly as it does one at a time, whatever their lengths", () => {
    const kernel = bzip2Kernel();
    const datas = [wordsText(3, 1001), randomBytes(4, 2000), runsBytes(5, 40), wordsText(6, 7)];
    const packs = datas.map(d => bzip2Compress(d));
    const task = (src: Uint8Array) => ({ src, bit: 32, maxBlock: 900_000 });
    for (const [i, j] of [[0, 1], [1, 0], [2, 3], [0, 0]]) {
      const heads = kernel.decodeTwo(task(packs[i]), task(packs[j]));
      expect(same(kernel.finish(heads[0] as BlockHead, 1 << 22)!, datas[i])).toBe(true);
      expect(same(kernel.finish(heads[1] as BlockHead, 1 << 22)!, datas[j])).toBe(true);
    }
  });

  it("keeps the good block of a pair when the other is damaged or cut short", () => {
    const kernel = bzip2Kernel();
    const data = wordsText(7, 3000);
    const good = { src: bzip2Compress(data), bit: 32, maxBlock: 900_000 };
    const damaged = { src: bzip2Compress(data, { origPtr: () => 999_999 }), bit: 32, maxBlock: 900_000 };
    const cut = { src: good.src.subarray(0, 200), bit: 32, maxBlock: 900_000 };
    const [bad, ok] = kernel.decodeTwo(damaged, good);
    expect((bad as Error).message).toMatch(/start pointer is out of range/);
    expect(same(kernel.finish(ok as BlockHead, 1 << 22)!, data)).toBe(true);
    const [ok2, short] = kernel.decodeTwo(good, cut);
    expect(short).toBeNull();
    expect(same(kernel.finish(ok2 as BlockHead, 1 << 22)!, data)).toBe(true);
  });

  it("reports a block cut short as truncated rather than damaged", () => {
    const packed = bzip2Compress(wordsText(2, 5000));
    expect(bzip2Kernel().decodeBlock(packed.subarray(0, 300), 32, 900_000)).toBeNull();
  });
});
