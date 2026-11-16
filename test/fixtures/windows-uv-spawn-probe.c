/* Fixed libuv three-pipe witness. It accepts no program, command, provider or stream data from its caller.
 * The trusted host observes the fixed running leaf before issuing a fixed ACK. This is not pre-entry admission.
 * Unknown ownership or completion retains the process until the external private-job Stop; it never publishes.
 */
#include "windows-uv-spawn-observe.h"
#include <limits.h>
#include <string.h>
#include <wchar.h>

#define PATH_CHARS 32768u
#define PATH_BYTES (PATH_CHARS * 3u)
#define WORDS 64u
#define MAGIC 0x53565545u
#define TOKEN_APP_CONTAINER ((TOKEN_INFORMATION_CLASS)29)
enum { R_MAGIC, R_SCHEMA, R_ROLE, R_STATUS, R_STAGE, R_CONTROLS, R_LOOP_INIT, R_PIPE_INIT,
  R_SPAWN_RESULT, R_SPAWN_RETURNED, R_CHILD, R_EXIT_CALLBACK, R_EXIT_STATUS, R_TERM_SIGNAL,
  R_PROCESS_CLOSED, R_PIPE_CLOSED, R_ACK_POLLS, R_ACK, R_STDIN_BYTES, R_STDOUT_BYTES,
  R_STDERR_BYTES, R_LOOP_CLOSE, R_FAIL_OPERATION, R_FAIL_CODE, R_OBSERVATION = 24,
  R_CANARY_SUCCESS = 52, R_CANARY_ERROR, R_PARENT_CREATE_SUCCESS, R_PARENT_CREATE_ERROR,
  R_PARENT_VM_SUCCESS, R_PARENT_VM_ERROR };
enum { OP_ACK = 1, OP_WRITE, OP_SHUTDOWN, OP_READ, OP_OUTPUT, OP_EXIT, OP_LOOP, OP_LEDGER };

static const char ack[] = "EMBER_ACK_1\n";
static const char response[] = "EMBER_STDIO_1\n";
static const char canary_payload[] = "EMBER_UV_SPAWN_CANARY\n";
static uint32_t record[WORDS];
static WCHAR tools[PATH_CHARS], state[PATH_CHARS], canary[PATH_CHARS], image[PATH_CHARS];
static WCHAR ack_path[PATH_CHARS], report_path[PATH_CHARS], env_value[PATH_CHARS];
static char image_utf8[PATH_BYTES];
static const WCHAR* env_names[] = { L"SYSTEMROOT", L"WINDIR", L"LOCALAPPDATA", L"PATH", L"TEMP", L"TMP", L"EMBER_LPAC_WORK",
  L"EMBER_LPAC_STATE", L"EMBER_LPAC_TOOLS", L"EMBER_UV_SPAWN_CANARY", L"EMBER_UV_SPAWN_PARENT" };
static char env_storage[11][PATH_BYTES];
static char* child_environment[12];
static char stdout_bytes[sizeof(response)], read_storage[2][64];
static uv_loop_t loop;
static uv_pipe_t pipes[3];
static uv_process_t child;
static uv_timer_t timer;
static uv_write_t writer;
static uv_shutdown_t shutdown_request;
static uv_buf_t write_buffer;
static unsigned int timer_closed, process_closing, pipe_closing, timer_closing;
static int runtime_failed;
typedef char report_has_256_bytes[(sizeof(record) == 256) ? 1 : -1];

