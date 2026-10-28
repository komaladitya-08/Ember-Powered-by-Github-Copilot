/**
 * Ember main process: single instance, settings, logging, environment checks,
 * the windows (home, overlay, handle, ask box), the Copilot brain, perception,
 * hands and voice, and the wiring between them.
 *
 * Everything that differs per OS comes from one Platform object (platform/index.ts,
 * chosen by the OS alone, never by $DISPLAY): the window system and input, overlay shaping,
 * the accessibility helper's launch, the desk and the system integration. This file
 * never tests the OS itself; it asks the platform's members.
 */

import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, net, Notification, powerMonitor, safeStorage, screen, session, shell, systemPreferences, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createLogger, type LogLevel } from "./logger";
import { SettingsStore, hasConsent, type SettingsPatch } from "./settings";
import { commandMode, managedKeys } from "./admin";
import { inspectEnvironment, type EnvReport } from "./environment";
import { createCommandWindow, createHomeWindow, createPromptWindow, isTrustedSender, quitQuestion, settingsFromHome } from "./windows";
import { IPC, type Status, type SignInProgress, type AskContext } from "../shared/ipc";
import { OVERLAY, IDLE_BUBBLE, type EmberState, type Rect } from "../shared/overlay";
import { OverlayManager } from "./overlay";
import { HandleWindow } from "./handle";
import { revive } from "./revive";
import { friendlyApp, useAppNames } from "../shared/apps";
import { AtspiSidecar } from "./perception/sidecar";
import { isNeverLook } from "./perception/elements";
import { Perception, type QuickContext } from "./perception";
import { AskWindow } from "./ask";
import { VoiceService, voicePermissions } from "./voice";
import type { VoiceEvent } from "../voice/engine";
import { VOICE_MODELS_BYTES, modelsReady } from "../voice/models";
import { doctorChecks, formatDoctor, type DoctorProbes } from "./doctor";
import { AuditLog } from "./policy/audit";
import { KillSwitch } from "./agent/killswitch";
import { PolicyEngine } from "./policy/policy";
import { remoteSurfaceCheck } from "./policy/remote-surface";
import { Confirmer, guardWhileAsking } from "./agent/confirm";
import { CursorBorrow } from "./hands/borrow";
import { isTerminalWindowApp } from "./hands/system";
import { freshAskPress } from "./hotkey";
import type { DeskPlace } from "./desk/place";
import { DeskView } from "./desk/view";
import { AgentHost, explainStartError, gitHubReachable, idleWord, type Hands } from "./agent/host";
import { expandedBubble } from "./agent/presenter";
import { electronClipboard } from "./agent/clipboard";
import { locateRuntime } from "./agent/runtime";
import { TokenStore, resolveToken, startDeviceFlow, pollDeviceFlow } from "./agent/auth";
import { endsWithQuestion, spokenText } from "../voice/spoken";
import { readAgentState } from "./agent/conductor";
import { loadPlatform } from "./platform";
import { primaryScaledUnion, toHelperStatus } from "./platform/compose";
import type { HelperStatus, Input, OwnWindowHandle, SidecarContext, WindowSystem } from "./platform/types";
import { extraBinDirs } from "./platform/darwin/system";
import { deskProcesses } from "./desk/desk";
import { createTargets, targetDoctorRows, wslSwitchOn, type TargetsRuntimeExtra } from "./targets/runtime";
import { afterTargetFix, applySetupFix, targetChecksSource, withTargetChecks } from "./targets/setup-check";
import type { IpcLike, MenuItemLike, TargetsRuntime } from "./targets/types";
import { wrapForWsl } from "./wsl/routed-sidecar";
import { wrapWindowsForWsl } from "./wsl/routed-windows";
import { wslAwarePrivacy, wslAwareSystem } from "./wsl/privacy";
import type { Question } from "./agent/confirm";
import { afterFix, type FixId } from "./environment";
import { settingsSection, setupIdle } from "../shared/setup-attention";
import { hello } from "./hello";

/**
 * Switches for tests and demos (a fake model server, test hooks, another policy
 * file…) work only in development: an installed Ember ignores them, so no one can
 * point it at another endpoint or around the administrator's policy.
 */
const devEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name]);

// An installed Ember never opens a debugging port (anyone on the machine could drive it through one).
// (Chromium also takes these with a single dash, and hasSwitch() sees every spelling it accepts.)
const debugSwitch = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "inspect", "inspect-brk", "inspect-port"]
  .some(name => app.commandLine.hasSwitch(name)) || process.argv.some(a => /^--?(remote-debugging-[a-z-]+|inspect(-brk|-port)?)\b/.test(a));
if (app.isPackaged && debugSwitch) {
  process.stderr.write("Ember doesn't start with debugging switches.\n");
  app.exit(2);
}

/**
 * This OS's pieces. Made before ready: building it touches nothing of Electron's `screen` and calls no app.getPath
 * (PlatformDeps' rule); its window system and input open after ready.
 */
const platform = loadPlatform({
  electron: { app, screen, desktopCapturer, systemPreferences, shell, powerMonitor, browserWindow: BrowserWindow },
  packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: process.env,
});
const sys = platform.system;
useAppNames(platform.os);

// Linux: Chromium speaks (speechSynthesis) only through speech-dispatcher, and only with this switch.
for (const s of sys.chromiumSwitches) app.commandLine.appendSwitch(s);

// ~/.config/ember on Linux unless overridden (tests use a temp dir).
app.setName("ember");
app.setPath("userData", process.env.EMBER_USER_DATA ?? sys.paths.userData(app.getPath("appData"), app.getPath("home")));
// Windows toasts need the app's AppUserModelId, set before ready.
if (sys.lifecycle.appUserModelId) app.setAppUserModelId(sys.lifecycle.appUserModelId);
const userData = app.getPath("userData");
// Private: settings, logs and the audit trail mention the user's apps and windows.
try { fs.mkdirSync(userData, { recursive: true, mode: 0o700 }); fs.chmodSync(userData, 0o700); } catch { /* reported when used */ }

const log = createLogger({
  dir: path.join(userData, "logs"),
  level: (process.env.EMBER_LOG_LEVEL as LogLevel | undefined) ?? "info",
  // `ember doctor` prints a report; log lines would get in its way.
  stdout: !process.argv.includes("--doctor") && (process.env.EMBER_LOG_STDOUT === "1" || !app.isPackaged),
});

process.on("uncaughtException", err => log.error("uncaught exception", { err }));
process.on("unhandledRejection", reason => log.error("unhandled rejection", { reason }));

/** Ember could not start: say so plainly and exit, so the single-instance lock isn't held by a hidden Ember. */
function startupFailed(err: unknown): void {
  log.error("app.start_failed", { err });
  const message = err instanceof Error ? err.message : String(err);
  void app.whenReady().then(() => {
    // A dialog with no parent window comes up in front only once Ember is the active app (macOS).
    sys.lifecycle.focusOwnApp();
    dialog.showErrorBox("Ember couldn't start", `${message}\n\nThe details are in ${log.file}.`);
    app.exit(1);
  });
}

/**
 * Told the setup rows at each read (readEnvironment), once Ember runs: its handle's "Setup needed" follows them (review
 * #95). Declared before start() runs below, which sets it.
 */
let onSetupRead: ((checks: EnvReport["checks"]) => void) | null = null;

if (process.argv.includes("--doctor")) {
  // A check-up, not a second Ember: runs even while Ember is running.
  void runDoctor();
} else if (!app.requestSingleInstanceLock()) {
  log.info("instance.handover", { pid: process.pid });
  app.quit();
} else {
  try {
    start();
  } catch (err) {
    startupFailed(err);
  }
}

/** What openWindows() returned (undefined until it has run), and which of Ember's shortcuts another app holds. */
let wsState: WindowSystem | null | undefined;
let shortcutsTaken: string[] | undefined;
/** The shared accessibility host's status (Windows, macOS): undefined until asked, null when it didn't answer. */
let helper: HelperStatus | null | undefined;

/** The setup-check fixes the user applied while Ember runs (some rows then say what comes next, review #98). */
let fixesApplied: readonly FixId[] = [];
/** Whether Ember's spoken replies are heard: null until it has tried, false when no voice spoke (review #101). */
let speechHeard: boolean | null = null;

/** The setup checks: what this OS reports, plus what the running app has learnt (its display, shortcuts, helper, fixes). */
function readEnvironment(): EnvReport {
  const report = inspectEnvironment({ ...sys.environment({ windows: wsState, shortcutsTaken, helper }), applied: fixesApplied, speech: speechHeard });
  onSetupRead?.(report.checks);
  return report;
}

/**
 * Speech models installed with Ember (the ember-voice-models package, which puts them in "/usr/share/ember/voice-models"
 * on Linux; sys.voice says where on each OS) are used in place of a download.
 */
function voiceModelsRoot(): { root: string; bundled: boolean } {
  const bundled = [devEnv("EMBER_VOICE_MODELS"), ...sys.voice.bundledModelDirs(process.resourcesPath ?? "")]
    .find((d): d is string => !!d && modelsReady(d));
  return bundled ? { root: bundled, bundled: true } : { root: path.join(userData, "models"), bundled: false };
}

/** How gh is run to find a GitHub CLI sign-in on this OS (its path, no console window on Windows). */
const ghOptions = () => ({ path: sys.ghCliPath() ?? undefined, spawn: sys.spawnDefaults });

// Packaged builds ship the sidecar under resources/; development runs it from the repo.
const sidecarScript = () => app.isPackaged
  ? path.join(process.resourcesPath, "sidecar", "atspi", "ember_atspi.py")
  : path.join(app.getAppPath(), "sidecar", "atspi", "ember_atspi.py");

/** Where Ember runs from, for the accessibility helper's launch (main.cjs's folder holds ax-sidecar.cjs). */
const sidecarContext = (): SidecarContext => ({
  appDir: __dirname, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged, userData, execPath: process.execPath,
});

/**
 * The doctor's "Accessibility helper" row (Windows, macOS): the shared host started once, asked for its status within
 * its cold-start time, and stopped. undefined on Linux, where nothing is started (the Python sidecar starts on demand).
 */
async function doctorHelper(): Promise<HelperStatus | null | undefined> {
  const launch = platform.sidecarLaunch(sidecarContext());
  if (!launch) return undefined;
  const sidecar = new AtspiSidecar(sidecarScript(), log.child("atspi"), undefined, undefined, launch);
  let timer: NodeJS.Timeout | undefined;
  try {
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("no answer")), (launch.firstRequestMs ?? 5000) + 1000); });
    return toHelperStatus(await Promise.race([sidecar.status(), late]));
  } catch (err) {
    log.warn("doctor.helper_unavailable", { err });
    return null;
  } finally {
    clearTimeout(timer);
    sidecar.stop();
  }
}

/** The user's settings file as it is on disk (the doctor only reads it), or null. */
function settingsText(): string | null {
  try {
    return fs.readFileSync(path.join(userData, "settings.json"), "utf8");
  } catch {
    return null; // none yet: defaults, WSL off
  }
}

