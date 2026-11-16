/* Linux-only fault logic. The actual fixed source supplies capture/close/terminal code unchanged.
 * Function-section GC omits unrelated WinAPI paths. These mocks establish no Windows ABI/policy result.
 */
#include <setjmp.h>
#include <stdlib.h>
#define main policy_program_main
#include "../windows-child-process-policy.c"
#undef main
static jmp_buf stopped;
static unsigned int mode, closeCalls, writes;
static int bad;
static void check(int ok) { if (!ok) bad=1; }
DWORD GetLastError(void) { return 6; }
DWORD GetCurrentProcessId(void) { return 100; }
void Sleep(DWORD milliseconds) { check(milliseconds==1000); longjmp(stopped,1); }
BOOL SetFilePointerEx(HANDLE file,LARGE_INTEGER offset,LARGE_INTEGER *next,DWORD method) {
  check(file==(HANDLE)(uintptr_t)99 && offset.QuadPart==0 && next==NULL && method==FILE_BEGIN); return TRUE;
}
BOOL WriteFile(HANDLE file,const void *data,DWORD bytes,DWORD *written,void *overlapped) {
  check(file==(HANDLE)(uintptr_t)99 && data==record && bytes==320 && overlapped==NULL); *written=bytes; writes++; return TRUE;
}
BOOL FlushFileBuffers(HANDLE file) { check(file==(HANDLE)(uintptr_t)99); return TRUE; }
BOOL CloseHandle(HANDLE handle) {
  closeCalls++; check(handle==(HANDLE)(uintptr_t)(closeCalls==1?12:11));
  return !((mode==6 && closeCalls==1) || (mode==7 && closeCalls==2));
}
int main(int argc,char **argv) {
  int terminal;
  volatile int result=-1;
  DWORD *a=attempt(0);
  if(argc!=2 || strlen(argv[1])!=1 || argv[1][0]<'0' || argv[1][0]>'9') return 10;
  mode=(unsigned int)(argv[1][0]-'0'); reportFile=(HANDLE)(uintptr_t)99;
  if(mode==1) child.hProcess=(HANDLE)(uintptr_t)11;
  if(mode==2) child.dwProcessId=123;
  if(mode>=3) { child.hProcess=(HANDLE)(uintptr_t)11; child.hThread=(HANDLE)(uintptr_t)12; child.dwProcessId=123; child.dwThreadId=124; }
  if(mode==3) child.hProcess=NULL;
  if(mode==4) child.hThread=child.hProcess;
  if(mode==8) child.hProcess=INVALID_HANDLE_VALUE;
  if(mode==9) child.dwProcessId=100;
  terminal=setjmp(stopped);
  if(!terminal) {
    result=captureCreation(mode>=3,5,a);
    if(result==1) closeCreated(a);
  }
  if(mode==0) check(!terminal && result==0 && closeCalls==0 && writes==0 && a[A_CREATE_ATTEMPT]==1 && a[A_CREATE_OK]==0 && a[A_CREATE_CODE]==5 && a[A_OWNERSHIP]==0);
  else if(mode==5) check(!terminal && result==1 && closeCalls==2 && writes==0 && a[A_CREATE_OK]==1 && a[A_THREAD_CLOSED]==1 && a[A_PROCESS_CLOSED]==1 && a[A_OWNERSHIP]==0 && child.hThread==NULL && child.hProcess==NULL);
  else {
    check(terminal && writes==1 && record[H_STATUS]==UNCERTAIN && a[A_OWNERSHIP]==2);
    check(record[H_TERMINAL]==(mode==6 || mode==7 ? 9u:8u));
    check(closeCalls==(mode==6?1u:mode==7?2u:0u));
    if(mode==6) check(a[A_THREAD_CLOSED]==0 && a[A_PROCESS_CLOSED]==0 && child.hProcess==(HANDLE)(uintptr_t)11);
    if(mode==7) check(a[A_THREAD_CLOSED]==1 && a[A_PROCESS_CLOSED]==0);
  }
  if(bad) return 20;
  printf("{\"schema\":1,\"case\":%u,\"terminal\":%u,\"closeAttempts\":%u,\"checkpointWrites\":%u}\n",mode,terminal?1u:0u,closeCalls,writes);
  return 0;
}
