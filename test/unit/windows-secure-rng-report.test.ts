import { describe, expect, it } from "vitest";
import { parseWindowsSecureRngReport, WINDOWS_SECURE_RNG_REPORT_BYTES } from "../fixtures/windows-secure-rng-report";

type Role = 0 | 1;
const USEFUL = [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0];
const SKIPPED = Array<number>(12).fill(0);
const denied = (code: number) => [1, 0, code, 0, 0, 0, 0, 0, 0, 1, 0, 0];
const generationFailed = (code: number) => [1, 1, 0, 1, 0, code, 1, 1, 0, 1, 0, 0];
function report(role: Role = 1, defaultProvider = USEFUL, intelProvider = SKIPPED, cngStatus = 0): Buffer {
  const deniedCode = role === 1 ? 5 : 0;
  const words = [0x47525345, 1, role, 1, 6, 31, deniedCode, 0, deniedCode, deniedCode, deniedCode, 6, 1, 0, 0, 0,
    ...defaultProvider, ...intelProvider, 1, cngStatus, cngStatus === 0 ? 1 : 0, 1, 0, 0, 0, 0];
  const bytes = Buffer.alloc(WINDOWS_SECURE_RNG_REPORT_BYTES);
  words.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
}
function changed(bytes: Buffer, updates: readonly (readonly [number, number])[]): Buffer {
  const copy = Buffer.from(bytes);
  for (const [word, value] of updates) copy.writeUInt32LE(value, word * 4);
  return copy;
}
const refuses = (bytes: Buffer, role: Role = 1) => expect(() => parseWindowsSecureRngReport(bytes, role)).toThrow("exact numeric contract");

describe("secure RNG report framing and completed checkpoints", () => {
  it.each([0, 1] as const)("keeps role %s control evidence distinct from RNG outcomes", role => {
    const value = parseWindowsSecureRngReport(report(role, denied(0x80090016), USEFUL, 0xc0000022), role);
    expect(value).toMatchObject({ role, status: 1, controls: 31, canaryCode: role === 1 ? 5 : 0, selfCode: 0,
      parentReadCode: role === 1 ? 5 : 0, parentDuplicateCode: role === 1 ? 5 : 0, parentCreateCode: role === 1 ? 5 : 0 });
    expect(value.defaultProvider.generated).toBe(0); expect(value.conditionalIntel.generated).toBe(1);
    expect(value.cng).toEqual({ attempted: 1, status: 0xc0000022, generated: 0, wiped: 1 });
  });
  it("decodes a fully finished failed control run without promoting it to success", () => {
    const input = changed(report(), [[3, 2], [5, 15], [10, 13]]);
    expect(parseWindowsSecureRngReport(input, 1)).toMatchObject({ status: 2, controls: 15, parentCreateCode: 13 });
  });
  it.each([0, 2, 191, 193, 384])("refuses incomplete or concatenated framing of %s bytes", length => refuses(Buffer.alloc(length)));
  it("rejects typed-array input and an untrusted role even when the bytes otherwise match", () => {
    const input = report();
    expect(() => parseWindowsSecureRngReport(new Uint8Array(input) as Buffer, 1)).toThrow("exact numeric contract");
    for (const role of [-1, 2, NaN, Infinity]) expect(() => parseWindowsSecureRngReport(input, role as Role)).toThrow("exact numeric contract");
    refuses(input, 0);
  });
  it.each([
    ["wrong magic", 0, 0x45535247], ["foreign schema", 1, 2], ["foreign role", 2, 0],
    ["running", 3, 0], ["uncertain", 3, 3], ["unknown status", 3, 0xffffffff],
    ["preflight checkpoint", 4, 1], ["before final checkpoint", 4, 5], ["extra stage", 4, 7],
    ["incomplete checkpoints", 11, 5], ["unexecuted checkpoints", 11, 0], ["extra checkpoint", 11, 7],
    ["global unwiped", 12, 0], ["nonboolean wipe", 12, 2], ["terminal ownership", 13, 1],
    ["header reserved one", 14, 1], ["header reserved two", 15, 1],
    ["control mask overflow", 5, 32], ["success with missing control", 5, 30], ["failure with complete controls", 3, 2],
  ] as const)("refuses %s", (_description, word, value) => refuses(changed(report(), [[word, value]])));
  it.each([6, 7, 8, 9, 10])("does not accept a claimed passing control with contradictory code at word %s", word => {
    refuses(changed(report(), [[word, word === 7 ? 5 : 0]]));
    refuses(changed(report(0), [[word, 5]]), 0);
  });
});

