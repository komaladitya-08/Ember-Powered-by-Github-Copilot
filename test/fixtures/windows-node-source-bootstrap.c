/* Inert setup image for the existing 16MiB fixture constructor. The launcher must redirect to the verified Node PE. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
void mainCRTStartup(void) { ExitProcess(101); }
