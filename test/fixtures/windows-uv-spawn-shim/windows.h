/* Test-only declarations for Linux fault logic, never Windows SDK/ABI or native evidence. */
#ifndef EMBER_UV_SPAWN_TEST_WINDOWS_H
#define EMBER_UV_SPAWN_TEST_WINDOWS_H
#include <stdint.h>
#include <stddef.h>
#define WINAPI
typedef void* HANDLE;
typedef uint32_t DWORD;
typedef int32_t BOOL;
typedef uintptr_t ULONG_PTR;
typedef const char* LPCSTR;
typedef const uint16_t* LPCWSTR;
typedef uint16_t* LPWSTR;
typedef void* LPVOID;
typedef struct { uint32_t marker; } SECURITY_ATTRIBUTES, *LPSECURITY_ATTRIBUTES;
typedef struct { uint32_t marker; } OVERLAPPED, *LPOVERLAPPED;
typedef struct { uint32_t marker; } STARTUPINFOW, *LPSTARTUPINFOW;
typedef struct { uint32_t marker; } PROCESS_INFORMATION, *LPPROCESS_INFORMATION;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
HANDLE WINAPI CreateNamedPipeA(LPCSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
HANDLE WINAPI CreateFileA(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
BOOL WINAPI ConnectNamedPipe(HANDLE, LPOVERLAPPED);
HANDLE WINAPI CreateIoCompletionPort(HANDLE, HANDLE, ULONG_PTR, DWORD);
BOOL WINAPI CreateProcessW(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
#endif
