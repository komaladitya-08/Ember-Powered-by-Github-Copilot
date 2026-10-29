# Follow-ups collected from package reports (for Phase 1/3 integration)

## From port/packaging + port/testport
- runtime.ts hard-codes linux-x64 runtime (A1) → per-platform path; then remove agent-misc gate (TODO(port)).
- windows.ts isTrustedSender (A5) Windows paths.
- admin.ts (A6) per-OS policy location; Windows registry.
- POSIX modes no-op on Windows (A7): document; rely on profile ACLs.
- launch-app.test.ts (gtk-launch), overlay-shape.test.ts (libX11) — gate or extend when platform layer lands.
- ask-window.test.ts uses 4-byte X11 id; HWND is 8 bytes.
- environment.test.ts needs Windows/macOS cases.
- packaging.test.ts L158/L175 gating; fuses.test.ts L79 timeout under load.
- macOS executable is Contents/MacOS/Ember (renamed); sidecar launch and autostart must use process.execPath.
- Docs: macOS executable rename; Ember.exe icon/version resource TODO; LSUIElement decision.
- CI: drop --allow-missing / --allow-missing-sidecar once ax-sidecar.cjs and uia files exist.
- Compare first real Windows/macOS skip lists with testport's expected 28 skips.

## From port/win32
- WindowSystem lacks activate/focusInput → add to types.ts (win32 added Win32WindowSystem extension with activate + sync capture).
- borrow.ts: use onScreen instead of screenSize bounds; textKey for typing; check blockedReason before activating.
- main.ts: inject Electron screen; log win32Error; input.close() at will-quit.
- policy: CredentialUIBroker, LogonUI in SECURITY_APP.
- Packaging: koffi win32 native package unpacked from asar (check asarUnpack/stage).
- inner/outer: win32 used x/y/w/h = DWM frame, inner = client area (not D2). Decide; matchFrame tries DWM frame.
- Never spawn win_bench.ps1 with windowsHide.

## From port/uia
- CI compile check: assembly names may not resolve (WPF assemblies in subfolder); run ember_uia.ps1 itself with stdin
  closed (compiles, prints ready, exits 0) or pass full paths. System.Web.Extensions not used.
- Ship ember_uia.ps1 + ember_uia.cs under resources/sidecar/uia; run uia-bridge.test.ts in windows job.
- Host: code against sidecar/uia/PROTOCOL.md ({windows} from topWindows; arrays from elementsAt/children; fatal line;
  first-start timeout >= 20 s; EMBER_UIA_CACHE=%LOCALAPPDATA%\ember\uia); bounds may be null.
- Timed-out perform marks busy only if app stops answering messages (accepted deviation).
- AllSigned execution policy blocks the unsigned bootstrap (document; signing later).
- home/styles.css:229 hard-codes 'Press Ctrl+Alt+Space' in the empty conversation (P1-E review): make it OS-aware (unowned file; lead/I).
- MS capture must always settle (null on timeout/reject) — Perception keeps Ember hidden until it does (P1-B).
- test/unit/sidecar-host-uia.test.ts 'lets a slow first start go on in the background…' fails under heavy load (load avg 8.5/4 CPUs), passes alone 3/3: make it timing-robust (fake timers or wider margins).
- (P1-D) Off Linux nothing counts as a terminal and never-look defaults are empty until V fills rows: V must merge before platforms are switched on.
- (P1-D) App ids split only on . ! _ off Linux; V/WS decide spaces and "/" for Start Menu ids.
- (P1-D) APP_NAMES["constructor"] prototype lookup bug (pre-existing; fixing changes Linux) — consider Object.hasOwn in a separate fix.
- (FX-PW) Attach-path foreground risk (R6): CI logs whether the window came to front within 1 s with a busy app in front.
- (MS review) P1-D idIsTerminal treats any id part 'console' as terminal on every OS → com.apple.Console (log viewer) refused: V/P1-D to scope it.
## From V (for package I)
- Run dialog window rule: program explorer, class #32770, localized titles (Run/Ausführen/Exécuter/Ejecutar/Esegui/Executar/Uitvoeren/ファイル名を指定して実行/运行/執行/실행) → refuse any action but reading.
- Explorer runs .exe/.bat/.cmd/.vbs/.js/.hta/.msi/.lnk on double-click/Enter/Open with no dialog: add a policy rule.
- hands/system.ts idIsTerminal: read TERMINAL_ID_WORDS[os] (Console.app refused today); runsTerminal: test shell:AppsFolder\<id> after explorer.exe as an app id.
- win32/system/apps.ts:288 findApp(apps, query) without "win32".
- darwin/model.ts: SECURITY_OWNERS from SECURITY_APP.darwin (blocks screenshots while Keychain Access/Passwords open).
- main.ts: on macOS pass the bundle id to the policy's terminal check.
- policy RUN_ANSWER lacks "Open" (Gatekeeper).
- CI: add win32-vocabulary / darwin-vocabulary (and win32-system / darwin-system) integration suites to the Windows/macOS jobs.
## From the remote-surface fix (dcbbb6b, merged)
- app/main/policy/remote-surface.ts: msrdc/mstsc/msrdcw/Windows365/RdClient.Windows refused for every action and masked
  in captures (Windows only). Verify on a real install: the Windows App's process names; WSL's msrdc image folder
  (isWslgImage, not called yet). Not covered: Hyper-V vmconnect, VNC/TeamViewer/Citrix viewers (consider adding).
- DEVELOPING.md: one sentence on this behaviour (DOC package).
## After I-win (cef857d) and I-mac (cc833e3), merged as 74a5cdc / fc2bffb
- CI re-runs owed when the Actions budget allows: {"only":"windows"} (cef857d: the ember-doctor.cmd broken-policy check,
  the AppsFolder terminal fix) and {"only":"macos"} (cc833e3: only the window titled "Dock" is cut). Then one full run.
- Windows: CAPTUREBLT decision needs a Windows 11 measurement. Manual §12.3 items 1-14, 18.
- macOS: Q10 Input Monitoring evidence came from a runner with SIP off; keep the refusal until the manual check. Dock
  windows (Launchpad, stacks, multiple displays) on a real Mac. Electron "nonactivating panel" warning (M1/M2 pass).
- FU package (running): macOS bundle-id terminal check, RUN_ANSWER "Open", idIsTerminal per OS, Explorer runs programs,
  Run-dialog narrowing, findApp win32, APP_NAMES prototype.
## After FU (merged d6982eb) — open
- Explorer hides extensions (always for shortcuts): needs UIA ItemType or the selection passed through host + worker.
- Explorer item check boxes build a multi-selection; Enter on a document then runs a selected program (borrow steps are
  asked first, but the user's yes defeats the "never").
- .msi context menu: "Install" is asked, "Repair" not caught. Open/Save dialogs' right-click menus not covered (explorer
  rule only). Gatekeeper "Open" rule keys on English prompt text only (CoreServicesUIAgent is refused anyway).
- macOS terminal by bundle id: a renamed terminal outside the standard app folders is judged by name only.
