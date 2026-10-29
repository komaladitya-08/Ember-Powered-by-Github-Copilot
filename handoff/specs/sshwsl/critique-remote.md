# Critique: SSH transport and remote-desktop feasibility (sshwsl/design.md)

Reviewer lens: OpenSSH client behaviour on Linux, macOS and Windows; the bootstrap, framing and binary safety; remote
shells; the Node runtime and koffi on remotes; reaching the graphical session from an SSH login; capture without
Electron; headless behaviour. "design.md:N" is a line in `specs/sshwsl/design.md`. Code references are to the tree at
`832045e`. Each item gives the problem, the evidence, a severity (blocker / major / minor) and a concrete fix.

Checked and found sound (no item): `sh -s` as the remote command works under bash, zsh, fish and tcsh login shells;
`-T` with `EscapeChar=none` is binary-clean on POSIX (no pty, so no escape processing); GNU `head -c` reads exactly N
bytes from a pipe (tested: two consecutive `head -c` after `read -r` under dash and bash); official Node 24 needs glibc
2.28 and kernel 4.18 on linux-x64 and linux-arm64 (built on RHEL 8 with gcc-toolset-12, Node's `BUILDING.md` for
v24.x), so RHEL 8 works; koffi 3.2.1's `linux_x64/koffi.node` needs at most `GLIBC_2.25` (`readelf -V`), and koffi
loads only lazily (`createRequire` in `x11.ts:97`, `hands/input.ts:86`), so a commands-only agent never needs it;
`perception/capture.ts:49-53` loads sharp lazily, so the remote bundle doesn't pull sharp in; the session-0 and TCC
statements (L6, §5.3.5) are right; OpenSSH 8.0 (RHEL 8) uses askpass when `DISPLAY` is set and ssh has no
controlling terminal, which `detached: true` (setsid) gives; Win32-OpenSSH's current `readpass.c` does run
`SSH_ASKPASS`, but only when that variable is set and askpass is forced (item 6).

---

## Blockers

1. **macOS remotes: the first install corrupts the parts archive (BSD `head -c` reads ahead).**
   - Problem: after `INSTALL …`, the PC writes the runtime archive and then, straight away, the parts archive
     (design.md:2383). The script reads each with `head -c` (design.md:2233). macOS's `head` is the FreeBSD one: it
     reads `stdin` through stdio (`fread` on a `FILE *`). stdio fills its buffer with whatever the pipe holds, so the
     first `head -c <runtimeBytes>` swallows the first kilobytes of the parts archive. The parts SHA-256 then fails
     ("integrity", §8.7) on every first install on a Mac, and on any later install that sends both archives. GNU
     `head` (Linux) uses `read(2)` with the remaining count, so Linux is unaffected.
   - Evidence: Apple text_cmds `head/head.c`, `head_bytes(FILE *fp, …)` uses `fread(buf, 1, readlen, fp)`, and `main`
     passes `stdin`. design.md:2199, 2233, 2383.
   - Fix: never let a reader see bytes past its own archive. After `INSTALL`, the script prints `EMBER-READY runtime`;
     the PC sends exactly `runtimeBytes` and waits; the script `head -c` reads them and prints `EMBER-READY parts`;
     only then does the PC send the parts. A buffering reader can't over-read bytes the PC hasn't written yet.
     State it as a MUST in §5.1.9 and add a two-archive install to the `ssh-macos` job.

