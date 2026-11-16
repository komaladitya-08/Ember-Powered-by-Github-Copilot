/* The real APIs are unaliased in this TU. After each real return only trivial TLS scalar stores execute.
 * A compiler listing still has to establish that the selected compiler introduced no intervening helper calls.
 */
#include "windows-uv-spawn-observe.h"

#if defined(EMBER_UV_SPAWN_OBSERVE_PIPE) || defined(EMBER_UV_SPAWN_OBSERVE_PROCESS)
#error The observation implementation must never compile with API aliases.
#endif
#ifdef _MSC_VER
#define EMBER_THREAD_LOCAL __declspec(thread)
#else
#define EMBER_THREAD_LOCAL __thread
#endif

static EMBER_THREAD_LOCAL volatile ember_uv_spawn_observation ledger;
static EMBER_THREAD_LOCAL volatile uint32_t armed, in_call;

/* These are macros deliberately: no post-return helper, CRT, native or error-query call is introduced. */
#define ENTER_OBSERVATION() \
  uint32_t observing = armed; \
  if (observing) { \
    if (in_call) ledger.unknown = 1; \
    if (in_call < EMBER_UV_SPAWN_OBSERVE_LIMIT) in_call++; \
    else { ledger.unknown = 1; observing = 0; } \
  }
#define LEAVE_OBSERVATION(operation, successful) \
  if (observing) { \
    if (in_call != 1) ledger.unknown = 1; \
    if (ledger.total_calls < EMBER_UV_SPAWN_OBSERVE_LIMIT) { \
      ledger.total_calls++; \
      ledger.api[(operation) - 1].calls++; \
      if (successful) ledger.api[(operation) - 1].successes++; \
      ledger.api[(operation) - 1].last_result = (successful) ? 1u : 0u; \
      ledger.api[(operation) - 1].last_sequence = ledger.total_calls; \
      ledger.last_operation = (operation); \
      ledger.last_result = (successful) ? 1u : 0u; \
    } else ledger.unknown = 1; \
    if (in_call) in_call--; \
  }

void ember_uv_spawn_observe_begin(void) {
  uint32_t i;
  if (armed || in_call) { ledger.unknown = 1; return; }
  ledger.unknown = ledger.total_calls = ledger.last_operation = ledger.last_result = 0;
  ledger.translation_count = ledger.translation_input = ledger.translation_result = ledger.translation_sequence = 0;
  for (i = 0; i < EMBER_UV_SPAWN_API_COUNT; i++) {
    ledger.api[i].calls = ledger.api[i].successes = ledger.api[i].last_result = ledger.api[i].last_sequence = 0;
  }
  armed = 1;
}

void ember_uv_spawn_observe_end(int final_result, ember_uv_spawn_observation* output) {
  uint32_t i;
  if (!armed || in_call) ledger.unknown = 1;
  armed = 0;
  if ((ledger.translation_count && ledger.translation_result != final_result) ||
      (final_result == 0 && ledger.translation_count)) ledger.unknown = 1;
  output->unknown = ledger.unknown;
  output->total_calls = ledger.total_calls;
  output->last_operation = ledger.last_operation;
  output->last_result = ledger.last_result;
  output->translation_count = ledger.translation_count;
  output->translation_input = ledger.translation_input;
  output->translation_result = ledger.translation_result;
  output->translation_sequence = ledger.translation_sequence;
  for (i = 0; i < EMBER_UV_SPAWN_API_COUNT; i++) {
    output->api[i].calls = ledger.api[i].calls;
    output->api[i].successes = ledger.api[i].successes;
    output->api[i].last_result = ledger.api[i].last_result;
    output->api[i].last_sequence = ledger.api[i].last_sequence;
  }
}

HANDLE WINAPI ember_uv_spawn_CreateNamedPipeA(LPCSTR name, DWORD open_mode, DWORD pipe_mode,
    DWORD instances, DWORD out_size, DWORD in_size, DWORD timeout, LPSECURITY_ATTRIBUTES security) {
  HANDLE result;
  ENTER_OBSERVATION();
  result = CreateNamedPipeA(name, open_mode, pipe_mode, instances, out_size, in_size, timeout, security);
  LEAVE_OBSERVATION(1, result != INVALID_HANDLE_VALUE);
  return result;
}
HANDLE WINAPI ember_uv_spawn_CreateFileA(LPCSTR name, DWORD access, DWORD share,
    LPSECURITY_ATTRIBUTES security, DWORD disposition, DWORD attributes, HANDLE template_file) {
  HANDLE result;
  ENTER_OBSERVATION();
  result = CreateFileA(name, access, share, security, disposition, attributes, template_file);
  LEAVE_OBSERVATION(2, result != INVALID_HANDLE_VALUE);
  return result;
}
BOOL WINAPI ember_uv_spawn_ConnectNamedPipe(HANDLE pipe, LPOVERLAPPED overlapped) {
  BOOL result;
  ENTER_OBSERVATION();
  result = ConnectNamedPipe(pipe, overlapped);
  LEAVE_OBSERVATION(3, result != 0);
  return result;
}
HANDLE WINAPI ember_uv_spawn_CreateIoCompletionPort(HANDLE file, HANDLE port, ULONG_PTR key, DWORD threads) {
  HANDLE result;
  ENTER_OBSERVATION();
  result = CreateIoCompletionPort(file, port, key, threads);
  LEAVE_OBSERVATION(4, result != NULL);
  return result;
}
BOOL WINAPI ember_uv_spawn_CreateProcessW(LPCWSTR application, LPWSTR command, LPSECURITY_ATTRIBUTES process_security,
    LPSECURITY_ATTRIBUTES thread_security, BOOL inherit, DWORD flags, LPVOID environment, LPCWSTR cwd,
    LPSTARTUPINFOW startup, LPPROCESS_INFORMATION process) {
  BOOL result;
  ENTER_OBSERVATION();
  result = CreateProcessW(application, command, process_security, thread_security, inherit, flags, environment, cwd, startup, process);
  LEAVE_OBSERVATION(5, result != 0);
  return result;
}
int ember_uv_spawn_translate_sys_error(int input) {
  int result;
  uint32_t observing = armed;
  result = uv_translate_sys_error(input);
  if (observing) {
    if (in_call || ledger.translation_count) ledger.unknown = 1;
    else {
      ledger.translation_count = 1;
      ledger.translation_input = input;
      ledger.translation_result = result;
      ledger.translation_sequence = ledger.total_calls;
    }
  }
  return result;
}
