/* Fixed ordinary-Windows control for the unchanged observer object. No live delegated API is called.
 * The SDK declarations and ABI assertions remain intact. The five __imp_ DATA definitions intercept
 * dllimport indirection; a real Windows link/run is still required to establish that binding.
 * Normal CRT initialisation and stack protection are required. There are no command-line modes.
 */
#include "windows-uv-spawn-observe.h"
#include <string.h>

#if defined(EMBER_UV_SPAWN_OBSERVE_PIPE) || defined(EMBER_UV_SPAWN_OBSERVE_PROCESS)
#error The ABI control must never compile with API aliases.
#endif
_Static_assert(sizeof(void*) == 8 && sizeof(DWORD) == 4, "The fixed control requires x64 DWORD layout");

typedef struct {
  DWORD id, baseline, wrapped, arguments_outputs, entry_error, exact_return, after_error, armed_ledger;
} control_row;
typedef struct {
  DWORD magic, version, status, stage, expected, completed, baseline, wrapped, checks, unexpected;
  DWORD failed_case, failed_function, reserved[4];
  control_row rows[6];
} control_report;
typedef struct { uintptr_t returned; DWORD after_error; } control_result;
_Static_assert(sizeof(control_report) == 256, "The fixed control report must have 64 DWORDs");

static control_report report;
/* Zero is pre-main, one is running, two is DONE. A late CRT call must invalidate even emitted bytes. */
static volatile DWORD phase, unexpected_calls;
static DWORD delegated[6];
static struct {
  DWORD function, open, calls, arguments_ok, entry_ok, seed, marker, sets_error, successful;
} active;
static const char pipe_name[] = "fixed-abi-pipe", file_name[] = "fixed-abi-file";
static WCHAR application[] = { 'a', 'p', 'p', 0 }, command[] = { 'c', 'm', 'd', 0 };
static WCHAR directory[] = { 'c', 'w', 'd', 0 };
static unsigned char environment[] = { 0x61, 0, 0, 0 };
static SECURITY_ATTRIBUTES process_security, thread_security;
static OVERLAPPED overlapped;
static STARTUPINFOW startup;
static PROCESS_INFORMATION information;

#define OPAQUE(value) ((HANDLE)(uintptr_t)(value))
#define INPUT_HANDLE OPAQUE(UINT64_C(0xf123456789abcde0))
#define PORT_HANDLE OPAQUE(UINT64_C(0xe23456789abcdef0))
#define OUTPUT_HANDLE OPAQUE(UINT64_C(0xd3456789abcdef01))
#define THREAD_HANDLE OPAQUE(UINT64_C(0xc456789abcdef012))
#define COMPLETION_KEY ((ULONG_PTR)UINT64_C(0xb56789abcdef0123))
#define ARG(value) do { if (!(value)) active.arguments_ok = 0; } while (0)

