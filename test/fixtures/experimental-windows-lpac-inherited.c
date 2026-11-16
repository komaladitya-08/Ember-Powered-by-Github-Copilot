/*
 * Separate fixed LPAC child-inheritance diagnostic. The original explicit-attributes control remains unmodified.
 * No child instruction runs until both existing confinement checks and a trusted-host admission receipt succeed.
 * Build without a CRT using the same kernel32/advapi32-only recipe as the included original fixture.
 */
#define mainCRTStartup explicitAttributesControlMain
#include "experimental-windows-lpac.c"
#undef mainCRTStartup
#include "windows-lpac-child-sd-diagnostic.h"

#ifndef EMBER_LPAC_CHILD_AAP_ONLY
#define EMBER_LPAC_CHILD_AAP_ONLY 0
#endif
#if EMBER_LPAC_CHILD_AAP_ONLY != 0 && EMBER_LPAC_CHILD_AAP_ONLY != 1
#error The fixed child-creation probe accepts only its two reviewed variants.
#endif
#ifndef EMBER_LPAC_CHILD_NULL_SECURITY
#define EMBER_LPAC_CHILD_NULL_SECURITY 0
#endif
#ifndef EMBER_LPAC_CHILD_DETACHED
#define EMBER_LPAC_CHILD_DETACHED 0
#endif
#if (EMBER_LPAC_CHILD_NULL_SECURITY != 0 && EMBER_LPAC_CHILD_NULL_SECURITY != 1) || (EMBER_LPAC_CHILD_DETACHED != 0 && EMBER_LPAC_CHILD_DETACHED != 1)
#error The fixed child-creation observations accept only literal selectors.
#endif
#if (EMBER_LPAC_CHILD_NULL_SECURITY || EMBER_LPAC_CHILD_DETACHED) && !EMBER_LPAC_CHILD_AAP_ONLY
#error Each isolated comparison requires the existing AAP-only policy branch.
#endif
#if EMBER_LPAC_CHILD_NULL_SECURITY && EMBER_LPAC_CHILD_DETACHED
#error The object-security and console observations must remain separate.
#endif

#if EMBER_LPAC_CHILD_AAP_ONLY
static DWORD aapNativeError(void)
{
    DWORD error = GetLastError();
    return error ? error : ERROR_INVALID_DATA;
}

/* Only the exceptional attribute-cleanup path uses this stricter owned-child shutdown. */
static BOOL stopAapCreatedChild(PROCESS_INFORMATION *process, DWORD *error)
{
    DWORD waited = WaitForSingleObject(process->hProcess, 0), failure = 0;
    if (waited == WAIT_TIMEOUT) {
        if (!TerminateProcess(process->hProcess, 125)) { *error = aapNativeError(); return FALSE; }
        waited = WaitForSingleObject(process->hProcess, 5000);
    }
    if (waited != WAIT_OBJECT_0) {
        *error = waited == WAIT_FAILED ? aapNativeError() : waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : ERROR_INVALID_DATA;
        return FALSE;
    }
    if (!CloseHandle(process->hThread)) failure = aapNativeError(); else process->hThread = NULL;
    if (!CloseHandle(process->hProcess)) { if (!failure) failure = aapNativeError(); } else process->hProcess = NULL;
    *error = failure;
    return failure == 0;
}

static __declspec(noreturn) void aapCreationRefusal(DWORD stage, DWORD error)
{
    recordFailure(stage, error ? error : ERROR_INVALID_DATA);
    ExitProcess(stage);
}
#endif

