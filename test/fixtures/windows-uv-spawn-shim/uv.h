/* Test-only observer dependency; it cannot stand in for a libuv or SDK build. */
#ifndef EMBER_UV_SPAWN_TEST_UV_H
#define EMBER_UV_SPAWN_TEST_UV_H
#include "windows.h"
int uv_translate_sys_error(int);
#endif
