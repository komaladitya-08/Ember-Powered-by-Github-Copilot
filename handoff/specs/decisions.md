# Decisions for the Windows + macOS port (binding for the design)

These are the lead's decisions. The design must follow them; where a spec file disagrees, this file wins.
Targets: Windows 10 22H2+ / 11 (x64; arm64 best-effort), macOS 13+ (arm64 and x64). Linux behaviour must not change.

## D1. One composition root
`app/main/platform/` owns every OS-specific piece. `app/main/platform/index.ts` exports `loadPlatform(): Platform`,
chosen by `process.platform` only (never by $DISPLAY). One `Platform` object, with sub-objects:
- `windows: WindowSystem | null` (pointer, keysDown, activeWindow, focusWindow, clientWindows, stack, capture, hasCompositor,
  windowId(BrowserWindow), isOwnWindow, activate, focusInput?, unit conversion toDip/fromDip/rectToDip, screenBounds, close).
  Keep X11 field names (`client`, `wmClass`, `overrideRedirect`, `outer`, `inner`) so matchFrame/coveringRects/tests don't churn.
- `input: Input | null` — keep the existing XInput method set and conventions (X keysym names as key vocabulary, X button
  numbers 1/2/3/4-7, X button-mask bits 256/512/1024, key codes opaque and never 0). New members optional.
- `overlay`: input-region shaping (XShape on Linux only; returns false elsewhere so the existing hover-polling path runs).
- `keyboardHold` (Linux XGrabKeyboard buffer; null elsewhere), `clipboardHandoff`/`readSelection` (Linux only; elsewhere
  "unavailable" / "").
- `sidecar: SidecarLaunch` — `{ command, args, env, firstRequestMs }` replacing the hard-wired `spawn(python, [script])`.
- `system: SystemPlatform` — apps (list/launch/isTerminalApp/hasBuiltInShell), tier-0 settings (available + change), paths
  (userData root, admin policy location, bundled voice models), admin policy loader, autostart, audit sink, gh CLI lookup,
  which(), spawn defaults (windowsHide), environment checks + fixes, doctor probes, a11y probes (screen reader, reduced
  motion), voice speaker monitor availability, never-look defaults, security-window and terminal vocabularies, shortcut table,
  primary modifier, user-facing platform words for persona/copy.
- `desk`: the Xvfb desk factory on Linux; `null` on Windows/macOS (never construct DeskManager there).
Code outside `app/main/platform/` must not test `process.platform` except through this object (tests may).
Electron-import rule stays: perception/, agent/, policy/, hands/, desk/ load under plain Node. Platform backends that need
Electron (e.g. desktopCapturer, screen) receive it injected from main.ts.

## D2. Units
- Linux: unchanged (physical pixels; DIP via primary scaleFactor).
- Windows: physical pixels everywhere (Electron is per-monitor DPI aware; the UIA bridge sets Per-Monitor-V2 awareness
  before any UIA call). DIP conversion via `screen.screenToDipRect/screenToDipPoint` (injected). `outer` = GetWindowRect
  (includes invisible resize borders, which is what UIA reports for the frame); `inner` = DWM extended frame bounds.
- macOS: points everywhere (CGEvent, CGWindowList, AX, Electron screen). DIP conversion is identity. Captures are taken in
  pixels and resampled to points so "1 image pixel = 1 screen unit" holds for masking.
- Negative coordinates are valid on Windows/macOS (monitors left/above the primary): no clip-at-0, use `onScreen?(x,y)`.

## D3. Accessibility: a shared TypeScript sidecar host + thin native providers
- Linux keeps the Python AT-SPI sidecar unchanged.
- Windows and macOS run ONE shared TypeScript sidecar host, `dist/app/ax-sidecar.cjs`, started as Ember's own binary with
  `ELECTRON_RUN_AS_NODE=1` (like desk-agent). It speaks EXACTLY the existing JSON-RPC protocol (same methods, shapes, error
  wording, AT-SPI role/state vocabulary), so `AtspiSidecar` and all TS consumers stay unchanged apart from the launch.
- The host holds all platform-neutral protocol logic: id blocks/keep/scratch, budgets and truncation, secret detection and
  withholding (reuse perception/elements.ts word lists — no third copy), label inference, verification after actions,
  result shaping and error wording, remember_secrets/mark_secret.
