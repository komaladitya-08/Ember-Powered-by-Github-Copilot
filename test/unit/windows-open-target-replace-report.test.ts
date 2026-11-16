/** The host comparison accepts observations, never an invalid A control or incomplete native ownership. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWindowsOpenTargetReplaceReport, WINDOWS_OPEN_TARGET_REPLACE_REPORT_BYTES, WINDOWS_OPEN_TARGET_REPLACE_REPORT_MAGIC } from "../fixtures/windows-open-target-replace-report";

const complete = (bSuccess = false, bError = bSuccess ? 0 : 5) => [WINDOWS_OPEN_TARGET_REPLACE_REPORT_MAGIC, 1, 1, 3, 3, 3, 3, 3, bSuccess ? 3 : 1, 0, bError, 0, 0, 0, 0, 0];
const encode = (words: readonly number[]) => {
  const bytes = Buffer.alloc(WINDOWS_OPEN_TARGET_REPLACE_REPORT_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4)); return bytes;
};
const changed = (offset: number, value: number, words = complete()) => { const next = [...words]; next[offset] = value; return encode(next); };

describe("Stopped ordinary-host open-target numeric observations", () => {
  it.each([false, true])("keeps B success=%s separate from the valid unpinned A control", success => {
    const parsed = parseWindowsOpenTargetReplaceReport(encode(complete(success)));
    expect(parsed).toEqual({ schema: 1, status: 1,
      preparation: { createdMask: 3, writtenMask: 3, flushedMask: 3, closedMask: 3 }, attemptedMask: 3, successMask: success ? 3 : 1,
      a: { success: 1, error: 0 }, b: { success: success ? 1 : 0, error: success ? 0 : 5 } });
  });
  it.each([0, 1, 5, 32, 0x80000000, 0xffffffff])("keeps an immediate failed-BOOL DWORD %i without coercing it into success", error => {
    const parsed = parseWindowsOpenTargetReplaceReport(encode(complete(false, error)));
    expect(parsed.b).toEqual({ success: 0, error }); expect(parsed.successMask).toBe(1);
  });
  it.each([0, 2, 3, 4, 0xffffffff])("refuses a foreign magic %i", value => {
    expect(() => parseWindowsOpenTargetReplaceReport(changed(0, value))).toThrow("numeric contract");
  });
  it.each([0, 2, 0xffffffff])("refuses schema %i", value => {
    expect(() => parseWindowsOpenTargetReplaceReport(changed(1, value))).toThrow("numeric contract");
  });
  it.each([0, 2, 0xffffffff])("refuses noncomplete status %i", value => {
    expect(() => parseWindowsOpenTargetReplaceReport(changed(2, value))).toThrow("numeric contract");
  });
  it.each([3, 4, 5, 6, 7])("requires both completed preparation/attempt bits in word %i", offset => {
    for (const value of [0, 1, 2, 4, 7, 0xffffffff]) expect(() => parseWindowsOpenTargetReplaceReport(changed(offset, value))).toThrow("numeric contract");
  });
  it.each([0, 2, 4, 7, 0xffffffff])("refuses invalid success mask %i, including B without A", mask => {
    expect(() => parseWindowsOpenTargetReplaceReport(changed(8, mask))).toThrow("numeric contract");
  });
  it.each([1, 5, 32, 0xffffffff])("refuses failed A error %i even if its success bit is asserted", error => {
    expect(() => parseWindowsOpenTargetReplaceReport(changed(9, error))).toThrow("numeric contract");
  });
  it.each([1, 5, 32, 0xffffffff])("refuses B success with an error DWORD %i", error => {
    expect(() => parseWindowsOpenTargetReplaceReport(encode(complete(true, error)))).toThrow("numeric contract");
  });
  it.each([11, 12, 13, 14, 15])("refuses reserved word %i", offset => {
    expect(() => parseWindowsOpenTargetReplaceReport(changed(offset, 1))).toThrow("numeric contract");
  });
  it.each([0, 4, 60, 63, 65, 68, 128])("refuses report size %i", length => {
    expect(() => parseWindowsOpenTargetReplaceReport(Buffer.alloc(length))).toThrow("numeric contract");
  });
  it("requires an actual Buffer without reading foreign values", () => {
    let touched = 0;
    const foreign = new Proxy({}, { get() { touched++; throw new Error("private"); } });
    expect(() => parseWindowsOpenTargetReplaceReport(foreign as Buffer)).toThrow("numeric contract"); expect(touched).toBe(0);
    expect(() => parseWindowsOpenTargetReplaceReport(new Uint8Array(64) as Buffer)).toThrow("numeric contract");
  });
  it("returns detached deeply frozen numeric facts without mutating or retaining the report", () => {
    const bytes = encode(complete()), copy = Buffer.from(bytes), parsed = parseWindowsOpenTargetReplaceReport(bytes);
    expect(bytes.equals(copy)).toBe(true); bytes.fill(0);
    expect(parsed.b).toEqual({ success: 0, error: 5 });
    for (const object of [parsed, parsed.preparation, parsed.a, parsed.b]) expect(Object.isFrozen(object)).toBe(true);
    expect(() => { (parsed.b as { error: number }).error = 33; }).toThrow();
    expect(JSON.stringify(parsed)).not.toMatch(/SID|path|handle|process|private|EMBER/);
  });
});

// Run the actual decision/API-order bodies with fixed logic mocks. This does not validate Windows declarations or ABI.
const actualFunction = (source: string, signature: string) => {
  const start = source.indexOf(signature), opening = source.indexOf("{", start);
  if (start < 0 || opening < 0) throw new Error("The fixed C logic fixture is unavailable.");
  let depth = 1, end = opening + 1;
  for (; end < source.length && depth > 0; end++) { if (source[end] === "{") depth++; if (source[end] === "}") depth--; }
  if (depth !== 0) throw new Error("The fixed C logic fixture is unavailable.");
  return source.slice(start, end);
};
describe.skipIf(process.platform !== "linux")("Actual ordinary-host C comparison with fixed non-Windows logic mocks", () => {
  let directory = "", executable = "";
  beforeAll(() => {
    const source = readFileSync(path.resolve("test/fixtures/windows-open-target-replace.c"), "utf8");
    const declarations = source.slice(source.indexOf("#define CHARS"), source.indexOf("/* A failed close"));
    const functions = ["static void uncertain(void)", "static void closeKnown(HANDLE *owned)", "static int pathInput(const WCHAR *text)",
      "static int join(const WCHAR *root, const WCHAR *name, WCHAR *output)", "static int prepare(const WCHAR *file, DWORD bit)",
      "static int compare(const WCHAR *root, DWORD bit, const WCHAR *temporaryName, const WCHAR *targetName, DWORD errorSlot)",
      "static int publish(const WCHAR *file)", "int wmain(int argc, WCHAR **argv)"].map(signature => actualFunction(source, signature)).join("\n");
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-open-target-logic-"));
    executable = path.join(directory, "logic"); const fixture = path.join(directory, "logic.c");
    writeFileSync(fixture, String.raw`
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef wchar_t WCHAR;
typedef void *HANDLE;
typedef int BOOL;
typedef struct { int64_t QuadPart; } LARGE_INTEGER;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define GENERIC_WRITE 0x40000000u
#define FILE_SHARE_READ 1u
#define FILE_SHARE_WRITE 2u
#define FILE_SHARE_DELETE 4u
#define CREATE_NEW 1u
#define FILE_ATTRIBUTE_NORMAL 128u
#define FILE_FLAG_OPEN_REPARSE_POINT 0x200000u
#define FILE_BEGIN 0u
#define MOVEFILE_REPLACE_EXISTING 1u
#define FALSE 0
#define _TRUNCATE ((size_t)-1)
${declarations}
static int scenario, bad, creates, writes, flushes, closes, moves, errors, pendingError, lastApi;
static unsigned closedHandles;
static size_t wcsnlen_s(const WCHAR *text, size_t bound) { size_t n; for (n=0;n<bound && text[n];n++) {} return n; }
static int _snwprintf_s(WCHAR *out, size_t bound, size_t truncate, const WCHAR *format, ...) {
  va_list args; int n; (void)truncate; va_start(args, format); n=vswprintf(out,bound,format,args); va_end(args); return n;
}
static void api(int id) { if (pendingError) bad=1; lastApi=id; }
static int handleIndex(HANDLE owned) { int index=(int)(uintptr_t)owned-10; if(index<0 || index>2) { bad=1; return 0; } return index; }
static HANDLE CreateFileW(const WCHAR *file, DWORD access, DWORD share, void *security, DWORD disposition, DWORD attributes, void *templateFile) {
  static const WCHAR *names[]={L"C:\\fixed\\a-temp.txt",L"C:\\fixed\\b-temp.txt",L"C:\\fixed\\report.bin"};
  int index=creates; api(1); creates++;
  if(index>2 || wcscmp(file,names[index]) || access!=GENERIC_WRITE || share!=7 || security || disposition!=CREATE_NEW ||
      attributes!=(FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT) || templateFile) bad=1;
  if((scenario==5 && index==0) || (scenario==6 && index==1) || (scenario==11 && index==2)) return INVALID_HANDLE_VALUE;
  if(index==2 && (moves!=2 || record[STATUS]!=1 || record[ATTEMPTED]!=3 || record[CREATED]!=3 || record[CLOSED]!=3)) bad=1;
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
  return !((scenario==9 && index==0) || (scenario==10 && index==1) || (scenario==13 && index==2));
}
static int MoveFileExW(const WCHAR *from, const WCHAR *to, DWORD flags) {
  static const WCHAR *sources[]={L"C:\\fixed\\a-temp.txt",L"C:\\fixed\\b-temp.txt"};
  static const WCHAR *targets[]={L"C:\\fixed\\a-old.txt",L"C:\\fixed\\b-old.txt"};
  int index=moves, ok; api(7); moves++;
  if(index>1 || wcscmp(from,sources[index]) || wcscmp(to,targets[index]) || flags!=MOVEFILE_REPLACE_EXISTING ||
      creates!=2 || closes!=2 || record[CREATED]!=3 || record[WRITTEN]!=3 || record[FLUSHED]!=3 || record[CLOSED]!=3) bad=1;
  ok=index==0?scenario!=4:scenario==1;
  if(!ok) pendingError=1;
  return ok;
}
static DWORD GetLastError(void) {
  if(!pendingError || lastApi!=7) bad=1;
  pendingError=0; errors++;
  return scenario==2?0:scenario==3?0xffffffffu:5u;
}
static void Sleep(DWORD milliseconds) {
  if(milliseconds!=1000 || bad || (scenario!=9 && scenario!=10 && scenario!=13)) exit(230);
  if(scenario==13 ? moves!=2 || errors!=1 || creates!=3 || closes!=3 : moves || errors) exit(230);
  /* A report-close failure occurs only after both observations; no publication escapes this process. */
  exit(234);
}
${functions}
int main(int argc, char **argv) {
  WCHAR *fixed[]={L"fixed.exe",L"C:\\fixed",L"C:\\fixed\\report.bin"};
  int result;
  if(argc!=2) return 230;
  scenario=atoi(argv[1]);
  if(scenario<0 || scenario>18) return 230;
  if(scenario==15) fixed[2]=L"C:\\fixed\\other.bin";
  if(scenario==16) fixed[1]=L"C:\\fixed\\";
  if(scenario==17) fixed[2]=L"C:\\report.bin";
  if(scenario==18) fixed[2]=L"C:\\fixed\\REPORT.bin";
  result=wmain(scenario==14?2:3,fixed);
  if(bad || pendingError) return 230;
  if(scenario<=3) {
    if(result!=0 || creates!=3 || writes!=3 || flushes!=3 || closes!=3 || moves!=2 || errors!=(scenario==1?0:1) ||
        record[ATTEMPTED]!=3 || record[SUCCEEDED]!=(scenario==1?3u:1u) || record[A_ERROR] ||
        record[B_ERROR]!=(scenario==1?0u:scenario==2?0u:scenario==3?0xffffffffu:5u)) return 230;
    if(fwrite(record,1,sizeof(record),stdout)!=sizeof(record)) return 230;
  } else if(scenario==4) {
    if(result!=1 || creates!=2 || moves!=1 || closes!=2 || errors!=1 || record[ATTEMPTED]!=1 || record[SUCCEEDED] || record[STATUS]) return 230;
  } else if(scenario==5 || scenario==6 || scenario==7 || scenario==8) {
    if(result!=1 || moves || errors || record[STATUS] || creates>2) return 230;
  } else if(scenario==11 || scenario==12) {
    if(result!=103 || moves!=2 || errors!=1 || creates!=3 || closes!=(scenario==11?2:3)) return 230;
  } else if(scenario>=14) {
    if(result!=(scenario==14 || scenario==16?101:102) || creates || moves || closes || errors) return 230;
  } else return 230;
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
    [0, "B FALSE/error5", 0], [1, "B TRUE without GetLastError", 0], [2, "B FALSE/error0", 0], [3, "B FALSE/maximum DWORD", 0],
    [4, "A failure without B or report", 1], [5, "A CREATE_NEW refusal", 1], [6, "B CREATE_NEW refusal", 1],
    [7, "A write refusal with known close", 1], [8, "B flush refusal with known close", 1],
    [9, "A close uncertainty before either attempt", 234], [10, "B close uncertainty before either attempt", 234],
    [11, "report creation refusal", 103], [12, "short report write", 103], [13, "report close uncertainty", 234],
    [14, "wrong argument count", 101], [15, "another report basename", 102], [16, "invalid root path", 101],
    [17, "report outside the comparison root", 102], [18, "nonliteral report basename case", 102],
  ] as const)("case %i preserves %s", (scenario, _description, exit) => {
    const result = spawnSync(executable, [String(scenario)], { stdio: ["ignore", "pipe", "pipe"], timeout: 2000, maxBuffer: 4096 });
    expect(result.status, "The fixed actual-body logic mock must satisfy its closed invariants.").toBe(exit);
    expect(result.stderr.length).toBe(0); expect(result.stdout.length).toBe(scenario <= 3 ? 64 : 0);
    if (scenario <= 3) {
      const parsed = parseWindowsOpenTargetReplaceReport(result.stdout);
      expect(parsed.b).toEqual({ success: scenario === 1 ? 1 : 0, error: scenario === 1 || scenario === 2 ? 0 : scenario === 3 ? 0xffffffff : 5 });
    }
  });
});
