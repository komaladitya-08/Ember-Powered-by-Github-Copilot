/* Test declarations only. No Windows ABI, process policy or kernel behavior is emulated here. */
#ifndef EMBER_POLICY_TEST_WINDOWS_H
#define EMBER_POLICY_TEST_WINDOWS_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>
typedef uint32_t DWORD;
typedef int BOOL;
typedef unsigned char BYTE;
typedef wchar_t WCHAR;
typedef void *HANDLE;
typedef void *PSID;
typedef uintptr_t ULONG_PTR;
typedef size_t SIZE_T;
typedef int TOKEN_INFORMATION_CLASS;
typedef struct { int64_t QuadPart; } LARGE_INTEGER;
typedef struct { DWORD Flags; } PROCESS_MITIGATION_CHILD_PROCESS_POLICY;
typedef struct { PSID Sid; DWORD Attributes; } SID_AND_ATTRIBUTES;
typedef struct { DWORD GroupCount; SID_AND_ATTRIBUTES Groups[1]; } TOKEN_GROUPS;
typedef struct { HANDLE hProcess,hThread; DWORD dwProcessId,dwThreadId; } PROCESS_INFORMATION;
typedef void *LPPROC_THREAD_ATTRIBUTE_LIST;
typedef struct { DWORD cb; BYTE remainder[100]; } STARTUPINFOW;
typedef struct { STARTUPINFOW StartupInfo; LPPROC_THREAD_ATTRIBUTE_LIST lpAttributeList; } STARTUPINFOEXW;
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
#define PROCESS_VM_WRITE 32
#define PROCESS_CREATE_PROCESS 128
#define PROCESS_QUERY_LIMITED_INFORMATION 4096
#define TOKEN_QUERY 8
#define ERROR_ACCESS_DENIED 5
#define ERROR_INVALID_DATA 13
#define ERROR_INSUFFICIENT_BUFFER 122
#define HEAP_ZERO_MEMORY 8
#define SECURITY_MAX_SID_SIZE 68
#define SID_REVISION 1
#define SID_MAX_SUB_AUTHORITIES 15
#define SE_GROUP_ENABLED 4
#define TokenUser 1
#define TokenGroups 2
#define TokenIntegrityLevel 25
#define TokenIsAppContainer 29
#define TokenCapabilities 30
#define TokenAppContainerSid 31
#define WinBuiltinAnyPackageSid 84
#define ProcessChildProcessPolicy 13
#define PROCESS_CREATION_CHILD_PROCESS_OVERRIDE 2
#define PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY 0x2000e
#define CREATE_SUSPENDED 4
#define CREATE_NO_WINDOW 0x8000000
#define EXTENDED_STARTUPINFO_PRESENT 0x80000
#define WAIT_OBJECT_0 0
#define _TRUNCATE ((size_t)-1)
#define ZeroMemory(target,size) memset((target),0,(size))
DWORD GetLastError(void);
void Sleep(DWORD);
BOOL SetFilePointerEx(HANDLE,LARGE_INTEGER,LARGE_INTEGER *,DWORD);
BOOL WriteFile(HANDLE,const void *,DWORD,DWORD *,void *);
BOOL FlushFileBuffers(HANDLE);
BOOL CloseHandle(HANDLE);
DWORD GetEnvironmentVariableW(const WCHAR *,WCHAR *,DWORD);
DWORD GetCurrentProcessId(void);
HANDLE GetCurrentProcess(void);
BOOL OpenProcessToken(HANDLE,DWORD,HANDLE *);
BOOL GetTokenInformation(HANDLE,TOKEN_INFORMATION_CLASS,void *,DWORD,DWORD *);
BOOL IsValidSid(PSID);
DWORD GetLengthSid(PSID);
BOOL EqualSid(PSID,PSID);
BYTE *GetSidSubAuthorityCount(PSID);
DWORD *GetSidSubAuthority(PSID,DWORD);
BOOL CreateWellKnownSid(int,PSID,void *,DWORD *);
HANDLE GetProcessHeap(void);
void *HeapAlloc(HANDLE,DWORD,SIZE_T);
BOOL HeapFree(HANDLE,DWORD,void *);
BOOL GetProcessMitigationPolicy(HANDLE,int,void *,SIZE_T);
BOOL SetProcessMitigationPolicy(int,void *,SIZE_T);
HANDLE CreateFileW(const WCHAR *,DWORD,DWORD,void *,DWORD,DWORD,HANDLE);
BOOL ReadFile(HANDLE,void *,DWORD,DWORD *,void *);
HANDLE OpenProcess(DWORD,BOOL,DWORD);
BOOL IsProcessInJob(HANDLE,HANDLE,BOOL *);
BOOL InitializeProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST,DWORD,DWORD,SIZE_T *);
BOOL UpdateProcThreadAttribute(LPPROC_THREAD_ATTRIBUTE_LIST,DWORD,ULONG_PTR,void *,SIZE_T,void *,SIZE_T *);
void DeleteProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);
BOOL CreateProcessW(const WCHAR *,WCHAR *,void *,void *,BOOL,DWORD,void *,const WCHAR *,STARTUPINFOW *,PROCESS_INFORMATION *);
DWORD GetProcessId(HANDLE);
DWORD GetThreadId(HANDLE);
DWORD GetProcessIdOfThread(HANDLE);
BOOL QueryFullProcessImageNameW(HANDLE,DWORD,WCHAR *,DWORD *);
DWORD ResumeThread(HANDLE);
DWORD WaitForSingleObject(HANDLE,DWORD);
BOOL GetExitCodeProcess(HANDLE,DWORD *);
DWORD GetModuleFileNameW(HANDLE,WCHAR *,DWORD);
int _snwprintf_s(WCHAR *,SIZE_T,SIZE_T,const WCHAR *,...);
int _wcsicmp(const WCHAR *,const WCHAR *);
#endif