async function runDoctor(): Promise<void> {
  await app.whenReady();
  const ws = wsState = platform.openWindows(log);
  helper = await doctorHelper();
  const env = readEnvironment();
  // The doctor never logged xtest.unavailable: no logger.
  const input = platform.openInput(ws, null);
  const admin = sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY"));
  const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: app.isPackaged ? {} : process.env, runtimeId: sys.paths.runtimeId, exe: sys.paths.runtimeExe });
  let auth: DoctorProbes["auth"] = null;
  if (admin.policy.provider) auth = { kind: "provider", host: new URL(admin.policy.provider.baseUrl).host };
  else {
    const t = await resolveToken(new TokenStore(path.join(userData, "github-token.bin"), safeStorage), process.env, ghOptions()).catch(() => null);
    // After "Sign out" in Ember, a GitHub CLI or environment sign-in isn't used (as Ember itself does).
    const ignored = !!t && (t.source === "environment" || t.source === "github-cli") && readAgentState(path.join(userData, "agent.json")).signedOut;
    if (t && !ignored) auth = { kind: "github", source: t.source };
  }
  const models = voiceModelsRoot();
  const probes = await sys.doctorProbes();
  // Input that can't reach apps counts as missing. Asked about the window the user is in, not window 0: macOS answers
  // for every window at once (the Accessibility permission, secure input), while Windows refuses a window it can't
  // check, and 0 is never one, so every Windows check-up would say input was missing. Linux has no such question.
  const blocked = ws && input?.blockedReason ? input.blockedReason(ws.activeWindow()?.id ?? 0) : null;
  const checks = doctorChecks({
    os: platform.os, helper, env, compositor: ws ? ws.hasCompositor() : null,
    xtest: ws ? !!input && !blocked : null,
    speechDispatcher: probes.speechDispatcher, microphones: probes.microphones,
    voiceModels: models.bundled ? "bundled" : modelsReady(models.root) ? "downloaded" : "missing",
    runtime: runtime.exists, auth, admin, desk: probes.desk, sandbox: probes.sandbox, fileWatchers: probes.fileWatchers,
    // The SSH client, WSL, the command window's terminal and the remote parts (§8.8).
    extra: [...(probes.extra ?? []), ...(await targetDoctorRows({ os: platform.os, sys, admin: () => admin, resourcesPath: process.resourcesPath, packaged: app.isPackaged, wslOn: wslSwitchOn(settingsText()) }))],
    shortcuts: sys.shortcuts, words: sys.words, policyLocation: sys.adminPolicy.location,
  });
  process.stdout.write(`Ember ${app.getVersion()} check-up\n\n${formatDoctor(checks)}\n`);
  input?.close();
  ws?.close();
  app.exit(checks.some(c => c.status === "fail") ? 1 : 0);
}