describe("secure RNG provider sequencing and known ownership", () => {
  it.each([0, 5, 0x80090016, 0xffffffff])("preserves acquire denial code %s without manufacturing successful ownership", code => {
    const value = parseWindowsSecureRngReport(report(1, denied(code), denied(code)), 1);
    for (const provider of [value.defaultProvider, value.conditionalIntel]) {
      expect(provider).toEqual({ attempted: 1, acquired: 0, acquireCode: code, generateAttempted: 0, generated: 0, generateCode: 0,
        releaseAttempted: 0, released: 0, releaseCode: 0, wiped: 1, knownClosed: true });
    }
  });
  it.each([0, 5, 0xffffffff])("preserves a known-released failed generation code %s and permits the conditional attempt", code => {
    const value = parseWindowsSecureRngReport(report(1, generationFailed(code), USEFUL), 1);
    expect(value.defaultProvider).toMatchObject({ acquired: 1, generated: 0, generateCode: code, released: 1, releaseCode: 0, wiped: 1, knownClosed: true });
    expect(value.conditionalIntel.generated).toBe(1);
  });
  it.each([
    ["default skipped", SKIPPED, USEFUL], ["conditional skipped after acquire denial", denied(5), SKIPPED],
    ["conditional skipped after generation failure", generationFailed(5), SKIPPED],
    ["conditional acquire after default success", USEFUL, denied(5)], ["conditional success after default success", USEFUL, USEFUL],
  ] as const)("refuses %s", (_description, defaultProvider, intelProvider) => {
    refuses(report(1, [...defaultProvider], [...intelProvider]));
  });
  it.each([16, 28])("refuses pending, unreleased, forged-error and unwiped acquired context states at offset %s", offset => {
    const base = offset === 16 ? report() : report(1, denied(5), USEFUL);
    const contradictions: readonly (readonly [string, number, number])[] = [
      ["attempt is not boolean", 0, 2], ["acquired is not boolean", 1, 2], ["success has acquire error", 2, 5],
      ["generation not attempted", 3, 0], ["generation attempt not boolean", 3, 2], ["generation result not boolean", 4, 2],
      ["generation success has error", 5, 5], ["release not attempted", 6, 0], ["release attempt not boolean", 6, 2],
      ["release failed", 7, 0], ["release result not boolean", 7, 2], ["release success has error", 8, 5],
      ["buffer not wiped", 9, 0], ["wipe not boolean", 9, 2], ["context still held", 10, 1],
      ["context ownership uncertain", 10, 2], ["provider reserved", 11, 1],
    ];
    for (const [description, word, value] of contradictions) {
      expect(() => parseWindowsSecureRngReport(changed(base, [[offset + word, value]]), 1), description).toThrow("exact numeric contract");
    }
  });
  it.each([16, 28])("does not admit generation, release or ownership after failed acquire at offset %s", offset => {
    const base = report(1, denied(5), denied(5));
    for (const word of [3, 4, 5, 6, 7, 8, 10, 11]) refuses(changed(base, [[offset + word, 1]]));
    refuses(changed(base, [[offset + 9, 0]]));
  });
  it("does not let a skipped conditional provider carry even one status, error, wipe or ownership field", () => {
    for (let word = 1; word < 12; word++) refuses(changed(report(), [[28 + word, 1]]));
  });
});

describe("secure RNG independent CNG and public readout", () => {
  it.each([1, 0x80000000, 0xc0000022, 0xffffffff])("keeps nonzero NTSTATUS %s distinct from provider and control success", status => {
    const value = parseWindowsSecureRngReport(report(1, USEFUL, SKIPPED, status), 1);
    expect(value.status).toBe(1); expect(value.defaultProvider.generated).toBe(1);
    expect(value.cng).toEqual({ attempted: 1, status, generated: 0, wiped: 1 });
  });
  it.each([
    ["not attempted", 40, 0], ["nonboolean attempt", 40, 2], ["failure marked successful", 41, 0xc0000022],
    ["success marked failed", 42, 0], ["nonboolean result", 42, 2], ["unwiped", 43, 0], ["nonboolean wipe", 43, 2],
    ["reserved zero", 44, 1], ["reserved one", 45, 1], ["reserved two", 46, 1], ["reserved three", 47, 1],
  ] as const)("refuses CNG %s", (_description, word, value) => refuses(changed(report(), [[word, value]])));
  it("returns a detached frozen status-only tree with no raw report buffer", () => {
    const input = report(1, denied(0x80090016), generationFailed(5), 0xc0000022);
    const value = parseWindowsSecureRngReport(input, 1), snapshot = JSON.stringify(value);
    expect(Object.keys(value).sort()).toEqual(["role", "status", "controls", "canaryCode", "selfCode", "parentReadCode", "parentDuplicateCode", "parentCreateCode",
      "buffersWiped", "defaultProvider", "conditionalIntel", "cng"].sort());
    for (const object of [value, value.defaultProvider, value.conditionalIntel, value.cng]) {
      expect(Object.isFrozen(object)).toBe(true); expect(Reflect.set(object, "entropy", Buffer.alloc(48))).toBe(false);
    }
    input.fill(0); expect(JSON.stringify(value)).toBe(snapshot);
    expect(snapshot).not.toMatch(/entropy|providerName|path|sha256|Buffer|Uint8Array/);
  });
});
