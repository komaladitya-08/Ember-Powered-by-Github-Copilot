# loginctl and busctl output for the remote agent's desktop discovery

`test/unit/remote-agent-desktop-linux.test.ts` reads these files as `discoverDesktop` (app/remote/desktop-linux.ts)
reads the commands' output on a remote. One folder per machine and situation:

| File | Command (as the agent runs it, for uid 1000) |
|---|---|
| `show-user.txt` | `loginctl show-user 1000 -p Display -p Sessions` |
| `show-session-<id>.txt` | `loginctl show-session <id> -p Id -p User -p Type -p Class -p Active -p State -p Remote -p Seat -p Display -p LockedHint` |
| `manager-env.txt` | `busctl --user get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Environment` |
| `screensaver.txt` | `busctl --user call org.gnome.ScreenSaver /org/gnome/ScreenSaver org.gnome.ScreenSaver GetActive` (no file: no such service) |

**Where they come from.** These files were not captured on real machines: the container they were written in has no
systemd, logind or desktop session. They reproduce, byte for byte, what systemd prints, worked out from its source at
the versions the two systems ship (v239 for RHEL 8, v255 for Ubuntu 24.04): `loginctl show-*` prints the requested
properties in the order of the D-Bus vtable (`src/login/logind-session-dbus.c`, `logind-user-dbus.c`: Id, User, …,
Seat, TTY, Display, Remote, …, Type, Class, Active, State, …, LockedHint), not in the `-p` order, and skips empty
strings (so a seat-less session has no `Seat=` line); `User=` is the uid, `Sessions=` the ids separated by spaces,
newest first; `busctl get-property` prints `as <n> "<string>" …` with C escapes (`src/busctl/busctl.c`
`format_cmdline`; systemd 239 has no `--json`, so the agent reads this plain form everywhere). The environment values
are typical of each desktop, not copied from one. Replace any folder with real output when it can be captured (the
lead's manual plan, design §10.3 items 1-2): run the commands above on the machine in that situation and keep the
file names.

Situations: `rhel8-x11` (GNOME 3.28 on Xorg; the user manager has no display, so the session scope's processes give
it), `rhel8-x11-locked` (logind's LockedHint and GNOME's screensaver), `rhel8-x11-switched` (another user took seat0),
`rhel8-headless` (the SSH login only), `rhel8-vnc` (TigerVNC's seat-less session), `ubuntu2404-x11` (GNOME 46 on Xorg,
gnome-shell outside the session scope, the display in the user manager), `ubuntu2404-wayland`, `ubuntu2404-xrdp`
(a remote, seat-less session), `ubuntu2404-two-seats` (the same user active on seat0 and seat1).