/* Ordinary CreateProcess inherits the current token; suspended admission verifies the actual result, never an assumption. */
static BOOL spawnInherited(DWORD flags, PROCESS_INFORMATION *process, DWORD *error)
{
#if EMBER_LPAC_CHILD_AAP_ONLY
    STARTUPINFOEXW startup;
    SIZE_T bytes = 0;
    DWORD policy = 1;
    BOOL created;
    SECURITY_ATTRIBUTES *processSecurity = &childAttributes, *threadSecurity = &childAttributes;
    DWORD childConsoleFlags = CREATE_NO_WINDOW;
#if EMBER_LPAC_CHILD_NULL_SECURITY
    processSecurity = NULL;
    threadSecurity = NULL;
#endif
#if EMBER_LPAC_CHILD_DETACHED
    childConsoleFlags = DETACHED_PROCESS;
#endif
    memset(&startup, 0, sizeof(startup));
    memset(process, 0, sizeof(*process));
    childNtStatus = MAXDWORD;
    startup.StartupInfo.cb = sizeof(startup);
    commandLine[0] = 0;
    if (!append(commandLine, L"\"") || !append(commandLine, selfPath) || !append(commandLine, L"\" child")) {
        aapCreationRefusal(32, ERROR_FILENAME_EXCED_RANGE);
    }
    if (InitializeProcThreadAttributeList(NULL, 1, 0, &bytes) || GetLastError() != ERROR_INSUFFICIENT_BUFFER
        || bytes == 0 || bytes > 65536) aapCreationRefusal(32, ERROR_INVALID_DATA);
    startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)LocalAlloc(LPTR, bytes);
    if (startup.lpAttributeList == NULL) aapCreationRefusal(32, ERROR_NOT_ENOUGH_MEMORY);
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)) {
        DWORD failure = aapNativeError();
        if (LocalFree(startup.lpAttributeList) != NULL) failure = aapNativeError();
        aapCreationRefusal(32, failure);
    }
    /* Inherit the existing token, adding only the documented AAP opt-out selection. No new lowbox/capabilities. */
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, (DWORD_PTR)0x2000f,
                                   &policy, sizeof(policy), NULL, NULL)) {
        DWORD failure = aapNativeError(); DeleteProcThreadAttributeList(startup.lpAttributeList);
        if (LocalFree(startup.lpAttributeList) != NULL) failure = aapNativeError();
        aapCreationRefusal(32, failure);
    }
    created = CreateProcessW(selfPath, commandLine, processSecurity, threadSecurity, FALSE,
                             flags | childConsoleFlags | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                             NULL, NULL, &startup.StartupInfo, process);
    *error = created ? ERROR_SUCCESS : GetLastError();
    childNtStatus = created ? 0 : getLastNtStatus ? (DWORD)getLastNtStatus() : MAXDWORD;
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    if (LocalFree(startup.lpAttributeList) != NULL) {
        DWORD failure = aapNativeError(), stopped = 0;
        if (created) {
            if (!stopAapCreatedChild(process, &stopped)) aapCreationRefusal(31, stopped);
            aapCreationRefusal(30, failure);
        }
        aapCreationRefusal(32, failure);
    }
#if !EMBER_LPAC_CHILD_NULL_SECURITY
    if (!created && flags == 0) writeChildSdAccessDiagnostic();
#endif
    return created;
#else
    STARTUPINFOW startup;
    BOOL created;
    memset(&startup, 0, sizeof(startup));
    memset(process, 0, sizeof(*process));
    startup.cb = sizeof(startup);
    commandLine[0] = 0;
    if (!append(commandLine, L"\"") || !append(commandLine, selfPath) || !append(commandLine, L"\" child")) {
        *error = ERROR_FILENAME_EXCED_RANGE;
        return FALSE;
    }
    created = CreateProcessW(selfPath, commandLine, &childAttributes, &childAttributes, FALSE,
                             flags | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                             NULL, NULL, &startup, process);
    *error = created ? ERROR_SUCCESS : GetLastError();
    childNtStatus = created ? 0 : getLastNtStatus ? (DWORD)getLastNtStatus() : MAXDWORD;
    if (!created && flags == 0) writeChildSdAccessDiagnostic();
    return created;
#endif
}

