/* Linux only: exercise actual fixed C ownership/wipe branches with deterministic injected failures.
 * These mocks provide no randomness and establish no Windows ABI, policy, LPAC or cryptographic proof.
 * The real Windows recipe never includes this directory.
 */
#include <setjmp.h>
#include <stdarg.h>
#include <stdlib.h>
#define main rng_program_main
#include "../windows-secure-rng-probe.c"
#undef main
static jmp_buf stopped;
static unsigned int mode, acquireCount, generateCount, releaseCount, cngCount, closeReportCount, wipeCount, reportWrites;
static DWORD lastError;
static int bad;
static void check(int condition) { if (!condition) bad = 1; }
static int wiped(void) { unsigned int i; for (i = 0; i < sizeof(entropy); i++) if (entropy[i] != 0) return 0; return 1; }
void *SecureZeroMemory(void *value, size_t size) {
  volatile BYTE *p = (volatile BYTE *)value;
  size_t i; for (i = 0; i < size; i++) p[i] = 0;
  check(value == entropy && size == 48); wipeCount++; lastError = 0xf00d;
  return value;
}
DWORD GetLastError(void) { return lastError; }
void Sleep(DWORD duration) { check(duration == 1000 && wiped()); longjmp(stopped, 1); }
BOOL SetFilePointerEx(HANDLE file, LARGE_INTEGER position, LARGE_INTEGER *next, DWORD method) {
  check(file == (HANDLE)(uintptr_t)99 && position.QuadPart == 0 && next == NULL && method == FILE_BEGIN); return TRUE;
}
BOOL WriteFile(HANDLE file, const void *data, DWORD size, DWORD *written, void *overlapped) {
  check(file == (HANDLE)(uintptr_t)99 && data == record && size == 192 && overlapped == NULL);
  *written = size; reportWrites++; return TRUE;
}
BOOL FlushFileBuffers(HANDLE file) { check(file == (HANDLE)(uintptr_t)99); return TRUE; }
BOOL CloseHandle(HANDLE file) {
  if (file == (HANDLE)(uintptr_t)99) { closeReportCount++; if (mode == 6) return FALSE; }
  return TRUE;
}
DWORD GetEnvironmentVariableW(const WCHAR *key, WCHAR *out, DWORD capacity) {
  const WCHAR *value = wcscmp(key, L"EMBER_SECURE_RNG_PARENT") == 0 ? L"42" : L"C:\\Fixed";
  size_t length = wcslen(value); check(length < capacity); wcscpy(out, value); return (DWORD)length;
}
DWORD GetCurrentProcessId(void) { return 100; }
HANDLE GetCurrentProcess(void) { return (HANDLE)(uintptr_t)100; }
HANDLE CreateFileW(const WCHAR *name, DWORD access, DWORD share, void *security, DWORD creation, DWORD flags, HANDLE templateFile) {
  (void)name; (void)access; (void)share; (void)security; (void)flags; (void)templateFile;
  return (HANDLE)(uintptr_t)(creation == CREATE_NEW ? 99 : 98);
}
BOOL ReadFile(HANDLE file, void *out, DWORD capacity, DWORD *count, void *overlapped) {
  check(file == (HANDLE)(uintptr_t)98 && capacity >= sizeof(canaryText) - 1 && overlapped == NULL);
  *count = sizeof(canaryText) - 1; memcpy(out, canaryText, *count); return TRUE;
}
HANDLE OpenProcess(DWORD rights, BOOL inherit, DWORD pid) { (void)rights; (void)pid; check(inherit == FALSE); return (HANDLE)(uintptr_t)97; }
BOOL OpenProcessToken(HANDLE process, DWORD rights, HANDLE *out) { (void)process; check(rights == TOKEN_QUERY); *out = (HANDLE)(uintptr_t)96; return TRUE; }
BOOL GetTokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS kind, void *out, DWORD size, DWORD *count) {
  (void)token; check(kind == 29 && size == 4); *(DWORD *)out = 0; *count = 4; return TRUE;
}
int _snwprintf_s(WCHAR *out, size_t capacity, size_t truncate, const WCHAR *format, ...) {
  int result; va_list args; check(truncate == _TRUNCATE); va_start(args, format); result = vswprintf(out, capacity, format, args); va_end(args); return result;
}
BOOL CryptAcquireContextW(HCRYPTPROV *out, const WCHAR *container, const WCHAR *name, DWORD type, DWORD flags) {
  acquireCount++; check(container == NULL && flags == (CRYPT_VERIFYCONTEXT | CRYPT_SILENT) && *out == 0 && wiped());
  check(acquireCount == 1 ? name == NULL && type == PROV_RSA_FULL : wcscmp(name, intelProvider) == 0 && type == 22);
  if (mode == 1) { *out = 11; lastError = 5; return FALSE; }
  if (mode == 2) { *out = 0; return TRUE; }
  if (mode == 7 && acquireCount == 1) { lastError = 0x80090016; return FALSE; }
  *out = acquireCount == 1 ? 11 : 22; return TRUE;
}
BOOL CryptGenRandom(HCRYPTPROV owned, DWORD size, BYTE *out) {
  generateCount++; check((owned == 11 || owned == 22) && size == 48 && out == entropy); memset(out, 0xa5, size);
  if (mode == 3 && owned == 11) { lastError = 31; return FALSE; } return TRUE;
}
BOOL CryptReleaseContext(HCRYPTPROV owned, DWORD flags) {
  releaseCount++; check((owned == 11 || owned == 22) && flags == 0 && wiped());
  if (mode == 4) { lastError = 6; return FALSE; } return TRUE;
}
NTSTATUS BCryptGenRandom(HANDLE algorithm, BYTE *out, DWORD size, DWORD flags) {
  cngCount++; check(algorithm == NULL && out == entropy && size == 48 && flags == 2 && wiped()); memset(out, 0x5a, size);
  return mode == 5 ? (NTSTATUS)0xc0000022u : 0;
}
int main(int argc, char **argv) {
  int terminal;
  volatile int result = -1;
  char *program[] = { (char *)"fixed", NULL };
  if (argc != 2 || strlen(argv[1]) != 1 || argv[1][0] < '0' || argv[1][0] > '7') return 10;
  mode = (unsigned int)(argv[1][0] - '0');
  terminal = setjmp(stopped);
  if (!terminal) result = rng_program_main(1, program);
  check(wiped() && wipeCount >= 3 && record[H_WIPED] == 1 && reportWrites >= 1);
  if (mode == 1 || mode == 2 || mode == 4) {
    check(terminal && result == -1 && record[H_STATUS] == UNCERTAIN && provider(0)[P_OWNERSHIP] == 2);
    check(record[H_TERMINAL] == (mode == 1 ? 1u : mode == 2 ? 2u : 3u));
    check(acquireCount == 1 && generateCount == (mode == 4 ? 1u : 0u) && releaseCount == (mode == 4 ? 1u : 0u) && cngCount == 0 && closeReportCount == 0);
    check(mode != 1 || provider(0)[P_ACQUIRE_ERROR] == 5); check(mode != 4 || provider(0)[P_RELEASE_ERROR] == 6);
  } else {
    check(mode == 6 ? terminal && result == -1 : !terminal && result == 0);
    check(record[H_STATUS] == (mode == 6 ? UNCERTAIN : COMPLETE) && record[H_STAGE] == 6 && record[H_CONTROLS] == 31 && record[H_CHECKPOINT] == 6);
    check(record[H_TERMINAL] == (mode == 6 ? 8u : 0u));
    check(acquireCount == (mode == 3 || mode == 7 ? 2u : 1u));
    check(releaseCount == (mode == 3 ? 2u : 1u) && generateCount == releaseCount && cngCount == 1 && closeReportCount == 1 && context == 0);
    check(mode != 3 || (provider(0)[P_GENERATE_ERROR] == 31 && provider(1)[P_GENERATE_OK] == 1));
    check(mode != 7 || (provider(0)[P_ACQUIRE_ERROR] == 0x80090016 && provider(1)[P_GENERATE_OK] == 1));
    check(cng()[C_STATUS] == (mode == 5 ? 0xc0000022u : 0u) && cng()[C_WIPED] == 1);
  }
  if (bad) return 20;
  printf("{\"schema\":1,\"case\":%u,\"terminal\":%u,\"wiped\":1,\"acquireAttempts\":%u,\"generateAttempts\":%u,\"releaseAttempts\":%u,\"cngAttempts\":%u,\"reportCloseAttempts\":%u}\n",
      mode, terminal ? 1u : 0u, acquireCount, generateCount, releaseCount, cngCount, closeReportCount);
  return 0;
}
