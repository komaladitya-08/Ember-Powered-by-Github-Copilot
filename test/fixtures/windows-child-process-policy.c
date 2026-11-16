/* Fixed root/leaf observation only. No arbitrary image, script, broker, driver or direct Nt ABI.
 * CHILD_PROCESS_POLICY values and ProcessChildProcessPolicy are separate SDK contracts.
 * All terminal uncertainty remains inside the private job until the trusted parent stops it.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <processthreadsapi.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define WORDS 80
#define MAGIC 0x50435045u
#define CHARS 32768
#define CONTROLS 15u
#define MAX_TOKEN_BYTES 16384u
enum { RUNNING, COMPLETE, FAILED, UNCERTAIN };
enum { H_MAGIC, H_VERSION, H_ROLE, H_CASE, H_STATUS, H_STAGE, H_CONTROLS,
       H_CANARY_CODE, H_SELF_CODE, H_PARENT_CREATE_CODE, H_PARENT_WRITE_CODE,
       H_BEFORE_OK, H_BEFORE_CODE, H_BEFORE_FLAGS, H_SET_ATTEMPT, H_SET_MASK,
       H_SET_OK, H_SET_CODE, H_AFTER_OK, H_AFTER_CODE, H_AFTER_FLAGS,
       H_CHECKPOINT, H_TERMINAL, H_RESERVED };
enum { A_ROUTE, A_ATTEMPT, A_ATTR_ATTEMPT, A_ATTR_READY, A_ATTR_CODE,
       A_CREATE_ATTEMPT, A_CREATE_OK, A_CREATE_CODE, A_TOKEN_OK, A_IMAGE_OK,
       A_JOB_OK, A_POLICY_OK, A_POLICY_FLAGS, A_RESUME_ATTEMPT, A_RESUME_OK,
       A_RESUME_CODE, A_WAIT_OK, A_EXIT_CODE, A_THREAD_CLOSED, A_PROCESS_CLOSED,
       A_ATTR_DELETED, A_CLOSE_CODE, A_OWNERSHIP, A_RESERVED };
static DWORD record[WORDS];
static HANDLE reportFile = INVALID_HANDLE_VALUE;
static PROCESS_INFORMATION child;
static WCHAR state[CHARS], canary[CHARS], ownImage[CHARS], childImage[CHARS], command[CHARS], reportPath[CHARS];
static WCHAR number[16];
static DWORD parentPid, caseId;
static const char canaryText[] = "EMBER_CHILD_POLICY_CANARY\n";
static BYTE canaryBytes[64];
static union { LARGE_INTEGER align; BYTE bytes[4096]; } attributes;
static DWORD overridePolicy = PROCESS_CREATION_CHILD_PROCESS_OVERRIDE;
static BYTE *tokenStorage;
typedef char fixed_report_size[(sizeof(record) == 320) ? 1 : -1];
typedef char fixed_policy_size[(sizeof(PROCESS_MITIGATION_CHILD_PROCESS_POLICY) == 4) ? 1 : -1];
static DWORD *attempt(unsigned int index) { return record + 24 + index * 24; }
static int validHandle(HANDLE value) { return value != NULL && value != INVALID_HANDLE_VALUE; }
static int checkpoint(void) {
  LARGE_INTEGER zero;
  DWORD count = 0;
  zero.QuadPart = 0; record[H_CHECKPOINT]++;
  return SetFilePointerEx(reportFile, zero, NULL, FILE_BEGIN)
      && WriteFile(reportFile, record, sizeof(record), &count, NULL)
      && count == sizeof(record) && FlushFileBuffers(reportFile);
}
static void retain(DWORD reason) {
  record[H_STATUS] = UNCERTAIN; record[H_TERMINAL] = reason; checkpoint();
  for (;;) Sleep(1000);
}
static void closeKnown(HANDLE value) { if (!CloseHandle(value)) retain(3); }
static int pathInput(const WCHAR *key, WCHAR *out) {
  DWORD size = GetEnvironmentVariableW(key, out, CHARS), i;
  if (size < 3 || size >= CHARS || out[1] != L':' || out[2] != L'\\'
      || !((out[0] >= L'A' && out[0] <= L'Z') || (out[0] >= L'a' && out[0] <= L'z'))) return 0;
  for (i = 0; i < size; i++) if (out[i] < 32 || out[i] == L'"' || out[i] == L'/') return 0;
  return 1;
}
static int numberInput(const WCHAR *key, DWORD *out) {
  DWORD size = GetEnvironmentVariableW(key, number, 16), i;
  *out = 0;
  if (!size || size > 10 || (size > 1 && number[0] == L'0')) return 0;
  for (i = 0; i < size; i++) {
    DWORD digit;
    if (number[i] < L'0' || number[i] > L'9') return 0;
    digit = (DWORD)(number[i] - L'0');
    if (*out > (MAXDWORD - digit) / 10) return 0;
    *out = *out * 10 + digit;
  }
  return 1;
}
static HANDLE tokenOf(HANDLE process) {
  HANDLE token = NULL;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) { if (token != NULL) retain(4); retain(4); }
  if (!validHandle(token)) retain(4);
  return token;
}
static DWORD tokenDword(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD value = 0, bytes = 0;
  if (!GetTokenInformation(token, kind, &value, sizeof(value), &bytes) || bytes != sizeof(value)) retain(5);
  return value;
}
/* Check SID pointers before asking SID routines to read variable-length data. */
static int containedSid(const BYTE *base, DWORD bytes, PSID sid) {
  uintptr_t start = (uintptr_t)base, pointer = (uintptr_t)sid;
  const BYTE *data;
  DWORD length;
  if (bytes < 8 || pointer < start || pointer - start > bytes - 8) return 0;
  data = base + (pointer - start);
  if (data[0] != SID_REVISION || data[1] > SID_MAX_SUB_AUTHORITIES) return 0;
  length = 8u + 4u * data[1];
  return length <= bytes - (DWORD)(pointer - start) && IsValidSid(sid) && GetLengthSid(sid) == length;
}
static void tokenIdentity(HANDLE token, TOKEN_INFORMATION_CLASS kind, BYTE *out, DWORD capacity, PSID *sid) {
  DWORD bytes = 0;
  if (!GetTokenInformation(token, kind, out, capacity, &bytes) || bytes < sizeof(PSID) || bytes > capacity) retain(5);
  *sid = *(PSID *)out;
  if (!containedSid(out, bytes, *sid)) retain(5);
}
static int noCapabilitiesOrAap(HANDLE token) {
  DWORD size = 0, returned = 0, i;
  BOOL queried;
  TOKEN_GROUPS *groups;
  BYTE aap[SECURITY_MAX_SID_SIZE];
  DWORD aapBytes = sizeof(aap);
  BYTE caps[32];
  if (!GetTokenInformation(token, TokenCapabilities, caps, sizeof(caps), &returned) || returned < sizeof(DWORD) || *(DWORD *)caps != 0) return 0;
  queried = GetTokenInformation(token, TokenGroups, NULL, 0, &size);
  if (queried || GetLastError() != ERROR_INSUFFICIENT_BUFFER || size < offsetof(TOKEN_GROUPS, Groups) || size > MAX_TOKEN_BYTES) retain(5);
  tokenStorage = (BYTE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
  if (tokenStorage == NULL) retain(6);
  if (!GetTokenInformation(token, TokenGroups, tokenStorage, size, &returned) || returned > size || returned < offsetof(TOKEN_GROUPS, Groups)) retain(5);
  groups = (TOKEN_GROUPS *)tokenStorage;
  if (groups->GroupCount > 128 || groups->GroupCount > (returned - offsetof(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) retain(5);
  if (!CreateWellKnownSid(WinBuiltinAnyPackageSid, NULL, aap, &aapBytes) || !IsValidSid(aap)) retain(5);
  queried = TRUE;
  for (i = 0; i < groups->GroupCount; i++) {
    if (!containedSid(tokenStorage, returned, groups->Groups[i].Sid)) retain(5);
    if (EqualSid(groups->Groups[i].Sid, aap) && (groups->Groups[i].Attributes & SE_GROUP_ENABLED)) queried = FALSE;
  }
  if (!HeapFree(GetProcessHeap(), 0, tokenStorage)) retain(6);
  tokenStorage = NULL;
  return queried != FALSE;
}
static DWORD integrityOf(HANDLE token) {
  BYTE data[256]; PSID sid;
  tokenIdentity(token, TokenIntegrityLevel, data, sizeof(data), &sid);
  if (*GetSidSubAuthorityCount(sid) == 0) retain(5);
  return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
}
static int childTokenMatches(void) {
  HANDLE self = tokenOf(GetCurrentProcess()), other = tokenOf(child.hProcess);
  DWORD role = tokenDword(self, TokenIsAppContainer), otherRole = tokenDword(other, TokenIsAppContainer);
  BYTE selfUser[256], otherUser[256], selfPackage[256], otherPackage[256];
  PSID userA, userB, packageA, packageB;
  int matched;
  if (role > 1 || otherRole > 1) retain(5);
  tokenIdentity(self, TokenUser, selfUser, sizeof(selfUser), &userA);
  tokenIdentity(other, TokenUser, otherUser, sizeof(otherUser), &userB);
  matched = role == otherRole && EqualSid(userA, userB) && integrityOf(self) == integrityOf(other);
  if (role) {
    tokenIdentity(self, TokenAppContainerSid, selfPackage, sizeof(selfPackage), &packageA);
    tokenIdentity(other, TokenAppContainerSid, otherPackage, sizeof(otherPackage), &packageB);
    matched = matched && EqualSid(packageA, packageB) && noCapabilitiesOrAap(self) && noCapabilitiesOrAap(other);
  }
  closeKnown(other); closeKnown(self);
  return matched;
}
static int policyOf(HANDLE process, DWORD *flags, DWORD *code) {
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY policy;
  BOOL ok;
  ZeroMemory(&policy, sizeof(policy)); *flags = 0; *code = 0;
  ok = GetProcessMitigationPolicy(process, ProcessChildProcessPolicy, &policy, sizeof(policy));
  if (!ok) { *code = GetLastError(); return 0; }
  if (policy.Flags & ~7u) retain(7);
  *flags = policy.Flags; return 1;
}
static void controls(void) {
  HANDLE opened;
  DWORD bytes = 0, code = 0, i;
  static const DWORD rights[2] = { PROCESS_CREATE_PROCESS, PROCESS_VM_WRITE };
  opened = CreateFileW(canary, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (opened == INVALID_HANDLE_VALUE) { code = GetLastError(); if (record[H_ROLE] && code == ERROR_ACCESS_DENIED) record[H_CONTROLS] |= 1; }
  else {
    if (ReadFile(opened, canaryBytes, sizeof(canaryBytes), &bytes, NULL) && bytes == sizeof(canaryText) - 1
        && memcmp(canaryBytes, canaryText, bytes) == 0 && record[H_ROLE] == 0) record[H_CONTROLS] |= 1;
    else code = ERROR_INVALID_DATA;
    closeKnown(opened);
  }
  record[H_CANARY_CODE] = code;
  opened = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  if (opened == NULL) record[H_SELF_CODE] = GetLastError();
  else { record[H_CONTROLS] |= 2; closeKnown(opened); }
  for (i = 0; i < 2; i++) {
    opened = OpenProcess(rights[i], FALSE, parentPid); code = opened == NULL ? GetLastError() : 0;
    record[H_PARENT_CREATE_CODE + i] = code;
    if (opened == NULL) { if (record[H_ROLE] && code == ERROR_ACCESS_DENIED) record[H_CONTROLS] |= 4u << i; }
    else { if (!record[H_ROLE]) record[H_CONTROLS] |= 4u << i; closeKnown(opened); }
  }
}
static void policyObservation(void) {
  static const DWORD mutation[8] = { 0, 0, 0, 0, 2, 4, 3, 5 };
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY policy;
  record[H_BEFORE_OK] = (DWORD)policyOf(GetCurrentProcess(), &record[H_BEFORE_FLAGS], &record[H_BEFORE_CODE]);
  if (!record[H_BEFORE_OK] || ((caseId == 1 || caseId >= 3) && record[H_BEFORE_FLAGS] != 1)
     ) retain(7);
  if (caseId >= 3) {
    ZeroMemory(&policy, sizeof(policy)); policy.Flags = mutation[caseId];
    record[H_SET_ATTEMPT] = 1; record[H_SET_MASK] = policy.Flags;
    if (SetProcessMitigationPolicy(ProcessChildProcessPolicy, &policy, sizeof(policy))) record[H_SET_OK] = 1;
    else record[H_SET_CODE] = GetLastError();
  }
  record[H_AFTER_OK] = (DWORD)policyOf(GetCurrentProcess(), &record[H_AFTER_FLAGS], &record[H_AFTER_CODE]);
  if (caseId < 3 && (!record[H_AFTER_OK] || record[H_AFTER_FLAGS] != record[H_BEFORE_FLAGS])) retain(7);
}
/* The exact ownership boundary is used by the Linux fault tests without pretending to emulate Windows. */
static int captureCreation(BOOL created, DWORD code, DWORD *a) {
  a[A_CREATE_ATTEMPT] = 1;
  if (!created) {
    a[A_CREATE_CODE] = code;
    if (child.hProcess != NULL || child.hThread != NULL || child.dwProcessId != 0 || child.dwThreadId != 0) { a[A_OWNERSHIP] = 2; retain(8); }
    return 0;
  }
  if (!validHandle(child.hProcess) || !validHandle(child.hThread) || child.hProcess == child.hThread || child.dwProcessId == 0 || child.dwProcessId == GetCurrentProcessId() || child.dwThreadId == 0) {
    a[A_OWNERSHIP] = 2; retain(8);
  }
  a[A_CREATE_OK] = 1; a[A_OWNERSHIP] = 1; return 1;
}
static void closeCreated(DWORD *a) {
  HANDLE value = child.hThread; child.hThread = NULL;
  if (!CloseHandle(value)) { a[A_CLOSE_CODE] = GetLastError(); a[A_OWNERSHIP] = 2; retain(9); }
  a[A_THREAD_CLOSED] = 1;
  value = child.hProcess; child.hProcess = NULL;
  if (!CloseHandle(value)) { a[A_CLOSE_CODE] = GetLastError(); a[A_OWNERSHIP] = 2; retain(9); }
  a[A_PROCESS_CLOSED] = 1; a[A_OWNERSHIP] = 0;
}
/* NULL checks association only. The trusted parent owns the exact private job and verifies its final zero. */
static int childHasJob(void) {
  BOOL associated = FALSE;
  return IsProcessInJob(child.hProcess, NULL, &associated) && associated;
}

static void observeCreation(unsigned int index) {
  DWORD *a = attempt(index), code = 0, flags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
  SIZE_T size = 0;
  BOOL initialized = FALSE, created, updated;
  STARTUPINFOEXW startup;
  a[A_ROUTE] = index; a[A_ATTEMPT] = 1;
  ZeroMemory(&startup, sizeof(startup)); ZeroMemory(&child, sizeof(child));
  startup.StartupInfo.cb = sizeof(STARTUPINFOW);
  if (index) {
    a[A_ATTR_ATTEMPT] = 1;
    if (InitializeProcThreadAttributeList(NULL, 1, 0, &size) || GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0 || size > sizeof(attributes.bytes)) retain(10);
    ZeroMemory(&attributes, sizeof(attributes));
    initialized = InitializeProcThreadAttributeList((LPPROC_THREAD_ATTRIBUTE_LIST)attributes.bytes, 1, 0, &size);
    if (!initialized) { a[A_ATTR_CODE] = GetLastError(); return; }
    updated = UpdateProcThreadAttribute((LPPROC_THREAD_ATTRIBUTE_LIST)attributes.bytes, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,
        &overridePolicy, sizeof(overridePolicy), NULL, NULL);
    if (!updated) code = GetLastError();
    if (!updated) { a[A_ATTR_CODE] = code; DeleteProcThreadAttributeList((LPPROC_THREAD_ATTRIBUTE_LIST)attributes.bytes); a[A_ATTR_DELETED] = 1; return; }
    a[A_ATTR_READY] = 1; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)attributes.bytes;
    flags |= EXTENDED_STARTUPINFO_PRESENT;
  }
  if (_snwprintf_s(command, CHARS, _TRUNCATE, L"\"%ls\" --leaf", ownImage) < 0) retain(10);
  created = CreateProcessW(ownImage, command, NULL, NULL, FALSE, flags, NULL, NULL, &startup.StartupInfo, &child);
  if (!created) code = GetLastError();
  if (initialized) { DeleteProcThreadAttributeList((LPPROC_THREAD_ATTRIBUTE_LIST)attributes.bytes); a[A_ATTR_DELETED] = 1; }
  if (!captureCreation(created, code, a)) return;
  if (GetProcessId(child.hProcess) != child.dwProcessId || GetThreadId(child.hThread) != child.dwThreadId || GetProcessIdOfThread(child.hThread) != child.dwProcessId) retain(11);
  if (!childTokenMatches()) retain(11);
  a[A_TOKEN_OK] = 1;
  {
    DWORD chars = CHARS;
    if (!QueryFullProcessImageNameW(child.hProcess, 0, childImage, &chars) || chars == 0 || chars >= CHARS || _wcsicmp(ownImage, childImage) != 0) retain(11);
    a[A_IMAGE_OK] = 1;
  }
  if (!childHasJob()) retain(11);
  a[A_JOB_OK] = 1;
  a[A_POLICY_OK] = (DWORD)policyOf(child.hProcess, &a[A_POLICY_FLAGS], &code);
  if (!a[A_POLICY_OK]) retain(11);
  a[A_RESUME_ATTEMPT] = 1;
  {
    DWORD previous = ResumeThread(child.hThread);
    if (previous == MAXDWORD) { a[A_RESUME_CODE] = GetLastError(); retain(12); }
    if (previous != 1) retain(12);
  }
  a[A_RESUME_OK] = 1;
  if (WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0) retain(13);
  a[A_WAIT_OK] = 1;
  if (!GetExitCodeProcess(child.hProcess, &a[A_EXIT_CODE]) || a[A_EXIT_CODE] != 0) retain(13);
  closeCreated(a);
}
int main(int argc, char **argv) {
  HANDLE token;
  DWORD role, chars;
  if (argc == 2 && strcmp(argv[1], "--leaf") == 0) return 0;
  if (argc != 1 || !pathInput(L"EMBER_LPAC_STATE", state) || !pathInput(L"EMBER_CHILD_POLICY_CANARY", canary)
      || !numberInput(L"EMBER_CHILD_POLICY_CASE", &caseId) || caseId > 7
      || !numberInput(L"EMBER_CHILD_POLICY_PARENT", &parentPid) || !parentPid || parentPid == GetCurrentProcessId()) return 101;
  chars = GetModuleFileNameW(NULL, ownImage, CHARS);
  if (!chars || chars >= CHARS - 16) return 102;
  token = tokenOf(GetCurrentProcess()); role = tokenDword(token, TokenIsAppContainer); closeKnown(token);
  if (role > 1) return 103;
  record[H_MAGIC] = MAGIC; record[H_VERSION] = 1; record[H_ROLE] = role; record[H_CASE] = caseId; record[H_STAGE] = 1;
  if (_snwprintf_s(reportPath, CHARS, _TRUNCATE, L"%ls\\%ls-child-policy.bin", state, role ? L"lpac" : L"host") < 0) return 104;
  reportFile = CreateFileW(reportPath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (reportFile == INVALID_HANDLE_VALUE) return 105;
  if (!checkpoint()) retain(14);
  record[H_STAGE] = 2; controls(); if (record[H_CONTROLS] != CONTROLS) retain(15); if (!checkpoint()) retain(14);
  record[H_STAGE] = 3; policyObservation(); if (!checkpoint()) retain(14);
  record[H_STAGE] = 4; observeCreation(0); if (!checkpoint()) retain(14);
  record[H_STAGE] = 5; observeCreation(1); if (!checkpoint()) retain(14);
  record[H_STAGE] = 6; record[H_STATUS] = COMPLETE; if (!checkpoint()) retain(14);
  if (!CloseHandle(reportFile)) { record[H_STATUS] = UNCERTAIN; record[H_TERMINAL] = 16; for (;;) Sleep(1000); }
  return 0;
}
