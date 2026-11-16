#ifndef EMBER_RNG_TEST_WINCRYPT_H
#define EMBER_RNG_TEST_WINCRYPT_H
#include "windows.h"
#define PROV_RSA_FULL 1
#define CRYPT_VERIFYCONTEXT 0xf0000000u
#define CRYPT_SILENT 0x40u
BOOL CryptAcquireContextW(HCRYPTPROV *, const WCHAR *, const WCHAR *, DWORD, DWORD);
BOOL CryptGenRandom(HCRYPTPROV, DWORD, BYTE *);
BOOL CryptReleaseContext(HCRYPTPROV, DWORD);
#endif
