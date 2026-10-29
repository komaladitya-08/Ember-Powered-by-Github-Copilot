# Critique of design.md: Linux non-regression and integration correctness

Reviewer lens: Linux non-regression, test/eval breakage, Electron-import rule, unwireable interfaces
(missing members, wrong types, sync/async, ids/units), approval-chord safety, file ownership (§11 vs D11/pkg-*.md).
Base: branch ember-improve/20261022-windows-macos at e89a93f. Every file:line is from that tree unless marked otherwise.

Status: complete. 15 findings: 1 blocker (3), 5 major (1, 2, 6, 9, 12), 9 minor (4, 5, 7, 8, 10, 11, 13, 14, 15).

## Findings

### 1. macOS: Ember's approval chord can be pressed under another letter (exact-chord match vs layout-aware keys)
- Problem and evidence: §2.4 makes `isSystemKey` on darwin refuse Ember's chords only by exact equality
  (`keyFamily(s.chord) === keyFamily(k)`), and `KEYS.darwin.systemKeys` has no `ctrl+shift+cmd+*` family. port/darwin
  presses the key that *types* the letter on the active layout (wt/darwin `app/main/platform/darwin/input.ts:147-153`,
  `keys.ts:1-6`, `hitoolbox.ts:2-6`: UCKeyTranslate; borrow.ts `keys` goes through `shortcutStroke(sym, layout)`,
  borrow.ts:357-362), while Electron registers global shortcuts on macOS as Carbon hot keys by key *code*
  (Chromium maps the accelerator's VKEY to a fixed US-ANSI kVK_* position; confirm on a QWERTZ Mac in §12.3 item 5,
  but the fix below is fail-closed whichever way that turns out). On a German (QWERTZ) layout a task asking
  for `ctrl+shift+cmd+z` gets keycode kVK_ANSI_Y, which fires Ember's Allow (Control+Shift+Command+Y); AZERTY moves M
  (mute) the same way. The policy sees `ctrl+shift+cmd+z`, which is not a system key: it is only "a shortcut Ember can't
  judge" (policy.ts:1759, a confirm, which an app grant or a queued second question can turn into a press while
  another task's question is up). The Confirmer's `blocked()` (borrow.driving, main.ts:1193) and arm delay are the only
  other guards, and CGEventPost is asynchronous, so the hot-key callback can arrive after `drivingNow` is cleared
  (borrow.ts:458). Windows is safe (every `super+*` is a system key, policy.ts:566). Linux is not changed by the port;
  the same class of gap exists there only with multi-group XKB keymaps (XKeysymToKeycode searches group 1 for the
  grab, borrow uses the active group) - pre-existing, out of Phase 1 scope, note it in PLAN §9.
- Severity: major (safety rule that must fail closed; trivial to fix).
- Fix: on darwin refuse the whole modifier family, not just six letters: in `isSystemKey(k, kc)` add
  `kc.os === "darwin" && mods.has("ctrl") && mods.has("shift") && mods.has("cmd")` → true (and, generally,
  "mods ⊇ the chord's modifier set of any SHORTCUTS[os] entry" for every OS except Linux, where the Linux regex
  already does this and must not change). Add invariant tests: darwin `ctrl+shift+cmd+z`, `ctrl+alt+shift+cmd+y`,
  `ctrl+shift+super+y` and `ctrl+shift+meta+comma` are system keys; Linux `isSystemKey` results for a frozen list are
  unchanged. Optionally also make `Confirmer.blocked` = `borrow.driving || Date.now() - borrow.lastSyntheticKeyAt < 500`
  (defence in depth for asynchronous posting).
- Where: §2.2 (`KEYS.darwin`), §2.4 (`isSystemKey` and its invariant tests), §11.2 P1-C tests.

