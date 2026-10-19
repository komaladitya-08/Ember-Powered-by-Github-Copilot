/**
 * Ember main process: single instance, settings, logging, environment checks,
 * the windows (home, overlay, handle, ask box), the Copilot brain, perception,
 * hands and voice, and the wiring between them.
 */

import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, net, Notification, powerMonitor, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createLogger, type LogLevel } from "./logger";
import { SettingsStore, hasConsent, type SettingsPatch } from "./settings";
import { loadAdminPolicy, managedKeys, providerApiKey } from "./admin";
import { inspectEnvironment, type EnvReport } from "./environment";
import { createHomeWindow, isTrustedSender } from "./windows";
import { IPC, type Status, type SignInProgress, type AskContext } from "../shared/ipc";
import { OVERLAY, IDLE_BUBBLE, type EmberState, type Rect } from "../shared/overlay";
import { OverlayManager } from "./overlay";
import { HandleWindow } from "./handle";
import { revive } from "./revive";
import { openX11 } from "./x11";
import { friendlyApp } from "../shared/apps";
import { AtspiSidecar, pickPython } from "./perception/sidecar";
import { isNeverLook } from "./perception/elements";
import { isSecurityWindow } from "./policy/policy";
import { Perception, type QuickContext } from "./perception";
import { AskWindow } from "./ask";
import { VoiceService, voicePermissions } from "./voice";
import type { VoiceEvent } from "../voice/engine";
import { VOICE_MODELS_BYTES, modelsReady } from "../voice/models";
import { doctorChecks, formatDoctor, type DoctorProbes } from "./doctor";
import { launchCommand, syncAutostart } from "./autostart";
import { AuditLog, journalSink } from "./policy/audit";
import { KillSwitch } from "./agent/killswitch";
import { PolicyEngine } from "./policy/policy";
import { Confirmer, guardWhileAsking } from "./agent/confirm";
import { openXInput, xinputError } from "./hands/input";
import { handClipboardToManager, readSelection } from "./hands/clipboard-handoff";
import { CursorBorrow } from "./hands/borrow";
import { holdKeyboard } from "./hands/keybuffer";
import { DeskManager } from "./desk/desk";
import { openDeskPlace, type DeskPlace } from "./desk/place";
import { isTerminalApp } from "./hands/system";
import { DeskView } from "./desk/view";
import { AgentHost, explainStartError, gitHubReachable, idleWord, inotifyUse, type Hands } from "./agent/host";
import { expandedBubble } from "./agent/presenter";
import { electronClipboard } from "./agent/clipboard";
import { locateRuntime } from "./agent/runtime";
import { TokenStore, resolveToken, startDeviceFlow, pollDeviceFlow } from "./agent/auth";
import { endsWithQuestion, spokenText } from "../voice/spoken";
import { readAgentState } from "./agent/conductor";


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

// Chromium on Linux speaks (speechSynthesis) only through speech-dispatcher, and only with this switch.
if (process.platform === "linux") app.commandLine.appendSwitch("enable-speech-dispatcher");

// ~/.config/ember unless overridden (tests use a temp dir).
app.setName("ember");
app.setPath("userData", process.env.EMBER_USER_DATA ?? path.join(app.getPath("appData"), "ember"));
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
    dialog.showErrorBox("Ember couldn't start", `${message}\n\nThe details are in ${log.file}.`);
    app.exit(1);
  });
}

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

let pyatspiPresent: boolean | null = null;
let pyatspiProbed = 0;
/** Set once Ember has tried the X display, and once it knows which shortcuts it got. */
let x11Reachable: boolean | undefined;
let shortcutsTaken: string[] | undefined;

/** Is the GNOME accessibility switch on, and can the sidecar's Python import pyatspi? */
function probeAccessibility(): { enabled: boolean | null; pyatspi: boolean } {
  let enabled: boolean | null = null;
  try {
    const out = execFileSync("gsettings", ["get", "org.gnome.desktop.interface", "toolkit-accessibility"], { encoding: "utf8", timeout: 2000 });
    enabled = out.trim() === "true";
  } catch { /* no gsettings (not GNOME) */ }
  // Asked again (at most every 30 s) while it is missing: the user may have just installed it.
  if (pyatspiPresent === null || (!pyatspiPresent && Date.now() - pyatspiProbed > 30_000)) {
    pyatspiProbed = Date.now();
    try {
      execFileSync(pickPython(), ["-c", "import pyatspi"], { stdio: "ignore", timeout: 5000 });
      pyatspiPresent = true;
    } catch {
      pyatspiPresent = false;
    }
  }
  return { enabled, pyatspi: pyatspiPresent };
}

function readEnvironment(): EnvReport {
  let osRelease: string | null = null;
  try { osRelease = fs.readFileSync("/etc/os-release", "utf8"); } catch { /* not Linux */ }
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return inspectEnvironment({
    env: process.env,
    osRelease,
    glibc: header?.glibcVersionRuntime ?? null,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    platform: process.platform,
    arch: process.arch,
    accessibility: process.platform === "linux" ? probeAccessibility() : undefined,
    x11: x11Reachable,
    shortcutsTaken,
  });
}

