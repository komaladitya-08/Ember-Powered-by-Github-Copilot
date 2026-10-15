/**
 * Ember main process: single instance, settings, logging, environment checks,
 * the windows (home, overlay, handle, ask box), the Copilot brain, perception,
 * hands and voice, and the wiring between them.
 */

import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, net, Notification, powerMonitor, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from "electron";
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
import { openX11 } from "./x11";
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
import { CursorBorrow } from "./hands/borrow";
import { DeskManager } from "./desk/desk";
import { openDeskPlace, type DeskPlace } from "./desk/place";
import { DeskView } from "./desk/view";
import { AgentHost, type Hands } from "./agent/host";
import { locateRuntime } from "./agent/runtime";
import { TokenStore, resolveToken, startDeviceFlow, pollDeviceFlow } from "./agent/auth";
import { plainText } from "./agent/presenter";

const CHARACTER_NAMES = { cinder: "Cinder", wisp: "Wisp", glassling: "Glassling", glint: "Glint" } as const;

/**
 * Switches for tests and demos (a fake model server, test hooks, another policy
 * file…) work only in development: an installed Ember ignores them, so no one can
 * point it at another endpoint or around the administrator's policy.
 */
const devEnv = (name: string): string | undefined => (app.isPackaged ? undefined : process.env[name]);

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
  if (pyatspiPresent === null) {
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
    if (t) auth = { kind: "github", source: t.source };
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
    speechDispatcher: which("spd-say"), microphones,
    voiceModels: models.bundled ? "bundled" : modelsReady(models.root) ? "downloaded" : "missing",
    runtime: runtime.exists, auth, admin, desk: DeskManager.available(), sandbox: { userNamespaces, suidHelper },
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
  app.on("will-quit", unwatch);

  let home: BrowserWindow | null = null;
  const showHome = () => {
    if (home && !home.isDestroyed()) {
      if (home.isMinimized()) home.restore();
      home.show();
      home.focus();
      return;
    }
    home = createHomeWindow();
    home.once("ready-to-show", () => log.info("window.home.shown"));
    home.on("closed", () => { home = null; });
  };

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
    admin: { source: admin.source, error: admin.error ?? null, managed: managedKeys(policy), features: policy.features, provider: policy.provider?.baseUrl ?? null,
      confirmEveryAction: policy.confirmEveryAction, allowGrants: policy.allowGrants, retentionDays: policy.auditRetentionDays ?? 30 },
  })));
  ipcMain.handle(IPC.activity, guard(() => audit?.recent(150) ?? []));
  ipcMain.handle(IPC.updateSettings, guard((patch: SettingsPatch) => settings.update(patch)));
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

  let lastState: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };
  let confirmer: Confirmer | null = null;
  // While the user works on Ember's desk, the task cards stay out of the enlarged view's way.
  let deskInControl = false;
  const showState = (next: Partial<EmberState>) => {
    lastState = { ...lastState, ...next };
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
  const greet = () => {
    const name = CHARACTER_NAMES[settings.get().character];
    const phase = agent?.getStatus().phase;
    const connected = phase !== "signed-out" && phase !== "error";
    const keys = (shortcutsTaken ?? []).length ? "Click my handle in the corner to ask me something or to stop me." : "Press Ctrl+Alt+Space to ask me anything; Ctrl+Alt+X stops me.";
    const thought = !connected
      ? "I'm not connected to Copilot yet. Open settings (Ctrl+Alt+E) to connect me."
      : overlay ? `I'll stay by your cursor. ${keys}` : `This session can't show me beside your cursor, so I'll wait here. ${keys}`;
    const bubble = { ...IDLE_BUBBLE, visible: true, mood: "idle" as const, title: `Hi, I'm ${name}!`, thought,
      actions: connected ? [] : [{ id: "ui:settings", label: "Open settings" }] };
    setState({ emotion: "happy", talking: true, bubble });
    if (greetTimer) clearTimeout(greetTimer);
    setTimeout(() => setState({ talking: false }), 1600);
    greetTimer = hideIfStill(bubble, connected ? 7000 : 15000);
  };

  const busyTasks = () => agent?.tasks?.list().filter(t => t.status === "running" || t.status === "queued").length ?? 0;
  /** Quitting with tasks under way asks first (they would stop half-way). */
  const quitEmber = async () => {
    const n = busyTasks();
    if (n) {
      const { response } = await dialog.showMessageBox({
        type: "question", buttons: ["Keep Ember running", "Stop and quit"], defaultId: 0, cancelId: 0,
        title: "Quit Ember?", message: `Ember is still working on ${n === 1 ? "a task" : `${n} tasks`}.`, detail: "Quitting stops it where it is.",
      });
      if (response !== 1) return;
    }
    app.quit();
  };
  const showMenu = () => {
    if (!handle) return;
    const paused = followPaused;
    const hidden = overlay?.isHidden() ?? false;
    // Accelerators are shown, not registered here (the global shortcuts already are).
    const keys = (accelerator: string) => ({ accelerator, registerAccelerator: false });
    Menu.buildFromTemplate([
      { label: "Ask Ember…", ...keys("Ctrl+Alt+Space"), click: openAsk },
      { label: "Stop everything", ...keys("Ctrl+Alt+X"), click: () => stopEverything("menu") },
      ...(voice && settings.get().wakeWord && settings.get().voice.consent
        ? [{ label: voice.isMuted ? "Unmute microphone" : "Mute microphone", ...keys("Ctrl+Alt+M"), click: toggleMute }]
        : []),
      ...(agent?.lastAnswer() ? [{ label: "Read the last answer", click: () => { showHome(); sendToHome(IPC.focusSection, "conversation"); } }] : []),
      { type: "separator" },
      { label: "Settings…", ...keys("Ctrl+Alt+E"), click: showHome },
      { label: paused ? "Follow my cursor" : "Stay put", enabled: !!overlay, click: () => { followPaused = !paused; overlay?.setPaused(followPaused); } },
      { label: hidden ? "Show Ember" : "Hide Ember", enabled: !!overlay, click: () => overlay?.setHidden(!hidden) },
      { type: "separator" },
      { label: "Quit Ember", click: () => { void quitEmber(); } },
    ]).popup({ window: handle.win });
  };
  let followPaused = false;

  const sendToHome = (channel: string, value: unknown) => {
    const send = () => { if (home && !home.isDestroyed()) home.webContents.send(channel, value); };
    if (home && !home.isDestroyed() && home.webContents.isLoading()) home.webContents.once("did-finish-load", send); else send();
  };
  /** Questions are answered with keys too (Orca and keyboard users can't click the bubble). */
  const QUESTION_KEYS = { "Control+Alt+Y": "primary", "Control+Alt+N": "deny", "Control+Alt+A": "always" } as const;
  let questionKeys: string[] = [];
  const questionChanged = (q: { question: { prompt: string; options: { id: string }[] } } | null) => {
    for (const k of questionKeys) globalShortcut.unregister(k);
    questionKeys = [];
    if (!q) return;
    for (const [accel, which] of Object.entries(QUESTION_KEYS)) {
      if (which === "always" && !q.question.options.some(o => o.id === "always")) continue;
      if (globalShortcut.register(accel, () => confirmer?.answerKey(which))) questionKeys.push(accel);
    }
    // A question nobody can see expires as "no": a hidden Ember shows itself to ask.
    if (overlay?.isHidden()) overlay.setHidden(false);
    if (settings.get().speak || screenReaderOn()) {
      voice?.speak(`Ember asks: ${q.question.prompt} Press Control Alt Y to allow, or Control Alt N for not now.`);
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

  // ───── Copilot brain ─────
  const askWindow = new AskWindow();
  let agent: AgentHost | null = null;
  let perception: Perception | null = null;
  let voice: VoiceService | null = null;
  /** Where the user was when they last called Ember (taken before anything of Ember's takes focus). */
  let callContext: Promise<QuickContext | null> = Promise.resolve(null);
  // Nothing is read from the screen or sent anywhere until the user has agreed (M8.8).
  const consented = () => hasConsent(settings.get());
  const captureContext = () => { callContext = perception && consented() ? perception.quickContext().catch(() => null) : Promise.resolve(null); };
  const askEmber = async (text: string) => {
    if (!consented()) { showHome(); return; }
    // A slow screen read never holds a request for long: it goes without context after 1.5 s.
    const context = await Promise.race([callContext, new Promise<null>(r => setTimeout(() => r(null), 1500))]);
    return agent?.ask(text, context)?.catch(err => log.error("ask.failed", { err }));
  };
  const openAsk = () => {
    if (!consented()) { showHome(); return; }
    captureContext();
    askWindow.show(overlay?.position ?? null, { sees: null, history: askHistory });
    // What Ember will read, shown as a chip once the quick look is done.
    void callContext.then(c => {
      const t = c?.target;
      const sees = t ? [t.app, t.title].filter(Boolean).join(" · ") || null : null;
      const ctx: AskContext = { sees: sees && sees.length > 80 ? sees.slice(0, 79) + "…" : sees, history: askHistory };
      askWindow.setContext(ctx);
    });
  };
  let audit: AuditLog | null = null;
  let borrowRef: CursorBorrow | null = null;
  const killSwitch = new KillSwitch(() => [
    { name: "borrow", stop: () => borrowRef?.stop() },
    { name: "speech", stop: () => voice?.hush() },
    // A request still being spoken is dropped, not sent after Stop.
    { name: "listening", stop: () => voice?.cancelListening() },
    { name: "agent", stop: () => agent?.abortAll() },
    { name: "motion", stop: () => { overlay?.setBorrowing(false); showState({ focus: null, gesture: null }); } },
  ], log.child("killswitch"), () => audit);
  /** Ctrl+Alt+X, "Ember, stop", or Stop in the menu: everything stops at once. */
  const stopEverything = (source: "hotkey" | "voice" | "menu") => {
    void killSwitch.pull(source);
    const bubble = { visible: true, mood: "idle" as const, title: "Stopped", thought: "Okay, I've stopped everything.", step: null, streaming: false, actions: [] };
    setState({ emotion: "neutral", talking: false, status: null, bubble });
    hideIfStill(bubble, 3000);
  };
  let lastAskByVoice = false;
  /** What Ember showed before a wake, put back if the wake turns out to be another word. */
  let beforeWake: Pick<EmberState, "emotion" | "bubble"> | null = null;
  const toggleMute = () => {
    if (!voice || !(settings.get().wakeWord && settings.get().voice.consent)) return;
    voice.setMuted(!voice.isMuted);
    // Remembered: a restart (or login) doesn't quietly open the microphone again.
    try { settings.update({ voice: { ...settings.get().voice, muted: voice.isMuted } }); } catch (err) { log.warn("voice.mute_not_saved", { err }); }
    setState({ status: voice.isMuted ? "Microphone off" : null });
    if (voice.isMuted) setTimeout(() => { if (voice?.isMuted) setState({ status: null }); }, 2500);
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
        setState({ emotion: "listening", talking: false, bubble: { visible: true, mood: "listening", title: "Listening…", thought: "", step: null, streaming: true, actions: [] } });
        break;
      case "listening":
        if (e.on && e.reason === "follow-up") setState({ emotion: "listening", status: "Listening for a follow-up…" });
        if (!e.on) setState({ status: null });
        // Nobody spoke: back to idle. The wake was another word ("Amber"): back to what was showing.
        // A follow-up window that heard nothing leaves the answer up (unless it had started showing "Listening…").
        if (!e.on && e.reason === "timeout") setState(e.window === "wake" || lastState.bubble.mood === "listening" ? { emotion: "neutral", bubble: IDLE_BUBBLE } : { emotion: "neutral" });
        if (!e.on && e.reason === "rejected") setState(beforeWake ?? { emotion: "neutral", bubble: IDLE_BUBBLE });
        break;
      case "speech":
        if (e.on) setState({ bubble: { visible: true, mood: "listening", title: "Listening…", thought: "…", step: null, streaming: true, actions: [] } });
        break;
      case "utterance":
        lastAskByVoice = true;
        log.info("voice.utterance", { chars: e.text.length, ms: e.ms });
        // A follow-up (no wake word) keeps the context from the last call.
        void askEmber(e.text);
        break;
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
    await agent?.start(null);
  }));
  ipcMain.handle(IPC.cancelSignIn, guard(() => { signInAbort?.abort(); progress({ state: "cancelled" }); }));
  /** "Check again": look for a sign-in (Ember's own, the environment, gh) and reconnect with it. */
  const retrySignIn = async () => {
    if (!consented()) { showHome(); return; }
    const found = await resolveToken(tokens).catch(() => null);
    currentToken = found?.token ?? null;
    await agent?.start(currentToken, found?.source);
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
    const clientId = process.env.EMBER_GITHUB_CLIENT_ID;
    if (!clientId) {
      // No sign-in app yet: watch for a GitHub CLI sign-in instead, and connect as soon as one appears (no restart).
      say({ state: "waiting", message: "In a terminal, run “gh auth login”. Ember will notice within a few seconds and connect; no restart needed." });
      const before = currentToken;
      for (let i = 0; i < 200 && !ac.signal.aborted; i++) {
        const found = await resolveToken(tokens).catch(() => null);
        if (found && found.token !== before) {
          currentToken = found.token;
          await agent?.start(found.token, found.source);
          say({ state: "done" });
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
      if (/^https:\/\/github\.com\//.test(code.verificationUri)) void shell.openExternal(code.verificationUri);
      const token = await pollDeviceFlow(fetch, clientId, code, { signal: ac.signal });
      const kept = tokens?.save(token) ?? false;
      if (!kept) log.warn("auth.not_persisted", { reason: "no keyring available; sign-in lasts until Ember quits" });
      currentToken = token;
      await agent?.start(token, "stored");
      say({ state: "done", message: kept ? undefined : "Signed in. No keyring is available, so you'll need to sign in again next time." });
    } catch (err) {
      if (!ac.signal.aborted) say({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }));
  ipcMain.handle(IPC.voiceStatus, guard(() => voiceStatus()));
  ipcMain.handle(IPC.voiceDownload, guard(async () => {
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
  ipcMain.on(OVERLAY.interactive, (event, rects: unknown) => {
    if (!overlay?.owns(event.sender) || !Array.isArray(rects) || rects.length > 32 || !rects.every(isRect)) return;
    overlay.setInteractive(event.sender, rects);
  });
  ipcMain.on(OVERLAY.bubbleAction, (event, id: unknown) => {
    const fromHandle = !!handle && event.sender === handle.win.webContents;
    if (!(overlay?.owns(event.sender) || fromHandle) || typeof id !== "string" || id.length > 120) return;
    // A click that arrives while Ember drives the mouse was Ember's, not the user's: ignored.
    if (borrowRef?.active) { log.warn("bubble.action_while_borrowing", { id }); return; }
    if (id === "ui:settings") { showHome(); return; }
    if (id === "ui:more") { showHome(); sendToHome(IPC.focusSection, "conversation"); return; }
    const task = /^task:(.+):(stop|dismiss)$/.exec(id);
    if (task) {
      if (task[2] === "stop") agent?.tasks?.cancel(task[1]); else agent?.tasks?.dismiss(task[1]);
      log.info("task.card_action", { action: task[2] });
      return;
    }
    log.info("bubble.action", { id, handled: confirmer?.answer(id) ?? false });
  });
  ipcMain.on(OVERLAY.handleMenu, event => {
    if (handle && event.sender === handle.win.webContents) showMenu();
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
  settings.onChange(s => {
    if (s.onboarded && !wasOnboarded) {
      // Setup finished: get out of the way so the user sees Ember say hello. If Copilot isn't
      // connected, the window stays and shows how to connect (asking would only say "not connected").
      setTimeout(() => {
        const phase = agent?.getStatus().phase;
        if (phase === "signed-out" || phase === "error") sendToHome(IPC.focusSection, "copilot");
        else if (home && !home.isDestroyed()) home.close();
        greet();
      }, 500);
    }
    wasOnboarded = s.onboarded;
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    overlay?.stop();
    void agent?.stop();
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
    const x11 = process.env.DISPLAY ? openX11() : null;
    x11Reachable = process.env.DISPLAY ? !!x11 : undefined;
    const env = readEnvironment();
    const compositing = x11 ? x11.hasCompositor() : false;
    // X11 has one global scale factor; XQueryPointer reports physical pixels.
    const cursor = () => {
      const p = x11?.pointer();
      if (!p) return screen.getCursorScreenPoint();
      const scale = screen.getPrimaryDisplay().scaleFactor || 1;
      return { x: p.x / scale, y: p.y / scale };
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

    if (compositing) {
      overlay = new OverlayManager(() => settings.get(), log.child("overlay"), cursor);
      overlay.start();
    } else {
      log.warn("overlay.fallback", { reason: "no compositing manager; using the handle card" });
    }
    handle = new HandleWindow(() => settings.get(), !compositing);

    // Ember's shortcuts. One another app already holds is reported (setup check, greeting) and tried again every minute.
    const shortcuts: Record<string, () => void> = {
      "Control+Alt+E": showHome, "Control+Alt+Space": openAsk, "Control+Alt+X": () => stopEverything("hotkey"), "Control+Alt+M": () => toggleMute(),
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
      // A click while Ember drives the mouse was Ember's own: never an answer.
      blocked: () => borrowRef?.active ?? false,
      onChange: questionChanged,
    });
    const scale = () => screen.getPrimaryDisplay().scaleFactor || 1;
    const xinput = x11 ? openXInput() : null;
    if (x11 && !xinput) log.warn("xtest.unavailable", { err: xinputError });
    // A borrow still running lets go (keys up, pointer home) before the connection closes.
    app.on("will-quit", () => { borrowRef?.stop(); xinput?.close(); });
    // The administrator can turn off borrowing the mouse (tier 3) and Ember's desk (tier 2).
    const borrow = xinput && policy.features.cursor !== false ? new CursorBorrow(xinput) : null;
    borrowRef = borrow;
    // Ember's desk: started the first time a task needs it, torn down when Ember quits.
    const deskManager = new DeskManager(log.child("desk"));
    const deskView = new DeskView(log.child("desk-view"), on => {
      deskInControl = on;
      overlay?.setState({ tasks: on ? [] : lastState.tasks });
    });
    let deskPlace: Promise<DeskPlace> | null = null;
    let deskHide: NodeJS.Timeout | null = null;
    app.on("will-quit", () => { void deskPlace?.then(p => p.close()).catch(() => undefined); deskManager.stop(); });
    const hands: Hands | undefined = x11 ? {
      perception, sidecar, audit, confirmer,
      policy: new PolicyEngine({
        neverLook: () => settings.get().privacy.neverLook, grants: () => settings.get().grants,
        rateLimit: policy.maxActionsPerMinute,
        actionsAllowed: () => policy.features.actions !== false,
        confirmEveryAction: () => policy.confirmEveryAction,
        allowGrants: () => policy.allowGrants,
      }),
      flyTo: b => setState({ focus: b ? { x: b.x / scale(), y: b.y / scale(), width: b.width / scale(), height: b.height / scale() } : null }),
      currentWindow: () => {
        const w = x11.activeWindow();
        // Ember's own windows (ask box, settings) are not a task's target.
        if (!w || w.pid === process.pid) return null;
        // A private window: its process only (a task there is refused), never its title.
        const priv = isNeverLook({ app: w.wmClass ?? "", name: w.title }, settings.get().privacy.neverLook) || isSecurityWindow({ app: w.wmClass ?? "", title: w.title });
        return priv ? { pid: w.pid ?? undefined } : { pid: w.pid ?? undefined, title: w.title };
      },
      pointer: xinput ? () => xinput.pointerState() : undefined,
      clipboard: { readText: () => clipboard.readText(), writeText: t => clipboard.writeText(t) },
      desk: DeskManager.available().ok && policy.features.desk !== false ? () => (deskPlace ??= openDeskPlace(deskManager, {
        sidecarScript: sidecarScript(), log: log.child("desk"), neverLook: () => settings.get().privacy.neverLook,
        profiles: path.join(userData, "desk-profiles"), userInControl: () => deskView.userInControl,
      }).catch(err => { deskPlace = null; throw err; })) : undefined,
      onDesk: place => {
        if (deskHide) clearTimeout(deskHide);
        if (place) deskView.show(place);
        // Keep the view up a little after the work ends, so the user sees the result.
        else deskHide = setTimeout(() => { if (!deskView.userInControl) deskView.hide(); }, 10_000);
      },
      cursor: borrow && xinput ? {
        borrow,
        findWindow: title => xinput.findWindow(title),
        // The window with keyboard focus (where typed keys would go), else the one the WM calls active.
        activeWindow: () => { const w = x11.focusWindow() ?? x11.activeWindow(); return w ? { app: w.wmClass, title: w.title } : null; },
        setBorrowing: state => {
          overlay?.setBorrowing(state === "active");
          // Ember's own windows let the borrowed clicks through (they sit where apps keep OK and Save buttons).
          handle?.setClickThrough(state === "active");
          setState({ status: state === "active" ? "Using your mouse: move it to take over" : state === "waiting" ? "Waiting until you let go of the mouse…" : null });
        },
      } : undefined,
    } : undefined;
    agent = new AgentHost({
      userData, runtimePath: runtime.path, settings, log: log.child("agent"), setState, provider, admin: () => policy,
      describeScreen: () => seeing.describe(), hands,
      onAnswer: text => { if (settings.get().speak || screenReaderOn()) voice?.speak(plainText(text)); },
      // A spoken request gets a short follow-up window: no need to say "Hey Ember" again.
      onTurnEnd: aborted => { if (lastAskByVoice && !aborted) voice?.followUp(8000); lastAskByVoice = false; },
      onStatus: status => broadcast(IPC.agentStatusChanged, status),
      onTranscript: entries => broadcast(IPC.conversationChanged, entries),
      onTaskFinished: t => {
        const text = `${t.title}: ${t.status === "done" ? "done" : t.status === "cancelled" ? "stopped" : "didn't work"}. ${t.summary}`;
        if (settings.get().speak || screenReaderOn()) voice?.speak(text);
        if (userAway() && t.status !== "cancelled") notify(t.status === "done" ? `Ember finished: ${t.title}` : `Ember couldn't finish: ${t.title}`, t.summary);
      },
      isOnline: () => net.isOnline(),
    });
    // The brain connects once the user has agreed to what Ember does (first run asks).
    let brainStarted = false;
    const startBrain = async () => {
      if (brainStarted || !consented()) return;
      brainStarted = true;
      const found = provider ? null : await resolveToken(tokens);
      log.info("auth.token", { source: testProvider ? "test-provider" : provider ? "admin-provider" : found?.source ?? "none" });
      currentToken = found?.token ?? null;
      await agent?.start(currentToken, found?.source);
    };
    void startBrain();
    settings.onChange(() => { void startBrain(); });
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
        broadcast(IPC.voiceStatus, voiceStatus(detail));
      },
    });
    if (settings.get().voice.muted) voice.setMuted(true);
    const wantVoice = () => settings.get().wakeWord && settings.get().voice.consent && consented();
    void voice.setWanted(wantVoice());
    let wanted = wantVoice();
    settings.onChange(() => { if (wantVoice() !== wanted) { wanted = wantVoice(); void voice?.setWanted(wanted); } });
    app.on("will-quit", () => voice?.stop());

    if (!settings.get().onboarded || process.argv.includes("--show-settings")) showHome();
    else setTimeout(greet, 800);

    if (devEnv("EMBER_TEST_HOOKS") === "1") {
      (globalThis as Record<string, unknown>).__ember = {
        settings, setState, greet, showHome, overlay: () => overlay, handle: () => handle,
        agent: () => agent, perception: () => perception, confirmer: () => confirmer, voice: () => voice, deskView: () => deskView, ask: (text: string) => { captureContext(); return askEmber(text); }, showAsk: openAsk,
        showMenu, state: () => lastState,
      };
    }
  };
}
