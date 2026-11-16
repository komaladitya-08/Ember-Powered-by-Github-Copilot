/* Test-only control dependency; no libuv or SDK build is established by this declaration. */
#ifndef EMBER_UV_OBSERVER_ABI_TEST_UV_H
#define EMBER_UV_OBSERVER_ABI_TEST_UV_H
#include "windows.h"
int uv_translate_sys_error(int);
#endif
