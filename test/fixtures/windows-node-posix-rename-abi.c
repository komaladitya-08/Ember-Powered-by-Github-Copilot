/* Compile only: the actual pinned adapter must fit both libuv's Win8 target and the Win10RS1 SDK ABI. */
#include <assert.h>
#include <stddef.h>
#include <string.h>
#if !defined(__STDC_VERSION__) || __STDC_VERSION__ != 201112L
#error The ABI probe requires ISO C11.
#endif
#ifndef static_assert
#error The real assert.h C11 static_assert macro is required.
#endif
static_assert(__STDC_VERSION__ == 201112L, "The ABI probe requires standard C11 assertions.");
#include "uv.h"
#include "uv-common.h"

#define SET_REQ_RESULT(req, value) do { (req)->result = (value); assert((req)->result != -1); } while (0)
#define SET_REQ_WIN32_ERROR(req, error) do { (req)->sys_errno_ = (error); (req)->result = uv_translate_sys_error((req)->sys_errno_); } while (0)
#define SET_REQ_UV_ERROR(req, error, system) do { (req)->result = (error); (req)->sys_errno_ = (system); } while (0)
#include "node-posix-adapter.inc"

#if defined(EMBER_POSIX_ABI_SDK) && EMBER_POSIX_ABI_SDK == 1
STATIC_ASSERT(sizeof(uv__fs_rename_info_ex_t) == sizeof(FILE_RENAME_INFO));
STATIC_ASSERT(offsetof(uv__fs_rename_info_ex_t, Flags) == offsetof(FILE_RENAME_INFO, Flags));
STATIC_ASSERT(offsetof(uv__fs_rename_info_ex_t, RootDirectory) == offsetof(FILE_RENAME_INFO, RootDirectory));
STATIC_ASSERT(offsetof(uv__fs_rename_info_ex_t, FileNameLength) == offsetof(FILE_RENAME_INFO, FileNameLength));
STATIC_ASSERT(offsetof(uv__fs_rename_info_ex_t, FileName) == offsetof(FILE_RENAME_INFO, FileName));
STATIC_ASSERT(UV__FS_RENAME_INFO_EX == 22);
STATIC_ASSERT(FileRenameInfoEx == 22);
STATIC_ASSERT(UV__FS_RENAME_REPLACE_POSIX == (FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS));
#endif

/* No executable or entry point is linked or run. Referencing the actual adapter also compiles its complete body. */
void ember_node_posix_rename_compile_only(uv_fs_t* request) {
  fs__rename(request);
}
