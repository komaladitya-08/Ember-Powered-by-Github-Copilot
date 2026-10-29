# Ember on Windows and macOS: the implementation design

Status: binding design for the port. It follows `decisions.md` (D1-D10) wherever a spec disagrees, and settles every
contradiction listed in `gaps.md` (C1-C17, G1-G22). Repository: `/home/user/Ember-Powered-by-Github-Copilot`, branch
`ember-improve/20261022-windows-macos`, base commit `b67b02e`. Every `file:line` is from that tree.

Reading order for implementers: §1 (phases), §11 (your work package and the files you own), then the sections your
package names. The TypeScript in §2 and §5.2 is normative: copy it verbatim, then add only what your package needs
(new optional members need the owner's agreement in Phase 3).

Conventions that apply to every file written for this port (owner's rules): strict TS with `noUnusedLocals`;
`import type` for types; double quotes, semicolons, 2-space indent; a module doc comment on every file stating the
constraint behind it; JSDoc on exports; kebab-case file names; log events `area.snake_case`; British spelling in UI,
docs and comments; UI copy in sentence case; safety rules fail closed. `electron` may be imported (as a value) only in
`main.ts`, `windows.ts`, `overlay.ts`, `handle.ts`, `ask.ts`, `voice.ts`, `revive.ts`, `desk/view.ts` and preloads;
`import type` from `"electron"` is allowed anywhere (it is erased). `agent/`, `perception/`, `policy/`, `hands/`,
`desk/`, `platform/` and `app/sidecar-host/` load under plain Node: platform backends that need Electron get it
injected (`ElectronParts`, §2.1). Never call `koffi.view()`; load koffi lazily with `createRequire(__filename)("koffi")`
inside an `open…()`/`bind()` function, never at import time (so every module imports on every OS and in unit tests);
bind each library once per module (memoise the bindings object); koffi type names are process-wide, so prefix every
`koffi.struct`/`koffi.proto`/`koffi.union` name with the module's tag (`W32Ws_RECT`, `MacIn_CGPoint`, `AxCf_CFRange`).

Baseline in this container (before any change): `typecheck` 0, `lint` 0, `vitest` 55 files pass, 1 skipped, and
`test/unit/desk.test.ts` fails only because the Electron binary isn't installed here (it imports `desk/view.ts`,
which imports `electron`). Acceptance for every package: no new failures, typecheck and lint clean.

---

## 1. Overview and the three tiers of work

### 1.1 Target shape

```
app/main/platform/               one composition root (D1); nothing outside it tests process.platform
  types.ts                       the contract (§2.1, verbatim)
  index.ts                       loadPlatform(deps): Platform, by process.platform only
  host-launch.ts                 SidecarLaunch for the shared TS accessibility host (win32 + darwin)
  linux/                         adapters over today's modules (x11.ts, xshape.ts, hands/*, admin, autostart, audit…)
  win32/                         koffi user32/gdi32/dwmapi/kernel32/advapi32 backends + system integration
  darwin/                        koffi CoreGraphics/ApplicationServices/CoreFoundation backends + system integration
app/shared/shortcuts.ts          the shortcut table (D6) and per-OS key conventions (primary modifier)
app/shared/words.ts              platform words for prompts and copy
app/shared/never-look.ts         never-look defaults and their display names, keyed by OS
app/sidecar-host/                the shared TypeScript accessibility host → dist/app/ax-sidecar.cjs (D3)
  uia/  ax/                      the Windows (C# bridge client) and macOS (koffi AX) providers
sidecar/uia/ember_uia.ps1 .cs    the thin C# 5 UI Automation bridge, hosted by Windows PowerShell 5.1
sidecar/atspi/ember_atspi.py     unchanged (Linux)
```

Runtime picture per OS:

| | Linux (unchanged) | Windows 10 22H2+/11 | macOS 13+ |
|---|---|---|---|
| Window system | `x11.ts` (libX11) via `linux/window-system.ts` | `win32/window-system.ts` (user32, dwmapi) | `darwin/window-system.ts` (CGWindowList, AX at 0.25 s) |
| Input | `hands/input.ts` (XTest) | `win32/input.ts` (SendInput) | `darwin/input.ts` (CGEvent, suppression 0) |
| Capture | XGetImage | GDI BitBlt SRCCOPY\|CAPTUREBLT | Electron `desktopCapturer`, resampled to points |
| Overlay click-through | XShape input region | hover polling, `forward: false` | hover polling, `forward: true`, `type: "panel"` |
| Accessibility helper | Python AT-SPI sidecar | `Ember.exe` (`ELECTRON_RUN_AS_NODE=1`) runs `ax-sidecar.cjs` → spawns `powershell.exe … ember_uia.ps1` (C# UIA bridge) | `Ember` (`ELECTRON_RUN_AS_NODE=1`) runs `ax-sidecar.cjs` with the in-process koffi AX provider |
| Screen units | X root pixels | physical virtual-screen pixels (PMv2) | points |
| Desk (tier 2) | Xvfb desk | none (`Platform.desk = null`) | none |
| Shortcuts | Ctrl+Alt+{Space,X,E,M,Y,N} | Win+Alt+{…} | Control+Shift+Command+{…} |

### 1.2 Phase 1: the platform layer, on Linux, with zero behaviour change

Goal: every OS-specific call in the main process goes through `Platform`; Linux behaves byte-for-byte as before
(same log events, same model-facing text, same keystrokes, same sidecar launch). Phase 1 **wraps** the existing Linux
modules: `x11.ts`, `xshape.ts`, `hands/input.ts`, `hands/keybuffer.ts`, `hands/clipboard-handoff.ts`, `hands/system.ts`,
`autostart.ts`, `admin.ts`, `policy/audit.ts`, `environment.ts`, `doctor.ts`, `desk/*` keep their logic; only their
call sites move behind the platform object, and the modules gain optional parameters whose defaults are today's
behaviour. Phase 1 also lands every OS-keyed **data** table (shortcuts, key conventions, words, never-look defaults,
security/terminal/app-name vocabularies) with Linux rows identical to today, so Phase 2 packages never edit shared files.

Allowed Linux-visible changes in Phase 1 (each listed in §4 with its reason; nothing else may change):
1. `windows.ts` `isTrustedSender` compares with a literal `/renderer/` instead of `${path.sep}renderer${path.sep}`
   (identical on Linux, where `path.sep === "/"`).
2. `agent/auth.ts` `TokenStore.save` returns `false` instead of throwing when `safeStorage.encryptString` throws
   (error path only; today that exception escapes into the sign-in flow).
3. Model-facing text that names `open_on_desk` appears only when the desk is offered (D5). On a Linux host with
   Xvfb, xauth and dbus-daemon nothing changes; on one without them the stale "Try open_on_desk." hints go.
4. The settings-window line "…and in the system journal (`journalctl -t ember-audit`)" shows only when the journal
   sink exists (G7; today it always shows, also where there is no systemd-cat).

Phase 1 is split into five packages (P1-A … P1-E, §11.2) on disjoint files; they code against §2 and §4.

### 1.3 Phase 2: backends, in parallel

Nine packages on disjoint files (§11.3): Windows window system and input (W1), Windows system integration and
composition (W2), the C# UIA bridge and Windows provider (W3), the shared sidecar host core (H), macOS window system and
input (M1), macOS system integration and composition (M2), the macOS AX provider (M3), packaging and CI (P). Each writes
unit tests that run on Linux with fakes, and integration tests that run on the target OS in CI, gated by environment
variables (`EMBER_UIA_TEST=1`, `EMBER_AX_TEST=1`, `EMBER_WIN_TEST=1`, `EMBER_MAC_TEST=1`).

### 1.4 Phase 3: integration

One package (I, §11.4) owns `main.ts` again and the cross-cutting files: it switches the Windows and macOS platform
objects on in `platform/index.ts`, resolves any interface additions the Phase 2 packages requested, turns the CI
integration steps from `continue-on-error` to required, runs the manual test plan (§12.3) on real machines, and updates
`PLAN.md` (D9: §1, §2 rows, milestone M11 with task ids, §9, §10), `README.md` and `docs/DEVELOPING.md`.

---

## 2. Interfaces

### 2.1 `app/main/platform/types.ts` (normative; owner P1-A)

Linux-only members are marked **Linux only**, with what Windows and macOS return.

```ts
/**
 * The platform layer's contract: every OS-specific capability Ember's main process uses, behind one Platform object
 * that loadPlatform() (./index.ts) picks by process.platform alone, never by $DISPLAY. The Linux implementation wraps
 * the existing X11, XTest, XShape, AT-SPI and GNOME modules unchanged; Windows and macOS implement the same shapes so
 * callers keep one code path. Types only (no runtime code), so plain-Node modules (perception, agent, policy, hands,
 * desk, the sidecar host) may import it.
 */

import type { App, BrowserWindow, BrowserWindowConstructorOptions, DesktopCapturer, PowerMonitor, Screen, Shell, SystemPreferences } from "electron";
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

export type { KeyConventions, OS, PlatformWords, ShortcutTable };

// ───────────── Geometry ─────────────

/**
 * A window in the platform's own id domain: the X11 client window XID (linux), the top-level HWND as a number (win32),
 * the CGWindowID (darwin). 0 means none. The window system, the input backend and windowId(ownWindow) share it.
 */
export type WindowId = number;

/**
 * Screen units: X root pixels (linux); physical virtual-screen pixels of a per-monitor-v2 DPI-aware process (win32);
 * CoreGraphics global points, top-left origin, y down (darwin). x and y may be negative off Linux.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** A top-level window as the "who is this" queries report it. Its geometry is for identity only. */
export interface PlatformWindow extends Rect {
  id: WindowId;
  /** Owning process; Ember's own windows report the main process's pid. null only on X11 without _NET_WM_PID. */
  pid: number | null;
  title: string;
  /**
   * What never-look, isSecurityWindow and friendlyApp match. linux: WM_CLASS "instance Class"; win32:
   * "<exe base> <window class>" (UWP: "ApplicationFrameHost <hosted exe base> ApplicationFrameWindow");
   * darwin: "<bundle id> <owner name>".
   */
  wmClass: string;
  /** clientWindows() only: the friendly part (linux: WM_CLASS class; win32: exe base; darwin: kCGWindowOwnerName). */
  wmClassName?: string;
}

/** A mapped top-level window as stacked on screen. Field names are X11's so matchFrame and coveringRects don't change. */
export interface StackedWindow extends Rect {
  /** linux: the window manager's frame (or the window itself); win32/darwin: equal to `client`. */
  id: WindowId;
  /** The id activate(), activeWindow() and findWindow() use. */
  client: WindowId;
  pid: number | null;
  title: string;
  wmClass: string;
  /** linux: client + _NET_FRAME_EXTENTS; win32: GetWindowRect (invisible resize borders included, as UIA's frame); darwin: kCGWindowBounds. */
  outer: Rect;
  /** linux: the client window; win32: DWMWA_EXTENDED_FRAME_BOUNDS; darwin: kCGWindowBounds. */
  inner: Rect;
  /** A popup the app opened (menu, dropdown list, tooltip): never matched as a frame, and covers nothing of its own app. */
  overrideRedirect: boolean;
}

/** A screen rectangle's pixels: always one pixel per screen unit (darwin resamples Retina captures to points). */
export interface ScreenImage extends Rect {
  /** BGRA, stride = width * 4; alpha is ignored. */
  bgra: Buffer;
}

/** The pointer in screen units. `mask` uses X's layout on every OS: 256 logical primary, 512 middle, 1024 secondary. */
export interface PointerState extends Point { mask: number }

/** Keys held when an ask-shortcut callback runs (freshAskPress, hotkey.ts). */
export interface ChordState { control: boolean; alt: boolean; space: boolean }

// ───────────── Window system ─────────────

/** What Perception needs. The desk's remote X11 facade (desk/agent.ts deskX11) satisfies it structurally. */
export interface PerceptionWindows {
  activeWindow(): PlatformWindow | null;
  focusWindow(): PlatformWindow | null;
  clientWindows(): PlatformWindow[];
  stack(): StackedWindow[];
  /** Synchronous on linux and win32, asynchronous on darwin. null: nothing of it is on screen, or it can't be captured safely. */
  capture(x: number, y: number, width: number, height: number): ScreenImage | null | Promise<ScreenImage | null>;
  /**
   * A system authentication surface is up, or may be. win32: the input desktop isn't "Default" (UAC, Ctrl+Alt+Del,
   * lock screen); darwin: a SecurityAgent/coreautha/coreauthd window is on screen, or secure keyboard entry is on.
   * Fails closed: true when it can't tell. Absent on linux (GNOME's dialogs come from the sidecar's shell_overlays).
   */
  systemDialogOpen?(): boolean;
}

export interface WindowSystem extends PerceptionWindows {
  readonly os: OS;
  /** Transparent windows render correctly. linux: _NET_WM_CM_S0 is owned; win32 and darwin: always true. */
  hasCompositor(): boolean;
  /** Linux only true (main then polls hasCompositor every 2 s). win32/darwin: false. */
  readonly compositorMayChange: boolean;
  /** null when it can't be read (closed; win32 secure desktop). */
  pointer(): PointerState | null;
  /**
   * Linux only: X re-reports a grabbed shortcut when its grab ends, so a callback is checked against the keys really
   * held. win32/darwin return null (their hotkeys fire once per press; freshAskPress trusts null, debounced).
   */
  keysDown(): ChordState | null;
  /** Ember's own window → WindowId. linux: native handle uint32; win32: HWND; darwin: CGWindowID from getMediaSourceId(). 0 if destroyed. */
  windowId(win: BrowserWindow): WindowId;
  /** Is `id` one of Ember's own windows? */
  isOwnWindow(id: WindowId): boolean;
  /** Brings a window to the front with the keyboard. Best effort: callers check focusWindow(). linux: XInput.activate (nothing without XTest). */
  activate(id: WindowId): void;
  /** linux: XSetInputFocus for one of Ember's own windows (through XInput). win32/darwin: absent. */
  focusInput?(id: WindowId): void;
  /** Screen units → Electron DIP. linux: ÷ primary scaleFactor; win32: screen.screenToDipPoint; darwin: identity. */
  toDip(p: Point): Point;
  /** DIP → screen units. */
  fromDip(p: Point): Point;
  /** linux: each field ÷ primary scaleFactor (main.ts:1253 today); win32: screen.screenToDipRect(null, r); darwin: identity. */
  rectToDip(r: Rect): Rect;
  /** Every display's union in screen units (Perception.screenBounds). */
  screenBounds(): Rect;
  close(): void;
}

/**
 * The input backend: hands/input.ts's XInput method set and conventions on every OS (X keysym names and numbers as
 * the key vocabulary; X button numbers 1 left, 2 middle, 3 right, 4/5 wheel up/down, 6/7 wheel left/right, 8/9 back
 * and forward; the X button mask in pointerState). Key codes are opaque per backend and never 0 (linux X keycode
 * 8-255; win32 virtual-key code 1-254, text keys 0x10000 + char code; darwin CGKeyCode + 8). New members are optional.
 */
export interface Input extends XInput {
  /** win32: a key code that types `ch` (printable ASCII, "\n" or "\t") whatever the layout (KEYEVENTF_UNICODE), or 0. Absent elsewhere. */
  textKey?(ch: string): number;
  /** win32/darwin: is (x, y) on a monitor? (Virtual-screen boxes have dead zones and may start below 0.) Absent on linux. */
  onScreen?(x: number, y: number): boolean;
  /** Why input can't reach `window` (win32: it runs elevated, UIPI; darwin: no Accessibility trust), or null. Absent on linux. */
  blockedReason?(window: WindowId): string | null;
}

// ───────────── Overlay and Ember's floating windows ─────────────

export type FloatingKind = "overlay" | "handle" | "ask" | "desk-view";

export interface FloatingWindow {
  /** Spread last into the window's BrowserWindow options (so they override Ember's defaults). linux: {}. */
  options: Partial<BrowserWindowConstructorOptions>;
  /** Replaces the window class's own setVisibleOnAllWorkspaces call. linux: exactly today's call for this kind (none for ask and desk-view). */
  showOnAllWorkspaces(win: BrowserWindow): void;
}

export interface OverlayShaper {
  /**
   * Restricts `win`'s input to `rects` (window-local DIP; `scale` = its display's scaleFactor). true only with a real
   * input region (linux XShape). win32/darwin return false, and OverlayManager's hover polling runs.
   */
  setInputRegion(win: BrowserWindow, rects: readonly Rect[], scale: number): boolean;
  /** Closes what setInputRegion keeps open (OverlayManager.stop). */
  release(): void;
  /**
   * Click-through windows call setIgnoreMouseEvents(true, { forward: true }) when this is true (darwin), else
   * setIgnoreMouseEvents(true) with no options exactly as today (linux, and win32 where forward would install a
   * low-level mouse hook on the UI thread).
   */
  readonly forward: boolean;
  floating(kind: FloatingKind): FloatingWindow;
}

// ───────────── Linux-only helpers ─────────────

/** Linux only (an X keyboard grab while the ask box opens). Platform.keyboardHold is null on win32 and darwin. */
export type KeyboardHold = (o: { log?: (event: string, fields: Record<string, unknown>) => void }) => KeyBuffer | null;

/** Linux only (freedesktop clipboard manager hand-off, X PRIMARY). Platform.clipboard is null on win32 and darwin. */
export interface ClipboardBridge {
  /** An X id of one of Ember's windows, for telling its clipboard apart; 0 without $DISPLAY (today's gate, main.ts:1017). */
  ownerId(win: BrowserWindow): number;
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

export interface SidecarLaunch {
  readonly kind: "atspi" | "uia" | "ax";
  command: string;
  args: readonly string[];
  /** The child's whole environment; AtspiSidecar adds EMBER_ATSPI_ID_BASE. */
  env: NodeJS.ProcessEnv;
  /** win32: true, so no console window appears for the helper (G1). */
  windowsHide?: boolean;
  /** Timeout for requests written before the process has answered anything (cold start, C14). Absent: the request's own 5000 ms. */
  firstRequestMs?: number;
}

// ───────────── System integration ─────────────

export interface AppCatalog {
  /** Installed apps (cached; at most about 1 s cold). linux: XDG .desktop files; win32: Start Menu .lnk + AppsFolder; darwin: .app bundles. */
  list(): DesktopApp[];
  /** hands/system.ts findApp on every OS (its ranking is generic). */
  find(apps: DesktopApp[], query: string): DesktopApp | null;
  /** Detached; throws synchronously for terminals; the child never inherits Ember's environment (tokens, EMBER_*). */
  launch(app: DesktopApp): void;
  isTerminalApp(app: Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "argv" | "categories" | "terminal">>): boolean;
  hasBuiltInShell(app: Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "argv" | "categories">>): boolean;
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
  /** userData unless EMBER_USER_DATA overrides it: linux and darwin appData/ember; win32 %LOCALAPPDATA%\ember (D7). */
  userData(appData: string): string;
  /** The Copilot runtime, relative to the app path. linux: exactly today's constant (runtime.ts:9). */
  readonly runtimeRelative: string;
}

export interface AdminPolicySource {
  /** Where the doctor and settings window say the policy lives. */
  readonly location: string;
  /**
   * admin.ts loadAdminPolicy's contract: absent → { policy: {}, source: null }; unreadable, untrusted or invalid →
   * LOCKDOWN with `error` (fail closed). `devOverride`: EMBER_ADMIN_POLICY, which main passes only when unpackaged.
   */
  load(devOverride?: string): LoadedAdminPolicy;
  /** The provider API key. linux/darwin: apiKeyFile, else EMBER_PROVIDER_API_KEY (today); win32: HKLM ProviderApiKey, else EMBER_PROVIDER_API_KEY. */
  providerApiKey(p: NonNullable<AdminPolicy["provider"]>): string | undefined;
}

export interface Autostart {
  /** Makes the OS match `on`; true when something changed. Never touches the OS when already in step. */
  sync(on: boolean): boolean;
  /** linux/win32: argv has --autostart; darwin: app.getLoginItemSettings().wasOpenedAtLogin. */
  launchedAtLogin(argv: readonly string[]): boolean;
  /** A note for the settings window ("needs your approval in System Settings > General > Login Items"), or null. */
  note(): string | null;
}

/** Setup-check fixes (environment.ts Check.fix). */
export type FixId = "enable-accessibility" | "open-accessibility-settings" | "open-screen-recording-settings" | "open-microphone-settings" | "move-to-applications";

export interface EnvContext {
  /** openWindows() was tried and returned a window system (undefined: not tried yet). */
  windowsOpened?: boolean;
  shortcutsTaken?: string[];
  /** The accessibility helper's last status (win32: PowerShell language mode), null when it didn't answer, undefined when not asked. */
  helper?: { toolkitAccessibility: boolean | null; languageMode?: string } | null;
}

/** One extra doctor row a platform adds (doctor.ts DoctorCheck's shape). */
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
  /** win32/darwin rows in doctor wording (permissions, PowerShell language mode, elevation). linux: []. */
  extra: PlatformDoctorRow[];
}

export interface A11yProbes {
  /** A real screen reader runs. linux: GNOME's screen-reader-enabled (cached 60 s) || app.isAccessibilitySupportEnabled() (today); win32: SPI_GETSCREENREADER; darwin: VoiceOver. */
  screenReaderOn(): boolean;
  /** The OS asks for less motion. linux: gsettings enable-animations false; win32/darwin: systemPreferences.getAnimationSettings().prefersReducedMotion. */
  systemReducedMotion(): boolean;
}

/** Unpacks one .tar.bz2 voice model archive into `root`. Errors carry the word "tar" (voice.ts downloadHelp maps them). */
export type Unpacker = (archive: string, root: string) => Promise<void>;

export interface VoicePlatform {
  /** Linux only true (parec speaker rejection); win32/darwin false, and the setting and consent copy say so. */
  readonly speakerMonitor: boolean;
  /** linux: undefined (the system tar, as today); win32/darwin: the in-process extractor (app/voice/untar.ts). */
  readonly unpack?: Unpacker;
  /** Folders a bundled copy of the models may be in (linux: /usr/share/ember/voice-models, then resources/voice-models). */
  bundledModelDirs(resourcesPath: string): string[];
}

export interface PrivacyVocabulary {
  /** Never-look entries a fresh install starts with (app/shared/never-look.ts NEVER_LOOK_DEFAULTS[os]). */
  readonly neverLookDefaults: readonly string[];
  /** policy.ts isSecurityWindow with this OS's vocabulary. */
  isSecurityWindow(w: { app?: string; title?: string; name?: string }): boolean;
}

/** Clipboard formats Ember saves and puts back around a tier-3 paste (agent/clipboard.ts), per OS. */
export interface ClipboardFormats {
  /** A format (as Electron lists it) that may be read and written back. linux: today's savableFormat. */
  savable(type: string): boolean;
  /** A password manager's "this is a password" marker (linux: x-kde-passwordManagerHint). */
  passwordMarker(type: string): boolean;
}

export interface AppLifecycle {
  /** Before app ready. win32: app.setAppUserModelId. linux/darwin: nothing. */
  beforeReady(): void;
  /** After ready. win32: Start Menu shortcut for toasts (zip build, first run); darwin: an app menu whose Quit calls `quit`. linux: nothing. */
  afterReady(o: { quit: () => void; showSettings: () => void }): void;
  /** OS session ending without will-quit (win32 BrowserWindow "session-end"; darwin powerMonitor "shutdown"). linux: never calls back. */
  onSessionEnd(fn: () => void): void;
  /** darwin: reopening Ember.app (Dock, Finder) emits "activate", not "second-instance": true → main shows settings on "activate". */
  readonly reopenShowsSettings: boolean;
  /** Before a dialog with no parent (darwin: app.focus({ steal: true })). linux/win32: nothing. */
  beforeDialog(): void;
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
  /** Where the settings window says that copy is, or null when auditSink gives none. */
  auditCopy(): string | null;
  /** Absolute path of a usable gh, or null to use "gh" from PATH (linux: always null, as today). */
  ghCliPath(): string | null;
  /** path.delimiter, PATHEXT (.EXE;.COM only) on win32, extra folders on darwin. */
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

/** The Electron pieces backends may use; main passes them in (plain-Node modules never import electron). */
export interface ElectronParts {
  app: App;
  screen: Screen;
  desktopCapturer: DesktopCapturer;
  systemPreferences: SystemPreferences;
  shell: Shell;
  powerMonitor: PowerMonitor;
  BrowserWindow: Pick<typeof BrowserWindow, "getAllWindows" | "getFocusedWindow">;
}

export interface PlatformDeps {
  electron: ElectronParts;
  packaged: boolean;
  execPath: string;
  appPath: string;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
}

export interface Platform {
  readonly os: OS;
  readonly system: SystemPlatform;
  /**
   * D1's `windows`, opened after app ready (it needs Electron's screen). linux: openX11() only when $DISPLAY is set,
   * as today, else null; win32/darwin: never null. Call once.
   */
  openWindows(log: Logger): WindowSystem | null;
  /**
   * D1's `input`, opened after openWindows. null when there is none (linux without XTest; logged as today). linux also
   * hands the XInput to the window system, whose activate()/focusInput() go through it.
   */
  openInput(ws: WindowSystem, log: Logger): Input | null;
  readonly overlay: OverlayShaper;
  readonly keyboardHold: KeyboardHold | null;
  readonly clipboard: ClipboardBridge | null;
  sidecar(ctx: SidecarContext): SidecarLaunch;
  readonly desk: DeskFactory | null;
}
```

Deviations from D1's wording, on purpose: `windows` and `input` are opened lazily by `openWindows()`/`openInput()`
because Electron's `screen` only works after `app.whenReady()`, and the Linux XInput must be attached to the Linux
window system. The security-window and terminal vocabularies are exposed as functions bound to the OS
(`privacy.isSecurityWindow`, `apps.isTerminalApp`) because their data stays in `policy.ts` and `hands/system.ts`,
keyed by OS (§2.4).

`app/main/x11.ts` keeps exporting `Rect`, `StackedWindow`, `X11Window`, `X11Image` and `X11`, but its `Rect` and
`StackedWindow` interface bodies are replaced by `export type { Rect, StackedWindow } from "./platform/types";` so
existing imports (`perception/windows.ts`, `desk/place.ts`, `desk/agent.ts`, tests) keep compiling.

`app/main/platform/index.ts` (P1-A; switched on per OS in Phase 3):

```ts
/** loadPlatform(): the one place that reads process.platform (D1). Backends load native libraries only when opened. */
import type { Platform, PlatformDeps } from "./types";
import { linuxPlatform } from "./linux";
import { win32Platform } from "./win32";      // Phase 3 adds this import (W2 owns win32/index.ts)
import { darwinPlatform } from "./darwin";    // Phase 3 adds this import (M2 owns darwin/index.ts)

/** The platform for this process. Unknown OSes get the Linux object (they fail the environment's platform check, as today). */
export function loadPlatform(deps: PlatformDeps, os: NodeJS.Platform = process.platform): Platform {
  if (os === "win32") return win32Platform(deps);
  if (os === "darwin") return darwinPlatform(deps);
  return linuxPlatform(deps);
}
```

In Phase 1 `index.ts` has only the Linux branch (the win32/darwin imports are added by I in Phase 3), so Phase 1 never
depends on Phase 2 files. `win32Platform` and `darwinPlatform` have the signature `(deps: PlatformDeps) => Platform`.

`app/main/platform/host-launch.ts` (P1-A, pure, unit-tested in Phase 1, used by W2 and M2):

```ts
/** The SidecarLaunch for the shared TypeScript accessibility host (dist/app/ax-sidecar.cjs) run by Ember's own binary as Node. */
export function hostLaunch(ctx: SidecarContext, o: {
  provider: "uia" | "ax";
  /** The base environment, already cleaned by the caller (win32: allowlisted, no PSModulePath). */
  env: NodeJS.ProcessEnv;
  /** Provider settings, e.g. EMBER_UIA_SCRIPT, EMBER_UIA_POWERSHELL, EMBER_UIA_CACHE. */
  extraEnv?: Record<string, string>;
  windowsHide?: boolean;
  firstRequestMs: number;
}): SidecarLaunch;
// → { kind: o.provider, command: ctx.execPath, args: [path.join(ctx.appDir, "ax-sidecar.cjs")],
//     env: { ...o.env, ...o.extraEnv, ELECTRON_RUN_AS_NODE: "1", EMBER_AX_PROVIDER: o.provider, NODE_OPTIONS: undefined },
//     windowsHide: o.windowsHide, firstRequestMs: o.firstRequestMs }
// (keys whose value is undefined are deleted from env, not passed as "undefined")
```

### 2.2 `app/shared/shortcuts.ts` (normative; owner P1-C)

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
  /** Keys Ember presses itself in the worker. linux/win32: today's exact strings (tests pin them). */
  readonly edit: { readonly selectAll: string; readonly paste: string; readonly textEnd: string; readonly sheetHome: string; readonly nameBox: string };
  /** Canonical combinations only the user may press, beyond isSystemKey's Linux rules and SHORTCUTS[os] chords. */
  readonly systemKeys: readonly string[];
}

const PRIMARY_CTRL = { mod: "Control_L", primary: "Control_L", cmdorctrl: "Control_L" } as const;

export const KEYS: Readonly<Record<OS, KeyConventions>> = {
  linux: {
    os: "linux", primary: "ctrl", extraModifiers: PRIMARY_CTRL, logoToken: "super",
    logoAliases: /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "super"],
    labels: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super" },
    edit: { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" },
    systemKeys: [],
  },
  win32: {
    os: "win32", primary: "ctrl", extraModifiers: PRIMARY_CTRL, logoToken: "super",
    logoAliases: /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "super"],
    labels: { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Win" },
    edit: { selectAll: "ctrl+a", paste: "ctrl+v", textEnd: "ctrl+End", sheetHome: "ctrl+Home", nameBox: "ctrl+shift+F5" },
    // Start menu (then a typed program name), Task Manager, window switching and the window menu.
    systemKeys: ["ctrl+escape", "ctrl+shift+escape", "alt+tab", "alt+shift+tab", "alt+escape", "alt+space"],
  },
  darwin: {
    os: "darwin", primary: "cmd",
    extraModifiers: { mod: "Super_L", primary: "Super_L", cmdorctrl: "Super_L", cmd: "Super_L", command: "Super_L", option: "Alt_L", opt: "Alt_L" },
    logoToken: "cmd", logoAliases: /^\s*(win|windows|logo|mod4)\s*$/i, modifierOrder: ["ctrl", "alt", "shift", "cmd"],
    labels: { ctrl: "Control", alt: "Option", shift: "Shift", cmd: "Cmd" },
    // Cocoa text: ⌘↓ is the end of the document; LibreOffice for Mac: ⌘Home and ⌘⇧F5 (verify in CI).
    edit: { selectAll: "cmd+a", paste: "cmd+v", textEnd: "cmd+Down", sheetHome: "cmd+Home", nameBox: "cmd+shift+F5" },
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

### 2.3 `app/shared/words.ts` (normative; owner P1-C)

```ts
/** User-facing words that differ per OS (persona, tool descriptions, perception notes, copy). Linux values are today's text. */
import type { OS } from "./shortcuts";

export interface PlatformWords {
  /** persona.ts IDENTITY: "…on their ${desktop}." */
  readonly desktop: string;
  /** worker-persona.ts WORKER_IDENTITY / GUIDE_IDENTITY: "…in the user's real ${apps}…". */
  readonly apps: string;
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
}

export const PLATFORM_WORDS: Readonly<Record<OS, PlatformWords>> = {
  linux: {
    desktop: "Linux desktop (RHEL, GNOME)", apps: "Linux desktop applications (RHEL, GNOME)", fileManager: "Files",
    settingsApp: "Settings", openAppExamples: "Text Editor, Files, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
    fileDialogPathHint: "in a file dialog press Ctrl+L (or use its name field) and type the file's name",
    noScreen: "no X11 display or accessibility service", reinstall: "Reinstall Ember (sudo dnf reinstall ember).",
    shellUnchecked: "GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "the Activities overview or the window switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "No keyring is available", micIndicator: "GNOME shows a microphone icon while Ember listens.",
  },
  win32: {
    desktop: "Windows PC", apps: "Windows applications", fileManager: "File Explorer", settingsApp: "Settings",
    openAppExamples: "Notepad, File Explorer, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
    fileDialogPathHint: "in a file dialog type the file's full path in the File name box",
    noScreen: "the accessibility helper isn't running", reinstall: "Reinstall Ember.",
    shellUnchecked: "Windows didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "Task View or the window switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "Windows couldn't protect the sign-in on this computer",
    micIndicator: "Windows shows a microphone icon in the taskbar while Ember listens.",
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
  },
};
```

### 2.4 The primary modifier in policy, borrow and worker (owner P1-C)

One canonical policy token `mod`, resolved per OS (C2 resolved this way; worker-host-desk §11's "ctrl stays primary"
is rejected). Everything below takes a `KeyConventions` argument that **defaults to `KEYS.linux`**, so every existing
call and test keeps today's result.

**`hands/borrow.ts`**
- `parseCombo(combo: string, kc: KeyConventions = KEYS.linux)`: the modifier lookup is
  `MODIFIERS[m.toLowerCase()] ?? kc.extraModifiers[m.toLowerCase()]` (today's MODIFIERS first). On darwin
  `cmd+s` → `Super_L` + `s` (the macOS backend presses ⌘ for Super_L); `ctrl+a` → real Control. `canonicalCombo`
  gets the same parameter (MODIFIER_KEYS maps `super_l/r`, `meta_l/r` to `kc.logoToken`; order `kc.modifierOrder`).
- `CursorBorrowOptions` gains `keys?: KeyConventions`; `hand.keys(combo)` calls `parseCombo(combo, this.keys)`.
- `glideTo` bounds: `const ok = x.onScreen ? x.onScreen(tx, ty) : (tx >= 0 && ty >= 0 && tx < screen.width && ty < screen.height);`
- `planText`: before the layout branch, `if (x.textKey) { … every char → { code: x.textKey(ch) || throw the same "can't type" error, sym: keysymForChar(ch), shift: false } …; byCode: true, shift: 0 }`.
- `check()`: the pointer counts as Ember's when within TOLERANCE of `expected` **or of the previous `expected`**
  (macOS posts asynchronously; one step behind is not the user). Linux pointers are synchronous, so nothing changes.
- Before activating the target: `const why = x.blockedReason?.(o.window ?? 0); if (o.window && why) throw new Error(why);`

**`policy/policy.ts`**
- `canonicalKeys(keys, kc = KEYS.linux)`: maps `kc.logoAliases` tokens to `kc.logoToken`, parses with
  `parseCombo(…, kc)`, maps modifier keysyms with today's MODIFIER_NAMES except `super|meta|hyper|mod4` →
  `kc.logoToken`, and orders by `kc.modifierOrder`. Linux results are unchanged (`"cmd+space"` → `"super+space"`,
  as `policy.test.ts:228` pins).
- `isSystemKey(k, kc = KEYS.linux)`: today's body, except the logo rule applies only when `kc.logoToken === "super"`;
  then `|| SHORTCUTS[kc.os]` chords contain `keyFamily(k)` `|| kc.systemKeys.includes(keyFamily(k))`. On Linux the
  extra checks add nothing (the Ctrl+Alt regex already covers Ember's chords).
- Key tables are built per OS, lazily and memoised, from templates where `mod` means the primary:
  `SAFE_COMBOS = ["mod+a","mod+c","mod+x","mod+v","mod+z","mod+y","mod+shift+z","mod+b","mod+i","mod+u","mod+f","mod+g","mod+h","mod+s","mod+shift+s","mod+n","mod+t","mod+l","mod+o","mod+home","mod+end","mod+left","mod+right","mod+up","mod+down","mod+shift+left","mod+shift+right","mod+shift+home","mod+shift+end","mod+backspace","mod+plus","mod+minus","mod+equal","mod+0","mod+tab","mod+shift+tab","mod+prior","mod+next","mod+pageup","mod+pagedown"]`
  (darwin adds `"alt+left","alt+right","alt+shift+left","alt+shift+right","cmd+up","cmd+down","cmd+shift+up","cmd+shift+down"`),
  `DESTRUCTIVE_KEYS = ["delete","shift+delete","mod+delete","mod+shift+delete","mod+return","alt+return","mod+shift+return","alt+f4","mod+q","mod+w","mod+shift+w","mod+shift+q"]`
  (darwin adds `"cmd+backspace","shift+cmd+backspace","alt+shift+cmd+backspace","alt+cmd+w","alt+cmd+q"`),
  `PASTE_KEYS = ["mod+v","mod+shift+v","shift+insert"]` (darwin adds `"alt+shift+cmd+v"`). Each entry is
  canonicalised with `canonicalKeys(entry, kc)`. On linux and win32 the sets equal today's.
- Every regex that means "the primary" is built from `kc.primary` (P): `REMOVES = ^((shift|P|P\+shift)\+)?(delete|backspace)$|^P\+x$`,
  `replacesSelection`'s `P\+x|shift\+delete|P\+(shift\+)?(backspace|delete)`, `takesSelected`'s `k === "P+x"`. The
  "a shortcut Ember can't judge" test (policy.ts:1759) and `typesCharacter` use `(ctrl|alt|super|cmd)\+` on every OS
  (no Linux combination contains `cmd`, so Linux is unchanged). `ACTIVATE_KEY`'s `ctrl+m`/`ctrl+j` stay literal
  (they are real Control line feeds on every OS).
- `keyLabel(keys, kc = KEYS.linux)` uses `{ ...KEY_LABELS, ...kc.labels }`. The "(Ctrl+A)" wording
  (policy.ts:1354, 1355, 1409) becomes `keyLabel(kc.edit.selectAll, kc)` → "Ctrl+A" on Linux, "Cmd+A" on macOS.
- `PolicyEngineOptions` gains `keys?: KeyConventions` and `os?: OS`; every internal call passes `this.keys`.
- `isSecurityWindow(w, os: OS = "linux")`: `SECURITY_APP`/`SECURITY_TITLE` become per-OS tables (§9.5) whose
  Linux entries are today's regexes, unchanged. `TABBED_APP`, `WEB_APP`, `OFFICE_APP`, `RISKY` additions and
  `RUNS_PROGRAM`/`RUN_FILE_DIALOG` additions likewise (§9.5).

**`agent/worker.ts`**: `this.keys = d.system.keys`. The hard-coded strings become `kc.edit.selectAll`, `"Delete"`,
`kc.edit.textEnd`, `kc.edit.paste` (cursorAct, worker.ts:1952-1962), `kc.edit.sheetHome` (fillCell, :2389),
`kc.edit.nameBox` (toCellByName, :2555). `afterKeys`' `k === "ctrl+a"` (:463) becomes
`k === canonicalKeys(kc.edit.selectAll, kc)`; the `canonicalKeys`/`keyFamily` calls at :461, :483, :519 pass `kc`.
The press_keys description uses `words.keyExamples`. Linux keystrokes are identical (`worker-safety.test.ts:349`
expects `["ctrl+a", "Delete", "ctrl+v"]`).

**Hotkeys** (`hotkey.ts`): no logic change. `freshAskPress(chord, at, last)` already trusts a `null` chord; main passes
`ws?.keysDown() ?? null`, which is `null` on win32/darwin (G6 resolved). Only the doc comments change.

**Invariant tests** (P1-C, `test/unit/shortcuts.test.ts`): for each OS, every `SHORTCUTS[os][id].chord` equals
`canonicalKeys(accelAsCombo, KEYS[os])` (accelerator → combo: `Control`→`ctrl`, `Command`→`cmd`, `Super`→`super`,
`+` kept) and `isSystemKey(chord, KEYS[os])` is true; `KEYS.linux.edit` equals today's strings; on darwin
`canonicalKeys("cmd+s") === "cmd+s"`, `isSystemKey("cmd+s")` is false, `isSystemKey("cmd+space")` true,
`DESTRUCTIVE` has `cmd+q`; on win32 `isSystemKey("super+r")` and `isSystemKey("ctrl+shift+escape")` are true.

