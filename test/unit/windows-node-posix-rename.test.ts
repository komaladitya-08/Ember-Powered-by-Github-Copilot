/** Actual pinned adapter body under fixed Linux Win32/allocator mocks; SDK ABI is separately mandatory on Windows. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pin from "../../scripts/experimental/windows-node-posix-source-pin.json";

describe.skipIf(process.platform !== "linux")("Actual experimental libuv rename body", () => {
  let directory = "", executable = "";
  beforeAll(() => {
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-node-rename-logic-")); executable = path.join(directory, "logic");
    const file = path.join(directory, "logic.c");
    writeFileSync(file, String.raw`
#include <assert.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
typedef uint32_t DWORD;
typedef uint16_t WCHAR;
typedef void *HANDLE;
typedef int BOOL;
typedef int FILE_INFO_BY_HANDLE_CLASS;
typedef struct { int result; int sys_errno_; struct { WCHAR* pathw; } file; struct { struct { WCHAR* new_pathw; } info; } fs; } uv_fs_t;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define DELETE 0x10000u
#define FILE_READ_ATTRIBUTES 0x80u
#define FILE_SHARE_READ 1u
#define FILE_SHARE_WRITE 2u
#define FILE_SHARE_DELETE 4u
#define OPEN_EXISTING 3u
#define FILE_FLAG_OPEN_REPARSE_POINT 0x200000u
#define ERROR_PATH_NOT_FOUND 3u
#define ERROR_INVALID_PARAMETER 87u
#define ERROR_FILENAME_EXCED_RANGE 206u
#define ERROR_OUTOFMEMORY 14u
#define ERROR_GEN_FAILURE 31u
#define UV_EIO -5001
#define UV_ENOMEM -5002
#define FALSE 0
#define STATIC_ASSERT(expr) _Static_assert(expr,#expr)
#define SET_REQ_RESULT(req,value) do { (req)->result=(value);assert((req)->result!=-1); } while(0)
#define SET_REQ_WIN32_ERROR(req,error) do { (req)->sys_errno_=(error);(req)->result=uv_translate_sys_error((req)->sys_errno_); } while(0)
#define SET_REQ_UV_ERROR(req,error,system) do { (req)->result=(error);(req)->sys_errno_=(system); } while(0)
static int scenario,bad,opens,sets,closes,allocations,frees,errorReads,translations,pendingError;
static DWORD lastError;
static WCHAR sourcePath[32]={67,58,92,115,111,117,114,99,101,0},targetPath[32769];
static size_t targetLength,allocatedBytes;
static void *allocated;
static int uv_translate_sys_error(int error) { translations++;return error==0?0:-10000-error; }
static void* uv__malloc(size_t bytes) {
  allocations++;if(opens || sets || closes || allocations!=1)bad=1;
  if(bytes!=20+(targetLength+1)*2)bad=1;
  if(scenario==9)return NULL;
  allocatedBytes=bytes;return allocated=malloc(bytes);
}
static void uv__free(void *value) {
  if(value!=allocated || frees || pendingError)bad=1;
  frees++;free(value);allocated=NULL;lastError=777;
}
static HANDLE CreateFileW(const WCHAR *source,DWORD access,DWORD sharing,void *security,DWORD disposition,DWORD flags,HANDLE templateFile) {
  if(source!=sourcePath || access!=0x10080 || sharing!=7 || security || disposition!=3 || flags!=0x200000 || templateFile || opens || pendingError)bad=1;
  opens++;
  if(scenario==3 || scenario==4 || scenario==15) { lastError=scenario==3?5:0;pendingError=1;return scenario==15?NULL:INVALID_HANDLE_VALUE; }
  return (HANDLE)(uintptr_t)700;
}
static BOOL SetFileInformationByHandle(HANDLE source,FILE_INFO_BY_HANDLE_CLASS kind,void *buffer,DWORD bytes) {
  unsigned char *raw=(unsigned char *)buffer;DWORD flags,length;HANDLE root;
  if(source!=(HANDLE)(uintptr_t)700 || kind!=22 || buffer!=allocated || bytes!=allocatedBytes || sets || closes || pendingError)bad=1;
  memcpy(&flags,raw,4);memcpy(&root,raw+8,8);memcpy(&length,raw+16,4);
  if(flags!=3 || root || length!=targetLength*2 || memcmp(raw+20,targetPath,(targetLength+1)*2))bad=1;
  sets++;
  if(scenario==1 || scenario==2 || scenario==7 || scenario==8 || scenario>=20) {
    lastError=scenario==1?5:scenario==7?32:0;
    if(scenario>=20) { static const DWORD codes[]={2,3,32,17,87,50,1,5};lastError=codes[scenario-20]; }
    pendingError=1;return 0;
  }
  return scenario==14?2:1;
}
static BOOL CloseHandle(HANDLE source) {
  if(source!=(HANDLE)(uintptr_t)700 || closes || pendingError)bad=1;
  closes++;
  if(scenario==5 || scenario==6 || scenario==7 || scenario==8) {lastError=scenario==6?0:5;if(scenario==5 || scenario==6)pendingError=1;return 0;}
  lastError=888;return 1;
}
static DWORD GetLastError(void) { if(!pendingError)bad=1;pendingError=0;errorReads++;return lastError; }
` + pin.patches[3].replacement + String.raw`
int main(int argc,char **argv) {
  uv_fs_t req;size_t index;WCHAR sourceBefore[32],targetBefore[32769];
  if(argc!=2) { return 230; }
  scenario=atoi(argv[1]);if(scenario<0 || scenario>27) { return 230; }
  targetLength=scenario==10?0:scenario==11?32768:scenario==16?32767:scenario==17?3:8;
  for(index=0;index<targetLength;index++) { targetPath[index]=(WCHAR)(65+index%20); }
  targetPath[targetLength]=0;
  if(scenario==17) {targetPath[0]=65;targetPath[1]=0xd83d;targetPath[2]=0xde80;}
  if(scenario==18 || scenario==19) {
    static const WCHAR fromSubdir[]={115,117,98,92,102,105,108,101,0},fromCwd[]={102,105,108,101,0};
    static const WCHAR toCwd[]={116,97,114,103,101,116,0},toSubdir[]={115,117,98,92,116,97,114,103,101,116,0};
    memcpy(sourcePath,scenario==18?fromSubdir:fromCwd,scenario==18?sizeof(fromSubdir):sizeof(fromCwd));
    targetLength=scenario==18?6:10;
    memcpy(targetPath,scenario==18?toCwd:toSubdir,(targetLength+1)*2);
  }
  memcpy(sourceBefore,sourcePath,sizeof(sourcePath));memcpy(targetBefore,targetPath,sizeof(targetPath));
  memset(&req,0,sizeof(req));req.result=123;req.sys_errno_=123;req.file.pathw=scenario==12?NULL:sourcePath;req.fs.info.new_pathw=scenario==13?NULL:targetPath;
  fs__rename(&req);
  if(memcmp(sourceBefore,sourcePath,sizeof(sourcePath)) || memcmp(targetBefore,targetPath,sizeof(targetPath)))bad=1;
  if(bad || allocated || pendingError || opens>1 || sets>1 || closes>1 || allocations>1 || frees>1)return 230;
  printf("{\"result\":%d,\"system\":%d,\"opens\":%d,\"sets\":%d,\"closes\":%d,\"allocations\":%d,\"frees\":%d,\"errorReads\":%d,\"translations\":%d}",req.result,req.sys_errno_,opens,sets,closes,allocations,frees,errorReads,translations);
  return 0;
}
`);
    const result = spawnSync("cc", ["-std=c11", "-O0", "-Wall", "-Wextra", "-Werror", file, "-o", executable], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 4096 });
    expect(result.status, "The fixed adapter mock must compile; compiler output remains private.").toBe(0);
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  const run = (scenario: number) => {
    const value = spawnSync(executable, [String(scenario)], { stdio: ["ignore", "pipe", "pipe"], timeout: 2000, maxBuffer: 4096 });
    expect(value.status, "The actual adapter must preserve its fixed call and buffer invariants.").toBe(0); expect(value.stderr.length).toBe(0);
    return JSON.parse(value.stdout.toString()) as Record<string, number>;
  };
  it.each([0, 14, 16, 17, 18, 19])("case %i completes one positive source/setter/close with exact UTF-16 bytes", scenario => {
    expect(run(scenario)).toEqual({ result: 0, system: 123, opens: 1, sets: 1, closes: 1, allocations: 1, frees: 1, errorReads: 0, translations: 0 });
  });
  it.each([[1,5],[7,32],[20,2],[21,3],[22,32],[23,17],[24,87],[25,50],[26,1],[27,5]])("case %i preserves genuine error %i before close/free changes last-error", (scenario,error) => {
    expect(run(scenario)).toEqual({ result: -10000-error, system: error, opens: 1, sets: 1, closes: 1, allocations: 1, frees: 1, errorReads: 1, translations: 1 });
  });
  it.each([2,8])("case %i refuses FALSE/error0 even when close also refuses", scenario => {
    expect(run(scenario)).toMatchObject({ result: -5001, system: 31, opens: 1, sets: 1, closes: 1, frees: 1, errorReads: 1, translations: 0 });
  });
  it.each([[3,5],[4,0],[15,0]])("case %i never closes an unissued source after error %i", (scenario,error) => {
    expect(run(scenario)).toMatchObject({ result: error ? -10000-error : -5001, system: error || 31, opens: 1, sets: 0, closes: 0, allocations: 1, frees: 1, errorReads: 1 });
  });
  it.each([[5,5],[6,0]])("case %i refuses a close failure after successful rename, without retry", (scenario,error) => {
    expect(run(scenario)).toMatchObject({ result: error ? -10000-error : -5001, system: error || 31, opens: 1, sets: 1, closes: 1, frees: 1, errorReads: 1 });
  });
  it("refuses allocation failure before any native call", () => {
    expect(run(9)).toEqual({ result: -5002, system: 14, opens: 0, sets: 0, closes: 0, allocations: 1, frees: 0, errorReads: 0, translations: 0 });
  });
  it.each([[10,3],[11,206],[12,87],[13,87]])("case %i refuses malformed or bounded paths with error %i before allocation/native calls", (scenario,error) => {
    expect(run(scenario)).toEqual({ result: -10000-error, system: error, opens: 0, sets: 0, closes: 0, allocations: 0, frees: 0, errorReads: 0, translations: 1 });
  });
});

it("leaves the three prior patches and Windows header target untouched", () => {
  expect(pin.patches).toHaveLength(4); expect(pin.patches[3].file).toBe("deps/uv/src/win/fs.c");
  expect(pin.patches[3].replacement).not.toMatch(/MoveFileExW|NtSetInformationFile|BACKUP_SEMANTICS|IGNORE_READONLY|#\s*define\s+(?:_WIN32_WINNT|NTDDI_VERSION)/);
  const original = JSON.parse(readFileSync(path.resolve("scripts/experimental/windows-node-source-pin.json"), "utf8"));
  expect(pin.patches.slice(0,3)).toEqual(original.patches);
  expect(pin.sourceArchive).toEqual(original.sourceArchive); expect(pin.provenance).toEqual(original.provenance);
});

describe.skipIf(process.platform !== "linux")("Actual SDK enum assertion logic only", () => {
  it.each([[22, 22, true], [22, 23, false], [23, 22, false]] as const)("checks adapter %i and SDK %i without comparing different enum types", (adapterValue, sdkValue, accepted) => {
    const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-node-enum-assertion-"));
    try {
      const lines = readFileSync(new URL("../fixtures/windows-node-posix-rename-abi.c", import.meta.url), "utf8").split("\n").filter(line => line.startsWith("STATIC_ASSERT(") && (line.includes("UV__FS_RENAME_INFO_EX") || line.includes("FileRenameInfoEx")));
      expect(lines).toHaveLength(2);
      const source = path.join(directory, "assertion.c"), object = path.join(directory, "assertion.o");
      writeFileSync(source, `#include <assert.h>\nenum { UV__FS_RENAME_INFO_EX = ${adapterValue} };\ntypedef enum { FileRenameInfoEx = ${sdkValue} } sdk_class;\n#define STATIC_ASSERT(value) static_assert(value, #value)\n${lines.join("\n")}\n`);
      const result = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Wenum-compare", "-Werror", "-c", source, "-o", object], { stdio: ["ignore", "pipe", "pipe"], timeout: 2500, maxBuffer: 4096 });
      expect(result.error, "The fixed compiler must return a natural outcome; its text remains private.").toBeUndefined();
      expect(result.signal).toBeNull(); expect(Number.isInteger(result.status)).toBe(true);
      if (accepted) expect(result.status, "Equal enum values must compile without suppressing warnings.").toBe(0);
      else expect(result.status, "The real assertion must still reject a changed SDK value.").not.toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
