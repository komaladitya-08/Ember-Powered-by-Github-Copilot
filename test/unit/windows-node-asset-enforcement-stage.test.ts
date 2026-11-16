/** Fixed-size streamed byte models only. No Windows API, producer download or Node PE executes. */
import path from "node:path";
import type * as Crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import manifest from "../../app/shared/windows-node-toolchain.json";

vi.mock("node:crypto", async original => {
  const actual = await original<typeof Crypto>();
  const pins = new Map([
    [78, { bytes: 120219136, sha256: "d95bc2f8d456eb84306f54aa798c17ee21e5fd22591f943fc13c6adc8fd115db" }],
    [76, { bytes: 145485, sha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4" }],
    [82, { bytes: 6035, sha256: "f50e4859309b72dde505b99cd4c8edd926f2c55dc4aa74f035712d0d5323c9ad" }],
    [66, { bytes: 2560, sha256: "bb80548df91d6989305bfe6ed357cb21f47cef31af4a424ca4df5e598d3bcacc" }],
  ]);
  const blocks = new Map([...pins.keys()].map(marker => [marker, Buffer.alloc(65536, marker)]));
  return { ...actual, createHash(algorithm: string) {
    if (algorithm !== "sha256") return actual.createHash(algorithm);
    let marker: number | undefined, bytes = 0, exact = true, fallback: ReturnType<typeof actual.createHash> | undefined;
    const result = {
      update(data: string | Uint8Array, encoding?: BufferEncoding) {
        const b = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        if (!bytes && b.length && pins.has(b[0])) marker = b[0];
        if (marker === undefined) (fallback ??= actual.createHash(algorithm)).update(b);
        else for (let at = 0; at < b.length; at += 65536) exact &&= b.subarray(at, at + 65536).equals(blocks.get(marker)!.subarray(0, Math.min(65536, b.length - at)));
        bytes += b.length; return result;
      },
      digest(encoding: "hex") {
        if (marker === undefined) return (fallback ??= actual.createHash(algorithm)).digest(encoding);
        const pin = pins.get(marker)!; return exact && bytes === pin.bytes ? pin.sha256 : "0".repeat(64);
      },
    };
    return result;
  } };
});

type Row = { kind: "file" | "directory"; id: bigint; size: number; marker: number; pathMtime: bigint; pathCtime: bigint;
  fdMtime: bigint; fdCtime: bigint; symlink: boolean; corrupt: boolean };
type Descriptor = { row: Row; target: string; write: boolean; stats: number };
const REFUSAL = "The pinned Windows coding toolchain could not be verified.";
const PRIVATE = "PRIVATE synthetic close failure";

async function fixture() {
  const root = path.resolve("synthetic-node-stage-clock"), producer = path.join(root, "producer"), packaged = path.join(root, "packaged"), destination = path.join(root, "new-package");
  const rows = new Map<string, Row>(), descriptors = new Map<number, Descriptor>(), opened: Descriptor[] = [], calls: string[] = [];
  const state = { closeAttempts: 0, maximumRead: 0, maximumWrite: 0, writes: 0, failClose: false,
    afterRead: undefined as undefined | ((row: Row) => void) };
  let identity = 1n, descriptor = 10;
  const add = (target: string, kind: Row["kind"], size = 0, marker = 0) => {
    const row: Row = { kind, id: identity++, size, marker, pathMtime: 100n, pathCtime: 200n, fdMtime: 1000n, fdCtime: 2000n, symlink: false, corrupt: false };
    rows.set(target, row); return row;
  };
  add(root, "directory"); add(producer, "directory"); add(packaged, "directory");
  for (const member of manifest.files) {
    const marker = member.source === "source-node.exe" ? 78 : member.source === "LICENSE" ? 76 : member.source === "build-receipt.json" ? 82 : 66;
    add(path.join(producer, member.source), "file", member.bytes, marker);
    if (member.ship) add(path.join(packaged, member.name), "file", member.bytes, marker);
  }
  const selected = (target: string) => { const row = rows.get(target); if (!row) throw Error(PRIVATE); return row; };
  const stat = (row: Row, api: "path" | "fd") => {
    const kind = row.kind, symlink = row.symlink;
    return { dev: 1n, ino: row.id, size: BigInt(row.size), nlink: 1n,
      mtimeNs: api === "path" ? row.pathMtime : row.fdMtime, ctimeNs: api === "path" ? row.pathCtime : row.fdCtime,
      isFile: () => kind === "file", isDirectory: () => kind === "directory", isSymbolicLink: () => symlink };
  };
  const writeBlocks = new Map<number, Buffer>();
  const files = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
    lstatSync(target: string) { calls.push("lstat"); return stat(selected(target), "path"); },
    readdirSync(target: string) { calls.push("readdir"); if (selected(target).kind !== "directory") throw Error(PRIVATE); return [...rows.keys()].filter(name => path.dirname(name) === target).map(name => path.basename(name)); },
    mkdirSync(target: string) { calls.push("mkdir"); if (rows.has(target) || selected(path.dirname(target)).kind !== "directory") throw Error(PRIVATE); add(target, "directory"); },
    openSync(target: string, flags: number | string) {
      calls.push("open");
      if (flags === "wx") {
        if (rows.has(target) || selected(path.dirname(target)).kind !== "directory") throw Error(PRIVATE);
        add(target, "file"); const parent = selected(path.dirname(target)); parent.pathMtime++; parent.pathCtime++;
      } else if (flags !== 0) throw Error(PRIVATE);
      const value = { row: selected(target), target, write: flags === "wx", stats: 0 }, fd = descriptor++;
      descriptors.set(fd, value); opened.push(value); return fd;
    },
    fstatSync(fd: number) { calls.push("fstat"); const value = descriptors.get(fd)!; value.stats++; return stat(value.row, "fd"); },
    readSync(fd: number, bytes: Buffer, offset: number, length: number, position: number) {
      calls.push("read"); const value = descriptors.get(fd)!; if (value.write) throw Error(PRIVATE);
      state.maximumRead = Math.max(state.maximumRead, length);
      const count = Math.max(0, Math.min(length, value.row.size - position));
      bytes.fill(value.row.marker, offset, offset + count);
      if (value.row.corrupt && position === 0 && count > 1) bytes[offset + 1] ^= 1;
      if (count) state.afterRead?.(value.row); return count;
    },
    writeSync(fd: number, bytes: Buffer, offset: number, length: number, position: number) {
      calls.push("write"); const value = descriptors.get(fd)!; if (!value.write || length < 1 || length > 65536) throw Error(PRIVATE);
      const marker = bytes[offset]; let block = writeBlocks.get(marker); if (!block) { block = Buffer.alloc(65536, marker); writeBlocks.set(marker, block); }
      if (!bytes.subarray(offset, offset + length).equals(block.subarray(0, length))) throw Error(PRIVATE);
      if (position === 0) value.row.marker = marker;
      else if (value.row.marker !== marker) throw Error(PRIVATE);
      value.row.size = Math.max(value.row.size, position + length); value.row.pathMtime++; value.row.pathCtime++; value.row.fdMtime++; value.row.fdCtime++;
      state.maximumWrite = Math.max(state.maximumWrite, length); state.writes++; return length;
    },
    fsyncSync(fd: number) { calls.push("fsync"); if (!descriptors.has(fd)) throw Error(PRIVATE); },
    closeSync(fd: number) { calls.push("close"); state.closeAttempts++; if (!descriptors.delete(fd)) throw Error(PRIVATE); if (state.failClose) throw Error(PRIVATE); },
  };
  vi.resetModules(); vi.doMock("node:fs", () => ({ default: files }));
  const candidate = await import("../../scripts/package/windows-node-toolchain.mjs");
  return { candidate, rows, descriptors, opened, calls, state, producer, packaged, destination };
}

afterEach(() => { vi.doUnmock("node:fs"); vi.resetModules(); });

it("verifies the fixed three members with stable but different path and descriptor clocks", async () => {
  const f = await fixture(); expect(f.candidate.verifyWindowsNodeToolchain(f.packaged)).toMatchObject({ files: 3 });
  expect(f.opened).toHaveLength(3); expect(f.opened.every(fd => fd.stats === 2)).toBe(true);
  expect(f.opened.every(fd => fd.row.pathMtime !== fd.row.fdMtime && fd.row.pathCtime !== fd.row.fdCtime)).toBe(true);
  expect(f.state.maximumRead).toBe(65536); expect(f.descriptors.size).toBe(0);
});

it("stages exactly four fixed producer members into three packaged members with independent stable clocks", async () => {
  const f = await fixture(); expect(f.candidate.stageWindowsNodeToolchain(f.producer, f.destination)).toMatchObject({ files: 3 });
  expect([...f.rows.keys()].filter(name => path.dirname(name) === f.destination).map(name => path.basename(name)).sort()).toEqual(["LICENSE", "build-receipt.json", "node.exe"]);
  expect(f.opened.filter(fd => !fd.write)).toHaveLength(7); expect(f.opened.filter(fd => !fd.write).every(fd => fd.stats === 2)).toBe(true);
  expect(f.opened.filter(fd => fd.write)).toHaveLength(3); expect(f.state.maximumRead).toBe(65536); expect(f.state.maximumWrite).toBe(65536);
  expect(f.candidate.verifyWindowsNodeToolchain(f.destination).files).toBe(3); expect(f.descriptors.size).toBe(0);
});

for (const operation of ["verify", "stage"] as const) it.each(["pathMtime", "pathCtime", "fdMtime", "fdCtime"] as const)("%s changes during a " + operation + " capture refuse before staging", async field => {
  const f = await fixture(); let changed = false;
  f.state.afterRead = row => { if (!changed) { changed = true; row[field]++; } };
  expect(() => operation === "verify" ? f.candidate.verifyWindowsNodeToolchain(f.packaged) : f.candidate.stageWindowsNodeToolchain(f.producer, f.destination)).toThrow(REFUSAL);
  expect(changed).toBe(true); expect(f.state.closeAttempts).toBe(1); expect(f.descriptors.size).toBe(0); expect(f.rows.has(f.destination)).toBe(false); expect(f.state.writes).toBe(0);
});

it("the strict marker hash boundary refuses changed content at the unchanged pinned size", async () => {
  const f = await fixture(); f.rows.get(path.join(f.packaged, "node.exe"))!.corrupt = true;
  expect(() => f.candidate.verifyWindowsNodeToolchain(f.packaged)).toThrow(REFUSAL); expect(f.descriptors.size).toBe(0);
});

it.each(["verify", "stage"] as const)("a consumed unknown close during %s is attempted once and permanently fences all later IO", async operation => {
  const f = await fixture(); f.state.failClose = true;
  const attempt = () => operation === "verify" ? f.candidate.verifyWindowsNodeToolchain(f.packaged) : f.candidate.stageWindowsNodeToolchain(f.producer, f.destination);
  let failure: unknown; try { attempt(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain(REFUSAL); expect(String(failure)).not.toContain(PRIVATE);
  expect(f.state.closeAttempts).toBe(1); expect(f.descriptors.size).toBe(0); f.state.failClose = false;
  const calls = f.calls.length;
  expect(() => f.candidate.verifyWindowsNodeToolchain(f.packaged)).toThrow(REFUSAL);
  expect(() => f.candidate.stageWindowsNodeToolchain(f.producer, f.destination)).toThrow(REFUSAL);
  expect(f.calls).toHaveLength(calls); expect(f.state.closeAttempts).toBe(1); expect(f.rows.has(f.destination)).toBe(false);
});
