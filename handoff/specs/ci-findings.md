# Real-runner CI findings (fix these in the FX packages; evidence from GitHub Actions)

## Run 113 (windows-2022, head 6a628b5: win32 + uia merged)
- test/integration/win32-desktop.test.ts: 10/10 PASS (foreground switching, capture, click, unicode typing, keysDown, onScreen).
- The C# bridge compiles with real Windows PowerShell 5.1.20348 Add-Type (step passed in ~5 s).
- test/integration/uia-bridge.test.ts: 14/15 pass. FAIL "exits with code 0 within 2 s when stdin closes": 2305 ms.

## Run 114 (head f40ad72: + darwin, voice, host merged, and the bridge backstop shortened from 1500 to 300 ms)
### Windows (FX-PU, FX-PH)
- uia-bridge "exits with code 0 within 2 s when stdin closes": STILL 2304 ms (code 0). So the ~2.3 s is not the
  Environment.Exit backstop. Find where it really goes (the test client's close() logic; EOF reaching the reader thread
  under `powershell.exe -File` with redirected stdin; PowerShell's own console host also reading stdin; the bootstrap's
  `exit` after Run() returns; Node's pipe close on Windows). Fix the cause, not the threshold, unless the cause is
  outside our control — then explain and set a justified bound.
- uia-bridge "lists the bench among the top-level windows, with its process and program name": FAILED this time
  (passed in run 113): the bench's topWindows entry matched name and pid but NOT `controlType: "Window"` (missing or
  different). Likely a property read omitted under the deadline/two-level fetch, or a race with the bench still
  creating its window. Make it deterministic.
- test/integration/ax-sidecar.test.ts (the TS host end to end through AtspiSidecar, first real run):
  - expected role "combo box" for Theme but got "label" (ax-sidecar.test.ts:147);
  - select_option → "background_unavailable: this element has no selectable options";
  - set_value out of range expected /is outside/ but got "background_unavailable: this element has no value to set"
    (ax-sidecar.test.ts:196);
  - timed out after 10000 ms waiting for the bench's select (ax-sidecar.test.ts:208).
  Pattern: the test (or the host) picks the WinForms Label named "Theme"/"Volume" instead of the ComboBox/TrackBar whose
  AccessibleName is the same. Check the bench's control names, how the host names nodes (labelledBy, label inference)
  and how the test finds them; make the host/test pick the actual control (role-aware lookup), and confirm the host maps
  WinForms ComboBox/TrackBar ControlTypes to "combo box"/"slider".
### macOS (FX-PD)
- darwin-desktop.test.ts: AXIsProcessTrusted() = true and Screen Recording = true under the CI grants (responsible
  chain: node ← bash ← Runner.Worker ← Runner.Listener ← hosted-compute-agent). 4 tests pass (window list/pointer/keys
  without permission in 0.27 ms; displays in points; no capture without a function; keyboard layout read).
- FAIL: "timed out waiting for TextEdit's window in the stack" (darwin-desktop.test.ts:154): the TextEdit-dependent
  describe (6 tests) never started. Investigate: how TextEdit is opened (`open -a TextEdit <file>` on a fresh runner may
  show an open panel / iCloud prompt / restore state, or open hidden), whether CGWindowList filtering (layer, owner,
  on-screen-only, alpha, system-process skip) drops its window, and the timeout. Make the test robust (e.g. open a fresh
  .txt with `open -F -a TextEdit`, wait for the app's pid, log the raw CGWindowList entries for that pid on failure).
- ax-sidecar.test.ts skipped on macOS as intended (no AX provider yet).

## Run 115 (head 6cc9c55: + Phase-1 B/D/E, FX-PW, FX-PK, FX-PD)
- windows unit: platform-linux-system.test.ts:75 compared a POSIX literal with path.join → fixed by the lead (d?).
- macOS darwin-desktop: still no TextEdit. `open -n -F -a TextEdit <tmp>/ember.txt --args …` → exit 0, but NO TextEdit
  process exists afterwards (every TextEdit pid: []), CoreGraphics has no window for the pid, and the frontmost window on
  screen is a UserNotificationCenter alert (pid 4775, 260x300 at 382,105) — very likely the system prompt raised by the
  preceding Input Monitoring test (CGRequestListenEventAccess / "would like to receive keystrokes") or another TCC/system
  alert. Hypotheses to check on the runner: (1) the alert steals focus / blocks LaunchServices from launching TextEdit;
  (2) `open -n` with --args ApplePersistence… exits 0 but TextEdit dies at launch (check `log show --predicate
  'process == "TextEdit"' --last 2m`, crash reports in ~/Library/Logs/DiagnosticReports); (3) the runner's TextEdit is
  sandboxed and the temp path under /var/folders is refused. Mitigations: don't call CGRequestListenEventAccess in CI
  (only preflight), dismiss/avoid UserNotificationCenter alerts, or use an Electron-based bench window instead of TextEdit
  (the AX package is writing test/fixtures/mac_bench.js).
