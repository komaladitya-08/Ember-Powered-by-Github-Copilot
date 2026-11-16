/** Actual new C helper/useful bodies with fixed Linux mocks; no Windows ABI or kernel claim. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWindowsCommandCreatorOwnerReport } from "../fixtures/windows-command-creator-owner-report";

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

describe.skipIf(process.platform !== "linux")("Actual LPAC POSIX replacement logic with fixed non-Windows mocks", () => {
  let directory = "", executable = "";
  beforeAll(() => {
    const source = readFileSync(path.resolve("test/fixtures/windows-command-posix-proof.c"), "utf8");
    const declarations = source.slice(source.indexOf("#define CHARS"), source.indexOf("/* A failed close"));
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-creator-posix-logic-"));
    executable = path.join(directory, "logic");
    const fixture = path.join(directory, "logic.c");
    writeFileSync(fixture, `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stddef.h>
#include <string.h>
typedef uint32_t DWORD;
typedef wchar_t WCHAR;
typedef void *HANDLE;
typedef int BOOL;
typedef struct { DWORD Flags; HANDLE RootDirectory; DWORD FileNameLength; WCHAR FileName[1]; } FILE_RENAME_INFO;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define OPEN_EXISTING 3u
#define CREATE_NEW 1u
#define MOVEFILE_REPLACE_EXISTING 1u
#define DELETE 0x10000u
#define FILE_READ_ATTRIBUTES 0x80u
#define FILE_SHARE_READ 1u
#define FILE_SHARE_WRITE 2u
#define FILE_SHARE_DELETE 4u
#define FILE_FLAG_OPEN_REPARSE_POINT 0x200000u
#define FILE_RENAME_FLAG_REPLACE_IF_EXISTS 1u
#define FILE_RENAME_FLAG_POSIX_SEMANTICS 2u
#define FileRenameInfoEx 22u
#define ERROR_FILENAME_EXCED_RANGE 206u
#define FALSE 0
${declarations}
static int scenario, bad, joins, writes, moves, removals, reads, lastErrors, closes, publications, sourceOpens, sourceCloses, sets, pendingError;
static DWORD nativeError = 5;
static size_t wcsnlen_s(const WCHAR *text, size_t bound) { size_t i; for(i=0;i<bound && text[i];i++) {} return i; }
static void uncertain(void) { _Exit(235); }
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
  bad = 1; return 0;
}
static HANDLE CreateFileW(const WCHAR *file, DWORD access, DWORD share, void *security, DWORD disposition, DWORD attributes, void *templateFile) {
  if (pendingError || sourceOpens || record[OPERATION] != REPLACE_FILE || wcscmp(file,L"replacement.tmp") ||
      access != (DELETE|FILE_READ_ATTRIBUTES) || share != 7 || security || disposition != OPEN_EXISTING ||
      attributes != FILE_FLAG_OPEN_REPARSE_POINT || templateFile || writes != 3 || moves != 1) bad=1;
  sourceOpens++;
  if(scenario==14) { pendingError=1;nativeError=5;return INVALID_HANDLE_VALUE; }
  if(scenario==16) return 0;
  return (HANDLE)(intptr_t)700;
}
static int SetFileInformationByHandle(HANDLE owned, DWORD kind, void *bytes, DWORD size) {
  FILE_RENAME_INFO *info=(FILE_RENAME_INFO *)bytes;
  if(pendingError || owned!=(HANDLE)(intptr_t)700 || kind!=22 || bytes!=renameBuffer.bytes || sets || sourceCloses ||
      info->Flags!=3 || info->RootDirectory || info->FileNameLength!=wcslen(L"replace.txt")*sizeof(WCHAR) ||
      size!=offsetof(FILE_RENAME_INFO,FileName)+(wcslen(L"replace.txt")+1)*sizeof(WCHAR) ||
      wcscmp((WCHAR *)(renameBuffer.bytes+offsetof(FILE_RENAME_INFO,FileName)),L"replace.txt")) bad=1;
  sets++;
  if(scenario==2 || scenario==13 || scenario==17) { pendingError=1;nativeError=scenario==17?0:5;return 0; }
  return 1;
}
static DWORD GetLastError(void) {
  lastErrors++;
  if (replacementFailureExit != 1) bad=1;
  if(record[OPERATION]==REPLACE_FILE && !pendingError) bad=1;
  pendingError=0; return nativeError;
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
  if(pendingError || publications) bad=1;
  if(owned==&heartbeatFile) { closes++; *owned=INVALID_HANDLE_VALUE; return 1; }
  if(*owned!=(HANDLE)(intptr_t)700 || sourceCloses) bad=1;
  *owned=INVALID_HANDLE_VALUE; sourceCloses++; nativeError=123;
  if(scenario==15) uncertain();
  return 1;
}
static int publish(const WCHAR *report) {
  (void)report; publications++;
  if ((scenario == 0 && closes != 0) || (scenario != 0 && (closes != 1 || record[STATUS] != FAILED || record[OPERATION_ERROR] != errorCode))) bad = 1;
  /* A later publication error must not replace the already captured operation-error field. */
  errorCode = 123;
  return scenario != 12 && scenario != 13;
}
${actualFunction(source, "static int replacePinnedPosix(const WCHAR *from, const WCHAR *to, DWORD *failure)")}
${actualFunction(source, "static int useful(const WCHAR *root)")}
${actualFunction(source, "static int failed(const WCHAR *report)")}
int main(int argc, char **argv) {
  int ok, result;
  static const DWORD expectedOp[] = {19,9,9,5,8,10,11,12,9,9,6,7,9,9,9,9,9,9};
  static const DWORD expectedFeatures[] = {0xfff,0xf0f,0xf0f,0xf00,0xf07,0xf1f,0xf3f,0xf7f,0xf0f,0xf0f,0xf01,0xf03,0xf0f,0xf0f,0xf0f,0xf0f,0xf0f,0xf0f};
  static const int expectedExit[] = {0,211,212,1,1,1,1,1,211,211,1,1,211,212,212,235,235,212};
  (void)heartbeat; (void)readyStaging; (void)seed;
  if (argc != 2) return 230;
  scenario = atoi(argv[1]); if (scenario < 0 || scenario > 17) return 230;
  record[MAGIC] = REPORT_MAGIC; record[VERSION] = 2; record[MODE] = USEFUL; record[FEATURES] = 0xf00;
  record[SOURCE_READ] = record[SOURCE_WRITE] = record[CANARY_READ] = record[CANARY_WRITE] = 5;
  record[ACL_CREATED] = record[ACL_REMOVED] = 3;
  record[ACL_ATTEMPTED] = record[ACL_CLOSED] = record[ACL_VALIDATED] = 15;
  record[ACL_FILE_DAC_ERROR] = record[ACL_FILE_OWNER_ERROR] = record[ACL_DIRECTORY_DAC_ERROR] = record[ACL_DIRECTORY_OWNER_ERROR] = 5;
  ok = useful(L"fixed-root");
  if (ok) {
    if (scenario != 0 || joins != 9 || writes != 3 || moves != 1 || sets != 1 || sourceCloses != 1 || removals != 3 || reads != 1 || lastErrors != 0 || replacementFailureExit != 1) bad = 1;
    record[STATUS] = COMPLETE; record[OPERATION] = DONE; publish(L"fixed-report"); result = 0;
  } else result = failed(L"fixed-report");
  if (bad || result != expectedExit[scenario] || record[OPERATION] != expectedOp[scenario]
      || record[FEATURES] != expectedFeatures[scenario] || publications != 1
      || lastErrors != ((scenario == 2 || scenario == 4 || scenario == 13 || scenario == 14 || scenario == 17) ? 1 : 0)
      || (scenario != 0 && record[OPERATION_ERROR] != ((scenario == 8 || scenario == 9) ? 206u : scenario == 17 ? 0u : 5u))) return 230;
  if(pendingError || (sourceOpens && scenario!=14 && sourceCloses!=1) || sets>1 || sourceCloses>1) return 230;
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
    [2, "replacement SetInfo failure captured before its source close", 212, 9, 0xf0f, 5],
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
    [13, "SetInfo failure followed by failed report publication", 212, 9, 0xf0f, 5],
    [14, "source-open refusal before any SetInfo or close", 212, 9, 0xf0f, 5],
    [17, "honest failed-BOOL error0 captured before a close changes last-error", 212, 9, 0xf0f, 0],
  ] as const)("case %i preserves %s", (scenario, _description, exit, operation, features, error) => {
    const result = spawnSync(executable, [String(scenario)], { stdio: ["ignore", "pipe", "pipe"], timeout: 2000, maxBuffer: 4096 });
    expect(result.status, "The fixed actual-body logic mock must satisfy its closed invariants.").toBe(exit);
    expect(result.stderr.length).toBe(0);
    expect(result.stdout.length).toBe(128);
    const parsed = parseWindowsCommandCreatorOwnerReport(result.stdout, "useful");
    expect(parsed).toMatchObject({ mode: 1, status: scenario === 0 ? 1 : 2, operation, features, failedOperationError: error,
      acl: { createdMask: 3, attemptMask: 15, grantedMask: 0, closedMask: 15, errors: [5, 5, 5, 5], validatedMask: 15, removedMask: 3 } });
  });
  it.each([15,16])("case %i publishes no report after unknown source ownership", scenario => {
    const result=spawnSync(executable,[String(scenario)],{stdio:["ignore","pipe","pipe"],timeout:2000,maxBuffer:4096});
    expect(result.status).toBe(235);expect(result.stdout.length).toBe(0);expect(result.stderr.length).toBe(0);
  });
});

