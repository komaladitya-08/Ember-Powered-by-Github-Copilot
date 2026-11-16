/* Fixed synchronous spawn observations. SDK declarations precede aliases; no API obtains a new error value. */
#ifndef EMBER_WINDOWS_UV_SPAWN_OBSERVE_H
#define EMBER_WINDOWS_UV_SPAWN_OBSERVE_H

#if !defined(_WIN32_WINNT) || _WIN32_WINNT != 0x0602
#error The fixed spawn witness requires the Node libuv Windows target 0x0602 before every header.
#endif
#include <uv.h>
#include <windows.h>
#include <stdint.h>

#define EMBER_UV_SPAWN_OBSERVE_LIMIT 4096u
#define EMBER_UV_SPAWN_API_COUNT 5u
typedef struct ember_uv_spawn_api_observation_s {
  uint32_t calls, successes, last_result, last_sequence;
} ember_uv_spawn_api_observation;
typedef struct ember_uv_spawn_observation_s {
  uint32_t unknown, total_calls, last_operation, last_result;
  uint32_t translation_count;
  int32_t translation_input, translation_result;
  uint32_t translation_sequence;
  ember_uv_spawn_api_observation api[EMBER_UV_SPAWN_API_COUNT];
} ember_uv_spawn_observation;
typedef char ember_observation_has_28_words[(sizeof(ember_uv_spawn_observation) == 112) ? 1 : -1];

/* The caller arms only its synchronous uv_spawn; snapshots occur after it has returned. */
void ember_uv_spawn_observe_begin(void);
void ember_uv_spawn_observe_end(int final_result, ember_uv_spawn_observation* output);
HANDLE WINAPI ember_uv_spawn_CreateNamedPipeA(LPCSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
HANDLE WINAPI ember_uv_spawn_CreateFileA(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
BOOL WINAPI ember_uv_spawn_ConnectNamedPipe(HANDLE, LPOVERLAPPED);
HANDLE WINAPI ember_uv_spawn_CreateIoCompletionPort(HANDLE, HANDLE, ULONG_PTR, DWORD);
BOOL WINAPI ember_uv_spawn_CreateProcessW(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
int ember_uv_spawn_translate_sys_error(int);

/* Both the selected SDK declaration and our wrapper must have the same exact C/Win64 function type. */
typedef HANDLE (WINAPI *ember_expected_named_pipe)(LPCSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
typedef HANDLE (WINAPI *ember_expected_file)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef BOOL (WINAPI *ember_expected_connect)(HANDLE, LPOVERLAPPED);
typedef HANDLE (WINAPI *ember_expected_completion)(HANDLE, HANDLE, ULONG_PTR, DWORD);
typedef BOOL (WINAPI *ember_expected_process)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
typedef int (*ember_expected_translate)(int);
#define EMBER_UV_SPAWN_ABI_CHECK(name, expected) _Static_assert(_Generic(&(name), expected: 1, default: 0), "The fixed spawn SDK/wrapper ABI changed")
EMBER_UV_SPAWN_ABI_CHECK(CreateNamedPipeA, ember_expected_named_pipe);
EMBER_UV_SPAWN_ABI_CHECK(ember_uv_spawn_CreateNamedPipeA, ember_expected_named_pipe);
EMBER_UV_SPAWN_ABI_CHECK(CreateFileA, ember_expected_file);
EMBER_UV_SPAWN_ABI_CHECK(ember_uv_spawn_CreateFileA, ember_expected_file);
EMBER_UV_SPAWN_ABI_CHECK(ConnectNamedPipe, ember_expected_connect);
EMBER_UV_SPAWN_ABI_CHECK(ember_uv_spawn_ConnectNamedPipe, ember_expected_connect);
EMBER_UV_SPAWN_ABI_CHECK(CreateIoCompletionPort, ember_expected_completion);
EMBER_UV_SPAWN_ABI_CHECK(ember_uv_spawn_CreateIoCompletionPort, ember_expected_completion);
EMBER_UV_SPAWN_ABI_CHECK(CreateProcessW, ember_expected_process);
EMBER_UV_SPAWN_ABI_CHECK(ember_uv_spawn_CreateProcessW, ember_expected_process);
EMBER_UV_SPAWN_ABI_CHECK(uv_translate_sys_error, ember_expected_translate);
EMBER_UV_SPAWN_ABI_CHECK(ember_uv_spawn_translate_sys_error, ember_expected_translate);
#undef EMBER_UV_SPAWN_ABI_CHECK

#if defined(EMBER_UV_SPAWN_OBSERVE_PIPE) || defined(EMBER_UV_SPAWN_OBSERVE_PROCESS)
#define CreateNamedPipeA ember_uv_spawn_CreateNamedPipeA
#define CreateFileA ember_uv_spawn_CreateFileA
#define ConnectNamedPipe ember_uv_spawn_ConnectNamedPipe
#define CreateIoCompletionPort ember_uv_spawn_CreateIoCompletionPort
#define CreateProcessW ember_uv_spawn_CreateProcessW
#endif
#if defined(EMBER_UV_SPAWN_OBSERVE_PROCESS)
#define uv_translate_sys_error ember_uv_spawn_translate_sys_error
#endif
#endif
