/* Test-only declarations for Linux fault-logic checks, never a Windows ABI implementation. */
#ifndef EMBER_RNG_TEST_WINDOWS_H
#define EMBER_RNG_TEST_WINDOWS_H
#include <stddef.h>
#include <stdint.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef int BOOL;
typedef unsigned char BYTE;
typedef wchar_t WCHAR;
typedef void *HANDLE;
typedef uintptr_t HCRYPTPROV;
typedef int32_t NTSTATUS;
typedef int TOKEN_INFORMATION_CLASS;
typedef struct { int64_t QuadPart; } LARGE_INTEGER;
#define TRUE 1
#define FALSE 0
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define MAXDWORD UINT32_MAX
#define FILE_BEGIN 0
#define GENERIC_READ 0x80000000u
#define GENERIC_WRITE 0x40000000u
#define FILE_SHARE_READ 1
#define OPEN_EXISTING 3
#define CREATE_NEW 1
#define FILE_ATTRIBUTE_NORMAL 128
#define PROCESS_VM_READ 16
#define PROCESS_DUP_HANDLE 64
#define PROCESS_CREATE_PROCESS 128
#define PROCESS_QUERY_LIMITED_INFORMATION 4096
#define TOKEN_QUERY 8
#define ERROR_ACCESS_DENIED 5
#define ERROR_INVALID_DATA 13
#define _TRUNCATE ((size_t)-1)
void *SecureZeroMemory(void *, size_t);
DWORD GetLastError(void);
void Sleep(DWORD);
BOOL SetFilePointerEx(HANDLE, LARGE_INTEGER, LARGE_INTEGER *, DWORD);
BOOL WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
BOOL FlushFileBuffers(HANDLE);
BOOL CloseHandle(HANDLE);
DWORD GetEnvironmentVariableW(const WCHAR *, WCHAR *, DWORD);
DWORD GetCurrentProcessId(void);
HANDLE GetCurrentProcess(void);
HANDLE CreateFileW(const WCHAR *, DWORD, DWORD, void *, DWORD, DWORD, HANDLE);
BOOL ReadFile(HANDLE, void *, DWORD, DWORD *, void *);
HANDLE OpenProcess(DWORD, BOOL, DWORD);
BOOL OpenProcessToken(HANDLE, DWORD, HANDLE *);
BOOL GetTokenInformation(HANDLE, TOKEN_INFORMATION_CLASS, void *, DWORD, DWORD *);
int _snwprintf_s(WCHAR *, size_t, size_t, const WCHAR *, ...);
#endif
