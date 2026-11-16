import { expect, it } from "vitest";
import { windowsCommandCreatorTokenSid } from "../../app/main/agent/windows-command-creator-token";

type Kind = 1 | 4 | 31;
const BASE = 0x100000n;
function fixture(kind: Kind, parts = [21, 42, 0xffffffff], authority = 5n) {
  const offset = kind === 1 ? 16 : 8, returned = offset + 8 + 4 * parts.length;
  const bytes = Buffer.alloc(returned + 32);
  bytes.writeBigUInt64LE(BASE + BigInt(offset)); bytes[offset] = 1; bytes[offset + 1] = parts.length;
  for (let index = 0; index < 6; index++) bytes[offset + 2 + index] = Number((authority >> BigInt((5 - index) * 8)) & 255n);
  parts.forEach((part, index) => bytes.writeUInt32LE(part, offset + 8 + index * 4));
  return { bytes, returned, offset, kind, read: () => windowsCommandCreatorTokenSid(bytes, returned, BASE, kind) };
}

it.each([1, 4, 31] as const)("decodes the complete pointed SID from actual x64 token layout %s without changing the buffer", kind => {
  const f = fixture(kind), before = Buffer.from(f.bytes);
  expect(f.read()).toBe("S-1-5-21-42-4294967295"); expect(f.bytes.equals(before)).toBe(true);
});

it("keeps the full package SID and unsigned 48-bit authority private without truncating components", () => {
  const packageSid = fixture(31, [2, 1, 2, 3, 4, 5, 6, 7], 15n);
  expect(packageSid.read()).toBe("S-1-15-2-1-2-3-4-5-6-7");
  expect(fixture(4, [0, 0xffffffff], 0xffffffffffffn).read()).toBe("S-1-281474976710655-0-4294967295");
  expect(fixture(1, Array.from({ length: 15 }, (_, index) => index)).read().split("-")).toHaveLength(18);
});

it.each([1, 4, 31] as const)("refuses a SID inside allocated memory but outside the returned native byte count for layout %s", kind => {
  const f = fixture(kind);
  for (const returned of [f.offset + 7, f.offset + 8, f.returned - 1]) {
    expect(() => windowsCommandCreatorTokenSid(f.bytes, returned, BASE, kind)).toThrow("bounded SID contract");
  }
});

it.each(["null", "header", "unaligned", "outside", "revision", "zero-count", "large-count"])("refuses malformed native SID %s", mode => {
  const f = fixture(4);
  if (mode === "null") f.bytes.writeBigUInt64LE(0n);
  if (mode === "header") f.bytes.writeBigUInt64LE(BASE + 4n);
  if (mode === "unaligned") f.bytes.writeBigUInt64LE(BASE + BigInt(f.offset) + 1n);
  if (mode === "outside") f.bytes.writeBigUInt64LE(BASE + BigInt(f.returned));
  if (mode === "revision") f.bytes[f.offset] = 2;
  if (mode === "zero-count") f.bytes[f.offset + 1] = 0;
  if (mode === "large-count") f.bytes[f.offset + 1] = 16;
  expect(f.read).toThrow("bounded SID contract");
});

it.each([0, -1, 15.5, NaN, Infinity, "24", undefined, null])("refuses invalid returned size %# without coercion", returned => {
  const f = fixture(1); expect(() => windowsCommandCreatorTokenSid(f.bytes, returned, BASE, f.kind)).toThrow("bounded SID contract");
});

it.each([0n, -1n, 0x8000000000000000n, 0x7ffffffffffffff0n, 1048576, "1048576", undefined, null])("refuses invalid owned buffer address %#", base => {
  const f = fixture(4); expect(() => windowsCommandCreatorTokenSid(f.bytes, f.returned, base, f.kind)).toThrow("bounded SID contract");
});

it("requires the correct TokenUser header and an actual bounded Buffer", () => {
  const f = fixture(4);
  expect(() => windowsCommandCreatorTokenSid(f.bytes, f.returned, BASE, 1)).toThrow("bounded SID contract");
  expect(() => windowsCommandCreatorTokenSid(f.bytes, f.bytes.length + 1, BASE, 4)).toThrow("bounded SID contract");
  expect(() => windowsCommandCreatorTokenSid(new Uint8Array(f.bytes) as unknown as Buffer, f.returned, BASE, 4)).toThrow("bounded SID contract");
});

it("does not consult coercion hooks on foreign returned sizes or addresses", () => {
  const f = fixture(4); let touched = 0;
  const foreign = new Proxy({}, { get() { touched++; throw new Error("Foreign coercion was consulted."); } });
  expect(() => windowsCommandCreatorTokenSid(f.bytes, foreign, BASE, 4)).toThrow("bounded SID contract");
  expect(() => windowsCommandCreatorTokenSid(f.bytes, f.returned, foreign, 4)).toThrow("bounded SID contract");
  expect(touched).toBe(0);
});