/* No error string, path, handle, PID or stream contents are written anywhere. */
static void uncertain(void) { for (;;) Sleep(1000); }
static void close_native(HANDLE handle) {
  if (handle == NULL || handle == INVALID_HANDLE_VALUE || !CloseHandle(handle)) uncertain();
}
static void fail(uint32_t operation, int code) {
  if (!runtime_failed) { record[R_FAIL_OPERATION] = operation; record[R_FAIL_CODE] = (uint32_t)code; }
  runtime_failed = 1;
}
static int absolute_path(const WCHAR* value) {
  size_t i, start = 3, length = wcslen(value);
  if (length < 4 || length >= PATH_CHARS || value[1] != L':' || value[2] != L'\\' ||
      !((value[0] >= L'A' && value[0] <= L'Z') || (value[0] >= L'a' && value[0] <= L'z'))) return 0;
  for (i = 3; i <= length; i++) {
    WCHAR c = value[i];
    if (c == L'\\' || c == 0) {
      size_t n = i - start;
      if (!n || (n == 1 && value[start] == L'.') || (n == 2 && value[start] == L'.' && value[start + 1] == L'.') ||
          value[i - 1] == L'.' || value[i - 1] == L' ') return 0;
      start = i + 1;
    } else if (c < 32 || c == 127 || c == L':' || c == L'/' || c == L'"' || c == L'<' || c == L'>' || c == L'|' || c == L'?' || c == L'*') return 0;
  }
  return 1;
}
static int environment_path(const WCHAR* name, WCHAR* output, int directory) {
  DWORD n = GetEnvironmentVariableW(name, output, PATH_CHARS), attributes;
  if (!n || n >= PATH_CHARS || !absolute_path(output)) return 0;
  if (!directory) return 1;
  attributes = GetFileAttributesW(output);
  return attributes != INVALID_FILE_ATTRIBUTES &&
    (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == FILE_ATTRIBUTE_DIRECTORY;
}
static int fixed_path(WCHAR* output, const WCHAR* directory, const WCHAR* filename) {
  size_t length = wcslen(directory), extra = wcslen(filename);
  if (length + extra + 2 > PATH_CHARS) return 0;
  memcpy(output, directory, length * sizeof(WCHAR)); output[length++] = L'\\';
  memcpy(output + length, filename, (extra + 1) * sizeof(WCHAR)); return 1;
}
static int parent_id(DWORD* output) {
  WCHAR value[16];
  uint64_t parsed = 0;
  DWORD i, n = GetEnvironmentVariableW(L"EMBER_UV_SPAWN_PARENT", value, 16);
  if (!n || n > 10 || value[0] == L'0') return 0;
  for (i = 0; i < n; i++) {
    if (value[i] < L'0' || value[i] > L'9') return 0;
    parsed = parsed * 10u + (uint64_t)(value[i] - L'0');
    if (parsed > 0xffffffffu) return 0;
  }
  *output = (DWORD)parsed; return 1;
}
static int controls(void) {
  HANDLE token = NULL, handle;
  DWORD app = 0, size = 0, pid, n, error;
  char canary_bytes[sizeof(canary_payload)];
  BOOL ok;
  if (!environment_path(L"EMBER_LPAC_TOOLS", tools, 1) || !environment_path(L"EMBER_LPAC_STATE", state, 1) ||
      !environment_path(L"EMBER_UV_SPAWN_CANARY", canary, 0) || !parent_id(&pid)) return 0;
  n = GetModuleFileNameW(NULL, image, PATH_CHARS);
  if (!n || n >= PATH_CHARS || !absolute_path(image) ||
      !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, image, -1, image_utf8, PATH_BYTES, NULL, NULL)) return 0;
  ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token);
  if (!ok) { if (token) uncertain(); return 0; }
  if (!token) uncertain();
  ok = GetTokenInformation(token, TOKEN_APP_CONTAINER, &app, sizeof(app), &size);
  close_native(token);
  if (!ok || size != sizeof(app) || app > 1) return 0;
  record[R_ROLE] = app; record[R_CONTROLS] |= 16;
  handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  if (!handle) return 0;
  close_native(handle); record[R_CONTROLS] |= 2;
  handle = CreateFileW(canary, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    error = GetLastError(); record[R_CANARY_ERROR] = error;
    if (app != 1 || error != ERROR_ACCESS_DENIED) return 0;
  } else {
    if (!handle) uncertain();
    ok = ReadFile(handle, canary_bytes, (DWORD)sizeof(canary_bytes), &n, NULL);
    close_native(handle);
    if (!ok || n != sizeof(canary_payload) - 1 || app != 0 || memcmp(canary_bytes, canary_payload, sizeof(canary_payload) - 1)) {
      SecureZeroMemory(canary_bytes, sizeof(canary_bytes)); return 0;
    }
    SecureZeroMemory(canary_bytes, sizeof(canary_bytes));
    record[R_CANARY_SUCCESS] = 1;
  }
  record[R_CONTROLS] |= 1;
  handle = OpenProcess(PROCESS_CREATE_PROCESS, FALSE, pid);
  if (!handle) {
    error = GetLastError(); record[R_PARENT_CREATE_ERROR] = error;
    if (app != 1 || error != ERROR_ACCESS_DENIED) return 0;
  } else { close_native(handle); if (app != 0) return 0; record[R_PARENT_CREATE_SUCCESS] = 1; }
  record[R_CONTROLS] |= 4;
  handle = OpenProcess(PROCESS_VM_WRITE, FALSE, pid);
  if (!handle) {
    error = GetLastError(); record[R_PARENT_VM_ERROR] = error;
    if (app != 1 || error != ERROR_ACCESS_DENIED) return 0;
  } else { close_native(handle); if (app != 0) return 0; record[R_PARENT_VM_SUCCESS] = 1; }
  record[R_CONTROLS] |= 8;
  return fixed_path(ack_path, tools, app ? L"lpac-uv-spawn-ack.bin" : L"host-uv-spawn-ack.bin") &&
    fixed_path(report_path, state, app ? L"lpac-uv-spawn-report.bin" : L"host-uv-spawn-report.bin");
}

