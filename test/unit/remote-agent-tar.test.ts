import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { gzip, readTar, tarArchive } from "../../scripts/package/tar-writer.mjs";
import { buildParts, elfVersionNeeds, manifestText, matchesIntegrity, PARTS_TARGETS, partsIdOf, tooNew } from "../../scripts/package/remote-parts.mjs";
import type { PartsInputs } from "../../scripts/package/remote-parts.mjs";
import { TarReader } from "../../app/voice/untar";

const bytes = (s: string) => Buffer.from(s, "utf8");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What another tar reader (the voice models' one, written apart from tar-writer.mjs) makes of an archive. */
function independent(tar: Uint8Array): { files: Record<string, string>; dirs: string[] } {
  const r = new TarReader();
  const files: Record<string, string> = {};
  const dirs: string[] = [];
  let current: string | null = null;
  for (const ev of r.push(tar)) {
    if (ev.kind === "directory") dirs.push(ev.path.join("/"));
    else if (ev.kind === "file") { current = ev.path.join("/"); files[current] = ""; }
    else if (ev.kind === "data") files[current!] += Buffer.from(ev.bytes).toString("utf8");
  }
  r.finish();
  return { files, dirs };
}

/** A minimal 64-bit little-endian ELF whose version needs are `names` (from libc.so.6). */
function elfNeeding(names: string[]): Buffer {
  const strs = ["", "libc.so.6", ...names];
  const dynstr = Buffer.from(strs.join("\0") + "\0", "latin1");
  const off = (s: string) => dynstr.indexOf(Buffer.from(`${s}\0`, "latin1"), 1);
  const verneed = Buffer.alloc(16 + 16 * names.length);
  verneed.writeUInt16LE(1, 0);
  verneed.writeUInt16LE(names.length, 2);
  verneed.writeUInt32LE(off("libc.so.6"), 4);
  verneed.writeUInt32LE(16, 8);
  names.forEach((n, i) => {
    const at = 16 + 16 * i;
    verneed.writeUInt32LE(off(n), at + 8);
    verneed.writeUInt32LE(i === names.length - 1 ? 0 : 16, at + 12);
  });
  const shoff = 64 + dynstr.length + verneed.length;
  const head = Buffer.alloc(64);
  head.writeUInt32BE(0x7f454c46, 0);
  head[4] = 2; head[5] = 1; head[6] = 1;
  head.writeBigUInt64LE(BigInt(shoff), 0x28);
  head.writeUInt16LE(64, 0x3a);
  head.writeUInt16LE(3, 0x3c);
  const sh = Buffer.alloc(64 * 3);
  sh.writeUInt32LE(3, 64 + 4); // SHT_STRTAB
  sh.writeBigUInt64LE(64n, 64 + 24);
  sh.writeBigUInt64LE(BigInt(dynstr.length), 64 + 32);
  sh.writeUInt32LE(0x6ffffffe, 128 + 4); // SHT_GNU_verneed
  sh.writeBigUInt64LE(BigInt(64 + dynstr.length), 128 + 24);
  sh.writeBigUInt64LE(BigInt(verneed.length), 128 + 32);
  sh.writeUInt32LE(1, 128 + 40); // its strings: section 1
  sh.writeUInt32LE(1, 128 + 44); // one library
  return Buffer.concat([head, dynstr, verneed, sh]);
}

describe("tarArchive", () => {
  const entries = [
    { path: "b.txt", mode: 0o644, data: bytes("bee") },
    { path: "dir", mode: 0o755, dir: true },
    { path: "dir/a.sh", mode: 0o755, data: bytes("#!/bin/sh\n") },
    { path: "a.txt", mode: 0o600, data: bytes("") },
  ];

  it("gives the same bytes for the same entries in any order", () => {
    expect(tarArchive([...entries].reverse()).equals(tarArchive(entries))).toBe(true);
  });

  it("writes sorted ustar entries with mtime 0, uid and gid 0, padded to whole 10 KiB records", () => {
    const tar = tarArchive(entries);
    expect(tar.length % 10240).toBe(0);
    const names: string[] = [];
    for (let at = 0; at < tar.length; at += 512) {
      const h = tar.subarray(at, at + 512);
      if (h.every(b => b === 0)) break;
      names.push(h.toString("latin1", 0, 100).replace(/\0.*$/s, ""));
      expect(h.toString("latin1", 257, 263)).toBe("ustar\0");
      expect(h.toString("latin1", 136, 147)).toBe("00000000000");
      expect(h.toString("latin1", 108, 115)).toBe("0000000");
      expect(h.toString("latin1", 116, 123)).toBe("0000000");
      const size = parseInt(h.toString("latin1", 124, 135), 8);
      at += Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(["a.txt", "b.txt", "dir/", "dir/a.sh"]);
  });

  it("is read back the same by tar-writer's reader and by an independent one", () => {
    const tar = tarArchive(entries);
    expect(readTar(tar).map(e => [e.path, e.mode, e.dir, e.data.toString("utf8")])).toEqual([
      ["a.txt", 0o600, false, ""], ["b.txt", 0o644, false, "bee"], ["dir", 0o755, true, ""], ["dir/a.sh", 0o755, false, "#!/bin/sh\n"],
    ]);
    expect(independent(tar)).toEqual({ files: { "a.txt": "", "b.txt": "bee", "dir/a.sh": "#!/bin/sh\n" }, dirs: ["dir"] });
  });

  it("splits a long name into ustar's prefix and name", () => {
    const deep = `${"d".repeat(90)}/${"e".repeat(40)}`;
    const tar = tarArchive([{ path: "d".repeat(90), mode: 0o755, dir: true }, { path: deep, mode: 0o644, data: bytes("x") }]);
    expect(readTar(tar).map(e => e.path)).toEqual(["d".repeat(90), deep]);
    expect(independent(tar).files[deep]).toBe("x");
  });

  it("refuses names that could land elsewhere, files without their folder, and duplicates", () => {
    expect(() => tarArchive([{ path: "/etc/x", mode: 0o644, data: bytes("") }])).toThrow(/relative/);
    expect(() => tarArchive([{ path: "a/../b", mode: 0o644, data: bytes("") }])).toThrow(/"\.\."/);
    expect(() => tarArchive([{ path: "a\\b", mode: 0o644, data: bytes("") }])).toThrow(/backslash/);
    expect(() => tarArchive([{ path: "dir/x", mode: 0o644, data: bytes("") }])).toThrow(/folder isn't listed/);
    expect(() => tarArchive([{ path: "x", mode: 0o644, data: bytes("") }, { path: "x", mode: 0o644, data: bytes("") }])).toThrow(/twice/);
  });
});

describe("readTar", () => {
  it("refuses links and a wrong checksum", () => {
    const tar = tarArchive([{ path: "x", mode: 0o644, data: bytes("1") }]);
    const link = Buffer.from(tar);
    link[156] = "2".charCodeAt(0);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : link[i];
    link.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    expect(() => readTar(link)).toThrow(/type "2"/);
    const bad = Buffer.from(tar);
    bad[0] ^= 1;
    expect(() => readTar(bad)).toThrow(/checksum/);
  });
});

describe("gzip", () => {
  it("writes mtime 0 and the Unix OS byte, and round-trips", () => {
    const z = gzip(bytes("hello"));
    expect([z[4], z[5], z[6], z[7], z[9]]).toEqual([0, 0, 0, 0, 3]);
    expect(gunzipSync(z).toString("utf8")).toBe("hello");
    expect(gzip(bytes("hello")).equals(z)).toBe(true);
  });
});

describe("the parts' checks", () => {
  it("reads an ELF file's version needs and names those newer than RHEL 8's", () => {
    const elf = elfNeeding(["GLIBC_2.17", "GLIBC_2.34", "GLIBCXX_3.4.22", "GLIBCXX_3.4.30", "CXXABI_1.3.9"]);
    expect(elfVersionNeeds(elf)).toEqual(["CXXABI_1.3.9", "GLIBCXX_3.4.22", "GLIBCXX_3.4.30", "GLIBC_2.17", "GLIBC_2.34"]);
    expect(tooNew(elf)).toEqual(["GLIBCXX_3.4.30", "GLIBC_2.34"]);
    expect(tooNew(elfNeeding(["GLIBC_2.28", "GLIBC_2.2.5"]))).toEqual([]);
    expect(() => elfVersionNeeds(bytes("#!/bin/sh"))).toThrow(/ELF/);
  });

  it("checks a tarball against the lockfile's integrity", () => {
    const data = bytes("package");
    const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;
    expect(matchesIntegrity(data, integrity)).toBe(true);
    expect(matchesIntegrity(bytes("packagf"), integrity)).toBe(false);
    expect(matchesIntegrity(data, "md5-abc")).toBe(false);
  });

  it("writes manifest.sha256 in sha256sum -c's format, sorted", () => {
    expect(manifestText([{ path: "b", data: bytes("2") }, { path: "a", data: bytes("1") }]))
      .toBe(`${sha(bytes("1"))}  a\n${sha(bytes("2"))}  b\n`);
    expect(partsIdOf("0.1.0", ["x"])).toBe(`0.1.0-${sha(bytes("x")).slice(0, 12)}`);
    expect(() => partsIdOf("0.1.0 ; rm", [])).toThrow(/version/);
  });
});

describe("buildParts", () => {
  const koffi = (arch: string) => [
    { path: "node_modules/koffi/package.json", data: bytes("{}") },
    { path: "node_modules/koffi/index.cjs", data: bytes("module.exports = {};") },
    { path: `node_modules/@koromix/koffi-linux-${arch}/linux_${arch}/koffi.node`, data: elfNeeding(["GLIBC_2.17"]) },
  ];
  const inputs: PartsInputs = {
    version: "0.1.0",
    bundle: bytes("// the agent"),
    atspi: bytes("# atspi"),
    notice: bytes("# notice"),
    uninstall: bytes("#!/bin/sh\n"),
    readme: bytes("readme"),
    license: bytes("MIT"),
    notices: t => bytes(`notices for ${t}`),
    koffi: { "linux-x64": koffi("x64"), "linux-arm64": koffi("arm64") },
  };

  it("gives the same bytes on every run", () => {
    const a = buildParts(inputs), b = buildParts(inputs);
    expect(a.partsId).toBe(b.partsId);
    expect(a.archives.map(x => sha(x.bytes))).toEqual(b.archives.map(x => sha(x.bytes)));
    expect(a.partsId).toMatch(/^0\.1\.0-[0-9a-f]{12}$/);
  });

  it("puts koffi, the sidecar and the notice only in Linux parts, and lists every file in the manifest", () => {
    const built = buildParts(inputs);
    expect(built.archives.map(a => a.target)).toEqual(PARTS_TARGETS);
    for (const a of built.archives) {
      const entries = readTar(gunzipSync(a.bytes));
      const files = entries.filter(e => !e.dir);
      const manifest = files.find(e => e.path === "manifest.sha256")!.data.toString("utf8");
      const listed = manifest.trim().split("\n").map(l => l.split("  "));
      expect(listed.map(([, p]) => p).sort()).toEqual(files.map(f => f.path).filter(p => p !== "manifest.sha256").sort());
      for (const [hash, p] of listed) expect(sha(files.find(f => f.path === p)!.data)).toBe(hash);
      const linux = a.target.startsWith("linux-");
      expect(files.some(f => f.path === "sidecar/notice/ember_notice.py")).toBe(linux);
      expect(files.some(f => f.path.endsWith("koffi.node"))).toBe(linux);
      expect(files.some(f => /musl/.test(f.path))).toBe(false);
      expect(files.find(f => f.path === "uninstall.sh")!.mode).toBe(0o755);
      expect(files.find(f => f.path === "ember-remote.cjs")!.mode).toBe(0o644);
      expect(built.json.targets[a.target]).toEqual({ file: `ember-remote-parts-${built.partsId}-${a.target}.tar.gz`, sha256: sha(a.bytes), bytes: a.bytes.length });
    }
  });

  it("changes the parts id when any file of any target changes", () => {
    const changed = buildParts({ ...inputs, koffi: { ...inputs.koffi, "linux-arm64": koffi("arm64").map((f, i) => (i === 0 ? { ...f, data: bytes("{ }") } : f)) } });
    expect(changed.partsId).not.toBe(buildParts(inputs).partsId);
  });

  it("refuses a Linux target without koffi", () => {
    expect(() => buildParts({ ...inputs, koffi: { "linux-x64": koffi("x64") } })).toThrow(/no koffi files for linux-arm64/);
  });
});
