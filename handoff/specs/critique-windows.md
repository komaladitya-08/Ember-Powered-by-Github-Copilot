# Critique: Windows feasibility of design.md and the Windows package briefs

Reviewer lens: will the Windows parts actually work on Windows 10 22H2 / 11 x64 with Electron 44, koffi 3.2.1,
Windows PowerShell 5.1 (C# 5 Add-Type), System.Windows.Automation, and the windows-2022 runner?
Each item: problem, evidence, severity (blocker / major / minor), concrete fix, where it belongs.


## Index (severity, where)

No blocker found: the in-flight Windows code (port/win32, port/uia, port/host, port/packaging) is careful and the C#
compiles at C# 5 (re-checked). The majors below will each break a real Windows user or a safety rule if not fixed.

| # | Finding | Severity | Belongs to |
|---|---|---|---|
| 1 | Autostart can't be turned off: Run value `name: "Ember"` vs AUMID-keyed `openAtLogin` | major | §9.5 (WS) |
| 2 | GPO execution policy + Mark-of-the-Web stops the bridge on managed machines | major | §5.2/§6/§9.8, pkg-uia, pkg-host |
| 3 | `status` is gated on the bridge start, so the CLM/policy setup check never shows | major | pkg-host, §5.2, §9.8 |
| 4 | Failed bridge respawned every 5 s forever | minor | pkg-host |
| 5 | Console windows are named after their client (python, ssh…), not seen as terminals | major | §2.1, §9.11, pkg-win32, pkg-uia |
| 6 | Synchronous HWND_BROADCAST WM_SETTINGCHANGE can freeze main for 5 s × N | major | §9.3 (WS) |
| 7 | windows-2022 = Server 2022, admin, one 1024×768 screen: UWP/Calculator/C15/UIPI checks can't run | major | §6, §10, §11.3, §11.5, §12.3, pkg-packaging |
| 8 | Win+Alt collisions (PowerToys Win+Alt+Space, Game Bar Win+Alt+M), Super→MOD_WIN unverified, Alt-release menu mode | major | §2.2, R14, §12.3, smoke test |
| 9 | Ask box (non-tool window) drags the user back to another virtual desktop | major | §8.3 |
| 10 | Missing UWP/.lnk targets make explorer.exe show modal errors (one offers to delete the shortcut) | minor | §9.2 |
| 11 | Start Menu catalogue: redirected folders, sync COM on main, MSI advertised shortcuts, own shortcut, MSIX gap | minor | §9.2 |
| 12 | Ember.exe keeps Electron's VERSIONINFO/icon and an invalid signature ("Electron" in Startup apps, mic indicator) | major | §10, pkg-packaging §5 |
| 13 | Test bench runs in powershell.exe → program "powershell" = a terminal for Ember-level tests | minor | pkg-win32 §4-5, §11.5 |
| 14 | Bridge reads Ember's own windows (no skipPids below the host) | minor | pkg-uia, pkg-host, §2.5 |
| 15 | `systemDialogOpen` (b) misses prompts whose SYSTEM process can't be opened | minor | §7.2 |
| 16 | `BringWindowToTop` on a busy app blocks the main thread (and the stop hotkey) | major | pkg-win32 §2, §7.4/R6 |
| 17 | Managed System.Windows.Automation proxies vs COM UIA: classic Win32 lists/trees, 32-bit targets | minor | pkg-uia §9, pkg-win32 §4, §12.2 |
| 18 | Smaller items (a)-(j): PSModulePath, env case, hide-for-capture, CAPTUREBLT, login cold start, EDR, full-screen apps, profile paths, ADMX, wording | minor | various |
| 19 | One hung UWP app makes all UWP apps busy (busy keyed by ApplicationFrameHost pid) | major | pkg-uia §4-5, §6 |
| 20 | Per-thread DPI fallback may give UIA logical coordinates; ready line can't tell | minor | pkg-uia §2, §5.1, §12.3 |
| 21 | Roslyn LangVersion 5 harness ≠ legacy csc used by Add-Type; make the CI compile authoritative | minor | §6, pkg-packaging §8 |

## Findings

1. **Autostart can never be turned off (Run value name vs AppUserModelId).**
   - Problem: §9.5 writes the Run value with `name: "Ember"`, but reads state with `app.getLoginItemSettings({ path, args })`.
     On Windows `getLoginItemSettings` takes no `name` (electron.d.ts:22467-22494, `LoginItemSettingsOptions` has only
     `path`/`args` for win32); Electron computes `openAtLogin` from the Run value named after the AppUserModelId (its
     Windows implementation reads that value; the typings show there is no way to name another), consistent with
     (`setLoginItemSettings`' own doc: "name … Defaults to the app's AppUserModelId()", electron.d.ts:23972-23977). §9.12
     sets the AUMID to `io.github.komaladitya08.ember`, so `openAtLogin` is always false: `sync(true)` rewrites the value on
     every settings change, and `sync(false)` returns early ("already in step") and never deletes `HKCU\…\Run\Ember`.
     The user's "start at login: off" is silently ignored.
   - Evidence: design.md:1946-1953 (`name = "Ember"`), design.md:2141 (AUMID), electron.d.ts lines above.
   - Severity: major (a consent setting that doesn't stick).
   - Fix: drop `name` (let it default to the AUMID, which main sets before ready, §4.1 item 4), or keep `name: "Ember"`
     and derive state from `launchItems.find(i => i.name === "Ember" && i.scope === "user" && sameExe(i.path))`
     instead of `openAtLogin`; `note()` uses the same entry's `enabled`. Integration test: sync(true) → value present;
     sync(false) → value gone (today's test only checks the "on" half).
   - Where: design §9.5 (WS, `win32/system/autostart.ts`) and its integration test in §11.3.

2. **The UIA bridge does not start from a downloaded zip on machines with a Group Policy execution policy.**
   - Problem: the bridge is started with `-ExecutionPolicy Bypass -File ember_uia.ps1`. A `MachinePolicy`/`UserPolicy`
     execution policy set by GPO (very common in companies: `RemoteSigned` or `AllSigned`) overrides the process-scope
     `-ExecutionPolicy` switch. Files extracted with Explorer from a browser-downloaded zip carry the Mark-of-the-Web
     (`Zone.Identifier`, ZoneId=3), so under `RemoteSigned` the unsigned `ember_uia.ps1` is "remote" and refused.
     PROTOCOL.md acknowledges it ("a Group Policy execution policy (AllSigned, RemoteSigned) overrides -ExecutionPolicy
     Bypass") but the design has no plan beyond "report it": Windows accessibility is then off on exactly the managed
     machines Ember targets. The fatal line is also not reliable here: PowerShell refuses the script before any of it
     runs, so there is no `{"fatal":…}` line, only stderr and exit 1 (PROTOCOL.md "If the process exits before writing
     any line").
   - Evidence: /home/user/wt/uia/sidecar/uia/PROTOCOL.md (Framing section); design.md:1424, :1456, :2317 (R8 covers CLM,
     not execution policy); pkg-packaging.md §5 (zip only).
   - Severity: major.
   - Fix: (a) Ember owns its resource files, so at start (WS, `win32/system/lifecycle.ts`) delete the `:Zone.Identifier`
     stream of `resources\sidecar\uia\ember_uia.ps1` and `.cs` (`fs.rmSync(p + ":Zone.Identifier", { force: true })`, NTFS
     ADS path; ignore errors) — this fixes `RemoteSigned` + MOTW, the common case, without bypassing anything.
     (b) For `AllSigned`/`Restricted` by GPO, detect it (`HKLM|HKCU\SOFTWARE\Policies\Microsoft\Windows\PowerShell`
     `EnableScripts`/`ExecutionPolicy`) and surface a specific setup-check/doctor text ("Your organisation only allows
     signed PowerShell scripts; Ember's accessibility helper is unsigned") instead of the generic "didn't start".
     (c) The host must map "exit before any line + stderr mentions `execution polic`/`PSSecurityException`/
     `UnauthorizedAccess`" to that detail and stop retrying (see item 4). Optional alternative to (a) if the lead accepts
     it: start the bootstrap as `-Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:EMBER_UIA_SCRIPT)))"`
     (execution policy applies to script files only; CLM/AppLocker/WDAC still apply), with `$PSScriptRoot` replaced by an
     env var — but that overrides an admin's GPO, so (a)+(b) is the conservative default.
   - Where: design §5.2/§6 item 1, §9.8 (new `powershell: "policy"` state), §9.9 doctor row; pkg-uia.md §1 (bootstrap must
     not use `$PSScriptRoot` if (c-alt) is chosen); pkg-host.md (stderr mapping).

3. **`status` cannot report why the bridge failed, so the Constrained Language Mode setup check never shows.**
   - Problem: §2.1 `EnvContext.helper` and §9.8 expect the host's `status` to answer `{ toolkitAccessibility: false,
     detail: "<fatal message>" }`. In port/host every method except `ping` first awaits `provider.start()`
     (/home/user/wt/host/app/sidecar-host/host.ts:66-77), so when the bridge printed `{"fatal":…}` (CLM, AllSigned,
     Add-Type blocked) `status` returns a JSON-RPC **error**, and its result shape has no `detail` field at all
     (/home/user/wt/host/app/sidecar-host/reading.ts:60-73). Main then stores `helper = null` → `powershell: "unknown"` →
     "no row" (design.md:2005-2007, :2014). The one diagnostic for locked-down machines is lost.
   - Severity: major.
   - Fix: in port/host, run `status` like `ping` (no `start()` gate); have it call a non-throwing
     `provider.health(): { ok: boolean; detail?: string; languageMode?: string; dpi?: string }` and answer
     `{ …today's fields, toolkitAccessibility: ok ? true : false, detail, languageMode }`. The UIA provider keeps the
     fatal text and `languageMode` from the bridge's fatal line (PROTOCOL.md "The first line"). Design §9.8 then keys
     "constrained" on `languageMode === "ConstrainedLanguage"` instead of regex-matching prose.
   - Where: pkg-host.md (status), design §5.2 (status fetch) and §9.8.

4. **A failed bridge is respawned every 5 s on demand, forever.**
   - Problem: `UiaProvider.start()` relaunches PowerShell whenever a request arrives more than `retryMs` (5 s) after a
     failed start (/home/user/wt/host/app/sidecar-host/providers/uia.ts:276-283). Under CLM/AllSigned the outcome never
     changes, but every perception read spawns `powershell.exe` again (≈0.5-1.5 s CPU each, and with Script Block
     Logging on, an event-log entry each time). PROTOCOL.md explicitly says "Don't restart in a loop after a fatal line".
   - Severity: minor (resource use, log noise on managed machines).
   - Fix: on a fatal line whose `languageMode` is `ConstrainedLanguage`, or an execution-policy refusal (item 2), mark
     the provider permanently unavailable for the life of the host (`status` reports it, other methods fail fast with
     the same text); otherwise back off exponentially (5 s, 30 s, 2 min, cap 10 min).
   - Where: pkg-host.md (providers/uia.ts).

5. **Console windows report the console client's program, so a Python/Node/SSH console isn't a "terminal".**
   - Problem: for a classic console window (class `ConsoleWindowClass`, drawn by conhost.exe) `GetWindowThreadProcessId`
     reports the pid of the first attached client process, for compatibility. port/win32's `appName()` and the bridge's
     `processName` therefore give `python`, `node`, `ssh`, `ftp`, `diskpart`, `netsh`, `wsl`… for a console started from
     the Start menu or Run. §9.11's `TERMINALS` lists shells and terminal programs by name only, so `isTerminalApp`
     (worker `open_app`, policy) misses these windows: a borrowed-keyboard `type_text` into a Python REPL would run
     code. The host's role mapping does call text in console classes "terminal"
     (/home/user/wt/host/app/sidecar-host/roles.ts:85-94) and the policy refuses typing into an element with role
     "terminal" (app/main/policy/policy.ts:1816), but tier-3 decisions keyed on the window's app name don't see it, and
     never-look/grant matching by program becomes unpredictable for console windows.
   - Evidence: /home/user/wt/win32/app/main/platform/win32/hwnd.ts (appName = program of the HWND's pid);
     design.md:2081-2093 (name lists only).
   - Severity: major (safety rule that fails open on Windows).
   - Fix: make the window class part of the terminal decision on Windows: (a) in port/win32 `appName()` and in the
     bridge's `AddWindowFacts`, a top-level window whose class is `ConsoleWindowClass` or `PseudoConsoleWindow` gets the
     app name `conhost` (the program that really owns the window), keeping the client's name in a new optional
     `clientProgram` field for display; (b) V adds a win32 `TERMINAL_CLASSES` row (`ConsoleWindowClass`,
     `CASCADIA_HOSTING_WINDOW_CLASS`, `PseudoConsoleWindow`, `mintty`, `PuTTY`, `VirtualConsoleClass`) and
     `AppIdentity` gains optional `windowClass`, checked by `isTerminalApp` on win32. Integration test: start
     `python.exe` (or `cmd /k`) from a `.lnk`; `stack()`/`clientWindows()` name it `conhost` and the policy refuses a
     tier-3 `type_text` into it.
   - Where: design §2.1 conventions (app names: console windows), §9.11 (V), pkg-win32.md §1 (wmClass rule),
     pkg-uia.md §6 (processName rule).

6. **The WM_SETTINGCHANGE broadcast can freeze Ember's main thread for many seconds.**
   - Problem: §9.3 calls `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, …, SMTO_ABORTIFHUNG, 5000, …)`
     synchronously through koffi on Electron's main thread. For `HWND_BROADCAST` the timeout is per top-level window
     ("the total wait time can be up to the value of uTimeout multiplied by the number of top-level windows", Win32
     docs); SMTO_ABORTIFHUNG only skips windows already flagged hung (≥5 s unresponsive). One slow app = 5 s of frozen
     overlay, hover polling and hotkeys; two = 10 s.
   - Evidence: design.md:1888-1890, :1903.
   - Severity: major (UI freeze from a tier-0 action).
   - Fix: call it with koffi's asynchronous form (`SendMessageTimeoutW.async(…, cb)`, runs on koffi's worker thread;
     Ember's own windows still get the message through the main thread's message loop) with
     `SMTO_ABORTIFHUNG | SMTO_BLOCK`, timeout 1000 ms, and don't wait for it before reading the value back (the read
     back checks the registry, not the broadcast). Unit-test that the binding is the async one.
   - Where: design §9.3 (WS `win32/system/settings.ts`, `ffi.ts`).

7. **CI's windows-2022 runner is Windows Server 2022, run as an administrator: several "verify in CI" items can't be
   verified there.**
   - Problem: the design leans on CI for Windows client behaviour that Server 2022 doesn't have or can't show:
     (a) the UWP Calculator check for C15 (§6 item 4, §11.5 "UWP Calculator matchFrame by pid") and WS's
     "list() has … Calculator" (§11.3) — Server 2022 ships no Store apps; its Calculator is the classic Win32
     `win32calc`, so no ApplicationFrameHost frame is exercised; (b) Windows 11 Notepad/Paint/Photos/Store/Game Bar
     (§9.2 curated table, R14's Win+Alt collisions) don't exist there; (c) hosted runners run the job as an
     administrator (runneradmin, UAC effectively off), so Ember is elevated: `blockedReason` never fires, the
     "elevated" setup check always warns, the explorer.exe de-elevation/clean-env property (§9.2) and UIPI can't be
     observed, and if `EnableLUA` is 0 UWP activation itself is refused ("can't be opened while User Account Control is
     turned off"), which would also break a Settings-based UWP test; (d) one 1024×768 monitor at 100 %: no mixed DPI,
     no negative coordinates.
   - Evidence: design.md:1593, :1848-1849, :2229, :2248-2249, :2335-2337; D8 (windows-2022).
   - Severity: major (false confidence: the C15 and UWP checks would be skipped or pass vacuously).
   - Fix: (1) the Windows job prints its facts first (`[Environment]::OSVersion`, `whoami /groups` integrity level,
     `EnableLUA`, the screen size) and the integration suites branch on them explicitly, recording "not testable on
     this runner: <reason>" instead of silently passing; (2) C15/UWP checks use the Settings app
     (`shell:AppsFolder\windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel`, present on
     Server 2022 Desktop Experience) only when `EnableLUA` is 1, else they move to §12.3; (3) WS's list() expectation
     becomes "Settings and File Explorer" (Calculator only when the package is registered); (4) consider adding a
     `windows-2025` matrix row (Server 2025 shares the Windows 11 24H2 shell) for the shell-dependent checks; (5) the
     elevated-window refusal, the clean-environment launch through explorer, Win+Alt collisions and mixed DPI are
     listed explicitly as manual-only in §12.3 (items 2, 5, 7, 13).
   - Where: design §6 item 4, §10 item 2, §11.3 (WS tests), §11.5 (I), §12.3; pkg-packaging.md §8 (CI job).

8. **The Win+Alt table collides on ordinary Windows machines, and nothing in CI checks that Super registers at all.**
   - Problem: (a) Win+Alt+Space is the default shortcut of PowerToys Command Palette (PowerToys 0.90+), so the most
     important shortcut (ask) is "taken" on many developer and power-user machines; Win+Alt+M is the Xbox Game Bar
     microphone toggle, on by default on Windows 10/11 client (R14 names only the latter). (b) The design assumes
     Electron maps `Super` to `MOD_WIN` in `RegisterHotKey` on Windows; if a build didn't, all six registrations would
     fail and the only signal is the "shortcut taken" path. (c) `RegisterHotKey` eats only the letter's key-down: the
     foreground app still sees Alt go down and up with nothing in between when the user presses Win first, which in
     classic Win32 apps can enter menu mode (the very "Alt tap" side effect input.md forbids for activation). For
     "allow" (Win+Alt+Y) Ember then types into an app whose menu bar has the keyboard.
   - Evidence: design.md:710-715, :2335-2337; decisions.md D6; app/main/main.ts:1122-1136 (registration order and the
     taken list).
   - Severity: major (ask/mute unavailable or acting oddly on a large share of real machines; (c) is a safety check).
   - Fix: (1) R14 lists PowerToys Command Palette and Game Bar explicitly and the lead decides now whether Windows keeps
     Space/M or uses other letters (the table is one row; nothing else changes); (2) the Windows smoke test (PK/I) asserts
     the log has no `shortcut.unavailable` for any of the six on the runner (Server 2022 has neither PowerToys nor Game
     Bar, so all six must register — this proves the Super→MOD_WIN mapping in Electron 44); (3) §12.3 item 2 adds:
     Win11 client with Game Bar on and PowerToys installed; after each of the six chords, Notepad and File Explorer must
     not show menu mnemonics/menu mode; (4) fallback if (c) shows: when a Win+Alt chord fires, send one
     `VK 0xE8` (unassigned) down/up through SendInput while Alt is still held — the "menu mask key" technique — owned by
     port/win32 as `Input.maskMenuKey?()` and called by main's shortcut handlers on win32.
   - Where: design §2.2, §12.2 R14, §12.3 item 2, §10 (smoke assertion); pkg-win32.md (mask key, optional member).

9. **The ask box will drag the user back to another virtual desktop.**
   - Problem: on Windows, the ask box is a normal (non-tool) top-level window that is created once and then hidden and
     re-shown (app/main/ask.ts:90-116; `skipTaskbar` removes the taskbar button but not the virtual-desktop
     assignment). §8.3 gives it `{ thickFrame: false, roundedCorners: false }` only. Windows' virtual-desktop manager
     tracks such windows: showing and activating it while the user is on another desktop switches desktops (or flashes
     it) instead of popping it over the current app. The overlay and handle are `type: "toolbar"` (WS_EX_TOOLWINDOW),
     which the manager doesn't track, so they follow the user (the design's "verify" note covers only them).
   - Evidence: design.md:1736-1741 (`ask options` row), app/main/ask.ts:90-99.
   - Severity: major (the main interaction misbehaves for anyone using Task View desktops).
   - Fix: give the Windows ask box `type: "toolbar"` as well (tool windows can still be activated and take the
     keyboard; the ask box is focusable), and add an integration check: create a second desktop isn't scriptable on
     CI, so §12.3 gets "open the ask box on desktop 1, switch to desktop 2, press Win+Alt+Space: the box appears on
     desktop 2 and the desktop doesn't change". Fallback if a tool window can't take focus reliably: destroy and
     recreate the ask box on each open on win32 (`AskWindow` option `recreate`).
   - Where: design §8.3 table (ask row, win32), §12.3.

10. **"Launching a missing one fails harmlessly" is false: explorer.exe shows modal error boxes.**
    - Problem: §9.2 falls back to "offer every curated entry" when packaged-app detection fails, saying a missing app
      fails harmlessly. `explorer.exe shell:AppsFolder\<AUMID>` for an app that isn't registered shows Explorer's own
      error dialog on the user's screen; a `.lnk` whose target is gone shows "Problem with Shortcut … Do you want to
      delete this shortcut?" — a destructive Yes/No prompt Ember caused. The packaged-app detection itself reads an
      undocumented key (`HKCU\Software\Classes\Local Settings\…\AppModel\Repository\Packages`).
    - Evidence: design.md:1845-1851, :1852-1857.
    - Severity: minor (UX and a stray destructive prompt; no data loss unless the user clicks Yes).
    - Fix: detect packages with the documented `GetPackagesByPackageFamily` (kernel32, appmodel.h:
      `LONG GetPackagesByPackageFamily(PCWSTR family, UINT32 *count, PWSTR *names, UINT32 *bufLen, WCHAR *buf)`; first
      call with nulls, `count > 0` means installed for this user) and drop the "offer every entry" fallback; skip a
      `.lnk` whose target (`argv[0]`, after `%VAR%` expansion) doesn't exist, both when listing and right before
      launching.
    - Where: design §9.2 (WS `win32/system/apps.ts`, `ffi.ts`).

11. **Start Menu catalogue details that will bite on real machines.**
    - Problems and fixes (all WS, §9.2, minor):
      (a) Deriving the folders from `app.getPath("appData")`/ProgramData misses redirected Start Menus (roaming
      profiles, folder redirection): use `SHGetKnownFolderPath(FOLDERID_Programs)` and `FOLDERID_CommonPrograms`
      (already bound for ProgramData).
      (b) `shell.readShortcutLink` is synchronous COM on Electron's main thread; 2000 shortcuts cold is a visible
      overlay stall. Either parse `.lnk` files in TypeScript (MS-SHLLINK: header, LinkInfo, StringData, and the
      PropertyStore ExtraData block for `System.AppUserModel.ID`) so the catalogue stays plain Node and can run off the
      main thread, or cap each `list()` cold pass at ~300 ms and finish it on later calls.
      (c) MSI "advertised" shortcuts (older Office MSI, many enterprise apps) resolve to an icon under
      `%WINDIR%\Installer\{GUID}\…`, so `programs` would be e.g. `wordicon`: treat targets under `%WINDIR%\Installer`
      as unknown program (fall back to title match) or resolve them with `msi.dll` `MsiGetShortcutTargetW` +
      `MsiGetComponentPathW`.
      (d) The Start Menu shortcut Ember creates for itself (§9.12 `ensureShortcut`) shows up in its own catalogue:
      skip entries whose target is `process.execPath`.
      (e) MSIX desktop apps with no `.lnk` and not in the curated table (new Teams, WhatsApp, Spotify, Clipchamp…)
      can't be opened. If that matters for v1, the C# bridge can enumerate `shell:AppsFolder` (Shell.Application COM
      via reflection, no `dynamic` needed in C# 5) and the host expose it; otherwise list it as a known gap in §12.
    - Where: design §9.2; §12.2 (gap).

12. **Ember.exe still says "Electron" everywhere Windows names a program, and carries a broken signature.**
    - Problem: stage.mjs renames electron.exe but leaves its VERSIONINFO and icon ("TODO(port): set Ember.exe's icon and
      version resource once a resource editor is a dependency", /home/user/wt/packaging/scripts/package/stage.mjs:161-164).
      Windows shows the exe's FileDescription/ProductName/CompanyName in Task Manager (processes and **Startup apps**),
      Settings › Privacy › Microphone ("Electron is using your microphone"), the volume mixer, Windows Firewall prompts
      and SmartScreen. §9.5's note tells the user to "turn Ember on" in Startup apps, where it is listed as "Electron —
      GitHub, Inc.". Flipping fuses also edits bytes under Electron's Authenticode signature, so the shipped exe has an
      *invalid* GitHub signature ("This digital signature is not valid"), which some AV/EDR products treat as tampering,
      worse than unsigned. The design's §10 doesn't pick the TODO up.
    - Severity: major (user trust and the design's own copy; security tooling).
    - Fix: §10 adds a step owned by I/PK: before flipping fuses, rewrite the PE resources with a pure-JS editor
      (`resedit`, MIT, no native code, runs and is unit-testable on Linux) — FileDescription/ProductName "Ember",
      CompanyName (owner), OriginalFilename/InternalName "Ember.exe", FileVersion/ProductVersion = package version, the
      icon group from `ember.ico` — and drop the certificate table (resedit's `ignoreCert`), then flip fuses, then
      `fuses.mjs --check`. CI asserts the version strings (PowerShell `(Get-Item Ember.exe).VersionInfo`) and that
      `Get-AuthenticodeSignature` reports `NotSigned`, not `HashMismatch`.
    - Where: design §10 (new item), pkg-packaging.md §5 (lifts the "no new dependency" limit for this one devDependency:
      lead decision).

13. **The shared test bench runs inside powershell.exe, so Ember-level tests will see a "terminal".**
    - Problem: win_bench.ps1 is a WinForms window hosted by `powershell.exe`, so its window's program is `powershell`
      (pkg-win32.md §5 even asserts `program name "powershell"`). V puts `powershell` in Windows `TERMINALS`
      (design.md:2081-2082), so I's Ember-level checks (§11.5) and any policy-level test will refuse to act on the bench
      ("terminal") or treat it as a shell; the bench also inherits powershell.exe's DPI awareness and console.
    - Severity: minor (test validity; would surface as confusing failures in Phase 3).
    - Fix: keep win_bench.ps1 as the builder but have it compile the form to `EmberBench.exe`
      (`Add-Type -OutputType WindowsApplication -OutputAssembly <temp>\EmberBench.exe`, C# 5, with a PMv2 manifest via
      `SetProcessDpiAwarenessContext` at start) and run that, so the program name is `EmberBench`; the suites assert that
      name. A second variant built `/platform:x86` covers 32-bit targets (item 17).
    - Where: pkg-win32.md §4-5, design §11.5.

14. **The bridge reads Ember's own windows on every window list.**
    - Problem: port/host filters `ownPid` only after the provider answered (/home/user/wt/host/app/sidecar-host/windows.ts:123-128,
      reading.ts:77), and the bridge's `topWindows` calls `AutomationElement.FromHandle` + cached properties on every
      visible top-level window, Ember's overlays, handle and ask box included; `elementsAt` hits Ember's overlay
      whenever it isn't click-through. Linux's sidecar never touches Ember's process ("its windows are never found,
      listed or read", sidecar/atspi/ember_atspi.py:1936). On Windows, UIA requests into a Chromium HWND switch on
      Chromium's accessibility in Ember itself (renderer AX trees for a 60 Hz overlay) and flip
      `isAccessibilitySupportEnabled()`.
    - Severity: minor (performance; verify).
    - Fix: hostLaunch passes `EMBER_OWNER_PID` (main's pid) and the bridge gets a `skipPids` parameter (topWindows,
      elementsAt) applied before any UIA call — skipped windows are listed from Win32 facts only, and an `elementsAt`
      whose `WindowFromPoint` root belongs to a skipped pid answers `[]` so the host descends in the target window (it
      already does, reading.ts:487-500). Check in the integration test: Ember's `accessibility-support-changed` never
      fires while the host lists windows.
    - Where: pkg-uia.md §6 (topWindows/elementsAt params), pkg-host.md, design §5.1 (env), §2.5 hostLaunch.

15. **`systemDialogOpen` (b) misses prompts whose program can't be read.**
    - Problem: §7.2 (b) matches `wmClass` against `consent`, `logonui`, `credentialuibroker`… but `wmClass` comes from
      `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, which a standard user often can't open on SYSTEM processes
      (consent.exe, LogonUI.exe). With "prompt on secure desktop" off (common in VDI/RDP setups) the UAC dialog is on the
      user's desktop with `wmClass` "" and (b) says nothing.
    - Severity: minor (the foreground-title check in the security vocabulary still catches most cases).
    - Fix: (b) also matches the dialog window classes (`Credential Dialog Xaml Host`, `$$$Secure UAP Dummy Window Class
      For Interim Dialog`) and `SECURITY_TITLE[win32]`, and fails closed for a topmost, screen-covering window whose
      program can't be read. Unit-test with a fake stack entry `{ wmClass: "", className: "Credential Dialog Xaml Host" }`.
    - Where: design §7.2 (WS `win32/system/secure-desktop.ts`).

16. **`activate()` can block Ember's main thread on a busy app — and with it the stop shortcut.**
    - Problem: the last step of port/win32's activation calls `BringWindowToTop(target)` (hwnd.ts `activateWindow`).
      That is `SetWindowPos` without `SWP_ASYNCWINDOWPOS`, which for another thread's window waits synchronously for
      that thread to handle WM_WINDOWPOSCHANGING. The `isHung` guard (`IsHungAppWindow`) only trips after ~5 s of no
      message processing, so a target that is merely busy (Excel recalculating, an app loading a file) freezes Electron's
      main thread for as long as it is busy, and indefinitely if it deadlocks at that moment. Everything on that thread
      stops: the overlay, hover polling, and `WM_HOTKEY` for Win+Alt+X — the kill switch §12.3 item 5 wants under 300 ms.
      CursorBorrow activates the target window from a timer during tier-3 work, so this is on the hot path.
    - Evidence: /home/user/wt/win32/app/main/platform/win32/hwnd.ts (`activateWindow`, step 4), ffi.ts
      (`BringWindowToTop` binding); design.md:1658-1659, :2312-2313 (R6), :2362.
    - Severity: major (a safety control can become unresponsive).
    - Fix: replace `BringWindowToTop(hwnd)` with `SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE |
      SWP_ASYNCWINDOWPOS)` (the target thread isn't the attached foreground thread, so the request is posted, not
      sent); add a rule to pkg-win32's module comment — "no synchronous cross-thread window call on the main thread"
      — and a unit test that the activation sequence uses only async/position-posting calls for foreign windows
      (`ShowWindowAsync`, `SetWindowPos` with ASYNC, `SetForegroundWindow`, `AttachThreadInput` with the hung guard).
    - Where: pkg-win32.md §2 (activate), design §7.4 / R6.

17. **System.Windows.Automation is not the COM UIA client Inspect.exe shows: verify its blind spots early.**
    - Problem: D3 binds the managed .NET Framework client. It goes through UIAutomationCore but registers .NET's own
      client-side proxies (UIAutomationClientsideProviders) for classic Win32 controls (SysListView32, SysTreeView32,
      tab, combo), which read the target with cross-process memory calls and are known to differ from the COM API's
      view (missing or flattened items, `ProxyNotSupported`, trouble with 32-bit targets from a 64-bit client). It also
      lacks newer UIA properties/patterns (the bridge already reads LegacyIAccessible through UIAutomationCore's flat
      API for that reason). The design's only fixture is a WinForms window, which UIA serves natively, so CI would not
      notice.
    - Severity: minor (fidelity; could become major for File Explorer-style lists in older apps).
    - Fix: add to the bench (item 13) a ListView (details view) and a TreeView, and run the uia-bridge suite against a
      second `/platform:x86` build of the bench; record in §12 the fallback if they fail: route those control classes
      through UIAutomationCore's COM `IUIAutomation` via `[ComImport]` interfaces in C# 5 (no `dynamic`), keeping the
      wire protocol unchanged.
    - Where: pkg-uia.md §9 (integration test), pkg-win32.md §4 (bench), design §12.2 (new risk).

18. **Smaller Windows issues (each minor), with fixes.**
    - (a) *PSModulePath*: deleting it makes Windows PowerShell 5.1 rebuild a default that **includes the user's
      `Documents\WindowsPowerShell\Modules`** (OneDrive-redirected on many machines, so start-up may touch OneDrive).
      Set it explicitly to `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules` instead (cleanEnv's `drop` becomes a
      `set`), which is deterministic and as safe. Where: design §2.5/§5.1, pkg-host.md, PROTOCOL.md note.
    - (b) *Case-insensitive environment edits*: on Windows `{ ...process.env }` is a plain object; `cleanEnv`,
      `hostLaunch`'s deletions (NODE_OPTIONS, ELECTRON_*) and appEnv's NEVER list must match names case-insensitively
      (`Path`/`PATH`, `Node_Options`), as port/host's `bridgeEnv` already does. Unit-test with mixed-case keys. Where:
      design §2.5, §4.15.
    - (c) *Hide for capture*: `setOpacity(0)` + 60 ms on a `transparent: true` window is listed as "verify". The
      Windows-native alternative is Electron's `setContentProtection(true)` (SetWindowDisplayAffinity
      WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+, honoured by GDI BitBlt): set it on Ember's windows just for the
      capture (one DWM frame, ~16 ms) and clear it after — no visible flicker. Leaving it on permanently would also hide
      Ember from the user's screen shares; that is a product choice for the lead. Where: design §8.3, §4.7 (a
      `hideForCapture` hook on the platform).
    - (d) *CAPTUREBLT*: BitBlt with CAPTUREBLT hides and redraws the mouse cursor on many systems (visible flicker on
      each screenshot). Measure on a Windows 11 client whether DWM's composed screen DC already includes layered windows
      without it; drop the flag if so. Large captures (3×4K ≈ 100 MB BGRA) are also synchronous on the main thread:
      perception should keep capturing the window rectangle, not the virtual screen. Where: pkg-win32.md §1 (capture).
    - (e) *Cold start at login*: with `--autostart`, PowerShell + csc + Defender can exceed the 18 s host start budget;
      after the first (error) answer every later request has 5 s, while `UiaProvider.start()` blocks up to 18 s, so the
      client kills and revives the host while the orphaned compile is still running (several concurrent compiles at
      login). Fix: after the first answer the host answers the BUSY wording at once while the bridge is still starting
      (never blocks a request past ~1 s on `start()`), and main delays the 10 s status probe to 60 s when launched with
      `--autostart`. Where: pkg-host.md (start), design §5.2.
    - (f) *EDR heuristics*: an unsigned exe spawning hidden `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy
      Bypass -File …` matches common EDR detections (MITRE T1059.001). R8 should say so, and DOC should give admins the
      exact command line, script path and the cached DLL's location/hash so they can allow-list it. Where: §12.2 R8,
      §11.6.
    - (g) *Full-screen apps*: the overlay is raised to topmost every 2 s over every monitor; over a full-screen D3D
      game or video it prevents independent flip and can knock exclusive-mode apps out. Hide the overlay on a display
      while `SHQueryUserNotificationState` says `QUNS_RUNNING_D3D_FULL_SCREEN` or `QUNS_PRESENTATION_MODE` (shell32,
      one koffi call in the 2 s raise loop). Where: design §8.3, R10.
    - (h) *Profile paths*: add to §12.3 a Windows account whose name has a space and a non-ASCII letter (`José Smith`):
      the bridge's cache path, `%TEMP%` for csc, the Start Menu walk and `EMBER_UIA_SCRIPT` all go through it.
    - (i) *Admin policy delivery*: one REG_SZ of JSON is hard to deploy with Intune/ADMX (text elements are short by
      default). Ship an ADMX/ADML pair with a `multiText` or long `text` element for `PolicyJson` (DOC), or accept
      `REG_MULTI_SZ` joined with "\n" in addition to `REG_SZ` (still fail closed on any other type).
      Where: design §9.4, §11.6.
    - (j) *Elevated wording*: §9.8 warns "apps it opens run as administrator too", but §9.2 launches through the
      running (non-elevated) shell, which de-elevates. Reword: "Ember is running as administrator: start it normally
      so it can't act with administrator rights by mistake."

19. **One hung UWP app makes every UWP app "busy": the bridge keys busy state by the frame's pid.**
    - Problem: C15 makes the top-level `pid` the frame's (ApplicationFrameHost), and the bridge uses that pid as the busy
      key: `SnapshotTarget` returns `Win.PidOf(frame)` (ember_uia.cs:2156-2163), handles carry it (`HandleTarget`,
      :2142-2150), and `TopWindows` groups windows per `PidOf` (:2242-2256). ApplicationFrameHost.exe is **one process
      for all UWP frames**, so when Settings' or Calculator's CoreWindow hangs during a snapshot, the deadline marks
      ApplicationFrameHost busy and every other UWP window (Settings, Calculator, Store, Photos, Clock…) answers `busy`
      at once — and `topWindows` lists them all as busy entries without handles — until the stuck worker returns.
    - Severity: major (Ember goes blind to a whole class of apps because of one).
    - Fix: keep the wire `pid` as the frame's (C15), but make the bridge's *busy key* the hosted pid for
      `ApplicationFrameWindow` targets (`Win.Hosted(frame, framePid)`, already written for `hostedPid`; fall back to the
      frame pid when there is none), group `topWindows` workers by that key, and report `busyPids` as hosted pids
      (documented in PROTOCOL.md). Elements inside a CoreWindow already carry the hosted app's `ProcessId`, so handles
      registered from them should use it too. Test: a Linux unit test of the busy-key choice (frame with a hosted
      CoreWindow → hosted pid; frame without → frame pid) and a manual check in §12.3 (pause Settings in a debugger;
      Calculator stays readable).
    - Where: pkg-uia.md §4 (busy per pid → per hosted pid for frames), §5; design §6 item 4.

20. **Per-thread DPI awareness may not give UIA physical coordinates; the ready line can't tell.**
    - Problem: if powershell.exe's manifest already fixed the process awareness, `SetProcessDpiAwarenessContext`
      fails and the bridge sets PMv2 per worker thread (ember_uia.cs:1167-1186), then reports the *thread's* context
      as `dpi`. Whether UIAutomationCore converts bounds and `FromPoint` by the calling thread's context or by the
      process's is not documented; if by the process's, a mixed-DPI setup gets logical coordinates for some monitors
      while the ready line says `per-monitor-v2`, and the host/AtspiSidecar assume k = 1 (design.md:1439-1441). CI has
      one 100 % monitor, so nothing would catch it.
    - Severity: minor (mixed-DPI only; wrong click targets when it happens).
    - Fix: the ready line reports both (`dpi` for threads, `processDpi` from `GetProcessDpiAwareness`); the host logs
      `uia.dpi_mixed` when they differ and the environment check shows a warning row; §12.3 item 13 adds an explicit
      check: `at_point` at a control's centre on a 150 % monitor left of a 100 % primary returns that control, and a
      tier-1 action's verification bounds match `stack()`'s frame. Fallback if it fails: convert in the bridge per window
      with `LogicalToPhysicalPointForPerMonitorDPI` / `PhysicalToLogicalPointForPerMonitorDPI` (user32) for bounds and
      `FromPoint` input, so the wire stays in physical pixels.
    - Where: pkg-uia.md §2 (ready line), design §5.1 (units), §12.3.

21. **Harness ≠ the compiler that ships.** The lead's check builds with Roslyn `LangVersion 5` (it passes today:
    `dotnet build -p:SrcFile=/home/user/wt/uia/sidecar/uia/ember_uia.cs` → 0 errors, 0 warnings, re-run for this
    review), but Windows PowerShell 5.1's `Add-Type` uses the legacy pre-Roslyn `csc.exe` from
    `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319`, whose overload resolution and lambda inference differ from
    Roslyn's C# 5 mode in edge cases. port/packaging's CI step compiles with the real `Add-Type`, so make that step
    run (and be required) from the first CI run of every branch that touches `ember_uia.cs`, and have the CI step load
    the assemblies exactly as the bootstrap does (by `Location`, not by partial name) so it compiles what Ember
    compiles. Severity: minor. Where: design §6 item 6, pkg-packaging.md §8.

