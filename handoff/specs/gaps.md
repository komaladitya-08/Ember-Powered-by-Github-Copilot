# Completeness critique: Linux dependencies the eight specs miss, and where the specs disagree

Repo: `/home/user/Ember-Powered-by-Github-Copilot` at `b67b02e`. All `file:line` references point into that tree.
Specs reviewed (same folder): `sidecar-protocol-read.md`, `sidecar-protocol-act.md`, `sidecar-consumers.md`,
`window-system.md`, `input.md`, `system.md`, `worker-host-desk.md`, `build-test-ci.md`.

How the search was done. I read all eight specs. I then grepped `app/`, `sidecar/atspi/ember_atspi.py`, `scripts/`,
`packaging/`, `eval/`, `test/` (smoke, mock-llm, demo, plus the pinned strings in unit tests), `.github/`, `packages/`
and `demo/` for: `process.platform`, `/etc/`, `/usr/`, `/proc`, `/tmp`, `/run`, `/opt`, `DISPLAY`, `XDG_`,
`gsettings`, `dbus`, `xdg-open`, `execFile(`, `execFileSync(`, `spawn(`, `spawnSync(`, `fork(`, `.desktop`,
`koffi.load`, `libX`, `chmod`, `0o[0-7]`, every signal name, `process.kill(`, `.kill(`, `os.homedir`, `os.tmpdir`,
`path.posix`, `split(":")`, `PATH`, `python`, `GNOME`, `Xorg`/`X11`, `RHEL`/`dnf`, `Ctrl+Alt`/`Control+Alt`, `Ctrl+`,
`Super`, `journal`, `systemd`, `pactl`/`parec`/`pulse`, `speech-dispatcher`, `getNativeWindowHandle`,
`readUInt32LE`, `powerMonitor`, `getuid`, `process.on(`, `startsWith(`/`path.sep` on paths, `env.HOME`/`USER`/`SHELL`,
renderer keyboard handling (`ctrlKey`/`metaKey`), Electron lifecycle (`second-instance`, `will-quit`, `activate`,
`Notification`, `dialog.`), and the renderer pages' copy. Every hit was checked against the specs. Section 4 lists
the hits that the specs already cover.

Severity: **S** = safety or privacy, **F** = a feature breaks, **C** = wording or copy only, **T** = tooling or docs.
**verify** = must be checked on a real Windows or macOS machine.

---

## 1. Uncovered dependencies and platform behaviours

### G1 [F, high] The sidecar spawn has no `windowsHide`, so a console window stays open on Windows
- `app/main/perception/sidecar.ts:217-220`:
  `spawn(this.python, [this.script], { stdio: ["pipe","pipe","pipe"], env: {...} })`.
- `powershell.exe` is a console-subsystem program. When a GUI process (Electron) spawns it without
  `windowsHide: true`, Windows opens a **visible console window that stays for the sidecar's whole life**. Closing it
  kills the sidecar, and `revive` (sidecar.ts:300-309) then reopens it. `-WindowStyle Hidden` still flashes.
- system.md §15 lists the spawn sites that need `windowsHide` (auth.ts:60, models.ts, …) and adds
  `platform.spawnDefaults`. No spec applies it to the sidecar launcher: build-test-ci §1.2b, sidecar-consumers §13.1,
  sidecar-protocol-act §14 and worker-host-desk §12 all give the command and arguments but leave out `windowsHide`.
- Fix: the generalised launcher `{command, args, env}` must spread `platform.spawnDefaults`, so it passes
  `windowsHide: true` on win32. Add a unit test that asserts it for the win32 launcher.

### G2 [S, high] Windows PowerShell logging can record screen contents; AMSI and EDR can block the sidecar
No spec mentions PowerShell's own logging. All three of these features are common on managed Windows fleets:
- **Module Logging** (GPO "Turn on Module Logging", event 4103 in `Microsoft-Windows-PowerShell/Operational`) records
  each cmdlet call **with its parameter values**. If the sidecar runs read results through cmdlets such as
  `ConvertTo-Json -InputObject $tree`, `Out-String` or `Write-Output`, window titles, field text and selections land
  in the event log. That log is forwarded to SIEMs and read by administrators. The never-look list, secret
  withholding and the "nothing leaves this computer" consent (home/index.html:31-34) all assume screen text stays in
  Ember's process.
- **Script Block Logging** (event 4104) logs the script text. Since PowerShell 5 it also logs "suspicious" blocks
  automatically, without any GPO, and `Add-Type` and `DllImport` count as suspicious. That logs only code, which is
  harmless, but the UIA sidecar will be flagged on every start.
- **Transcription** (GPO) writes the host's output to a transcript folder, often on a network share. Writing directly
  to a .NET stdout stream is believed to bypass it. **verify**.
- **AMSI and EDR**: a script that runs `Add-Type` with P/Invoke into user32, launched by an unsigned Electron app and
  walking every window with UI Automation, matches common heuristics for malware and keyloggers. Defender or a
  third-party EDR may block it or quarantine the cached DLL.

Proposed handling (Windows only):
- Keep the `.ps1` a bootstrap of about 10 lines. It loads the compiled assembly and calls
  `[EmberUia.Host]::Run()`. The C# code reads stdin and writes stdout through
  `Console.OpenStandardInput()`/`OpenStandardOutput()` and serialises JSON itself. No data ever passes through a
  cmdlet or the pipeline.