/** Speech models installed with Ember (the ember-voice-models package) are used in place of a download. */
function voiceModelsRoot(): { root: string; bundled: boolean } {
  const bundled = [devEnv("EMBER_VOICE_MODELS"), "/usr/share/ember/voice-models", path.join(process.resourcesPath ?? "", "voice-models")]
    .find((d): d is string => !!d && modelsReady(d));
  return bundled ? { root: bundled, bundled: true } : { root: path.join(userData, "models"), bundled: false };
}

const which = (cmd: string) => (process.env.PATH ?? "/usr/bin:/bin").split(":").some(d => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });

async function runDoctor(): Promise<void> {
  await app.whenReady();
  const x11 = process.env.DISPLAY ? openX11() : null;
  x11Reachable = process.env.DISPLAY ? !!x11 : undefined;
  const env = readEnvironment();
  const xin = x11 ? openXInput() : null;
  const admin = loadAdminPolicy(devEnv("EMBER_ADMIN_POLICY"));
  const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: app.isPackaged ? {} : process.env });
  let auth: DoctorProbes["auth"] = null;
  if (admin.policy.provider) auth = { kind: "provider", host: new URL(admin.policy.provider.baseUrl).host };
  else {
    const t = await resolveToken(new TokenStore(path.join(userData, "github-token.bin"), safeStorage)).catch(() => null);
    // After "Sign out" in Ember, a GitHub CLI or environment sign-in isn't used (as Ember itself does).
    const ignored = !!t && (t.source === "environment" || t.source === "github-cli") && readAgentState(path.join(userData, "agent.json")).signedOut;
    if (t && !ignored) auth = { kind: "github", source: t.source };
  }
  let microphones: string[] | null;
  try {
    microphones = execFileSync("pactl", ["list", "short", "sources"], { encoding: "utf8", timeout: 3000 })
      .split("\n").map(l => l.split("\t")[1]).filter((n): n is string => !!n && !n.endsWith(".monitor"));
  } catch { microphones = which("pactl") ? [] : null; }
  const models = voiceModelsRoot();
  let userNamespaces = false;
  try { userNamespaces = Number(fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8")) > 0; } catch { /* not Linux */ }
  try { if (fs.readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf8").trim() === "0") userNamespaces = false; } catch { /* not Debian */ }
  let suidHelper = false;
  try { const st = fs.statSync(path.join(path.dirname(process.execPath), "chrome-sandbox")); suidHelper = st.uid === 0 && (st.mode & 0o4000) !== 0; } catch { /* none */ }
  const checks = doctorChecks({
    env, compositor: x11 ? x11.hasCompositor() : null, xtest: x11 ? !!xin : null,
    // What Chromium speaks through (spd-say isn't packaged on RHEL 8, so it can't be the test).
    speechDispatcher: which("speech-dispatcher") || ["/usr/lib64/libspeechd.so.2", "/usr/lib/x86_64-linux-gnu/libspeechd.so.2"].some(f => fs.existsSync(f)), microphones,
    voiceModels: models.bundled ? "bundled" : modelsReady(models.root) ? "downloaded" : "missing",
    runtime: runtime.exists, auth, admin, desk: DeskManager.available(), sandbox: { userNamespaces, suidHelper },
    fileWatchers: inotifyUse(),
  });
  process.stdout.write(`Ember ${app.getVersion()} check-up\n\n${formatDoctor(checks)}\n`);
  xin?.close();
  x11?.close();
  app.exit(checks.some(c => c.status === "fail") ? 1 : 0);
}

function start(): void {
  // The administrator's policy (/etc/ember/policy.json) overrides the user's settings.
  const admin = loadAdminPolicy(devEnv("EMBER_ADMIN_POLICY"));
  if (admin.error) log.error("admin_policy.invalid", { error: admin.error, note: "locked down until it is fixed" });
  else if (admin.source) log.info("admin_policy.loaded", { file: admin.source });
  const policy = admin.policy;
  const settings = new SettingsStore(path.join(userData, "settings.json"), policy);
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
  /**
   * One of Ember's own windows comes to the front with the keyboard. A window manager that prevents focus stealing
   * (xfwm4, Mutter) keeps a window Ember opens from its overlay or a hotkey behind the user's app otherwise: Ember asks
   * as a pager does (a direct user action), which they honour.
   */
  const bringToFront = (win: BrowserWindow) => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    try { const xid = win.getNativeWindowHandle().readUInt32LE(0); if (xid) xinputRef?.activate(xid); } catch { /* not X11 */ }
  };
  const showHome = () => {
    // A bubble that only points to settings (a greeting, "Read all") goes: settings has it now.
    if (lastState.bubble.visible && lastState.bubble.actions.length && lastState.bubble.actions.every(a => a.id.startsWith("ui:"))) setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
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

  ipcMain.handle(IPC.getStatus, guard((): Status => ({
    appVersion: app.getVersion(),
    settings: settings.get(),
    environment: readEnvironment(),
    logFile: log.file,
    settingsNotice,
    admin: { source: admin.source, error: admin.error ?? null, managed: managedKeys(policy), features: policy.features, provider: policy.provider?.baseUrl ?? null,
      confirmEveryAction: policy.confirmEveryAction, allowGrants: policy.allowGrants, retentionDays: policy.auditRetentionDays ?? 30,
      neverLook: policy.neverLook },
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
  ipcMain.handle(IPC.updateSettings, guard((patch: SettingsPatch) => {
    const sizeOnly = !!patch && typeof patch === "object" && Object.keys(patch).length === 1 && "size" in patch;
    return settings.update(ownNeverLook(patch), { soon: sizeOnly });
  }));
  ipcMain.handle(IPC.applyFix, guard((fix: string) => {
    if (fix !== "enable-accessibility") throw new Error(`unknown fix: ${fix}`);
    execFileSync("gsettings", ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"], { timeout: 5000 });
    log.info("fix.applied", { fix });
    return readEnvironment();
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

  /** Hides `bubble` later, unless something else has replaced it by then. */
  const hideIfStill = (bubble: EmberState["bubble"], ms: number) => setTimeout(() => {
    if (lastState.bubble === bubble) setState({ emotion: "neutral", bubble: IDLE_BUBBLE });
  }, ms);
  /** Whether one of Ember's own shortcuts works (another app may hold it). */
  const hasKey = (accel: string) => !(shortcutsTaken ?? []).includes(accel);
  const greet = () => {
    const phase = agent?.getStatus().phase;
    const connected = phase !== "signed-out" && phase !== "error";
    // Offline at start (a retry waits for the network): Ember connects by itself, there is nothing to set up.
    const waiting = phase === "error" && (agent?.waitingForNetwork ?? false);
    const keys = hasKey("Control+Alt+Space") && hasKey("Control+Alt+X")
      ? "Press Ctrl+Alt+Space to ask me anything; Ctrl+Alt+X stops me."
      : "Click my handle in the corner to ask me something or to stop me.";
    const settingsOpen = homeOpen();
    const thought = waiting ? "I can't reach GitHub yet: I'll connect as soon as the network is back."
      : !connected
      ? settingsOpen ? "I'm not connected to Copilot yet: connect me in the settings window." : `I'm not connected to Copilot yet. Open settings${hasKey("Control+Alt+E") ? " (Ctrl+Alt+E)" : ""} to connect me.`
      : overlay ? `I'll stay by your cursor. ${keys}` : `This session can't show me beside your cursor, so I'll wait here. ${keys}`;
    const bubble = { ...IDLE_BUBBLE, visible: true, mood: connected ? "idle" as const : waiting ? "error" as const : "attention" as const, title: "Hi, I'm Ember!", thought,
      actions: connected || settingsOpen || waiting ? [] : [{ id: "ui:settings", label: "Open settings" }] };
    setState({ emotion: "happy", talking: true, bubble });
    if (greetTimer) clearTimeout(greetTimer);
    setTimeout(() => setState({ talking: false }), 1600);
    greetTimer = hideIfStill(bubble, connected ? 7000 : 15000);
  };

  const busyTasks = () => agent?.tasks?.list().filter(t => t.status === "running" || t.status === "queued").length ?? 0;
  /**
   * Quitting with tasks under way asks first (they would stop half-way). One question at a time: Quit chosen
   * again while it is up (perhaps behind a window now) closes it and asks again on top.
   */
  let quitAsking: AbortController | null = null;
  const quitEmber = async (): Promise<void> => {
    const n = busyTasks();
    if (!n) { app.quit(); return; }
    quitAsking?.abort();
    const mine = quitAsking = new AbortController();
    try {
      const { response } = await dialog.showMessageBox({
        type: "question", buttons: ["Keep Ember running", "Stop and quit"], defaultId: 0, cancelId: 0, signal: mine.signal,
        title: "Quit Ember?", message: `Ember is still working on ${n === 1 ? "a task" : `${n} tasks`}.`, detail: "Quitting stops it where it is.",
      });
      if (!mine.signal.aborted && response === 1) app.quit();
    } finally {
      if (quitAsking === mine) quitAsking = null;
    }
  };
  /** The handle's menu is open (or opening): a second click doesn't open another one over it. */
  let menuOpen = false;
  /** The app window the user was last in (an X client window), for giving focus back after Ember's own windows. */
  let userWindow = 0;
  /** The window the ask box was opened over (it may be one of Ember's: settings, the quit question). */
  let askOver = 0;
  /** The window the user took Ember's desk over from (the keyboard goes back there on hand back). */
  let deskTakenFrom = 0;
  /**
   * The window with the keyboard now (an X client window, 0 if none), noted as the user's when it isn't Ember's.
   * `ember`: it is one of Ember's own (settings, the desk view, the quit question, the ask box).
   */
  const focusNow = (): { id: number; ember: boolean } => {
    const f = x11Ref?.focusWindow();
    if (!f) return { id: 0, ember: false };
    if (f.pid !== process.pid) userWindow = f.id;
    return { id: f.id, ember: f.pid === process.pid };
  };
  /**
   * Focus goes back to `back` (the window that had it, Ember's settings or quit question included) while it is still
   * up; else to the user's window, or, when that has gone too, to the topmost app window that isn't Ember's.
   */
  /** Windows on screen, bottom to top. */
  const shownWindows = () => x11Ref?.stack().filter(w => w.title && w.width > 1 && w.height > 1) ?? [];
  const giveFocusBack = (back: number) => {
    const shown = shownWindows();
    // Never the ask box: activating its X window would map it without openAsk (a click into the app looked like Ask opening).
    if (back && askWindow.isWindow(back)) back = askOver && !askWindow.isWindow(askOver) ? askOver : 0;
    if (back && shown.some(w => w.client === back)) { xinputRef?.activate(back); return; }
    const apps = shown.filter(w => w.pid !== process.pid);
    const to = apps.some(w => w.client === userWindow) ? userWindow : apps.at(-1)?.client ?? userWindow;
    if (to && !askWindow.isWindow(to)) xinputRef?.activate(to);
  };
  const showMenu = () => {
    if (!handle || menuOpen) return;
    const win = handle.win;
    const paused = followPaused;
    const hidden = overlay?.isHidden() ?? false;
    // The shortcut is part of the label (Chromium would print it "Alt+Ctrl+…"), and left out when another app holds it.
    const label = (text: string, accel: string) => hasKey(accel) ? `${text}   ${accel.replace("Control", "Ctrl")}` : text;
    // An item that opens one of Ember's windows (the ask box, settings, the quit question) keeps the focus it
    // takes: the user's app doesn't get it back over the window (settings shows only once it has loaded).
    let opens = false;
    // Linux: Esc (or releasing the click that opened the menu) can fire the first item. Ignore clicks after the menu
    // has started closing; a real pick runs before menu-will-close.
    let menuClosing = false;
    const menu = Menu.buildFromTemplate([
      // What the user was in was read before the handle took focus: looking again would find the handle.
      { label: label("Ask Ember…", "Control+Alt+Space"), registerAccelerator: false, click: () => {
        if (menuClosing) { log.info("ask.menu_ignored", { reason: "menu-closing" }); return; }
        opens = true; openAsk({ look: false, over: back, source: "menu" });
      } },
      { label: label("Stop everything", "Control+Alt+X"), registerAccelerator: false, click: () => stopEverything("menu") },
      ...(voice && settings.get().wakeWord && settings.get().voice.consent
        ? [{ label: label(voice.isMuted ? "Unmute microphone" : "Mute microphone", "Control+Alt+M"), registerAccelerator: false, click: toggleMute }]
        : []),
      ...(agent?.lastAnswer() ? [{ label: "Read the last answer", click: () => { opens = true; readLastAnswer(); } }] : []),
      { type: "separator" },
      { label: label("Settings…", "Control+Alt+E"), registerAccelerator: false, click: () => { opens = true; showHome(); } },
      { label: paused ? "Follow my cursor" : "Stay put", enabled: !!overlay, click: () => { followPaused = !paused; overlay?.setPaused(followPaused); presenceChanged(); } },
      { label: hidden ? "Show Ember" : "Hide Ember", enabled: !!overlay, click: () => { shownForAnswer = false; keptHidden = !hidden; overlay?.setHidden(!hidden); presenceChanged(); } },
      { type: "separator" },
      { label: "Quit Ember", click: () => { opens = busyTasks() > 0; void quitEmber(); } },
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
    const xid = Number(win.getNativeWindowHandle().readUInt32LE(0));
    // Open once the keyboard is really on the handle, and has stayed there: the X server says so, and Electron has
    // seen the focus come (each can come first; a focus change after the menu opened closed it at once, and with no
    // window manager its keys went to the app behind).
    let focusSeen = win.isFocused();
    const onFocus = () => { focusSeen = true; };
    win.on("focus", onFocus);
    const hasKeyboard = () => focusSeen && win.isFocused() && (!x11Ref || x11Ref.focusWindow()?.id === xid);
    let opened = false, steady = 0;
    const go = () => {
      if (opened) return;
      opened = true; clearInterval(poll); clearTimeout(late); win.off("focus", onFocus);
      if (win.isDestroyed()) menuOpen = false; else open();
    };
    // Nor while the click on the handle is still held: the menu opens under the pointer, and the release would choose
    // its first item ("Ask Ember…": the ask box opened by itself).
    const released = () => ((x11Ref?.pointer()?.mask ?? 0) & 0x1f00) === 0;
    const poll = setInterval(() => { if (win.isDestroyed()) go(); else if (hasKeyboard() && released()) { if (++steady >= 2) go(); } else steady = 0; }, 10);
    // No focus within a moment (no X input here): the menu opens anyway, once the button is up (at most a second).
    const menuAsked = Date.now();
    const late = setTimeout(function later() { if (released() || Date.now() - menuAsked > 1000) go(); else setTimeout(later, 20); }, 250);
    win.focus();
    if (xinputRef?.focusInput) xinputRef.focusInput(xid);
  };
  let followPaused = false;
  let presenceChanged = () => { /* set once the IPC is ready */ };
  /** The whole answer in settings; the bubble goes, so Ember doesn't sit over it holding the old one. */
  const readLastAnswer = () => {
    // The answer being read in full goes from the bubble (with or without a "Read all" button).
    if (lastState.bubble.visible && lastState.bubble.actions.every(a => a.id.startsWith("ui:"))) setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
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
    const phase = agent?.getStatus().phase;
    if (phase === "signed-out" || phase === "error") sendToHome(IPC.focusSection, "copilot");
  };

  const sendToHome = (channel: string, value: unknown) => {
    const send = () => { if (home && !home.isDestroyed()) home.webContents.send(channel, value); };
    if (home && !home.isDestroyed() && home.webContents.isLoading()) home.webContents.once("did-finish-load", send); else send();
  };
  /**
   * Questions are answered with keys too (Orca and keyboard users can't click the bubble): Y allows, N says
   * not now. "Always" is a click only: a global key would take an app's own Ctrl+Alt+A and grant for good.
   */
  const QUESTION_KEYS = [
    { accel: "Control+Alt+Y", which: "primary", hint: "Ctrl+Alt+Y allow", say: "Control Alt Y to allow" },
    { accel: "Control+Alt+N", which: "deny", hint: "Ctrl+Alt+N not now", say: "Control Alt N for not now" },
  ] as const;
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
  const questionChanged = (q: { question: { prompt: string; options: { id: string }[] } } | null) => {
    if (!q) {
      for (const k of questionKeys) globalShortcut.unregister(k);
      questionKeys = [];
      return;
    }
    holdQuestionKeys();
    // A question nobody can see expires as "no": a hidden Ember shows itself to ask (and stays shown,
    // also when the compositor comes back while the question is on the card).
    keptHidden = false;
    if (overlay?.isHidden()) { overlay.setHidden(false); presenceChanged(); }
    if (maySpeak()) {
      const keys = heldKeys().map(k => k.say);
      voice?.speak(`Ember asks: ${spokenText(q.question.prompt)}${keys.length ? ` Press ${keys.join(", or ")}.` : ""}`);
    }
    if (userAway()) notify("Ember needs your OK", q.question.prompt);
  };
  /** The user isn't looking at Ember right now (idle, or Ember hidden). */
  const userAway = () => (overlay?.isHidden() ?? false) || powerMonitor.getSystemIdleTime() >= 30;
  const notify = (title: string, body: string) => {
    try { if (Notification.isSupported()) new Notification({ title, body: body.slice(0, 240), silent: false }).show(); } catch (err) { log.warn("notify.failed", { err }); }
  };
  let screenReader: boolean | null = null;
  /** Orca running: speak questions and results even without "Speak replies". */
  const screenReaderOn = () => {
    if (screenReader === null) {
      try { screenReader = execFileSync("gsettings", ["get", "org.gnome.desktop.a11y.applications", "screen-reader-enabled"], { encoding: "utf8", timeout: 2000 }).trim() === "true"; } catch { screenReader = false; }
      setTimeout(() => { screenReader = null; }, 60_000).unref?.();
    }
    return screenReader || app.isAccessibilitySupportEnabled();
  };
  let askHistory: string[] = [];
  /** Speak replies (or a screen reader runs), unless the organisation turned speaking off. */
  const maySpeak = () => policy.features.speak !== false && (settings.get().speak || screenReaderOn());

  // ───── Copilot brain ─────
  const askWindow = new AskWindow({
    keepOff: () => handle?.bounds ?? null,
    // As the handle's menu takes the keyboard: the window manager is asked, and X is told too.
    takeFocus: xid => { xinputRef?.activate(xid); xinputRef?.focusInput?.(xid); },
    onReveal: source => log.info("ask.reveal", { source }),
  });
  let agent: AgentHost | null = null;
  let perception: Perception | null = null;
  let voice: VoiceService | null = null;
  /** Where the user was when they last called Ember (taken before anything of Ember's takes focus). */
  let callContext: Promise<QuickContext | null> = Promise.resolve(null);
  // Nothing is read from the screen or sent anywhere until the user has agreed (M8.8).
  const consented = () => hasConsent(settings.get());
  const captureContext = () => {
    if (!perception || !consented()) { callContext = Promise.resolve(null); return; }
    // What is selected in the user's window, asked for now (some apps don't tell it through accessibility).
    const active = x11Ref?.activeWindow();
    const selected = active && active.pid !== process.pid ? readSelection({ sameClientAs: active.id }).catch(() => "") : Promise.resolve("");
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
    // The window it opens over (Ember's settings included): the handle's menu gives focus back there.
    askOver = look ? focusNow().id : over;
    if (look) captureContext();
    // From the hotkey, letters typed before the box has the keyboard would go to the user's app: Ember holds the
    // keyboard meanwhile and hands what was typed to the box.
    const held = look ? holdKeyboard() : null;
    askWindow.show(overlay ? { ...overlay.position, size: settings.get().size } : null, { sees: null, history: askHistory }, source);
    if (held) void askWindow.hasKeyboard().then(() => askWindow.typed(held.stop()), () => held.stop());
    // What Ember will read, shown as a chip once the quick look is done.
    void callContext.then(c => {
      const t = c?.target;
      const sees = t ? [t.app && friendlyApp(t.app), t.title].filter(Boolean).join(" · ") || null : null;
      const ctx: AskContext = { sees: sees && sees.length > 80 ? sees.slice(0, 79) + "…" : sees, history: askHistory };
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
  let xinputRef: ReturnType<typeof openXInput> = null;
  let x11Ref: ReturnType<typeof openX11> = null;
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
    modelsReady: voice?.modelsReady ?? false, modelsBytes: VOICE_MODELS_BYTES,
  });
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
  // Packaged builds ship the sidecar under resources/; development runs it from the repo.
  const sidecarScript = () => app.isPackaged
    ? path.join(process.resourcesPath, "sidecar", "atspi", "ember_atspi.py")
    : path.join(app.getAppPath(), "sidecar", "atspi", "ember_atspi.py");
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
    return explainStartError(err, { online: net.isOnline() });
  };
  /** "Check again": look for a sign-in (Ember's own, the environment, gh) and reconnect with it. */
  const retrySignIn = async (): Promise<{ found: boolean; source: string | null }> => {
    if (!consented()) { showHome(); return { found: false, source: null }; }
    const found = await resolveToken(tokens).catch(() => null);
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
        const found = await resolveToken(tokens).catch(() => null);
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
      await connected(await agent?.start(token, "stored"), kept ? undefined : "Signed in. No keyring is available, so you'll need to sign in again next time.");
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
    // Stopping a task is always honoured (also while Ember waits for the mouse). Anything else that arrives
    // while Ember really drives the pointer was Ember's own click, not the user's: ignored.
    if (borrowRef?.driving && !(task && task[2] === "stop")) { log.warn("bubble.action_while_borrowing", { id }); return; }
    if (id === "ui:settings") { openSettings(); return; }
    if (id === "ui:more") { expandAnswer(); return; }
    if (id === "ui:conversation") { readLastAnswer(); return; }
    if (id === "ui:close") { closeExpanded(); return; }
    if (task) {
      if (task[2] === "stop") agent?.tasks?.cancel(task[1]); else agent?.tasks?.dismiss(task[1]);
      log.info("task.card_action", { action: task[2] });
      return;
    }
    log.info("bubble.action", { id, handled: confirmer?.answer(id) ?? false });
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
  // "Start Ember when I log in" keeps ~/.config/autostart/ember.desktop in step.
  const autostart = () => {
    try {
      if (syncAutostart(settings.get().startAtLogin, launchCommand({ packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath() }))) {
        log.info("autostart.updated", { on: settings.get().startAtLogin });
      }
    } catch (err) { log.warn("autostart.failed", { err }); }
  };
  autostart();
  settings.onChange(autostart);
  if (process.argv.includes("--autostart")) log.info("app.autostart");
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
      // Setup finished: get out of the way so the user sees Ember say hello. If Copilot isn't
      // connected, the window stays and shows how to connect (asking would only say "not connected").
      void settledPhase().then(phase => {
        if (phase === "signed-out" || phase === "error") {
          // Settings stays open at Copilot; Ember says hello once it closes, not over it.
          sendToHome(IPC.focusSection, "copilot");
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

  // An X id of one of Ember's windows, taken while they exist (at will-quit they are gone): the clipboard's
  // owner is told apart by it.
  let emberXid = 0;
  app.on("browser-window-created", (_e, w) => {
    if (!emberXid && process.env.DISPLAY) try { emberXid = Number(w.getNativeWindowHandle().readUInt32LE(0)); } catch { /* not X11 */ }
  });
  // Quitting waits (up to 3 s) for the brain to stop: that is when this run's conversation is deleted. Meanwhile a
  // clipboard Ember holds (after a paste it put the user's back) goes to the clipboard manager (≤ 2 s), or
  // quitting would empty it.
  let quitting = false;
  app.on("will-quit", e => {
    globalShortcut.unregisterAll();
    overlay?.stop();
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    const brain = agent ? Promise.race([agent.stop(), new Promise(r => setTimeout(r, 3000))]).catch(() => undefined) : Promise.resolve();
    const clip = emberXid
      ? handClipboardToManager({ ourWindow: emberXid }).then(result => log.info("clipboard.handoff", { result }), err => log.warn("clipboard.handoff_failed", { err }))
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
    const x11 = x11Ref = process.env.DISPLAY ? openX11() : null;
    x11Reachable = process.env.DISPLAY ? !!x11 : undefined;
    const env = readEnvironment();
    let compositing = x11 ? x11.hasCompositor() : false;
    askWindow.setOpaque(!compositing);
    // Made now (hidden), so Ctrl+Alt+Space opens it at once: a box still loading took the first letters typed.
    if (consented()) askWindow.prepare();
    // X11 has one global scale factor; XQueryPointer reports physical pixels.
    const cursor = () => {
      const p = x11?.pointer();
      if (!p) return screen.getCursorScreenPoint();
      const scale = screen.getPrimaryDisplay().scaleFactor || 1;
      return { x: p.x / scale, y: p.y / scale, buttons: p.mask & 0x1f00 };
    };
    app.on("will-quit", () => x11?.close());
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
      const o = new OverlayManager(() => settings.get(), log.child("overlay"), cursor);
      // GNOME's "Animations" switch off counts as asking for calm mode.
      try { o.systemReducedMotion = execFileSync("gsettings", ["get", "org.gnome.desktop.interface", "enable-animations"], { encoding: "utf8", timeout: 2000 }).trim() === "false"; } catch { /* not GNOME */ }
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
      handle = new HandleWindow(() => settings.get(), !overlay);
      handle.sendState(lastState);
      old?.destroy();
      deskViewRef?.handleMoved();
    };
    if (compositing) makeOverlay();
    else log.warn("overlay.fallback", { reason: "no compositing manager; using the handle card" });
    makeHandle();
    // The compositor can go and come back (GNOME Shell restarting, another window manager): Ember follows,
    // so its full-screen overlay never turns the desktop black.
    if (x11) {
      const watch = setInterval(() => {
        const now = x11.hasCompositor();
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
    const shortcuts: Record<string, () => void> = {
      "Control+Alt+E": showHome, "Control+Alt+Space": () => openAsk(), "Control+Alt+X": () => stopEverything("hotkey"), "Control+Alt+M": () => toggleMute(),
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
    try { adminKey = policy.provider ? providerApiKey(policy.provider) : undefined; } catch (err) { log.error("admin_policy.api_key_unreadable", { err }); }
    const testProvider = devEnv("EMBER_TEST_PROVIDER_URL");
    const provider = testProvider
      ? { type: "openai" as const, baseUrl: testProvider, apiKey: "test" }
      : policy.provider
        ? { type: policy.provider.type, baseUrl: policy.provider.baseUrl, apiKey: adminKey, wireApi: policy.provider.wireApi, azure: policy.provider.azure }
        : undefined;
    const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: app.isPackaged ? {} : process.env });
    if (!runtime.exists) log.error("agent.runtime_missing", { path: runtime.path });
    // Perception: the accessibility sidecar (text) and X11 capture (images).
    const sidecar = new AtspiSidecar(sidecarScript(), log.child("atspi"));
    app.on("will-quit", () => sidecar.stop());
    perception = new Perception({
      sidecar, x11, log: log.child("perception"),
      neverLook: () => settings.get().privacy.neverLook,
      screenBounds: () => {
        const scale = screen.getPrimaryDisplay().scaleFactor || 1;
        const all = screen.getAllDisplays().map(d => d.bounds);
        const x0 = Math.min(...all.map(b => b.x)), y0 = Math.min(...all.map(b => b.y));
        const x1 = Math.max(...all.map(b => b.x + b.width)), y1 = Math.max(...all.map(b => b.y + b.height));
        return { x: x0 * scale, y: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale };
      },
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
    audit = new AuditLog(path.join(userData, "audit"), undefined, journalSink(err => log.warn("audit.journal_failed", { err })));
    try { audit.prune(policy.auditRetentionDays ?? 30); } catch (err) { log.warn("audit.prune_failed", { err }); }
    confirmer = new Confirmer(showState, {
      // A click while Ember drives the mouse was Ember's own: never an answer (waiting for the user to let go is fine).
      blocked: () => borrowRef?.driving ?? false,
      onChange: questionChanged,
      keyHint: questionKeyHint,
    });
    const scale = () => screen.getPrimaryDisplay().scaleFactor || 1;
    const xinput = xinputRef = x11 ? openXInput() : null;
    if (x11 && !xinput) log.warn("xtest.unavailable", { err: xinputError });
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
    }) : null;
    borrowRef = borrow;
    // Ember's desk: started the first time a task needs it, torn down when Ember quits.
    // Desk apps get only the environment they need; the test bench's event log is passed on in development only.
    const benchLog = devEnv("EMBER_BENCH_LOG");
    const deskManager = new DeskManager(log.child("desk"), benchLog ? { env: { EMBER_BENCH_LOG: benchLog } } : {});
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
    });
    deskViewRef = deskView;
    let deskPlace: Promise<DeskPlace> | null = null;
    // A desk whose display died is gone: the next desk task starts a new one.
    deskManager.onDead(() => { deskPlace = null; });
    app.on("will-quit", () => { void deskPlace?.then(p => p.close()).catch(() => undefined); deskManager.stop(); });
    const hands: Hands | undefined = x11 ? {
      perception, sidecar, audit, confirmer,
      policy: new PolicyEngine({
        neverLook: () => settings.get().privacy.neverLook, grants: () => settings.get().grants,
        rateLimit: policy.maxActionsPerMinute,
        actionsAllowed: () => policy.features.actions !== false,
        confirmEveryAction: () => policy.confirmEveryAction,
        allowGrants: () => policy.allowGrants,
        isTerminalApp: name => isTerminalApp({ id: name, name }),
      }),
      flyTo: b => setState({ focus: b && b.width > 2 && b.height > 2 ? { x: b.x / scale(), y: b.y / scale(), width: b.width / scale(), height: b.height / scale() } : null }),
      currentWindow: () => {
        const w = x11.activeWindow();
        // Ember's own windows (ask box, settings) are not a task's target.
        if (!w || w.pid === process.pid) return null;
        // A private window: its process only (a task there is refused), never its title.
        const priv = isNeverLook({ app: w.wmClass ?? "", name: w.title }, settings.get().privacy.neverLook) || isSecurityWindow({ app: w.wmClass ?? "", title: w.title });
        return priv ? { pid: w.pid ?? undefined } : { pid: w.pid ?? undefined, title: w.title };
      },
      pointer: xinput ? () => xinput.pointerState() : undefined,
      // A guide sees a keyboard user press the control it points at (Enter or Space while it has focus).
      activationKey: xinput ? (() => {
        const codes = ["Return", "KP_Enter", "space"].map(n => xinput.keycodeOf(xinput.keysymOf(n))).filter(c => c > 0);
        return () => { const down = xinput.keysDown(); return codes.some(c => down.includes(c)); };
      })() : undefined,
      // Every format the user had on the clipboard comes back after a paste, not just text.
      clipboard: electronClipboard(clipboard, ClipboardItem),
      desk: DeskManager.available().ok && policy.features.desk !== false ? () => (deskPlace ??= openDeskPlace(deskManager, {
        sidecarScript: sidecarScript(), log: log.child("desk"), neverLook: () => settings.get().privacy.neverLook,
        profiles: path.join(userData, "desk-profiles"), userInControl: () => deskView.userInControl,
      }).catch(err => { deskPlace = null; throw err; })) : undefined,
      // The view counts the tasks on the desk; it stays up a little after the last one leaves, so the user sees the result.
      // A task leaving a desk that has since died doesn't hide the view another task uses on the new desk.
      onDesk: (place, previous) => { if (previous) deskView.leave(previous); if (place) deskView.show(place); },
      cursor: borrow && xinput ? {
        borrow,
        findWindow: (title, pid) => xinput.findWindow(title, pid),
        // The window with keyboard focus (where typed keys would go), else the one the WM calls active.
        activeWindow: () => { const w = x11.focusWindow() ?? x11.activeWindow(); return w ? { app: w.wmClass, title: w.title, pid: w.pid } : null; },
        // Several tasks may borrow in turn: the state shown is the borrow's own (driving now, or someone waiting), not the last task's word.
        setBorrowing: showBorrowing,
      } : undefined,
    } : undefined;
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
        showState({ idle: idleWord(status) });
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
      const found = provider ? null : await resolveToken(tokens);
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
      monitor: settings.get().voice.speakerRejection,
      onEvent: onVoice,
      onState: (state, detail) => {
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
    settings.onChange(() => { if (wantVoice() !== wanted) { wanted = wantVoice(); void voice?.setWanted(wanted); } });
    app.on("will-quit", () => voice?.stop());

    // Started by the user (the launcher, a terminal), settings opens; started at login (--autostart), Ember only greets.
    if (!settings.get().onboarded || process.argv.includes("--show-settings") || !process.argv.includes("--autostart")) showHome();
    // The hello waits for Copilot to connect (at most a few seconds), so it doesn't say "not connected" too early.
    else setTimeout(() => void Promise.race([brainStart, new Promise(r => setTimeout(r, 5000))]).then(() => greet()), 800);

    if (devEnv("EMBER_TEST_HOOKS") === "1") {
      (globalThis as Record<string, unknown>).__ember = {
        settings, setState, greet, showHome, overlay: () => overlay, handle: () => handle,
        agent: () => agent, perception: () => perception, confirmer: () => confirmer, voice: () => voice, deskView: () => deskView, ask: (text: string) => { captureContext(); return askEmber(text); }, showAsk: () => openAsk({ source: "test" }),
        showMenu, state: () => lastState,
      };
    }
  };
}
