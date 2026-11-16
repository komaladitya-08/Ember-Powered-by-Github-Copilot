/** Actual witness C over in-memory Win32 stubs. Host cc execution proves no Windows ABI or enforcement property. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WINDOWS_H = String.raw`
#ifndef FIXED_WINDOWS_H
#define FIXED_WINDOWS_H
#include <stdint.h>
#include <stddef.h>
#include <wchar.h>
typedef void *HANDLE;
typedef uint32_t DWORD;
typedef wchar_t WCHAR;
typedef int BOOL;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define READ_CONTROL 0x00020000u
#define WRITE_DAC 0x00040000u
#define WRITE_OWNER 0x00080000u
#define GENERIC_WRITE 0x40000000u
#define FILE_SHARE_READ 1u
#define FILE_SHARE_WRITE 2u
#define FILE_SHARE_DELETE 4u
#define OPEN_EXISTING 3u
#define CREATE_NEW 1u
#define FILE_FLAG_OPEN_REPARSE_POINT 0x00200000u
#define FILE_FLAG_BACKUP_SEMANTICS 0x02000000u
#define FILE_ATTRIBUTE_NORMAL 0x80u
#define ERROR_SUCCESS 0u
#define ERROR_ACCESS_DENIED 5u
#define ERROR_SHARING_VIOLATION 32u
#define FILE_TYPE_CHAR 2u
#define FILE_TYPE_PIPE 3u
#define STD_INPUT_HANDLE ((DWORD)-10)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define STD_ERROR_HANDLE ((DWORD)-12)
void Sleep(DWORD);
BOOL CloseHandle(HANDLE);
HANDLE GetStdHandle(DWORD);
DWORD GetFileType(HANDLE);
BOOL ReadFile(HANDLE, void *, DWORD, DWORD *, void *);
HANDLE CreateFileW(const WCHAR *, DWORD, DWORD, void *, DWORD, DWORD, HANDLE);
DWORD GetLastError(void);
BOOL GetHandleInformation(HANDLE, DWORD *);
BOOL WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
BOOL FlushFileBuffers(HANDLE);
void *SecureZeroMemory(void *, size_t);
#endif
`;

const DRIVER = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
#include "windows.h"
#include "witness.c"

typedef struct { HANDLE handle; int object; int right; int closed; int matrixIndex; } FixedHandle;
static FixedHandle acquired[32];
static int selectedObject, selectedRight, selectedOutcome, variant, failClose, failDiagnostic, matrixVariant, matrixUnknown, failCreate;
static int handles, closedHandles, closeAttempts, probes, controls, creates, sleeps, infos;
static int errorPending, errorReads, diagnosticWrites, diagnosticPhase, matrixQueries, matrixWrites;
static int naturalCase, failureProbes, currentMatrixIndex = -1;
static DWORD currentError;
static char capturedOut[128], capturedErr[128], capturedControl[128], attemptedDiagnostic[128], attemptedMatrix[128];
static size_t outLength, errLength, controlLength, attemptedLength, attemptedMatrixLength;
static const int mixedMatrix[24] = { 2, 1, 3, 4, 5, 1, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 5, 2, 3, 4, 5, 1, 5 };
static jmp_buf escape;
static void contract(int accepted, int stage) {
  if (!accepted) { printf("{\"schema\":1,\"contract\":0,\"stage\":%d}\n", stage); exit(71); }
}
static void nativeEntry(int lastError) { contract(!errorPending || lastError, 1); }
static FixedHandle *lookup(HANDLE handle) {
  int i;
  for (i = 0; i < handles; i++) if (acquired[i].handle == handle) return &acquired[i];
  contract(0, 2); return NULL;
}
static HANDLE acquire(int object, int right) {
  FixedHandle *value;
  contract(handles < 32, 3); value = &acquired[handles++];
  value->handle = (HANDLE)(uintptr_t)(100 + handles);
  value->object = object; value->right = right; value->closed = 0; value->matrixIndex = currentMatrixIndex; return value->handle;
}
static int matrixOutcome(int index) { return matrixUnknown == index + 1 ? 1 : mixedMatrix[index]; }
static const WCHAR *fixedPaths[] = { L"witness", L"C:\\parent", L"C:\\root", L"C:\\root\\node.exe",
  L"C:\\low-owner", L"C:\\full", L"C:\\full\\file.txt", L"C:\\medium-full", L"C:\\medium-full\\file.txt" };
static int pathObject(const WCHAR *file) {
  int i;
  for (i = 1; i <= 8; i++) { if (wcscmp(file, fixedPaths[i]) == 0) return i; }
  return 0;
}
static int accessRight(DWORD access) {
  if (access == READ_CONTROL) return 1;
  if (access == WRITE_DAC) return 2;
  if (access == WRITE_OWNER) return 3;
  contract(0, 4); return 0;
}
static int wanted(int object, int right) {
  static const int expected[8][3] = { { 0, 0, 0 }, { 1, 0, 0 }, { 1, 0, 0 }, { 0, 0, 0 },
    { 1, 1, 1 }, { 1, 1, 1 }, { 1, 0, 0 }, { 1, 0, 0 } };
  return expected[object - 1][right - 1];
}
static HANDLE refused(DWORD error, int nullHandle) {
  currentError = error; errorPending = !nullHandle; return nullHandle ? NULL : INVALID_HANDLE_VALUE;
}
HANDLE GetStdHandle(DWORD kind) {
  nativeEntry(0);
  if (kind == STD_INPUT_HANDLE) return (HANDLE)(uintptr_t)1;
  if (kind == STD_OUTPUT_HANDLE) return (HANDLE)(uintptr_t)2;
  if (kind == STD_ERROR_HANDLE) return (HANDLE)(uintptr_t)3;
  contract(0, 5); return NULL;
}
DWORD GetFileType(HANDLE handle) {
  nativeEntry(0);
  if (handle == (HANDLE)(uintptr_t)1) return FILE_TYPE_CHAR;
  contract(handle == (HANDLE)(uintptr_t)2 || handle == (HANDLE)(uintptr_t)3, 6); return FILE_TYPE_PIPE;
}
BOOL ReadFile(HANDLE handle, void *bytes, DWORD size, DWORD *count, void *overlapped) {
  nativeEntry(0); contract(handle == (HANDLE)(uintptr_t)1 && bytes && size == 1 && count && !overlapped, 7);
  *count = 0; return 1;
}
HANDLE CreateFileW(const WCHAR *file, DWORD access, DWORD share, void *security, DWORD disposition, DWORD flags, HANDLE templateFile) {
  int object, right;
  nativeEntry(0); contract(share == 7 && !security && !templateFile, 8);
  object = pathObject(file);
  if (disposition == OPEN_EXISTING) {
    contract(object >= 1 && object <= 8, 9); right = accessRight(access);
    contract(flags == (FILE_FLAG_OPEN_REPARSE_POINT | ((object != 3 && object != 6 && object != 8) ? FILE_FLAG_BACKUP_SEMANTICS : 0)), 10);
    if (!naturalCase && probes == failureProbes) {
      int outcome;
      currentMatrixIndex = matrixQueries++; contract(matrixQueries == (object - 1) * 3 + right && matrixQueries <= 24, 39);
      outcome = matrixOutcome(currentMatrixIndex);
      if (outcome == 2) return refused(ERROR_ACCESS_DENIED, 0);
      if (outcome == 3) return refused(ERROR_SHARING_VIOLATION, 0);
      if (outcome == 4) return refused(87, matrixVariant);
      return acquire(object, right);
    }
    currentMatrixIndex = -1;
    probes++; contract(probes == (object - 1) * 3 + right, 11);
    if (object == selectedObject && right == selectedRight) {
      if (selectedOutcome == 2) return refused(ERROR_ACCESS_DENIED, 0);
      if (selectedOutcome == 3) return refused(ERROR_SHARING_VIOLATION, 0);
      if (selectedOutcome == 4) return refused(87, variant);
      contract(selectedOutcome == 1 || selectedOutcome == 5, 12); return acquire(object, right);
    }
    return wanted(object, right) ? acquire(object, right) : refused(ERROR_ACCESS_DENIED, 0);
  }
  contract(disposition == CREATE_NEW && access == GENERIC_WRITE && flags == (FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT), 15);
  contract(probes == 24, 16); creates++;
  if (creates == 1) contract(wcscmp(file, L"C:\\parent\\access-create.txt") == 0, 17);
  else if (creates == 2) contract(wcscmp(file, L"C:\\root\\access-create.txt") == 0, 18);
  else if (creates == 3) contract(wcscmp(file, L"C:\\medium-full\\access-create.txt") == 0, 19);
  else contract(creates == 4 && wcscmp(file, L"C:\\full\\access-create.txt") == 0, 20);
  if (failCreate == creates) return creates < 4 ? acquire(7, 0) : refused(ERROR_ACCESS_DENIED, 0);
  return creates < 4 ? refused(ERROR_ACCESS_DENIED, 0) : acquire(7, 0);
}
DWORD GetLastError(void) {
  nativeEntry(1); contract(errorPending, 20); errorPending = 0; errorReads++; return currentError;
}
BOOL GetHandleInformation(HANDLE handle, DWORD *flags) {
  FixedHandle *value;
  nativeEntry(0); value = lookup(handle); contract(!value->closed && flags, 21); infos++;
  if (value->matrixIndex >= 0 && matrixOutcome(value->matrixIndex) == 5) {
    if (!matrixVariant) return 0;
    *flags = 1; return 1;
  }
  if (value->matrixIndex < 0 && value->object == selectedObject && value->right == selectedRight && selectedOutcome == 5) {
    if (!variant) return 0;
    *flags = 1; return 1;
  }
  *flags = 0; return 1;
}
BOOL CloseHandle(HANDLE handle) {
  FixedHandle *value;
  nativeEntry(0); value = lookup(handle); contract(!value->closed, 22); closeAttempts++;
  if (failClose && value->matrixIndex < 0 && value->object == selectedObject && value->right == selectedRight) return 0;
  if (value->matrixIndex >= 0 && matrixUnknown == value->matrixIndex + 1) return 0;
  value->closed = 1; closedHandles++; return 1;
}
void Sleep(DWORD milliseconds) {
  nativeEntry(0); contract(milliseconds == 1000 && (failClose || matrixUnknown), 23); sleeps++; longjmp(escape, 1);
}
static void append(char *target, size_t *length, const void *bytes, size_t count) {
  contract(*length + count <= 128, 24); memcpy(target + *length, bytes, count); *length += count;
}
BOOL WriteFile(HANDLE handle, const void *bytes, DWORD size, DWORD *written, void *overlapped) {
  DWORD shortCount;
  nativeEntry(0); contract(bytes && size && written && !overlapped, 25);
  if (handle == (HANDLE)(uintptr_t)3 && !diagnosticPhase && size >= sizeof("EMBER_ASSET_PROBE_V2:") - 1 &&
      memcmp(bytes, "EMBER_ASSET_PROBE_V2:", sizeof("EMBER_ASSET_PROBE_V2:") - 1) == 0) {
    contract(handles == closedHandles && matrixQueries == 24, 26); diagnosticPhase = 1;
    append(attemptedDiagnostic, &attemptedLength, bytes, size);
  }
  if (handle == (HANDLE)(uintptr_t)3 && diagnosticPhase == 1 && size >= sizeof("EMBER_ASSET_MATRIX_V2:") - 1 &&
      memcmp(bytes, "EMBER_ASSET_MATRIX_V2:", sizeof("EMBER_ASSET_MATRIX_V2:") - 1) == 0) {
    contract(handles == closedHandles && errLength == sizeof("EMBER_ASSET_PROBE_V2:0:0:0\n") - 1, 40); diagnosticPhase = 2;
    append(attemptedMatrix, &attemptedMatrixLength, bytes, size);
  }
  if (diagnosticPhase && handle == (HANDLE)(uintptr_t)3) {
    contract(handles == closedHandles, 41); diagnosticWrites++; if (diagnosticPhase == 2) matrixWrites++;
    if (failDiagnostic == diagnosticPhase) { *written = 0; return 0; }
  }
  shortCount = size > 7 ? 7 : size; *written = shortCount;
  if (handle == (HANDLE)(uintptr_t)2) append(capturedOut, &outLength, bytes, shortCount);
  else if (handle == (HANDLE)(uintptr_t)3) append(capturedErr, &errLength, bytes, shortCount);
  else { FixedHandle *value = lookup(handle); contract(value->object == 7 && !value->closed, 27); append(capturedControl, &controlLength, bytes, shortCount); }
  return 1;
}
BOOL FlushFileBuffers(HANDLE handle) {
  FixedHandle *value;
  nativeEntry(0); value = lookup(handle); contract(value->object == 7 && !value->closed, 28); return 1;
}
void *SecureZeroMemory(void *bytes, size_t count) { nativeEntry(0); return memset(bytes, 0, count); }
int main(int argc, char **argv) {
  WCHAR *arguments[9];
  int i, code, expectedProbes;
  char expectedFrame[] = "EMBER_ASSET_PROBE_V2:0:0:0\n";
  char expectedMatrix[] = "EMBER_ASSET_MATRIX_V2:000000000000000000000000\n";
  size_t prefix = sizeof("EMBER_ASSET_PROBE_V2:") - 1;
  size_t matrixPrefix = sizeof("EMBER_ASSET_MATRIX_V2:") - 1;
  contract(argc == 10, 29);
  selectedObject = atoi(argv[1]); selectedRight = atoi(argv[2]); selectedOutcome = atoi(argv[3]);
  variant = atoi(argv[4]); failClose = atoi(argv[5]); failDiagnostic = atoi(argv[6]);
  matrixVariant = atoi(argv[7]); matrixUnknown = atoi(argv[8]); failCreate = atoi(argv[9]);
  naturalCase = !selectedObject || (wanted(selectedObject, selectedRight) && selectedOutcome == 1) || (!wanted(selectedObject, selectedRight) && selectedOutcome == 2);
  failureProbes = (selectedObject - 1) * 3 + selectedRight;
  for (i = 0; i < 9; i++) arguments[i] = (WCHAR *)fixedPaths[i];
  if (setjmp(escape) == 0) code = wmain(9, arguments); else code = 250;
  contract(!errorPending, 30);
  expectedProbes = naturalCase ? 24 : failureProbes;
  contract(probes == expectedProbes, 31);
  if (failClose) {
    contract(code == 250 && sleeps == 1 && handles == closedHandles + 1 && closeAttempts == handles &&
      !diagnosticWrites && !outLength && !errLength && !controlLength && !controls && !creates && !matrixQueries, 32);
  } else if (matrixUnknown) {
    contract(code == 250 && sleeps == 1 && handles == closedHandles + 1 && closeAttempts == handles &&
      matrixQueries == matrixUnknown && !diagnosticWrites && !outLength && !errLength && !controlLength && !controls && !creates, 42);
  } else if (failCreate) {
    contract(code == 308 && naturalCase && creates == failCreate && probes == 24 && !matrixQueries && !controls &&
      handles == closedHandles && closeAttempts == handles && !outLength && !errLength && !controlLength && !sleeps, 45);
  } else if (naturalCase) {
    contract(code == 29 && !sleeps && handles == closedHandles && closeAttempts == handles && probes == 24 &&
      !controls && creates == 4 && infos == 10 && errorReads == 17 && !diagnosticWrites && !matrixQueries, 33);
    contract(outLength == sizeof(output) - 1 && memcmp(capturedOut, output, outLength) == 0 &&
      errLength == sizeof(errorOutput) - 1 && memcmp(capturedErr, errorOutput, errLength) == 0 &&
      controlLength == sizeof(controlBytes) - 1 && memcmp(capturedControl, controlBytes, controlLength) == 0, 34);
  } else {
    expectedFrame[prefix] = (char)('0' + selectedObject); expectedFrame[prefix + 2] = (char)('0' + selectedRight);
    expectedFrame[prefix + 4] = (char)('0' + selectedOutcome);
    for (i = 0; i < 24; i++) expectedMatrix[matrixPrefix + (size_t)i] = (char)('0' + matrixOutcome(i));
    contract(code == 305 && !sleeps && handles == closedHandles && closeAttempts == handles && !outLength && !controlLength &&
      !controls && !creates && diagnosticWrites >= 1 && matrixQueries == 24, 35);
    contract(attemptedLength == sizeof(expectedFrame) - 1 && memcmp(attemptedDiagnostic, expectedFrame, attemptedLength) == 0, 36);
    if (failDiagnostic == 1) contract(!errLength && diagnosticWrites == 1 && !attemptedMatrixLength && !matrixWrites, 37);
    else {
      contract(attemptedMatrixLength == sizeof(expectedMatrix) - 1 && memcmp(attemptedMatrix, expectedMatrix, attemptedMatrixLength) == 0, 43);
      if (failDiagnostic == 2) contract(errLength == sizeof(expectedFrame) - 1 && memcmp(capturedErr, expectedFrame, errLength) == 0 && matrixWrites == 1, 44);
      else contract(errLength == sizeof(expectedFrame) + sizeof(expectedMatrix) - 2 && memcmp(capturedErr, expectedFrame, sizeof(expectedFrame) - 1) == 0 &&
        memcmp(capturedErr + sizeof(expectedFrame) - 1, expectedMatrix, sizeof(expectedMatrix) - 1) == 0, 38);
    }
  }
  printf("{\"schema\":1,\"contract\":1,\"code\":%d,\"probes\":%d,\"matrixQueries\":%d,\"opened\":%d,\"closed\":%d,\"live\":%d,\"closeAttempts\":%d,\"lastErrors\":%d,\"diagnosticWrites\":%d,\"matrixWrites\":%d,\"stdoutBytes\":%zu,\"stderrBytes\":%zu,\"controlBytes\":%zu,\"sleeps\":%d}\n",
    code, probes, matrixQueries, handles, closedHandles, handles - closedHandles, closeAttempts, errorReads, diagnosticWrites, matrixWrites, outLength, errLength, controlLength, sleeps);
  return 0;
}
`;

interface Report { schema: number; contract: number; code: number; probes: number; matrixQueries: number; opened: number; closed: number; live: number;
  closeAttempts: number; lastErrors: number; diagnosticWrites: number; matrixWrites: number; stdoutBytes: number; stderrBytes: number; controlBytes: number; sleeps: number }
const refusal = () => { const error = new Error("The fixed portable C witness contract failed."); error.stack = "Error: " + error.message; return error; };

describe.skipIf(process.platform !== "linux")("actual asset witness C with fixed Win32 stubs", () => {
  let root = "", executable = "";
  beforeAll(() => {
    try {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-asset-c-model-")); executable = path.join(root, "witness-model");
      const body = fs.readFileSync(new URL("../fixtures/windows-node-asset-enforcement.c", import.meta.url));
      fs.writeFileSync(path.join(root, "witness.c"), body, { flag: "wx" });
      fs.writeFileSync(path.join(root, "windows.h"), WINDOWS_H, { flag: "wx" });
      fs.writeFileSync(path.join(root, "driver.c"), DRIVER, { flag: "wx" });
      const compiled = spawnSync("cc", ["-std=c11", "-O0", "-Wall", "-Wextra", "-Werror", "-I", root, path.join(root, "driver.c"), "-o", executable],
        { cwd: root, timeout: 2500, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      if (compiled.error || compiled.status !== 0 || compiled.signal) throw refusal();
    } catch { throw refusal(); }
  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  const run = (object: number, right: number, outcome: number, variant = 0, unknownClose = 0, failedWrite = 0, matrixVariant = 0, matrixUnknown = 0, failedCreate = 0): Report => {
    try {
      const child = spawnSync(executable, [object, right, outcome, variant, unknownClose, failedWrite, matrixVariant, matrixUnknown, failedCreate].map(String),
        { cwd: root, timeout: 750, maxBuffer: 8192, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (child.error || child.status !== 0 || child.signal || child.stderr) throw refusal();
      const report: unknown = JSON.parse(child.stdout);
      if (!report || typeof report !== "object" || Array.isArray(report) ||
          !Object.values(report).every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
          (report as Report).schema !== 1 || (report as Report).contract !== 1) throw refusal();
      return report as Report;
    } catch { throw refusal(); }
  };

  const wanted = (object: number, right: number) => [[0, 0, 0], [1, 0, 0], [1, 0, 0], [0, 0, 0], [1, 1, 1], [1, 1, 1], [1, 0, 0], [1, 0, 0]][object - 1][right - 1] === 1;
  const frameBytes = Buffer.byteLength("EMBER_ASSET_PROBE_V2:1:1:1\nEMBER_ASSET_MATRIX_V2:123451234512345123451234\n");
  it("requires all24 V2 access checks, three denied creates, the Low create and exact new29 success frames", () => {
    const report = run(0, 0, 0);
    expect(report).toMatchObject({ code: 29, probes: 24, matrixQueries: 0, opened: 11, closed: 11, live: 0, closeAttempts: 11, lastErrors: 17, diagnosticWrites: 0, matrixWrites: 0, sleeps: 0 });
    expect(report.stdoutBytes).toBe(Buffer.byteLength("EMBER_ASSET_ACCESS_V2:131071:2047:17:11:2:1\n"));
    expect(report.stderrBytes).toBe(Buffer.byteLength("EMBER_ASSET_ACCESS_STDERR_V2\n"));
    expect(report.controlBytes).toBe(Buffer.byteLength("EMBER_ASSET_CONTROL_CREATED_V2\n"));
  });
  const scenarios = Array.from({ length: 8 }, (_value, index) => index + 1).flatMap(object => [1, 2, 3].flatMap(right =>
    (wanted(object, right) ? [[1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [5, 0], [5, 1]] : [[1, 0], [2, 0], [3, 0], [4, 0], [4, 1]])
      .map(([outcome, variant]) => ({ object, right, outcome, variant }))));
  it.each(scenarios)("enforces V2 object $object right $right outcome $outcome variant $variant", ({ object, right, outcome, variant }) => {
    const natural = wanted(object, right) && outcome === 1 || !wanted(object, right) && outcome === 2;
    const report = run(object, right, outcome, variant);
    expect(report).toMatchObject({ code: natural ? 29 : 305, live: 0, sleeps: 0, probes: natural ? 24 : (object - 1) * 3 + right });
    expect(report.closed).toBe(report.opened); expect(report.closeAttempts).toBe(report.opened); expect(report.matrixQueries).toBe(natural ? 0 : 24);
    if (!natural) expect(report).toMatchObject({ stdoutBytes: 0, stderrBytes: frameBytes, controlBytes: 0 });
  });
  it.each(Array.from({ length: 8 }, (_value, index) => index + 1).flatMap(object => [1, 2, 3].map(right => ({ object, right }))))("unknown close on object $object right $right emits no V2 frame", ({ object, right }) => {
    const report = run(object, right, wanted(object, right) ? 5 : 1, 0, 1);
    expect(report).toMatchObject({ code: 250, live: 1, probes: (object - 1) * 3 + right, matrixQueries: 0, diagnosticWrites: 0, stdoutBytes: 0, stderrBytes: 0, controlBytes: 0, sleeps: 1 });
    expect(report.opened).toBe(report.closed + 1); expect(report.closeAttempts).toBe(report.opened);
  });
  it.each([{ object: 1, right: 1, outcome: 1 }, { object: 2, right: 2, outcome: 1 }, { object: 8, right: 3, outcome: 3 }])(
    "diagnostic WriteFile failure keeps305 after object $object right $right closes", ({ object, right, outcome }) => {
      const report = run(object, right, outcome, 0, 0, 1);
      expect(report).toMatchObject({ code: 305, live: 0, probes: (object - 1) * 3 + right, matrixQueries: 24, diagnosticWrites: 1, matrixWrites: 0, stdoutBytes: 0, stderrBytes: 0, controlBytes: 0, sleeps: 0 });
      expect(report.closed).toBe(report.opened);
    });
  it.each([0, 1])("queries all24 cells and preserves the original V2 tuple through matrix variant%s", matrixVariant => {
    const report = run(2, 3, 1, 0, 0, 0, matrixVariant);
    expect(report).toMatchObject({ code: 305, probes: 6, matrixQueries: 24, live: 0, stdoutBytes: 0, controlBytes: 0, sleeps: 0 });
    expect(report.matrixWrites).toBeGreaterThan(1); expect(report.closed).toBe(report.opened);
  });
  it.each(Array.from({ length: 24 }, (_value, index) => index + 1))("unknown close at matrix cell%s emits neither deferred V2 frame", matrixUnknown => {
    const report = run(1, 1, 1, 0, 0, 0, 0, matrixUnknown);
    expect(report).toMatchObject({ code: 250, probes: 1, matrixQueries: matrixUnknown, live: 1, diagnosticWrites: 0, matrixWrites: 0, stdoutBytes: 0, stderrBytes: 0, controlBytes: 0, sleeps: 1 });
    expect(report.opened).toBe(report.closed + 1); expect(report.closeAttempts).toBe(report.opened);
  });
  it("matrix WriteFile failure keeps305 and cannot append a V2 success frame", () => {
    const report = run(1, 1, 1, 0, 0, 2);
    expect(report).toMatchObject({ code: 305, probes: 1, matrixQueries: 24, live: 0, matrixWrites: 1, stdoutBytes: 0,
      stderrBytes: Buffer.byteLength("EMBER_ASSET_PROBE_V2:1:1:1\n"), controlBytes: 0, sleeps: 0 });
    expect(report.closed).toBe(report.opened);
  });
  it.each([1, 2, 3, 4])("V2 create control%s cannot fail or reverse and still produce success", failedCreate => {
    const report = run(0, 0, 0, 0, 0, 0, 0, 0, failedCreate);
    expect(report).toMatchObject({ code: 308, probes: 24, matrixQueries: 0, live: 0, diagnosticWrites: 0, stdoutBytes: 0, stderrBytes: 0, controlBytes: 0 });
  });
});
