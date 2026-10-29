# Ember on Windows working with WSL

Branch read: `ember-improve/20261022-windows-macos` (HEAD `38cdddb`). Every `file:line` is from that tree. Claims about
Windows/WSL behaviour that the repository doesn't show are marked **(OS fact)** when well established, and **(verify)**
when they must be checked on a real Windows 11 + WSL2 machine before anyone builds on them. This spec lays out options,
costs and risks; it decides nothing the owner has to decide.

Two readings of "help with what the user does in WSL":

- **(a) GUI reading:** Linux GUI apps under WSLg (seeing, acting, launching), plus the WSL file system as Windows apps
  see it. Fits today's rules once the gaps in §1.3 are closed.
- **(b) Command-line reading:** running commands in a WSL shell. Contradicts the hard rules "never opens or acts in
  terminals, never runs programs or shell commands". Possible only if the owner explicitly lifts those rules for WSL.

---

## 0. Conclusions first

1. **Today's Windows build cannot see inside WSLg windows, and it doesn't recognise them either. That is a safety gap
   now, before any WSL work starts.** A WSLg window is a Windows top-level window owned by `msrdc.exe`. Ember names
   windows by their program (`hwnd.ts:52-66`, `names.ts:23-26`), so every Linux app, whether gedit, a polkit prompt or
   gnome-terminal, reports as app `msrdc`.
   - `isTerminalApp("msrdc")` is false (`main.ts:1342`, `terminals.ts:46-54`).
   - The Windows security vocabulary matches neither the Linux prompt programs nor their titles (`vocabulary.ts:42-48`,
     `66-68`).
   - Grants are keyed by app name (`policy.ts:2002`), so "Always in msrdc" would cover every Linux app.
   - The only defence left is the borrow confirmation, which is asked every time (`policy.ts:1994-1997`).

   Fix to make before anything else, whatever the owner decides about WSL: an msrdc RAIL window that hasn't been
   identified gets no action at all (§11, item 1).
2. **Reading inside WSLg apps needs Ember's existing Python AT-SPI sidecar running inside the distro.** UI Automation
   sees only the RAIL frame (verify, but expected: RDP RAIL remotes pixels, not an accessibility tree). The client
   already accepts any launch command (`SidecarLaunch {command,args,env}`, `sidecar.ts:198-213`, spawned at
   `sidecar.ts:263-268`). So `wsl.exe -d <distro> --exec python3 /mnt/c/…/ember_atspi.py` works with no protocol change.
   The real unknowns are in the distro:
   - `python3-pyatspi` (with `python3-gi`, `gir1.2-atspi-2.0`, `at-spi2-core`) is not in stock WSL images, and Ember
     never installs packages.
   - Apps and the sidecar must share one D-Bus session bus, so they share the accessibility bus (§4.3). Whether that
     bus exists depends on systemd being on and on how WSLg sets `XDG_RUNTIME_DIR` (verify).
3. **Coordinates need a translation as well as a scale.** Ember today only scales an app's reported bounds by `k`
   (`scaleBounds`, `sidecar.ts:181-185`; `matchFrame`, `windows.ts:32-56`, which requires
   `|o.x − b.x·k| + |o.y − b.y·k| ≤ 8 + 4k`). Under WSLg:
   - Wayland-native GTK/Qt apps report their bounds relative to their own window: Wayland clients don't know where
     they are on screen (OS fact; how WSLg behaves: verify).
   - The RAIL HWND may include a title bar that Weston draws (verify).
   - WSLg's DPI scaling makes `k` the monitor scale, whole or fractional (`.wslgconfig` `WESTON_RDP_*`; verify).

   The mapping must be affine (`k, dx, dy`) per window, worked out from frame-relative positions. Any doubt fails
   closed: tier 1 only, no coordinate clicks, no image of that window.
4. **Pids and identities must be namespaced per distro.**
   - Linux pids from the in-distro sidecar can equal Windows pids by accident. `matchFrame` uses `samePid`
     (`windows.ts:39`), perception's `skipPids` uses the stack's pids (`index.ts:145`), and the sidecar's own
     `best_window` gives a pid match +8 (`ember_atspi.py:2157-2178`). A Windows pid sent into the distro could pick the
     wrong window.
   - All RAIL windows of a distro share one msrdc pid (verify), so `pointerLandsOn`'s same-process rule
     (`rules.ts:233-240`) would treat a click on another Linux app's window as landing on the target.
5. **Launching WSLg apps through their Start Menu shortcuts is refused today.** The catalogue lists them, because it
   walks the Start Menu (`apps.ts:241-249`). But their target is `wslg.exe` (verify the exact argv), which is in
   `REFUSED.win32` (`terminals.ts:189-190`). `runsTerminal` refuses on it (`system.ts:275`), and `check()` throws
   (`apps.ts:262-271`). Allowing them needs a strict parser for the shortcut's shape that judges the Linux argv with
   the Linux vocabulary.
6. **The user's own words "in WSL" are treated as asking for a terminal on Windows.** `TERMINAL_WIN32` contains `wsl`
   (`vocabulary.ts:242`, `259`), and `startTask` refuses a task when the user named a terminal and the goal doesn't
   (`host.ts:878-885`). Under reading (a), "open gedit in WSL" must stop meaning a terminal.