- Below it, a coarse `AxProvider` interface (few round trips): topWindows(), snapshot(window, budgets) → raw nodes with all
  attributes needed, element(handle), elementsAt(x, y), perform(handle, op, args), focused(), stable keys. Role/state mapping
  to the AT-SPI vocabulary happens in the provider (platform knowledge), with the mapping tables in TS where possible.
- macOS provider: koffi + ApplicationServices (AX C API) + CoreFoundation, in-process in the host. Global messaging
  timeout ~0.8 s; kAXErrorCannotComplete → BUSY.
- Windows provider: a thin C# 5 UI Automation bridge (System.Windows.Automation, .NET Framework 4.x) hosted by
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ember_uia.ps1`,
  newline JSON over stdio, started by the host (windowsHide). The .ps1 is a tiny bootstrap (Add-Type -Path ember_uia.cs,
  cached compiled DLL under userData keyed by source hash; no screen data ever passes through PowerShell cmdlets — logging).
  .ps1/.cs are ASCII-only. Each UIA operation runs with a deadline (~800 ms) on a worker thread; a timed-out pid is marked
  busy and fails fast until its thread returns. The bridge exits on stdin EOF. Sets PMv2 DPI awareness first. Strip
  PSModulePath from its env.
- The host answers the TS client within its budget: the client gets `firstRequestMs` (longer, e.g. 20 s on Windows) for the
  first request of a new process, so a cold compile is not a kill loop.
- C# must compile as C# 5 (Windows PowerShell 5.1 Add-Type). The lead has a local compile check:
  `dotnet build` of a net48/LangVersion 5 project against Microsoft.NETFramework.ReferenceAssemblies.net48 at
  /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/cscheck
  (dotnet at ../dotnet/dotnet; `dotnet build -p:SrcFile=<abs path to .cs>`).

## D4. Window system, input, capture backends
- Windows: koffi + user32/gdi32/dwmapi/kernel32 in main. Z-order via GetTopWindow/GetWindow(GW_HWNDNEXT) (no callbacks).
  Filter cloaked (DWMWA_CLOAKED), invisible, zero-size, WS_EX_TRANSPARENT/tool windows as appropriate. Input via SendInput
  (KEYEVENTF_UNICODE for text, VK table for keysym names, absolute virtual-desk coords). Takeover via GetAsyncKeyState +
  cursor position, filtering keys Ember itself holds and the generic/VK_PACKET/fake-LCtrl cases. Foreground via the
  documented order in input.md (no Alt-tap). Capture via GDI BitBlt(SRCCOPY|CAPTUREBLT) from the screen DC (sync BGRA).
  Compositor always true. Elevated target windows: refuse borrowing with a clear reason (UIPI drops input silently).
- macOS: koffi + CoreGraphics/ApplicationServices/CoreFoundation (+ objc runtime only where unavoidable, never variadic
  objc_msgSend). Windows via CGWindowListCopyWindowInfo; ids are CGWindowID; own windows via getMediaSourceId().
  Input via CGEvent (local events suppression interval 0), key codes = CGKeyCode + 8 (never 0). AX calls in main use a
  0.25 s messaging timeout. Capture via Electron desktopCapturer (injected), preflighted by screen-recording permission
  (fail closed), resampled to points. Compositor always true.
- Overlay on Windows/macOS: hover polling + setIgnoreMouseEvents (forward:false on Windows; forward:true on macOS);
  macOS overlay/handle windows use type "panel" where needed so a click never activates Ember over the user's app.

## D5. Desk
Linux only. `Platform.desk` is null elsewhere; DeskManager is never constructed; `open_on_desk` is never offered; all text that
mentions the desk is conditional.

## D6. Shortcuts (one table, per platform) and the primary modifier
- Linux: unchanged — Control+Alt+Space ask, +X stop, +E settings, +M mic, +Y allow, +N not now.
- Windows: Super+Alt+Space, Super+Alt+X, Super+Alt+E, Super+Alt+M, Super+Alt+Y, Super+Alt+N (Ctrl+Alt is AltGr on many
  layouts and would swallow €, µ, ń…).
- macOS: Control+Shift+Command+Space, +X, +E, +M, +Y, +N (Ctrl+Option is VoiceOver's modifier; Option+letter types characters;
  Ctrl+Cmd+Space is the emoji picker).
- The table lives in one module (shared by main, policy, copy, spoken hints, environment check). `freshAskPress` trusts the
  press off Linux (no chord check). The policy's "Ember's own shortcuts / system keys" block-list is derived from the table.
- Primary modifier: a canonical `mod` token → ctrl on Linux/Windows, cmd on macOS. `cmd`/`command` is its own modifier on
  macOS (not super). The worker's hard-coded ctrl+a / ctrl+v / ctrl+End / ctrl+Home / ctrl+shift+F5 use the platform primary.
  Platform-specific dangerous keys (Windows: win+*, alt+f4, ctrl+shift+esc; macOS: cmd+q, cmd+w, cmd+tab, cmd+space,
  cmd+option+esc, ctrl+cmd+q, cmd+shift+q) are classified like their Linux equivalents.

## D7. System integration
- userData: Linux unchanged; Windows `%LOCALAPPDATA%\ember`; macOS `~/Library/Application Support/ember`.
- Admin policy: Linux unchanged. Windows: JSON in the registry, `HKLM\SOFTWARE\Policies\Ember`, REG_SZ value `PolicyJson`
  (admin-only writable by construction), read via koffi advapi32; apiKeyFile is not supported on Windows (key via env var or a
  REG_SZ `ProviderApiKey` value) — design must keep fail-closed semantics. macOS: `/Library/Application Support/Ember/policy.json`
  with the same root-owned/no group-other-write checks as Linux, applied to the file and its folder.
- Autostart: Windows/macOS via app.setLoginItemSettings (Windows args ["--autostart"], quoted).
- Audit sink: journald on Linux only; none elsewhere (file audit log stays).
- Launching apps: Windows via explorer.exe with a Start Menu .lnk or shell:AppsFolder\<AUMID> (clean env, no shell);
  macOS via `/usr/bin/open -a <app path>` with appEnv(). Never ShellExecute from Ember's own environment.
- Tier-0 settings: Windows — app/system dark mode via HKCU registry (+ broadcast WM_SETTINGCHANGE); macOS — dark mode via
  `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to …'` (Apple Events
  permission; NSAppleEventsUsageDescription). Only what is verified goes in `available`; `change_setting` is dropped when
  the list is empty.
