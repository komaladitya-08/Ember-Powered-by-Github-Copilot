# Ember on Windows and macOS: the implementation design

Status: binding design for the port, **revision 2** (after the Linux, Windows and macOS critiques; every finding and
its resolution is listed in "Critique resolutions" at the end, and what the in-flight packages must change is in
"Corrections for running packages"). It follows `decisions.md` (D1-D11) wherever a spec disagrees, except for the
departures listed just below, and settles the contradictions listed in `gaps.md` (C1-C17, G1-G22). Repository:
`/home/user/Ember-Powered-by-Github-Copilot`, branch `ember-improve/20261022-windows-macos`. Revision 1 was written
against `e89a93f` (the interim contract `app/main/platform/types.ts` on top of `b67b02e`); unless a reference says
otherwise, every `file:line` in §1-§12 is from that tree. Revision 2 was checked against the branch tip `b3a8fd5`, on
which port/packaging, port/testport, port/win32, port/uia, port/darwin and port/voice **have already merged**; only
port/host (`/home/user/wt/host`, `30ec143`) is still in flight. Paths such as `app/main/platform/darwin/windows.ts` and
`sidecar/uia/ember_uia.cs` therefore exist on the branch now.

## Departures from decisions

Each is the smallest change that keeps the decision's intent; the lead may veto any of them.
1. **D8, macOS inner executable.** D8 says to keep `Contents/MacOS/Electron` "unless renaming is proven safe". Keeping
   it is unworkable: Electron's `app.isPackaged` is `false` for any executable named "electron", which would switch on
   main.ts's development overrides (every `EMBER_*` dev variable, `--inspect`) in an installed Ember. port/packaging
   (`740c547`, `scripts/package/layout.mjs:88-92`) already renames it to `Contents/MacOS/Ember` with
   `CFBundleExecutable` = `Ember`; the helper apps keep Electron's names (Electron looks for "Electron Helper" first).
   The design names `Ember.app/Contents/MacOS/Ember` everywhere (finding M20).
2. **D1, `WindowSystem.activate` / `isOwnWindow` / `focusInput`.** D1 lists them on `WindowSystem`; this design keeps
   activation and `focusInput` on `Input` (XInput's method set, which D1 also keeps, already has `activate` and
   `focusInput?`), and tells Ember's own windows apart by `pid === process.pid` on every OS instead of an
   `isOwnWindow` member. Two owners of one operation would drift; port/win32's `Win32WindowSystem.activate` stays an
   extension that main doesn't call (finding L15f).
3. **D3, PSModulePath.** D3 says to strip `PSModulePath` from the bridge's environment. Deleting it makes Windows
   PowerShell 5.1 rebuild a default that includes the user's `Documents\WindowsPowerShell\Modules` (often
   OneDrive-redirected), so the bridge's environment **sets** it to `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`
   instead: the same intent (no user modules), deterministic (finding W18a; correction for port/host's `bridgeEnv`).
4. **D10, supplemented, not replaced.** D10's grants stay. They can't show which TCC client a user's Ember needs,
   because the macos-15 image already grants Accessibility and Screen Recording to the runner's own ancestors, which
   every step inherits as its responsible process. CI therefore adds one run of the packaged app through LaunchServices
   (`open -n -W -a Ember.app --args --doctor`) before and after Ember's own bundle row is written with its real code
   requirement, plus the PostEvent/ListenEvent/AppleEvents/replayd grants (finding M4, §10 item 3).
5. **D2, Windows `inner`** (carried from revision 1, not raised by the critics, listed for completeness). D2 says
   `inner` = DWM extended frame bounds; merged port/win32 reports the DWM frame as the window's `x/y/width/height` and the
   client area as `inner` (`outer` = GetWindowRect as D2 says). Nothing is lost: `matchFrame`
   (perception/windows.ts:39) tries `outer`, `inner` and `x/y/width/height`, so the DWM frame is still matched, and the
   client area is the more useful `inner`.

Reading order for implementers: §1 (phases), §11 (your work package and the files you own), then the sections your
package names. The TypeScript in §2 is normative: copy it verbatim, then add only what your package needs (a new
member must be optional, and must be listed in your final report so the integration package can review it).

Conventions that apply to every file written for this port (owner's rules): strict TS with `noUnusedLocals`;
`import type` for types; double quotes, semicolons, 2-space indent; a module doc comment on every file stating the
constraint behind it; JSDoc on exports; kebab-case file names; log events `area.snake_case`; British spelling in UI,
docs and comments; UI copy in sentence case; safety rules fail closed. `electron` may be imported only in `main.ts`,
`windows.ts`, `overlay.ts`, `handle.ts`, `ask.ts`, `voice.ts`, `revive.ts`, `desk/view.ts` and preloads. Everything
else, including `app/main/platform/**` and `app/sidecar-host/**`, loads under plain Node and takes Electron objects by
injection through **structural** types (as the committed `ScreenLike` and `OwnWindowHandle` do; no `import type` from
`"electron"` in plain-Node modules). Never call `koffi.view()`; load koffi lazily with
`createRequire(__filename)("koffi")` inside an `open…()`/`bind()` function, never at import time, so every module
imports on every OS and in unit tests; bind each library once per module (memoise the bindings object); koffi type
names are process-wide, so prefix every `koffi.struct`/`koffi.proto`/`koffi.union` name with the module's tag
(`W32Ws_RECT`, `MacIn_CGPoint`, `AxCf_CFRange`, `W32Sys_FILETIME`). Win32 `BOOL` is `int`. Every `koffi.load` is guarded
so a missing library yields null or a safe default.

Baseline in this container (before any change): `typecheck` 0, `lint` 0, `vitest` 55 files pass, 1 skipped, and
`test/unit/desk.test.ts` fails only because the Electron binary isn't installed here (it imports `desk/view.ts`, which
imports `electron`). Acceptance for every package: no new failures, typecheck and lint clean, and its own new tests.

---

## 1. Overview and the phases of work

### 1.1 Target shape

```
app/main/platform/               the one composition root (D1); nothing outside it tests process.platform
  types.ts                       the contract (§2.1): the committed interim file, extended
  index.ts                       loadPlatform(deps): Platform, by process.platform only
  os.ts                          HOST_OS (the only process.platform read outside index.ts; for data defaults)
  compose.ts                     helpers shared by the per-OS compositions (withSystemDialog, cleanEnv, hoverShaper)
  which.ts                       portable which() (path.delimiter, PATHEXT, extra folders)
  linux/                         adapters over today's modules (x11.ts, xshape.ts, hands/*, admin, autostart, audit…)
  win32/                         port/win32's window system + input (merged) and, beside it,
    platform.ts  system/**         the Windows composition and SystemPlatform (package WS)
  darwin/                        port/darwin's window system + input + cf/ax/cg bindings (merged) and, beside it,
    platform.ts  electron-capture.ts  system/**   the macOS composition, desktopCapturer capture, SystemPlatform (package MS)
                                 (the host's launch is port/host's app/sidecar-host/launch.ts hostLaunch(); no second copy here)
app/shared/shortcuts.ts          the shortcut table (D6) and per-OS key conventions (primary modifier)
app/shared/words.ts              platform words for prompts and copy
app/shared/never-look.ts         never-look defaults and their display names, keyed by OS
app/main/policy/vocabulary.ts    security-window, browser/mail/office and risky-label vocabularies, keyed by OS
app/main/hands/terminals.ts      terminal and built-in-shell vocabularies, keyed by OS
app/sidecar-host/                the shared TypeScript accessibility host → dist/app/ax-sidecar.cjs (D3; port/host)
  providers/uia.ts               client for the C# bridge (port/host)
  providers/ax-darwin*.ts        the macOS AX provider (package AX)
sidecar/uia/ember_uia.ps1 .cs    the thin C# 5 UI Automation bridge, hosted by Windows PowerShell 5.1 (port/uia)
sidecar/atspi/ember_atspi.py     unchanged (Linux)
```

Runtime picture per OS:

| | Linux (unchanged) | Windows 10 22H2+/11 | macOS 13+ |
|---|---|---|---|
| Window system | `x11.ts` (libX11) via `linux/window-system.ts` | `openWin32Windows({ screen })` (user32, dwmapi) | `openDarwinWindows({ screen, capture, screenAccess })` (CGWindowList, AX at 0.25 s) |
| Input | `hands/input.ts` (XTest) | `openWin32Input()` (SendInput) | `openDarwinInput()` (CGEvent, suppression 0) |
| Capture | XGetImage (sync) | GDI BitBlt SRCCOPY\|CAPTUREBLT (sync) | Electron `desktopCapturer`, resampled to points (async, §8.2) |
| Overlay click-through | XShape input region | hover polling, `forward: false`, `type: "toolbar"` (overlay, handle and ask box) | hover polling, `forward: true`, `type: "panel"` (overlay, handle and ask box), no `setVisibleOnAllWorkspaces` call |
| Accessibility helper | Python AT-SPI sidecar | `Ember.exe` (`ELECTRON_RUN_AS_NODE=1`) runs `ax-sidecar.cjs` → spawns `powershell.exe … ember_uia.ps1` (C# UIA bridge) | `Ember.app/Contents/MacOS/Ember` (`ELECTRON_RUN_AS_NODE=1`) runs `ax-sidecar.cjs` with the in-process koffi AX provider |
| Screen units | X root pixels | physical virtual-screen pixels (PMv2) | points |
| Desk (tier 2) | Xvfb desk | none (`Platform.desk = null`) | none |
| Shortcuts | Ctrl+Alt+{Space,X,E,M,Y,N} | Win+Alt+{…} | Control+Shift+Command+{…} |

### 1.2 Step 0: the contract commit (lead, before any new package starts)

One commit on the branch, made by the lead from this document, so that every later package compiles against the same
shapes and no two packages create the same shared file:
- `app/main/platform/types.ts`: the committed interim file extended exactly as §2.1 (its existing names and members
  untouched; additions only).
- `app/main/platform/os.ts` (§2.1, eight lines).
- `app/shared/shortcuts.ts` (§2.2) and `app/shared/words.ts` (§2.3), complete for all three OSes.
- `app/main/environment.ts`: only widen `Check.fix` to `FixId` (re-exported from types.ts); no logic change.
- `app/main/hands/system.ts`: only the two type-only members `argv?: string[]` and `programs?: string[]` on
  `DesktopApp` (so §2.1's `AppIdentity` compiles; P1-D then owns the file and fills in their use).
The step 0 commit runs `npx tsc --noEmit`, `npm run lint` and `npm test`, and all three must stay green (they only add
types and pure data). Step 0 adds no function stubs: packages that use another Phase 1 package's functions rebase
before their final checks (§11.2).

### 1.3 Phase 1: the platform layer, on Linux, with zero behaviour change

Goal: every OS-specific call in the main process goes through `Platform`; Linux behaves byte-for-byte as before (same
log events, same model-facing text, same keystrokes, same sidecar launch). Phase 1 **wraps**, it does not rewrite:
`x11.ts`, `xshape.ts`, `hands/input.ts`, `hands/keybuffer.ts`, `hands/clipboard-handoff.ts`, `hands/system.ts`,
`autostart.ts`, `admin.ts`, `policy/audit.ts`, `environment.ts`, `doctor.ts`, `desk/*` keep their logic; their call
sites move behind the platform object, and they gain optional parameters whose defaults are today's behaviour. Phase 1
also creates every OS-keyed **data** module (`never-look.ts`, `policy/vocabulary.ts`, `hands/terminals.ts`,
`clipboard formats`) with the Linux rows moved verbatim and the Windows/macOS rows **empty** (package V fills them),
and makes `environment.ts`/`doctor.ts` handle the Windows and macOS inputs (pure code, testable on Linux).

Allowed Linux-visible changes in Phase 1 (each listed in §4 with its reason; nothing else may change):
1. `windows.ts` `isTrustedSender` tests the file URL's pathname for `/renderer/` instead of
   `${path.sep}renderer${path.sep}` (identical on Linux, where `path.sep === "/"`).
2. `agent/auth.ts` `TokenStore.save` returns `false` instead of throwing when `safeStorage.encryptString` throws (error
   path only; today that exception escapes into the sign-in flow).
3. Model-facing text that names `open_on_desk` appears only when the desk is offered (D5): on Linux, when Xvfb, xauth
   and dbus-daemon are present **and** the admin policy doesn't turn the desk off (`features.desk !== false`,
   main.ts:1270). Where the desk is offered nothing changes; where it isn't (tools missing, or the policy's switch) the
   stale "Try open_on_desk." hints and the prompt's desk sentence go. The exported constants (`WORKER_RULES` and the
   rest, §4.10) keep today's exact text.
4. The settings-window line "…and in the system journal (`journalctl -t ember-audit`)" shows only when the journal sink
   exists (G7; today it always shows, also where there is no systemd-cat).
5. `worker-persona.ts` rule 3 lists only the settings `available` (on Linux: all six, so identical).

Nothing else may change on Linux, including what the policy accepts: Linux key parsing gains no new spellings
(`mod+s`, `primary+a`, `cmdorctrl+v` still answer "Ember's keyboard doesn't know that key combination"), takeover
detection keeps today's tolerance, and the doctor logs nothing it didn't log before.

Phase 1 is five packages on disjoint files (P1-A … P1-E, §11.2) that start after step 0 (port/testport has merged),
run in parallel and code against §2 and §4. They merge in the order P1-B and P1-D, then P1-E and P1-C, then P1-A (the
only owner of `main.ts`) last; a package whose code calls another Phase 1 package's new functions rebases onto it before
its final `tsc`/lint/test run (§11.2).

### 1.4 Phase 2: backends, in parallel

Already in flight (D11), adopted as they are apart from the listed corrections: **port/win32** (PW), **port/darwin**
(PD), **port/uia** (PU), **port/host** (PH), **port/packaging** (PK), **port/voice** (PV), **port/testport** (PT); all
but PH have merged. Their corrections ("Corrections for running packages", at the end) are applied by the lead: PH's
before it merges, the merged packages' as one follow-up commit per package (**FX-PW**, **FX-PD**, **FX-PU**,
**FX-PK**), each before the package that depends on it (§11.3). Added by this design, after step 0: **WS** (Windows
SystemPlatform and composition), **MS** (macOS SystemPlatform, composition and the desktopCapturer capture), **AX** (the
macOS AX provider for the host, after PH and PD merge), **V** (Windows and macOS vocabularies and copy, after Phase 1
merges). Each writes unit tests that run on Linux with fakes, and integration
tests that run on the target OS in CI, gated by `EMBER_WIN32_TEST`, `EMBER_UIA_TEST`, `EMBER_DARWIN_TEST`,
`EMBER_AX_TEST`, `EMBER_WINSYS_TEST`, `EMBER_MACSYS_TEST` (fail, not skip, when set and the facility is missing). A
check the runner can't exercise (Windows Server 2022 has no Store apps and runs the job elevated; one 1024×768 screen;
the macOS runner's TCC ancestry) is reported as "not testable on this runner: <reason>" from the facts the job prints
first, never passed vacuously (§10 item 10), and is listed in §12.3.

### 1.5 Phase 3: integration, then docs

One package (**I**, §11.5) switches the Windows and macOS platform objects on in `platform/index.ts`, owns the
post-merge maintenance of `platform/win32/**` and `platform/darwin/**` outside WS/MS files, applies the interface
additions the Phase 2 packages reported, drops `--allow-missing-sidecar` and makes the CI integration steps required
(§10), and runs the manual test plan (§12.3) on real machines. **DOC** (§11.6) then updates `PLAN.md` (D9: §1, §2
rows, milestone M11 with task ids, §9, §10), `README.md` and `docs/DEVELOPING.md`.

---

## 2. Interfaces

### 2.1 `app/main/platform/types.ts` (normative; step 0, lead; later changes only through I)

The first part is the committed interim contract, **verbatim**, except that its doc comment gains one paragraph, its
imports and re-exports grow, and `WindowSystem` gains one optional member (`systemDialogOpen`); everything after the
`Input` interface is new. Members marked **Linux only** say what Windows and macOS give instead.

```ts
/**
 * The contract every OS backend implements (Linux X11, Windows, macOS). The rest of Ember talks to the desktop only
 * through these shapes, so each backend keeps X11's names and conventions: window and key vocabularies stay as they
 * were on Linux, and the Linux backend is the existing X11 code unchanged.
 *
 * Conventions every backend keeps:
 * - Units: "native" screen units. Linux and Windows use physical pixels; macOS uses points (what CGEvent,
 *   CGWindowList, AX and Electron's screen all use). Coordinates may be negative on Windows and macOS (a monitor left
 *   of or above the primary one).
 * - Window ids are numbers in one space per backend: the X client window (Linux), the HWND (Windows), the CGWindowID
 *   (macOS). They are compared with ===, so every member that returns or takes a window uses the same space.
 * - App names (`wmClass`): Linux keeps WM_CLASS ("gedit gedit"). Windows uses the program's file name without
 *   ".exe" as the system reports it ("notepad", "msedge"); for a UWP app's frame (ApplicationFrameHost) it is the
 *   hosted app's program. macOS uses the app's localized name ("TextEdit"). The accessibility sidecar reports the same
 *   name in its `app` field, so policy, never-look and grants match on both.
 * - Keys are named by X keysym names ("Return", "Control_L", "a") and keysym numbers. Key codes are opaque per backend
 *   (never 0). Mouse buttons use X's numbers (1 left, 2 middle, 3 right, 4–7 wheel) and X's button-mask bits (256 left,
 *   512 middle, 1024 right).
 *
 * Beyond the window system and input, one Platform object (loadPlatform() in ./index.ts, chosen by process.platform
 * alone, never by $DISPLAY) carries every other OS-specific piece: overlay shaping, the accessibility helper's launch,
 * system integration, the desk. Types only, and Electron only as structural shapes, so plain-Node modules (perception,
 * agent, policy, hands, desk, the sidecar host) may import this file.
 */

import type { X11, X11Image, Rect } from "../x11";
import type { XInput } from "../hands/input";
import type { KeyBuffer } from "../hands/keybuffer";
import type { HandoffResult } from "../hands/clipboard-handoff";
import type { DesktopApp, SettingName } from "../hands/system";
import type { AdminPolicy, LoadedAdminPolicy } from "../admin";
import type { EnvInputs } from "../environment";
import type { DeskManager } from "../desk/desk";
import type { DeskPlace } from "../desk/place";
import type { Logger } from "../logger";
import type { KeyConventions, OS, ShortcutTable } from "../../shared/shortcuts";
import type { PlatformWords } from "../../shared/words";

export type { Rect, X11Image };
export type { StackedWindow, X11Window } from "../x11";
export type { KeyConventions, OS, PlatformWords, ShortcutTable };

/** The part of Electron's `screen` a backend needs (injected: platform code below main.ts doesn't import electron). */
export interface ScreenLike {
  getPrimaryDisplay(): { bounds: Rect; scaleFactor: number };
  getAllDisplays(): { bounds: Rect; scaleFactor: number }[];
  /** Windows only (Electron): physical screen rectangle → DIP. */
  screenToDipRect?(window: null, rect: Rect): Rect;
  /** Windows only (Electron): physical screen point → DIP. */
  screenToDipPoint?(point: { x: number; y: number }): { x: number; y: number };
  /** Windows only (Electron): DIP point → physical screen point. */
  dipToScreenPoint?(point: { x: number; y: number }): { x: number; y: number };
}

/** What a backend needs to know about one of Ember's own BrowserWindows (structurally typed). */
export interface OwnWindowHandle {
  getNativeWindowHandle(): Buffer;
  getMediaSourceId(): string;
}

/**
 * The window system: X11's members, plus what X11 code got from Electron or assumed.
 * `capture` may answer asynchronously (macOS captures through Electron's desktopCapturer).
 */
export interface WindowSystem extends Omit<X11, "capture"> {
  /** "x11" | "win32" | "darwin". */
  readonly kind: "x11" | "win32" | "darwin";
  /** False where compositing can't come and go (Windows, macOS): the 2 s compositor watch isn't needed. */
  readonly compositorMayChange: boolean;
  capture(x: number, y: number, width: number, height: number): X11Image | null | Promise<X11Image | null>;
  /** The id of one of Ember's own windows in this backend's window-id space (0 when it can't be told). */
  windowId(win: OwnWindowHandle): number;
  /** Native screen rectangle → Electron DIP (Linux: ÷ primary scale; Windows: per monitor; macOS: identity). */
  toDip(rect: Rect): Rect;
  /** Native screen point → Electron DIP. */
  toDipPoint(point: { x: number; y: number }): { x: number; y: number };
  /** Every display together, in native units. */
  screenBounds(): Rect;
  /**
   * (Added by the design; optional.) A system authentication surface is up, or may be: Windows, the input desktop isn't
   * "Default" (UAC, Ctrl+Alt+Del, lock screen) or a credential prompt window is on screen; macOS, a SecurityAgent /
   * coreautha window is on screen or secure keyboard entry is on (or can't be checked). Fails closed (true when it
   * can't tell). port/darwin implements it natively; the Windows composition adds it with withSystemDialog (§2.5, §7.2).
   * Absent on Linux, where GNOME Shell's own dialogs come from the sidecar's shell_overlays. Perception ORs it with
   * shell_overlays.
   */
  systemDialogOpen?(): boolean;
}

/**
 * Synthetic input: XInput's members (Linux XTest), so CursorBorrow and its fakes work unchanged. The optional
 * additions let Windows and macOS do what X11 does differently.
 */
export interface Input extends XInput {
  /**
   * Types one character whatever the keyboard layout (Windows KEYEVENTF_UNICODE, macOS
   * CGEventKeyboardSetUnicodeString). False when the backend can't.
   */
  textKey?(ch: string, down: boolean): boolean;
  /** Is this point on some display (negative coordinates are valid off Linux)? Replaces "inside screenSize()". */
  onScreen?(x: number, y: number): boolean;
  /**
   * Why input can't reach `window`, or null when it can (Windows: the window belongs to an elevated program and UIPI
   * would silently drop Ember's input; macOS: Ember lacks the Accessibility permission, or secure input is on).
   */
  blockedReason?(window: number): string | null;
  /**
   * (Added by the design; optional.) True when posted pointer moves and keys become visible asynchronously (macOS
   * CGEventPost): CursorBorrow's takeover check may also accept the previous step's position, and main's Confirmer
   * refuses an approval chord within 500 ms of Ember's last posted key. Absent (Linux XTest, Windows SendInput): today's
   * code, verbatim.
   */
  readonly pointerLags?: boolean;
}

// ───────────── Everything below is added by the design ─────────────

/** What Perception needs of a window system. The desk's remote X11 facade (desk/agent.ts) satisfies it structurally. */
export type PerceptionWindows = Pick<WindowSystem, "activeWindow" | "focusWindow" | "clientWindows" | "stack" | "capture" | "systemDialogOpen">;

/**
 * Keys held when an ask-shortcut callback runs (WindowSystem.keysDown, freshAskPress). Every backend answers it, but
 * main uses it only on Linux, where X re-reports a grabbed shortcut when its grab ends; elsewhere main passes null
 * (trusted and debounced, G6; §4.1).
 */
export type ChordState = { control: boolean; alt: boolean; space: boolean };

// ───────────── Electron, as structural shapes (injected by main.ts) ─────────────

/** A display as Electron's screen reports it (DIP bounds; macOS: points). */
export interface DisplayLike { id: number; bounds: Rect; scaleFactor: number; size: { width: number; height: number } }

/** Electron's screen as the macOS capture needs it (display ids, to match desktopCapturer sources). */
export interface CaptureScreen extends ScreenLike { getAllDisplays(): DisplayLike[] }

/** The part of Electron's NativeImage the capture uses. */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: Rect): NativeImageLike;
  resize(o: { width: number; height: number; quality?: "good" | "better" | "best" }): NativeImageLike;
  /** BGRA on Windows and macOS (Chromium's kN32 is BGRA on little-endian desktops); verify in CI (§8.2). */
  toBitmap(): Buffer;
}

export interface DesktopCapturerLike {
  getSources(o: { types: ("screen" | "window")[]; thumbnailSize?: { width: number; height: number }; fetchWindowIcons?: boolean }):
    Promise<{ id: string; name: string; display_id: string; thumbnail: NativeImageLike }[]>;
}

export interface LoginItemSettingsLike {
  openAtLogin: boolean;
  /** darwin. */ wasOpenedAtLogin?: boolean;
  /** darwin: "not-registered" | "enabled" | "requires-approval" | "not-found". */ status?: string;
  /** win32. */ executableWillLaunchAtLogin?: boolean;
  /** win32. */ launchItems?: { name: string; path: string; args: string[]; enabled: boolean }[];
}

export interface AppLike {
  readonly isPackaged: boolean;
  getPath(name: "appData" | "home" | "temp" | "exe" | "userData"): string;
  getAppPath(): string;
  getVersion(): string;
  isAccessibilitySupportEnabled(): boolean;
  setAppUserModelId?(id: string): void;
  setLoginItemSettings(s: { openAtLogin: boolean; path?: string; args?: string[]; enabled?: boolean; name?: string }): void;
  getLoginItemSettings(o?: { path?: string; args?: string[] }): LoginItemSettingsLike;
  focus(o?: { steal: boolean }): void;
  isInApplicationsFolder?(): boolean;
  moveToApplicationsFolder?(): boolean;
}

export interface SystemPreferencesLike {
  getMediaAccessStatus?(t: "microphone" | "camera" | "screen"): "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  askForMediaAccess?(t: "microphone" | "camera"): Promise<boolean>;
  isTrustedAccessibilityClient?(prompt: boolean): boolean;
  getAnimationSettings(): { prefersReducedMotion: boolean };
}

export interface ShellLike {
  openExternal(url: string): Promise<void>;
  /** win32 only. */ writeShortcutLink?(p: string, op: "create" | "update" | "replace", o: { target: string; args?: string; appUserModelId?: string; description?: string }): boolean;
}

export interface PowerMonitorLike { on(event: "shutdown", fn: () => void): unknown }

/** The part of Electron's BrowserWindow class the macOS window system uses (focusWindow() reports Ember's own panel). */
export interface BrowserWindowStatic { getFocusedWindow(): OwnWindowHandle | null }

/** The Electron pieces backends may use; main passes them in (plain-Node modules never import electron). */
export interface ElectronParts {
  app: AppLike;
  /** Only used after app ready. Electron's `screen` throws on any property access before ready. */
  screen: CaptureScreen;
  desktopCapturer: DesktopCapturerLike;
  systemPreferences: SystemPreferencesLike;
  shell: ShellLike;
  powerMonitor: PowerMonitorLike;
  /** Electron's BrowserWindow class (darwin passes `() => browserWindow.getFocusedWindow()` as focusedOwnWindow). */
  browserWindow: BrowserWindowStatic;
}

/**
 * What loadPlatform() gets. Rule for every composition (unit-tested with a `screen` Proxy whose every property access
 * throws and an `app.getPath` that throws): loadPlatform() and the per-OS constructors touch no property of `screen`,
 * `desktopCapturer`, `powerMonitor` or `browserWindow` and call no `app.getPath`/`app.getName`; only openWindows(),
 * openInput(), sidecarLaunch() and the probes do, and main calls those after ready (and after setName/setPath).
 */
export interface PlatformDeps {
  electron: ElectronParts;
  packaged: boolean;
  /** process.execPath (Ember's own binary: the sidecar host runs as it, ELECTRON_RUN_AS_NODE=1). */
  execPath: string;
  appPath: string;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
}

// ───────────── Overlay and Ember's floating windows ─────────────

export type FloatingKind = "overlay" | "handle" | "ask" | "desk-view";

export interface FloatingWindow {
  /** Spread last into the window's BrowserWindow options. linux: {} (today's options exactly). */
  readonly options: { type?: "toolbar" | "panel"; acceptFirstMouse?: boolean; hiddenInMissionControl?: boolean; roundedCorners?: boolean; thickFrame?: boolean };
  /**
   * Replaces the window class's own setVisibleOnAllWorkspaces call: null → no call; "plain" → setVisibleOnAllWorkspaces(true);
   * an object → setVisibleOnAllWorkspaces(true, object). linux: exactly today's call (overlay
   * { visibleOnFullScreen: true }, handle "plain", ask and desk-view null); win32: null for every kind; darwin: null for
   * every kind (Electron's macOS call transforms the process type: Dock icon, menu bar and focus, §8.3).
   */
  readonly allWorkspaces: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean } | "plain" | null;
}

export interface OverlayShaper {
  /**
   * Restricts `win`'s input to `rects` (window-local DIP; `scale` = its display's scaleFactor). true only with a real
   * input region (linux XShape). win32/darwin return false, and OverlayManager's hover polling runs.
   */
  setInputRegion(win: OwnWindowHandle, rects: readonly Rect[], scale: number): boolean;
  /** Closes what setInputRegion keeps open (OverlayManager.stop). */
  release(): void;
  /**
   * Click-through windows call setIgnoreMouseEvents(true, { forward: true }) when this is true (darwin), else
   * setIgnoreMouseEvents(true) with no options exactly as today (linux, and win32 where forward would install a
   * low-level mouse hook on Electron's UI thread).
   */
  readonly forward: boolean;
  floating(kind: FloatingKind): FloatingWindow;
}

// ───────────── Linux-only helpers ─────────────

/** Linux only (an X keyboard grab while the ask box opens). Platform.keyboardHold is null on win32 and darwin. */
export type KeyboardHold = (o: { log?: (event: string, fields: Record<string, unknown>) => void }) => KeyBuffer | null;

/** Linux only (freedesktop clipboard-manager hand-off, X PRIMARY). Platform.clipboard is null on win32 and darwin. */
export interface ClipboardBridge {
  /** An X id of one of Ember's windows, for telling its clipboard apart; 0 without $DISPLAY (today's gate, main.ts:1017). */
  ownerId(win: OwnWindowHandle): number;
  handOff(ourWindow: number): Promise<HandoffResult>;
  readSelection(sameClientAs: number): Promise<string>;
}

// ───────────── Accessibility helper launch ─────────────

export interface SidecarContext {
  /** dist/app (main.cjs's folder): ax-sidecar.cjs and desk-agent.cjs live here. main passes __dirname. */
  appDir: string;
  appPath: string;
  resourcesPath: string;
  packaged: boolean;
  userData: string;
  execPath: string;
}

/**
 * How AtspiSidecar starts its helper (port/host's `launch` option; structurally identical to it, and built by port/host's
 * `hostLaunch()` in app/sidecar-host/launch.ts, §5.1). Absent → today's `pickPython()` + ember_atspi.py with PYTHON*
 * variables, unchanged.
 */
export interface SidecarLaunch {
  command: string;
  args: string[];
  /** The child's whole environment; AtspiSidecar adds EMBER_ATSPI_ID_BASE. */
  env: NodeJS.ProcessEnv;
  /** Timeout for requests written before the process has answered anything (cold start, C14). Absent: the request's own 5000 ms. */
  firstRequestMs?: number;
  /** win32: true, so no console window appears for the helper (G1). */
  windowsHide?: boolean;
}

// ───────────── System integration ─────────────

/**
 * What the terminal and shell checks look at: DesktopApp's identity (hands/system.ts; `argv`/`programs` are the
 * type-only members step 0 adds) plus, for a window, its Win32 class (Windows console hosts, §9.11).
 */
export type AppIdentity = Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "categories" | "terminal">> & { argv?: string[]; windowClass?: string };

export interface AppCatalog {
  /** Installed apps (cached; at most about 1 s cold). linux: XDG .desktop files; win32: Start Menu .lnk + AppsFolder; darwin: .app bundles. */
  list(): DesktopApp[];
  /** hands/system.ts findApp on every OS (its ranking is generic). */
  find(apps: DesktopApp[], query: string): DesktopApp | null;
  /** Detached; throws synchronously for terminals; the child never inherits Ember's environment (tokens, EMBER_*). */
  launch(app: DesktopApp): void;
  isTerminalApp(app: AppIdentity): boolean;
  hasBuiltInShell(app: AppIdentity): boolean;
  /** Lower-case names this app's windows report as AxWindow.app, already passed through appKey (worker open_app). */
  programsOf(app: DesktopApp): Set<string>;
  /** How an AxWindow.app is compared with programsOf. linux/darwin: lower case; win32: lower case without ".exe" (C6). */
  appKey(app: string): string;
}

export interface SystemSettings {
  /** name → description for the model. Only names this OS really changes and reads back; empty → no change_setting tool. */
  readonly available: Partial<Record<SettingName, string>>;
  /** Sets, reads back and returns the decoded before/after; throws an Error in plain words. */
  change(name: SettingName, value: string): Promise<{ before: string; after: string }>;
}

export interface SystemPaths {
  /** userData unless EMBER_USER_DATA overrides it: linux <appData>/ember (today); win32 %LOCALAPPDATA%\ember; darwin <appData>/ember (D7). */
  userData(appData: string, home: string): string;
  /** The Copilot SDK platform id and runtime file name. linux: "linux-x64", "copilot-runtime" (today's constant, runtime.ts:9). */
  readonly runtimeId: string;
  readonly runtimeExe: string;
  /**
   * How the settings window names the data folder, or a file in it. linux: "~/.config/ember" (+ "/settings.json"),
   * today's fixed text; win32/darwin: the real folder with the home folder shown as "~" (darwin) or "%LOCALAPPDATA%" (win32).
   */
  dataDirLabel(userData: string, file?: string): string;
  /** How many times SettingsStore retries a rename refused with EPERM/EBUSY/EACCES (antivirus and sync locks). linux/darwin 0 (today); win32 5. */
  readonly renameRetries: number;
}

export interface AdminPolicySource {
  /** Where the doctor and settings window say the policy lives. */
  readonly location: string;
  /**
   * admin.ts loadAdminPolicy's contract: absent → { policy: {}, source: null }; unreadable, untrusted or invalid →
   * LOCKDOWN with `error` (fail closed). `devOverride`: EMBER_ADMIN_POLICY, which main passes only when unpackaged
   * (a file path, read with today's loader without the root-owner check, on every OS).
   */
  load(devOverride?: string): LoadedAdminPolicy;
  /** The provider API key. linux/darwin: apiKeyFile, else EMBER_PROVIDER_API_KEY (today); win32: HKLM ProviderApiKey, else EMBER_PROVIDER_API_KEY. Throws when a configured source can't be read. */
  providerApiKey(p: NonNullable<AdminPolicy["provider"]>): string | undefined;
}

export interface Autostart {
  /** Makes the OS match `on`; true when something changed. Never touches the OS when already in step (macOS shows a notification per change). */
  sync(on: boolean): boolean;
  /** linux/win32: argv has --autostart; darwin: app.getLoginItemSettings().wasOpenedAtLogin. */
  launchedAtLogin(argv: readonly string[]): boolean;
  /** A note for the settings window (darwin "requires-approval", win32 disabled in Task Manager), or null. */
  note(): string | null;
}

/** Setup-check fixes (environment.ts Check.fix). */
export type FixId = "enable-accessibility" | "open-accessibility-settings" | "open-screen-recording-settings" | "open-microphone-settings" | "open-automation-settings" | "move-to-applications"
  | "open-input-monitoring-settings" | "reset-permissions" | "unblock-helper";

/** The shared host's `status` answer as main keeps it (port/host answers it without starting the provider, PH correction). */
export interface HelperStatus {
  toolkitAccessibility: boolean | null;
  /** Why the provider couldn't start: the bridge's fatal line, or "refused by an execution policy" when PowerShell ran nothing. */
  detail?: string;
  /** Windows: the bridge's `languageMode` ("FullLanguage", "ConstrainedLanguage"). */
  languageMode?: string;
  /** Windows: the bridge threads' DPI awareness and the process's; they differ on mixed-DPI risk (§12.2 R22). */
  dpi?: string;
  processDpi?: string;
}

export interface EnvContext {
  /** What openWindows() returned: undefined while it hasn't run yet. */
  windows: WindowSystem | null | undefined;
  /** Ember's accelerators another app holds; undefined while unknown. */
  shortcutsTaken?: string[];
  /**
   * win32/darwin: the shared host's `status` answer, fetched once in the background after start (never on Linux, where
   * the Python sidecar still starts on demand only): null when it didn't answer, undefined when not asked yet.
   */
  helper?: HelperStatus | null;
}

/** One doctor row a platform adds (doctor.ts DoctorCheck's shape). */
export interface PlatformDoctorRow { id: string; status: "ok" | "warn" | "fail"; label: string; detail: string; fix?: string }

export interface PlatformDoctorProbes {
  /** Microphone sources (linux: pactl), null when they can't be listed. */
  microphones: string[] | null;
  /** linux: speech-dispatcher is there; win32/darwin: true (Chromium uses the system's voices). */
  speechDispatcher: boolean;
  /** Linux only; null elsewhere (the check is left out). */
  sandbox: { userNamespaces: boolean; suidHelper: boolean } | null;
  /** Linux only (inotify); null elsewhere. */
  fileWatchers: { used: number; max: number } | null;
  /** Linux only (DeskManager.available()); null elsewhere. */
  desk: { ok: boolean; missing: string[] } | null;
  /** win32/darwin rows in doctor wording (permissions, PowerShell language mode, elevation, location). linux: []. */
  extra: PlatformDoctorRow[];
}

export interface A11yProbes {
  /** A real screen reader runs. linux: GNOME screen-reader-enabled (cached 60 s) || app.isAccessibilitySupportEnabled() (today); win32: SPI_GETSCREENREADER; darwin: VoiceOver. */
  screenReaderOn(): boolean;
  /** The OS asks for less motion. linux: gsettings enable-animations false (today); win32/darwin: systemPreferences.getAnimationSettings().prefersReducedMotion. */
  systemReducedMotion(): boolean;
}

export interface VoicePlatform {
  /** Linux only true (parec speaker rejection); win32/darwin false, and the setting and consent copy say so. */
  readonly speakerMonitor: boolean;
  /** Folders a bundled copy of the models may be in, in order (linux: /usr/share/ember/voice-models, then resources/voice-models). */
  bundledModelDirs(resourcesPath: string): string[];
}

export interface PrivacyVocabulary {
  /** Never-look entries a fresh install starts with (app/shared/never-look.ts NEVER_LOOK_DEFAULTS[os]). */
  readonly neverLookDefaults: readonly string[];
  /** policy.ts isSecurityWindow with this OS's vocabulary. */
  isSecurityWindow(w: { app?: string; title?: string; name?: string }): boolean;
}

/** Clipboard formats Ember saves and puts back around a tier-3 paste (agent/clipboard.ts), per OS (G5). */
export interface ClipboardFormats {
  /** A format (as Electron lists it) that may be read and written back. linux: today's savableFormat. */
  savable(type: string): boolean;
  /** A password manager's "this is a password" marker (linux: x-kde-passwordManagerHint). */
  passwordMarker(type: string): boolean;
  /**
   * Formats written beside the text Ember pastes itself, so clipboard history and cloud sync skip it (win32:
   * ExcludeClipboardContentFromMonitorProcessing; darwin: org.nspasteboard.TransientType). linux: none. Verify in CI
   * that Electron's clipboard writes them (§9.11).
   */
  readonly ownTextMarkers: readonly string[];
}

export interface AppLifecycle {
  /** win32: the AppUserModelId main sets before ready (toasts need it); null elsewhere. */
  readonly appUserModelId: string | null;
  /** win32: create the Start Menu shortcut toasts need, once (zip build). linux/darwin: nothing. Never throws. */
  ensureShortcut(): void;
  /** darwin: main installs an application menu whose Quit (Cmd+Q) runs quitEmber. */
  readonly appMenu: boolean;
  /** darwin: reopening Ember.app (Dock, Finder) emits "activate", not "second-instance": main shows settings then. */
  readonly reopenShowsSettings: boolean;
  /** How the OS ends the session without will-quit (G10): win32 "session-end" on Ember's windows; darwin powerMonitor "shutdown"; linux null. */
  readonly sessionEnd: "window-session-end" | "power-monitor-shutdown" | null;
  /**
   * Before one of Ember's own normal windows takes the keyboard (settings, bringToFront) and before a dialog with no
   * parent window (G15): darwin app.focus({ steal: true }) (a hotkey doesn't activate Ember otherwise); linux/win32:
   * nothing. Never for the ask box on darwin (see activateForAsk).
   */
  focusOwnApp(): void;
  /**
   * Main also asks the input backend to activate Ember's own windows (bringToFront, the ask box): linux true (today,
   * for window managers that prevent focus stealing), win32 true (foreground rules), darwin false (an AX call into
   * Ember's own process from its main thread would wait for itself until the messaging timeout).
   */
  readonly activateOwnWithInput: boolean;
  /**
   * Whether opening the ask box activates Ember (focusOwnApp, then the input backend when activateOwnWithInput): linux
   * and win32 true (today's calls); darwin false: the box is a non-activating panel that becomes key on show()/focus()
   * while the user's app stays active (Electron skips activateIgnoringOtherApps for panels), so `blur` still hides it
   * and "where the user was" stays the user's app.
   */
  readonly activateForAsk: boolean;
  /** darwin: systemPreferences.askForMediaAccess("microphone") once voice consent is given. Absent on linux/win32. */
  askMicrophone?(): Promise<boolean>;
}

export interface SystemPlatform {
  readonly os: OS;
  readonly words: PlatformWords;
  readonly shortcuts: ShortcutTable;
  readonly keys: KeyConventions;
  readonly paths: SystemPaths;
  readonly apps: AppCatalog;
  readonly settings: SystemSettings;
  readonly adminPolicy: AdminPolicySource;
  readonly autostart: Autostart;
  /** A copy of each audit line in a system log. linux: journald via systemd-cat when present; win32/darwin: undefined (D7). */
  auditSink(onError: (err: unknown) => void): ((line: string) => void) | undefined;
  /** Where the settings window says that copy is ("the system journal (journalctl -t ember-audit)"), or null when auditSink gave none. */
  auditCopy(): string | null;
  /** Absolute path of a usable gh, or null to use "gh" from PATH (linux: always null, as today). */
  ghCliPath(): string | null;
  /** platform/which.ts with this OS's rules. */
  which(cmd: string): string | null;
  /** Spread into every execFile/spawn of a helper. win32: { windowsHide: true }; else {}. */
  readonly spawnDefaults: { windowsHide?: boolean };
  /** Chromium switches appended before ready. linux: ["enable-speech-dispatcher"] (main.ts:72). */
  readonly chromiumSwitches: readonly string[];
  /** Inputs for inspectEnvironment. Cheap: getStatus calls it on every settings-window status request. */
  environment(ctx: EnvContext): EnvInputs;
  readonly fixes: { readonly ids: readonly FixId[]; apply(fix: FixId): Promise<void>; label(fix: FixId): string };
  doctorProbes(): Promise<PlatformDoctorProbes>;
  readonly a11y: A11yProbes;
  readonly voice: VoicePlatform;
  readonly privacy: PrivacyVocabulary;
  readonly clipboardFormats: ClipboardFormats;
  readonly lifecycle: AppLifecycle;
}

// ───────────── Desk (Linux only, D5) ─────────────

export interface DeskFactory {
  available(): { ok: boolean; missing: string[] };
  create(log: Logger, o: { env?: NodeJS.ProcessEnv }): DeskManager;
  openPlace(desk: DeskManager, o: { sidecarScript: string; log: Logger; neverLook: () => string[]; profiles: string; userInControl?: () => boolean }): Promise<DeskPlace>;
}

// ───────────── The platform object ─────────────

export interface Platform {
  readonly os: OS;
  readonly system: SystemPlatform;
  /**
   * D1's `windows`, opened after app ready (Electron's screen works only then). linux: openX11() only when $DISPLAY is
   * set, as today, else null; win32/darwin: null only if the native libraries failed to load. Call once.
   */
  openWindows(log: Logger): WindowSystem | null;
  /**
   * D1's `input`, opened after openWindows. null when there is none (linux without X11 or XTest). `log` null: nothing is
   * logged (the doctor, which never logged `xtest.unavailable`); otherwise linux logs it as main does today.
   */
  openInput(ws: WindowSystem | null, log: Logger | null): Input | null;
  /**
   * The OS re-reports a grabbed global shortcut when its grab ends, so the ask callback checks the held chord
   * (freshAskPress with keysDown()): linux true (X11); win32/darwin false (RegisterHotKey and Carbon hot keys fire once per
   * press: main passes null, trusted and debounced, G6).
   */
  readonly shortcutsReReported: boolean;
  readonly overlay: OverlayShaper;
  readonly keyboardHold: KeyboardHold | null;
  readonly clipboard: ClipboardBridge | null;
  /** undefined on linux (AtspiSidecar's default Python launch); the shared host's launch on win32/darwin (§5). */
  sidecarLaunch(ctx: SidecarContext): SidecarLaunch | undefined;
  readonly desk: DeskFactory | null;
}
```