/* Every delegate captures its entry error before this or any argument check. */
static int admit(DWORD function, DWORD entry_error) {
  if (phase != 1 || !active.open || active.function != function) {
    unexpected_calls++;
    if (phase != 0) ExitProcess(91);
    return 0;
  }
  active.calls++;
  delegated[function - 1]++;
  if (entry_error != active.seed) active.entry_ok = 0;
  return 1;
}
static void finish_error(void) {
  if (active.sets_error) SetLastError(active.marker);
}
static HANDLE WINAPI fake_named_pipe(LPCSTR name, DWORD open_mode, DWORD pipe_mode, DWORD instances,
    DWORD out_size, DWORD in_size, DWORD timeout, LPSECURITY_ATTRIBUTES security) {
  DWORD entry_error = GetLastError();
  if (!admit(1, entry_error)) return INVALID_HANDLE_VALUE;
  ARG(name == pipe_name && open_mode == 0x81234567u && pipe_mode == 0x92345678u &&
      instances == 0xa3456789u && out_size == 0xb456789au && in_size == 0xc56789abu &&
      timeout == 0xd6789abcu && security == &process_security);
  finish_error();
  return active.successful ? OUTPUT_HANDLE : INVALID_HANDLE_VALUE;
}
static HANDLE WINAPI fake_file(LPCSTR name, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES security,
    DWORD disposition, DWORD attributes, HANDLE template_file) {
  DWORD entry_error = GetLastError();
  if (!admit(2, entry_error)) return INVALID_HANDLE_VALUE;
  ARG(name == file_name && access == 0x82345678u && share == 0x93456789u &&
      security == &process_security && disposition == 0xa456789au && attributes == 0xb56789abu &&
      template_file == INPUT_HANDLE);
  finish_error();
  return active.successful ? OUTPUT_HANDLE : INVALID_HANDLE_VALUE;
}
static BOOL WINAPI fake_connect(HANDLE pipe, LPOVERLAPPED output) {
  DWORD entry_error = GetLastError();
  if (!admit(3, entry_error)) return 0;
  ARG(pipe == INPUT_HANDLE && output == &overlapped);
  if (output == &overlapped) {
    output->Internal = (ULONG_PTR)UINT64_C(0x87654321fedcba98);
    output->InternalHigh = (ULONG_PTR)UINT64_C(0x98765432edcba987);
    output->Offset = 0xa9876543u; output->OffsetHigh = 0xba987654u; output->hEvent = OUTPUT_HANDLE;
  }
  finish_error();
  return active.successful ? 7 : 0;
}
static HANDLE WINAPI fake_completion(HANDLE file, HANDLE port, ULONG_PTR key, DWORD threads) {
  DWORD entry_error = GetLastError();
  if (!admit(4, entry_error)) return NULL;
  ARG(file == INPUT_HANDLE && port == PORT_HANDLE && key == COMPLETION_KEY && threads == 0xcba98765u);
  finish_error();
  return active.successful ? OUTPUT_HANDLE : NULL;
}
static BOOL WINAPI fake_process(LPCWSTR app, LPWSTR mutable_command, LPSECURITY_ATTRIBUTES ps,
    LPSECURITY_ATTRIBUTES ts, BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd,
    LPSTARTUPINFOW start, LPPROCESS_INFORMATION output) {
  DWORD entry_error = GetLastError();
  if (!admit(5, entry_error)) return 0;
  ARG(app == application && mutable_command == command && ps == &process_security &&
      ts == &thread_security && inherit == 7 && flags == 0xdcba9876u && env == environment &&
      cwd == directory && start == &startup && output == &information);
  if (mutable_command == command) { mutable_command[0] = 'x'; mutable_command[1] = 'y'; }
  if (output == &information) {
    output->hProcess = OUTPUT_HANDLE; output->hThread = THREAD_HANDLE;
    output->dwProcessId = 0xedcba987u; output->dwThreadId = 0xfedcba98u;
  }
  finish_error();
  return active.successful ? 7 : 0;
}
int uv_translate_sys_error(int input) {
  DWORD entry_error = GetLastError();
  if (!admit(6, entry_error)) return -4048;
  ARG(input == (int)0x76543210);
  finish_error();
  return active.successful ? 0 : -4048;
}

/* Typed const POINTER DATA, never replacement SDK function declarations or executable trampolines. */
ember_expected_named_pipe const __imp_CreateNamedPipeA = fake_named_pipe;
ember_expected_file const __imp_CreateFileA = fake_file;
ember_expected_connect const __imp_ConnectNamedPipe = fake_connect;
ember_expected_completion const __imp_CreateIoCompletionPort = fake_completion;
ember_expected_process const __imp_CreateProcessW = fake_process;