2. **Linux desktop discovery parses `loginctl … --value` by position, and that order isn't the `-p` order.**
   - Problem: §5.3.4 step 2 and the probe's `session` key run `loginctl show-session S -p User -p Type -p Class
     -p Active -p State -p Remote -p Seat -p Display -p LockedHint --value` and read the values in that order.
     systemd prints the properties in the D-Bus `GetAll` order of the Session interface (Id, User, Name, …, Seat, TTY,
     Display, Remote, …, Type, Class, Active, State, IdleHint, …, LockedHint) and filters by `-p`. Without `--all` it
     also skips empty strings, such as `Display` on a Wayland session. So "Type" receives `seat0` and the desktop is
     always "none": it fails closed, but the Linux remote desktop never works. Fake-loginctl unit tests written in the
     `-p` order would still pass.
   - Evidence: systemd `bus_print_all_properties` → `bus_message_print_all_properties` walks the reply's `{sv}`
     entries and checks `strv_find(filter, name)`; empty strings print only with `all`. design.md:2226, 2454-2457.
   - Fix: never use `--value` with more than one `-p`. Print `Key=Value` lines (add `--all` so empty values are
     present) and parse them by name. Better: read `org.freedesktop.login1` with `busctl --json=short get-property` or
     `gdbus call`. The test fixtures must be real `loginctl` output captured from RHEL 8 and Ubuntu 24.04.

## Major

3. **The user's `ControlMaster auto` / `ControlPersist` config makes Ember's ssh a master.**
   - Problem: Ember passes `ControlMaster=no` only when it rides a live master (design.md:2111). With a typical
     `~/.ssh/config` (`ControlMaster auto`, `ControlPath ~/.ssh/cm-%C`, `ControlPersist 10m`) and no live master,
     Ember's own `ssh -T` becomes the master, and `ControlPersist` forks it into the background. The connection then
     outlives Ember and its Disconnect, which the design rules out ("Ember never creates a master", design.md:2163;
     gaps.md §4.4).
   - It also goes the other way. The user's next terminal `ssh build-01` rides Ember's hardened connection
     (`ForwardAgent=no`, `ClearAllForwardings`), so their `LocalForward` silently does nothing. Without persist, their
     terminal dies when Ember disconnects.
   - On Windows, a shared config (dotfiles, or a WSL `~/.ssh` symlink) with `ControlMaster` lines makes Win32-OpenSSH
     fail (no Unix-socket mux).
   - Evidence: design.md:2106-2116, 2159-2164; ssh_config(5) precedence (the first value obtained wins, and command-line
     `-o` comes first).
   - Fix: always pass `-o ControlMaster=no`. Pass `-o ControlPath=none` whenever Ember isn't riding a checked live
     master. On Windows, pass both always (verify in `ssh-windows.test.ts` that 7.7, 8.x and 9.x accept them). Add
     `ssh-argv` unit cases for "config has ControlMaster auto + ControlPersist".

4. **ProxyJump hops escape every hardening option, prompts get the wrong host's label, and connects have no deadline.**
   - Options: OpenSSH builds the jump hop as `ssh [-l u] [-p p] [-J rest] [-F cfg] [-v] -W '[%h]:%p' <jump>`. It does
     not pass the command line's `-o` options, so `BatchMode=yes`, `StrictHostKeyChecking=yes`,
     `UpdateHostKeys=no` and `LogLevel` don't apply to the jump host. A jump configured with
     `StrictHostKeyChecking accept-new` (or `no`) is trusted silently. The `/dev/null` known-hosts refusal checks only
     the final host (design.md:2095).
   - Prompts: in a "batch" run, the jump hop still prompts. On RHEL GNOME, `/etc/profile.d/gnome-ssh-askpass.sh`
     exports `SSH_ASKPASS`, so the system dialog pops up outside Ember. In the interactive run, the jump's password
     prompt arrives through Ember's askpass, but the card says "Sign in to build-01" (§8.6). The user may then type
     build-01's password for the jump host, or the jump host's for build-01.
   - Hang: on a Windows PC, ssh.exe started with `windowsHide` has a hidden console. The jump hop reads its password
     from that console and hangs for ever. `ConnectTimeout` doesn't cover authentication or ProxyCommands (SSO
     helpers such as `cloudflared`, `tsh` or `gcloud` IAP), and the design sets no wall-clock limit before the probe.
   - Evidence: OpenSSH `ssh.c` ProxyJump `xasprintf(&options.proxy_command, …)` (only -l/-p/-J/-F/-v carried);
     design.md:2101-2131, 2133-2152.
   - Fix:
     - When `ssh -G` reports `proxyjump`, rewrite it into an explicit `-o ProxyCommand=<abs ssh> -T -o BatchMode=…
       -o StrictHostKeyChecking=yes -o ControlMaster=no -o ControlPath=none -o ForwardAgent=no
       -o ClearAllForwardings=yes -W [%h]:%p -- <hop>`, recursively for chains. Validate each hop with `validDest` and
       run `ssh -G` on each hop with the same refusals.
     - In batch runs, set `SSH_ASKPASS_REQUIRE=force` with `SSH_ASKPASS=<a helper that exits 1>` (≥ 8.4), or on 8.0
       unset `SSH_ASKPASS` and set `DISPLAY` to a value no askpass can use. Then any unexpected prompt fails at once
       instead of popping up or hanging.
     - Label each askpass card with the host named in the prompt text (shown as untrusted), plus "via <jump>".
     - Add an overall deadline: no `EMBER-PROBE-BEGIN` within 45 s means kill ssh, with the message "build-01 took
       too long to answer (a jump host or sign-in helper may be waiting)".

5. **Reconnecting collides with the dying agent's single-instance lock, so reconnect gives up at once.**
   - Problem: after a stall, the old agent keeps its lock until its dead-man fires (3 s) and its parts stop (up to
     1 s). Reconnect tries again after 1 s and 2 s (design.md:2290). The new bootstrap finds the lock held and answers
     "busy". The design says that message means another computer ("Ember from another computer is already working",
     design.md:2556). It is also a non-network failure, which ends reconnect ("giving up … at a non-network failure").
     So the most common loss (a short blip) can't recover by itself. Two PCs bootstrapping at once also race in
     staging before any lock exists.
   - Evidence: design.md:2266, 2290-2293, 2552-2557, 2564-2565.
   - Fix:
     - Write the PC's identity into the lock: a random per-install `pcId` from settings, sent in the INSTALL/SERVE line
       and in `hello`.
     - If the lock's `pcId` equals the caller's, wait up to 6 s (the dead-man plus exit plus a margin) and then take
       the lock over by sending SIGTERM to the stale pid, which is the same uid.
     - Treat "busy" as retryable during reconnect.
     - Take a `mkdir`-based lock in the bootstrap around INSTALL, so two PCs never unpack into the same folder at once.

6. **Windows PC: the askpass "when it works" path is underspecified and unsafe as an obvious port; gate it by version,
   not by a CI result.**
   - When askpass runs: Win32-OpenSSH's `read_passphrase` runs `SSH_ASKPASS` only when that variable is set, and
     askpass is chosen only with `SSH_ASKPASS_REQUIRE=force`. `DISPLAY` means nothing there, and the hidden console
     counts as a terminal. So it needs ≥ 8.4.
   - Which clients have it: Windows 10's in-box client is older (7.7p1 or 8.1p1; verify), while Windows 11 has 8.6p1
     or 9.5p1. The `windows-2022` runner's client says nothing about a Windows 10 user's (design.md:3277, L15).
   - Helper type: the helper is started with CreateProcess and the prompt as its argument. The shell wrapper of
     §5.1.6 has no Windows form, and the obvious one (`askpass.cmd`) runs through `cmd.exe`. A keyboard-interactive
     prompt is server text, and one containing `"&…&"` then runs commands on the PC (the BatBadBut class).
     `Ember.exe` with `ELECTRON_RUN_AS_NODE=1` can't be the helper either: it would treat the prompt as a script path.
   - Missing paths: the unknown-host-key case on Windows has no route at all (batch only) and no message (§8.7 has
     only "auth (Windows PC)").
   - Evidence: PowerShell/openssh-portable `readpass.c`, the `#ifdef WINDOWS if (getenv(SSH_ASKPASS_ENV))` block;
     design.md:2153-2157, 3110, 3277.
   - Fix:
     - Enable askpass on Windows when `ssh -V` is ≥ 8.4, with `SSH_ASKPASS_REQUIRE=force`.
     - The helper is `Ember.exe` itself in an "askpass mode": `main.ts`'s first lines check `EMBER_ASKPASS_NONCE`
       before the single-instance lock or any window, connect to the pipe, print the answer and `app.exit`. It is
       never a `.cmd` or `.bat`.
     - For older clients, add the message "Connect once with `ssh build-01` in a terminal, check its key, then try
       again", and for passwords the ssh-agent advice.
     - Spawn ssh.exe so that no stray prompt can block on a hidden console (item 4's deny-all askpass, plus the
       deadline).

