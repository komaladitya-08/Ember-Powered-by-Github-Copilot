# Critique of sshwsl/design.md through the WSL feasibility lens

Reviewer: skeptical WSL reviewer. Read: `sshwsl/design.md` (all of §1-§4, §3.1-§3.14, §5.1.9, §5.1.14, §5.3.4, §8.4,
§8.7, §8.8, §10, §11.2, the critique resolutions), `decisions.md`, `wsl.md`, `gaps.md` §5. Code read on the branch as
it stands now (`74a5cdc`, I-win and I-mac merged after the design's `dcbbb6b`): `perception/index.ts`,
`perception/sidecar.ts`, `policy/remote-surface.ts`, `hands/terminals.ts`, `policy/vocabulary.ts`, `main.ts`,
`platform/win32/{windows,rules,ffi}.ts`, `platform/win32/system/apps.ts`, `platform/linux/system.ts`,
`sidecar/atspi/ember_atspi.py`, `agent/worker.ts`.

External evidence (fetched 2026-10-22):
- Vampire/setup-wsl README: "Beginning with later `windows-2022` virtual environment version for GitHub actions, WSLv2
  is also available"; `wsl-version` default `2`; its own test matrix runs `wsl-version: [1, 2]` on `windows-2022`,
  `windows-2025`, `windows-latest`; the wrappers run as the distro's default user, "usually … `root`".
- actions/runner-images: Windows2022-Readme lists "Windows Subsystem for Linux (WSLv1): Enabled"; Windows2025-Readme lists
  "Windows Subsystem for Linux (Default, WSLv2): 3.0.3.0".
- Microsoft Learn "Basic commands for WSL": `wsl --distribution <D> --user <User>` ("ie. root"), `<Distro> config
  --default-user`, `wsl --export <D> -` (to stdout), `wsl --mount`, imported distros set their default user in
  `/etc/wsl.conf`. `wsl --help`: "--exec, -e: Execute the specified command without using the default Linux shell";
  "--: Pass the remaining command line as is" (i.e. to the default shell).
- microsoft/WSL#8842: with systemd on, WSL's `/init` sets `XDG_RUNTIME_DIR=/run/user/1000/` (and a bus address) while
  the socket may be missing; WSL "automounts the /mnt/wslg/runtime-dir at /run/user/1000"; `user-runtime-dir@` can wipe
  it, and the WSLg mount can over-mount the systemd user bus socket (still reported on WSL 2.5.7). ArchWSL#357: the
  same conflict needs tmpfiles symlinks.
- microsoft/WSL#2164: WSL's WSL-to-Win32 argument quoting is inconsistent (tabs not quoted).
- elevenforum "WSL2 -- How to remove 'WARN:COPY MODE' from each WSL2 window?" and The Register's WSLg first look:
  WSLg window titles can carry a "[WARN:COPY MODE]" prefix.

Severity: **blocker** = the design as written lets a dangerous command run without asking, or a promised v1
capability cannot work and nothing in the plan fixes it; **major** = wrong on common real setups or weakens a safety
rule; **minor** = edge cases, wording, robustness.

---

1. **`wsl.exe` / `wslg.exe` / `bash.exe` / distro launchers are classified as plain argv, but without `-e/--exec` they
   run their arguments through the distro's default shell. That lets a destructive command through without asking.**
   - Evidence: design §3.4.5: "`wsl.exe [-d D] [--] cmd…` and `wsl -e`: the inner argv classified as POSIX words (no
     shell)". `wsl --help` says the opposite for the first form: without `--exec`, and with `--`, "the remaining command
     line" goes to the default Linux shell. So `wsl -- "rm -rf ~/project"` (from PowerShell on the local Windows target,
     or as `wsl.exe -- '…'` from inside WSL through interop) reaches the classifier as one program word
     `rm -rf ~/project`. That word is in no table. §3.4's confidence rule doesn't catch a literal word that contains
     spaces or `;`, so it is "ordinary" and runs without asking.
   - Also missing from the "complete" tables (§3.5; only §4.2's prose names a few):
     - `wsl -u/--user root` (documented, passwordless root) and `--user <other>`;
     - `--system` (the WSLg system distro);
     - `-d docker-desktop*` (root in Docker's VM);
     - `--mount`/`--unmount` (admin; raw disks);
     - `--export <D> <file|->` (the whole Linux filesystem, `~/.ssh` included);
     - `--import`, `--import-in-place`, `--set-version`, `--manage`, `--debug-shell`;
     - `<distro>.exe config --default-user root`;
     - legacy `bash.exe -c`, `ubuntu*.exe run …`.
   - The nested classification also uses the wrong context. On a Windows target `~`, `$HOME` and relative paths resolve
     to the Windows profile and cwd. So `wsl cat ~/.netrc` resolves to `C:\Users\ana\.netrc`, which is not in the
     Windows secret list (only `_netrc` is), and prints the WSL `.netrc` without asking.
   - Severity: **blocker**.
   - Fix (CL, `tables.ts`/`classify.ts`):
     - (a) Program words `wsl`, `wslg`, `bash` (on Windows), `wslhost`, and any `*.exe` whose base name is a registered
       distro launcher: parse wsl's own options first. `-e/--exec` → argv semantics. Otherwise join the remaining
       args with single spaces and classify the result recursively as POSIX shell text. If any arg contains a space,
       quote, backslash or shell metacharacter, the join is ambiguous (PowerShell 5.1 and cmd re-quote differently) →
       "unclear".
     - (b) Rows: `-u/--user` → e ("Runs as root in WSL" / "as another user"); `--system`, `-d docker-desktop*` → e;
       `--mount/--unmount`, `--import*`, `--set-version`, `--manage`, `--update`, `--install`, `--shutdown`,
       `--terminate`, `--set-default*`, `config --default-user` → e; `--unregister` → a; `--export` → d ("Copies a whole
       Linux system, with its keys and passwords").
     - (c) Classify the inner text with a WSL `ClassifyContext` for the named or default distro. Use its facts when
       Ember has them. Otherwise `~`, `$HOME` and relative paths are unresolved, and the secret-path rules also test
       the POSIX list against `/home/*/` and `/root/`.
     - Add the corpus cases `wsl -- "rm -rf ~"`, `wsl rm -rf ~`, `wsl -u root id`, `wsl.exe -d docker-desktop sh`,
       `wsl --export Ubuntu -`.

2. **Identified WSLg windows can never appear in a screenshot. Perception masks remote surfaces by the window stack's
   program name, which stays "msrdc". Step 0 has no hook to change that.**
   - Evidence:
     - `perception/index.ts:680-684`: `remoteSurfaces()` masks every stack window where `isRemoteSurface(w.wmClass)`
       is true.
     - `main.ts:1260-1267` passes `x11: ws` (the raw Windows window system) and `isRemoteSurface:
       remoteSurfaceCheck(platform.os)` (an app-name test).
     - Design §4.4 wraps only the sidecar (`wrapForWsl(base, o)`). The §11.2 `main.ts` hook list (items 1-12) has no
       hook for the stack, `currentWindow`, `activeWindow` (`main.ts:1352`, `1380`: `wmClass`) or the
       remote-surface check.
     - So L7/§4.7's "screenshots" of WSLg apps can't happen: every RAIL HWND, identified or not, is blacked out whole.
       A task that starts on a focused WSLg window gets `spec.target.app = "msrdc"` (`worker.ts:847`).
   - Severity: **blocker** (fails closed, but a v1 deliverable is undeliverable within the contract, and WB can't edit
     the shared files to fix it).
   - Fix (S0): add `wrapWindowsForWsl(ws, router): PerceptionWindows` in `app/main/wsl/routed-windows.ts` (S0 stub =
     identity). Main passes its result as Perception's `x11`, to the hands' window lists, and to
     `currentWindow`/`activeWindow`. It rewrites `wmClass` of RAIL HWNDs the router identified (with a transform) to
     `wsl:<distro>:<app>`, and leaves unidentified ones as `msrdc`. The existing `isRemoteSurface` keeps masking exactly
     the unidentified ones. Alternatively change `PerceptionOptions.isRemoteSurface` to take the `StackedWindow` and
     let the router answer per HWND. Add `sshwsl-contract` tests: an identified RAIL HWND is unmasked; an unidentified
     one is masked.

3. **Windows programs reached through interop are matched case-sensitively and with `.exe` dropped only in lower
   case. `CMD.EXE /c rd /s /q C:\…` therefore classifies as an unknown, ordinary program.**
   - Evidence: §3.4.4: "lookup is case-insensitive on Windows and macOS and for PowerShell cmdlets everywhere" (WSL is
     not listed). Windows directories under drvfs are case-insensitive by default, and `appendWindowsPath` puts
     `/mnt/c/Windows/System32` on the WSL PATH. So `CMD.EXE`, `Cmd.exe`, `POWERSHELL.EXE` and `WSL.EXE` all run from
     bash. Program `CMD.EXE` is in no row → ordinary → `rd /s /q` runs without asking. `.bat`/`.cmd` files run through
     interop are executed by cmd with cmd's metacharacter parsing.
   - Severity: **blocker** (a D4.3 class-a bypass reachable by prompt injection).
   - Fix (CL): on a WSL target, a program word that resolves, or would resolve, under the mount root, or that ends in
     `.exe|.com|.bat|.cmd` in any case, is looked up case-insensitively with the extension removed. `.bat`/`.cmd`
     programs are classified as `cmd /c "<joined args>"`. A cmd-family program whose args hold cmd metacharacters
     (`& | < > ^ % !`) outside a single literal `/c` text → unclear. Corpus: `CMD.EXE /c del x`,
     `PowerShell.EXE -c Remove-Item x`, `./x.BAT`.

4. **Secret-path and Ember-path rules miss the cross-boundary forms: Windows paths inside nested cmd/PowerShell from
   WSL, and `\\wsl.localhost\…` / `\\wsl$\…` from Windows.**
   - Evidence:
     - §3.6.1: the Windows list is "profile-relative", and WSL uses "the Windows list under the drive mounts
       (`/mnt/c/Users/*/…`)" only. §3.6.2: `ember.paths` holds only the `/mnt/c/…` form inside WSL (§4.2).
     - From a WSL target, `cmd.exe /c type C:\Users\ana\.aws\credentials` is classified recursively as cmd with the
       WSL context, which has no Windows profile. The `.aws\` rule is profile-relative, and no "anywhere" basename
       matches `credentials` → ordinary → printed to the model.
     - `cmd.exe /c rmdir /s /q C:\Users\ana\AppData\Local\ember` → class a (asks, or announces after "delete the ember
       folder") instead of D4.5's flat refusal.
     - From the local Windows target, `Get-Content \\wsl.localhost\Ubuntu\home\ana\.netrc` (or `\\wsl$\…`) matches no
       Windows row.
   - Severity: **major** (class d is "always asks").
   - Fix (CL + WA):
     - `ClassifyContext.wsl` gains `windows: { home, localAppData, appData, temp, systemRoot, emberPaths }` (Ember
       knows them on the PC, so nothing needs asking). Nested cmd/PowerShell classification switches to Windows path
       rules with that context.
     - On Windows targets, normalise `\\wsl.localhost\<D>\…`, `\\wsl$\<D>\…` and `\\?\UNC\wsl…` (case-insensitive) to
       `(distro D, POSIX path)`. Apply the POSIX secret list with D's home when known, else with `/home/*/` and
       `/root/`.
     - Match Ember's paths and secret paths case-insensitively under drive mounts (already said), and also resolve
       8.3 short names (`PROGRA~1`) as unresolved → unclear.
     - The "This can reach your Windows files" line (§3.8.2) should also fire for any interop program and any
       Windows-form path, not only for paths under `mountRoot`.

5. **cmd.exe started from a Linux working folder runs in `C:\Windows`, and WSL re-quotes arguments when it hands them
   to Windows. The object on the card can be wrong.**
   - Evidence:
     - When interop starts `cmd.exe` with a cwd that isn't on a drive mount (`/home/ana/proj` →
       `\\wsl.localhost\…`), cmd prints "UNC paths are not supported. Defaulting to Windows directory." and runs in
       `%SystemRoot%`. So `cmd.exe /c del *.log` from `~/proj` deletes `C:\Windows\*.log`. The classifier resolves it
       against `/home/ana/proj` and the card says "Deletes /home/ana/proj/*.log". (PowerShell accepts a UNC cwd; cmd
       doesn't.)
     - WSL-to-Win32 argument conversion is not a faithful argv join (microsoft/WSL#2164: tabs not quoted). The
       recursive cmd/PowerShell parse of "the literal text" may not be the line the Windows program receives.
   - Severity: **major**.
   - Fix (CL): in a nested cmd classification from a WSL target whose cwd is not under `mountRoot`, resolve relative
     paths and globs against `systemRoot`, and add the card line "cmd can't use a Linux folder, so this runs in
     C:\Windows". Simpler: make it unclear. For any interop program, if an argument contains a tab, a double quote or a
     trailing backslash → unclear.

6. **Interop and desktop launchers that outlive the kill switch are "ordinary". A GUI app started by a command is
   killed at the command's timeout.**
   - Evidence:
     - §3.4.7's outliving list has `start`, `Start-Process`, `nohup`… but not `explorer.exe <path|url>`, `wslview`,
       `xdg-open`/`gio open`/`gnome-open` (which wslu routes to Windows' shell), `rundll32 url.dll,FileProtocolHandler`,
       `Invoke-Item`, `code`/`code-insiders`/`cursor` (from WSL, `code .` starts a VS Code Server daemon in the distro
       and VS Code on Windows), or `cmd.exe /c start` when the recursion isn't taken.
     - These hand work to Windows' shell or to a daemon, outside the job object and the `EMBER_RUN_ID` sweep. With a
       file argument they run the file's handler (`explorer.exe x.bat` runs it).
     - Conversely, a foreground GUI program (`gedit notes.txt`, `notepad.exe x`) holds the command open until the
       120 s timeout. The ladder then kills the user's app.
   - Severity: **major** (D4.3 f completeness; surprising data loss in an editor).
   - Fix (CL + AG):
     - Add those launchers to class f ("Opens a program that keeps running after Ember stops."). With a file operand
       that this task downloaded, it is "Runs a file downloaded in this task.".
     - A known GUI program in command position (a desktop-file `Exec` match, or a `.exe` whose PE subsystem is GUI if
       cheaply knowable, else a table: notepad, explorer, code, gedit…) → "unclear" with "Open apps with open_app
       instead".
     - §3.15's worker prompt says: "Open apps with open_app, not run_command."

7. **The distro's default user taken from the registry is not authoritative.**
   - Evidence: design §4.1 reads `Lxss\{GUID}\DefaultUid` first, and `defaultUid` "asked inside it once (starts it) when
     the registry didn't say". §4.3: "Root default user (`WslService.defaultUid` 0) → not started". Microsoft Learn: for
     imported distros the default user is set in `/etc/wsl.conf` `[user] default=`, which wins over the registry.
     setup-wsl distros, `wsl --import` distros and new tar-based distros before OOBE all show `DefaultUid` 0 or absent.
     - Registry 0, wsl.conf `default=ana` → WSLg identification is refused needlessly (common for imported distros).
     - Registry 1000, wsl.conf `default=root` → the in-distro sidecar runs as root and WSLg acting proceeds in a root
       distro (L17/R3 fails open).
   - Severity: **major**.
   - Fix (WA/WB): use the registry only for listing. Take the uid from inside: the facts script's `id -u`, plus a new
     `uid` field in the sidecar's `status`. The router refuses to route to a sidecar reporting uid 0 whatever the
     registry says. The sidecar only starts for running distros, so asking costs no boot.

8. **The AT-SPI bus discovery can pick a bus the apps aren't on. The doctor's "turn on systemd" fix is not shown to
   work under WSLg. Qt, Chromium, Electron and Firefox apps stay invisible even with a bus.**
   - Evidence:
     - Design §4.3 item 1: candidates (a) the newest same-uid process with `DISPLAY`/`WAYLAND_DISPLAY`, (b)
       `/run/user/<uid>/bus`, (c) `$XDG_RUNTIME_DIR/bus`, `/mnt/wslg/runtime-dir/bus`; "the first candidate whose bus
       answers `org.a11y.Bus.GetAddress` wins".
     - Under WSL every process started through wsl.exe has `DISPLAY` and `WAYLAND_DISPLAY` (from `/init`), including
       the user's shells, Ember's own command runs and VS Code's server. "Newest" is arbitrary.
     - A user-bus socket answering `GetAddress` proves only that at-spi2-core is installed. Calling it D-Bus-activates
       a launcher on a bus the apps may not use. WSL#8842 shows `/init` can export a bus address whose socket the
       WSLg mount has hidden. Then the apps have no a11y at all, and the sidecar may still find (b) after a remount.
     - Common WSL advice (`eval $(dbus-launch)` in `.bashrc`) gives one bus per terminal; Start-menu launches (no rc)
       get none. dbus-x11 autolaunch puts the address on the X display, not in any `environ`.
     - WSLg's runtime dir is owned by uid 1000: users with another uid get no Wayland socket.
     - Even on the right bus, at-spi-bus-launcher's `IsEnabled` follows `toolkit-accessibility` (default false off
       GNOME). Qt waits for `IsEnabled`, and Chromium/Electron/Firefox need `ScreenReaderEnabled` or a flag. The
       Linux build has a doctor fix for this (`platform/linux/system.ts:92-97`); the WSL rows (§8.8) don't.
   - Severity: **major** (WSLg reading works only on a lucky subset; fails closed otherwise).
   - Fix (WB):
     - (a) Gather the candidates: the distinct `DBUS_SESSION_BUS_ADDRESS` values found in same-uid `environ`s
       (excluding processes carrying `EMBER_RUN_ID` and the sidecar's own tree), the runtime sockets, and the X11
       root-window `_DBUS_SESSION_BUS_ADDRESS`/`AT_SPI_BUS` properties on `:0`. Probe each without activation
       (`NO_AUTO_START`).
     - (b) Score each candidate by how many of its a11y applications have a frame matching a visible RAIL title of
       that distro. Pick the best with score ≥ 1, else `bus: "none"`. Re-score when RAIL windows appear that match
       nothing.
     - (c) Drop the systemd instruction from §8.7 "WSL no bus" until the manual test (§10.3 item 5) proves it. Say
       instead: "Ember can't find the session bus your Linux apps use in Ubuntu. Apps started from Ember's menu can
       still be read" (if (e) lands), or name the limitation.
     - (d) Add a doctor row and fix `wsl-a11y:<distro>`: "Turn on accessibility for Linux apps in Ubuntu", applied
       through the WSL runner as the fixed argv `gsettings set org.gnome.desktop.interface toolkit-accessibility true`
       (only when a dconf backend exists). Tell the user to restart the apps.
     - (e) Optional, now that D4.1 allows Ember to run programs: B2 for apps Ember launches, through an Ember-owned
       `dbus-daemon --session` in the distro and `wsl.exe -d D --cd ~ --exec env DBUS_SESSION_BUS_ADDRESS=…
       QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 GNOME_ACCESSIBILITY=1 <argv from the parsed .desktop Exec>`.

9. **`program` from `/proc/<pid>/comm` is truncated to 15 bytes. The WSLg terminal check misses GNOME Terminal and
   others.**
   - Evidence:
     - Design §4.3 item 2: "`program` (`/proc/<pid>/comm` of the frame's app, ≤ 32 chars)". The kernel's comm is at
       most 15 characters (TASK_COMM_LEN 16).
     - `gnome-terminal-server` → `gnome-terminal-`, `blackbox-terminal` → `blackbox-termin`, `x-terminal-emulator` →
       `x-terminal-emul`. Firefox's comm is `GeckoMain`.
     - §4.5 judges `wsl:` apps with `linuxIsTerminal({ id: linuxApp, name: linuxApp })`, and `TERMINALS.linux` is an
       exact set (`hands/terminals.ts:37-44`). So `wsl:ubuntu:gnome-terminal-` is not a terminal. Only the VTE
       element's `terminal` role (`policy.ts:1960`) still refuses: menu items (Edit › Paste) and tabs in the terminal
       window become actionable.
     - §10.1's WB test pins `wsl:ubuntu:gnome-terminal-server`, a name the code will never produce.
   - Severity: **major**.
   - Fix (WB, `ember_atspi.py` behind the variable):
     - `program` = basename of `readlink /proc/<pid>/exe`, plus `argv0`/`argv1` basenames from `/proc/<pid>/cmdline`
       (interpreters: `python3 /usr/bin/terminator`).
     - The router's `isTerminalApp`/`isSecurityWindow` union tests each of: exe basename, cmdline names, AT-SPI
       application name, comm. Refuse if any matches.
     - The display/grant name uses the exe basename.

10. **The coordinate model (one top band, k ∈ {monitor scale, 1}) doesn't fit GTK client-side decorations, Weston's
    X11 frames or WSLg's scaling knobs. A wrong transform that passes the checks would misplace secret-field masks.**
    - Evidence:
      - Design §4.9 steps 2-4: `|hwnd.inner.width − frame.width·k| ≤ 2` and a top-only band `0 ≤ dyTop ≤ 48·k`.
      - GTK3 on Wayland (gedit, the README's example) reports its toplevel extents as the whole surface, shadow
        margins included, at (0,0) (no screen origin on Wayland). Its children are offset by the shadow, so the width
        test fails → identity only, no screenshot.
      - GTK4 can report the visible size while children carry the surface (shadow) offset. The width test then passes
        but every mapped bound is off by the shadow inset (≈10-30 px), and masks miss password fields.
      - Weston's XWM frames for X11 apps have side and bottom borders as well as the title bar.
      - `.wslgconfig` `WESTON_RDP_DEBUG_DESKTOP_SCALING_FACTOR` and integer HiDPI rounding give k values that are
        neither 1 nor the monitor's scale.
    - Severity: **major** (privacy: mis-masking, and only partly verifiable).
    - Fix (WB, `match.ts`):
      - (a) Map the **content box**, the union of the frame's direct children's extents, rather than the frame. Use
        an inset model `(l, t, r, b)`: `k = hwnd.inner.width / contentWidth` with `l = r`, `b ≤ 8·k`, `t ≤ 48·k`.
      - (b) Accept any k in [0.5, 4] snapped to 1/8 only when both axes agree within 2 px. Drop the "≈ monitor scale or
        1" rule (or add the `.wslgconfig` factor as a third allowed value).
      - (c) Self-check: the topmost and leftmost children must map to within 3 px of the HWND's inner top-left edge
        band, else no transform.
      - (d) A window with any secret field and no proven transform is masked whole. One with no secret field and no
        transform may be captured, keeping L7's screenshots useful.
      - (e) Add the GTK3/GTK4 CSD and the Weston-frame cases to `wsl-match` fixtures. Make the §10.3 item 5 checklist
        include "a password field in a GTK4 dialog is masked at 150 %".

11. **Title matching misses WSLg's own title decorations. Popups are separate RAIL windows that match nothing.**
    - Evidence:
      - Design §4.9 step 1 strips only "one trailing ` (<distro>)`" (a guess). WSLg prefixes titles with
        `[WARN:COPY MODE]` when it falls back from shared memory (elevenforum thread; The Register: "an ugly '[WARN:
        COPY MODE]' prefix"), so exact matches fail and every window stays unidentified.
      - RAIL title lengths may be truncated by the RDP order.
      - Menus, combo lists and tooltips (`xdg_popup`, X11 override-redirect) are their own RAIL HWNDs. They match no
        AT-SPI frame and stay "msrdc": masked black over the window they belong to, and counted as covering it.
      - `pointerLandsOn` still accepts same-pid popups (`win32/rules.ts:156-162` now; the design cites `:233-240` from
        before the I-win merge), so L7 stands.
    - Severity: **major** (identification is the gate for every WSLg feature).
    - Fix (WB):
      - Normalise both titles: strip a leading `[WARN:…]` bracket group and a trailing ` (<distro>)`, NFC, collapse
        whitespace. Accept a prefix match when the RAIL title is ≥ 100 characters and unique.
      - Associate an unmatched RAIL HWND with an identified one when its Win32 owner chain or bounds-within-parent and
        same msrdc pid say it is a popup of it: it inherits the identity for masking and covering, but never becomes
        an action target.
      - CI records the real titles (item 12).

12. **CI: hosted Windows runners can run WSL2 now. The plan tests WSL1 only, and as root.**
    - Evidence:
      - Design §10.2 `wsl-windows`: "installing Ubuntu 22.04 as **WSL1** (hosted runners can't run WSL2 or WSLg)".
      - setup-wsl tests `wsl-version: 2` on `windows-2022` and `windows-2025` and documents WSLv2 on later windows-2022
        images. windows-2025 ships Store WSL 3.0.3 (WSLv2 default).
      - setup-wsl distros run as root by default, so every command in the job hits D4.6's "every command asks" and
        `defaultUid` 0, and doesn't exercise the ordinary path.
    - Severity: **major** (most of §4's "verify" items could be settled on CI instead of the lead's laptop).
    - Fix (SB/WA, `remote.yml`):
      - Keep `wsl-windows` on windows-2022 with WSL1 for the inbox UTF-16 `wsl.exe` path.
      - Add `wsl2-windows` on windows-2025 (`wsl-version: 2`, Store WSL: `--version`, `WSL_UTF8`, WSLInterop-late with
        systemd on and off). Create a non-root user (`wsl-shell-user`) and set `/etc/wsl.conf` `[user] default=` +
        `wsl --terminate`, which also tests item 7.
      - Add a `wslg-probe` step that installs `x11-apps gedit python3-pyatspi at-spi2-core`, starts `xeyes` and gedit
        through `wslg.exe`, and records, as job artefacts (never as pass/fail until stable):
        - whether RAIL windows appear on the runner's desktop;
        - their class names, titles, owners and msrdc image path;
        - the UIA tree;
        - the Start-menu `.lnk` arguments;
        - the session bus candidates;
        - AT-SPI extents vs HWND rects.
      - Where WSLg is absent there, the step says so and skips.

13. **The WSL target's lease key breaks per-window mutual exclusion on the shared screen.**
    - Evidence: design §2.6 table: `leaseKey` for `wsl:D` is ``k => `wsl:${D}|${k}` ``, while X13 says "WSLg windows are
      part of this screen (local and WSL targets share it)". A local task and a WSL task acting in the same Notepad or
      gedit window get different lease keys, so both can type into it at once. The lease exists to prevent exactly
      that (`tasks.ts:191`).
    - Severity: **major**.
    - Fix (TG/AG): `leaseKey` = identity for `wsl:*` (same screen). Keep prefixes only for SSH targets.

14. **"When I SSH into a system" from a WSL shell is neither noticed nor connectable with Ember's Windows SSH.**
    - Evidence:
      - Design §2.7: `userSshProcesses("win32")` is "a CIM query for ssh.exe of this session". An `ssh build-01` typed
        in a Windows Terminal WSL tab is a Linux process, invisible to Windows.
      - §5.1 uses the PC's OpenSSH with `ssh -G`, the user's config and agent. For WSL-centric users the keys,
        `~/.ssh/config` aliases, agent and `known_hosts` live in the distro.
      - The Windows OpenSSH Authentication Agent service is disabled by default, and L15 rules out password prompts on
        Windows.
      - So on Windows the most common "I SSH into a system" workflow gets no offer, and a manual connect fails with
        "didn't accept your key".
    - Severity: **major** (a headline owner scenario on one of the three OSes).
    - Fix (SA/TG):
      - (a) When WSL is on, the ssh-noticing poll also reads own-uid `ssh` processes in running distros. Use one fixed
        `wsl.exe -d D --exec` reader of `/proc/*/cmdline` filtered to comm `ssh`, through `sshDestination`, only on the
        same triggers.
      - (b) `HostRecord` gains `via?: "wsl:<distro>"`. `sshArgv` then runs `wsl.exe -d D --exec /usr/bin/ssh …` (the
        same argv after `--exec`; the mux is binary-safe through wsl.exe pipes: verify on the `wsl2-windows` job).
        `ssh -G` runs inside the distro too, and noticed hosts default to that `via`.
      - (c) Askpass via WSL is out of v1 (BatchMode only); say so.
      - Otherwise state the limitation plainly in "Limitations and departures".
      - Also say in §5.3.5 that a remote reached over SSH that is itself WSL (`wsl=1`) is "commands only": its WSLg apps
        are on that PC's Windows screen. The logind rules of §5.3.4 already give "none"; the consent card should say
        why.

15. **Windows X servers show Linux apps as opaque pixels, the same gap R12 closed for msrdc. They aren't remote
    surfaces.**
    - Evidence: `policy/remote-surface.ts:27-31` covers `msrdc|mstsc|msrdcw|windows365|rdclient.windows` only. WSL1 users
      and WSLg-off users (`guiApplications=false`) run X apps through VcXsrv (`vcxsrv.exe`), X410 (`x410.exe`), Xming
      (`xming.exe`), GWSL (`gwsl.exe` → VcXsrv) or Cygwin/X (`xwin.exe`). Every Linux window (xterm, a polkit prompt,
      KeePassXC) is that program's window to Ember. Not a terminal, not a security window, not masked; one grant
      covers all. The borrow's same-pid rule takes any of its windows.
    - Severity: **major**.
    - Fix (WB, one line plus tests): add `vcxsrv|x410|xming|xwin|gwsl` to `REMOTE_SURFACE.win32` (refused at every tier
      except read/open_app, masked always). Note in the WSL doctor: "Linux apps shown by an X server (VcXsrv, X410…)
      can't be used; WSLg's can."

16. **The stop ladder and process containment for WSL runs don't hold as written.**
    - Evidence:
      - §3.13 step 1 for pipe runs: "SIGINT to the process group (`process.kill(-pgid)`)". For a WSL run the spawned
        process is `wsl.exe`. On Windows, Node rejects negative pids, and `SIGINT`/`SIGTERM` mean TerminateProcess.
        The pipe variant closes stdin, so `\x03` can't be sent either.
      - Killing wsl.exe first orphans the Linux tree. A silent `sleep`, or a build not writing output, keeps running
        until the sweep (a second `wsl.exe`).
      - Interop children (`notepad.exe`) are Windows processes created by that wsl.exe. The sweep can't see them
        (`EMBER_RUN_ID/u` never crosses back to Windows), and §3.13 assigns job objects only to "Windows" runs.
      - If Ember crashes, nothing stops the in-distro runs or the WSL sidecars: Windows doesn't kill children on parent
        exit.
      - §4.3 item 4's sidecar watchdog fires on `getppid()` changing. Under WSL2 the parent is WSL's per-session relay
        process, which may outlive the Windows client (verify), so the watchdog may never fire.
    - Severity: **major** (Stop and the kill switch must reach what Ember started).
    - Fix (RUN/WA/WB):
      - WSL ladder: PTY runs send `\x03` (as designed). Pipe runs: step 1 = the in-distro sweep with `INT`, step 2 =
        sweep `TERM`, step 3 = sweep `KILL` then TerminateProcess `wsl.exe`. Never kill `wsl.exe` before the last
        sweep.
      - Every Ember-spawned `wsl.exe` (runner, facts, exists, sweeps, sidecar) goes into a `KILL_ON_JOB_CLOSE` job
        right after spawn: it holds interop children (verify on CI) and dies with Ember.
      - The Python watchdog polls stdin for `POLLHUP`/`POLLRDHUP` every 500 ms besides `getppid()`.
      - State the residual: after an Ember crash, Linux processes of a WSL run continue until they write to their
        closed output or the distro stops.

17. **The WSL runner's environment and exit reporting are wrong for everyday commands.**
    - Evidence:
      - §3.3 sends only `EMBER_CMD/u:EMBER_RUN_ID/u:EMBER_COLS/u:EMBER_ROWS/u:TERM/u` through `WSLENV`. §3.3.1's
        additions (`PAGER=cat`, `GIT_PAGER=cat`, `SYSTEMD_PAGER`, `MANPAGER`, `LANG=C.UTF-8` when unset) never reach the
        distro.
      - Inside `script`'s PTY, `git log`/`git diff`/`git show` (D4.2's own examples) start `less` and wait for keys.
        The model has no input tool, so they hang to the 120 s timeout and are killed. `LANG` is unset under
        `--exec` (no PAM or profile), so non-ASCII names print escaped.
      - `WSL_UTF8=1` is set for probes and the sidecar but not for the runner. wsl.exe's own messages ("There is no
        distribution…", `chdir(...) failed`, service errors) then arrive as UTF-16LE inside the PTY/pipe stream, with
        NULs in the window and the model text.
      - wsl.exe's own failures exit 1 or −1, indistinguishable from the command's exit 1, so `failed-to-start` is
        never reported.
    - Severity: **major** (common commands hang; misleading results).
    - Fix (RUN/WA):
      - Put the "add" variables into the fixed POSIX launcher itself (`export PAGER=cat GIT_PAGER=cat … ;
        [ -n "$LANG" ] || export LANG=C.UTF-8`) for every POSIX target, so no target depends on env passing.
      - Set `WSL_UTF8=1` on the runner's wsl.exe.
      - The launcher prints a start marker (`\x1b]777;ember-start\x07`, stripped by output shaping) before `eval`. No
        marker → `failed-to-start` with wsl.exe's stderr decoded by `decode.ts`.

18. **Arguments with quotes passed through wsl.exe's command line are fragile, and two design strings are wrong as
    argv.**
    - Evidence:
      - §4.3 `wsl.exe -d <distro> --exec wslpath -a -u '<windows path>'` and §4.2 `--exec /bin/sh -c '<FACTS>'` are
        written as shell lines. Under `--exec` there is no shell, so literal `'` characters would reach `wslpath`.
      - `POSIX_INNER` (§3.3) and FACTS contain `"` characters. Node escapes them as `\"` for the Windows command line,
        and wsl.exe re-parses that line with its own rules (WSL#2164 shows WSL's quoting conversions are not uniform).
    - Severity: **minor** (breaks runs, not safety; easy to make robust).
    - Fix (WA/RUN):
      - Pass fixed scripts on stdin (`--exec /bin/sh -s`), as `exists()` already does with data.
      - Pass the inner launcher through `WSLENV` (`EMBER_INNER/u`) and run `script … -c 'set -f; eval $EMBER_INNER'`.
        That needs no quote or backslash in argv: Node quotes it as one plain `"…"` argument, and the launcher text is
        written without glob characters or significant runs of spaces.
      - Write the design strings as argv arrays.

19. **Facts-script and probe details that fail on real distros.**
    - Evidence (§4.2 FACTS, §4.1, §4.3):
      - (a) `[ -e /proc/sys/fs/binfmt_misc/WSLInterop ]`: newer WSL registers `WSLInterop-late` so systemd-binfmt
        doesn't wipe it. Use `ls /proc/sys/fs/binfmt_misc/WSLInterop*` or `[ -n "$WSL_INTEROP" ]`.
      - (b) `mountroot` parsed from `/etc/wsl.conf` with a `sed` range that ignores spacing, case and quotes. Ask
        `wslpath -u 'C:\'` (a separate argv) or `findmnt -rn -t 9p,drvfs -o TARGET` instead.
      - (c) `script` may be BusyBox's (Alpine), which has no `-e`. Accept only `script --version` containing
        "util-linux".
      - (d) `python3 -I` implies `-E`, so `PYTHONUNBUFFERED`/`PYTHONIOENCODING` passed through `WSLENV` are ignored
        (harmless: `protocol_streams` flushes and fixes UTF-8). Drop them. A distro without `python3` makes `env` exit
        127, which the doctor must report as "python3 missing", not "pyatspi missing".
      - (e) The 5 s probe timeout (§4.1) is shorter than a cold VM + systemd boot. Anything that may boot a distro
        (facts, the first command) needs ~30 s and a "Starting Ubuntu…" status.
      - (f) A tar-based distro that has never been launched runs its OOBE (user creation) on first start. Lxss
        `RunOOBE`=1 (verify the value name) → the target says "Set up Ubuntu first: open it from the Start menu once"
        and Ember doesn't start it.
      - (g) `wsl --list --running --quiet` prints a localised sentence when nothing runs. Accept only names that are in
        the Lxss list.
    - Severity: **minor**.
    - Fix: as listed, with `wsl-runner`/`wsl-discover` fixtures for each.

20. **Revive can boot a distro the user just stopped, contrary to the WSL consent text.**
    - Evidence:
      - `sidecar.ts:343-362`: `retire()` → `revive()` on the next tick after any exit of a helper that answered.
      - Design `mayStart: () => wsl.isRunning(distro) && …` with `isRunning` "refreshed at most every 2 s". After
        `wsl --terminate Ubuntu` the cached answer is still "running", and `ensure()` spawns `wsl.exe -d Ubuntu`, which
        boots it again.
      - The WSL card (§8.4.1) promises it "never starts a distro on its own".
    - Severity: **minor**.
    - Fix (WB): after any exit of a WSL sidecar, refresh the running set uncached (`wsl --list --running --quiet`)
      before a revive. Or give WSL sidecars no automatic revive; the LibreOffice-abort reason is about LibreOffice,
      which can be revived on the next real request.

21. **WSLg availability is assumed from "a v2 distro and no `guiApplications=false`".**
    - Evidence:
      - §4.1. The inbox WSL on Windows 10 has no WSLg; WSLg there needs Store WSL.
      - `isWslgImage` (`remote-surface.ts:52-55`) knows only `Program Files\WSL` and the Store package path, so an
        inbox Windows 11 WSLg's msrdc stays a remote surface.
      - The doctor would say "with WSLg" when there is none.
    - Severity: **minor**.
    - Fix (WA): WSLg features require `wslVersion !== null` (Store/MSI WSL) and are confirmed by the sidecar's
      `status.wslg` (`/mnt/wslg` exists). Otherwise the doctor says "Update WSL to use Linux apps with Ember: run `wsl
      --update`".

22. **Tool-owned distros and WSL's own configuration files.**
    - Evidence:
      - R3 hides only `docker-desktop*` (§4.1). `rancher-desktop`/`rancher-desktop-data` (root) and
        `podman-machine-*` are also tool-owned VMs. Acting in them breaks those tools.
      - If the default distro is a hidden one, "WSL" (§2.3 rule 5) names nothing.
      - Writing `%USERPROFILE%\.wslconfig` or `.wslgconfig` (`[wsl2] kernel=`, `kernelCommandLine=`,
        `guiApplications=`) changes how every distro boots (a custom kernel is full control of the WSL VM). Today that
        is an ordinary "append" (or an overwrite only when it exists).
    - Severity: **minor**.
    - Fix (WA/CL): hide `rancher-desktop*` and mark `podman-machine-*` "used by Podman: commands only, asked every
      time". When the default distro is hidden, "WSL" names the first visible distro and the active line says so. Add
      `.wslconfig`, `.wslgconfig` (Windows profile and `/mnt/<c>/Users/<u>/`) and `/etc/wsl.conf` to §3.5.5's
      "Writing system locations" ("Changes how WSL starts").

23. **`wslgLaunch` judges a WSLg shortcut's tail as an argv, but after `--` wslg.exe hands it to the default shell as
    a command line.**
    - Evidence:
      - Design §4.8: `wslgLaunch` accepts `wslg.exe [-d <name>] [--cd <dir>|~] -- <argv…>`, splits the `.lnk` arguments
        with Windows rules (`win32/system/apps.ts:159` `splitWindowsArgs`) and judges `<argv>` with the Linux
        vocabulary.
      - wsl/wslg's `--` means "pass the remaining command line as is" to the distro's default shell (bash, zsh, fish,
        which reads `~/.zshenv`). Shortcut tails come from any `.desktop` file in the distro, user-writable ones in
        `~/.local/share/applications` included, which WSLg turns into Start-menu shortcuts automatically. So
        `gedit; xterm` or `$(…)` in a tail runs as shell text, and a terminal hidden behind `;` is not judged.
      - Older shortcut shapes (`wslg.exe ~ -d D <cmd>`, inbox WSLg) differ again (verify on the `wslg-probe` job, item 12).
    - Severity: **major** (the terminal/never-run judgement can be sidestepped by any distro process that writes a
      `.desktop` file).
    - Fix (WB): after `--`, accept only tokens matching `^[A-Za-z0-9_@%+=:,./-]+$` (no quotes, `$`, backquotes,
      `;&|<>(){}*?[]~!#` or whitespace inside a token), and wrappers judged by `hands/terminals.ts`'s `WRAPPERS` table as today.
      Otherwise refuse with "Ember can't tell exactly what this shortcut runs". Accept the older shape only if CI
      records it, and then with the same token rule.

---

Things checked and found sound:
- `--exec` for the sidecar and runner (no shell injection through names).
- `WSLENV` replacement keeps Ember's sign-in variables out of every distro.
- UTF-16LE/UTF-8 detection by NUL position.
- The Lxss enumeration in a new file (no I-win edits).
- Launching WSLg apps by opening the `.lnk` with explorer.exe (with item 23's token rule).
- The same-machine check via WSL2's shared `boot_id`.
- GDI capture including RAIL windows.
- Tier 1 needing no input path.
- Id-block routing.
- WSL1 = commands only.
