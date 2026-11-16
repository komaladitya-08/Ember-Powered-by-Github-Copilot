import { describe, expect, it } from "vitest";
import { parseWindowsUvSpawnReport, WINDOWS_UV_SPAWN_REPORT_BYTES } from "../fixtures/windows-uv-spawn-report";

const encode = (words: readonly number[]) => {
  const bytes = Buffer.alloc(WINDOWS_UV_SPAWN_REPORT_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, index * 4));
  return bytes;
};
const useful = (role: 0 | 1 = 1): number[] => {
  const words = Array<number>(64).fill(0);
  [0x53565545, 1, role, 1, 6, 31, 0, 7, 0, 1, 1, 1, 0, 0, 1, 7, 1, 1, 12, 14, 0, 0, 0, 0].forEach((word, index) => { words[index] = word; });
  words[25] = 13; words[26] = 5; words[27] = 1;
  for (let index = 0; index < 4; index++) words.splice(32 + index * 4, 4, 3, 3, 1, index + 9);
  words.splice(48, 4, 1, 1, 1, 13);
  for (let index = 52; index < 58; index += 2) { words[index] = 1 - role; words[index + 1] = role === 1 ? 5 : 0; }
  return words;
};
const refusal = (): number[] => {
  const words = useful();
  words[8] = -4048;
  for (let index = 10; index <= 19; index++) if (index !== 14 && index !== 15) words[index] = 0;
  words[27] = 0; words[28] = 1; words[29] = 5; words[30] = -4048; words[31] = 13;
  words[49] = 0; words[50] = 0;
  return words;
};
const rejected = (words: number[], role: 0 | 1 = 1) => expect(() => parseWindowsUvSpawnReport(encode(words), role)).toThrow("The stopped fixed libuv spawn report failed its bounded numeric contract.");
const changed = (words: readonly number[], index: number, value: number) => { const next = [...words]; next[index] = value; return next; };
const resequence = (words: number[]) => {
  let total = 0, lastOperation = 0, lastResult = 0;
  for (let api = 0; api < 5; api++) {
    const base = 32 + api * 4;
    if (words[base] === 0) words.fill(0, base, base + 4);
    else { total += words[base]; words[base + 3] = total; lastOperation = api + 1; lastResult = words[base + 2]; }
  }
  words[25] = total; words[26] = lastOperation; words[27] = lastResult;
  return words;
};

