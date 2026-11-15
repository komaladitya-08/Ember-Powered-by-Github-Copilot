/*
 * Offline LPAC probe. Build as native C, without a CRT:
 *   cl /nologo /TC /O2 /GS- /Zl experimental-windows-lpac.c /link
 *      /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib
 *
 * This is a disposable fixture, never a production launcher. It receives no credentials and prints nothing.
 * The parent grants only its copied executable, work and state directories. A normal child deliberately remains
 * in the private job after the parent exits, so Stop must observe the entire job rather than just this process.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stddef.h>
#include <sddl.h>

/* Keep compiler-generated aggregate copies/fills from introducing a CRT dependency. */
void * __cdecl memset(void *target, int value, size_t count);
void * __cdecl memcpy(void *target, const void *source, size_t count);
#pragma function(memset)
#pragma function(memcpy)
void * __cdecl memset(void *target, int value, size_t count)
{
    volatile unsigned char *bytes = (volatile unsigned char *)target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}
void * __cdecl memcpy(void *target, const void *source, size_t count)
{
    volatile unsigned char *to = (volatile unsigned char *)target;
    const volatile unsigned char *from = (const volatile unsigned char *)source;
    while (count--) *to++ = *from++;
    return target;
}

#define MAX_CHARS 32768
#define TOKEN_IS_APP_CONTAINER ((TOKEN_INFORMATION_CLASS)29)
#define TOKEN_CAPABILITIES_CLASS ((TOKEN_INFORMATION_CLASS)30)
#define TOKEN_APP_CONTAINER_SID ((TOKEN_INFORMATION_CLASS)31)

static WCHAR selfPath[MAX_CHARS];
static WCHAR commandLine[MAX_CHARS];
static WCHAR statePath[MAX_CHARS];
static WCHAR workPath[MAX_CHARS];
static WCHAR toolsPath[MAX_CHARS];
static WCHAR localAppDataPath[MAX_CHARS];
static WCHAR tempPath[MAX_CHARS];
static WCHAR filePath[MAX_CHARS];
static WCHAR argument[64];
static WCHAR descriptorText[MAX_CHARS];
static ULONGLONG tokenBuffer[128];
static ULONGLONG privilegeBuffer[128];
static ULONGLONG defaultAclBuffer[256];
static ULONGLONG parentSidBuffer[128];
static ULONGLONG childSidBuffer[128];
static DWORD report[12];
static PSECURITY_DESCRIPTOR childSecurity;
static SECURITY_ATTRIBUTES childAttributes;
typedef LONG (WINAPI *LAST_NT_STATUS)(void);
static LAST_NT_STATUS getLastNtStatus;
static DWORD childNtStatus;
static const BYTE workBytes[] = { 'l', 'p', 'a', 'c', '-', 'f', 'i', 'x', 't', 'u', 'r', 'e' };

static DWORD lengthOf(const WCHAR *text)
{
    DWORD length = 0;
    while (text[length]) length++;
    return length;
}

static BOOL append(WCHAR *target, const WCHAR *text)
{
    DWORD used = lengthOf(target), extra = lengthOf(text), i;
    if (used >= MAX_CHARS || extra >= MAX_CHARS || used + extra >= MAX_CHARS) return FALSE;
    for (i = 0; i <= extra; i++) target[used + i] = text[i];
    return TRUE;
}

static BOOL pathFor(const WCHAR *directory, const WCHAR *suffix)
{
    filePath[0] = 0;
    return append(filePath, directory) && append(filePath, suffix);
}

/* The launcher supplies exactly one argument, a decimal host PID. Child mode uses the literal word child. */
static BOOL readArgument(void)
{
    const WCHAR *cursor = GetCommandLineW();
    BOOL quoted = FALSE;
    DWORD count = 0;
    while (*cursor) {
        if (*cursor == L'"') quoted = !quoted;
        else if (!quoted && (*cursor == L' ' || *cursor == L'\t')) break;
        cursor++;
    }
    if (quoted) return FALSE;
    while (*cursor == L' ' || *cursor == L'\t') cursor++;
    if (!*cursor) return FALSE;
    quoted = FALSE;
    while (*cursor) {
        if (*cursor == L'"') quoted = !quoted;
        else {
            if (!quoted && (*cursor == L' ' || *cursor == L'\t')) break;
            if (count + 1 >= (DWORD)(sizeof(argument) / sizeof(argument[0]))) return FALSE;
            argument[count++] = *cursor;
        }
        cursor++;
    }
    argument[count] = 0;
    if (quoted || count == 0) return FALSE;
    while (*cursor == L' ' || *cursor == L'\t') cursor++;
    return *cursor == 0;
}

static BOOL childArgument(void)
{
    static const WCHAR expected[] = L"child";
    DWORD i = 0;
    while (argument[i] && argument[i] == expected[i]) i++;
    return argument[i] == 0 && expected[i] == 0;
}

