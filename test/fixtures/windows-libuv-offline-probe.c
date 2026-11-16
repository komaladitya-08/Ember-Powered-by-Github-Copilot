/*
 * Fixed libuv initialization feasibility probe, never a project-code runner or an offline-runtime boundary.
 * Compile with the pinned libuv headers/static library and /MT. The build recipe owns the one libuv call omission;
 * EMBER_UV_FIXED_PROBE_OFFLINE records its identity only and does not alter this program's operations.
 * No stdout/stderr, arbitrary arguments, supplied code, networking API or dynamically selected library is used.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <uv.h>
#include <windows.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

#ifndef EMBER_UV_FIXED_PROBE_OFFLINE
#error Define EMBER_UV_FIXED_PROBE_OFFLINE explicitly as 0 (stock) or 1 (separate offline probe).
#endif
#if EMBER_UV_FIXED_PROBE_OFFLINE != 0 && EMBER_UV_FIXED_PROBE_OFFLINE != 1
#error Invalid fixed probe build identity.
#endif

#define PROBE_PATH_CHARS 32768
#define PROBE_PATH_BYTES (PROBE_PATH_CHARS * 3)
#define PROBE_WORDS 24
#define PROBE_MAGIC 0x50565545u
#define PROBE_UNOBSERVED 0xffffffffu
#define TOKEN_IS_APP_CONTAINER ((TOKEN_INFORMATION_CLASS)29)

enum {
  R_MAGIC, R_VERSION, R_BUILD, R_TOKEN, R_STAGE, R_STATUS, R_DOMAIN, R_ERROR,
  R_FEATURES, R_SYNC_BYTES, R_ASYNC_BYTES, R_FS_CALLBACKS, R_TIMER_CALLBACKS,
  R_TIMER_CLOSED, R_WORK_CALLBACKS, R_AFTER_WORK, R_THREAD_CALLBACKS, R_THREAD_JOINED,
  R_LOOP_INIT, R_LOOP_RUN, R_LOOP_CLOSE, R_CLEANUP, R_CHECKPOINT, R_RESERVED
};
enum { STATUS_RUNNING = 0, STATUS_COMPLETE = 1, STATUS_FAILED = 2 };
enum { DOMAIN_NONE = 0, DOMAIN_WIN32 = 1, DOMAIN_UV = 2, DOMAIN_CONTRACT = 3, DOMAIN_CLEANUP = 4 };
enum { FEATURE_SYNC = 1, FEATURE_ASYNC = 2, FEATURE_TIMER = 4, FEATURE_WORK = 8, FEATURE_THREAD = 16, FEATURE_LOOP = 32 };
/* Every created file descriptor is invalidated before its single close attempt. */
enum { CLEAN_FILE_CREATED = 1, CLEAN_ALL_FDS_CLOSED = 2, CLEAN_FILE_REMOVED = 4, CLEAN_LOOP_CLOSED = 8 };
enum {
  CONTRACT_SHORT_WRITE = 1001, CONTRACT_WRONG_READ = 1002, CONTRACT_NOT_EOF = 1003,
  CONTRACT_CALLBACKS = 1004, CONTRACT_WORK_RESULT = 1005, CONTRACT_THREAD_RESULT = 1006,
  CONTRACT_LOOP_ALIVE = 1007, CONTRACT_REPORT_SHORT_WRITE = 1008, CONTRACT_REPORT_FILE = 1009
};

static const char payload[] = "EMBER_LIBUV_LOCAL_PROBE\n";
static const DWORD payloadBytes = (DWORD)(sizeof(payload) - 1);
static DWORD record[PROBE_WORDS];
static HANDLE reportFile = INVALID_HANDLE_VALUE;
static int reportBroken;
static WCHAR workPath[PROBE_PATH_CHARS], statePath[PROBE_PATH_CHARS];
static WCHAR filePath[PROBE_PATH_CHARS], reportPath[PROBE_PATH_CHARS];
static char fileUtf8[PROBE_PATH_BYTES];
static char syncBytes[sizeof(payload)], asyncBytes[sizeof(payload)];
static uv_loop_t loop;
static uv_timer_t timer;
static uv_work_t work;
static uv_fs_t asyncRead;
static uv_buf_t asyncBuffer;
static uv_thread_t thread;
static uv_file openFile = -1;
static int loopReady, timerReady, timerClosing, readPending, workPending, threadReady, fdUncertain;
static volatile LONG workCallbacks, threadCallbacks, workResult, threadResult;

typedef char record_must_be_exactly_96_bytes[(sizeof(record) == 96) ? 1 : -1];