### 2. A second `hostLaunch` duplicates port/host's `app/sidecar-host/launch.ts`, with different semantics
- Problem and evidence: §2.5/§5.1/§7.1/§8.1 and §11.2 give P1-A a new `app/main/platform/host-launch.ts` exporting
  `hostLaunch(ctx, { provider, env, extraEnv, windowsHide, firstRequestMs })`. port/host already ships
  `hostLaunch(o: HostLaunchOptions)` in wt/host `app/sidecar-host/launch.ts:30-39` (execPath, host path, uiaScript,
  uiaCache, env, platform, packaged). They disagree: port/host's provider is chosen by `process.platform` inside the
  host (`providers/index.ts:21-26`; `EMBER_AX_PROVIDER` only matters for `fake`), it never reads
  `EMBER_UIA_POWERSHELL` (it builds the path from `SystemRoot`, `providers/uia.ts:202-205`), strips the test switches
  only when packaged, sets `windowsHide: true` on every OS, and uses `firstRequestMs` 10 s on macOS (design: 8 s);
  the design's `cleanEnv` drops every `EMBER_*`, which also kills the dev-only `EMBER_AX_PROVIDER=fake` path that
  port/host's Ember-level tests rely on. D11 says to adopt, not redefine.
- Severity: major (two owners for one function; whichever WS/MS call, half the design's statements about the launch
  are false).
- Fix: drop `platform/host-launch.ts` from P1-A. WS/MS call port/host's `hostLaunch` and pass
  `env: cleanEnv(deps.env, { keep: packaged ? [] : ["EMBER_AX_PROVIDER", "EMBER_AX_FAKE_DESKTOP", "EMBER_AX_FAKE_LOG"] })`.
  Delete the `EMBER_UIA_POWERSHELL` variable from §5.2 (or, if the GetSystemDirectoryW path is wanted, request it from
  port/host as an addition reported to I). Make §5.1's 8 s match port/host's `FIRST_REQUEST_MS` (10 s) or change it in
  one place only. `SidecarContext` then needs `userData` only for `uiaCache`.
- Where: §2.5, §5.1, §5.2, §7.1, §8.1, §11.2 (P1-A file list and its host-launch test).

### 3. Step 0's types.ts does not compile: `AppIdentity` picks `DesktopApp.argv`, which only P1-D adds
- Problem and evidence: §2.1 declares `AppIdentity = Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "argv" |
  "categories" | "terminal">>`. `DesktopApp` (hands/system.ts:97-100) has no `argv` today; §4.15 has P1-D add it in
  Phase 1. `Pick<T, K extends keyof T>` with `"argv"` is TS2344, so the step 0 commit fails `tsc --noEmit`, which §1.2
  says must stay green, and every Phase 1/2 package compiles against a broken contract.