7. **A 3-second network stall ends every running command on that remote.**
   - Problem: the agent's dead-man stops everything after 3 s without a frame, and the PC declares the link lost
     after 5 s and stops every task (design.md:2264-2276). One lost segment costs a TCP retransmission timeout of at
     least 1 s, then 2 s: about 3 s. Wi-Fi roaming, VPN rekeys and laptop lid-closes do this routinely. A 10-minute
     build that D4.2 lets run without asking is killed by a blip, the task ends, and nothing resumes (§5.1.13). That
     is safe, but it works against the owner's "allow most commands" on real networks.
   - Evidence: design.md:2266-2268, 2287-2293, 2890 (T12).
   - Fix: split the dead-man by what is at stake.
     - Desktop steps: keep the 1.5 s freshness gate for `act`, `apps.launch` and `cmd.run`, and keep the 3 s stop.
     - Running commands: stop only after a longer silence, 20 s by default (an admin key
       `ssh.commandGraceSeconds`, minimum 3). The PC says "build-01 isn't answering: its running command stops in
       20 s unless the link comes back."
     - The PC: mark the link "stalled" at 5 s (no new steps, tasks paused) and "lost" at the same 20 s.
     - The kill switch still kills the ssh process at once. Say plainly (L10) that a command on an unreachable remote
       ends within the grace period, not within 300 ms. If the lead rejects this, record it as a known limitation.

