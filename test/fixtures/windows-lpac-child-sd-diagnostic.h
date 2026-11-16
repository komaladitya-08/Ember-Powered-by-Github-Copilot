/* Observational only: map copies of the supplied child DACL, never its launch descriptor or token.
 * MS-DTYP 2.4.3: Access Check does not map generic rights inside ACEs. This is not a process-creation proof.
 * Included after experimental-windows-lpac.c; no CRT, asynchronous I/O, heap allocation, impersonation or retry.
 */
#ifndef EMBER_WINDOWS_LPAC_CHILD_SD_DIAGNOSTIC_H
#define EMBER_WINDOWS_LPAC_CHILD_SD_DIAGNOSTIC_H

#include <stddef.h>

#define SD_ACCESS_BUFFER_BYTES 4096u
#define SD_ACCESS_WORDS 20u

static DWORD sdAccessRecord[SD_ACCESS_WORDS];
static ULONGLONG sdAccessOwnerBuffer[SD_ACCESS_BUFFER_BYTES / sizeof(ULONGLONG)];
static ULONGLONG sdAccessGroupBuffer[SD_ACCESS_BUFFER_BYTES / sizeof(ULONGLONG)];
static ULONGLONG sdAccessProcessAcl[SD_ACCESS_BUFFER_BYTES / sizeof(ULONGLONG)];
static ULONGLONG sdAccessThreadAcl[SD_ACCESS_BUFFER_BYTES / sizeof(ULONGLONG)];
static ULONGLONG sdAccessPrivileges[SD_ACCESS_BUFFER_BYTES / sizeof(ULONGLONG)];
static SECURITY_DESCRIPTOR sdAccessProcessDescriptor, sdAccessThreadDescriptor;
static BOOL sdAccessAttempted;
typedef char sdAccessFixedReportSize[(sizeof(sdAccessRecord) == 80) ? 1 : -1];

/* Volatile byte loops cannot become an undeclared CRT copy/fill or leave sensitive buffers unwiped. */
static void sdAccessCopy(void *target, const void *source, DWORD bytes)
{
    volatile BYTE *to = (volatile BYTE *)target;
    const volatile BYTE *from = (const volatile BYTE *)source;
    while (bytes--) *to++ = *from++;
}

static void sdAccessWipe(void *target, DWORD bytes)
{
    volatile BYTE *to = (volatile BYTE *)target;
    while (bytes--) *to++ = 0;
}

static BOOL sdAccessInvalid(DWORD error)
{
    SetLastError(error);
    return FALSE;
}

/* Only follow a SID wholly inside the successful query/ACE buffer, including its bounded authority array. */
static BOOL sdAccessSidWithin(const void *buffer, DWORD bytes, PSID sid, DWORD minimumOffset)
{
    ULONG_PTR start = (ULONG_PTR)buffer, pointer = (ULONG_PTR)sid, offset;
    const BYTE *data;
    DWORD length;
    if (sid == NULL || pointer < start || (pointer & 3u) != 0) return sdAccessInvalid(ERROR_INVALID_SID);
    offset = pointer - start;
    if (offset < minimumOffset || offset > bytes || bytes - (DWORD)offset < 8u) return sdAccessInvalid(ERROR_INVALID_SID);
    data = (const BYTE *)sid;
    if (data[0] != SID_REVISION || data[1] > SID_MAX_SUB_AUTHORITIES) return sdAccessInvalid(ERROR_INVALID_SID);
    length = 8u + 4u * (DWORD)data[1];
    if (length > bytes - (DWORD)offset || !IsValidSid(sid) || GetLengthSid(sid) != length) return sdAccessInvalid(ERROR_INVALID_SID);
    return TRUE;
}

