/* Fixed secure API witness only. No OpenSSL/Node execution, supplied code, RNG fallback use or policy change.
 * Source authority: Node22.23.5/OpenSSL3.5.9 rand_win.c89-116 and independent BCrypt branch73-79.
 * The 48-byte request follows the default AES256 primary entropy32 + nonce16; no entropy leaves this process.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <windows.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define WORDS 48
#define MAGIC 0x47525345u
#define CHARS 32768
#define ENTROPY_BYTES 48
#define ALL_CONTROLS 31u
enum { RUNNING, COMPLETE, FAILED, UNCERTAIN };
enum { H_MAGIC, H_VERSION, H_ROLE, H_STATUS, H_STAGE, H_CONTROLS, H_CANARY_ERROR,
       H_SELF_ERROR, H_READ_ERROR, H_DUP_ERROR, H_PARENT_ERROR, H_CHECKPOINT, H_WIPED, H_TERMINAL };
enum { P_ATTEMPT, P_ACQUIRE_OK, P_ACQUIRE_ERROR, P_GENERATE_ATTEMPT, P_GENERATE_OK,
       P_GENERATE_ERROR, P_RELEASE_ATTEMPT, P_RELEASE_OK, P_RELEASE_ERROR, P_WIPED, P_OWNERSHIP, P_RESERVED };
enum { C_ATTEMPT, C_STATUS, C_OK, C_WIPED };
static DWORD record[WORDS];
static HANDLE reportFile = INVALID_HANDLE_VALUE;
static HCRYPTPROV context;
static BYTE entropy[ENTROPY_BYTES];
static WCHAR state[CHARS], canary[CHARS], reportPath[CHARS], pidWide[16];
static char canaryData[32];
static const char canaryText[] = "EMBER_SECURE_RNG_CANARY\n";
static const WCHAR intelProvider[] = L"Intel Hardware Cryptographic Service Provider";
static DWORD parentPid;
typedef char fixed_report_size[(sizeof(record) == 192) ? 1 : -1];
static DWORD *provider(unsigned int index) { return record + 16 + index * 12; }
static DWORD *cng(void) { return record + 40; }
static void wipe(void) { SecureZeroMemory(entropy, sizeof(entropy)); record[H_WIPED] = 1; }

static int checkpoint(void) {
  LARGE_INTEGER zero;
  DWORD written = 0;
  zero.QuadPart = 0; record[H_CHECKPOINT]++;
  return SetFilePointerEx(reportFile, zero, NULL, FILE_BEGIN)
      && WriteFile(reportFile, record, sizeof(record), &written, NULL)
      && written == sizeof(record) && FlushFileBuffers(reportFile);
}
/* A possibly owned provider is never retried/released after ambiguity; the private job bounds this terminal state. */
static void retain(DWORD reason) {
  wipe(); record[H_STATUS] = UNCERTAIN; record[H_TERMINAL] = reason; checkpoint();
  for (;;) Sleep(1000);
}
static void checkedClose(HANDLE handle) { if (!CloseHandle(handle)) retain(5); }
static int environmentPath(const WCHAR *key, WCHAR *output) {
  DWORD length = GetEnvironmentVariableW(key, output, CHARS), i;
  if (length < 3 || length >= CHARS || output[1] != L':' || output[2] != L'\\'
      || !((output[0] >= L'A' && output[0] <= L'Z') || (output[0] >= L'a' && output[0] <= L'z'))) return 0;
  for (i = 0; i < length; i++) if (output[i] < 32 || output[i] == L'"' || output[i] == L'/') return 0;
  return 1;
}
static int inputs(void) {
  DWORD i, count;
  if (!environmentPath(L"EMBER_LPAC_STATE", state) || !environmentPath(L"EMBER_SECURE_RNG_CANARY", canary)) return 0;
  count = GetEnvironmentVariableW(L"EMBER_SECURE_RNG_PARENT", pidWide, 16);
  if (count == 0 || count > 10 || pidWide[0] == L'0') return 0;
  for (i = 0; i < count; i++) {
    DWORD digit;
    if (pidWide[i] < L'0' || pidWide[i] > L'9') return 0;
    digit = (DWORD)(pidWide[i] - L'0');
    if (parentPid > (MAXDWORD - digit) / 10) return 0;
    parentPid = parentPid * 10 + digit;
  }
  return parentPid != 0 && parentPid != GetCurrentProcessId();
}
static void controls(void) {
  HANDLE opened;
  DWORD got = 0, error = 0, index;
  static const DWORD rights[3] = { PROCESS_VM_READ, PROCESS_DUP_HANDLE, PROCESS_CREATE_PROCESS };
  opened = CreateFileW(canary, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (opened == INVALID_HANDLE_VALUE) {
    error = GetLastError();
    if (record[H_ROLE] == 1 && error == ERROR_ACCESS_DENIED) record[H_CONTROLS] |= 1;
  } else {
    if (ReadFile(opened, canaryData, sizeof(canaryData), &got, NULL)
        && got == sizeof(canaryText) - 1 && memcmp(canaryData, canaryText, got) == 0 && record[H_ROLE] == 0) record[H_CONTROLS] |= 1;
    else error = ERROR_INVALID_DATA;
    checkedClose(opened);
  }
  record[H_CANARY_ERROR] = error;
  opened = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  if (opened == NULL) record[H_SELF_ERROR] = GetLastError();
  else { record[H_CONTROLS] |= 2; checkedClose(opened); }
  for (index = 0; index < 3; index++) {
    opened = OpenProcess(rights[index], FALSE, parentPid); error = opened == NULL ? GetLastError() : 0;
    record[H_READ_ERROR + index] = error;
    if (opened == NULL) { if (record[H_ROLE] == 1 && error == ERROR_ACCESS_DENIED) record[H_CONTROLS] |= 4u << index; }
    else { if (record[H_ROLE] == 0) record[H_CONTROLS] |= 4u << index; checkedClose(opened); }
  }
}
static int observeProvider(unsigned int index) {
  DWORD *p = provider(index);
  BOOL acquired, generated, released;
  wipe(); p[P_ATTEMPT] = 1; context = 0;
  acquired = CryptAcquireContextW(&context, NULL, index == 0 ? NULL : intelProvider,
      index == 0 ? PROV_RSA_FULL : 22, CRYPT_VERIFYCONTEXT | CRYPT_SILENT);
  if (!acquired) {
    p[P_ACQUIRE_ERROR] = GetLastError(); wipe(); p[P_WIPED] = 1;
    if (context != 0) { p[P_OWNERSHIP] = 2; retain(1); }
    return 0;
  }
  p[P_ACQUIRE_OK] = 1;
  if (context == 0) { p[P_OWNERSHIP] = 2; wipe(); p[P_WIPED] = 1; retain(2); }
  p[P_OWNERSHIP] = 1; p[P_GENERATE_ATTEMPT] = 1;
  generated = CryptGenRandom(context, sizeof(entropy), entropy);
  if (generated) p[P_GENERATE_OK] = 1;
  else p[P_GENERATE_ERROR] = GetLastError();
  wipe(); p[P_WIPED] = 1; p[P_RELEASE_ATTEMPT] = 1;
  released = CryptReleaseContext(context, 0);
  if (!released) { p[P_RELEASE_ERROR] = GetLastError(); p[P_OWNERSHIP] = 2; retain(3); }
  p[P_RELEASE_OK] = 1; p[P_OWNERSHIP] = 0; context = 0;
  return generated != FALSE;
}
static void observeCng(void) {
  DWORD *p = cng(); NTSTATUS status;
  wipe(); p[C_ATTEMPT] = 1;
  status = BCryptGenRandom(NULL, entropy, sizeof(entropy), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  p[C_STATUS] = (DWORD)status; p[C_OK] = status == 0 ? 1 : 0;
  wipe(); p[C_WIPED] = 1;
}
int main(int argc, char **argv) {
  HANDLE token = NULL;
  DWORD role = 0, bytes = 0;
  int defaultEntropy;
  (void)argv; wipe();
  if (argc != 1 || !inputs()) return 101;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { if (token != NULL) retain(7); return 102; }
  if (token == NULL || token == INVALID_HANDLE_VALUE) retain(7);
  if (!GetTokenInformation(token, (TOKEN_INFORMATION_CLASS)29, &role, sizeof(role), &bytes) || bytes != sizeof(role) || role > 1) { checkedClose(token); return 103; }
  checkedClose(token);
  record[H_MAGIC] = MAGIC; record[H_VERSION] = 1; record[H_ROLE] = role; record[H_STAGE] = 1;
  if (_snwprintf_s(reportPath, CHARS, _TRUNCATE, L"%ls\\%ls-secure-rng.bin", state, role ? L"lpac" : L"host") < 0) return 105;
  reportFile = CreateFileW(reportPath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (reportFile == INVALID_HANDLE_VALUE) return 106;
  if (!checkpoint()) retain(6);
  record[H_STAGE] = 2; controls(); if (!checkpoint()) retain(6);
  record[H_STAGE] = 3; defaultEntropy = observeProvider(0); if (!checkpoint()) retain(6);
  record[H_STAGE] = 4; if (!defaultEntropy) observeProvider(1); if (!checkpoint()) retain(6);
  record[H_STAGE] = 5; observeCng(); if (!checkpoint()) retain(6);
  wipe(); record[H_STAGE] = 6; record[H_STATUS] = record[H_CONTROLS] == ALL_CONTROLS ? COMPLETE : FAILED;
  if (!checkpoint()) retain(6);
  if (!CloseHandle(reportFile)) { wipe(); record[H_STATUS] = UNCERTAIN; record[H_TERMINAL] = 8; for (;;) Sleep(1000); }
  return record[H_STATUS] == COMPLETE ? 0 : 1;
}
