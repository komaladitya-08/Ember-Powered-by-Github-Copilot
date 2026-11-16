/* Executes the actual observer source against fixed test delegates, not Windows or libuv.
 * No real error getter/setter exists here: adding such a call to the observer fails the build.
 */
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "../windows-uv-spawn-observe.c"

static char name[] = "fixed", environment[] = "fixed";
static uint16_t application[] = { 'f', 0 }, command[] = { 'c', 0 }, cwd[] = { 'd', 0 };
static SECURITY_ATTRIBUTES security1 = { 1 }, security2 = { 2 };
static OVERLAPPED overlapped = { 3 };
static STARTUPINFOW startup = { 4 };
static PROCESS_INFORMATION information = { 5 };
static const uintptr_t wide_key = (uintptr_t)0x12345678u + ((uintptr_t)0x12345678u << 32);
static uint32_t fake_error, delegate_calls[6], bad_arguments;
static int mode, recurse;
static HANDLE fake_handle = (HANDLE)(uintptr_t)0x1234;
static BOOL fake_bool = 7;
#define REQUIRE(value) do { if (!(value)) return __LINE__; } while (0)
#define CHECK(value) do { if (!(value)) bad_arguments++; } while (0)

HANDLE WINAPI CreateNamedPipeA(LPCSTR n, DWORD a, DWORD p, DWORD count, DWORD out, DWORD in, DWORD timeout, LPSECURITY_ATTRIBUTES s) {
  delegate_calls[0]++; CHECK(n == name && a == 11 && p == 12 && count == 13 && out == 14 && in == 15 && timeout == 16 && s == &security1);
  if (mode == 2 && !recurse) { recurse = 1; ember_uv_spawn_CreateFileA(name, 21, 22, &security1, 23, 24, fake_handle); }
  if (mode == 3) ember_uv_spawn_observe_begin();
  fake_error = 0x13572468u; return fake_handle;
}
HANDLE WINAPI CreateFileA(LPCSTR n, DWORD a, DWORD share, LPSECURITY_ATTRIBUTES s, DWORD disposition, DWORD attrs, HANDLE template_file) {
  delegate_calls[1]++; CHECK(n == name && a == 21 && share == 22 && s == &security1 && disposition == 23 && attrs == 24 && template_file == fake_handle);
  fake_error = 0x24681357u; return fake_handle;
}
BOOL WINAPI ConnectNamedPipe(HANDLE h, LPOVERLAPPED o) {
  delegate_calls[2]++; CHECK(h == fake_handle && o == &overlapped);
  fake_error = 535; return fake_bool;
}
HANDLE WINAPI CreateIoCompletionPort(HANDLE h, HANDLE port, ULONG_PTR key, DWORD threads) {
  delegate_calls[3]++; CHECK(h == fake_handle && port == &security1 && key == wide_key && threads == 31);
  fake_error = 0x98765432u; return fake_handle;
}
BOOL WINAPI CreateProcessW(LPCWSTR a, LPWSTR c, LPSECURITY_ATTRIBUTES ps, LPSECURITY_ATTRIBUTES ts, BOOL inherit,
    DWORD flags, LPVOID env, LPCWSTR d, LPSTARTUPINFOW start, LPPROCESS_INFORMATION info) {
  delegate_calls[4]++; CHECK(a == application && c == command && ps == &security1 && ts == &security2 && inherit == 9 && flags == 41 && env == environment && d == cwd && start == &startup && info == &information);
  c[0] = 'x'; info->marker = 55; fake_error = 0x87654321u; return fake_bool;
}
int uv_translate_sys_error(int error) {
  delegate_calls[5]++; fake_error = 0x76543210u;
  return error == 5 || error == 1314 ? -4048 : -1000;
}
static HANDLE call_named(void) { return ember_uv_spawn_CreateNamedPipeA(name, 11, 12, 13, 14, 15, 16, &security1); }
static HANDLE call_file(void) { return ember_uv_spawn_CreateFileA(name, 21, 22, &security1, 23, 24, fake_handle); }
static BOOL call_process(void) { return ember_uv_spawn_CreateProcessW(application, command, &security1, &security2, 9, 41, environment, cwd, &startup, &information); }
static void* unarmed_thread(void* ignored) { (void)ignored; call_named(); return NULL; }
int main(int argc, char** argv) {
  ember_uv_spawn_observation result;
  int which, translated;
  uint32_t i;
  if (argc != 2) return 250;
  which = atoi(argv[1]);
  if (which == 1) {
    ember_uv_spawn_observe_begin();
    REQUIRE(call_named() == fake_handle && fake_error == 0x13572468u);
    REQUIRE(call_file() == fake_handle && fake_error == 0x24681357u);
    REQUIRE(ember_uv_spawn_ConnectNamedPipe(fake_handle, &overlapped) == 7 && fake_error == 535);
    REQUIRE(ember_uv_spawn_CreateIoCompletionPort(fake_handle, &security1, wide_key, 31) == fake_handle && fake_error == 0x98765432u);
    REQUIRE(call_process() == 7 && command[0] == 'x' && information.marker == 55 && fake_error == 0x87654321u);
    ember_uv_spawn_observe_end(0, &result);
    REQUIRE(!result.unknown && result.total_calls == 5 && result.last_operation == 5 && result.last_result == 1 && !result.translation_count);
    for (i = 0; i < 5; i++) REQUIRE(result.api[i].calls == 1 && result.api[i].successes == 1 && result.api[i].last_result == 1 && result.api[i].last_sequence == i + 1 && delegate_calls[i] == 1);
  } else if (which == 2) {
    fake_handle = INVALID_HANDLE_VALUE; fake_bool = 0; ember_uv_spawn_observe_begin();
    REQUIRE(call_named() == INVALID_HANDLE_VALUE); REQUIRE(call_file() == INVALID_HANDLE_VALUE);
    REQUIRE(ember_uv_spawn_ConnectNamedPipe(fake_handle, &overlapped) == 0);
    fake_handle = NULL; REQUIRE(ember_uv_spawn_CreateIoCompletionPort(fake_handle, &security1, wide_key, 31) == NULL);
    REQUIRE(call_process() == 0);
    translated = ember_uv_spawn_translate_sys_error(5); REQUIRE(translated == -4048 && fake_error == 0x76543210u);
    ember_uv_spawn_observe_end(translated, &result);
    REQUIRE(!result.unknown && result.total_calls == 5 && result.last_result == 0 && result.translation_count == 1 && result.translation_input == 5 && result.translation_result == -4048 && result.translation_sequence == 5 && delegate_calls[5] == 1);
    for (i = 0; i < 5; i++) REQUIRE(result.api[i].calls == 1 && result.api[i].successes == 0);
  } else if (which == 3) {
    call_named(); call_file(); ember_uv_spawn_translate_sys_error(5);
    ember_uv_spawn_observe_begin(); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(!result.unknown && result.total_calls == 0 && result.translation_count == 0);
  } else if (which == 4) {
    mode = 2; ember_uv_spawn_observe_begin(); call_named(); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(result.unknown == 1 && result.total_calls == 2 && result.api[0].calls == 1 && result.api[1].calls == 1 && result.api[1].last_sequence == 1 && result.api[0].last_sequence == 2);
  } else if (which == 5) {
    ember_uv_spawn_observe_begin(); for (i = 0; i < EMBER_UV_SPAWN_OBSERVE_LIMIT + 1; i++) call_named(); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(result.unknown == 1 && result.total_calls == 4096 && result.api[0].calls == 4096 && result.api[0].successes == 4096 && delegate_calls[0] == 4097);
  } else if (which == 6) {
    mode = 3; ember_uv_spawn_observe_begin(); call_named(); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(result.unknown == 1 && result.total_calls == 1);
  } else if (which == 7) {
    ember_uv_spawn_observe_begin(); ember_uv_spawn_translate_sys_error(5); ember_uv_spawn_translate_sys_error(1314); ember_uv_spawn_observe_end(-4048, &result);
    REQUIRE(result.unknown == 1 && result.translation_count == 1 && result.translation_input == 5 && delegate_calls[5] == 2);
  } else if (which == 8) {
    ember_uv_spawn_observe_begin(); ember_uv_spawn_translate_sys_error(5); ember_uv_spawn_observe_end(-1, &result);
    REQUIRE(result.unknown == 1 && result.translation_result == -4048);
  } else if (which == 9) {
    pthread_t thread; ember_uv_spawn_observe_begin();
    REQUIRE(pthread_create(&thread, NULL, unarmed_thread, NULL) == 0); REQUIRE(pthread_join(thread, NULL) == 0);
    call_named(); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(result.unknown == 0 && result.total_calls == 1 && delegate_calls[0] == 2);
  } else if (which == 10) {
    ember_uv_spawn_observe_begin(); fake_handle = NULL; REQUIRE(call_file() == NULL);
    fake_handle = INVALID_HANDLE_VALUE; REQUIRE(ember_uv_spawn_CreateIoCompletionPort(fake_handle, &security1, wide_key, 31) == INVALID_HANDLE_VALUE);
    ember_uv_spawn_observe_end(0, &result);
    REQUIRE(!result.unknown && result.api[1].successes == 1 && result.api[3].successes == 1);
  } else if (which == 11) {
    fake_bool = -17; ember_uv_spawn_observe_begin(); REQUIRE(call_process() == -17); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(!result.unknown && result.api[4].successes == 1 && result.last_result == 1);
  } else if (which == 12) {
    ember_uv_spawn_observe_begin(); translated = ember_uv_spawn_translate_sys_error(1314); ember_uv_spawn_observe_end(translated, &result);
    REQUIRE(!result.unknown && result.translation_count == 1 && result.translation_input == 1314 && result.translation_result == -4048 && result.translation_sequence == 0 && result.total_calls == 0 && delegate_calls[5] == 1);
  } else if (which == 13) {
    ember_uv_spawn_observe_begin(); ember_uv_spawn_translate_sys_error(5); ember_uv_spawn_observe_end(0, &result);
    REQUIRE(result.unknown == 1);
  } else if (which == 14) {
    ember_uv_spawn_observe_end(0, &result); REQUIRE(result.unknown == 1);
  } else if (which == 15) {
    ember_uv_spawn_observe_begin(); call_named(); ember_uv_spawn_observe_end(0, &result);
    call_file(); REQUIRE(!result.unknown && result.total_calls == 1 && result.api[1].calls == 0);
  } else return 249;
  REQUIRE(bad_arguments == 0); return 0;
}