static void fail(DWORD domain, int64_t code)
{
  if (record[R_STATUS] != STATUS_FAILED) {
    record[R_DOMAIN] = domain;
    record[R_ERROR] = (DWORD)(uint32_t)code;
  }
  record[R_STATUS] = STATUS_FAILED;
}

static DWORD fixedChecksum(void)
{
  DWORD value = 2166136261u;
  size_t index;
  for (index = 0; index < sizeof(payload) - 1; index++) value = (value ^ (BYTE)payload[index]) * 16777619u;
  return value;
}

/* No untrusted pathname or argument is accepted. These are exact host-owned scratch environment values. */
static int localDirectory(const WCHAR *name, WCHAR *output, DWORD *nativeError)
{
  DWORD count = GetEnvironmentVariableW(name, output, PROBE_PATH_CHARS);
  DWORD index, start = 3, attributes, driveType;
  WCHAR drive[4];
  if (count == 0) return 1;
  if (count < 4 || count >= PROBE_PATH_CHARS) return 2;
  if (
      !((output[0] >= L'A' && output[0] <= L'Z') || (output[0] >= L'a' && output[0] <= L'z')) ||
      output[1] != L':' || output[2] != L'\\') return 3;
  for (index = 3; index <= count; index++) {
    WCHAR c = output[index];
    if (c == L'\\' || c == 0) {
      DWORD length = index - start;
      if (!length || (length == 1 && output[start] == L'.') ||
          (length == 2 && output[start] == L'.' && output[start + 1] == L'.') ||
          output[index - 1] == L'.' || output[index - 1] == L' ') return 4;
      start = index + 1;
    } else if (c < 32 || c == 127 || c == L':' || c == L'/' || c == L'"' || c == L'<' ||
               c == L'>' || c == L'|' || c == L'?' || c == L'*') return 5;
  }
  drive[0] = output[0]; drive[1] = L':'; drive[2] = L'\\'; drive[3] = 0;
  driveType = GetDriveTypeW(drive);
  if (driveType != DRIVE_FIXED) return (int)(16 + (driveType <= 6 ? driveType : 15));
  attributes = GetFileAttributesW(output);
  if (attributes == INVALID_FILE_ATTRIBUTES) { *nativeError = GetLastError(); return 32; }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return 33;
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return 34;
  return 0;
}

static int fixedPath(WCHAR *output, const WCHAR *directory, const WCHAR *name)
{
  size_t length = wcslen(directory), extra = wcslen(name);
  if (length + extra + 2 > PROBE_PATH_CHARS) return 0;
  memcpy(output, directory, length * sizeof(WCHAR));
  output[length++] = L'\\';
  memcpy(output + length, name, (extra + 1) * sizeof(WCHAR));
  return 1;
}

static int checkpoint(void)
{
  LARGE_INTEGER zero;
  DWORD written = 0;
  if (reportBroken || reportFile == INVALID_HANDLE_VALUE) return 0;
  record[R_CHECKPOINT]++;
  zero.QuadPart = 0;
  if (!SetFilePointerEx(reportFile, zero, NULL, FILE_BEGIN)) {
    DWORD error = GetLastError(); reportBroken = 1; fail(DOMAIN_WIN32, error); return 0;
  }
  if (!WriteFile(reportFile, record, (DWORD)sizeof(record), &written, NULL)) {
    DWORD error = GetLastError(); reportBroken = 1; fail(DOMAIN_WIN32, error); return 0;
  }
  if (written != sizeof(record)) {
    reportBroken = 1; fail(DOMAIN_CONTRACT, CONTRACT_REPORT_SHORT_WRITE); return 0;
  }
  if (!FlushFileBuffers(reportFile)) {
    DWORD error = GetLastError(); reportBroken = 1; fail(DOMAIN_WIN32, error); return 0;
  }
  return 1;
}

static int advance(DWORD stage)
{
  if (record[R_STATUS] == STATUS_FAILED) return 0;
  record[R_STAGE] = stage;
  return checkpoint();
}

static void closeFd(void)
{
  uv_fs_t request;
  uv_file value = openFile;
  int rc;
  if (value < 0) return;
  openFile = -1;
  memset(&request, 0, sizeof(request));
  rc = uv_fs_close(&loop, &request, value, NULL);
  uv_fs_req_cleanup(&request);
  if (rc != 0) { fdUncertain = 1; fail(DOMAIN_CLEANUP, rc); }
}

