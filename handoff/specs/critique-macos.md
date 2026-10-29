# Critique: macOS feasibility of design.md and pkg-darwin / pkg-host / pkg-packaging

Lens: will the macOS parts actually work on macOS 13-15 (arm64 + x64) and on GitHub's macos-15 runner?
Each item: problem, evidence, severity (blocker / major / minor), concrete fix, where it belongs.
Evidence cites design.md (§), the repo at the branch tip, and the in-flight worktrees under /home/user/wt
(port/darwin at 9e51bc1 + uncommitted edits, port/host at f46b153, port/packaging at 740c547). Electron facts were
checked against Electron's source (shell/browser/native_window_mac.mm, browser_mac.mm, ui/cocoa/electron_ns_panel.mm)
and node_modules/electron/electron.d.ts (Electron 44.5.0); runner facts against actions/runner-images
(images/macos/scripts/build/configure-tccdb-macos.sh).

## Findings (most severe first)

### 1. `setVisibleOnAllWorkspaces` on macOS hides and re-shows the Dock icon and steals focus (blocker)
- Problem: on macOS, `BrowserWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` is not a
  "brief flicker": Electron calls `Browser::DockHide()` = `TransformProcessType(kProcessTransformToUIElementApplication)`
  and leaves the process a UI element (no Dock icon, **no menu bar, so §4.1 item 26's app menu and its Command+Q never
  show**). Without `visibleOnFullScreen` (the handle's `"plain"` call) it calls `DockShow()`, which, when Ember is
  active, activates the Dock, waits ~1 s, transforms back and then
  `activateWithOptions:NSApplicationActivateIgnoringOtherApps` (it **steals focus from the user's app**); a DockHide
  within 1 s of a DockShow is silently ignored. Ember calls both: overlay.ts:283 (`{ visibleOnFullScreen: true }`, per
  display, again on every display-added/revive), handle.ts:56 (plain), and §8.3 adds the ask box
  (`{ visibleOnFullScreen: true }`). The final Dock/menu state depends on creation order and timing.
- Evidence: Electron `NativeWindowMac::SetVisibleOnAllWorkspaces` (`if (!skipTransformProcessType) { if
  (visibleOnFullScreen) DockHide(); else DockShow(); }`), `Browser::DockShow` in browser_mac.mm; design §8.3 table
  (darwin `allWorkspaces` = `{ visibleOnFullScreen: true }` for overlay and ask, handle "as the overlay" while
  §2.1/§4.4 default the handle to `"plain"`); R11 treats it as a cosmetic flicker and keeps `skipTransformProcessType`
  only as a fallback.
- Not needed at all: Electron's `type: "panel"` window (ElectronNSPanel) already ORs
  `NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary` into every
  `setCollectionBehavior` and adds `NSWindowStyleMaskNonactivatingPanel` (electron_ns_panel.mm); the docs say a panel
  "floats on top of full-screened apps" and "appears on all spaces".
- Fix: `hoverShaper("darwin").floating(kind).allWorkspaces = null` for overlay, handle **and** ask (all three are
  `type: "panel"`), so no `setVisibleOnAllWorkspaces` call is made on macOS at all. If P1-A keeps a call for any reason
  it must be `{ visibleOnFullScreen: true, skipTransformProcessType: true }`, never `"plain"`. Add to P1-A's
  `platform-compose` test: no darwin `FloatingWindow` has `allWorkspaces` without `skipTransformProcessType: true`.
  Rewrite R11 (the risk is gone, not a fallback) and add to §12.3: overlay and handle visible over a full-screen Safari
  Space and on a second Space; Ember keeps its Dock icon and app menu; the user's app stays frontmost after start.
- Where: design §8.3 table + R11 + §12.3 (P1-A writes `hoverShaper`).

### 2. The ask box's `takeFocus` activates Ember on macOS, defeating the non-activating panel (major)
- Problem: §8.3 says the ask box "becomes key without activating Ember, so the user's app stays active and `blur`
  still hides it", but §4.1 item 18 makes `takeFocus` call `sys.lifecycle.focusOwnApp()`, which §9.12 defines on darwin
  as `app.focus({ steal: true })` = `activateIgnoringOtherApps`. Every ask then deactivates the user's app (menu bar
  switches to Ember); when the box hides on blur nothing re-activates the user's app, so the next keystrokes go nowhere
  and `captureContext`'s "where the user was" is now Ember. Electron itself already avoids activation for panels:
  `Show()` and `Focus()` skip `activateIgnoringOtherApps` when `IsPanel()` ("Panels receive key focus when shown but
  should not activate the app", native_window_mac.mm), so ask.ts:121-122's `win.show(); win.focus();` is enough.
- Fix: split the lifecycle hook: `focusOwnApp()` stays for `bringToFront` (settings, item 9) and before dialogs
  (item 15); `AskWindow.takeFocus` on darwin only records `askXid` (no `focusOwnApp`, no `activate`). Express it as a
  §9.12 row `activateForAsk: false` (darwin) / `true` (linux, win32 keep today's calls). Add an automated check to I's
  `ember-darwin.test.ts`: open the ask box over TextEdit, type into it, and assert the system-wide
  `AXFocusedApplication` pid is still TextEdit's while the box has the keys, and that `blur` hides it. (Electron's
  panel is an NSWindow subclass with a faked style mask, not an NSPanel: key input without activation is the property to
  prove, not assume.)
- Where: design §4.1 item 18, §9.12 table, §11.5 (I's test).

### 3. Keyboard takeover detection may silently need Input Monitoring, and nothing checks it (major)
- Problem: the user's "brake" during a borrow is CursorBorrow's `check()` (borrow.ts:238-247): any key down that
  Ember doesn't hold stops Ember. On macOS `keysDown()` polls `CGEventSourceKeyState(combinedSession, 0..127)`
  (port/darwin input.ts:270-276, desktop.ts:134-136). Since 10.15 macOS gates keyboard *observation* behind Input
  Monitoring (`kTCCServiceListenEvent`, `CGPreflightListenEventAccess`), which is a separate grant from Accessibility.
  Whether per-key state polling is gated is not documented by Apple; if it is, `keysDown()` returns `[]` without the
  grant and Ember keeps typing while the user types (fail open on a safety rule). main.ts:1264 `activationKey` has the
  same dependency. Nothing in the design can reveal it: §9.8 has no Input Monitoring row, `blockedReason` only checks
  `AXIsProcessTrusted()`, and CI never grants or revokes `kTCCServiceListenEvent` (and the runner's responsible
  process may already hold whatever is needed, see item 4).
- Fix: (a) PD binds `CGPreflightListenEventAccess` / `CGRequestListenEventAccess` (CoreGraphics, 10.15+) as optional
  CG symbols (cg.ts `CG_OPTIONAL_PROTOTYPES`), and `CGPreflightPostEventAccess` is checked next to `AXIsProcessTrusted`
  for posting. (b) Settle the question in CI once, in `darwin-desktop.test.ts`: a helper process (node + koffi, a
  different event source) posts F13 down; the test process (whose responsible client is first denied, then granted
  `kTCCServiceListenEvent`) must see code `105+8` in `keysDown()`; log both answers. (c) If gated: `blockedReason()`
  returns "Ember needs Input Monitoring (System Settings › Privacy & Security › Input Monitoring) to notice when you
  take over the keyboard." whenever `CGPreflightListenEventAccess()` is false (fail closed for tier 3), MS adds an
  `input-monitoring` setup check and a fix (`CGRequestListenEventAccess()` once, then
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`), and CI grants
  `kTCCServiceListenEvent` to the test clients. If not gated, record the evidence in §12 and drop the check.
- Where: pkg-darwin (bindings, blockedReason, test), design §8.5 + §9.8 (MS) + §10 item 3 (I).

### 4. macOS CI cannot prove TCC attribution, and the grants it writes are incomplete (major)
- Problem: (a) The macos-15 image already grants Accessibility and ScreenCapture (system TCC.db) to the runner's own
  ancestors: `/opt/hca/hosted-compute-agent`, `.../provisioner/provisioner`, `/bin/bash`, `runprovisioner.sh`
  (runner-images configure-tccdb-macos.sh). Anything a step spawns directly (vitest, the dev Electron, the packaged
  `Contents/MacOS/Ember`, its node-mode host child) inherits that responsible process, so `AXIsProcessTrusted()` is true
  whatever Ember's own rows say. R3 ("TCC attributes the host child to Ember.app") and D10's "learn which client was
  needed" therefore get no evidence from CI. (b) The bundle-id rows port/packaging added (ci.yml:339-346) use
  `csreq NULL`; for a bundle client tccd normally validates the code requirement, and an ad-hoc app's designated
  requirement is its cdhash, so the row may be ignored or rewritten. (c) Missing services: `kTCCServicePostEvent` and
  `kTCCServiceListenEvent` (item 3); `kTCCServiceAppleEvents` (§10 item 3) is evaluated by the *user* tccd against
  `~/Library/Application Support/com.apple.TCC/TCC.db` (runner-images writes AppleEvents to both DBs), not the system DB
  D10's recipe writes. (d) macOS 15 adds a second gate for capture: replayd's
  `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist` ("bypass the private window
  picker" approval, re-asked periodically); runner-images writes a far-future date there for hosted-compute-agent only.
  An unapproved capturing binary gets a modal alert on a headless runner.
- Fix (I, ci.yml; D10 amended): keep today's path rows, and add one attribution check that runs the packaged app the
  way users do, through LaunchServices so Ember.app is its own responsible process:
  `open -n -W --stdout "$RUNNER_TEMP/doctor.txt" --stderr "$RUNNER_TEMP/doctor.err" -a dist/package/Ember.app --args --doctor`
  first **before** adding Ember's bundle row (expect the Accessibility row to fail: proves nothing is borrowed from the
  agent), then after inserting `('kTCCServiceAccessibility','io.github.komaladitya08.ember',0,2,4,1,X'<csreq>',…)`
  where `<csreq>` = `codesign -d -r- Ember.app` piped through `csreq -r- -b req.bin` and `xxd -p` (expect pass). Give
  the doctor (MS §9.9) an "Accessibility helper" row that starts the host and prints `status().toolkitAccessibility`,
  so the same run proves the child's trust. Also: insert `kTCCServicePostEvent` and `kTCCServiceListenEvent` rows for
  every candidate; write AppleEvents rows (`indirect_object_identifier='com.apple.systemevents'`) to the user DB and
  restart the user tccd (`launchctl kickstart -k gui/$(id -u)/com.apple.tccd`); and before any capture test
  `defaults write "$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals" "<binary path>" -date "3024-01-01 00:00:00 +0000"`
  for the dev Electron, the packaged `Contents/MacOS/Ember` and node.
- Where: decisions D10 / design §10 item 3 and R3 (I), port/packaging ci.yml, design §9.9 (MS doctor row).

### 5. Every ad-hoc build invalidates the user's Accessibility and Screen Recording grants (major)
- Problem: TCC stores the app's designated requirement with the grant; for an ad-hoc signature that is the cdhash,
  which changes on every build (stage re-signs with `codesign --force --deep --sign -`, mac-bundle.mjs:102). After each
  update System Settings still shows Ember switched on, but `AXIsProcessTrusted()` and the Screen Recording preflight
  are false. The design's check text ("Ember needs the Accessibility permission…") sends the user to a toggle that is
  already on. Same for the Keychain ACL of "Ember Safe Storage" (R9 mentions only that one).
- Fix: MS's `accessibility` and `screen-recording` checks say, on macOS, "If Ember is already listed and switched on,
  remove it with − and add it again: macOS ties the permission to this exact copy of Ember." and offer a fix
  `reset-accessibility` = `execFile("/usr/bin/tccutil", ["reset", "Accessibility", "io.github.komaladitya08.ember"])`
  then `isTrustedAccessibilityClient(true)` (and `ScreenCapture` likewise; verify on 14/15 that a reset by bundle id
  needs no administrator, else offer only the remove-and-add text). DOC states it in the release notes for testers. Add to §12.3: install build N, grant, install build N+1 over it.
- Where: design §9.8 (MS), R9, §12.3, §11.6 (DOC).

### 6. Intel Macs and macOS 13 are targets that nothing ever builds, launches or tests (major)
- Problem: decisions.md targets macOS 13+ on arm64 **and** x64, but `macos-15` is an Apple-silicon image, stage.mjs
  stages "per target on its own OS" (npm installs only the host's `@koromix/koffi-darwin-*`, `@img/sharp-darwin-*`,
  `@github/copilot-sdk-darwin-*`), and §12.3 tests only macOS 14 and 15. So no x64 Ember.app is ever produced, and the
  x86-64 koffi paths (CGRect returned through a hidden pointer by `CGDisplayBounds`, CGPoint in xmm0/xmm1) and macOS 13
  (first SMAppService release, oldest System Settings URLs) are never exercised.
- Fix: add a small `macos-x64` job on the `macos-15-intel` label (the last Intel image) that runs on pushes to the
  default branch and tags only: npm ci, build, `node scripts/package/stage.mjs`, `archive.mjs`, the packaged checks and
  `test/smoke/launch.mjs --exe …/Contents/MacOS/Ember`, plus `darwin-desktop.test.ts` (cheap, no AX host). If the label
  is unavailable, cross-stage on arm64 with `npm ci --cpu=x64 --os=darwin` + `npm_config_arch=x64` and assert with
  `lipo -archs` that every Mach-O under Ember.app is x86_64 (launch under Rosetta only if `/usr/bin/pgrep oahd`).
  Either add macOS 13 to §12.3's machines or state "macOS 13: best effort, untested" in D-targets and the README.
- Where: design §10 (I), §12.3, port/packaging ci.yml.

### 7. The macOS AX provider will ask Ember's own process, and hit-tests system-wide (minor)
- Problem: §5.3 `topWindows()` reads `AXWindows` for every pid in the CG list ("skipping nothing: ownPid filtering is
  the host's"); port/host filters `ownPid` only after the provider returned (windows.ts:43, 128; ownPid arrives per
  request). So the host child sends AX requests to Ember's main process on every list: Ember's own windows answer, and
  Chromium switches its accessibility tree on for Ember's renderers (the 60 Hz overlay then pays for AX updates;
  `app.isAccessibilitySupportEnabled()` flips). `elementsAt` uses the **system-wide** hit test, which messages whatever
  app owns the window at the point; Ember's screen-saver-level overlay/handle/bubbles sit over everything, so a hit can
  land in Ember (port/host's at_point then falls back to descending the target window, reading.ts:496-509, so it stays
  correct but slow and still touches Ember).
- Fix: hostLaunch passes `EMBER_OWN_PID=<process.pid>` (and the provider also treats `process.ppid` as own); the AX
  provider never creates an AX element for that pid (skip it before `AXWindows`, return it as a CG-only `RawWindow`).
  Extend `AxProvider.elementsAt(x, y, pid?)`; the AX provider then hit-tests app-scoped,
  `AXUIElementCopyElementAtPosition(app(pid), x, y)` (at_point always knows the target window's pid), and system-wide
  only without a pid.
- Where: design §5.1 (env), §5.3 (AX); port/host provider.ts / reading.ts (AX package owns the edit after merge).

### 8. Stable keys from `CFHash`: precision loss and in-read collisions (minor)
- Problem: `cf.hash()` returns `Number(raw.CFHash(ref))` (cf.ts:380-382); `CFHashCode` is 64-bit and koffi 3 returns
  `unsigned long` values above 2^53 as BigInt, so `Number()` rounds them and distinct elements can share
  `${pid}:h${hash}`. Keys are not only for remembered secrets: port/host compares them for identity inside one read
  (actions.ts:132 `selectedAlone`, :168 deselecting "other" selected rows), so two rows with one key would leave a
  second row selected in a multi-select list (a file dialog would then open two files). Nothing pins how well
  `CFHash` spreads AXUIElement tokens either.
- Fix: `hash()` returns the exact value as a hex string (`BigInt.asUintN(64, BigInt(raw))`), and §5.3's key becomes
  `${pid}:h${hex}`. Within one `snapshot`/`children` answer the provider detects duplicate keys and, for those only,
  falls back to the index-path key (log `ax.key_collision`). The CI check that already compares the password key
  across two host processes also reads a 200-row list and asserts zero duplicate keys.
- Where: pkg-darwin cf.ts (`hash`), design §5.3 (AX), R4.

### 9. `AXUIElementCopyMultipleAttributeValues` reports failures as values the bindings can't decode (minor)
- Problem: §5.3's `attrs()` relies on one `AXUIElementCopyMultipleAttributeValues(el, names, 0, &out)` per node. With
  options 0 a failed attribute is not an error return: its slot holds an `AXValueRef` of type `kAXValueAXErrorType`
  (5) wrapping the `AXError` (some apps put `kCFNull` there). port/darwin's `decodeAXValue` returns null for type 5
  (ax.ts:90-101), so `NoValue`, `AttributeUnsupported` and `CannotComplete` all collapse into "absent": a hung app's
  partial answer would read as an element with no name/role instead of `busy`, and the 5 s busy memory never starts.
  The whole call returns `kAXErrorCannotComplete` only when the app doesn't answer at all.
- Fix: PD's `decodeAXValue` gains `{ type: "error"; code: number }` for type 5 (`buf.readInt32LE(0)`); AX's `attrs()`
  maps it per slot (CannotComplete in any slot → `busy`, NoValue/Unsupported → absent, CFNull → absent), and the fake
  `AxApi` in the unit tests returns per-slot errors so the mapping is tested on Linux.
- Where: pkg-darwin ax.ts, design §5.3 (`AxApi.attrs`, tests).

### 10. Per-node extra round trips can blow the read budget in Chromium/Electron apps (minor)
- Problem: §5.3 reads, for every interactive node, `actions(el)` plus up to four `settable(el, …)` calls (AXValue,
  AXSelected, AXFocused, AXExpanded) and a second `attr(el, "AXValue")`: up to 6 synchronous IPCs on top of the batch
  and the children call. A 300-control Chromium page (1-5 ms per AX IPC) then needs 2-9 s; port/host's read budget is
  1.5 s (reading.ts:25) and a hung app costs up to 0.8 s **per call** between deadline checks, so reads come back
  `truncated`/`slow` on exactly the apps users care about.
- Fix: keep the read to one `attrs` batch + one children range per node. List `actions` only for the roles port/host
  lists actions for (roles.ts:21-26, rows/cells excluded) and derive the rest from role: `focusable` from role and
  `AXFocused` presence, `editable` from role (text field/area/combo/search, not static text) and verify at write time
  (`settable` is asked in `element()`/`perform()`, where one node is involved). Check the deadline before every IPC and
  stop with `cut` once `deadlineMs - 800` has passed, so one stalled call can't overshoot past the budget.
- Where: design §5.3 (AX).

### 11. Borrow loops put CGWindowList and 128 key-state calls on Electron's main thread every 8 ms (minor)
- Problem: during a borrow `check()` runs per glide step (`STEP_MS = 8`, borrow.ts:94) and calls `keysDown()` (128
  `CGEventSourceKeyState` calls, input.ts:274) and `pointerOn()` (a full `CGWindowListCopyWindowInfo`, which builds a
  dictionary per on-screen window); `keyboardOnTarget()` per typed character adds another window list plus an AX
  `AXFocusedWindow` round trip (0.25 s worst case). At 125 Hz this is a measurable share of the main thread that also
  runs the overlay's 60 Hz hover polling and IPC.
- Fix: in port/darwin's `makeDesktop`, cache `windows()` for 30 ms (a borrow step never needs fresher), and read all
  keys in one call with Carbon `GetKeys(KeyMap)` (`void GetKeys(void *keys)`, 16 bytes, bit `k` of byte `k >> 3` per
  CGKeyCode) when bound, falling back to the loop. `darwin-desktop.test.ts` logs the median cost of `keysDown()`,
  `windows()` and `focusedWindow()`; I sets a budget (check() < 2 ms median) in `ember-darwin.test.ts`.
- Where: pkg-darwin (desktop.ts/hitoolbox.ts + test), design §8.5.

### 12. Activation from a background process on macOS 14+ needs a fallback (minor)
- Problem: `Input.activate()` sets `AXFrontmost` on the app and `AXRaise`/`AXMain` on the window (desktop.ts:148-162);
  CursorBorrow waits up to 1 s for the focus (borrow.ts:417-425). Ember is never the active app (its windows are
  non-activating panels), and macOS 14 introduced cooperative activation, under which background-initiated activation
  requests can be declined. R6 covers Windows only; §8.5 has no macOS equivalent.
- Fix: keep `darwin-desktop.test.ts`'s activation test (it runs from a process with no UI, which is the realistic
  case) and add a fallback in `raise()`: if `AXFocusedApplication` isn't the target pid 300 ms after `AXFrontmost`,
  activate through LaunchServices (`/usr/bin/open -a <bundle path>`, the path from `proc_pidpath` walked up to the
  `.app`), then `AXRaise` again. Add R6-mac to §12.2 with this default.
- Where: pkg-darwin desktop.ts, design §8.5 + §12.2.

### 13. Gatekeeper on macOS 15 and App Translocation are described wrongly for testers (minor)
- Problem: R9 says Gatekeeper is passed with "right-click → Open"; macOS 15 removed that override: the first launch
  is refused and the user must click "Open Anyway" in System Settings › Privacy & Security (or clear the quarantine
  flag). Until the user moves the quarantined app out of Downloads/the dmg, macOS runs it translocated from a random
  read-only path: the TCC grant, the SMAppService login item and `isInApplicationsFolder()` all see that path.
  §9.8's `move-to-applications` fix helps only after Ember has started.
- Fix: R9 and DOC's tester notes: "Drag Ember to Applications first; on macOS 15 open it once, then System Settings ›
  Privacy & Security › Open Anyway (or `xattr -dr com.apple.quarantine /Applications/Ember.app`)." The dmg (port/
  packaging already adds an Applications link) is the documented route; `location` stays a setup warning. §12.3 item 1
  uses the dmg on a clean macOS 15 account.
- Where: design R9, §11.6 (DOC), §12.3.

### 14. In development the TCC grant goes to the terminal, not to Electron (minor)
- Problem: `npm run dev` starts `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` from a shell, so
  TCC's responsible process is Terminal / iTerm2 / Visual Studio Code; the Accessibility prompt and the Screen
  Recording list name that app, and the AX host child inherits it. §5.1/D10 list the dev Electron binary as the grant
  target, which only holds when Electron is started through LaunchServices.
- Fix: DEVELOPING.md (DOC) says which app to grant and why; optionally a `dev:mac` script that launches through
  LaunchServices (`open -n -W node_modules/electron/dist/Electron.app --args "$PWD"`) so the grants go to "Electron"
  (`com.github.Electron`) and not to the developer's terminal (which would otherwise give every script run there
  Accessibility and Screen Recording).
- Where: design §5.2 (dev column note), §11.6 (DOC).

### 15. VoiceOver detection through `defaults read com.apple.universalaccess` is fragile (minor)
- Problem: §9.10 reads `voiceOverOnOffKey` with `/usr/bin/defaults`; the key is absent until VoiceOver was toggled
  once, the domain is privacy-protected on recent releases (the design already says "verify"), and the fallback (an
  on-screen window owned by `VoiceOver`) misses VoiceOver with the caption panel and cursor hidden.
- Fix: primary test = the VoiceOver process is running (`/System/Library/CoreServices/VoiceOver.app` runs only while
  VoiceOver is on): `execFile("/usr/bin/pgrep", ["-x", "VoiceOver"])` exit 0, or koffi `proc_listallpids` +
  `proc_name`; keep `defaults` as a second opinion. (`NSWorkspace.isVoiceOverEnabled` through fixed-arity
  `objc_msgSend` bindings is the exact API if the process test proves unreliable.)
- Where: design §9.10 (MS).

### 16. `textKey` on key code 0 types the wrong thing under an input method (minor)
- Problem: `textKey` posts a key-down/up on `kVK_ANSI_A` with `CGEventKeyboardSetUnicodeString` (input.ts:351-362,
  desktop.ts:245-249). With a CJK input method active (Japanese, Pinyin, Korean…) the target app's input method sees
  key code 0 and composes from it ("あ", "a" in a candidate window) instead of inserting the string; some apps and
  Java/Qt toolkits read the key code too. §2.4 makes `textKey` the only typing path on macOS.
- Fix: before typing, read the current input source (`TISCopyCurrentKeyboardInputSource` +
  `kTISPropertyInputSourceType`, already bound next to the layout code in hitoolbox.ts, main thread only); when it is
  not `TISTypeKeyboardLayout`, `blockedReason`/`textKey` refuse with "Switch to a keyboard layout (not an input method)
  so Ember can type, or let Ember fill the field directly." (tier 1 `set_text` still works). Add a CJK input source to
  §12.3 item 5.
- Where: pkg-darwin input.ts/hitoolbox.ts, design §2.4 and §12.3.

### 17. The macOS security-window vocabulary misses system prompts that take credentials or consent (minor)
- Problem: port/darwin's `SECURITY_OWNERS` is `SecurityAgent`, `coreautha` (model.ts:60); §8.4 adds `coreauthd`,
  `loginwindow`; §9.11 has more but not the TCC/consent and passkey prompts. Missing owners whose windows are
  credential or consent UI: `universalAccessAuthWarn` ("… would like to control this computer using accessibility
  features"), `UserNotificationCenter` (TCC prompts; listed only for shell_overlays in §5.3), `CoreServicesUIAgent`
  (Gatekeeper), `AuthenticationServicesAgent` (passkeys/AutoFill sheets), `ScreenSaverEngine`. An Ember screenshot
  or click while the Accessibility prompt is up is precisely the self-approval path to avoid.
- Fix: V verifies the owner names on macOS 14/15 (print `ws.stack()` while each prompt is up) and puts them in
  `SECURITY_APP.darwin`; port/darwin's `SECURITY_OWNERS` and §8.4's `macSystemDialog` read the same list (one source,
  `policy/vocabulary.ts`), so the three lists can't drift.
- Where: design §8.4, §9.11 (V), pkg-darwin model.ts (I reconciles after merge).

### 18. The secure-input check fails open when HIToolbox doesn't bind completely (minor)
- Problem: §8.4 says an unbindable `IsSecureEventInputEnabled` "counts as true (fail closed)". In port/darwin,
  hitoolbox.ts `bind()` binds the TIS layout functions, `LMGetKbdType`, `UCKeyTranslate` and
  `IsSecureEventInputEnabled` all-or-nothing (throws on the first missing one, hitoolbox.ts:229-233), and
  desktop.ts:166-168 answers `secureInput() → false` when HIToolbox is null. So a macOS release that moves or drops any
  one layout symbol silently disables the secure-input refusal for both screenshots (windows.ts:189-197) and typing
  (input.ts:183-187, 368-379).
- Fix: bind `IsSecureEventInputEnabled` on its own (Carbon, then HIToolbox, then CoreServices); `secureInput()` returns
  `boolean | null`, and null means: `systemDialogOpen()` true, `blockedReason()` "Ember can't tell whether a password is
  being typed, so it won't use the keyboard." Use `CGSessionCopyCurrentDictionary()["kCGSSessionSecureInputPID"]`
  (already read) as the fallback signal before giving up. Log `platform.secure_input_unknown` once (§8.4's event).
  Also surface the holder: when secure input blocks screenshots, Perception's refusal and the doctor row name the app
  holding it (`kCGSSessionSecureInputPID` → owner), since a stuck secure input (Terminal's Secure Keyboard Entry, a
  password manager) otherwise disables Ember with no visible reason.
- Where: pkg-darwin hitoolbox.ts/desktop.ts/windows.ts, design §8.4 (MS: reason text, doctor row).

### 19. desktopCapturer capture: main-thread image work and the macOS 15 capture alert (minor)
- Problem: §8.2 asks `getSources` for native-pixel thumbnails (a 5K/6K display is a 60-80 MB bitmap), then
  `crop()`, `resize()` and `toBitmap()` them: NativeImage operations run synchronously on Electron's main thread, so
  every worker screenshot stalls the overlay's hover polling and IPC for tens to hundreds of ms. Separately, on
  macOS 15 an app that reads the screen without the system picker gets a recurring "… is requesting to bypass the
  system private window picker" alert (the replayd approval of item 4(d)); neither §9.8 nor §12.3 mention it.
- Fix: request thumbnails at the displays' point size (`W = max(d.bounds.width)`, `H = max(d.bounds.height)`), so
  Chromium scales off the main thread and step 6's resize disappears (the scale-from-actual-size step stays, and the
  pure `composePoints` path in port/darwin capture.ts remains for odd sizes). Note the macOS 15 alert in the
  `screen-recording` check's ok-with-note text ("macOS asks again about once a month; choose Allow") and in §12.3
  item 6.
- Where: design §8.2 (MS), §9.8, §12.3.

### 20. The design still says "keep the inner executable"; port/packaging renamed it, and must (minor)
- Problem: D8 and §10 item 7 keep `Contents/MacOS/Electron`; port/packaging 740c547 renames it to `Ember`
  (`CFBundleExecutable` = Ember) because Electron's `app.isPackaged` is false for an executable named "Electron", which
  would turn on main.ts's development overrides (every `EMBER_*` dev variable, `--inspect`) in an installed Ember. The
  rename is required, not optional; §5.1, §9.9 and §10 still write `<inner exe>`.
- Fix: design §5.1/§9.9/§10 name `Ember.app/Contents/MacOS/Ember`; §10 records why (isPackaged) and keeps port/
  packaging's CI assertion (`CFBundleExecutable` = Ember, `--inspect` refused); helpers keep Electron's names
  (Electron looks for "Electron Helper" first). D8 gets a one-line amendment.
- Where: decisions D8 (lead), design §5.1, §9.9, §10.

### 21. Login item: a `not-found` status makes every settings change re-register (minor)
- Problem: §9.5's darwin `sync(on)` treats only `enabled`/`requires-approval` as on and calls
  `app.setLoginItemSettings({ openAtLogin: true })` whenever the status differs, and main calls `sync` on every
  settings change. When BTM can't resolve the app (`status: "not-found"`: a translocated or not-yet-moved copy, see
  item 13) the register never sticks, so each settings change registers again and macOS shows "Background Items
  Added" each time.
- Fix: remember the outcome per session: after a register whose re-read status is `not-found`, don't register again
  until Ember restarts, and `note()` returns "Move Ember to the Applications folder, then turn this on again."
- Where: design §9.5 (MS).

## Checked and sound (no change needed)
- AX C API through koffi from a node-mode child: prototypes in port/darwin ax.ts/cg.ts match the headers
  (`float` hit-test coordinates and timeout, `int32_t` AXError/pid, `bool` for Boolean, CGPoint/CGRect by value,
  `CGEventCreateScrollWheelEvent2` instead of the variadic call); the AX calls need no run loop, and TIS is kept to the
  main thread (hitoolbox.ts), which a node-mode child's JS thread is.
- kAX attribute names as CFStrings built at runtime (`cf.key()`, interned for the process) are correct: the kAX
  constants are `CFSTR` macros, not exported symbols; `kAXTrustedCheckOptionPrompt` is read with `lib.symbol` + decode.
- AXValue CGPoint/CGSize/CGRect/CFRange decoding (ax.ts:90-101) is right for both architectures (only the AXError type
  is missing, item 9).
- `AXUIElementSetMessagingTimeout` on the system-wide element sets the process default (0.25 s main, 0.8 s host).
- CGWindowList parsing (`kCGWindow*` keys are CFStrings spelled like the constants; bounds via
  `CGRectMakeWithDictionaryRepresentation`), front-to-back → bottom-to-top, layer 0 = app windows; AX frame = CG
  bounds, so `matchFrame`'s k = 1.
- `getMediaSourceId()` = `window:<CGWindowID>:0` on macOS, parsed by model.ts; panels keep a window number.
- CGEvent posting from one HID-state source with suppression interval 0 and local events permitted; X buttons 4-7 →
  line scroll events; codes = CGKeyCode + 8; Command for Super_L/Meta_L (keys.ts).
- Responsibility: a child spawned by Ember.app (libuv posix_spawn, no disclaim) is attributed to Ember.app, so the
  host shares Ember's grants for users who start Ember from Finder/login (CI just can't show it, item 4).
- Fuses on `Electron Framework.framework/Electron Framework`, universal binaries refused, ad-hoc `--deep` re-sign after
  every byte is in place and `xattr -cr` before it, Info.plist keys (port/packaging mac-bundle.mjs); no hardened
  runtime, so no entitlements are needed for AX, microphone or Apple Events.