7. **Capture already works:** GDI BitBlt of the composed desktop includes RAIL windows (`capture.ts:200-208`; OS
   fact for DWM). **Tier 3 input already reaches RAIL windows** through SendInput (msrdc runs at medium integrity, so
   UIPI doesn't block it). One exception: Ember types text as `KEYEVENTF_UNICODE` (`keys.ts:181-189`). Weston's RDP
   backend historically logs Unicode keyboard events and drops them (verify for WSLg's fork). Typing into WSLg apps by
   cursor may need a scancode path.
8. **Reading (b), commands, is a rule change, not a feature switch.** Five places refuse it on purpose:
   - `policy.ts:1960`: a `terminal` element.
   - `policy.ts:1961`: opening a terminal.
   - `policy.ts:1963`: any action in a terminal app.
   - `policy.ts:1977`: system keys.
   - `host.ts:880-885`: the user's terminal words.

   RESEARCH.md §9 (`docs/RESEARCH.md:461-472`) has a deferred design based on tmux, `capture-pane` and OSC 133, made
   for SSH. For WSL there is a cheaper and more classifiable shape: one command per call through
   `wsl.exe --exec` (§12.3). Either way, commands in WSL can reach Windows through interop and `/mnt/c` (OS fact), so
   "only in WSL" is not a sandbox.
9. **CI can't cover any of this end to end.** GitHub-hosted Windows runners have no nested virtualisation, so no WSL2
   and no WSLg (verify). The pure parts can be unit-tested on Linux: decoding `wsl.exe` output, the Lxss facts, the
   wslg-argv parser, the affine maths, routing, and the vocabulary union. The in-distro sidecar is the Linux sidecar and
   is already tested. The end-to-end path needs a self-hosted Windows 11 runner or a manual test script.

---

## 1. What the code does today, and what WSL looks like to it

### 1.1 Windows platform pieces involved

| Piece | Where | Relevance |
|---|---|---|
| Window lists (`clientWindows`, `stack`) | `win32/windows.ts:184-221` | RAIL windows appear here like any app window: `wmClass` is the program, `"msrdc"`; `wmClassName` is the Win32 class (RAIL class name unknown; verify) |
| App naming | `win32/hwnd.ts:52-66`, `win32/names.ts:23-77` | Special cases exist only for UWP frames and consoles. No RAIL special case |
| Rules: app / findable / covers / popup | `win32/rules.ts:133-176` | RAIL popups (Linux menus) would count as `isPopup` only if msrdc sets owners or tool-window styles on them (verify) |
| Pointer check for the borrow | `win32/input.ts:212-228` → `rules.ts:233-240` | Same-pid popups count as landing on the target. All RAIL windows of a distro share one pid |
| UIPI / secure desktop | `win32/security.ts:227-249`, `input.ts:200-211` | msrdc runs medium IL, so no block |
| Capture | `win32/capture.ts:200-208` | BitBlt of the composed desktop includes RAIL windows |
| Sidecar launch | `win32/platform.ts:72-80` → `sidecar-host/launch.ts:36-43` | One launch: the TS host plus the UIA bridge. No second sidecar |
| Platform contract | `platform/types.ts:542-567` | `sidecarLaunch()` returns one launch; `desk: null` on win32 (`win32/platform.ts:71`) |
| App catalogue | `win32/system/apps.ts:236-257` (list), `262-281` (check), `289-302` (launch via explorer.exe) | WSLg shortcuts are listed, then refused at `check()` |
| Terminal vocabulary | `hands/terminals.ts:46-54` (`wsl, wslhost, bash, ubuntu…, debian, kali`), `120` (WSL package ids), `189-190` (`wslg` refused), `212` (console classes) | Correct for reading (b); blocks reading (a) launching |
| User terminal words | `policy/vocabulary.ts:241-259`, `agent/host.ts:878-885` | "in WSL" counts as asking for a terminal |
| Policy terminal refusals | `policy/policy.ts:1960-1966` | Unchanged under (a); must change under (b) |
| Registry | `win32/system/registry.ts:65-99`, `win32/system/ffi.ts:29-31` | `regGetValue`/`regSetValue` only. **No key enumeration** (no `RegOpenKeyExW`/`RegEnumKeyExW`) |

### 1.2 The accessibility client and the Python sidecar

- `AtspiSidecar` (`sidecar.ts:233-509`): one process at a time; newline JSON-RPC over stdio; one request in flight.
  - On a timeout it kills the process and starts a new one at once (`sidecar.ts:371-377`, `336-362`, revive).
  - Element ids come from a per-process block (`ID_BLOCK`, `sidecar.ts:214-221`; `EMBER_ATSPI_ID_BASE`, `262-271`;
    read in Python at `ember_atspi.py:758-766`).
  - It keeps secret-field keys `[bus name, object path]` for the next process (`sidecar.ts:230-247`, `292-296`).
  - It scales element bounds by a per-id factor (`scaleElements`, `sidecar.ts:390-397`; `physical`, `410-417`).
    **Scale only, no offset.**
- The Python sidecar is compatible with Python 3.6+ and pyatspi 2.26 (`ember_atspi.py:1-13`).
  - It reads extents in screen coordinates (`raw_extents`, `ember_atspi.py:198-202`: `Atspi.CoordType.SCREEN` /
    `DESKTOP_COORDS`).
  - It finds windows by pid/path/title (`find_window`, `2181-2206`; `best_window` scoring pid +8, exact title +6,
    title-substring +4, `2157-2178`).
  - It reads `/proc/<pid>/comm` (`process_name`, `2577-2583`) and detects GNOME Shell for `shell_overlays`
    (`2586-2661`). Under WSLg there is no GNOME Shell, so the result is empty and complete.
  - `status` reads gsettings `toolkit-accessibility` (`2680-2694`). `main()` exits when stdin reaches EOF
    (`4641-4655`).
- The desk precedent: Linux already runs a **second** `AtspiSidecar` with its own environment and bus
  (`desk/desk.ts:428-453` starts `dbus-daemon --session`; `desk/place.ts:210` constructs the sidecar with `info.env`).
  The worker switches readers via `place` (`worker.ts:851-856`: `this.place?.sidecar ?? this.d.sidecar`). A WSL
  "place" can copy this shape (§6.2).

### 1.3 Gaps in today's Windows build (exist before any WSL work)

Each item below is a way in which a WSLg window gets through a check that was built for ordinary Windows apps.

1. **Terminals in WSLg are not recognised.** A WSLg gnome-terminal, xterm or Konsole window is "msrdc".
   `isTerminalApp` is false (`main.ts:1342`), and the window exposes no `terminal` element to UIA (`policy.ts:1960`
   can't fire). xterm has no AT-SPI at all, so even an in-distro sidecar can't name it. **Ember could type into a Linux
   shell under WSLg** after a borrow confirmation (`policy.ts:1994-1997`).
2. **Linux security prompts are not recognised.** polkit-gnome, pinentry-gtk, gcr-prompter and ssh-askpass under WSLg
   report as "msrdc", with Linux titles ("Authentication Required"). `SECURITY_APP.win32` and `SECURITY_TITLE.win32`
   don't match (`vocabulary.ts:42-48`, `66-68`); the Linux rows would (`vocabulary.ts:41`, `65`).
3. **Never-look by app name fails.** An entry "keepassxc" matches a WSLg window only through its title
   (`isNeverLook` is a substring match on `app + " " + title`, `elements.ts:440-443`). Capture skipping is by the
   stack's `wmClass` (`index.ts:145`), which is "msrdc".
4. **Grants are too coarse.** `grants()["msrdc"]` (`policy.ts:2002`) would be one grant for every Linux app of every
   distro.
5. **Borrow target check is too loose.** `pointerLandsOn` accepts the same process's menus and popups
   (`rules.ts:236-239`), so a click on another WSLg app of the same distro passes.
6. **Same gap for other remote windows.** Windows' own RDP clients (mstsc, the Windows App/AVD client, which is also
   an msrdc.exe) are opaque surfaces showing another machine. Today they are ordinary apps to Ember. The remote-desktop
   spec covers the SSH side; the same "unidentified remote surface" rule should cover them.

---

## 2. Discovering WSL: distros, versions, WSLg

### 2.1 Sources

| Fact | Source | Notes |
|---|---|---|
| Installed distros | Registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{GUID}`, values `DistributionName` (SZ), `Version` (DWORD 1 or 2), `State` (DWORD), `BasePath` (SZ), `DefaultUid` (DWORD), `Flags` (DWORD), `PackageFamilyName` (SZ, Store distros). Root value `DefaultDistribution` = `{GUID}` (OS fact; value set: verify per WSL version) | Per user (HKCU), so no elevation. Needs **subkey enumeration**: add `RegOpenKeyExW`, `RegEnumKeyExW` and `RegCloseKey` to `win32/system/ffi.ts` (today only `regGetValue`/`regSetValue`, `ffi.ts:29-31`). `readString`/`readDword` (`registry.ts:65-90`) then read each value. Never starts the VM |
| Running distros | `wsl.exe --list --running --quiet` | Names only, no localised words. `wsl.exe -l -v` has localised headers and state words ("Running"/"Stopped" are translated), so it isn't parsed. Doesn't boot the VM (verify) |
| WSL package/version | `wsl.exe --version` (Store/MSI WSL only; prints WSL, kernel, **WSLg**, MSRDC, Direct3D, DXCore and Windows versions; labels localised). The inbox wsl.exe prints usage instead (verify) | Parse version numbers by line order, not labels (verify that the order is stable). Or use file facts below |
| WSL install | `%ProgramFiles%\WSL\wsl.exe`, `wslg.exe`, `msrdc.exe` (Store/MSI WSL); inbox `%SystemRoot%\System32\wsl.exe` (verify paths per version) | `msrdc.exe`'s directory is also how a RAIL window is told from the Windows App's msrdc (§3.1) |
| WSLg turned off | `%USERPROFILE%\.wslconfig`, `[wsl2] guiApplications=false` (documented in the microsoft/wslg README) | A plain INI read |
| WSLg scaling knobs | `%USERPROFILE%\.wslgconfig`, section `[system-distro-env]`: `WESTON_RDP_HI_DPI_SCALING`, `WESTON_RDP_FRACTIONAL_HI_DPI_SCALING`, `WESTON_RDP_DEBUG_DESKTOP_SCALING_FACTOR` (third-party guide; verify against WSLg source) | Only a hint: `k` is measured per window anyway (§5) |
| WSLg live in a distro | In the distro: `/mnt/wslg/` exists; `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, `PULSE_SERVER` are set (README); `/mnt/wslg/versions.txt` (verify) | Asked by the in-distro sidecar's `status` (new optional fields) |
| WSL1 distro | Lxss `Version`=1 | No WSLg (README: WSL 2 only). No AT-SPI sidecar there either (WSL1 can't run WSLg apps) |

### 2.2 `wsl.exe` output encoding

- `wsl.exe`'s own messages (`--list`, `--version`, errors) are **UTF-16LE without a BOM** when redirected (OS fact).
  `WSL_UTF8=1` in the child's environment switches them to UTF-8 (WSL 0.64.0+; verify on the oldest supported WSL).
- Decoder: set `WSL_UTF8=1`. Then, if the bytes have NULs at odd offsets in the first 64 bytes, decode `utf16le`,
  else `utf8`. Strip `\r`, trim, drop empty lines. Same idea as `decodeRegistryString` (`registry.ts:52-57`).
- Output from a Linux program under `wsl.exe --exec` is passed through as raw bytes (UTF-8 from the program), and is
  unaffected by `WSL_UTF8`. The sidecar protocol is safe.
- Exit codes: `wsl.exe --list` exits non-zero when no distro is installed (localised message). Treat that as an empty
  list. `wsl.exe --exec` returns the Linux program's exit code (OS fact).
- Spawn every probe with `windowsHide: true` (console program) and a timeout (5 s, like `system.ts:19-21`), with an
  environment from `cleanEnv` (`compose.ts:56-69`) plus `WSL_UTF8=1`.

### 2.3 Proposed module

`app/main/platform/win32/wsl/discover.ts`, plain Node, unit-tested on Linux like `apps.ts`:

```ts
interface WslDistro { name: string; guid: string; version: 1 | 2; isDefault: boolean; packageFamily?: string }
interface WslFacts {
  installed: boolean;          // wsl.exe present
  distros: WslDistro[];        // from Lxss (no VM start)
  running: Set<string>;        // wsl.exe -l --running -q
  wslg: { available: boolean; disabledByUser: boolean; version?: string; msrdcDir?: string };
}
```

Facts are cached like the PowerShell facts (`powershell.ts` `FACTS_MS` 60 s). `running` is refreshed on demand: when a
RAIL window appears, and before any sidecar (re)start (§4.5).

---

## 3. WSLg windows on the Windows side

### 3.1 What they are

- WSLg runs Weston with an RDP backend in a system distro, and remotes each Linux toplevel as an RDP **RAIL** window.
  On Windows, `msrdc.exe` draws it (README; Microsoft WSLg blog). One msrdc process per running distro with GUI apps
  (verify).
- **Telling a WSLg RAIL window apart:**
  - The process image is `msrdc.exe` **in the WSL install directory** (`api.processImage(pid)`, used by `programOf`,
    `hwnd.ts:41-45`). The Windows App/AVD client also ships an `msrdc.exe` in another directory, so the name alone is
    not enough.
  - The class name is not a reliable key. A search found msrdc's hidden container `TscShellContainerClass`; the RAIL
    windows' class is unknown (verify with Spy++). Record it, but don't key on it.
  - msrdc's command line carries WSLg arguments (verify), but Ember doesn't read other processes' command lines.
- **Title:** the Linux toplevel's title. Whether WSLg appends " (<distro>)" is unknown (verify). Matching strips one
  trailing ` (<distro name>)` when the name is a running distro.
- **What UIA sees:** a top-level window with a single client pane and no descendant controls (verify; expected,
  because RAIL carries pixels and window metadata, not accessibility). The TS host would list it as app "msrdc" and
  read an empty tree.
- **Popups and menus:** RAIL has an owner field (`WINDOW_ORDER_FIELD_OWNER`). Whether msrdc sets `GW_OWNER` on popup
  HWNDs decides `isPopup`/`pointerLandsOn` (verify).
- **Decorations:** X11 apps get Weston-drawn frames; Wayland apps with client-side decorations draw their own header
  bar. So the HWND may or may not include a title bar outside the AT-SPI frame (verify). §5 handles both.

### 3.2 Which distro a RAIL window belongs to

1. One running distro with WSLg: that one (the common case).
2. Several: msrdc pid → distro, learned by matching. Ask each running distro's sidecar for `list_windows` and match
   titles and size ratios (§5.2). Cache pid→distro until that msrdc exits.
3. No match in any distro: **unidentified** (§6.4).

---

## 4. Reading inside WSLg apps: the AT-SPI sidecar inside the distro

### 4.1 Launch shape

The client takes a `SidecarLaunch` (`sidecar.ts:198-213`):

```ts
{
  command: "C:\\Program Files\\WSL\\wsl.exe",            // or System32\wsl.exe (from discovery)
  args: ["-d", distro, "--cd", "~", "--exec", "python3", "-I", scriptLinuxPath],
  env: { ...cleanEnv(process.env, { os: "win32" }), WSL_UTF8: "1",
         PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8",
         WSLENV: "EMBER_ATSPI_ID_BASE/u:PYTHONUNBUFFERED/u:PYTHONIOENCODING/u" },
  firstRequestMs: 15_000,                                  // wsl.exe + python + gi import; distro already running
  windowsHide: true,
}
```

- **`--exec`, never a shell.** `--exec` runs the program with no shell parsing (OS fact), so a distro name or path
  can't inject commands. Never `-u`/`--user` (root).
- **Environment crosses only through `WSLENV`** (OS fact). The client adds `EMBER_ATSPI_ID_BASE` after the launch env
  (`sidecar.ts:266`). Naming it in `WSLENV` ahead of time is enough. No token or `EMBER_*` secret crosses: `cleanEnv`
  drops `SECRET` names and `EMBER_*` (`compose.ts:56-69`), and `WSLENV` names only the three variables above.
- **Script path:** `ember_atspi.py` ships under `resources/sidecar/atspi/` (`main.ts:152-155`). Inside the distro it
  is `/mnt/c/Program Files/Ember/resources/sidecar/atspi/ember_atspi.py`, through drvfs automount (OS fact).
  - Translate with `wsl.exe -d X --exec wslpath -a -u '<winpath>'` once per distro. Don't hard-code `/mnt/`: users can
    change `[automount] root` in `/etc/wsl.conf`.
  - Running it from the Windows install keeps it as tamper-resistant as the Windows install: drvfs enforces Windows
    ACLs for the Windows user (OS fact). Python's `-I` keeps the script directory and user site out of `sys.path`.
  - `[automount] enabled=false` leaves no `/mnt/c`. Fallback: a two-stage bootstrap. `python3 -I -c '<reads N bytes
    of code from stdin, exec>'`, and Ember writes the packaged script's bytes first, then speaks the protocol. This
    needs a small change to `protocol_streams` (`ember_atspi.py:4607-4613`) so the bootstrap's stdin buffering doesn't
    swallow protocol bytes. The other fallback, copying the script into `\\wsl.localhost\<distro>\…`, puts it where any
    distro process can rewrite it, so it is weaker.
- **Ids:** each new `AtspiSidecar` process gets a new id block from the module counter (`sidecar.ts:220-221`, `262`).
  WSL ids never collide with UIA host ids. Element calls can be routed by id block (§6.2).

### 4.2 Prerequisites inside the distro (Ember never installs them)

| Need | Debian/Ubuntu | Fedora | Arch | openSUSE | Notes |
|---|---|---|---|---|---|
| pyatspi | `python3-pyatspi` | `python3-pyatspi` | `python-atspi` | `python3-pyatspi` | Pulls in `python3-gi`, the Atspi typelib (`gir1.2-atspi-2.0` on Debian) and libatspi. Package names: verify per release |
| a11y bus | `at-spi2-core` | `at-spi2-core` | `at-spi2-core` | `at-spi2-core` | Usually arrives with GTK3 (Recommends) when a GUI app is installed (verify) |
| GTK bridge | `libatk-adaptor` / `at-spi2-atk` (GTK3); GTK4 has its own | same | same | same | Qt: `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` or the bus's `org.a11y.Status.IsEnabled` |
| Python | 3.6+ | | | | The sidecar targets 3.6+ (`ember_atspi.py:7-9`) |

- Stock WSL images (Ubuntu rootfs) don't ship `python3-pyatspi`, and usually not `python3-gi` (verify). Ember's doctor
  must show the exact command for the user to run themselves: `sudo apt install python3-pyatspi at-spi2-core`.
- Ember never opens a terminal for this and never runs it. The rules forbid both, and `sudo` is `REFUSED`
  (`terminals.ts:186`).
- The sidecar already answers every request with `python3-pyatspi is not installed` when the import fails
  (`ember_atspi.py:28-32`, `4634`), and `status` still answers. The doctor can tell the cases apart: "WSL
  present, WSLg present, distro running, helper missing".

### 4.3 The D-Bus and accessibility bus question (the main unknown)

AT-SPI apps register on the accessibility bus. They find it through `AT_SPI_BUS_ADDRESS`, else the X root window
property `AT_SPI_BUS`, else `org.a11y.Bus` on the **session bus** (OS fact for libatspi). Recent libatspi skips the X
property when `WAYLAND_DISPLAY` is set (verify), and WSLg sets both `DISPLAY` and `WAYLAND_DISPLAY`. So in practice a
**session bus shared by the apps and the sidecar** is required.

| Distro state | What apps get | What the sidecar can see |
|---|---|---|
| systemd on (`[boot] systemd=true` in `/etc/wsl.conf`, the default for Ubuntu installed by `wsl --install` in recent WSL; verify) | A user manager with `dbus.socket` → `/run/user/<uid>/bus`. Whether WSLg-launched apps get `DBUS_SESSION_BUS_ADDRESS`, or GLib's `$XDG_RUNTIME_DIR/bus` fallback reaches it, depends on WSLg's `XDG_RUNTIME_DIR` (historically `/mnt/wslg/runtime-dir`; with systemd possibly `/run/user/<uid>`; verify) | If the apps' bus is `/run/user/<uid>/bus`, the sidecar sets `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` and sees **every** app, including those the user started from the Start Menu |
| No systemd | No session bus. atk-bridge fails silently, unless `dbus-x11` autolaunch makes one per X display (verify) | Nothing, unless Ember provides a bus |

Options, for the owner and a spike to settle:

- **B1. Use the distro's own bus** (systemd case). This is the least intrusive. Spike: from a WSLg-launched gedit, read
  `/proc/<pid>/environ` (as the same user) for `DBUS_SESSION_BUS_ADDRESS`/`XDG_RUNTIME_DIR`, and check that
  `at-spi-bus-launcher` is activated. The sidecar then copies that address. A small new sidecar startup step: find
  the bus the frames are on.
- **B2. Ember-owned bus, apps Ember launches only.** This copies the desk (`desk.ts:440-453`): `wsl.exe --exec
  dbus-daemon --session --print-address`, kept alive by Ember. Apps Ember opens get `DBUS_SESSION_BUS_ADDRESS` (and
  `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, `GNOME_ACCESSIBILITY=1`) through `wslg.exe … -- env …` or `WSLENV`. Apps the
  user started are invisible (unidentified, §6.4). Predictable, works without systemd, and leaves the user's session
  untouched.
- **B3. Ember creates the bus where GLib looks** (`$XDG_RUNTIME_DIR/bus`). Apps started afterwards find it with no
  env change. But this changes the user's session for every app, and apps already running stay invisible until
  restarted. Intrusive. Listed only for completeness.

Also: Chromium/Electron Linux apps need `--force-renderer-accessibility`, or the bus's `ScreenReaderEnabled`. Qt5
apps need `IsEnabled`, which the sidecar could set through `org.a11y.Status`. Setting it is a write to the user's
session, so it needs its own decision.

### 4.4 Per-app accessibility facts the sidecar can't fix

- xterm, urxvt and most Xaw/Motif/Tk/SDL apps have no AT-SPI. They are always **unidentified** RAIL windows (§6.4).
- GTK4 apps on Wayland: their AT-SPI extents are relative to their own window (OS fact for Wayland; verify for
  GTK3/GTK4 under Weston). Handled by §5's frame-relative mapping.

### 4.5 Lifecycle, so Ember never boots or holds a distro by accident

- **Start only when a RAIL window of that distro is on screen.** Never for a stopped distro: `wsl.exe -d X` boots the
  VM (seconds) and keeps it running while the sidecar lives (OS fact).
- **Revive guard:** `retire()` revives at once after any exit of a helper that ever answered (`sidecar.ts:343`,
  `353-362`). For WSL that would reboot a distro the user just ran `wsl --terminate` or `wsl --shutdown` on. The WSL
  launch needs a gate: check `running` (§2.1) before `ensure()` spawns (`sidecar.ts:258-297`), and revive only while
  the distro runs and a RAIL window exists. Concretely, an optional `SidecarLaunch.mayStart?: () => boolean`, checked
  in `ensure()`. The LibreOffice-abort reason for revive (`sidecar.ts:346-352`) still applies inside the distro, so
  keep revive when allowed.
- **Idle stop:** stop the WSL sidecar when that distro has had no RAIL windows for 60 s, so WSL's idle VM shutdown
  can happen.
- **Kill reaches the Linux process?** `SIGKILL` on `wsl.exe` (`sidecar.ts:376`) closes the relay. The Python side
  sees stdin EOF and exits **only if it is reading** (`ember_atspi.py:4646-4648`). A sidecar stuck in a libatspi call
  (800 ms timeouts, `ember_atspi.py:51-52`) recovers within a second or two. A truly stuck one could linger (verify
  whether WSL signals orphans when the relay dies). Add a watchdog thread to the sidecar that `os._exit(0)`s when
  `os.getppid()` changes (the relay is gone). It is a small, Linux-safe change.
- **Cold start:** about 0.2-0.5 s for `wsl.exe` into a running distro, plus 0.3-1 s for gi/pyatspi imports
  (estimates; measure). `firstRequestMs` 15 s covers antivirus scanning `/mnt/c`.

---

## 5. Mapping WSLg windows and coordinates

### 5.1 Why today's matcher fails

`matchFrame` (`windows.ts:32-56`):

- needs `samePid || sameTitle`. Pids live in different namespaces, and titles may carry a suffix.
- tries `outer`, `inner` and frame rects with one `k`, and rejects unless the origins agree after scaling
  (`off > 8 + 4k`, `windows.ts:49-50`). Wayland-native apps report `(0,0)` for their frame. Xwayland apps report
  Xwayland root coordinates, whose relation to Windows' virtual-desktop origin (negative on left or upper monitors) is
  unknown (verify).

Perception caches the scale **per pid** (`index.ts:99-100`, `244-259`). Linux pids from several distros can collide,
and they collide with Windows pids.

### 5.2 Proposed WSLg matcher (`perception/wslg.ts`, pure)

Inputs: RAIL HWNDs of distro D (from `stack()`, `windows.ts:201-221`, with `outer`, `inner` and frame), and D's AT-SPI
frames (`list_windows`).

1. **Candidates by title:** AT-SPI frame name == RAIL title with one trailing ` (D)` stripped. Without a title (rare),
   the frame `active` ↔ foreground HWND.
2. **Scale:** `k = hwnd.innerWidth / frame.width`. Snap to quarters as `windows.ts:45-48` does. Accept if `k` is within
   0.05 of the monitor scale of the HWND's monitor (Electron's `screen.getDisplayMatching` scale factor) or of 1
   (scaling off).
3. **Vertical offset:**
   - `dyTop = hwnd.inner.height − frame.height·k`. This is the band of server-side decoration, if any.
   - Accept `0 ≤ dyTop ≤ 48·k` (a Weston title bar; verify the height). Assume the decoration is on top and the frame
     is horizontally aligned (`|hwnd.inner.width − frame.width·k| ≤ 2`).
   - Otherwise there is no mapping.
4. **Transform:**
   - `dx = hwnd.inner.x − frame.x·k`, `dy = hwnd.inner.y + dyTop − frame.y·k`.
   - Every element maps as `X = dx + x·k`, `Y = dy + y·k`. This holds for Wayland apps (frame at 0,0) and for X11 apps
     (frame anywhere), because only offsets relative to the frame matter.
5. **Ambiguity fails closed:** two frames fit one HWND or vice versa (two "Untitled Document 1" windows), or `k`/`dy`
   is out of bounds. Then the window is matched for **identity only** when the title is unique, otherwise
   unidentified. With identity but no transform: tier 1 actions only; no coordinate clicks; no image of the window
   (secret masks can't be placed).
6. **Re-derive on every read.** Cache by HWND (not pid) for at most 2 s. Windows move between monitors with different
   scales, and Weston's per-output scale follows.

Generalising the client: `AtspiSidecar.scaleElements(ids, k)` and `physical()` (`sidecar.ts:390-417`) carry only `k`.
They need a `Transform {k, dx, dy}` (with `{k, 0, 0}` as today). `scaleBounds` (`sidecar.ts:181-185`) becomes an
affine `mapBounds`. `atPoint` must map back: `(X − dx)/k`, today `Math.floor(Math.round(p.x)/k)` at `index.ts:202`.

The sidecar asks AT-SPI for SCREEN coordinates (`ember_atspi.py:198-202`). Under Wayland these are window-relative
(verify). The affine map covers both cases. A sidecar option to ask WINDOW coordinates
(`Atspi.CoordType.WINDOW`) would make the convention explicit. Optional.

### 5.3 DPI facts to verify

- WSLg's default HiDPI behaviour. The `.wslgconfig` guide suggests scaling is on by default, with apps rendered at
  logical size and upscaled. Then AT-SPI reports logical pixels and `k` ≈ monitor scale. Fractional scaling is
  opt-in; with scaling off, `k = 1`.
- Mixed-DPI multi-monitor: a window across two monitors takes its `k` from the monitor holding most of it (Weston's
  output). The measured `k` in step 2 settles it.
- msrdc's DPI awareness (per-monitor v2 expected) is what keeps HWND rects in physical pixels. Ember's window system
  works in physical pixels (`windows.ts:84-88`).

---

## 6. Routing perception and actions

### 6.1 Identity of a WSLg window

A matched RAIL window gets:

- `app = "wsl:<distro>:<linux app>"`. The Linux app is the AT-SPI application name, plus a new `program` field from
  `/proc/<pid>/comm` (`process_name`, `ember_atspi.py:2577-2583`) added to `list_windows`/`read_window`'s `window`.
- `pid = null` towards Windows code; the Linux pid is kept inside the WSL route only.
- `path` = the AT-SPI frame path.

With this naming, existing string logic mostly works:

- **Never-look:** substring "keepassxc" matches `wsl:ubuntu:keepassxc` (`elements.ts:440-443`). The user can add "wsl"
  to hide all WSL apps.
- **Grants:** keyed per Linux app, e.g. `grants()["wsl:ubuntu:gedit"]`, not "msrdc" (`policy.ts:2002`).
  `friendlyApp()` must display "gedit (Ubuntu)".
- **Terminal and security checks:** `isTerminalApp` at `main.ts:1342` gets a `wsl:` branch, judged with the **Linux**
  vocabulary on the Linux app and program (`TERMINALS.linux`, `SHELL_APP.linux`, … `terminals.ts:38-45`, `90-95`),
  **or'ed** with the win32 check. `isSecurityWindow` for `wsl:` windows applies `SECURITY_APP.linux` and
  `SECURITY_TITLE.linux` (`vocabulary.ts:41`, `65`) as well as win32's. Today the engine has one `os` and one
  `isSecurityWindow` (`policy.ts:176-181`); add a per-request vocabulary hook, or make the win32 checks also run the
  Linux rows on `wsl:` apps. That union only ever refuses more.

### 6.2 Two ways to wire it

| | **R1. Routed sidecar (one perception)** | **R2. WslPlace (a "place" like the desk)** |
|---|---|---|
| Shape | A `RoutedSidecar` implementing `AtspiSidecar`'s public surface over the UIA host and one `AtspiSidecar` per running distro. `listWindows` merges (UIA windows minus RAIL HWNDs, plus mapped WSL windows). `readWindow`/`atPoint`/`secretFields` route by target (`wsl:` app or RAIL HWND). Element methods route by **id block** (each child process owns known blocks) | `WslPlace { perception, sidecar, input (Windows SendInput), x11 (Windows window system filtered to D's RAIL HWNDs, with the transform), open(app) }`, entered like `place` (`worker.ts:851-856`) |
| Fit with the worker | Transparent: `this.d.sidecar` stays one object | Needs an "on the user's screen" place. Today `place` implies the desk: `fly()` is skipped (`worker.ts:864`), and `onDesk` lifts the borrow (`policy.ts:1987-1992`). Both must be false for WSL |
| `list_windows`, switch_window across Windows and WSL apps | Natural | Needs leaving and entering places |
| Code size | Medium (merge and route, plus id-block bookkeeping) | Medium (new place, plus making `place` semantics explicit) |
| Risk | Routing bugs send an id to the wrong process. Block ownership prevents misdirection: an unknown block gets "no longer known" | Two readers active; per-task switching friction |

R1 matches how users think ("my windows"). R2 reuses the desk's tested separation. Owner/implementer choice.

### 6.3 Pid hygiene (both options)

- Never send a Windows pid into a WSL sidecar: `find_window`'s +8 pid score (`ember_atspi.py:2165-2166`) would pick a
  random Linux window. Send `{path}` (with the Linux pid kept in the route) or `{title}` only.
- `skipPids` (`index.ts:145`, `197`) for WSL is computed from WSL windows' Linux pids, never from the stack.
- `coveringRects(…, same)` (`windows.ts:106-115`) uses pids to exempt the target's popups. For RAIL, exempt by HWND
  owner chain, not pid.

### 6.4 Unidentified RAIL windows (fail closed)

A RAIL window with no AT-SPI match (no helper, no shared bus, xterm, ambiguous) is treated as:

- **read:** title only, with the Linux and Windows security and never-look checks on the title. No tree.
- **capture:** allowed only if the window isn't private by title. If the never-look list is non-empty, mask
  unidentified RAIL windows in captures: they can't be checked by app. Owner choice: mask always.
- **act:** **refused, every tier.** The reason given is "Ember can't tell what this Linux app is, so it won't use it".
  This one rule closes gaps 1-5 in §1.3 for today's build too.

---

## 7. Capture

- Works unchanged: BitBlt of the composed desktop includes RAIL windows (`capture.ts:184-208`).
- Secret masking needs §5's transform. No transform → no image of that window (or the whole window blacked out).
  `withSecrets` and the recheck (`index.ts:213-221`, `527-560`) work on mapped bounds.
- `shellOverlays` is empty under WSLg (no GNOME Shell, `ember_atspi.py:2605-2661`). Linux password prompts are
  ordinary RAIL windows and are caught by §6.1's Linux security rows.

---

## 8. Acting

| Tier | In WSLg windows | Notes |
|---|---|---|
| 0 settings | Out of scope. `change_setting` targets Windows settings (`win32/system/settings.ts`) | Linux gsettings inside the distro would change the distro's GTK settings. A separate decision |
| 1 accessibility | **In the distro sidecar**: `do_action`, `set_text`, `set_value`, `select_option` work without input focus (`sidecar.ts:477-502`) | `can_do` with `caret` uses AT-SPI `active`/`focused` (`ember_atspi.py:2887-2915`). Weston's focus follows Windows activation through RAIL. `activate()` (`hwnd.ts:153-179`) on the RAIL HWND first |
| 2 desk | None on Windows (`win32/platform.ts:71`) | Option: **a WSL-hosted desk** for Linux apps. Run the Linux desk (Xvfb plus its own dbus, `desk/desk.ts`) inside the distro, with its helper process there and frames over stdio. Large: the desk's koffi/X11 helper (`desk/agent-process.ts`) would run under Node in the distro. Listed, not costed in detail |
| 3 borrow | SendInput to the RAIL HWND reaches Weston (msrdc medium IL; `blockedReason` passes, `input.ts:200-211`) | (i) `pointerOn` must require the hit HWND to be the target or in its owner chain, not "same pid" (`rules.ts:236-239`). (ii) **Text:** Ember types every printable character as `KEYEVENTF_UNICODE` (`keys.ts:181-189`). Upstream Weston's RDP backend logs Unicode keyboard events and drops them (verify for WSLg). Needs a VK+scancode path (`keyInput` with layout, `input.ts:66-69`) for RAIL targets. Weston's keymap must equal the Windows layout, which WSLg syncs at connect (verify mid-session switches). (iii) Borrow semantics hold: the window is on the user's screen, and the user can take over |

Policy for WSL acts is unchanged otherwise: first action per app asks (`policy.ts:2002-2010`), risky words always ask,
borrow always asks. They are keyed by the `wsl:` app (§6.1).

---

## 9. Launching WSLg apps

### 9.1 Through WSLg's Start Menu shortcuts (preferred)

- WSLg's `WSLDVCPlugin` creates a Windows Start Menu shortcut for each Linux `.desktop` entry it finds (README),
  usually in a folder named after the distro. The catalogue already lists them (`apps.ts:241-249`). `appFromShortcut`
  accepts them: an absolute `.exe` target that exists (`apps.ts:143-163`).
- Target and arguments: `…\WSL\wslg.exe` with something like `-d <distro> --cd "~" -- <linux argv>` (**verify the
  exact shape on current WSL and on Windows 11's older inbox WSLg**).
- **Today refused:** `wslg` ∈ `REFUSED.win32` (`terminals.ts:190`) → `runsTerminal` true (`system.ts:275`) →
  `isTerminalApp` → `check()` throws (`apps.ts:264`, `270`).
- **Proposal:** a `wslgLaunch(argv)` parser in `win32/system/` (pure, tested). It accepts **only** this shape:
  `wslg.exe [-d|--distribution <name>] [--cd <dir>|~] -- <argv…>`, where `<argv>` is non-empty.
  - It rejects `-u/--user`, `-e/--exec`, `--system`, `--shell-type`, any option it doesn't know, a distro that isn't
    installed, and a WSL1 distro.
  - It then judges the Linux argv with the **Linux** vocabulary: `isTerminalApp({id, name, argv}, "linux")`
    (`system.ts:339-351`), which follows wrappers and inline code (`system.ts:270-308`). The matching in-distro
    `.desktop` file is read via `\\wsl.localhost` only if the distro is running (Terminal=true, Categories).
  - If both pass, `check()` allows it. Launch stays explorer.exe opening the `.lnk` (`apps.ts:296-301`). Ember never
    spawns `wslg.exe` itself.
  - Keep `wslg` in `REFUSED` for every other path.
- Launching a WSLg shortcut **boots the distro** if it is stopped (OS fact). That is acceptable: the user asked to
  open the app.
- **B2 bus:** shortcut launches can't carry Ember's bus address. Under B2, Ember-opened WSL apps need Ember's own
  launch: `wslg.exe -d D --cd ~ -- env DBUS_SESSION_BUS_ADDRESS=… <argv>`. That is an Ember-spawned `wslg.exe`, so a
  narrow, code-built exception (argv built only from a parsed `.desktop` Exec line). Owner decision.

### 9.2 Other ways (listed, not preferred)

- **`wsl.exe -d D --exec <app>`:** Ember spawns a WSL process directly. Same safety as above if the argv comes from a
  parsed `.desktop` file, but `wsl` is a terminal by name (`terminals.ts:50`). It needs the same narrow exception.
- **In-distro `.desktop` listing** through `\\wsl.localhost\<D>\usr\share\applications` and `~/.local/share/
  applications`, parsed by `parseDesktopFile` (`system.ts:140-160`). It finds apps WSLg skipped. Reading
  `\\wsl.localhost` boots a stopped distro (OS fact), so only for running distros.

---

## 10. Files

- WSL files appear in Windows as `\\wsl.localhost\<distro>\…` (Windows 11 / current WSL; legacy `\\wsl$\…`) (OS fact).
  Ember has no file tools, so WSL files matter only through apps:
  - Linux apps' own file dialogs under WSLg (tier 1 in the distro).
  - File Explorer browsing `\\wsl.localhost` (ordinary win32 app). Typing a path is allowed. Typing a program name or
    command line is refused (`TYPING_REFUSED.win32`, `vocabulary.ts:206-213`).
- **Risk:** WSL home folders are full of scripts. Double-clicking `x.sh`/`x.py`/`x.ps1` in File Explorer may run it,
  depending on file associations (Git Bash registers `.sh`). `runsProgram` (`policy.ts:732-760`) catches "Run"
  dialogs and labels, not a double-click on a script. Consider refusing "open" of executable-extension items in
  Explorer (a vocabulary row, like `TYPING_REFUSED`).
- Windows apps editing WSL files: VS Code (Remote-WSL) is a shell app and refused (`terminals.ts:99-102`).

---

## 11. Changes for reading (a), in order

1. **Unidentified RAIL fail-closed rule (do now, independent of WSL).** Identify WSLg RAIL HWNDs by msrdc image
   directory, and the Windows App/mstsc remote surfaces by program. Refuse all actions in them unless identified
   (§6.4). Files:
   - `win32/names.ts` (a `remoteSurface(program, imageDir)` decision),
   - `win32/hwnd.ts` (`appName` reports `msrdc` plus a flag),
   - `policy.ts` (a `never` reason before the grant logic, next to `policy.ts:1960-1966`),
   - tests mirroring `test/unit/vocabulary-win32.test.ts`.
2. **WSL discovery** (§2): registry enumeration FFI, `wsl.exe` probes with UTF-16 handling, `.wslconfig` read. Doctor
   lines (`win32/system/doctor.ts`).
3. **In-distro sidecar launch** (§4): a WSL `SidecarLaunch` builder, the `mayStart` gate in `sidecar.ts:258`, idle
   stop, the Python parent watchdog, and an optional `program` field in `list_windows`.
4. **Bus spike and choice** (§4.3: B1 or B2).
5. **WSLg matcher and affine transform** (§5): `perception/wslg.ts`, `Transform` in `sidecar.ts`/`perception/windows.ts`,
   per-HWND scale cache.
6. **Routing** (§6.2, R1 or R2), pid hygiene (§6.3), `wsl:` identity, policy vocabulary union (§6.1).
7. **Borrow fixes** (§8): owner-chain `pointerOn` for RAIL; a scancode text path for RAIL targets.
8. **Launch** (§9.1): the `wslgLaunch` parser; Linux-vocabulary judgement; `check()` allowance.
9. **Words:** drop the bare `wsl` from `TERMINAL_WIN32` and from `TERMINAL_REQUEST.win32.names`
   (`vocabulary.ts:242`, `259`). Keep "WSL terminal" and "WSL shell", already covered by `[\w.-]+\s+(?:terminal|shell)`,
   so "open gedit in WSL" no longer reads as a terminal request (`host.ts:880-885`). Update
   `test/unit/vocabulary-win32.test.ts:320-322`, which pins "start wsl" as a terminal request: that expectation must
   change deliberately.
10. **Admin:** optional `features.wsl` (reading and acting in WSLg apps) in `AdminPolicySchema` (`admin.ts:20-55`).
    The schema is `.strict()`, so a policy file with the new key makes **older** Ember versions lock down
    (`admin.ts:68-79`). Document that.

Rough size, excluding spikes: items 1-2 about 2-3 days; 3-6 about 1.5-2.5 weeks; 7-9 about 1 week; plus manual
testing on real Windows 11 + WSL2 (Ubuntu with and without systemd, Fedora; 100%/150%/mixed DPI; X11 and Wayland
apps).

---

## 12. Reading (b): commands in a WSL shell

### 12.1 What it conflicts with today

| Rule (owner's) | Enforced at |
|---|---|
| Never acts in terminals | `policy.ts:1960` (`terminal` role), `1963` (any act in a terminal app), `terminals.ts:46-54`, `209-213` (console classes) |
| Never opens terminals | `policy.ts:1961`; catalogue `check()` `apps.ts:262-271`; worker refusals `worker.ts:1023`, `1052` |
| Never runs programs or commands | `REFUSED`/`runsTerminal` (`terminals.ts:185-193`, `system.ts:270-308`), `runsProgram` (`policy.ts:732-760`), `TYPING_REFUSED` (`vocabulary.ts:206-213`) |
| User's terminal words refuse the task | `host.ts:878-885`, `vocabulary.ts:236-260` |
| Desktop shortcuts (open-terminal keys) user-only | `policy.ts:1975-1978` |

Any version of (b) needs the owner to write the exception, for example: "Ember never runs commands, **except** commands
in a WSL distro when the user has turned on WSL commands: each one asked for by the user, shown verbatim, and
confirmed by a click unless it is in the read-only class." Admin policy can only switch it off.

### 12.2 Options

| | What Ember does | Rule change | Main risks |
|---|---|---|---|
| **C0. Read and explain only** (no change) | Ember **reads** the user's Windows Terminal or WSL tab (reading terminals is allowed: the refusals above are for `kind !== "read"`, `policy.ts:1963`) and explains errors and suggests commands in words. The user types them | None | Terminal text may hold secrets (it goes to the model like any screen text, under the existing consent). It is untrusted (prompt injection in output) |
| **C1. Type, the user presses Enter** | Ember types a command into the user's terminal and stops. The user runs it | Lift "never types into terminals" | Hidden characters or newlines run it at once (bracketed paste helps, not always on). Easy to over-trust. Classification still needed |
| **C2. Visible tmux session** (RESEARCH §9 adapted) | Ember opens its own terminal window: `wsl.exe -d D --exec tmux -L ember new -A -s ember`, shown in Windows Terminal or conhost. It sends commands with `tmux -L ember send-keys -l`, then Enter after confirmation, reads `capture-pane -p -J`, and detects completion and exit status through OSC 133 markers from an Ember rcfile's `PROMPT_COMMAND`, captured with `pipe-pane` | Lift both terminal rules for Ember's own session | Needs tmux in the distro (verify in stock images). Interactive programs (vim, less, sudo prompts) need careful states. Output parsing is fragile. Heavier |
| **C3. One command per call, headless** | `wsl.exe -d D --cd <dir> --exec /bin/bash --noprofile --norc -c '<cmd>'` (or no shell, see C4), stdin `/dev/null`, timeout, output capped. The exit code is wsl.exe's (OS fact). The command and its output show in Ember's bubble or task card | Lift "never runs commands" (no terminal window involved) | Invisible unless Ember shows it. Shell-grammar classification. Background jobs and long runs |
| **C4. Structured WSL tools, no shell** | Fixed tools with code-built argv via `--exec` (no shell): `wsl_list_dir(path)` → `ls -la -- <path>`, `wsl_read_text(path, maxBytes)`, `wsl_which(name)`, `wsl_package_status(name)` → `dpkg-query -W`, `wsl_git_status(dir)`… Mutating tools added one by one with their own confirmations | A narrow lift ("Ember may read the WSL file system and run these fixed queries") | Lowest injection surface. Covers diagnosis well, not arbitrary tasks. Every tool is code to maintain |

C0 is available today. C4 and C3 can be combined: C4 for read-only, C3 (confirmed) for the rest.

### 12.3 Mechanics common to C2 to C4

- **Transport:** a separate in-distro helper, not the AT-SPI sidecar, whose contract is reading and acting in apps.
  For example `ember_wsl_exec.py`, started like §4.1, with a closed method set
  `{run(argv|script, cwd, timeoutMs, maxBytes), stop(runId), status}`.
  - It owns every child in its own process group (`setsid`), kills the group on `stop`, on stdin EOF and on the parent
    watchdog, and caps output (for example 64 KiB kept, head and tail to the model).
  - Never `-u root`. Environment from `appEnv`-style rules (`system.ts:452-485`) plus nothing from Ember: no
    `GH_*`/`COPILOT_*` through `WSLENV`.
- **Classification:** reuse and extend `runsTerminal`'s parser (`system.ts:270-308`): wrappers, inline code,
  interpreters, `REFUSED.linux` (sudo, su, pkexec, ssh, …, `terminals.ts:186`). Add a real POSIX shell tokeniser for
  C3: `;`, `&&`, `||`, `|`, redirections, `$()`, backticks, here-docs, globs, `eval`, `source`, `exec`, `&`. Classes:
  - **read-only** (allowlisted programs and flags: `ls`, `cat`/`head`/`tail` on non-secret paths, `grep`, `find`
    without `-exec`/`-delete`/`-fprint`, `git status|log|diff|show`, `uname`, `df`, `du`, `ps`, `dpkg -l`,
    `apt list`/`apt-cache policy`, `which`, `env` without arguments: redact). Run without asking, if the user enabled
    that.
  - **changes user files** (`mkdir`, `cp`, `mv`, `touch`, `git add/commit/checkout`, `pip install --user`,
    `npm install` in a project). Confirm every time, with the exact command.
  - **destructive** (`rm`, `git reset --hard`/`clean -fd`/`push --force`, `chmod -R`, `>` overwrite, `dd`, `truncate`,
    `mkfs`). Confirm every time with a warning. Never "always".
  - **privileged** (`sudo`, `su`, `apt install`, `systemctl`, `mount`, writing `/etc`). **Refused.** Ember never
    handles passwords; the user runs these.
  - **network-exec** (`curl … | sh`, `wget -O- | bash`, `pip install` from a URL). Refused.
  - **escapes to Windows**: any `*.exe` (interop), `cmd.exe`, `powershell.exe`, `wslpath` plus `explorer.exe`, or
    writes under the drvfs root (`/mnt/c`…). Refused or destructive-class. **Interop is on by default and `/mnt/c` is
    the Windows user's files (OS fact), so WSL is not a sandbox.**
  - **interactive** (`vim`, `less`, `top`, `python` with no script, `ssh`, REPLs). Refused in C3/C4. Only C2 could
    host them.
  - **long-running or background** (`&`, `nohup`, `disown`, servers). Refused, or a timeout with a clear stop.
  - Unparseable means refused.
- **Secret handling:**
  - Refuse reading known secret paths: `~/.ssh/`, `~/.gnupg/`, `~/.aws/credentials`, `~/.azure/`,
    `~/.config/gh/hosts.yml`, `~/.git-credentials`, `~/.netrc`, `.env*`, `/etc/shadow`, `*.pem`/`*key*`.
  - Redact token shapes in output before it reaches the model: `ghp_`/`gho_`/`github_pat_`, `AKIA…`, `-----BEGIN …
    PRIVATE KEY-----`, JWTs, and `password=`-style pairs. Similar in spirit to the secret-field rules
    (`ember_atspi.py:121-150` lists).
  - The audit log stores the program names and the class, not full arguments. The journal already keeps app names
    only (`policy.ts:1939` comment).
- **Confirmations:** built from the structured request, as all of Ember's questions are (`policy.ts:1445-1461`
  style). Show the command verbatim in a monospace line, the distro, the cwd, the class and why. "Allow once" only.
  Approval only by a click in the bubble or Ctrl+Alt+Y/N, unchanged. Mark a command the user didn't ask for as not
  aligned (`policy.ts` `aligned`), like risky clicks today.
- **Prompt injection:** command output, file contents and READMEs are untrusted. The model only proposes; policy
  decides. A command not traceable to the user's words is flagged, and refused in the privileged and network classes
  anyway.
- **Kill switch:** add a `wsl-commands` part to `KillSwitch` (`main.ts:731-738`, 300 ms budget, `killswitch.ts:35`)
  that sends `stop` (SIGINT, then SIGKILL to the group) and kills `wsl.exe`. The helper's watchdog covers the case
  where only `wsl.exe` dies.
- **Admin and consent:**
  - A new admin key (for example `features.wslCommands`), default false. The user turns it on in settings; admin can
    force it off. Remember the `.strict()` schema issue (`admin.ts:20-55`).
  - A **separate consent** item: command output is a new category sent to the model (file contents, environment).
- **Visibility:** C3/C4 runs show in Ember's task card with command, live output tail and a Stop button. C2 is visible
  in its own terminal window, but Ember must never type into a terminal the user owns: only `-L ember`'s session.

### 12.4 What RESEARCH §9 offers and what changes for WSL

`docs/RESEARCH.md:461-472`:

- tmux on its own socket (`-L ember`), the user's real terminal, visible typing, `capture-pane`, OSC 133 through
  `pipe-pane` (RHEL's tmux predates native support), secrets through ssh-agent/askpass, classification and
  confirmations.
- Policy references: tufantunc/ssh-mcp (MIT) and classfang/ssh-mcp-server (ISC).
- macOS/Windows would use `node-pty` + `@xterm/headless`.

For WSL:

- No SSH hop and no remote secrets. `wsl.exe --exec` gives exit codes and clean stdio, so C3/C4 don't need OSC 133 or
  `capture-pane`.
- The tmux design (C2) matters only if interactive programs are wanted.
- `node-pty` + `@xterm/headless` on Windows could host `wsl.exe` in a ConPTY with Ember's own rendering, instead of
  the user's Windows Terminal. That is an alternative to tmux for C2, at the cost of a native module.

### 12.5 Risks summary for (b)

- **Breaks a founding promise.** Admins approved Ember on "never runs commands" (RESEARCH §8 enterprise review note,
  `docs/RESEARCH.md:445-459`).
- **WSL reaches Windows** (interop, `/mnt/c`). A WSL command can do anything the Windows user can.
- **Classification errors.** Shell grammar is large; any parser bug is a hole. Refuse what can't be parsed.
- **Secrets leaking to the model** through output.
- **Social engineering:** text on a web page or in a README proposes a command, and the user clicks Allow.
- **Long-running or interactive processes** and the 300 ms kill budget.
- **CI can't test it end to end** (no WSL2 on hosted runners; verify).

Cost estimate:

- C0: 0 (exists), plus copy and prompts.
- C4: about 1-1.5 weeks for a read-only set (helper, tools, classification-free argv, redaction, UI, consent, admin).
- C3: about 2-3 weeks more (shell tokeniser, classifier, confirmations, kill, tests).
- C2: about 3-4 weeks (tmux states, OSC 133, interactive handling), or a node-pty/ConPTY variant.

---

## 13. Testing

- **Unit (Linux CI):**
  - `wsl.exe` output decoding (UTF-16LE with and without BOM, UTF-8, CRLF, empty, error exit).
  - Lxss facts from a fake registry.
  - The `wslgLaunch` argv parser (accept and reject tables).
  - The Linux-vocabulary judgement of WSLg argv.
  - The affine matcher (Wayland frame at 0,0; X11 frame offset; decoration band; 100/125/150/200%; negative monitor
    origins; ambiguity).
  - RoutedSidecar id-block routing.
  - Pid hygiene (no Windows pid reaches the WSL route).
  - The policy union (WSLg polkit title refused, `wsl:ubuntu:gnome-terminal-server` refused, unidentified RAIL
    refused).
  - Commands: classifier tables and redaction.
- **Sidecar in Linux CI:** run the existing Python sidecar through a fake `wsl.exe` (a shell script that drops
  `-d D --cd ~ --exec`) to exercise launch, the env passing through `WSLENV` semantics, the revive gate and the watchdog.
- **Windows integration:** GitHub-hosted runners can't run WSL2/WSLg (verify). Use a self-hosted Windows 11 runner
  with WSL2, or a scripted manual checklist: Spy++ class/owner facts, title suffix, UIA tree of a RAIL window,
  BitBlt, SendInput Unicode vs scancode, DPI matrix, bus discovery with and without systemd.

---

## 14. Verify list (facts this spec depends on)

1. RAIL window class name; whether popups carry `GW_OWNER`; one msrdc per distro; msrdc image path per WSL
   flavour.
2. Window title: is ` (<distro>)` appended?
3. UIA tree of a RAIL window (expected: frame only).
4. WSLg Start Menu shortcut target and args (wslg.exe path and argv shape, inbox vs Store/MSI).
5. `wsl --list --running --quiet` doesn't boot the VM; `WSL_UTF8` honoured by `--list`/`--version` on the oldest
   supported WSL; `--version` line order.
6. Session bus under WSLg: `DBUS_SESSION_BUS_ADDRESS`/`XDG_RUNTIME_DIR` of WSLg-launched apps with and without
   systemd; whether libatspi skips the X property when `WAYLAND_DISPLAY` is set; whether `at-spi-bus-launcher`
   activates.
7. Package names and default presence of `python3-pyatspi`, `python3-gi`, `at-spi2-core` and tmux in Ubuntu/Debian/
   Fedora WSL images.
8. AT-SPI extents of GTK3/GTK4/Qt Wayland apps under Weston (window-relative?) and of Xwayland apps (root coordinates
   vs Windows virtual-desktop origin).
9. WSLg HiDPI defaults and `.wslgconfig` knob names; the decoration band height.
10. Weston/WSLg handling of RDP Unicode keyboard events; keymap sync on Windows layout switches.
11. What WSL does to Linux processes when `wsl.exe` is killed.
12. Nested virtualisation (WSL2) on GitHub-hosted Windows runners.

Sources consulted for OS facts (beyond the repo): the microsoft/wslg README (architecture, `guiApplications=false`,
env vars, Start Menu integration via WSLDVCPlugin); a third-party `.wslgconfig` guide (scrapbox.io, dojineko) for the
`WESTON_RDP_*` knobs; reports of `WSL_UTF8=1` (WSL 0.64.0 release notes as relayed by deskmodder.de; MicroEJ forum);
an issue report naming msrdc's `TscShellContainerClass` container window.