- Add an integration test on a runner with Module Logging, Script Block Logging and Transcription turned on. It
  reads a bench window and asserts that the bench's text appears in none of event 4103, event 4104 or the transcript.
- Plan Authenticode signing for the `.ps1` and the DLL (see G4, G13).

### G3 [F, medium] The sidecar inherits `PSModulePath` (and `__PSLockdownPolicy`) from Ember's environment
- sidecar.ts:219 passes `{ ...this.env, … }`. When Ember starts from PowerShell 7 (a VS Code or Windows Terminal
  tab in development, or a pwsh logon script), `PSModulePath` lists PowerShell 7's module folders. Windows PowerShell
  5.1 then autoloads incompatible modules (Microsoft.PowerShell.Utility and Security from pwsh), and cmdlets fail with
  "module could not be loaded". **verify** (this is a known PowerShell 5.1/7 interop issue).
- `__PSLockdownPolicy=4` in the environment forces Constrained Language Mode, so `Add-Type` fails.
- Fix: on win32, remove `PSModulePath` from the sidecar's environment (5.1 rebuilds its default) and report
  `__PSLockdownPolicy` in the doctor. Only system.md §9.3 mentions Constrained Language Mode, and only through
  `$ExecutionContext.SessionState.LanguageMode`.

### G4 [F, medium] Execution policy, Mark-of-the-Web and a shipped DLL
- build-test-ci §1.2b notes that a Group Policy execution policy (AllSigned/RemoteSigned in
  MachinePolicy/UserPolicy) overrides `-ExecutionPolicy Bypass`, but it gives no remedy. Either Authenticode-sign
  `ember_uia.ps1`, or start through `-Command` with a tiny bootstrap that loads the assembly. Execution policy
  applies only to script files, so a bootstrap avoids it, but that sidesteps what the organisation chose: prefer
  signing.
