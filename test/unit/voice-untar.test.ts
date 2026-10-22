/**
 * The tar reader and safe extractor that unpack the speech models (app/voice/untar.ts): real GNU tar output
 * (gnu, pax and ustar formats, committed in test/fixtures/voice-archive), archives written in the test (long
 * names, odd entry types), and hostile ones (paths that escape, links, names Windows reads differently, caps)
 * that must be refused before anything is written outside the destination.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TarReader, extractTar, extractTarBz2, safeEntryPath, type TarEvent, type TarLimits } from "../../app/voice/untar";
import { bzip2Compress, longNameEntry, paxEntry, pieces, randomBytes, tarArchive, tarEntry, withChecksum, wordsText } from "../fixtures/voice-archive/make";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-untar-"));
  dirs.push(d);
  return d;
};

/** Every event of an archive, fed in pieces of `size` bytes; data events joined per file. */
function read(archive: Uint8Array, limits: TarLimits = {}, size = archive.length): { files: Record<string, string>; dirs: string[] } {
  const reader = new TarReader(limits);
  const files: Record<string, string> = {};
  const dirsSeen: string[] = [];
  let current = "";
  const take = (events: TarEvent[]) => {
    for (const e of events) {
      if (e.kind === "file") {
        current = e.path.join("/");
        files[current] = "";
      } else if (e.kind === "data") files[current] += Buffer.from(e.bytes).toString("latin1");
      else if (e.kind === "directory") dirsSeen.push(e.path.join("/"));
    }
  };
  for (let i = 0; i < archive.length; i += size) take(reader.push(archive.subarray(i, i + size)));
  reader.finish();
  return { files, dirs: dirsSeen };
}

const file = (name: string, data: string | Uint8Array = "", more: Partial<Parameters<typeof tarEntry>[0]> = {}) => tarEntry({ name, data, ...more });
const dir = (name: string) => tarEntry({ name, type: "5", mode: 0o755 });
const one = (...parts: Uint8Array[]) => tarArchive(parts);
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

/** The tree in the committed tar fixtures (as gen made it). */
const FIXTURE_TREE: Record<string, string> = {
  "top/hello.txt": "Hello from Ember\n",
  "top/empty": "",
  "top/block512.bin": latin1(randomBytes(10, 512)),
  "top/block513.bin": latin1(randomBytes(11, 513)),
  "top/sub/words.txt": latin1(wordsText(12, 5000)),
  [`top/long-${"x".repeat(90)}/file-with-a-long-name.txt`]: "long name\n",
};

