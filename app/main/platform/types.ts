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
import type { UtilityFork } from "../perception/sidecar";
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
   * Absent on Linux, where GNOME Shell's own dialogs come from the sidecar's shell_overlays, except in a Wayland
   * session: always true there (XWayland shows Ember only X11 apps, review #240). Perception ORs it with
   * shell_overlays.
   */
  systemDialogOpen?(): boolean;
  /**
   * (Added by the release fixes; optional.) Why systemDialogOpen() is true when the cause is a state the user can turn
   * off rather than a dialog (macOS: secure keyboard entry on in an app, and no system prompt on screen; Linux: a
   * Wayland session), as a clause
   * that starts in lower case, has no full stop and says what Ember holds back ("secure keyboard entry is on in
   * Terminal …, so Ember won't look at the screen or use the mouse or keyboard until it's off"). null when it is a
   * dialog, when nothing is up, or when it can't be told: the dialog's words stay. Only words: systemDialogOpen()
   * alone decides.
   */
  systemDialogReason?(): string | null;
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
export type PerceptionWindows = Pick<WindowSystem, "activeWindow" | "focusWindow" | "clientWindows" | "stack" | "capture" | "systemDialogOpen" | "systemDialogReason">;

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

/** The part of Electron's desktopCapturer the macOS capture uses. */
export interface DesktopCapturerLike {
  getSources(o: { types: ("screen" | "window")[]; thumbnailSize?: { width: number; height: number }; fetchWindowIcons?: boolean }):
    Promise<{ id: string; name: string; display_id: string; thumbnail: NativeImageLike }[]>;
}

/** What Electron's app.getLoginItemSettings() answers, as far as autostart reads it. */
export interface LoginItemSettingsLike {
  openAtLogin: boolean;
  /** darwin. */ wasOpenedAtLogin?: boolean;
  /** darwin: "not-registered" | "enabled" | "requires-approval" | "not-found". */ status?: string;
  /** win32. */ executableWillLaunchAtLogin?: boolean;
  /** win32. */ launchItems?: { name: string; path: string; args: string[]; enabled: boolean }[];
}

/** The part of Electron's app the compositions and system modules use. */
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
  /** The user's preferred languages, most preferred first ("de-DE"): the macOS app catalogue's localized names. */
  getPreferredSystemLanguages?(): string[];
}

/** The part of Electron's systemPreferences the permission checks and probes use (some members exist on one OS only). */
export interface SystemPreferencesLike {
  getMediaAccessStatus?(t: "microphone" | "camera" | "screen"): "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  askForMediaAccess?(t: "microphone" | "camera"): Promise<boolean>;
  isTrustedAccessibilityClient?(prompt: boolean): boolean;
  getAnimationSettings(): { prefersReducedMotion: boolean };
}

/** The part of Electron's shell the fixes and the lifecycle use. */
export interface ShellLike {
  openExternal(url: string): Promise<void>;
  /** win32 only. */ writeShortcutLink?(p: string, op: "create" | "update" | "replace", o: { target: string; args?: string; appUserModelId?: string; description?: string }): boolean;
}

/** The part of Electron's powerMonitor the macOS lifecycle uses (the session ends without will-quit). */
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
  /**
   * Electron's utilityProcess: darwin starts the accessibility host with its fork (review #177: no node mode there).
   * Only used after app ready.
   */
  utilityProcess?: { fork: UtilityFork };
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
  /** process.execPath (Ember's own binary: on Windows the sidecar host runs as it, ELECTRON_RUN_AS_NODE=1). */
  execPath: string;
  appPath: string;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
}

// ───────────── Overlay and Ember's floating windows ─────────────

/** Ember's floating windows, each of which takes its window options from the overlay shaper. */
export type FloatingKind = "overlay" | "handle" | "ask" | "desk-view";

/** How one kind of floating window is created on this OS. */
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

/** Click-through for Ember's floating windows: a real input region (Linux XShape) or hover polling (Windows, macOS). */
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

