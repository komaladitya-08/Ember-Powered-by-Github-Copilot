/* Separate fixed creator-owner witness. The original eight copy operations, protections and writer/revoked paths remain.
 * Fresh file/directory ACL-right opens observe access only; no owner/ACL/privilege/token mutation is performed here.
 * Ordinary acl-host controls require all four independent rights; LPAC useful requires all four denials with error5.
 * Deletion deliberately matches Node22.23.5/libuv's POSIX disposition path, not general DeleteFile compatibility:
 * https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/uv/src/win/fs.c#L1161
 * https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex
 * The host must attest the executable/token/root-only job and prove full Stop before reading report/work bytes.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <wchar.h>
#include <stdio.h>
#include <string.h>

#define CHARS 32768
#define REPORT_MAGIC 0x4f434357u
#define HEARTBEAT_MAGIC 0x42484357u
enum { USEFUL = 1, WRITER = 2, REVOKED = 3, ACL_HOST = 4 };
enum { COMPLETE = 1, FAILED = 2 };
enum { MAGIC, VERSION, MODE, STATUS, OPERATION, FEATURES, SOURCE_READ, SOURCE_WRITE, CANARY_READ, CANARY_WRITE,
       WORK_READ, WORK_WRITE, WORK_CREATE, OPERATION_ERROR, INITIAL_COUNTER, RESERVED,
       ACL_CREATED, ACL_ATTEMPTED, ACL_GRANTED, ACL_CLOSED, ACL_FILE_DAC_ERROR, ACL_FILE_OWNER_ERROR,
       ACL_DIRECTORY_DAC_ERROR, ACL_DIRECTORY_OWNER_ERROR, ACL_VALIDATED, ACL_REMOVED };
enum { BOOT, PROBE_SOURCE_READ, PROBE_SOURCE_WRITE, PROBE_CANARY_READ, PROBE_CANARY_WRITE,
       READ_SEED, EDIT_SEED, CREATE_FILE, RENAME_FILE, REPLACE_FILE, REMOVE_FILE, REMOVE_CHILD, REMOVE_DIRECTORY,
       HEARTBEAT, REPORT, READY, PROBE_WORK_READ, PROBE_WORK_WRITE, PROBE_WORK_CREATE, DONE };
enum { ACL_CREATE_FILE = 20, ACL_CREATE_DIRECTORY, ACL_FILE_DAC, ACL_FILE_OWNER, ACL_DIRECTORY_DAC, ACL_DIRECTORY_OWNER };
static DWORD record[32], heartbeat[16], errorCode;
static HANDLE heartbeatFile = INVALID_HANDLE_VALUE;
static WCHAR first[CHARS], second[CHARS], readyStaging[CHARS];
static const char seed[] = "EMBER_COMMAND_SEED\n";
static const char edited[] = "EMBER_COMMAND_EDITED\n";
static const char created[] = "EMBER_COMMAND_CREATED\n";
static const char replaced[] = "EMBER_COMMAND_REPLACED\n";
typedef char exact_report[(sizeof(record) == 128) ? 1 : -1];

/* A failed close may have consumed its handle. Never retry, publish, or resume work with unknown ownership. */
static void uncertain(void) { for (;;) Sleep(1000); }