Notes on the additions:
- `WindowSystem` gains only the optional `systemDialogOpen`; `Input` gains only the optional `pointerLags`. port/darwin
  already implements `systemDialogOpen` (with `accessibilityTrusted()` and `screenRecording()` beside it, as its
  `DarwinWindowSystem` extension) and is used as is; port/win32 doesn't, so the Windows composition adds it with
  `withSystemDialog(ws, check)` (§2.5), which keeps every backend extra. `pointerLags: true` is set by port/darwin's
  input (FX-PD correction).
- `windows` and `input` are opened lazily by `openWindows()`/`openInput()` because Electron's `screen` works only after
  `app.whenReady()`. Ember's own windows are told apart by `pid === process.pid` on every OS (the browser process owns
  every HWND/NSWindow; `_NET_WM_PID`, `GetWindowThreadProcessId`, `kCGWindowOwnerPID`), so no `isOwnWindow` member is
  needed. Activation stays on `Input.activate` (as today); there is no `WindowSystem.activate` in the contract
  (port/win32's `Win32WindowSystem.activate` is an extension main doesn't call). Both are departure 2 (top).
- `WindowSystem.windowId` may answer 0; every consumer treats 0 as "no window" (`AskWindow.isWindow(0)` and
  `DeskView.isWindow(0)` are false, §4.5).
- `SidecarLaunch` is structurally identical to the type port/host exports from `perception/sidecar.ts` (d0d7ef4); once
  port/host has merged, I replaces the copy here with `export type { SidecarLaunch } from "../perception/sidecar";`.
- `ChordState` remains X11's `{ control, alt, space }`: off Linux main passes `null` to `freshAskPress` (§4.12), so a
  press is trusted and debounced (G6).
- Vocabularies are exposed as functions bound to the OS (`privacy.isSecurityWindow`, `apps.isTerminalApp`) because
  their data lives in `policy/vocabulary.ts` and `hands/terminals.ts`, keyed by OS.

`app/main/platform/os.ts` (step 0):

```ts
/** The OS this process runs on, for data defaults that are read at module load (settings' never-look default). Everything else asks the Platform object (D1). */
import type { OS } from "../../shared/shortcuts";

/** "linux" for anything that isn't Windows or macOS (they fail the environment's platform check, as today). */
export const HOST_OS: OS = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
```

`app/main/platform/index.ts` (P1-A; Phase 3 adds the two branches, owner I):

```ts
/** loadPlatform(): the one place that picks the OS backend, by process.platform alone (D1). Backends load native libraries only when opened. */
import type { Platform, PlatformDeps } from "./types";
import { linuxPlatform } from "./linux";
// Phase 3 (I) adds: import { win32Platform } from "./win32/platform"; import { darwinPlatform } from "./darwin/platform";

/** The platform for this process. Unknown OSes get the Linux object (they fail the environment's platform check, as today). */
export function loadPlatform(deps: PlatformDeps, os: NodeJS.Platform = process.platform): Platform {
  // Phase 3: if (os === "win32") return win32Platform(deps); if (os === "darwin") return darwinPlatform(deps);
  void os;
  return linuxPlatform(deps);
}
```

`win32Platform` (WS, `win32/platform.ts`) and `darwinPlatform` (MS, `darwin/platform.ts`) have the signature
`(deps: PlatformDeps) => Platform` and are unit-tested on Linux with fake `ElectronParts` (they must not load koffi
until `openWindows`/`openInput`/a probe runs).

### 2.2 `app/shared/shortcuts.ts` (normative; step 0, then owner P1-C)

```ts
/**
 * Ember's global shortcuts and each OS's keyboard conventions, in one table (decision D6): main registers the
 * accelerators, the policy keeps tasks from pressing them, and the settings window, bubbles and spoken hints show them,
 * all from here, so they can't drift apart. Pure data: imported by main, plain-Node modules and renderers.
 */

/** The operating systems Ember runs on. */
export type OS = "linux" | "win32" | "darwin";

export type ShortcutId = "ask" | "stop" | "settings" | "mute" | "allow" | "deny";

/** One global shortcut, in every form Ember needs. */
export interface ShortcutDef {
  /** Electron accelerator. */
  readonly accel: string;
  /** As Ember's copy writes it ("Ctrl+Alt+Space"). */
  readonly label: string;
  /** Key caps for <kbd> chips, in order. */
  readonly keys: readonly string[];
  /** As read aloud ("Control Alt Space"). */
  readonly say: string;
  /** policy.ts canonicalKeys(accel-as-combo, KEYS[os]): what isSystemKey matches. */
  readonly chord: string;
}

export type ShortcutTable = Readonly<Record<ShortcutId, ShortcutDef>>;

const LETTERS: Record<ShortcutId, string> = { ask: "Space", stop: "X", settings: "E", mute: "M", allow: "Y", deny: "N" };
const lower = (k: string) => k.toLowerCase();

function table(f: (key: string) => ShortcutDef): ShortcutTable {
  return Object.fromEntries((Object.keys(LETTERS) as ShortcutId[]).map(id => [id, f(LETTERS[id])])) as ShortcutTable;
}

/** Linux: unchanged. Windows: Win+Alt (Ctrl+Alt is AltGr). macOS: Control+Shift+Command (⌃⌥ is VoiceOver's, ⌃⌘Space the emoji picker). */
export const SHORTCUTS: Readonly<Record<OS, ShortcutTable>> = {
  linux: table(k => ({ accel: `Control+Alt+${k}`, label: `Ctrl+Alt+${k}`, keys: ["Ctrl", "Alt", k], say: `Control Alt ${k}`, chord: `ctrl+alt+${lower(k)}` })),
  win32: table(k => ({ accel: `Super+Alt+${k}`, label: `Win+Alt+${k}`, keys: ["Win", "Alt", k], say: `Windows key, Alt, ${k}`, chord: `alt+super+${lower(k)}` })),
  darwin: table(k => ({ accel: `Control+Shift+Command+${k}`, label: `Control+Shift+Command+${k}`, keys: ["Control", "Shift", "Command", k], say: `Control Shift Command ${k}`, chord: `ctrl+shift+cmd+${lower(k)}` })),
};

/** How keys are named, parsed and labelled on an OS: the primary modifier lives here (D6). */
export interface KeyConventions {
  readonly os: OS;
  /** The policy's canonical token for the primary modifier ("mod"): "ctrl" (linux, win32) or "cmd" (darwin). */
  readonly primary: "ctrl" | "cmd";
  /** Modifier names hands/borrow.ts parseCombo accepts beyond today's, as X keysym names. */
  readonly extraModifiers: Readonly<Record<string, string>>;
  /** The canonical token for the Super_L/Super_R/Meta_* keysyms: "super" (linux, win32) or "cmd" (darwin, where they are ⌘). */
  readonly logoToken: "super" | "cmd";
  /** Spellings policy.canonicalKeys maps to the logo token before parsing (linux: today's LOGO_KEY, policy.ts:531). */
  readonly logoAliases: RegExp;
  /** Canonical modifier order (linux/win32: today's ctrl, alt, shift, super). */
  readonly modifierOrder: readonly string[];
  /** Labels of canonical modifier tokens for questions and copy (linux: today's KEY_LABELS entries). */
  readonly labels: Readonly<Record<string, string>>;
  /** Keys Ember presses itself in the worker, already canonical. linux/win32: today's exact strings (tests pin them). */
  readonly edit: { readonly selectAll: string; readonly paste: string; readonly textEnd: string; readonly sheetHome: string; readonly nameBox: string };
  /** Canonical combinations only the user may press, beyond isSystemKey's Linux rules and SHORTCUTS[os] chords. */
  readonly systemKeys: readonly string[];
}

export const KEYS: Readonly<Record<OS, KeyConventions>> = {
  linux: {
    // No new spellings on Linux or Windows: "mod+s" still fails to parse there (policy templates expand "mod" first).
    os: "linux", primary: "ctrl", extraModifiers: {}, logoToken: "super",
    logoAliases: /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "super"],
    labels: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super" },
    edit: { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" },
    systemKeys: [],
  },
  win32: {
    os: "win32", primary: "ctrl", extraModifiers: {}, logoToken: "super",
    logoAliases: /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "super"],
    labels: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" },
    edit: { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" },
    // Start menu (then a typed program name), Task Manager, window switching and the window menu (super+* is already a system key).
    systemKeys: ["ctrl+escape", "ctrl+shift+escape", "alt+tab", "alt+shift+tab", "alt+escape", "alt+space"],
  },
  darwin: {
    os: "darwin", primary: "cmd",
    // Only the spellings a model is told about on a Mac ("cmd+s", "option+left"); no "mod"/"primary"/"cmdorctrl".
    extraModifiers: { cmd: "Super_L", command: "Super_L", option: "Alt_L", opt: "Alt_L" },
    logoToken: "cmd", logoAliases: /^\s*(win|windows|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "cmd"],
    labels: { ctrl: "Control", alt: "Option", shift: "Shift", cmd: "Cmd" },
    // Cocoa text: ⌘↓ is the end of the document; LibreOffice for Mac: ⌘Home and ⌘⇧F5 (verify in CI).
    edit: { selectAll: "cmd+a", paste: "cmd+v", textEnd: "cmd+down", sheetHome: "cmd+home", nameBox: "shift+cmd+f5" },
    // App switcher, Spotlight, Force Quit, lock screen, log out, screenshots, Mission Control and Spaces.
    systemKeys: ["cmd+tab", "shift+cmd+tab", "cmd+space", "alt+cmd+escape", "ctrl+cmd+q", "shift+cmd+q", "alt+shift+cmd+q",
      "shift+cmd+3", "shift+cmd+4", "shift+cmd+5", "ctrl+shift+cmd+3", "ctrl+shift+cmd+4", "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right"],
  },
};
```

The Linux rows reproduce today's strings exactly: `SHORTCUTS.linux.ask.label === "Ctrl+Alt+Space"`, the menu label
`accel.replace("Control", "Ctrl")` equals `label`, question hints are `${label} allow` / `${label} not now`
(`"Ctrl+Alt+Y allow"`) and spoken `${say} to allow` / `${say} for not now` (`"Control Alt Y to allow"`), and
`environment.ts`'s ok text is `${ask.label} ask · ${stop.label} stop · ${settings.label} settings · ${mute.label} microphone`.
`KEYS.linux.edit` keeps the worker's exact strings (`"ctrl+End"` with its capital, as `worker-safety.test.ts` pins);
the darwin `edit` strings are written canonically (lower case, canonical order) so `afterKeys` can compare them as is.

Ember's own chords are protected as a **modifier family** off Linux, not as six exact combinations (§2.4
`isSystemKey`): any combination whose modifiers include all of a `SHORTCUTS[os]` chord's modifiers is a system key
(win32: `alt+super+*`, already covered by the `super` rule; darwin: every `ctrl+shift+cmd+*`). On macOS the backend
presses the key that *types* a letter on the active layout while Electron's Carbon hot keys are bound to fixed key
codes, so on QWERTZ a task's `ctrl+shift+cmd+z` lands on the Y position, which is Ember's Allow; refusing the family
fails closed whichever way the layouts line up. Linux keeps today's regex (which already refuses every `ctrl+alt+*`).

Windows collisions (R14): Win+Alt+Space is PowerToys Command Palette's default and Win+Alt+M is Xbox Game Bar's
microphone toggle; D6 is kept and those machines get the existing "shortcut taken" path; the letters are open
question Q7 for the lead (one row of this table changes, nothing else).

### 2.3 `app/shared/words.ts` (normative; step 0, then owner V)

```ts
/** User-facing words that differ per OS (persona, tool descriptions, perception notes, copy). Linux values are today's text, verbatim. */
import type { OS } from "./shortcuts";

export interface PlatformWords {
  /** persona.ts IDENTITY: "…on their ${desktop}." */
  readonly desktop: string;
  /** worker-persona.ts WORKER_IDENTITY / GUIDE_IDENTITY: "…in the user's real ${apps}…". */
  readonly apps: string;
  /** persona.ts TOOL_RULES "(the terminal, ${fileManager}, a browser)". */
  readonly fileManager: string;
  readonly settingsApp: string;
  /** worker.ts open_app description: "(for example ${openAppExamples})". */
  readonly openAppExamples: string;
  /** worker.ts press_keys description examples. */
  readonly keyExamples: string;
  /** worker.ts:1655 tail. */
  readonly fileDialogPathHint: string;
  /** conductor.ts describe_screen fallback "(${noScreen})". */
  readonly noScreen: string;
  /** host.ts explainStartError, doctor.ts runtime fix. */
  readonly reinstall: string;
  /** perception/index.ts:422 (shell_overlays incomplete). */
  readonly shellUnchecked: string;
  /** perception/index.ts:424 (an overview of every window is open). */
  readonly overviewOpen: string;
  /** main.ts:887-889: why a sign-in can't be kept ("No keyring is available"). */
  readonly keyringMissing: string;
  /** home/index.html:91 consent copy. */
  readonly micIndicator: string;
  /** home/index.html:31 consent copy, after "through the desktop's accessibility service": what the OS will ask for ("" when nothing). */
  readonly permissionsNote: string;
}

export const PLATFORM_WORDS: Readonly<Record<OS, PlatformWords>> = {
  linux: {
    desktop: "Linux desktop (RHEL, GNOME)", apps: "Linux desktop applications (RHEL, GNOME)", fileManager: "Files",
    settingsApp: "Settings", openAppExamples: "Text Editor, Files, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
    fileDialogPathHint: "in a file dialog press Ctrl+L (or use its name field) and type the file's name",
    noScreen: "no X11 display or accessibility service", reinstall: "Reinstall Ember (sudo dnf reinstall ember).",
    shellUnchecked: "GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "the Activities overview or the window switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "No keyring is available", micIndicator: "GNOME shows a microphone icon while Ember listens.", permissionsNote: "",
  },
  win32: {
    desktop: "Windows PC", apps: "Windows applications", fileManager: "File Explorer", settingsApp: "Settings",
    openAppExamples: "Notepad, File Explorer, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
    fileDialogPathHint: "in a file dialog type the file's full path in the File name box",
    noScreen: "the accessibility helper isn't running", reinstall: "Reinstall Ember.",
    shellUnchecked: "Windows didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "Task View or the window switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "Windows couldn't protect the sign-in on this computer",
    micIndicator: "Windows shows a microphone icon in the taskbar while Ember listens.", permissionsNote: "",
  },
  darwin: {
    desktop: "Mac", apps: "Mac applications", fileManager: "Finder", settingsApp: "System Settings",
    openAppExamples: "TextEdit, Finder, System Settings", keyExamples: "\"cmd+s\", \"Return\", \"cmd+shift+t\"",
    fileDialogPathHint: "in a file dialog press Cmd+Shift+G, type the folder's path, then choose the file",
    noScreen: "Ember doesn't have Accessibility permission", reinstall: "Install Ember again (drag a fresh Ember.app into Applications).",
    shellUnchecked: "macOS didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "Mission Control or the app switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "Keychain access was denied",
    micIndicator: "macOS shows an orange dot in the menu bar while Ember listens.",
    permissionsNote: "macOS will ask you to allow Accessibility and Screen Recording for Ember.",
  },
};
```

### 2.4 The primary modifier in policy, borrow and worker (owner P1-C)

One canonical policy token `mod`, resolved per OS (C2 resolved this way; worker-host-desk §11's "ctrl stays primary"
is rejected). Everything below takes a `KeyConventions` argument that **defaults to `KEYS.linux`**, so every existing
call and test keeps today's result.

**`hands/borrow.ts`**
- `parseCombo(combo: string, kc: KeyConventions = KEYS.linux)`: the modifier lookup is
  `MODIFIERS[m.toLowerCase()] ?? kc.extraModifiers[m.toLowerCase()]` (today's MODIFIERS first; `KEYS.linux` and
  `KEYS.win32` have no extra modifiers, so Linux and Windows parse exactly today's set). On darwin `cmd+s` →
  `Super_L` + `s` (the macOS backend presses ⌘ for Super_L); `ctrl+a` → real Control. `canonicalCombo` gets the same
  parameter (MODIFIER_KEYS maps `super_l/r`, `meta_l/r` to `kc.logoToken`; order `kc.modifierOrder`).
- `CursorBorrow` records `lastSyntheticKeyAt` (the time of the last key event it posted; a public read-only number,
  0 before any) so main's Confirmer can refuse an approval chord that arrives just after Ember typed (§4.1 item 38).
- `CursorBorrowOptions` gains `keys?: KeyConventions`; `hand.keys(combo)` calls `parseCombo(combo, this.keys)`.
- `glideTo` bounds: `const ok = x.onScreen ? x.onScreen(tx, ty) : (tx >= 0 && ty >= 0 && tx < screen.width && ty < screen.height);`
  (same error text when `!ok`).
- `type`: when `x.textKey` exists, the text is typed character by character through it (no layout plan): before
  typing, `typeableText` is checked as today; per character `check(); keyboardOnTarget(); keyboardFree();` then
  `if (!x.textKey(ch, true)) throw new Error(\`The keyboard can't type “${ch}”, so Ember stopped.\`); x.textKey(ch, false);`
  then `await sleep(12)`. `checkTyping` returns without a layout plan when `x.textKey` exists. `check()` runs only while
  Ember's text key is up, so no held-key bookkeeping is needed (verify on macOS that a posted key-up is visible to
  `CGEventSourceKeyState` within 12 ms; fallback in §12.2 R7). On macOS `textKey` posts key code 0 with a Unicode
  string, which an input method (Japanese, Pinyin, Korean) would compose from: port/darwin's `blockedReason` refuses
  while the current input source isn't a keyboard layout (FX-PD), so the borrow never starts and tier 1 `set_text`
  stays available.
- `check()`: only when `x.pointerLags === true` (macOS posts asynchronously), the pointer also counts as Ember's
  within TOLERANCE of the **previous** `expected`. Without the flag (Linux XTest, Windows SendInput) `check()` is
  today's code verbatim, so a user's movement that lands near the previous glide step is still a takeover there
  (borrow-platform test: the Linux fake, which has no flag, takes over on a one-step-back move).