/** Where Ember runs from, for building the accessibility helper's launch. */
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
  /** darwin: fork `args[0]` as an Electron utility process instead of spawning `command` (review #177). */
  utility?: { fork: UtilityFork; serviceName: string };
}

// ───────────── System integration ─────────────

/**
 * What the terminal and shell checks look at: DesktopApp's identity (hands/system.ts; `argv`/`programs` are the
 * type-only members step 0 adds) plus, for a window, its Win32 class (Windows console hosts, §9.11).
 */
export type AppIdentity = Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "categories" | "terminal">> & { argv?: string[]; windowClass?: string };

/** Installed apps: listing, finding and launching them, and the terminal and shell checks. */
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

/** The tier-0 comfort settings this OS can change (hands/system.ts SETTINGS names). */
export interface SystemSettings {
  /** name → description for the model. Only names this OS really changes and reads back; empty → no change_setting tool. */
  readonly available: Partial<Record<SettingName, string>>;
  /** Sets, reads back and returns the decoded before/after; throws an Error in plain words. */
  change(name: SettingName, value: string): Promise<{ before: string; after: string }>;
}

/** Where Ember keeps its data and finds the Copilot runtime on this OS. */
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

/** Where the administrator's policy and the provider API key come from on this OS (fails closed). */
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

/** Starting Ember at login. */
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

/** What the setup checks learn from the running app, beyond what the OS reports. */
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

/** What the doctor (`ember --doctor`) probes on this OS. */
export interface PlatformDoctorProbes {
  /** Microphone sources (linux: pactl), null when they can't be listed. */
  microphones: string[] | null;
  /** linux: speech-dispatcher is there; win32/darwin: true (Chromium uses the system's voices). */
  speechDispatcher: boolean;
  /** Linux only; null elsewhere (the check is left out). appImage: running as an AppImage, which has no setuid helper. */
  sandbox: { userNamespaces: boolean; suidHelper: boolean; appImage?: boolean } | null;
  /** Linux only (inotify); null elsewhere. */
  fileWatchers: { used: number; max: number } | null;
  /** Linux only (DeskManager.available()); null elsewhere. */
  desk: { ok: boolean; missing: string[] } | null;
  /** win32/darwin rows in doctor wording (permissions, PowerShell language mode, elevation, location). linux: []. */
  extra: PlatformDoctorRow[];
}

/** Accessibility preferences the OS reports. */
export interface A11yProbes {
  /** A real screen reader runs. linux: GNOME screen-reader-enabled (cached 60 s) || app.isAccessibilitySupportEnabled() (today); win32: SPI_GETSCREENREADER; darwin: VoiceOver. */
  screenReaderOn(): boolean;
  /** The OS asks for less motion. linux: gsettings enable-animations false (today); win32/darwin: systemPreferences.getAnimationSettings().prefersReducedMotion. */
  systemReducedMotion(): boolean;
}

/** The OS-specific parts of voice input. */
export interface VoicePlatform {
  /** Linux only true (parec speaker rejection); win32/darwin false, and the setting and consent copy say so. */
  readonly speakerMonitor: boolean;
  /** Folders a bundled copy of the models may be in, in order (linux: /usr/share/ember/voice-models, then resources/voice-models). */
  bundledModelDirs(resourcesPath: string): string[];
}

/** This OS's privacy vocabulary: never-look defaults and security windows. */
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

/** How the app's lifecycle differs per OS (toasts, menu, reopening, session end, activation). */
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

/** Every OS-specific piece beside the window system and input: words, keys, paths, apps, settings, policy and the rest. */
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

/** The desk (tier 2, a private Xvfb display): Linux only (D5); Platform.desk is null elsewhere. */
export interface DeskFactory {
  available(): { ok: boolean; missing: string[] };
  create(log: Logger, o: { env?: NodeJS.ProcessEnv }): DeskManager;
  openPlace(desk: DeskManager, o: { sidecarScript: string; log: Logger; neverLook: () => string[]; profiles: string; userInControl?: () => boolean }): Promise<DeskPlace>;
}

// ───────────── The platform object ─────────────

/** The platform object loadPlatform() returns: one per process, chosen by process.platform alone. */
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
