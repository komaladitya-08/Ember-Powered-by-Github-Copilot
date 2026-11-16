/** The host comparison accepts observations, never an invalid A control or incomplete native ownership. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWindowsOpenTargetPosixReport, WINDOWS_OPEN_TARGET_POSIX_REPORT_BYTES, WINDOWS_OPEN_TARGET_POSIX_REPORT_MAGIC } from "../fixtures/windows-open-target-posix-report";

const complete = (bSuccess = false, bError = bSuccess ? 0 : 5) => [WINDOWS_OPEN_TARGET_POSIX_REPORT_MAGIC, 2, 1, 3, 3, 3, 3, 3, bSuccess ? 3 : 1, 0, bError, 3, 3, 22, 3, 3,
  ...Array<number>(8).fill(0), 9, 0, 100, 10, 20, 0, 0, 0, 9, 0, 101, 30, 40, 0, 0, 0];
const encode = (words: readonly number[]) => {
  const bytes = Buffer.alloc(WINDOWS_OPEN_TARGET_POSIX_REPORT_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
};
const changed = (offset: number, value: number, words = complete()) => { const next = [...words]; next[offset] = value; return encode(next); };

describe("Stopped ordinary-host open-target numeric observations", () => {
  it.each([false, true])("keeps B success=%s separate from the valid unpinned A control", success => {
    const parsed = parseWindowsOpenTargetPosixReport(encode(complete(success)));
    expect(parsed).toEqual({ schema: 2, status: 1, api: { informationClass: 22, flags: 3 }, source: { openedMask: 3, closedMask: 3, identityCapturedMask: 3 },
      preparation: { createdMask: 3, writtenMask: 3, flushedMask: 3, closedMask: 3 }, attemptedMask: 3, successMask: success ? 3 : 1,
      a: { success: 1, error: 0 }, b: { success: success ? 1 : 0, error: success ? 0 : 5 } });
  });
  it.each([0, 1, 5, 32, 0x80000000, 0xffffffff])("keeps an immediate failed-BOOL DWORD %i without coercing it into success", error => {
    const parsed = parseWindowsOpenTargetPosixReport(encode(complete(false, error)));
    expect(parsed.b).toEqual({ success: 0, error }); expect(parsed.successMask).toBe(1);
  });
  it.each([0, 2, 3, 4, 0xffffffff])("refuses a foreign magic %i", value => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(0, value))).toThrow("numeric contract");
  });
  it.each([0, 1, 3, 0xffffffff])("refuses schema %i", value => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(1, value))).toThrow("numeric contract");
  });
  it.each([0, 2, 0xffffffff])("refuses noncomplete status %i", value => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(2, value))).toThrow("numeric contract");
  });
  it.each([3, 4, 5, 6, 7])("requires both completed preparation/attempt bits in word %i", offset => {
    for (const value of [0, 1, 2, 4, 7, 0xffffffff]) expect(() => parseWindowsOpenTargetPosixReport(changed(offset, value))).toThrow("numeric contract");
  });
  it.each([0, 2, 4, 7, 0xffffffff])("refuses invalid success mask %i, including B without A", mask => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(8, mask))).toThrow("numeric contract");
  });
  it.each([1, 5, 32, 0xffffffff])("refuses failed A error %i even if its success bit is asserted", error => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(9, error))).toThrow("numeric contract");
  });
  it.each([1, 5, 32, 0xffffffff])("refuses B success with an error DWORD %i", error => {
    expect(() => parseWindowsOpenTargetPosixReport(encode(complete(true, error)))).toThrow("numeric contract");
  });
  it.each([11, 12, 15])("requires positive source ownership in word %i", offset => {
    for (const value of [0, 1, 2, 4, 0xffffffff]) expect(() => parseWindowsOpenTargetPosixReport(changed(offset, value))).toThrow("numeric contract");
  });
  it.each([[13, 3], [13, 0], [13, 65], [14, 1], [14, 2], [14, 7], [14, 0xffffffff]])("refuses an unsupported API or flag projection (%i/%i)", (offset, value) => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(offset, value))).toThrow("numeric contract");
  });
  it.each([16, 17, 18, 19, 20, 21, 22, 23, 29, 30, 31, 37, 38, 39])("refuses reserved word %i", offset => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(offset, 1))).toThrow("numeric contract");
  });
  it.each([24, 32])("requires both private source tuples to bind the same volume (%i)", offset => {
    expect(() => parseWindowsOpenTargetPosixReport(changed(offset, 10))).toThrow("numeric contract");
  });
  it.each([25, 33])("rejects a zero private source identifier at %i", offset => {
    const words = complete(); words[offset] = 0; words[offset + 1] = 0;
    expect(() => parseWindowsOpenTargetPosixReport(encode(words))).toThrow("numeric contract");
  });
  it("rejects aliased private source identifiers without exposing them", () => {
    const words = complete(); words[33] = words[25]; words[34] = words[26];
    expect(() => parseWindowsOpenTargetPosixReport(encode(words))).toThrow("numeric contract");
  });
  it("accepts full unsigned private identity words while projecting none of them", () => {
    const words = complete(); for (const offset of [24, 25, 27, 28, 32, 33, 35, 36]) words[offset] = 0xffffffff;
    const parsed = parseWindowsOpenTargetPosixReport(encode(words));
    expect(parsed.source).toEqual({ openedMask: 3, closedMask: 3, identityCapturedMask: 3 });
    expect(JSON.stringify(parsed)).not.toContain("4294967295");
    expect(parsed).not.toHaveProperty("identity");
  });
  it.each([0, 4, 64, 96, 128, 156, 159, 161, 164])("refuses report size %i", length => {
    expect(() => parseWindowsOpenTargetPosixReport(Buffer.alloc(length))).toThrow("numeric contract");
  });
  it("requires an actual Buffer without reading foreign values", () => {
    let touched = 0;
    const foreign = new Proxy({}, { get() { touched++; throw new Error("private"); } });
    expect(() => parseWindowsOpenTargetPosixReport(foreign as Buffer)).toThrow("numeric contract"); expect(touched).toBe(0);
    expect(() => parseWindowsOpenTargetPosixReport(new Uint8Array(160) as Buffer)).toThrow("numeric contract");
  });
  it("returns detached deeply frozen numeric facts without mutating or retaining the report", () => {
    const bytes = encode(complete()), copy = Buffer.from(bytes), parsed = parseWindowsOpenTargetPosixReport(bytes);
    expect(bytes.equals(copy)).toBe(true); bytes.fill(0);
    expect(parsed.b).toEqual({ success: 0, error: 5 });
    for (const object of [parsed, parsed.api, parsed.preparation, parsed.source, parsed.a, parsed.b]) expect(Object.isFrozen(object)).toBe(true);
    expect(() => { (parsed.b as { error: number }).error = 33; }).toThrow();
    expect(JSON.stringify(parsed)).not.toMatch(/SID|path|handle|process|private|EMBER/);
  });
});

// Execute the actual C decision/API-order bodies. These mocks do not establish Windows declarations or ABI.
const actualFunction = (source: string, signature: string) => {
  const start = source.indexOf(signature), opening = source.indexOf("{", start);
  if (start < 0 || opening < 0) throw new Error("The fixed C logic fixture is unavailable.");
  let depth = 1, end = opening + 1;
  for (; end < source.length && depth > 0; end++) { if (source[end] === "{") depth++; if (source[end] === "}") depth--; }
  if (depth !== 0) throw new Error("The fixed C logic fixture is unavailable.");
  return source.slice(start, end);
};
describe.skipIf(process.platform !== "linux")("Actual POSIX C control with fixed non-Windows logic mocks", () => {
  let directory = "", executable = "";
  beforeAll(() => {
    const source = readFileSync(path.resolve("test/fixtures/windows-open-target-posix.c"), "utf8");
    const declarations = source.slice(source.indexOf("#define CHARS"), source.indexOf("/* A failed close"));
    const functions = ["static void uncertain(void)", "static void closeKnown(HANDLE *owned)", "static int pathInput(const WCHAR *text)",
      "static int join(const WCHAR *root, const WCHAR *name, WCHAR *output)", "static int prepare(const WCHAR *file, DWORD bit)",
      "static int identify(HANDLE source, DWORD bit)", "static int compare(const WCHAR *root, DWORD bit, const WCHAR *temporaryName, const WCHAR *targetName, DWORD errorSlot)",
      "static int publish(const WCHAR *file)", "int wmain(int argc, WCHAR **argv)"].map(signature => actualFunction(source, signature)).join("\n");
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-posix-logic-")); executable = path.join(directory, "logic");
    const fixture = path.join(directory, "logic.c");
    writeFileSync(fixture, String.raw`
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef wchar_t WCHAR;
typedef void *HANDLE;
typedef int BOOL;
typedef struct { int64_t QuadPart; } LARGE_INTEGER;
typedef struct { DWORD Flags; HANDLE RootDirectory; DWORD FileNameLength; WCHAR FileName[1]; } FILE_RENAME_INFO;
typedef struct { DWORD dwLowDateTime; DWORD dwHighDateTime; } FILETIME;
typedef struct { DWORD dwFileAttributes; FILETIME ftCreationTime,ftLastAccessTime,ftLastWriteTime; DWORD dwVolumeSerialNumber,nFileSizeHigh,nFileSizeLow,nNumberOfLinks,nFileIndexHigh,nFileIndexLow; } BY_HANDLE_FILE_INFORMATION;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define GENERIC_WRITE 0x40000000u
#define DELETE 0x10000u
#define FILE_READ_ATTRIBUTES 0x80u
#define FILE_SHARE_READ 1u
#define FILE_SHARE_WRITE 2u
#define FILE_SHARE_DELETE 4u
#define CREATE_NEW 1u
#define OPEN_EXISTING 3u
#define FILE_ATTRIBUTE_NORMAL 128u
#define FILE_ATTRIBUTE_DIRECTORY 16u
#define FILE_FLAG_OPEN_REPARSE_POINT 0x200000u
#define FILE_BEGIN 0u
#define FILE_RENAME_FLAG_REPLACE_IF_EXISTS 1u
#define FILE_RENAME_FLAG_POSIX_SEMANTICS 2u
#define FileRenameInfoEx 22u
#define FALSE 0
#define _TRUNCATE ((size_t)-1)
${declarations}
static int scenario, bad, creates, sources, queries, writes, flushes, closes, renames, errors, pendingError, lastApi;
static unsigned closedHandles;
static size_t wcsnlen_s(const WCHAR *text, size_t bound) { size_t n; for (n=0;n<bound && text[n];n++) {} return n; }
static int _snwprintf_s(WCHAR *out, size_t bound, size_t truncate, const WCHAR *format, ...) {
  va_list args; int n; (void)truncate; va_start(args, format); n=vswprintf(out,bound,format,args); va_end(args); return n;
}
static void api(int id) { if(pendingError) bad=1; lastApi=id; }
static int handleIndex(HANDLE owned) {
  int number=(int)(uintptr_t)owned;
  if(number>=10 && number<=12) return number-10;
  if(number>=20 && number<=21) return number-17;
  bad=1; return 0;
}
static HANDLE CreateFileW(const WCHAR *file, DWORD access, DWORD share, void *security, DWORD disposition, DWORD attributes, void *templateFile) {
  static const WCHAR *createdNames[]={L"C:\\fixed\\a-temp.txt",L"C:\\fixed\\b-temp.txt",L"C:\\fixed\\report.bin"};
  static const WCHAR *sourceNames[]={L"C:\\fixed\\a-temp.txt",L"C:\\fixed\\b-temp.txt"};
  int index; api(1);
  if(share!=7 || security || templateFile) bad=1;
  if(access==(DELETE|FILE_READ_ATTRIBUTES)) {
    index=sources++;
    if(index>1 || wcscmp(file,sourceNames[index]) || disposition!=OPEN_EXISTING || attributes!=FILE_FLAG_OPEN_REPARSE_POINT ||
        creates!=2 || (record[CLOSED]&3)!=3 || record[SOURCE_CLOSED]!=(index?1u:0u)) bad=1;
    if((scenario==19 && index==0) || (scenario==20 && index==1)) return INVALID_HANDLE_VALUE;
    if((scenario==23 && index==0) || (scenario==24 && index==1)) return NULL;
    return (HANDLE)(uintptr_t)(20+index);
  }
  index=creates++;
  if(index>2 || wcscmp(file,createdNames[index]) || access!=GENERIC_WRITE || disposition!=CREATE_NEW ||
      attributes!=(FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT)) bad=1;
  if((scenario==5 && index==0) || (scenario==6 && index==1) || (scenario==11 && index==2)) return INVALID_HANDLE_VALUE;
  if(index==2 && (renames!=2 || record[STATUS]!=1 || record[ATTEMPTED]!=3 || record[SOURCE_CLOSED]!=3)) bad=1;
  return (HANDLE)(uintptr_t)(10+index);
}
static int SetFilePointerEx(HANDLE owned, LARGE_INTEGER offset, void *output, DWORD origin) {
  api(2); if(handleIndex(owned)>1 || offset.QuadPart || output || origin!=FILE_BEGIN) bad=1; return 1;
}
static int WriteFile(HANDLE owned, const void *bytes, DWORD length, DWORD *written, void *overlapped) {
  int index=handleIndex(owned); api(3); writes++; if(overlapped) bad=1;
  if(index<2 && (bytes!=replacement || length!=sizeof(replacement)-1)) bad=1;
  if(index==2 && (bytes!=record || length!=sizeof(record))) bad=1;
  if(scenario==7 && index==0) { *written=0; return 0; }
  *written=(scenario==12 && index==2)?length-1:length; return 1;
}
static int SetEndOfFile(HANDLE owned) { api(4); if(handleIndex(owned)>1) bad=1; return 1; }
static int FlushFileBuffers(HANDLE owned) { int index=handleIndex(owned); api(5); flushes++; return !(scenario==8 && index==1); }
static int CloseHandle(HANDLE owned) {
  int index=handleIndex(owned); api(6); closes++;
  if(closedHandles&(1u<<index)) bad=1;
  closedHandles|=1u<<index;
  return !((scenario==9 && index==0) || (scenario==10 && index==1) || (scenario==13 && index==2) ||
    (scenario==21 && index==3) || (scenario==22 && index==4));
}
static int GetFileInformationByHandle(HANDLE source, BY_HANDLE_FILE_INFORMATION *details) {
  int index=queries++; api(8);
  if(index>1 || source!=(HANDLE)(uintptr_t)(20+index) || record[SOURCE_OPENED]!=(index?3u:1u)) bad=1;
  details->dwFileAttributes=128; details->dwVolumeSerialNumber=9; details->nNumberOfLinks=1;
  details->nFileIndexHigh=0; details->nFileIndexLow=100u+(DWORD)index;
  details->ftCreationTime.dwLowDateTime=10u+(DWORD)index; details->ftCreationTime.dwHighDateTime=20u;
  if((scenario==25 && index==0) || (scenario==26 && index==1)) return 0;
  if((scenario==27 && index==0) || (scenario==28 && index==1)) details->nNumberOfLinks=2;
  if(scenario==29 && index==0) details->dwFileAttributes|=16;
  if(scenario==30 && index==1) details->dwFileAttributes|=0x400;
  if(scenario==31 && index==0) details->nFileIndexLow=0;
  return 1;
}
static int SetFileInformationByHandle(HANDLE source, DWORD informationClass, const void *buffer, DWORD bytes) {
  static const WCHAR *targets[]={L"C:\\fixed\\a-old.txt",L"C:\\fixed\\b-old.txt"};
  const FILE_RENAME_INFO *header=(const FILE_RENAME_INFO *)buffer;
  const WCHAR *name=(const WCHAR *)((const unsigned char *)buffer+offsetof(FILE_RENAME_INFO,FileName));
  int index=renames++, ok; api(7);
  if(index>1 || source!=(HANDLE)(uintptr_t)(20+index) || informationClass!=22 || buffer!=renameBuffer.bytes ||
      header->Flags!=3 || header->RootDirectory || wcscmp(name,targets[index]) ||
      header->FileNameLength!=wcslen(name)*sizeof(WCHAR) ||
      bytes!=offsetof(FILE_RENAME_INFO,FileName)+(wcslen(name)+1)*sizeof(WCHAR) ||
      record[CREATED]!=3 || record[WRITTEN]!=3 || record[FLUSHED]!=3 || record[CLOSED]!=3 ||
      record[SOURCE_OPENED]!=(index?3u:1u) || record[SOURCE_CLOSED]!=(index?1u:0u) ||
      record[SOURCE_IDENTIFIED]!=(index?3u:1u) || queries!=index+1) bad=1;
  ok=index==0?scenario!=4:scenario==1; if(!ok) pendingError=1; return ok;
}
static DWORD GetLastError(void) {
  if(!pendingError || lastApi!=7) bad=1;
  pendingError=0; errors++;
  return scenario==2?0:scenario==3?0xffffffffu:5u;
}
static void Sleep(DWORD milliseconds) {
  if(milliseconds!=1000 || bad || pendingError || (scenario!=9 && scenario!=10 && scenario!=13 &&
      scenario!=21 && scenario!=22 && scenario!=23 && scenario!=24)) exit(230);
  if(record[STATUS] && scenario!=13) exit(230);
  exit(234);
}
${functions}
int main(int argc, char **argv) {
  WCHAR *fixed[]={L"fixed.exe",L"C:\\fixed",L"C:\\fixed\\report.bin"};
  int result;
  if(argc!=2) return 230;
  scenario=atoi(argv[1]); if(scenario<0 || scenario>31) return 230;
  if(scenario==15) fixed[2]=L"C:\\fixed\\other.bin";
  if(scenario==16) fixed[1]=L"C:\\fixed\\";
  if(scenario==17) fixed[2]=L"C:\\report.bin";
  if(scenario==18) fixed[2]=L"C:\\fixed\\REPORT.bin";
  result=wmain(scenario==14?2:3,fixed);
  if(bad || pendingError) return 230;
  if(scenario<=3) {
    if(result!=0 || creates!=3 || sources!=2 || queries!=2 || writes!=3 || flushes!=3 || closes!=5 || renames!=2 ||
        errors!=(scenario==1?0:1) || record[SOURCE_OPENED]!=3 || record[SOURCE_CLOSED]!=3 ||
        record[ATTEMPTED]!=3 || record[SUCCEEDED]!=(scenario==1?3u:1u) || record[A_ERROR] ||
        record[B_ERROR]!=(scenario==1?0u:scenario==2?0u:scenario==3?0xffffffffu:5u)) return 230;
    if(fwrite(record,1,sizeof(record),stdout)!=sizeof(record)) return 230;
  } else if(scenario==4) {
    if(result!=1 || creates!=2 || sources!=1 || renames!=1 || closes!=3 || errors!=1 || record[ATTEMPTED]!=1 || record[SUCCEEDED] || record[STATUS]) return 230;
  } else if(scenario==5 || scenario==6 || scenario==7 || scenario==8) {
    if(result!=1 || renames || sources || errors || record[STATUS] || creates>2) return 230;
  } else if(scenario==11 || scenario==12) {
    if(result!=103 || renames!=2 || errors!=1 || creates!=3 || closes!=(scenario==11?4:5)) return 230;
  } else if(scenario>=14 && scenario<=18) {
    if(result!=(scenario==14 || scenario==16?101:102) || creates || renames || sources || closes || errors) return 230;
  } else if(scenario==19 || scenario==20) {
    if(result!=1 || creates!=2 || sources!=(scenario==19?1:2) || renames!=(scenario==19?0:1) ||
        closes!=(scenario==19?2:3) || record[STATUS] || errors) return 230;
  } else if(scenario>=25 && scenario<=31) {
    int first=scenario==25 || scenario==27 || scenario==29 || scenario==31;
    if(result!=1 || creates!=2 || sources!=(first?1:2) || queries!=(first?1:2) ||
        renames!=(first?0:1) || closes!=(first?3:4) || record[STATUS] || errors) return 230;
  } else return 230;
  return result;
}
`);
    const compiled = spawnSync("cc", ["-std=c11", "-O0", "-Wall", "-Wextra", "-Werror", fixture, "-o", executable], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 4096,
    });
    expect(compiled.status, "The actual fixed C logic mock must compile without forwarding compiler output.").toBe(0);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each([
    [0, "B FALSE/error5", 0], [1, "B TRUE without GetLastError", 0], [2, "B FALSE/error0", 0], [3, "B FALSE/maximum DWORD", 0],
    [4, "A failure without B or report", 1], [5, "A CREATE_NEW refusal", 1], [6, "B CREATE_NEW refusal", 1],
    [7, "A write refusal with known close", 1], [8, "B flush refusal with known close", 1],
    [9, "A preparation close uncertainty", 234], [10, "B preparation close uncertainty", 234],
    [11, "report creation refusal", 103], [12, "short report write", 103], [13, "report close uncertainty", 234],
    [14, "wrong argument count", 101], [15, "another report basename", 102], [16, "invalid root path", 101],
    [17, "report outside the control root", 102], [18, "nonliteral report basename case", 102],
    [19, "A source-open refusal", 1], [20, "B source-open refusal", 1],
    [21, "A source-close uncertainty", 234], [22, "B source-close uncertainty", 234],
    [23, "A source-open NULL uncertainty", 234], [24, "B source-open NULL uncertainty", 234],
    [25, "A source identity query refusal", 1], [26, "B source identity query refusal", 1],
    [27, "A source multi-link refusal", 1], [28, "B source multi-link refusal", 1],
    [29, "A directory source refusal", 1], [30, "B reparse source refusal", 1], [31, "A zero source identifier refusal", 1],
  ] as const)("case %i preserves %s", (scenario, _description, exit) => {
    const result = spawnSync(executable, [String(scenario)], { stdio: ["ignore", "pipe", "pipe"], timeout: 2000, maxBuffer: 4096 });
    expect(result.status, "The fixed actual-body logic mock must satisfy its closed invariants.").toBe(exit);
    expect(result.stderr.length).toBe(0); expect(result.stdout.length).toBe(scenario <= 3 ? WINDOWS_OPEN_TARGET_POSIX_REPORT_BYTES : 0);
    if (scenario <= 3) {
      const parsed = parseWindowsOpenTargetPosixReport(result.stdout);
      expect(parsed.b).toEqual({ success: scenario === 1 ? 1 : 0, error: scenario === 1 || scenario === 2 ? 0 : scenario === 3 ? 0xffffffff : 5 });
    }
  });
});
