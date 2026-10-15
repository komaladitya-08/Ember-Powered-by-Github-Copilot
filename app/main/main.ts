/**
 * Ember main process (M0 skeleton): single instance, settings, logging,
 * environment checks and the home window. Later milestones add the overlay,
 * the Copilot conductor, perception and voice.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, session, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createLogger, type LogLevel } from "./logger";
import { SettingsStore, type SettingsPatch } from "./settings";
import { inspectEnvironment, type EnvReport } from "./environment";
import { createHomeWindow, isTrustedSender } from "./windows";
import { IPC, type Status } from "../shared/ipc";
import { OVERLAY, IDLE_BUBBLE, type EmberState, type Rect } from "../shared/overlay";
import { OverlayManager } from "./overlay";
import { HandleWindow } from "./handle";
import { openX11 } from "./x11";

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
  settings.onChange(s => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.settingsChanged, s);
  });

  // Ember keeps running without windows: the overlay and handle are its presence.
  app.on("window-all-closed", () => { /* stay alive */ });

  let overlay: OverlayManager | null = null;
  let handle: HandleWindow | null = null;
  let greetTimer: NodeJS.Timeout | null = null;

  let lastState: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null };
  const setState = (next: Partial<EmberState>) => {
    lastState = { ...lastState, ...next };
    overlay?.setState(next);
    handle?.sendState(lastState);
  };

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
      { label: "Settings…", click: showHome },
      { label: paused ? "Follow my cursor" : "Stay put", enabled: !!overlay, click: () => { followPaused = !paused; overlay?.setPaused(followPaused); } },
      { label: hidden ? "Show Ember" : "Hide Ember", enabled: !!overlay, click: () => overlay?.setHidden(!hidden) },
      { type: "separator" },
      { label: "Quit Ember", click: () => app.quit() },
    ]).popup({ window: handle.win });
  };
  let followPaused = false;

  ipcMain.on(OVERLAY.interactive, (event, rects: Rect[]) => {
    if (overlay?.owns(event.sender)) overlay.setInteractive(event.sender, rects);
  });
  ipcMain.on(OVERLAY.bubbleAction, (event, id: string) => {
    if (overlay?.owns(event.sender)) log.info("bubble.action", { id });
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

    if (!settings.get().onboarded || process.argv.includes("--show-settings")) showHome();
    else setTimeout(greet, 800);

    if (process.env.EMBER_TEST_HOOKS === "1") {
      (globalThis as Record<string, unknown>).__ember = { settings, setState, greet, showHome, overlay: () => overlay, handle: () => handle };
    }
  });
}