/** Every file under `root`, as relative "/"-joined paths and latin1 contents. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join("/")] = fs.readFileSync(p, "latin1");
    }
  };
  walk(root);
  return out;
}

describe("TarReader", () => {
  it("reads files and folders the same fed whole or one byte at a time", () => {
    const archive = one(dir("top/"), file("top/a.txt", "hello"), file("top/empty"), file("top/big.bin", randomBytes(1, 1000)));
    const whole = read(archive);
    expect(whole).toEqual({ files: { "top/a.txt": "hello", "top/empty": "", "top/big.bin": latin1(randomBytes(1, 1000)) }, dirs: ["top"] });
    expect(read(archive, {}, 1)).toEqual(whole);
    expect(read(archive, {}, 777)).toEqual(whole);
  });

  it("takes long names from GNU 'L' headers, pax 'x' headers and the ustar prefix", () => {
    const long = `top/${"d".repeat(120)}/${"f".repeat(110)}.txt`;
    expect(read(one(longNameEntry(long), file("ignored", "gnu")))).toEqual({ files: { [long]: "gnu" }, dirs: [] });
    expect(read(one(paxEntry({ path: long, mtime: "1700000000.5" }), file("ignored", "pax")))).toEqual({ files: { [long]: "pax" }, dirs: [] });
    expect(read(one(file("name.txt", "split", { prefix: "top/deep/folder" })))).toEqual({ files: { "top/deep/folder/name.txt": "split" }, dirs: [] });
    // GNU archives use that space for other fields: no prefix there.
    expect(read(one(file("name.txt", "gnu", { prefix: "zz", format: "gnu" })))).toEqual({ files: { "name.txt": "gnu" }, dirs: [] });
  });

  it("reads a 100-byte name with no NUL, a pax size and a base-256 size", () => {
    const hundred = `top/${"n".repeat(96)}`;
    expect(read(one(file(hundred, "x"))).files).toEqual({ [hundred]: "x" });
    expect(read(one(paxEntry({ size: "3" }), file("top/p", "abc"))).files).toEqual({ "top/p": "abc" });
    expect(read(one(file("top/b", "base256", { base256: true }))).files).toEqual({ "top/b": "base256" });
  });

  it("treats contiguous ('7') and old NUL-type entries as files", () => {
    expect(read(one(file("top/seven", "7", { type: "7" }), file("top/old", "0", { type: "\0" }))).files).toEqual({ "top/seven": "7", "top/old": "0" });
  });

  it("reads a regular entry whose name ends with a slash as a folder, as old tars wrote them", () => {
    expect(read(one(file("top/", "", { type: "\0" }), file("top/sub/", ""), file("top/sub/a", "in it")))).toEqual({ files: { "top/sub/a": "in it" }, dirs: ["top", "top/sub"] });
  });

  it("skips devices, FIFOs, global pax headers and volume labels, creating nothing for them", () => {
    const archive = one(
      paxEntry({ comment: "global" }, "g"),
      tarEntry({ name: "volume", type: "V" }),
      tarEntry({ name: "top/fifo", type: "6" }),
      tarEntry({ name: "top/char", type: "3" }),
      tarEntry({ name: "top/block", type: "4" }),
      tarEntry({ name: "top/odd", type: "Z", data: "skipped data" }),
      file("top/after", "still read"),
    );
    expect(read(archive)).toEqual({ files: { "top/after": "still read" }, dirs: [] });
  });

  const refusals: [string, Uint8Array, RegExp][] = [
    ["a symbolic link", one(tarEntry({ name: "top/link", type: "2", linkname: "/etc/passwd" })), /symbolic link \(to "\/etc\/passwd"\), and links aren't allowed/],
    ["a hard link", one(file("top/a"), tarEntry({ name: "top/b", type: "1", linkname: "top/a" })), /hard link/],
    ["a long-named link", one(longNameEntry("../../target", "K"), tarEntry({ name: "top/l", type: "2" })), /symbolic link \(to "..\/..\/target"\)/],
    ["a path up out of the folder", one(file("../evil", "x")), /goes up a folder/],
    ["a path up in the middle", one(file("top/../../evil", "x")), /goes up a folder/],
    ["an absolute path", one(file("/etc/cron.d/evil", "x")), /absolute path/],
    ["a pax path that goes up", one(paxEntry({ path: "top/../../x" }), file("top/ok")), /goes up a folder/],
    ["a GNU long name that goes up", one(longNameEntry(`../${"x".repeat(120)}`), file("top/ok")), /goes up a folder/],
    ["a backslash (a folder separator on Windows)", one(file("top\\..\\..\\evil", "x")), /backslash/],
    ["a drive letter", one(file("C:evil", "x")), /character Windows can't use/],
    ["an alternate data stream", one(file("top/model.onnx:hidden", "x")), /character Windows can't use/],
    ["a control character", one(file("top/bell\u0007", "x")), /character Windows can't use/],
    ["a reserved device name", one(file("top/nul", "x")), /reserved on Windows/],
    ["a reserved name with an extension", one(file("top/AUX.txt", "x")), /reserved on Windows/],
    ["a name ending in a dot", one(file("top/model.", "x")), /ends with a dot or a space/],
    ["a name ending in a space", one(file("top/model ", "x")), /ends with a dot or a space/],
    ["a GNU sparse file", one(tarEntry({ name: "top/s", type: "S", data: "x" })), /sparse/],
    ["a pax sparse file", one(paxEntry({ "GNU.sparse.major": "1", "GNU.sparse.minor": "0" }), file("top/s", "x")), /sparse file/],
    ["a multi-volume continuation", one(tarEntry({ name: "top/m", type: "M", data: "x" })), /multi-volume/],
    ["a damaged header", one(file("top/a", "x", { checksumXor: 1 })), /checksum doesn't match/],
    ["data after the end marker", tarArchive([file("top/a", "x"), new Uint8Array(1024), Uint8Array.of(1)], false), /data after its end marker/],
    ["the end right after a long-name header", one(longNameEntry("top/x")), /ends right after a long-name/],
    ["a name that isn't UTF-8", one(withChecksum(file("top/abc", "x").map((b, i) => (i === 4 ? 0xff : b)))), /isn't valid UTF-8/],
    ["a malformed pax record", one(tarEntry({ name: "x", type: "x", data: "99 path=top/a\n" }), file("top/a")), /pax header is malformed/],
    ["too many long-name headers in a row", one(...Array.from({ length: 5 }, () => paxEntry({ comment: "c" })), file("top/a")), /too many long-name or pax headers/],
  ];
  for (const [what, archive, error] of refusals) {
    it(`refuses ${what}`, () => {
      expect(() => read(archive)).toThrow(error);
    });
  }

  it("refuses an archive that stops before its end marker", () => {
    expect(() => read(tarArchive([file("top/a", "x")], false))).toThrow(/truncated/);
    expect(() => read(one(file("top/a", "abcdef")).subarray(0, 600))).toThrow(/truncated/);
  });

  it("refuses more entries or bytes than its limits, before reading their data", () => {
    const four = one(file("top/a"), file("top/b"), file("top/c"), file("top/d"));
    expect(read(four, { maxEntries: 4 }).files).toHaveProperty("top/d");
    expect(() => read(four, { maxEntries: 3 })).toThrow(/more than 3 entries/);
    const big = one(file("top/a", randomBytes(2, 600)), file("top/b", randomBytes(3, 600)));
    expect(() => read(big, { maxBytes: 1000 })).toThrow(/more than 1000 bytes/);
    expect(() => read(one(tarEntry({ name: "x", type: "x", data: new Uint8Array((1 << 20) + 1) })))).toThrow(/too large/);
  });

  it("allows only zero padding after the end marker, up to 1 MiB", () => {
    expect(read(tarArchive([file("top/a", "x"), new Uint8Array(1024 + 9216)], false)).files).toEqual({ "top/a": "x" });
    expect(() => read(tarArchive([file("top/a", "x"), new Uint8Array((1 << 20) + 4096)], false))).toThrow(/too much padding/);
  });
});

describe("safeEntryPath", () => {
  it("splits names into parts, dropping '.' and repeated slashes", () => {
    expect(safeEntryPath("./top/a")).toEqual(["top", "a"]);
    expect(safeEntryPath("top//sub/./b/")).toEqual(["top", "sub", "b"]);
    expect(safeEntryPath("./")).toEqual([]);
    expect(safeEntryPath("vits/espeak-ng-data/voices/!v/Mr serious")).toEqual(["vits", "espeak-ng-data", "voices", "!v", "Mr serious"]);
    expect(safeEntryPath("top/cached_decode.int8.onnx")).toEqual(["top", "cached_decode.int8.onnx"]);
  });

  it("refuses empty names and names that only look harmless", () => {
    for (const bad of ["", "/", "..", "a/..", "top/con.onnx", "top/LPT9", "top/CONIN$", "top/x|y", "top/x?y", "top/x*y", "top/\"q\"", "top/..."]) {
      expect(() => safeEntryPath(bad)).toThrow(/tar archive refused/);
    }
  });
});

describe("extractTar", () => {
  for (const format of ["gnu", "pax", "ustar"]) {
    it(`extracts GNU tar's ${format} format with every file intact`, async () => {
      const dest = tmp();
      const summary = await extractTarBz2(path.resolve("test/fixtures/voice-archive", `${format}.tar.bz2`), dest, { topFolder: "top" });
      expect(tree(dest)).toEqual(FIXTURE_TREE);
      expect(summary).toEqual({ files: 6, directories: 3, bytes: 17 + 512 + 513 + 5000 + 10 });
    });
  }

  it.skipIf(process.platform === "win32")("creates files 0644 and folders 0755 whatever the archive says, and never links", async () => {
    const dest = tmp();
    const archive = one(tarEntry({ name: "top/", type: "5", mode: 0o777 }), file("top/run.sh", "#!/bin/sh\n", { mode: 0o4755 }));
    const old = process.umask(0o022);
    try {
      await extractTar(pieces(archive, 100), dest);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(path.join(dest, "top")).mode & 0o7777).toBe(0o755);
    expect(fs.statSync(path.join(dest, "top/run.sh")).mode & 0o7777).toBe(0o644);
  });

  it("refuses an entry outside the top folder before writing it", async () => {
    const dest = tmp();
    const archive = one(file("top/a", "ok"), file("other/b", "not this"));
    await expect(extractTar(pieces(archive, 512), dest, { topFolder: "top" })).rejects.toThrow(/"other\/b" is outside "top"/);
    expect(fs.readdirSync(dest)).toEqual(["top"]);
  });

  it("writes nothing outside the destination for a hostile archive", async () => {
    const parent = tmp();
    const dest = path.join(parent, "dest");
    fs.mkdirSync(dest);
    for (const evil of ["../escape", "/abs-escape", "top/../../escape", "top\\..\\..\\escape"]) {
      await expect(extractTar(pieces(one(file("top/ok", "fine"), file(evil, "x")), 512), dest)).rejects.toThrow(/tar archive refused/);
      fs.rmSync(path.join(dest, "top"), { recursive: true, force: true });
    }
    await expect(extractTar(pieces(one(tarEntry({ name: "top/l", type: "2", linkname: "../.." }), file("top/l/escape", "x")), 512), dest)).rejects.toThrow(/links aren't allowed/);
    expect(fs.readdirSync(parent)).toEqual(["dest"]);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it("never overwrites: a second entry for the same file fails", async () => {
    const dest = tmp();
    await expect(extractTar(pieces(one(file("top/a", "one"), file("top/a", "two")), 512), dest)).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(path.join(dest, "top/a"), "utf8")).toBe("one");
  });

  it("refuses a file entry naming the destination itself", async () => {
    await expect(extractTar(pieces(one(file(".", "x")), 512), tmp())).rejects.toThrow(/destination folder itself/);
  });

  it("extracts a .tar.bz2 end to end, and fails on a damaged one", async () => {
    const archive = one(dir("model/"), file("model/a.onnx", randomBytes(4, 50_000)), file("model/tokens.txt", wordsText(5, 20_000)));
    const good = path.join(tmp(), "good.tar.bz2");
    fs.writeFileSync(good, bzip2Compress(archive, { blockBytes: 20_000 }));
    const dest = tmp();
    await extractTarBz2(good, dest, { topFolder: "model", workers: 2 });
    expect(tree(dest)).toEqual({ "model/a.onnx": latin1(randomBytes(4, 50_000)), "model/tokens.txt": latin1(wordsText(5, 20_000)) });
    const bad = path.join(tmp(), "bad.tar.bz2");
    fs.writeFileSync(bad, bzip2Compress(archive, { blockBytes: 20_000, crcXor: b => (b === 2 ? 1 : 0) }));
    await expect(extractTarBz2(bad, tmp(), { topFolder: "model", workers: 2 })).rejects.toThrow(/block's CRC doesn't match/);
  });

  // Windows can't delete (or download again to) an archive that is still open, so it must be closed by then.
  it.skipIf(process.platform !== "linux")("has closed the archive when it returns or fails", async () => {
    const opened = (file: string) => fs.readdirSync("/proc/self/fd").filter(fd => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`) === file;
      } catch {
        return false; // the descriptor readdir itself used, closed by now
      }
    }).length;
    const archive = one(dir("model/"), file("model/a.onnx", randomBytes(6, 50_000)));
    const good = path.join(tmp(), "good.tar.bz2");
    fs.writeFileSync(good, bzip2Compress(archive, { blockBytes: 20_000 }));
    await extractTarBz2(good, tmp(), { topFolder: "model", workers: 0 });
    expect(opened(good)).toBe(0);
    // Damaged at the start of a file much longer than is read before the damage shows, so it is still open then.
    const bad = path.join(tmp(), "bad.tar.bz2");
    fs.writeFileSync(bad, Buffer.concat([bzip2Compress(archive, { blockBytes: 20_000, crcXor: b => (b === 0 ? 1 : 0) }), new Uint8Array(8 << 20)]));
    await expect(extractTarBz2(bad, tmp(), { topFolder: "model", workers: 0 })).rejects.toThrow(/block's CRC doesn't match/);
    expect(opened(bad)).toBe(0);
  });
});

const gnuTar = process.platform === "linux" && (() => {
  try {
    return execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU tar");
  } catch {
    // No tar at all: the committed fixtures still cover GNU tar's output.
    return false;
  }
})();

describe.skipIf(!gnuTar)("extractTar against the system GNU tar", () => {
  for (const format of ["gnu", "pax", "posix", "ustar", "v7"]) {
    it(`extracts what tar --format=${format} writes`, async () => {
      const src = tmp();
      const want: Record<string, string> = {};
      for (let k = 0; k < 40; k++) {
        const name = `top/d${k % 4}/${k % 3 ? "f" : `long-${"y".repeat(k * 2)}`}${k}.bin`;
        if (format === "v7" && name.length >= 100) continue;
        fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
        fs.writeFileSync(path.join(src, name), randomBytes(k + 1, k * 37));
        want[name] = latin1(randomBytes(k + 1, k * 37));
      }
      const tarball = execFileSync("tar", ["-C", src, `--format=${format}`, "-cf", "-", "top"], { maxBuffer: 1 << 26 });
      const dest = tmp();
      await extractTar(pieces(tarball, 10_000), dest, { topFolder: "top" });
      expect(tree(dest)).toEqual(want);
    });
  }
});