- Severity: blocker (for step 0; one-line fix).
- Fix: in step 0 write `AppIdentity = Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "categories" |
  "terminal">> & { argv?: string[] }`, or let step 0 also add the type-only `argv?: string[]; programs?: string[]` to
  `DesktopApp` (and take those two lines out of P1-D's list). Add "step 0 runs `npx tsc --noEmit`" to §1.2 explicitly.
- Where: §2.1, §1.2, §4.15, §11.2 (step 0 row).

### 4. Linux would accept new key spellings (`mod+…`, `primary+…`, `cmdorctrl+…`): a model-visible policy change
- Problem and evidence: §2.2 gives `KEYS.linux.extraModifiers = PRIMARY_CTRL` (`mod`, `primary`, `cmdorctrl` → Control_L), and §2.4
  makes `parseCombo(combo, kc = KEYS.linux)` and `canonicalKeys` use it. Today `parseCombo("mod+s")` throws
  (borrow.ts:105-109), so `canonicalKeys` is null and the policy answers never "Ember's keyboard doesn't know that key
  combination" (policy.ts:1827-1828). After Phase 1 Linux presses Ctrl+S (or asks, for `primary+delete`). That is a
  Linux behaviour change outside §1.3's list of five, and nothing needs it: §2.4 expands the `mod` templates with
  `entry.replace(/\bmod\b/g, kc.primary)` before parsing, so the token never reaches `parseCombo`.
- Severity: minor.
- Fix: `KEYS.linux.extraModifiers = {}` and `KEYS.win32.extraModifiers = {}`; darwin keeps `cmd/command/option/opt`
  (drop `mod/primary/cmdorctrl` there too unless a model is told about them). Add to P1-C's frozen-copy test: for a
  list of spellings (`mod+s`, `primary+a`, `cmdorctrl+v`, `cmd+s`, `win+r`) `canonicalKeys` on Linux equals today's
  output (null, null, null, `super+s`, `super+r`).
- Where: §2.2, §2.4, §11.2 P1-C tests.

### 5. The "one step behind" pointer tolerance changes takeover detection on Linux too
- Problem and evidence: §2.4 (borrow.ts `check()`) makes the pointer count as Ember's when within TOLERANCE of `expected` *or of the
  previous expected*, on every OS. On Linux a user movement that happens to land within 2 px of the previous glide
  step (borrow.ts:242, steps are a few px apart) is no longer a takeover at that check. §4.8 says "Linux pointers are
  synchronous, so nothing changes", but the change is in what counts as the user, not in timing. Takeover detection is
  a safety rule; Phase 1 promises byte-for-byte Linux behaviour.
- Severity: minor.
- Fix: gate it on a backend capability, e.g. an optional `Input.pointerLags?: true` (port/darwin sets it; requested
  through I per §11.4) or `x.textKey !== undefined` as a stop-gap; when absent `check()` is today's code verbatim. The
  borrow-platform test then asserts the Linux fake (no flag) still takes over on a one-step-back move.
- Where: §2.4 (borrow), §4.8, §2.1 (Input, optional member).

### 6. port/darwin and port/win32 already do what WS/MS are told to build; the wrapper would strip their extras
- Problem and evidence: §2.1's notes and §7.2/§8.4 say the in-flight backends don't implement `systemDialogOpen`, so WS/MS write
  `win32/system/secure-desktop.ts` / `darwin/system/secure-input.ts` and wrap with `withSystemDialog`. But
  wt/darwin `windows.ts:44-56,189-205` already has `systemDialogOpen()` (SecurityAgent/coreautha + secure input, fail
  closed) plus `accessibilityTrusted()` and `screenRecording()`; wt/win32 `ffi.ts:184-186,455-460` already binds
  OpenInputDesktop/GetUserObjectInformationW/CloseDesktop (`inputDesktopName()`) and `security.ts:35-39` has
  `onUsersDesktop()`. `withSystemDialog` delegates "each member of WindowSystem" explicitly (§2.5), so the darwin
  extras are lost after wrapping (MS's environment check would have to re-derive them), and MS replaces port/darwin's
  check with a second one. Likewise wt/darwin `capture.ts:93-135` already has `composePoints(displays, rect)`
  (stitch + resample to points) and `captureRect` with `acceptImage` (exact-rect contract), which §8.2 re-specifies
  with NativeImage crop/resize. Finally wt/darwin `windows.ts:27-31` takes `focusedOwnWindow?: () => OwnWindowHandle |
  null` (BrowserWindow.getFocusedWindow) so `focusWindow()` can report Ember's non-activating panel; §8.1 never passes
  it and `ElectronParts` (§2.1) has no way to provide it.
- Severity: major (duplicate safety code with two behaviours; an unwireable dependency).
- Fix: darwin composition uses port/darwin's `systemDialogOpen` as is (no wrapper; delete `secure-input.ts` from MS);
  win32 composition wraps with a check built on port/win32's `loadWin32().inputDesktopName()` + `onUsersDesktop()`
  plus the credential-window `wmClass` list (no second binding). `withSystemDialog` returns `T & { systemDialogOpen }`
  via a Proxy or `Object.create(ws)` so backend extras survive (and its test checks an extra member survives). §8.2:
  MS builds `DisplayBitmap`s from the thumbnails and calls `composePoints`, keeping the design's fail-closed rules
  (no permission, missing `display_id`, empty thumbnail → null). Add `focusedOwnWindow?: () => OwnWindowHandle | null`
  to `ElectronParts` (main passes `() => BrowserWindow.getFocusedWindow()`), and pass it in §8.1.
- Where: §2.1 (notes, ElectronParts), §2.5, §7.2, §8.1, §8.2, §8.4, §9.1, §11.3 (WS/MS file lists).

### 7. The helper status that the Windows/macOS environment check needs cannot be wired
- Problem and evidence: `EnvContext.helper` (§2.1) carries `{ toolkitAccessibility, detail }`, §9.8 derives `powershell:
  "constrained"` from `detail`, and §5.2 says main fetches `sidecar.status()` 10 s after ready. But port/host's
  `status` answer has no `detail` (wt/host `app/sidecar-host/reading.ts:59-72`), `SidecarStatus` has no such field
  (wt/host `perception/sidecar.ts:163`), and no item in §4.1's main.ts list schedules the fetch or feeds `wsState`'s
  sibling into `readEnvironment`. As written, the Constrained Language Mode text can never appear.
- Severity: minor (Windows/macOS diagnostics only; no Linux impact as long as the fetch stays gated on
  `sidecarLaunch` returning a launch).
- Fix: request from port/host (via I, §11.4) an optional `detail?: string` in the status answer (the bridge's fatal
  line or the provider's start error) and in `SidecarStatus`; add a §4.1 item: "when `platform.sidecarLaunch(...)`
  returned a launch, `setTimeout(() => sidecar.status().then(s => helper = s, () => helper = null), 10_000).unref()`;
  `readEnvironment` passes `helper`". Linux: no launch, no fetch, `helper` stays undefined.
- Where: §2.1, §4.1, §5.2, §9.8; port/host follow-up.

### 8. `clipboard-formats.ts` has two owners in the design
- Problem and evidence: §3's table and §4.10 say P1-D creates `app/main/agent/clipboard-formats.ts` and §11.2 lists it under
  P1-D, but §9.11 says "created by P1-C with the Linux row". P1-C owns `clipboard.ts`, which must stop defining
  `savableFormat` and re-export it: if P1-D creates the new file it must copy `savableFormat`'s body (it can't import
  from a file P1-C is rewriting without a cycle), and for a while two copies exist.
- Severity: minor.
- Fix: one owner. Simplest: P1-D creates `clipboard-formats.ts` holding the moved `savableFormat` body and the Linux
  row; P1-C's `clipboard.ts` imports and re-exports it (merge order P1-D → P1-C already holds). Fix §9.11's sentence.
- Where: §9.11 (and §3/§4.10 for consistency).

### 9. The worker's own auth-prompt guard keeps the Linux vocabulary on every OS
- Problem and evidence: §4.9 routes keys, words, apps and settings through `WorkerSystem`, and §4.1 item 40 routes main's
  `currentWindow` through `sys.privacy.isSecurityWindow`, but worker.ts:2909 (`withCursor`'s `authPrompt`: "a password
  or authentication prompt has the keyboard → never") calls the imported Linux `isSecurityWindow(w)` directly
  (worker.ts:28). `WorkerSystem` has no privacy member, so on Windows/macOS that guard never matches
  `credentialuibroker`/`consent`/`SecurityAgent` and the borrow starts (other checks such as `keyboardOnTarget` may still
  stop it, but this rule is meant to fail closed on its own). perception/index.ts:107,320,323,419,579 is covered by
  §4.7 only if every one of those call sites is switched; the design names functions, not lines.
- Severity: major (a safety guard silently becomes a no-op off Linux; no Linux impact).
- Fix: `WorkerSystem` gains `privacy: Pick<PrivacyVocabulary, "isSecurityWindow">` (Linux default = today's function);
  worker.ts:2909 uses `this.sys.privacy.isSecurityWindow(w)`. P1-B's test asserts each of the five perception call
  sites uses `this.o.isSecurityWindow` (a fake that matches "credentialuibroker" blocks the screenshot, the window line
  and the never-look mask). Add a P1-C worker-platform case: with a win32 fake system whose active window is
  `credentialuibroker`, `press_keys` is denied before any borrow.
- Where: §4.9 (WorkerSystem), §4.7, §11.2 P1-B/P1-C tests.

### 10. Injected `windowId` can answer 0, and 0 then matches Ember's own windows
- Problem and evidence: §4.5/§4.6 swap ask.ts:224 and desk/view.ts:204's `readUInt32LE(0) === xid` for `windowId(win) === xid`,
  and main passes `w => ws?.windowId(w) ?? 0`; `WindowSystem.windowId` returns 0 "when it can't be told" (types.ts).
  `isWindow(0)` then returns true whenever the box exists. Today's callers guard with `back &&` / `to &&`
  (main.ts:432,436), but `mayRefocus: w => !askWindow.isWindow(w)` (main.ts:1217) and future callers don't. Also
  ask.ts:123 calls `takeFocus` only `if (xid)`, so §4.1 item 18's `sys.lifecycle.focusOwnApp()` (macOS: the only thing
  that makes the hotkey-opened box key) never runs when the id is 0.
- Severity: minor (Linux: `windowId` is never 0 while X11 is open, so no change).
- Fix: `isWindow(id)` returns false for `id === 0`; ask.ts `reveal()` calls `takeFocus(id)` unconditionally and the
  callback in main guards the input calls with `if (id)` while always calling `focusOwnApp()`. Pin both in
  ask-window.test.ts's new cases (P1-A may only add tests, so as a new file).
- Where: §4.1 item 18, §4.5, §4.6.

### 11. Ownership overlaps with the running packages (globs and briefs), and two shared host files
- Problem and evidence: (a) §11.1 says PW owns "platform/win32/** except WS's files" and PD "platform/darwin/** except MS's files",
  but pkg-win32.md:7 and pkg-darwin.md:7 give them the whole folders with no exception, and §11.3 lets WS/MS start
  "right after step 0", i.e. while PW/PD may still be running. (b) WS's unit tests `test/unit/platform-win32-system-*.test.ts`
  fall inside PW's glob `test/unit/platform-win32-*.test.ts` (pkg-win32.md:10); MS's `platform-darwin-system-*` inside
  PD's `platform-darwin-*` (pkg-darwin.md:15). (c) AX owns "the darwin branch of providers/index.ts" and "AX additions
  in roles.ts" while I owns "app/sidecar-host/** outside AX files" and PH wrote both files: three owners of two files.
  (d) P1-D changes `doctorChecks`, whose only existing tests are in test/unit/packaging.test.ts (PK's file,
  pkg-packaging.md:11); §4.14 calls them "doctor.test.ts", which does not exist, and P1-D may not edit PK's file.
- Severity: minor (process; each is a likely merge conflict or an "unowned" edit).
- Fix: (a) amend pkg-win32.md/pkg-darwin.md now ("do not create win32/platform.ts, win32/system/**" /
  "darwin/platform.ts, darwin/electron-capture.ts, darwin/system/**"), or start WS/MS only after PW/PD merge. (b) name
  WS/MS tests `win32-system-*.test.ts` / `darwin-system-*.test.ts`. (c) give AX whole files (`providers/ax-darwin*.ts`,
  a new `roles-ax.ts` imported by roles.ts) and let I make the one-line hook-ups in providers/index.ts and roles.ts.
  (d) §4.14: "the doctor cases in packaging.test.ts (PK) must pass unchanged; P1-D's new doctor tests go in a new
  file"; and choose the discriminator now: `DoctorProbes.os` (default "linux"), not the platform check's detail text
  (that is "linux/arm64 is not supported in v1" on Linux arm64, which would flip a Linux box to Windows/macOS wording).
- Where: §11.1, §11.3, §4.14, pkg-win32.md, pkg-darwin.md.

### 12. Phase 1 merge order and "parallel" claims don't hold: the branch would stop compiling between merges
- Problem and evidence: (a) §11.2 says P1-B, P1-D, P1-E merge "in any order", but P1-E's copy.ts imports `app/shared/never-look.ts`
  (`missingDefaults`, names) and its ui-copy.test.ts edit compares with `NEVER_LOOK_DEFAULTS[HOST_OS]`, both created by
  P1-D: P1-E before P1-D breaks the build. (b) §4.21 makes `Status.platform` a required field; P1-E merges before P1-A,
  and today's main.ts `getStatus` (main.ts:300-309) builds a `Status` without it, so `tsc --noEmit` fails on the
  branch from P1-E's merge until P1-A's. (c) P1-A cannot typecheck in its own worktree until P1-B..E and PH have
  merged: linux/index.ts imports P1-D's `linuxSystem`, and main.ts uses P1-C's `CursorBorrowOptions.keys`,
  `PolicyEngineOptions.keys/os/isSecurityWindow`, `AgentHostOptions.system`, `electronClipboard`'s 4th parameter,
  `explainStartError`'s `reinstall`, and P1-D's `locateRuntime({ runtimeId })`, `resolveToken(store, o)`,
  `SettingsStore({ renameRetries })`, `useAppNames`. P1-C likewise needs P1-D's `programsOf`, `DesktopApp.argv`,
  `hands/terminals.ts` and `clipboard-formats.ts`. Yet every package must finish with `tsc`, lint and the full suite
  green (§11 preamble).
- Severity: major (process; as written two packages can't meet their own acceptance and the branch is red mid-merge).
- Fix: order P1-B, P1-D → P1-E, P1-C → P1-A; make `Status.platform` optional (the renderer keeps today's Linux markup
  when it is absent), or merge P1-E together with P1-A; and either have step 0 land compile-only stubs for every
  cross-package seam (types plus throwing/identity bodies: `linuxSystem`, `programsOf`, `LAUNCHERS`, `DesktopApp.argv`,
  `CLIPBOARD_FORMATS.linux`, the optional option fields) or state that P1-A and P1-C rebase onto the merged
  predecessors before their final checks and report.
- Where: §1.3, §4.21, §11.2 (merge order paragraph and the step 0 row).

### 13. Exported key helpers keep the Linux conventions; the worker calls them without `kc`
- Problem and evidence: §2.4/§4.9 thread `kc` through `canonicalKeys`/`keyFamily` at worker.ts:461,483,519 and through the
  PolicyEngine, but the worker also calls the exported helpers `typedChar` (worker.ts:462,517,2675,3084),
  `replacesSelection` (:465), `isActivatingKey` (:2669) and `takesFormula`, which call `canonicalKeys(keys)` with the
  Linux default (policy.ts:509,587,600-614). On macOS `cmd+v` then canonicalises to `super+v`: `replacesSelection` says
  no, so the worker's own selection tracking (`afterKeys`, `this.keyed`) and the `afterSelectAll`/`ownText` facts it
  sends to the policy are wrong, and the policy judges a paste over a whole selection without knowing it.
- Severity: minor (macOS only; Linux defaults unchanged).
- Fix: every exported key helper in policy.ts takes `kc: KeyConventions = KEYS.linux` (`isActivatingKey`, `typedChar`,
  `typesCharacter`, `replacesSelection`, `keyLabel`, `normalizeKeys`) and the worker passes `this.sys.keys` at each
  call above; `afterKeys(keys, typed, selected, kc = KEYS.linux)` keeps its exported signature for
  worker-tools.test.ts. P1-C's worker-platform test: darwin `cmd+a` then `cmd+v` marks the field replaced.
- Where: §2.4 (policy bullet list), §4.9.

### 14. Electron objects handed over before `ready` and before `setName`/`setPath`
- Problem and evidence: §4.1 item 1 calls `loadPlatform({ electron: { app, screen, desktopCapturer, … } })` at module load, before
  `app.setName("ember")` and `app.setPath("userData", …)` (main.ts:75-77) and long before `ready`. Electron's `screen`
  export is a Proxy that throws on *any* property access before `ready`, so a composition that feature-tests
  `screen.screenToDipRect`, destructures a method, or logs `deps` at construction crashes Ember at start on every OS
  (Linux included, since `linuxPlatform` gets the same object). Likewise anything that reads `app.getPath(...)` or
  `app.getName()` while being constructed captures pre-`setPath` values.
- Severity: minor (no Linux change if implemented as described; a cheap guard against a start-up crash).
- Fix: state the rule in §2.1 (`PlatformDeps`): constructors and `loadPlatform` touch no property of `screen`,
  `desktopCapturer` or `powerMonitor` and call no `app.getPath`; only `openWindows`/`openInput`/probes do. Add to
  platform-index/platform-linux (P1-A) and win32-platform/darwin-platform (WS/MS) tests: `loadPlatform` with a
  `screen` Proxy whose `get` throws, and an `app.getPath` that throws, does not throw.
- Where: §2.1 (PlatformDeps doc), §4.1 item 1, §11.2/§11.3 tests.

### 15. Wording in §4 that an implementer could read as a Linux change (pin each one)
- Problem and evidence, each small:
  (a) §4.21 "`KEY_NAMES` (:99) from `KEYS[os].labels`": copy.ts:97-101 has 30 entries (Enter, Esc, Page Up…);
      `KEYS.linux.labels` has 4. A replacement would change every "What Ember did" key line on Linux.
  (b) §4.10 rebuilds rule 3 and rule 4 of `WORKER_RULES`; test/integration/persona.test.ts:70 asserts
      `toContain(WORKER_RULES)`. If the export becomes a template or loses rule 4's desk line, the el8 suite fails.
  (c) §1.3 allowed change 3 says nothing changes "on a Linux host with Xvfb, xauth and dbus-daemon", but
      `this.d.desk` is also undefined when the admin policy sets `features.desk: false` (main.ts:1270), so the
      "Try open_on_desk." hints and the prompt's desk sentence change there too.
  (d) §4.1 `runDoctor`: `platform.openInput(ws, log)` logs `xtest.unavailable`, which today's doctor path never
      logged (main.ts:172), and the design drops `xin?.close()` (main.ts:203).
  (e) §4.1 items 8 and 14 test `platform.os === "win32"` / `=== "linux"` in main.ts. Legal under D1, but they make
      main the place that knows "Windows renames need retries" and "only X11 re-reports a grabbed chord"; I would then
      edit main for every new OS rule.
  (f) §2.1's notes drop D1's `WindowSystem.isOwnWindow` and `activate` (own windows by `pid === process.pid`;
      activation stays on `Input`). Reasonable, but it is a deviation from a binding decision and isn't listed as one.
- Severity: minor.
- Fix: (a) "merge: `{ ...KEY_NAMES, ...KEYS[os].labels }`", plus a P1-E test that Linux `keyLabel` output is unchanged
  for every KEY_NAMES key. (b) "`WORKER_RULES`, `WORKER_IDENTITY`, `GUIDE_*`, `IDENTITY`, `TOOL_RULES` stay exported
  with today's exact text (the Linux, desk-on, all-settings rendering)". (c) Reword allowed change 3: "…only when the
  desk is offered (Xvfb, xauth, dbus-daemon present and the admin policy doesn't turn it off)". (d) Linux `openInput`
  takes `{ quiet?: boolean }` or the doctor keeps calling the adapter without logging; keep the `close()` calls.
  (e) `system.settingsRenameRetries: number` and `windows.chordReReported: boolean` (or `keysDownMeaningful`). (f) List it
  in §12.1 as a D1 deviation for the lead.
- Where: §1.3, §2.1, §4.1, §4.10, §4.21, §12.1.

## Checked and found sound (no action)

- Shortcut strings: every Linux string built from `SHORTCUTS.linux` equals today's literal: greeting (main.ts:368-374),
  menu labels (main.ts:444, `accel.replace("Control","Ctrl")` = `label`), question hints and spoken text
  (main.ts:565-568), environment ok text and taken list (environment.ts:115-118), registration order
  (main.ts:1122-1136). `canonicalKeys(accel)` gives each OS's `chord`, and each chord is a system key on its OS.
- Approval chord: Linux is unchanged (policy.ts:562-572 ctrl+alt rule; XGrabKey and XTest both resolve the keysym
  through XKeysymToKeycode); Windows is covered by the `super` rule (policy.ts:566) and `KEYEVENTF_UNICODE` typing
  can't fire `RegisterHotKey`; press_keys is the only tool that presses modifiers (worker.ts:2717), and
  `answerKey` also requires the arm delay and `!borrow.driving` (confirm.ts:114, main.ts:1193). macOS: item 1.
- Electron-import rule: no plain-Node module in the design imports `electron`; everything comes through the
  structural types of §2.1. `platform/linux/overlay-shaper.ts` is imported by overlay.ts (allowed) and linux/index.ts.
- Linux adapters: `openLinuxWindows` keeps the `$DISPLAY` gate, `toDip`/`toDipPoint`/`screenBounds` match
  main.ts:1059-1060,1172-1178; overlay shaper reproduces applyHits (overlay.ts:209-231) and
  test/unit/overlay-shape.test.ts still passes (it fakes koffi in the require cache, so the shaper's xshape import
  is the same module instance); `captureRect` stays synchronous for a sync capture; `platformDialog()` is false on
  Linux and on the desk (desk/agent.ts:242-249's facade exposes only the helper's real X11 methods).
- AtspiSidecar: port/host's 5th parameter (wt/host perception/sidecar.ts:236) leaves the Python launch, env and
  timeouts byte-for-byte when `launch` is undefined; main's `undefined, undefined` for `python`/`env` keeps
  `pickPython()`/`process.env`.
- Eval and integration tests: eval/src/runner.ts constructs Perception/PolicyEngine/Worker/CursorBorrow with the
  defaults the design keeps Linux (`x11: X11` satisfies `PerceptionWindows`); persona, worker-safety and desk suites
  keep today's text and keystrokes provided items 4, 5 and 15(b) are applied. port/packaging's Linux layout excludes
  `ax-sidecar.cjs` (wt/packaging scripts/package/layout.mjs:56), so the RPM is unchanged.
- Ownership: Phase 1 files are disjoint from each other and from PH/PV/PK/PT; the remaining overlaps are in item 11.