8. **When the agent dies abnormally, its commands are orphaned; the normal stop exits before its own ladder ends.**
   - Watchdog: the watchdog SIGKILLs the agent when its loop stalls for 2 s (design.md:2268), and the OOM killer can do
     the same. Children "exit on their own stdin's EOF" (design.md:2419-2420), but `script` passes EOF to the PTY as
     ^D: a `make` that doesn't read stdin keeps running. With the agent gone, nobody can stop it: neither Stop, nor the
     kill switch, nor the next connect.
   - Normal stop: §5.3.11 exits "after the parts finish or 1 s", but the ladder sends SIGKILL at 1000 ms and sweeps
     at 1500 ms (design.md:1662-1665), so the last two steps race the exit.
   - Evidence: design.md:1655-1685, 2268, 2413-2420, 2559-2565.
   - Fix:
     - The watchdog thread keeps the live runs' process-group ids in a `SharedArrayBuffer`. Before it SIGKILLs the
       agent, it sends SIGKILL to each `-pgid` (`process.kill` works in a worker) and runs the
       `/proc/*/environ` `EMBER_RUN_ID` sweep.
     - Serve writes `runs/<runId>` stamps in the per-session folder. At start-up, it sweeps and kills processes that
       carry a stamped `EMBER_RUN_ID` whose agent pid is gone, and audits them as `stop`, `source: "orphan"`.
     - On EOF or the dead-man, nobody is watching, so start the ladder at SIGTERM, send SIGKILL at 300 ms, and exit
       no earlier than 1.6 s (or when the parts finish).