static DWORD hostPid(void)
{
    DWORD value = 0, digit, i = 0;
    while (argument[i]) {
        if (argument[i] < L'0' || argument[i] > L'9') return 0;
        digit = (DWORD)(argument[i++] - L'0');
        if (value > (MAXDWORD - digit) / 10) return 0;
        value = value * 10 + digit;
    }
    return value;
}

static BOOL environmentPath(const WCHAR *name, WCHAR *output)
{
    DWORD count = GetEnvironmentVariableW(name, output, MAX_CHARS);
    return count > 0 && count < MAX_CHARS;
}

static BOOL writeTextReport(const WCHAR *suffix, const WCHAR *text)
{
    HANDLE file;
    DWORD written = 0, bytes = lengthOf(text) * sizeof(WCHAR);
    BOOL result;
    if (!pathFor(statePath, suffix)) return FALSE;
    file = CreateFileW(filePath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return FALSE;
    result = WriteFile(file, text, bytes, &written, NULL) && written == bytes;
    CloseHandle(file);
    return result;
}

/* Read-only test of the token's defaults for future kernel objects. This does not change any token or object. */
static void defaultDaclDiagnostic(DWORD *output)
{
    HANDLE token = NULL, duplicate = NULL;
    SECURITY_DESCRIPTOR descriptor;
    GENERIC_MAPPING mapping = { READ_CONTROL, READ_CONTROL, SYNCHRONIZE, 0x1fffff };
    DWORD bytes = 0, privilegeBytes = sizeof(privilegeBuffer), granted = 0;
    BOOL allowed = FALSE, checked;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &token)) goto failed;
    if (!GetTokenInformation(token, TokenDefaultDacl, defaultAclBuffer, sizeof(defaultAclBuffer), &bytes)) goto failed;
    if (!GetTokenInformation(token, TokenUser, tokenBuffer, sizeof(tokenBuffer), &bytes)) goto failed;
    if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION)
        || !SetSecurityDescriptorOwner(&descriptor, ((TOKEN_USER *)tokenBuffer)->User.Sid, FALSE)
        || !SetSecurityDescriptorGroup(&descriptor, ((TOKEN_USER *)tokenBuffer)->User.Sid, FALSE)
        || !SetSecurityDescriptorDacl(&descriptor, TRUE, ((TOKEN_DEFAULT_DACL *)defaultAclBuffer)->DefaultDacl, FALSE)
        || !DuplicateTokenEx(token, TOKEN_QUERY, NULL, SecurityImpersonation, TokenImpersonation, &duplicate)) goto failed;
    checked = AccessCheck(&descriptor, duplicate, MAXIMUM_ALLOWED, &mapping, (PPRIVILEGE_SET)privilegeBuffer,
                          &privilegeBytes, &granted, &allowed);
    output[0] = checked; output[1] = allowed; output[2] = granted;
    if (!checked) output[3] = GetLastError();
    goto cleanup;
failed:
    output[3] = GetLastError();
cleanup:
    if (duplicate != NULL) CloseHandle(duplicate);
    if (token != NULL) CloseHandle(token);
}

static void recordFailure(DWORD stage, DWORD error)
{
    DWORD diagnostic[25], written = 0, i, policy = 0;
    HANDLE file, probe;
    for (i = 0; i < 25; i++) diagnostic[i] = 0;
    diagnostic[0] = stage; diagnostic[1] = error;
    for (i = 0; i < 12; i++) diagnostic[i + 2] = report[i];
    probe = CreateFileW(selfPath, GENERIC_READ | GENERIC_EXECUTE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    diagnostic[14] = probe != INVALID_HANDLE_VALUE;
    if (probe != INVALID_HANDLE_VALUE) CloseHandle(probe); else diagnostic[15] = GetLastError();
    probe = OpenProcess(PROCESS_CREATE_PROCESS, FALSE, GetCurrentProcessId());
    diagnostic[16] = probe != NULL;
    if (probe != NULL) CloseHandle(probe); else diagnostic[17] = GetLastError();
    if (GetProcessMitigationPolicy(GetCurrentProcess(), (PROCESS_MITIGATION_POLICY)13, &policy, sizeof(policy))) diagnostic[18] = policy;
    else { diagnostic[18] = MAXDWORD; diagnostic[19] = GetLastError(); }
    defaultDaclDiagnostic(diagnostic + 20);
    diagnostic[24] = childNtStatus;
    if (!pathFor(statePath, L"\\failure.bin")) return;
    file = CreateFileW(filePath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    WriteFile(file, diagnostic, sizeof(diagnostic), &written, NULL);
    CloseHandle(file);
}

static BOOL tokenFlag(HANDLE token, TOKEN_INFORMATION_CLASS informationClass)
{
    DWORD value = 0, bytes = 0;
    return GetTokenInformation(token, informationClass, &value, sizeof(value), &bytes)
        && bytes == sizeof(value) && value == 1;
}

/* A query error is never a denial witness. Owner and group are required by AccessCheck. */
static BOOL checkedAccess(HANDLE token, const WCHAR *userSid, const WCHAR *packageSid, BOOL expected)
{
    PSECURITY_DESCRIPTOR descriptor = NULL;
    GENERIC_MAPPING mapping = { 1, 2, 4, 7 };
    DWORD bytes = sizeof(privilegeBuffer), granted = 0;
    BOOL allowed = FALSE, result;
    descriptorText[0] = 0;
    if (!append(descriptorText, L"O:SYG:SYD:P(A;;0x1;;;") || !append(descriptorText, userSid)
        || !append(descriptorText, L")(A;;0x1;;;") || !append(descriptorText, packageSid)
        || !append(descriptorText, L")")) return FALSE;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptorText, SDDL_REVISION_1, &descriptor, NULL)) return FALSE;
    result = AccessCheck(descriptor, token, 1, &mapping, (PPRIVILEGE_SET)privilegeBuffer, &bytes, &granted, &allowed);
    LocalFree(descriptor);
    return result && (expected ? (allowed && granted == 1) : (!allowed && granted == 0));
}