function start(): void {
  // The administrator's policy (/etc/ember/policy.json on Linux) overrides the user's settings.
  const admin = sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY"));
  if (admin.error) log.error("admin_policy.invalid", { error: admin.error, note: "locked down until it is fixed" });
  else if (admin.source) log.info("admin_policy.loaded", { file: admin.source });
  const policy = admin.policy;
  // Windows: antivirus and sync tools briefly lock a file being replaced, so the save tries again.
  const settings = new SettingsStore(path.join(userData, "settings.json"), policy, { renameRetries: sys.paths.renameRetries });
  const loaded = settings.load();
  if (loaded.recoveredFrom) log.warn("settings.recovered", { backup: loaded.recoveredFrom });
  // Edits made by hand (never-look list, grants) are picked up while Ember runs.
  const unwatch = settings.watch();
  /** What went wrong with settings.json (shown in the settings window until the file reads fine). */
  let settingsNotice: string | null = settings.lastProblem;
  settings.onProblem(problem => {
    settingsNotice = problem;
    if (problem) log.warn("settings.hand_edit", { detail: problem });
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.settingsNotice, problem);
  });
  app.on("will-quit", () => { unwatch(); try { settings.flush(); } catch (err) { log.warn("settings.not_saved", { err }); } });

  let home: BrowserWindow | null = null;
  /** One of Ember's own windows in the window system's id space (0 when there is none, or it can't be told). */
  const ownId = (win: OwnWindowHandle): number => {
    try { return wsRef?.windowId(win) ?? 0; } catch { return 0; }
  };
  /**
   * One of Ember's own windows comes to the front with the keyboard. A window manager that prevents focus stealing
   * (xfwm4, Mutter) keeps a window Ember opens from its overlay or a hotkey behind the user's app otherwise: Ember asks
   * as a pager does (a direct user action), which they honour. Windows' foreground rules need the input backend too;
   * on macOS Ember activates itself (an AX call into its own process would wait for its own main thread).
   */
  const bringToFront = (win: BrowserWindow) => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    sys.lifecycle.focusOwnApp();
    if (sys.lifecycle.activateOwnWithInput) {
      const id = ownId(win);
      // Best effort, as it always was: the window is shown and focused either way.
      try { if (id) inputRef?.activate(id); } catch { /* the window manager wasn't asked */ }
    }
  };
  const showHome = () => {
    // A bubble that only points to settings (a greeting, "Read all") goes: settings has it now. An expanded answer's
    // pinned hold goes with it, as Close ends it (no timer would, and the tasks' bubbles would wait behind it).
    if (lastState.bubble.visible && lastState.bubble.actions.length && lastState.bubble.actions.every(a => a.id.startsWith("ui:"))) {
      setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
      agent?.releasePin(lastState.bubble);
    }
    if (home && !home.isDestroyed()) {
      if (home.isMinimized()) home.restore();
      bringToFront(home);
      return;
    }
    home = createHomeWindow();
    home.once("ready-to-show", () => log.info("window.home.shown"));
    // A crashed settings page comes back (it may be the consent page on first run).
    revive(home, reason => log.warn("window.home.renderer_gone", { reason }));
    // While the user works in settings, Ember waits beside the window instead of over it.
    for (const e of ["focus", "blur", "move", "resize", "minimize", "restore", "hide", "show"] as const) home.on(e as "focus", stepAside);
    // Minimised or hidden, the page stops drawing its characters (X11 still reports it visible).
    const win = home;
    win.once("show", () => bringToFront(win));
    const shown = (on: boolean) => () => { if (!win.isDestroyed()) win.webContents.send(IPC.homeVisibility, on); };
    win.on("minimize", shown(false)); win.on("hide", shown(false)); win.on("restore", shown(true)); win.on("show", shown(true));
    home.on("closed", () => {
      home = null;
      stepAside();
      if (greetOnClose) { greetOnClose = false; setTimeout(() => greet(), 300); }
    });
  };
  /** Ember greets once settings closes (first run while Copilot isn't connected yet). */
  let greetOnClose = false;
  const stepAside = () => {
    const h = home && !home.isDestroyed() && home.isVisible() && !home.isMinimized() && home.isFocused() ? home : null;
    const r = h ? h.getBounds() : null;
    overlay?.stepAside(r);
    // The bubble keeps off the window too.
    if (JSON.stringify(lastState.avoid ?? []) !== JSON.stringify(r ? [r] : [])) showState({ avoid: r ? [r] : [] });
  };
  const homeOpen = () => !!home && !home.isDestroyed() && home.isVisible() && !home.isMinimized();

  app.on("second-instance", () => {
    log.info("instance.second", {});
    showHome();
  });

  // No page may open windows or navigate away from our bundled files.
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", e => e.preventDefault());
  });

  // These channels change settings, sign in and out, and apply fixes: only the settings window may use them
  // (not the overlay, ask box, desk view or mic page, even though they are Ember's own pages too).
  const guard = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A): R => {
      const url = event.senderFrame?.url ?? "";
      if (!isTrustedSender(url) || !home || home.isDestroyed() || event.sender !== home.webContents) throw new Error(`untrusted IPC sender: ${url}`);
      return fn(...args);
    };

  /** What the settings window says differently on this OS (shortcuts, the data folder, the microphone, fixes). */
  const platformStatus = (): NonNullable<Status["platform"]> => ({
    os: platform.os,
    shortcuts: Object.fromEntries(Object.entries(sys.shortcuts).map(([id, d]) => [id, { label: d.label, keys: d.keys }])) as NonNullable<Status["platform"]>["shortcuts"],
    dataDir: sys.paths.dataDirLabel(userData),
    settingsFile: sys.paths.dataDirLabel(userData, "settings.json"),
    auditCopy: sys.auditCopy(),
    micIndicator: sys.words.micIndicator,
    permissionsNote: sys.words.permissionsNote,
    speakerRejection: sys.voice.speakerMonitor,
    fixLabels: Object.fromEntries(sys.fixes.ids.map(id => [id, sys.fixes.label(id)])),
    desk: !!platform.desk && platform.desk.available().ok,
    autostartNote: sys.autostart.note(),
  });
  // The setup check shows the other computers' and WSL's rows too, as ember --doctor does (§8.8): read through the
  // targets runtime, kept a few seconds, and waited for briefly (the rows from before show while a slow one finishes).
  const targetChecks = targetChecksSource(() => targets?.doctorRows() ?? Promise.resolve([]), { keepMs: 15_000, waitMs: 3000, now: () => Date.now() });
  const environmentNow = async (fresh = false) => withTargetChecks(readEnvironment(), await targetChecks(fresh));
  ipcMain.handle(IPC.getStatus, guard(async (): Promise<Status> => ({
    appVersion: app.getVersion(),
    settings: settings.get(),
    environment: await environmentNow(),
    logFile: log.file,
    settingsNotice,
    admin: { source: admin.source, error: admin.error ?? null, managed: managedKeys(policy), features: policy.features, provider: policy.provider?.baseUrl ?? null,
      confirmEveryAction: policy.confirmEveryAction, allowGrants: policy.allowGrants, retentionDays: policy.auditRetentionDays ?? 30,
      neverLook: policy.neverLook, commands: { local: commandMode(admin, "local"), wsl: commandMode(admin, "wsl"), ssh: commandMode(admin, "ssh") },
      sshHostsLimited: policy.ssh?.allowedHosts !== undefined },
    platform: platformStatus(),
  })));
  ipcMain.handle(IPC.activity, guard(() => audit?.recent(150) ?? []));
  /** The administrator's never-look entries are applied on top; they never go into the user's own list. */
  const ownNeverLook = (patch: SettingsPatch): SettingsPatch => {
    if (!patch.privacy?.neverLook || !policy.neverLook.length) return patch;
    const lower = (x: string) => x.toLowerCase();
    const mine = new Set(settings.own().privacy.neverLook.map(lower));
    const adminOnly = new Set(policy.neverLook.map(lower).filter(x => !mine.has(x)));
    return { ...patch, privacy: { ...patch.privacy, neverLook: patch.privacy.neverLook.filter(x => !adminOnly.has(lower(x))) } };
  };
  // Dragging the size slider sends a change per step: shown at once, saved a moment later.
  ipcMain.handle(IPC.updateSettings, guard((sent: SettingsPatch) => {
    // Where Ember works and what commands may do change only behind their consent cards (TARGETS_IPC), never here.
    const { patch, dropped } = settingsFromHome(sent);
    if (dropped.length) log.warn("settings.update_refused", { keys: dropped });
    const sizeOnly = !!patch && typeof patch === "object" && Object.keys(patch).length === 1 && "size" in patch;
    return settings.update(ownNeverLook(patch), { soon: sizeOnly });
  }));
  // Only the fixes this OS offers (Linux: turning on GNOME's accessibility switch), and the targets runtime's
  // wsl-a11y:<distro> (§8.8); any other id is refused before anything runs.
  ipcMain.handle(IPC.applyFix, guard(async (fix: string) => {
    const t = targets;
    const done = await applySetupFix(fix, { osFixes: sys.fixes.ids, applyOs: id => sys.fixes.apply(id), applyTarget: t ? id => t.applyFix(id) : null });
    log.info("fix.applied", { fix: done ? "wsl-a11y" : fix });
    if (!done) fixesApplied = afterFix(fixesApplied, fix as FixId);
    const env = await environmentNow(true);
    return done ? afterTargetFix(env, done.target, done.message) : env;
  }));
  settings.onChange(s => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.settingsChanged, s);
  });

  // Ember keeps running without windows: the overlay and handle are its presence.
  app.on("window-all-closed", () => { /* stay alive */ });

  let overlay: OverlayManager | null = null;
  let handle: HandleWindow | null = null;
  let greetTimer: NodeJS.Timeout | null = null;

  // The handle says Ready only once Copilot is connected.
  let lastState: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null, idle: "Not connected" };
  let confirmer: Confirmer | null = null;
  // While the user works on Ember's desk, the task cards stay out of the enlarged view's way.
  let deskInControl = false;
  const showState = (next: Partial<EmberState>) => {
    lastState = { ...lastState, ...next };
    // Shown just for an answer the user asked for while Ember was hidden: hidden again once it's read.
    if (shownForAnswer && next.bubble && !next.bubble.visible) { shownForAnswer = false; keptHidden = true; overlay?.setHidden(true); }
    overlay?.setState(deskInControl && next.tasks ? { ...next, tasks: [] } : next);
    handle?.sendState(lastState);
  };
  // While Ember is asking the user something, nothing else may replace the question
  // (a worker's reasoning would otherwise wipe the buttons before they're clicked).
  const setState = guardWhileAsking(() => confirmer?.waiting ?? false, showState);
  /** The setup rows as last read (none until then), for the handle's word: a status change doesn't read them again. */
  let setupSeen: EnvReport["checks"] = [];
  /** The handle's word: "Setup needed" while Copilot is ready and a setup row holds Ember back (review #95), else the agent's. */
  const idleNow = (status: Parameters<typeof idleWord>[0]) => setupIdle(status.phase, setupSeen) ?? idleWord(status);
  /**
   * Setup rows just read (every readEnvironment: the settings window's status and focus re-read, a fix, Start, the
   * hello): kept, and the handle's word follows them, so "Setup needed" goes once the row holding Ember back is fixed.
   */
  const sawSetup = (rows: EnvReport["checks"]) => {
    setupSeen = rows;
    const status = agent?.getStatus();
    const idle = status && idleNow(status);
    if (idle && idle !== lastState.idle) showState({ idle });
  };
  onSetupRead = sawSetup;
  /** This OS's setup rows now, for the Start decision and the hello (none if they can't be read: words, never a gate). */
  const setupRows = (): EnvReport["checks"] => {
    try { return readEnvironment().checks; } catch (err) { log.warn("environment.read_failed", { err }); return []; }
  };

  /** Hides `bubble` later, unless something else has replaced it by then. */
  const hideIfStill = (bubble: EmberState["bubble"], ms: number) => setTimeout(() => {
    if (lastState.bubble === bubble) setState({ emotion: "neutral", bubble: IDLE_BUBBLE });
  }, ms);
  /** Ember's shortcuts on this OS (one table: the accelerators, and how the copy names them). */
  const sc = sys.shortcuts;
  /** Whether one of Ember's own shortcuts works (another app may hold it). */
  const hasKey = (accel: string) => !(shortcutsTaken ?? []).includes(accel);
  const greet = () => {
    const phase = agent?.getStatus().phase;
    const connected = phase !== "signed-out" && phase !== "error";
    // Offline at start (a retry waits for the network): Ember connects by itself, there is nothing to set up.
    const waiting = phase === "error" && (agent?.waitingForNetwork ?? false);
    const keys = hasKey(sc.ask.accel) && hasKey(sc.stop.accel)
      ? `Press ${sc.ask.label} to ask me anything; ${sc.stop.label} stops me.`
      : "Click my handle in the corner to ask me something or to stop me.";
    const settingsOpen = homeOpen();
    // What Ember says and for how long (hello.ts): connected, it names a setup row that holds it back (review #95).
    const h = hello({ phase, waiting, overlay: !!overlay, keys, settingsKey: hasKey(sc.settings.accel) ? sc.settings.label : null, settingsOpen, rows: connected ? setupRows() : [] });
    const bubble = { ...IDLE_BUBBLE, visible: true, mood: h.mood, title: "Hi, I'm Ember!", thought: h.thought, actions: h.actions };
    setState({ emotion: "happy", talking: true, bubble });
    if (greetTimer) clearTimeout(greetTimer);
    setTimeout(() => setState({ talking: false }), 1600);
    greetTimer = hideIfStill(bubble, h.holdMs);
  };

  const busyTasks = () => agent?.tasks?.list().filter(t => t.status === "running" || t.status === "queued").length ?? 0;
  /** What quitting would stop (§8.9): tasks under way, commands running, computers connected; null when nothing. */
  const quitWords = () => quitQuestion(busyTasks(), targets?.busy() ?? { commands: 0, connections: 0 },
    targets?.summaries().filter(t => t.kind === "ssh" && (t.state === "ready" || t.state === "connecting")).map(t => t.label));
  /**
   * Quitting with tasks under way (or commands running, or connections) asks first (they would stop half-way). One
   * question at a time: Quit chosen again while it is up (perhaps behind a window now) closes it and asks again on top.
   */
  let quitAsking: AbortController | null = null;
  const quitEmber = async (): Promise<void> => {
    const words = quitWords();
    if (!words) { app.quit(); return; }
    quitAsking?.abort();
    const mine = quitAsking = new AbortController();
    // A question with no parent window comes up in front only once Ember is the active app (macOS).
    sys.lifecycle.focusOwnApp();
    try {
      const { response } = await dialog.showMessageBox({
        type: "question", buttons: ["Keep Ember running", "Stop and quit"], defaultId: 0, cancelId: 0, signal: mine.signal,
        title: "Quit Ember?", message: words.message, detail: words.detail,
      });
      if (!mine.signal.aborted && response === 1) app.quit();
    } finally {
      if (quitAsking === mine) quitAsking = null;
    }
  };
  /** The handle's menu is open (or opening): a second click doesn't open another one over it. */
  let menuOpen = false;
  /** The app window the user was last in (an X client window on Linux), for giving focus back after Ember's own windows. */
  let userWindow = 0;
  /** The window the ask box was opened over (it may be one of Ember's: settings, the quit question). */
  let askOver = 0;
  /** The window the user took Ember's desk over from (the keyboard goes back there on hand back). */
  let deskTakenFrom = 0;
  /**
   * The window with the keyboard now (an X client window on Linux, 0 if none), noted as the user's when it isn't
   * Ember's. `ember`: it is one of Ember's own (settings, the desk view, the quit question, the ask box).
   */
  const focusNow = (): { id: number; ember: boolean } => {
    const f = wsRef?.focusWindow();
    if (!f) return { id: 0, ember: false };
    if (f.pid !== process.pid) userWindow = f.id;
    return { id: f.id, ember: f.pid === process.pid };
  };
  /**
   * Focus goes back to `back` (the window that had it, Ember's settings or quit question included) while it is still
   * up; else to the user's window, or, when that has gone too, to the topmost app window that isn't Ember's.
   */
  /** Windows on screen, bottom to top. */
  const shownWindows = () => wsRef?.stack().filter(w => w.title && w.width > 1 && w.height > 1) ?? [];
  const giveFocusBack = (back: number) => {
    const shown = shownWindows();
    // Never the ask box: activating its X window would map it without openAsk (a click into the app looked like Ask opening).
    if (back && askWindow.isWindow(back)) back = askOver && !askWindow.isWindow(askOver) ? askOver : 0;
    if (back && shown.some(w => w.client === back)) { inputRef?.activate(back); return; }
    const apps = shown.filter(w => w.pid !== process.pid);
    const to = apps.some(w => w.client === userWindow) ? userWindow : apps.at(-1)?.client ?? userWindow;
    if (to && !askWindow.isWindow(to)) inputRef?.activate(to);
  };
  const showMenu = () => {
    if (!handle || menuOpen) return;
    const win = handle.win;
    const paused = followPaused;
    const hidden = overlay?.isHidden() ?? false;
    // The shortcut is part of the label (Chromium would print it "Alt+Ctrl+…"), and left out when another app holds it.
    const label = (text: string, def: { accel: string; label: string }) => hasKey(def.accel) ? `${text}   ${def.label}` : text;
    // An item that opens one of Ember's windows (the ask box, settings, the quit question) keeps the focus it
    // takes: the user's app doesn't get it back over the window (settings shows only once it has loaded).
    let opens = false;
    // Linux: Esc (or releasing the click that opened the menu) can fire the first item. Ignore clicks after the menu
    // has started closing; a real pick runs before menu-will-close.
    let menuClosing = false;
    const menu = Menu.buildFromTemplate([
      // What the user was in was read before the handle took focus: looking again would find the handle.
      { label: label("Ask Ember…", sc.ask), registerAccelerator: false, click: () => {
        if (menuClosing) { log.info("ask.menu_ignored", { reason: "menu-closing" }); return; }
        opens = true; openAsk({ look: false, over: back, source: "menu" });
      } },
      { label: label("Stop everything", sc.stop), registerAccelerator: false, click: () => stopEverything("menu") },
      // "Work on" (which computer requests go to), when there is more than this one.
      ...toMenu(targets?.menuItems() ?? []),
      ...(voice && settings.get().wakeWord && settings.get().voice.consent
        ? [{ label: label(voice.isMuted ? "Unmute microphone" : "Mute microphone", sc.mute), registerAccelerator: false, click: toggleMute }]
        : []),
      ...(agent?.lastAnswer() ? [{ label: "Read the last answer", click: () => { opens = true; readLastAnswer(); } }] : []),
      { type: "separator" },
      { label: label("Settings…", sc.settings), registerAccelerator: false, click: () => { opens = true; showHome(); } },
      { label: paused ? "Follow my cursor" : "Stay put", enabled: !!overlay, click: () => { followPaused = !paused; overlay?.setPaused(followPaused); presenceChanged(); } },
      { label: hidden ? "Show Ember" : "Hide Ember", enabled: !!overlay, click: () => { shownForAnswer = false; keptHidden = !hidden; overlay?.setHidden(!hidden); presenceChanged(); } },
      { type: "separator" },
      { label: "Quit Ember", click: () => { opens = quitWords() !== null; void quitEmber(); } },
    ]);
    // The handle never takes focus (a click on it leaves the user's app focused), so the menu's arrows, Enter
    // and Esc would go to that app: the handle takes focus first (the window manager may refuse a toolbar
    // window, so straight from X then), and gives it back after unless a menu item opened something that took
    // it (the ask box, settings, the quit question). The menu opens once the focus has come: a focus change
    // under an open menu closes it.
    // The window with the keyboard, and what "Ask Ember…" will read there, taken now: once the handle has focus
    // they're gone. From settings (or another of Ember's windows) Ember reads nothing; from the ask box, what the
    // box was opened over still stands. The ask box hides when it loses focus, so focus goes back past it.
    const had = focusNow();
    const fromAskBox = had.ember && askWindow.isWindow(had.id);
    if (!fromAskBox) captureContext();
    // From the ask box (it hides when it loses focus), focus goes back to what the box was opened over.
    const fromDesk = had.ember && !!deskViewRef?.isWindow(had.id);
    const back = fromAskBox ? askOver : had.id;
    menuOpen = true;
    const askWasVisible = askWindow.visible;
    menu.on("menu-will-close", () => { menuClosing = true; });
    const open = () => menu.popup({ window: win, callback: () => setTimeout(() => {
      menuOpen = false;
      // Esc dismissed the menu but the first item still opened Ask: put it away (it never went through a pick).
      if (!opens && askWindow.visible && !askWasVisible) {
        log.warn("ask.spurious_after_menu");
        askWindow.hide();
      }
      if (win.isDestroyed()) return;
      const kept = BrowserWindow.getFocusedWindow() === win;
      win.setFocusable(false);
      // From the desk view the user had taken over: once handed back ("Stop everything"), the view takes no keys, so
      // they go back to the window the user took it over from.
      if (kept && !opens) giveFocusBack(fromDesk && !deskInControl ? deskTakenFrom : back);
    }, 150) });
    win.setFocusable(true);
    const xid = ownId(win);
    // Open once the keyboard is really on the handle, and has stayed there: the X server says so, and Electron has
    // seen the focus come (each can come first; a focus change after the menu opened closed it at once, and with no
    // window manager its keys went to the app behind). The X server's word is an X11 check: elsewhere Electron's is
    // enough (a macOS panel that takes the keyboard never shows up as the focus window).
    let focusSeen = win.isFocused();
    const onFocus = () => { focusSeen = true; };
    win.on("focus", onFocus);
    const ws = wsRef;
    const hasKeyboard = () => focusSeen && win.isFocused() && (!ws || ws.kind !== "x11" || ws.focusWindow()?.id === xid);
    let opened = false, steady = 0;
    const go = () => {
      if (opened) return;
      opened = true; clearInterval(poll); clearTimeout(late); win.off("focus", onFocus);
      if (win.isDestroyed()) menuOpen = false; else open();
    };
    // Nor while the click on the handle is still held: the menu opens under the pointer, and the release would choose
    // its first item ("Ask Ember…": the ask box opened by itself).
    const released = () => ((wsRef?.pointer()?.mask ?? 0) & 0x1f00) === 0;
    const poll = setInterval(() => { if (win.isDestroyed()) go(); else if (hasKeyboard() && released()) { if (++steady >= 2) go(); } else steady = 0; }, 10);
    // No focus within a moment (no X input here): the menu opens anyway, once the button is up (at most a second).
    const menuAsked = Date.now();
    const late = setTimeout(function later() { if (released() || Date.now() - menuAsked > 1000) go(); else setTimeout(later, 20); }, 250);
    win.focus();
    if (inputRef?.focusInput) inputRef.focusInput(xid);
  };
  /** The targets runtime's menu items as Electron's (the same fields; submenus too). */
  const toMenu = (items: MenuItemLike[]): Electron.MenuItemConstructorOptions[] => items.map(i => ({
    ...(i.label !== undefined ? { label: i.label } : {}), ...(i.type ? { type: i.type } : {}),
    ...(i.checked !== undefined ? { checked: i.checked } : {}), ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
    ...(i.submenu ? { submenu: toMenu(i.submenu) } : {}), ...(i.click ? { click: i.click } : {}),
  }));
  let followPaused = false;
  let presenceChanged = () => { /* set once the IPC is ready */ };
  /** The whole answer in settings; the bubble goes, so Ember doesn't sit over it holding the old one. */
  const readLastAnswer = () => {
    // The answer being read in full goes from the bubble (with or without a "Read all" button), and the hold its
    // "Read all" pinned with it ("Open in settings" on the expanded answer: as Close).
    if (lastState.bubble.visible && lastState.bubble.actions.every(a => a.id.startsWith("ui:"))) {
      setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
      agent?.releasePin(lastState.bubble);
    }
    showHome();
    sendToHome(IPC.focusSection, "conversation");
  };
  /** "Read all": the whole answer in the bubble, where the user was reading it (settings keeps it too). */
  const expandAnswer = () => {
    const full = agent?.lastAnswer();
    if (!full) { readLastAnswer(); return; }
    agent?.claimBubble({ pin: true });
    setState({ talking: false, bubble: expandedBubble(lastState.bubble, full) });
  };
  const closeExpanded = () => {
    if (!lastState.bubble.expanded) return;
    setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
    agent?.releaseBubble(lastState.bubble);
  };
  /** Settings, at the Copilot section when that's what needs doing. The bubble that offered it goes. */
  const openSettings = () => {
    showHome();
    // Copilot to connect, or a setup row that holds Ember back (review #95).
    const where = settingsSection(agent?.getStatus().phase, setupRows());
    if (where) sendToHome(IPC.focusSection, where);
  };

  const sendToHome = (channel: string, value: unknown) => {
    const send = () => { if (home && !home.isDestroyed()) home.webContents.send(channel, value); };
    if (home && !home.isDestroyed() && home.webContents.isLoading()) home.webContents.once("did-finish-load", send); else send();
  };
  /**
   * Questions are answered with keys too (Orca and keyboard users can't click the bubble): Y allows, N says
   * not now. "Always" is a click only: a global key would take an app's own Ctrl+Alt+A and grant for good.
   */
  const QUESTION_KEYS: readonly { accel: string; which: "primary" | "deny"; hint: string; say: string }[] = [
    { accel: sc.allow.accel, which: "primary", hint: `${sc.allow.label} allow`, say: `${sc.allow.say} to allow` },
    { accel: sc.deny.accel, which: "deny", hint: `${sc.deny.label} not now`, say: `${sc.deny.say} for not now` },
  ];
  let questionKeys: string[] = [];
  const holdQuestionKeys = () => {
    if (questionKeys.length) return;
    for (const k of QUESTION_KEYS) {
      if (globalShortcut.register(k.accel, () => confirmer?.answerKey(k.which))) questionKeys.push(k.accel);
      else log.warn("shortcut.question_key_taken", { accel: k.accel });
    }
  };
  const heldKeys = () => QUESTION_KEYS.filter(k => questionKeys.includes(k.accel));
  /** The keys that answer the question now up, for its bubble (only keys Ember actually holds). */
  const questionKeyHint = () => { holdQuestionKeys(); return heldKeys().map(k => k.hint).join(" · ") || undefined; };
  const questionChanged = (q: { n: number; question: Question } | null) => {
    // The keys are held first, so a command card names the keys that answer it (the targets runtime asks keyHint).
    if (q) holdQuestionKeys();
    // A question with a panel (a command, a consent card) shows its window; the window goes with it.
    targets?.questionChanged(q);
    if (!q) {
      for (const k of questionKeys) globalShortcut.unregister(k);
      questionKeys = [];
      return;
    }
    holdQuestionKeys();
    // The question replaced an expanded answer and its Close button: the pinned hold has nothing left to keep. What it
    // held off shows after the question (the question holds everything meanwhile).
    agent?.releasePin(lastState.bubble);
    // A question nobody can see expires as "no": a hidden Ember shows itself to ask (and stays shown,
    // also when the compositor comes back while the question is on the card).
    keptHidden = false;
    if (overlay?.isHidden()) { overlay.setHidden(false); presenceChanged(); }
    // A command is never read out or put in a notification (R7): only that Ember wants to run one, and where; the card
    // on screen shows it, and the keys work only there.
    const words = targets?.questionWords(q.question) ?? null;
    if (maySpeak()) {
      const keys = heldKeys().map(k => k.say);
      voice?.speak(words ?? `Ember asks: ${spokenText(q.question.prompt)}${keys.length ? ` Press ${keys.join(", or ")}.` : ""}`);
    }
    if (userAway()) notify("Ember needs your OK", words ?? q.question.prompt);
  };
  /** The user isn't looking at Ember right now (idle, or Ember hidden). */
  const userAway = () => (overlay?.isHidden() ?? false) || powerMonitor.getSystemIdleTime() >= 30;
  const notify = (title: string, body: string) => {
    try { if (Notification.isSupported()) new Notification({ title, body: body.slice(0, 240), silent: false }).show(); } catch (err) { log.warn("notify.failed", { err }); }
  };
  let askHistory: string[] = [];
  /** Speak replies (or a screen reader runs: Orca, Narrator, VoiceOver), unless the organisation turned speaking off. */
  const maySpeak = () => policy.features.speak !== false && (settings.get().speak || sys.a11y.screenReaderOn());

  // ───── Copilot brain ─────
  /** The ask box's window as last given the keyboard (an X window on Linux; 0: not yet, or it can't be told). */
  let askXid = 0;
  const askWindow = new AskWindow({
    keepOff: () => handle?.bounds ?? null,
    windowId: w => ownId(w),
    floating: platform.overlay.floating("ask"),
    // As the handle's menu takes the keyboard: the window manager is asked, and X is told too. On macOS the box is a
    // panel that takes the keyboard on show() without activating Ember (the user's app stays the active one).
    takeFocus: id => {
      askXid = id;
      if (!sys.lifecycle.activateForAsk) return;
      sys.lifecycle.focusOwnApp();
      if (id && sys.lifecycle.activateOwnWithInput) { inputRef?.activate(id); inputRef?.focusInput?.(id); }
    },
    // Electron can think the box is focused while X still has the user's app: only stop holding keys once X agrees
    // (an X11 check, needed only where Ember holds the keyboard while the box opens).
    hasFocus: platform.keyboardHold ? (): boolean => !wsRef || (askXid !== 0 && wsRef.focusWindow()?.id === askXid) : undefined,
    onReveal: source => log.info("ask.reveal", { source }),
  });
  let agent: AgentHost | null = null;
  /** Where tasks act besides this screen (WSL, SSH) and the commands on each (§2); made once the hands are. */
  let targets: (TargetsRuntime & TargetsRuntimeExtra) | null = null;
  let perception: Perception | null = null;
  let voice: VoiceService | null = null;
  /** Where the user was when they last called Ember (taken before anything of Ember's takes focus). */
  let callContext: Promise<QuickContext | null> = Promise.resolve(null);
  // Nothing is read from the screen or sent anywhere until the user has agreed (M8.8).
  const consented = () => hasConsent(settings.get());
  const captureContext = () => {
    if (!consented()) { callContext = Promise.resolve(null); return; }
    // Set to work on another computer: its context (never this screen's: the user's window is the terminal they reached
    // it from, §2.8). Asked first, so it works without a window system here too.
    const remote = targets?.quickContext();
    if (remote) { callContext = remote.catch(() => null); return; }
    if (!perception) { callContext = Promise.resolve(null); return; }
    // What is selected in the user's window, asked for now (some apps don't tell it through accessibility; Linux's
    // PRIMARY selection, which other OSes don't have).
    const active = wsRef?.activeWindow();
    const clip = platform.clipboard;
    const selected = active && active.pid !== process.pid && clip ? clip.readSelection(active.id).catch(() => "") : Promise.resolve("");
    callContext = Promise.all([perception.quickContext(), selected]).then(([c, sel]) => Perception.withSelection(c, sel)).catch(() => null);
  };
  const askEmber = async (text: string) => {
    if (!consented()) { showHome(); return; }
    // A hidden Ember shows itself for the answer to a question the user just asked (and hides again after).
    if ((overlay ? overlay.isHidden() : keptHidden) && !shownForAnswer) { shownForAnswer = true; overlay?.setHidden(false); }
    // A Stop while the screen is read (or the brain connects) drops the request.
    const epoch = agent?.stopEpoch;
    // A slow screen read never holds a request for long: it goes without context after 3 s (the first read after
    // Ember starts also starts the accessibility helper).
    const context = await Promise.race([callContext, new Promise<null>(r => setTimeout(() => r(null), 3000))]);
    return agent?.ask(text, context, epoch)?.catch(err => log.error("ask.failed", { err }));
  };
  /**
   * `look: false`: what the user is in was read already (the handle's menu reads it before taking focus), and
   * `over` is the window it had the keyboard.
   */
  const openAsk = ({ look = true, over = 0, source = "hotkey" }: { look?: boolean; over?: number; source?: "hotkey" | "menu" | "test" } = {}) => {
    // Every opening says where it came from (an ask box that opened by itself would show up here).
    log.info("ask.open", { source });
    if (!consented()) { showHome(); return; }
    // Already open: the user is typing in it. Looking again would only find the ask box itself.
    if (askWindow.visible) { askWindow.focus(); return; }
    // From the hotkey, letters typed before the box has the keyboard would go to the user's app: Ember holds the
    // keyboard meanwhile and hands what was typed to the box. Take it before reading focus/context: those X11 and
    // accessibility round trips can outlast the hotkey's own grab, and by then the first letter has gone.
    const held = look && platform.keyboardHold ? platform.keyboardHold({ log: (event, fields) => log.info(event, fields) }) : null;
    // The window it opens over (Ember's settings included): the handle's menu gives focus back there.
    askOver = look ? focusNow().id : over;
    if (look) captureContext();
    // Where a request goes when it names no computer: the picker's choice, as a chip (§8.1).
    const askTarget = () => { try { return targets?.summaries().find(t => t.active) ?? null; } catch { return null; } };
    askWindow.show(overlay ? { ...overlay.position, size: settings.get().size } : null, { sees: null, history: askHistory, target: askTarget() }, source);
    if (held) void askWindow.hasKeyboard().then(() => askWindow.typed(held.stop()), () => held.stop());
    // What Ember will read, shown as a chip once the quick look is done.
    void callContext.then(c => {
      const t = c?.target;
      const sees = t ? [t.app && friendlyApp(t.app), t.title].filter(Boolean).join(" · ") || null : null;
      const ctx: AskContext = { sees: sees && sees.length > 80 ? sees.slice(0, 79) + "…" : sees, history: askHistory, target: askTarget() };
      askWindow.setContext(ctx);
    });
  };
  let audit: AuditLog | null = null;
  let borrowRef: CursorBorrow | null = null;
  let deskViewRef: DeskView | null = null;
  const killSwitch = new KillSwitch(() => [
    { name: "borrow", stop: () => borrowRef?.stop() },
    { name: "speech", stop: () => voice?.hush() },
    // A request still being spoken is dropped, not sent after Stop.
    { name: "listening", stop: () => voice?.cancelListening() },
    { name: "agent", stop: () => agent?.abortAll() },
    // Every command stops, on every target, and every remote is told to stop (at once, whatever the network does).
    { name: "targets", stop: () => targets?.stopAll() },
    // The user's take-over of the desk ends too (its keys are released).
    { name: "desk", stop: () => deskViewRef?.handBack() },
    { name: "motion", stop: () => { overlay?.setBorrowing(false); deskViewRef?.setDriving(false); showState({ focus: null, gesture: null }); } },
  ], log.child("killswitch"), () => audit);
  /** Ctrl+Alt+X, "Ember, stop", or Stop in the menu: everything stops at once. */
  const stopEverything = (source: "hotkey" | "voice" | "menu") => {
    void killSwitch.pull(source);
    // Failure cards stay until closed, and only a click closes them: Stop everything clears them too
    // (the keyboard's way, and the screen reader's).
    for (const t of agent?.tasks?.list() ?? []) if (t.status === "failed") agent?.tasks?.dismiss(t.id);
    const bubble = { visible: true, mood: "idle" as const, title: "Stopped", thought: "Okay, I've stopped everything.", step: null, streaming: false, actions: [] };
    statusBy.listen = statusBy.mic = null;
    setState({ emotion: "neutral", talking: false, status: statusBy.borrow, bubble });
    hideIfStill(bubble, 3000);
  };
  let lastAskByVoice = false;
  /** This turn's answer: its follow-up takes "Okay." as the reply it is when the answer asked something. */
  let turnAnswer = "";
  /**
   * Said on the status line when a spoken request ran past the longest Ember listens: after a "Hey Ember" request a
   * follow-up window comes, after a follow-up none does.
   */
  const CUT_NOTES = {
    wake: "I only caught the first part: say the rest after my answer.",
    "follow-up": "I only caught the first part: say “Hey Ember” and the rest.",
  } as const;
  const isCutNote = (s: string | null) => s === CUT_NOTES.wake || s === CUT_NOTES["follow-up"];
  let shownForAnswer = false;
  /** "Hide Ember" while there is no overlay to hold it (no compositor): the next overlay starts hidden. */
  let keptHidden = false;
  /** The window system and input, once opened after ready (null: none on this desktop). */
  let inputRef: Input | null = null;
  let wsRef: WindowSystem | null = null;
  /** The accessibility helper's client, once made after ready. */
  let sidecarRef: AtspiSidecar | null = null;
  /** Shows the borrow's state (status line, click-through); set once the hands are ready. */
  let showBorrowing: (() => void) | null = null;
  /** One status line, several writers: the borrow comes first, then listening, then the microphone. */
  const statusBy: { borrow: string | null; listen: string | null; mic: string | null } = { borrow: null, listen: null, mic: null };
  const setStatus = (owner: keyof typeof statusBy, text: string | null) => {
    statusBy[owner] = text;
    setState({ status: statusBy.borrow ?? statusBy.listen ?? statusBy.mic });
  };
  /** What Ember showed before a wake, put back if the wake turns out to be another word. */
  let beforeWake: Pick<EmberState, "emotion" | "bubble"> | null = null;
  const toggleMute = () => {
    if (!voice || !(settings.get().wakeWord && settings.get().voice.consent)) return;
    voice.setMuted(!voice.isMuted);
    // Remembered: a restart (or login) doesn't quietly open the microphone again.
    try { settings.update({ voice: { ...settings.get().voice, muted: voice.isMuted } }); } catch (err) { log.warn("voice.mute_not_saved", { err }); }
    setStatus("mic", voice.isMuted ? "Microphone off" : null);
    if (voice.isMuted) setTimeout(() => { if (voice?.isMuted) setStatus("mic", null); }, 2500);
  };
  const voiceStatus = (detail?: string) => ({
    state: voice?.micState ?? "off", detail: detail ?? null,
    modelsReady: voice?.modelsReady ?? false, modelsBytes: VOICE_MODELS_BYTES, speechMissing: speechHeard === false,
  });
  /** The detail of the microphone's current state, so a status sent for something else keeps it. */
  let voiceDetail: string | undefined;
  /** What Ember does with what it hears. */
  const onVoice = (e: VoiceEvent) => {
    switch (e.type) {
      case "wake":
        beforeWake = { emotion: lastState.emotion, bubble: lastState.bubble };
        captureContext();
        voice?.hush();
        // The bubble is main's now: an answer's leftover hide timer mustn't blank "Listening…".
        agent?.claimBubble();
        setState({ emotion: "listening", talking: false, bubble: { visible: true, mood: "listening", title: "Listening…", thought: "", step: null, streaming: true, actions: [] } });
        break;
      case "listening":
        if (e.on && e.reason === "follow-up") { setState({ emotion: "listening" }); setStatus("listen", "Listening for a follow-up…"); }
        // (Not the note that a request was cut: it comes with the "listening off" of that request, and stays.)
        if (!e.on && !isCutNote(statusBy.listen)) setStatus("listen", null);
        // Nobody spoke: back to idle. The wake was another word ("Amber"): back to what was showing.
        // A follow-up window that heard nothing leaves the answer up (unless it had started showing "Listening…"),
        // with its own hide timer still running. What is put back gets a hide of its own.
        if (!e.on && e.reason === "timeout") {
          if (e.window === "wake" || lastState.bubble.mood === "listening") { agent?.claimBubble(); setState({ emotion: "neutral", bubble: IDLE_BUBBLE }); } else setState({ emotion: "neutral" });
        }
        if (!e.on && e.reason === "rejected") {
          agent?.claimBubble();
          setState(beforeWake ?? { emotion: "neutral", bubble: IDLE_BUBBLE });
        }
        // Main lets go of the bubble: an answer or result it put back (or left) hides after its reading time.
        // Something put back that is nobody's any more (one of main's own, whose hide ran out under "Listening…") goes shortly.
        if (!e.on && (e.reason === "timeout" || e.reason === "rejected")) {
          const shown = lastState.bubble;
          if (!(agent?.releaseBubble(shown) ?? false) && shown.visible) hideIfStill(shown, 4000);
        }
        break;
      case "speech":
        if (e.on) agent?.claimBubble();
        if (e.on) setState({ bubble: { visible: true, mood: "listening", title: "Listening…", thought: "…", step: null, streaming: true, actions: [] } });
        break;
      case "utterance": {
        // One follow-up per wake: the answer to a follow-up opens no window of its own (the engine refuses it too).
        lastAskByVoice = e.window === "wake";
        log.info("voice.utterance", { chars: e.text.length, ms: e.ms, window: e.window, cut: !!e.cut });
        // The request ran past the longest Ember listens: what was heard goes, and the user is told the rest didn't.
        if (e.cut) {
          const note = CUT_NOTES[e.window];
          setStatus("listen", note);
          setTimeout(() => { if (statusBy.listen === note) setStatus("listen", null); }, 10_000).unref?.();
        }
        // A follow-up (no wake word) keeps the context from the last call.
        void askEmber(e.text);
        break;
      }
      case "stop":
        // "Ember, stop": everything stops, locally, without asking the model.
        stopEverything("voice");
        break;
    }
  };
  let tokens: TokenStore | null = null;
  let currentToken: string | null = null;
  let signInAbort: AbortController | null = null;
  const broadcast = (channel: string, value: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, value);
  };
  const progress = (p: SignInProgress) => broadcast(IPC.signInProgress, p);

  ipcMain.handle(IPC.agentStatus, guard(() => agent?.getStatus() ?? null));
  ipcMain.handle(IPC.conversation, guard(() => agent?.getTranscript() ?? []));
  ipcMain.handle(IPC.signOut, guard(async () => {
    signInAbort?.abort();
    // While still connected: delete this account's conversation so the next sign-in starts fresh.
    await agent?.forgetConversation();
    tokens?.clear();
    currentToken = null;
    askHistory = [];
    await agent?.start(null);
  }));
  ipcMain.handle(IPC.cancelSignIn, guard(() => { signInAbort?.abort(); progress({ state: "cancelled" }); }));
  /** The page of the sign-in under way, opened again on request (GitHub's own pages only). */
  let signInPage: string | null = null;
  const openSignInPage = () => { if (signInPage && /^https:\/\/github\.com\//.test(signInPage)) void shell.openExternal(signInPage); };
  ipcMain.handle(IPC.openSignInPage, guard(openSignInPage));
  /** A sign-in that failed, in plain words (a network or certificate problem, not "net::ERR_…"). */
  const signInError = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/^(The sign-in code expired|Sign-in was cancelled)/.test(msg)) return msg;
    if (/refused the sign-in request \(4\d\d\)/.test(msg)) return "GitHub didn't accept Ember's sign-in request. Make sure Ember is up to date, or run “gh auth login” in a terminal and press Check again.";
    return explainStartError(err, { online: net.isOnline(), reinstall: sys.words.reinstall });
  };
  /** "Check again": look for a sign-in (Ember's own, the environment, gh) and reconnect with it. */
  const retrySignIn = async (): Promise<{ found: boolean; source: string | null }> => {
    if (!consented()) { showHome(); return { found: false, source: null }; }
    const found = await resolveToken(tokens, process.env, ghOptions()).catch(() => null);
    currentToken = found?.token ?? null;
    await agent?.start(currentToken, found?.source);
    return { found: !!found, source: found?.source ?? null };
  };
  ipcMain.handle(IPC.agentRetry, guard(retrySignIn));
  ipcMain.handle(IPC.signIn, guard(async () => {
    // Nothing connects before the user has agreed to what Ember does.
    if (!consented()) { showHome(); throw new Error("Agree to how Ember works first (at the top of this window)."); }
    // This flow only: a second click cancels the first, and an old flow never overwrites a newer one's messages.
    const ac = new AbortController();
    signInAbort?.abort();
    signInAbort = ac;
    const say = (p: SignInProgress) => { if (signInAbort === ac) progress(p); };
    /** Signed in only when Copilot actually connected; otherwise what went wrong. */
    const connected = async (phase: string | undefined, note?: string) => {
      if (phase === "ready") say({ state: "done", message: note });
      else say({ state: "error", message: agent?.getStatus().detail ?? "Copilot didn't connect." });
    };
    const clientId = process.env.EMBER_GITHUB_CLIENT_ID;
    if (!clientId) {
      // No sign-in app yet: watch for a GitHub CLI sign-in instead, and connect as soon as one appears (no restart).
      say({ state: "waiting", message: "In a terminal, run “gh auth login”. Ember will notice within a few seconds and connect; no restart needed." });
      const before = currentToken;
      for (let i = 0; i < 200 && !ac.signal.aborted; i++) {
        const found = await resolveToken(tokens, process.env, ghOptions()).catch(() => null);
        if (ac.signal.aborted) return;
        if (found && found.token !== before) {
          currentToken = found.token;
          await connected(await agent?.start(found.token, found.source));
          return;
        }
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!ac.signal.aborted) say({ state: "error", message: "Ember didn't see a new GitHub sign-in. Run “gh auth login”, then press Check again." });
      return;
    }
    const fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => net.fetch(url, init);
    try {
      const code = await startDeviceFlow(fetch, clientId);
      if (ac.signal.aborted) return;
      say({ state: "code", userCode: code.userCode, verificationUri: code.verificationUri });
      // Only GitHub's own page is ever opened.
      signInPage = code.verificationUri;
      openSignInPage();
      const token = await pollDeviceFlow(fetch, clientId, code, { signal: ac.signal });
      // Cancelled at the last moment: the code was approved, but the user said no here.
      if (ac.signal.aborted) return;
      const kept = tokens?.save(token) ?? false;
      if (!kept) log.warn("auth.not_persisted", { reason: "no keyring available; sign-in lasts until Ember quits" });
      currentToken = token;
      await connected(await agent?.start(token, "stored"), kept ? undefined : `Signed in. ${sys.words.keyringMissing}, so you'll need to sign in again next time.`);
    } catch (err) {
      if (!ac.signal.aborted) say({ state: "error", message: signInError(err) });
    }
  }));
  ipcMain.handle(IPC.voiceStatus, guard(() => voiceStatus()));
  const presence = () => ({ hidden: overlay?.isHidden() ?? false, paused: followPaused, overlay: !!overlay });
  presenceChanged = () => broadcast(IPC.presenceChanged, presence());
  ipcMain.handle(IPC.presence, guard(presence));
  ipcMain.handle(IPC.setPresence, guard((p: unknown) => {
    const want = (p && typeof p === "object" ? p : {}) as { hidden?: unknown; paused?: unknown };
    if (typeof want.hidden === "boolean") { shownForAnswer = false; keptHidden = want.hidden; overlay?.setHidden(want.hidden); }
    if (typeof want.paused === "boolean") { followPaused = want.paused; overlay?.setPaused(followPaused); }
    broadcast(IPC.presenceChanged, presence());
    return presence();
  }));
  ipcMain.handle(IPC.quit, guard(() => quitEmber()));
  ipcMain.handle(IPC.voiceDownload, guard(async () => {
    // Listening turned off by the organisation: nothing to download for.
    if (policy.features.voice === false) return;
    try {
      await voice?.downloadModels((done, total) => broadcast(IPC.voiceProgress, { done, total }));
    } catch {
      return; // VoiceService already left "Downloading…" and said why (onState → voiceStatus with the detail)
    }
    broadcast(IPC.voiceStatus, voiceStatus());
  }));
  ipcMain.on(IPC.ask, (event, text: unknown) => {
    if (!askWindow.owns(event.sender) || typeof text !== "string") return;
    askWindow.hide();
    lastAskByVoice = false;
    const t = text.slice(0, 2000);
    askHistory = [...askHistory.filter(h => h !== t), t].slice(-20);
    void askEmber(t);
  });
  ipcMain.on(IPC.askClose, event => { if (askWindow.owns(event.sender)) askWindow.hide(); });

  const isRect = (r: unknown): r is Rect => !!r && typeof r === "object" && ["x", "y", "width", "height"].every(k => Number.isFinite((r as Record<string, unknown>)[k]));
  ipcMain.on(OVERLAY.cards, (event, rect: unknown) => {
    if (!overlay?.owns(event.sender) || !(rect === null || isRect(rect))) return;
    overlay.setCards(event.sender, rect);
  });
  ipcMain.on(OVERLAY.interactive, (event, rects: unknown) => {
    if (!overlay?.owns(event.sender) || !Array.isArray(rects) || rects.length > 32 || !rects.every(isRect)) return;
    overlay.setInteractive(event.sender, rects);
  });
  /** From the handle's page (a handle closed or crashed is no one: a check on it must not throw for the overlay's clicks). */
  const isHandle = (sender: Electron.WebContents) => !!handle && !handle.win.isDestroyed() && sender === handle.win.webContents;
  ipcMain.on(OVERLAY.bubbleAction, (event, id: unknown) => {
    const fromHandle = isHandle(event.sender);
    if (!(overlay?.owns(event.sender) || fromHandle) || typeof id !== "string" || id.length > 120) return;
    const task = /^task:(.+):(stop|dismiss)$/.exec(id);
    // Stopping a task is always honoured (also while Ember waits for the mouse), and so is an announced command's Stop
    // (critique integration-24). Anything else that arrives while Ember really drives the pointer was Ember's own
    // click, not the user's: ignored.
    if (borrowRef?.driving && !(task && task[2] === "stop") && !id.startsWith("ui:cmdstop:")) { log.warn("bubble.action_while_borrowing", { id }); return; }
    if (id === "ui:settings") { openSettings(); return; }
    if (id === "ui:more") { expandAnswer(); return; }
    if (id === "ui:conversation") { readLastAnswer(); return; }
    if (id === "ui:close") { closeExpanded(); return; }
    // The targets runtime's own: a target picked, an offer, a connection, a panel to show, an announced command's Stop.
    if (targets?.bubbleAction(id)) return;
    if (task) {
      if (task[2] === "stop") agent?.tasks?.cancel(task[1]); else agent?.tasks?.dismiss(task[1]);
      log.info("task.card_action", { action: task[2] });
      return;
    }
    log.info("bubble.action", { id, handled: confirmer?.answer(id, "bubble") ?? false });
  });
  ipcMain.on(OVERLAY.handleMenu, event => {
    if (isHandle(event.sender)) showMenu();
  });
  ipcMain.on(OVERLAY.handleFit, (event, height: unknown) => {
    if (handle && isHandle(event.sender) && typeof height === "number") { handle.fit(height); deskViewRef?.handleMoved(); }
  });

  settings.onChange((s) => {
    overlay?.broadcastSettings(s);
    handle?.sendSettings(s);
  });
  // "Start Ember when I log in" keeps the OS's login item (Linux: ~/.config/autostart/ember.desktop) in step.
  const autostart = () => {
    try {
      if (sys.autostart.sync(settings.get().startAtLogin)) {
        log.info("autostart.updated", { on: settings.get().startAtLogin });
      }
    } catch (err) { log.warn("autostart.failed", { err }); }
  };
  autostart();
  settings.onChange(autostart);
  const atLogin = sys.autostart.launchedAtLogin(process.argv);
  if (atLogin) log.info("app.autostart");
  let wasOnboarded = settings.get().onboarded;
  /** The brain's start (finding a sign-in, then connecting): what the greeting and onboarding wait for. */
  let brainStart: Promise<unknown> = Promise.resolve();
  /** How connecting Copilot ended (waits while it is still starting, up to 20 s). */
  const settledPhase = async () => {
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 500));
    // Still looking for a sign-in (a slow GitHub CLI at login): that counts as starting.
    await Promise.race([brainStart, new Promise(r => setTimeout(r, 20_000))]);
    for (;;) {
      const phase = agent?.getStatus().phase;
      if (phase !== "starting" || Date.now() - t0 > 20_000) return phase;
      await new Promise(r => setTimeout(r, 250));
    }
  };
  settings.onChange(s => {
    if (s.onboarded && !wasOnboarded) {
      // Setup finished: get out of the way so the user sees Ember say hello. If Copilot isn't connected, the window
      // stays and shows how to connect (asking would only say "not connected"); if a setup row holds Ember back (a
      // permission, screen reading), it stays at the setup check (review #95).
      void settledPhase().then(phase => {
        const where = settingsSection(phase, setupRows());
        if (where) {
          // Settings stays open there; Ember says hello once it closes, not over it.
          sendToHome(IPC.focusSection, where);
          if (homeOpen()) { greetOnClose = true; return; }
        } else if (home && !home.isDestroyed()) {
          // Hello once the window has gone (Ember is still waiting beside it until then).
          greetOnClose = true;
          home.close();
          return;
        }
        greet();
      });
    }
    wasOnboarded = s.onboarded;
  });

  /**
   * The session ends (log-off, shut down) without will-quit on Windows and macOS (G10): settings are saved and
   * whatever Ember holds is let go of at once, as quitting would.
   */
  let sessionEnding = false;
  const endSession = (source: string) => {
    if (sessionEnding) return;
    sessionEnding = true;
    log.info("app.session_end", { source });
    try { settings.flush(); } catch (err) { log.warn("settings.not_saved", { err }); }
    borrowRef?.stop();
    inputRef?.releaseAll();
    sidecarRef?.stop();
    voice?.stop();
  };
  if (sys.lifecycle.sessionEnd === "power-monitor-shutdown") powerMonitor.on("shutdown", () => endSession("shutdown"));
  // An X id of one of Ember's windows, taken while they exist (at will-quit they are gone): the clipboard's
  // owner is told apart by it (Linux only: elsewhere the system keeps the clipboard after Ember quits).
  let emberXid = 0;
  app.on("browser-window-created", (_e, w) => {
    if (!emberXid && platform.clipboard) emberXid = platform.clipboard.ownerId(w);
    if (sys.lifecycle.sessionEnd === "window-session-end") w.on("session-end", () => endSession("session-end"));
  });
  // Quitting waits (up to 3 s) for the brain to stop: that is when this run's conversation is deleted. Meanwhile a
  // clipboard Ember holds (after a paste it put the user's back) goes to the clipboard manager (≤ 2 s), or
  // quitting would empty it. Not while the session ends: there is no time to wait then.
  let quitting = false;
  app.on("will-quit", e => {
    globalShortcut.unregisterAll();
    overlay?.stop();
    if (quitting || sessionEnding) return;
    quitting = true;
    e.preventDefault();
    const brain = agent ? Promise.race([agent.stop(), new Promise(r => setTimeout(r, 3000))]).catch(() => undefined) : Promise.resolve();
    const clipboardBridge = platform.clipboard;
    const clip = emberXid && clipboardBridge
      ? clipboardBridge.handOff(emberXid).then(result => log.info("clipboard.handoff", { result }), err => log.warn("clipboard.handoff_failed", { err }))
      : Promise.resolve();
    void Promise.all([brain, clip]).finally(() => app.exit(0));
  });

  void app.whenReady().then(() => {
    whenReady();
  }).catch(startupFailed);

  const whenReady = () => {
    // Deny camera, mic, notifications etc. until a feature asks for them explicitly (M5).
    // Everything is denied except the microphone, for Ember's own mic window, audio only.
    voicePermissions(() => voice);
    // No background downloads: the spellchecker would fetch dictionaries from Google.
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerLanguages([]);
    session.defaultSession.on("spellcheck-dictionary-download-begin", (_e, lang) => log.warn("spellcheck.download", { lang }));
    // macOS: an application menu whose Quit (Command+Q) asks as the handle's Quit does; its Edit menu is what makes
    // Command+C/V/X/A/Z work in the settings window's fields.
    if (sys.lifecycle.appMenu) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: "Ember", submenu: [
          { label: "Settings…", accelerator: "Command+,", click: () => showHome() },
          { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" },
          { label: "Quit Ember", accelerator: "Command+Q", click: () => void quitEmber() },
        ] },
        { role: "editMenu" },
        { role: "windowMenu" },
      ]));
    }
    // Windows: the Start Menu shortcut toasts need (made once, for the zip build).
    sys.lifecycle.ensureShortcut();
    // Linux: X11 only with $DISPLAY, as always (the platform reads it).
    const ws = wsRef = wsState = platform.openWindows(log);
    const env = readEnvironment();
    let compositing = ws ? ws.hasCompositor() : false;
    askWindow.setOpaque(!compositing);
    // Made now (hidden), so the ask shortcut opens it at once: a box still loading took the first letters typed.
    if (consented()) askWindow.prepare();
    // Where the pointer is, in global DIP, and the buttons held: from the window system (X11's XQueryPointer reports
    // physical pixels; Electron's position can be stale there), else Electron's.
    const cursor = () => {
      const p = ws?.pointer();
      if (!ws || !p) return screen.getCursorScreenPoint();
      const d = ws.toDipPoint(p);
      return { x: d.x, y: d.y, buttons: p.mask & 0x1f00 };
    };
    app.on("will-quit", () => ws?.close());
    log.info("app.ready", {
      version: app.getVersion(),
      os: env.os,
      session: env.sessionType,
      desktop: env.desktop,
      glibc: env.glibc,
      electron: env.versions.electron,
      compositing,
      failing: env.checks.filter(c => c.status !== "ok").map(c => c.id),
    });

    const makeOverlay = (hidden = false) => {
      const o = new OverlayManager(() => settings.get(), log.child("overlay"), cursor, platform.overlay);
      // The system asking for less motion (GNOME's "Animations" switch off) counts as asking for calm mode.
      try { o.systemReducedMotion = sys.a11y.systemReducedMotion(); } catch { /* not known: Ember's own setting only */ }
      o.avoid = () => handle?.bounds ?? null;
      o.setState(lastState);
      o.setHidden(hidden);
      o.setPaused(followPaused);
      o.start();
      overlay = o;
    };
    /** The pill with a compositor, the card without one (transparent windows paint black then). */
    const makeHandle = () => {
      const old = handle;
      handle = new HandleWindow(() => settings.get(), !overlay, { floating: platform.overlay.floating("handle"), forward: platform.overlay.forward });
      handle.sendState(lastState);
      old?.destroy();
      deskViewRef?.handleMoved();
    };
    if (compositing) makeOverlay();
    else log.warn("overlay.fallback", { reason: "no compositing manager; using the handle card" });
    makeHandle();
    // The compositor can go and come back (GNOME Shell restarting, another window manager): Ember follows,
    // so its full-screen overlay never turns the desktop black. (Windows and macOS always composite.)
    if (ws?.compositorMayChange) {
      const watch = setInterval(() => {
        const now = ws.hasCompositor();
        if (now === compositing) return;
        compositing = now;
        askWindow.setOpaque(!now);
        log.warn("overlay.compositor_changed", { compositing: now });
        // "Hide Ember" outlives the switch (the overlay that knew it is gone while there is no compositor).
        // Shown only for an answer still counts as hidden: it hides again when the answer goes.
        if (overlay) keptHidden = overlay.isHidden() || shownForAnswer;
        if (now) makeOverlay(keptHidden && !shownForAnswer); else { overlay?.stop(); overlay = null; }
        makeHandle();
        askWindow.keepClear();
        // What the new windows don't know yet: the settings window to keep off, a borrow under way.
        stepAside();
        showBorrowing?.();
        presenceChanged();
      }, 2000);
      watch.unref?.();
      app.on("will-quit", () => clearInterval(watch));
    }

    // Ember's shortcuts. One another app already holds is reported (setup check, greeting) and tried again every minute.
    let lastAskPress = 0;
    const shortcuts: Record<string, () => void> = {
      [sc.settings.accel]: showHome,
      // A callback is not a press: X11 reports the shortcut again when its grab ends, after the keyboard buffer lets
      // go (the box then opened on a Backspace or a click). Only a real, fresh chord opens it. Elsewhere a callback is
      // one press (trusted, debounced).
      [sc.ask.accel]: () => {
        const now = Date.now(), chord = platform.shortcutsReReported ? ws?.keysDown() ?? null : null;
        if (!freshAskPress(chord, now, lastAskPress)) {
          log.info("ask.hotkey_ignored", { at: now - lastAskPress, chord });
          return;
        }
        lastAskPress = now;
        openAsk();
      },
      [sc.stop.accel]: () => stopEverything("hotkey"), [sc.mute.accel]: () => toggleMute(),
    };
    const registerShortcuts = () => {
      const taken: string[] = [];
      for (const [accel, fn] of Object.entries(shortcuts)) {
        if (globalShortcut.isRegistered(accel)) continue;
        if (!globalShortcut.register(accel, fn)) taken.push(accel);
      }
      const changed = JSON.stringify(taken) !== JSON.stringify(shortcutsTaken ?? []);
      if (taken.length && changed) log.warn("shortcut.unavailable", { taken });
      shortcutsTaken = taken;
      return taken;
    };
    if (registerShortcuts().length) {
      const retry = setInterval(() => { if (!registerShortcuts().length) clearInterval(retry); }, 60_000);
      retry.unref?.();
    }

    // Connect the brain. EMBER_TEST_PROVIDER_URL points it at an offline OpenAI-compatible server (tests, demos).
    tokens = new TokenStore(path.join(userData, "github-token.bin"), safeStorage);
    // The administrator can point Ember at the organisation's own endpoint (BYOK) instead of Copilot sign-in.
    let adminKey: string | undefined;
    try { adminKey = policy.provider ? sys.adminPolicy.providerApiKey(policy.provider) : undefined; } catch (err) { log.error("admin_policy.api_key_unreadable", { err }); }
    const testProvider = devEnv("EMBER_TEST_PROVIDER_URL");
    const provider = testProvider
      ? { type: "openai" as const, baseUrl: testProvider, apiKey: "test" }
      : policy.provider
        ? { type: policy.provider.type, baseUrl: policy.provider.baseUrl, apiKey: adminKey, wireApi: policy.provider.wireApi, azure: policy.provider.azure }
        : undefined;
    const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: app.isPackaged ? {} : process.env, runtimeId: sys.paths.runtimeId, exe: sys.paths.runtimeExe });
    if (!runtime.exists) log.error("agent.runtime_missing", { path: runtime.path });
    // Perception: the accessibility sidecar (text) and the window system's capture (images). Linux starts the Python
    // AT-SPI sidecar (no launch); Windows and macOS the shared host, run as Ember's own binary.
    const launch = platform.sidecarLaunch(sidecarContext());
    const sidecar = sidecarRef = new AtspiSidecar(sidecarScript(), log.child("atspi"), undefined, undefined, launch);
    app.on("will-quit", () => sidecar.stop());
    // WSL (§4.4, §4.5): WSLg apps' windows read through their distros' sidecars, named "wsl:<distro>:<app>" in the
    // window system's lists, and judged as Linux apps too (on top of today's checks, macOS's bundle ids included).
    // Without WSL every one of these is today's own, unchanged.
    const privacy = wslAwarePrivacy({ isSecurityWindow: sys.privacy.isSecurityWindow, isTerminalApp: a => isTerminalWindowApp(a.name ?? a.id, sys.apps, platform.os) });
    const wslOptions = { os: platform.os, log: log.child("wsl"), ws: () => wsRef, wsl: () => targets?.wsl ?? null, settings };
    const seenBy = wrapForWsl(sidecar, wslOptions);
    const wsSeen = ws && wrapWindowsForWsl(ws, wslOptions);
    // The host's status for the setup checks (why it couldn't start, PowerShell's language mode), asked once, after
    // the cold start (and later still at login, so the probe stays out of the way of everything else starting).
    if (launch) {
      setTimeout(() => sidecar.status().then(st => { helper = toHelperStatus(st); }, () => { helper = null; }), atLogin ? 60_000 : 10_000).unref();
    }
    perception = new Perception({
      sidecar: seenBy, x11: wsSeen, log: log.child("perception"),
      neverLook: () => settings.get().privacy.neverLook,
      // Every display in the window system's units; Electron's displays (X11's arithmetic) when none opened.
      screenBounds: () => (ws ? ws.screenBounds() : primaryScaledUnion(screen)),
      words: sys.words,
      isSecurityWindow: privacy.isSecurityWindow,
      // Remote desktops' and WSLg apps' windows are blacked out of every screenshot (Windows only; undefined elsewhere).
      isRemoteSurface: remoteSurfaceCheck(platform.os),
      // Ember steps out of its own screenshots: overlay and handle go transparent for the capture.
      hideOverlay: async () => {
        const hw = handle?.win && !handle.win.isDestroyed() ? handle.win : null;
        hw?.setOpacity(0);
        const restore = overlay ? await overlay.hideForCapture() : await new Promise<() => void>(r => setTimeout(() => r(() => {}), 60));
        return () => { restore(); if (hw && !hw.isDestroyed()) hw.setOpacity(1); };
      },
    });
    const seeing = perception;
    // Hands: the policy engine decides every action; the confirmer asks the user with bubble buttons.
    audit = new AuditLog(path.join(userData, "audit"), undefined, sys.auditSink(err => log.warn("audit.journal_failed", { err })));
    try { audit.prune(policy.auditRetentionDays ?? 30); } catch (err) { log.warn("audit.prune_failed", { err }); }
    confirmer = new Confirmer(showState, {
      // A click while Ember drives the mouse was Ember's own: never an answer (waiting for the user to let go is fine).
      // Where posted keys arrive late (macOS), neither is a chord within 500 ms of a key Ember posted itself.
      blocked: () => (borrowRef?.driving ?? false) || (inputRef?.pointerLags === true && Date.now() - (borrowRef?.lastSyntheticKeyAt ?? 0) < 500),
      onChange: questionChanged,
      keyHint: questionKeyHint,
      // A question shown in a window of Ember's own (a command, a consent card): the keys allow it only while that window
      // shows all of it (R7).
      panelReady: n => targets?.panelReady(n) ?? false,
    });
    // Linux warns xtest.unavailable when XTest is missing.
    const xinput = inputRef = platform.openInput(ws, log);
    // A borrow still running lets go (keys up, pointer home) before the connection closes.
    app.on("will-quit", () => { borrowRef?.stop(); xinput?.close(); });
    // The administrator can turn off borrowing the mouse (tier 3) and Ember's desk (tier 2).
    // The borrow says when someone starts waiting for the mouse or Ember starts driving it; the status follows.
    showBorrowing = () => {
      if (!borrow) return;
      const driving = borrow.driving;
      overlay?.setBorrowing(driving);
      // Ember's own windows let the borrowed clicks through (they sit where apps keep OK and Save buttons).
      handle?.setClickThrough(driving);
      deskViewRef?.setDriving(driving);
      setStatus("borrow", driving ? (borrow.usesMouse ? "Using your mouse: move it to take over" : "Using your keyboard: press a key or move the mouse to take over")
        : borrow.pending > 0 ? (borrow.usesMouse ? "Waiting until you let go of the mouse…" : "Waiting until you stop using the keyboard and mouse…") : null);
    };
    const borrow: CursorBorrow | null = xinput && policy.features.cursor !== false ? new CursorBorrow(xinput, {
      onChange: showBorrowing,
      // Never the ask box (it hid when the borrow took the keyboard), nor a window that isn't on screen any more.
      mayRefocus: w => !askWindow.isWindow(w) && shownWindows().some(s => s.client === w || s.id === w),
      keys: sys.keys,
    }) : null;
    borrowRef = borrow;
    // Ember's desk: started the first time a task needs it, torn down when Ember quits.
    // Desk apps get only the environment they need; the test bench's event log is passed on in development only.
    // (Linux only: there is no desk on Windows and macOS.)
    const benchLog = devEnv("EMBER_BENCH_LOG");
    const deskFactory = platform.desk;
    const deskManager = deskFactory ? deskFactory.create(log.child("desk"), benchLog ? { env: { EMBER_BENCH_LOG: benchLog } } : {}) : null;
    const deskView = new DeskView(log.child("desk-view"), on => {
      deskInControl = on;
      overlay?.setState({ tasks: on ? [] : lastState.tasks });
    }, {
      handleBounds: () => handle?.bounds ?? null,
      // Hand back returns the keyboard to the window the user was in. The click on "Take over" may already have given
      // the view the keyboard: then it is the topmost app window (the one they were in, raised when they used it).
      userFocus: () => {
        const had = focusNow();
        const back = had.ember ? shownWindows().filter(w => w.pid !== process.pid).at(-1)?.client ?? 0 : had.id;
        deskTakenFrom = back;
        return () => giveFocusBack(back);
      },
      windowId: w => ownId(w),
    });
    deskViewRef = deskView;
    let deskPlace: Promise<DeskPlace> | null = null;
    // A desk whose display died is gone: the next desk task starts a new one.
    deskManager?.onDead(() => { deskPlace = null; });
    app.on("will-quit", () => { void deskPlace?.then(p => p.close()).catch(() => undefined); deskManager?.stop(); });
    // Built whenever a window system opened: reading apps (tier 1) needs no input backend.
    const hands: Hands | undefined = wsSeen ? {
      perception, sidecar: seenBy, audit, confirmer,
      policy: new PolicyEngine({
        neverLook: () => settings.get().privacy.neverLook, grants: () => settings.get().grants,
        rateLimit: policy.maxActionsPerMinute,
        actionsAllowed: () => policy.features.actions !== false,
        confirmEveryAction: () => policy.confirmEveryAction,
        allowGrants: () => policy.allowGrants,
        // On macOS also by the installed app with that name's bundle id (Terminal renamed is still Terminal); a WSLg
        // app's also as a Linux app (§4.5).
        isTerminalApp: name => privacy.isTerminalApp({ id: name, name }),
        keys: sys.keys, os: platform.os, isSecurityWindow: privacy.isSecurityWindow,
      }),
      // The window system's units to Electron's DIP (X11: ÷ the primary scale factor).
      flyTo: b => setState({ focus: b && b.width > 2 && b.height > 2 ? wsSeen.toDip(b) : null }),
      currentWindow: () => {
        const w = wsSeen.activeWindow();
        // Ember's own windows (ask box, settings) are not a task's target.
        if (!w || w.pid === process.pid) return null;
        // A private window: its process only (a task there is refused), never its title.
        const priv = isNeverLook({ app: w.wmClass ?? "", name: w.title }, settings.get().privacy.neverLook) || privacy.isSecurityWindow({ app: w.wmClass ?? "", title: w.title });
        return priv ? { pid: w.pid ?? undefined } : { pid: w.pid ?? undefined, title: w.title };
      },
      pointer: xinput ? () => xinput.pointerState() : undefined,
      // A guide sees a keyboard user press the control it points at (Enter or Space while it has focus).
      activationKey: xinput ? (() => {
        const codes = ["Return", "KP_Enter", "space"].map(n => xinput.keycodeOf(xinput.keysymOf(n))).filter(c => c > 0);
        return () => { const down = xinput.keysDown(); return codes.some(c => down.includes(c)); };
      })() : undefined,
      // Every format the user had on the clipboard comes back after a paste, not just text (the formats are the OS's).
      clipboard: electronClipboard(clipboard, ClipboardItem, undefined, sys.clipboardFormats),
      // Offered only where the desk can start and the organisation allows it (Linux with Xvfb, xauth and dbus-daemon).
      desk: deskFactory && deskManager && deskFactory.available().ok && policy.features.desk !== false ? () => (deskPlace ??= deskFactory.openPlace(deskManager, {
        sidecarScript: sidecarScript(), log: log.child("desk"), neverLook: () => settings.get().privacy.neverLook,
        profiles: path.join(userData, "desk-profiles"), userInControl: () => deskView.userInControl,
      }).catch(err => { deskPlace = null; throw err; })) : undefined,
      // The view counts the tasks on the desk; it stays up a little after the last one leaves, so the user sees the result.
      // A task leaving a desk that has since died doesn't hide the view another task uses on the new desk.
      onDesk: deskFactory ? (place, previous) => { if (previous) deskView.leave(previous); if (place) deskView.show(place); } : undefined,
      cursor: borrow && xinput ? {
        borrow,
        findWindow: (title, pid) => xinput.findWindow(title, pid),
        // The window with keyboard focus (where typed keys would go), else the one the WM calls active.
        activeWindow: () => { const w = wsSeen.focusWindow() ?? wsSeen.activeWindow(); return w ? { app: w.wmClass, title: w.title, pid: w.pid } : null; },
        // Several tasks may borrow in turn: the state shown is the borrow's own (driving now, or someone waiting), not the last task's word.
        setBorrowing: showBorrowing,
      } : undefined,
    } : undefined;
    // Where tasks act (this computer, WSL distros, computers over SSH) and their commands (§2): made whether or not this
    // screen has hands (without them, this computer is commands only).
    // The runtime's channels hear only Ember's own bundled pages (each handler then checks which window sent it).
    const fromPage = (e: { senderFrame: { url: string } | null }) => isTrustedSender(e.senderFrame?.url ?? "");
    const ipc: IpcLike = {
      on: (channel, fn) => { ipcMain.on(channel, (e, ...args) => { if (fromPage(e)) fn({ sender: e.sender }, ...args); else log.warn("targets.ipc_untrusted", { channel }); }); },
      handle: (channel, fn) => {
        ipcMain.handle(channel, (e, ...args) => {
          if (!fromPage(e)) throw new Error(`untrusted IPC sender on ${channel}`);
          return fn({ sender: e.sender }, ...args);
        });
      },
    };
    let elevatedNow: boolean | undefined;
    targets = createTargets({
      log: log.child("targets"), os: platform.os, sys, userData, appDir: __dirname, resourcesPath: process.resourcesPath,
      execPath: process.execPath, packaged: app.isPackaged, settings, admin: () => admin, audit: () => audit, confirmer: () => confirmer,
      localHands: hands ?? null, showState: setState, notify,
      openSettings: section => { showHome(); if (section) sendToHome(IPC.focusSection, section); },
      ipc,
      // As the settings channels' guard: the settings window's own page only (critique integration-5).
      isHome: sender => !!home && !home.isDestroyed() && sender.id === home.webContents.id && isTrustedSender(home.webContents.getURL()),
      windows: { command: () => createCommandWindow(platform.os), prompt: () => createPromptWindow(platform.os) },
      fetch: (u, i) => net.fetch(u, i),
      devEnv,
      // Windows: the token's elevation, as the platform reads it (TokenElevation); elsewhere uid 0. It can't change while
      // Ember runs. A check that fails counts as elevated: every command then asks (D4.6).
      elevated: () => elevatedNow ??= (() => {
        if (platform.os !== "win32") return process.getuid?.() === 0;
        try { return sys.environment({ windows: wsState, shortcutsTaken, helper }).windows?.elevated !== false; } catch (err) { log.warn("targets.elevation_unknown", { err }); return true; }
      })(),
      // Ember's own processes now (D4.5): Electron's (main, the pages, the voice utility), the accessibility helper, and
      // everything on Ember's desk (its helper, display, bus and apps).
      emberPids: () => {
        const desk = deskManager?.running?.env.EMBER_DESK_ID;
        const pids = [...app.getAppMetrics().map(m => m.pid), sidecar.pid, deskManager?.agent?.pid, ...(desk ? deskProcesses(desk) : [])];
        return [...new Set(pids.filter((p): p is number => typeof p === "number" && p > 0))];
      },
      // macOS: Homebrew's, MacPorts' and pipx's folders that exist (apps started from Finder get launchd's PATH).
      extraPath: () => platform.os === "darwin" ? extraBinDirs(app.getPath("home")).filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }) : [],
      jobHost: platform.os === "win32" ? { execPath: process.execPath, script: path.join(__dirname, "job-host.cjs") } : null,
      // The window the user is in, for the ssh noticer (§2.7): the window system's, whether or not Ember may borrow the mouse.
      ...(wsSeen ? { activeWindow: () => { const w = wsSeen.focusWindow() ?? wsSeen.activeWindow(); return w ? { app: w.wmClass, title: w.title } : null; } } : {}),
      // The command card's key hint: only the keys Ember holds for the question up now.
      keyHint: () => heldKeys().map(k => k.hint).join(" · ") || null,
      // A computer whose connection went or where someone pressed Stop: its tasks stop here too; whose screen locked or
      // session went inactive: those that used its desktop.
      stopTasksOn: (target, only) => { agent?.cancelTasksOn(target, only); },
    });
    // Commands still running and connections are let go of when Ember quits.
    app.on("will-quit", () => { void targets?.dispose(); });
    agent = new AgentHost({
      userData, runtimePath: runtime.path, settings, log: log.child("agent"), setState, provider, admin: () => policy,
      describeScreen: () => seeing.describe(), hands,
      // Spoken without code or full addresses ("code shown in the bubble"), which nobody wants read out.
      onAnswer: text => { turnAnswer = text; if (maySpeak()) voice?.speak(spokenText(text)); },
      // A spoken request gets a short follow-up window: no need to say "Hey Ember" again.
      onTurnEnd: aborted => {
        if (lastAskByVoice && !aborted) voice?.followUp(8000, { afterQuestion: endsWithQuestion(turnAnswer) });
        lastAskByVoice = false;
        turnAnswer = "";
      },
      onStatus: status => {
        broadcast(IPC.agentStatusChanged, status);
        // The handle says why Ember can't answer yet, instead of "Ready" (in a few words: the pill is narrow).
        // Ready with a setup row holding Ember back: "Setup needed" (review #95).
        showState({ idle: idleNow(status) });
      },
      onTranscript: entries => broadcast(IPC.conversationChanged, entries),
      // Another account signed in: its conversation went, and with it what the ask box remembers (as at sign-out).
      onAccountChanged: () => { askHistory = []; },
      onTaskFinished: t => {
        if (maySpeak()) voice?.speak(spokenText(t.text));
        if (userAway() && t.status !== "cancelled") notify(t.status === "done" ? `Ember finished: ${t.title}` : `Ember couldn't finish: ${t.title}`, t.summary);
      },
      isOnline: () => net.isOnline(),
      // "Not authenticated" while GitHub can't be reached is a network problem, not a bad sign-in.
      reachable: gitHubReachable((url, init) => net.fetch(url, init)),
      // A proxy set only in GNOME Settings reaches the Copilot runtime too (it reads only HTTPS_PROXY).
      resolveProxy: url => session.defaultSession.resolveProxy(url),
      // This OS's words, keys, apps, settings and privacy vocabulary for the conductor and workers (WSLg apps among them).
      system: wslAwareSystem(sys),
      targets: targets.agent,
      // Tasks ask and are audited even where this screen has no hands (commands only, §2.6).
      taskBase: { audit, confirmer },
      // Ember's own processes for commands here and in WSL (D4.5): main's and the targets runtime's helpers', live.
      emberPids: () => targets?.emberPids() ?? [],
      // A command the user asked for is announced aloud too when replies are spoken (D4.4); its Stop is on screen.
      onAnnounce: text => { if (maySpeak()) voice?.speak(spokenText(text)); },
    });
    // The network came back (or the computer woke): a connection waiting to retry tries now. (Electron's
    // main process has no online/offline event; a VPN coming up is covered by asking, which retries too.)
    let wasOnline = net.isOnline();
    const netWatch = setInterval(() => { const on = net.isOnline(); if (on !== wasOnline) { wasOnline = on; agent?.networkChanged(on); } }, 5000);
    netWatch.unref?.();
    powerMonitor.on("resume", () => agent?.networkChanged(true));
    // The brain connects once the user has agreed to what Ember does (first run asks).
    let brainStarted = false;
    const startBrain = async () => {
      if (brainStarted || !consented()) return;
      brainStarted = true;
      const found = provider ? null : await resolveToken(tokens, process.env, ghOptions());
      log.info("auth.token", { source: testProvider ? "test-provider" : provider ? "admin-provider" : found?.source ?? "none" });
      currentToken = found?.token ?? null;
      // Found on its own (GitHub CLI, environment): not used after the user signed out of Ember
      // (then "Sign in" may use it at once, so it isn't counted as the token in use).
      const phase = await agent?.start(currentToken, found?.source, "auto");
      if (phase === "signed-out") currentToken = null;
    };
    brainStart = startBrain();
    settings.onChange(() => { const p = startBrain(); if (brainStarted) brainStart = brainStart.then(() => p); });
    // Another model chosen in settings: switched in place (running tasks keep going).
    let models = JSON.stringify(settings.get().models);
    settings.onChange(next => {
      const m = JSON.stringify(next.models);
      if (m !== models) { models = m; void agent?.setModels(next.models); }
    });

    // ───── Voice ─────
    const speechModels = voiceModelsRoot();
    if (speechModels.bundled) log.info("voice.models_bundled", { root: speechModels.root });
    voice = new VoiceService({
      log: log.child("voice"),
      modelsRoot: speechModels.root,
      // Speaker rejection needs PulseAudio's monitor sources (Linux only); elsewhere the setting says so.
      monitor: settings.get().voice.speakerRejection && sys.voice.speakerMonitor,
      // Where the system that refused it lets the user allow it (the setup check has a button for it). Named without
      // a menu path: it differs between Windows 10 ("Privacy"), Windows 11 and macOS ("Privacy & Security").
      micHint: sys.fixes.ids.includes("open-microphone-settings") ? `To allow it, open the microphone's privacy settings in ${sys.words.settingsApp}.` : undefined,
      onEvent: onVoice,
      onSpeech: ok => {
        if (speechHeard === ok) return;
        speechHeard = ok;
        log.info("voice.speech", { ok });
        broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
      },
      onState: (state, detail) => {
        voiceDetail = detail;
        setState({ mic: state });
        // The microphone went off (muted, listening turned off, the voice process died): nothing more will be
        // heard, so "Listening…" goes (the bubble is given back), and so do a follow-up window's status line and
        // listening pose (its "listening off" never comes now).
        if (state !== "active" && state !== "waiting") {
          if (statusBy.listen) setStatus("listen", null);
          if (lastState.bubble.mood === "listening") {
            setState({ emotion: "neutral", bubble: IDLE_BUBBLE });
            agent?.releaseBubble(lastState.bubble);
          } else if (lastState.emotion === "listening") setState({ emotion: "neutral" });
        }
        broadcast(IPC.voiceStatus, voiceStatus(detail));
      },
    });
    if (settings.get().voice.muted) voice.setMuted(true);
    const wantVoice = () => settings.get().wakeWord && settings.get().voice.consent && consented();
    void voice.setWanted(wantVoice());
    let wanted = wantVoice();
    let micConsent = settings.get().voice.consent;
    settings.onChange(next => {
      // macOS asks for the microphone once listening is agreed to, so its prompt comes with that context.
      if (next.voice.consent && !micConsent) sys.lifecycle.askMicrophone?.().catch(err => log.warn("voice.mic_ask_failed", { err }));
      micConsent = next.voice.consent;
      if (wantVoice() !== wanted) { wanted = wantVoice(); void voice?.setWanted(wanted); }
    });
    app.on("will-quit", () => voice?.stop());

    // Started by the user (the launcher, a terminal), settings opens; started at login (--autostart), Ember only greets.
    if (!settings.get().onboarded || process.argv.includes("--show-settings") || !atLogin) showHome();
    // The hello waits for Copilot to connect (at most a few seconds), so it doesn't say "not connected" too early.
    else setTimeout(() => void Promise.race([brainStart, new Promise(r => setTimeout(r, 5000))]).then(() => greet()), 800);
    // macOS: opening Ember.app again (Dock, Finder) reactivates this one instead of starting a second, so settings
    // opens. Listened for only from here: Electron documents "activate" for a first launch too, and at login that would
    // open settings over the decision just made.
    if (sys.lifecycle.reopenShowsSettings) app.on("activate", () => showHome());

    if (devEnv("EMBER_TEST_HOOKS") === "1") {
      (globalThis as Record<string, unknown>).__ember = {
        settings, setState, greet, showHome, overlay: () => overlay, handle: () => handle,
        agent: () => agent, perception: () => perception, confirmer: () => confirmer, voice: () => voice, deskView: () => deskView, ask: (text: string) => { captureContext(); return askEmber(text); }, showAsk: () => openAsk({ source: "test" }),
        showMenu, state: () => lastState,
      };
    }
  };
}