9. **Wayland remotes ("text", R6/L5) will almost never come up as designed.**
   - Environment: the session's processes in `session-S.scope` (gdm-wayland-session, the gnome-session leader, and
     gnome-shell on GNOME 3.32) started before the compositor created its sockets, so their `environ` has no
     `WAYLAND_DISPLAY` and no Xwayland `DISPLAY`. On GNOME ≥ 3.34 (RHEL 9, Ubuntu 22.04+), gnome-shell runs as
     `org.gnome.Shell@wayland.service` under `user@<uid>.service`, not in the session scope at all.
   - Notice: the notice is a GTK 3 window that must be "always-on-top, all-workspaces, top centre" (design.md:2540).
     Native Wayland ignores `set_keep_above`, `move` and `stick`. And "notice failed → desktop none" (design.md:2544).
   - Untested: Perception with `x11: null` has never run against a real session, because the local app refuses
     Wayland (`environment.ts:144-147`).
   - Evidence: design.md:2462-2467, 2486-2488, 2540-2546; `app/main/environment.ts:144-147`.
   - Fix:
     - Environment for Wayland (and as a second source on X11): read the systemd user manager's `Environment`
       property (`busctl --user get-property org.freedesktop.systemd1 /org/freedesktop/systemd1
       org.freedesktop.systemd1.Manager Environment`), which gnome-session updates. Parse it inside the agent and
       keep only the allow-list (never print or send it). Accept `WAYLAND_DISPLAY` only when
       `$XDG_RUNTIME_DIR/<name>` is a socket owned by the uid.
     - Notice: run it with `GDK_BACKEND=x11` on the Xwayland `DISPLAY` found that way, where keep-above works for X11
       clients. Without Xwayland, use a persistent desktop notification with a "Stop" action through
       `org.freedesktop.Notifications`, with the `resident` hint and urgency critical. Only when neither works is the
       desktop "none".
     - Add a CI job: `mutter --headless --wayland --virtual-monitor 1280x1024` (or weston's headless backend) with
       `dbus-run-session`, at-spi2-core and a GTK test window, exercising the "text" path.

10. **STIG-hardened RHEL 8 (fapolicyd, confined SELinux users) blocks the runtime from `$HOME`, and the probe can't
    tell.**
    - Problem: the DISA RHEL 8 STIG requires fapolicyd. Its default trust is the RPM database, and its rules refuse
      to run untrusted ELF files ("Operation not permitted") and to open untrusted language files such as
      `ember_atspi.py`. Install succeeds, then `exec node` fails, and the user sees a generic `EMBER-ERROR` or a
      "network" message. SELinux confined users (`user_u`/`staff_u` with `user_exec_content` off) produce the same
      result.
    - Evidence: design.md:2217 (only `noexec` is probed), 2236-2239; RHEL 8 fapolicyd documentation (a copied
      `/bin/ls` run from `/tmp` is refused).
    - Fix:
      - Probe `fapolicyd=$(systemctl is-active fapolicyd 2>/dev/null)` and `selinux_user=$(id -Z 2>/dev/null)`.
      - After unpacking, and before writing `.verified`, run `"$rt/bin/node" --version`. On failure, print
        `EMBER-ERROR exec-denied` and remove the staging folder.
      - Message: "build-01's security software doesn't let programs from your home folder run. Ask its administrator
        to allow Ember's helper (fapolicyd trust), or to install the Ember remote package."
      - Keep the root-owned `/opt` package (install-transport.md §4.3 B5) as the documented route for managed fleets.

11. **macOS remote commands: TCC blocks `~/Desktop`, `~/Documents` and `~/Downloads` over SSH, and `$TMPDIR` may be
    unset.**
    - TCC: anything run under `sshd-keygen-wrapper` without "Allow full disk access for remote users" gets
      `Operation not permitted` in the Files-and-Folders locations (Desktop, Documents, Downloads, iCloud Drive,
      removable and network volumes), not only under `~/Library`. That is where Mac projects usually live, and the
      doctor hint mentions only `~/Library` (design.md:2489-2491).
    - Temporary folder: §5.2.3 puts the per-session folder in `$TMPDIR/ember-remote/`, but SSH logins on macOS don't
      reliably get `TMPDIR` (launchd sets it for GUI sessions).
    - Evidence: design.md:2364, 2486-2491; remote-desktop.md §5.1.
    - Fix:
      - Probe with a fixed test (`ls "$HOME/Documents" >/dev/null 2>&1; echo $?`).
      - When it is refused, say so in the SSH consent card and in a doctor row: "Commands on <Mac> can't open your
        Desktop, Documents or Downloads folders until "Allow full disk access for remote users" is on (System
        Settings › General › Sharing › Remote Login › ⓘ)."
      - Use `getconf DARWIN_USER_TEMP_DIR`, then `/tmp`, for the per-session folder.

12. **"Seat 0, Remote = no" rules out the remote desktops people actually use from SSH (VNC and xrdp).**
    - Problem: a machine one SSHes into usually has nobody at its console. When it does have a logged-in desktop,
      that is mostly a TigerVNC `vncsession` or an xrdp session: seat-less, and `Remote=yes` for xrdp. §5.3.4 accepts
      only an active, unlocked `seat0` console session of the same uid, so the remote-desktop half of decision 2
      covers mainly a second physical workstation. The design doesn't say so; L4 and L6 discuss other limits.
    - Evidence: design.md:2454-2459; remote-desktop.md §1 P2. logind treats seat-less sessions as always active.
    - Fix (lead or owner decision, stated either way): allow a seat-less X11 session of the same uid when it is that
      uid's only graphical session. The local user can watch it in their VNC or RDP viewer, which also lowers the
      "someone at the console" risk. Otherwise add L21: "Remote desktops reached through VNC/xrdp aren't used in v1",
      and say it in the consent card ("build-01's desktop is a remote session: Ember will run commands only").

## Minor

13. **X11 environment discovery is brittle beyond RHEL 8.**
    - (a) On GNOME ≥ 3.34, gnome-shell isn't in the scope (item 9), so "prefer gnome-shell" falls through to "any",
      which may be `gdm-x-session` or `Xorg`, whose environ has no `DISPLAY`.
    - (b) Where gnome-shell carries file capabilities (`cap_sys_nice`, shipped by some distros), its
      `/proc/<pid>/environ` is root-only (not dumpable).
    - (c) Whether logind's `Display` is set for GDM's Xorg-as-user sessions is unverified. The nightly eval itself
      falls back to `:0` (`.github/workflows/nightly-eval.yml:84-87`).
    - (d) `pam_namespace` or a private `/tmp` can hide `/tmp/.X11-unix/X<N>`, while Xlib connects through the
      abstract socket anyway.
    - Fix: pick the first readable scope process whose environ has a local-form `DISPLAY`, and take
      `XDG_SESSION_ID=S` as confirmation. When logind's `Display` is empty, accept that `DISPLAY` after `openX11`
      succeeds. Accept a display that opens even when the socket file isn't visible. Keep refusing any host part.

14. **Lock detection trusts `LockedHint` alone.** Lockers other than GNOME's (xscreensaver, light-locker, xsecurelock)
    don't set it, so a locked screen reads as unlocked (design.md:2456). Fix: also treat the screen as locked when the
    X screensaver extension reports on or DPMS is off (the existing check, `hands/input.ts:477-488`), or when
    `org.gnome.ScreenSaver.GetActive` is true.

15. **The desktop child's environment has no `HOME`, `PATH`, `USER` or `SHELL`.** Step 4 keeps only session variables,
    and step 6 runs `appEnv` on that set (design.md:2462-2473; `appEnv`'s `KEEP` takes them from its base,
    `hands/system.ts:485-515`). gedit, gtk-launch and python would start without `HOME`, and with `PATH` defaulting to
    `/usr/bin:/bin`. Fix: build the base from the agent's own sanitised environment (`HOME`, `USER`, `LOGNAME`, `SHELL`,
    `PATH`, `LANG`), lay the session's allow-listed variables over it, then apply `appEnv`.

