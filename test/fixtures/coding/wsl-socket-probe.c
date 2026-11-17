/* Native syscall controls for the WSL-specific filter; compiled only by integration/qualification setup. */
#include <errno.h>
#include <sys/socket.h>
#include <unistd.h>
int main(void) {
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 1;
  close(pair[0]); close(pair[1]);
  const int families[] = { AF_INET, AF_INET6, 40 /* AF_VSOCK */ };
  for (unsigned i = 0; i < sizeof(families) / sizeof(families[0]); ++i) {
    errno = 0;
    int fd = socket(families[i], SOCK_STREAM, 0);
    if (fd >= 0) { close(fd); return 2; }
    if (errno != EPERM) return 3;
    errno = 0;
    if (socketpair(families[i], SOCK_STREAM, 0, pair) != -1 || errno != EPERM) return 4;
  }
  return 0;
}
