/* Test-only Linux declarations. These are portable control-logic tests, never Windows ABI evidence. */
#ifndef EMBER_UV_OBSERVER_ABI_TEST_WINDOWS_H
#define EMBER_UV_OBSERVER_ABI_TEST_WINDOWS_H
#include <stddef.h>
#include <stdint.h>
#define WINAPI
typedef void* HANDLE;
typedef uint32_t DWORD;
typedef int32_t BOOL;
typedef uintptr_t ULONG_PTR;
typedef uint16_t WCHAR;
typedef const char* LPCSTR;
typedef const WCHAR* LPCWSTR;
typedef WCHAR* LPWSTR;
typedef void* LPVOID;
typedef struct { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; } SECURITY_ATTRIBUTES, *LPSECURITY_ATTRIBUTES;
typedef struct { ULONG_PTR Internal, InternalHigh; DWORD Offset, OffsetHigh; HANDLE hEvent; } OVERLAPPED, *LPOVERLAPPED;
typedef struct { DWORD cb, dwFlags; HANDLE hStdInput, hStdOutput, hStdError; } STARTUPINFOW, *LPSTARTUPINFOW;
typedef struct { HANDLE hProcess, hThread; DWORD dwProcessId, dwThreadId; } PROCESS_INFORMATION, *LPPROCESS_INFORMATION;
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define STD_OUTPUT_HANDLE ((DWORD)-11)
HANDLE WINAPI CreateNamedPipeA(LPCSTR, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPSECURITY_ATTRIBUTES);
HANDLE WINAPI CreateFileA(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
BOOL WINAPI ConnectNamedPipe(HANDLE, LPOVERLAPPED);
HANDLE WINAPI CreateIoCompletionPort(HANDLE, HANDLE, ULONG_PTR, DWORD);
BOOL WINAPI CreateProcessW(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
DWORD WINAPI GetLastError(void);
void WINAPI SetLastError(DWORD);
HANDLE WINAPI GetStdHandle(DWORD);
BOOL WINAPI WriteFile(HANDLE, const void*, DWORD, DWORD*, LPOVERLAPPED);
_Noreturn void WINAPI ExitProcess(DWORD);
#endif
