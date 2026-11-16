/* Linux-only actual-C control tests. These hooks test fault handling, never Windows import binding or ABI.
 * Production has no test switches: this TU includes both unchanged observer C and control C and supplies
 * only the test Windows API implementations. Numeric modes belong exclusively to this test executable.
 */
#include <stdio.h>
#include <stdlib.h>
#include "../windows-uv-spawn-observe.c"
#define main ember_control_main
#include "../windows-uv-observer-abi-control.c"
#undef main

static DWORD test_error;
static int fault;

DWORD WINAPI GetLastError(void) { return test_error; }
void WINAPI SetLastError(DWORD error) { test_error = error; }
HANDLE WINAPI GetStdHandle(DWORD which) { return which == STD_OUTPUT_HANDLE ? OPAQUE(1) : INVALID_HANDLE_VALUE; }
_Noreturn void WINAPI ExitProcess(DWORD code) { exit((int)code); }
BOOL WINAPI WriteFile(HANDLE handle, const void* buffer, DWORD bytes, DWORD* written, LPOVERLAPPED output) {
  if (handle != OPAQUE(1) || bytes != 256 || !written || output || fault == 12) return 0;
  *written = (DWORD)fwrite(buffer, 1, fault == 13 ? 128 : bytes, stdout);
  return *written == (fault == 13 ? 128u : bytes);
}

HANDLE WINAPI CreateNamedPipeA(LPCSTR name, DWORD open_mode, DWORD pipe_mode, DWORD instances,
    DWORD out_size, DWORD in_size, DWORD timeout, LPSECURITY_ATTRIBUTES security) {
  HANDLE result;
  if (fault == 7) SetLastError(0x1234u);
  if (fault == 15) return active.successful ? OUTPUT_HANDLE : INVALID_HANDLE_VALUE;
  result = __imp_CreateNamedPipeA(name, open_mode, pipe_mode, instances,
      fault == 2 ? out_size ^ 0x80000000u : out_size, in_size, timeout,
      fault == 1 ? &thread_security : security);
  if (fault == 8) SetLastError(0x4321u);
  if (fault == 10) result = __imp_CreateNamedPipeA(name, open_mode, pipe_mode, instances, out_size, in_size, timeout, security);
  if (fault == 16) ledger.unknown = 1;
  return result;
}
HANDLE WINAPI CreateFileA(LPCSTR name, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
    DWORD disposition, DWORD attributes, HANDLE template_file) {
  return __imp_CreateFileA(name, access, share, security, disposition, attributes,
      fault == 17 ? OPAQUE((uint32_t)(uintptr_t)template_file) : template_file);
}
BOOL WINAPI ConnectNamedPipe(HANDLE pipe, LPOVERLAPPED output) {
  BOOL result = __imp_ConnectNamedPipe(pipe, output);
  if (fault == 5) output->Offset ^= 1;
  if (fault == 9 && result == 7) return 1;
  return result;
}
HANDLE WINAPI CreateIoCompletionPort(HANDLE file, HANDLE port, ULONG_PTR key, DWORD threads) {
  return __imp_CreateIoCompletionPort(file, port, fault == 3 ? (DWORD)key : key, threads);
}
BOOL WINAPI CreateProcessW(LPCWSTR app, LPWSTR mutable_command, LPSECURITY_ATTRIBUTES ps,
    LPSECURITY_ATTRIBUTES ts, BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd,
    LPSTARTUPINFOW start, LPPROCESS_INFORMATION output) {
  WCHAR other_command[] = { 'c', 'm', 'd', 0 };
  BOOL result = __imp_CreateProcessW(app, fault == 4 ? other_command : mutable_command,
      ps, ts, inherit, flags, env, cwd, start, output);
  if (fault == 6) output->dwThreadId ^= 1;
  return result;
}
int main(int argc, char** argv) {
  int result;
  if (argc != 2) return 80;
  fault = atoi(argv[1]);
  if (fault < 0 || fault > 18) return 81;
  if (fault == 11) {
    /* Simulates an imported API reached by CRT initialisation before the production main. */
    test_error = 0x12345678u;
    if (__imp_CreateNamedPipeA(NULL, 0, 0, 0, 0, 0, 0, NULL) != INVALID_HANDLE_VALUE || unexpected_calls != 1) return 82;
  }
  if (fault == 18) {
    /* Every one of the 28 original ledger DWORDs participates in the comparison. */
    ember_uv_spawn_observation value;
    uint32_t words[28];
    unsigned int i;
    memset(&value, 0, sizeof(value));
    value.total_calls = value.last_operation = value.last_result = 1;
    value.api[0].calls = value.api[0].successes = value.api[0].last_result = value.api[0].last_sequence = 1;
    if (!ledger_ok(1, 1, &value)) return 83;
    memcpy(words, &value, sizeof(value));
    for (i = 0; i < sizeof(value) / sizeof(*words); i++) {
      words[i] ^= 0x80000000u;
      memcpy(&value, words, sizeof(value));
      if (ledger_ok(1, 1, &value)) return 84;
      words[i] ^= 0x80000000u;
    }
    return 0;
  }
  result = ember_control_main();
  if (fault == 14 && !result) __imp_CreateNamedPipeA(NULL, 0, 0, 0, 0, 0, 0, NULL);
  return result;
}