static int openLocal(int flags)
{
  uv_fs_t request;
  int rc;
  memset(&request, 0, sizeof(request));
  rc = uv_fs_open(&loop, &request, fileUtf8, flags, 0600, NULL);
  uv_fs_req_cleanup(&request);
  if (rc < 0) { fail(DOMAIN_UV, rc); return 0; }
  openFile = rc;
  return 1;
}

static int synchronousFile(void)
{
  uv_fs_t request;
  uv_buf_t buffer;
  int rc;
  if (!openLocal(_O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY)) return 0;
  record[R_CLEANUP] |= CLEAN_FILE_CREATED;
  memset(&request, 0, sizeof(request));
  buffer = uv_buf_init((char *)payload, payloadBytes);
  rc = uv_fs_write(&loop, &request, openFile, &buffer, 1, 0, NULL);
  uv_fs_req_cleanup(&request);
  if (rc < 0) fail(DOMAIN_UV, rc);
  else if ((DWORD)rc != payloadBytes) fail(DOMAIN_CONTRACT, CONTRACT_SHORT_WRITE);
  closeFd();
  if (record[R_STATUS] == STATUS_FAILED || !openLocal(_O_RDONLY | _O_BINARY)) return 0;
  memset(&request, 0, sizeof(request));
  buffer = uv_buf_init(syncBytes, (unsigned int)sizeof(syncBytes));
  rc = uv_fs_read(&loop, &request, openFile, &buffer, 1, 0, NULL);
  uv_fs_req_cleanup(&request);
  if (rc < 0) fail(DOMAIN_UV, rc);
  else if ((DWORD)rc != payloadBytes || memcmp(syncBytes, payload, payloadBytes) != 0) fail(DOMAIN_CONTRACT, CONTRACT_WRONG_READ);
  else record[R_SYNC_BYTES] = (DWORD)rc;
  if (record[R_STATUS] != STATUS_FAILED) {
    memset(&request, 0, sizeof(request));
    buffer = uv_buf_init(syncBytes, 1);
    rc = uv_fs_read(&loop, &request, openFile, &buffer, 1, payloadBytes, NULL);
    uv_fs_req_cleanup(&request);
    if (rc < 0) fail(DOMAIN_UV, rc);
    else if (rc != 0) fail(DOMAIN_CONTRACT, CONTRACT_NOT_EOF);
  }
  closeFd();
  if (record[R_STATUS] == STATUS_FAILED) return 0;
  record[R_FEATURES] |= FEATURE_SYNC;
  return advance(3);
}

static void readCallback(uv_fs_t *request)
{
  record[R_FS_CALLBACKS]++;
  readPending = 0;
  if (request != &asyncRead || record[R_FS_CALLBACKS] != 1) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
  else if (request->result < 0) fail(DOMAIN_UV, request->result);
  else if ((uint64_t)request->result != payloadBytes || memcmp(asyncBytes, payload, payloadBytes) != 0) fail(DOMAIN_CONTRACT, CONTRACT_WRONG_READ);
  else { record[R_ASYNC_BYTES] = (DWORD)request->result; record[R_FEATURES] |= FEATURE_ASYNC; }
  uv_fs_req_cleanup(request);
  closeFd();
}

static int queueRead(void)
{
  int rc;
  if (!openLocal(_O_RDONLY | _O_BINARY)) return 0;
  memset(&asyncRead, 0, sizeof(asyncRead));
  asyncBuffer = uv_buf_init(asyncBytes, (unsigned int)sizeof(asyncBytes));
  readPending = 1;
  rc = uv_fs_read(&loop, &asyncRead, openFile, &asyncBuffer, 1, 0, readCallback);
  if (rc < 0) {
    readPending = 0; uv_fs_req_cleanup(&asyncRead); fail(DOMAIN_UV, rc); closeFd(); return 0;
  }
  return advance(4);
}

static void timerClosed(uv_handle_t *handle)
{
  if (handle != (uv_handle_t *)&timer) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
  record[R_TIMER_CLOSED]++;
  if (record[R_TIMER_CLOSED] != 1) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
}

static void closeTimer(void)
{
  if (timerReady && !timerClosing) {
    timerClosing = 1;
    uv_close((uv_handle_t *)&timer, timerClosed);
  }
}

static void timerCallback(uv_timer_t *handle)
{
  int rc;
  record[R_TIMER_CALLBACKS]++;
  if (handle != &timer || record[R_TIMER_CALLBACKS] != 1) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
  rc = uv_timer_stop(handle);
  if (rc != 0) fail(DOMAIN_CLEANUP, rc);
  else record[R_FEATURES] |= FEATURE_TIMER;
  closeTimer();
}

