/** Closed report checks plus Linux-only execution of the actual useful/failure C bodies with fixed logic mocks, not Windows ABI proof. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWindowsCommandCreatorOwnerReport, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC } from "../fixtures/windows-command-creator-owner-report";
import { parseWindowsCommandCopyReport, WINDOWS_COMMAND_COPY_REPORT_MAGIC } from "../fixtures/windows-command-copy-report";

type Mode = "useful" | "writer" | "revoked" | "acl-host";
const modes: readonly Mode[] = ["useful", "writer", "revoked", "acl-host"];
const numericMode = (mode: Mode) => modes.indexOf(mode) + 1;
const encode = (words: readonly number[]) => {
  const bytes = Buffer.alloc(WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, index * 4));
  return bytes;
};
const complete = (mode: Mode = "useful") => {
  const numeric = numericMode(mode), words = Array<number>(32).fill(0);
  words.splice(0, 16, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC, 2, numeric, 1, mode === "writer" ? 13 : 19,
    mode === "useful" ? 0xfff : mode === "writer" ? 0xf01 : mode === "revoked" ? 0xf07 : 0,
    ...Array<number>(4).fill(mode === "acl-host" ? 0 : 5), ...Array<number>(3).fill(mode === "revoked" ? 5 : 0), 0, mode === "writer" ? 1 : 0, 0);
  if (mode === "useful" || mode === "acl-host") words.splice(16, 10, 3, 15, mode === "acl-host" ? 15 : 0, 15,
    ...Array<number>(4).fill(mode === "useful" ? 5 : 0), 15, 3);
  return words;
};
const mutate = (words: readonly number[], offset: number, value: number) => { const next = [...words]; next[offset] = value; return next; };
const refusal = (words: readonly number[], mode: Mode = "useful") => expect(() => parseWindowsCommandCreatorOwnerReport(encode(words), mode)).toThrow("numeric contract");
const legacyFailure = (mode: "useful" | "writer" | "revoked", operation: number) => {
  const words = complete(mode); if (mode !== "useful" || operation <= 4) words.fill(0, 16);
  words[3] = 2; words[4] = operation; words[13] = 32; words[14] = 0;
  if (operation <= 4) {
    words[5] = 0; words.fill(0, 6, 13);
    for (let probe = 1; probe < operation; probe++) { words[5] |= 0x100 << (probe - 1); words[5 + probe] = 5; }
    if (operation > 0) words[5 + operation] = 32;
  } else {
    words[5] = 0xf00;
    if (mode === "useful") words[5] |= (1 << (operation - 5)) - 1;
    if (mode === "revoked") {
      words.fill(0, 10, 13); words[5] |= (1 << (operation - 16)) - 1;
      for (let probe = 16; probe < operation; probe++) words[probe - 6] = 5;
      words[operation - 6] = 32;
    }
  }
  return words;
};
const aclFailure = (mode: "useful" | "acl-host", operation: number, error = 32, unexpectedGrant = false) => {
  const words = complete(mode); words[3] = 2; words[4] = operation; words[13] = unexpectedGrant ? 13 : error;
  if (mode === "useful") words[5] = 0xf00;
  if (operation === 26 || operation === 27) { words[25] = operation - 26; return words; }
  words.fill(0, 16);
  if (operation === 20 || operation === 21) { words[16] = operation - 20; return words; }
  const index = operation - 22, prefix = (1 << index) - 1, current = 1 << index;
  words[16] = 3; words[17] = prefix | current; words[24] = prefix;
  for (let prior = 0; prior < index; prior++) words[20 + prior] = mode === "useful" ? 5 : 0;
  words[18] = mode === "acl-host" ? prefix : unexpectedGrant ? current : 0; words[19] = words[17];
  words[20 + index] = unexpectedGrant ? 0 : error;
  return words;
};

describe("Closed creator-owner command-copy numeric reports", () => {
  it.each(modes)("decodes the exact completed %s mode without importing legacy magic or schema", mode => {
    const parsed = parseWindowsCommandCreatorOwnerReport(encode(complete(mode)), mode);
    expect(parsed).toMatchObject({ mode: numericMode(mode), status: 1, operation: mode === "writer" ? 13 : 19, failedOperationError: 0 });
    expect(parsed.acl).toEqual(mode === "useful" ? { createdMask: 3, attemptMask: 15, grantedMask: 0, closedMask: 15, errors: [5, 5, 5, 5], validatedMask: 15, removedMask: 3 }
      : mode === "acl-host" ? { createdMask: 3, attemptMask: 15, grantedMask: 15, closedMask: 15, errors: [0, 0, 0, 0], validatedMask: 15, removedMask: 3 }
        : { createdMask: 0, attemptMask: 0, grantedMask: 0, closedMask: 0, errors: [0, 0, 0, 0], validatedMask: 0, removedMask: 0 });
  });

  it.each(["useful", "writer", "revoked"] as const)("preserves the existing decoded facts for completed %s", mode => {
    const words = complete(mode), legacy = encode(words).subarray(0, 64); legacy.writeUInt32LE(WINDOWS_COMMAND_COPY_REPORT_MAGIC, 0); legacy.writeUInt32LE(1, 4);
    const original = parseWindowsCommandCopyReport(legacy, mode), { acl, ...facts } = parseWindowsCommandCreatorOwnerReport(encode(words), mode);
    expect(facts).toEqual(original); expect(acl).toBeDefined();
  });

  it.each(Array.from({ length: 13 }, (_, operation) => operation))("keeps legacy useful failure %i and forbids invented later ACL progress", operation => {
    const words = legacyFailure("useful", operation), parsed = parseWindowsCommandCreatorOwnerReport(encode(words), "useful");
    expect(parsed).toMatchObject({ status: 2, operation, failedOperationError: 32,
      acl: { createdMask: operation <= 4 ? 0 : 3, attemptMask: operation <= 4 ? 0 : 15, validatedMask: operation <= 4 ? 0 : 15, removedMask: operation <= 4 ? 0 : 3 } });
    refusal(mutate(words, 16, 1));
  });

  it.each([...[0, 1, 2, 3, 4, 13].map(operation => ["writer", operation] as const), ...[0, 1, 2, 3, 4, 16, 17, 18].map(operation => ["revoked", operation] as const)])(
    "retains the original %s failure operation %i", (mode, operation) => {
      const words = legacyFailure(mode, operation), legacy = encode(words).subarray(0, 64); legacy.writeUInt32LE(WINDOWS_COMMAND_COPY_REPORT_MAGIC, 0); legacy.writeUInt32LE(1, 4);
      const { acl, ...facts } = parseWindowsCommandCreatorOwnerReport(encode(words), mode);
      expect(facts).toEqual(parseWindowsCommandCopyReport(legacy, mode)); expect(acl.createdMask).toBe(0);
    });

  it.each(["useful", "acl-host"] as const)("reports known creation failures without later permission attempts in %s", mode => {
    for (const operation of [20, 21]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure(mode, operation)), mode);
      expect(parsed).toMatchObject({ status: 2, operation, failedOperationError: 32,
        acl: { createdMask: operation - 20, attemptMask: 0, grantedMask: 0, closedMask: 0, errors: [0, 0, 0, 0], validatedMask: 0, removedMask: 0 } });
    }
  });

  it.each([22, 23, 24, 25])("keeps a useful wrong-error refusal at ACL operation %i, including honest code0", operation => {
    for (const error of [0, 32, 0xffffffff]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure("useful", operation, error)), "useful");
      expect(parsed.failedOperationError).toBe(error); expect(parsed.acl.errors[operation - 22]).toBe(error);
      expect(parsed.acl.grantedMask).toBe(0); expect(parsed.acl.validatedMask).toBe((1 << (operation - 22)) - 1);
    }
  });

  it.each([22, 23, 24, 25])("records an unexpected useful ACL grant only after its known close at operation %i", operation => {
    const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure("useful", operation, 0, true)), "useful"), bit = 1 << (operation - 22);
    expect(parsed.failedOperationError).toBe(13); expect(parsed.acl.grantedMask).toBe(bit); expect(parsed.acl.closedMask).toBe((bit << 1) - 1);
  });

  it.each([22, 23, 24, 25])("records ordinary-host refusal after only the prior validated grants at operation %i", operation => {
    for (const error of [0, 5, 32, 0xffffffff]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure("acl-host", operation, error)), "acl-host"), prefix = (1 << (operation - 22)) - 1;
      expect(parsed.acl).toMatchObject({ grantedMask: prefix, closedMask: (prefix << 1) | 1, validatedMask: prefix });
      expect(parsed.acl.errors[operation - 22]).toBe(error);
    }
  });

  it.each(["useful", "acl-host"] as const)("reports cleanup failures after the complete ACL proof in %s", mode => {
    for (const operation of [26, 27]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure(mode, operation, 0)), mode);
      expect(parsed).toMatchObject({ status: 2, operation, failedOperationError: 0, features: mode === "useful" ? 0xf00 : 0,
        acl: { createdMask: 3, attemptMask: 15, closedMask: 15, validatedMask: 15, removedMask: operation - 26 } });
      expect(parsed.acl.errors).toEqual(Array<number>(4).fill(mode === "useful" ? 5 : 0));
    }
  });

  it("counts denied right attempts as finished ownership without claiming four native handle closes", () => {
    const parsed = parseWindowsCommandCreatorOwnerReport(encode(complete()), "useful");
    expect(parsed.acl.grantedMask).toBe(0); expect(parsed.acl.closedMask).toBe(15); expect(parsed.acl.attemptMask).toBe(15);
  });

  it.each([0, 64, 127, 129, 4096])("rejects a nonexact %i-byte report", length => expect(() => parseWindowsCommandCreatorOwnerReport(Buffer.alloc(length), "useful")).toThrow("numeric contract"));

  it("rejects non-Buffer input, unsupported modes and foreign mode/schema/magic", () => {
    expect(() => parseWindowsCommandCreatorOwnerReport(new Uint8Array(128) as Buffer, "useful")).toThrow("numeric contract");
    expect(() => parseWindowsCommandCreatorOwnerReport(encode(complete()), "foreign" as Mode)).toThrow("numeric contract");
    refusal(mutate(complete(), 0, WINDOWS_COMMAND_COPY_REPORT_MAGIC)); refusal(mutate(complete(), 1, 1));
    for (const mode of modes) for (const other of modes) if (mode !== other) refusal(complete(other), mode);
  });

  it.each([15, 26, 27, 28, 29, 30, 31])("rejects nonzero reserved field %i", offset => refusal(mutate(complete(), offset, 1)));

  it.each([[3, 0], [3, 3], [4, 20], [5, 0xffe], [5, 0x1fff], [6, 0], [7, 32], [8, 3], [9, 0], [10, 5], [11, 5], [12, 5], [13, 1], [14, 1]])(
    "rejects contradictory completed legacy fact %i=%i", (offset, value) => refusal(mutate(complete(), offset, value)));

  it.each([[16, 0], [16, 1], [16, 7], [17, 7], [17, 31], [18, 1], [19, 1], [20, 0], [21, 32], [22, 0], [23, 0], [24, 7], [24, 16], [25, 0], [25, 1], [25, 7]])(
    "rejects contradictory completed useful ACL fact %i=%i", (offset, value) => refusal(mutate(complete(), offset, value)));

  it.each([[5, 1], [6, 5], [7, 5], [8, 5], [9, 5], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [16, 1], [17, 7], [18, 7], [19, 7], [20, 5], [21, 5], [22, 5], [23, 5], [24, 7], [25, 0], [25, 1], [25, 7]])(
    "rejects a forged completed ordinary ACL control fact %i=%i", (offset, value) => refusal(mutate(complete("acl-host"), offset, value), "acl-host"));

  it.each(["writer", "revoked"] as const)("rejects any ACL progress added to the unchanged %s mode", mode => {
    for (let offset = 16; offset <= 25; offset++) refusal(mutate(complete(mode), offset, 1), mode);
  });

  it.each(["useful", "acl-host"] as const)("rejects impossible creation-failure progress in %s", mode => {
    refusal(mutate(aclFailure(mode, 20), 16, 1), mode); refusal(mutate(aclFailure(mode, 21), 16, 0), mode);
    for (const offset of [17, 18, 19, 20, 21, 22, 23, 24, 25]) refusal(mutate(aclFailure(mode, 21), offset, 1), mode);
  });

  it.each(["useful", "acl-host"] as const)("rejects skipped, repeated and future right-attempt progress in %s", mode => {
    const words = aclFailure(mode, 24);
    for (const [offset, value] of [[16, 1], [17, 3], [17, 15], [17, 16], [24, 1], [24, 7], [24, 2], [23, 32]]) refusal(mutate(words, offset, value), mode);
  });

  it.each(["useful", "acl-host"] as const)("rejects premature or skipped cleanup progress in %s", mode => {
    refusal(mutate(aclFailure(mode, 26), 25, 1), mode); refusal(mutate(aclFailure(mode, 27), 25, 0), mode); refusal(mutate(aclFailure(mode, 27), 25, 3), mode);
    for (const offset of [16, 17, 19, 24]) refusal(mutate(aclFailure(mode, 26), offset, 0), mode);
    refusal(mutate(aclFailure(mode, 24), 25, 1), mode);
  });

  it("keeps native refusal errors consistent and distinguishes an unexpected grant from GetLastError", () => {
    for (const mode of ["useful", "acl-host"] as const) refusal(mutate(aclFailure(mode, 24, 32), 13, 0), mode);
    refusal(mutate(aclFailure("useful", 24, 0, true), 13, 0));
    refusal(mutate(aclFailure("useful", 24, 0, true), 13, 5));
  });

  it("does not label an expected useful denial or successful host grant as the failed current attempt", () => {
    for (const operation of [22, 23, 24, 25]) {
      refusal(aclFailure("useful", operation, 5));
      const words = aclFailure("acl-host", operation, 0), bit = 1 << (operation - 22);
      words[18] |= bit; words[19] |= bit; refusal(words, "acl-host");
    }
  });

  it("rejects unknown close ownership and grants on unattempted or already validated-denied slots", () => {
    const granted = aclFailure("useful", 24, 0, true); refusal(mutate(granted, 19, 0));
    const host = aclFailure("acl-host", 24); refusal(mutate(host, 19, 1), "acl-host");
    const wrong = aclFailure("useful", 24); wrong[18] = 1; wrong[19] = 1; refusal(wrong);
    const future = aclFailure("acl-host", 24); future[18] = 11; future[19] = 11; refusal(future, "acl-host");
  });

  it("preserves raw finite errors without payload and returns a detached deeply frozen observation", () => {
    const bytes = encode(aclFailure("useful", 24, 0xffffffff)), parsed = parseWindowsCommandCreatorOwnerReport(bytes, "useful");
    bytes.fill(0x41); expect(parsed.failedOperationError).toBe(0xffffffff); expect(parsed.acl.errors).toEqual([5, 5, 0xffffffff, 0]);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.acl)).toBe(true); expect(Object.isFrozen(parsed.acl.errors)).toBe(true);
    expect(Reflect.set(parsed.acl.errors, "0", 0)).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("AAAA");
    expect(() => parseWindowsCommandCreatorOwnerReport(Buffer.from("PRIVATE PATH AND CONTENT"), "useful")).toThrow("numeric contract");
  });
});

// Extract the production bodies rather than restating the replacement decision in a TypeScript model.
const actualFunction = (source: string, signature: string) => {
  const start = source.indexOf(signature), opening = source.indexOf("{", start);
  if (start < 0 || opening < 0) throw new Error("The fixed C logic fixture is unavailable.");
  let depth = 1, end = opening + 1;
  for (; end < source.length && depth > 0; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  if (depth !== 0) throw new Error("The fixed C logic fixture is unavailable.");
  return source.slice(start, end);
};

describe.skipIf(process.platform !== "linux")("Actual creator-owner C replacement failure logic with fixed non-Windows mocks", () => {
  let directory = "", executable = "";
  beforeAll(() => {
    const source = readFileSync(path.resolve("test/fixtures/windows-command-creator-owner-proof.c"), "utf8");
    const declarations = source.slice(source.indexOf("#define CHARS"), source.indexOf("/* A failed close"));
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-creator-logic-"));
    executable = path.join(directory, "logic");
    const fixture = path.join(directory, "logic.c");
    writeFileSync(fixture, `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef wchar_t WCHAR;
typedef intptr_t HANDLE;
#define INVALID_HANDLE_VALUE ((HANDLE)-1)
#define OPEN_EXISTING 3u
#define CREATE_NEW 1u
#define MOVEFILE_REPLACE_EXISTING 1u
${declarations}
static int scenario, bad, joins, writes, moves, removals, reads, lastErrors, closes, publications;
static int join(const WCHAR *root, const WCHAR *name, WCHAR *output) {
  (void)root; joins++;
  if (record[OPERATION] == REPLACE_FILE && ((scenario == 8 && wcscmp(name, L"replacement.tmp") == 0)
      || (scenario == 9 && wcscmp(name, L"replace.txt") == 0))) { errorCode = 206; return 0; }
  wcscpy(output, name); return 1;
}
static int readSeed(const WCHAR *file) {
  reads++; if (wcscmp(file, L"seed.txt") != 0) bad = 1;
  if (scenario == 3) { errorCode = 5; return 0; } return 1;
}
static int writeFixed(const WCHAR *file, const char *bytes, DWORD length, DWORD disposition) {
  writes++;
  if (record[OPERATION] == EDIT_SEED) {
    if (wcscmp(file, L"seed.txt") || bytes != edited || length != sizeof(edited)-1 || disposition != OPEN_EXISTING) bad = 1;
  } else if (record[OPERATION] == CREATE_FILE) {
    if (wcscmp(file, L"created.txt") || bytes != created || length != sizeof(created)-1 || disposition != CREATE_NEW) bad = 1;
  } else if (record[OPERATION] == REPLACE_FILE) {
    if (wcscmp(file, L"replacement.tmp") || bytes != replaced || length != sizeof(replaced)-1 || disposition != CREATE_NEW) bad = 1;
  } else bad = 1;
  if ((record[OPERATION] == REPLACE_FILE && (scenario == 1 || scenario == 12))
      || (record[OPERATION] == EDIT_SEED && scenario == 10) || (record[OPERATION] == CREATE_FILE && scenario == 11)) {
    if (replacementFailureExit != 1) bad = 1;
    errorCode = 5; return 0;
  } return 1;
}
static int MoveFileExW(const WCHAR *from, const WCHAR *to, DWORD flags) {
  moves++;
  if (record[OPERATION] == RENAME_FILE) {
    if (wcscmp(from, L"move.txt") || wcscmp(to, L"renamed.txt") || flags != 0) bad = 1;
    return scenario != 4;
  }
  if (record[OPERATION] != REPLACE_FILE || wcscmp(from, L"replacement.tmp") || wcscmp(to, L"replace.txt") || flags != MOVEFILE_REPLACE_EXISTING) bad = 1;
  return scenario != 2 && scenario != 13;
}
static DWORD GetLastError(void) {
  lastErrors++;
  /* The diagnostic marker must be assigned only after the original failed-API error capture. */
  if (replacementFailureExit != 1) bad = 1;
  return 5;
}
static int removePosix(const WCHAR *file, int isDirectory) {
  removals++;
  if ((record[OPERATION] == REMOVE_FILE && (wcscmp(file, L"remove.txt") || isDirectory))
      || (record[OPERATION] == REMOVE_CHILD && (wcscmp(file, L"staged-folder\\\\child.txt") || isDirectory))
      || (record[OPERATION] == REMOVE_DIRECTORY && (wcscmp(file, L"staged-folder") || !isDirectory))) bad = 1;
  if ((scenario == 5 && record[OPERATION] == REMOVE_FILE) || (scenario == 6 && record[OPERATION] == REMOVE_CHILD)
      || (scenario == 7 && record[OPERATION] == REMOVE_DIRECTORY)) { errorCode = 5; return 0; } return 1;
}
static int closeKnown(HANDLE *owned) {
  if (owned != &heartbeatFile || publications != 0) bad = 1;
  closes++; *owned = INVALID_HANDLE_VALUE; return 1;
}
static int publish(const WCHAR *report) {
  (void)report; publications++;
  if ((scenario == 0 && closes != 0) || (scenario != 0 && (closes != 1 || record[STATUS] != FAILED || record[OPERATION_ERROR] != errorCode))) bad = 1;
  /* A later publication error must not replace the already captured operation-error field. */
  errorCode = 123;
  return scenario != 12 && scenario != 13;
}
${actualFunction(source, "static int useful(const WCHAR *root)")}
${actualFunction(source, "static int failed(const WCHAR *report)")}
int main(int argc, char **argv) {
  int ok, result;
  static const DWORD expectedOp[] = {19,9,9,5,8,10,11,12,9,9,6,7,9,9};
  static const DWORD expectedFeatures[] = {0xfff,0xf0f,0xf0f,0xf00,0xf07,0xf1f,0xf3f,0xf7f,0xf0f,0xf0f,0xf01,0xf03,0xf0f,0xf0f};
  static const int expectedExit[] = {0,211,212,1,1,1,1,1,211,211,1,1,211,212};
  (void)heartbeat; (void)readyStaging; (void)seed;
  if (argc != 2) return 230;
  scenario = atoi(argv[1]); if (scenario < 0 || scenario > 13) return 230;
  record[MAGIC] = REPORT_MAGIC; record[VERSION] = 2; record[MODE] = USEFUL; record[FEATURES] = 0xf00;
  record[SOURCE_READ] = record[SOURCE_WRITE] = record[CANARY_READ] = record[CANARY_WRITE] = 5;
  record[ACL_CREATED] = record[ACL_REMOVED] = 3;
  record[ACL_ATTEMPTED] = record[ACL_CLOSED] = record[ACL_VALIDATED] = 15;
  record[ACL_FILE_DAC_ERROR] = record[ACL_FILE_OWNER_ERROR] = record[ACL_DIRECTORY_DAC_ERROR] = record[ACL_DIRECTORY_OWNER_ERROR] = 5;
  ok = useful(L"fixed-root");
  if (ok) {
    if (scenario != 0 || joins != 9 || writes != 3 || moves != 2 || removals != 3 || reads != 1 || lastErrors != 0 || replacementFailureExit != 1) bad = 1;
    record[STATUS] = COMPLETE; record[OPERATION] = DONE; publish(L"fixed-report"); result = 0;
  } else result = failed(L"fixed-report");
  if (bad || result != expectedExit[scenario] || record[OPERATION] != expectedOp[scenario]
      || record[FEATURES] != expectedFeatures[scenario] || publications != 1
      || lastErrors != ((scenario == 2 || scenario == 4 || scenario == 13) ? 1 : 0)
      || (scenario != 0 && record[OPERATION_ERROR] != ((scenario == 8 || scenario == 9) ? 206u : 5u))) return 230;
  if (fwrite(record, 1, sizeof(record), stdout) != sizeof(record)) return 230;
  return result;
}
`);
    const compiled = spawnSync("cc", ["-std=c11", "-O0", "-Wall", "-Wextra", "-Werror", fixture, "-o", executable], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 4096,
    });
    expect(compiled.status, "The fixed C logic mock must compile without forwarding compiler output.").toBe(0);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it.each([
    [0, "all eight unchanged useful operations", 0, 19, 0xfff, 0],
    [1, "replacement preparation after its captured write error", 211, 9, 0xf0f, 5],
    [2, "replacement Move failure after its one original error capture", 212, 9, 0xf0f, 5],
    [3, "earlier read failure", 1, 5, 0xf00, 5],
    [4, "earlier ordinary rename failure", 1, 8, 0xf07, 5],
    [5, "later file removal failure", 1, 10, 0xf1f, 5],
    [6, "later child removal failure", 1, 11, 0xf3f, 5],
    [7, "later directory removal failure", 1, 12, 0xf7f, 5],
    [8, "first replacement join failure", 211, 9, 0xf0f, 206],
    [9, "second replacement join failure", 211, 9, 0xf0f, 206],
    [10, "earlier edit failure", 1, 6, 0xf01, 5],
    [11, "earlier create failure", 1, 7, 0xf03, 5],
    [12, "preparation failure followed by failed report publication", 211, 9, 0xf0f, 5],
    [13, "Move failure followed by failed report publication", 212, 9, 0xf0f, 5],
  ] as const)("case %i preserves %s", (scenario, _description, exit, operation, features, error) => {
    const result = spawnSync(executable, [String(scenario)], { stdio: ["ignore", "pipe", "pipe"], timeout: 2000, maxBuffer: 4096 });
    expect(result.status, "The fixed actual-body logic mock must satisfy its closed invariants.").toBe(exit);
    expect(result.stderr.length).toBe(0);
    expect(result.stdout.length).toBe(128);
    const parsed = parseWindowsCommandCreatorOwnerReport(result.stdout, "useful");
    expect(parsed).toMatchObject({ mode: 1, status: scenario === 0 ? 1 : 2, operation, features, failedOperationError: error,
      acl: { createdMask: 3, attemptMask: 15, grantedMask: 0, closedMask: 15, errors: [5, 5, 5, 5], validatedMask: 15, removedMask: 3 } });
  });
});