static BOOL sdAccessQuerySid(HANDLE token, TOKEN_INFORMATION_CLASS source, void *buffer, PSID *sid)
{
    DWORD returned = 0;
    if (!GetTokenInformation(token, source, buffer, SD_ACCESS_BUFFER_BYTES, &returned)) return FALSE;
    if (returned < sizeof(void *) + 8u || returned > SD_ACCESS_BUFFER_BYTES) return sdAccessInvalid(ERROR_INVALID_DATA);
    if (source == TokenOwner) *sid = ((TOKEN_OWNER *)buffer)->Owner;
    else if (source == TokenPrimaryGroup) *sid = ((TOKEN_PRIMARY_GROUP *)buffer)->PrimaryGroup;
    else return sdAccessInvalid(ERROR_INVALID_PARAMETER);
    return sdAccessSidWithin(buffer, returned, *sid, (DWORD)sizeof(void *));
}

/* The fixed source constructs three non-inheriting allow ACEs, each with GA and no other mask bits.
 * Preserve every ACL/SID byte and its order; normalize only those copied mask DWORDs.
 */
static BOOL sdAccessDaclCopy(void *buffer, DWORD allAccess, PSID owner, PSID group, SECURITY_DESCRIPTOR *descriptor)
{
    PSECURITY_DESCRIPTOR supplied = childAttributes.lpSecurityDescriptor;
    PACL original = NULL, copied = (PACL)buffer;
    PVOID rawAce = NULL;
    ACCESS_ALLOWED_ACE *ace;
    SECURITY_DESCRIPTOR_CONTROL control;
    GENERIC_MAPPING mapping = { 0, 0, 0, 0 };
    DWORD revision = 0, suppliedBytes, index, sidBytes;
    ULONG_PTR start, pointer, offset;
    BOOL present = FALSE, defaulted = FALSE;
    if (childAttributes.nLength != sizeof(childAttributes) || childAttributes.bInheritHandle != FALSE || supplied == NULL ||
        !IsValidSecurityDescriptor(supplied)) return sdAccessInvalid(ERROR_INVALID_SECURITY_DESCR);
    if (!GetSecurityDescriptorControl(supplied, &control, &revision)) return FALSE;
    if (revision != SECURITY_DESCRIPTOR_REVISION || !(control & SE_SELF_RELATIVE) || !(control & SE_DACL_PROTECTED) ||
        (control & (SE_SACL_PRESENT | SE_DACL_DEFAULTED | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_AUTO_INHERITED)))
        return sdAccessInvalid(ERROR_INVALID_SECURITY_DESCR);
    suppliedBytes = GetSecurityDescriptorLength(supplied);
    if (suppliedBytes < SECURITY_DESCRIPTOR_MIN_LENGTH || suppliedBytes > SD_ACCESS_BUFFER_BYTES)
        return sdAccessInvalid(ERROR_INVALID_SECURITY_DESCR);
    if (!GetSecurityDescriptorDacl(supplied, &present, &original, &defaulted)) return FALSE;
    if (!present || original == NULL || defaulted) return sdAccessInvalid(ERROR_INVALID_ACL);
    start = (ULONG_PTR)supplied; pointer = (ULONG_PTR)original;
    if (pointer < start) return sdAccessInvalid(ERROR_INVALID_ACL);
    offset = pointer - start;
    if (offset > suppliedBytes || suppliedBytes - (DWORD)offset < sizeof(ACL) ||
        original->AclSize < sizeof(ACL) || original->AclSize > suppliedBytes - (DWORD)offset ||
        original->AclSize > SD_ACCESS_BUFFER_BYTES || original->AceCount != 3 || !IsValidAcl(original))
        return sdAccessInvalid(ERROR_INVALID_ACL);
    sdAccessCopy(copied, original, original->AclSize);
    mapping.GenericAll = allAccess;
    for (index = 0; index < copied->AceCount; index++) {
        if (!GetAce(copied, index, &rawAce)) return FALSE;
        start = (ULONG_PTR)copied; pointer = (ULONG_PTR)rawAce;
        if (pointer < start) return sdAccessInvalid(ERROR_INVALID_ACL);
        offset = pointer - start;
        if (offset < sizeof(ACL) || offset > copied->AclSize || copied->AclSize - (DWORD)offset < sizeof(ACE_HEADER))
            return sdAccessInvalid(ERROR_INVALID_ACL);
        ace = (ACCESS_ALLOWED_ACE *)rawAce;
        if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags != 0 ||
            ace->Header.AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8u ||
            ace->Header.AceSize > copied->AclSize - (DWORD)offset || ace->Mask != GENERIC_ALL)
            return sdAccessInvalid(ERROR_INVALID_ACL);
        if (!sdAccessSidWithin(ace, ace->Header.AceSize, (PSID)&ace->SidStart, (DWORD)offsetof(ACCESS_ALLOWED_ACE, SidStart))) return FALSE;
        sidBytes = GetLengthSid((PSID)&ace->SidStart);
        if (ace->Header.AceSize != offsetof(ACCESS_ALLOWED_ACE, SidStart) + sidBytes) return sdAccessInvalid(ERROR_INVALID_ACL);
        MapGenericMask(&ace->Mask, &mapping);
        if (ace->Mask != allAccess || (ace->Mask & (GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | GENERIC_ALL)))
            return sdAccessInvalid(ERROR_INVALID_ACL);
    }
    if (!IsValidAcl(copied)) return sdAccessInvalid(ERROR_INVALID_ACL);
    if (!InitializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(descriptor, owner, FALSE) || !SetSecurityDescriptorGroup(descriptor, group, FALSE) ||
        !SetSecurityDescriptorDacl(descriptor, TRUE, copied, FALSE) ||
        !SetSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) return FALSE;
    return IsValidSecurityDescriptor(descriptor) ? TRUE : sdAccessInvalid(ERROR_INVALID_SECURITY_DESCR);
}

