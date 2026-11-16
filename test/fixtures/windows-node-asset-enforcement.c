/* Fixed test-only LPAC access witness. Never selected by the production Node factory. */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#include <windows.h>
#include <wchar.h>
#include <string.h>

static const char output[] = "EMBER_ASSET_ACCESS_V1:255:511:1\n";
static const char errorOutput[] = "EMBER_ASSET_ACCESS_STDERR\n";
static const char controlBytes[] = "EMBER_ASSET_CONTROL_CREATED\n";
static int lastProbeOutcome = 4;

static void uncertain(void) { for (;;) Sleep(1000); }
static void closeKnown(HANDLE owned) { if (!CloseHandle(owned)) uncertain(); }
static int ordinary(const WCHAR *value) {
  size_t count = wcslen(value), index;
  if (count < 4 || count > 4096 || value[1] != L':' || value[2] != L'\\' ||
      !((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z'))) return 0;
  for (index = 0; index < count; index++) if (value[index] < 32 || value[index] == L'/' || value[index] == L'"') return 0;
  return 1;
}
static int writeAll(HANDLE owned, const void *bytes, DWORD length) {
  const char *cursor = (const char *)bytes;
  while (length) {
    DWORD count = 0;
    if (!WriteFile(owned, cursor, length, &count, NULL) || count == 0 || count > length) return 0;
    cursor += count; length -= count;
  }
  return 1;
}
static int errorOutcome(DWORD error) {
  return error == ERROR_ACCESS_DENIED ? 2 : error == ERROR_SHARING_VIOLATION ? 3 : 4;
}
static int allowed(const WCHAR *file, DWORD access, int directory);
static int failedProbe(HANDLE err, int object, int right, WCHAR **targets) {
  char frame[] = "EMBER_ASSET_PROBE_V1:0:0:0\n";
  char matrix[] = "EMBER_ASSET_MATRIX_V1:000000000000000000\n";
  const size_t prefix = sizeof("EMBER_ASSET_PROBE_V1:") - 1;
  const size_t matrixPrefix = sizeof("EMBER_ASSET_MATRIX_V1:") - 1;
  const DWORD rights[] = { READ_CONTROL, WRITE_DAC, WRITE_OWNER };
  const int originalOutcome = lastProbeOutcome;
  int objectIndex, rightIndex;
  if (object < 1 || object > 3 || right < 1 || right > 3 || originalOutcome < 1 || originalOutcome > 5) return 205;
  /* Failure-only measurements use existing opens without changing ACLs, file contents or the first failure. */
  for (objectIndex = 1; objectIndex <= 6; objectIndex++) {
    for (rightIndex = 0; rightIndex < 3; rightIndex++) {
      (void)allowed(targets[objectIndex], rights[rightIndex], objectIndex != 3 && objectIndex != 6);
      if (lastProbeOutcome < 1 || lastProbeOutcome > 5) return 205;
      matrix[matrixPrefix + (objectIndex - 1) * 3 + rightIndex] = (char)('0' + lastProbeOutcome);
    }
  }
  /* Both frames wait for every acquired query handle to close positively. Unknown close emits nothing. */
  frame[prefix] = (char)('0' + object); frame[prefix + 2] = (char)('0' + right); frame[prefix + 4] = (char)('0' + originalOutcome);
  if (writeAll(err, frame, (DWORD)(sizeof(frame) - 1))) (void)writeAll(err, matrix, (DWORD)(sizeof(matrix) - 1));
  return 205;
}
static int allowed(const WCHAR *file, DWORD access, int directory) {
  HANDLE owned = CreateFileW(file, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
  DWORD flags = 1; int accepted;
  if (owned == INVALID_HANDLE_VALUE || owned == NULL) { lastProbeOutcome = owned == INVALID_HANDLE_VALUE ? errorOutcome(GetLastError()) : 4; return 0; }
  /* Successful security-only opens prove their requested rights. Metadata is held/read by the host pins. */
  accepted = GetHandleInformation(owned, &flags) && flags == 0;
  closeKnown(owned); lastProbeOutcome = accepted ? 1 : 5; return accepted;
}
static int denied(const WCHAR *file, DWORD access, int directory) {
  HANDLE owned = CreateFileW(file, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
  DWORD error = owned == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  if (owned != INVALID_HANDLE_VALUE && owned != NULL) closeKnown(owned);
  lastProbeOutcome = owned != INVALID_HANDLE_VALUE && owned != NULL ? 1 : owned == INVALID_HANDLE_VALUE ? errorOutcome(error) : 4;
  return owned == INVALID_HANDLE_VALUE && error == ERROR_ACCESS_DENIED;
}
static int createProbe(const WCHAR *directory, int expected) {
  WCHAR file[4140]; HANDLE owned; DWORD error;
  size_t length = wcslen(directory);
  if (length > 4096) return 0;
  memcpy(file, directory, length * sizeof(WCHAR));
  memcpy(file + length, L"\\access-create.txt", sizeof(L"\\access-create.txt"));
  owned = CreateFileW(file, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  error = owned == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  SecureZeroMemory(file, sizeof(file));
  if (owned == INVALID_HANDLE_VALUE || owned == NULL) return !expected && owned == INVALID_HANDLE_VALUE && error == ERROR_ACCESS_DENIED;
  if (!expected) { closeKnown(owned); return 0; }
  if (!writeAll(owned, controlBytes, (DWORD)(sizeof(controlBytes) - 1)) || !FlushFileBuffers(owned)) { closeKnown(owned); return 0; }
  closeKnown(owned); return 1;
}
int wmain(int argc, WCHAR **argv) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE), out = GetStdHandle(STD_OUTPUT_HANDLE), err = GetStdHandle(STD_ERROR_HANDLE);
  DWORD count = 1; char byte = 0; int index;
  /* parent, actual asset root, actual Node image, Low host-only directory, Low full-package directory/file. */
  if (argc != 7) return 201;
  for (index = 1; index < argc; index++) if (!ordinary(argv[index])) return 202;
  if (!input || input == INVALID_HANDLE_VALUE || !out || out == INVALID_HANDLE_VALUE || !err || err == INVALID_HANDLE_VALUE ||
      GetFileType(input) != FILE_TYPE_CHAR || GetFileType(out) != FILE_TYPE_PIPE || GetFileType(err) != FILE_TYPE_PIPE) return 203;
  if (!ReadFile(input, &byte, 1, &count, NULL) || count != 0) return 204;
  for (index = 1; index <= 3; index++) {
    int directory = index != 3;
    if (!allowed(argv[index], READ_CONTROL, directory)) return failedProbe(err, index, 1, argv);
    if (!denied(argv[index], WRITE_DAC, directory)) return failedProbe(err, index, 2, argv);
    if (!denied(argv[index], WRITE_OWNER, directory)) return failedProbe(err, index, 3, argv);
  }
  /* Same owner and host-only DACL as the Medium parent; only this known control is Low. */
  if (!allowed(argv[4], WRITE_DAC, 1)) return 206;
  if (!allowed(argv[5], WRITE_DAC, 1) || !allowed(argv[5], WRITE_OWNER, 1) ||
      !allowed(argv[6], WRITE_DAC, 0) || !allowed(argv[6], WRITE_OWNER, 0)) return 207;
  if (!createProbe(argv[1], 0) || !createProbe(argv[2], 0) || !createProbe(argv[5], 1)) return 208;
  if (!writeAll(out, output, (DWORD)(sizeof(output) - 1)) || !writeAll(err, errorOutput, (DWORD)(sizeof(errorOutput) - 1))) return 209;
  return 19;
}