16. **Bootstrap hygiene, and L9's claim on SSH.** sshd runs the login shell's start-up (bash sources `~/.bashrc` for
    sshd commands, zsh `~/.zshenv`), so `LD_PRELOAD`, `LD_LIBRARY_PATH` (conda, environment modules) and `DYLD_*` reach
    `node`. They can break it (a different `libstdc++`) or inject code. L9's "conda, nvm… are absent" is also untrue
    on SSH: commands inherit the agent's environment, which those rc files built (design.md:36, 2191). Fix: the
    bootstrap also unsets `LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH` before `exec`,
    and the agent refuses to start with them set. Reword L9 for SSH: "start-up files the remote login itself ran
    still apply".

17. **The "nothing after the script until `EMBER-PROBE-END`" rule is load-bearing; state it.** dash (`sh` on
    Debian/Ubuntu) reads a script from a pipe in blocks. Tested here: with the script, the decision line and the
    payload written together, dash swallowed them all, ran nothing and printed nothing. The design only implies the
    wait ("writes the script to stdin, then waits", design.md:2183-2186). Fix: a MUST in §5.1.9 (the PC writes nothing
    more until it has read `EMBER-PROBE-END`), and a unit test with a fake ssh that would fail if the PC pipelines.
    `ssh-linux` covers dash, since `/bin/sh` is dash on ubuntu-24.04.