static void sdAccessCheck(HANDLE token, SECURITY_DESCRIPTOR *descriptor, DWORD allAccess, DWORD *output)
{
    GENERIC_MAPPING mapping = { 0, 0, 0, 0 };
    DWORD desired = GENERIC_ALL, granted = 0, privilegeBytes = SD_ACCESS_BUFFER_BYTES;
    BOOL allowed = FALSE, checked;
    mapping.GenericAll = allAccess;
    MapGenericMask(&desired, &mapping);
    output[0] = desired;
    sdAccessWipe(sdAccessPrivileges, sizeof(sdAccessPrivileges));
    checked = AccessCheck(descriptor, token, desired, &mapping, (PPRIVILEGE_SET)sdAccessPrivileges,
                          &privilegeBytes, &granted, &allowed);
    if (!checked) {
        output[1] = 0; output[2] = 0; output[3] = 0; output[4] = GetLastError();
    } else {
        output[1] = 1; output[2] = allowed ? 1u : 0u; output[3] = granted; output[4] = 0;
    }
    sdAccessWipe(sdAccessPrivileges, sizeof(sdAccessPrivileges));
}

static __declspec(noreturn) void sdAccessCloseUncertain(DWORD error)
{
    recordFailure(31, error);
    ExitProcess(31);
}