static int fixed_environment(void) {
  unsigned int i, count = 0;
  for (i = 0; i < sizeof(env_names) / sizeof(env_names[0]); i++) {
    DWORD n = GetEnvironmentVariableW(env_names[i], env_value, PATH_CHARS);
    int prefix, bytes;
    if (n >= PATH_CHARS) return 0;
    if (!n) continue;
    prefix = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, env_names[i], -1, env_storage[count], PATH_BYTES, NULL, NULL);
    if (prefix <= 1) return 0;
    env_storage[count][prefix - 1] = '=';
    bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, env_value, -1, env_storage[count] + prefix, PATH_BYTES - prefix, NULL, NULL);
    if (!bytes) return 0;
    child_environment[count] = env_storage[count]; count++;
  }
  child_environment[count] = NULL; return 1;
}
static void pipe_closed(uv_handle_t* handle) {
  unsigned int i;
  for (i = 0; i < 3; i++) if (handle == (uv_handle_t*)&pipes[i]) {
    if (record[R_PIPE_CLOSED] & (1u << i)) uncertain();
    record[R_PIPE_CLOSED] |= 1u << i; return;
  }
  uncertain();
}
static void close_pipe(unsigned int index) {
  if (index >= 3 || !(record[R_PIPE_INIT] & (1u << index))) uncertain();
  if (pipe_closing & (1u << index)) return;
  pipe_closing |= 1u << index;
  uv_close((uv_handle_t*)&pipes[index], pipe_closed);
}
static void timer_close(uv_handle_t* handle) {
  if (handle != (uv_handle_t*)&timer || timer_closed) uncertain();
  timer_closed = 1;
}
static void close_timer(void) {
  int rc;
  if (timer_closing) return;
  timer_closing = 1; rc = uv_timer_stop(&timer); if (rc) uncertain();
  uv_close((uv_handle_t*)&timer, timer_close);
}
static void process_close(uv_handle_t* handle) {
  if (handle != (uv_handle_t*)&child || record[R_PROCESS_CLOSED]) uncertain();
  record[R_PROCESS_CLOSED] = 1;
}
static void exited(uv_process_t* process, int64_t exit_status, int term_signal) {
  if (process != &child || record[R_EXIT_CALLBACK] || process_closing || exit_status < INT32_MIN || exit_status > INT32_MAX) uncertain();
  record[R_EXIT_CALLBACK] = 1; record[R_EXIT_STATUS] = (uint32_t)(int32_t)exit_status; record[R_TERM_SIGNAL] = (uint32_t)term_signal;
  if (exit_status || term_signal) fail(OP_EXIT, (int)exit_status);
  process_closing = 1; uv_close((uv_handle_t*)&child, process_close);
}
static void allocate(uv_handle_t* handle, size_t suggested, uv_buf_t* buffer) {
  (void)suggested;
  if (handle == (uv_handle_t*)&pipes[1]) *buffer = uv_buf_init(read_storage[0], sizeof(read_storage[0]));
  else if (handle == (uv_handle_t*)&pipes[2]) *buffer = uv_buf_init(read_storage[1], sizeof(read_storage[1]));
  else uncertain();
}
static void read_bytes(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buffer) {
  unsigned int index = stream == (uv_stream_t*)&pipes[1] ? 1u : 2u;
  if (stream != (uv_stream_t*)&pipes[index]) uncertain();
  if (nread > 0) {
    if (index == 2) {
      if ((uint64_t)nread + record[R_STDERR_BYTES] > 4096) uncertain();
      record[R_STDERR_BYTES] += (uint32_t)nread; fail(OP_OUTPUT, 0);
    }
    else if ((uint64_t)nread + record[R_STDOUT_BYTES] > sizeof(response) - 1) uncertain();
    else { memcpy(stdout_bytes + record[R_STDOUT_BYTES], buffer->base, (size_t)nread); record[R_STDOUT_BYTES] += (uint32_t)nread; }
    SecureZeroMemory(buffer->base, (SIZE_T)nread);
  } else if (nread < 0) {
    if (nread != UV_EOF) fail(OP_READ, (int)nread);
    close_pipe(index);
  }
}
static void shutdown_complete(uv_shutdown_t* request, int status) {
  if (request != &shutdown_request) uncertain();
  if (status) fail(OP_SHUTDOWN, status);
  close_pipe(0);
}
static void write_complete(uv_write_t* request, int status) {
  int rc;
  if (request != &writer) uncertain();
  if (status) { fail(OP_WRITE, status); close_pipe(0); return; }
  record[R_STDIN_BYTES] = (uint32_t)(sizeof(ack) - 1);
  rc = uv_shutdown(&shutdown_request, (uv_stream_t*)&pipes[0], shutdown_complete);
  if (rc) { fail(OP_SHUTDOWN, rc); close_pipe(0); }
}
static void poll_ack(uv_timer_t* handle) {
  HANDLE file;
  char bytes[sizeof(ack)];
  DWORD read = 0, error;
  BOOL ok;
  int rc;
  if (handle != &timer || record[R_ACK] || record[R_ACK_POLLS] >= 500) uncertain();
  record[R_ACK_POLLS]++;
  file = CreateFileW(ack_path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return;
    uncertain();
  }
  if (!file) uncertain();
  ok = ReadFile(file, bytes, sizeof(bytes), &read, NULL);
  close_native(file);
  if (!ok || read != sizeof(ack) - 1 || memcmp(bytes, ack, sizeof(ack) - 1)) {
    SecureZeroMemory(bytes, sizeof(bytes)); uncertain();
  }
  SecureZeroMemory(bytes, sizeof(bytes)); record[R_ACK] = 1; close_timer();
  write_buffer = uv_buf_init((char*)ack, sizeof(ack) - 1);
  rc = uv_write(&writer, (uv_stream_t*)&pipes[0], &write_buffer, 1, write_complete);
  if (rc) { fail(OP_WRITE, rc); close_pipe(0); }
}
static void publish(void) {
  HANDLE file;
  DWORD written = 0;
  BOOL ok;
  file = CreateFileW(report_path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) uncertain();
  if (!file) uncertain();
  ok = WriteFile(file, record, sizeof(record), &written, NULL);
  if (!ok || written != sizeof(record) || !FlushFileBuffers(file)) { close_native(file); uncertain(); }
  close_native(file);
}
static int leaf(void) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE), error = GetStdHandle(STD_ERROR_HANDLE);
  char bytes[sizeof(ack)];
  DWORD total = 0, n = 0;
  if (!input || input == INVALID_HANDLE_VALUE || !output || output == INVALID_HANDLE_VALUE || !error || error == INVALID_HANDLE_VALUE || input == output || input == error || output == error) uncertain();
  while (total < sizeof(ack) - 1) {
    if (!ReadFile(input, bytes + total, (DWORD)(sizeof(ack) - 1 - total), &n, NULL) || n == 0 || n > sizeof(ack) - 1 - total) uncertain();
    total += n;
  }
  if (memcmp(bytes, ack, sizeof(ack) - 1)) { SecureZeroMemory(bytes, sizeof(bytes)); uncertain(); }
  SecureZeroMemory(bytes, sizeof(bytes)); close_native(input);
  if (!WriteFile(output, response, sizeof(response) - 1, &n, NULL) || n != sizeof(response) - 1) uncertain();
  close_native(output); close_native(error); return 0;
}
int main(int argc, char** argv) {
  uv_process_options_t options;
  uv_stdio_container_t stdio[3];
  ember_uv_spawn_observation observation;
  char* arguments[3];
  unsigned int i;
  int rc;
  if (argc == 2 && strcmp(argv[1], "--leaf") == 0) return leaf();
  if (argc != 1) return 101;
  record[R_MAGIC] = MAGIC; record[R_SCHEMA] = 1;
  if (!controls() || record[R_CONTROLS] != 31 || !fixed_environment()) return 102;
  rc = uv_loop_init(&loop); record[R_LOOP_INIT] = (uint32_t)rc;
  if (rc) return 103;
  for (i = 0; i < 3; i++) {
    rc = uv_pipe_init(&loop, &pipes[i], 0);
    if (rc) uncertain();
    record[R_PIPE_INIT] |= 1u << i;
  }
  memset(&options, 0, sizeof(options)); memset(stdio, 0, sizeof(stdio));
  arguments[0] = image_utf8; arguments[1] = "--leaf"; arguments[2] = NULL;
  options.file = image_utf8; options.args = arguments; options.env = child_environment;
  options.exit_cb = exited; options.flags = 0; options.cwd = NULL; options.stdio_count = 3; options.stdio = stdio;
  for (i = 0; i < 3; i++) { stdio[i].flags = (uv_stdio_flags)(UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE); stdio[i].data.stream = (uv_stream_t*)&pipes[i]; }
  ember_uv_spawn_observe_begin();
  rc = uv_spawn(&loop, &child, &options);
  ember_uv_spawn_observe_end(rc, &observation);
  record[R_SPAWN_RESULT] = (uint32_t)rc; record[R_SPAWN_RETURNED] = 1;
  memcpy(record + R_OBSERVATION, &observation, sizeof(observation));
  if (rc == 0) {
    record[R_CHILD] = 1;
    if (observation.unknown) fail(OP_LEDGER, 0);
    for (i = 1; i < 3; i++) { rc = uv_read_start((uv_stream_t*)&pipes[i], allocate, read_bytes); if (rc) uncertain(); }
    rc = uv_timer_init(&loop, &timer); if (rc) uncertain();
    rc = uv_timer_start(&timer, poll_ack, 0, 10); if (rc) uncertain();
  } else {
    if (rc > 0) uncertain();
    for (i = 0; i < 3; i++) close_pipe(i);
    /* uv_spawn initialises this uv handle even when no OS child was created. */
    process_closing = 1; uv_close((uv_handle_t*)&child, process_close);
  }
  rc = uv_run(&loop, UV_RUN_DEFAULT);
  if (rc || record[R_PIPE_CLOSED] != 7 || record[R_PROCESS_CLOSED] != 1 || (record[R_CHILD] &&
      (record[R_EXIT_CALLBACK] != 1 || !timer_closed))) uncertain();
  rc = uv_loop_close(&loop); record[R_LOOP_CLOSE] = (uint32_t)rc;
  if (rc) uncertain();
  if (record[R_CHILD] && (record[R_ACK] != 1 || record[R_STDIN_BYTES] != sizeof(ack) - 1 ||
      record[R_STDOUT_BYTES] != sizeof(response) - 1 || record[R_STDERR_BYTES] || memcmp(stdout_bytes, response, sizeof(response) - 1))) fail(OP_OUTPUT, 0);
  SecureZeroMemory(stdout_bytes, sizeof(stdout_bytes));
  record[R_STATUS] = runtime_failed ? 2u : 1u; record[R_STAGE] = 6;
  publish(); return 0;
}
