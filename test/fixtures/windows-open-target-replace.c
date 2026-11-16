/* Fixed ordinary-host open-target comparison. No project input, POSIX rename, retry or stdout/stderr. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdio.h>

#define CHARS 32768
#define REPORT_MAGIC 0x52544f57u
enum { MAGIC, VERSION, STATUS, CREATED, WRITTEN, FLUSHED, CLOSED, ATTEMPTED, SUCCEEDED, A_ERROR, B_ERROR };
static DWORD record[16];
static WCHAR temporary[CHARS], target[CHARS];
static const char replacement[] = "EMBER_OPEN_TARGET_NEW\n";
typedef char exact_report[(sizeof(record) == 64) ? 1 : -1];

/* A failed close can consume its handle. Never retry or publish with unknown ownership. */
static void uncertain(void) { for (;;) Sleep(1000); }
static void closeKnown(HANDLE *owned) {
  HANDLE selected = *owned;
  *owned = INVALID_HANDLE_VALUE;
  if (selected == NULL || selected == INVALID_HANDLE_VALUE) uncertain();
  if (!CloseHandle(selected)) uncertain();
}
static int pathInput(const WCHAR *text) {
  size_t i, length = wcsnlen_s(text, CHARS), start = 3;
  if (length < 4 || length >= CHARS || text[1] != L':' || text[2] != L'\\' ||
      !((text[0] >= L'A' && text[0] <= L'Z') || (text[0] >= L'a' && text[0] <= L'z'))) return 0;
  for (i = 3; i <= length; i++) {
    WCHAR c = text[i];
    if ((c && c < 32) || c == 127 || c == L'/' || c == L':' || c == L'"') return 0;
    if (c == L'\\' || c == 0) {
      if (i == start || text[i - 1] == L'.' || text[i - 1] == L' ') return 0;
      start = i + 1;
    }
  }
  return 1;
}
static int join(const WCHAR *root, const WCHAR *name, WCHAR *output) {
  return _snwprintf_s(output, CHARS, _TRUNCATE, L"%ls\\%ls", root, name) >= 0;
}
static int prepare(const WCHAR *file, DWORD bit) {
  HANDLE owned = CreateFileW(file, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  LARGE_INTEGER zero;
  DWORD written = 0;
  int ok = 0;
  if (owned == NULL) uncertain();
  if (owned == INVALID_HANDLE_VALUE) return 0;
  record[CREATED] |= bit;
  zero.QuadPart = 0;
  if (SetFilePointerEx(owned, zero, NULL, FILE_BEGIN) &&
      WriteFile(owned, replacement, (DWORD)(sizeof(replacement) - 1), &written, NULL) &&
      written == (DWORD)(sizeof(replacement) - 1) && SetEndOfFile(owned)) {
    record[WRITTEN] |= bit;
    if (FlushFileBuffers(owned)) { record[FLUSHED] |= bit; ok = 1; }
  }
  closeKnown(&owned); record[CLOSED] |= bit;
  return ok;
}
static int compare(const WCHAR *root, DWORD bit, const WCHAR *temporaryName, const WCHAR *targetName, DWORD errorSlot) {
  BOOL moved;
  DWORD error;
  if (!join(root, temporaryName, temporary) || !join(root, targetName, target)) return 0;
  record[ATTEMPTED] |= bit;
  moved = MoveFileExW(temporary, target, MOVEFILE_REPLACE_EXISTING);
  if (!moved) {
    error = GetLastError(); /* Capture the failed call's immediate DWORD before any other API. */
    record[errorSlot] = error;
  } else record[SUCCEEDED] |= bit;
  return bit == 1 ? moved != FALSE : 1;
}
static int publish(const WCHAR *file) {
  HANDLE owned = CreateFileW(file, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  DWORD written = 0;
  int ok = 0;
  if (owned == NULL) uncertain();
  if (owned == INVALID_HANDLE_VALUE) return 0;
  if (WriteFile(owned, record, (DWORD)sizeof(record), &written, NULL) && written == (DWORD)sizeof(record) && FlushFileBuffers(owned)) ok = 1;
  closeKnown(&owned);
  return ok;
}
int wmain(int argc, WCHAR **argv) {
  if (argc != 3 || !pathInput(argv[1]) || !pathInput(argv[2])) return 101;
  if (!join(argv[1], L"report.bin", target) || wcscmp(target, argv[2]) != 0) return 102;
  record[MAGIC] = REPORT_MAGIC; record[VERSION] = 1;
  if (!join(argv[1], L"a-temp.txt", temporary) || !prepare(temporary, 1) ||
      !join(argv[1], L"b-temp.txt", temporary) || !prepare(temporary, 2)) return 1;
  /* Invalid A never becomes an observation of B. Neither case uses a fallback. */
  if (!compare(argv[1], 1, L"a-temp.txt", L"a-old.txt", A_ERROR)) return 1;
  if (!compare(argv[1], 2, L"b-temp.txt", L"b-old.txt", B_ERROR)) return 1;
  record[STATUS] = 1;
  return publish(argv[2]) ? 0 : 103;
}