/* No path, SID, text or report is returned. Only the host's exact eight-byte fresh acknowledgement can admit this PID. */
static BOOL awaitInheritedChildAdmission(DWORD childPid, DWORD *error)
{
    ULONGLONG started = GetTickCount64();
    HANDLE file;
    BY_HANDLE_FILE_INFORMATION before, after;
    DWORD admission[2], count, failure;
    BYTE extra;
    BOOL accepted;
    if (!childPid || !pathFor(statePath, L"\\child-admit.bin")) {
        *error = ERROR_INVALID_DATA;
        return FALSE;
    }
    for (;;) {
        if (GetTickCount64() - started >= 10000) {
            *error = ERROR_TIMEOUT;
            return FALSE;
        }
        /* Deny write/delete sharing while reading; OPEN_REPARSE_POINT never follows the final name. */
        file = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        if (file == INVALID_HANDLE_VALUE) {
            failure = GetLastError();
            if (failure == ERROR_FILE_NOT_FOUND || failure == ERROR_SHARING_VIOLATION) { Sleep(10); continue; }
            *error = failure;
            return FALSE;
        }
        accepted = FALSE;
        failure = ERROR_INVALID_DATA;
        if (GetFileType(file) != FILE_TYPE_DISK) goto closeAdmission;
        if (!GetFileInformationByHandle(file, &before)) { failure = GetLastError(); goto closeAdmission; }
        if ((before.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0
            || before.nNumberOfLinks != 1 || before.nFileSizeHigh != 0 || before.nFileSizeLow != sizeof(admission)) goto closeAdmission;
        count = 0;
        if (!ReadFile(file, admission, sizeof(admission), &count, NULL)) { failure = GetLastError(); goto closeAdmission; }
        if (count != sizeof(admission) || admission[0] != 0x43495045u || admission[1] != childPid) goto closeAdmission;
        count = 0;
        if (!ReadFile(file, &extra, 1, &count, NULL)) { failure = GetLastError(); goto closeAdmission; }
        if (count != 0) goto closeAdmission;
        if (!GetFileInformationByHandle(file, &after)) { failure = GetLastError(); goto closeAdmission; }
        if (before.dwFileAttributes != after.dwFileAttributes || before.dwVolumeSerialNumber != after.dwVolumeSerialNumber
            || before.nFileIndexHigh != after.nFileIndexHigh || before.nFileIndexLow != after.nFileIndexLow
            || before.nNumberOfLinks != after.nNumberOfLinks || before.nFileSizeHigh != after.nFileSizeHigh
            || before.nFileSizeLow != after.nFileSizeLow
            || before.ftCreationTime.dwHighDateTime != after.ftCreationTime.dwHighDateTime
            || before.ftCreationTime.dwLowDateTime != after.ftCreationTime.dwLowDateTime
            || before.ftLastWriteTime.dwHighDateTime != after.ftLastWriteTime.dwHighDateTime
            || before.ftLastWriteTime.dwLowDateTime != after.ftLastWriteTime.dwLowDateTime) goto closeAdmission;
        accepted = TRUE;
        failure = ERROR_SUCCESS;
closeAdmission:
        if (!CloseHandle(file)) { *error = GetLastError(); return FALSE; }
        *error = failure;
        return accepted;
    }
}

void __cdecl mainCRTStartup(void)
{
    HANDLE token = NULL, file, host;
    DWORD count, needed = 0, error, parent, groups;
    PROCESS_INFORMATION unexpected, child;
    BYTE signature[2];
    BOOL wrote, selfControl, readDenied, duplicateDenied, parentDenied;

    if (!readArgument()) ExitProcess(10);
    if (childArgument()) {
        Sleep(INFINITE);
        ExitProcess(11);
    }
    parent = hostPid();
    if (!parent || parent == GetCurrentProcessId()) ExitProcess(12);
    getLastNtStatus = (LAST_NT_STATUS)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetLastNtStatus");
    count = GetModuleFileNameW(NULL, selfPath, MAX_CHARS);
    if (!count || count >= MAX_CHARS) ExitProcess(13);
    if (!environmentPath(L"EMBER_LPAC_STATE", statePath)
        || !environmentPath(L"EMBER_LPAC_WORK", workPath)
        || !environmentPath(L"EMBER_LPAC_TOOLS", toolsPath)) ExitProcess(14);

    report[0] = 1;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &token)) {
        report[1] = tokenFlag(token, TOKEN_IS_APP_CONTAINER);
        report[2] = packageAccessWitness(token);
        if (GetTokenInformation(token, TOKEN_CAPABILITIES_CLASS, tokenBuffer, sizeof(tokenBuffer), &needed)
            && needed >= sizeof(DWORD)) {
            memcpy(&groups, tokenBuffer, sizeof(groups));
            report[3] = groups == 0;
        }
        if (!prepareChildSecurity(token)) { recordFailure(25, GetLastError()); CloseHandle(token); ExitProcess(25); }
        CloseHandle(token);
    } else { recordFailure(26, GetLastError()); ExitProcess(26); }
    count = GetEnvironmentVariableW(L"GH_TOKEN", argument, (DWORD)(sizeof(argument) / sizeof(argument[0])));
    report[4] = count == 0;

    if (!pathFor(statePath, L"\\..\\all-app-packages.txt")) ExitProcess(15);
    file = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    error = GetLastError();
    report[5] = file == INVALID_HANDLE_VALUE && error == ERROR_ACCESS_DENIED;
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);

    file = CreateFileW(selfPath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        count = 0;
        report[6] = ReadFile(file, signature, sizeof(signature), &count, NULL)
            && count == sizeof(signature) && signature[0] == 'M' && signature[1] == 'Z';
        CloseHandle(file);
    }

    host = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, GetCurrentProcessId());
    selfControl = host != NULL && GetProcessId(host) == GetCurrentProcessId();
    if (host != NULL) CloseHandle(host);
    readDenied = processRightDenied(PROCESS_VM_READ, parent);
    duplicateDenied = processRightDenied(PROCESS_DUP_HANDLE, parent);
    parentDenied = processRightDenied(PROCESS_CREATE_PROCESS, parent);
    report[7] = selfControl && readDenied && duplicateDenied && parentDenied;

    if (spawnInherited(CREATE_BREAKAWAY_FROM_JOB, &unexpected, &error)) {
        report[8] = 0;
        if (!endUnexpectedChild(&unexpected)) ExitProcess(16);
    } else report[8] = error == ERROR_ACCESS_DENIED;

    if (!pathFor(workPath, L"\\fixture-write.bin")) ExitProcess(17);
    file = CreateFileW(filePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        count = 0;
        report[10] = WriteFile(file, workBytes, sizeof(workBytes), &count, NULL) && count == sizeof(workBytes);
        CloseHandle(file);
    }

    if (!spawnInherited(0, &child, &error)) { recordFailure(18, error); LocalFree(childSecurity); ExitProcess(18); }
    LocalFree(childSecurity); childSecurity = NULL; childAttributes.lpSecurityDescriptor = NULL;
    if (!confinedChild(child.hProcess)) { recordFailure(27, GetLastError()); endUnexpectedChild(&child); ExitProcess(27); }
    if (!awaitInheritedChildAdmission(child.dwProcessId, &error)) { recordFailure(29, error); endUnexpectedChild(&child); ExitProcess(29); }
    if (ResumeThread(child.hThread) != 1) { recordFailure(28, GetLastError()); endUnexpectedChild(&child); ExitProcess(28); }
    report[9] = child.dwProcessId;
    if (environmentPath(L"LOCALAPPDATA", localAppDataPath) && environmentPath(L"TEMP", tempPath)
        && writeTextReport(L"\\local-app-data-path.txt", localAppDataPath)
        && writeTextReport(L"\\temp-path.txt", tempPath)
        && pathFor(tempPath, L"\\fixture-temp.bin")) {
        file = CreateFileW(filePath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file != INVALID_HANDLE_VALUE) {
            count = 0;
            report[11] = WriteFile(file, workBytes, sizeof(workBytes), &count, NULL) && count == sizeof(workBytes);
            CloseHandle(file);
        }
    }
    if (!pathFor(statePath, L"\\report.bin")) {
        if (!endUnexpectedChild(&child)) ExitProcess(19);
        ExitProcess(20);
    }
    file = CreateFileW(filePath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        if (!endUnexpectedChild(&child)) ExitProcess(21);
        ExitProcess(22);
    }
    count = 0;
    wrote = WriteFile(file, report, sizeof(report), &count, NULL) && count == sizeof(report);
    CloseHandle(file);
    if (!wrote) {
        if (!endUnexpectedChild(&child)) ExitProcess(23);
        ExitProcess(24);
    }
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    ExitProcess(0);
}