static int prepareTimer(void)
{
  int rc = uv_timer_init(&loop, &timer);
  if (rc != 0) { fail(DOMAIN_UV, rc); return 0; }
  timerReady = 1;
  rc = uv_timer_start(&timer, timerCallback, 25, 0);
  if (rc != 0) { fail(DOMAIN_UV, rc); closeTimer(); return 0; }
  return advance(5);
}

/* These two worker-thread callbacks only update Interlocked values; they never write the record or a file. */
static void workCallback(uv_work_t *request)
{
  DWORD value = request == &work ? fixedChecksum() : 0;
  InterlockedExchange(&workResult, (LONG)value);
  InterlockedIncrement(&workCallbacks);
}

static void afterWorkCallback(uv_work_t *request, int status)
{
  workPending = 0;
  record[R_AFTER_WORK]++;
  if (request != &work || record[R_AFTER_WORK] != 1) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
  else if (status != 0) fail(DOMAIN_UV, status);
  else if (InterlockedCompareExchange(&workCallbacks, 0, 0) != 1 ||
           (DWORD)InterlockedCompareExchange(&workResult, 0, 0) != fixedChecksum()) fail(DOMAIN_CONTRACT, CONTRACT_WORK_RESULT);
  else record[R_FEATURES] |= FEATURE_WORK;
}

static void threadCallback(void *argument)
{
  DWORD value = argument == &thread ? fixedChecksum() : 0;
  InterlockedExchange(&threadResult, (LONG)value);
  InterlockedIncrement(&threadCallbacks);
}

static int queueWork(void)
{
  int rc;
  memset(&work, 0, sizeof(work));
  workPending = 1;
  rc = uv_queue_work(&loop, &work, workCallback, afterWorkCallback);
  if (rc != 0) { workPending = 0; fail(DOMAIN_UV, rc); return 0; }
  return advance(6);
}

static void joinThread(void)
{
  int rc;
  if (!threadReady) return;
  threadReady = 0; /* Exactly one join attempt; a failed join is not retried against an opaque recycled handle. */
  rc = uv_thread_join(&thread);
  if (rc != 0) { fail(DOMAIN_CLEANUP, rc); return; }
  record[R_THREAD_JOINED] = 1;
  if (InterlockedCompareExchange(&threadCallbacks, 0, 0) != 1 ||
      (DWORD)InterlockedCompareExchange(&threadResult, 0, 0) != fixedChecksum()) fail(DOMAIN_CONTRACT, CONTRACT_THREAD_RESULT);
  else record[R_FEATURES] |= FEATURE_THREAD;
}

static int prepareThread(void)
{
  int rc = uv_thread_create(&thread, threadCallback, &thread);
  if (rc != 0) { fail(DOMAIN_UV, rc); return 0; }
  threadReady = 1;
  joinThread();
  return advance(7);
}

static void removeWorkFile(void)
{
  uv_fs_t request;
  int rc;
  if (!(record[R_CLEANUP] & CLEAN_FILE_CREATED) || fdUncertain || openFile >= 0 || readPending) return;
  record[R_CLEANUP] |= CLEAN_ALL_FDS_CLOSED;
  memset(&request, 0, sizeof(request));
  rc = uv_fs_unlink(&loop, &request, fileUtf8, NULL);
  uv_fs_req_cleanup(&request);
  if (rc != 0) fail(DOMAIN_CLEANUP, rc);
  else record[R_CLEANUP] |= CLEAN_FILE_REMOVED;
}

