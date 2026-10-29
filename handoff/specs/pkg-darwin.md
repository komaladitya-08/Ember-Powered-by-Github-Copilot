# Package darwin: the macOS window system, input and capture backend

Worktree: /home/user/wt/darwin (branch port/darwin). Integration env var: EMBER_DARWIN_TEST.
Specs to read: window-system.md, input.md, gaps.md (macOS items), decisions.md D1, D2, D4, D6, D10.

## You own (and touch nothing else)
- app/main/platform/darwin/** (suggested: cf.ts — CoreFoundation helpers: CFString to/from JS, CFNumber, CFBoolean,
  CFArray, CFDictionary lookup with CFString keys, CFRelease discipline; written to be reused later by the macOS
  accessibility provider in a node-mode child process, so Electron-free and side-effect-free at import; ax.ts — the AX C API
  bindings (AXUIElementCreateApplication, AXUIElementCreateSystemWide, AXUIElementCopyAttributeValue,
  AXUIElementCopyAttributeNames, AXUIElementSetAttributeValue, AXUIElementPerformAction, AXUIElementGetPid,
  AXUIElementSetMessagingTimeout, AXUIElementCopyElementAtPosition, AXValueGetValue, AXIsProcessTrusted(WithOptions),
  and the private-but-stable _AXUIElementGetWindow with a fallback), also reused later; cg.ts — CoreGraphics bindings;
  windows.ts; input.ts; capture.ts; keys.ts — keysym name/number → CGKeyCode tables; index.ts exporting the factories)
- test/unit/platform-darwin-*.test.ts
- test/integration/darwin-desktop.test.ts

## Build
1. `openDarwinWindows(deps: { screen: ScreenLike; capture?: (rect: Rect) => Promise<X11Image | null>; screenAccess?: () => boolean }): WindowSystem | null`
   implementing `WindowSystem` (app/main/platform/types.ts): kind "darwin", compositorMayChange false, hasCompositor() true;
   all units are points. pointer(): CGEventCreate(NULL) + CGEventGetLocation (struct CGPoint by value) and
   CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, button) → X mask bits; keysDown() via
   CGEventSourceFlagsState/KeyState (control, alt=option, space keycode 49); windows from CGWindowListCopyWindowInfo
   (kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements): kCGWindowNumber, kCGWindowOwnerPID,
   kCGWindowOwnerName (= wmClass, the app's localized name), kCGWindowName (empty without Screen Recording permission),
   kCGWindowBounds (CGRectMakeWithDictionaryRepresentation), kCGWindowLayer (0 = normal app windows; others are menus,
   the Dock, status items → overrideRedirect for popups/menus of apps, excluded from clientWindows), kCGWindowAlpha;
   the list is front-to-back: stack() must return bottom-to-top. `outer` = `inner` = the window bounds (AX frames are the
   same rectangle). activeWindow(): the frontmost app's frontmost layer-0 window (frontmost app pid via the AX system-wide
   AXFocusedApplication with a 0.25 s messaging timeout, else the first layer-0 window in the list); focusWindow(): if Ember
   itself (process.pid) is frontmost, return null-safe info for Ember's focused window without calling AX on other apps;
   otherwise the app's AXFocusedWindow mapped to its CGWindowID (_AXUIElementGetWindow, or match by pid + frame);
   titles: prefer kCGWindowName, fall back to the AX title for the focused/active window. capture(x, y, w, h): uses
   deps.capture (main will inject an Electron desktopCapturer-based function) and fails closed (null) when deps.screenAccess
   reports no Screen Recording permission or no capture function was given; the image it returns must be in points
   (resampled from pixels by the injected function — document that contract); windowId(win) parses
   win.getMediaSourceId() "window:<CGWindowID>:0" (0 if it can't); toDip/toDipPoint identity; screenBounds() union of
   deps.screen displays' bounds.
2. `openDarwinInput(): Input | null` implementing `Input`: CGEventSourceCreate(kCGEventSourceStateHIDSystemState) once,
   CGEventSourceSetLocalEventsSuppressionInterval(src, 0) and permit local events during suppression, so the user's own
   mouse/keyboard can always take over; move: kCGEventMouseMoved, or LeftMouseDragged while the left button is held
   (track held buttons); buttons 1/2/3 → left/other(2)/right down/up with click state; 4–7 wheel via
   CGEventCreateScrollWheelEvent2 (fixed arity: source, units, wheelCount, wheel1, wheel2, wheel3 — not variadic) in line
   units; keysymOf/keysym/keycodeOf/keycode with codes = CGKeyCode + 8 (never 0; A is CGKeyCode 0); modifiers via
   flags on the events Ember posts (track held modifiers: kCGEventFlagMaskShift/Control/Alternate/Command); keysDown()
   via CGEventSourceKeyState over the key range for the combined session state, minus nothing Ember doesn't hold (it is
   compared against what Ember holds by the caller); needsShift(sym) for ASCII via a US-layout table is acceptable (typing
   goes through textKey); textKey(ch, down) via CGEventKeyboardSetUnicodeString on a keycode-0 event; activeWindow()/
   focusedWindow() as CGWindowIDs; screenSize() main display points; onScreen(x, y) (CGGetDisplaysWithPoint count > 0);
   findWindow(title, pid?, wmClass?) with the XInput semantics, using AX window titles (CG titles may be empty);
   activate(windowId): the window's app frontmost (AXUIElementSetAttributeValue(app, "AXFrontmost", kCFBooleanTrue)) and
   AXRaise on its AX window; read kCFBooleanTrue/False with lib.symbol / decode, or create via CFPreferences-free means
   (document which); releaseAll() releases everything Ember holds (also on process "exit"); blockedReason(window):
   AXIsProcessTrusted() false → "Ember needs the Accessibility permission (System Settings › Privacy & Security ›
   Accessibility) to use the mouse and keyboard."; secure input on (IsSecureEventInputEnabled via Carbon, if bindable)
   → a clear reason; screenLocked?() if feasible (CGSessionCopyCurrentDictionary "CGSSessionScreenIsLocked").
   All AX calls in this backend use a 0.25 s messaging timeout (they run on Electron's main thread later).
3. All pure logic separated and unit-tested on Linux with fakes: CGKeyCode tables, keysym mapping, +8 code offset,
   button/mask mapping, CGWindowList entry → StackedWindow conversion and ordering, media-source-id parsing, layer rules,
   CF value conversion logic where it can be faked.
4. test/integration/darwin-desktop.test.ts (skip unless process.platform === "darwin"; fail when EMBER_DARWIN_TEST=1 and
   AXIsProcessTrusted() is false — print which binary needs the grant): open TextEdit with a new empty document
   (`open -a TextEdit` / `osascript -e 'tell application "TextEdit" to make new document'` only if Automation is granted —
   prefer `open -n -a TextEdit --args -ApplePersistenceIgnoreState YES` plus a fresh file in a temp dir:
   `open -a TextEdit <tmp>/ember.txt`), wait for its window in stack() (by owner name "TextEdit" and pid), activate it,
   check activeWindow() is it, type "Ember 1é" with textKey, save with Cmd+S via keysym, read the file back; pointer()
   matches a move(); keysDown() empty at rest; releaseAll() leaves nothing down. Quit TextEdit in afterAll (kill the pid).

Do not wire anything into app/main/main.ts — integration into the app is a later phase.