static void writeChildSdAccessDiagnostic(void)
{
    HANDLE primary = NULL, duplicate = NULL, writer;
    PSID owner = NULL, group = NULL;
    DWORD error = 0, written = 0, closeError = 0;
    BOOL complete = FALSE, closeFailed = FALSE, wrote;
    if (sdAccessAttempted) ExitProcess(33);
    sdAccessAttempted = TRUE;
    sdAccessWipe(sdAccessRecord, sizeof(sdAccessRecord));
    sdAccessRecord[0] = 0x44435345u; sdAccessRecord[1] = 1; sdAccessRecord[2] = 1;
    sdAccessRecord[4] = PROCESS_ALL_ACCESS; sdAccessRecord[9] = THREAD_ALL_ACCESS;
    sdAccessRecord[2] = 2;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &primary)) { error = GetLastError(); goto cleanup; }
    sdAccessRecord[2] = 3;
    if (!sdAccessQuerySid(primary, TokenOwner, sdAccessOwnerBuffer, &owner)) { error = GetLastError(); goto cleanup; }
    sdAccessRecord[14] = 4;
    sdAccessRecord[2] = 4;
    if (!sdAccessQuerySid(primary, TokenPrimaryGroup, sdAccessGroupBuffer, &group)) { error = GetLastError(); goto cleanup; }
    sdAccessRecord[15] = 5;
    sdAccessRecord[2] = 5;
    if (!sdAccessDaclCopy(sdAccessProcessAcl, PROCESS_ALL_ACCESS, owner, group, &sdAccessProcessDescriptor)) { error = GetLastError(); goto cleanup; }
    sdAccessRecord[16] |= 1;
    if (!sdAccessDaclCopy(sdAccessThreadAcl, THREAD_ALL_ACCESS, owner, group, &sdAccessThreadDescriptor)) { error = GetLastError(); goto cleanup; }
    sdAccessRecord[16] |= 2;
    sdAccessRecord[2] = 6;
    if (!DuplicateTokenEx(primary, TOKEN_QUERY, NULL, SecurityImpersonation, TokenImpersonation, &duplicate)) { error = GetLastError(); goto cleanup; }
    sdAccessRecord[2] = 7;
    sdAccessCheck(duplicate, &sdAccessProcessDescriptor, PROCESS_ALL_ACCESS, sdAccessRecord + 4);
    sdAccessCheck(duplicate, &sdAccessThreadDescriptor, THREAD_ALL_ACCESS, sdAccessRecord + 9);
    complete = TRUE;
cleanup:
    sdAccessRecord[3] = error;
    /* Attempt each acquired token once. A failed close never yields an access payload or a retry. */
    if (duplicate != NULL) {
        if (!CloseHandle(duplicate)) { closeError = GetLastError(); closeFailed = TRUE; }
        else sdAccessRecord[18] = 1;
    }
    if (primary != NULL) {
        if (!CloseHandle(primary)) { if (!closeFailed) closeError = GetLastError(); closeFailed = TRUE; }
        else sdAccessRecord[17] = 1;
    }
    sdAccessWipe(sdAccessOwnerBuffer, sizeof(sdAccessOwnerBuffer));
    sdAccessWipe(sdAccessGroupBuffer, sizeof(sdAccessGroupBuffer));
    sdAccessWipe(sdAccessProcessAcl, sizeof(sdAccessProcessAcl));
    sdAccessWipe(sdAccessThreadAcl, sizeof(sdAccessThreadAcl));
    sdAccessWipe(sdAccessPrivileges, sizeof(sdAccessPrivileges));
    sdAccessWipe(&sdAccessProcessDescriptor, sizeof(sdAccessProcessDescriptor));
    sdAccessWipe(&sdAccessThreadDescriptor, sizeof(sdAccessThreadDescriptor));
    if (closeFailed) sdAccessCloseUncertain(closeError);
    if (complete) sdAccessRecord[2] = 8;
    if (!pathFor(statePath, L"\\child-sd-access.bin")) ExitProcess(33);
    writer = CreateFileW(filePath, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (writer == INVALID_HANDLE_VALUE) ExitProcess(33);
    wrote = WriteFile(writer, sdAccessRecord, sizeof(sdAccessRecord), &written, NULL);
    if (!wrote || written != sizeof(sdAccessRecord)) {
        if (!CloseHandle(writer)) sdAccessCloseUncertain(GetLastError());
        ExitProcess(33);
    }
    wrote = FlushFileBuffers(writer);
    if (!CloseHandle(writer)) sdAccessCloseUncertain(GetLastError());
    sdAccessWipe(sdAccessRecord, sizeof(sdAccessRecord));
    if (!wrote) ExitProcess(33);
}

#endif
