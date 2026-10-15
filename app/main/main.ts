/**
 * Ember main process (M0 skeleton): single instance, settings, logging,
 * environment checks and the home window. Later milestones add the overlay,
 * the Copilot conductor, perception and voice.
 */

import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createLogger, type LogLevel } from "./logger";
import { SettingsStore, type SettingsPatch } from "./settings";
import { inspectEnvironment, type EnvReport } from "./environment";
import { createHomeWindow, isTrustedSender } from "./windows";
import { IPC, type Status } from "../shared/ipc";

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

  app.on("window-all-closed", () => {
    // M0: nothing else to show, so quit. From M1 the overlay keeps Ember running.
    app.quit();
  });

  void app.whenReady().then(() => {
    // Deny camera, mic, notifications etc. until a feature asks for them explicitly (M5).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // No background downloads: the spellchecker would fetch dictionaries from Google.
    session.defaultSession.setSpellCheckerEnabled(false);
    const env = readEnvironment();
    log.info("app.ready", {
      version: app.getVersion(),
      os: env.os,
      session: env.sessionType,
      desktop: env.desktop,
      glibc: env.glibc,
      electron: env.versions.electron,
      failing: env.checks.filter(c => c.status !== "ok").map(c => c.id),
    });
    showHome();
  });
}
