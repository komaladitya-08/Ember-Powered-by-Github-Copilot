/* Fixed one-shot namespace prerequisite only. No libuv/Node execution or supplied command is accepted.
 * Reproduces Node 22.23.5 pipe.c:249-429 duplex server/client access and client-before-connect ordering.
 * Deliberate safety divergence: global OVERLAPPED + private event, rather than libuv's NULL OVERLAPPED.
 * No name-collision retry, ACL change, capability, network socket, token change or child launch occurs.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define WORDS 40
#define MAGIC 0x504e5045u
#define CHARS 32768
#define ALL_CONTROLS 31u
enum { RUNNING, COMPLETE, FAILED, UNCERTAIN };
enum { PAIR_NONE, PAIR_CONNECTED, PAIR_REFUSED, PAIR_CONTRACT, PAIR_UNCERTAIN };
enum { H_MAGIC, H_VERSION, H_ROLE, H_STATUS, H_STAGE, H_CONTROLS, H_CANARY_ERROR,
       H_SELF_ERROR, H_READ_ERROR, H_DUP_ERROR, H_PARENT_ERROR, H_CHECKPOINT };
enum { P_STAGE, P_ERROR, P_RESULT, P_CREATED, P_CLOSED, P_SERVER_INHERIT,
       P_CLIENT_INHERIT, P_PENDING, P_CANCEL, P_CANCEL_ERROR, P_COMPLETION_ERROR, P_CLOSE_ERROR };
static DWORD record[WORDS];
static HANDLE reportFile = INVALID_HANDLE_VALUE;
static HANDLE pairEvent[2], server[2], client[2];
static OVERLAPPED overlaps[2];
static WCHAR state[CHARS], canary[CHARS], reportPath[CHARS], nonceWide[33], pidWide[16];
static char nonce[33], names[2][192], canaryData[32];
static const char canaryText[] = "EMBER_PIPE_NAMESPACE_CANARY\n";
static DWORD parentPid;

typedef char fixed_report_size[(sizeof(record) == 160) ? 1 : -1];
static DWORD *pair(unsigned int index) { return record + 16 + index * 12; }

static int checkpoint(void) {
  LARGE_INTEGER zero;
  DWORD written = 0;
  zero.QuadPart = 0;
  record[H_CHECKPOINT]++;
  return SetFilePointerEx(reportFile, zero, NULL, FILE_BEGIN)
      && WriteFile(reportFile, record, sizeof(record), &written, NULL)
      && written == sizeof(record) && FlushFileBuffers(reportFile);
}

/* Keep every possibly pending operation and handle in stable storage until the parent kills the private job. */
static void retain(void) {
  record[H_STATUS] = UNCERTAIN;
  checkpoint();
  for (;;) Sleep(1000);
}

static int environmentPath(const WCHAR *key, WCHAR *output) {
  DWORD length = GetEnvironmentVariableW(key, output, CHARS);
  DWORD i;
  if (length < 3 || length >= CHARS || output[1] != L':' || output[2] != L'\\'
      || !((output[0] >= L'A' && output[0] <= L'Z') || (output[0] >= L'a' && output[0] <= L'z'))) return 0;
  for (i = 0; i < length; i++) if (output[i] < 32 || output[i] == L'"' || output[i] == L'/') return 0;
  return 1;
}

static int inputs(void) {
  DWORD i, count = GetEnvironmentVariableW(L"EMBER_PIPE_NAMESPACE_NONCE", nonceWide, 33);
  if (count != 32 || !environmentPath(L"EMBER_LPAC_STATE", state)
      || !environmentPath(L"EMBER_PIPE_NAMESPACE_CANARY", canary)) return 0;
  for (i = 0; i < 32; i++) {
    if (!((nonceWide[i] >= L'0' && nonceWide[i] <= L'9') || (nonceWide[i] >= L'a' && nonceWide[i] <= L'f'))) return 0;
    nonce[i] = (char)nonceWide[i];
  }
  nonce[32] = 0;
  count = GetEnvironmentVariableW(L"EMBER_PIPE_NAMESPACE_PARENT", pidWide, 16);
  if (count == 0 || count > 10 || pidWide[0] == L'0') return 0;
  for (i = 0; i < count; i++) {
    DWORD digit;
    if (pidWide[i] < L'0' || pidWide[i] > L'9') return 0;
    digit = (DWORD)(pidWide[i] - L'0');
    if (parentPid > (MAXDWORD - digit) / 10) return 0;
    parentPid = parentPid * 10 + digit;
  }
  if (parentPid == 0 || parentPid == GetCurrentProcessId()) return 0;
  return snprintf(names[0], sizeof(names[0]), "\\\\?\\pipe\\uv\\Ember.FixedPipe.%s", nonce) > 0
      && snprintf(names[1], sizeof(names[1]), "\\\\?\\pipe\\LOCAL\\uv\\Ember.FixedPipe.%s", nonce) > 0;
}

