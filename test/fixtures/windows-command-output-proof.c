/* Fixed output-API witness only. No Node/toolchain, replacement, shell, child or network workload. */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <windows.h>
#include <wchar.h>
#include <string.h>

static const char seed[] = "EMBER_OUTPUT_SEED\n";
static const char created[] = "EMBER_OUTPUT_CREATED\n";
static const char ready[] = "EMBER_OUTPUT_READY\n";
static const char errorReady[] = "EMBER_ERROR_READY\n";
static const char done[] = "\nEMBER_OUTPUT_DONE\n";
static const char errorDone[] = "\nEMBER_ERROR_DONE\n";
static char block[16384];

/* An unknown child close cannot certify progress. The host must terminate the genuine root/job. */
static void uncertain(void) { for (;;) Sleep(1000); }
static void closeKnown(HANDLE owned) { if (!CloseHandle(owned)) uncertain(); }
static int writeAll(HANDLE owned, const void *bytes, DWORD length) {
  const char *cursor = (const char *)bytes;
  while (length) {
    DWORD count = 0;
    if (!WriteFile(owned, cursor, length, &count, NULL) || count == 0 || count > length) return 0;
    cursor += count; length -= count;
  }
  return 1;
}
static int checkSeed(void) {
  HANDLE owned = CreateFileW(L"seed.txt", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  char bytes[sizeof(seed)]; DWORD count = 0; int accepted;
  if (owned == INVALID_HANDLE_VALUE || owned == NULL) return 0;
  accepted = ReadFile(owned, bytes, (DWORD)sizeof(bytes), &count, NULL) && count == (DWORD)(sizeof(seed) - 1)
    && memcmp(bytes, seed, sizeof(seed) - 1) == 0;
  SecureZeroMemory(bytes, sizeof(bytes)); closeKnown(owned); return accepted;
}
static int createKnown(void) {
  HANDLE owned = CreateFileW(L"created.txt", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  int accepted;
  if (owned == INVALID_HANDLE_VALUE || owned == NULL) return 0;
  accepted = writeAll(owned, created, (DWORD)(sizeof(created) - 1)) && FlushFileBuffers(owned);
  closeKnown(owned); return accepted;
}
int wmain(int argc, WCHAR **argv) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE), error = GetStdHandle(STD_ERROR_HANDLE);
  DWORD count = 1, index; char probe = 0; int mode;
  if (argc != 2) return 201;
  mode = wcscmp(argv[1], L"natural") == 0 ? 1 : wcscmp(argv[1], L"overflow") == 0 ? 2 : wcscmp(argv[1], L"cancel") == 0 ? 3 : 0;
  if (!mode || !input || input == INVALID_HANDLE_VALUE || !output || output == INVALID_HANDLE_VALUE || !error || error == INVALID_HANDLE_VALUE) return 202;
  if (GetFileType(input) != FILE_TYPE_CHAR || GetFileType(output) != FILE_TYPE_PIPE || GetFileType(error) != FILE_TYPE_PIPE) return 203;
  if (!ReadFile(input, &probe, 1, &count, NULL) || count != 0 || !checkSeed()) return 204;
  if (mode == 1 && !createKnown()) return 205;
  if (!writeAll(output, ready, (DWORD)(sizeof(ready) - 1)) || !writeAll(error, errorReady, (DWORD)(sizeof(errorReady) - 1))) return 206;
  /* Give the host a bounded opportunity to observe the exact still-live root before any Stop request. */
  Sleep(1000);
  if (mode == 3) { Sleep(10000); return 207; }
  if (mode == 2) {
    memset(block, 'X', sizeof(block));
    for (index = 0; index < 32; index++) if (!writeAll(output, block, (DWORD)sizeof(block))) return 208;
    Sleep(10000); return 209;
  }
  memset(block, 'O', sizeof(block));
  if (!writeAll(output, block, (DWORD)sizeof(block)) || !writeAll(output, block, 1024) || !writeAll(output, done, (DWORD)(sizeof(done) - 1))) return 210;
  memset(block, 'E', sizeof(block));
  if (!writeAll(error, block, 13 * 1024) || !writeAll(error, errorDone, (DWORD)(sizeof(errorDone) - 1))) return 211;
  SecureZeroMemory(block, sizeof(block));
  return 17;
}