static void prepare(DWORD function, DWORD successful, DWORD sets_error, DWORD repeat) {
  memset(&active, 0, sizeof(active));
  active.function = function; active.open = 1; active.arguments_ok = active.entry_ok = 1;
  active.successful = successful; active.sets_error = sets_error;
  active.seed = 0x51230000u + function * 16u + repeat;
  active.marker = 0x73450000u + function * 16u + repeat;
  command[0] = 'c'; command[1] = 'm'; command[2] = 'd'; command[3] = 0;
  memset(&process_security, 0, sizeof(process_security)); memset(&thread_security, 0, sizeof(thread_security));
  process_security.nLength = (DWORD)sizeof(process_security); process_security.lpSecurityDescriptor = INPUT_HANDLE;
  process_security.bInheritHandle = 7;
  thread_security.nLength = (DWORD)sizeof(thread_security); thread_security.lpSecurityDescriptor = PORT_HANDLE;
  thread_security.bInheritHandle = 9;
  memset(&overlapped, 0, sizeof(overlapped)); memset(&information, 0, sizeof(information));
  memset(&startup, 0, sizeof(startup)); startup.cb = (DWORD)sizeof(startup); startup.dwFlags = 0x87654321u;
  startup.hStdInput = INPUT_HANDLE; startup.hStdOutput = PORT_HANDLE; startup.hStdError = THREAD_HANDLE;
}
static int outputs_ok(DWORD function) {
  if (process_security.nLength != sizeof(process_security) || process_security.lpSecurityDescriptor != INPUT_HANDLE ||
      process_security.bInheritHandle != 7 || thread_security.nLength != sizeof(thread_security) ||
      thread_security.lpSecurityDescriptor != PORT_HANDLE || thread_security.bInheritHandle != 9 ||
      startup.cb != sizeof(startup) || startup.dwFlags != 0x87654321u || startup.hStdInput != INPUT_HANDLE ||
      startup.hStdOutput != PORT_HANDLE || startup.hStdError != THREAD_HANDLE ||
      application[0] != 'a' || application[1] != 'p' || application[2] != 'p' || application[3] != 0 ||
      directory[0] != 'c' || directory[1] != 'w' || directory[2] != 'd' || directory[3] != 0 ||
      environment[0] != 0x61 || environment[1] || environment[2] || environment[3] || command[2] != 'd' || command[3]) return 0;
  if (function == 3) {
    if (overlapped.Internal != (ULONG_PTR)UINT64_C(0x87654321fedcba98) ||
        overlapped.InternalHigh != (ULONG_PTR)UINT64_C(0x98765432edcba987) || overlapped.Offset != 0xa9876543u ||
        overlapped.OffsetHigh != 0xba987654u || overlapped.hEvent != OUTPUT_HANDLE) return 0;
  } else if (overlapped.Internal || overlapped.InternalHigh || overlapped.Offset || overlapped.OffsetHigh || overlapped.hEvent) return 0;
  if (function == 5) return command[0] == 'x' && command[1] == 'y' && information.hProcess == OUTPUT_HANDLE &&
      information.hThread == THREAD_HANDLE && information.dwProcessId == 0xedcba987u && information.dwThreadId == 0xfedcba98u;
  return command[0] == 'c' && command[1] == 'm' && !information.hProcess && !information.hThread &&
      !information.dwProcessId && !information.dwThreadId;
}
static int ledger_ok(DWORD function, DWORD successful, const ember_uv_spawn_observation* value) {
  DWORD i;
  if (value->unknown != (DWORD)(function == 6 && successful) ||
      value->total_calls != (DWORD)(function != 6) || value->last_operation != (function == 6 ? 0 : function) ||
      value->last_result != (function == 6 ? 0 : successful) ||
      value->translation_count != (DWORD)(function == 6) ||
      value->translation_input != (function == 6 ? (int)0x76543210 : 0) ||
      value->translation_result != (function == 6 && !successful ? -4048 : 0) || value->translation_sequence != 0) return 0;
  for (i = 0; i < 5; i++) {
    DWORD selected = (DWORD)(i + 1 == function);
    if (value->api[i].calls != selected || value->api[i].successes != selected * successful ||
        value->api[i].last_result != selected * successful || value->api[i].last_sequence != selected) return 0;
  }
  return 1;
}
static int invoke(DWORD function, DWORD wrapped, DWORD armed_case, DWORD successful, DWORD sets_error,
    DWORD repeat, control_result* captured) {
  DWORD after_error = 0, before_count = delegated[function - 1];
  uintptr_t returned = 0, expected;
  ember_uv_spawn_observation observed;
  control_row* row = &report.rows[function - 1];
  prepare(function, successful, sets_error, repeat);
  if (armed_case) ember_uv_spawn_observe_begin();
  SetLastError(active.seed);
  switch (function) {
    case 1: {
      ember_expected_named_pipe volatile call = wrapped ? ember_uv_spawn_CreateNamedPipeA : fake_named_pipe;
      HANDLE result = call(pipe_name, 0x81234567u, 0x92345678u, 0xa3456789u, 0xb456789au, 0xc56789abu, 0xd6789abcu, &process_security);
      after_error = GetLastError(); returned = (uintptr_t)result; break;
    }
    case 2: {
      ember_expected_file volatile call = wrapped ? ember_uv_spawn_CreateFileA : fake_file;
      HANDLE result = call(file_name, 0x82345678u, 0x93456789u, &process_security, 0xa456789au, 0xb56789abu, INPUT_HANDLE);
      after_error = GetLastError(); returned = (uintptr_t)result; break;
    }
    case 3: {
      ember_expected_connect volatile call = wrapped ? ember_uv_spawn_ConnectNamedPipe : fake_connect;
      BOOL result = call(INPUT_HANDLE, &overlapped);
      after_error = GetLastError(); returned = (uintptr_t)(intptr_t)result; break;
    }
    case 4: {
      ember_expected_completion volatile call = wrapped ? ember_uv_spawn_CreateIoCompletionPort : fake_completion;
      HANDLE result = call(INPUT_HANDLE, PORT_HANDLE, COMPLETION_KEY, 0xcba98765u);
      after_error = GetLastError(); returned = (uintptr_t)result; break;
    }
    case 5: {
      ember_expected_process volatile call = wrapped ? ember_uv_spawn_CreateProcessW : fake_process;
      BOOL result = call(application, command, &process_security, &thread_security, 7, 0xdcba9876u, environment, directory, &startup, &information);
      after_error = GetLastError(); returned = (uintptr_t)(intptr_t)result; break;
    }
    default: {
      ember_expected_translate volatile call = wrapped ? ember_uv_spawn_translate_sys_error : uv_translate_sys_error;
      int result = call((int)0x76543210);
      after_error = GetLastError(); returned = (uintptr_t)(intptr_t)result; break;
    }
  }
  active.open = 0;
  if (armed_case) ember_uv_spawn_observe_end(function == 6 && !successful ? -4048 : 0, &observed);
  if (unexpected_calls || active.calls != 1 || delegated[function - 1] != before_count + 1) return 0;
  if (!active.arguments_ok || !outputs_ok(function)) return 0;
  row->arguments_outputs++;
  if (!active.entry_ok) return 0;
  row->entry_error++;
  if (function == 6) expected = successful ? 0 : (uintptr_t)(intptr_t)-4048;
  else if (function == 3 || function == 5) expected = successful ? 7 : 0;
  else expected = successful ? (uintptr_t)OUTPUT_HANDLE : function == 4 ? 0 : (uintptr_t)INVALID_HANDLE_VALUE;
  if (returned != expected) return 0;
  row->exact_return++;
  if (after_error != (sets_error ? active.marker : active.seed)) return 0;
  row->after_error++;
  if (armed_case) {
    if (!ledger_ok(function, successful, &observed)) return 0;
    row->armed_ledger++;
  }
  if (wrapped) { row->wrapped++; report.wrapped++; }
  else { row->baseline++; report.baseline++; }
  captured->returned = returned; captured->after_error = after_error;
  return 1;
}
int main(void) {
  DWORD function, armed_case, successful, sets_error, repeat, written = 0;
  control_result baseline, wrapped;
  if (unexpected_calls || phase) return 92;
  phase = 1;
  memset(&report, 0, sizeof(report));
  for (function = 1; function <= 6; function++) {
    report.rows[function - 1].id = function;
    for (armed_case = 0; armed_case < 2; armed_case++) for (successful = 0; successful < 2; successful++)
      for (sets_error = 0; sets_error < 2; sets_error++) for (repeat = 0; repeat < 2; repeat++) {
        /* A direct unarmed delegate baseline always precedes its wrapper comparison. */
        if (!invoke(function, 0, 0, successful, sets_error, repeat, &baseline) ||
            !invoke(function, 1, armed_case, successful, sets_error, repeat, &wrapped) ||
            baseline.returned != wrapped.returned || baseline.after_error != wrapped.after_error) { phase = 2; return 93; }
        report.completed++;
      }
  }
  for (function = 1; function <= 6; function++) {
    const control_row* row = &report.rows[function - 1];
    if (delegated[function - 1] != 32 || row->baseline != 16 || row->wrapped != 16 ||
        row->arguments_outputs != 32 || row->entry_error != 32 || row->exact_return != 32 ||
        row->after_error != 32 || row->armed_ledger != 8) { phase = 2; return 94; }
  }
  if (unexpected_calls || report.completed != 96 || report.baseline != 96 || report.wrapped != 96) { phase = 2; return 95; }
  report.magic = 0x31494241u; report.version = report.status = 1; report.expected = 96; report.checks = 127;
  phase = 2;
  if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), &report, (DWORD)sizeof(report), &written, NULL) || written != sizeof(report)) return 96;
  return 0;
}
