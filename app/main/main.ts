/**
 * Ember main process (M0 skeleton): single instance, settings, logging,
 * environment checks and the home window. Later milestones add the overlay,
 * the Copilot conductor, perception and voice.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, net, safeStorage, screen, session, shell, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createLogger, type LogLevel } from "./logger";
import { SettingsStore, type SettingsPatch } from "./settings";
import { inspectEnvironment, type EnvReport } from "./environment";
import { createHomeWindow, isTrustedSender } from "./windows";
import { IPC, type Status, type SignInProgress } from "../shared/ipc";
import { OVERLAY, IDLE_BUBBLE, type EmberState, type Rect } from "../shared/overlay";
import { OverlayManager } from "./overlay";
import { HandleWindow } from "./handle";
import { openX11 } from "./x11";
import { AtspiSidecar, pickPython } from "./perception/sidecar";
import { Perception } from "./perception";
import { AskWindow } from "./ask";
import { AuditLog } from "./policy/audit";
import { PolicyEngine } from "./policy/policy";
import { Confirmer, guardWhileAsking } from "./agent/confirm";
import { AgentHost, type Hands } from "./agent/host";
import { locateRuntime } from "./agent/runtime";
import { TokenStore, resolveToken, startDeviceFlow, pollDeviceFlow } from "./agent/auth";

const CHARACTER_NAMES = { cinder: "Cinder", wisp: "Wisp", glassling: "Glassling", glint: "Glint" } as const;

// ~/.config/ember unless overridden (tests use a temp dir).
app.setName("ember");
app.setPath("userData", process.env.EMBER_USER_DATA ?? path.join(app.getPath("appData"), "ember"));
const userData = app.getPath("userData");

const log = createLogger({
  dir: path.join(userData, "logs"),
  level: (process.env.EMBER_LOG_LEVEL as LogLevel | undefined) ?? "info",
  stdout: process.env.EMBER_LOG_STDOUT === "1" || !app.isPackaged,
});

process.on("uncaughtException", err => log.error("uncaught exception", { err }));
process.on("unhandledRejection", reason => log.error("unhandled rejection", { reason }));

if (!app.requestSingleInstanceLock()) {
  log.info("instance.handover", { pid: process.pid });
  app.quit();
} else {
  start();
}

let pyatspiPresent: boolean | null = null;

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
  });
}

function start(): void {
  const settings = new SettingsStore(path.join(userData, "settings.json"));
  const loaded = settings.load();
  if (loaded.recoveredFrom) log.warn("settings.recovered", { backup: loaded.recoveredFrom });

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

  const guard = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A): R => {
      const url = event.senderFrame?.url ?? "";
      if (!isTrustedSender(url)) throw new Error(`untrusted IPC sender: ${url}`);
      return fn(...args);
    };

  ipcMain.handle(IPC.getStatus, guard((): Status => ({
    appVersion: app.getVersion(),
    settings: settings.get(),
    environment: readEnvironment(),
    logFile: log.file,
  })));
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
  const showState = (next: Partial<EmberState>) => {
    lastState = { ...lastState, ...next };
    overlay?.setState(next);
    handle?.sendState(lastState);
  };
  // While Ember is asking the user something, nothing else may replace the question
  // (a worker's reasoning would otherwise wipe the buttons before they're clicked).
  const setState = guardWhileAsking(() => confirmer?.waiting ?? false, showState);

  const greet = () => {
    const name = CHARACTER_NAMES[settings.get().character];
    setState({
      emotion: "happy",
      talking: true,
      bubble: { ...IDLE_BUBBLE, visible: true, mood: "idle", title: `Hi, I'm ${name}!`,
        thought: overlay ? "I'll stay by your cursor. Press Ctrl+Alt+E for settings." : "This session can't show me beside your cursor, so I'll wait here. Press Ctrl+Alt+E for settings." },
    });
    if (greetTimer) clearTimeout(greetTimer);
    setTimeout(() => setState({ talking: false }), 1600);
    greetTimer = setTimeout(() => setState({ emotion: "neutral", bubble: IDLE_BUBBLE }), 6000);
  };

  const showMenu = () => {
    if (!handle) return;
    const paused = followPaused;
    const hidden = overlay?.isHidden() ?? false;
    Menu.buildFromTemplate([
      { label: "Ask Ember…\tCtrl+Alt+Space", click: () => askWindow.show(overlay?.position ?? null) },
      { label: "Stop", enabled: agent?.getStatus().phase === "ready", click: () => { void agent?.abortAll(); } },
      { type: "separator" },
      { label: "Settings…", click: showHome },
      { label: paused ? "Follow my cursor" : "Stay put", enabled: !!overlay, click: () => { followPaused = !paused; overlay?.setPaused(followPaused); } },
      { label: hidden ? "Show Ember" : "Hide Ember", enabled: !!overlay, click: () => overlay?.setHidden(!hidden) },
      { type: "separator" },
      { label: "Quit Ember", click: () => app.quit() },
    ]).popup({ window: handle.win });
  };
  let followPaused = false;

  // ───── Copilot brain ─────
  const askWindow = new AskWindow();
  let agent: AgentHost | null = null;
  let perception: Perception | null = null;
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
  ipcMain.handle(IPC.signOut, guard(async () => {
    tokens?.clear();
    currentToken = null;
    await agent?.start(null);
  }));
  ipcMain.handle(IPC.signIn, guard(async () => {
    const clientId = process.env.EMBER_GITHUB_CLIENT_ID;
    if (!clientId) {
      progress({ state: "unavailable", message: "This build has no GitHub sign-in app yet. In a terminal, run “gh auth login”, then restart Ember: it will use that sign-in." });
      return;
    }
    signInAbort?.abort();
    signInAbort = new AbortController();
    const fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => net.fetch(url, init);
    try {
      const code = await startDeviceFlow(fetch, clientId);
      progress({ state: "code", userCode: code.userCode, verificationUri: code.verificationUri });
      void shell.openExternal(code.verificationUri);
      const token = await pollDeviceFlow(fetch, clientId, code, { signal: signInAbort.signal });
      const kept = tokens?.save(token) ?? false;
      if (!kept) log.warn("auth.not_persisted", { reason: "no keyring available; sign-in lasts until Ember quits" });
      currentToken = token;
      await agent?.start(token);
      progress({ state: "done", message: kept ? undefined : "Signed in. No keyring is available, so you'll need to sign in again next time." });
    } catch (err) {
      progress({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }));
  ipcMain.on(IPC.ask, (event, text: unknown) => {
    if (!askWindow.owns(event.sender) || typeof text !== "string") return;
    askWindow.hide();
    void agent?.ask(text.slice(0, 2000));
  });
  ipcMain.on(IPC.askClose, event => { if (askWindow.owns(event.sender)) askWindow.hide(); });

  ipcMain.on(OVERLAY.interactive, (event, rects: Rect[]) => {
    if (overlay?.owns(event.sender)) overlay.setInteractive(event.sender, rects);
  });
  ipcMain.on(OVERLAY.bubbleAction, (event, id: string) => {
    const fromHandle = !!handle && event.sender === handle.win.webContents;
    if (!(overlay?.owns(event.sender) || fromHandle) || typeof id !== "string") return;
    log.info("bubble.action", { id, handled: confirmer?.answer(id) ?? false });
  });
  ipcMain.on(OVERLAY.handleMenu, event => {
    if (handle && event.sender === handle.win.webContents) showMenu();
  });

  settings.onChange((s) => {
    overlay?.broadcastSettings(s);
    handle?.sendSettings(s);
  });
  let wasOnboarded = settings.get().onboarded;
  settings.onChange(s => {
    if (s.onboarded && !wasOnboarded) {
      // Setup finished: get out of the way so the user sees Ember say hello.
      setTimeout(() => { if (home && !home.isDestroyed()) home.close(); greet(); }, 500);
    }
    wasOnboarded = s.onboarded;
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    overlay?.stop();
    void agent?.stop();
  });

  void app.whenReady().then(() => {
    // Deny camera, mic, notifications etc. until a feature asks for them explicitly (M5).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // No background downloads: the spellchecker would fetch dictionaries from Google.
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerLanguages([]);
    session.defaultSession.on("spellcheck-dictionary-download-begin", (_e, lang) => log.warn("spellcheck.download", { lang }));
    const env = readEnvironment();
    const x11 = env.sessionType === "x11" || process.env.DISPLAY ? openX11() : null;
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

    if (!globalShortcut.register("Control+Alt+E", showHome)) log.warn("shortcut.unavailable", { accel: "Control+Alt+E" });
    if (!globalShortcut.register("Control+Alt+Space", () => askWindow.show(overlay?.position ?? null))) {
      log.warn("shortcut.unavailable", { accel: "Control+Alt+Space" });
    }

    // Connect the brain. EMBER_TEST_PROVIDER_URL points it at an offline OpenAI-compatible server (tests, demos).
    tokens = new TokenStore(path.join(userData, "github-token.bin"), safeStorage);
    const provider = process.env.EMBER_TEST_PROVIDER_URL
      ? { type: "openai" as const, baseUrl: process.env.EMBER_TEST_PROVIDER_URL, apiKey: "test" }
      : undefined;
    const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath });
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
    const audit = new AuditLog(path.join(userData, "audit"));
    try { audit.prune(); } catch (err) { log.warn("audit.prune_failed", { err }); }
    confirmer = new Confirmer(showState);
    const scale = () => screen.getPrimaryDisplay().scaleFactor || 1;
    const hands: Hands | undefined = x11 ? {
      perception, sidecar, audit, confirmer,
      policy: new PolicyEngine({ neverLook: () => settings.get().privacy.neverLook, grants: () => settings.get().grants }),
      flyTo: b => setState({ focus: b ? { x: b.x / scale(), y: b.y / scale(), width: b.width / scale(), height: b.height / scale() } : null }),
      currentWindow: () => {
        const w = x11.activeWindow();
        // Ember's own windows (ask box, settings) are not a task's target.
        return w && w.pid !== process.pid ? { pid: w.pid ?? undefined, title: w.title } : null;
      },
    } : undefined;
    agent = new AgentHost({
      userData, runtimePath: runtime.path, settings, log: log.child("agent"), setState, provider,
      describeScreen: () => seeing.describe(), hands,
      onStatus: status => broadcast(IPC.agentStatusChanged, status),
    });
    void (async () => {
      const found = provider ? null : await resolveToken(tokens);
      log.info("auth.token", { source: provider ? "test-provider" : found?.source ?? "none" });
      currentToken = found?.token ?? null;
      await agent?.start(currentToken);
    })();
    let models = JSON.stringify(settings.get().models);
    settings.onChange(next => {
      const m = JSON.stringify(next.models);
      if (m !== models) { models = m; void agent?.start(currentToken); }
    });

    if (!settings.get().onboarded || process.argv.includes("--show-settings")) showHome();
    else setTimeout(greet, 800);

    if (process.env.EMBER_TEST_HOOKS === "1") {
      (globalThis as Record<string, unknown>).__ember = {
        settings, setState, greet, showHome, overlay: () => overlay, handle: () => handle,
        agent: () => agent, perception: () => perception, confirmer: () => confirmer, ask: (text: string) => agent?.ask(text), showAsk: () => askWindow.show(overlay?.position ?? null),
      };
    }
  });
}