/* LPAC creation opts out of ALL APPLICATION PACKAGES. Observe that behavior against an own-package control,
 * rather than using unsupported Win32 token class 46. This does not claim a formal LPAC identity-query contract. */
static BOOL packageAccessWitness(HANDLE token)
{
    HANDLE duplicate = NULL;
    LPWSTR userSid = NULL, packageSid = NULL;
    DWORD bytes = 0;
    BOOL result = FALSE;
    if (!GetTokenInformation(token, TokenUser, tokenBuffer, sizeof(tokenBuffer), &bytes)
        || !ConvertSidToStringSidW(((TOKEN_USER *)tokenBuffer)->User.Sid, &userSid)) goto cleanup;
    if (!GetTokenInformation(token, TOKEN_APP_CONTAINER_SID, tokenBuffer, sizeof(tokenBuffer), &bytes)
        || !ConvertSidToStringSidW(*(PSID *)tokenBuffer, &packageSid)) goto cleanup;
    if (!DuplicateTokenEx(token, TOKEN_QUERY, NULL, SecurityImpersonation, TokenImpersonation, &duplicate)) goto cleanup;
    result = checkedAccess(duplicate, userSid, packageSid, TRUE)
        && checkedAccess(duplicate, userSid, L"S-1-15-2-1", FALSE);
cleanup:
    if (duplicate != NULL) CloseHandle(duplicate);
    if (packageSid != NULL) LocalFree(packageSid);
    if (userSid != NULL) LocalFree(userSid);
    return result;
}

/* Do not rely on the token's default DACL when creating NEW private process/thread kernel objects.
 * The kernel supplies their owner/group from this token; only this user, SYSTEM and this package get access. */
static BOOL prepareChildSecurity(HANDLE token)
{
    LPWSTR userSid = NULL, packageSid = NULL;
    DWORD bytes = 0;
    BOOL result = FALSE;
    if (!GetTokenInformation(token, TokenUser, tokenBuffer, sizeof(tokenBuffer), &bytes)
        || !ConvertSidToStringSidW(((TOKEN_USER *)tokenBuffer)->User.Sid, &userSid)) goto cleanup;
    if (!GetTokenInformation(token, TOKEN_APP_CONTAINER_SID, parentSidBuffer, sizeof(parentSidBuffer), &bytes)
        || !ConvertSidToStringSidW(*(PSID *)parentSidBuffer, &packageSid)) goto cleanup;
    descriptorText[0] = 0;
    if (!append(descriptorText, L"D:P(A;;GA;;;") || !append(descriptorText, userSid)
        || !append(descriptorText, L")(A;;GA;;;SY)(A;;GA;;;") || !append(descriptorText, packageSid)
        || !append(descriptorText, L")")) goto cleanup;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptorText, SDDL_REVISION_1, &childSecurity, NULL)) goto cleanup;
    childAttributes.nLength = sizeof(childAttributes);
    childAttributes.lpSecurityDescriptor = childSecurity;
    childAttributes.bInheritHandle = FALSE;
    result = TRUE;
cleanup:
    if (packageSid != NULL) LocalFree(packageSid);
    if (userSid != NULL) LocalFree(userSid);
    return result;
}

/* Each right is tested separately; a combined mask could hide one unexpectedly permitted operation. */
static BOOL processRightDenied(DWORD right, DWORD processId)
{
    HANDLE process = OpenProcess(right, FALSE, processId);
    DWORD error = GetLastError();
    if (process != NULL) CloseHandle(process);
    return process == NULL && error == ERROR_ACCESS_DENIED;
}