- If a **precompiled** `EmberUia.dll` ships in the Windows zip, Explorer's "Extract all" copies the zone identifier
  (Mark-of-the-Web) onto every extracted file. .NET Framework 4 then refuses `Add-Type -Path` / `Assembly.LoadFrom`
  for that file with "An attempt was made to load an assembly from a network location" **verify**. Load it with
  `[Reflection.Assembly]::Load([IO.File]::ReadAllBytes($p))` instead, or keep compiling at run time into
  `%LOCALAPPDATA%` (build-test-ci's cache, which carries no MOTW).
- The cached DLL in a user-writable folder is loaded into a process that sees every window. Check its SHA-256
  against the expected hash before loading it. That costs nothing and stops an accidental or stale replacement.

### G5 [S/F, high] Saving and restoring the clipboard drops Windows and macOS formats, including password-manager markers
- `app/main/agent/clipboard.ts:46-59`: `savableFormat(type)` keeps a format only if it is shaped like a MIME type
  (`/^[\w.+-]+\/[\w.+-]+/`) after stripping Electron's `electron application/osclipboard;format="…"` wrapper, or if
  it is `x-kde-passwordManagerHint`. `save()` (:101-138) saves only those formats. `restore()` (:147-155) writes only
  those formats back. `PICTURE` (:64) is LibreOffice- and GTK-specific.
- **Windows** custom formats (e.g. `Rich Text Format`, `HTML Format`, `Csv`, `XML Spreadsheet`, Office's
  `Art::GVML ClipFormat`, Explorer's `Shell IDList Array`/`FileGroupDescriptorW`/`Preferred DropEffect`) and **macOS**
  UTIs (`public.rtf`, `com.apple.webarchive`, `public.file-url`, `com.microsoft.Excel…`) do not match that pattern.
  - After every tier-3 paste on the user's screen (worker.ts:1859, `paste` defaults to on in main), the user's
    rich-text, spreadsheet or file copy comes back as plain text and HTML at best. That is silent data loss.
  - When nothing on the clipboard is MIME-shaped, `save()` throws "the app that owns the clipboard gave nothing"
    (:132), so nothing is pasted.
- The password markers that input.md §9 and worker-host-desk §5.2 propose adding to `holdsPassword` (Windows
  `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`, `Clipboard Viewer Ignore`; macOS
  `org.nspasteboard.ConcealedType`/`TransientType`) **are dropped by `savableFormat` before `holdsPassword` (:59)
  ever sees them**. So adding them to `holdsPassword` alone does nothing.
  - Ember would then put a password manager's copy back on the clipboard **without** its markers.
  - On Windows that makes it a fresh copy, which Clipboard History (Win+V) and cloud clipboard sync record. On macOS,
    clipboard-history tools record it.
  - The text Ember pastes itself (cursorAct) is also recorded by Win+V history and cloud sync.
- Proposed handling:
  - Make `savableFormat` and the marker list per OS: win32 accepts any registered format name (deny-list known
    GDI-handle formats such as `CF_BITMAP`/`CF_ENHMETAFILE`/`CF_PALETTE` if Electron exposes them); darwin accepts
    UTIs.
  - Make `holdsPassword` check the OS marker list.
  - When Ember writes its own paste text, add the exclusion formats on win32
    (`ExcludeClipboardContentFromMonitorProcessing`, plus `CanIncludeInClipboardHistory` and
    `CanUploadToCloudClipboard` = DWORD 0) and `org.nspasteboard.TransientType` on darwin.
  - **verify**: which formats Electron 44's async `clipboard.read()` lists on win32/darwin; whether `ClipboardItem`
    accepts them back; and whether reading a delayed-render Office format can hang or crash, as X `PIXMAP` does
    (the comment at :50-53).
  - Add per-OS cases to test/unit/clipboard.test.ts.

### G6 [F, high] `freshAskPress` requires Ctrl+Alt, which breaks the new ask accelerators
- `app/main/hotkey.ts:15-25`: `Chord = {control, alt}`. The press counts only when `chord.control && chord.alt`.
  main.ts:1127 passes `x11Ref?.keysDown() ?? null`.
- system.md §14 proposes `Super+Alt+Space` on Windows and `Control+Shift+Command+Space` on macOS. window-system §8
  keeps `keysDown(): {control, alt, space} | null`. With either proposal one of `control`/`alt` is false, so **every
  ask press is ignored** (logged `ask.hotkey_ignored`).
- input.md §9 says the "Chord must grow" but changes nothing.
- Proposed handling: the re-report problem that `freshAskPress` exists for is specific to X11 grabs
  (hotkey.ts:1-5). Windows `RegisterHotKey` and macOS Carbon hotkeys fire once per press. So `ws.keysDown()` should
  return `null` (trust plus debounce) off Linux. If a chord check is kept anyway, it must take its modifiers from
  `ShortcutTable`.

### G7 [C, medium] The home page states the Linux data folder and the journal on every platform
- `app/renderer/home/index.html:34`: "…in `~/.config/ember`".
- `app/renderer/home/index.html:146`: "Every decision and action is also in `~/.config/ember/audit/` and in the system
  journal (`journalctl -t ember-audit`)".
  - The `#journal-hint` span is **never hidden**. Nothing in `app/renderer/home/main.ts` references it, so the line is
    already wrong on Linux without systemd-cat, and always wrong on Windows and macOS.
- system.md §13.3 covers home/main.ts:217 and index.html:31/33/47/54/77/91/138, but not :34 or :146.
- Fix: add `Status.platform.dataDir` and `auditCopy` ("the Windows Event Log (Application, source Ember)", "the
  unified log (`log show --predicate …`)", or none). Hide the span when `auditSink()` returned undefined.

### G8 [C, medium] More Linux wording that system.md §13 doesn't list
| Where | Text | Windows / macOS |
|---|---|---|
| perception/index.ts:422 (model-facing) | "GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog…" | "the system didn't answer in time…" |
| perception/index.ts:424 (model-facing) | "the Activities overview or the window switcher is open" | Windows: "Task View or the Alt+Tab switcher"; macOS: "Mission Control" |
| main.ts:887, :889 (user-facing) | "No keyring is available, so you'll need to sign in again next time" | Windows: Windows couldn't protect the sign-in (DPAPI); macOS: "Keychain access was denied" (pairs with system.md §7.1's try/catch on `save`) |
| policy.ts:1291-1292 `KEY_LABELS` (every key question via `keyLabel`, :1300) | `super: "Super"`, `ctrl: "Ctrl"` | Windows `Win`; macOS `Cmd`/`Control`/`Option`, following the input/policy decision in C2. system.md covers only renderer copy.ts:99 |
| policy.ts:1354, :1355, :1409; worker.ts:1841 (question and model text) | "(Ctrl+A)" | macOS "Cmd+A" |
| environment.ts:106, doctor.ts:63 | `sudo dnf install python3-pyatspi` | Linux branch only. Fine once `inspectEnvironment` branches per OS |

### G9 [S, medium] Policy wording lists don't know Windows and macOS danger labels
- Checked with node against `RISKY` (policy.ts:194):
  - "Move to Bin" (macOS en-GB/en-AU Finder) → **false**.
  - "Move to Recycle Bin" → **false**.
  - "End task" (Task Manager) → **false**. This is moot only if Task Manager becomes never-act (system.md §2.5).
  - "Empty Bin", "Run anyway", "Force Quit" and "Delete permanently" → true.
- `RUNS_PROGRAM`/`RUN_FILE_DIALOG` (policy.ts:621-645) are built from Nautilus's words. Missing:
  - Windows file Properties **"Unblock"**: it removes Mark-of-the-Web, so the file then runs without the SmartScreen
    warning. This is the Windows analogue of "Allow executing file as program".
  - macOS **"Open Anyway"** (System Settings > Privacy & Security, the Gatekeeper bypass) and the Gatekeeper alert's
    "Open".
  - The macOS "…would like to control this computer" / Privacy & Security **Allow** switches. Granting Accessibility
    or Screen Recording to another app is a security setting. `securitySetting` (policy.ts:482) catches it only if
    the words match.
- system.md §16.2 adds "run anyway", "open file - security warning" and "are you sure you want to open it", but none
  of the above.
- Add them, with policy.test.ts rows.

### G10 [F/S, medium] Shutdown and logout skip `will-quit` on Windows and may be cancelled on macOS
- main.ts:226 (`settings.flush()` on will-quit), :1023-1032 (will-quit `preventDefault`, waits ≤ 3 s for
  `agent.stop()` and the clipboard handoff), :1201 (`borrowRef.stop(); xinput.close()` → releases held keys).
- electron.d.ts:199-200: "On Windows, this event [`before-quit`] will not be emitted if the app is closed due to a
  shutdown/restart of the system or a user logout". The same note sits at :647 and :996 for `will-quit`/`quit`.
- Windows offers `BrowserWindow` `query-session-end`/`session-end` (electron.d.ts:2347, :2446, win32).
  `powerMonitor 'shutdown'` is **linux,darwin** only (:11056-11062).
- Today on Linux, logout sends SIGTERM and Electron quits normally.
- Fix:
  - Windows: on `session-end` of any Ember window, flush settings, `releaseAll()` input, append the audit line, and
    skip the 3 s wait.
  - macOS: listen to `powerMonitor 'shutdown'`.
  - macOS **verify**: whether `preventDefault()` in `will-quit` during a logout makes Electron answer
    `NSTerminateCancel`, which cancels the logout ("Ember interrupted logging out"). If it does, don't defer the
    quit when it is triggered by logout or shutdown.

### G11 [F, medium] Zip-first Windows packaging means toast notifications never appear
- system.md §17: Windows shows toasts only for an AppUserModelID that has a Start-menu shortcut.
- build-test-ci §2.3 ships a **zip first** and NSIS later. A zip creates no shortcut, so main.ts:603
  `new Notification(...)` never shows anything. That includes "Ember needs your OK" (main.ts:598) and
  task-finished (:1307).
- Fix:
  - On first run of a zip build, create `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Ember.lnk` with
    `shell.writeShortcutLink(path, { target: process.execPath, appUserModelId })` (electron.d.ts:14103-14111), and
    call `app.setAppUserModelId` with the same id. Or ship NSIS before the zip.
  - macOS **verify**: that `Notification` works for an ad hoc-signed, `LSUIElement` app. The first use prompts for
    notification permission.

### G12 [F, medium] macOS 15 Local Network privacy
- An admin `provider.baseUrl` on a LAN address (admin.ts:48-55), a LAN proxy found by `resolveProxy`
  (host.ts:947-981), and the Copilot runtime child (attributed to Ember.app) all trigger macOS 15's Local Network
  prompt.
- Without `NSLocalNetworkUsageDescription` in Info.plist, connections fail ("No route to host"). build-test-ci §2.4.3
  doesn't list the key.
- Add it, and map `EHOSTUNREACH` in `explainStartError` (host.ts) to "allow Ember under Privacy & Security >
  Local Network". **verify** with a LAN proxy.

### G13 [F, medium] Windows 11 Smart App Control and unsigned code
- build-test-ci §2.3.2 covers SmartScreen ("More info, Run anyway").
- With **Smart App Control** in enforcement (the default on clean Windows 11 installs that qualify), unsigned
  `ember.exe` and unsigned native modules (`koffi.node`, sharp's DLLs) are blocked with no override. The `.ps1` may
  be affected too. **verify**.
- Treat Authenticode signing as required for any Windows release beyond testers, not as "later".

### G14 [S, medium] Windows takeover detection ignores assistive-technology input and touch
- input.md §7.5 step 4 discards every Raw Input event with `hDevice == NULL` as "injected (Ember's or anyone's)".
- The On-Screen Keyboard, Voice Access, eye-control software and Dragon inject through `SendInput`, so they also
  arrive with `hDevice == NULL`. A user of those tools taking over would then be seen only by polling. Ember targets
  accessibility users.
- Use `RAWMOUSE.ulExtraInformation` / `RAWKEYBOARD.ExtraInformation` and discount only events carrying Ember's
  `EMBER_TAG` (input.md already sets `dwExtraInfo`). **verify** that SendInput's `dwExtraInfo` shows up there.
- Touch and pen (HID usage page 0x0D) aren't registered, so register digitizer usages too.

### G15 [F, low] Dialogs from an accessory app can open behind other windows
- main.ts:396 (`dialog.showMessageBox` for the quit question, no parent) and main.ts:96 (`showErrorBox` at start).
- On macOS with `LSUIElement` (which build-test-ci recommends), the app isn't active, so the alert can open behind
  the frontmost app. Call `app.focus({ steal: true })` first.
- On Windows the menu-driven quit has foreground rights. A startup error at login may open behind other windows.

### G16 [F, low] macOS re-launch doesn't emit `second-instance`
- main.ts:280-283 shows settings on `second-instance`.
- Re-opening Ember.app from Finder, the Dock or Spotlight makes LaunchServices activate the running app, so Electron
  emits `activate`, not `second-instance`. Add `app.on("activate", showHome)` on darwin.
- system.md §17 mentions `activate` only as an alternative to LSUIElement. build-test-ci §4.3's smoke test spawns the
  binary directly, which **does** emit `second-instance`, so CI won't catch this.

### G17 [C/F, low] Windows contrast themes force colours in Chromium
- With a Windows contrast theme on, Chromium turns on `forced-colors: active`. GNOME's high contrast doesn't. Ember's
  bubble, handle, home and ask pages have never been checked for `forced-color-adjust`.
- **verify** that the transparent overlay stays transparent (alpha is preserved) and that the bubble stays readable.
- macOS "Increase contrast" and "Reduce transparency" map to `prefers-contrast` and `prefers-reduced-transparency`.
- Ember's audience makes this more likely than usual.

### G18 [F, low] macOS sheets are not separate windows
- These key on the window's role and title:
  - worker.ts:193-219 (`SAVE_TITLE`, `dialogNote`);
  - policy.ts:666 (`DIALOG_WINDOW`) and :1519 (`enterMaySend`'s "Enter in a file chooser never sends");
  - policy.ts:675 (`elsewhere`).
- On macOS, Save/Open panels and most alerts are AX sheets inside the document window. sidecar-consumers §3.3
  reports them as in-tree `dialog` nodes, so the window stays `frame`.
- The effect fails safe: Ember asks more, and the `dialogNote` hint is lost. `dialogAround` (worker.ts:538-552)
  still finds the sheet. Note it in the AX sidecar spec, and consider deriving `windowId.role` from a sheet that has
  focus.

### G19 [S, low] Absolute paths from environment variables
- build-test-ci §1.2b uses `process.env.SystemRoot` to find powershell.exe. system.md §2.2 does the same for
  explorer.exe, and §12.1 for tar.exe.
- system.md §4.1 argues correctly that user-controlled environment variables must not locate trusted files
  (`SHGetKnownFolderPath(FOLDERID_ProgramData)`). The same reasoning applies to System32: use
  `GetSystemDirectoryW` / `FOLDERID_System` via koffi. The threat is same-user only, so this is low priority but
  free to fix.
- Several specs spawn a bare `powershell.exe` (PATH lookup). See C11.

### G20 [T, low] Linux-only development tooling and docs that no spec mentions
- `scripts/install-desktop-entry.sh` (GNOME menu entry), `scripts/demo/desktop.sh` and `scripts/demo/as-demo-user.sh`
  (Xvfb, openbox, xcompmgr, dbus-launch, `/tmp/ember-demo-*`).
- `test/demo/m1…m9-tour.mjs`: xdotool, ImageMagick `import -window root`, `ffmpeg -f x11grab`,
  `--ozone-platform=x11`, gsettings, and `XDG_CONFIG_HOME` checks of the autostart file in m9.
- README.md:5-25 ("First platform: RHEL 8.4", dnf install) and docs/DEVELOPING.md (RHEL setup).
- `.github/actionlint.yaml` (self-hosted labels): needed if the pre-authorised self-hosted macOS runner from
  build-test-ci §4.2 is added.
- Proposal: keep the demos and scripts Linux-only and say so in their headers. Add Windows and macOS sections to the
  README and DEVELOPING (install, permissions, `--doctor`, the macOS TCC grants in development belonging to the
  terminal).

### G21 [T, low] Hardening option: `RunAsNode` isn't needed on Windows
- build-test-ci §0.4 keeps `EMBER_FUSES.RunAsNode` on everywhere: Linux needs it for desk-agent, macOS for the AX
  sidecar. Windows uses PowerShell, so a Windows build could turn the fuse off. Then `ELECTRON_RUN_AS_NODE=1
  ember.exe` (eventually a signed Node) is impossible.
- Adjust build-test-ci §4.4's "RunAsNode works" check for win32 if this is done.

### G22 [T, trivial] File modes missing from system.md §3
- conductor.ts:333 (`agent.json`, `{ mode: 0o600 }`) is not in system.md §3's list of file modes. No action is needed
  on Windows. Just don't claim 0600 there.

---

## 2. Contradictions between specs (with a recommended resolution)

### C1 [high] macOS coordinate unit
- **sidecar-protocol-read.md §10 (port note):** "The macOS window layer must report frames in pixels (points ×
  backingScaleFactor) so that `matchFrame` finds k = 2."
- **window-system.md §1/§10, sidecar-consumers.md §8.1, worker-host-desk.md §7:** screen units = **points**. `toDip`
  is the identity, `matchFrame` gives k = 1, and the capture folds the Retina ratio into `pixelWidth`/`scale`.
- Resolution: **points everywhere** (the second option). Pixels break on mixed-scale displays, as the read spec
  itself admits, and would make `flyTo`, `CursorBorrow`, CGEvent and AX disagree. Update read §10 and §13.11.

### C2 [high, safety] The primary modifier on macOS
- **input.md §6.1 #4:** add `mod`/`primary`/`cmdorctrl` to `MODIFIERS` (Control_L on linux/win32, Super_L = Command
  on darwin). Add `cmd`/`command` → Super_L. The worker's strings become `mod+a`, `mod+v`, and so on.
- **worker-host-desk.md §11:** keep **`ctrl`** as the portable primary. On macOS, `canonicalKeys`/`parseCombo` map
  `cmd` to the primary, the backend presses ⌘ for `ctrl`, and a separate `macctrl` name reaches the real ⌃.
- **system.md §14:** "give macOS a separate primary-modifier mapping (and separate SAFE_COMBOS/DESTRUCTIVE_KEYS)".
- These are incompatible. The policy's canonical form drives `SAFE_COMBOS`, `DESTRUCTIVE_KEYS`, `PASTE_KEYS`,
  `isSystemKey`, `keyLabel` and `afterSelectAll`.
- Recommendation: **one canonical policy token `mod`**, resolved per OS by `parseCombo` and the backend.
  - Write the policy tables once as `mod+…`.
  - `keyLabel` prints Ctrl or Cmd.
  - On darwin, `cmd` → `mod` and `ctrl` → real Control (key questions say "Control").
  - `isSystemKey` keeps `super` = Windows logo key on win32, and on darwin adds the macOS system keys (input.md
    §6.1 #4).
  - Whoever owns the policy must decide this once, and input.md and worker-host-desk.md must be aligned to it.

### C3 [high, safety] Ember's global shortcuts and the system-key list
- **system.md §14:** Windows `Super+Alt+{Space,X,E,M,Y,N}`, macOS `Control+Shift+Command+{…}`.
- **worker-host-desk.md §10** (worker.ts:1082 row): "Mac: Control-Option-E". That is exactly the VoiceOver modifier
  system.md warns against.
- Microsoft's RegisterHotKey documentation reserves shortcuts involving the Windows key for the OS. Windows
  `Super+Alt+…` combinations overlap Game Bar (Win+Alt+G/R/T/B/PrtScn) and Windows 11 (Win+Alt+D, Win+Alt+K).
  **verify** each.
- Two consequences no spec states:
  1. G6: `freshAskPress` rejects every press.
  2. policy.ts:562-572 `isSystemKey` blocks Ember's own chords only as `ctrl+alt+(y|n|x|space|e|m|…)`.
     - With C2's `cmd → mod` on darwin, `ctrl+shift+mod+y` is **not** a system key unless it is added.
     - A task could then press Ember's own "Allow" chord and **approve its own question**. That is the invariant
       policy.ts:559-561 exists for.
     - Derive the blocked chords from `platform.shortcuts`, and add a test per OS that every `ShortcutTable` accel
       canonicalises to an `isSystemKey` hit.

### C4 [medium] How Windows `activate()` gets the foreground
- **window-system.md §9.9:** the synthetic Alt tap is "the documented-effective trick". Avoid `AttachThreadInput` on
  the main thread (it hangs on a hung foreground thread).
- **input.md §7.6:** empty `SendInput` first, then `AttachThreadInput` guarded by `IsHungAppWindow`, and **never**
  the Alt tap (it toggles menu mnemonics).
- Resolution: input.md's order, implemented **once** and shared by `WindowSystem.activate` and `Input.activate` (they
  are the same operation on the same HWND domain).

### C5 [low] `focusInput` on Windows
- window-system.md §9.9 says leave it undefined. input.md §7.6 says `SetFocus(hwnd)`, optional.
- Either is fine. Pick one: undefined, since `win.focus()` already does it.

### C6 [medium] `programsOf` and `.exe`
- **system.md §2.2:** `programs = [basename(target) without .exe]`.
- **sidecar-consumers.md §9.4 and system.md's header:** the sidecar's `app` = image name **with** `.exe`
  (`notepad.exe`).
- worker.ts:1016 matches with `programs.has(w.app.toLowerCase())`, exactly. So `"notepad"` never equals
  `"notepad.exe"`, and `open_app` falls back to the title test, which fails for any app whose title doesn't contain
  its name.
- Resolution: normalise **both** sides in `programsOf` and the comparison (strip `/\.exe$/i`, lower-case).

### C7 [medium] How apps are launched
- **system.md §2.2/§2.3:** Windows: `explorer.exe <lnk | shell:AppsFolder\AUMID>`, and **never** ShellExecute or
  `shell.openPath` in Ember's process (the child would inherit Ember's tokens and EMBER_*). macOS: `open -a <path>`.
- **worker-host-desk.md §5.3:** "Launch with `ShellExecute` / `explorer.exe shell:AppsFolder\<AUMID>`". macOS:
  `open -b <id>`.
- Resolution: system.md, because of the environment leak. `-a <path>` vs `-b <id>` is a free choice.

### C8 [medium] What gates `hands`
- **window-system.md §8.1, input.md §4.2:** `hands = ws && input ? {…} : undefined`.
- **worker-host-desk.md §5.1/§12:** tier 1 (accessibility actions, guides, show_me) needs no input backend, and
  `cursor` is optional.
- Resolution: `hands = ws ? {…} : undefined`. Set `cursor`/`pointer`/`activationKey` only when the input backend
  opened **and** `blockedReason` is null. Example: macOS without Accessibility trust, where CGEventPost silently
  drops events.

### C9 [medium] Four overlapping platform interfaces
- system.md `SystemPlatform` (words, shortcuts, paths, apps, settings, policy, autostart, a11y, voice, …).
- window-system.md `WindowSystem` (windows, pointer, keysDown, windowId, activate, units, overlay).
- input.md `Input`.
- worker-host-desk.md `HandsPlatform` (`activeWindow`, `focusWindow`, `ownWindowId`, `toDip`, `screenRect`,
  `openInput`, `system`, `desk`, `sidecar`, `text`).
- The same concept goes by different names:
  - `windowId` / `ownWindowId`;
  - `screenBounds()` / `screenRect()` / `Input.screenSize()` + `onScreen()`;
  - `rectToDip` / `toDip(rect)`;
  - `PlatformWords` / `HandsPlatform.text`.
- Resolution: one composition root, e.g.
  `Platform { os; system: SystemPlatform; openWindows(): WindowSystem|null; openInput(): Input|null; sidecar: SidecarLaunch|null; desk: DeskSupport|null }`.
  Drop `HandsPlatform` as a separate type and keep each concept under one name.

### C10 [medium] Who detects system dialogs, and what happens on error
- **window-system.md §9.11/§10.10:** `PerceptionWindows.systemDialogOpen?()` in the platform layer (Windows: input
  desktop ≠ "Default"; macOS: SecurityAgent/coreautha windows, `IsSecureEventInputEnabled`).
- **sidecar-consumers.md §8.5:** the sidecar's `shell_overlays` reports CredentialUIBroker/SecurityAgent as `dialog`,
  Task View/Mission Control as `overview`, and toasts as `notification`.
- **input.md §7.6:** `keyboardGrabbed` uses the same input-desktop test.
- Both checks are worth having, but no spec says how they combine:
  - `perceive` (index.ts:418-424) and `systemDialogOpen` (index.ts:543, used by the worker's `withCursor`
    worker.ts:2915) must OR the platform hook with `shell_overlays`.
  - `shell_overlays` errors **fail open** (index.ts:536-539). The platform hook should **fail closed**.
  - Use one shared helper for the input-desktop test.

### C11 [low] The PowerShell command line
- build-test-ci.md §1.2b uses the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo
  -NoProfile -NonInteractive -ExecutionPolicy Bypass -File …`.
- sidecar-consumers.md §13.1, act §14, read §12.1 and worker-host-desk.md §12 use a bare `powershell.exe` (PATH
  lookup, which can be hijacked by an earlier PATH entry).
- Resolution: the absolute path (from `GetSystemDirectoryW`, G19), plus `windowsHide` (G1), plus the environment
  cleanup (G3).

### C12 [low] Name of the macOS AX sidecar
- build-test-ci.md: `app/main/platform/darwin/ax-sidecar.ts` → `dist/app/ax-sidecar.cjs`. act §14: `ember_ax.js`.
  consumers §13: `sidecar.js`.
- Resolution: build-test-ci's name (it is wired into build, staging and CI checks).

### C13 [low] AX messaging timeouts: 0.25 s vs 0.8 s
- window-system.md §10 and input.md §8.7 use 0.25 s (main process). read §12.1 and act §14 use 0.8 s (sidecar).
- This is not a real conflict, because `AXUIElementSetMessagingTimeout(systemWide, …)` is **per process**. Say so
  explicitly. The main process makes AX calls once per typed character (`focusedWindow`) at 0.25 s. The sidecar uses
  0.8 s to mirror `CALL_TIMEOUT_MS`.

### C14 [medium] The first request to a slow-starting sidecar
- consumers §1.3/§12.6 and read §12.1 propose a TS-side grace (a "ready" line, or a longer first timeout).
- build-test-ci §1.2b proposes an assembly cache **or** a 20 s timeout for `status`. But `status` is sent only by
  `revive` (sidecar.ts:307), and the first request is usually `read_window` or `list_windows`.
- system.md §9.3 also wants `status` to carry the PowerShell LanguageMode for the environment check. But
  `readEnvironment` runs on every settings-window status request (main.ts:303), so starting PowerShell from there
  would be slow.
- Resolution:
  - `ensure()` gets a per-launcher `firstAnswerMs` (e.g. 20 s on win32). The timer of every request queued before
    the first answer starts at that answer.
  - Keep the assembly cache.
  - Fetch `status` once in the background after start, and cache the LanguageMode for `readEnvironment`.

### C15 [low] Process id of UWP windows
- window-system.md §9.4 uses the top-level (ApplicationFrameHost) pid in the stack. sidecar-consumers §9.4 uses the
  frame owner's pid in the sidecar, with `app` = the hosted exe. worker-host-desk §6/§13 says the UIA pid "may
  differ".
- These are consistent only if the **UIA sidecar deliberately reports the frame's pid**. Neither protocol spec
  (read §12.x) states it. Make it an explicit UIA invariant, with a test against Calculator.

### C16 [low] How `--doctor` prints on Windows
- system.md §10 ships `ember-doctor.cmd` (`start "" /wait`). build-test-ci §2.3.6 writes the report to a file, opens
  it, or attaches to the console.
- Pick one. The `.cmd` keeps the exit code.

### C17 [medium] Raw Input filter (G14) vs input.md §7.5
input.md must change step 4 from "skip `hDevice == NULL`" to "skip events tagged `EMBER_TAG`".

---

## 3. Gaps between specs (each assumes another owns it)

- **Sidecar launcher environment and spawn options** (G1, G3, C11): the build, consumers, protocol and
  worker-host-desk specs each define the command line. None owns the spawn options or the environment. Give
  `SidecarLaunch` the type `{ command, args, env(base): env, spawnOptions, firstAnswerMs }` in one place.
- **Clipboard on Windows and macOS** (G5): input.md and worker-host-desk.md touch markers, system.md doesn't touch
  the clipboard, and no spec owns `agent/clipboard.ts`.
- **Shortcut table ↔ `freshAskPress` ↔ `isSystemKey` ↔ every label** (G6, C2, C3, G8): system.md owns the wording,
  input.md the parsing, nobody `hotkey.ts`. Make `ShortcutTable` the single source, with tests.
- **OS session lifecycle** (G10) and **notifications in the zip build** (G11): nobody.
- **Policy vocabularies**: system.md §16 covers security windows, terminals and never-look. Nobody covers `RISKY`,
  `RUNS_PROGRAM`, `KEY_LABELS`, `TABBED_APP` (consumers §13.4 lists it) and the Ctrl+A question text (G8, G9).
- **Docs** (G20): nobody.

---

## 4. Search hits already covered by a spec (for the record)

| Pattern | Hits | Covered by |
|---|---|---|
| `process.platform` | main.ts:72, :150-152; eval/src/main.ts:130 | system §12.1, §9; build §3.6 |
| `/etc/` | admin.ts:14; main.ts:143; eval/src/main.ts:130 | system §4, §9; build §3.6 |
| `/usr/`, `/opt/` | autostart.ts:20; audit.ts:79; main.ts:160, :197; sidecar.ts:172; system.ts:78, :326 | system §5, §6, §10, §12, §2; consumers/read §1.1 |
| `/proc` | host.ts:197-222; main.ts:190-191; desk.ts:46, :117, :130-152; desk/agent.ts:67 | system §10, §17; worker-host-desk §9; build §3.1 |
| `/tmp`, `/run` | desk.ts:62, :75, :103; audit.ts:80; eval/src/exit.ts:58 | worker-host-desk §9 (desk Linux-only); system §6; build §3.2 |
| `DISPLAY` | main.ts:169-170, :1017, :1048-1049; environment.ts:64; eval runner:198-199, gates:122-145 | window-system §2.2, §7; input §11.15; system §9; build §3.6 |
| `XDG_` | system.ts:77-78, :326, :411-430; autostart.ts:12; environment.ts:62-63; desk.ts:426-438 | system §2, §5, §9; worker-host-desk §9 |
| `gsettings` | system.ts:29-93; main.ts:125, :326, :609, :1077; doctor.ts:64; eval checks/runner | system §2.6, §9.3, §11; window-system §4.3; build §3.6 |
| `dbus` | desk.ts:370-453; doctor.ts:103-104; eval | worker-host-desk §9; system §10 |
| `execFile`/`spawn`/`fork` | models.ts:98, :116; auth.ts:60; system.ts:12, :488, :492; speakers.ts:30; audit.ts:84; voice.ts:224; desk; eval; stage.mjs:36, :173 | system §2, §6, §7, §12, §15; build §2.2; **sidecar.ts:217 → G1** |
| `koffi.load`, `libX` | x11.ts:104; xshape.ts:77-78; input.ts:102-106; keybuffer.ts:168; clipboard-handoff.ts:165; agent-process.ts:28-107 | window-system; input §5, §9 |
| `chmod`, modes | runtime.ts:35; main.ts:79, :193; settings.ts:355-359; logger.ts:65, :90; audit.ts:23, :37; auth.ts:49; autostart.ts:55; desk | system §3, §8; build §3.1; **conductor.ts:333 → G22** |
| signals, `kill` | sidecar.ts:233, :238, :287, :320, :451; desk; eval runner:407; smoke:60 | consumers §1.3; worker-host-desk §9; build §3.1, §4.3 |
| `os.homedir`/`tmpdir`, `split(":")`, `PATH` | system.ts:77, :326, :480; main.ts:165; desk.ts:35; place.ts:130 (LibreOffice presets, desk); eval runner:88 | system §2, §7.3; worker-host-desk §9.2; build §3.1 |
| `python` | sidecar.ts:169-173, :211-217; main.ts:132; eval | consumers §1.1, §13; build §1.2, §3.6 |
| GNOME/Xorg/RHEL copy | persona.ts:11, :25; worker-persona.ts:6-13, :29; environment.ts:68-118; doctor.ts:49-112; host.ts:281; conductor.ts:108; system.ts:20 | system §13.2; worker-host-desk §10; **perception/index.ts:422/424, main.ts:887/889 → G8** |
| `Ctrl+Alt`/`Control+Alt` | main.ts:368-375, :444-463, :565-567, :1122-1136; copy.ts:66, :167; home/main.ts:731; index.html:33/54/77/138; environment.ts:118; doctor.ts:82, :94; worker.ts:1082; presenter.ts:45; policy.ts:556-572 | system §13.3, §14; input §4.2 |
| `journal`/`systemd` | audit.ts:4-128 | system §6; **index.html:146 → G7** |
| `pactl`/`parec`/speech-dispatcher | main.ts:72, :185-187, :197; speakers.ts:30-45; settings.ts:30 | system §10, §12 |
| `getNativeWindowHandle`/`readUInt32LE` | main.ts:238, :501, :1017; ask.ts:123, :224; desk/view.ts:204; overlay.ts:366 | window-system §3, §8.1; input §4.2 |
| `powerMonitor` | main.ts:601 (`getSystemIdleTime`), :1320 (`resume`) | portable; input §7.6 uses `getSystemIdleState`; **shutdown → G10** |
| renderer Linux copy | home/index.html:31/33/47/54/77/91/138; home/main.ts:186/217/731; copy.ts:6-16/51/66/99/167; desk renderer (Linux-only) | system §13.3; **index.html:34/146 → G7**; home/main.ts:716 is the compositor card (Linux-only once `compositing` is true on win32/darwin, window-system §5.1) |
| `isTrustedSender` `path.sep` | windows.ts:31-33 | window-system §5.4 |
| `env.APPIMAGE`, `WAYLAND_DISPLAY` | autostart.ts:19; environment.ts:79 | system §5, §9 |
| Copilot session hardening | session-config.ts (`availableTools: []` plus a verified subset) | portable: it is name-agnostic, so a Windows runtime's `powershell` tool is refused like `bash` (no spec states this; noted here) |