static int pathInput(const WCHAR *text) {
  size_t i, length = wcsnlen_s(text, CHARS), start = 3;
  if (length < 4 || length >= CHARS || text[1] != L':' || text[2] != L'\\'
      || !((text[0] >= L'A' && text[0] <= L'Z') || (text[0] >= L'a' && text[0] <= L'z'))) return 0;
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
  if (_snwprintf_s(output, CHARS, _TRUNCATE, L"%ls\\%ls", root, name) < 0) { errorCode = ERROR_FILENAME_EXCED_RANGE; return 0; }
  return 1;
}
static int closeKnown(HANDLE *owned) {
  HANDLE selected = *owned;
  *owned = INVALID_HANDLE_VALUE;
  if (selected == INVALID_HANDLE_VALUE) return 1;
  if (selected == NULL) uncertain();
  if (!CloseHandle(selected)) uncertain();
  return 1;
}
static HANDLE open(const WCHAR *file, DWORD access, DWORD disposition, DWORD attributes) {
  HANDLE value = CreateFileW(file, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, disposition, attributes, NULL);
  if (value == INVALID_HANDLE_VALUE) errorCode = GetLastError();
  else if (value == NULL) uncertain();
  return value;
}
static int denied(const WCHAR *file, DWORD access, DWORD disposition, DWORD slot, DWORD bit) {
  HANDLE owned = open(file, access, disposition, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT);
  if (owned == INVALID_HANDLE_VALUE) {
    record[slot] = errorCode;
    if (errorCode == ERROR_ACCESS_DENIED) { record[FEATURES] |= bit; errorCode = 0; return 1; }
    return 0;
  }
  /* Unexpected permission never authorizes reading/writing protected bytes. Only the owned create probe can create. */
  record[slot] = 0; errorCode = ERROR_INVALID_DATA;
  if (!closeKnown(&owned)) return 0;
  return 0;
}
static int protectedProbes(const WCHAR *source, const WCHAR *canary) {
  record[OPERATION] = PROBE_SOURCE_READ; if (!denied(source, GENERIC_READ, OPEN_EXISTING, SOURCE_READ, 0x100)) return 0;
  record[OPERATION] = PROBE_SOURCE_WRITE; if (!denied(source, GENERIC_WRITE, OPEN_EXISTING, SOURCE_WRITE, 0x200)) return 0;
  record[OPERATION] = PROBE_CANARY_READ; if (!denied(canary, GENERIC_READ, OPEN_EXISTING, CANARY_READ, 0x400)) return 0;
  record[OPERATION] = PROBE_CANARY_WRITE; return denied(canary, GENERIC_WRITE, OPEN_EXISTING, CANARY_WRITE, 0x800);
}
static int readSeed(const WCHAR *file) {
  HANDLE owned = open(file, GENERIC_READ, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT);
  char bytes[128]; DWORD count = 0; int ok = 0;
  if (owned == INVALID_HANDLE_VALUE) return 0;
  if (!ReadFile(owned, bytes, (DWORD)sizeof(seed), &count, NULL)) errorCode = GetLastError();
  else if (count != (DWORD)(sizeof(seed) - 1) || memcmp(bytes, seed, sizeof(seed) - 1) != 0) errorCode = ERROR_INVALID_DATA;
  else ok = 1;
  SecureZeroMemory(bytes, sizeof(bytes));
  if (!closeKnown(&owned)) ok = 0;
  return ok;
}
static int overwrite(HANDLE owned, const void *bytes, DWORD length) {
  LARGE_INTEGER zero; DWORD written = 0;
  zero.QuadPart = 0;
  if (!SetFilePointerEx(owned, zero, NULL, FILE_BEGIN)) { errorCode = GetLastError(); return 0; }
  if (!WriteFile(owned, bytes, length, &written, NULL)) { errorCode = GetLastError(); return 0; }
  if (written != length) { errorCode = ERROR_INVALID_DATA; return 0; }
  if (!SetEndOfFile(owned)) { errorCode = GetLastError(); return 0; }
  if (!FlushFileBuffers(owned)) { errorCode = GetLastError(); return 0; }
  return 1;
}
static int writeFixed(const WCHAR *file, const char *bytes, DWORD length, DWORD disposition) {
  HANDLE owned = open(file, GENERIC_WRITE, disposition, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT);
  int ok;
  if (owned == INVALID_HANDLE_VALUE) return 0;
  ok = overwrite(owned, bytes, length);
  if (!closeKnown(&owned)) ok = 0;
  return ok;
}
static int removePosix(const WCHAR *file, int directory) {
  HANDLE owned = open(file, DELETE | FILE_READ_ATTRIBUTES, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL));
  FILE_DISPOSITION_INFO_EX disposition;
  int ok = 1;
  if (owned == INVALID_HANDLE_VALUE) return 0;
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  if (!SetFileInformationByHandle(owned, FileDispositionInfoEx, &disposition, (DWORD)sizeof(disposition))) { errorCode = GetLastError(); ok = 0; }
  if (!closeKnown(&owned)) ok = 0;
  return ok;
}
static int useful(const WCHAR *root) {
  record[OPERATION] = READ_SEED; if (!join(root, L"seed.txt", first) || !readSeed(first)) return 0; record[FEATURES] |= 1;
  record[OPERATION] = EDIT_SEED; if (!writeFixed(first, edited, (DWORD)(sizeof(edited) - 1), OPEN_EXISTING)) return 0; record[FEATURES] |= 2;
  record[OPERATION] = CREATE_FILE; if (!join(root, L"created.txt", first) || !writeFixed(first, created, (DWORD)(sizeof(created) - 1), CREATE_NEW)) return 0; record[FEATURES] |= 4;
  record[OPERATION] = RENAME_FILE; if (!join(root, L"move.txt", first) || !join(root, L"renamed.txt", second)) return 0;
  if (!MoveFileExW(first, second, 0)) { errorCode = GetLastError(); return 0; } record[FEATURES] |= 8;
  record[OPERATION] = REPLACE_FILE; if (!join(root, L"replacement.tmp", first) || !join(root, L"replace.txt", second) || !writeFixed(first, replaced, (DWORD)(sizeof(replaced) - 1), CREATE_NEW)) return 0;
  if (!MoveFileExW(first, second, MOVEFILE_REPLACE_EXISTING)) { errorCode = GetLastError(); return 0; } record[FEATURES] |= 16;
  record[OPERATION] = REMOVE_FILE; if (!join(root, L"remove.txt", first) || !removePosix(first, 0)) return 0; record[FEATURES] |= 32;
  record[OPERATION] = REMOVE_CHILD; if (!join(root, L"staged-folder\\child.txt", first) || !removePosix(first, 0)) return 0; record[FEATURES] |= 64;
  record[OPERATION] = REMOVE_DIRECTORY; if (!join(root, L"staged-folder", first) || !removePosix(first, 1)) return 0; record[FEATURES] |= 128;
  return 1;
}
static int revoked(const WCHAR *root) {
  if (!join(root, L"seed.txt", first)) return 0;
  record[OPERATION] = PROBE_WORK_READ; if (!denied(first, GENERIC_READ, OPEN_EXISTING, WORK_READ, 1)) return 0;
  record[OPERATION] = PROBE_WORK_WRITE; if (!denied(first, GENERIC_WRITE, OPEN_EXISTING, WORK_WRITE, 2)) return 0;
  record[OPERATION] = PROBE_WORK_CREATE; return join(root, L"revoked-created.txt", first) && denied(first, GENERIC_WRITE, CREATE_NEW, WORK_CREATE, 4);
}
static DWORD creatorRights(const WCHAR *root, int host) {
  DWORD index;
  record[OPERATION] = ACL_CREATE_FILE;
  if (!join(root, L"creator-acl-file.txt", first) || !writeFixed(first, created, (DWORD)(sizeof(created) - 1), CREATE_NEW)) return 206;
  record[ACL_CREATED] |= 1;
  record[OPERATION] = ACL_CREATE_DIRECTORY;
  if (!join(root, L"creator-acl-directory", second)) return 206;
  if (!CreateDirectoryW(second, NULL)) { errorCode = GetLastError(); return 206; }
  record[ACL_CREATED] |= 2;
  for (index = 0; index < 4; index++) {
    DWORD bit = 1u << index;
    DWORD access = (index & 1u) ? WRITE_OWNER : WRITE_DAC;
    DWORD attributes = FILE_FLAG_OPEN_REPARSE_POINT | (index >= 2 ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL);
    HANDLE owned;
    record[OPERATION] = ACL_FILE_DAC + index;
    record[ACL_ATTEMPTED] |= bit;
    owned = open(index >= 2 ? second : first, access, OPEN_EXISTING, attributes);
    if (owned == INVALID_HANDLE_VALUE) record[ACL_FILE_DAC_ERROR + index] = errorCode;
    else {
      record[ACL_GRANTED] |= bit;
      /* No ACL or owner is ever changed, even when the exact requested access was unexpectedly granted. */
      closeKnown(&owned);
    }
    /* Closed means no remaining owned handle: a denied open has none; a granted open earned its one positive close. */
    record[ACL_CLOSED] |= bit;
    if (record[ACL_GRANTED] & bit) {
      if (!host) { errorCode = ERROR_INVALID_DATA; return 201 + index; }
    } else if (host || record[ACL_FILE_DAC_ERROR + index] != ERROR_ACCESS_DENIED) return 205;
    record[ACL_VALIDATED] |= bit; errorCode = 0;
  }
  record[OPERATION] = 26;
  if (!removePosix(first, 0)) return 207;
  record[ACL_REMOVED] |= 1;
  record[OPERATION] = 27;
  if (!removePosix(second, 1)) return 207;
  record[ACL_REMOVED] |= 2;
  return 0;
}
static int publish(const WCHAR *file) {
  HANDLE owned = open(file, GENERIC_WRITE, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT);
  int ok;
  if (owned == INVALID_HANDLE_VALUE) return 0;
  ok = overwrite(owned, record, (DWORD)sizeof(record));
  if (!closeKnown(&owned)) ok = 0;
  return ok;
}
static int ready(const WCHAR *file) {
  HANDLE owned = open(readyStaging, GENERIC_WRITE, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT);
  if (owned == INVALID_HANDLE_VALUE) return 0;
  if (!closeKnown(&owned)) return 0;
  if (!MoveFileExW(readyStaging, file, 0)) { errorCode = GetLastError(); return 0; }
  return 1;
}
static int failed(const WCHAR *report) {
  closeKnown(&heartbeatFile); record[STATUS] = FAILED; record[OPERATION_ERROR] = errorCode;
  publish(report); return 1;
}
static int aclFailed(const WCHAR *report, DWORD exitCode) {
  record[STATUS] = FAILED; record[OPERATION_ERROR] = errorCode;
  if (!publish(report)) return 103;
  return (int)exitCode;
}
int wmain(int argc, WCHAR **argv) {
  DWORD mode = 0, aclExit;
  if (argc != 7) return 101;
  if (wcscmp(argv[1], L"useful") == 0) mode = USEFUL;
  else if (wcscmp(argv[1], L"writer") == 0) mode = WRITER;
  else if (wcscmp(argv[1], L"revoked") == 0) mode = REVOKED;
  else if (wcscmp(argv[1], L"acl-host") == 0) mode = ACL_HOST;
  if (!mode || !pathInput(argv[2]) || !pathInput(argv[3]) || !pathInput(argv[4]) || !pathInput(argv[5]) || !pathInput(argv[6]) ||
      _snwprintf_s(readyStaging, CHARS, _TRUNCATE, L"%ls-staging", argv[6]) < 0) return 102;
  record[MAGIC] = REPORT_MAGIC; record[VERSION] = 2; record[MODE] = mode;
  if (mode != ACL_HOST && !protectedProbes(argv[3], argv[4])) return failed(argv[5]);
  if (mode == USEFUL || mode == ACL_HOST) {
    aclExit = creatorRights(argv[2], mode == ACL_HOST);
    if (aclExit) return aclFailed(argv[5], aclExit);
  }
  if (mode == USEFUL) { if (!useful(argv[2])) return failed(argv[5]); record[OPERATION] = DONE; }
  else if (mode == ACL_HOST) record[OPERATION] = DONE;
  else if (mode == REVOKED) { if (!revoked(argv[2])) return failed(argv[5]); record[OPERATION] = DONE; }
  else {
    record[OPERATION] = HEARTBEAT;
    if (!join(argv[2], L"heartbeat.bin", first)) return failed(argv[5]);
    heartbeatFile = open(first, GENERIC_WRITE, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT);
    if (heartbeatFile == INVALID_HANDLE_VALUE) return failed(argv[5]);
    heartbeat[0] = HEARTBEAT_MAGIC; heartbeat[1] = 1; heartbeat[2] = 1;
    if (!overwrite(heartbeatFile, heartbeat, (DWORD)sizeof(heartbeat))) return failed(argv[5]);
    record[FEATURES] |= 1; record[INITIAL_COUNTER] = 1;
  }
  record[STATUS] = COMPLETE;
  /* One static, closed report precedes readiness. Neither report nor marker is modified during the writer loop. */
  if (!publish(argv[5])) { closeKnown(&heartbeatFile); return 103; }
  if (mode != WRITER) return 0;
  if (!ready(argv[6])) { closeKnown(&heartbeatFile); return 104; }
  for (;;) {
    if (heartbeat[2] == MAXDWORD) { closeKnown(&heartbeatFile); return 105; }
    heartbeat[2]++;
    if (!overwrite(heartbeatFile, heartbeat, (DWORD)sizeof(heartbeat))) { closeKnown(&heartbeatFile); return 106; }
    Sleep(5);
  }
}