describe("Fixed stopped libuv spawn receipts", () => {
  it.each([0, 1] as const)("accepts role %i only after the fixed child, controls, IO and handles completed", role => {
    const report = parseWindowsUvSpawnReport(encode(useful(role)), role);
    expect(report).toMatchObject({ role, status: 1, useful: true, controls: 31, spawnResult: 0, childSpawned: 1, childExitCallbacks: 1,
      processClosed: 1, pipeClosedMask: 7, ackSeen: 1, stdinBytes: 12, stdoutBytes: 14, stderrBytes: 0, loopClose: 0 });
    expect(report.ledger.apis.process).toEqual({ calls: 1, successes: 1, lastResult: 1, lastSequence: 13 });
    expect(report.controlsObserved.canary).toEqual({ success: 1 - role, error: role === 1 ? 5 : 0 });
  });

  it("reports a fully closed synchronous refusal without calling it useful child compatibility", () => {
    const report = parseWindowsUvSpawnReport(encode(refusal()), 1);
    expect(report).toMatchObject({ status: 1, useful: false, spawnResult: -4048, childSpawned: 0, childExitCallbacks: 0, processClosed: 1, ackPolls: 0, stdinBytes: 0, stdoutBytes: 0 });
    expect(report.ledger.translation).toEqual({ count: 1, input: 5, result: -4048, sequence: 13 });
  });

  it("allows a translation before any wrapped API and does not invent an unpinned error mapping", () => {
    const words = refusal();
    words.fill(0, 24, 52); words[8] = -4058; words[28] = 1; words[29] = 3; words[30] = -4058;
    const report = parseWindowsUvSpawnReport(encode(words), 1);
    expect(report.ledger.totalCalls).toBe(0);
    expect(report.ledger.translation).toEqual({ count: 1, input: 3, result: -4058, sequence: 0 });
  });

  it("accepts the two source-pinned EPERM inputs without treating different positive inputs as equivalent", () => {
    expect(parseWindowsUvSpawnReport(encode(changed(refusal(), 29, 1314)), 1).spawnResult).toBe(-4048);
    const words = refusal(); words[8] = -4000; words[29] = 123; words[30] = -4000;
    expect(parseWindowsUvSpawnReport(encode(words), 1).ledger.translation.input).toBe(123);
  });

  it("does not classify a FALSE ConnectNamedPipe return alone as a refused spawn", () => {
    const words = useful(); words[41] = 0; words[42] = 0;
    expect(parseWindowsUvSpawnReport(encode(words), 1).useful).toBe(true);
  });

  it("allows failed named-pipe retries while still requiring exactly three successful pairs", () => {
    const words = useful(); words[32] = 4;
    expect(parseWindowsUvSpawnReport(encode(resequence(words)), 1).useful).toBe(true);
  });

  it.each([0, 1, 2, 3, 4].flatMap(api => [-1, 1].map(delta => [api, delta] as const)))(
    "rejects useful completion with API %i count changed by %i", (api, delta) => {
      const words = useful(), base = 32 + api * 4;
      words[base] += delta; words[base + 1] += delta;
      rejected(resequence(words));
    });

  it("keeps an unknown synchronous observation diagnostic rather than useful", () => {
    const words = refusal(); words[24] = 1; words[27] = 1; words[49] = 1; words[50] = 1;
    expect(parseWindowsUvSpawnReport(encode(words), 1)).toMatchObject({ useful: false, ledger: { unknown: 1 } });
  });

  it("accepts a known logic failure only with complete child/loop cleanup, and permits an honest zero failure code", () => {
    const words = useful(); words[3] = 2; words[22] = 8; words[23] = 0; words[18] = 4; words[19] = 2; words[17] = 0; words[24] = 1;
    expect(parseWindowsUvSpawnReport(encode(words), 1)).toMatchObject({ useful: false, status: 2, failOperation: 8, failCode: 0, childExitCallbacks: 1, processClosed: 1 });
    words[12] = -1; words[13] = 15; words[23] = -2; words[20] = 4096;
    expect(parseWindowsUvSpawnReport(encode(words), 1)).toMatchObject({ childExitStatus: -1, childTermSignal: 15, failCode: -2, stderrBytes: 4096 });
    rejected(changed(words, 20, 4097));
  });

  it("permits exact bounded counts and multiple observations without confusing aggregate and last outcomes", () => {
    const words = refusal(); words[25] = 4096; words[32] = 4086; words[33] = 4085; words[34] = 0; words[35] = 4086;
    words[39] = 4089; words[43] = 4092; words[47] = 4095; words[51] = 4096;
    words[31] = 4096;
    const report = parseWindowsUvSpawnReport(encode(words), 1);
    expect(report.ledger.totalCalls).toBe(4096);
    expect(report.ledger.apis.namedPipe).toEqual({ calls: 4086, successes: 4085, lastResult: 0, lastSequence: 4086 });
  });

  it.each([0, 255, 257])("rejects a report with %i bytes", length => {
    expect(() => parseWindowsUvSpawnReport(Buffer.alloc(length), 1)).toThrow("bounded numeric contract");
  });

  it("rejects non-Buffer input and unsupported expected roles with a fixed message", () => {
    expect(() => parseWindowsUvSpawnReport(new Uint8Array(256) as Buffer, 1)).toThrow("bounded numeric contract");
    expect(() => parseWindowsUvSpawnReport(encode(useful()), 2 as 1)).toThrow("bounded numeric contract");
  });

  it.each([
    [0, 0], [1, 0], [2, 0], [3, 0], [3, 3], [4, 5], [5, 30], [5, 32], [6, -1], [7, 3], [7, 8], [8, 1], [9, 0], [9, 2],
    [10, 2], [11, 2], [14, 2], [15, 3], [15, 8], [16, 501], [17, 2], [18, 13], [19, 15], [20, 1], [21, -16], [22, 9],
  ])("rejects malformed header word %i=%i", (index, value) => rejected(changed(useful(), index, value)));

  it.each([58, 59, 60, 61, 62, 63])("rejects nonzero reserved word %i", index => rejected(changed(useful(), index, 1)));

  it.each([[11, 0], [12, 1], [13, 1], [14, 0], [16, 0], [17, 0], [18, 11], [19, 13], [24, 1], [22, 1], [23, 5]])(
    "does not certify useful completion with contradictory word %i=%i", (index, value) => rejected(changed(useful(), index, value)));

  it.each([10, 11, 12, 13, 16, 17, 18, 19])("does not attach child or IO observations to synchronous refusal at word %i", index => rejected(changed(refusal(), index, 1)));

  it("requires the initialized uv_process_t close callback even when uv_spawn refuses", () => rejected(changed(refusal(), 14, 0)));

  it("rejects apparent synchronous refusal after a known successful CreateProcessW", () => {
    const words = refusal(); words[27] = 1; words[49] = 1; words[50] = 1;
    rejected(words);
  });

  it("requires exactly one successful process API for useful completion", () => {
    const words = useful(); words[25] = 12; words[26] = 4; words.fill(0, 48, 52);
    rejected(words);
  });

  it("does not accept an unclosed/uncallbacked child as a known logic failure", () => {
    const words = useful(); words[3] = 2; words[22] = 1;
    rejected(changed(words, 11, 0)); rejected(changed(words, 14, 0)); rejected(changed(words, 15, 0)); rejected(changed(words, 5, 15));
    rejected(changed(words, 22, 0));
  });

  it.each([[24, 2], [25, 4097], [26, 6], [27, 2], [28, 2], [31, 4097], [32, 4097], [33, 4], [34, 2], [35, 14]])(
    "rejects out-of-bound ledger word %i=%i", (index, value) => rejected(changed(useful(), index, value)));

  it("requires total, last operation and last result to agree with the per-API observations", () => {
    rejected(changed(useful(), 25, 6)); rejected(changed(useful(), 26, 0)); rejected(changed(useful(), 26, 4)); rejected(changed(useful(), 27, 0));
    rejected(changed(useful(), 39, 1)); rejected(changed(useful(), 35, 0));
  });

  it("rejects call counts that cannot fit before their recorded last sequence", () => {
    const words = useful(); words[25] = 14; words[32] = 4; words[33] = 4; words[35] = 3; words[51] = 14;
    words[3] = 2; words[22] = 1;
    rejected(words);
    words[25] = 15; words[35] = 4; words[36] = 4; words[37] = 4; words[39] = 7; words[43] = 10; words[47] = 13; words[51] = 15;
    rejected(words);
  });

  it.each([33, 34, 35])("requires a never-called API's observation word %i to be zero", index => {
    const words = refusal(); words.fill(0, 32, 36); words[25] = 10; words[31] = 10;
    words[39] = 3; words[43] = 6; words[47] = 9; words[51] = 10;
    words[index] = 1; rejected(words);
  });

  it("rejects impossible success aggregates even when totals and last-result fields otherwise agree", () => {
    rejected(changed(useful(), 33, 0));
    const words = refusal(); words[49] = 1;
    rejected(words);
  });

  it("requires absent translation observations to be wholly empty", () => {
    for (const index of [29, 30, 31]) rejected(changed(useful(), index, 1));
  });

  it.each([[29, 0], [29, -1], [30, 0], [30, 1], [31, 14], [30, -4000]])("rejects contradictory translation word %i=%i", (index, value) => rejected(changed(refusal(), index, value)));

  it("checks the source-pinned 5/1314 mapping and the observed spawn result separately", () => {
    const words = refusal(); words[8] = -4000; words[30] = -4000; rejected(words);
    words[29] = 1314; rejected(words);
    words[29] = 123; words[30] = -4001; rejected(words);
  });

  it.each([52, 54, 56])("requires role-specific positive/negative control observation %i", index => {
    rejected(changed(useful(), index, 1)); rejected(changed(useful(), index + 1, 0));
    rejected(changed(useful(0), index, 0), 0); rejected(changed(useful(0), index + 1, 5), 0);
  });

  it("returns detached frozen numeric facts with no raw payload or mutable input reference", () => {
    const bytes = encode(refusal()), report = parseWindowsUvSpawnReport(bytes, 1);
    bytes.fill(0x61);
    expect(report.spawnResult).toBe(-4048);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.ledger)).toBe(true);
    expect(Object.isFrozen(report.ledger.translation)).toBe(true);
    expect(Object.isFrozen(report.ledger.apis)).toBe(true);
    for (const api of Object.values(report.ledger.apis)) expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(report.controlsObserved)).toBe(true);
    for (const control of Object.values(report.controlsObserved)) expect(Object.isFrozen(control)).toBe(true);
    expect(Reflect.set(report.ledger.apis.process, "lastResult", 1)).toBe(false);
    expect(JSON.stringify(report)).not.toContain("aaaa");
    expect(() => parseWindowsUvSpawnReport(Buffer.from("PRIVATE OUTPUT AND PATH"), 1)).toThrow("The stopped fixed libuv spawn report failed its bounded numeric contract.");
  });
});
