import { expect, it } from "vitest";
import { abiUnitReport } from "../fixtures/windows-uv-observer-abi-unit";
// @ts-expect-error -- pure fixed binary-report contract, outside the application TypeScript build
import { parseWindowsUvObserverAbiReport as parse } from "../../scripts/experimental/windows-uv-observer-abi-report.mjs";

it("accepts only all fixed direct-baseline and wrapped comparisons without claiming native admission", () => {
  const bytes = abiUnitReport(), value = parse(bytes);
  expect(value).toMatchObject({ schema: 1, cases: 96, checks: 127 }); expect(value.functions).toHaveLength(6);
  expect(value.functions[0]).toEqual({ functionId: 1, baselineCalls: 16, wrappedCalls: 16, argumentAndOutputChecks: 32, entryErrorChecks: 32, returnChecks: 32, afterErrorChecks: 32, ledgerChecks: 8 });
  expect(JSON.stringify(value)).not.toMatch(/admission|LPAC|path|handle|pointer|lastErrorValue|nativeEnabled/);
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.functions)).toBe(true); expect(Object.isFrozen(value.functions[0])).toBe(true);
  bytes.fill(0); expect(value.cases).toBe(96); expect(value.functions[5].functionId).toBe(6);
});

it.each(Array.from({ length: 64 }, (_, index) => index))("refuses incomplete, contradictory or expanded proof in DWORD %s", index => {
  for (const value of [0, 1, 0xffffffff]) {
    const bytes = abiUnitReport(), previous = bytes.readUInt32LE(index * 4); if (value === previous) continue;
    bytes.writeUInt32LE(value, index * 4); expect(() => parse(bytes)).toThrow("fixed observer ABI report was refused");
  }
});

it("refuses short, trailing, foreign and executable-shaped input before publishing any fields", () => {
  for (const bytes of [undefined, null, "private", {}, Buffer.alloc(0), abiUnitReport().subarray(0, 255), Buffer.concat([abiUnitReport(), Buffer.from([0])]), Buffer.alloc(4096)]) {
    expect(() => parse(bytes)).toThrow("fixed observer ABI report was refused");
  }
});

it("contains decoding exceptions without inspecting foreign error properties", () => {
  let read = 0; const foreign = new Proxy({}, { get() { read++; throw new Error("private"); } });
  const bytes = abiUnitReport(); Object.defineProperty(bytes, "readUInt32LE", { value() { throw foreign; } });
  expect(() => parse(bytes)).toThrow("fixed observer ABI report was refused"); expect(read).toBe(0);
});