- At the start of `borrowNow`, before waiting for the user to be idle:
  `const why = x.blockedReason?.(o.window ?? 0) ?? null; if (why) throw new Error(why);` (the worker reports it as the
  reason; C8's "no cursor without trust" is replaced by this per-borrow refusal with a clear message).

**`policy/policy.ts`**
- `canonicalKeys(keys, kc = KEYS.linux)`: maps `kc.logoAliases` tokens to `kc.logoToken`, parses with
  `parseCombo(…, kc)`, maps modifier keysyms with today's MODIFIER_NAMES except `super|meta|hyper|mod4` → `kc.logoToken`,
  and orders by `kc.modifierOrder`. Linux results are unchanged (`"cmd+space"` → `"super+space"`, as
  `policy.test.ts:228` pins).
- `isSystemKey(k, kc = KEYS.linux)`: today's body, except the logo rule applies only when `kc.logoToken === "super"`;
  then, **only when `kc.os !== "linux"`**, `|| shortcutFamily(k, kc) || kc.systemKeys.includes(keyFamily(k))`, where
  `shortcutFamily(k, kc)` is true when the modifier set of `k` contains every modifier of some `SHORTCUTS[kc.os]` chord
  (darwin: any `ctrl+shift+cmd+*`, also with `alt` added; win32: any `alt+super+*`). On Linux nothing is added (the
  Ctrl+Alt regex already covers Ember's chords, and a frozen list of Linux results pins it).
- Every **exported** key helper takes `kc: KeyConventions = KEYS.linux` and passes it to `canonicalKeys`:
  `isActivatingKey`, `typedChar`, `typesCharacter`, `replacesSelection`, `keyLabel`, `normalizeKeys`; worker.ts's
  exported `afterKeys(keys, typed, selected, kc = KEYS.linux)` likewise (worker-tools.test.ts keeps calling it with
  three arguments). The worker passes `this.sys.keys` at every call (worker.ts:461-465, 483, 517, 519, 2669, 2675,
  3084), so on macOS `cmd+a` then `cmd+v` is known to replace the selection.
- Key tables are built per OS, lazily and memoised, from templates where `mod` means the primary:
  `SAFE_COMBOS = ["mod+a","mod+c","mod+x","mod+v","mod+z","mod+y","mod+shift+z","mod+b","mod+i","mod+u","mod+f","mod+g","mod+h","mod+s","mod+shift+s","mod+n","mod+t","mod+l","mod+o","mod+home","mod+end","mod+left","mod+right","mod+up","mod+down","mod+shift+left","mod+shift+right","mod+shift+home","mod+shift+end","mod+backspace","mod+plus","mod+minus","mod+equal","mod+0","mod+tab","mod+shift+tab","mod+prior","mod+next","mod+pageup","mod+pagedown"]`
  — **P1-C first copies today's literal list (policy.ts:576-580) and replaces `ctrl` with `mod` token by token, so the
  Linux set is provably identical** (a unit test compares the new Linux set with a frozen copy of today's);
  darwin adds `"alt+left","alt+right","alt+shift+left","alt+shift+right","cmd+up","cmd+down","cmd+shift+up","cmd+shift+down"`;
  `DESTRUCTIVE_KEYS` likewise from today's list (policy.ts:581-583) with `ctrl` → `mod`; darwin adds
  `"cmd+backspace","shift+cmd+backspace","alt+shift+cmd+backspace","alt+cmd+w","alt+cmd+q","cmd+q","cmd+w"`;
  `PASTE_KEYS = ["mod+v","mod+shift+v","shift+insert"]` (darwin adds `"alt+shift+cmd+v"`). Each entry is canonicalised
  with `canonicalKeys(entry.replace(/\bmod\b/g, kc.primary), kc)`. win32 adds `"alt+f4"` to nothing (already there).
- Every regex that means "the primary" is built from `kc.primary` (P): `REMOVES = ^((shift|P|P\+shift)\+)?(delete|backspace)$|^P\+x$`,
  `replacesSelection`'s `P\+x|shift\+delete|P\+(shift\+)?(backspace|delete)`, `takesSelected`'s `k === "P+x"`. The "a
  shortcut Ember can't judge" test (policy.ts:1759) and `typesCharacter` use `(ctrl|alt|super|cmd)\+` on every OS (no
  Linux combination contains `cmd`, so Linux is unchanged). `ACTIVATE_KEY`'s `ctrl+m`/`ctrl+j` stay literal (they are
  real Control line feeds on every OS).
- `keyLabel(keys, kc = KEYS.linux)` uses `{ ...KEY_LABELS, ...kc.labels }`. The "(Ctrl+A)" wording (policy.ts:1354,
  1355, 1409) becomes `keyLabel(kc.edit.selectAll, kc)` → "Ctrl+A" on Linux, "Cmd+A" on macOS.
- `PolicyEngineOptions` gains `keys?: KeyConventions`; every internal call passes `this.keys`.
- `isSecurityWindow(w, os: OS = "linux")` reads `SECURITY_APP[os]`/`SECURITY_TITLE[os]` from `policy/vocabulary.ts`
  (Linux entries are today's regexes, moved verbatim); likewise `TABBED_APP`, `WEB_APP`, `OFFICE_APP`, the `RISKY`
  additions and `RUNS_PROGRAM`/`RUN_FILE_DIALOG` additions (§9.11). `PolicyEngineOptions.os?: OS` picks them.

**`agent/worker.ts`**: `const kc = this.d.system.keys`. The hard-coded strings become `kc.edit.selectAll`, `"Delete"`,
`kc.edit.textEnd`, `kc.edit.paste` (cursorAct, worker.ts:1952-1962), `kc.edit.sheetHome` (fillCell, :2389),
`kc.edit.nameBox` (toCellByName, :2555). `afterKeys`' `k === "ctrl+a"` (:463) becomes
`k === canonicalKeys(kc.edit.selectAll, kc)`; the `canonicalKeys`/`keyFamily` calls at :461, :483, :519 pass `kc`.
The press_keys description uses `words.keyExamples`. Linux keystrokes are identical (`worker-safety.test.ts:349`
expects `["ctrl+a", "Delete", "ctrl+v"]`).

**Hotkeys** (`hotkey.ts`): no logic change. `freshAskPress(chord, at, last)` already trusts a `null` chord; main passes
`platform.shortcutsReReported ? ws?.keysDown() ?? null : null` (G6 resolved: Windows `RegisterHotKey` and macOS Carbon
hotkeys fire once per press). Only the doc comments change.

**Invariant tests** (P1-C, `test/unit/shortcuts.test.ts`): for each OS, every `SHORTCUTS[os][id].chord` equals
`canonicalKeys(accelAsCombo, KEYS[os])` (accelerator → combo: `Control`→`ctrl`, `Command`→`cmd`, `Super`→`super`, `+`
kept) and `isSystemKey(chord, KEYS[os])` is true; `KEYS.linux.edit` equals today's strings; on darwin
`canonicalKeys("cmd+s") === "cmd+s"`, `isSystemKey("cmd+s")` is false, `isSystemKey("cmd+space")` true, `DESTRUCTIVE`
has `cmd+q`, every `KEYS.darwin.edit` value is a fixed point of `canonicalKeys`, and the family rule holds:
`ctrl+shift+cmd+z`, `ctrl+alt+shift+cmd+y`, `ctrl+shift+super+y` and `ctrl+shift+meta+comma` are system keys; on win32
`isSystemKey("super+r")` and `isSystemKey("ctrl+shift+escape")` are true. Linux freezes: for `mod+s`, `primary+a`,
`cmdorctrl+v`, `cmd+s`, `win+r`, `canonicalKeys` gives today's `null, null, null, "super+s", "super+r"`, and
`isSystemKey` gives today's answer for a frozen list of 40 combinations.

### 2.5 `compose.ts`, `which.ts` (P1-A; P1-D owns which.ts) and the host launch (port/host's `hostLaunch`)

The host's launch is **port/host's** `hostLaunch(o: HostLaunchOptions): SidecarLaunch` in
`app/sidecar-host/launch.ts` (wt/host `launch.ts:30-39`): `{ command: o.execPath, args: [o.host], env: { ...o.env,
ELECTRON_RUN_AS_NODE: "1", EMBER_UIA_SCRIPT?, EMBER_UIA_CACHE? }, firstRequestMs: FIRST_REQUEST_MS[o.platform] (win32
20 s, darwin 10 s), windowsHide: true }`, with the test-only switches removed when `o.packaged`. There is no second
copy in `app/main/platform/` (revision 1's `host-launch.ts` is dropped). The provider is chosen inside the host by
`process.platform` (`providers/index.ts` `providerKind`; `fake` only when asked for and unpackaged), and the bridge's
PowerShell path and environment are the host's (`powershellPath`, `bridgeEnv`). The compositions (§7.1, §8.1) call it as
`hostLaunch({ execPath: ctx.execPath, host: path.join(ctx.appDir, "ax-sidecar.cjs"), uiaScript, uiaCache, env:
hostEnv(deps.env, ctx), platform, packaged: ctx.packaged })`.

```ts
// compose.ts (P1-A) — pure, unit-tested on Linux.
/**
 * A WindowSystem whose systemDialogOpen is `check`, and which is otherwise `ws` itself: a Proxy whose `get` answers
 * systemDialogOpen with `check` and every other key with Reflect.get(ws, key) (functions bound to `ws`), so backend
 * extras (port/win32's activate, port/darwin's accessibilityTrusted) survive and `this` inside a backend method is the
 * backend. The return type keeps the extras: `T & { systemDialogOpen(): boolean }`.
 */
export function withSystemDialog<T extends WindowSystem>(ws: T, check: () => boolean): T & { systemDialogOpen(): boolean };

/**
 * An environment for a helper Ember starts: `env` minus tokens (appEnv's NEVER list: GH_*, GITHUB_*, COPILOT_*,
 * *_TOKEN, *_KEY, *_SECRET), minus EMBER_* except EMBER_LOG_LEVEL and the names in `keep`, minus NODE_OPTIONS,
 * ELECTRON_NO_ATTACH_CONSOLE and ELECTRON_ENABLE_LOGGING (keys deleted, not set to "undefined"). On win32 every name
 * is compared case-insensitively (`Path`/`PATH`, `Node_Options`), as Windows' environment is.
 */
export function cleanEnv(env: NodeJS.ProcessEnv, o: { os: OS; keep?: readonly string[] }): NodeJS.ProcessEnv;

/**
 * The host's environment: cleanEnv(env, { os, keep: packaged ? [] : HOST_TEST_SWITCHES }) plus EMBER_OWNER_PID =
 * String(process.pid) (the host and its provider never read Ember's own windows, PH/PU corrections).
 * HOST_TEST_SWITCHES is port/host's exported TEST_SWITCHES (EMBER_AX_PROVIDER, EMBER_AX_FAKE_DESKTOP,
 * EMBER_AX_FAKE_LOG), so the development-only fake provider still works in Ember-level tests.
 */
export function hostEnv(env: NodeJS.ProcessEnv, o: { os: OS; packaged: boolean; ownerPid: number }): NodeJS.ProcessEnv;

// which.ts (P1-D) — pure over injected fs and env.
/** The absolute path of `cmd` on PATH (path.delimiter; quotes stripped; win32 tries PATHEXT limited to .EXE and .COM; extra folders appended), or null. */
export function which(cmd: string, o: { os: OS; env: NodeJS.ProcessEnv; extraDirs?: readonly string[]; isExecutable?: (p: string) => boolean }): string | null;
```

Tests (`platform-compose.test.ts`): `withSystemDialog` answers `check`, keeps an extra member of a fake (and its
binding: a method that reads `this` sees the backend), and lets `check` throw only into the caller's fail-closed
wrapper (§4.7); `cleanEnv` drops tokens and EMBER_* with mixed-case keys on win32, keeps `EMBER_LOG_LEVEL` and `keep`;
`hostEnv` adds EMBER_OWNER_PID and keeps the test switches only unpackaged.

---

## 3. How each Linux module maps onto the interface (Phase 1 wraps, it doesn't rewrite)

Every Linux member is a thin adapter over a function that exists today, called with today's arguments. The adapters
live in `app/main/platform/linux/` (owners in brackets). No Linux module loses an export; where one gains a parameter,
the default is today's value.

| Today's module and export | Today's caller (main.ts unless noted) | Platform member | Linux adapter (owner) |
|---|---|---|---|
| `x11.ts` `openX11()` | :169, :1048 (`process.env.DISPLAY ? openX11() : null`) | `openWindows(log)` | `linux/window-system.ts` `openLinuxWindows({ screen, env })` (P1-A) |
| `xshape.ts` `setInputShape(xid, rects, scale)`, `closeInputShape()` | overlay.ts:214-221, :82 | `overlay.setInputRegion(win, rects, scale)`, `overlay.release()` | `linux/overlay-shaper.ts` (P1-A) |
| `hands/input.ts` `openXInput()`, `xinputError` | :172, :1198-1199 (`x11 ? openXInput() : null`, warn `xtest.unavailable`) | `openInput(ws, log)` | `linux/index.ts` (P1-A): `ws ? openXInput() : null`, logs `xtest.unavailable` with `{ err: xinputError }` on the logger it is given (main passes its root `log`, so the event is identical; the doctor passes null and nothing is logged, as today) |
| `hands/keybuffer.ts` `holdKeyboard(o)` | :667 | `keyboardHold` | `o => holdKeyboard(o)` (P1-A) |
| `hands/clipboard-handoff.ts` `handClipboardToManager`, `readSelection` | :640, :1016-1017 (`emberXid`), :1030-1031 | `clipboard: ClipboardBridge` | `linux/clipboard.ts` (P1-A): `ownerId(win) = env.DISPLAY ? readUInt32LE(0) : 0`; `handOff(w) = handClipboardToManager({ ourWindow: w })`; `readSelection(id) = readSelection({ sameClientAs: id })` |
| `hands/system.ts` `listApps`, `findApp`, `launchApp`, `isTerminalApp`, `hasBuiltInShell`, `programsOf` (moved from worker.ts:698) | worker.ts:29, :977-1017; main.ts:1251 | `system.apps` | `linux/system.ts` (P1-D): `list: () => listApps()`, `find: findApp`, `launch: launchApp`, `isTerminalApp: a => isTerminalApp(a)`, `hasBuiltInShell`, `programsOf: a => programsOf(a)`, `appKey: s => s.toLowerCase()` |
| `hands/system.ts` `SETTINGS`, `changeSetting` | worker.ts:964-972 | `system.settings` | `{ available: SETTINGS, change: changeSetting }` (P1-D) |
| `autostart.ts` `syncAutostart`, `launchCommand` | :967-975, :976, :1374 | `system.autostart` | `sync(on) = syncAutostart(on, launchCommand({ packaged, execPath, appPath }))`; `launchedAtLogin(argv) = argv.includes("--autostart")`; `note() = null` (P1-D) |
| `admin.ts` `loadAdminPolicy`, `providerApiKey`, `ADMIN_POLICY_FILE` | :173, :210, :1157 | `system.adminPolicy` | `location: ADMIN_POLICY_FILE`; `load(dev) = dev === undefined ? loadAdminPolicy() : loadAdminPolicy(dev)`; `providerApiKey: p => providerApiKey(p)` (P1-D) |
| `policy/audit.ts` `journalSink` | :1189 | `system.auditSink(onError)`, `system.auditCopy()` | `auditSink = onError => journalSink(onError)`; `auditCopy = () => journalAvailable() ? "the system journal (journalctl -t ember-audit)" : null`, with `journalAvailable(exists = fs.existsSync)` newly exported from audit.ts and used by `journalSink` itself (P1-D) |
| `environment.ts` `inspectEnvironment`; main.ts `readEnvironment`, `probeAccessibility` (:121-156) | :303, :328, :171, :1050 | `system.environment(ctx)` | `linux/environment.ts` (P1-D): `probeAccessibility` and the body of `readEnvironment` moved verbatim; `x11: ctx.windows === undefined ? undefined : env.DISPLAY ? !!ctx.windows : undefined` (today's `x11Reachable`); main still calls `inspectEnvironment(platform.system.environment(ctx))` |
| main.ts `applyFix` gsettings (:324-329) | IPC `applyFix` | `system.fixes` | `ids: ["enable-accessibility"]`, `apply` runs today's `execFileSync("gsettings", ["set", …, "true"], { timeout: 5000 })`, `label: () => "Turn on"` (P1-D) |
| main.ts `runDoctor` probes (:183-200) | `--doctor` | `system.doctorProbes()` | `linux/doctor-probes.ts` (P1-D): pactl microphones, speech-dispatcher (`which` + libspeechd paths), user namespaces, chrome-sandbox suid, `inotifyUse()`, `DeskManager.available()`, `extra: []`, moved verbatim |
| main.ts `screenReaderOn` (:605-613) | `maySpeak` | `system.a11y.screenReaderOn` | gsettings `screen-reader-enabled` cached 60 s `\|\| app.isAccessibilitySupportEnabled()`, moved verbatim (P1-D) |
| main.ts `makeOverlay` gsettings `enable-animations` (:1077) | `OverlayManager.systemReducedMotion` | `system.a11y.systemReducedMotion` | moved verbatim (P1-D) |
| main.ts `voiceModelsRoot` dirs (:160) | voice | `system.voice.bundledModelDirs(resourcesPath)` | `["/usr/share/ember/voice-models", path.join(resourcesPath, "voice-models")]`; main keeps prepending `devEnv("EMBER_VOICE_MODELS")` (P1-D) |
| settings `voice.speakerRejection` → VoiceService `monitor` (:1349) | voice | `system.voice.speakerMonitor` | `true` (P1-D) |
| main.ts `which` (:165) | doctor | `system.which` | `platform/which.ts` with `os: "linux"`, default PATH `/usr/bin:/bin` when unset, `X_OK` (P1-D) |
| main.ts:72 `enable-speech-dispatcher` | before ready | `system.chromiumSwitches` | `["enable-speech-dispatcher"]` (P1-D) |
| main.ts:76 userData | before ready | `system.paths.userData(appData, home)` | `path.join(appData, "ember")` (P1-D) |
| `agent/runtime.ts` `RELATIVE` (:9) | :174, :1164 | `system.paths.runtimeId/runtimeExe` | `"linux-x64"`, `"copilot-runtime"` (P1-D) |
| `agent/auth.ts` `ghCliToken` (`execFile("gh", …)`) | resolveToken | `system.ghCliPath()`, `system.spawnDefaults` | `null`, `{}` (P1-D) |
| `agent/clipboard.ts` `savableFormat`, `holdsPassword` marker | worker paste | `system.clipboardFormats` | `{ savable: savableFormat, passwordMarker: t => t === "x-kde-passwordManagerHint", ownTextMarkers: [] }` (P1-D builds; P1-C makes clipboard.ts take it) |
| main.ts:76 and home `~/.config/ember` texts | settings window | `system.paths.dataDirLabel(userData, file?)` | `"~/.config/ember"` + (`file` ? `/${file}` : "") (P1-D) |
| `policy.ts` `isSecurityWindow`; settings never-look default | perception, main :1259, worker | `system.privacy` | `{ neverLookDefaults: NEVER_LOOK_DEFAULTS.linux, isSecurityWindow: w => isSecurityWindow(w) }` (P1-D; the one-argument call is today's signature, so P1-D doesn't wait for P1-C's `os` parameter) |
| `desk/desk.ts` `DeskManager`, `desk/place.ts` `openDeskPlace` | :1223, :1270-1273, :199 | `Platform.desk` | `linux/desk.ts` (P1-A): `{ available: () => DeskManager.available(), create: (log, o) => new DeskManager(log, o), openPlace: openDeskPlace }` |
| `perception/sidecar.ts` `new AtspiSidecar(script, log)` | :1167, desk/place.ts | `Platform.sidecarLaunch(ctx)` | returns `undefined` (AtspiSidecar keeps its Python default); main keeps `sidecarScript()` for Linux and the desk (P1-A) |
| main.ts lifecycle (none today) | — | `system.lifecycle` | `{ appUserModelId: null, ensureShortcut() {}, appMenu: false, reopenShowsSettings: false, sessionEnd: null, focusOwnApp() {}, activateOwnWithInput: true, activateForAsk: true }` (P1-D) |
| `SettingsStore` save (no retry today) | settings.ts `renameSync` | `system.paths.renameRetries` | `0` (P1-D) |
| hotkey chord check (main.ts:1126-1134) | ask callback | `Platform.shortcutsReReported` | `true` (P1-A) |
| (strings) | persona, worker, main, doctor, copy | `system.words/shortcuts/keys` | `PLATFORM_WORDS.linux`, `SHORTCUTS.linux`, `KEYS.linux` (P1-D) |

### 3.1 The Linux window system adapter (`linux/window-system.ts`, P1-A)

```ts
/** The X11 window system behind the platform contract: x11.ts unchanged, plus what main.ts used to compute from Electron's primary scale factor. */
export function openLinuxWindows(o: { screen: ScreenLike; env: NodeJS.ProcessEnv; open?: () => X11 | null }): WindowSystem | null {
  if (!o.env.DISPLAY) return null;                 // today's gate (main.ts:1048), $DISPLAY read here only on Linux
  const x = (o.open ?? openX11)();
  if (!x) return null;
  const scale = () => o.screen.getPrimaryDisplay().scaleFactor || 1;
  return {
    kind: "x11", compositorMayChange: true,
    hasCompositor: s => x.hasCompositor(s), pointer: () => x.pointer(), keysDown: () => x.keysDown(),
    activeWindow: () => x.activeWindow(), focusWindow: () => x.focusWindow(), clientWindows: () => x.clientWindows(),
    stack: () => x.stack(), capture: (cx, cy, w, h) => x.capture(cx, cy, w, h), close: () => x.close(),
    windowId: win => { try { return win.getNativeWindowHandle().readUInt32LE(0); } catch { return 0; } },
    toDip: r => { const k = scale(); return { x: r.x / k, y: r.y / k, width: r.width / k, height: r.height / k }; },
    toDipPoint: p => { const k = scale(); return { x: p.x / k, y: p.y / k }; },
    // main.ts:1172-1178 verbatim: the union of the displays' DIP bounds, times the primary scale.
    screenBounds: () => { /* … */ },
  };
}
```

Invariants (unit-tested with a fake `X11` and fake screen, `test/unit/platform-linux-window-system.test.ts`): no
`DISPLAY` → null without calling `open`; `toDip`/`toDipPoint` equal main.ts:1060 and :1253's arithmetic;
`screenBounds` equals main.ts:1172-1178 for a two-display fake; `windowId` of a throwing handle is 0.

### 3.2 The Linux overlay shaper (`linux/overlay-shaper.ts`, P1-A)

`setInputRegion(win, rects, scale)` = `xid = readUInt32LE(0)` (0 on throw) → `xid ? setInputShape(xid, rects, scale) : false`;
`release()` = `closeInputShape()`; `forward: false`; `floating(kind)` returns `{ options: {}, allWorkspaces }` with
`allWorkspaces` = `{ visibleOnFullScreen: true }` (overlay), `"plain"` (handle), `null` (ask, desk-view): exactly the
calls overlay.ts:283 and handle.ts:56 make today. `test/unit/overlay-shape.test.ts` must keep passing unchanged (it pins
the open → shape → ignore false → shape order).

### 3.3 The Linux composition (`linux/index.ts`, P1-A; `linux/system.ts`, P1-D)

```ts
export function linuxPlatform(deps: PlatformDeps): Platform {
  const system = linuxSystem(deps);                       // linux/system.ts (P1-D), the rows of the table above
  return {
    os: "linux", system,
    openWindows: () => openLinuxWindows({ screen: deps.electron.screen, env: deps.env }),
    openInput: (ws, log) => { if (!ws) return null; const xi = openXInput(); if (!xi) log?.warn("xtest.unavailable", { err: xinputError }); return xi; },
    shortcutsReReported: true,
    overlay: linuxOverlayShaper(), keyboardHold: o => holdKeyboard(o), clipboard: linuxClipboard(deps.env),
    sidecarLaunch: () => undefined, desk: linuxDesk,
  };
}
```

Invariant tests (`test/unit/platform-linux.test.ts`, P1-A): `loadPlatform(fakeDeps, "linux").os === "linux"`; with no
`DISPLAY` `openWindows` returns null and `openInput(null)` returns null without loading koffi; `sidecarLaunch()` is
undefined; `system.shortcuts === SHORTCUTS.linux`; `system.chromiumSwitches` equals `["enable-speech-dispatcher"]`;
`system.paths.userData("/home/u/.config", "/home/u") === "/home/u/.config/ember"`; `system.fixes.ids` equals
`["enable-accessibility"]`; `system.lifecycle.sessionEnd === null`; `openInput(ws, null)` with a failing XTest logs
nothing; and `loadPlatform` with a `screen` Proxy that throws on every property access and an `app.getPath` that
throws does not throw (§2.1 `PlatformDeps` rule; the same test exists for win32 and darwin in WS/MS).

---

## 4. Phase 1 change list, file by file

Each entry: what changes, then the invariant that keeps Linux identical. `platform` is the object `loadPlatform()`
returns; `sys = platform.system`; `ws` the opened window system (or null); `input` the opened input backend (or null).
Owners are the Phase 1 packages of §11.2.

### 4.1 `app/main/main.ts` (P1-A, the only owner)

Module load (before ready):
1. `const platform = loadPlatform({ electron: { app, screen, desktopCapturer, systemPreferences, shell, powerMonitor, browserWindow: BrowserWindow }, packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: process.env });`
   (Allowed before ready only because of §2.1's `PlatformDeps` rule: nothing in `loadPlatform` touches `screen` or
   calls `app.getPath`; `app.getAppPath()` above is today's call and is safe before ready.)
   right after the debug-switch check (main.ts:66-69). `sys = platform.system`. `useAppNames(platform.os)`
   (app/shared/apps.ts, §4.20).
2. main.ts:72 → `for (const s of sys.chromiumSwitches) app.commandLine.appendSwitch(s);`.
   *Linux:* the same single `enable-speech-dispatcher` switch.
3. main.ts:76 → `app.setPath("userData", process.env.EMBER_USER_DATA ?? sys.paths.userData(app.getPath("appData"), app.getPath("home")))`.
   *Linux:* `path.join(appData, "ember")`, as today.
4. Before ready: `if (sys.lifecycle.appUserModelId) app.setAppUserModelId(sys.lifecycle.appUserModelId);` (Windows
   toasts, G11). *Linux:* null, no call.
5. Delete `probeAccessibility`, `readEnvironment`'s body, `which` (:115-165); `readEnvironment()` becomes
   `inspectEnvironment(sys.environment({ windows: wsState, shortcutsTaken }))` where `wsState` is `undefined` until
   `openWindows` ran, then its result (today's `x11Reachable` logic lives in `linux/environment.ts`). *Linux:* the same
   `EnvInputs` object field by field (unit test in P1-D compares `linuxSystem().environment(…)` with a frozen copy of
   today's construction for the same fake inputs).
6. `voiceModelsRoot()` → `[devEnv("EMBER_VOICE_MODELS"), ...sys.voice.bundledModelDirs(process.resourcesPath ?? "")]`.

`runDoctor()` (:167-206): `ws = platform.openWindows(log)`, `wsState = ws`, `input = platform.openInput(ws, null)` (the
doctor never logged `xtest.unavailable`, main.ts:172), and at the end `input?.close(); ws?.close();` as today (:203-204),
`admin = sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY"))`, `runtime = locateRuntime({ …, runtimeId: sys.paths.runtimeId, exe: sys.paths.runtimeExe })`,
`probes = await sys.doctorProbes()`, `helper = await doctorHelper()` (below), then `doctorChecks({ os: platform.os, helper, env, compositor: ws ? ws.hasCompositor() : null, xtest: ws ? !!input && !input.blockedReason?.(0) : null, speechDispatcher: probes.speechDispatcher, microphones: probes.microphones, voiceModels, runtime: runtime.exists, auth, admin, desk: probes.desk, sandbox: probes.sandbox, fileWatchers: probes.fileWatchers, extra: probes.extra, shortcuts: sys.shortcuts, words: sys.words, policyLocation: sys.adminPolicy.location })`.
*Linux:* `openWindows` is `DISPLAY ? openX11() : null` (today's gate), `openInput` returns `openXInput()` when ws, and
every probe value is computed by the moved code; `blockedReason` is undefined on Linux so `xtest` is `!!input`.
`doctorHelper()`: when `platform.sidecarLaunch(ctx)` returns a launch (win32/darwin), start an `AtspiSidecar` with it,
ask `status()` (within the launch's `firstRequestMs`), stop it, and return the `HelperStatus` (null on failure); the
doctor then has an "Accessibility helper" row (§9.9), which on macOS also proves that the host child itself is trusted
(finding M4). Linux: no launch, `helper` undefined, no row, nothing started (today's output).

`start()`:
7. Admin policy (:210) → `sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY"))`; log events unchanged.
8. `SettingsStore` gets `{ renameRetries: sys.paths.renameRetries }` (§4.18). *Linux:* 0 (today). (main never tests
   `platform.os` for an OS rule; the per-OS facts are members.)
9. `bringToFront(win)` (:234-239) → `win.show(); win.focus(); sys.lifecycle.focusOwnApp(); if (sys.lifecycle.activateOwnWithInput) { const id = ws?.windowId(win) ?? 0; if (id) inputRef?.activate(id); }`.
   *Linux:* `windowId` = `readUInt32LE(0)` and `activateOwnWithInput` is true, `focusOwnApp` does nothing: same calls.
10. `app.on("second-instance", …)` unchanged; add `if (sys.lifecycle.reopenShowsSettings) app.on("activate", () => showHome());` (G16).
11. `applyFix` (:324-329) → `guard(async (fix: string) => { if (!sys.fixes.ids.includes(fix as FixId)) throw new Error(\`unknown fix: ${fix}\`); await sys.fixes.apply(fix as FixId); log.info("fix.applied", { fix }); return readEnvironment(); })`.
    *Linux:* the same gsettings command (moved), the same error text, the same log event; the IPC answer is now a
    promise of the same value (ipcMain.handle awaits either).
12. `getStatus` (:300-309) adds `platform: platformStatus()` (§4.21): `{ os, shortcuts, dataDir: sys.paths.dataDirLabel(userData), settingsFile: sys.paths.dataDirLabel(userData, "settings.json"), auditCopy: sys.auditCopy(), micIndicator: sys.words.micIndicator, permissionsNote: sys.words.permissionsNote, speakerRejection: sys.voice.speakerMonitor, fixLabels, desk: !!platform.desk && platform.desk.available().ok, autostartNote: sys.autostart.note() }`.
13. Shortcut table: `const sc = sys.shortcuts;`
    - greeting (:368-375): `hasKey(sc.ask.accel) && hasKey(sc.stop.accel) ? \`Press ${sc.ask.label} to ask me anything; ${sc.stop.label} stops me.\`` and
      `Open settings${hasKey(sc.settings.accel) ? \` (${sc.settings.label})\` : ""} to connect me.`;
    - menu (:444-467): `label(text, def)` = `hasKey(def.accel) ? \`${text}   ${def.label}\` : text`, called with `sc.ask`,
      `sc.stop`, `sc.mute`, `sc.settings`;
    - `QUESTION_KEYS` (:565-568) = `[{ accel: sc.allow.accel, which: "primary", hint: \`${sc.allow.label} allow\`, say: \`${sc.allow.say} to allow\` }, { accel: sc.deny.accel, which: "deny", hint: \`${sc.deny.label} not now\`, say: \`${sc.deny.say} for not now\` }]`;
    - registration (:1122-1136): the object is built in today's key order `settings, ask, stop, mute` from `sc.*.accel`.
    *Linux:* every string is identical (§2.2's invariants; the `taken` list keeps its order, so `shortcut.unavailable`
    and `shortcutsTaken` are unchanged).
14. Ask hotkey (:1126-1134): `const chord = platform.shortcutsReReported ? ws?.keysDown() ?? null : null;` (G6). *Linux:*
    true, today's call.
15. `quitEmber` (:390-404): `sys.lifecycle.focusOwnApp()` before `dialog.showMessageBox` (G15). `startupFailed` (:92-99)
    likewise before `showErrorBox`. *Linux:* no-op.
16. `focusNow()`, `shownWindows()`, `giveFocusBack()` (:417-437): `x11Ref` → `ws`, `xinputRef` → `inputRef`; logic unchanged.
17. `showMenu()` (:438-524): `xid` → `ws?.windowId(win) ?? 0` (computed once as today); `hasKeyboard` = `focusSeen && win.isFocused() && (!ws || ws.kind !== "x11" || ws.focusWindow()?.id === xid)`
    (the X server cross-check is an X11 quirk; a non-activating macOS panel never shows up as the focus window);
    `released()` uses `ws?.pointer()?.mask`; `focusInput` stays `inputRef?.focusInput?.(xid)`.
    *Linux:* `ws.kind === "x11"`, so the same three-way condition.
18. `AskWindow` options (:621-628): `windowId: w => ws?.windowId(w) ?? 0`, `floating: platform.overlay.floating("ask")`,
    `takeFocus: id => { askXid = id; if (!sys.lifecycle.activateForAsk) return; sys.lifecycle.focusOwnApp(); if (id && sys.lifecycle.activateOwnWithInput) { inputRef?.activate(id); inputRef?.focusInput?.(id); } }`,
    `hasFocus: platform.keyboardHold ? () => !ws || (askXid !== 0 && ws.focusWindow()?.id === askXid) : undefined`.
    ask.ts's `reveal()` now calls `takeFocus(id)` with whatever `windowId` answered, 0 included (§4.5), and the
    callback guards the input calls with `if (id)`. On darwin (`activateForAsk: false`) the panel becomes key on
    `show()`/`focus()` without activating Ember, so nothing else is called (finding M2; I's ember-darwin test proves
    it). *Linux:* `windowId` is never 0 while X11 is open, so the same takeFocus calls and the same hasFocus check.
19. `screenReaderOn` (:605-613) → `sys.a11y.screenReaderOn()` (cache inside the Linux adapter, moved verbatim).
20. `captureContext` (:636-642): `selected = active && active.pid !== process.pid && platform.clipboard ? platform.clipboard.readSelection(active.id).catch(() => "") : Promise.resolve("")`.
21. `openAsk` (:667): `const held = look && platform.keyboardHold ? platform.keyboardHold({ log: … }) : null;`.
22. Sign-in (:886-889): the keyring text becomes `\`Signed in. ${sys.words.keyringMissing}, so you'll need to sign in again next time.\``
    (Linux: identical). `signInError` passes `{ reinstall: sys.words.reinstall }` to `explainStartError` (§4.10).
23. Autostart (:966-976): `sys.autostart.sync(settings.get().startAtLogin)` inside today's try/log; `:976` and `:1374`
    use `sys.autostart.launchedAtLogin(process.argv)`. *Linux:* `syncAutostart(on, launchCommand(...))` and
    `argv.includes("--autostart")`.
24. Clipboard owner (:1013-1018): `if (!emberXid && platform.clipboard) emberXid = platform.clipboard.ownerId(w);`; will-quit
    (:1030-1032): `emberXid && platform.clipboard ? platform.clipboard.handOff(emberXid).then(…) : Promise.resolve()`.
25. Session end (G10), new: `let sessionEnding = false; const endSession = (source: string) => { if (sessionEnding) return; sessionEnding = true; log.info("app.session_end", { source }); try { settings.flush(); } catch (err) { log.warn("settings.not_saved", { err }); } borrowRef?.stop(); inputRef?.releaseAll(); sidecarRef?.stop(); voice?.stop(); };`
    hooked only by `sys.lifecycle.sessionEnd`: `"window-session-end"` → in `browser-window-created`
    `w.on("session-end", () => endSession("session-end"))`; `"power-monitor-shutdown"` → `powerMonitor.on("shutdown", () => endSession("shutdown"))`.
    The will-quit handler (:1023-1034) returns early (no `preventDefault`, no 3 s wait) when `sessionEnding`.
    *Linux:* `sessionEnd` is null: nothing is hooked, `sessionEnding` stays false.
26. macOS application menu, new: when `sys.lifecycle.appMenu`, after ready
    `Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Ember", submenu: [{ label: "Settings…", accelerator: "Command+,", click: () => showHome() }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: "Quit Ember", accelerator: "Command+Q", click: () => void quitEmber() }] }, { role: "editMenu" }, { role: "windowMenu" }]))`.
    The Edit menu is what makes Cmd+C/V/X/A/Z work in the settings window's fields on macOS. *Linux:* `appMenu` false.
    On win32 also false (Electron's default menu isn't shown in Ember's frameless/menu-less windows today; unchanged).
27. Windows Start Menu shortcut, new: after ready `sys.lifecycle.ensureShortcut()` (WS: only when packaged). *Linux:* no-op.

`whenReady()`:
28. `const ws = wsRef = platform.openWindows(log); wsState = ws;` replaces :1048-1049. `let compositing = ws ? ws.hasCompositor() : false;`
    (win32/darwin: always true, so the overlay is made and the ask box is transparent).
29. `cursor()` (:1056-1061) → `const p = ws?.pointer(); if (!p) return screen.getCursorScreenPoint(); const d = ws!.toDipPoint(p); return { x: d.x, y: d.y, buttons: p.mask & 0x1f00 };`.
    *Linux:* `toDipPoint` divides by the primary scale factor, as today.
30. `makeOverlay` (:1074-1084): `new OverlayManager(() => settings.get(), log.child("overlay"), cursor, platform.overlay)`;
    `o.systemReducedMotion = sys.a11y.systemReducedMotion()` inside today's try.
31. `makeHandle` (:1086-1092): `new HandleWindow(() => settings.get(), !overlay, { floating: platform.overlay.floating("handle"), forward: platform.overlay.forward })`.
32. Compositor watch (:1098-1118): `if (ws?.compositorMayChange)`. *Linux:* true whenever X11 opened (today's `if (x11)`).
33. Runtime (:1164) → `locateRuntime({ appPath, resourcesPath, env, runtimeId: sys.paths.runtimeId, exe: sys.paths.runtimeExe })`.
34. Sidecar (:1167): `const sidecar = sidecarRef = new AtspiSidecar(sidecarScript(), log.child("atspi"), undefined, undefined, platform.sidecarLaunch({ appDir: __dirname, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged, userData, execPath: process.execPath }));`
    (port/host's 5th constructor parameter). *Linux:* `sidecarLaunch` is undefined, so `pickPython()` and the default
    env are used exactly as today.
    Helper status (C14, findings L7/W3), new: only when that launch was defined,
    `setTimeout(() => sidecar.status().then(s => { helper = toHelperStatus(s); }, () => { helper = null; }), sys.autostart.launchedAtLogin(process.argv) ? 60_000 : 10_000).unref()`;
    `readEnvironment()` passes `helper` in `EnvContext` (port/host answers `status` without starting the provider and
    carries `detail`/`languageMode`/`dpi`/`processDpi`, PH correction; 60 s at login keeps the probe out of the cold
    start, W18e). *Linux:* no launch, no fetch, `helper` stays undefined.
35. Perception (:1169-1186): `x11: ws`, `screenBounds: () => ws ? ws.screenBounds() : primaryScaledUnion()` (today's
    inline function kept as the fallback when there is no window system), `words: sys.words`,
    `isSecurityWindow: sys.privacy.isSecurityWindow`.
36. Audit (:1189): `new AuditLog(path.join(userData, "audit"), undefined, sys.auditSink(err => log.warn("audit.journal_failed", { err })))`.
37. Input (:1198-1199): `const input = inputRef = platform.openInput(ws, log);` (the `xtest.unavailable` warning moved into
    the Linux `openInput`, same event and fields). `flyTo`'s `scale()` goes; `flyTo: b => setState({ focus: b && b.width > 2 && b.height > 2 ? ws!.toDip(b) : null })`.
38. `CursorBorrow` (:1214-1218): `new CursorBorrow(input, { onChange, mayRefocus, keys: sys.keys })`. Confirmer
    (:1193): `blocked: () => (borrowRef?.driving ?? false) || (inputRef?.pointerLags === true && Date.now() - (borrowRef?.lastSyntheticKeyAt ?? 0) < 500)`
    (defence in depth for asynchronous posting on macOS: a hot-key callback that arrives after the borrow ended still
    can't answer a question). *Linux:* `pointerLags` is undefined, so today's `borrowRef?.driving ?? false`.
39. Desk (:1222-1242): `const deskManager = platform.desk ? platform.desk.create(log.child("desk"), benchLog ? { env: { EMBER_BENCH_LOG: benchLog } } : {}) : null;`
    `deskManager?.onDead(…)`; will-quit uses `deskManager?.stop()`. `DeskView` is still constructed (IPC only) with
    `windowId: w => ws?.windowId(w) ?? 0`.
40. Hands (:1243-1285) — built whenever a window system exists (C8: tier 1 needs no input):
    `const hands: Hands | undefined = ws ? { perception, sidecar, audit, confirmer, policy: new PolicyEngine({ …today's options…, isTerminalApp: name => sys.apps.isTerminalApp({ id: name, name }), keys: sys.keys, os: platform.os, isSecurityWindow: sys.privacy.isSecurityWindow }), flyTo, currentWindow, pointer: input ? () => input.pointerState() : undefined, activationKey: input ? (…today…) : undefined, clipboard: electronClipboard(clipboard, ClipboardItem, undefined, sys.clipboardFormats), desk: platform.desk && deskManager && platform.desk.available().ok && policy.features.desk !== false ? () => (deskPlace ??= platform.desk!.openPlace(deskManager, {…})) : undefined, onDesk: platform.desk ? (place, previous) => {…} : undefined, cursor: borrow && input ? {…today…} : undefined } : undefined;`
    `currentWindow` uses `sys.privacy.isSecurityWindow`. *Linux:* `ws` is non-null exactly when `x11` was, and
    `platform.desk` is the Linux factory, so every field is what it is today.
41. `AgentHost` (:1286-1314) gains `system: sys` (`SystemPlatform` satisfies `WorkerSystem`, §4.9, structurally).
42. Voice (:1346-1350): `monitor: settings.get().voice.speakerRejection && sys.voice.speakerMonitor`. *Linux:* `&& true`.
    Voice consent (macOS): in the settings `onChange` that sees `voice.consent` turn true, `void sys.lifecycle.askMicrophone?.()`
    before `voice.setWanted(true)` (so the TCC prompt comes with context). *Linux:* absent.
43. will-quit `x11?.close()` (:1062) → `ws?.close()`.

No `process.platform`, `process.env.DISPLAY` or `getNativeWindowHandle` remains in main.ts after Phase 1 (a grep test in
P1-A's `test/unit/platform-boundary.test.ts` checks `app/main/**/*.ts` outside `platform/` for `process.platform` and
`.getNativeWindowHandle(`; allowed exceptions are listed in the test with a reason).

### 4.2 `app/main/windows.ts` (P1-A)

`isTrustedSender(url)` → `url.startsWith("file://") && decodeURIComponent(url).includes("/renderer/")`. File URLs use
`/` on every OS; the Windows `\` check rejected every settings IPC (window-system §5.4). *Linux:* `path.sep === "/"`, the
same string. Test: `test/unit/trusted-sender.test.ts` with Linux, Windows (`file:///C:/Program%20Files/Ember/resources/app/dist/app/renderer/home/index.html`)
and macOS URLs, and a `file:///tmp/evil/index.html` rejection.

### 4.3 `app/main/overlay.ts` (P1-A)

- Constructor gains a fourth parameter `private shaper: OverlayShaper = linuxOverlayShaper()` (imported from
  `platform/linux/overlay-shaper.ts`, which is Electron-free), so existing tests keep today's XShape path.
- `applyHits` (:209-231): `if (hit && this.shaper.setInputRegion(o.win, rects, scale))`, and the re-apply after
  `setIgnoreMouseEvents(false)` calls `this.shaper.setInputRegion(o.win, rects, scale)`. `xidOf` moves into the Linux shaper.
- One helper `private passThrough(win) { if (this.shaper.forward) win.setIgnoreMouseEvents(true, { forward: true }); else win.setIgnoreMouseEvents(true); }`
  used at :229, :284, :303 (revive) and in `tick` (:357: `over ? win.setIgnoreMouseEvents(false) : this.passThrough(win)`).
- `create` (:254-286): `...this.shaper.floating("overlay").options` spread after `title`, before `webPreferences`; line
  :283 becomes the `allWorkspaces` rule (§2.1 `FloatingWindow`).
- `stop` (:74-83): `this.shaper.release()` instead of `closeInputShape()`.
*Linux:* the shaper calls `setInputShape(readUInt32LE(0), rects, scale)` and `closeInputShape()`, `forward` is false,
`options` is `{}`, `allWorkspaces` is `{ visibleOnFullScreen: true }`: `test/unit/overlay-shape.test.ts` passes unchanged.
New `test/unit/overlay-hover.test.ts`: with a fake shaper whose `setInputRegion` returns false and `forward: true`, the
hover path flips with `setIgnoreMouseEvents(true, { forward: true })`; with `forward: false`, with one argument; held
buttons freeze the state (takesPointer).

### 4.4 `app/main/handle.ts` (P1-A)

Constructor `(settings, fallback, o: { floating?: FloatingWindow; forward?: boolean } = {})`: options spread
`...(o.floating?.options ?? {})` last before `webPreferences`; :56 `setVisibleOnAllWorkspaces(true)` → the
`allWorkspaces` rule (default `"plain"`); `setClickThrough(on)` (:96-98) → `on && o.forward ? setIgnoreMouseEvents(true, { forward: true }) : setIgnoreMouseEvents(on)`.
*Linux:* main passes the Linux floating (`{}` / `"plain"`) and `forward: false`: the same calls.

### 4.5 `app/main/ask.ts` (P1-A)

Options gain `windowId?: (w: BrowserWindow) => number` (default `w => w.getNativeWindowHandle().readUInt32LE(0)`) and
`floating?: FloatingWindow`. `reveal()` (:123) calls `takeFocus(windowId(win))` whatever the id (0 included; main's
callback decides, §4.1 item 18); `isWindow(id)` (:223-225) is `id !== 0 && windowId(win) === id`, so an unknown id never
matches the box (`mayRefocus`, main.ts:1217, has no guard of its own). `build()` spreads `floating.options` and applies
`allWorkspaces` (Linux: null → no call, as today). *Linux:* main passes `ws.windowId` (= `readUInt32LE(0)`, never 0
with X11 open), the same numbers and calls. New `test/unit/ask-window-platform.test.ts` (P1-A adds tests only):
`isWindow(0)` is false with a box whose id reads 0; `takeFocus` runs with id 0.

### 4.6 `app/main/desk/view.ts` (P1-A)

Options gain `windowId?: (w: BrowserWindow) => number` (same default); `isWindow(id)` (:203-205) uses it and is false
for `id === 0`. Nothing else:
the desk is Linux-only and the view only ever shows a Linux desk. *Linux:* identical.

### 4.7 `app/main/perception/index.ts` and `perception/capture.ts` (P1-B)

- `PerceptionOptions.x11: PerceptionWindows | null` (was `X11 | null`; the field name stays so tests and the desk's
  `openDeskPlace` keep compiling); new optional `words?: Pick<PlatformWords, "shellUnchecked" | "overviewOpen">`
  (default `PLATFORM_WORDS.linux`) and `isSecurityWindow?: (w) => boolean` (default policy's Linux one).
- `perceive` (:415-424): the two noShot texts use `words.shellUnchecked` / `words.overviewOpen`; after the
  `isSecurityWindow` check add `if (this.platformDialog()) return noShot("a system dialog is open, so Ember looks away until it's done");`
  where `platformDialog() { try { return x11.systemDialogOpen?.() ?? false; } catch { return true; } }` (fails closed, C10).
- `systemDialogOpen()` (:543-545) → `(await this.shellOverlays()).dialog || this.platformDialog()` (the worker's
  `withCursor` guard sees both).
- Every one of the five call sites of the imported Linux `isSecurityWindow` (perception/index.ts:107, 320, 323, 419,
  579-580: `isPrivate`, `x11WindowLines`, the active-window refusal in `perceive`, `privateWindows`) calls
  `this.o.isSecurityWindow` instead; the import goes. :323 already passes `wmClassName` (the Win32 class on Windows),
  so the class rows of §9.11 reach it.
- `captureRect(x11: Pick<PerceptionWindows, "capture">, …)` (capture.ts:68-77): `const r = x11.capture(…); img = r instanceof Promise ? await r : r;`
  inside today's try/finally, so the overlay comes back right after the pixels on every OS and a synchronous capture
  stays synchronous (no extra microtask on Linux).
*Linux:* `systemDialogOpen` is absent on the Linux window system, so `platformDialog()` is false; words and the
security check default to today's. Tests: `test/unit/perception-platform.test.ts` (async capture fake resolving after
a delay: the overlay is restored only after it resolves; `systemDialogOpen` throwing → no screenshot; an async capture
with a negative origin keeps `rect.x < 0` and masks land at the right offsets; a fake `isSecurityWindow` that matches
`credentialuibroker` blocks the screenshot, drops the window line and masks the window: one case per call site).

### 4.8 `app/main/hands/borrow.ts` and `hands/keymap.ts` (P1-C)

As §2.4: `parseCombo(combo, kc)`, `canonicalCombo(combo, kc)`, `CursorBorrowOptions.keys`, `onScreen`, the `textKey`
typing path, the one-step-behind pointer tolerance behind `x.pointerLags`, `lastSyntheticKeyAt`, and the
`blockedReason` refusal at the start of a borrow.
*Linux:* `kc` defaults to `KEYS.linux`, which has no extra modifiers (so `mod+s` still throws "unknown modifier"),
XInput has no `onScreen`/`textKey`/`blockedReason`/`pointerLags`, so `check()` is today's code (borrow-platform test: a
fake input without `pointerLags` whose user moves to the previous step's position takes over at once, as
`borrow.test.ts` expects; with `pointerLags: true` that position is Ember's). `keymap.ts` changes only if `parseCombo`
callers there need `kc` (none today).

### 4.9 `app/main/agent/worker.ts` (P1-C)

- `WorkerDeps` gains `system?: WorkerSystem`, defined in worker.ts:
  `export interface WorkerSystem { os: OS; keys: KeyConventions; words: PlatformWords; shortcuts: ShortcutTable; apps: Pick<AppCatalog, "list" | "find" | "launch" | "isTerminalApp" | "programsOf" | "appKey">; settings: SystemSettings; privacy: Pick<PrivacyVocabulary, "isSecurityWindow"> }`.
  When absent, `LINUX_WORKER_SYSTEM` (built from today's `hands/system` imports, `KEYS.linux`, `PLATFORM_WORDS.linux`,
  `SHORTCUTS.linux`) is used, so `worker-tools.test.ts` and friends construct workers as today. Tier-0 is injected
  (worker-host-desk §5.3); the `hands/system` import stays only for that default.
- `change_setting` (:964-972) is registered only when `Object.keys(sys.settings.available).length > 0`; description,
  `z.enum` keys and audit text come from `available`; it calls `sys.settings.change`.
- `open_app`/`open_on_desk` (:973-1024): `sys.apps.find(sys.apps.list(), name)`, `sys.apps.isTerminalApp`,
  `sys.apps.launch`, `programsOf` → `sys.apps.programsOf(app)` (moved to hands/system.ts, §4.15), and the window match
  `programs.has(sys.apps.appKey(w.app))` (C6). The description's examples use `sys.words.openAppExamples`.
  `open_on_desk` keeps using hands/system directly (Linux-only tool, `this.d.desk` gates it).
- `press_keys` description (:1030) uses `sys.words.keyExamples`.
- :1082 → `\`Pick one in settings (${sys.shortcuts.settings.label}).\``; :1655 → `sys.words.fileDialogPathHint`.
- "Try open_on_desk." (:2196, :2229, :2906) → `this.d.desk ? "Try open_on_desk." : "Tell the user in finish_task."`.
- The keys of §2.4 (`kc = sys.keys`), including every call of an exported key helper (`typedChar`, `replacesSelection`,
  `isActivatingKey`, `afterKeys`; worker.ts:461-465, 483, 517, 519, 2669, 2675, 3084).
- `withCursor`'s own guard (worker.ts:2909, "an authentication prompt has the keyboard → never") calls
  `this.sys.privacy.isSecurityWindow(w)` instead of the imported Linux function (the import goes), so on Windows and
  macOS it matches `credentialuibroker`/`consent`/`SecurityAgent` and fails closed on its own. `LINUX_WORKER_SYSTEM.privacy`
  is today's function.
- `workerSystemMessage({ words: sys.words, settings: sys.settings.available, desk: !!this.d.desk })`,
  `guideSystemMessage({ words: sys.words })` (:1097).
- `dialogNote` (:216) uses `FILE_PATH_WORDS[sys.os]` from policy/vocabulary.ts (Linux: today's regex).
- `LAUNCHERS` (:412) moves to `hands/terminals.ts` as `LAUNCHERS[os]` (used by `programsOf`).
*Linux:* the default/injected Linux system gives today's strings; with a desk the hints are unchanged (allowed change 3
otherwise). Tests: `test/unit/worker-platform.test.ts`: tool names per platform fake (no `change_setting` with empty
`available`; no `open_on_desk` without desk); `open_app` matches `"notepad"` against an `app` of `"Notepad"` through
`appKey`; darwin keys press `["cmd+a", "Delete", "cmd+v"]`; Linux still `["ctrl+a", "Delete", "ctrl+v"]`; with a
win32 fake system whose active window is `credentialuibroker`, `press_keys` is denied before any borrow; on darwin
`cmd+a` then `cmd+v` marks the field replaced (`afterKeys` with `KEYS.darwin`).

### 4.10 `app/main/agent/host.ts`, `conductor.ts`, `presenter.ts`, `persona.ts`, `worker-persona.ts`, `clipboard.ts` (P1-C)

- host.ts: `AgentHostOptions.system?: WorkerSystem` (default Linux) handed to `makeWorker` (`WorkerDeps.system`), to the
  conductor (words for `describe_screen`'s fallback, shortcuts for the model-picker hint) and the presenter. The
  `TERMINAL` request regexes (host.ts:29-42) become `TERMINAL_REQUEST[sys.os]` from `policy/vocabulary.ts` (Linux rows
  moved verbatim; P1-C owns both files). `explainStartError(err, ctx)` gains `ctx.reinstall?: string` (default today's
  "Reinstall Ember (sudo dnf reinstall ember)."). `Hands` itself is unchanged (C8 is main's job).
- conductor.ts:108 → `(${words.noScreen})`; presenter.ts:45 → `\`Pick another one in settings (${shortcuts.settings.label}).\``.
- persona.ts: `identity(words)`, `toolRules(words)` functions; `IDENTITY`/`TOOL_RULES` stay exported as
  `identity(PLATFORM_WORDS.linux)`/`toolRules(PLATFORM_WORDS.linux)`; `emberSystemMessage(words = PLATFORM_WORDS.linux)`.
- worker-persona.ts: `workerSystemMessage(o: { words?: PlatformWords; settings?: Partial<Record<SettingName, string>>; desk?: boolean } = {})`
  with defaults Linux words, `SETTINGS` (all six) and `desk: true`; rule 3 is built by `settingsRule(available)` (dropped
  when empty), rule 4's desk sentence only when `desk`; `guideSystemMessage(o: { words?: PlatformWords } = {})`.
- clipboard.ts: `electronClipboard(cb, Item, timeoutMs = SAVE_TIMEOUT_MS, formats: ClipboardFormats = CLIPBOARD_FORMATS.linux)`
  with the per-OS table from `agent/clipboard-formats.ts` (P1-D is its only Phase 1 owner and moves `savableFormat`'s
  body there; P1-C merges after P1-D and only imports and re-exports it: Linux row = today's `savableFormat` logic,
  the KDE marker, no own-text markers; Windows/macOS rows equal to the Linux row until V); clipboard.ts then re-exports
  `savableFormat` from there instead of defining it (one copy of the rule);
  `savableFormat`/`holdsPassword` keep their exports and Linux meaning; the instance uses `formats.savable` and
  `formats.passwordMarker`, and writes `formats.ownTextMarkers` (empty on Linux) beside its own paste text.
- The exported constants `WORKER_RULES`, `WORKER_IDENTITY`, `GUIDE_*`, `IDENTITY` and `TOOL_RULES` stay exported with
  today's exact text (the Linux, desk-on, all-settings rendering): test/integration/persona.test.ts:70 asserts
  `toContain(WORKER_RULES)` on the el8 suite.
*Linux:* a unit test pins `workerSystemMessage()` and `emberSystemMessage()` to frozen copies of today's output,
`WORKER_RULES` and the other exported constants to their frozen text, and `settingsRule(SETTINGS)` to today's rule-3
text; `explainStartError` without `reinstall` gives today's text.

### 4.11 `app/main/policy/policy.ts` and new `policy/vocabulary.ts` (P1-C)

§2.4 for keys. `vocabulary.ts` holds, keyed by `OS`, `SECURITY_APP`, `SECURITY_TITLE`, `TABBED_APP`, `WEB_APP`,
`OFFICE_APP`, `RISKY_EXTRA` (extra risky labels added to `RISKY`'s alternatives), `RUNS_PROGRAM_EXTRA`,
`RUN_FILE_DIALOG_EXTRA`, `FILE_PATH_WORDS`, `TERMINAL_REQUEST` (host.ts:29-42); Linux rows are today's regexes moved verbatim (policy.ts:194, :398-400,
:625-645, :668, :1504, :1507); Windows and macOS rows are `null`/empty in Phase 1 (V fills them, §9.11).
`TYPING_REFUSED` (boxes where typing a bare program name is refused, §9.11) is read by a new generic check in
`decide()` for `type_text`/`fill` requests (empty on Linux, so it never fires there).
`isSecurityWindow(w, os = "linux")`, `PolicyEngineOptions.os`/`keys`/`isSecurityWindow`. *Linux:* every existing
`policy.test.ts` case passes unchanged (they call without `os`/`kc`).

### 4.12 `app/main/hotkey.ts` (P1-A)

Doc comments only: the chord check is an X11 re-report guard; off Linux main passes `null` (trusted, debounced 300 ms).

### 4.13 `app/main/environment.ts` (P1-D)

`EnvInputs` gains optional `shortcuts?: ShortcutTable` (default `SHORTCUTS.linux`), `windows?: { build: number; elevated: boolean; session: "console" | "rdp" | "service"; powershell: "full" | "constrained" | "policy" | "blocked-download" | "missing" | "unknown"; dpiMixed: boolean }`
and `mac?: { version: string; accessibility: boolean; screen: MediaAccess; microphone: MediaAccess; inputMonitoring: boolean | null; inApplications: boolean; root: boolean }`
(§9.8 says how each is derived).
`inspectEnvironment` keeps today's body for `platform === "linux"` and branches for `"win32"`/`"darwin"` per system.md
§9.2's table (checks `platform`, `os`, `session`, `accessibility`, `screen-recording` (darwin), `elevated`,
`location` (darwin), `shortcuts`; no `desktop`/`glibc`). The shortcuts check text is
`\`${sc.ask.label} ask · ${sc.stop.label} stop · ${sc.settings.label} settings · ${sc.mute.label} microphone\`` and the
taken list maps each accelerator to its `label` (Linux: `accel.replace(/Control/g, "Ctrl")` equals `label`).
`Check.fix: FixId`. *Linux:* `environment.test.ts`'s RHEL fixture output is unchanged; new fixtures for Windows 11 and
macOS 14 inputs in `test/unit/environment-platforms.test.ts`.

### 4.14 `app/main/doctor.ts` (P1-D)

`DoctorProbes.desk` and `.sandbox` may be null (row left out); new optional `os?: OS` (default `"linux"`), `helper?:
HelperStatus | null` (the "Accessibility helper" row, win32/darwin only), `extra?: PlatformDoctorRow[]` (appended
before `copilot`), `shortcuts?`, `words?: Pick<PlatformWords, "reinstall">`, `policyLocation?: string`. The Linux fix
texts (session, compositor, pyatspi, libXtst, pactl, speech-dispatcher, desk dnf line, chrome-sandbox, sysctl) are used
exactly when `p.os === "linux"`; the discriminator is that field, never the platform check's detail text (on Linux
arm64 that text is "linux/arm64 is not supported in v1", which must not flip the box to Windows/macOS wording). Off Linux: compositor row ok "Windows/macOS always composites", xtest row from `xtest`
with "SendInput"/"Accessibility" wording, microphones from the platform probe, speech "Uses the system's voices".
"(Ctrl+Alt+E)"/"(Ctrl+Alt+Space)" come from `shortcuts`; "None (optional: /etc/ember/policy.json)." from
`policyLocation`. *Linux:* the doctor cases in `test/unit/packaging.test.ts` (port/packaging's file; there is no
`doctor.test.ts`) pass unchanged and are not edited; P1-D's new cases go in a new `test/unit/doctor-platforms.test.ts`.

### 4.15 `app/main/hands/system.ts` and new `hands/terminals.ts` (P1-D)

- `DesktopApp`'s `argv?: string[]` (pre-split; always set on win32/darwin, `exec` undefined there) and
  `programs?: string[]` (declared by step 0) get their uses. Every `execArgv(app.exec)` consumer uses `app.argv ?? execArgv(app.exec ?? "")`
  (`hasBuiltInShell`, `runsTerminal`, `launchApp`'s fallback, `programsOf`; desk/place.ts:146 is Linux-only and left).
- `programsOf(app, launchers = LAUNCHERS.linux)` moves here from worker.ts:698 (prefers `app.programs` when set).
- The vocabularies (`TERMINALS`, `SHELLS`, `INTERPRETERS`, `SHELL_MODULES`, `SHELL_APP*`, `WRAPPERS`, `REFUSED`, the
  name regex :321, `LAUNCHERS`) move to `hands/terminals.ts` as `Record<OS, …>` with Linux
  rows verbatim and Windows/macOS rows empty (V fills), plus `TERMINAL_CLASSES: Record<OS, readonly string[]>` (Linux and
  macOS empty). `isTerminalApp(app, os = "linux")` also answers true when `app.windowClass` is in `TERMINAL_CLASSES[os]`
  (Windows console hosts, §9.11; never on Linux, where the row is empty), `hasBuiltInShell(app, os = "linux")`;
  `named()` also strips `/\.(exe|com|bat|cmd|ps1|lnk|app)$/i` and `idWords` also splits on `!` and `_` **only when
  `os !== "linux"`** (system.md §2.4; on Linux the split set stays today's).
- The on/off and number decoding that `changeSetting`'s encoders use is exported as `parseOnOff(value): boolean`
  (and `parseScale(value): number`) so the Windows and macOS settings modules share the grammar.
- `appEnv(base, o)` gains `o.os?: OS` (default "linux"): win32 makes the KEEP/NEVER tests case-insensitive and adds the
  Windows KEEP names (system.md §2.2). Linux unchanged.
*Linux:* `tasks.test.ts`, `desk.test.ts`, `launch-app.test.ts` pass unchanged.

### 4.16 `app/main/autostart.ts`, `admin.ts`, `policy/audit.ts` (P1-D)

- autostart.ts: no change (wrapped). admin.ts: no logic change; `loadAdminPolicy` keeps its signature, and its JSON and
  schema half is exported as `parseAdminPolicy(raw, source)` with `lockedDown(source, error)` (§9.4: the Windows and
  macOS sources reuse them). audit.ts: export `journalAvailable(exists = fs.existsSync)` and use it in
  `journalSink`. *Linux:* identical.

### 4.17 `app/main/agent/runtime.ts` and `agent/auth.ts` (P1-D)

- runtime.ts: `locateRuntime(opts: { appPath; resourcesPath?; env?; runtimeId?: string; exe?: string })` builds
  `node_modules/@github/copilot-sdk-${runtimeId}/prebuilds/${runtimeId}/${exe}` (defaults `"linux-x64"`,
  `"copilot-runtime"`: today's RELATIVE); `ensureExecutable` is skipped when `exe` ends in `.exe`.
- auth.ts: `TokenStore.save` wraps `encryptString` in try/catch → `false` (allowed change 2); `ghCliToken(o: { path?: string; spawn?: { windowsHide?: boolean } } = {})`
  uses `o.path ?? "gh"` and spreads `o.spawn`; `resolveToken(store, o?)` passes them through; main passes
  `{ path: sys.ghCliPath() ?? undefined, spawn: sys.spawnDefaults }`. *Linux:* `"gh"` with no extra options.

### 4.18 `app/main/settings.ts` and new `app/shared/never-look.ts` (P1-D)

- never-look.ts: `NEVER_LOOK_DEFAULTS: Record<OS, readonly string[]>` (Linux: today's six entries; Windows/macOS `[]`
  until V), `NEVER_LOOK_NAMES: Record<string, string>` (today's names from copy.ts:6-16), `missingDefaults(list, os)`.
- settings.ts: the `privacy.neverLook` default (:46-47) is `[...NEVER_LOOK_DEFAULTS[HOST_OS]]` (`platform/os.ts`);
  `SettingsStore` options gain `renameRetries?: number` (default 0): on `EPERM`/`EBUSY`/`EACCES` from `renameSync` it
  retries that many times 50 ms apart (Windows antivirus/sync locks). Comments ":32 (Ctrl+Alt+M)", ":40 XDG autostart
  entry" become OS-neutral. *Linux:* `HOST_OS === "linux"` → the same default; retries 0.

### 4.19 `app/main/voice.ts` (P1-A) and the speaker monitor

`monitor` gating is in main (§4.1 item 42). voice.ts: `micHelp` (:343-348) gains an optional platform hint (the fix id
`open-microphone-settings` and its label) passed from main through `VoiceService` options `micHint?: string`.
*Linux:* no hint passed, today's text.

### 4.20 `app/shared/apps.ts` (P1-D)

`APP_NAMES` becomes `Record<OS, Record<string, string>>` (Linux: today's map; Windows/macOS `{}` until V);
`useAppNames(os)` sets the module's OS once at start-up (main, and the home renderer from `Status.platform.os`);
`friendlyApp(name)` strips `/\.exe$/i` first only when that OS is win32, then looks up `APP_NAMES[os]`. *Linux:* the
default OS is "linux"; `ui-copy.test.ts` and policy questions unchanged.

### 4.21 `app/shared/ipc.ts`, `app/renderer/home/{index.html,main.ts,copy.ts}` (P1-E)

- ipc.ts: `Status.platform?: { os: OS; shortcuts: Record<ShortcutId, { label: string; keys: readonly string[] }>; dataDir: string; settingsFile: string; auditCopy: string | null; micIndicator: string; permissionsNote: string; speakerRejection: boolean; fixLabels: Partial<Record<FixId, string>>; desk: boolean; autostartNote: string | null }` — **optional**, so the branch keeps compiling when P1-E merges before P1-A
  (today's main.ts `getStatus` builds a `Status` without it); while it is absent the renderer keeps today's Linux
  markup and strings.
- index.html: every `.chord` span gets `data-shortcut="<id>"` (:33 stop, :54 ask, :77 settings, :91 mute, :138 allow/deny)
  and keeps today's Linux `<kbd>` markup as its default content; :34 `<code id="data-dir">~/.config/ember</code>`; :91 the
  speakers sentence wrapped in `<span id="speaker-note">` and "GNOME shows…" in `<span id="mic-indicator">`; :31 a
  `<span id="permissions-note"></span>`; :146 `<code id="audit-dir">~/.config/ember/audit/</code>` and `#journal-hint`
  (hidden when `auditCopy` is null, its text from `auditCopy`); :47 a `<p id="autostart-note" hidden>`.
- main.ts (renderer): fills those from `status.platform` on every status (chords from `keys`; `speaker-note` hidden when
  `!speakerRejection`); :186 button text `status.platform.fixLabels[c.fix] ?? "Turn on"`; :217 `status.platform.settingsFile`;
  :731 `\`Microphone off (${shortcuts.mute.label} to turn on)\``.
- copy.ts: `tagline(…, askLabel)` (:66), the stop label (:167), `KEY_NAMES` (:99) **merged** as
  `{ ...KEY_NAMES, ...KEYS[os].labels }` (today's 30 entries stay; on Linux the four labels equal today's, so every "What
  Ember did" key line is unchanged: a P1-E test compares `keyLabel` output for every KEY_NAMES key), never-look
  defaults/names from `app/shared/never-look.ts` (`missingDefaults(list, os)`).
*Linux:* the defaults are today's strings, and the Linux `Status.platform` reproduces them (`dataDir` "~/.config/ember",
`auditCopy` the journal text exactly when systemd-cat exists — allowed change 4). `ui-copy.test.ts` stays green (its
never-look equality now compares `DEFAULT_SETTINGS.privacy.neverLook` with the shared `NEVER_LOOK_DEFAULTS[HOST_OS]`, so
it also holds on Windows and macOS CI; P1-E owns that one-line edit).

### 4.22 Files that do **not** change in Phase 1

`x11.ts`, `xshape.ts`, `hands/input.ts`, `hands/keybuffer.ts`, `hands/clipboard-handoff.ts`, `desk/desk.ts`,
`desk/place.ts`, `desk/agent*.ts`, `perception/sidecar.ts` (port/host owns its launch change), `perception/elements.ts`,
`follow.ts`, `revive.ts`, `logger.ts`, `app/voice/**` (port/voice), `sidecar/atspi/**`, `scripts/**` (port/packaging,
port/host's build entry), every preload.

---

## 5. The sidecar host: how Phase 1 and Phase 3 wire it (port/host is adopted, with its corrections)

`pkg-host.md` and port/host's code are authoritative for the host itself (`app/sidecar-host/**`: protocol, ids, tree,
secrets, labels, `roles.ts` with `uiaRole()`/`axRole()`, actions, `provider.ts` with `AxProvider`/`RawNode`/`RawWindow`/
`ProviderError`, `providers/uia.ts`, `providers/fake.ts`, `launch.ts` with `hostLaunch()`, the esbuild entry
`dist/app/ax-sidecar.cjs`) and for `AtspiSidecar`'s launch generalisation (a 5th constructor parameter
`launch?: SidecarLaunch`, `firstRequestMs` applied until the first answer, `windowsHide` passed to spawn), apart from the
PH corrections at the end of this document (status without the start gate and with `detail`; no respawn loop after a
fatal start; `EMBER_OWNER_PID`; `elementsAt(x, y, pid?)`; an exported `TEST_SWITCHES`; the bridge's `PSModulePath`).
This section only says how Ember starts it.

### 5.1 SidecarLaunch per platform

| | linux | win32 (WS, `win32/platform.ts`) | darwin (MS, `darwin/platform.ts`) |
|---|---|---|---|
| `sidecarLaunch(ctx)` | `undefined` (Python default, unchanged) | `hostLaunch({ execPath: ctx.execPath, host: <appDir>\ax-sidecar.cjs, uiaScript: <ps1, §5.2>, uiaCache: <userData>\uia-cache, env: hostEnv(deps.env, { os: "win32", packaged, ownerPid: process.pid }), platform: "win32", packaged })` | `hostLaunch({ execPath: ctx.execPath, host: <appDir>/ax-sidecar.cjs, env: hostEnv(deps.env, { os: "darwin", packaged, ownerPid: process.pid }), platform: "darwin", packaged })` |
| command | `pickPython()` | `ctx.execPath` = `Ember.exe` (dev: `node_modules\electron\dist\electron.exe`) | `ctx.execPath` = `Ember.app/Contents/MacOS/Ember` (dev: `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`) |
| args | `[ember_atspi.py]` | `[<appDir>\ax-sidecar.cjs]` | `[<appDir>/ax-sidecar.cjs]` |
| env added | PYTHON*, `EMBER_ATSPI_ID_BASE` | `ELECTRON_RUN_AS_NODE=1`, `EMBER_UIA_SCRIPT`, `EMBER_UIA_CACHE`, `EMBER_OWNER_PID`, `EMBER_ATSPI_ID_BASE` | `ELECTRON_RUN_AS_NODE=1`, `EMBER_OWNER_PID`, `EMBER_ATSPI_ID_BASE` |
| `firstRequestMs` | (5000, today) | 20 000 (port/host's `FIRST_REQUEST_MS.win32`) | 10 000 (`FIRST_REQUEST_MS.darwin`) |

- `firstRequestMs` is port/host's one constant (no second value here): 20 s on Windows (Windows PowerShell 5.1 start +
  `Add-Type` compile of `ember_uia.cs` with antivirus scanning: 3-10 s cold, about 1 s warm from the DLL cache); 10 s on
  macOS (the host starts in well under a second, but the first AX call into a Chromium or Java app can take seconds
  while the app builds its tree). The 5 s per-request timeout applies once the process has answered once. While the
  bridge is still starting, port/host answers later requests at once with its "still starting" error (`againMs` 0)
  instead of blocking, so a slow login start is not a kill-and-revive loop (W18e).
- The provider is chosen by the host (`providerKind`: the platform's own; `fake` only with `EMBER_AX_PROVIDER=fake` in an
  unpackaged host, and `hostLaunch` strips the test switches when packaged, so both hold). `hostEnv` keeps those
  switches only unpackaged, so Ember-level tests can still select the fake desktop.
- `hostEnv`/`cleanEnv` (§2.5) drop tokens (`appEnv`'s NEVER list) and `EMBER_*` (except `EMBER_LOG_LEVEL`), comparing
  names case-insensitively on Windows: the host never needs them, and the C# bridge it starts inherits its environment.
  `__PSLockdownPolicy` is **kept** (an administrator's Constrained Language Mode choice is honoured, never bypassed; the
  bridge then fails to start and the environment check says why, §9.8). The bridge's own environment is port/host's
  `bridgeEnv`, which sets `PSModulePath` to `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules` (departure 3).
- `EMBER_OWNER_PID` is Ember's main process id: the host and both providers never send an accessibility request into
  that process (it would switch Chromium's accessibility on for Ember's own renderers, flip
  `isAccessibilitySupportEnabled()`, and on macOS wait on Ember's own main thread). Its windows are still listed from
  the window facts alone, so `ownPid` filtering keeps working (PH and PU corrections; §5.3 for AX).
- Units: the host never scales. Windows reports physical pixels (the bridge is Per-Monitor-V2 aware, the same space as
  port/win32's window system); macOS reports points. `AtspiSidecar`'s scaling (`frameScale`/`matchFrame` k) then finds
  k = 1 on both. The bridge's ready line reports the threads' and the process's DPI awareness; when they differ the host
  logs `uia.dpi_mixed` and `status` carries both, which the environment check shows (§9.8, R22).

### 5.2 Paths, dev versus packaged

`ctx.appDir` is main.cjs's own folder (`__dirname`), so `ax-sidecar.cjs` is always found beside it:

| | development (`npm run dev`) | packaged (port/packaging layout) |
|---|---|---|
| `ax-sidecar.cjs` | `<repo>/dist/app/ax-sidecar.cjs` | Windows `Ember\resources\app\dist\app\ax-sidecar.cjs`; macOS `Ember.app/Contents/Resources/app/dist/app/ax-sidecar.cjs` |
| `ember_uia.ps1`, `ember_uia.cs` | `<repo>/sidecar/uia/` (`app.getAppPath()`) | `Ember\resources\sidecar\uia\` (`process.resourcesPath`) |
| `EMBER_UIA_CACHE` | `<userData>\uia-cache` = `%LOCALAPPDATA%\ember\uia-cache` | same |
| PowerShell | port/host's `powershellPath(env)`: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (never one on PATH) | same |

There is no `EMBER_UIA_POWERSHELL` variable (revision 1's is dropped: port/host builds the path from `SystemRoot`, and
a same-user process that could change Ember's environment could already change Ember's settings). The cache folder is
created by the bridge (`ember_uia.ps1`); it is per-user (`%LOCALAPPDATA%` ACL), the DLL name carries the source's
SHA-256, and the bootstrap recomputes the source hash on every start (G4: a stale DLL can't be loaded for a changed
source; a same-user attacker who can write `%LOCALAPPDATA%` can already write Ember's own settings, so no stronger check
is added; noted in §12).

The status fetch (C14): when `sidecarLaunch` returned a launch, main asks `sidecar.status()` once, 10 s after ready
(60 s when started at login), and keeps the `HelperStatus` (`toolkitAccessibility`, `detail`, `languageMode`, `dpi`,
`processDpi`) as `EnvContext.helper` for `readEnvironment` (a failed or timed-out status → `null`). port/host answers
`status` without starting the provider first (PH correction): it reports the provider's last start failure as `detail`
(the bridge's fatal line, or "PowerShell refused to run the bridge (execution policy)" when the process exited before
writing any line and its stderr names an execution policy) and `languageMode` from the fatal line. Linux never does
this (the Python sidecar keeps starting on demand only).

In development on macOS the TCC grants go to the app that started Electron (Terminal, iTerm2, Visual Studio Code), not
to Electron: DOC says so, and port/packaging's scripts gain an optional `dev:mac` that starts Electron through
LaunchServices (`open -n -W node_modules/electron/dist/Electron.app --args "$PWD"`) so the grants go to "Electron"
instead of the developer's terminal (FX-PK).

### 5.3 The macOS AX provider (package AX; after port/host and port/darwin merge)

Files (AX owns): `app/sidecar-host/providers/ax-darwin.ts` (the `AxProvider`), `providers/ax-darwin-read.ts` (attribute
batching → `RawNode`/`RawWindow`), `providers/ax-darwin-api.ts` (the narrow `AxApi` interface the provider calls, and its
koffi implementation over `app/main/platform/darwin/{cf,ax,cg}.ts` plus the few extra symbols below, bound once in this
module), `test/unit/sidecar-host-ax-darwin-*.test.ts`, `test/integration/ax-sidecar-darwin.test.ts`,
`test/fixtures/mac_bench.js`; and, as **whole files for its duration** (PH has merged before AX starts and I starts
after AX merges, so nobody else edits them meanwhile), `providers/index.ts` (port/host's "unsupported" darwin stub is
replaced) and `roles.ts` (AX additions to `axRole`). Ownership is sequential: PH → AX → I.

`AxApi` (so every unit test runs on Linux against a fake tree):

```ts
interface AxApi {
  trusted(): boolean;                                                     // AXIsProcessTrusted()
  systemWide(): AxRef;                                                    // AXUIElementCreateSystemWide(), timeout set once
  app(pid: number): AxRef;                                                // AXUIElementCreateApplication(pid), cached per pid, timeout 0.8 s
  attrs(el: AxRef, names: readonly string[]): Map<string, AxValue | AxError>;   // AXUIElementCopyMultipleAttributeValues(el, names, 0, &out): ONE round trip; a failed slot holds an AXValue of kAXValueAXErrorType (5), decoded per slot as AxError (FX-PD: decodeAXValue's error type)
  attr(el: AxRef, name: string): AxValue | AxError;
  count(el: AxRef, name: string): number;                                 // AXUIElementGetAttributeValueCount
  range(el: AxRef, name: string, index: number, max: number): AxRef[];    // AXUIElementCopyAttributeValues (long child lists)
  settable(el: AxRef, name: string): boolean;                             // AXUIElementIsAttributeSettable
  actions(el: AxRef): string[];                                           // AXUIElementCopyActionNames
  set(el: AxRef, name: string, v: AxValue): AxError | null;               // AXUIElementSetAttributeValue
  perform(el: AxRef, action: string): AxError | null;                     // AXUIElementPerformAction
  at(x: number, y: number, pid?: number): AxRef | null;                   // AXUIElementCopyElementAtPosition(pid ? app(pid) : systemWide, x, y): app-scoped when the target is known
  pid(el: AxRef): number;                                                 // AXUIElementGetPid
  windowId(win: AxRef): number;                                           // _AXUIElementGetWindow (0 when it fails)
  hash(el: AxRef): string;                                                // CFHash as an exact unsigned 64-bit hex string (FX-PD: cf.hash keeps BigInt precision)
  same(a: AxRef, b: AxRef): boolean;                                      // CFEqual
  release(el: AxRef): void;                                               // CFRelease
  onScreenWindows(): { id: number; pid: number; owner: string; layer: number; bounds: Rect; title: string }[]; // cg.ts CGWindowListCopyWindowInfo
}
```

- **Messaging timeout**: `AXUIElementSetMessagingTimeout(systemWide, 0.8)` once at start (the process-wide default:
  C13; the main process separately uses 0.25 s), and `0.8` on every app element it creates. `kAXErrorCannotComplete`
  (-25204) → `ProviderError("busy")` and the pid is remembered as busy for 5 s, during which every call for that pid
  fails with `busy` at once (the Python sidecar's hung-app memory, sidecar-protocol-read §5.3); `kAXErrorInvalidUIElement`
  (-25202) → `gone`; `kAXErrorAPIDisabled` (-25211) → `denied`; `kAXErrorAttributeUnsupported`/`ActionUnsupported`/
  `NotImplemented` (-25205/-25206/-25208) → `unsupported`; `kAXErrorNoValue` (-25212) → the attribute is absent; anything
  else → `failed`. The same mapping applies **per slot** of an `attrs` batch: `CopyMultipleAttributeValues` with
  options 0 reports a failed attribute as an `AXValue` of `kAXValueAXErrorType` (or `kCFNull`) in its slot, not as an
  error return, so `CannotComplete` in any slot → `busy` (and the 5 s memory starts), `NoValue`/`AttributeUnsupported`/
  `kCFNull` → absent. The walk checks its deadline before every IPC and stops with `cut: ["time"]` once
  `deadlineMs - 800` has passed, so one stalled call can't overshoot the budget.
- **Attributes read per node** (one `attrs` call; `AXValue` is never in it): `AXRole`, `AXSubrole`, `AXTitle`, `AXDescription`,
  `AXHelp`, `AXPlaceholderValue`, `AXEnabled`, `AXFocused`, `AXSelected`, `AXExpanded`, `AXDisclosing`, `AXPosition`,
  `AXSize`, `AXTitleUIElement`, `AXMinValue`, `AXMaxValue`, `AXValueIncrement`, `AXModal`, `AXHidden`,
  `AXMenuItemMarkChar`, `AXRowCount`, `AXColumnCount`, `AXRowIndexRange`, `AXColumnIndexRange`, `AXIdentifier`. Children
  come from `AXVisibleRows` (AXTable, AXOutline), `AXVisibleChildren` (AXList, when present) or `AXChildren`, read with
  `count` + `range` so a 10 000-row list costs one call for its first `maxNodes` rows. A snapshot spends **at most three
  round trips per node** (the `attrs` batch, one children `range`, and the `AXValue` read below), so a 300-control
  Chromium page stays inside port/host's 1.5 s read budget: `actions(el)` is read only for the roles port/host lists
  actions for (roles.ts's actionable roles; rows and cells excluded), and `settable` is never asked while walking:
  `focusable` comes from the role and the presence of `AXFocused`, `editable` from the role (text field, text area,
  combo box, search field; not static text), and both are verified with `settable` in `element()`/`perform()`, where
  one node is involved. `name` = `AXTitle` || `AXDescription` (the
  host's label inference does the rest); `labelledBy` = the `AXTitleUIElement`'s `AXValue`/`AXTitle`; `value` = `AXValue`
  as text cut to 2000 characters, read by a second `attr(el, "AXValue")` call only for value-bearing roles (text
  fields, combo boxes, check boxes, radio buttons, sliders, incrementors, static text, cells) and **never for the
  `AXSecureTextField` subrole** (`password: true`; the first batch already told the subrole); `toggle` from `AXValue` 0/1/2 on check boxes and toggles; `range` from numeric
  `AXValue` + min/max/increment; `grid` from `AXRowCount`/`AXColumnCount` (or the counts of `AXRows`/`AXColumns`); `cell`
  from the index ranges' locations; `multiLine` for AXTextArea; `editable` and `focusable` as above.
- **Hidden nodes** (a security property, sidecar-protocol-read §7.1): AX has no SHOWING state, so the walk keeps the
  visible rectangle of the window intersected with every `AXScrollArea` ancestor's frame, and marks a node `offscreen`
  when its frame doesn't intersect it, when `AXHidden` is true, or when it has no frame and no visible children; the host
  then drops it with its subtree.
- **Role and state mapping**: in port/host's `roles.ts` (`axRole(n, ctx)` with `vocabulary: "ax"`). The provider passes
  `platformRole`/`platformSubrole` and the facts above, and never maps roles itself; additions it needs (for example
  AXOutline rows → `tree item`) go into `roles.ts` as part of the AX package (AX owns `roles.ts` edits after port/host merges).
- **Stable keys** (`RawNode.key`, for remembered secret fields across host restarts, and compared for identity inside
  one read by port/host's actions, e.g. `selectedAlone`): `${pid}:h${hash(el)}` with `hash` the exact unsigned 64-bit
  CFHash as hex (koffi hands values above 2^53 back as BigInt; `Number()` would round distinct elements together).
  Within one `snapshot`/`children` answer the provider detects duplicate keys and, for those nodes only, uses the
  index-path key below (logs `ax.key_collision`). CFHash of a remote AXUIElementRef is computed from the pid and the
  app's element token, so it should be the same in a new host process; **verify in CI** (the darwin integration test
  reads the bench twice from two host processes and compares the password field's key, and reads its 200-row list with
  zero duplicate keys). Fallback if it differs: `${pid}:p${windowId}/${childIndexPath.join(".")}:${role}` (stable while
  the window's structure is), selected by one constant `KEY_MODE` in `ax-darwin.ts`.
- **Windows**: `topWindows()` takes the on-screen CG list (front to back), groups it by pid, and for every pid except
  Ember's own (`EMBER_OWNER_PID`, and `process.ppid` as a fallback) reads each app's `AXWindows`; Ember's windows are
  returned as CG-only `RawWindow`s (no AX element is ever created for Ember's process, which would message Ember's busy
  main thread and switch Chromium's accessibility on for its renderers; `ownPid` filtering stays the host's). For the
  others it reads (batched `AXRole`, `AXSubrole`, `AXTitle`, `AXPosition`, `AXSize`,
  `AXModal`, `AXMain`, `AXMinimized`), and maps each AX window to its CGWindowID with `windowId(win)`; if that fails, by
  the CG entry of the same pid whose bounds equal the AX frame within 1 point (then by title). `RawWindow.key` =
  `String(cgWindowId)` (the protocol's window `path`), `native` = the id, `app` = the CG `kCGWindowOwnerName` (the same
  string port/darwin's window system puts in `wmClass`), `active` = the app is the system-wide `AXFocusedApplication`
  and the window is `AXMain`, `offscreen` = minimised or not in the on-screen list. A window with no CGWindowID gets
  `key = ${pid}:h${hash}` and can't be a screenshot target (Perception fails closed when `locate` can't match it).
- **Chromium and Electron apps**: an app whose windows report no children gets `AXManualAccessibility = true` set on its
  app element once (Chromium then builds its tree; the next read sees it). Never `AXEnhancedUserInterface` (it breaks
  window animations and window managers).
- **elementsAt / focused / children / textInfo**: `elementsAt(x, y, pid?)` (port/host passes the target window's pid,
  which `at_point` always knows: PH correction) hit-tests app-scoped with `at(x, y, pid)`, so a point covered by Ember's
  own overlay or bubbles still lands in the target app and Ember is never messaged; system-wide only without a pid
  (never into Ember's pid: such a hit answers `[]` and the host descends the target window, as it already can). Then
  `AXParent` up to the `AXWindow`, reversed,
  each node batched; `focused()` = system-wide `AXFocusedApplication` → `AXFocusedUIElement` → its `AXWindow`;
  `children(h, max)` = `range(h, "AXChildren", 0, max)` (for an `AXPopUpButton` its `AXMenu`'s children when the menu
  exists, else `[]`: a closed pop-up's options aren't readable without opening it, so the host answers
  background_unavailable for a background window); `textInfo` = `AXValue` (text roles, never secure ones → `{ secret: true }`),
  `AXSelectedText`, `caretAtEnd` from `AXSelectedTextRange` vs `AXNumberOfCharacters`.
- **perform**: invoke → `AXPress`; toggle → `AXPress`; select → set `AXSelected` true when settable, else `AXPick`
  (menu items) or `AXPress` (radio buttons, tabs); expand/collapse → set `AXExpanded`/`AXDisclosing`, else `AXShowMenu`
  for expand on pop-ups; setValue → set `AXValue` (a CFString; refused with `denied` on `AXSecureTextField`); setRange →
  set `AXValue` (a CFNumber) or `AXIncrement`/`AXDecrement` steps when not settable; focus → set `AXFocused` true;
  scrollIntoView → `AXScrollToVisible`; legacy → `unsupported`. The provider never calls `AXRaise` or sets
  `AXFrontmost` (the host never raises windows for a tier-1 action).
- **Permission**: `accessibility()` = `trusted()`. When it is false every other call throws `ProviderError("denied",
  "Ember needs the Accessibility permission (System Settings > Privacy & Security > Accessibility).")`. The child runs
  as Ember's own executable, so TCC attributes it to Ember.app (the responsible process) when Ember is started by
  LaunchServices (Finder, Dock, login). CI's in-process tests can't show this (every step inherits the runner's granted
  ancestors); the packaged app's doctor run through `open -a` does, with its "Accessibility helper" row (§10 item 3,
  §9.9). The integration test still prints `status().toolkitAccessibility` from inside the host and fails when
  `EMBER_AX_TEST=1` and it is false.
- **shell_overlays** on macOS (host logic with provider facts): the host reports windows from `onScreenWindows()` whose
  owner is in `SECURITY_APP.darwin` (policy/vocabulary.ts, the one list port/darwin's `SECURITY_OWNERS` also reads after
  FX-PD/V: `SecurityAgent`, `coreautha`, `coreauthd`, `universalAccessAuthWarn`, `UserNotificationCenter`,
  `CoreServicesUIAgent`, `AuthenticationServicesAgent`, `ScreenSaverEngine`; V verifies the names) as `dialog`, with
  `complete: true`;
  Mission Control and the app switcher (`Dock`-owned windows above layer 0 covering a display) as `overview` (verify in
  CI; fallback: dialogs only). The main process's `systemDialogOpen` (§8.4) covers the same dialogs independently.
- **Tests**: unit (Linux, fake `AxApi`): attribute batching makes one `attrs` call per node; secure fields never yield
  `value`; busy memory (a `CannotComplete` marks the pid busy for 5 s, other pids answer); offscreen clipping inside a
  scroll area; window ↔ CGWindowID fallback by bounds; key modes; error-code mapping, also per slot (the fake returns
  `CannotComplete`/`NoValue`/`kCFNull` in single slots); duplicate hash keys fall back to index paths; at most three
  round trips per node; the deadline cut; Ember's pid is never given to any AX call; `elementsAt` with a pid hit-tests
  that app; long child lists read by range.
  Integration (macOS, `EMBER_AX_TEST`): through the real `AtspiSidecar` and the built host against `test/fixtures/mac_bench.js`
  (a JXA AppKit window "Ember Bench (macOS)" run with `osascript -l JavaScript`, with a Name field, a secure Password
  field, a Remember me check box, a Theme pop-up, a Volume slider, a 200-row list and a Save button, logging JSON lines like
  `win_bench.ps1`; verify in CI that JXA's `ObjC.registerSubclass` target-action works on macos-15, fallback: TextEdit
  for the read/set_text cases only): list_windows finds it with `app` "osascript" and a numeric `path`; read_window has
  `text`, `password text` (secret, no text), `check box`, `combo box`, `slider`, `push button`; set_text on Name logs;
  do_action on Save logs; toggle; set_value on Volume; at_point on Save; a second host process gives the same secret key.

---

## 6. The UIA bridge (port/uia adopted, with its corrections): integration points only

`pkg-uia.md`, `sidecar/uia/PROTOCOL.md`, `ember_uia.ps1` and `ember_uia.cs` (merged) are authoritative, apart from the
FX-PU corrections at the end. Ember-side integration:
1. **Launch**: only through port/host's `providers/uia.ts`, with §5.2's paths, `windowsHide`, port/host's `bridgeEnv`
   (PSModulePath set to the system modules folder) and `EMBER_UIA_CACHE`. Ember's main process never starts PowerShell
   itself (no `Get-StartApps`, no probes): one PowerShell per session, the host's (plus one during `--doctor`, §9.9).
2. **Ready and cold start**: the bridge's `{"ready":true,…}` line is consumed by the host; `firstRequestMs` 20 s covers
   a cold compile; a `{"fatal":…,"languageMode":…}` line becomes the host's `status` `detail`/`languageMode` and the
   environment check's text (§9.8). After a fatal line whose `languageMode` is `ConstrainedLanguage` the host marks the
   provider unavailable for its lifetime (every request fails fast with the same text; PROTOCOL.md: "Don't restart in a
   loop"). After an execution-policy refusal (the process exited before writing any line) it retries at once only when
   the script's `Zone.Identifier` stream has gone (the user pressed `unblock-helper`, §9.8; one `fs.existsSync` per
   request), else on the back-off below. Any other failed start is retried with back-off (5 s, 30 s, 2 min, then every
   10 min), not every 60 s forever (PH correction).
3. **Execution policy and Mark-of-the-Web** (W2). A Group Policy execution policy (`MachinePolicy`/`UserPolicy` scope)
   overrides `-ExecutionPolicy Bypass`. Under `RemoteSigned` the unsigned bootstrap is refused only when it carries the
   Mark-of-the-Web (files extracted by Explorer from a browser-downloaded zip have a `Zone.Identifier` stream); under
   `AllSigned`/`Restricted` it is always refused. PowerShell then exits before writing any line. Ember never bypasses
   either: WS's environment reads the policy (`HKLM` and `HKCU\SOFTWARE\Policies\Microsoft\Windows\PowerShell`
   `EnableScripts`/`ExecutionPolicy`) and whether Ember's own `ember_uia.ps1`/`.cs` carry a `Zone.Identifier` stream
   (`fs.existsSync(p + ":Zone.Identifier")`), and the setup check says which case it is (§9.8): for `RemoteSigned` +
   the mark it offers the user-initiated fix `unblock-helper` (removes the `Zone.Identifier` stream of those two files
   only, what `Unblock-File` would do, after the user presses the button); for `AllSigned`/`Restricted` it explains that
   the organisation allows only signed scripts. The CLM `__PSLockdownPolicy` and AppLocker/WDAC stay honoured.
4. **Shipping** (port/packaging layout): `resources/sidecar/uia/ember_uia.ps1` and `ember_uia.cs`, ASCII and LF
   (`.gitattributes`); no precompiled DLL is shipped (Mark-of-the-Web, G4), the per-user cache is the only DLL.
5. **pid and app invariant (C15)**: the bridge's top-level window `pid` is `GetWindowThreadProcessId` of the top-level
   HWND (ApplicationFrameHost for a UWP frame) and its `processName` is the hosted program, exactly as port/win32's
   `stack()` reports `pid` and `wmClass`. The bridge's **busy key**, though, is the hosted app's pid for an
   `ApplicationFrameWindow` (falling back to the frame's pid), so one hung UWP app doesn't make every UWP window busy
   (ApplicationFrameHost is one process for all of them); `busyPids` lists hosted pids (FX-PU, W19). I verifies C15 in CI
   with the Settings app when the runner has `EnableLUA = 1` (Windows Server 2022 has no Store Calculator; with UAC off
   UWP activation is refused), else records "not testable on this runner" and keeps it in §12.3.
6. **Console windows** (W5): a classic console window (class `ConsoleWindowClass`, drawn by conhost.exe) reports the
   pid of its first client (python, node, ssh…). Both port/win32's `appName()` and the bridge's `processName` name such
   a window `conhost` (the program that owns it), with the client's name kept in an optional `clientProgram` field for
   display, so the terminal vocabulary (`conhost` is a terminal, §9.11) and never-look/grants see one stable name
   (FX-PW, FX-PU). Windows Terminal's window is `windowsterminal` already.
7. **Ember's own windows** (W14): the bridge takes `skipPids` (from the host's `EMBER_OWNER_PID`) on `topWindows` and
   `elementsAt` and makes no UIA call into those processes: their windows are listed from Win32 facts only, and an
   `elementsAt` whose `WindowFromPoint` root belongs to a skipped pid answers `[]` (FX-PU, PH).
8. **Units**: physical pixels, Per-Monitor-V2 (the bridge sets it before any UIA call), the space of port/win32's
   window system and of `SendInput`'s absolute coordinates. The ready line reports both the threads' awareness (`dpi`)
   and the process's (`processDpi`, from `GetProcessDpiAwareness`); if they differ (powershell.exe's manifest fixed the
   process awareness), UIA may answer logical coordinates on some monitors: the host logs `uia.dpi_mixed`, the
   environment check warns, and §12.3 item 13 checks it; fallback in R22.
9. **CI**: the Windows job compiles the bridge the way Ember does, by running `ember_uia.ps1` itself with stdin closed
   (Windows PowerShell 5.1's legacy csc via `Add-Type`, assemblies loaded as the bootstrap loads them; it must print the
   ready line and exit 0), as a required step from the first run of every branch that touches `ember_uia.cs` (the
   Roslyn LangVersion 5 harness is only a fast local check), and runs `test/integration/uia-bridge.test.ts` and
   `ax-sidecar.test.ts` with `EMBER_UIA_TEST=1` against the bench (§11.5: compiled to `EmberBench.exe`, with a ListView
   and a TreeView, and a `/platform:x86` build for 32-bit targets; FX-PW).
10. **Logging (G2)**: no screen data passes through a cmdlet; Ember's doctor reports when PowerShell Module Logging or
   Transcription is enabled by policy (`HKLM\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ModuleLogging` /
   `Transcription` `Enable*` = 1) as a warning row, since the bootstrap's own lines are logged there (WS, §9.9). The
   doctor also prints the exact command line, the script path and the cached DLL's path and SHA-256, so an
   administrator can allow-list them in an EDR product (R8).
11. **Managed UIA client** (W17): `System.Windows.Automation` registers .NET's client-side proxies for classic Win32
   controls (SysListView32, SysTreeView32, tab, combo), which can differ from the COM API's view, especially for 32-bit
   targets. The bench's ListView/TreeView and its x86 build check it in CI; fallback in R21.

---

## 7. Windows window system, input and capture (port/win32 adopted, with its corrections)

`pkg-win32.md` and port/win32's code (merged: `app/main/platform/win32/**`) are authoritative for
`openWin32Windows({ screen })` and `openWin32Input()` (user32/gdi32/dwmapi/kernel32 through koffi, bound by `loadWin32()`
in `ffi.ts`; z-order without callbacks; DWM-cloaked filtering; `outer` = GetWindowRect, `inner` = client area,
`x/y/width/height` = DWM extended frame bounds; SendInput with the 40-byte x64 `INPUT`; KEYEVENTF_UNICODE `textKey`;
`blockedReason` for elevated targets; GDI BitBlt capture that refuses off the user's desktop; `screenLocked()` from the
input desktop; `focusInput` for Ember's own windows; the `Win32WindowSystem` extension with `activate` and a
synchronous `capture`), apart from the FX-PW corrections at the end (no synchronous cross-thread window call on the main
thread; console windows named `conhost`; the compiled bench). What Ember adds around it:

### 7.1 Composition (`win32/platform.ts`, WS)

```ts
export function win32Platform(deps: PlatformDeps): Platform {
  const system = win32System(deps);                                    // win32/system/index.ts (§9)
  return {
    os: "win32", system,
    openWindows: log => {
      const ws = openWin32Windows({ screen: deps.electron.screen });  // only called after app ready (main §4.1 item 28)
      if (!ws) { log.error("platform.windows_unavailable", { err: win32Error }); return null; }
      return withSystemDialog(ws, () => win32SystemDialog(ws, loadWin32())); // §7.2; keeps Win32WindowSystem's extras
    },
    openInput: (_ws, log) => { const i = openWin32Input(); if (!i) log?.error("platform.input_unavailable", { err: win32Error }); return i; },
    shortcutsReReported: false,
    overlay: hoverShaper("win32"),                                      // §8.3
    keyboardHold: null, clipboard: null, desk: null,
    sidecarLaunch: ctx => hostLaunch({
      execPath: ctx.execPath, host: path.join(ctx.appDir, "ax-sidecar.cjs"),
      uiaScript: path.join(ctx.packaged ? ctx.resourcesPath : ctx.appPath, "sidecar", "uia", "ember_uia.ps1"),
      uiaCache: path.join(ctx.userData, "uia-cache"),
      env: hostEnv(deps.env, { os: "win32", packaged: ctx.packaged, ownerPid: process.pid }), platform: "win32", packaged: ctx.packaged,
    }),
  };
}
```

`hoverShaper(os)` lives in `platform/compose.ts` (P1-A writes it with both rows; it is data): `setInputRegion` → false,
`release` → nothing, `forward` → `os === "darwin"`, `floating(kind)` → §8.3's table.

### 7.2 `systemDialogOpen` on Windows (`win32/system/system-dialog.ts`, WS)

`win32SystemDialog(ws, api)` reuses port/win32's bindings (no second `OpenInputDesktop` binding): it is true when
(a) `!onUsersDesktop(api.inputDesktopName())` (port/win32 `security.ts`: the input desktop can't be opened or isn't
"Default": UAC on the secure desktop, Ctrl+Alt+Del, the lock screen), or (b) `ws.stack()` has a window whose `wmClass` is
in `SECURITY_APP.win32` (credentialuibroker, consent, logonui, lockapp, pinenrollmentbroker, bioenrollmenthost, …;
case-insensitive), or whose class (`wmClassName`) is a credential/consent dialog class (`Credential Dialog Xaml Host`,
`$$$Secure UAP Dummy Window Class For Interim Dialog`), or whose title matches `SECURITY_TITLE.win32`, or (c) a topmost
window covering a whole display has a `wmClass` of "" (its program couldn't be opened, as for SYSTEM processes such as
consent.exe and LogonUI.exe under a standard user when "prompt on the secure desktop" is off), or (d) `api` is null or
anything throws (fail closed). The class and title lists live in `policy/vocabulary.ts` (V fills them; one source).
Unit-tested with a fake API and fake stacks, including `{ wmClass: "", wmClassName: "Credential Dialog Xaml Host" }`.

### 7.3 Units and DIP

`toDip`/`toDipPoint` use the injected `screen.screenToDipRect(null, r)`/`screenToDipPoint(p)` (per monitor); main's
`cursor()`, `flyTo` and the overlay all go through them (§4.1 items 29 and 37), so mixed-DPI setups place Ember and its
focus ring correctly. `screenBounds()` is the virtual screen in physical pixels; perception's rectangles, captures and
masks stay in physical pixels end to end.

### 7.4 What Ember relies on (checked by I in CI, `test/integration/win32-desktop.test.ts` plus Ember-level checks)

- One id space: `stack()[].client === activeWindow().id` for the foreground window; `windowId(ownWindow)` equals the
  HWND `focusWindow()` reports while that window has the keyboard (§4.1 items 17-18).
- `pid` of Ember's own windows is `process.pid` (the browser process owns the HWNDs).
- `activate(hwnd)` brings the bench to the front within 1 s from a timer (CursorBorrow's wait), with the documented
  order (input.md §7.6), never an Alt tap, and **never blocks Ember's main thread on the target**: port/win32's last
  step uses `SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS)` instead of
  `BringWindowToTop` (a synchronous cross-thread `SetWindowPos` that waits for a merely busy app, freezing the overlay
  and the stop shortcut's `WM_HOTKEY`), and its module comment states the rule "no synchronous cross-thread window call
  on the main thread" (FX-PW, W16). A unit test checks the activation sequence uses only `ShowWindowAsync`,
  async `SetWindowPos`, `SetForegroundWindow` and the hung-guarded `AttachThreadInput` for foreign windows.
- `keysDown()` excludes VK_PACKET and the generic modifier duplicates, so `textKey` typing never looks like a takeover.
- A classic console window's `wmClass` is `conhost` (§6 item 6), so `isTerminalApp` refuses tier-3 typing into a Python
  REPL started from the Start menu (integration test: `python.exe` or `cmd /k` started from a `.lnk`).
- Capture: BitBlt with `CAPTUREBLT` may hide and redraw the cursor on each capture; port/win32 measures on a Windows 11
  client whether DWM's composed screen DC already includes layered windows without it and drops the flag if so (FX-PW,
  §12.3). Perception keeps capturing the window's rectangle, not the virtual screen (a 3×4K virtual screen is ~100 MB of
  BGRA on the main thread).

---

## 8. macOS window system, input and capture (port/darwin adopted, with its corrections)

`pkg-darwin.md` and port/darwin's code (merged: `app/main/platform/darwin/**`) are authoritative for
`openDarwinWindows({ screen, capture, screenAccess, focusedOwnWindow })` (its `DarwinWindowSystem` already has
`systemDialogOpen()`, `accessibilityTrusted()` and `screenRecording()`), `openDarwinInput()`, the capture contract
(`capture.ts`: `DarwinCapture`, `captureRect`/`acceptImage`, the pure `composePoints`) and the reusable
`cf.ts`/`ax.ts`/`cg.ts`/`hitoolbox.ts`, apart from the FX-PD corrections at the end (secure input bound on its own and
fail-closed; Input Monitoring; `pointerLags`; the input-source check; exact CFHash; AXValue errors; one security-owner
list; the activation fallback; cheaper borrow polling). What Ember adds: the injected capture function, the Screen
Recording preflight (already in `captureRect`), and the floating-window options.

### 8.1 Composition (`darwin/platform.ts`, MS)

```ts
export function darwinPlatform(deps: PlatformDeps): Platform {
  const system = darwinSystem(deps);                                   // darwin/system/index.ts (§9)
  const { screen, desktopCapturer, systemPreferences, browserWindow } = deps.electron;
  const screenAccess = () => systemPreferences.getMediaAccessStatus?.("screen") === "granted";
  return {
    os: "darwin", system,
    openWindows: log => {
      const ws = openDarwinWindows({
        screen, screenAccess,
        capture: electronCapture({ desktopCapturer, screen, log }),   // §8.2; captureRect already preflights and clips
        focusedOwnWindow: () => browserWindow.getFocusedWindow(),       // focusWindow() reports Ember's own key panel
      });
      if (!ws) { log.error("platform.windows_unavailable", { err: darwinWindowsError }); return null; }
      return ws;                                                         // port/darwin's systemDialogOpen as is (§8.4)
    },
    openInput: (_ws, log) => { const i = openDarwinInput(); if (!i) log?.error("platform.input_unavailable", { err: darwinInputError }); return i; },
    shortcutsReReported: false,
    overlay: hoverShaper("darwin"),
    keyboardHold: null, clipboard: null, desk: null,
    sidecarLaunch: ctx => hostLaunch({
      execPath: ctx.execPath, host: path.join(ctx.appDir, "ax-sidecar.cjs"),
      env: hostEnv(deps.env, { os: "darwin", packaged: ctx.packaged, ownerPid: process.pid }), platform: "darwin", packaged: ctx.packaged,
    }),
  };
}
```

There is no `withSystemDialog` on macOS and no second secure-input check: port/darwin's `systemDialogOpen()` is the one
check (with the FX-PD corrections), and MS's environment check reads `accessibilityTrusted()`/`screenRecording()` from
the opened window system when there is one.

### 8.2 The desktopCapturer capture (`darwin/electron-capture.ts`, MS)

`electronCapture(o: { desktopCapturer: DesktopCapturerLike; screen: CaptureScreen; log?: Logger; timeoutMs?: number }): DarwinCapture`
fulfils port/darwin's `DarwinCapture` contract: given `rect` (global points, already clipped to the screen and
integral by `captureRect`, which has also checked the Screen Recording permission and refuses without it, so the
wallpaper-only image macOS hands out without the permission is never taken), it returns the screen inside `rect` as BGRA
at one pixel per point, or null. Per call:
1. `parts` = every display of `screen.getAllDisplays()` whose bounds intersect `rect`; none → null.
2. **Sources**: one call `desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: W, height: H }, fetchWindowIcons: false })`
   with `W = max(d.bounds.width)`, `H = max(d.bounds.height)` over `parts`: the displays' **point** size, so Chromium
   scales each display to (about) points while it produces the thumbnail, and no full-resolution 5K/6K bitmap is
   decoded, cropped or resized by NativeImage calls on Electron's main thread. Raced against `timeoutMs` (default 3000)
   → null on timeout or rejection.
3. **Match** each part's display to a source by `source.display_id === String(display.id)`. A part with no matching
   source, or whose `thumbnail.isEmpty()`, → null (fail closed: never a partial picture).
4. **Compose**: each matched source becomes a `DisplayBitmap` `{ bounds: d.bounds, width: thumb.getSize().width, height:
   thumb.getSize().height, bgra: thumb.toBitmap() }` (the real thumbnail size, not the requested one), and the result is
   port/darwin's `composePoints(bitmaps, rect)`: it averages or picks per point, leaves uncovered points black, and is
   already unit-tested; electron-capture adds no resampling of its own.
5. **Pixel order**: `toBitmap()` is BGRA on macOS (Chromium's N32 is BGRA on little-endian); **verify in CI** (the
   integration test captures the bench's pure red swatch `#FF0000` and asserts bytes `00 00 FF xx`; if a build ever
   returns RGBA, the module swaps R and B, decided once by a constant checked in that test).

Perception hides Ember first (opacity 0 + 60 ms) and shows it again only after the promise settles (`captureRect`,
§4.7), so Ember's own windows aren't in the picture. Cost: 100-300 ms per capture (every display is grabbed);
acceptable for worker screenshots, which are not per-frame. macOS 15 asks again, about once a month, whether an app that
reads the screen without the system picker may keep doing so (the "bypass the system private window picker" alert): the
Screen Recording setup check's ok text says "macOS asks again about once a month; choose Allow" (§9.8), and §12.3 item 6
covers it. Unit tests (Linux, fakes): two displays with different sizes and a rectangle across both (the
thumbnail size requested is the larger point size; bitmaps go to `composePoints` with their real sizes); a missing
`display_id` → null; an empty thumbnail → null; a timeout → null; negative origins.

### 8.3 Overlay, handle and ask box on Windows and macOS (`hoverShaper`, P1-A)

No XShape analogue exists (window-system §11.2), so `setInputRegion` returns false and OverlayManager's hover polling
decides click-through at 60 Hz from `ws.pointer()` (with real button state, so nothing flips while a button is held).

| `floating(kind)` | win32 | darwin |
|---|---|---|
| overlay `options` | `{ type: "toolbar", thickFrame: false, roundedCorners: false }` | `{ type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true, roundedCorners: false }` |
| overlay `allWorkspaces` | null (`WS_EX_TOOLWINDOW` windows aren't tracked by the virtual-desktop manager, so they show on every desktop: verify, §12.3) | **null** (see below) |
| handle | as the overlay | as the overlay (`allWorkspaces` null, never `"plain"`) |
| ask `options` | `{ type: "toolbar", thickFrame: false, roundedCorners: false }` (a tool window can still be activated and take the keyboard; a normal window would drag the user back to the virtual desktop it was created on) | `{ type: "panel", acceptFirstMouse: true, hiddenInMissionControl: true }` (focusable: it becomes key without activating Ember, so the user's app stays active and `blur` still hides it; `activateForAsk: false`, §2.1) |
| ask `allWorkspaces` | null | **null** |
| desk-view | `{}`, null (never shown off Linux) | `{}`, null |
| `forward` | false (a `WH_MOUSE_LL` hook on Electron's UI thread would make every app's mouse wait for Ember's main thread) | true (cheap; the renderer sees hover) |

- **No `setVisibleOnAllWorkspaces` on macOS** (finding M1). Electron's macOS implementation transforms the process:
  with `visibleOnFullScreen` it calls `DockHide()` (the process becomes a UI element: no Dock icon and no menu bar, so
  the app menu and its Command+Q would never show), and without it `DockShow()`, which activates the Dock, waits about a
  second and then activates Ember with `activateIgnoringOtherApps` (stealing focus from the user's app); a hide within a
  second of a show is ignored. It isn't needed: Electron's `type: "panel"` window already ORs
  `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary` into its collection behaviour and adds
  `NSWindowStyleMaskNonactivatingPanel` ("floats on top of full-screened apps", "appears on all spaces"). P1-A's
  `platform-compose` test asserts no darwin `FloatingWindow` has a non-null `allWorkspaces`, and that any call P1-A might
  ever add there carries `skipTransformProcessType: true`. Linux keeps exactly today's calls (overlay
  `{ visibleOnFullScreen: true }`, handle `"plain"`).
- macOS `type: "panel"`: a click on Allow never activates Ember over the user's app, and `acceptFirstMouse` makes that
  first click count. Electron's panel is an NSWindow subclass with a faked style mask, not an NSPanel, so "takes the
  keyboard without activating Ember" is proven by I's `ember-darwin.test.ts` (open the ask box over TextEdit, type into
  it, the system-wide `AXFocusedApplication` stays TextEdit's, and `blur` hides it), not assumed.
- `setAlwaysOnTop(true, "screen-saver")` and the 2 s `raise()` stay on every OS (Windows: above the taskbar; macOS:
  above the menu bar and Dock). On Windows the overlay over a full-screen Direct3D game or a presentation can prevent
  independent flip or knock an exclusive-mode app out (R10): default as is, verified manually; fallback in R10.
- The handle's menu (`showMenu`): `setFocusable(true)` + `focus()` work on both (darwin/win32 APIs); the X11 focus
  cross-check is skipped off X11 (§4.1 item 17).
- Hide for capture stays `setOpacity(0)` + 60 ms on every OS (verify on Windows with `transparent: true` windows: the
  integration test captures the overlay's area while a bubble shows and expects no bubble pixels). Fallback on Windows
  if bubble pixels show or the flicker is visible: `setContentProtection(true)` on Ember's windows only for the capture
  (`WDA_EXCLUDEFROMCAPTURE`, Windows 10 2004+, honoured by BitBlt; one DWM frame) and cleared right after, behind a
  `hideForCapture` hook of the platform (I's change; leaving it on permanently would hide Ember from the user's screen
  shares, a product decision).

### 8.4 `systemDialogOpen` on macOS (port/darwin's, with FX-PD corrections)

port/darwin's `systemDialogOpen()` is true when the window system is closed, when secure keyboard entry is on, when an
on-screen window (alpha > 0) is owned by one of `SECURITY_OWNERS`, or when anything throws (`windows.ts:189-197`). MS
adds nothing beside it. The FX-PD corrections make it fail closed in the two places it doesn't yet:
- **Secure input bound on its own**: today `IsSecureEventInputEnabled` is bound with the TIS layout functions,
  `LMGetKbdType` and `UCKeyTranslate` all-or-nothing (`hitoolbox.ts:61-80`), and `desktop.secureInput()` answers false
  when HIToolbox is null (`desktop.ts:166-168`), so a macOS that moves any one layout symbol silently turns the
  secure-input refusal off for screenshots and typing. It gets its own lookup (Carbon, then HIToolbox, then
  CoreServices); `secureInput()` returns `boolean | null`; `null` uses `CGSessionCopyCurrentDictionary()`'s
  `kCGSSessionSecureInputPID` (already read) as the fallback signal, and when that is missing too, `systemDialogOpen()`
  is true and `blockedReason()` says "Ember can't tell whether a password is being typed, so it won't use the keyboard."
  (`platform.secure_input_unknown` logged once). When secure input blocks Ember, the refusal and the doctor row name the
  app holding it (`kCGSSessionSecureInputPID` → owner), since a stuck Secure Keyboard Entry otherwise disables Ember
  with no visible reason.
- **One owner list**: `SECURITY_OWNERS` (today `SecurityAgent`, `coreautha`, `model.ts:60`) is read from
  `SECURITY_APP.darwin` in `policy/vocabulary.ts`, which V fills and verifies on macOS 14/15 (print `ws.stack()` while
  each prompt is up): `SecurityAgent`, `coreautha`, `coreauthd`, `universalAccessAuthWarn` ("… would like to control
  this computer using accessibility features"), `UserNotificationCenter` (TCC prompts), `CoreServicesUIAgent`
  (Gatekeeper), `AuthenticationServicesAgent` (passkeys), `ScreenSaverEngine`, and `loginwindow` when it covers a whole
  display (the lock screen). The host's macOS `shell_overlays` reads the same list (§5.3), so the three can't drift.

### 8.5 What Ember relies on (checked by I in CI, `test/integration/darwin-desktop.test.ts` plus Ember-level checks)

- `windowId(win)` parses `getMediaSourceId()` and equals the CGWindowID `stack()` lists for that window; `pid` of Ember's
  windows is `process.pid`.
- The main process's AX calls use a 0.25 s messaging timeout; `focusWindow()` never calls AX on Ember's own process
  (it would wait for its own main thread), and reports Ember's key panel through `focusedOwnWindow`.
- `Input.activate` is never called for Ember's own windows (`activateOwnWithInput: false`, §2.1).
- `blockedReason(0)` names the missing Accessibility permission, and CursorBorrow refuses with it (§2.4); it also
  refuses while secure input is on or unknown, while the current input source is an input method rather than a keyboard
  layout (`TISCopyCurrentKeyboardInputSource` + `kTISPropertyInputSourceType` ≠ `TISTypeKeyboardLayout`, main thread
  only: "Switch to a keyboard layout (not an input method) so Ember can type, or let Ember fill the field directly."),
  and, until CI shows key-state polling isn't gated, without Input Monitoring (next item).
- **Input Monitoring** (finding M3). The user's keyboard "brake" during a borrow is `check()` seeing a key Ember doesn't
  hold, from `CGEventSourceKeyState(combinedSession, …)`. Since 10.15 keyboard *observation* is gated by Input Monitoring
  (`kTCCServiceListenEvent`), separately from Accessibility; whether per-key state polling is gated is undocumented, and
  if it is, `keysDown()` silently answers nothing and Ember keeps typing while the user types. Default (fail closed):
  port/darwin binds `CGPreflightListenEventAccess`/`CGRequestListenEventAccess` (CoreGraphics, optional symbols) and
  `CGPreflightPostEventAccess`, and `blockedReason()` refuses keyboard borrowing with "Ember needs Input Monitoring
  (System Settings › Privacy & Security › Input Monitoring) to notice when you take over the keyboard." while
  `CGPreflightListenEventAccess()` is false; MS adds the `input-monitoring` setup check and its fix (§9.8). I settles the
  question once (darwin-desktop test: a helper process posts F13 down while the test process, its listen grant first
  absent and then present, reads `keysDown()`; plus §12.3 item 5 on a real Mac without the grant) and, only if polling
  is proven ungated, drops the requirement in one commit with the evidence (Q10).
- **Activation from the background** (macOS 14+ cooperative activation may decline it): if `AXFocusedApplication` isn't
  the target 300 ms after `AXFrontmost`, port/darwin's `raise()` activates the app through LaunchServices
  (`/usr/bin/open -a <bundle path>`, the path from `proc_pidpath` walked up to the `.app`) and sends `AXRaise` again
  (FX-PD; R6-mac). The darwin-desktop activation test runs from a process with no UI, the realistic case.
- **Borrow polling cost**: during a borrow `check()` runs every 8 ms on Electron's main thread. port/darwin caches
  `windows()` for 30 ms and reads all keys in one Carbon `GetKeys(KeyMap)` call when it binds (bit `k & 7` of byte
  `k >> 3`), falling back to the 128-call loop (FX-PD); `darwin-desktop.test.ts` logs the median cost of `keysDown()`,
  `windows()` and `focusedWindow()`, and I's `ember-darwin.test.ts` budgets `check()` under 2 ms median.

---

## 9. Windows and macOS SystemPlatform (packages WS and MS)

Nothing here is owned by an in-flight package. WS writes `app/main/platform/win32/system/**` and `win32/platform.ts`;
MS writes `app/main/platform/darwin/system/**`, `darwin/platform.ts` and `darwin/electron-capture.ts`. Both are plain
Node (Electron comes through `PlatformDeps.electron`), load koffi only inside functions that run on their own OS, and
are unit-tested on Linux with fakes (`test/unit/win32-system-*.test.ts`, `test/unit/darwin-system-*.test.ts`: names
outside port/win32's and port/darwin's `platform-win32-*`/`platform-darwin-*` globs)
plus integration tests on their OS (`test/integration/win32-system.test.ts` with `EMBER_WINSYS_TEST`,
`test/integration/darwin-system.test.ts` with `EMBER_MACSYS_TEST`).

### 9.1 Module layout

```
win32/system/index.ts          win32System(deps): SystemPlatform (assembles the rest; the words/shortcuts/keys rows of §2)
win32/system/ffi.ts            koffi bindings, bound once (the window-system ones stay port/win32's, loadWin32()):
                               advapi32 (RegGetValueW, RegSetKeyValueW, OpenProcessToken, GetTokenInformation),
                               user32 (SendMessageTimeoutW, bound for koffi's .async form; SystemParametersInfoW),
                               kernel32 (GetSystemDirectoryW, GetWindowsDirectoryW, GetCurrentProcess, CloseHandle,
                               ProcessIdToSessionId, GetPackagesByPackageFamily), shell32 (SHGetKnownFolderPath),
                               ole32 (CoTaskMemFree)
win32/system/registry.ts       readString/readDword/writeDword/enumKeys over ffi.ts (pure error mapping, unit-tested)
win32/system/known-folders.ts  systemDirectory(), windowsDirectory(), programData(), programs(), commonPrograms()
                               (FOLDERID_ProgramData, FOLDERID_Programs, FOLDERID_CommonPrograms: redirected folders too)
win32/system/lnk.ts            a pure MS-SHLLINK reader (header, LinkInfo, StringData, EnvironmentVariable, Darwin and
                               PropertyStore extra blocks → target, args, description, AUMID, advertised), unit-tested
                               with fixture bytes; plain Node, so the catalogue never calls COM on the main thread
win32/system/apps.ts           Start Menu .lnk + packaged apps catalogue, launch through explorer.exe
win32/system/argv.ts           splitWindowsArgs(): CommandLineToArgvW's rules in TS (pure)
win32/system/settings.ts       dark_style (and verified-only extras)
win32/system/admin-policy.ts   HKLM\SOFTWARE\Policies\Ember
win32/system/autostart.ts      app.setLoginItemSettings
win32/system/environment.ts    EnvInputs.windows, fixes
win32/system/doctor.ts         doctor probes
win32/system/a11y.ts           SPI_GETSCREENREADER, reduced motion
win32/system/system-dialog.ts  win32SystemDialog (§7.2), over port/win32's loadWin32() bindings
win32/system/powershell.ts     execution policy (GPO) and Mark-of-the-Web facts, the unblock-helper fix (§6 item 3)
win32/system/lifecycle.ts      AppUserModelId, Start Menu shortcut

darwin/system/index.ts         darwinSystem(deps): SystemPlatform
darwin/system/plist.ts         XML and binary (bplist00) property-list reader (pure, unit-tested with fixtures)
darwin/system/apps.ts          .app bundles catalogue, launch through /usr/bin/open -a
darwin/system/settings.ts      dark_style through System Events
darwin/system/admin-policy.ts  /Library/Application Support/Ember/policy.json
darwin/system/autostart.ts     app.setLoginItemSettings (SMAppService)
darwin/system/environment.ts   EnvInputs.mac, fixes
darwin/system/doctor.ts        doctor probes
darwin/system/a11y.ts          VoiceOver, reduced motion
darwin/system/lifecycle.ts     app menu flag, activate, shutdown, microphone prompt
(no darwin secure-input module: port/darwin's systemDialogOpen is the one check, §8.4)
```

### 9.2 Apps: listing and launching

**Windows (`win32/system/apps.ts`).**
- Sources, in this order (an earlier source wins a name clash): (1) the per-user Start Menu `programs()`
  (`SHGetKnownFolderPath(FOLDERID_Programs = {A77F5D77-2E2B-44C3-A6A2-ABA601054A51})`), (2) the all-users Start Menu
  `commonPrograms()` (`FOLDERID_CommonPrograms = {0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}`), both from the known-folder
  API so redirected and roaming Start Menus are found (each `SHGetKnownFolderPath(id, 0, null, &path)`, then
  `CoTaskMemFree`); (3) packaged apps. Folders are walked to depth 4, at most 2000 `.lnk` files.
- Each `.lnk` is parsed by `lnk.ts` (pure TypeScript, MS-SHLLINK: the 76-byte header, LinkInfo's local base path,
  StringData's arguments and description, the EnvironmentVariableDataBlock's `%VAR%` target, the PropertyStore block's
  `System.AppUserModel.ID`, and the DarwinDataBlock that marks an MSI "advertised" shortcut), so listing never calls
  COM on Electron's main thread (Electron's `shell.readShortcutLink` is synchronous COM; 2000 of them cold is a visible
  stall). A shortcut the parser can't read is skipped. Skipped too: targets not ending in `.exe`; targets that don't
  exist (after `%VAR%` expansion; checked when listing and again right before launching: a missing target would make
  Explorer show "Problem with Shortcut … Do you want to delete this shortcut?", a destructive prompt Ember caused);
  uninstallers (name `/\buninstall\b|^remove\b/i`, target base `/^(unins\d*|uninst\w*|msiexec)\.exe$/i`); and
  Ember's own shortcut (target = `process.execPath`, §9.12).
- `DesktopApp`: `id` = the path relative to Programs without `.lnk`, `\` → `/`; `name` = the file name without `.lnk`;
  `file` = the `.lnk` path; `keywords` = `[description]` lower-cased when present; `argv` = `[target, ...splitWindowsArgs(args)]`;
  `programs` = `[basename(target) without .exe, lower case]`, or `[]` for an advertised (MSI) shortcut, whose target is an
  icon under `%WINDIR%\Installer` (the window then matches by title, as on Linux; explorer.exe still launches the
  `.lnk` itself); `generic` from a small table keyed by program (explorer "file manager", notepad "text editor",
  msedge/chrome/firefox "web browser", outlook/olk "email", winword "word processor", excel "spreadsheet", powerpnt
  "presentation", mspaint "image editor").
- Packaged apps that have no `.lnk` (Settings, Calculator, and on Windows 11 Notepad, Paint, Photos, Snipping Tool,
  Terminal, Clock, Store, Outlook): a curated table `{ name, aumid, family, program, generic }`, e.g.
  `{ "Settings", "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", family "windows.immersivecontrolpanel_cw5n1h2txyewy", program "systemsettings", generic "settings" }`,
  `{ "Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", program "calculatorapp", generic "calculator" }`,
  `{ "Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", program "notepad", generic "text editor" }`,
  `{ "Paint", "Microsoft.Paint_8wekyb3d8bbwe!App", program "mspaint", generic "image editor" }`,
  `{ "Photos", "Microsoft.Windows.Photos_8wekyb3d8bbwe!App", program "photos" }`,
  `{ "Snipping Tool", "Microsoft.ScreenSketch_8wekyb3d8bbwe!App", program "snippingtool" }`,
  `{ "Terminal", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", program "windowsterminal" }` (listed so it is refused by
  name, never launched), `{ "Outlook", "Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookforWindows", program "olk", generic "email" }`,
  `{ "Clock", "Microsoft.WindowsAlarms_8wekyb3d8bbwe!App", program "time" }`, `{ "Microsoft Store", "Microsoft.WindowsStore_8wekyb3d8bbwe!App", program "winstore.app" }`.
  An entry is offered only when its package is installed for this user, asked through the documented
  `LONG GetPackagesByPackageFamily(PCWSTR family, UINT32 *count, PWSTR *names, UINT32 *bufLen, WCHAR *buf)` (kernel32,
  appmodel.h; first call with null buffers: `count > 0` means installed); Settings is always offered. There is no "offer
  every curated entry" fallback: `explorer.exe shell:AppsFolder\<AUMID>` for an unregistered app shows Explorer's own
  error dialog on the user's screen. `DesktopApp`: `id` = the AUMID, `file` = `shell:AppsFolder\<AUMID>`, `argv` = `[]`,
  `programs` = `[program]`. PowerShell is never used for the catalogue (no `Get-StartApps`). MSIX desktop apps with no
  `.lnk` that aren't in the curated table (new Teams, WhatsApp, Spotify, Clipchamp…) can't be opened by name in v1
  (R24).
- Launch (C7): `isTerminalApp(app)` → throw first (synchronously, as `launchApp` does); a `.lnk` whose target no longer
  exists → throw "That app's shortcut points at a program that isn't there any more."; then
  `spawn(path.join(windowsDirectory(), "explorer.exe"), [app.file], { detached: true, stdio: "ignore", windowsHide: true, cwd: os.homedir(), env: appEnv(process.env, { os: "win32" }) }).unref()`,
  errors after spawn logged and swallowed (exit code 1 from the hand-off explorer.exe is normal). The running shell
  starts the app with **its** environment, so Ember's tokens and `EMBER_*` never reach it (verify in CI: the bench
  started through a `.lnk` prints its environment and has no `EMBER_`/`GH_` variable), and with the shell's integrity
  level, so an app Ember opens is never elevated even when Ember is. Never `shell.openPath`, `ShellExecute` or
  `cmd /c start` from Ember's process.
- `appKey(s) = s.toLowerCase().replace(/\.exe$/, "")`; `programsOf(app) = programsOf(app, LAUNCHERS.win32)`;
  `isTerminalApp(a) = isTerminalApp(a, "win32")`; `hasBuiltInShell(a) = hasBuiltInShell(a, "win32")`;
  `find = findApp`.
- Cache: the parsed list is kept 5 minutes and dropped early when a Start Menu folder's mtime changes; parsed shortcuts
  are memoised by `(path, mtimeMs)` for the session, so a warm `list()` costs a directory walk only.

**macOS (`darwin/system/apps.ts`).**
- Sources: `/Applications`, `/Applications/Utilities`, `/System/Applications`, `/System/Applications/Utilities`,
  `~/Applications`, `/System/Library/CoreServices/Finder.app`, and `*.app` one level inside non-bundle folders of
  `/Applications` (vendor folders). Each bundle's `Contents/Info.plist` is read with `plist.ts` (XML or `bplist00`;
  no `plutil` processes). Skipped: no `CFBundleExecutable`, `LSUIElement` or `LSBackgroundOnly` true.
- `DesktopApp`: `id` = `CFBundleIdentifier` (else the path); `name` = the bundle's file name without `.app`;
  `file` = the bundle path; `keywords` = `[CFBundleDisplayName, CFBundleName]` lower-cased, de-duplicated;
  `argv` = `[<bundle>/Contents/MacOS/<CFBundleExecutable>]`; `categories` = `[LSApplicationCategoryType]` when set;
  `programs` = `[file name, CFBundleName, CFBundleExecutable, CFBundleIdentifier]` lower-cased (the sidecar's `app` is
  the localized name, which equals the file name for most apps; a localized name that differs falls back to the title
  match, as on Linux); `generic` from Finder "file manager", TextEdit "text editor", Safari "web browser", Mail
  "email", System Settings "settings", Numbers "spreadsheet", Pages "word processor", Keynote "presentation", Preview
  "document viewer", Calculator "calculator".
- Launch: terminal check first, then `execFile("/usr/bin/open", ["-a", app.file], { env: appEnv(process.env), cwd: os.homedir(), timeout: 10_000 }, err => err && log)`.
  LaunchServices starts the app with launchd's environment, never `open`'s, so the "no tokens to apps" invariant holds
  by construction. A first launch of a downloaded app shows Gatekeeper's prompt (CoreServicesUIAgent), which the
  security vocabulary covers.
- `appKey(s) = s.toLowerCase()`; the vocabulary functions with `"darwin"`; cache as on Windows (folder mtimes).

### 9.3 Tier-0 settings (D7: only what is verified goes in `available`)

**Windows (`win32/system/settings.ts`)**: `available = { dark_style: "Dark mode for apps" }`.
- `change("dark_style", value)`: parse `value` with the existing on/off grammar (hands/system.ts's decoder, exported by
  P1-D as `parseOnOff`); `before = readDword(HKCU, "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "AppsUseLightTheme") === 0`;
  `writeDword(…, "AppsUseLightTheme", on ? 0 : 1)`; broadcast
  `SendMessageTimeoutW(HWND_BROADCAST = 0xFFFF, WM_SETTINGCHANGE = 0x001A, 0, "ImmersiveColorSet", SMTO_ABORTIFHUNG | SMTO_BLOCK = 0x0003, 1000, &result)`
  through koffi's **asynchronous** call (`fn.async(…, cb)`, on koffi's worker thread), never synchronously on Electron's
  main thread: for `HWND_BROADCAST` the timeout applies per top-level window, and `SMTO_ABORTIFHUNG` skips only windows
  already flagged hung, so one slow app would freeze the overlay, hover polling and the stop shortcut for seconds.
  Ember's own windows still receive the message through the main thread's loop. `change` doesn't wait for the broadcast:
  it reads the registry value back (the read-back is the registry's, not the broadcast's) and returns; a unit test
  checks the binding used is the async one. Return `{ before: String(before), after: String(after) }`. `SystemUsesLightTheme` (the taskbar) is left
  alone. A missing key → `Error("Dark mode for apps is not available on this computer")`.
- Candidates `text_size` (`HKCU\Software\Microsoft\Accessibility` `TextScaleFactor` 100-225), `do_not_disturb`
  (`…\PushNotifications` `ToastEnabled`), `clock_seconds` (`…\Explorer\Advanced` `ShowSecondsInSystemClock` + a
  `"TraySettings"` broadcast, Windows 11 23H2+) stay **out** of `available` until an integration test proves the change
  applies live and reads back; I adds a verified one with its test. `night_light`, `battery_percentage`: never.
- koffi signatures (`ffi.ts`; HKEYs are passed as `intptr_t`: `HKEY_CURRENT_USER = -2147483647`,
  `HKEY_LOCAL_MACHINE = -2147483646`, the sign-extended 64-bit values):
  `int32_t RegGetValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32_t flags, _Out_ uint32_t *type, _Out_ void *data, _Inout_ uint32_t *cbData)`
  (`RRF_RT_REG_SZ = 0x02`, `RRF_RT_REG_DWORD = 0x10`, `RRF_SUBKEY_WOW6464KEY = 0x10000`; `ERROR_SUCCESS 0`,
  `ERROR_FILE_NOT_FOUND 2`, `ERROR_ACCESS_DENIED 5`, `ERROR_MORE_DATA 234`, `ERROR_UNSUPPORTED_TYPE 1630`; strings are
  read in two calls, size then data, into a `Buffer` decoded as UTF-16LE without the trailing NUL);
  `int32_t RegSetKeyValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32_t type, const void *data, uint32_t cbData)` (`REG_DWORD = 4`);
  (`RRF_RT_REG_MULTI_SZ = 0x20` too, for the admin policy, §9.4);
  `intptr_t SendMessageTimeoutW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, const char16_t *lParam, uint32_t flags, uint32_t timeoutMs, _Out_ uintptr_t *result)`.

**macOS (`darwin/system/settings.ts`)**: `available = { dark_style: "Dark Mode" }`.
- `change`: `before` = `execFile("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"])` → `"Dark"` is on, exit
  status 1 is off; then `execFile("/usr/bin/osascript", ["-e", \`tell application "System Events" to tell appearance preferences to set dark mode to ${on}\`], { timeout: 10_000 })`;
  `after` read the same way (`systemPreferences.getUserDefault` is cached, so not used). Needs Apple Events consent for
  Ember → System Events (first use shows the system prompt; Info.plist `NSAppleEventsUsageDescription`, port/packaging).
  stderr containing `-1743` → `Error("Ember isn't allowed to change the appearance: allow Ember to control System Events in System Settings › Privacy & Security › Automation.")`;
  `-600`/`-1712` (System Events didn't answer) → `Error("System Events didn't answer; try again.")`.
- **Verify** on macos-15 (CI can grant `kTCCServiceAppleEvents` with `indirect_object_identifier = 'com.apple.systemevents'`
  in the same D10 way); if it can't be verified there, it is verified on a real Mac in §12.3 before Phase 3 ships it.
- Nothing else (Night Shift, Focus, clock and battery options have no public API).

### 9.4 Admin policy (fail closed on everything but "not there")

P1-D first splits `admin.ts` (no behaviour change): `parseAdminPolicy(raw: string, source: string): LoadedAdminPolicy`
(JSON + schema + the LOCKDOWN error texts, moved out of `loadAdminPolicy`) and `lockedDown(source: string, error: string): LoadedAdminPolicy`
are exported; `loadAdminPolicy` calls them.

**Windows (`win32/system/admin-policy.ts`)**: `location = "HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)"`.
- `load(dev)`: `dev !== undefined` → `loadAdminPolicy(dev, { requireRootOwned: false })` (development only). Otherwise
  `readString(HKLM, "SOFTWARE\\Policies\\Ember", "PolicyJson", RRF_RT_REG_SZ | RRF_RT_REG_MULTI_SZ | RRF_SUBKEY_WOW6464KEY)`
  (a `REG_MULTI_SZ` is joined with "\n", because Intune/ADMX text elements are short and a multi-line value is easier to
  deploy; any other type → locked down):
  `ERROR_FILE_NOT_FOUND` (no key or no value) → `{ policy: AdminPolicySchema.parse({}), source: null }`; any other error,
  a value larger than 256 KiB, or koffi/advapi32 failing to load → `lockedDown(location, …)`; else
  `parseAdminPolicy(json, location)`. Only administrators and SYSTEM can write under `HKLM\SOFTWARE\Policies` by its
  default ACL, so there is no ACL check (D7); the POSIX `uid`/`mode` test is never used on Windows (it passes for any
  file there, system.md §4). DOC ships an ADMX/ADML pair whose `PolicyJson` element is a `multiText` (`REG_MULTI_SZ`).
- A policy with `provider.apiKeyFile` → `lockedDown(location, "provider.apiKeyFile isn't supported on Windows: put the key in the ProviderApiKey value of HKLM\\SOFTWARE\\Policies\\Ember")`
  (fail closed instead of a provider without its key).
- `providerApiKey(p)`: `readString(HKLM, "SOFTWARE\\Policies\\Ember", "ProviderApiKey", …)` → trimmed; not found →
  `process.env.EMBER_PROVIDER_API_KEY || undefined`; any other error throws (main logs `admin_policy.api_key_unreadable`, as today).

**macOS (`darwin/system/admin-policy.ts`)**: `location = "/Library/Application Support/Ember/policy.json"`.
- `load(dev)`: `dev` as on Windows. Otherwise `lstat` the folder `/Library/Application Support/Ember`: ENOENT →
  absent; not a real directory (a symlink included), `uid !== 0`, or `(mode & 0o022) !== 0` →
  `lockedDown(folder, "/Library/Application Support/Ember must belong to root and be writable only by root")`. Then
  `lstat` the file: ENOENT → absent; a symlink → locked down; else `loadAdminPolicy(location, { requireRootOwned: true })`
  (today's uid 0 / no group-or-other-write check, applied to the file). `/Library/Application Support` is `root:admin 0755`,
  so creating `Ember/` needs an administrator.
- `providerApiKey`: today's (`apiKeyFile`, else `EMBER_PROVIDER_API_KEY`).

### 9.5 Autostart (`app.setLoginItemSettings`, injected)

**Windows**: `path = process.execPath`; `args = packaged ? ["--autostart"] : [quote(appPath), "--autostart"]` with
`quote(s) = /\s/.test(s) ? \`"${s}"\` : s` (Electron joins `args` with spaces). **No `name`**: the Run value is named
after the AppUserModelId, which main sets before ready (§4.1 item 4), because Electron's `getLoginItemSettings` takes
no name on Windows (`LoginItemSettingsOptions` has only `path`/`args`) and computes `openAtLogin` from the value named
after the AUMID; with a value named "Ember", `openAtLogin` would always be false, `sync(true)` would rewrite the value
on every settings change and `sync(false)` would never delete it (finding W1). Task Manager's Startup apps lists the
exe's own description (§10 item 11), not the value name.
- `sync(on)`: `const cur = app.getLoginItemSettings({ path, args }); if (cur.openAtLogin === on) return false; app.setLoginItemSettings({ openAtLogin: on, path, args }); return true;`
- `launchedAtLogin(argv) = argv.includes("--autostart")`.
- `note()`: when on and (`cur.executableWillLaunchAtLogin === false`, or the `launchItems` entry whose `name` is the
  AUMID has `enabled: false`) → "Turned off in Task Manager's Startup apps: turn Ember on there to start it when you sign in."
- Verify in CI, both halves: after `sync(true)` `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<AUMID>` holds
  `"<execPath>" --autostart` and `openAtLogin` is true; after `sync(false)` the value is gone and `openAtLogin` false.

**macOS** (SMAppService main app, macOS 13+):
- `sync(on)`: `const s = app.getLoginItemSettings(); const isOn = s.status ? s.status === "enabled" || s.status === "requires-approval" : s.openAtLogin; if (isOn === on) return false; if (on && notFoundThisSession) return false; app.setLoginItemSettings({ openAtLogin: on }); if (on && app.getLoginItemSettings().status === "not-found") notFoundThisSession = true; return true;`
  (every register shows "Background Items Added", so never call it when in step; main calls `sync` on every settings
  change; a register whose re-read status is `not-found`, as for a translocated or not-yet-moved copy, isn't repeated
  until Ember restarts, finding M21).
- `launchedAtLogin(argv) = argv.includes("--autostart") || app.getLoginItemSettings().wasOpenedAtLogin === true`
  (no arguments reach a main-app login item; verify on 13/14/15; fallback: a bundled LaunchAgent with `--autostart`,
  a packaging change listed in §10).
- `note()`: `requires-approval` → "Allow Ember in System Settings › General › Login Items to start it when you log in.";
  `notFoundThisSession` or not in Applications (`app.isInApplicationsFolder?.() === false`) → "Move Ember to the
  Applications folder, then turn this on again."

### 9.6 gh CLI, `which` and spawn defaults

- `which(cmd)` = `platform/which.ts` (§2.5) with this OS: Windows reads `Path` case-insensitively from the env, splits on
  `;`, strips quotes, and tries `cmd` as given when it already ends in `.exe`/`.com`, else `cmd + ".exe"` then `".com"`
  (never `.cmd`/`.bat`: Node refuses to spawn them without a shell since CVE-2024-27980, and a shell is never used).
- `ghCliPath()`: Windows `which("gh")`, else the first existing of `<ProgramFiles>\GitHub CLI\gh.exe`,
  `<LOCALAPPDATA>\Microsoft\WinGet\Links\gh.exe`, `<USERPROFILE>\scoop\shims\gh.exe`, `<programData()>\chocolatey\bin\gh.exe`;
  macOS `which("gh")`, else `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, `/opt/local/bin/gh`, `~/.local/bin/gh` (apps
  started from Finder or at login get launchd's `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; Ember never sources a login shell).
  Result cached for 60 s (the sign-in loop asks every 3 s).
- `spawnDefaults`: Windows `{ windowsHide: true }` (spread into `ghCliToken`, the explorer launch and every helper Ember
  spawns); macOS `{}`.
- Every environment Ember edits for a child on Windows (`cleanEnv`, `hostEnv`, `appEnv`'s KEEP/NEVER lists) compares
  names case-insensitively (`Path`/`PATH`, `Node_Options`): `{ ...process.env }` is a plain object there. Unit-tested
  with mixed-case keys.

### 9.7 Paths, runtime, audit, switches

| | Windows | macOS |
|---|---|---|
| `paths.userData(appData, home)` | `path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ember")` (D7; not Roaming: Chromium caches, `copilot/`, 126 MB of models) | `path.join(appData, "ember")` = `~/Library/Application Support/ember` |
| `paths.dataDirLabel(userData, file?)` | `%LOCALAPPDATA%\ember` (+ `\file`) when `userData` is the default, else the real path | the real path with the home folder as `~` (+ `/file`) |
| `paths.renameRetries` | `5` (antivirus and sync locks) | `0` |
| `paths.runtimeId` / `runtimeExe` | `win32-${process.arch}` / `copilot-runtime.exe` | `darwin-${process.arch}` / `copilot-runtime` |
| `auditSink` / `auditCopy` | `undefined` / `null` (D7: file audit log only) | same |
| `chromiumSwitches` | `[]` | `[]` |
| `voice.speakerMonitor` | `false` | `false` |
| `voice.bundledModelDirs(res)` | `[path.join(res, "voice-models"), path.join(programData(), "Ember", "voice-models")]` | `[path.join(res, "voice-models"), "/Library/Application Support/Ember/voice-models"]` |
| `privacy` | `{ neverLookDefaults: NEVER_LOOK_DEFAULTS.win32, isSecurityWindow: w => isSecurityWindow(w, "win32") }` | same with `"darwin"` |
| `clipboardFormats` | `CLIPBOARD_FORMATS.win32` (§9.11) | `CLIPBOARD_FORMATS.darwin` |
| `words` / `shortcuts` / `keys` | `PLATFORM_WORDS.win32` / `SHORTCUTS.win32` / `KEYS.win32` | the darwin rows |

Model downloads (port/voice) need no system `tar`/`bzip2` on either OS; the model folder's `.<target>.ok` dot-files must
survive packaging (port/packaging checks it).

### 9.8 Environment checks and fixes

`environment(ctx)` returns the common inputs (`env`, `osRelease: null`, `glibc: null`, `versions`, `platform`, `arch`,
`shortcutsTaken`, `shortcuts`) plus the OS block; `inspectEnvironment` (P1-D) turns them into checks. Everything here is
an Electron call or a cached koffi call: `readEnvironment` runs on every settings-window status request.

**Windows** `windows: { build, elevated, session, powershell, dpiMixed }`:
- `build` from `process.getSystemVersion?.() ?? os.release()` ("10.0.22631" → 22631);
- `elevated`: `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY = 0x8, &h)` + `GetTokenInformation(h, TokenElevation = 20, &elev, 4, &len)`, cached;
- `session`: `SESSIONNAME === "Console"` → console, `/^RDP-/` → rdp, `ProcessIdToSessionId(pid) === 0` → service;
- `powershell`, first match wins: `env.__PSLockdownPolicy` set, or `ctx.helper.languageMode === "ConstrainedLanguage"` →
  `"constrained"`; the PowerShell policy key (`HKLM`, then `HKCU`, `SOFTWARE\Policies\Microsoft\Windows\PowerShell`:
  `EnableScripts = 1` with `ExecutionPolicy` `AllSigned`, or `EnableScripts = 0`) → `"policy"`; that key's
  `ExecutionPolicy` is `RemoteSigned` and `ember_uia.ps1` or `ember_uia.cs` has a `Zone.Identifier` stream →
  `"blocked-download"` (all three read by `win32/system/powershell.ts`, cached 60 s); `ctx.helper` undefined or null →
  `"unknown"`; `toolkitAccessibility === false` → `"missing"`; true → `"full"`. The state is keyed on facts
  (`languageMode`, the policy values, the stream), never on regex-matching the fatal message's prose;
- `dpiMixed`: `ctx.helper.dpi` and `ctx.helper.processDpi` both present and different.

| Check | ok | warn / fail (fix) |
|---|---|---|
| platform | win32 x64 "Windows x64"; arm64 "Windows on Arm (best effort)" | other arch → fail |
| os | build ≥ 19045: "Windows 11 (build N)" when ≥ 22000, else "Windows 10 (build N)" | 17763-19044 warn "Ember is tested on Windows 10 22H2 and Windows 11"; < 17763 fail |
| session | console/rdp "Desktop session" | service → fail "Start Ember from your desktop, not as a service." |
| accessibility ("Screen reading") | full → "Windows UI Automation" | constrained → warn "Windows PowerShell is restricted on this computer (Constrained Language Mode), so Ember can't read apps. Ask your administrator to allow Ember's accessibility helper."; policy → warn "Your organisation allows only signed PowerShell scripts, and Ember's accessibility helper isn't signed, so Ember can't read apps. Ask your administrator to allow it."; blocked-download → warn "Windows blocked Ember's accessibility helper because it came from the internet." (`unblock-helper`); missing → warn "Ember's accessibility helper didn't start: ${detail}"; unknown → no row |
| display scaling (new) | no row | dpiMixed → warn "Windows reports mixed display scaling to Ember's accessibility helper, so it may click in the wrong place on some monitors. Tell the Ember team." |
| elevated (new) | — | warn "Ember is running as administrator: start it normally so it can't act with administrator rights by mistake." |
| shortcuts | `SHORTCUTS.win32` text | taken → warn with the Win+Alt labels |

Fixes: `ids: ["open-microphone-settings", "unblock-helper"]`; `open-microphone-settings` →
`shell.openExternal("ms-settings:privacy-microphone")`, label "Open Settings"; `unblock-helper` → removes the
`Zone.Identifier` stream of exactly `resources\sidecar\uia\ember_uia.ps1` and `ember_uia.cs` (`fs.rmSync(p +
":Zone.Identifier", { force: true })`); the host sees the mark gone on its next request and starts the bridge again at
once (§6 item 2), label "Unblock it". The fix runs only when the user presses the button; Ember never strips the mark on its own.
(The microphone check itself is a doctor row and a voice status detail, not a setup check.)

**macOS** `mac: { version, accessibility, screen, microphone, inputMonitoring, inApplications, root }`:
`process.getSystemVersion()`, `systemPreferences.isTrustedAccessibilityClient(false)`,
`getMediaAccessStatus("screen")`, `getMediaAccessStatus("microphone")`, `inputMonitoring` from port/darwin's
`CGPreflightListenEventAccess` binding (FX-PD exposes it as `DarwinWindowSystem.inputMonitoring(): boolean | null`;
null while the window system isn't open or the symbol is missing), `app.isInApplicationsFolder()`,
`process.getuid?.() === 0`.

Because an ad-hoc signature's code requirement is its cdhash, which changes with every build, macOS keeps showing Ember
switched on in System Settings after an update while `AXIsProcessTrusted()` and the Screen Recording preflight are false.
Every permission check on macOS therefore ends with: "If Ember is already listed and switched on, remove it with −
and add it again: macOS ties the permission to this exact copy of Ember." (R9).

| Check | ok | warn / fail (fix) |
|---|---|---|
| platform | arm64 "macOS on Apple silicon"; x64 "macOS on Intel" | other → fail |
| os | ≥ 13.0 "macOS ${version}" | < 13 → fail "Ember needs macOS 13 or newer." |
| accessibility ("Reading and using apps") | trusted | fail "Ember needs the Accessibility permission to read and use apps." + the re-grant sentence (`open-accessibility-settings`, `reset-permissions`) |
| screen-recording (new) | granted: "Allowed. macOS asks again about once a month; choose Allow." | warn "Without Screen Recording, Ember can't take screenshots or see other apps' window titles. After you allow it, quit and reopen Ember." + the re-grant sentence (`open-screen-recording-settings`) |
| input-monitoring (new) | true | false → warn "Without Input Monitoring, Ember won't use the keyboard for you, because it couldn't notice you taking over." (`open-input-monitoring-settings`); null → no row. Dropped entirely if I proves key-state polling ungated (Q10) |
| microphone (new) | granted or not-determined (asked at voice consent): no row | denied → warn "Microphone access is off for Ember, so “Hey Ember” can't hear you." (`open-microphone-settings`) |
| location (new) | in Applications | warn "Ember isn't in the Applications folder, so its permissions and login item may not stick." (`move-to-applications`) |
| elevated | — | root → warn "Ember is running as root. Start it as yourself." |
| shortcuts | `SHORTCUTS.darwin` text | taken → warn |

Fixes: `ids: ["open-accessibility-settings", "open-screen-recording-settings", "open-input-monitoring-settings", "open-microphone-settings", "open-automation-settings", "reset-permissions", "move-to-applications"]`:
- `open-accessibility-settings`: `systemPreferences.isTrustedAccessibilityClient(true)` (the system prompt, once), then
  `shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")`;
- `open-screen-recording-settings`: `desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })`
  once (it puts Ember in the list), then `…?Privacy_ScreenCapture`;
- `open-input-monitoring-settings`: `CGRequestListenEventAccess()` once (through port/darwin), then `…?Privacy_ListenEvent`;
- `open-microphone-settings`: `askForMediaAccess("microphone")` when `not-determined`, else `…?Privacy_Microphone`;
- `open-automation-settings`: `…?Privacy_Automation` (offered by the `change_setting` error text, not a check);
- `reset-permissions`: `execFile("/usr/bin/tccutil", ["reset", service, "io.github.komaladitya08.ember"])` for
  `Accessibility`, `ScreenCapture` and `ListenEvent`, then `isTrustedAccessibilityClient(true)`; offered only if I
  verifies on macOS 14 and 15 that a reset by bundle id needs no administrator (else only the re-grant sentence stays);
- `move-to-applications`: `app.moveToApplicationsFolder()` (it relaunches; false → `Error("Ember couldn't move itself: drag Ember into Applications.")`).
Labels: "Open System Settings" (the five `open-*`), "Reset Ember's permissions", "Move to Applications". The settings
window asks for the status again when it regains focus (P1-E), since these change outside Ember. Verify on macOS 15 that
the `x-apple.systempreferences` URLs open the right panes.

### 9.9 Doctor probes

| Probe | Windows | macOS |
|---|---|---|
| `microphones` | `null` (listing devices needs a renderer); the doctor text off Linux says "Not checked here; the settings window tests it" | `null`, same text |
| `speechDispatcher` | `true` (the doctor says "Uses Windows' voices") | `true` ("Uses macOS voices") |
| `sandbox`, `fileWatchers`, `desk` | `null` (rows left out) | `null` |
| `helper` (main's `doctorHelper()`, §4.1) | "Accessibility helper": starts the host once, prints `toolkitAccessibility`, `detail`, `languageMode`, `dpi`/`processDpi`; fail when false | same row; on macOS it is also the proof that the host child itself is trusted when Ember is started by LaunchServices (§10 item 3) |
| `extra` rows | "Microphone privacy": `getMediaAccessStatus("microphone") === "denied"` → warn, fix "Settings › Privacy & security › Microphone › Let desktop apps access your microphone"; "Administrator": elevated → warn; "PowerShell": the `powershell` state of §9.8 (constrained, policy, blocked-download) → warn with §9.8's text; `HKLM\SOFTWARE\Policies\Microsoft\Windows\PowerShell\ModuleLogging` `EnableModuleLogging = 1` or `…\Transcription` `EnableTranscripting = 1` → ok-with-note "PowerShell logging is on: the accessibility helper's start-up is logged (never what is on screen)" (G2); "Helper command line" (always ok, for administrators who allow-list it in an EDR product): the exact PowerShell command line, the script's path and the cached DLL's path and SHA-256 | "Accessibility", "Screen Recording", "Input Monitoring", "Microphone" (each from the calls in §9.8, with the System Settings path and the re-grant sentence as the fix), "Secure input": on → warn naming the app holding it (`kCGSSessionSecureInputPID` → owner, FX-PD), "Location" (Applications folder), "Root" |

`ember --doctor` output on Windows (C16): the zip ships `ember-doctor.cmd`
(`@echo off` / `start "" /wait "%~dp0Ember.exe" --doctor` / `exit /b %errorlevel%`; Electron attaches to the parent
console), a packaging change listed in §10; verify in CI that the report prints and the exit code survives. macOS:
`/Applications/Ember.app/Contents/MacOS/Ember --doctor` in Terminal (TCC then judges Terminal, so the Accessibility rows
describe Terminal's grants; the LaunchServices form `open -n -W --stdout <file> -a Ember.app --args --doctor` judges
Ember itself, and DOC gives both).

### 9.10 Accessibility probes

- **Windows** `screenReaderOn()`: `SystemParametersInfoW(SPI_GETSCREENREADER = 0x0046, 0, &v, 0)`
  (`int SystemParametersInfoW(uint32_t action, uint32_t param, _Out_ int *pv, uint32_t winIni)`), cached 60 s; Narrator,
  NVDA and JAWS set it. Never `app.isAccessibilitySupportEnabled()` (any UIA client, Ember's own helper included, turns
  it on, and Ember would then speak everything: system.md §11.1).
- **macOS** `screenReaderOn()`: VoiceOver runs as its own process only while it is on
  (`/System/Library/CoreServices/VoiceOver.app`), so the primary test is `execFile("/usr/bin/pgrep", ["-x", "VoiceOver"])`
  exiting 0; `defaults read com.apple.universalaccess voiceOverOnOffKey` → `"1"` is a second opinion only (the key is
  absent until VoiceOver was toggled once, and the domain is privacy-protected on recent releases), and the window-list
  test is dropped (it misses VoiceOver with its caption panel and cursor hidden). `NSWorkspace.isVoiceOverEnabled`
  through fixed-arity `objc_msgSend` bindings is the exact API if the process test proves unreliable. The probe runs
  asynchronously every 60 s from creation and `screenReaderOn()` returns the last result (synchronous for `maySpeak`);
  never `isAccessibilitySupportEnabled()`.
- `systemReducedMotion()` on both: `systemPreferences.getAnimationSettings().prefersReducedMotion`.

### 9.11 Vocabularies (package V fills the Windows and macOS rows; Phase 1 leaves them empty)

All matching is lower case on whole words split on space, `.`, `-`, `_`, `!` (app names arrive as program names on
Windows, localized names and bundle ids on macOS). Sources: system.md §16 and gaps.md G9; V verifies each against real
windows in CI and adds `policy.test.ts`/`tasks.test.ts` rows per OS.

- **Terminal window classes** (`hands/terminals.ts` `TERMINAL_CLASSES.win32`, checked by `isTerminalApp` when a window's
  class is known, §4.15): `ConsoleWindowClass`, `CASCADIA_HOSTING_WINDOW_CLASS`, `PseudoConsoleWindow`, `mintty`,
  `PuTTY`, `VirtualConsoleClass`. With port/win32 and the bridge naming console windows `conhost` (§6 item 6), the
  name check catches them too.
- **Terminals and built-in shells** (`hands/terminals.ts`): Windows `TERMINALS` adds `cmd, powershell, pwsh,
  pwsh-preview, windowsterminal, wt, openconsole, conhost, wsl, wslhost, bash, ubuntu, ubuntu2004, ubuntu2204, ubuntu2404,
  debian, kali, mintty, git-bash, cmder, conemu, conemu64, mobaxterm, securecrt, xshell, termius`; macOS adds
  `terminal, iterm, iterm2, warp, xquartz, x11`; shell apps (refused as "a shell built in"): Windows `devenv,
  powershell_ise, notepad++, cursor, windsurf`, plus the command surfaces `searchhost, searchapp,
  startmenuexperiencehost, searchui, taskmgr` and the Run dialog (title `Run`, program `explorer`, class `#32770`);
  macOS `xcode, bbedit, textmate, nova, macvim, script editor, automator, shortcuts, cursor, spotlight`, bundle ids
  `com.apple.terminal, com.googlecode.iterm2, dev.warp.*, com.apple.scripteditor*, com.apple.automator,
  com.apple.shortcuts, com.apple.dt.xcode, com.microsoft.vscode*`; `REFUSED` (argv[0]) Windows `runas, psexec,
  psexec64, mshta, wscript, cscript, regsvr32, msiexec, cmstp, installutil, msbuild, forfiles, pcalua, schtasks, at, sc,
  reg, bitsadmin, certutil, wmic`, macOS `osascript, open, launchctl, automator, shortcuts`; `LAUNCHERS` Windows
  `rundll32, dllhost, applicationframehost, javaw, pythonw, py, wscript, cscript, msiexec` (never `explorer`), macOS
  `open, osascript, java`; the name regex adds `command prompt|powershell|anaconda prompt|git bash|developer (command prompt|powershell)`.
- **Typing into command boxes** (new data `TYPING_REFUSED` in `policy/vocabulary.ts`; P1-C adds the generic check that
  reads it, empty on Linux): Windows File Explorer's address box (program `explorer`, AutomationId `41477` or name
  "Address" in "Address Band Root") refuses `type_text`/`fill` whose trimmed text is a bare program name or ends in an
  executable extension (system.md §2.5).
- **Security windows** (`policy/vocabulary.ts`, the one source for perception, policy, the Windows `systemDialogOpen`
  of §7.2, port/darwin's `SECURITY_OWNERS` and the host's macOS `shell_overlays`): Windows `SECURITY_APP` `credentialuibroker, consent, logonui, lockapp,
  sechealthui, securityhealthhost, smartscreen, bdeunlock, bdeuisrv, microsoft.aad.brokerplugin, wwahost,
  pinenrollmentbroker, bioenrollmenthost, credentialenrollmentmanager`, and `SECURITY_CLASS.win32` (window classes,
  matched through `wmClassName`) `Credential Dialog Xaml Host`, `$$$Secure UAP Dummy Window Class For Interim Dialog`; `SECURITY_TITLE`
  `^(windows security|user account control|enter network credentials|windows hello|making sure it's you|credential manager|stored user names and passwords|bitlocker drive encryption|windows defender firewall with advanced security)$`;
  macOS `SECURITY_APP` `securityagent, coreautha, coreauthd, loginwindow, screensaverengine, coreservicesuiagent,
  universalaccessauthwarn, usernotificationcenter, authenticationservicesagent, keychain access,
  com.apple.keychainaccess, passwords (exact app), com.apple.passwords, ticket viewer, certificate assistant` (V
  verifies each owner name on macOS 14 and 15 by printing `ws.stack()` while the prompt is up);
  `SECURITY_TITLE` `^(privacy & security|passwords|touch id & password|users & groups|login password)$` and
  `^.* wants to (use your confidential information|make changes)`.
- **Risky labels** (`RISKY_EXTRA`, every OS's row also applies its own language lists): `move to bin`, `move to recycle
  bin`, `end task`, `unblock`, `open anyway`, `run anyway`, `force quit`, `empty bin`, `delete permanently`;
  `RUNS_PROGRAM_EXTRA`/`RUN_FILE_DIALOG_EXTRA`: `unblock` (file Properties: removes Mark-of-the-Web), `open anyway`
  (Gatekeeper bypass), `run anyway` (SmartScreen), `open file - security warning`, `are you sure you want to open it`.
- **Browsers, mail and office** (`TABBED_APP`, `WEB_APP`, `OFFICE_APP`): Windows `msedge, chrome, firefox, brave, opera,
  vivaldi, outlook, olk, thunderbird, teams, ms-teams, slack, discord` / `winword, excel, powerpnt, soffice`; macOS
  `safari, google chrome, firefox, brave browser, arc, opera, vivaldi, mail, microsoft outlook, thunderbird, slack,
  microsoft teams, discord, messages, telegram, whatsapp, signal` / `microsoft word, microsoft excel, microsoft
  powerpoint, pages, numbers, keynote, libreoffice`.
- **`FILE_PATH_WORDS`** (worker `dialogNote`): Windows adds `[A-Za-z]:\\|\\\\[\w.-]`; macOS today's regex.
- **Friendly app names** (`app/shared/apps.ts`): Windows `winword` Word, `excel` Excel, `powerpnt` PowerPoint, `outlook`/`olk`
  Outlook, `msedge` Microsoft Edge, `chrome` Google Chrome, `explorer` File Explorer, `notepad` Notepad, `mspaint` Paint,
  `systemsettings` Settings, `calculatorapp` Calculator, `windowsterminal` Terminal, `code` Visual Studio Code,
  `ms-teams`/`teams` Teams, `applicationframehost` "" (never surfaced); macOS names are already friendly, plus bundle ids
  `com.apple.systempreferences` System Settings, `com.apple.finder` Finder.
- **Never-look defaults** (`app/shared/never-look.ts`): Windows `keepass, 1password, bitwarden, lastpass, dashlane,
  nordpass, roboform, enpass, keeper, credentialuibroker` (shown as KeePass … "Password prompts (Windows Security)");
  macOS `keepassxc, 1password, bitwarden, lastpass, dashlane, enpass, strongbox, macpass, keychain access, securityagent`
  (… "Keychain Access", "Password prompts (SecurityAgent)"). No generic words ("passwords", "windows security") as
  never-look substrings: those are exact matches in the security vocabulary.
- **Clipboard formats** (`app/main/agent/clipboard-formats.ts`, created by P1-D with the Linux row, §4.10): Windows `savable` =
  any registered format name except the GDI-handle ones (`CF_BITMAP`, `CF_ENHMETAFILE`, `CF_METAFILEPICT`, `CF_PALETTE`,
  `CF_DSP*`), `passwordMarker` = `ExcludeClipboardContentFromMonitorProcessing` or `Clipboard Viewer Ignore`,
  `ownTextMarkers` = `["ExcludeClipboardContentFromMonitorProcessing"]`; macOS `savable` = UTIs
  (`/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i`) and MIME types, `passwordMarker` = `org.nspasteboard.ConcealedType`,
  `ownTextMarkers` = `["org.nspasteboard.TransientType"]`. **Verify in CI** which names Electron 44's async clipboard lists
  and accepts back on each OS (G5); until verified, V keeps Windows/macOS `savable` to MIME types only (today's rule),
  which loses rich formats but never crashes.
- **Words and copy**: `PLATFORM_WORDS` refinements (V owns words.ts after step 0) and the Windows/macOS strings the
  renderer shows (`Status.platform`).

### 9.12 Lifecycle

| | Windows | macOS |
|---|---|---|
| `appUserModelId` | `"io.github.komaladitya08.ember"` (the bundle identifier used on macOS too) | null |
| `ensureShortcut()` | packaged only: `<programs()>\Ember.lnk` (`FOLDERID_Programs`); when missing, or its target (read with `lnk.ts`) isn't `process.execPath`, `shell.writeShortcutLink(p, exists ? "replace" : "create", { target: process.execPath, appUserModelId, description: "Ember" })`; errors logged (`platform.shortcut_failed`), never thrown (G11: toasts need it) | nothing |
| `appMenu` | false | true (§4.1 item 26) |
| `reopenShowsSettings` | false (`second-instance` already does it) | true (G16) |
| `sessionEnd` | `"window-session-end"` (G10; `before-quit`/`will-quit` don't fire at log-off) | `"power-monitor-shutdown"` |
| `focusOwnApp()` | nothing | `app.focus({ steal: true })` |
| `activateOwnWithInput` | true | false |
| `activateForAsk` | true (today's calls; the ask box is a tool window, §8.3) | false (the non-activating panel becomes key on show; M2) |
| `askMicrophone` | absent | `() => systemPreferences.askForMediaAccess("microphone")` |

---

## 10. Packaging and CI (port/packaging adopted): what changes after it landed

`pkg-packaging.md` and port/packaging's files (merged) are authoritative (`scripts/package/layout.mjs` per target,
per-target `stage.mjs`, the macOS bundle with its executable renamed to `Contents/MacOS/Ember` (departure 1), fuses on
the Electron Framework binary and an ad-hoc re-sign, the Windows zip, the portable smoke test,
`scripts/run-integration.mjs`, `.gitattributes`, the `windows` and `macos` CI jobs). Items 3, 10, 11 (resource editing),
13, 14 and 15 are FX-PK corrections the lead applies right away (they don't wait for Phase 3); package I does the rest:
1. **Drops `--allow-missing-sidecar`** and `--allow-missing` from both CI jobs (and the TODO comments) once
   `dist/app/ax-sidecar.cjs` (port/host's build entry) is on the branch (`sidecar/uia/ember_uia.{ps1,cs}` already are);
   staging then fails closed on a missing helper file, as on Linux.
2. **Integration file lists** (`node scripts/run-integration.mjs …`): Windows
   `test/integration/win32-desktop.test.ts uia-bridge.test.ts ax-sidecar.test.ts win32-system.test.ts ember-win32.test.ts`
   with `EMBER_WIN32_TEST=1 EMBER_UIA_TEST=1 EMBER_WINSYS_TEST=1`; macOS
   `darwin-desktop.test.ts ax-sidecar-darwin.test.ts darwin-system.test.ts ember-darwin.test.ts` with
   `EMBER_DARWIN_TEST=1 EMBER_AX_TEST=1 EMBER_MACSYS_TEST=1`. Steps that were `continue-on-error` become required.
3. **TCC grants and attribution** (D10, supplemented; departure 4). Keep today's path rows for every candidate client.
   Add rows for `kTCCServicePostEvent` and `kTCCServiceListenEvent` (Input Monitoring, §8.5) for the same candidates;
   write `kTCCServiceAppleEvents` rows (`indirect_object_identifier = 'com.apple.systemevents'`, the dark-mode test,
   §9.3) to the **user** database `~/Library/Application Support/com.apple.TCC/TCC.db` (the user tccd evaluates Apple
   Events) and restart it (`launchctl kickstart -k gui/$(id -u)/com.apple.tccd`); and before any capture test write the
   macOS 15 screen-capture approval for the dev Electron, the packaged `Contents/MacOS/Ember` and node:
   `defaults write "$HOME/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals" "<binary>" -date "3024-01-01 00:00:00 +0000"`
   (an unapproved capturing binary gets a modal alert on a headless runner). Replace the bundle-id rows that carry
   `csreq NULL` (ci.yml:349-353; tccd validates a bundle client's code requirement, and an ad-hoc app's designated
   requirement is its cdhash) with one row whose `csreq` is the real requirement: `codesign -d -r- Ember.app` piped
   through `csreq -r- -b req.bin`, inserted as `X'<xxd -p req.bin>'`. **Attribution check**: run the packaged app the
   way users do, through LaunchServices so Ember.app is its own responsible process:
   `open -n -W --stdout "$RUNNER_TEMP/doctor.txt" --stderr "$RUNNER_TEMP/doctor.err" -a dist/package/Ember.app --args --doctor`,
   first **before** Ember's bundle row exists (the "Accessibility" and "Accessibility helper" rows must fail: proves
   nothing is borrowed from the runner's granted ancestors, `/opt/hca/hosted-compute-agent`, the provisioner and
   `/bin/bash`), then after it (both must pass: proves the grant reaches Ember and its host child). The in-process
   integration tests keep printing `AXIsProcessTrusted()` but are not evidence of attribution.
4. **Runtime path**: nothing to stage differently (layout.mjs keeps `@github/copilot-sdk-<plat>-<arch>`), but the
   packaged smoke step also runs `<exe> --doctor` and requires the `copilot` row not to say the runtime is missing
   (P1-D's `locateRuntime({ runtimeId, exe })`).
5. **Packaged host check**: after staging, spawn `ELECTRON_RUN_AS_NODE=1 <exe> <resources>/app/dist/app/ax-sidecar.cjs`
   (the host picks its provider by platform), write `{"id":1,"method":"ping","params":{}}`, and require an answer within
   30 s (proves RunAsNode, the bundle and the paths; the fuse stays ON on Windows too, since D3 runs the host as
   Ember.exe in node mode: G21's "turn it off on Windows" is rejected).
6. **Windows zip contents**: add `packaging/windows/ember-doctor.cmd` (§9.9) beside `Ember.exe`.
7. **macOS Info.plist**: add `NSLocalNetworkUsageDescription` ("Ember connects to your organisation's model service
   or proxy on the local network when your administrator sets one up.", G12) next to port/packaging's keys. The
   executable is `Contents/MacOS/Ember` (`CFBundleExecutable` = Ember: Electron's `app.isPackaged` is false for an
   executable named "electron"); helpers keep Electron's names; port/packaging's CI assertions (`CFBundleExecutable`,
   `--inspect` refused) stay. `LSUIElement` stays unset (Ember keeps a Dock icon and an app menu, §4.1 item 26; with no
   `setVisibleOnAllWorkspaces` call on macOS nothing transforms the process type, §8.3).
8. **Login-item fallback** (only if §9.5's `wasOpenedAtLogin` fails on a supported macOS): a LaunchAgent plist in
   `Contents/Library/LaunchAgents/` with `ProgramArguments [<exe>, "--autostart"]`, registered as an `agentService`;
   decided by I from CI/manual evidence, default not shipped.
9. Lint, typecheck and the eval stay in the Linux jobs; the RPM/AppImage job is unchanged.
10. **Runner facts first** (W7). `windows-2022` is Windows Server 2022, run as an administrator (UAC effectively off),
   with one 1024×768 screen at 100 % and no Store apps (its Calculator is the classic one, no ApplicationFrameHost
   frame). The Windows job prints `[Environment]::OSVersion`, the integrity level (`whoami /groups`), `EnableLUA` and
   the screen size first and exports them (`EMBER_CI_ELEVATED`, `EMBER_CI_LUA`, `EMBER_CI_SERVER`); the integration
   suites branch on them and record "not testable on this runner: <reason>" for the elevated-window refusal, UIPI, the
   de-elevating explorer.exe launch, UWP frames (C15 runs with Settings only when `EnableLUA` is 1), mixed DPI, negative
   coordinates and Win+Alt collisions, all of which are in §12.3. The macOS job prints `sw_vers`, the architecture and
   the TCC rows it wrote. A `windows-2025` row (Windows 11 24H2 shell) is optional (Q9).
11. **Ember.exe's identity** (W12). port/packaging renames electron.exe but keeps Electron's VERSIONINFO and icon (the
   `TODO(port)` at stage.mjs:162), so Task Manager (including **Startup apps**, which §9.5's note sends the user to),
   Settings › Privacy › Microphone, the volume mixer and firewall prompts say "Electron — GitHub, Inc.", and flipping
   fuses leaves an *invalid* Authenticode signature (`HashMismatch`, which some EDR products treat as tampering).
   Before flipping fuses, stage.mjs rewrites the PE resources with `resedit` (MIT, pure JavaScript, unit-testable on
   Linux; a devDependency, Q8): FileDescription and ProductName "Ember", CompanyName the owner, OriginalFilename and
   InternalName "Ember.exe", FileVersion and ProductVersion the package version, the icon group from `ember.ico`, and
   drops the certificate table; then flips fuses and runs `fuses.mjs --check`. CI asserts
   `(Get-Item Ember.exe).VersionInfo` and that `Get-AuthenticodeSignature` reports `NotSigned`, not `HashMismatch`.
12. **Intel Macs** (M6). `macos-15` is Apple silicon and stage.mjs stages per target on its own OS, so an x64
   Ember.app is never built. A small `macos-x64` job on `macos-15-intel` runs only on pushes to the default branch and
   on tags (macOS minutes are 10×): npm ci, build, stage, archive, the packaged checks, the smoke launch of
   `Contents/MacOS/Ember` and `darwin-desktop.test.ts` (no AX host). If the label is unavailable: cross-stage on arm64
   with `npm ci --cpu=x64 --os=darwin` and assert with `lipo -archs` that every Mach-O under Ember.app is x86_64. macOS 13
   is "best effort, untested in CI" in the README until a manual run on a 13 machine (§12.3).
13. **Shortcut registration on Windows** (W8). The packaged smoke test on the Windows runner asserts the log has no
   `shortcut.unavailable` for any of the six chords (Server 2022 has neither PowerToys nor Game Bar, so all six must
   register): this proves Electron 44 maps `Super` to `MOD_WIN` in `RegisterHotKey`.
14. **The bridge compiled as Ember compiles it** (W21). The C# compile step runs `ember_uia.ps1` itself with stdin
   closed and `EMBER_UIA_CACHE` set to a temp folder (Windows PowerShell 5.1's legacy csc through `Add-Type`, the
   assemblies loaded exactly as the bootstrap loads them): it must print the ready line and exit 0. It is required from
   the first run of every branch that touches `ember_uia.cs`; the `Add-Type -ReferencedAssemblies` step with partial
   names goes.
15. **`dev:mac`** (M14, optional): a package.json script that starts the dev Electron through LaunchServices
   (`open -n -W node_modules/electron/dist/Electron.app --args "$PWD"`), so TCC grants go to "Electron" and not to the
   developer's terminal.

---

## 11. Work packages, file ownership, order and tests

Rules for every package: work only in your own worktree and branch; touch only the files listed as yours (a file not
listed for anyone is touched by nobody; ask the lead); never edit another package's file, even "just a type": report it
under "Needs from others"; new members on shared types are optional and reported; commit early and often (the container
can restart). Every package runs `npx tsc --noEmit`, `npm run lint` and `npm test` on Linux before finishing and adds the
tests listed for it.

### 11.1 Already in flight (D11): adopted, with corrections

State at `b3a8fd5`: PT, PK, PW, PU, PD and PV have merged; PH is still in flight. Each merged package's corrections
("Corrections for running packages", at the end) land as one follow-up commit per package made by the lead (FX-PW,
FX-PD, FX-PU, FX-PK), touching only that package's files; PH's land on port/host before it merges.

| Package | Owns | State / merge before | Its corrections must land before |
|---|---|---|---|
| port/testport (PT) | test/unit/** portability edits, vitest.config.ts | merged | — |
| port/host (PH) | app/sidecar-host/**, perception/sidecar.ts launch, build-app.mjs entry, sidecar-launch + sidecar-host tests, test/integration/ax-sidecar.test.ts | in flight; merges before P1-A (main uses the 5th constructor parameter and `hostLaunch`) and before AX starts | PH merges |
| port/uia (PU) | sidecar/uia/**, uia tests | merged | I's Windows integration checks (FX-PU) |
| port/win32 (PW) | platform/win32/** files it wrote, win_bench.ps1, `platform-win32-*` tests | merged | WS merges (FX-PW: activation, console names, bench) |
| port/darwin (PD) | platform/darwin/** files it wrote, `platform-darwin-*` tests | merged | MS and AX merge (FX-PD) |
| port/packaging (PK) | scripts/package/**, packaging/**, ci.yml, smoke, run-integration, .gitattributes, package.json scripts | merged | I (FX-PK: TCC rows, resedit, compile step, runner facts) |
| port/voice (PV) | app/voice/**, scripts/voice/prepare.mjs, voice tests | merged | — (no corrections) |

Because PW and PD have merged, WS's and MS's new files under `platform/win32/` and `platform/darwin/` overlap with nobody
in time; FX-PW/FX-PD edit only the files PW/PD wrote, WS/MS only their own new files.

### 11.2 Step 0 and Phase 1 (five packages in parallel; start after step 0)

| Package | Owns (exactly these files) | Existing tests it may edit | New tests it must add |
|---|---|---|---|
| **Step 0** (lead) | app/main/platform/types.ts, platform/os.ts, app/shared/shortcuts.ts, app/shared/words.ts, the `Check.fix` type in app/main/environment.ts, the two type-only `DesktopApp` members in app/main/hands/system.ts | — | — (runs `npx tsc --noEmit`, lint and the suite) |
| **P1-A** composition, main and Ember's windows | app/main/main.ts, platform/index.ts, platform/compose.ts, platform/linux/{index,window-system,overlay-shaper,desk,clipboard}.ts, app/main/windows.ts, overlay.ts, handle.ts, ask.ts, desk/view.ts, hotkey.ts, voice.ts | none | platform-index, platform-linux (incl. the throwing-`screen` Proxy and quiet `openInput`), platform-linux-window-system, platform-compose (withSystemDialog keeps extras and binding; cleanEnv/hostEnv with mixed-case keys; hoverShaper rows; no darwin `allWorkspaces`), overlay-hover, ask-window-platform (`isWindow(0)` false; `takeFocus` with 0), trusted-sender, platform-boundary (no `process.platform`/`getNativeWindowHandle(` outside platform/ in app/main) |
| **P1-B** perception | app/main/perception/{index,capture,windows}.ts | none | perception-platform (async capture keeps the overlay hidden until it resolves; systemDialogOpen fails closed; OS words; negative origins; the injected `isSecurityWindow` at each of the five call sites) |
| **P1-C** keys, policy and agent | app/main/hands/{borrow,keymap}.ts, app/main/policy/{policy,vocabulary}.ts, app/main/agent/{worker,host,conductor,presenter,persona,worker-persona,clipboard}.ts, app/shared/shortcuts.ts (after step 0) | none | shortcuts (§2.4 invariants, incl. the darwin family rule and the Linux freezes), policy-platform (darwin cmd shortcuts allowed, system keys refused, Ember's chord families refused per OS, Linux sets equal frozen copies, exported helpers with `kc`), borrow-platform (onScreen, negative coordinates, textKey path, blockedReason refusal, `pointerLags` on and off, `lastSyntheticKeyAt`), worker-platform (§4.9, incl. the `privacy` guard and `afterKeys` on darwin), persona-platform (frozen Linux prompts and exported constants; settings rule; desk sentence) |
| **P1-D** system modules | app/main/hands/{system,terminals}.ts, app/main/{environment,doctor,settings,admin,autostart}.ts, app/main/policy/audit.ts, app/main/agent/{runtime,auth,clipboard-formats}.ts, app/shared/{never-look,apps}.ts, platform/which.ts, platform/linux/{system,environment,doctor-probes}.ts | none | platform-linux-system (every row of §3's table against today's values), environment-platforms (Windows 11 in each `powershell` state, Windows 10 1809, macOS 14 without Screen Recording or Input Monitoring, macOS 12), doctor-platforms (new file: `os` discriminator, helper row, Linux arm64 keeps Linux wording), which (win32 PATHEXT, quotes, no .cmd; darwin extra folders), never-look, runtime-platform (ids and exe names), terminals (Linux rows unchanged; `windowClass`), admin-parse (parseAdminPolicy/lockedDown equal today's texts), auth-save (encryptString throws → false), clipboard-formats (the moved `savableFormat`) |
| **P1-E** settings-window copy | app/shared/ipc.ts, app/renderer/home/{index.html,main.ts,copy.ts} | test/unit/ui-copy.test.ts (the never-look equality line only: compare with `NEVER_LOOK_DEFAULTS[HOST_OS]`) | home-platform-copy (no `Status.platform` → today's markup; Linux status renders today's strings; Windows/macOS status fills chords, data dir, mic indicator, hides the journal hint and the speakers sentence; `keyLabel` unchanged for every KEY_NAMES key on Linux) |

Merge order: **P1-B and P1-D** (independent), then **P1-E** (it imports P1-D's `app/shared/never-look.ts`) and **P1-C**
(it uses P1-D's `programsOf`, `hands/terminals.ts`, `clipboard-formats.ts`), then **P1-A** last (it wires everything:
P1-C's option fields, P1-D's `linuxSystem`/`locateRuntime`/`resolveToken`/`SettingsStore` options, and port/host's
launch commit). Each package codes against §2 and §4 from the start; a package that calls another Phase 1 package's new
functions (P1-A, P1-C, P1-E) rebases onto its merged predecessors before its final `tsc`/lint/test run and report, so
the branch is green after every merge (`Status.platform` is optional for the same reason, §4.21). Acceptance for Phase 1
as a whole: on Linux, the whole suite including `npm run test:sidecar`, the el8 integration suites and the smoke test
pass unchanged, and a recorded `EMBER_LOG_LEVEL=debug` session of the standard demo shows the same log events in the same
order before and after (I compares them).

### 11.3 Phase 2 additions (after step 0; merge after Phase 1)

| Package | Owns | Depends on (merge) | New tests |
|---|---|---|---|
| **WS** Windows SystemPlatform and composition | app/main/platform/win32/platform.ts, app/main/platform/win32/system/** | Phase 1, PH, FX-PW | win32-system-* (new names, outside PW's glob) on Linux with fake koffi/Electron (registry error mapping incl. `REG_MULTI_SZ`; argv splitting; `lnk.ts` against fixture bytes incl. advertised and env-var targets; .lnk filtering, missing targets and own shortcut; `GetPackagesByPackageFamily` detection; explorer launch arguments and env; autostart idempotence and both halves; admin policy: absent / too large / apiKeyFile / bad JSON / wrong type → locked down; which/gh candidates; environment inputs in every `powershell` state; `win32SystemDialog` with fake stacks; the async broadcast binding), win32-platform (composition: no koffi load until opened; `sidecarLaunch` shape through port/host's `hostLaunch`; throwing-`screen` Proxy); integration `test/integration/win32-system.test.ts` (`EMBER_WINSYS_TEST`): list() has Settings and File Explorer (Calculator only when its package is registered); launch Notepad through explorer.exe and see its window without `EMBER_*` in its environment; dark_style round trip and restore; HKLM policy absent → `{ source: null }`; autostart sync on then off (value present, then gone); SPI_GETSCREENREADER readable |
| **MS** macOS SystemPlatform, composition and capture | app/main/platform/darwin/platform.ts, darwin/electron-capture.ts, darwin/system/**, test/fixtures/plist/** | Phase 1, PH, FX-PD | darwin-system-* (new names, outside PD's glob: plist XML/binary fixtures; bundle filtering; programs; open -a arguments; admin policy folder/file checks with fake lstat; autostart status logic incl. `not-found`; environment inputs and fixes incl. Input Monitoring and the re-grant text; VoiceOver `pgrep` probe), darwin-electron-capture (§8.2's cases, through `composePoints`), darwin-platform (no koffi until opened; `focusedOwnWindow` passed; throwing-`screen` Proxy); integration `test/integration/darwin-system.test.ts` (`EMBER_MACSYS_TEST`): list() has TextEdit, Finder, System Settings; launch TextEdit; capture of a known region returns points-sized BGRA with the red swatch bytes; dark_style round trip (needs the Apple Events grant in the user database); getMediaAccessStatus("screen") granted under the CI grants |
| **AX** macOS AX provider | app/sidecar-host/providers/{ax-darwin,ax-darwin-read,ax-darwin-api}.ts, and as whole files for its duration providers/index.ts and roles.ts, test/fixtures/mac_bench.js | PH, PD, FX-PD | §5.3's unit and integration tests (`EMBER_AX_TEST`) |
| **V** vocabularies and copy | app/shared/{words,never-look,apps}.ts, app/main/policy/vocabulary.ts, app/main/hands/terminals.ts, app/main/agent/clipboard-formats.ts (Windows/macOS rows only; Linux rows frozen) | Phase 1 | vocabulary-win32 and vocabulary-darwin (every §9.11 row: a positive and a negative example, incl. `TERMINAL_CLASSES`, `SECURITY_CLASS` and the verified macOS owners; Linux rows equal frozen copies), apps-names-platforms |

WS and MS may start right after step 0 (they code against §2 and the documented Phase 1 signatures) and merge after
Phase 1, PH and their FX commit. AX starts when PH, PD and FX-PD are on the branch. V starts when Phase 1 has merged.

### 11.4 Interface additions requested during Phase 2

A Phase 2 package that needs a new optional member writes it in its final report; it doesn't edit types.ts. I applies
the accepted ones in one commit at the start of Phase 3 and the backends adopt them in their follow-ups (owned by I).
Already known from the critiques: `clientProgram?` on a stacked window (FX-PW/FX-PU, console windows),
`DarwinWindowSystem.inputMonitoring()` as a darwin extension (FX-PD, read by MS), and, only if §12.3 item 2 shows Alt
menu mode, `Input.maskMenuKey?()` (R14). `Input.pointerLags` and `WindowSystem.systemDialogOpen` are already in step 0.

### 11.5 Phase 3: integration (package I; after every package above)

Owns: app/main/platform/index.ts (adds the win32/darwin branches), app/main/platform/types.ts (accepted additions),
post-merge maintenance of app/main/platform/win32/** and darwin/** outside WS/MS files and of app/sidecar-host/**
(after AX merges), .github/workflows/ci.yml, scripts/package/**, packaging/**, scripts/run-integration.mjs,
package.json scripts, the `TODO(port)` gates port/testport left in test/unit/** (removed as each feature lands, e.g.
agent-misc.test.ts's runtime gate once `runtimeId` is wired), new test/integration/ember-win32.test.ts and
ember-darwin.test.ts. Ember-level checks: C15 `matchFrame` by pid with the Settings app (when the runner has
`EnableLUA = 1`; else "not testable on this runner"); window-scope screenshot of the bench (`EmberBench.exe` /
`mac_bench.js`) with its password field blacked out; the overlay hidden from a capture; `systemDialogOpen` false at rest;
packaged host ping; on macOS the ask box takes typed keys while the system-wide `AXFocusedApplication` stays TextEdit's
and `blur` hides it (M2); the overlay and handle keep Ember's Dock icon and app menu and the user's app stays frontmost
after start (M1); `check()` under 2 ms median (§8.5); the Input Monitoring evidence of §8.5 (Q10). Work: §10's list
(minus the FX-PK items the lead already applied); switching the platforms on; running §12.3 on real machines; deciding
the "verify" items of §12 from CI evidence (each decision a commit with the evidence in its body).

### 11.6 Docs (package DOC; after I, or alongside I's last week)

Owns PLAN.md, README.md, docs/DEVELOPING.md (D9): PLAN.md §1 (Windows and macOS are no longer "not in v1"), §2 rows for
D1-D8 (one composition root; units; the shared accessibility host; backends; desk Linux-only; shortcuts and the primary
modifier; system integration; packaging), a new milestone **M11 Windows and macOS** in §4 with task ids
(M11.1 platform layer, M11.2 Windows window system and input, M11.3 macOS window system and input, M11.4 sidecar host,
M11.5 UIA bridge, M11.6 AX provider, M11.7 system integration Windows, M11.8 system integration macOS, M11.9
vocabularies and copy, M11.10 packaging and CI, M11.11 integration and manual test), §9 (what remains after the port:
signing and notarization, speaker rejection off Linux, Excel/Numbers grids), §10 a progress row; README and DEVELOPING
gain Windows and macOS sections (install, permissions, `--doctor`, the macOS TCC grants belonging to the terminal in
development and the optional `dev:mac`, Windows Constrained Language Mode, where data lives). Also, from the critiques:
the tester notes for unsigned builds (macOS: drag Ember to Applications first, from the dmg; on macOS 15 open it once,
then System Settings › Privacy & Security › Open Anyway, or `xattr -dr com.apple.quarantine /Applications/Ember.app`;
until it is moved out of Downloads or the dmg, macOS runs it translocated and its permissions and login item don't
stick; after installing a new build, remove Ember from the Accessibility and Screen Recording lists and add it again);
for Windows administrators, the exact PowerShell command line, the script's path and the cached DLL's path and hash to
allow-list in an EDR product, the execution-policy cases (signed-only policies block the helper; `RemoteSigned` blocks it
only for a downloaded zip, which "Unblock it" fixes), and an ADMX/ADML template for `PolicyJson` as a `multiText`;
"macOS 13 and Intel Macs: best effort" until tested (§10 item 12); in PLAN §9, the multi-group XKB keymap caveat for
Linux's approval chord (pre-existing, unchanged by the port). The CLAUDE.md "Platform" ground rule needs an update
too; DOC drafts it in its report for the lead (the owner's file is not edited by a package).

---

## 12. Risks, open questions and the defaults chosen

### 12.1 How the spec contradictions are settled (gaps.md §2)

| | Settled as | Where |
|---|---|---|
| C1 macOS unit | points everywhere; captures resampled to points | §2.1 conventions, §8.2 |
| C2 primary modifier | one canonical `mod`, `cmd` on macOS, `ctrl` elsewhere | §2.2, §2.4 |
| C3 shortcuts vs system keys | one table; `isSystemKey` derived from it per OS | §2.2, §2.4 |
| C4 Windows foreground | input.md §7.6's order, once, in port/win32's `activate` | §7.4 |
| C5 `focusInput` on Windows | port/win32 implements it for Ember's own windows; harmless either way | §7 |
| C6 `.exe` in app names | names carry no `.exe` (committed convention); `appKey` strips it defensively | §2.1, §9.2 |
| C7 launching apps | explorer.exe / `open -a`, never ShellExecute from Ember | §9.2 |
| C8 what gates hands | the window system only; tier-3 refusal per borrow via `blockedReason` | §4.1 item 40, §2.4 |
| C9 four interfaces | one Platform object | §2.1 |
| C10 system dialogs | `systemDialogOpen` (fails closed; port/darwin's natively, Windows through `withSystemDialog`) OR `shell_overlays` | §4.7, §7.2, §8.4 |
| C11 PowerShell command line | port/host's absolute path from `SystemRoot`, windowsHide, `PSModulePath` set to the system modules folder | §5.2, departure 3 |
| C12 AX sidecar name | `dist/app/ax-sidecar.cjs` (shared host) | §5 |
| C13 AX timeouts | 0.25 s in main, 0.8 s in the host (per process) | §5.3, §8.5 |
| C14 first request | port/host's `firstRequestMs` 20 s / 10 s + the DLL cache + one background status (10 s after ready, 60 s at login) | §5.1, §5.2 |
| C15 UWP pid | top-level (frame) pid in both the stack and the bridge; the bridge's busy key is the hosted pid; CI check with Settings | §6 item 5 |
| C16 doctor on Windows | `ember-doctor.cmd` | §9.9, §10 item 6 |
| C17 raw input filter | moot: port/win32 polls (GetAsyncKeyState sees assistive-technology input too) | §7 |

### 12.2 Risks (ranked) with the default and the fallback

- **R1 Hover click-through race (safety).** Off Linux there is no input region: a press within one 16 ms tick of the
  pointer reaching a bubble button can go to the app below. Default: accept for v1 of the port, because the Confirmer's
  500 ms arm delay already ignores clicks on a question that just appeared, and hover hysteresis (6 px) keeps a button
  that was reached slowly. Fallback if the manual test shows misses: a larger entry pad (12-16 px) before taking the
  pointer and, on macOS, a renderer fast path (forwarded `mousemove` → immediate flip); both are I's follow-ups in
  overlay.ts/follow.ts.
- **R2 macOS Screen Recording.** Without it captures are wallpaper-only and window titles empty. Default: preflight on
  every capture (fail closed), a setup check saying a restart is needed, titles from AX for the focused window (PD).
- **R3 TCC attribution of the host child.** Default: the host runs as Ember's own executable, so Ember.app is the
  responsible process when LaunchServices started Ember. CI's in-process tests can't show it (the runner's granted
  ancestors are every step's responsible process); the packaged doctor run through `open -a`, before and after Ember's
  bundle row, does (§10 item 3). Fallback if it isn't: run the host as an Electron utility process
  (`utilityProcess.fork(ax-sidecar.cjs, [], { stdio: "pipe" })`), which macOS attributes to Ember itself;
  `AtspiSidecar` then needs a second launch kind (I's change, behind the same `SidecarLaunch`).
- **R4 CFHash stability across host restarts.** Default `KEY_MODE = "hash"` with the exact 64-bit hex value and
  index-path keys for in-read duplicates; fallback the index-path key for all (§5.3). The "this was a password field"
  memory across restarts and in-read identity (`selectedAlone`) depend on it; CI checks both.
- **R5 desktopCapturer details.** Pixel order, `display_id` sometimes empty, thumbnail sizes. Default: fail closed on any
  mismatch; CI checks the red swatch. Fallback: port/darwin's own CGWindowListCreateImage path (deprecated in the macOS 15
  SDK but still exported) behind the same `capture` injection.
- **R6 Windows foreground lock.** `activate()` from a timer may fail; CursorBorrow then says "the window didn't come to
  the front". Default: port/win32's documented order, with no synchronous cross-thread call (async `SetWindowPos`, FX-PW);
  CI test from a timer.
- **R6-mac macOS cooperative activation (14+).** Background-initiated activation may be declined. Default: `AXFrontmost`
  + `AXRaise`, then after 300 ms without focus LaunchServices (`open -a <bundle>`) and `AXRaise` again (FX-PD); the
  darwin-desktop test activates from a UI-less process.
- **R7 macOS posted key-ups vs the takeover check.** If `CGEventSourceKeyState` still reports Ember's text key as down
  12 ms after the key-up, `check()` would see a takeover. Default: none needed (verify in CI); fallback: I adds an
  optional `Input.ownKeyCodes?(): number[]` to port/darwin's input and CursorBorrow ignores those codes for one step.
- **R8 PowerShell blocked** (Constrained Language Mode, a Group Policy execution policy, AppLocker/WDAC, EDR
  quarantining the cached DLL or flagging an unsigned exe that starts hidden `powershell.exe -NoProfile
  -NonInteractive -ExecutionPolicy Bypass -File …`, a common detection for MITRE T1059.001). Default: Ember reports it
  with the specific reason (setup check, doctor: CLM, signed-only policy, a downloaded zip under `RemoteSigned` with the
  user-initiated "Unblock it" fix), stops retrying after an unfixable failure, gives administrators the exact command
  line, script path and DLL hash to allow-list, and keeps working with screenshots and the borrowed mouse; it never
  bypasses a policy (the `-Command` scriptblock trick that sidesteps execution policy for files is rejected). Signing the
  .ps1 is out of scope (no certificates).
- **R9 Unsigned builds.** SmartScreen ("More info → Run anyway"), Smart App Control (blocks outright), Gatekeeper (on
  macOS 15 there is no right-click → Open: System Settings › Privacy & Security › Open Anyway, or clearing the
  quarantine flag; a quarantined app run from Downloads or the dmg is translocated, so its grants and login item don't
  stick), TCC grants silently invalidated by every ad-hoc build (the cdhash changes; the toggle still shows on: the
  setup checks say "remove and add again", `reset-permissions` where allowed), Keychain prompts on re-signed builds
  (`TokenStore.save` → false, `words.keyringMissing`). Default: documented for testers (DOC); signing and notarization
  are out of scope (D8).
- **R10 Windows full-screen topmost overlay** may make the shell think a full-screen app runs (Focus Assist, taskbar),
  and over a full-screen Direct3D game or a presentation it can prevent independent flip or knock an exclusive-mode app
  out. Default: as is (WS_EX_TOOLWINDOW, no-activate); verify manually. Fallback: in the 2 s raise loop, hide the overlay
  on a display while `SHQueryUserNotificationState` (shell32, one koffi call) says `QUNS_RUNNING_D3D_FULL_SCREEN` or
  `QUNS_PRESENTATION_MODE`, and/or inset it by 1 px (options of `hoverShaper`; I's change).
- **R11 macOS Dock and focus (resolved).** `setVisibleOnAllWorkspaces` would transform the process type (no Dock icon
  and no menu bar with `visibleOnFullScreen`; focus stolen without it). It is never called on macOS (§8.3): panels join
  all Spaces and float over full-screen apps on their own. Remaining check: §12.3 item 16. `LSUIElement` stays open
  question Q1.
- **R12 Admin policy reach.** Windows reads only `HKLM\SOFTWARE\Policies\Ember`; a `%ProgramData%` file is not read (no
  ACL code to get wrong); `apiKeyFile` locks down. macOS checks the file and its folder. Default as designed.
- **R13 Clipboard formats (G5).** Until verified, Windows/macOS save and restore MIME types only: rich clipboard content
  comes back as text/HTML after a tier-3 paste. Default: keep (it never crashes). Until V lands the Windows/macOS password markers,
  a password manager's copy isn't recognised as one there, so Ember could put it back after a paste: V's clipboard
  rows are a gate for Phase 3 (Linux is unchanged).
- **R14 Shortcut collisions.** Windows: Win+Alt+Space is PowerToys Command Palette's default (0.90+) and Win+Alt+M is
  Xbox Game Bar's microphone toggle (on by default on client Windows), so ask or mute is "taken" on many machines;
  macOS apps may take Control+Shift+Command+letter. Default: D6's table with the existing "shortcut taken" path (setup
  check, greeting, handle menu, retry every minute); the Windows letters are Q7. `RegisterHotKey` eats only the letter's
  key-down, so a classic Win32 app may see Alt go down and up alone and enter menu mode (then Allow, Win+Alt+Y, would
  type into a menu bar): checked manually (§12.3 item 2); fallback: when a Win+Alt chord fires, send one `VK 0xE8`
  (unassigned) down/up while Alt is still held (the "menu mask key"), as an optional `Input.maskMenuKey?()` in port/win32
  that main's shortcut handlers call (requested through §11.4).
- **R15 Mixed DPI and negative coordinates.** Default: native units end to end and DIP only through `toDip`; manual test
  with a 150 % monitor left of a 100 % primary and a Retina + external Mac.
- **R16 macOS log-out.** `will-quit` with `preventDefault` during log-out could cancel it. Default: the shutdown hook
  sets `sessionEnding` and will-quit no longer defers then (§4.1 item 25); verify manually.
- **R17 macOS Local Network prompt** for LAN proxies and endpoints (G12). Default: the Info.plist key (§10 item 7); if
  connections still fail, I maps `EHOSTUNREACH` in `explainStartError` to "allow Ember under Privacy & Security › Local
  Network".
- **R18 PowerShell logging (G2).** Only the bootstrap's code is logged (Script Block Logging flags Add-Type); no screen
  data passes through cmdlets. Default: doctor note (§9.9); an integration test with logging policies on is I's
  follow-up when a runner allows it.
- **R19 UIA cache DLL in a user-writable folder (G4).** Same-user tampering only; the source hash names the DLL.
  Default: no extra check.
- **R20 File modes on Windows** (testport A7): 0700/0600 are ignored; privacy rests on `%LOCALAPPDATA%`'s per-user ACL.
  An `EMBER_USER_DATA` on a shared folder would expose logs and the audit trail. Default: documented (DOC); no ACL code.
- **R21 Managed UIA client blind spots** (W17). `System.Windows.Automation`'s client-side proxies for classic Win32
  controls can miss or flatten items, or fail on 32-bit targets. Default: keep it (D3); the bench's ListView/TreeView
  and its x86 build check it in CI. Fallback if they fail: route those control classes through UIAutomationCore's COM
  `IUIAutomation` via `[ComImport]` interfaces in C# 5 (no `dynamic`), keeping the wire protocol unchanged (PU's change).
- **R22 Per-thread DPI awareness** (W20). If powershell.exe's manifest fixed the process awareness, the bridge's
  threads run PMv2 but UIA may convert by the process's context, giving logical coordinates on some monitors. Default:
  the ready line reports both, the host logs `uia.dpi_mixed`, the setup check warns, §12.3 item 13 checks it. Fallback:
  convert per window in the bridge with `LogicalToPhysicalPointForPerMonitorDPI`/`PhysicalToLogicalPointForPerMonitorDPI`
  for bounds and `FromPoint` input, so the wire stays physical.
- **R23 macOS Input Monitoring** (M3). Whether key-state polling needs it is undocumented. Default: fail closed
  (keyboard borrowing needs it, §8.5); I drops the requirement only with CI and manual evidence (Q10).
- **R24 MSIX apps without a shortcut** (W11e). New Teams, WhatsApp, Spotify, Clipchamp and other MSIX desktop apps with
  no `.lnk` and not in the curated table can't be opened by name in v1. Fallback: the bridge enumerates
  `shell:AppsFolder` (Shell.Application through reflection, C# 5) and the host exposes it as an app list.
- **R25 macOS input methods** (M16). `textKey` types through key code 0, which an input method composes from. Default:
  refuse tier-3 typing while the input source isn't a keyboard layout (tier 1 still works); §12.3 item 5 tries a CJK
  input source.
- **R26 Untested targets** (M6). Intel Macs and macOS 13 aren't covered by the per-PR jobs. Default: the `macos-x64` job on
  default-branch pushes and tags (§10 item 12) and "best effort" for macOS 13 until a manual run.
- **R27 One hung UWP app** (W19). ApplicationFrameHost hosts every UWP frame; keying busy by its pid would blind Ember to
  all of them. Default: the bridge keys busy by the hosted pid (FX-PU); §12.3 item 4 pauses Settings and reads Calculator.
- **R28 Console windows** (W5). Classic console windows report their first client's pid. Default: named `conhost`
  (FX-PW, FX-PU) and matched by class too (§9.11); integration test with `python.exe` from a `.lnk`.

### 12.3 Manual test plan (I, on real machines: Windows 11 23H2+ client, Windows 10 22H2, macOS 14 and 15 on Apple silicon, macOS 13 or an Intel Mac when available)

Items marked *(runner)* are the ones CI can't exercise (§10 item 10) and are the only evidence for them.
1. Fresh install from the zip/dmg on a clean account (macOS 15: from the dmg, Open Anyway in Privacy & Security; the app
   not translocated): consent page (macOS: the permissions note), Accessibility/Screen Recording/Input Monitoring
   prompts and fixes, `--doctor` output (Windows through `ember-doctor.cmd`; macOS both from Terminal and through
   `open -a`). Windows: a zip extracted by Explorer under a `RemoteSigned` Group Policy → the "blocked download" check,
   "Unblock it" works; an account whose name has a space and a non-ASCII letter (`José Smith`): the bridge's cache, the
   Start Menu walk and `EMBER_UIA_SCRIPT` work.
2. Shortcuts: ask, stop, settings, mute, allow, deny; one taken by another app → setup warning and handle menu. Windows
   11 client with Xbox Game Bar on and PowerToys installed *(runner)*: which chords are taken; after each of the six,
   Notepad and File Explorer show no menu mnemonics or menu mode.
3. Ask about Notepad/TextEdit content; the ask box takes keys without activating Ember (macOS: TextEdit stays the
   active app, its menu bar stays) and hides on blur. Windows *(runner)*: open the box on desktop 1, switch to desktop
   2, press the ask chord: the box appears on desktop 2 and the desktop doesn't change.
4. Tier 1 in a background window: set text, toggle, choose an option, Save in a dialog (question, Allow by click and by
   key); Explorer/Finder items are selected, never opened. Windows *(runner)*: pause Settings in a debugger; Calculator
   stays readable (busy keyed by the hosted pid).
5. Tier 3: borrowed typing with a German layout (é, ß, €), Cmd/Ctrl shortcuts, takeover by mouse and by keyboard, the
   kill switch under 300 ms (also while the target app is busy: no main-thread stall), an elevated window (Windows
   *(runner)*) and missing Accessibility or Input Monitoring (macOS) refused with the reason. macOS: on QWERTZ a task's
   `ctrl+shift+cmd+z` is refused; with a Japanese or Pinyin input source tier-3 typing is refused with the input-method
   reason and `set_text` still works; without Input Monitoring, does a key pressed during a borrow stop Ember? (the
   evidence for Q10). Windows: a Python REPL started from the Start menu is a terminal (typing refused).
6. Screenshots: window scope with a password field blacked out; a never-look window (KeePass/1Password) masked; UAC /
   SecurityAgent / the Accessibility consent prompt up → no screenshot; Screen Recording revoked → no screenshot and the
   check says so; macOS 15's monthly "bypass the system private window picker" alert appears and Allow keeps capture
   working. Windows: the cursor doesn't flicker on capture (CAPTUREBLT) and no bubble pixels appear.
7. open_app: Calculator (UWP) and Settings on Windows *(runner)*, TextEdit and System Settings on macOS; terminals
   refused (cmd, PowerShell, Windows Terminal, Terminal, iTerm2); the Run dialog and Spotlight refused; an app opened while
   Ember runs elevated starts non-elevated *(runner)*; a Start Menu shortcut whose target was deleted is not offered and
   shows no Explorer prompt.
8. change_setting dark mode both ways and back (Windows: no freeze while another app is busy).
9. Start at login on/off (Windows: the Run value appears and disappears; Task Manager's Startup apps shows "Ember" with
   its icon, and turning it off there shows the note; macOS Login Items approval note; a translocated copy registers
   once and shows the move note); started at login shows only the greeting.
10. Voice: consent, the macOS microphone prompt, "Hey Ember", the setting's "speaker rejection is Linux-only" copy.
11. Sign-in through `gh` installed by winget / Homebrew with Ember started from the Start menu / Finder.
12. Quit with a task running from the menu and with Cmd+Q (question), from the Dock (quits), and logging off during a
    task (keys released, settings saved, no log-off blocked).
13. Two monitors with different scales and one left of the primary *(runner)*: Ember follows the cursor across, the
    focus ring sits on the control, screenshot masks line up; Windows: `at_point` at a control's centre on a 150 %
    monitor left of a 100 % primary returns that control and a tier-1 action's verification bounds match `stack()`'s
    frame (R22); the overlay shows on every virtual desktop.
14. Narrator/NVDA and VoiceOver on (VoiceOver detected with its caption panel hidden): answers and questions are spoken;
    reduced motion honoured; Windows contrast themes keep the bubble readable and the overlay transparent (G17).
15. The Linux build on RHEL 8: the full el8 suite and the demo session, unchanged.
16. macOS: overlay and handle visible over a full-screen Safari Space and on a second Space; Ember keeps its Dock icon
    and app menu; the user's app stays frontmost after Ember starts (M1).
17. macOS: install build N, grant the permissions, install build N+1 over it: the checks say "remove and add again",
    and `reset-permissions` (if offered) works without an administrator (M5).
18. Windows: a full-screen game or a PowerPoint slide show with Ember running: no flicker or exit from full screen (R10).

### 12.4 Open questions for the lead (with the default the packages implement)

- **Q1** macOS `LSUIElement` (no Dock icon)? Default: no: a Dock icon, an app menu, `activate` opens settings.
- **Q2** Windows tier-0 settings beyond dark mode? Default: none until an integration test proves them (§9.3).
- **Q3** A system-log audit copy on Windows/macOS? Default: none (D7); the settings window hides the journal line.
- **Q4** Windows on Arm? Default: best effort with the same code (the copilot runtime, koffi and sharp ship arm64
  builds); CI runs x64 only.
- **Q5** The CLAUDE.md platform rule and `.claude/rules` mention RHEL only. Default: DOC drafts the new wording in its
  report; the lead edits the owner's files.
- **Q6** The hover race mitigations of R1 for v1? Default: not in Phase 1; decided after the manual test (12.3 item 4).
- **Q7** Windows shortcut letters (R14): Win+Alt+Space collides with PowerToys Command Palette and Win+Alt+M with Xbox
  Game Bar. Default: keep D6's table (the "taken" path covers collisions); changing a letter is one row of
  `SHORTCUTS.win32` and nothing else.
- **Q8** `resedit` as a devDependency (§10 item 11), to give Ember.exe its own name, icon and version and drop the broken
  signature. Default: yes (MIT, pure JavaScript, build time only; port/packaging's brief excluded new dependencies, so
  this needs the lead's approval).
- **Q9** CI minutes: an optional `windows-2025` matrix row for the Windows 11 shell, and the `macos-x64` job on
  `macos-15-intel` (default-branch pushes and tags only). Default: no `windows-2025` row (those checks are manual,
  §12.3); the `macos-x64` job on (§10 item 12).
- **Q10** macOS Input Monitoring for keyboard borrowing (§8.5). Default: required (fail closed) until I's evidence shows
  key-state polling isn't gated; then dropped in one commit with the evidence.
- **Q11** The Windows "Unblock it" fix (§6 item 3, §9.8) removes the Mark-of-the-Web from Ember's two helper files when
  the user presses it, which is what `Unblock-File` does under a `RemoteSigned` policy. Default: offered (user-initiated,
  only those two files, never for `AllSigned`/`Restricted` or CLM). Alternative: text only.

---

## Critique resolutions

Ids: **L** = critique-linux.md, **W** = critique-windows.md, **M** = critique-macos.md, numbered as in each file. Every
finding was checked against the code (branch `b3a8fd5`, wt/host `30ec143`) or the Electron typings before deciding.
"Accepted" means the design (or a running package's correction) now does what the finding asks, possibly in a different
form; none is rejected outright. Where a finding was partly overtaken by events, the row says so.

### Linux critique

| Id | Verdict | Why (and what was checked) | Where |
|---|---|---|---|
| L1 | Accepted | port/darwin types by layout while Carbon hot keys bind fixed key codes, so an exact-chord list can be pressed under another letter; the darwin `isSystemKey` now refuses the whole `ctrl+shift+cmd` family (any OS but Linux: superset of a chord's modifiers), with invariant tests; Confirmer defence in depth gated on `pointerLags` so Linux is untouched. The multi-group XKB caveat goes to PLAN §9 | §2.2, §2.4, §4.1 item 38, §11.2, §11.6 |
| L2 | Accepted | Verified wt/host `launch.ts:30-39`: a `hostLaunch` with different inputs, `FIRST_REQUEST_MS` 20/10 s, provider by platform. `platform/host-launch.ts` and `EMBER_UIA_POWERSHELL` are dropped; compositions call port/host's `hostLaunch` with `hostEnv()` (keeps the fake-provider switches unpackaged; needs `TEST_SWITCHES` exported, PH) | §1.1, §2.5, §5.1, §5.2, §7.1, §8.1, §11.2 |
| L3 | Accepted | Verified: `DesktopApp` (hands/system.ts:97-105) has no `argv`, so `Pick<…, "argv">` is TS2344. `AppIdentity` now adds `argv` itself, step 0 adds the two type-only `DesktopApp` members, and step 0 runs `tsc` | §1.2, §2.1, §4.15 |
| L4 | Accepted | Verified `parseCombo` throws on unknown modifiers (borrow.ts:106-109). `KEYS.linux`/`KEYS.win32` get no extra modifiers; darwin keeps only `cmd/command/option/opt`; Linux freezes added | §1.3, §2.2, §2.4, §4.8 |
| L5 | Accepted | The one-step-back tolerance changes who counts as the user. Now gated on a new optional `Input.pointerLags` (port/darwin sets it, FX-PD); without it `check()` is verbatim | §2.1, §2.4, §4.8 |
| L6 | Accepted | Verified darwin `windows.ts:20-56,189-205` (systemDialogOpen, accessibilityTrusted, screenRecording, `focusedOwnWindow`), `capture.ts` (`composePoints`, `captureRect`), win32 `ffi.ts:472` `inputDesktopName`, `security.ts:39` `onUsersDesktop`. Darwin uses port/darwin's check (no wrapper, no MS secure-input module); win32's check reuses port/win32's bindings; `withSystemDialog` is a Proxy that keeps extras; `ElectronParts.browserWindow` feeds `focusedOwnWindow`; electron-capture calls `composePoints` | §2.1, §2.5, §7.1, §7.2, §8.1, §8.2, §8.4, §9.1, §11.3 |
| L7 | Accepted | Verified host `status` (reading.ts:60-73) has no `detail` and goes through `start()` (host.ts:30,77). PH correction: `status` without the start gate, with `detail`/`languageMode`/`dpi`/`processDpi`; main schedules the fetch (new §4.1 text) only when a launch exists | §2.1 `HelperStatus`, §4.1 item 34, §5.2, §9.8; PH |
| L8 | Accepted | One owner: P1-D creates `clipboard-formats.ts` with the moved `savableFormat`; P1-C imports and re-exports it | §4.10, §9.11 |
| L9 | Accepted | Verified worker.ts:2909 uses the imported Linux `isSecurityWindow`. `WorkerSystem.privacy` added; the guard uses it; P1-B tests each of the five perception call sites; P1-C has a win32 `credentialuibroker` case | §4.7, §4.9, §11.2 |
| L10 | Accepted | `isWindow(0)` is false in ask.ts and desk/view.ts; `reveal()` calls `takeFocus` with any id and main guards the input calls with `if (id)` (on darwin nothing is called anyway, M2) | §2.1 notes, §4.1 item 18, §4.5, §4.6 |
| L11 | Accepted | (a) overtaken: PW and PD have merged, so WS/MS files under their folders no longer overlap in time; (b) WS/MS tests renamed `win32-system-*`/`darwin-system-*`; (c) AX owns `providers/index.ts` and `roles.ts` as whole files for its duration, sequentially PH → AX → I; (d) verified there is no `doctor.test.ts` (doctor cases live in PK's packaging.test.ts): P1-D adds `doctor-platforms.test.ts` and discriminates on `DoctorProbes.os` | §4.14, §5.3, §9, §11.1, §11.3 |
| L12 | Accepted | Merge order is now P1-B, P1-D → P1-E, P1-C → P1-A; `Status.platform` is optional; P1-A/P1-C/P1-E rebase onto predecessors before final checks (step 0 adds only the type-only seams) | §1.2, §1.3, §4.21, §11.2 |
| L13 | Accepted | Verified policy.ts:509-614, 1300 call `canonicalKeys` with the Linux default. Every exported key helper and worker's `afterKeys` take `kc`; the worker passes `sys.keys` at each call | §2.4, §4.9 |
| L14 | Accepted | Electron's `screen` throws before ready. `PlatformDeps` states the no-touch rule; Linux, win32 and darwin composition tests use a throwing Proxy | §2.1, §3.3, §4.1 item 1, §11.2, §11.3 |
| L15 | Accepted | (a) `KEY_NAMES` merged, not replaced (verified 30 entries, copy.ts:97-101); (b) exported prompt constants keep today's text (persona.test.ts:70); (c) allowed change 3 covers `features.desk: false` (main.ts:1270); (d) the doctor's `openInput(ws, null)` logs nothing and keeps the closes (main.ts:172, 203-204); (e) `paths.renameRetries` and `Platform.shortcutsReReported` replace main's OS tests; (f) listed as departure 2 | top, §1.3, §2.1, §4.1, §4.10, §4.21 |

### Windows critique

| Id | Verdict | Why (and what was checked) | Where |
|---|---|---|---|
| W1 | Accepted | Verified electron.d.ts:22467-22494 (Windows `getLoginItemSettings` takes only path/args) and :23973-23977 (`name` defaults to the AUMID). `name` dropped; CI checks both halves | §9.5 |
| W2 | Accepted, modified | A GPO execution policy overrides `-ExecutionPolicy Bypass`, and MOTW makes `RemoteSigned` refuse the bootstrap. Ember never strips the mark silently: it detects the case and offers a user-initiated "Unblock it" fix for its two files (Q11); `AllSigned`/`Restricted` get a specific text; the host maps the no-output exit to a detail and doesn't loop. The `-Command` scriptblock alternative is rejected (it sidesteps an administrator's policy) | §6 items 2-3, §9.1, §9.8, §9.9, R8, Q11; PH |
| W3 | Accepted | Same as L7 (verified `WITHOUT_PROVIDER` = ping, remember_secrets). "constrained" is keyed on `languageMode`, not prose | §5.2, §9.8; PH |
| W4 | Accepted, partly overtaken | port/host now retries after 60 s (`retryMs`), not 5 s, but still forever. PH correction: unavailable for life after CLM; after an execution-policy refusal retry only when the mark is gone; otherwise back-off to 10 min | §6 item 2; PH |
| W5 | Accepted | port/win32's `appName` is the program of the window's pid (hwnd.ts:42-56), which for `ConsoleWindowClass` is the first client's. Console windows are named `conhost` in port/win32 and the bridge (`clientProgram` kept), and `TERMINAL_CLASSES.win32` backs it up through `windowClass` | §2.1 `AppIdentity`, §4.15, §6 item 6, §7.4, §9.11, R28; FX-PW, FX-PU |
| W6 | Accepted | A synchronous `HWND_BROADCAST` waits per window. The broadcast uses koffi's async form, `SMTO_ABORTIFHUNG` + `SMTO_BLOCK`, 1000 ms, and isn't awaited | §9.1, §9.3 |
| W7 | Accepted | Runner facts printed and exported; suites record "not testable"; C15 with Settings when `EnableLUA = 1`; WS's list() expects Settings and File Explorer; manual-only items marked *(runner)*; `windows-2025` is Q9 | §1.4, §6 item 5, §10 item 10, §11.3, §11.5, §12.3, Q9; FX-PK |
| W8 | Accepted; D6 kept | Collisions are real but not fatal (the "taken" path handles them): R14 names them, Q7 asks the lead about letters, the smoke test proves `Super` → `MOD_WIN` on the runner, §12.3 checks menu mode, `maskMenuKey` is the fallback | §2.2, §10 item 13, R14, §12.3 item 2, Q7; FX-PK |
| W9 | Accepted | The Windows ask box gets `type: "toolbar"` (tool windows aren't tracked by the virtual-desktop manager); manual check; fallback recreate per open if focus is unreliable | §1.1, §8.3, §12.3 item 3 |
| W10 | Accepted | `GetPackagesByPackageFamily` (documented) replaces the undocumented registry walk; the "offer every entry" fallback is gone; `.lnk` targets are checked when listing and before launching | §9.1, §9.2 |
| W11 | Accepted | (a) known-folder API for Programs/CommonPrograms; (b) a pure TypeScript `.lnk` reader instead of synchronous COM on the main thread; (c) advertised MSI shortcuts get no program (title match) and launch through their `.lnk`; (d) Ember's own shortcut skipped; (e) MSIX-without-shortcut is gap R24 | §9.1, §9.2, §9.12, R24 |
| W12 | Accepted | Verified stage.mjs:162's TODO. `resedit` sets Ember.exe's VERSIONINFO and icon and drops the certificate table before fuses; CI asserts `NotSigned`. New devDependency → Q8 | §10 item 11, Q8; FX-PK |
| W13 | Accepted | The bench is compiled to `EmberBench.exe` (with a ListView, a TreeView and an x86 build) so its program isn't `powershell`, a terminal | §6 item 9, §11.5; FX-PW |
| W14 | Accepted | `EMBER_OWNER_PID` from `hostEnv`; the bridge's `skipPids` and the host keep accessibility requests out of Ember's process | §2.5, §5.1, §6 item 7; PH, FX-PU |
| W15 | Accepted | The Windows dialog check also matches credential/consent window classes and titles, and fails closed for a topmost display-covering window whose program can't be read | §7.2, §9.11 |
| W16 | Accepted | Verified hwnd.ts:120-150 (`bringToTop` after `AttachThreadInput`). Async `SetWindowPos` and a module rule; unit test of the sequence | §7.4, R6; FX-PW |
| W17 | Accepted | Kept as risk R21 with CI coverage (ListView/TreeView, x86 bench) and a COM fallback | §6 item 11, R21; FX-PW, FX-PU |
| W18 | Accepted | (a) PSModulePath set, not deleted (departure 3; PH `bridgeEnv`); (b) case-insensitive env edits; (c) content protection kept as the Windows fallback for hide-for-capture, not the default (unverified either way, and permanent use would hide Ember from screen shares); (d) CAPTUREBLT measured (FX-PW); (e) partly overtaken (port/host already answers "still starting" at once); the status probe waits 60 s at login; (f) EDR note and allow-list facts; (g) full-screen hide as R10's fallback; (h) profile path test; (i) `REG_MULTI_SZ` + ADMX; (j) elevated wording fixed | top, §2.5, §4.1, §8.3, §9.4, §9.6, §9.8, §9.9, §11.6, R8, R10, §12.3 |
| W19 | Accepted | Verified ember_uia.cs:2195-2227 keys busy by `PidOf` (the frame). The busy key becomes the hosted pid for frames | §6 item 5, R27; FX-PU |
| W20 | Accepted | Ready line and `status` carry `dpi` and `processDpi`; `uia.dpi_mixed`; a setup-check warning; manual check; fallback conversions | §5.1, §6 item 8, §9.8, R22; FX-PU, PH |
| W21 | Accepted | CI compiles by running `ember_uia.ps1` itself with stdin closed (what Ember compiles), required from the first run | §6 item 9, §10 item 14; FX-PK |

### macOS critique

| Id | Verdict | Why (and what was checked) | Where |
|---|---|---|---|
| M1 | Accepted | Electron's macOS `SetVisibleOnAllWorkspaces` calls `DockHide()`/`DockShow()` unless `skipTransformProcessType`, and `type: "panel"` already joins all Spaces and floats over full screen. No call on macOS for overlay, handle or ask; a compose test pins it; R11 resolved; manual check | §1.1, §8.3, §10 item 7, R11, §11.5, §12.3 item 16 |
| M2 | Accepted | Electron skips app activation for panels on show/focus. New `AppLifecycle.activateForAsk` (darwin false): `takeFocus` records the id only; I's test proves key input without activation | §2.1, §4.1 item 18, §8.3, §9.12, §11.5 |
| M3 | Accepted, stricter default | Whether key-state polling needs Input Monitoring is undocumented, so the default fails closed: keyboard borrowing needs it until I's evidence says otherwise (Q10); bindings, setup check, fix, CI grants and a manual check | §2.1 `FixId`, §8.5, §9.8, §10 item 3, R23, Q10; FX-PD |
| M4 | Accepted | The runner's ancestors are already granted, so in-process tests prove nothing about attribution; LaunchServices doctor run before/after a bundle row with the real `csreq` (verified ci.yml:349-353 uses `csreq NULL`); PostEvent/ListenEvent rows; AppleEvents in the user DB; replayd approvals; doctor "Accessibility helper" row. D10 supplemented (departure 4) | top, §4.1 doctor, §5.3, §9.9, §10 item 3, R3; FX-PK |
| M5 | Accepted | Ad-hoc cdhash changes per build; checks carry the "remove and add again" sentence; `reset-permissions` fix if it needs no administrator; DOC and manual test | §9.8, R9, §11.6, §12.3 item 17 |
| M6 | Accepted | `macos-15` is arm64 only; a `macos-x64` job on `macos-15-intel` on default-branch pushes and tags, with a cross-stage fallback; macOS 13 "best effort" until tested | §10 item 12, R26, §12.3, Q9 |
| M7 | Accepted | Verified host `at_point` knows the window's pid before `elementsAt` (reading.ts:482-487). The AX provider never messages Ember's pid; `elementsAt(x, y, pid?)` hit-tests app-scoped | §5.1, §5.3; PH |
| M8 | Accepted | Verified cf.ts:264-266 `Number(CFHash)`. Exact hex keys; in-read duplicates fall back to index paths; CI checks a 200-row list | §5.3, R4; FX-PD |
| M9 | Accepted | Verified ax.ts:90-101 has no `kAXValueAXErrorType` case. Per-slot error decoding and mapping, tested with a fake | §5.3; FX-PD |
| M10 | Accepted | At most three round trips per node; `actions` only for actionable roles; `focusable`/`editable` from role, verified with `settable` at action time; deadline checks before each IPC | §5.3 |
| M11 | Accepted | 30 ms window-list cache and one `GetKeys` call in port/darwin; costs logged and budgeted | §8.5; FX-PD |
| M12 | Accepted | LaunchServices activation fallback after 300 ms; R6-mac | §8.5, R6-mac; FX-PD |
| M13 | Accepted | R9 and DOC's tester notes corrected for macOS 15 and translocation; §12.3 item 1 uses the dmg on a clean account | R9, §11.6, §12.3 item 1 |
| M14 | Accepted | DOC explains dev grants; optional `dev:mac` script | §5.2, §10 item 15, §11.6; FX-PK |
| M15 | Accepted | `pgrep -x VoiceOver` primary, `defaults` second opinion, window test dropped | §9.10 |
| M16 | Accepted | port/darwin's `blockedReason` refuses while the input source isn't a keyboard layout; tier 1 unaffected | §2.4, §8.5, R25, §12.3 item 5; FX-PD |
| M17 | Accepted | One owner list in `policy/vocabulary.ts` (`SECURITY_APP.darwin`) read by perception, port/darwin's `SECURITY_OWNERS` and the host's `shell_overlays`; V verifies names | §5.3, §8.4, §9.11; FX-PD |
| M18 | Accepted | Verified hitoolbox.ts:61-80 (all-or-nothing) and desktop.ts:166-168 (false when null). Separate binding, a boolean-or-null answer, session-dictionary fallback, fail closed, holder named | §8.4, §9.9; FX-PD |
| M19 | Accepted | Thumbnails requested at point size; no NativeImage crop/resize; `composePoints` does the rest; the macOS 15 monthly alert is in the check text and §12.3 | §8.2, §9.8, §12.3 item 6 |
| M20 | Accepted | Verified layout.mjs:88-92 and mac-bundle.mjs:30: the executable is renamed because `app.isPackaged` is false for "electron". Departure 1; every path says `Contents/MacOS/Ember` | top, §1.1, §5.1, §9.9, §10 item 7 |
| M21 | Accepted | A `not-found` register isn't repeated in the session; the note asks to move Ember | §9.5 |

---

## Corrections for running packages

The briefs (`pkg-*.md`) are not edited. State at `b3a8fd5`: **port/host (PH) is in flight**, so its corrections are applied
on port/host before it merges; port/win32, port/darwin, port/uia and port/packaging **have merged**, so theirs are applied
by the lead as one follow-up commit per package (FX-PW, FX-PD, FX-PU, FX-PK), touching only that package's files, before
the package listed in "needed before". port/voice and port/testport need no corrections. Each item names the finding it
comes from.

### port/host (PH; `/home/user/wt/host`, `30ec143`) — needed before PH merges

1. **`status` without the start gate** (L7, W3). Add `"status"` to `WITHOUT_PROVIDER` (host.ts:30) and give `AxProvider`
   a non-throwing `health(): { ok: boolean | null; detail?: string; languageMode?: string; dpi?: string; processDpi?: string }`.
   `status` (reading.ts:60-73) answers today's fields plus `detail`, `languageMode`, `dpi`, `processDpi` from `health()`;
   `toolkitAccessibility` is `false` after a failed start. `SidecarStatus` in perception/sidecar.ts gains the same
   optional fields. `UiaProvider` keeps the fatal line's text and `languageMode`; when the bridge exited before writing any
   line and its stderr mentions `execution polic`, `PSSecurityException` or `UnauthorizedAccess`, `detail` is
   "PowerShell refused to run the bridge (execution policy)" (stderr is still never logged above debug).
2. **No respawn loop** (W4, W2). In `UiaProvider.start()` (providers/uia.ts:316-322): after a fatal line with
   `languageMode` `ConstrainedLanguage`, fail every later request at once with the same text for the host's lifetime;
   after an execution-policy refusal, retry at once only when `fs.existsSync(script + ":Zone.Identifier")` has become
   false, else back off; any other failure backs off 5 s, 30 s, 2 min, then 10 min (replacing the fixed 60 s `retryMs`).
3. **Ember's own process** (W14, M7). Read `EMBER_OWNER_PID` from the environment (fall back to `process.ppid`); pass it
   to the bridge as `skipPids` on `topWindows` and `elementsAt` (PU item 3); never hand that pid to a provider call.
   Extend `AxProvider.elementsAt(x, y, pid?: number)` and pass `win.pid` from `atPoint` (reading.ts:487); the UIA
   provider may ignore it.
4. **Export the test switches** (L2). `export const TEST_SWITCHES` in launch.ts (Ember's `hostEnv` keeps them only
   unpackaged). Keep `FIRST_REQUEST_MS` (20 s / 10 s) as the one value; the design no longer has a second one.
5. **PSModulePath set, not deleted** (W18a, departure 3). `bridgeEnv` (providers/uia.ts:216-220) removes every
   case-variant of `PSModulePath` and then sets `PSModulePath` to
   `path.win32.join(<SystemRoot>, "System32", "WindowsPowerShell", "v1.0", "Modules")`; its unit test checks both.
6. **DPI** (W20). Log `uia.dpi_mixed` once when the ready line's `dpi` and `processDpi` differ (PU item 4), and report
   both in `health()`.
7. **Cold start at login** (W18e): already answered at once while starting (`againMs` 0); no change beyond item 2.

### port/win32 (PW; merged) — FX-PW, needed before WS merges

1. **No synchronous cross-thread window call on the main thread** (W16). In `activateWindow` (hwnd.ts:120-150) replace
   `api.bringToTop(hwnd)` with `SetWindowPos(hwnd, HWND_TOP = 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS)`
   (bind `int __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32_t flags)` in ffi.ts;
   drop `BringWindowToTop` if unused), state the rule in the module comment, and add a unit test that the activation
   sequence for a foreign window uses only `ShowWindowAsync`, async `SetWindowPos`, `SetForegroundWindow` and the
   hung-guarded `AttachThreadInput`.
2. **Console windows** (W5). In `appName()` (hwnd.ts:42), a top-level window whose class is `ConsoleWindowClass` or
   `PseudoConsoleWindow` is named `conhost`; the client's program goes to an optional `clientProgram` on the stacked
   window (an extension field, reported to I for types.ts). Unit test from fake facts; integration test with
   `python.exe`/`cmd /k` started from a `.lnk`.
3. **The bench** (W13, W17). `test/fixtures/win_bench.ps1` compiles its form to `EmberBench.exe`
   (`Add-Type -OutputType WindowsApplication -OutputAssembly <temp>\EmberBench.exe`, C# 5, `SetProcessDpiAwarenessContext`
   PMv2 at start) and runs it, so the program name is `EmberBench`; adds a ListView (details view) and a TreeView with
   JSON-line events; a second build with `/platform:x86`. win32-desktop.test.ts asserts `EmberBench` instead of
   `powershell` and keeps not using `windowsHide` for the bench.
4. **CAPTUREBLT** (W18d). Measure on a Windows 11 client whether the composed screen DC includes layered windows
   without `CAPTUREBLT` (Ember's overlay is layered): if so, drop the flag (it hides and redraws the cursor on many
   systems); record the evidence in the commit.

### port/darwin (PD; merged) — FX-PD, needed before MS and AX merge

1. **Secure input fails closed** (M18). Bind `IsSecureEventInputEnabled` on its own in hitoolbox.ts (Carbon, then
   HIToolbox, then CoreServices), outside the all-or-nothing layout binding (hitoolbox.ts:61-80). `desktop.secureInput()`
   (desktop.ts:166-168) returns `boolean | null`: null → use `session().secureInputPid !== null`; when that can't be read
   either, `systemDialogOpen()` returns true and `blockedReason()` returns "Ember can't tell whether a password is being
   typed, so it won't use the keyboard."; log `platform.secure_input_unknown` once. Expose the holder's name
   (`secureInputPid` → owner) for the refusal text and the doctor.
2. **Input Monitoring** (M3). Add `CGPreflightListenEventAccess`, `CGRequestListenEventAccess` and
   `CGPreflightPostEventAccess` to cg.ts's optional symbols; `blockedReason()` refuses with the Input Monitoring text
   (§8.5) while listen access is false; expose `DarwinWindowSystem.inputMonitoring(): boolean | null` and a
   `requestInputMonitoring()` for MS's fix. darwin-desktop.test.ts settles whether polling is gated (§8.5) and logs it.
3. **`pointerLags: true`** (L5) on the object `openDarwinInput()` returns.
4. **Input source check** (M16). `blockedReason()` (and `textKey`) refuse while
   `TISCopyCurrentKeyboardInputSource()`'s `kTISPropertyInputSourceType` isn't `kTISTypeKeyboardLayout`, with §8.5's text
   (main thread only, as the existing TIS calls).
5. **Exact CFHash** (M8). `cf.hash()` (cf.ts:264-266) returns `BigInt.asUintN(64, BigInt(raw.CFHash(ref))).toString(16)`
   (a string; update `CF.hash`'s type and its callers/tests).
6. **AXValue errors** (M9). `decodeAXValue` (ax.ts:90-101) gains `{ type: "error"; code: number }` for
   `kAXValueAXErrorType` (5), read with `buf.readInt32LE(0)`; unit-tested.
7. **One security-owner list** (M17). `SECURITY_OWNERS` (model.ts:60) is built from `SECURITY_APP.darwin` in
   `app/main/policy/vocabulary.ts` once that file exists (Phase 1, filled by V); until then keep today's two names and add
   `coreauthd`, `universalAccessAuthWarn`, `UserNotificationCenter`, `CoreServicesUIAgent`, `AuthenticationServicesAgent`
   and `ScreenSaverEngine` (I switches it to the shared list when V merges).
8. **Activation fallback** (M12). In `raise()` (desktop.ts:148-162): if `AXFocusedApplication` isn't the target pid 300 ms
   after `AXFrontmost`, run `/usr/bin/open -a <bundle path>` (from `proc_pidpath` walked up to the `.app`; nothing for a
   process outside a bundle) and `AXRaise` again; never for Ember's own pid.
9. **Borrow polling cost** (M11). Cache `windows()` for 30 ms in `makeDesktop`; read all keys with Carbon
   `void GetKeys(void *keyMap)` (16 bytes; key `k` down when bit `k & 7` of byte `k >> 3` is set) when it binds, else the
   loop; darwin-desktop.test.ts logs the median cost of `keysDown()`, `windows()` and `focusedWindow()`.

### port/uia (PU; merged) — FX-PU, needed before I's Windows integration checks

1. **Busy key per hosted app** (W19). In `SnapshotTarget`/`HandleTarget`/`PointTarget`/`TopWindows` (ember_uia.cs
   around 2142-2290), use `Win.Hosted(frame, framePid)` as the busy key for an `ApplicationFrameWindow` (the frame's pid
   when there is no hosted window); handles registered from elements inside a CoreWindow use the element's `ProcessId`;
   `busyPids` lists those keys. The wire `pid` stays the frame's (C15). Document it in PROTOCOL.md; a Linux unit test of
   the key choice where possible (uia-files.test.ts checks the documented behaviour), a manual check in §12.3 item 4.
2. **Console windows** (W5). `processName` of a top-level `ConsoleWindowClass`/`PseudoConsoleWindow` window is `conhost`,
   with the client's program in an optional `clientProgram`; PROTOCOL.md updated.
3. **`skipPids`** (W14). `topWindows` and `elementsAt` accept `skipPids: number[]`: no UIA call into those processes
   (their top-level windows listed from Win32 facts only); an `elementsAt` whose `WindowFromPoint` root belongs to a
   skipped pid answers `[]`. PROTOCOL.md updated; the uia-files test checks the dispatch table still matches.
4. **`processDpi`** (W20). The ready line and `status` add `"processDpi"` from `GetProcessDpiAwareness` (shcore) next to
   the threads' `dpi`; PROTOCOL.md updated. Fallback conversions (R22) only if §12.3 item 13 fails.
5. **Integration test** (W17, W13). uia-bridge.test.ts reads the bench's ListView and TreeView, and runs once against the
   x86 bench; it starts `EmberBench.exe` instead of the PowerShell-hosted form.

### port/packaging (PK; merged) — FX-PK, applied right away (CI)

1. **TCC** (M4, M3, §10 item 3). In ci.yml's macOS grant step: add `kTCCServicePostEvent` and `kTCCServiceListenEvent`
   for every candidate; replace the `client_type 0` rows with `csreq NULL` (ci.yml:349-353) by one bundle row with the
   real code requirement (`codesign -d -r- Ember.app | csreq -r- -b req.bin`, `X'<xxd -p req.bin>'`) written only after
   the first attribution run; write `kTCCServiceAppleEvents` (`indirect_object_identifier 'com.apple.systemevents'`) to
   the user database and `launchctl kickstart -k gui/$(id -u)/com.apple.tccd`; write the replayd
   `ScreenCaptureApprovals` dates for the dev Electron, `Contents/MacOS/Ember` and node. Add the two LaunchServices
   doctor runs (`open -n -W --stdout … -a dist/package/Ember.app --args --doctor`, before and after the bundle row) with
   their expected fail/pass on the "Accessibility" and "Accessibility helper" rows.
2. **Runner facts** (W7). First step of the Windows job prints and exports OS version, integrity level, `EnableLUA` and
   screen size (`EMBER_CI_ELEVATED`, `EMBER_CI_LUA`, `EMBER_CI_SERVER`); the macOS job prints `sw_vers`, `uname -m` and the
   TCC rows.
3. **Ember.exe resources** (W12; needs Q8). Add `resedit` as a devDependency; in stage.mjs (replacing the `TODO(port)` at
   :162) rewrite the VERSIONINFO strings and the icon group and drop the certificate table **before** `fuses.mjs`; CI
   asserts `(Get-Item Ember.exe).VersionInfo.FileDescription -eq "Ember"` and `Get-AuthenticodeSignature` →
   `NotSigned`. A Linux unit test in packaging.test.ts reads the rewritten resources back.
4. **Bridge compile step** (W21). Replace the `Add-Type -ReferencedAssemblies …` step (ci.yml:252-257) by running
   `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File sidecar/uia/ember_uia.ps1` with
   stdin closed and `EMBER_UIA_CACHE` set to `$RUNNER_TEMP\uia`: it must print the ready line and exit 0; required.
5. **Shortcut registration** (W8). The Windows packaged smoke run fails if the log has `shortcut.unavailable`.
6. **Intel job** (M6; Q9). Add the `macos-x64` job on `macos-15-intel` for default-branch pushes and tags (npm ci, build,
   stage, archive, packaged checks, smoke launch, darwin-desktop.test.ts), or the cross-stage + `lipo -archs` fallback.
7. **`dev:mac`** (M14). Optional package.json script: `open -n -W node_modules/electron/dist/Electron.app --args "$PWD"`.
8. **Drop `--allow-missing`/`--allow-missing-sidecar`** once PH has merged (I's §10 item 1; listed here because the
   flags live in PK's ci.yml).

### port/voice (PV; merged) and port/testport (PT; merged)

No findings concern them. (testport's report items A1-A7 are already in Phase 1: A1 `runtimeId`, A5 `isTrustedSender`,
A6 per-OS admin policy, A7 documented in R20.)