static void checkedClose(HANDLE handle) { if (!CloseHandle(handle)) retain(); }

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
        && got == sizeof(canaryText) - 1 && memcmp(canaryData, canaryText, got) == 0 && record[H_ROLE] == 0)
      record[H_CONTROLS] |= 1;
    else error = ERROR_INVALID_DATA;
    checkedClose(opened);
  }
  record[H_CANARY_ERROR] = error;
  opened = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  if (opened == NULL) record[H_SELF_ERROR] = GetLastError();
  else { record[H_CONTROLS] |= 2; checkedClose(opened); }
  for (index = 0; index < 3; index++) {
    opened = OpenProcess(rights[index], FALSE, parentPid);
    error = opened == NULL ? GetLastError() : 0;
    record[H_READ_ERROR + index] = error;
    if (opened == NULL) {
      if (record[H_ROLE] == 1 && error == ERROR_ACCESS_DENIED) record[H_CONTROLS] |= 4u << index;
    } else {
      if (record[H_ROLE] == 0) record[H_CONTROLS] |= 4u << index;
      checkedClose(opened);
    }
  }
}

/* A close is attempted once only. Any ambiguity retains all other owners and terminates this run via parent Stop. */
static void closePair(unsigned int index) {
  DWORD *p = pair(index), bit;
  HANDLE handle;
  unsigned int slot;
  for (slot = 0; slot < 3; slot++) {
    bit = slot == 0 ? 4 : slot == 1 ? 2 : 1;
    handle = slot == 0 ? client[index] : slot == 1 ? server[index] : pairEvent[index];
    if (!(p[P_CREATED] & bit)) continue;
    if (!CloseHandle(handle)) {
      p[P_CLOSE_ERROR] = GetLastError(); p[P_RESULT] = PAIR_UNCERTAIN; retain();
    }
    p[P_CLOSED] |= bit;
  }
}

