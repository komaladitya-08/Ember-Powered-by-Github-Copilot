import { expect, it } from "vitest";
import { parseWindowsLibuvProbeReport, WINDOWS_LIBUV_PROBE_BYTES } from "../fixtures/windows-libuv-probe-report";

const successful = () => {
  const words = [0x50565545, 1, 1, 1, 10, 1, 0, 0, 63, 24, 24, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 15, 12, 0];
  const bytes = Buffer.alloc(WINDOWS_LIBUV_PROBE_BYTES); words.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes;
};
const parse = (bytes: Buffer) => parseWindowsLibuvProbeReport(bytes, { build: 1, token: 1 });

it("accepts a complete fixed operation witness and returns only immutable bounded numeric facts", () => {
  const result = parse(successful());
  expect(result).toMatchObject({ stage: 10, status: 1, features: 63, syncBytes: 24, asyncBytes: 24, loopClose: 0, cleanup: 15 });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.values(result).every(value => typeof value === "number")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/path|payload|identity|file:|S-1-/);
});

it("preserves an incomplete flushed pre-initialization checkpoint without claiming useful work", () => {
  const bytes = Buffer.alloc(WINDOWS_LIBUV_PROBE_BYTES);
  [0x50565545, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xffffffff, 0xffffffff, 0xffffffff, 0, 2, 0]
    .forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  expect(parseWindowsLibuvProbeReport(bytes, { build: 0, token: 1 })).toMatchObject({ status: 0, stage: 1, features: 0, loopInit: 0xffffffff });
});

it.each([[0, 0], [1, 2], [2, 0], [3, 0], [4, 11], [5, 3], [6, 5], [8, 64], [9, 25], [10, 25], [11, 2], [13, 2], [17, 2], [21, 16], [22, 0], [22, 33], [23, 1]])(
  "refuses unknown schema, wrong build/token, bounds or hidden fields at %s", (index, value) => {
    const bytes = successful(); bytes.writeUInt32LE(value, index * 4);
    expect(() => parse(bytes)).toThrow("bounded numeric contract");
  },
);

it.each([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])("requires every useful-work/cleanup witness rather than accepting stage ten alone: %s", index => {
  const bytes = successful(); bytes.writeUInt32LE(index >= 18 && index <= 20 ? 1 : 0, index * 4);
  expect(() => parse(bytes)).toThrow("bounded numeric contract");
});

it.each([0, 95, 97, 4096])("rejects malformed byte lengths without returning raw content: %s", length => {
  const bytes = Buffer.alloc(length, 0x41);
  expect(() => parse(bytes)).toThrow("bounded numeric contract");
});

it("requires coherent explicit failed/error records and does not echo failed content", () => {
  const bytes = successful(); bytes.writeUInt32LE(8, 4 * 4); bytes.writeUInt32LE(2, 5 * 4);
  expect(() => parse(bytes)).toThrow();
  bytes.writeUInt32LE(2, 6 * 4); bytes.writeUInt32LE(0xfffffffb, 7 * 4);
  expect(parse(bytes)).toMatchObject({ status: 2, errorDomain: 2, errorCode: 0xfffffffb });
  const wrong = Buffer.from("private content, not a report".padEnd(96));
  expect(() => parse(wrong)).toThrow("bounded numeric contract");
});
