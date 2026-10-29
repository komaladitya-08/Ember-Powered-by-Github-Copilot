# Package win32: the Windows window system, input and capture backend

Worktree: /home/user/wt/win32 (branch port/win32). Integration env var: EMBER_WIN32_TEST.
Specs to read: window-system.md, input.md, gaps.md (Windows items), decisions.md D1, D2, D4, D6.

## You own (and touch nothing else)
- app/main/platform/win32/** (suggested: ffi.ts — all koffi bindings for user32/gdi32/dwmapi/kernel32/shcore; windows.ts;
  input.ts; capture.ts; keys.ts — keysym name/number → virtual-key tables; names.ts — program-name and UWP resolution;
  index.ts exporting the factories)
- test/unit/platform-win32-*.test.ts
- test/integration/win32-desktop.test.ts
- test/fixtures/win_bench.ps1 (the shared Windows test window, spec below; the UIA package's tests will use it too)

## Build
1. `openWin32Windows(deps: { screen: ScreenLike }): WindowSystem | null` implementing `WindowSystem` from
   app/main/platform/types.ts: kind "win32", compositorMayChange false, hasCompositor() true; pointer() (GetCursorPos +
   button mask from GetAsyncKeyState mapped to X bits 256/512/1024 for LOGICAL left/middle/right — mind swapped mouse
   buttons, GetSystemMetrics(SM_SWAPBUTTON)); keysDown() {control, alt, space}; activeWindow() (GetForegroundWindow);
   focusWindow() (GetGUIThreadInfo of the foreground thread → hwndFocus mapped to its top-level root, GA_ROOT; fall back to
   the foreground window); clientWindows() (app top-level windows: visible, not cloaked (DWMWA_CLOAKED), not tool windows
   without WS_EX_APPWINDOW, has a title, not owned-by-another-visible-window popups… document the rules); stack() bottom
   to top (walk GetTopWindow(NULL)/GetWindow(GW_HWNDNEXT) — no callbacks — then reverse), with `id` = `client` = HWND,
   `x/y/width/height` = DWM extended frame bounds (DWMWA_EXTENDED_FRAME_BOUNDS, what is visibly covered), `outer` =
   GetWindowRect (includes invisible resize borders, what UIA reports), `inner` = client area in screen coords,
   overrideRedirect = popup/menu windows (WS_POPUP without a caption, or class "#32768"); capture() = GDI BitBlt
   (SRCCOPY|CAPTUREBLT) from the screen DC of the virtual desktop into a 32-bit top-down DIB section → BGRA Buffer, copied
   with koffi.decode (sync; negative origins valid; clip to the virtual screen SM_XVIRTUALSCREEN…; null when nothing is on
   screen or BitBlt fails, e.g. on the secure desktop); windowId(win) = HWND from getNativeWindowHandle() (8 bytes on x64:
   readBigUInt64LE → Number); toDip/toDipPoint via deps.screen.screenToDipRect/screenToDipPoint (physical → DIP);
   screenBounds() = virtual screen in physical pixels; close().
   pid via GetWindowThreadProcessId; title via GetWindowTextW (safe for other processes' windows: no WM_GETTEXT is sent);
   wmClass = program name per the types.ts rule (QueryFullProcessImageNameW with OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION),
   basename without ".exe"; for ApplicationFrameHost frames, the hosted app's program: the child "Windows.UI.Core.CoreWindow"
   of a different process); wmClassName = the Win32 window class name.
2. `openWin32Input(): Input | null` implementing `Input` (the XInput method set + textKey/onScreen/blockedReason):
   SendInput with the x64 INPUT layout (sizeof must be 40: assert with koffi.sizeof at load and fail closed); mouse moves in
   absolute virtual-desktop coordinates (MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK, normalised to 0..65535 over the virtual
   screen); buttons 1/2/3 (logical, respect swap), 4/5 vertical wheel (±WHEEL_DELTA), 6/7 horizontal (MOUSEEVENTF_HWHEEL);
   keysymOf(name) returns X keysym numbers for the names Ember uses (see KEY_NAMES in app/main/hands/borrow.ts and
   keysymOf callers); keysym(sym, down) → VK (with KEYEVENTF_EXTENDEDKEY for the extended keys) — false when no key;
   keycodeOf(sym) → opaque code (VK, never 0); keycode(code, down); keysDown() → codes held (GetAsyncKeyState over the VK
   range) EXCLUDING the generic VK_SHIFT/VK_CONTROL/VK_MENU duplicates, VK_PACKET, and the fake left Ctrl Windows adds for
   AltGr when Ember itself pressed right Alt (track what Ember holds); needsShift(sym) via VkKeyScanExW on the foreground
   thread's layout; textKey(ch, down) via KEYEVENTF_UNICODE (surrogate pairs as two events); activeWindow()/focusedWindow()
   (numbers, same space); screenSize() (virtual screen size); onScreen(x, y) (MonitorFromPoint with MONITOR_DEFAULTTONULL);
   findWindow(title, pid?, wmClass?) with the XInput semantics (exact title wins, 0 on ambiguity); activate(hwnd) with the
   documented order from input.md (restore if minimised; if Ember is foreground SetForegroundWindow works; otherwise
   send an empty SendInput, then AttachThreadInput to the foreground thread, BringWindowToTop/SetForegroundWindow, detach;
   no Alt-tap); focusInput(hwnd) for Ember's own windows; sync() no-op; releaseAll() releases every key/button Ember holds
   (also registered on process "exit"); close(); blockedReason(hwnd): the window's process is elevated (or higher integrity)
   while Ember isn't → "That window belongs to a program running as administrator, so Ember can't use the mouse or keyboard
   there." (OpenProcessToken/GetTokenInformation TokenElevation / integrity level; if the check can't run, treat as blocked);
   keyboardGrabbed?(), pointerOn?(window, elementWindow?) (WindowFromPoint at the pointer → GA_ROOT equals window or a popup
   owned by it), screenLocked?() (OpenInputDesktop fails / desktop name isn't "Default"), watchUser?/userInput?: omit (polling).
3. All pure logic separated and unit-tested on Linux: VK tables and keysym mapping, INPUT encoding (offsets), absolute
   coordinate normalisation (incl. negative virtual-screen origins and multi-monitor), z-order filtering decisions from
   window style bits, keysDown filtering, program-name parsing, ApplicationFrameHost resolution decision, toDip fallbacks.
4. test/fixtures/win_bench.ps1: a WinForms window (Windows PowerShell 5.1, ASCII-only file) titled "Ember Bench (Windows)":
   Label "Name" + TextBox (AccessibleName "Name"); Label "Password" + TextBox with UseSystemPasswordChar (AccessibleName
   "Password"); CheckBox "Remember me"; ComboBox "Theme" (DropDownList: Light, Dark, System); TrackBar "Volume" (0-100);
   ListBox "Fruit" (Apple, Banana, Cherry); Button "Save"; Button "Open dialog" that shows a modal MessageBox "Saved?"
   (OK/Cancel). It takes `-Log <path>` and appends JSON lines for every event: {"event":"click","control":"Save"},
   {"event":"text","control":"Name","length":N} (never the password text), {"event":"toggle","control":"Remember me","checked":true},
   {"event":"select","control":"Theme","value":"Dark"}, {"event":"value","control":"Volume","value":N}, {"event":"focus","control":…},
   {"event":"ready","hwnd":N,"pid":N} once shown. It exits when its window closes or when `-Seconds <n>` elapse.
5. test/integration/win32-desktop.test.ts (skip unless process.platform === "win32"; fail if EMBER_WIN32_TEST=1 and anything
   is missing): start the bench (powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/fixtures/win_bench.ps1 -Log …),
   wait for "ready"; stack()/clientWindows() list it with its pid, program name "powershell" and title; activate() makes it
   the activeWindow(); capture() of its rect returns BGRA of width*height*4 that is not uniform; Input: move to the Save
   button's centre (find it by screen geometry from the fixture's ready line if needed, or log its rect in the ready line),
   click, see {"event":"click","control":"Save"} in the log; focus the Name box and type "Ember 1é" with textKey, see the length
   event; keysDown() is empty when idle; releaseAll() leaves nothing down; onScreen() true at the bench centre.
   Clean up the bench process in afterAll.

Do not wire anything into app/main/main.ts — integration into the app is a later phase.
