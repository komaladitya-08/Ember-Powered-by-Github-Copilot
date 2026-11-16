/* Fixed ordinary-host POSIX replacement control. No project input, fallback, retry or standard output. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A000002
#include <windows.h>
#include <wchar.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>

/* Use the user-mode SDK ABI, not the distinct kernel FILE_INFORMATION_CLASS enumeration.
 * https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h#L9140
 */
typedef char exact_pointer[(sizeof(void *) == 8) ? 1 : -1];
typedef char exact_wchar[(sizeof(WCHAR) == 2) ? 1 : -1];
typedef char exact_flags[(offsetof(FILE_RENAME_INFO, Flags) == 0) ? 1 : -1];
typedef char exact_root[(offsetof(FILE_RENAME_INFO, RootDirectory) == 8) ? 1 : -1];
typedef char exact_length[(offsetof(FILE_RENAME_INFO, FileNameLength) == 16) ? 1 : -1];
typedef char exact_name[(offsetof(FILE_RENAME_INFO, FileName) == 20) ? 1 : -1];
typedef char exact_class[(FileRenameInfoEx == 22) ? 1 : -1];
typedef char exact_replace_flag[(FILE_RENAME_FLAG_REPLACE_IF_EXISTS == 1) ? 1 : -1];
typedef char exact_posix_flag[(FILE_RENAME_FLAG_POSIX_SEMANTICS == 2) ? 1 : -1];
typedef char exact_file_info[(sizeof(BY_HANDLE_FILE_INFORMATION) == 52) ? 1 : -1];
typedef char exact_file_created[(offsetof(BY_HANDLE_FILE_INFORMATION, ftCreationTime) == 4) ? 1 : -1];
typedef char exact_file_volume[(offsetof(BY_HANDLE_FILE_INFORMATION, dwVolumeSerialNumber) == 28) ? 1 : -1];
typedef char exact_file_links[(offsetof(BY_HANDLE_FILE_INFORMATION, nNumberOfLinks) == 40) ? 1 : -1];
typedef char exact_file_index_high[(offsetof(BY_HANDLE_FILE_INFORMATION, nFileIndexHigh) == 44) ? 1 : -1];
typedef char exact_file_index_low[(offsetof(BY_HANDLE_FILE_INFORMATION, nFileIndexLow) == 48) ? 1 : -1];

#define CHARS 32768
#define REPORT_MAGIC 0x50544f57u
enum { MAGIC, VERSION, STATUS, CREATED, WRITTEN, FLUSHED, CLOSED, ATTEMPTED, SUCCEEDED, A_ERROR, B_ERROR,
  SOURCE_OPENED, SOURCE_CLOSED, INFORMATION_CLASS, RENAME_FLAGS, SOURCE_IDENTIFIED };
static DWORD record[40];
static WCHAR temporary[CHARS], target[CHARS];
static union { FILE_RENAME_INFO aligned; unsigned char bytes[offsetof(FILE_RENAME_INFO, FileName) + CHARS * sizeof(WCHAR)]; } renameBuffer;
static const char replacement[] = "EMBER_OPEN_TARGET_NEW\n";
typedef char exact_report[(sizeof(record) == 160) ? 1 : -1];

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
static int identify(HANDLE source, DWORD bit) {
  BY_HANDLE_FILE_INFORMATION details;
  DWORD offset = bit == 1 ? 24 : 32;
  memset(&details, 0, sizeof(details));
  if (!GetFileInformationByHandle(source, &details)) return 0;
  if ((details.dwFileAttributes & (0x445640u | FILE_ATTRIBUTE_DIRECTORY)) || details.nNumberOfLinks != 1 ||
      !(details.nFileIndexHigh | details.nFileIndexLow)) return 0;
  record[offset] = details.dwVolumeSerialNumber;
  record[offset + 1] = details.nFileIndexHigh;
  record[offset + 2] = details.nFileIndexLow;
  record[offset + 3] = details.ftCreationTime.dwLowDateTime;
  record[offset + 4] = details.ftCreationTime.dwHighDateTime;
  record[SOURCE_IDENTIFIED] |= bit;
  return 1;
}
static int compare(const WCHAR *root, DWORD bit, const WCHAR *temporaryName, const WCHAR *targetName, DWORD errorSlot) {
  HANDLE source;
  BOOL moved;
  size_t length, bytes;
  if (!join(root, temporaryName, temporary) || !join(root, targetName, target)) return 0;
  length = wcsnlen_s(target, CHARS);
  if (length < 4 || length >= CHARS) return 0;
  bytes = offsetof(FILE_RENAME_INFO, FileName) + (length + 1) * sizeof(WCHAR);
  if (bytes > sizeof(renameBuffer.bytes) || bytes > 0xffffffffu) return 0;
  memset(&renameBuffer, 0, sizeof(renameBuffer));
  renameBuffer.aligned.Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
  renameBuffer.aligned.RootDirectory = NULL;
  renameBuffer.aligned.FileNameLength = (DWORD)(length * sizeof(WCHAR));
  memcpy(renameBuffer.bytes + offsetof(FILE_RENAME_INFO, FileName), target, (length + 1) * sizeof(WCHAR));
  source = CreateFileW(temporary, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (source == NULL) uncertain();
  if (source == INVALID_HANDLE_VALUE) return 0;
  record[SOURCE_OPENED] |= bit;
  if (!identify(source, bit)) { closeKnown(&source); record[SOURCE_CLOSED] |= bit; return 0; }
  record[ATTEMPTED] |= bit;
  moved = SetFileInformationByHandle(source, FileRenameInfoEx, renameBuffer.bytes, (DWORD)bytes);
  if (!moved) record[errorSlot] = GetLastError(); /* Capture before CloseHandle or any other API. */
  else record[SUCCEEDED] |= bit;
  closeKnown(&source); record[SOURCE_CLOSED] |= bit;
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
  record[MAGIC] = REPORT_MAGIC; record[VERSION] = 2;
  record[INFORMATION_CLASS] = (DWORD)FileRenameInfoEx;
  record[RENAME_FLAGS] = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
  if (!join(argv[1], L"a-temp.txt", temporary) || !prepare(temporary, 1) ||
      !join(argv[1], L"b-temp.txt", temporary) || !prepare(temporary, 2)) return 1;
  /* Invalid A never becomes an observation of B. Neither case uses a fallback. */
  if (!compare(argv[1], 1, L"a-temp.txt", L"a-old.txt", A_ERROR)) return 1;
  if (!compare(argv[1], 2, L"b-temp.txt", L"b-old.txt", B_ERROR)) return 1;
  record[STATUS] = 1;
  return publish(argv[2]) ? 0 : 103;
}