18. **Failure classification gaps.**
    - (a) cmd.exe's "is not recognized" is localised (German: "…konnte nicht gefunden werden"), and Git for Windows'
      `sh.exe` on `PATH` runs the probe under MSYS (`uname -s` = `MINGW64_NT-…`), which gives "Ember can't work on
      MINGW64_NT… computers".
    - (b) `ForceCommand`, `command=` restricted keys, `git-shell`, `nologin`: no probe ever starts.
    - (c) `Bad configuration option`, `Unsupported option`, and Windows' `getsockname failed: Not a socket` from
      shared configs (`UseKeychain`, `ControlMaster`).
    - Fix (design.md:2166-2180): add a row "no `EMBER-PROBE-BEGIN`, exit ≠ 255" → "build-01 didn't run Ember's set-up
      (it may be Windows, or this login runs a fixed program)". Map `MINGW*`/`MSYS*`/`CYGWIN*` to the Windows
      message. Add a `config` class quoting the offending line from stderr. Add the overall deadline from item 4.

19. **ssh_config keys that break Ember's stdio channel.** On OpenSSH ≥ 8.7, `SessionType none`, `StdinNull yes` and
    `ForkAfterAuthentication yes` in a host's block break the channel. On Windows, `UserKnownHostsFile NUL` is the
    `/dev/null` equivalent and isn't refused. Fix: after `ssh -V`, add `-o SessionType=default -o StdinNull=no
    -o ForkAfterAuthentication=no` when the version is ≥ 8.7 (older clients reject unknown options). Extend the
    known-hosts refusal to `nul`, compared without regard to case.

20. **Noticing the user's ssh drops their command-line options.** `sshDestination` keeps only dest, user and port
    (design.md:474-485), so `ssh -J bastion build-01`, `-i key`, `-F cfg` or `-o HostKeyAlias=…` make Ember's own
    connection fail or go another way. On Windows, `ssh` run inside a WSL tab isn't a Windows process and is never
    noticed. Fix: carry `-J`, `-i`, `-F` and an allow-list of `-o` keys (Port, User, ProxyJump, IdentityFile,
    IdentitiesOnly, HostKeyAlias, HostName) into the host record. Show them on the consent card. State the WSL case
    as a limitation, or use a fixed `wsl.exe --exec ps` read when the focused terminal is a WSL tab.

21. **Node 24's floors aren't probed.** Node 24 needs macOS ≥ 13.5 (not 13.0) and Linux kernel ≥ 4.18 (Node
    `BUILDING.md` v24.x); design.md:102 promises "macOS 13+". Fix: probe `sw_vers -productVersion` and `uname -r`, and
    refuse with "build-01's system is too old for Ember (it needs macOS 13.5 or newer / Linux 4.18 or newer)".

22. **The same-machine check gives false positives on cloned VMs.** Golden images and VDI clones often share
    `/etc/machine-id`, so Ember would say "build-01 is this computer" (design.md:2301). The per-machine state key
    (design.md:2368) would also merge such clones on a shared NFS home. Fix (Linux to Linux): refuse only when both
    the machine-id hash and the `boot_id` hash match. Key the state folder by the machine-id hash plus a hash of the
    hostname.

23. **Stop over slow links can cost the link.** Up to 2 × 256 KiB credited plus 64 KiB of diag (about 576 KiB) can be
    in flight from the remote, in sshd and TCP buffers. Below about 4 Mbit/s with heavy output, the `stop` answer
    lands after more than max(1 s, 3 × RTT). The PC then kills ssh, the link is lost and its tasks end
    (design.md:2256-2258, 2270, 2788). Fix: grant 64 KiB per stream and grow it only while the measured throughput
    keeps the in-flight time under 250 ms. Set the escalation deadline to 3 × idle RTT + inFlightBytes ÷ throughput.

24. **The askpass socket path can exceed macOS's 104-byte `sun_path`.** `/Users/<user>/Library/Application
    Support/Ember/ssh/askpass-<32 hex>.sock` is about 109 bytes for an 18-character user name (design.md:2141). Fix:
    an 8-hex random name in a 0700 `mkdtemp` folder under `getconf DARWIN_USER_TEMP_DIR`, with a length check that
    falls back to `/tmp`.

25. **The bundle check as worded fails on Ember's own code.** "fails if … sharp … or `fetch` appear in … its code"
    (design.md:2355-2357) trips on `capture.ts:52` (`requireCjs("sharp")`, lazy, never called remotely) and on
    `policy.ts:1632` ("…can fetch from the internet…"). Fix: check the esbuild metafile's import graph (resolved
    `node:net`/`http`/`https`/`tls`/`dgram`, `electron`, `sharp`, `@github/copilot-sdk`). Have the remote build
    replace capture.ts's sharp loader with a throwing stub through an esbuild plugin, and test that.

26. **koffi's layout in the parts, and the arm64 glibc floor.** koffi finds its binary at
    `<koffi>/../@koromix/koffi-<os>-<arch>` (`node_modules/koffi/src/koffi/index.cjs:199`), resolved from the bundle's
    `createRequire(__filename)`. Fix: ship `versions/<id>/node_modules/koffi/` and
    `versions/<id>/node_modules/@koromix/koffi-<t>/` beside `ember-remote.cjs`, and remove the musl build. Run
    `scripts/check-symvers.sh` on every target's `koffi.node` (readelf works across architectures) so linux-arm64 is
    held to the same 2.28 floor.

27. **Runtime churn and transfer time.** "The newest Node 24 release at least 14 days old when SB builds"
    (design.md:2324) means most Ember updates re-upload about 30 MB to every remote: 25 s at 10 Mbit/s, about 4 min at
    1 Mbit/s. Fix: `remote-runtime.json` names a minimum (security) version; any verified runtime of that major at or
    above it is reused. Bump the pin only for security releases. Optional: when the probe finds `curl` and the user's
    uplink is slow, the remote fetches the pinned file itself and checks the SHA-256 there (install-transport.md §4.3
    B4).

28. **PNG screenshots are large over SSH.** A masked 1280 px PNG of a desktop is about 0.5-1.5 MB (design.md:2785), so
    each perceive-with-image costs 3-6 s at 2 Mbit/s. Fix: a small baseline JPEG encoder in TypeScript
    (`app/remote/jpeg.ts`, about 300 lines, no dependency) at quality 78, matching local captures. That is about 5×
    smaller. Masks are still painted before encoding.

29. **macOS PC: Local Network privacy.** On macOS 15, ssh's connections to LAN addresses are charged to Ember.app.
    Without the grant they fail with "No route to host", which §5.1.8 reports as network or VPN. The existing
    `NSLocalNetworkUsageDescription` speaks only of the AI service (`scripts/package/mac-bundle.mjs:42`, an I-mac
    file), and the ad hoc signature can lose the grant on update. Fix: ask I-mac to mention SSH computers in that
    string. When an RFC 1918 or link-local host gives "No route to host" on darwin ≥ 15, add "Allow Ember in System
    Settings › Privacy & Security › Local Network."

30. **Spike notes for SX (Windows remotes).**
    - cmd's 8191-character command line rules out sending the bootstrap as the remote command, and
      `-EncodedCommand` is a common EDR detection: use a short plain stage 1 that reads stage 2 from raw stdin
      (`[Console]::OpenStandardInput()`, exact-length loops).
    - Verify that PowerShell 5.1 doesn't pre-read redirected stdin before it starts `node.exe` with inherited
      handles.
    - Key-based logins get an S4U token with no DPAPI or network credentials, so Git Credential Manager, `gh` and
      network shares fail inside commands. Say so on the consent card.
    - Node writes to pipe stdout synchronously on Windows (Node docs, "A note on process I/O"), so a slow link
      stalls the agent's loop against its 2 s watchdog. Write frames from a worker thread there.
    - Task Scheduler deletes a task only after its trigger's `EndBoundary` passes (`DeleteExpiredTaskAfter`), so the
      "expiry" needs a one-shot trigger with an end boundary. Specify which session an interactive task runs in when
      the user has both a console and an RDP session.

31. **Spike notes for SX (macOS desktop).** `open -g -a Ember --args --remote-helper` passes no arguments when Ember
    is already running for that user, and `-n` then meets Ember's single-instance lock. The helper needs its own entry
    that skips the lock, or a separate helper bundle. TCC grants on an ad hoc-signed Ember.app are tied to its code
    hash and are lost on every update.