int main(int argc, char **argv)
{
  HANDLE token = NULL;
  DWORD appContainer = 0, bytes = 0, bootstrapError = 0;
  BY_HANDLE_FILE_INFORMATION information;
  int rc, exitCode;
  (void)argv;
  record[R_MAGIC] = PROBE_MAGIC; record[R_VERSION] = 1; record[R_BUILD] = EMBER_UV_FIXED_PROBE_OFFLINE;
  record[R_LOOP_INIT] = PROBE_UNOBSERVED; record[R_LOOP_RUN] = PROBE_UNOBSERVED; record[R_LOOP_CLOSE] = PROBE_UNOBSERVED;
  /* Bootstrap failures have fixed numeric exits; paths, arguments and native text are never printed. */
  if (argc != 1) return 10;
  rc = localDirectory(L"EMBER_LPAC_WORK", workPath, &bootstrapError);
  if (rc == 32) return (int)(bootstrapError <= 0xffffu ? 0xe1010000u | bootstrapError : 0xe1ffffffu);
  if (rc != 0) return 100 + rc;
  rc = localDirectory(L"EMBER_LPAC_STATE", statePath, &bootstrapError);
  if (rc == 32) return (int)(bootstrapError <= 0xffffu ? 0xe1020000u | bootstrapError : 0xe2ffffffu);
  if (rc != 0) return 200 + rc;
  if (_wcsicmp(workPath, statePath) == 0) return 300;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 11;
  rc = GetTokenInformation(token, TOKEN_IS_APP_CONTAINER, &appContainer, sizeof(appContainer), &bytes) != 0 &&
      bytes == sizeof(appContainer) && appContainer <= 1;
  if (!CloseHandle(token)) return 12;
  if (!rc) return 13;
  record[R_TOKEN] = appContainer;
  if (!fixedPath(reportPath, statePath, appContainer ? L"lpac-probe.bin" : L"host-probe.bin") ||
      !fixedPath(filePath, workPath, appContainer ? L"lpac-work.bin" : L"host-work.bin")) return 14;
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, filePath, -1, fileUtf8, (int)sizeof(fileUtf8), NULL, NULL)) return 15;
  reportFile = CreateFileW(reportPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_NEW,
                           FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (reportFile == INVALID_HANDLE_VALUE) return 16;
  if (!GetFileInformationByHandle(reportFile, &information) || information.nNumberOfLinks != 1 ||
      (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    fail(DOMAIN_CONTRACT, CONTRACT_REPORT_FILE);
  }
  if (!checkpoint() || !advance(1)) goto done;

  /* This flushed record survives a stock libuv fatal error during unconditional global initialization. */
  rc = uv_loop_init(&loop);
  record[R_LOOP_INIT] = (DWORD)(uint32_t)rc;
  if (rc != 0) { fail(DOMAIN_UV, rc); goto done; }
  loopReady = 1;
  if (!advance(2) || !synchronousFile() || !queueRead() || !prepareTimer() || !queueWork() || !prepareThread()) goto done;

done:
  if (loopReady) {
    joinThread();
    if (record[R_STATUS] == STATUS_FAILED) closeTimer();
    rc = uv_run(&loop, UV_RUN_DEFAULT);
    record[R_LOOP_RUN] = (DWORD)(uint32_t)rc;
    record[R_WORK_CALLBACKS] = (DWORD)InterlockedCompareExchange(&workCallbacks, 0, 0);
    record[R_THREAD_CALLBACKS] = (DWORD)InterlockedCompareExchange(&threadCallbacks, 0, 0);
    if (rc != 0 || uv_loop_alive(&loop)) fail(DOMAIN_CONTRACT, CONTRACT_LOOP_ALIVE);
    if (readPending || workPending) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
    closeFd();
    removeWorkFile();
    if (record[R_STATUS] != STATUS_FAILED &&
        (record[R_FS_CALLBACKS] != 1 || record[R_TIMER_CALLBACKS] != 1 || record[R_TIMER_CLOSED] != 1 ||
         record[R_WORK_CALLBACKS] != 1 || record[R_AFTER_WORK] != 1 || record[R_THREAD_CALLBACKS] != 1 || record[R_THREAD_JOINED] != 1))
      fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
    if (record[R_STATUS] != STATUS_FAILED) advance(8);
    rc = uv_loop_close(&loop);
    record[R_LOOP_CLOSE] = (DWORD)(uint32_t)rc;
    if (rc != 0) fail(DOMAIN_CLEANUP, rc);
    else { loopReady = 0; record[R_CLEANUP] |= CLEAN_LOOP_CLOSED; record[R_FEATURES] |= FEATURE_LOOP; }
    if (record[R_STATUS] != STATUS_FAILED) advance(9);
    /* This joins libuv's idle global worker pool after all queued callbacks and the loop have drained. */
    if (rc == 0) uv_library_shutdown();
  }
  if (record[R_STATUS] != STATUS_FAILED) {
    if (record[R_FEATURES] != 63 || record[R_CLEANUP] != 15) fail(DOMAIN_CONTRACT, CONTRACT_CALLBACKS);
    else { record[R_STATUS] = STATUS_COMPLETE; record[R_STAGE] = 10; }
  }
  checkpoint();
  exitCode = record[R_STATUS] == STATUS_COMPLETE && !reportBroken ? 0 : 1;
  /* The parent still requires actual root exit and job zero before reading this file; close failure is not success. */
  if (!CloseHandle(reportFile)) exitCode = 2;
  reportFile = INVALID_HANDLE_VALUE;
  return exitCode;
}