static BOOL spawnChild(DWORD flags, PROCESS_INFORMATION *process, DWORD *error)
{
    STARTUPINFOEXW startup;
    SECURITY_CAPABILITIES capabilities;
    SIZE_T bytes = 0;
    DWORD policy = 1;
    BOOL created;
    memset(&startup, 0, sizeof(startup));
    memset(&capabilities, 0, sizeof(capabilities));
    capabilities.AppContainerSid = *(PSID *)parentSidBuffer;
    memset(process, 0, sizeof(*process));
    startup.StartupInfo.cb = sizeof(startup);
    commandLine[0] = 0;
    if (!append(commandLine, L"\"") || !append(commandLine, selfPath) || !append(commandLine, L"\" child")) {
        *error = ERROR_FILENAME_EXCED_RANGE;
        return FALSE;
    }
    if (InitializeProcThreadAttributeList(NULL, 2, 0, &bytes) || GetLastError() != ERROR_INSUFFICIENT_BUFFER
        || bytes == 0 || bytes > 65536) { *error = ERROR_INVALID_DATA; return FALSE; }
    startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)LocalAlloc(LPTR, bytes);
    if (startup.lpAttributeList == NULL) { *error = ERROR_NOT_ENOUGH_MEMORY; return FALSE; }
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &bytes)) {
        *error = GetLastError(); LocalFree(startup.lpAttributeList); return FALSE;
    }
    /* Repeat the documented LPAC launch attributes with this exact parent package and no capabilities. */
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &capabilities, sizeof(capabilities), NULL, NULL)
        || !UpdateProcThreadAttribute(startup.lpAttributeList, 0, (DWORD_PTR)0x2000f, &policy, sizeof(policy), NULL, NULL)) {
        *error = GetLastError(); DeleteProcThreadAttributeList(startup.lpAttributeList); LocalFree(startup.lpAttributeList); return FALSE;
    }
    created = CreateProcessW(selfPath, commandLine, &childAttributes, &childAttributes, FALSE,
                             flags | CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                             NULL, NULL, &startup.StartupInfo, process);
    *error = created ? ERROR_SUCCESS : GetLastError();
    childNtStatus = created ? 0 : getLastNtStatus ? (DWORD)getLastNtStatus() : MAXDWORD;
    DeleteProcThreadAttributeList(startup.lpAttributeList); LocalFree(startup.lpAttributeList);
    return created;
}

/* The ordinary child must retain this exact package, zero capabilities and the AAP denial before its first instruction. */
static BOOL confinedChild(HANDLE process)
{
    HANDLE parent = NULL, child = NULL;
    DWORD bytes = 0;
    BOOL result = FALSE;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &parent)
        || !OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &child)) goto cleanup;
    if (!tokenFlag(child, TOKEN_IS_APP_CONTAINER)
        || !GetTokenInformation(parent, TOKEN_APP_CONTAINER_SID, parentSidBuffer, sizeof(parentSidBuffer), &bytes)
        || !GetTokenInformation(child, TOKEN_APP_CONTAINER_SID, childSidBuffer, sizeof(childSidBuffer), &bytes)
        || *(PSID *)parentSidBuffer == NULL || *(PSID *)childSidBuffer == NULL
        || !EqualSid(*(PSID *)parentSidBuffer, *(PSID *)childSidBuffer)
        || !GetTokenInformation(child, TOKEN_CAPABILITIES_CLASS, tokenBuffer, sizeof(tokenBuffer), &bytes)
        || bytes < sizeof(DWORD) || *(DWORD *)tokenBuffer != 0) goto cleanup;
    result = packageAccessWitness(child);
cleanup:
    if (child != NULL) CloseHandle(child);
    if (parent != NULL) CloseHandle(parent);
    return result;
}

static BOOL endUnexpectedChild(PROCESS_INFORMATION *process)
{
    BOOL ended;
    if (WaitForSingleObject(process->hProcess, 0) != WAIT_OBJECT_0)
        TerminateProcess(process->hProcess, 125);
    ended = WaitForSingleObject(process->hProcess, 5000) == WAIT_OBJECT_0;
    CloseHandle(process->hThread);
    CloseHandle(process->hProcess);
    return ended;
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

    if (spawnChild(CREATE_BREAKAWAY_FROM_JOB, &unexpected, &error)) {
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

    if (!spawnChild(0, &child, &error)) { recordFailure(18, error); LocalFree(childSecurity); ExitProcess(18); }
    LocalFree(childSecurity); childSecurity = NULL; childAttributes.lpSecurityDescriptor = NULL;
    if (!confinedChild(child.hProcess)) { recordFailure(27, GetLastError()); endUnexpectedChild(&child); ExitProcess(27); }
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