it("keeps every other original C function and the full useful decision sequence unchanged", () => {
  const baseline=readFileSync(path.resolve("test/fixtures/windows-command-creator-owner-proof.c"),"utf8");
  const candidate=readFileSync(path.resolve("test/fixtures/windows-command-posix-proof.c"),"utf8");
  for(const signature of ["static void uncertain(void)","static int pathInput(const WCHAR *text)","static int join(const WCHAR *root, const WCHAR *name, WCHAR *output)","static int closeKnown(HANDLE *owned)","static HANDLE open(const WCHAR *file, DWORD access, DWORD disposition, DWORD attributes)","static int denied(const WCHAR *file, DWORD access, DWORD disposition, DWORD slot, DWORD bit)","static int protectedProbes(const WCHAR *source, const WCHAR *canary)","static int readSeed(const WCHAR *file)","static int overwrite(HANDLE owned, const void *bytes, DWORD length)","static int writeFixed(const WCHAR *file, const char *bytes, DWORD length, DWORD disposition)","static int removePosix(const WCHAR *file, int directory)","static int revoked(const WCHAR *root)","static DWORD creatorRights(const WCHAR *root, int host)","static int publish(const WCHAR *file)","static int ready(const WCHAR *file)","static int failed(const WCHAR *report)","static int aclFailed(const WCHAR *report, DWORD exitCode)","int wmain(int argc, WCHAR **argv)"]) {
    expect(actualFunction(candidate,signature)).toBe(actualFunction(baseline,signature));
  }
  expect(actualFunction(candidate,"static int useful(const WCHAR *root)")).toBe(actualFunction(baseline,"static int useful(const WCHAR *root)").replace("if (!MoveFileExW(first, second, MOVEFILE_REPLACE_EXISTING)) { errorCode = GetLastError(); replacementFailureExit = 212; return 0; }","if (!replacePinnedPosix(first, second, &errorCode)) { replacementFailureExit = 212; return 0; }"));
});