static void compare(unsigned int index) {
  DWORD *p = pair(index), error, flags, wait, transferred;
  SECURITY_ATTRIBUTES attributes;
  p[P_STAGE] = 1;
  pairEvent[index] = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (pairEvent[index] == NULL) { p[P_ERROR] = GetLastError(); p[P_RESULT] = PAIR_REFUSED; goto closed; }
  p[P_CREATED] |= 1;
  if (!GetHandleInformation(pairEvent[index], &flags)) { p[P_ERROR] = GetLastError(); p[P_RESULT] = PAIR_REFUSED; goto closed; }
  if (flags != 0) { p[P_ERROR] = ERROR_INVALID_DATA; p[P_RESULT] = PAIR_CONTRACT; goto closed; }
  overlaps[index].hEvent = pairEvent[index];
  p[P_STAGE] = 2;
  server[index] = CreateNamedPipeA(names[index], PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | WRITE_DAC | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, NULL);
  if (server[index] == INVALID_HANDLE_VALUE) { p[P_ERROR] = GetLastError(); p[P_RESULT] = PAIR_REFUSED; goto closed; }
  p[P_CREATED] |= 2;
  p[P_STAGE] = 3;
  attributes.nLength = sizeof(attributes); attributes.lpSecurityDescriptor = NULL; attributes.bInheritHandle = TRUE;
  client[index] = CreateFileA(names[index], GENERIC_READ | GENERIC_WRITE | WRITE_DAC, 0, &attributes, OPEN_EXISTING, 0, NULL);
  if (client[index] == INVALID_HANDLE_VALUE) { p[P_ERROR] = GetLastError(); p[P_RESULT] = PAIR_REFUSED; goto closed; }
  p[P_CREATED] |= 4;
  p[P_STAGE] = 4;
  if (!ConnectNamedPipe(server[index], &overlaps[index])) {
    error = GetLastError();
    if (error == ERROR_IO_PENDING) {
      p[P_PENDING] = 1; p[P_STAGE] = 5;
      wait = WaitForSingleObject(pairEvent[index], 1000);
      if (wait != WAIT_OBJECT_0) {
        p[P_ERROR] = wait == WAIT_FAILED ? GetLastError() : wait;
        p[P_CANCEL] = 1; p[P_STAGE] = 6;
        if (!CancelIoEx(server[index], &overlaps[index])) {
          p[P_CANCEL_ERROR] = GetLastError();
          if (p[P_CANCEL_ERROR] != ERROR_NOT_FOUND) { p[P_RESULT] = PAIR_UNCERTAIN; retain(); }
        }
        if (WaitForSingleObject(pairEvent[index], 1000) != WAIT_OBJECT_0) { p[P_RESULT] = PAIR_UNCERTAIN; retain(); }
      }
      if (!GetOverlappedResult(server[index], &overlaps[index], &transferred, FALSE)) {
        p[P_COMPLETION_ERROR] = GetLastError();
        if (p[P_COMPLETION_ERROR] != ERROR_OPERATION_ABORTED) { p[P_RESULT] = PAIR_UNCERTAIN; retain(); }
        if (p[P_ERROR] == 0) p[P_ERROR] = p[P_COMPLETION_ERROR];
        p[P_RESULT] = PAIR_REFUSED; goto closed;
      }
      if (p[P_ERROR] != 0) { p[P_RESULT] = PAIR_REFUSED; goto closed; }
    } else if (error != ERROR_PIPE_CONNECTED) { p[P_ERROR] = error; p[P_RESULT] = PAIR_REFUSED; goto closed; }
  }
  p[P_STAGE] = 7;
  if (!GetHandleInformation(server[index], &flags)) { p[P_ERROR] = GetLastError(); p[P_RESULT] = PAIR_REFUSED; goto closed; }
  if (flags != 0) { p[P_ERROR] = ERROR_INVALID_DATA; p[P_RESULT] = PAIR_CONTRACT; goto closed; }
  p[P_SERVER_INHERIT] = flags;
  if (!GetHandleInformation(client[index], &flags)) { p[P_ERROR] = GetLastError(); p[P_RESULT] = PAIR_REFUSED; goto closed; }
  if (flags != HANDLE_FLAG_INHERIT) { p[P_ERROR] = ERROR_INVALID_DATA; p[P_RESULT] = PAIR_CONTRACT; goto closed; }
  p[P_CLIENT_INHERIT] = flags;
  p[P_RESULT] = PAIR_CONNECTED;
closed:
  closePair(index);
}

int main(int argc, char **argv) {
  HANDLE token;
  DWORD role = 0, bytes = 0;
  (void)argv;
  if (argc != 1 || !inputs()) return 101;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 102;
  if (!GetTokenInformation(token, (TOKEN_INFORMATION_CLASS)29, &role, sizeof(role), &bytes) || bytes != sizeof(role) || role > 1) { checkedClose(token); return 103; }
  checkedClose(token);
  record[H_MAGIC] = MAGIC; record[H_VERSION] = 1; record[H_ROLE] = role; record[H_STAGE] = 1;
  if (_snwprintf_s(reportPath, CHARS, _TRUNCATE, L"%ls\\%ls-pipe-namespace.bin", state, role ? L"lpac" : L"host") < 0) return 105;
  reportFile = CreateFileW(reportPath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (reportFile == INVALID_HANDLE_VALUE) return 106;
  if (!checkpoint()) return 107;
  record[H_STAGE] = 2; controls(); if (!checkpoint()) retain();
  record[H_STAGE] = 3; compare(0); if (!checkpoint()) retain();
  record[H_STAGE] = 4; compare(1);
  record[H_STAGE] = 5;
  record[H_STATUS] = record[H_CONTROLS] == ALL_CONTROLS && pair(0)[P_RESULT] != PAIR_CONTRACT && pair(1)[P_RESULT] != PAIR_CONTRACT ? COMPLETE : FAILED;
  if (!checkpoint()) retain();
  if (!CloseHandle(reportFile)) for (;;) Sleep(1000);
  return record[H_STATUS] == COMPLETE ? 0 : 1;
}