- Screen reader detection: Windows SPI_GETSCREENREADER; macOS VoiceOver via defaults/AX; not app.isAccessibilitySupportEnabled.
- Reduced motion: systemPreferences.getAnimationSettings().prefersReducedMotion on Windows/macOS.
- Speaker rejection (parec) Linux only; the setting and consent copy say so elsewhere.
- Voice model extraction must not depend on a system `tar`/`bzip2` on Windows/macOS.
- Fix windows.ts isTrustedSender for Windows paths. Handle Windows `session-end` and macOS shutdown; macOS app menu so Cmd+Q
  goes through quitEmber; Windows AppUserModelId (+ Start Menu shortcut on first run of the zip build) for toasts.
- Never-look/security/terminal vocabularies get Windows and macOS entries (one shared module keyed by OS where duplicated today).

## D8. Packaging and CI
- `scripts/package/layout.mjs` (pure, unit-tested) describes each target. stage.mjs works per target on its own OS.
- Windows: staged folder with Ember.exe (renamed electron.exe) + zip. macOS: Ember.app (Electron.app renamed; Info.plist:
  CFBundleName/DisplayName "Ember", CFBundleIdentifier, NSMicrophoneUsageDescription, NSAppleEventsUsageDescription; keep the
  inner executable and helper names unless renaming is proven safe), fuses flipped on the Electron Framework binary, then
  ad-hoc re-signed; zip + dmg. Linux RPM/AppImage unchanged. Signing/notarization with real certificates is out of scope.
- CI: new `windows` (windows-2022) and `macos` (macos-15) jobs: npm ci, unit tests, build, C# compile check with Windows
  PowerShell 5.1 Add-Type, smoke launch, platform integration tests for the sidecar host + provider against a fixture window
  (gated by EMBER_UIA_TEST / EMBER_AX_TEST), stage + package + packaged-app checks, artifacts. Lint/typecheck stay in Linux.
  Keep macOS minutes lean (private repo: 10x billing). `.gitattributes` with eol=lf.
- Eval stays Linux-only.

## D9. Docs
PLAN.md: §1 (no longer "not in v1"), §2 new rows for the platform decisions, a new milestone M11 (Windows and macOS) in §4
with task IDs, §9 updated, §10 progress row. README and docs/DEVELOPING.md get Windows and macOS sections.

## D10. macOS TCC in CI (researched by the lead)
GitHub-hosted macOS runners allow sudo writes to the SYSTEM TCC database (SIP only covers /System). Proven pattern
(xa11y/setup-a11y action.yml):
  sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access(service,client,client_type,auth_value,auth_reason,auth_version,csreq,policy_id,indirect_object_identifier_type,indirect_object_identifier,indirect_object_code_identity,flags,last_modified) VALUES('kTCCServiceAccessibility','<abs path of binary>',1,2,4,1,NULL,NULL,0,'UNUSED',NULL,0,$(date +%s));"
  sudo launchctl stop com.apple.tccd; sleep 2
Use the same for kTCCServiceScreenCapture. Because the TCC "responsible process" of a CI job is not certain, grant every
candidate: the Electron binary (node_modules/electron/dist/Electron.app/Contents/MacOS/Electron), the packaged
Ember.app/Contents/MacOS/<exe>, `$(command -v node)`, /bin/bash, /bin/zsh, and the runner's own binaries if found
(ps -o comm= of ancestors). The integration tests must print AXIsProcessTrusted() and fail loudly (not skip) when
EMBER_AX_TEST=1 is set and trust is missing, so we learn which client was needed.

## D11. Already under construction in parallel (the design must adopt these, not redefine them)
To speed things up, six packages started before the design was final, each in its own worktree:
- Interim contract committed on the branch: `app/main/platform/types.ts` — `WindowSystem` (= X11's members with an
  async-capable `capture`, plus kind, compositorMayChange, windowId(OwnWindowHandle), toDip, toDipPoint, screenBounds),
  `Input` (= XInput + optional textKey, onScreen, blockedReason), `ScreenLike`, `OwnWindowHandle`; conventions for units,
  window ids, app names (Windows: program file name without ".exe", UWP frames → hosted app; macOS: localized app name),
  X keysym vocabulary and X button numbers/masks. The design's types.ts must EXTEND this file (keep these names), adding
  Platform, SystemPlatform, SidecarLaunch, OverlayShaper, etc.
- port/win32: app/main/platform/win32/** — `openWin32Windows({screen})`, `openWin32Input()`; test/fixtures/win_bench.ps1
  (WinForms bench "Ember Bench (Windows)" with a JSON-lines log); test/integration/win32-desktop.test.ts (EMBER_WIN32_TEST).
- port/darwin: app/main/platform/darwin/** — cf.ts, ax.ts, cg.ts (reusable by the macOS AX provider), `openDarwinWindows({screen,
  capture?, screenAccess?})`, `openDarwinInput()`; test/integration/darwin-desktop.test.ts (EMBER_DARWIN_TEST).
- port/uia: sidecar/uia/ember_uia.ps1 + ember_uia.cs + PROTOCOL.md — the thin C# UIA bridge (raw UIA facts: topWindows,
  snapshot, element, elementsAt, focused, children, perform, textInfo, release, status; deadlines + busy per pid; handles;
  RuntimeId stable keys; ready line; DLL cache via EMBER_UIA_CACHE). The TS sidecar host maps raw ControlTypes to AT-SPI roles.
- port/packaging: scripts/package/layout.mjs, per-target stage.mjs, macOS bundle + fuses + ad-hoc sign, Windows zip,
  portable smoke test, scripts/run-integration.mjs, .gitattributes, CI jobs `windows` and `macos`.
- port/voice: in-process .tar.bz2 extraction (no system tar/bzip2/curl) in app/voice/.
- port/testport: unit tests made portable (gates/fixes in test files only) + a report of app-code portability bugs.
Still to design and build after the design lands: Phase 1 (platform layer wiring in main.ts etc.), the TS sidecar host +
AxProvider + the Windows provider client for the bridge + the macOS AX provider, SystemPlatform for Windows/macOS,
vocabularies, persona/copy words, shortcuts, admin policy, autostart, docs.
- port/host (started after the list above): app/sidecar-host/** — the shared TS sidecar host speaking Ember's JSON-RPC
  protocol, with an AxProvider interface (topWindows, snapshot, element, elementsAt, focused, children, perform, textInfo,
  release), roles.ts (UIA + AX → AT-SPI vocabulary), providers/uia.ts (client for the C# bridge), providers/fake.ts;
  esbuild entry dist/app/ax-sidecar.cjs in scripts/build-app.mjs; AtspiSidecar gains an optional `launch`
  {command, args, env, firstRequestMs, windowsHide} (Linux default unchanged). The macOS AX provider is a later package.
