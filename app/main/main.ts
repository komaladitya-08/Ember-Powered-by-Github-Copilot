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

import { HistoryStore } from "./agent/conversation-store";
import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeTheme, net, Notification, powerMonitor, safeStorage, screen, session, shell, systemPreferences, utilityProcess, webContents, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createLogger, logLevel } from "./logger";
import { dataFolderProblem, startupDialogText, startupProblem } from "./data-folder";
import { loginItemFollower } from "./autostart";
import { watchCrashes } from "./crash-log";
import { endRun, previousRun, startRun } from "./run-marker";
import { readTextFile } from "./text-file";
import { SettingsStore, checkHomePatch, hasConsent, plainSaveError, withOwnExtensions, withOwnProvider, withOwnTrust, type Settings, type SettingsPatch } from "./settings";
import { auditRetentionDays, autonomyAllowed, heldUntilRestart, homeAdmin, modelServiceRefusal } from "./admin";
import { autonomyConsented, autonomyInForce, ALL_SCOPES } from "./policy/autonomy";
import { TaskVoiceTrust, VOICE_ANSWER_REFUSED, heardAnswer, heardUnchecked, refusalEndsTrust, rejectionEndsTrust, voiceAnswer, voiceAnswerSaid, type VoiceAnswerNote, type VoiceAnswerOutcome } from "./agent/voice-answer";
import { inspectEnvironment, keyboardRoute, sessionGreeting, type EnvReport } from "./environment";
import { createCommandWindow, createHomeWindow, createPromptWindow, isTrustedSender, keepClearOf, quitQuestion, setTextScale, settingsFromHome, setUpAppChrome } from "./windows";
import { UPDATED_QUESTION, createUpdateCheck, restartAfterUpdate, updatedDetail } from "./install-watch";
import { IPC, TASKS_PUSH_MS, type Status, type SignInProgress, type AskContext, type ListenOnceStatus, type VoiceMatchStatus, type ProjectSelection, type ProjectResult, type ProjectWorkspaceReply, type HearResult, type RetryResult } from "../shared/ipc";
import { OVERLAY, IDLE_BUBBLE, answerEndShown, askSuggestions, askSuggestionsComing, bubbleBoxOf, suggestOf, suggestionsShown, wholeSeenOf, type EmberState, type Rect } from "../shared/overlay";
import { MIC_PROBLEM_MENU } from "../shared/mic";
import { applyPagePrefs, pagePrefs, textScale } from "./page-prefs";
import { OverlayManager } from "./overlay";
import { HandleWindow } from "./handle";
import { otherSide } from "../shared/handle-place";
import { revive } from "./revive";
import { memoryReport } from "./memory-report";
import { useAppNames } from "../shared/apps";
import { AtspiSidecar, type FocusBefore } from "./perception/sidecar";
import { isNeverLook } from "./perception/elements";
import { Perception, type QuickContext } from "./perception";
import { warmText } from "./perception/capture";
import { TEXT_WARM_DELAY_MS, scheduleTextWarm } from "./perception/text-warm";
import { AskWindow, MAC_SETTLE_MS, WAIT_TIP_OPENINGS, showsWaitTip, stepsAsideFor } from "./ask";
import { focusBeforeNow, openAskInOrder, userWindowsNow } from "./ask-open";
import { notificationBody } from "./notification";
import { askSees } from "./ask-sees";
import { LISTEN_CUT_BY_QUESTION, LISTEN_ONCE_STOPS_ANSWER, VoiceService, cutByQuestion, electronDownloader, heldByQuestion, listenOnceInSettings, questionHoldsListen, voicePermissions } from "./voice";
import type { VoiceEvent } from "../voice/engine";
import { VOICE_MODELS, VOICE_MODELS_BYTES, missingModels, modelsBytes, modelsReady } from "../voice/models";
import { capiChoice, type BackendChoice } from "../voice/runtime";
import { doctorChecks, formatDoctor, type DoctorProbes } from "./doctor";
import { AuditLog } from "./policy/audit";
import { KillSwitch, stillStoppingWords } from "./agent/killswitch";
import { PolicyEngine, isRiskyLabel } from "./policy/policy";
import { remoteSurfaceCheck } from "./policy/remote-surface";
import { restartOptions, runningAppImage, watchAdminPolicy } from "./policy/admin-watch";
import { ANSWER_MS, Confirmer, EXPIRED_MS, answerSettler, guardWhileAsking, hidesAgainAfter } from "./agent/confirm";
import { taskNotice } from "./agent/tasks";
import { CursorBorrow } from "./hands/borrow";
import { isTerminalWindowApp } from "./hands/system";
import { freshAskPress, holdShortcuts } from "./hotkey";
import { HelperWatch } from "./helper-watch";
import { ALWAYS_HELD, FALLBACK_SHORTCUTS, heldShortcuts, shownShortcuts, type ShortcutDef, type ShortcutId } from "../shared/shortcuts";
import type { DeskPlace } from "./desk/place";
import { DeskView } from "./desk/view";
import { createTaskWindowControl, taskControl } from "./agent/task-controls";
import { AgentHost, explainSignInError, gitHubReachable, idleWord, STOPPED_EVERYTHING, unansweredWord, type Hands, type TranscriptEntry } from "./agent/host";
import { composerSendRefusal } from "./agent/composer-refusal";
import { CONVERSATION_TEXT_LIMIT, conversationRequest } from "../shared/conversation";
import { projectAfterStatus, projectJobStops, projectMay, projectCommandFolder, projectCommandText, projectNames, projectSelection, projectStopped, removeProjectFile, projectPrompt, projectTurnRequest, ProjectInputError, ProjectModelError, PROJECT_MODEL_FAILED, PROJECT_PREVIOUS_ELSEWHERE, type ProjectSource } from "./agent/project";
import { exportProjectText } from "./agent/project-export";
import { applyNaturalVoicePreference, naturalVoiceChoices, naturalVoiceWanted } from "./voice-choice";
import { applyProjectPatch, readProjectPatch, type ProjectPatch } from "./agent/project-patch";
import { ProjectWorkspaceStore, workspaceAction, type ProjectExchange } from "./agent/project-workspaces";
import { memoryRefusal } from "./memory/guard";
import { correctMemoryRequest } from "./memory/correction";
import { expandedBubble, expandedSuggest, keysLanding, questionAloud, readKeyWords, readTimeOf } from "./agent/presenter";
import { electronClipboard } from "./agent/clipboard";
import { locateRuntime } from "./agent/runtime";
import { GrantKeeper, TokenStore, connectFirstAccepted, resolveToken, startDeviceFlow, pollDeviceGrant, type ResolvedToken, type SaveResult } from "./agent/auth";
import { cliTimedOutMessage, cliWaitStart, githubClientId, mayOpenSignInPage, noSignInMessage, type SignInWith } from "./agent/github-app";
import { AnswerLanguage, cancelWords, endsWithQuestion, spokenText } from "../voice/spoken";
import { SpeechStream } from "../voice/tts";
import { ENROL_PHRASES, encodePrint } from "../voice/voiceprint";
import { voiceprintStore } from "./voiceprint-store";
import { PersonalVoice } from "./personal/service";
import { wordsStore } from "./personal/words-store";
import { HEAR_SAMPLE, speakSettings, speaksAloud, speechSilenced } from "../shared/speech";
import { LOCKED_ASK, LockController, ScreenLock, holdNotice, lockAwareInput, lockedOutHands, logindLock } from "./screen-lock";
import { readAgentState } from "./agent/conductor";
import { loadPlatform, switchArgs } from "./platform";
import { helperStatusOfError, primaryScaledUnion, toHelperStatus } from "./platform/compose";
import type { HelperStatus, Input, OwnWindowHandle, SidecarContext, WindowSystem } from "./platform/types";
import { extraBinDirs } from "./platform/darwin/system";
import { deskProcesses } from "./desk/desk";
import { createTargets, targetDoctorRows, wslSwitchOn, type TargetsRuntimeExtra } from "./targets/runtime";
import { afterTargetFix, applySetupFix, targetChecksSource, withTargetChecks } from "./targets/setup-check";
import type { IpcLike, TargetsRuntime } from "./targets/types";
import { menuOptions } from "./targets/menu";
import { wrapForWsl } from "./wsl/routed-sidecar";
import { wrapWindowsForWsl } from "./wsl/routed-windows";
import { wslAwarePrivacy, wslAwareSystem } from "./wsl/privacy";
import type { Question } from "./agent/confirm";
import { afterFix, type FixId } from "./environment";
import { FINISH_SETUP, handleIdle, needsUser, settingsSection, setupIdle } from "../shared/setup-attention";
import { hello, keysLine } from "./hello";
import { TurnLatency } from "./turn-latency";
import { ACK_MS, acknowledgement, afterAck } from "./acknowledge";
import { MemoryService } from "./memory/service";
import { githubMemoryAccount, MemoryEpochAccount, MemoryOwner, type MemoryWait } from "./memory/owner";
import { MemoryLearning, linesAfterAskedForget, linesAfterForget, linesAfterRestore, withLearned, type MemoryLine } from "./memory/learning";
import type { OneShot } from "./memory/learn";
import { memoryActionOpens } from "./memory/questions";
import { BetterRecall } from "./memory/better-recall";
import { FEATURE_CONSENT_VERSION } from "../shared/consent";
import { installKind, releasePage, UpdateChecker, updateNotice } from "./updates";
import { ExtensionsService } from "./extensions/service";
import { registerExtensionsIpc } from "./extensions-ipc";
import { registerProviderIpc } from "./provider-ipc";
import { PROVIDER_KEY_FILE, ProviderKeyStore, activeProvider, checkAgain, createProviderService, ownProviderAuth, providerSummary, providerWaitingHost, redactingLogger, type ActiveProvider, type FetchLike } from "./provider";
import { PROVIDER_IPC } from "../shared/ipc";
import { recentLimit } from "../shared/ipc";
import { endpointHost } from "../shared/provider";
import { demoExtensionsApi, demoVariant } from "./extensions-demo";
import type { ExtensionsApi } from "../shared/extensions";
import { RoutineBook, countStoredRoutines, routinesFile } from "./agent/routines";
import { reminderNotification, type Reminder } from "./agent/reminders";
import { ReminderChangeSchema } from "../shared/reminders";
import { dockMenuItems, jumpListTasks, startView, wantsAsk } from "./launcher";
import { pushLater } from "./push-later";
import { askpassInEmber, isAskpassRun } from "../askpass/in-ember";

// SSH's password helper on macOS (review #177): the macOS build refuses node mode, so ssh's askpass wrapper starts
// Ember itself with --ember-askpass. That run asks the running Ember (askpass.cjs as a worker thread), prints the answer
// for ssh and ends here, before anything else of Ember starts: no single-instance lock, no window, nothing in the data
// folder, and no Dock icon (the run loop never starts; "prohibited" tells macOS so as well).
if (isAskpassRun(process.argv)) {
  try {
    if (typeof app.setActivationPolicy === "function") app.setActivationPolicy("prohibited");
  } catch {
    // Not on this OS, or refused: the run loop never starts, so nothing shows anyway.
  }
  const code = askpassInEmber({ script: path.join(__dirname, "askpass.cjs") });
  // Before the run loop app.exit ends the process at once; process.exit only stands behind it.
  app.exit(code);
  process.exit(code);
}

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
  electron: { app, screen, desktopCapturer, systemPreferences, shell, powerMonitor, browserWindow: BrowserWindow, utilityProcess },
  packaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: process.env,
});
const sys = platform.system;
useAppNames(platform.os);

// Linux: Chromium speaks (speechSynthesis) only through speech-dispatcher, and only with this switch. Windows: the
// video capture service runs in the browser process, not a process of its own (platform/types.ts).
for (const s of sys.chromiumSwitches) app.commandLine.appendSwitch(...switchArgs(s));
// Development only (test/voice-e2e): EMBER_TEST_MIC_WAV gives the microphone window a fake microphone that "hears"
// that WAV file (once; a trailing %noloop is added unless the path has one), with no device prompt.
const testMicWav = devEnv("EMBER_TEST_MIC_WAV");
if (testMicWav) {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", testMicWav.includes("%") ? testMicWav : `${testMicWav}%noloop`);
}

// ~/.config/ember on Linux unless overridden (tests use a temp dir).
app.setName("ember");
app.setPath("userData", process.env.EMBER_USER_DATA ?? sys.paths.userData(app.getPath("appData"), app.getPath("home")));
// Windows toasts need the app's AppUserModelId, set before ready.
if (sys.lifecycle.appUserModelId) app.setAppUserModelId(sys.lifecycle.appUserModelId);
const userData = app.getPath("userData");
// Private: settings, logs and the audit trail mention the user's apps and windows.
try { fs.mkdirSync(userData, { recursive: true, mode: 0o700 }); fs.chmodSync(userData, 0o700); } catch { /* reported when used */ }

// Any case; a name that isn't a level means info, said in the log (review #90).
const wantedLevel = logLevel(process.env.EMBER_LOG_LEVEL);
const log = createLogger({
  dir: path.join(userData, "logs"),
  level: wantedLevel.level,
  // `ember doctor` prints a report; log lines would get in its way.
  stdout: !process.argv.includes("--doctor") && (process.env.EMBER_LOG_STDOUT === "1" || !app.isPackaged),
});
if (wantedLevel.unknown !== undefined) log.warn("log.level_unknown", { value: wantedLevel.unknown.slice(0, 40), using: "info", levels: ["debug", "info", "warn", "error"] });

process.on("uncaughtException", err => log.error("uncaught exception", { err }));
process.on("unhandledRejection", reason => log.error("unhandled rejection", { reason }));
// GPU, utility and page crashes reach the log too (review #91).
watchCrashes(app, log);

/** Set once Ember couldn't start: its exit isn't the session ending (the run marker stays). */
let startFailed = false;
/**
 * Ember could not start: say so plainly and exit, so the single-instance lock isn't held by a hidden Ember. `said` is
 * the dialog's sentence: by default the plain words for `err` (startupProblem), never its own text, which the log keeps
 * (reliability-performance-r4-1).
 */
function startupFailed(err: unknown, said = startupProblem(err, userData, fs, platform.os)): void {
  startFailed = true;
  log.error("app.start_failed", { err });
  void app.whenReady().then(() => {
    // A dialog with no parent window comes up in front only once Ember is the active app (macOS).
    sys.lifecycle.focusOwnApp();
    // A log that couldn't be written (its folder can't be) isn't pointed to.
    dialog.showErrorBox("Ember couldn't start", startupDialogText(said, fs.existsSync(log.file) ? log.file : null));
    // Leave Electron from its message loop, not from inside ready (electron/electron#55011).
    setImmediate(() => app.exit(1));
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
  // Chromium can't take the lock in a data folder it can't write to either: that isn't another Ember (review #80).
  const unusable = dataFolderProblem(userData, process.pid, fs, platform.os);
  if (unusable) startupFailed(new Error(unusable), unusable);
  else {
    log.info("instance.handover", { pid: process.pid });
    app.quit();
  }
} else {
  try {
    start();
  } catch (err) {
    startupFailed(err);
  }
}

/**
 * What openWindows() returned (undefined until it has run), and the accelerators of Ember's shortcuts another app holds
 * (a default whose fallback Ember holds, or both chords of a shortcut it holds by neither: hotkey.ts holdShortcuts).
 */
let wsState: WindowSystem | null | undefined;
let shortcutsTaken: string[] | undefined;
/** Of Allow and Not now (held only while a question is up), the accelerators another app held when Ember last took them. */
let questionTaken: string[] = [];
/** The shared accessibility host's status (Windows, macOS): undefined until asked, null when it didn't answer. */
let helper: HelperStatus | null | undefined;
/**
 * Asks the shared host for it again (Windows) once the host is made (reliability-performance-c4-1); null on Linux, and
 * on macOS, whose Screen reading row reads the Accessibility permission live, not the host
 * (reliability-performance-v5-2).
 */
let helperWatch: HelperWatch | null = null;

/** The setup-check fixes the user applied while Ember runs (some rows then say what comes next, review #98). */
let fixesApplied: readonly FixId[] = [];
/** Whether Ember's spoken replies are heard: null until it has tried, false when no voice spoke (review #101). */
let speechHeard: boolean | null = null;

/** The setup checks: what this OS reports, plus what the running app has learnt (its display, shortcuts, helper, fixes). */
function readEnvironment(fresh = false): EnvReport {
  const report = inspectEnvironment({ ...sys.environment({ windows: wsState, shortcutsTaken, helper, ...(fresh ? { fresh } : {}) }), applied: fixesApplied, speech: speechHeard });
  onSetupRead?.(report.checks);
  return report;
}

/**
 * Speech models installed with Ember (the ember-voice-models package, which puts them in "/usr/share/ember/voice-models"
 * on Linux; sys.voice says where on each OS) are used in place of a download: the first such folder with what listening
 * needs. One it lacks (Ember's voice, Voice Match) comes from the user's own folder (`userRoot`), downloaded there.
 */
function voiceModelsRoot(): { root: string; bundled: boolean; userRoot: string } {
  const userRoot = path.join(userData, "models");
  const bundled = [devEnv("EMBER_VOICE_MODELS"), ...sys.voice.bundledModelDirs(process.resourcesPath ?? "")]
    .find((d): d is string => !!d && modelsReady(d));
  return bundled ? { root: bundled, bundled: true, userRoot } : { root: userRoot, bundled: false, userRoot };
}

/**
 * Where speech runs natively from sherpa-onnx's C API (app/voice/capi.ts), and whether it does (runtime.ts capiChoice):
 * EMBER_SHERPA_CAPI's folder in a development build, else a packaged Ember's own (sys.voice.nativeSpeechDir: Linux's
 * resources/voice-native). `choice` is null where there is no such folder (Windows and macOS run the addon).
 */
function nativeSpeech(): { capiDir: string | null; choice: BackendChoice | null } {
  const own = sys.voice.nativeSpeechDir(process.resourcesPath ?? "");
  const capiDir = devEnv("EMBER_SHERPA_CAPI") || (app.isPackaged ? own : null);
  if (own === null && !capiDir) return { capiDir: null, choice: null };
  return { capiDir, choice: capiChoice({ capiDir }) };
}

/** How gh is run to find a GitHub CLI sign-in on this OS (its path, no console window on Windows). */
const ghOptions = () => ({ path: sys.ghCliPath() ?? undefined, spawn: sys.spawnDefaults });
/** Whether the GitHub CLI is installed (the platform's own path for it, else on PATH): sign-in messages say how to get it. */
const ghInstalled = () => !!(sys.ghCliPath() ?? sys.which("gh"));
/** How this build signs in: Ember's own GitHub App when it has a client id (github-app.ts), else the GitHub CLI. */
const signInWith = (): SignInWith => githubClientId() ? "github" : "github-cli";

/** How long Ember's windows get to come up before a saved sign-in is read on macOS (the keychain may ask; ms). */
const KEYCHAIN_PAUSE_MS = 800;
/**
 * How long Check again waits for the shared host's status (Windows), as long as Linux's look: a bridge starting
 * again can take 20 s, and its answer then lands for the next read of the rows (reliability-performance-c4-1).
 */
const HELPER_RECHECK_MS = 6000;

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
    return helperStatusOfError(err);
  } finally {
    clearTimeout(timer);
    sidecar.stop();
  }
}

/** The user's settings file as it is on disk (the doctor only reads it), or null. */
function settingsText(): string | null {
  try {
    return readTextFile(path.join(userData, "settings.json"));
  } catch {
    return null; // none yet: defaults, WSL off
  }
}

async function runDoctor(): Promise<void> {
  let ws: WindowSystem | null = null;
  let input: Input | null = null;
  // A step that rejects exits 1: the check-up's report was never printed, so it can't pass.
  let failed = true;
  try {
    await app.whenReady();
    ws = wsState = platform.openWindows(log);
    helper = await doctorHelper();
    // The doctor reports completed checks; Home can show their pending state without blocking Stop.
    await sys.lookAgain?.();
    const env = readEnvironment();
    // The doctor never logged xtest.unavailable: no logger.
    input = platform.openInput(ws, null);
    const admin = sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY"));
    const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: app.isPackaged ? {} : process.env, runtimeId: sys.paths.runtimeId, exe: sys.paths.runtimeExe });
    let auth: DoctorProbes["auth"] = null;
    // The user's own provider by its host, with a key saved only if it was saved for that host (no keyring asked).
    const ownProvider = admin.policy.provider ? null : ownProviderAuth(settingsText(), admin, new ProviderKeyStore(path.join(userData, PROVIDER_KEY_FILE), safeStorage).savedHost());
    if (admin.policy.provider) auth = { kind: "provider", host: new URL(admin.policy.provider.baseUrl).host };
    else if (ownProvider) auth = ownProvider;
    else {
      const t = await resolveToken(new TokenStore(path.join(userData, "github-token.bin"), safeStorage), process.env, ghOptions()).catch(() => null);
      // After "Sign out" in Ember, a GitHub CLI or environment sign-in isn't used (as Ember itself does).
      const ignored = !!t && (t.source === "environment" || t.source === "github-cli") && readAgentState(path.join(userData, "agent.json")).signedOut;
      if (t && !ignored) auth = { kind: "github", source: t.source };
    }
    const signIn = { with: signInWith(), ghInstalled: ghInstalled() };
    const models = voiceModelsRoot();
    const probes = await sys.doctorProbes();
    // Input that can't reach apps counts as missing. Asked about the window the user is in, not window 0: macOS answers
    // for every window at once (the Accessibility permission, secure input), while Windows refuses a window it can't
    // check, and 0 is never one, so every Windows check-up would say input was missing. Linux has no such question.
    const blocked = ws && input?.blockedReason ? input.blockedReason(ws.activeWindow()?.id ?? 0) : null;
    // What stops Ember's typing but not its clicks (Linux: Typing Assist; macOS: an input method) has a row of its own.
    const typing = ws && input && !blocked ? input.keyboardBlockedReason?.() ?? null : null;
    if (typing) probes.extra.push({ id: "typing", status: "warn", label: "Typing", detail: typing });
    const checks = doctorChecks({
      os: platform.os, helper, env, compositor: ws ? ws.hasCompositor() : null,
      xtest: ws ? !!input && !blocked : null,
      speechDispatcher: probes.speechDispatcher, microphones: probes.microphones,
      voiceModels: models.bundled ? "bundled" : modelsReady(models.root) ? "downloaded" : "missing",
      voiceModelsMissing: missingModels([models.root, models.userRoot]).map(m => m.id),
      // Linux: native speech (the C API Ember carries) or WebAssembly; left out where the addon runs speech.
      speechBackend: nativeSpeech().choice,
      runtime: runtime.exists, auth, signIn, admin, desk: probes.desk, sandbox: probes.sandbox, fileWatchers: probes.fileWatchers,
      // The SSH client, WSL, the command window's terminal and the remote parts (§8.8).
      extra: [...(probes.extra ?? []), ...(await targetDoctorRows({ os: platform.os, sys, admin: () => admin, resourcesPath: process.resourcesPath, packaged: app.isPackaged, wslOn: wslSwitchOn(settingsText()) }))],
      shortcuts: sys.shortcuts, words: sys.words, policyLocation: sys.adminPolicy.location,
    });
    // The settings window's name for it (review #229).
    process.stdout.write(`Ember ${app.getVersion()} setup check\n\n${formatDoctor(checks)}\n`);
    failed = checks.some(c => c.status === "fail");
  } catch (err) {
    log.error("doctor.failed", { err });
    process.stderr.write(`Ember's setup check failed: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    // Even a close that throws must not keep the check-up alive.
    try { input?.close(); } catch (err) { log.warn("doctor.input_close_failed", { err }); }
    try { ws?.close(); } catch (err) { log.warn("doctor.windows_close_failed", { err }); }
    app.exit(failed ? 1 : 0);
  }
}

function start(): void {
  // The administrator's policy (/etc/ember/policy.json on Linux) overrides the user's settings. Read again every 10 s:
  // once it changes, Ember holds itself locked down until it is restarted (the watch below replaces both).
  let admin = sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY"));
  if (admin.error) log.error("admin_policy.invalid", { error: admin.error, note: "locked down until it is fixed" });
  else if (admin.source) log.info("admin_policy.loaded", { file: admin.source });
  let policy = admin.policy;
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
  // The last run's marker still there: it ended unexpectedly (main crashed, was killed, the power went: rp-5). Home says
  // so for this run, and the log says when it started; this run's own marker goes as it quits or the session ends.
  const lastRun = previousRun(userData);
  if (lastRun) log.warn("app.previous_run_ended", { startedAt: lastRun.startedAt, version: lastRun.version });
  startRun(userData, { pid: process.pid, version: app.getVersion() });
  let runEnded = false;
  const endThisRun = (how: "quit" | "session-end") => {
    if (runEnded) return;
    runEnded = true;
    if (how === "quit") log.info("app.quit", { how });
    endRun(userData);
  };
  app.on("will-quit", () => { endThisRun("quit"); unwatch(); try { settings.flush(); } catch (err) { log.warn("settings.not_saved", { err }); } });

  let home: BrowserWindow | null = null;
  let projectFiles: string[] = [];
  let projectPicking = false;
  let projectJob: AbortController | null = null;
  /** Jobs that send nothing (Apply patch): a connection that isn't ready doesn't stop them (projectJobStops). */
  const projectLocalJobs = new WeakSet<AbortController>();
  let projectPatch: ProjectPatch | null = null;
  let projectFolder: ReturnType<typeof projectCommandFolder> | null = null;
  let projectExchange: ProjectExchange | null = null;
  /** Whose the previous answer is (AgentHost.projectWorkspaceScope as it was given): it goes to no other service or account. */
  let projectExchangeScope: string | null = null;
  let projectOutput: { answer: string; diff?: string } | null = null;
  const projectWorkspaces = new ProjectWorkspaceStore(userData, safeStorage, platform.os === "darwin");
  const clearProject = () => { projectFiles = []; projectPatch = null; projectFolder = null; projectExchange = null; projectOutput = null; projectJob?.abort(); };
  /** Forgets Projects' work here and in Home together (integrations-r1): all of it, or the previous request and answer as context. */
  const forgetProject = (what: "all" | "previous") => {
    if (what === "all") clearProject(); else projectExchange = null;
    if (home && !home.isDestroyed()) home.webContents.send(IPC.projectForgot, what);
  };
  /** First run's "Hey Ember" try is showing: the microphone's level goes to the settings window too (IPC.watchLevel). */
  let homeWantsLevel = false;
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
    home = createHomeWindow(platform.os);
    home.once("ready-to-show", () => log.info("window.home.shown"));
    // Teaching Voice Match needs the window that shows the phrase: closed or hidden, it ends (voice-listening-v1).
    const cancelHomeListenOnce = () => { if (manualCall?.source === "home") voice?.cancelListenOnce(); endTeaching(); };
    // A crashed settings page comes back (it may be the consent page on first run).
    revive(home, reason => { cancelHomeListenOnce(); clearProject(); log.warn("window.home.renderer_gone", { reason }); });
    // While the user works in settings, Ember waits beside the window instead of over it.
    for (const e of ["focus", "blur", "move", "resize", "minimize", "restore", "hide", "show"] as const) home.on(e as "focus", stepAside);
    // Minimised or hidden, the page stops drawing its characters (X11 still reports it visible).
    const win = home;
    win.once("show", () => bringToFront(win));
    const shown = (on: boolean) => () => { if (!win.isDestroyed()) win.webContents.send(IPC.homeVisibility, on); };
    // Project work under way goes on while the window is minimised or hidden (integrations-6): closing it, a crash, the
    // screen lock, the policy and Stop everything still end it.
    const hidden = () => { shown(false)(); cancelHomeListenOnce(); };
    win.on("minimize", hidden); win.on("hide", hidden); win.on("restore", shown(true)); win.on("show", shown(true));
    home.on("closed", () => {
      cancelHomeListenOnce();
      enrolEnded = undefined;
      clearProject();
      home = null;
      homeWantsLevel = false;
      stepAside();
      if (greetOnClose) { greetOnClose = false; setTimeout(() => greet(), 300); }
    });
  };
  /** Ember greets once settings closes (first run while Copilot isn't connected yet). */
  let greetOnClose = false;
  /** Ember's own approval windows (made through the targets runtime's factories below), and whether a command card is up. */
  const approvals: { prompt: BrowserWindow | null; command: BrowserWindow | null } = { prompt: null, command: null };
  let commandCardUp = false;
  const shownWindow = (w: BrowserWindow | null) => (w && !w.isDestroyed()
    ? { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), bounds: w.getBounds() } : null);
  const stepAside = () => {
    // Settings while the user works in it; Ember's approval windows while they ask (review #125).
    const { aside, avoid } = keepClearOf({ home: shownWindow(home), prompt: shownWindow(approvals.prompt), command: shownWindow(approvals.command), commandCard: commandCardUp });
    overlay?.stepAside(aside);
    // The bubble keeps off the windows too.
    if (JSON.stringify(lastState.avoid ?? []) !== JSON.stringify(avoid)) showState({ avoid });
  };
  /** An approval window the targets runtime had main make: Ember and its bubble keep clear of it while it asks. */
  const keepClear = <W extends BrowserWindow>(which: "prompt" | "command", win: W): W => {
    approvals[which] = win;
    for (const e of ["move", "resize", "minimize", "restore", "hide", "show"] as const) win.on(e as "show", stepAside);
    win.on("closed", () => { if (approvals[which] === win) approvals[which] = null; stepAside(); });
    return win;
  };
  const homeOpen = () => !!home && !home.isDestroyed() && home.isVisible() && !home.isMinimized();

  // Started again: settings from the keyboard, or the ask box when a launcher's Ask Ember started it with --ask (D-45b),
  // on a first start's terms: once Ember is set up, and in a desktop session it can use (else settings and their check).
  app.on("second-instance", (_e, argv) => {
    const ask = wantsAsk(argv);
    log.info("instance.second", ask ? { ask } : {});
    const view = ask ? startView({ onboarded: settings.get().onboarded, showSettings: false, atLogin: false, sessionProblem: !!sessionGreeting(readEnvironment()), ask }) : "settings";
    if (view === "ask") openAsk({ source: "launcher" }); else showHomeFromKeys();
  });

  // No page may open windows or navigate away from our bundled files.
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", e => e.preventDefault());
    // Calm mode reaches every page of Ember's as it loads, those sent no settings too (page-prefs.ts).
    contents.on("dom-ready", () => void applyPagePrefs(contents, pagePrefs(settings.get())));
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
    // The chords Ember holds: a fallback while another app holds the default, none while it holds both (D-45b).
    shortcuts: shownShortcuts(sc, heldShortcuts(sc, fb, [...shortcutsTaken ?? [], ...questionTaken])),
    dataDir: sys.paths.dataDirLabel(userData),
    settingsFile: sys.paths.dataDirLabel(userData, "settings.json"),
    auditCopy: sys.auditCopy(),
    micIndicator: sys.words.micIndicator,
    permissionsNote: sys.words.permissionsNote,
    speakerRejection: sys.voice.speakerMonitor,
    outputLevel: sys.voice.outputLevel,
    fixLabels: Object.fromEntries(sys.fixes.ids.map(id => [id, sys.fixes.label(id)])),
    desk: !!platform.desk && platform.desk.available().ok,
    autostartNote: sys.autostart.note(),
    install: installKind({ os: platform.os, packaged: app.isPackaged, execPath: process.execPath, appImage: runningAppImage(process.env, process.execPath), exists: fs.existsSync }),
  });
  // The setup check shows the other computers' and WSL's rows too, as ember --doctor does (§8.8): read through the
  // targets runtime, kept a few seconds, and waited for briefly (the rows from before show while a slow one finishes).
  const targetChecks = targetChecksSource(() => targets?.doctorRows() ?? Promise.resolve([]), { keepMs: 15_000, waitMs: 3000, now: () => Date.now() });
  const environmentNow = async (fresh = false) => {
    // Check again: what waits between tries looks now, and is waited for here, never on the main thread
    // (reliability-performance-r2: a hung pyatspi import froze Ember for 5 s). Its look gives up after 5 s.
    const targetRows = targetChecks(fresh);
    if (fresh && sys.lookAgain) await Promise.race([sys.lookAgain().catch(() => undefined), new Promise(r => setTimeout(r, 6000))]);
    // Windows: the shared host's status, which was asked once after start, is asked now (reliability-performance-c4-1).
    if (fresh && helperWatch) await helperWatch.again();
    return withTargetChecks(readEnvironment(fresh), await targetRows);
  };
  ipcMain.handle(IPC.getStatus, guard(async (): Promise<Status> => ({
    appVersion: app.getVersion(),
    settings: settings.get(),
    environment: await environmentNow(),
    logFile: log.file,
    settingsNotice,
    unexpectedExit: lastRun ? { startedAt: lastRun.startedAt, version: lastRun.version } : null,
    admin: homeAdmin(admin),
    platform: platformStatus(),
  })));
  // Every entry the log keeps: the window shows the newest 80 it has lines for (a command writes several entries).
  ipcMain.handle(IPC.activity, guard((limit: unknown) => audit?.recent(recentLimit(limit)) ?? []));
  /** The administrator's never-look entries are applied on top; they never go into the user's own list. */
  const ownNeverLook = (patch: SettingsPatch): SettingsPatch => {
    if (!patch.privacy?.neverLook || !policy.neverLook.length) return patch;
    const lower = (x: string) => x.toLowerCase();
    const mine = new Set(settings.own().privacy.neverLook.map(lower));
    const adminOnly = new Set(policy.neverLook.map(lower).filter(x => !mine.has(x)));
    return { ...patch, privacy: { ...patch.privacy, neverLook: patch.privacy.neverLook.filter(x => !adminOnly.has(lower(x))) } };
  };
  // Dragging the size slider sends a change per step: shown at once, saved a moment later.
  ipcMain.handle(IPC.updateSettings, guard((sent: unknown) => {
    // Where Ember works and what commands may do change only behind their consent cards (TARGETS_IPC), never here.
    const { patch, dropped } = settingsFromHome(checkHomePatch(sent));
    if (dropped.length) log.warn("settings.update_refused", { keys: dropped });
    const sizeOnly = !!patch && typeof patch === "object" && Object.keys(patch).length === 1 && "size" in patch;
    // A save that failed reaches the window as one plain sentence (review #84). A change to Work without asking is Home's
    // (its audit entry says so; one found in the file otherwise is "file").
    if (patch && typeof patch === "object" && "autonomy" in patch) autonomyChangedBy = { via: "home", verified: false };
    try { return settings.update(ownNeverLook(withOwnExtensions(withOwnProvider(withOwnTrust(patch, settings.own().trust), settings.own().provider), settings.own().extensions)), { soon: sizeOnly }); } catch (err) { throw plainSaveError(err); } finally { autonomyChangedBy = null; }
  }));
  // Only the fixes this OS offers (Linux: turning on GNOME's accessibility switch), and the targets runtime's
  // wsl-a11y:<distro> (§8.8); any other id is refused before anything runs.
  // Check again (first-run-6): the setup rows read anew, a throttled probe included, after the user ran a fix themselves.
  ipcMain.handle(IPC.recheckSetup, guard(async () => environmentNow(true)));
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
    if (nativeTheme.themeSource !== s.appearance) nativeTheme.themeSource = s.appearance;
  });
  // And again when it changes (only then: the size slider changes the settings many times a second). The command and
  // prompt windows grow with the text size, open ones too (windows.ts).
  let pagePrefsKey = JSON.stringify(pagePrefs(settings.get()));
  setTextScale(textScale(settings.get().textSize));
  settings.onChange(s => {
    const prefs = pagePrefs(s);
    if (JSON.stringify(prefs) === pagePrefsKey) return;
    pagePrefsKey = JSON.stringify(prefs);
    setTextScale(textScale(prefs.textSize));
    for (const w of BrowserWindow.getAllWindows()) void applyPagePrefs(w.webContents, prefs);
  });

  // Ember keeps running without windows: the overlay and handle are its presence.
  app.on("window-all-closed", () => { /* stay alive */ });

  let overlay: OverlayManager | null = null;
  let handle: HandleWindow | null = null;
  let greetTimer: NodeJS.Timeout | null = null;

  // The handle says Ready only once Copilot is connected.
  // Before first run is done, that it needs finishing (first-run-8).
  let lastState: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null, idle: handleIdle(settings.get().onboarded, "Not connected") };
  let confirmer: Confirmer | null = null;
  /** Which tasks the owner asked for in a verified voice: their own questions may take a short spoken yes (voice-answer.ts). */
  const voiceTrust = new TaskVoiceTrust();
  // While the user works on Ember's desk, the task cards stay out of the enlarged view's way.
  let deskInControl = false;
  /** The task cards changed: Home's Task activity hears of it (set once the agent's handlers are, below). */
  let tasksShown = () => { /* nothing to tell until then */ };
  /** What the Ask box offers may have changed: an open box hears of it (set once the box is made, below). */
  let askOffersChanged = () => { /* no box yet */ };
  /**
   * The words of the answer opened in full whose last line the corner card has shown (no compositor: the card shows the
   * bubble; OVERLAY.handleAnswerEnd), null once that answer no longer shows (companion-repairs-x6-3).
   */
  let cardEnded: string | null = null;
  const showState = (next: Partial<EmberState>) => {
    lastState = { ...lastState, ...next };
    if (next.bubble && !answerEndShown(next.bubble, null, cardEnded)) cardEnded = null;
    if (next.tasks) tasksShown();
    // The answer its chips follow went, or a new one came (companion-c2-2).
    if (next.bubble || "suggest" in next) askOffersChanged();
    // Shown just for an answer the user asked for while Ember was hidden: hidden again once it's read.
    if (hidesAgainAfter(shownForAnswer, next)) { shownForAnswer = false; keptHidden = true; overlay?.setHidden(true); }
    overlay?.setState(deskInControl && next.tasks ? { ...next, tasks: [] } : next);
    handle?.sendState(lastState);
    syncHandle();
  };
  /** Hidden, Ember's handle shrinks to its face in the corner (the way back to Show Ember); shown, it is the pill again. */
  const syncHandle = () => { if (handle?.setCompact(overlay?.isHidden() ?? false)) deskViewRef?.handleMoved(); };
  // While Ember is asking the user something, nothing else may replace the question
  // (a worker's reasoning would otherwise wipe the buttons before they're clicked).
  const setState = guardWhileAsking(() => confirmer?.waiting ?? false, showState);
  /** The setup rows as last read (none until then), for the handle's word: a status change doesn't read them again. */
  let setupSeen: EnvReport["checks"] = [];
  /** The handle's word: the agent's ("Ready", or why Ember can't answer yet), or "Finish setting up" before first run is done. */
  const idleNow = (status: Parameters<typeof idleWord>[0]) => handleIdle(settings.get().onboarded, idleWord(status));
  /**
   * The setup row that holds Ember back while Copilot is ready, in a few words ("Fix “Screen reading”", review #95):
   * the handle says it when nothing more urgent is going on (a task, a question), never in place of those.
   */
  const setupNow = (status: Parameters<typeof idleWord>[0]) => setupIdle(status.phase, setupSeen);
  /**
   * Setup rows just read (every readEnvironment: the settings window's status and focus re-read, a fix, Start, the
   * hello): kept, and the handle's word follows them, so "Setup needed" goes once the row holding Ember back is fixed.
   */
  const sawSetup = (rows: EnvReport["checks"]) => {
    setupSeen = rows;
    const status = agent?.getStatus();
    const setup = status ? setupNow(status) : null;
    if (status && setup !== (lastState.setup ?? null)) showState({ setup });
  };
  onSetupRead = sawSetup;
  /** This OS's setup rows now, for the Start decision and the hello (none if they can't be read: words, never a gate). */
  const setupRows = (): EnvReport["checks"] => {
    try { return readEnvironment().checks; } catch (err) { log.warn("environment.read_failed", { err }); return []; }
  };

  /** How many times its usual time a bubble stays, and how long a question waits: the user's "More time to read and answer". */
  const readTime = () => readTimeOf(settings.get().moreTime);
  /** Hides `bubble` later (as long as the user needs to read it), unless something else has replaced it by then. */
  const hideIfStill = (bubble: EmberState["bubble"], ms: number) => setTimeout(() => {
    if (lastState.bubble === bubble) setState({ emotion: "neutral", bubble: IDLE_BUBBLE });
  }, ms * readTime());
  /** Ember's shortcuts on this OS (one table: the accelerators, and how the copy names them). */
  const sc = sys.shortcuts;
  /** Each shortcut's fallback on this OS (D-45b): Ember holds it while another app holds the default. */
  const fb = FALLBACK_SHORTCUTS[platform.os];
  /**
   * The chord Ember holds for one of its shortcuts now: its default, its fallback, or null (another app holds both).
   * Allow and Not now: as Ember last took them, for a question.
   */
  const holding = (id: ShortcutId): ShortcutDef | null => heldShortcuts(sc, fb, [...shortcutsTaken ?? [], ...questionTaken])[id];
  /** A shortcut as the copy names it ("Ctrl+Alt+E"), by the chord Ember holds; null while it holds neither. */
  const keyName = (id: ShortcutId) => holding(id)?.label ?? null;
  /**
   * Settings opened from the keyboard (Ember started again, its settings shortcut, the Dock): while the bubble says Ember
   * is still waiting, at Stop response, as its step says (accessibility-visual-2); while another app holds the ask or
   * stop shortcut and its fallback, at Ask Ember… or Stop everything, the keyboard's way to them then (review #45).
   */
  const showHomeFromKeys = () => {
    showHome();
    const at = keysLanding(agent?.conversationTurn ?? "idle", keyboardRoute(shortcutsTaken ?? [], sc, fb));
    if (at) sendToHome(IPC.focusSection, at);
  };
  const greet = () => {
    const phase = agent?.getStatus().phase;
    const connected = phase !== "signed-out" && phase !== "error";
    // Offline at start (a retry waits for the network): Ember connects by itself, there is nothing to set up.
    const waiting = phase === "error" && (agent?.waitingForNetwork ?? false);
    // The chords Ember holds (a fallback named as such); for shortcuts it holds by neither, the handle for a pointer,
    // and settings' Ask Ember… for the keyboard.
    const keys = keysLine(heldShortcuts(sc, fb, shortcutsTaken ?? []), sc);
    const settingsOpen = homeOpen();
    // Why Ember can't work here at all, said in place of everything else: the organisation's lockdown first (#107; no
    // session helps until the policy is fixed), then a session Ember can't use (Wayland, no X display, #240). Else what
    // Ember says and for how long (hello.ts): connected, it names a setup row that holds it back (review #95).
    const cannotWork = modelServiceRefusal(admin) ?? sessionGreeting(readEnvironment());
    // The user's own provider or the organisation's service is named, never GitHub or Copilot (first-run-r1).
    const service = agent?.getStatus().service;
    // Signed out while the user's own provider waits for its card: agreeing is the way on (integrations-v4-3).
    const providerWaiting = phase === "signed-out" && !fixedProvider ? providerWaitingHost(settings.get(), admin) : null;
    const h = hello({ phase, waiting, overlay: !!overlay, keys, settingsKey: keyName("settings"), settingsOpen, rows: connected ? setupRows() : [], providerWaiting, service, cannotWork });
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
  // An update replaced Ember's files under it (an RPM upgrade): as a window opens, which would load the new version's
  // pages, offer to restart (install-watch.ts; a packaged Ember only).
  const updateCheck = app.isPackaged ? createUpdateCheck({
    file: path.join(app.getAppPath(), "package.json"),
    ask: async () => {
      log.info("app.updated_while_running");
      sys.lifecycle.focusOwnApp();
      const { response } = await dialog.showMessageBox({
        type: "info", buttons: [...UPDATED_QUESTION.buttons], defaultId: 0, cancelId: 1,
        title: UPDATED_QUESTION.title, message: UPDATED_QUESTION.message, detail: updatedDetail(quitWords()),
      });
      return response === 0;
    },
    restart: () => { log.info("app.restart_after_update"); restartAfterUpdate(app, process.env, process.argv, process.execPath); },
  }) : null;
  app.on("browser-window-created", () => updateCheck?.beforeWindow());
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
  const focusNow = (): { id: number; ember: boolean } => noteFocus(wsRef?.focusWindow() ?? null);
  /** focusNow() for a window with the keyboard taken already (the ask box takes it with the active window: ask-open.ts). */
  const noteFocus = (f: { id: number; pid: number | null } | null): { id: number; ember: boolean } => {
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
    // The shortcut is part of the label (Chromium would print it "Alt+Ctrl+…"): the chord Ember holds (its fallback while
    // another app holds the default, D-45b), and none when another app holds both. A Mac's own menus show it as the
    // system does (⌃⇧⌘Space), from the accelerator, which is shown but never registered.
    const keyed = (text: string, def: ShortcutDef): Pick<Electron.MenuItemConstructorOptions, "label" | "accelerator"> => {
      const id = (Object.keys(sc) as ShortcutId[]).find(k => sc[k] === def);
      const now = id ? holding(id) : def;
      return !now ? { label: text } : platform.os === "darwin" ? { label: text, accelerator: now.accel } : { label: `${text}   ${now.label}` };
    };
    // An item that opens one of Ember's windows (the ask box, settings, the quit question) keeps the focus it
    // takes: the user's app doesn't get it back over the window (settings shows only once it has loaded).
    let opens = false;
    // No guard on menu-will-close: Electron sends it just before the picked item's click, so such a guard swallowed
    // every real pick. What keeps a pick nobody made away is the released() gate below: the menu opens only once the
    // button that opened it is up, so its release can't choose "Ask Ember…". (The check once the menu has closed,
    // ask.spurious_after_menu, only puts away an ask box that opened with no item's click at all: a click on "Ask
    // Ember…", whatever caused it, counts as a pick.)
    const menu = Menu.buildFromTemplate([
      // First run isn't done (the handle says "Finish setting up"): the way back to it comes first (first-run-8).
      ...(settings.get().onboarded ? [] : [{ label: `${FINISH_SETUP}…`, click: () => { opens = true; showHome(); } }, { type: "separator" as const }]),
      // What the user was in was read before the handle took focus: looking again would find the handle.
      { ...keyed("Ask Ember…", sc.ask), registerAccelerator: false, click: () => { opens = true; openAsk({ look: false, over: back, source: "menu" }); } },
      // While Ember talks: only its voice stops, not its tasks (voice-speaking-5).
      ...(voice?.speaking ? [{ label: "Stop speaking", click: () => stopSpeaking("menu") }] : []),
      { ...keyed("Stop everything", sc.stop), registerAccelerator: false, click: () => stopEverything("menu") },
      // "Work on" (which computer requests go to), when there is more than this one.
      // An item that opens settings ("Bring Ember to a computer…") marks it before its click (targets/menu.ts).
      ...menuOptions(targets?.menuItems() ?? [], () => { opens = true; }),
      ...(voice && consented() && policy.features.voice !== false
        ? [{ ...keyed(voice.isMuted ? "Unmute microphone" : "Mute microphone", sc.mute), registerAccelerator: false, click: toggleMute }]
        : []),
      // A microphone that can't hear "Hey Ember": the way to fix it (Settings, at Voice, says why and how).
      ...(voice?.micState === "error" ? [{ label: MIC_PROBLEM_MENU, click: () => { opens = true; showHome(); sendToHome(IPC.focusSection, "voice"); } }] : []),
      ...(agent?.lastAnswer() ? [{ label: "Read the last answer", click: () => { opens = true; readLastAnswer(); } }] : []),
      { type: "separator" },
      { ...keyed("Settings…", sc.settings), registerAccelerator: false, click: () => { opens = true; showHome(); } },
      { label: paused ? "Follow my cursor" : "Stay put", enabled: !!overlay, click: () => { followPaused = !paused; overlay?.setPaused(followPaused); presenceChanged(); } },
      { label: hidden ? "Show Ember" : "Hide Ember", enabled: !!overlay, click: () => { shownForAnswer = false; keptHidden = !hidden; overlay?.setHidden(!hidden); syncHandle(); presenceChanged(); } },
      // Handle position (review #75): the handle (pill, tab or card) and its task cards go to the other bottom corner.
      { label: "Move to the other side", click: moveHandle },
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
    // box was opened over still stands. The ask box hides when it loses focus, so focus goes back past it. The read
    // runs once the handle has the keyboard, so where Ember can't hold it (Windows, macOS) it is told what had it
    // (cross-review P1).
    const had = focusNow();
    const fromAskBox = had.ember && askWindow.isWindow(had.id);
    if (!fromAskBox) captureContext(undefined, focusBeforeNow(wsSeenRef ?? wsRef, !!platform.keyboardHold));
    // From the ask box (it hides when it loses focus), focus goes back to what the box was opened over.
    const fromDesk = had.ember && !!deskViewRef?.isWindow(had.id);
    const back = fromAskBox ? askOver : had.id;
    menuOpen = true;
    const askWasVisible = askWindow.visible;
    const open = () => menu.popup({ window: win, callback: () => setTimeout(() => {
      menuOpen = false;
      // The ask box opened while the menu was up, but no item's click opened it: put it away (nobody picked it).
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
  let followPaused = false;
  /** The handle menu's "Move to the other side": Handle position flips, and the settings change moves the handle. */
  const moveHandle = () => {
    try { settings.update({ handlePosition: otherSide(settings.get().handlePosition) }); } catch (err) { log.warn("handle.move_not_saved", { err }); }
  };
  let presenceChanged = () => { /* set once the IPC is ready */ };
  /** The whole answer in Home's conversation; the bubble goes, so Ember doesn't sit over it holding the old one. */
  const readLastAnswer = () => {
    // The answer being read in full goes from the bubble (with or without a "Read all" button), and the hold its
    // "Read all" pinned with it ("Open in settings" on the expanded answer: as Close).
    if (lastState.bubble.visible && lastState.bubble.actions.every(a => a.id.startsWith("ui:"))) {
      setState({ emotion: "neutral", talking: false, bubble: IDLE_BUBBLE });
      agent?.releasePin(lastState.bubble);
    }
    showHome();
    // At that answer, from its top: not at the conversation's oldest message (home-v1).
    sendToHome(IPC.focusSection, "conversation:latest");
  };
  /** "Read all": the whole answer in the bubble, where the user was reading it (settings keeps it too). */
  const expandAnswer = () => {
    const full = agent?.lastAnswer();
    if (!full) { readLastAnswer(); return; }
    agent?.claimBubble({ pin: true });
    // Its suggestions follow all of it now, also past the 600 characters the bubble showed (companion-v6-1).
    const suggest = expandedSuggest(lastState.suggest, lastState.bubble, full);
    setState({ talking: false, bubble: expandedBubble(lastState.bubble, full), ...(suggest !== lastState.suggest ? { suggest } : {}) });
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

  /**
   * Settings › Memory: at its list for a forget request, else at its note's words (shown while memory is off or waits
   * for it). Never at the note's "I agree, remember", where an Enter or a space typed on would agree (memory-r7).
   */
  const openMemory = (at: "list" | "note" = "note") => { showHome(); sendToHome(IPC.focusSection, at === "list" ? "memory:memory-query" : "memory:memory-consent-text"); };

  const sendToHome = (channel: string, value: unknown) => {
    const send = () => { if (home && !home.isDestroyed()) home.webContents.send(channel, value); };
    if (home && !home.isDestroyed() && home.webContents.isLoading()) home.webContents.once("did-finish-load", send); else send();
  };
  /**
   * Questions are answered with keys too (Orca and keyboard users can't click the bubble): Y allows, N says
   * not now, each by its fallback while another app holds the default (D-45b). "Always" is a click only: a global key
   * would take an app's own Ctrl+Alt+A and grant for good.
   */
  const QUESTION_KEYS: readonly { id: "allow" | "deny"; which: "primary" | "deny"; hint: string; say: string }[] = [
    { id: "allow", which: "primary", hint: "allow", say: "to allow" },
    { id: "deny", which: "deny", hint: "not now", say: "for not now" },
  ];
  /** The question keys are held now (a question is up). */
  let questionKeysUp = false;
  const holdQuestionKeys = () => {
    if (questionKeysUp && heldKeys().length) return;
    const { taken } = holdShortcuts(QUESTION_KEYS.map(k => k.id), sc, fb, {
      isRegistered: accel => globalShortcut.isRegistered(accel),
      register: (id, accel) => globalShortcut.register(accel, () => confirmer?.answerKey(id === "allow" ? "primary" : "deny")),
    });
    for (const accel of taken.filter(a => !questionTaken.includes(a))) log.warn("shortcut.question_key_taken", { accel });
    questionTaken = taken;
    questionKeysUp = true;
  };
  /** The question keys Ember holds now, each named by the chord it holds (its default or its fallback). */
  const heldKeys = () => (questionKeysUp ? QUESTION_KEYS.flatMap(k => {
    const def = holding(k.id);
    return def ? [{ ...k, hint: `${def.label} ${k.hint}`, say: `${def.say} ${k.say}` }] : [];
  }) : []);
  /** The keys that answer the question now up, for its bubble (only keys Ember actually holds). */
  const questionKeyHint = () => { holdQuestionKeys(); return heldKeys().map(k => k.hint).join(" · ") || undefined; };
  const questionChanged = (q: { n: number; question: Question } | null) => {
    // A Listen once hearing a request ends for the question (below): its control says so while one is up (companion-r2-2).
    listenCutFor = q ? listenCutFor ?? cutByQuestion(manualCall?.source, voice?.listenOnceStatus) : null;
    // The keys are held first, so a command card names the keys that answer it (the targets runtime asks keyHint).
    if (q) holdQuestionKeys();
    // A question with a panel (a command, a consent card) shows its window; the window goes with it. While a command
    // card is up, Ember and its bubble keep clear of the command window (review #125).
    commandCardUp = q?.question.panel?.kind === "command";
    // The voice process hears a short "no" in a follow-up window as an answer while a question is up (engine.ts).
    voice?.questionUp(q !== null);
    // "Answer Ember's question first." comes and goes with it (Listen once takes no press while it holds: companion-3).
    syncListenOnce();
    // So do the Ask box's suggestions: "Yes, please" there would only seem to answer it (companion-r2-1).
    askOffersChanged();
    targets?.questionChanged(q);
    presenceChanged();
    stepAside();
    if (!q) {
      for (const k of QUESTION_KEYS) for (const accel of [sc[k.id].accel, fb[k.id].accel]) if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
      questionKeysUp = false;
      return;
    }
    holdQuestionKeys();
    // The question replaced an expanded answer and its Close button: the pinned hold has nothing left to keep. What it
    // held off shows after the question (the question holds everything meanwhile).
    agent?.releasePin(lastState.bubble);
    // A question nobody can see expires as "no": a hidden Ember shows itself to ask (and stays shown,
    // also when the compositor comes back while the question is on the card). The handle is the pill again with it, not
    // the hidden-state tab (cross-review X6).
    keptHidden = false;
    if (overlay?.isHidden()) { overlay.setHidden(false); syncHandle(); presenceChanged(); }
    // A command is never read out or put in a notification (R7): only that Ember wants to run one, and where; the card
    // on screen shows it, and the keys work only there.
    const words = targets?.questionWords(q.question) ?? null;
    // On another computer it says which (§2.4), aloud and in the notification as the bubble's badge does.
    // A question with a whole text to read (review #116): the approve key shows its next part until all of it has been shown.
    const aloud = questionAloud(q.question, { keys: (q.question.detail ? readKeyWords(heldKeys()) : heldKeys()).map(k => k.say), spoken: spokenText });
    voice?.cancelListenOnce();
    pauseAnswerSpeech();
    if (maySpeak()) voice?.speak(words ?? aloud.say);
    if (userAway()) notify("Ember needs your OK", words ?? aloud.notify);
  };
  /** The user isn't looking at Ember right now (idle, or Ember hidden). */
  const userAway = () => (overlay?.isHidden() ?? false) || powerMonitor.getSystemIdleTime() >= 30;
  /** Notifications with a click, kept until they close: one that is garbage-collected never reports its click. */
  const clickable = new Set<Notification>();
  const notify = (title: string, body: string, onClick?: () => void) => {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body: notificationBody(body), silent: false });
      if (onClick) {
        clickable.add(n);
        n.on("click", () => { clickable.delete(n); onClick(); });
        n.on("close", () => clickable.delete(n));
      }
      n.show();
    } catch (err) { log.warn("notify.failed", { err }); }
  };
  let askHistory: string[] = [];
  /**
   * Speak replies: always, or while a screen reader runs (Orca, Narrator, VoiceOver; the default), or never, as the user
   * chose (review #55); never when the organisation turned speaking off.
   */
  let accountErasures = 0;
  const maySpeak = () => accountErasures === 0 && policy.features.speak !== false && !screenLock?.locked && speaksAloud(settings.get(), () => sys.a11y.screenReaderOn());
  /**
   * The answer being spoken as it streams: each message's first sentence cuts off whatever Ember was saying (as a new
   * answer always did), the rest follow it.
   */
  const answerSpeech = new SpeechStream();
  /** The answer's language, decided once for all its pieces (voice-speaking-r1): Kitten reads only English. */
  const answerLanguage = new AnswerLanguage();
  let answerSpoken = false;
  let answerInterrupted = false;
  /**
   * Stop speaking silenced this answer: the rest of it isn't said, but its words still reach the bubble, Home and the
   * transcript, and it is still the answer (the suggestions, Read the last answer: voice-speaking-c1-1).
   */
  let answerHushed = false;
  let answerEpoch = 0;
  /** How long each spoken request takes to be answered aloud, step by step: one `voice.latency` line, times only. */
  const turnLatency = new TurnLatency({ log: times => log.info("voice.latency", { ...times }) });
  /** The acknowledgement said for the answer now streaming (its first words don't say it again: afterAck). */
  let ackSaid: string | null = null;
  /**
   * Speaking turned off while Ember talks (Never chosen, the screen reader it spoke for gone): what it is saying stops
   * now, not at the end of the answer (voice-speaking-4, WCAG 1.4.2). On every settings change, and before each
   * sentence of an answer (a screen reader going says nothing to Ember). Whether Ember may speak now.
   */
  const silenceIfOff = (): boolean => {
    const allowed = maySpeak();
    if (speechSilenced(!!voice?.speaking, allowed)) { cancelAck(); voice?.hush(); }
    return allowed;
  };
  /**
   * `end`: the message is complete, so nothing of it waits any longer to tell its language; `more`: it ended before a
   * tool call, so a short one decides nothing for the messages after it (voice-speaking-r2-1).
   */
  const sayStreamed = (chunks: string[], end = false, more = false) => {
    if (answerInterrupted || confirmer?.waiting || !silenceIfOff()) return;
    for (const { text: chunk, lang } of answerLanguage.take(chunks, end, more)) {
      const c = afterAck(chunk, ackSaid);
      ackSaid = null;
      if (!c.trim()) continue;
      turnLatency.mark("firstChunk"); voice?.speak(c, { append: answerSpoken, lang }); answerSpoken = true;
    }
  };
  /**
   * The acknowledgement waiting for the spoken request in flight (acknowledge.ts): said if Copilot hasn't started
   * answering within ACK_MS, and the answer then follows it rather than cutting it off.
   */
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelAck = () => { if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; } };
  const ackLater = (request: string) => {
    cancelAck();
    const epoch = answerEpoch;
    const ack = acknowledgement(request);
    if (!ack || !maySpeak()) return;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (epoch !== answerEpoch || answerInterrupted || confirmer?.waiting || !maySpeak() || answerSpoken) return;
      turnLatency.mark("ack");
      // After whatever Ember is saying (a reminder, a task's result), not cutting it off.
      voice?.speak(ack, { append: true });
      answerSpoken = true;
      ackSaid = ack;
    }, ACK_MS);
    ackTimer.unref?.();
  };
  /** Interruption retires the stream and its delayed acknowledgement, not only audio already queued for playback. */
  const resetAnswerSpeech = () => {
    answerEpoch++;
    answerInterrupted = true;
    cancelAck();
    answerSpeech.reset();
    answerLanguage.reset();
    answerSpoken = false;
    ackSaid = null;
    lastAskByVoice = false;
    turnAnswer = "";
    lastReply = "";
    answerHushed = false;
    voice?.hush();
  };
  /**
   * Stop speaking (the handle's menu, while Ember talks): its voice stops and the rest of this answer isn't said, while
   * the answer's words and every task go on (voice-speaking-5). The conductor's answer isn't interrupted, which would
   * drop the rest of its words and mark it stopped (voice-speaking-c1-1). Stop everything stays the kill switch.
   */
  const stopSpeaking = (source: "menu") => {
    log.info("voice.stop_speaking", { source });
    const open = !!agent?.answerOpen;
    resetAnswerSpeech();
    answerHushed = open;
  };
  /** A permission card pauses this request; the tool's later reply still belongs to its original spoken turn. */
  const pauseAnswerSpeech = () => {
    const spoken = lastAskByVoice, interrupted = answerInterrupted, hushed = answerHushed;
    resetAnswerSpeech();
    lastAskByVoice = spoken;
    answerInterrupted = interrupted;
    answerHushed = hushed;
    agent?.pauseAnswer();
  };

  // ───── Copilot brain ─────
  /** The ask box's window as last given the keyboard (an X window on Linux; 0: not yet, or it can't be told). */
  let askXid = 0;
  /** When the ask box was last asked for (Date.now()): how long it took to have the keyboard is logged (ask.keyboard). */
  let askAsked = 0;
  const askWindow = new AskWindow({
    os: platform.os,
    keepOff: () => handle?.bounds ?? null,
    // The task cards: what the box shows keeps off them where it can (companion-r5-1).
    cards: () => overlay?.cardsRects() ?? [],
    // The answer or question Ember shows: the box opens beside it, not on it (companion-1).
    bubble: () => overlay?.bubbleRect() ?? null,
    // Where the box is while it is open: a bubble that comes up meanwhile keeps off it (companion-c1-1).
    // While it is open, the answer being replied to stays beside it (companion-c2-1).
    onBounds: askBox => { if (JSON.stringify(lastState.askBox ?? null) !== JSON.stringify(askBox)) showState({ askBox }); agent?.holdForAsk(askBox !== null); },
    // Clicks only on what it shows, where the window system can say so (Linux's input shape: companion-4).
    shape: (w, rects) => platform.overlay.setInputRegion(w, rects, screen.getDisplayMatching(w.getBounds()).scaleFactor || 1),
    windowId: w => ownId(w),
    floating: platform.overlay.floating("ask"),
    // A click into another app once the box has had the keyboard closes it there, also in the handover (review #84).
    settleMs: platform.os === "darwin" ? MAC_SETTLE_MS : undefined,
    // As the handle's menu takes the keyboard: the window manager is asked, and X is told too. On macOS the box is a
    // panel that takes the keyboard on show() without activating Ember (the user's app stays the active one). That route
    // is kept for the box's speed too (review #78): app.focus({ steal: true }), the settings window's, would make Ember
    // the active app, which the box must not (M2 checks the user's app stays active); the probe's ask.keyboard line times it.
    takeFocus: id => {
      askXid = id;
      if (!sys.lifecycle.activateForAsk) return;
      sys.lifecycle.focusOwnApp();
      if (id && sys.lifecycle.activateOwnWithInput) { inputRef?.activate(id); inputRef?.focusInput?.(id); }
    },
    // Electron can think the box is focused while X still has the user's app: only stop holding keys once X agrees
    // (an X11 check, needed only where Ember holds the keyboard while the box opens).
    hasFocus: platform.keyboardHold ? (): boolean => !wsRef || (askXid !== 0 && wsRef.focusWindow()?.id === askXid) : undefined,
    onReveal: source => {
      log.info("ask.reveal", { source });
      // A request is likely: Ember's voice loads meanwhile (voice-speaking-1).
      if (maySpeak()) voice?.warmSpeech();
      // Counted where the tip shows, until it no longer does: a moment later, and saved a moment after that, so neither
      // the settings' listeners nor the file hold up the keyboard.
      if (platform.keyboardHold) return;
      setTimeout(() => {
        const opened = settings.get().askOpened;
        if (opened >= WAIT_TIP_OPENINGS) return;
        try { settings.update({ askOpened: opened + 1 }, { soon: true }); } catch (err) { log.warn("ask.tip_count_failed", { err }); }
      }, 500).unref?.();
    },
    // How long the box took to have the keyboard, by Electron's word: what was typed before went elsewhere (review #78).
    onKeyboard: () => log.info("ask.keyboard", { ms: Date.now() - askAsked }),
    onHide: () => {
      if (manualCall?.source === "ask") voice?.cancelListenOnce();
      askContextRead = Promise.resolve(null);
    },
    // As large as its words at the text size (review #57).
    textScale: () => textScale(settings.get().textSize),
  });
  let agent: AgentHost | null = null;
  /** The saved conversation's store (set where the agent is made): what is wrong with it is asked by Home. */
  let historyStore: HistoryStore | null = null;
  /** Where tasks act besides this screen (WSL, SSH) and the commands on each (§2); made once the hands are. */
  let targets: (TargetsRuntime & TargetsRuntimeExtra) | null = null;
  let perception: Perception | null = null;
  let voice: VoiceService | null = null;
  let availableNaturalModels = naturalVoiceChoices(sys.voice.naturalVoice && process.env.EMBER_VOICE_BACKEND !== "wasm", false);
  const naturalVoiceOn = (s: Settings) => naturalVoiceWanted(s.voice);
  /** This computer's screen lock (review #81): while locked, Ember doesn't listen, speak or take requests. */
  let screenLock: ScreenLock | null = null;
  /** Where the user was when they last called Ember (taken before anything of Ember's takes focus). */
  let callContext: Promise<QuickContext | null> = Promise.resolve(null);
  let askContextRead = callContext;
  let manualCall: { source: "ask" | "home"; context: Promise<QuickContext | null>; before?: Pick<EmberState, "emotion" | "bubble"> } | null = null;
  /** The control whose Listen once the question now up ended mid-request (cutByQuestion), or null. */
  let listenCutFor: "ask" | "home" | null = null;
  // Nothing is read from the screen or sent anywhere until the user has agreed (M8.8).
  const consented = () => hasConsent(settings.get());
  /**
   * `taken`: the window the user was in, read before the ask box took the keyboard (where the box opens before the
   * screen is read: ask-open.ts), and `before`, what had the keyboard in it then (cross-review P1); undefined: the window
   * active now.
   */
  const captureContext = (taken?: NonNullable<ReturnType<WindowSystem["activeWindow"]>>, before?: FocusBefore) => {
    if (!consented()) { callContext = Promise.resolve(null); return; }
    // Set to work on another computer: its context (never this screen's: the user's window is the terminal they reached
    // it from, §2.8). Asked first, so it works without a window system here too.
    const remote = targets?.quickContext();
    if (remote) { callContext = remote.catch(() => null); return; }
    if (!perception) { callContext = Promise.resolve(null); return; }
    // What is selected in the user's window, asked for now (some apps don't tell it through accessibility; Linux's
    // PRIMARY selection, which other OSes don't have).
    const active = taken ?? wsRef?.activeWindow();
    const clip = platform.clipboard;
    const selected = active && active.pid !== process.pid && clip ? clip.readSelection(active.id).catch(() => "") : Promise.resolve("");
    callContext = Promise.all([perception.quickContext(taken, before), selected]).then(([c, sel]) => Perception.withSelection(c, sel)).catch(() => null);
  };
  /**
   * Main's own notice in the bubble for `ms` (times More time to read and answer, cross-review X4): held, so a task's
   * hide doesn't wipe it, and given back after, so a task still at work shows its progress again (review #81).
   */
  /**
   * The latest requests asked, and how, for a problem's Try again (presenter TRY_AGAIN): the request the problem offers
   * (AgentHost.takeRetry, its own turn's, not a newer one) goes again in the same words, with the same caution.
   */
  let recentAsks: { text: string; voiceUnchecked?: boolean; suggested?: boolean }[] = [];
  /**
   * Voice personalisation (app/main/personal/service.ts): Voice Match learning, the transcript corrected against the
   * user's own words, and what they might say next. Made once the stores it reads are (below).
   */
  let personalRef: PersonalVoice | null = null;
  /**
   * What the Ask box suggests now (askSuggestions): none while a question is up, those that follow the answer only
   * while it shows, and those that answer its last words only while those show: opened in full, once the overlay says
   * its end has, or without a compositor the corner card (companion-r2-1, companion-c2-2, companion-v6-2,
   * companion-repairs-x6-3).
   */
  const askOffers = () => askSuggestions(lastState, personalRef?.current() ?? [], !!confirmer?.waiting, answerEndShown(lastState.bubble, overlay?.bubbleRect(), cardEnded));
  askOffersChanged = () => askWindow.setSuggestions(askOffers());
  /** When the latest request went (for the task it may have started), and the latest reply's words. */
  let askedAt = 0;
  let lastReply = "";
  const showNotice = (n: { title: string; thought: string }, ms: number) => {
    const time = ms * readTime();
    return holdNotice<EmberState["bubble"]>({
      claim: () => agent?.claimBubble({ ms: time }), show: bubble => setState({ emotion: "neutral", bubble }), current: () => lastState.bubble,
      release: bubble => agent?.releaseBubble(bubble) ?? false, hide: () => setState({ emotion: "neutral", bubble: IDLE_BUBBLE }),
    }, { visible: true, mood: "idle", ...n, step: null, streaming: false, actions: [] }, time);
  };
  /** `how.voiceUnchecked`: heard where Ember can't tell the user from its speakers (V1: never the user's words for commands). */
  /**
   * `how.suggested`: one of Ember's suggestions the user chose (never their own words for commands: host.ts
   * UserRequest.suggested); `how.heardId`: the request Ember heard, for "That's not what I said" (personal/service.ts).
   */
  const askEmber = async (text: string, how: { voiceUnchecked?: boolean; spoken?: boolean; manual?: true; verified?: boolean; short?: boolean; suggested?: boolean; heardId?: number; replaces?: boolean } = {}, read = callContext, stillCurrent?: () => boolean) => {
    if (!consented()) { showHome(); return; }
    recentAsks = [...recentAsks, { text, ...(how.voiceUnchecked ? { voiceUnchecked: true } : {}), ...(how.suggested ? { suggested: true } : {}) }].slice(-4);
    // What the user might say next is worked out again once this is answered (app/main/personal/predict.ts).
    personalRef?.asked(text, { unchecked: how.voiceUnchecked, suggested: how.suggested });
    if (lastState.suggest) showState({ suggest: null });
    // Nobody at a locked screen is the user (a request said or typed then is dropped, review #81). Said, so that a user
    // who sees it (the lock read wrongly) knows why nothing happened.
    if (screenLock?.locked) { log.info("ask.refused", { reason: "screen_locked" }); showNotice(LOCKED_ASK, 6000); return; }
    // A typed "stop" while a task is at work stops everything at once, before any screen read (tasks-approvals-v2).
    if (agent?.stopsNow(text, { voiceUnchecked: how.voiceUnchecked, suggested: how.suggested, heardId: how.heardId })) return;
    // A hidden Ember shows itself for the answer to a question the user just asked (and hides again after).
    if ((overlay ? overlay.isHidden() : keptHidden) && !shownForAnswer) { shownForAnswer = true; overlay?.setHidden(false); syncHandle(); }
    // A Stop while the screen is read (or the brain connects) drops the request.
    const epoch = agent?.stopEpoch;
    // A slow screen read never holds a request for long: it goes without context after 3 s (the first read after
    // Ember starts also starts the accessibility helper).
    const context = await Promise.race([read, new Promise<null>(r => setTimeout(() => r(null), 3000))]);
    if (stillCurrent && (!stillCurrent() || !consented() || screenLock?.locked)) return;
    if (how.spoken) turnLatency.mark("sent");
    if (!agent) return;
    return agent.ask(text, context, epoch, { voiceUnchecked: how.voiceUnchecked, ...(how.replaces ? { replaces: true } : {}), ...(how.spoken ? { spoken: true } : {}), ...(how.manual ? { manual: true } : {}), ...(how.verified ? { verified: true } : {}), ...(how.short ? { short: true } : {}), ...(how.suggested ? { suggested: true } : {}), ...(how.heardId ? { heardId: how.heardId } : {}) }).catch(err => { log.error("ask.failed", { err }); });
  };
  /**
   * `look: false`: what the user is in was read already (the handle's menu reads it before taking focus), and
   * `over` is the window it had the keyboard.
   */
  const openAsk = ({ look = true, over = 0, source = "hotkey" }: { look?: boolean; over?: number; source?: "hotkey" | "menu" | "settings" | "launcher" | "test" } = {}) => {
    const asked = Date.now();
    // Every opening says where it came from (an ask box that opened by itself would show up here), once the box is up
    // where it opens: a line written first would hold up the keyboard (review #78).
    if (!consented()) { log.info("ask.open", { source }); showHome(); return; }
    // Already open: the user is typing in it. Looking again would only find the ask box itself.
    if (askWindow.visible) { log.info("ask.open", { source }); askWindow.focus(); return; }
    // From the hotkey, letters typed before the box has the keyboard would go to the user's app: Ember holds the
    // keyboard meanwhile and hands what was typed to the box. Take it before reading focus/context: those X11 and
    // accessibility round trips can outlast the hotkey's own grab, and by then the first letter has gone.
    const held = look && platform.keyboardHold ? platform.keyboardHold({ log: (event, fields) => log.info(event, fields) }) : null;
    // Where Ember can't hold the keyboard, the window with it and the window the user is in (read once the box is up) are
    // taken together now, from the window system Perception reads (on Windows a WSLg app's window by its Linux app's name,
    // which the read's checks need), in one look where it can (macOS): ask-open.ts.
    const where = look && !platform.keyboardHold ? userWindowsNow(wsSeenRef ?? wsRef) : null;
    // The window it opens over (Ember's settings included): the handle's menu gives focus back there.
    askOver = !look ? over : where ? noteFocus(where.focus).id : focusNow().id;
    // Where a request goes when it names no computer: the picker's choice, as a chip (§8.1).
    const askTarget = () => { try { return targets?.summaries().find(t => t.active) ?? null; } catch { return null; } };
    askAsked = asked;
    // A request is likely: Better recall's model loads meanwhile, if it isn't (memory/embed.ts).
    betterRecallRef?.semantic.warm();
    // Linux holds the keyboard, so the screen is read first, as always. Windows and macOS can't: the box shows first,
    // and the screen is read after it, of the window the user was in, told what had the keyboard there (ask-open.ts).
    openAskInOrder({
      holding: !!platform.keyboardHold, look,
      activeWindow: () => where?.active ?? null,
      keyboard: () => where?.keyboard ?? 0,
      read: (active, before) => captureContext(active, before),
      // The first few openings where Ember can't hold the letters typed meanwhile say to wait for the box (review #78).
      show: () => askWindow.show(overlay ? { ...overlay.position, size: settings.get().size } : null, {
        sees: null, history: askHistory, target: askTarget(), tip: showsWaitTip(!!platform.keyboardHold, settings.get().askOpened), listenOnce: listenOnceStatus("ask"),
        // Why a request would go unanswered now (not connected, offline): said before it is typed (companion-6).
        unavailable: unansweredWord(agent?.getStatus()) ?? undefined,
        // None yet beside an answer still coming in: its row's room, for its follow-ups (accessibility-visual-c4-1), only
        // while Ember suggests any (companion-v5-2: with Suggest off the row stayed blank).
        ...(askOffers().length ? { suggestions: askOffers() } : askSuggestionsComing(lastState, !!confirmer?.waiting, !!personalRef && settings.get().voice.suggest) ? { suggestionsComing: true } : {}),
      }, source),
    });
    const read = askContextRead = callContext;
    // ms: from the call (the shortcut's press, as Ember heard it) to the box shown.
    log.info("ask.open", { source, ms: Date.now() - asked });
    if (held) void askWindow.hasKeyboard().then(() => askWindow.typed(held.stop()), () => held.stop());
    // What Ember will read, shown as a chip once the quick look is done: the window, and what else goes with a request.
    void read.then(c => {
      if (askContextRead !== read) return;
      const ctx: AskContext = { ...askSees(c), history: askHistory, target: askTarget(), unavailable: unansweredWord(agent?.getStatus()) ?? undefined };
      askWindow.setContext(ctx);
    });
  };
  let audit: AuditLog | null = null;
  let borrowRef: CursorBorrow | null = null;
  let deskViewRef: DeskView | null = null;
  let extensionsRef: ExtensionsService | null = null;
  let learningRef: MemoryLearning | null = null;
  let betterRecallRef: BetterRecall | null = null;
  const killSwitch = new KillSwitch(() => [
    { name: "borrow", stop: () => borrowRef?.stop() },
    { name: "speech", stop: () => voice?.hush() },
    // A request still being spoken is dropped, not sent after Stop.
    { name: "listening", stop: () => voice?.cancelListening() },
    { name: "agent", stop: () => agent?.abortAll() },
    // Every command stops, on every target, and every remote is told to stop (at once, whatever the network does).
    { name: "targets", stop: () => targets?.stopAll() },
    { name: "project", stop: () => projectJob?.abort() },
    // Every extension call is refused from now on, its questions dropped, and every extension server ended.
    { name: "extensions", stop: () => extensionsRef?.stopPart().stop() },
    // The user's take-over of the desk ends too (its keys are released).
    { name: "desk", stop: () => deskViewRef?.handBack() },
    { name: "motion", stop: () => { overlay?.setBorrowing(false); deskViewRef?.setDriving(false); showState({ focus: null, gesture: null }); } },
    // Dispatch the safety stops above before Better recall synchronously flushes its pending vectors.
    { name: "memory", stop: () => { learningRef?.stopNow(); betterRecallRef?.semantic.stop(); } },
  ], log.child("killswitch"), () => audit);
  /** Ctrl+Alt+X, "Ember, stop", Stop in the handle's menu or in settings: everything stops at once. */
  const stopEverything = (source: "hotkey" | "voice" | "typed" | "menu" | "settings") => {
    // An acknowledgement still waiting isn't said after a stop.
    resetAnswerSpeech();
    const pulled = killSwitch.pull(source);
    // Voice Match learns nothing for a while after a stop, and the suggestions go.
    personalRef?.stopped();
    // First run's stop rehearsal hears it (only the settings window, and only that it happened and how).
    sendToHome(IPC.homeStopped, source);
    // A failure card stays about a minute (longer than others, so it can be read; the settings window's Conversation
    // keeps the result) and its Close needs a click: Stop everything clears it at once too (the keyboard's way, and the
    // screen reader's).
    // So does the card of a task whose question went unanswered, kept as long (tasks-approvals-r1).
    agent?.tasks?.dismissFailures();
    const bubble = { visible: true, mood: "idle" as const, title: "Stopped", thought: STOPPED_EVERYTHING, step: null, streaming: false, actions: [] };
    statusBy.listen = statusBy.mic = null;
    setState({ emotion: "neutral", talking: false, status: statusBy.borrow, bubble, suggest: null });
    hideIfStill(bubble, 3000);
    // Parts still winding down after the kill switch's wait (a command's kill ladder, a slow remote link) are named.
    void pulled.then(({ late }) => {
      const computers = targets?.summaries().filter(t => t.kind === "ssh" && (t.state === "ready" || t.state === "connecting" || t.state === "lost")).map(t => t.label) ?? [];
      const still = stillStoppingWords(late, computers);
      if (!still || lastState.bubble !== bubble) return;
      const stopping = { ...bubble, title: "Stopping", thought: still };
      setState({ bubble: stopping });
      hideIfStill(stopping, 6000);
    });
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
    "follow-up": "I only caught the first part: say “Ember” and the rest.",
    manual: "I only caught the first part. Use Listen once to say the rest.",
    conversation: "I only caught the first part: say the rest.",
  } as const;
  const isCutNote = (s: string | null) => s === CUT_NOTES.wake || s === CUT_NOTES["follow-up"] || s === CUT_NOTES.manual || s === CUT_NOTES.conversation;
  let shownForAnswer = false;
  /** "Hide Ember" while there is no overlay to hold it (no compositor): the next overlay starts hidden. */
  let keptHidden = false;
  /** The window system and input, once opened after ready (null: none on this desktop). */
  let inputRef: Input | null = null;
  let wsRef: WindowSystem | null = null;
  /**
   * The window system as Perception reads it (on Windows, identified WSLg windows renamed "wsl:<distro>:<app>"; elsewhere
   * wsRef itself), once Perception is made: the window the ask box reads after it is up is named from it, so the read's
   * never-look and security checks see the Linux app's name, as the read before the box did (review #78).
   */
  let wsSeenRef: WindowSystem | null = null;
  /** The accessibility helper's client, once made after ready. */
  let sidecarRef: AtspiSidecar | null = null;
  /** Shows the borrow's state (status line, click-through); set once the hands are ready. */
  let showBorrowing: (() => void) | null = null;
  /** One status line, several writers: the borrow comes first, then listening, then the microphone, then the keychain. */
  const statusBy: { borrow: string | null; listen: string | null; mic: string | null; keychain?: string | null } = { borrow: null, listen: null, mic: null };
  const setStatus = (owner: keyof typeof statusBy, text: string | null) => {
    statusBy[owner] = text;
    setState({ status: statusBy.borrow ?? statusBy.listen ?? statusBy.mic ?? statusBy.keychain ?? null });
  };
  /** What Ember showed before a wake, put back if the wake turns out to be another word. */
  let beforeWake: Pick<EmberState, "emotion" | "bubble"> | null = null;
  const toggleMute = () => {
    if (!voice || !consented() || policy.features.voice === false) return;
    voice.setMuted(!voice.isMuted);
    // Remembered: a restart (or login) doesn't quietly open the microphone again.
    try { settings.update({ voice: { ...settings.get().voice, muted: voice.isMuted } }); } catch (err) { log.warn("voice.mute_not_saved", { err }); }
    setStatus("mic", voice.isMuted ? "Microphone off" : null);
    if (voice.isMuted) setTimeout(() => { if (voice?.isMuted) setStatus("mic", null); }, 2500);
  };
  const listenOnceStatus = (source: "ask" | "home"): ListenOnceStatus => {
    const s = settings.get();
    const blocked = (detail: string): ListenOnceStatus => ({ phase: "blocked", detail });
    if (policy.features.voice === false) return { ...blocked("Your organisation has turned voice off."), fix: "admin" };
    if (!consented()) return blocked("Finish Ember's setup first.");
    if (screenLock?.locked) return blocked("The screen is locked.");
    if (s.voice.muted) return blocked("Unmute the microphone first.");
    if (manualCall && source !== manualCall.source) return { ...blocked("Ember is already listening."), reason: "listening" };
    // A Listen once of this control's that the question ended says so while it is up (companion-r2-2).
    if (confirmer?.waiting && listenCutFor === source) return blocked(LISTEN_CUT_BY_QUESTION);
    // A question holds it back, but not this control's own Listen once under way: its Cancel listening stays (companion-r1).
    // (Not said to screen readers while the microphone is open: a conversation waiting for its answer, voice-listening-v4-1.)
    if (questionHoldsListen(!!confirmer?.waiting, manualCall?.source === source ? voice?.listenOnceStatus : undefined)) return heldByQuestion(voice?.micState);
    const now = voice?.listenOnceStatus ?? blocked("The speech recogniser is getting ready.");
    // An answer on its way: Listen once stops it first, as a wake does (requestListenOnce; voice-listening-7).
    const answer = agent?.answerOpen && now.phase === "ready" ? { ...now, detail: LISTEN_ONCE_STOPS_ANSWER } : now;
    // Without the speech models only Settings' Download helps: Ask offers the way there (companion-3).
    const heard: ListenOnceStatus = answer.phase === "blocked" && voice && !voice.modelsReady && !voice.isDownloading ? { ...answer, fix: "settings" } : answer;
    return source === "home" ? listenOnceInSettings(heard) : heard;
  };
  const clearManualCall = () => {
    const call = manualCall;
    manualCall = null;
    if (!call?.before || lastState.bubble.mood !== "listening") return;
    setState(call.before);
    const shown = lastState.bubble;
    if (!(agent?.releaseBubble(shown) ?? false) && shown.visible) hideIfStill(shown, 4000);
  };
  const voiceStatus = (detail?: string) => ({
    state: voice?.micState ?? "off", detail: detail ?? null,
    ...(voice?.micLabel ? { micLabel: voice.micLabel } : {}),
    modelsReady: voice?.modelsReady ?? false,
    modelsMissing: (voice?.missingModels ?? VOICE_MODELS).map(m => m.id), modelsBytes: voice ? modelsBytes(voice.missingModels) : VOICE_MODELS_BYTES,
    ...(voice?.isDownloading ? { downloading: true } : {}),
    speechMissing: speechHeard === false,
    listenOnce: listenOnceStatus("home"),
    // A voiceprint whose model is gone isn't used (Ember hears every voice, rather than none), and settings says why.
    match: { enrolled: voiceprints.read() !== null, on: !!ownerPrint() && (voice?.matchReady ?? true), model: voice?.matchReady ?? true, wanted: !!ownerPrint(), enrolling, learnt: voiceprints.learnt().clips, ...(enrolEnded ? { ended: enrolEnded } : {}) },
    ...(voice ? { natural: voice.naturalStatus } : {}),
    ...(voice ? { clear: voice.clearStatus } : {}),
    naturalModels: availableNaturalModels,
  });
  let lastListenStatus = "";
  const syncListenOnce = () => {
    const phase = voice?.listenOnceStatus.phase;
    if (manualCall && (phase === undefined || phase === "ready" || phase === "blocked")) clearManualCall();
    const ask = listenOnceStatus("ask");
    // (The microphone's name too: Settings' voice line names it, and a headset plugged in changes it.)
    const key = JSON.stringify([ask, listenOnceStatus("home"), voice?.micLabel ?? null]);
    if (key === lastListenStatus) return;
    lastListenStatus = key;
    askWindow.setListenOnce(ask);
    // A reloaded Home reads the current status when it starts.
    if (home && !home.isDestroyed() && !home.webContents.isCrashed()) sendToHome(IPC.voiceStatus, voiceStatus(voiceDetail));
  };
  const requestListenOnce = (source: "ask" | "home", on: boolean): ListenOnceStatus => {
    if (!on) {
      if (manualCall?.source === source) voice?.cancelListenOnce();
    } else if (voice && listenOnceStatus(source).phase === "ready") {
      // Ember answering or talking: the answer stops first, as on a wake (its tasks go on; VoiceService hushes the voice).
      if (agent?.answerOpen) agent.interruptAnswer();
      // Home is Ember’s own window. Ask uses the desktop view taken before Ask took the keyboard.
      manualCall = { source, context: source === "ask" ? askContextRead : Promise.resolve(null) };
      if (!voice.listenOnce()) clearManualCall();
    }
    return listenOnceStatus(source);
  };
  /**
   * Voice Match (app/voice/voiceprint.ts): the owner's voiceprint, kept apart from the settings (voiceprint-store.ts),
   * is in use while the setting is on; `enrolling` is the teaching under way (settings shows the phrase to say).
   */
  const voiceprints = voiceprintStore(userData, VOICE_MODELS.find(m => m.id === "speaker")!.target);
  // Long-term memory (docs/MEMORY.md): memory.json beside the settings, used only while the user has it on and the
  // organisation allows it. Settings lists it; nothing is read from the file until something asks.
  const memoryAllowed = () => policy.features.memory !== false;
  const memoryOwner = new MemoryOwner(userData);
  let memoryEpoch = 0;
  /** Whose memory the epoch is for: a reconnect that finds the same account keeps it (memory-8). */
  const memoryAccount = new MemoryEpochAccount();
  // Better recall (memory/better-recall.ts): matching by meaning once the user downloads its model in Settings › Memory,
  // in the "Ember memory" utility process, used only while memory is on.
  const memoryConfigured = () => consented() && memoryAllowed() && settings.get().memory.on && settings.get().memory.consent.version >= FEATURE_CONSENT_VERSION.memory;
  const memoryOn = () => memoryOwner.ready && memoryConfigured();
  /** On under an earlier note than today's: paused until the user reviews it, as Home says (memory-r4). */
  const memoryNoteOutdated = (m: { on: boolean; consent: { version: number } }) => m.on && m.consent.version > 0 && m.consent.version < FEATURE_CONSENT_VERSION.memory;
  const betterRecall = new BetterRecall({
    dir: userData, modelsRoot: path.join(userData, "models"), log: log.child("memory"), download: electronDownloader, memoryOn, memoryWanted: memoryConfigured,
    fork: () => {
      const p = utilityProcess.fork(path.join(__dirname, "memory-embed.cjs"), [], { serviceName: "Ember memory", stdio: "pipe" });
      p.stderr?.on("data", (d: Buffer) => log.debug("memory.process_stderr", { line: d.toString().slice(0, 300) }));
      return { postMessage: m => p.postMessage(m), onMessage: fn => p.on("message", fn), onExit: fn => p.on("exit", fn), kill: () => { p.kill(); } };
    },
    onStatus: s => broadcast(IPC.memoryModelChanged, s),
    onReady: () => memory.index(),
  });
  betterRecallRef = betterRecall;
  settings.onChange(() => {
    const before = memoryOwner.state;
    memoryOwner.refresh(memoryConfigured());
    if (before !== memoryOwner.state) { memoryEpoch++; publishMemoryOwner(); }
    if (!memoryOn()) learningRef?.stopNow();
    betterRecall.settingsChanged();
  });
  const memoryView = () => ({
    rows: memoryAllowed() && consented() && memoryOwner.ready ? memory.list() : [],
    ownership: memoryOwner.state, epoch: memoryEpoch, reason: memoryOwner.reason, erasesOnSignOut: memoryOwner.mayEraseOnSignOut,
    // After the rows, which read memory.json first: what was wrong with it, only for the account's open memory (memory-r2).
    trouble: memoryOwner.ready ? memory.trouble : null,
  });
  const memory: MemoryService = new MemoryService({ dir: userData, log: log.child("memory"), semantic: betterRecall.semantic, inForce: memoryOn, onChange: () => broadcast(IPC.memoryChanged, memoryView()) });
  const publishMemoryOwner = () => {
    if (!memoryOn()) learningRef?.stopNow();
    betterRecall.settingsChanged();
    broadcast(IPC.memoryChanged, memoryView());
  };
  memory.start();
  const words = wordsStore(userData);
  const personal = new PersonalVoice({
    log: log.child("personal"), voiceprints, words,
    settings: () => {
      const v = settings.get().voice;
      return { learnVoice: v.learn, matchOn: !!ownerPrint() && (voice?.matchReady ?? false), learnWords: v.words, suggest: v.suggest };
    },
    apps: () => sys.apps.list().map(a => a.name),
    // Memory in force (on, agreed to, allowed): only then do its `user` facts' names help correct what Ember heard.
    memory: () => (memoryOn() ? memory.list() : null),
    risky: w => isRiskyLabel(w, platform.os),
  });
  personalRef = personal;
  /** The request a Voice Match sample belongs to: the voice process names it (a sample's `utterance` is the request's number). */
  let lastHeard: { utterance: number; verified: boolean; cut: boolean; selfSpoke: boolean } | null = null;
  if (memoryOn() && betterRecall.ready) memory.index();
  // Memory that learns on its own (app/main/memory/learning.ts): only while memory is in force (memoryOn: on, its own
  // consent, the organisation's features.memory; LOCKDOWN turns that off). Its "Ember learned" lines join the
  // conversation Home shows.
  let learnedLines: MemoryLine[] = [];
  const conversationNow = (entries: TranscriptEntry[] = agent?.getTranscript() ?? []) => withLearned(entries, learnedLines);
  const learning = new MemoryLearning({
    memory, inForce: memoryOn, managed: () => !memoryAllowed(),
    // "Spoken aloud or not" in the spoken interview is Ember's real speaking choice (memory-5).
    setSpoken: on => { try { settings.update(speakSettings(on ? "always" : "never")); } catch (err) { log.warn("memory.spoken_not_saved", { err }); } },
    // On and agreed to, but its owner isn't verified: Ember says why rather than asking to turn memory on (memory-2).
    // On under an earlier note the user hasn't reviewed: paused, as Home says, until they do (memory-r4).
    paused: () => (memoryConfigured() ? (memoryOwner.ready ? null : memoryOwner.reason ?? "checking")
      : consented() && memoryAllowed() && memoryNoteOutdated(settings.get().memory) ? "note" : null),
    questionsOn: () => settings.get().memory.questions,
    askedAt: () => settings.get().memory.askedAt,
    setAskedAt: at => { try { settings.update({ memory: { ...settings.get().memory, askedAt: at } }); } catch (err) { log.warn("memory.asked_not_saved", { err }); } },
    idle: () => agent?.idle ?? false,
    // Fail closed: without a lock watcher the screen counts as locked (nothing runs while away).
    locked: () => screenLock?.locked ?? true,
    say: text => agent?.sayFromMemory(text) ?? false,
    openMemory,
    onLearned: items => {
      const t = new Date().toISOString();
      learnedLines = [...learnedLines, ...items.map(i => ({ t, who: "learned" as const, text: i.text.slice(0, 400), fact: i.id }))].slice(-30);
      broadcast(IPC.conversationChanged, conversationNow());
    },
    // Forget everything (or sign-out): the "Ember learned" lines and their Undo leave the page too.
    onForgotAll: () => {
      learnedLines = [];
      broadcast(IPC.conversationChanged, conversationNow());
    },
    // One fact forgotten (Forget, Undo, forget_memory, "forget that"): its "Ember learned" line stays where it was and
    // says Ember forgot it, with the Undo that puts it back, so focus and a screen reader keep their place (memory-c1-3).
    // A correction changed its words: the line goes.
    onForgot: (id, gone) => {
      const next = linesAfterForget(learnedLines, id, gone);
      if (!next) return;
      learnedLines = next;
      broadcast(IPC.conversationChanged, conversationNow());
    },
    // forget_memory forgot what the user asked: the conversation says so, in the fact's own words, with Undo (memory-v2),
    // unless the line of when Ember learned it says so already.
    onAskedForget: f => {
      const next = linesAfterAskedForget(learnedLines, f, new Date().toISOString());
      if (!next) return;
      learnedLines = next;
      broadcast(IPC.conversationChanged, conversationNow());
    },
    log: log.child("memory"),
  });
  learningRef = learning;
  learning.start();
  /** The host's memory: the conductor's tools through `learning`, its model calls, finished tasks and its own requests. */
  const hostMemory = {
    ...learning.conductorMemory(),
    // True when it erased memory (the host says so after an account change: memory-11); unverified memory stays.
    forgetAll: () => {
      if (!memoryOwner.mayEraseOnSignOut) return false;
      learning.forgetAll();
      memoryOwner.clear();
      memoryOwner.pause();
      memoryEpoch++;
      publishMemoryOwner();
      return true;
    },
    resolveAccountId: (token: string, login: string) => githubMemoryAccount((url, init) => net.fetch(url, init), token, login),
    verifyAccount: (id: number | null, why?: MemoryWait) => { if (memoryAccount.verified(id, why)) memoryEpoch++; memoryOwner.verify(id, memoryConfigured(), why); publishMemoryOwner(); },
    pauseAccount: (why?: MemoryWait) => { if (memoryAccount.paused(why)) memoryEpoch++; memoryOwner.pause(why); publishMemoryOwner(); },
    accountReady: memoryOn,
    useModel: (model: OneShot | null) => learning.setModel(model),
    taskDone: (title: string, result: string) => learning.taskDone(title, result),
    intent: (text: string, how: { own: boolean }) => learning.intent(text, how),
    rememberNote: (text: string) => learning.rememberNote(text),
  };
  // Extensions (app/main/extensions/, docs/DEVELOPING.md "Extensions"): plugins' MCP tools, used only while the user has
  // them on and agreed, and the organisation allows them. Home's Extensions section calls this (ExtensionsApi).
  const extensions = new ExtensionsService({
    dir: path.join(userData, "extensions"), copilotHome: path.join(userData, "copilot"),
    settings, admin: () => policy, client: () => agent?.copilotClient ?? null, confirmer: () => confirmer, audit: () => audit,
    log: log.child("extensions"), os: platform.os,
    // macOS never runs Ember as plain Node (PLAN.md §2 "Node mode"): no launcher, so no stdio servers there.
    launcher: platform.os === "darwin" ? null : { execPath: process.execPath, script: path.join(__dirname, "mcp-launch.cjs") },
    fetch: (u, i) => net.fetch(String(u), i as RequestInit),
    allowLocal: devEnv("EMBER_EXTENSIONS_LOCAL") === "1",
  });
  // Every enabled extension's tools are checked against what the user agreed to before a conversation uses them.
  extensionsRef = extensions;
  void extensions.refresh().catch(err => log.warn("extensions.refresh_failed", { err }));
  // Turned on (or agreed to) later: the same check first.
  let extensionsActive = extensions.active();
  settings.onChange(() => {
    const on = extensions.active();
    if (on && !extensionsActive) void extensions.refresh().catch(err => log.warn("extensions.refresh_failed", { err }));
    extensionsActive = on;
  });
  // Routines and lasting reminders (app/main/agent/routines.ts): routines.json beside the settings, used only while the
  // user has them on and the organisation allows them.
  const routinesAllowed = () => policy.features.routines !== false;
  /** The routines kept; throws when routines.json can't be read, so a failure is never mistaken for none. */
  const routineRowsStrict = () => routinesAllowed() ? routineBook.list().map(r => ({ id: r.id, name: r.name, steps: r.steps })) : [];
  const routineRows = () => {
    // An unreadable routines.json (no permission) lists nothing rather than failing Home's section.
    try { return routineRowsStrict(); } catch (err) { log.warn("routines.unreadable", { err: err instanceof Error ? err.message : String(err) }); return []; }
  };
  const routineBook: RoutineBook = new RoutineBook({
    file: routinesFile(userData, err => log.warn("routines.file_broken", { err: err instanceof Error ? err.message : String(err) })),
    onChange: () => {
      // An unreadable book pushes nothing: an empty push would read as "no routines" to the Forget question.
      try { broadcast(IPC.routinesChanged, routineRowsStrict()); } catch (err) { log.warn("routines.unreadable", { err: err instanceof Error ? err.message : String(err) }); }
    },
  });
  const reminderRows = (rows = agent?.reminders.list() ?? []) => {
    if (!hasConsent(settings.get())) return [];
    let kept: Reminder[] = [];
    try { kept = routineBook.reminders(); } catch { /* The live reminders remain visible if the saved book can't be read. */ }
    return rows.map(r => ({ id: r.id, text: r.text, at: r.at, created: r.created,
      kept: kept.some(k => k.id === r.id && k.text === r.text && k.at === r.at && k.created === r.created) }));
  };
  const ownerPrint = () => (settings.get().voice.match ? voiceprints.read() : null);
  /**
   * "Work without asking" turned on or off is an audit entry (security review of #127): by voice or typed words (the host's
   * intent says which, just before it saves), else from Home's switch or card.
   */
  let autonomyChangedBy: { via: "voice" | "typed" | "home"; verified: boolean } | null = null;
  let autonomyWasOn = autonomyInForce(settings.get().autonomy, policy) !== null;
  /** Turned off before the audit log was opened (before the app was ready): written once it is. */
  const autonomyBeforeAudit: { on: boolean; via: string; verified: boolean }[] = [];
  settings.onChange(s => {
    const on = autonomyInForce(s.autonomy, policy) !== null;
    // Whoever marked a change takes it with them, whether or not it changed anything (review of #127).
    const how = autonomyChangedBy ?? { via: "file" as const, verified: false };
    autonomyChangedBy = null;
    if (on === autonomyWasOn) return;
    autonomyWasOn = on;
    const entry = { on, via: how.via, verified: how.verified };
    try {
      // No audit log yet: a turn on is refused (it can't be recorded), a turn off is kept for the log.
      if (!audit) { if (on) throw new Error("the audit log isn't open yet"); autonomyBeforeAudit.push(entry); } else audit.write({ event: "autonomy", ...entry });
    } catch (err) {
      // Not recorded: it isn't turned on (fail closed); a turn off stands.
      log.warn("autonomy.audit_failed", { err });
      if (on) settings.update({ autonomy: { ...s.autonomy, on: false } });
      return;
    }
    log.info("autonomy.changed", { on, via: how.via });
  });
  /** When the request being heard began (its wake, or a follow-up window opening): Ember's own voice since then is an echo. */
  let heardFrom = 0;
  /**
   * When the speech being heard started, and the question up then (Confirmer.currentNumber): a spoken answer counts only
   * for the question that was up, and armed, before it was said (security review of #127).
   */
  let saidFrom = 0;
  let questionWhenSaid: number | null = null;
  /** The question Ember last said it heard an answer over its own voice for (said once a question). */
  let heardOverFor: number | null = null;
  const speechStarts = () => { saidFrom = Date.now(); questionWhenSaid = confirmer?.currentNumber ?? null; };
  /**
   * A spoken answer to the question up (voice-answer.ts judged the words): taken through the Confirmer, which holds a yes
   * to what the approve key may do; or, when it can't be taken, the question stays and its bubble says why (and how to
   * set Voice Match up). Spoken too, where Ember speaks. Nothing of what was said is logged, only the outcome.
   */
  const answerByVoice = (o: Exclude<VoiceAnswerOutcome, { kind: "none" }>) => {
    if (!confirmer) return;
    const trustTask = o.kind === "answer" && o.trust === "task-voice" ? confirmer.currentTask : undefined;
    const result = o.kind === "answer"
      ? confirmer.answerVoice(o.answer, { verified: o.verified, question: questionWhenSaid, startedAt: saidFrom, ...(trustTask ? { trust: { task: trustTask } } : {}) })
      : o.why;
    log.info("voice.answer", { answer: o.answer, result, verified: o.kind === "answer" && o.verified, ...(o.kind === "answer" && o.trust ? { trust: o.trust } : {}) });
    // A yes refused as another voice: no task's short yes is trusted from now on (Ember can't tell whose question it was after).
    if (refusalEndsTrust(result, o.answer)) voiceTrust.endAll("other-voice");
    if (result === "answered" || result === "no-question") return;
    // A short yes on a task's trust that couldn't be taken (another task's question, or a panel's): as one too short.
    refuseVoiceAnswer(result === "untrusted" ? "too-short" : result);
  };
  /**
   * A spoken answer wasn't taken (`why`): the question stays up, its bubble says why and what to do instead, and so
   * does Ember, aloud, where it speaks (a fixed sentence: never Ember's own voice taken as an answer after it, as the
   * echo guard dates each request from its wake, and the voice process hears nothing while Ember speaks).
   */
  const refuseVoiceAnswer = (why: VoiceAnswerNote) => {
    if (!confirmer?.note(VOICE_ANSWER_REFUSED[why])) return;
    // (The keys stay under the note in the bubble; said aloud, they are named after it: tasks-approvals-6.)
    if (maySpeak()) voice?.speak(voiceAnswerSaid(why, heldKeys().map(k => k.say)));
  };
  let enrolling: VoiceMatchStatus["enrolling"] = null;
  /** How the last teaching ended (settings says so; forgotten when it closes or teaching starts again). */
  let enrolEnded: VoiceMatchStatus["ended"];
  /** Settings closed or hidden while it taught Ember a voice: the teaching stops, as Cancel would. */
  const endTeaching = () => {
    if (!enrolling) return;
    voice?.cancelEnrol();
    enrolling = null;
    enrolEnded = "cancelled";
    broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
  };
  /** The detail of the microphone's current state, so a status sent for something else keeps it. */
  let voiceDetail: string | undefined;
  /** The status line while a follow-up window listens. */
  const FOLLOW_UP_STATUS = "Listening for a follow-up…";
  /** The status line through a conversation: the microphone is open for what is said next. */
  const CONVERSATION_STATUS = "Listening…";
  /**
   * Said once a conversation, for a few seconds, when what was said over music or a video without the name wasn't heard
   * (engine.ts `dropped`): it vanished without a sign, and Ember looked deaf (voice-listening-10).
   */
  const OVER_SOUND_STATUS = "Music or a video is playing: say “Ember” first.";
  let overSoundSaid = false;
  /** A conversation is open (engine.ts CONVERSATION_IDLE_MS), and what keeps it told whether anything is at work. */
  let conversing = false;
  let conversingTimer: NodeJS.Timeout | null = null;
  const conversationOpen = (on: boolean) => {
    if (on !== conversing) voice?.watchOutput(on);
    if (on !== conversing) overSoundSaid = false;
    conversing = on;
    if (conversingTimer) clearInterval(conversingTimer);
    conversingTimer = null;
    if (!on) return;
    conversingTimer = setInterval(() => voice?.conversationBusy(!(agent?.idle ?? true) || !!confirmer?.waiting), 1000);
    conversingTimer.unref?.();
  };
  /** What Ember does with what it hears. */
  const onVoice = (e: VoiceEvent, heard?: { utterance: number }) => {
    switch (e.type) {
      case "wake":
        heardFrom = Date.now();
        speechStarts();
        beforeWake = { emotion: lastState.emotion, bubble: lastState.bubble };
        captureContext();
        betterRecallRef?.semantic.warm();
        if (agent) agent.interruptAnswer();
        else resetAnswerSpeech();
        // The bubble is main's now: an answer's leftover hide timer mustn't blank "Listening…".
        agent?.claimBubble();
        setState({ emotion: "listening", talking: false, bubble: { visible: true, mood: "listening", title: "Listening…", thought: "", step: null, streaming: true, actions: [] } });
        break;
      case "listening":
        if (e.window === "conversation") {
          // The microphone stays open through replies and tasks: nothing here may take the bubble from them.
          conversationOpen(e.on);
          if (e.on) { setStatus("listen", CONVERSATION_STATUS); break; }
          if (!isCutNote(statusBy.listen)) setStatus("listen", null);
          if (lastState.bubble.mood === "listening") { agent?.claimBubble(); setState({ emotion: "neutral", bubble: IDLE_BUBBLE }); }
          break;
        }
        if (e.window === "manual") {
          if (e.on && manualCall) {
            heardFrom = Date.now();
            speechStarts();
            manualCall.before = { emotion: lastState.emotion, bubble: lastState.bubble };
            agent?.claimBubble();
            setState({ emotion: "listening", bubble: { visible: true, mood: "listening", title: "Listening…", thought: "Say one request.", step: null, streaming: true, actions: [] } });
          } else if (manualCall && e.reason === "done" && lastState.bubble.mood === "listening") {
            setState({ bubble: { ...lastState.bubble, title: "Checking what I heard…", thought: "" } });
          }
          break;
        }
        if (e.on && e.reason === "follow-up") { heardFrom = Date.now(); speechStarts(); setState({ emotion: "listening" }); setStatus("listen", FOLLOW_UP_STATUS); }
        // "Hey Ember" said in a follow-up window made it a wake's window (engine.ts wakeOverFollowUp).
        if (e.on && e.reason === "wake" && statusBy.listen === FOLLOW_UP_STATUS) setStatus("listen", null);
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
      case "dropped":
        if (!conversing || overSoundSaid || statusBy.listen !== CONVERSATION_STATUS) break;
        overSoundSaid = true;
        setStatus("listen", OVER_SOUND_STATUS);
        setTimeout(() => { if (statusBy.listen === OVER_SOUND_STATUS) setStatus("listen", conversing ? CONVERSATION_STATUS : null); }, 5000).unref?.();
        break;
      case "speech":
        // (Counted by scripts/voice/echo-check.mjs: speech heard while Ember's own voice plays is its echo.)
        log.info("voice.speech_heard", { on: e.on });
        // In a conversation each thing said dates from its own start, for the spoken-answer checks (a window that opened
        // minutes ago says nothing of it), and the bubble stays with the reply or task it shows.
        if (conversing) { if (e.on) { heardFrom = Date.now(); speechStarts(); } break; }
        // In a follow-up window the speech itself starts later than the window: the answer is tied to then.
        if (e.on && saidFrom < heardFrom + 1) speechStarts();
        if (e.on) agent?.claimBubble();
        if (e.on) setState({ bubble: { visible: true, mood: "listening", title: "Listening…", thought: "…", step: null, streaming: true, actions: [] } });
        break;
      case "utterance": {
        const manual = e.window === "manual" ? manualCall : null;
        if (e.window === "manual" && (!manual || !voice || !consented() || screenLock?.locked || policy.features.voice === false)) break;
        const stillCurrent = manual ? voice?.listenOnceStillCurrent() : undefined;
        if (manual) {
          clearManualCall();
          if (manual.source === "ask") askWindow.hide();
        }
        // A spoken request's answer opens a follow-up window; the engine refuses one after MAX_FOLLOW_UPS in a row.
        log.info("voice.utterance", { chars: e.text.length, ms: e.ms, window: e.window, cut: !!e.cut });
        lastHeard = { utterance: heard?.utterance ?? -1, verified: e.verified === true, cut: !!e.cut, selfSpoke: e.overEmber === true || (voice?.selfSpokeSince(heardFrom) ?? true) };
        // The request ran past the longest Ember listens: what was heard goes, and the user is told the rest didn't.
        if (e.cut) {
          const note = CUT_NOTES[e.window];
          setStatus("listen", note);
          setTimeout(() => { if (statusBy.listen === note) setStatus("listen", null); }, 10_000).unref?.();
        }
        // While a question is up, "allow" or "not now" answers it (a yes only from the owner's verified voice, never from
        // Ember's own; voice-answer.ts). Anything else is a request, as ever.
        {
          const matchOn = !!ownerPrint() && (voice?.matchReady ?? false);
          // Turned on, but not in use: never taught, or its model isn't in (the refusal says to finish setting it up).
          const matchUnready = settings.get().voice.match && !matchOn;
          // A short yes may be taken on the asking task's trust: that task was asked for in the owner's verified voice,
          // within TASK_VOICE_MS, and no voice has been turned away since (owner decision of 2026-11-03).
          const taskTrust = voiceTrust.holds(confirmer?.currentTask);
          // (voiceAnswer reads the raw words, e.text, never personal.heard()'s corrected ones.)
          const spokenReply = voiceAnswer({
            text: e.text, questionUp: confirmer?.waiting ?? false, matchOn, matchUnready, verified: e.verified === true, short: e.short === true,
            ...(e.restScore !== undefined ? { restScore: e.restScore } : {}), taskTrust, selfSpoke: e.overEmber === true || (voice?.selfSpokeSince(heardFrom) ?? true),
          });
          // A spoken answer to a question is never learnt from (Voice Match learns from requests only).
          if (spokenReply.kind !== "none") { lastHeard = null; answerByVoice(spokenReply); break; }
          // A follow-up (no wake word) keeps the context from the last call. Without speaker rejection, a call, a video or
          // Ember's own voice can say it: it doesn't count as the user's own words for a dangerous command (OWNER V1).
          // `verified`: Voice Match matched the owner's voice (what may turn "Work without asking" on).
          turnLatency.heard(e.ms);
          // Near-misses corrected against the user's own words (personal/correct.ts): never into a risky request.
          const heard = personal.heard(e.text);
          // A click opens this window, but doesn't identify the voice in the room as the user for command policy.
          // In a conversation Ember looks again at what the user is in, as a wake does: they may have moved on.
          if (e.window === "conversation") captureContext();
          // Said while a reply was on its way: that reply stops, and this is answered with it in mind (host.ts replaceTurn).
          // A permission question stays up: its tool is waiting, and only its own answer ends it.
          const replaces = e.window === "conversation" && !confirmer?.waiting;
          void askEmber(heard.text, { heardId: heard.id, voiceUnchecked: heardUnchecked(e, !!manual, !!voice?.rejectsSpeakers), spoken: true, ...(replaces ? { replaces: true } : {}), ...(manual ? { manual: true } : {}), ...(matchOn && e.verified === true ? { verified: true } : {}), ...(matchOn && e.short === true ? { short: true } : {}) }, manual?.context, stillCurrent);
        }
        break;
      }
      case "duck":
        voice?.duck(e.on);
        break;
      case "cut-in":
        // The user is talking over Ember: it stops at once. What they say comes next, as an utterance.
        log.info("voice.cut_in");
        if (agent) agent.interruptAnswer();
        else resetAnswerSpeech();
        break;
      case "stop":
        // "Ember, stop": everything stops, locally, without asking the model.
        stopEverything("voice");
        break;
      case "rejected":
        // Another voice about: Voice Match learns nothing for a while (app/voice/adapt.ts).
        if (e.reason === "voice") personal.strangerTurnedAway();
        // Voice Match turned another voice away: no task's short yes is trusted any more, and while a question was up, no
        // spoken yes for that question at all.
        if (rejectionEndsTrust(e.reason)) voiceTrust.endAll("other-voice");
        if (e.reason === "voice" && confirmer?.lockVoice()) {
          log.info("voice.answer_locked");
          confirmer.note(VOICE_ANSWER_REFUSED.locked);
        }
        // "Ember, allow" said while Ember read the question out, where it can't tell its voice from the user's (Windows,
        // macOS): the wake was turned away, silently until now. It is never taken (it may be Ember's own words): Ember
        // stops speaking, and the bubble and Ember say to say it again (owner report of 2026-11-03).
        // Said once a question: again for the same one, Ember only stops speaking (review of #143).
        if (e.reason === "self" && confirmer?.waiting && e.heard && heardAnswer(e.heard)) {
          log.info("voice.answer_heard_over");
          voice?.hush();
          if (heardOverFor !== confirmer.currentNumber) { heardOverFor = confirmer.currentNumber; refuseVoiceAnswer("heard-over"); }
        }
        break;
    }
  };
  let tokens: TokenStore | null = null;
  let currentToken: string | null = null;
  // The user's own model provider (app/main/provider.ts): its API key is sealed in provider-key.bin, apart from the
  // settings, for the host it was entered for, and held by the service in memory only for the runtime's provider config.
  // Never logged (the agent's log is redacted), audited, shown or passed on. The keyring is asked only once the user's
  // provider is on with a key saved for its host: never otherwise, and on macOS only off the main thread (a Keychain
  // prompt there would hold Ember, and a second Ember waiting to hand over to it).
  const providers = createProviderService({
    settings, admin: () => admin, consented: () => consented(),
    keys: new ProviderKeyStore(path.join(userData, PROVIDER_KEY_FILE), safeStorage, { asyncKeyring: platform.os === "darwin" }),
    // Electron's fetch follows the system's proxy, as the runtime does.
    fetch: (url, init) => net.fetch(url, init) as unknown as ReturnType<FetchLike>,
    log: log.child("provider"),
    changed: () => { void agent?.providerChanged(); sendToHome(PROVIDER_IPC.changed, null); },
  });
  /** The endpoint in force now: the administrator's (or a development test server) once main has set it, else the user's own. */
  let fixedProvider: ActiveProvider | null = null;
  const providerNow = (): ActiveProvider | null => activeProvider({ fixed: fixedProvider, settings: settings.get(), admin, key: providers.key() });
  /** Sign-ins Copilot refused this run (a stale GH_TOKEN, an expired one): the next source is used instead, until Sign out (review #139). */
  const refusedTokens = new Set<string>();
  /**
   * Ember's own sign-in, when its GitHub App's tokens expire (eight hours): renewed from an hour before, once nothing is
   * under way (or two minutes before it runs out regardless, and at once when it ran out during sleep), and Copilot
   * reconnected with the new token at once (review #138, cross-review X11, X12).
   */
  const keeper = new GrantKeeper({
    fetch: (url, init) => net.fetch(url, init), store: () => tokens, inUse: () => currentToken, idle: () => agent?.idle ?? true,
    reconnect: async token => { currentToken = token; await agent?.start(token, "stored"); },
    log: (event, data) => log.info(event, data),
  });
  /** The sign-in to use: the first source whose token Copilot hasn't refused this run (a stored one that ran out renewed first). */
  const findToken = async () => { await keeper.freshen(); return resolveToken(tokens, process.env, ghOptions(), refusedTokens).catch(() => null); };
  /**
   * Counts Sign out, from the click: a sign-in that a look under way then finds isn't connected, which would undo the
   * sign-out (the account just left, read or renewed before its file was cleared) (final review S1).
   */
  let signOuts = 0;
  /**
   * Connects with `found`, or the first sign-in after it that Copilot accepts: a refused token gives way to the next
   * source (a token in the environment comes before the GitHub CLI's). Resolves to the phase and the sign-in used.
   * `since`: the count of sign-outs when the look for `found` began. Signed out since: nothing is connected (none used).
   */
  const connectWith = async (found: ResolvedToken | null, how: "user" | "auto" = "user", since = signOuts) => {
    if (since !== signOuts) return { phase: agent?.getStatus().phase, found: null };
    return connectFirstAccepted(async () => { const next = await findToken(); return since === signOuts ? next : null; }, async f => {
      currentToken = f?.token ?? null;
      keeper.use(currentToken);
      const phase = await agent?.start(currentToken, f?.source, how, f?.name);
      return { phase, refused: phase === "error" && agent?.getStatus().reason === "sign-in" };
    }, refusedTokens, found);
  };
  let signInAbort: AbortController | null = null;
  const broadcast = (channel: string, value: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, value);
  };
  // Telling the user a newer Ember is out (app/main/updates.ts): only once they turned it on and agreed to its note.
  const updates = new UpdateChecker({
    fetch: (url, init) => net.fetch(url, init), current: app.getVersion(), log: log.child("updates"),
    allowed: () => {
      const u = settings.get().updates;
      return consented() && policy.features.updates !== false && u.on && u.consent.version >= FEATURE_CONSENT_VERSION.updates;
    },
    told: () => settings.get().updates.told,
    lastChecked: () => settings.get().updates.checkedAt,
    checked: at => { try { settings.update({ updates: { ...settings.get().updates, checkedAt: at } }); } catch (err) { log.warn("updates.not_saved", { err }); } },
    announce: version => {
      settings.update({ updates: { ...settings.get().updates, told: version } });
      const notice = updateNotice(version);
      notify(notice.title, notice.body, () => { showHome(); sendToHome(IPC.focusSection, notice.section); });
    },
    changed: status => broadcast(IPC.updatesChanged, status),
  });
  settings.onChange(() => updates.refresh());
  updates.refresh();
  const progress = (p: SignInProgress) => broadcast(IPC.signInProgress, p);

  ipcMain.handle(IPC.agentStatus, guard(() => agent?.getStatus() ?? null));
  ipcMain.handle(IPC.conversation, guard(() => conversationNow()));
  ipcMain.handle(IPC.conversationSend, guard((input: unknown) => {
    const text = conversationRequest(input);
    if (!text) throw new Error("Enter a request of up to 2,000 characters.");
    if (!consented()) throw new Error("Finish setup before sending a request.");
    if (screenLock?.locked) throw new Error("Unlock your screen before sending a request.");
    // A typed "stop" while a task is at work stops everything at once (askEmber): no turn comes for it, and Home's
    // composer says so instead of waiting for a reply (home-c1-1). Also while Ember isn't connected (home-c2-1).
    const stops = agent?.stopsWith(text) === true;
    // Still starting, offline or reconnecting is said as such: Models & connections can't help with those. Signed out
    // while the user's own provider waits for its note, the host it waits for is named (integrations-r4-3).
    const status = agent?.getStatus() ?? { phase: "signed-out" as const };
    const refusal = composerSendRefusal(status, stops, status.phase === "signed-out" && !fixedProvider ? providerWaitingHost(settings.get(), admin) : null);
    if (refusal) throw new Error(refusal);
    // Home is Ember's own window. Its composer shares only the user's explicit request, never Home or stale app context.
    void askEmber(text, {}, Promise.resolve(null));
    return stops ? "stopped" : "sent";
  }));
  // Whether the conversation is answering a request (from Home, the Ask box or voice): Home says it, never a guess.
  ipcMain.handle(IPC.conversationTurn, guard(() => agent?.conversationTurn ?? "idle"));
  ipcMain.handle(IPC.conversationStop, guard(async () => {
    // Whether anything was stopped: a turn, a request waiting, or the answer still being spoken (home-3).
    const speaking = voice?.selfSpokeSince(Date.now()) ?? false;
    resetAnswerSpeech();
    return (await agent?.stopAnswer({ speaking })) ?? speaking;
  }));
  ipcMain.handle(IPC.conversationNew, guard(async () => {
    resetAnswerSpeech();
    await agent?.newConversation();
  }));
  // Home's Task activity (in memory only): asked for by the settings window alone, and pushed to it alone when the cards
  // change, at most every TASKS_PUSH_MS (a task's steps can come many a second; a closed window is sent nothing).
  ipcMain.handle(IPC.tasks, guard(() => agent?.taskActivities() ?? []));
  ipcMain.handle(IPC.openApproval, guard(() => targets?.openApproval() ?? false));
  ipcMain.handle(IPC.historyProblem, guard(() => historyStore?.problem ?? null));
  ipcMain.handle(IPC.taskControl, guard((raw: unknown) => taskControl(agent, raw)));
  const pushTasks = pushLater(TASKS_PUSH_MS, () => { if (home && !home.isDestroyed()) home.webContents.send(IPC.tasksChanged, agent?.taskActivities() ?? []); });
  tasksShown = () => { if (home && !home.isDestroyed()) pushTasks(); };
  ipcMain.handle(IPC.signOut, guard(async () => {
    signOuts++;
    accountErasures++;
    resetAnswerSpeech();
    signInAbort?.abort();
    // Projects' work goes here, at once: the "signed-out" status that follows also means a provider waiting for its
    // card, which keeps it (integrations-c2-1).
    forgetProject("all");
    // While still connected: delete this account's conversation so the next sign-in starts fresh.
    try {
      await agent?.forgetConversation();
    } finally {
      // Failed memory erasure must not leave a signed-in account or provider key active.
      try {
        currentToken = null;
        keeper.use(null);
        try { tokens?.clear(); }
        finally {
          try { providers.forget(); }
          finally {
            refusedTokens.clear();
            askHistory = [];
            await agent?.start(null);
          }
        }
      } finally {
        // A task result or late runtime turn during teardown must not seed the next account's playback.
        resetAnswerSpeech();
        accountErasures--;
      }
    }
  }));
  ipcMain.handle(IPC.cancelSignIn, guard(() => { signInAbort?.abort(); progress({ state: "cancelled" }); }));
  /** The page of the sign-in under way, opened again on request (GitHub's own pages, or the GitHub CLI's download page). */
  let signInPage: string | null = null;
  const openSignInPage = () => { if (signInPage && mayOpenSignInPage(signInPage)) void shell.openExternal(signInPage); };
  ipcMain.handle(IPC.openSignInPage, guard(openSignInPage));
  // Explicit Copy from Home (codes, setup commands and retained answers): every web permission stays denied, including
  // the clipboard's. Main writes only plain text from this window, within the session's per-message bound.
  ipcMain.handle(IPC.copyText, guard((text: unknown) => {
    if (typeof text !== "string" || !text || text.length > CONVERSATION_TEXT_LIMIT) throw new Error("Nothing to copy.");
    clipboard.writeText(text);
  }));
  // About this build's Show in Files (rp-8): only Ember's own log file, whatever the page sends.
  ipcMain.handle(IPC.showLogFile, guard(() => { shell.showItemInFolder(log.file); }));
  /** A sign-in that failed, in plain words (a network or certificate problem, not "net::ERR_…"; no promised retry). */
  const signInError = (err: unknown): string => explainSignInError(err, { online: net.isOnline(), reinstall: sys.words.reinstall });
  /**
   * "Check again": look for a sign-in (Ember's own, the environment, gh) and reconnect with it. Nothing found: `hint`
   * says what signing in needs in this build (the GitHub CLI, and how to install it here, without Ember's own app).
   */
  const retrySignIn = async (): Promise<RetryResult> => {
    if (!consented()) { showHome(); return { found: false, source: null }; }
    // A model provider in force: it is connected to again with the sign-in kept as it is, and no GitHub sign-in is
    // looked for or named (integrations-c1-1).
    return checkAgain(providerSummary(providerNow()), {
      reconnect: () => agent?.start(currentToken, agent.getStatus().source) ?? Promise.resolve(undefined),
      reason: () => agent?.getStatus().reason,
      github: async () => {
        // Sign-ins refused before are passed over; with nothing else, the one refused is tried again (it may work now).
        const since = signOuts;
        const first = await findToken() ?? (refusedTokens.size ? await resolveToken(tokens, process.env, ghOptions()).catch(() => null) : null);
        const { found } = await connectWith(first, "user", since);
        return { found: !!found, source: found?.source ?? null, ...(found ? {} : { hint: noSignInMessage({ os: platform.os, with: signInWith(), ghInstalled: ghInstalled() }) }) };
      },
    });
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
    // Ember's own GitHub App (its client id is built in, or EMBER_GITHUB_CLIENT_ID overrides it): the device flow.
    const clientId = githubClientId();
    if (!clientId) {
      // A build without a client id (a fork): watch for a GitHub CLI sign-in instead, and connect as soon as one appears
      // (no restart). The message says what that needs (a GitHub account with Copilot and the GitHub CLI) and how to
      // install gh here.
      // Without gh, an Open button shows where to get it (only that page, on request).
      const start = cliWaitStart(platform.os, ghInstalled());
      signInPage = start.page;
      say(start.progress);
      const before = currentToken;
      for (let i = 0; i < 200 && !ac.signal.aborted; i++) {
        // (A refused token in the environment is passed over: the new GitHub CLI sign-in is found behind it.)
        const found = await findToken();
        if (ac.signal.aborted) return;
        if (found && found.token !== before) {
          await connected((await connectWith(found)).phase);
          return;
        }
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!ac.signal.aborted) say({ state: "error", message: cliTimedOutMessage(platform.os, ghInstalled()) });
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
      // With what renews it, when the app's tokens expire.
      const grant = await pollDeviceGrant(fetch, clientId, code, { signal: ac.signal, onBlip: err => log.warn("auth.poll_blip", { err }) });
      const token = grant.token;
      // Cancelled at the last moment: the code was approved, but the user said no here.
      if (ac.signal.aborted) return;
      // In use from here, and Copilot switched to it in the same step (no await between): a renewal of the sign-in it
      // replaces, finishing meanwhile, is neither switched to nor saved, and a refusal of the connection it replaces
      // (still on the old token) is dropped by the host rather than taken for this one. The save goes on beside the
      // connection: sealed off the main thread on macOS, so a keychain prompt holds neither the app nor the connection.
      currentToken = token;
      keeper.use(token, grant);
      const saving = tokens?.saveAsync(grant) ?? Promise.resolve<SaveResult>("no-keyring");
      const phase = await agent?.start(token, "stored");
      const kept = await saving;
      // Signed out meanwhile: its clear() made the save write nothing, and its start(null) runs after this one.
      if (currentToken !== token) return;
      // Not kept (no keyring, or the file couldn't be written: a full or read-only disk): connected anyway, for this run.
      if (kept !== "kept") log.warn("auth.not_persisted", { reason: kept === "write-failed" ? "the token file couldn't be written" : "no keyring available", note: "sign-in lasts until Ember quits" });
      const why = kept === "write-failed" ? "Ember couldn't save the sign-in on this computer" : sys.words.keyringMissing;
      await connected(phase, kept === "kept" ? undefined : `Signed in. ${why}, so you'll need to sign in again next time.`);
    } catch (err) {
      if (!ac.signal.aborted) say({ state: "error", message: signInError(err) });
    }
  }));
  ipcMain.handle(IPC.voiceStatus, guard(() => voiceStatus()));
  // Only while the setting, with the organisation's policy applied, wants it (off where voice or speech is: admin.ts).
  ipcMain.handle(IPC.voiceNaturalRetry, guard(() => voice?.retryNaturalVoice()));
  /**
   * Hear Ember (Settings › Voice; it takes no arguments): one fixed sentence, as replies are said, only where Ember may
   * speak now (voice-speaking-7), and which voice said it once it was heard, never a guess before (voice-speaking-r3).
   */
  const hearEmber = async (): Promise<HearResult> => {
    if (policy.features.speak === false) return { spoke: false, why: "managed" };
    if (screenLock?.locked) return { spoke: false, why: "locked" };
    if (!voice || !maySpeak()) return { spoke: false, why: "off" };
    const heard = await voice.sample(HEAR_SAMPLE);
    return heard === "stopped" ? { spoke: false, why: "stopped" } : heard ? { spoke: true, voice: heard } : { spoke: false, why: "silent" };
  };
  ipcMain.handle(IPC.voiceHear, guard(() => hearEmber()));
  const presence = () => ({ hidden: overlay?.isHidden() ?? false, paused: followPaused, overlay: !!overlay, approval: confirmer?.waiting ?? false });
  presenceChanged = () => broadcast(IPC.presenceChanged, presence());
  ipcMain.handle(IPC.presence, guard(presence));
  ipcMain.handle(IPC.setPresence, guard((p: unknown) => {
    const want = (p && typeof p === "object" ? p : {}) as { hidden?: unknown; paused?: unknown };
    if (typeof want.hidden === "boolean") { shownForAnswer = false; keptHidden = want.hidden; overlay?.setHidden(want.hidden); syncHandle(); }
    if (typeof want.paused === "boolean") { followPaused = want.paused; overlay?.setPaused(followPaused); }
    broadcast(IPC.presenceChanged, presence());
    return presence();
  }));
  ipcMain.handle(IPC.quit, guard(() => quitEmber()));
  // The handle menu's Ask Ember… and Stop everything from settings: reachable without a pointer or a global shortcut.
  ipcMain.handle(IPC.openAsk, guard(() => { openAsk({ source: "settings" }); }));
  /** Project work under way may go on: the settings window open, shown or not (integrations-6). */
  const projectContinues = () => consented() && screenLock?.locked === false && policy.features.actions !== false &&
    agent?.getStatus().phase === "ready" && !!home && !home.isDestroyed();
  /** Project work may start: also with the settings window in view, where it is asked for. */
  const projectAvailable = () => projectContinues() && home?.isVisible() && !home.isMinimized();
  /**
   * Work on what Projects keeps here (export, a file's Remove, applying the reviewed patch) sends nothing, so it needs no
   * connection: the rest of projectAvailable holds (integrations-r3-2).
   */
  const projectLocal = () => projectMay("local", {
    consented: consented(), locked: screenLock?.locked !== false, actions: policy.features.actions !== false,
    shown: !!home && !home.isDestroyed() && home.isVisible() && !home.isMinimized(), ready: agent?.getStatus().phase === "ready",
  });
  ipcMain.handle(IPC.projectPick, guard(async (): Promise<ProjectSelection> => {
    const names = projectFiles.length ? projectNames(projectFiles) : [];
    const owner = home;
    if (!owner || !projectAvailable() || projectPicking || projectJob) return { names, error: "Project work is unavailable right now." };
    const previous = projectFiles;
    projectPicking = true;
    try {
      const selected = await dialog.showOpenDialog(owner, { title: "Choose project files", properties: ["openFile", "multiSelections"] });
      if (home !== owner || projectFiles !== previous) return { names: [] };
      // Not connected now (integrations-r1): the selection Home shows stays.
      if (!projectAvailable()) return { ...await projectSelection(previous), error: "Project work is unavailable right now." };
      if (selected.canceled) return await projectSelection(previous);
      const next = await projectSelection(selected.filePaths);
      if (home !== owner || projectFiles !== previous) return { names: [] };
      if (!projectAvailable()) return { ...await projectSelection(previous), error: "Project work is unavailable right now." };
      projectFiles = selected.filePaths;
      projectPatch = null;
      projectExchange = null;
      projectOutput = null;
      return { ...next, changed: true };
    } catch (err) {
      return { names: home === owner && projectFiles === previous ? names : [], error: err instanceof ProjectInputError ? err.message : "Couldn't choose project files." };
    } finally {
      projectPicking = false;
    }
  }));
  ipcMain.handle(IPC.projectRemove, guard(async (name: unknown): Promise<ProjectSelection> => {
    const files = projectFiles;
    if (!projectLocal() || projectPicking || projectJob) return { names: files.length ? projectNames(files) : [], error: "Project work is unavailable right now." };
    projectPicking = true;
    try {
      const next = removeProjectFile(files, name);
      const selection = await projectSelection(next);
      if (projectFiles !== files) return { names: [] };
      if (!projectLocal()) return { ...await projectSelection(files), error: "Project work is unavailable right now." };
      projectFiles = next;
      projectPatch = null;
      projectExchange = null;
      return { ...selection, changed: true };
    } catch (err) {
      return { names: files.length ? projectNames(files) : [], error: err instanceof ProjectInputError ? err.message : "Couldn't remove the file." };
    } finally { projectPicking = false; }
  }));
  ipcMain.handle(IPC.projectExport, guard(async (kind: unknown): Promise<{ message: string }> => {
    const output = projectOutput;
    const owner = home;
    if ((kind !== "answer" && kind !== "diff") || !output || !owner || !projectLocal() || projectPicking || projectJob) {
      return { message: "Choose an available project answer or diff to export." };
    }
    const text = kind === "diff" ? output.diff : output.answer;
    if (!text) return { message: "No project diff is available to export." };
    projectPicking = true;
    const current = () => projectOutput === output && home === owner && projectLocal() === true;
    try {
      const result = await dialog.showSaveDialog(owner, {
        title: kind === "diff" ? "Export project diff" : "Export project answer",
        defaultPath: kind === "diff" ? "ember-project.diff" : "ember-project-answer.txt",
        filters: [{ name: kind === "diff" ? "Unified diff" : "Plain text", extensions: [kind === "diff" ? "diff" : "txt"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      if (result.canceled || !result.filePath || !current()) return { message: "Project export cancelled." };
      exportProjectText(result.filePath, text, userData, current, projectFiles);
      return { message: kind === "diff" ? "Project diff exported. Exporting does not apply changes." : "Project answer exported." };
    } catch (err) {
      return { message: err instanceof ProjectInputError ? err.message : "Couldn't export the project output. Choose another destination." };
    } finally { projectPicking = false; }
  }));
  ipcMain.handle(IPC.projectRun, guard(async (request: unknown): Promise<ProjectResult> => {
    const input = projectTurnRequest.safeParse(request);
    if (!input.success) return { error: "Enter a project request of up to 4,000 characters." };
    const host = agent;
    if (!host || !projectAvailable() || projectJob || projectPicking) return { error: "Project work is unavailable right now." };
    const { mode, question, includePrevious } = input.data;
    // An answer from another model service or account is never sent to this one (integrations-r1): Home hides the choice.
    if (includePrevious && projectExchange && projectExchangeScope !== host.projectWorkspaceScope()) {
      forgetProject("previous");
      return { error: PROJECT_PREVIOUS_ELSEWHERE };
    }
    const run = projectJob = new AbortController();
    const files = projectFiles;
    // Stopped by the connection dropping (a reconnect, the service out of reach), not by the person (integrations-r1).
    const lost = () => agent?.getStatus().phase !== "ready";
    try {
      projectPatch = null;
      const sources: ProjectSource[] = [];
      const prompt = await projectPrompt(files, mode, question, run.signal, userData, mode === "patch" ? sources : undefined,
        includePrevious ? projectExchange : null);
      if (run.signal.aborted || projectFiles !== files || host !== agent || !projectContinues()) return { error: projectStopped(lost()) };
      const answer = await host.runProject(prompt, run);
      if (run.signal.aborted || !projectContinues()) return { error: projectStopped(lost()) };
      if (!answer) return { error: lost() ? projectStopped(true) : PROJECT_MODEL_FAILED };
      const read = mode === "patch" ? readProjectPatch(answer, sources) : null;
      projectPatch = read && "diff" in read ? read : null;
      const shown = answer.length > 24_000 ? `${answer.slice(0, 24_000)}\n\nThe answer was cut. Ask for a smaller change.` : answer;
      projectExchange = memoryRefusal(answer) ? null : { mode, question, answer: shown };
      projectExchangeScope = host.projectWorkspaceScope();
      projectOutput = { answer: shown, ...(projectPatch ? { diff: projectPatch.diff } : {}) };
      return {
        answer: shown, canContinue: projectExchange !== null,
        ...(projectPatch ? { patch: { name: projectPatch.source.name, diff: projectPatch.diff } } : {}),
        ...(read && "withheld" in read ? { withheld: { name: read.name, line: read.line } } : {}),
      };
    } catch (err) {
      // The model service's refusal says what to do about it (integrations-5); a file that couldn't be read says which.
      return { error: run.signal.aborted ? projectStopped(lost()) : err instanceof ProjectInputError || err instanceof ProjectModelError ? err.message : "Couldn't read the selected files. Choose them again." };
    } finally {
      if (projectJob === run) projectJob = null;
    }
  }));
  ipcMain.handle(IPC.projectApply, guard(async () => {
    const patch = projectPatch;
    const owner = home;
    const record = audit;
    if (!patch || !owner || !record || !projectLocal() || projectJob || projectPicking) {
      return { done: false, message: "Draft an applicable patch before trying to apply it." };
    }
    const run = projectJob = new AbortController();
    projectLocalJobs.add(run);
    try {
      const { response } = await dialog.showMessageBox(owner, {
        type: "warning", title: "Apply project patch", message: `Apply the reviewed patch to ${patch.source.name}?`,
        detail: patch.source.file, buttons: ["Cancel", "Apply patch"], cancelId: 0, defaultId: 0, signal: run.signal,
      });
      if (response !== 1 || run.signal.aborted || !projectLocal() || projectPatch !== patch || home !== owner) {
        return { done: false, message: "Patch application cancelled." };
      }
      applyProjectPatch(patch, run.signal, () => record.write({ event: "confirm", kind: "project-patch", answer: "once" }));
      projectPatch = null;
      try { record.write({ event: "action", kind: "project-patch", ok: true }); } catch { /* the confirmation was recorded before writing */ }
      return { done: true, message: `Patch applied to ${patch.source.name}.` };
    } catch (err) {
      return { done: false, message: run.signal.aborted ? "Patch application cancelled." : err instanceof ProjectInputError ? err.message : "Couldn't apply the patch. Draft it again after checking the file." };
    } finally {
      if (projectJob === run) projectJob = null;
    }
  }));
  ipcMain.handle(IPC.projectChooseFolder, guard(async () => {
    const owner = home;
    if (!owner || !projectAvailable() || projectPicking || projectJob) return { folder: null, message: "Project work is unavailable right now." };
    const previous = projectFiles;
    projectPicking = true;
    try {
      const selected = await dialog.showOpenDialog(owner, { title: "Choose command folder", properties: ["openDirectory"] });
      if (home !== owner || projectFiles !== previous || !projectAvailable()) return { folder: projectFolder?.path ?? null, message: "Folder selection cancelled." };
      if (!selected.canceled && selected.filePaths.length === 1) projectFolder = projectCommandFolder(selected.filePaths[0], userData);
      return { folder: projectFolder?.path ?? null };
    } catch (err) {
      return { folder: projectFolder?.path ?? null, message: err instanceof ProjectInputError ? err.message : "Couldn't open that folder." };
    } finally {
      projectPicking = false;
    }
  }));
  ipcMain.handle(IPC.projectRunCommand, guard(async (raw: unknown): Promise<string> => {
    const parsed = projectCommandText.safeParse(raw);
    if (!parsed.success) return "Enter one line of up to 2,000 characters without passwords or keys.";
    const host = agent;
    const folder = projectFolder;
    if (!host || !projectAvailable() || projectPicking || projectJob) return "Project work is unavailable right now.";
    if (!folder?.current()) return "Choose a current command folder.";
    const service = targets?.localProjectCommands();
    if (!service) return "Commands are off on this computer. Check the Commands settings.";
    const run = projectJob = new AbortController();
    try {
      return await host.runProjectCommand(parsed.data, folder.path, service, run.signal,
        () => projectFolder === folder && projectContinues() === true && folder.current());
    } catch {
      return run.signal.aborted ? "Project command stopped." : "Couldn't finish the command. Check the command window.";
    } finally {
      if (projectJob === run) projectJob = null;
    }
  }));
  ipcMain.handle(IPC.projectWorkspace, guard(async (raw: unknown): Promise<ProjectWorkspaceReply> => {
    const input = workspaceAction.safeParse(raw);
    if (!input.success) return { message: "Enter a workspace name of up to 64 characters." };
    const host = agent;
    const owner = home;
    if (!host || !owner || !projectAvailable() || projectPicking || projectJob) return { message: "Project work is unavailable right now." };
    const scope = host.projectWorkspaceScope();
    if (!scope) return { message: "Connect with a verified GitHub account or model provider to use saved workspaces." };
    const run = projectJob = new AbortController();
    const current = () => !run.signal.aborted && home === owner && agent === host && projectAvailable() === true && host.projectWorkspaceScope() === scope;
    try {
      const entries = await projectWorkspaces.list(scope);
      if (!current()) return { message: "Workspace request cancelled." };
      const names = entries.map(entry => entry.name);
      const request = input.data;
      if (request.action === "list") return { names };
      const name = request.name;
      const other = entries.filter(entry => entry.name !== name);
      if (request.action === "save") {
        if (!projectFiles.length && !projectFolder?.current()) return { names, message: "Choose project files or a command folder first." };
        const entry = { name, files: projectFiles, folder: projectFolder?.current() ? projectFolder.path : null, exchange: projectExchange };
        await projectWorkspaces.write(scope, [entry, ...other], current);
        return { names: [name, ...other.map(saved => saved.name)], message: `Saved workspace “${name}”.` };
      }
      const entry = entries.find(saved => saved.name === name);
      if (!entry) return { names, message: "That workspace is no longer saved." };
      if (request.action === "forget") {
        const { response } = await dialog.showMessageBox(owner, {
          type: "question", message: `Forget saved workspace “${name}”?`, detail: "Your project files stay where they are.",
          buttons: ["Cancel", "Forget workspace"], defaultId: 0, cancelId: 0, signal: run.signal,
        });
        if (response !== 1 || !current()) return { names, message: "Workspace kept." };
        await projectWorkspaces.write(scope, other, current);
        return { names: other.map(saved => saved.name), message: `Forgot workspace “${name}”.` };
      }
      const selection = await projectSelection(entry.files);
      if (!current()) return { message: "Workspace request cancelled." };
      let folder: typeof projectFolder = null;
      if (entry.folder) {
        try { folder = projectCommandFolder(entry.folder, userData); }
        catch { /* a moved folder needs a fresh selection */ }
      }
      projectFiles = entry.files;
      projectFolder = folder;
      projectExchange = entry.exchange;
      projectExchangeScope = scope;
      projectOutput = entry.exchange ? { answer: entry.exchange.answer } : null;
      projectPatch = null;
      return {
        names, opened: { files: selection.names, sizes: selection.sizes, folder: folder?.path ?? null, previous: projectExchange },
        message: entry.folder && !folder ? `Opened workspace “${name}”. Choose the command folder again.` : `Opened workspace “${name}”.`,
      };
    } catch (err) {
      return { message: run.signal.aborted ? "Workspace request cancelled." : err instanceof ProjectInputError ? err.message : "Couldn't read or save the workspace library." };
    } finally {
      if (projectJob === run) projectJob = null;
    }
  }));
  ipcMain.handle(IPC.projectClear, guard(clearProject));
  ipcMain.handle(IPC.projectCancel, guard(() => projectJob?.abort()));
  const listenOnceFromHome = guard((on: boolean): ListenOnceStatus => on && (!home?.isVisible() || home.isMinimized())
    ? { phase: "blocked", detail: "Open Ember's settings to listen here." }
    : requestListenOnce("home", on));
  ipcMain.handle(IPC.listenOnce, (event, on: unknown) => {
    if (typeof on !== "boolean") throw new Error("Invalid listening request");
    if (askWindow.visible && askWindow.owns(event.sender) && isTrustedSender(event.senderFrame?.url ?? "")) return requestListenOnce("ask", on);
    return listenOnceFromHome(event, on);
  });
  ipcMain.handle(IPC.stopEverything, guard(() => { stopEverything("settings"); }));
  // First run's "Hey Ember" try: the microphone's level (a step of 0–8, never audio) goes to the settings window too,
  // only while that step shows and the window can be seen.
  ipcMain.handle(IPC.watchLevel, guard((on: unknown) => { homeWantsLevel = on === true; }));
  // Voice Match: teaching needs Ember listening (the microphone open); the voiceprint goes in when the phrases are in.
  ipcMain.handle(IPC.voiceMatchEnrol, guard(() => {
    if (policy.features.voice === false || !voice?.enrol()) return false;
    enrolling = { got: 0, of: ENROL_PHRASES.length, phrase: ENROL_PHRASES[0] };
    enrolEnded = undefined;
    broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
    return true;
  }));
  ipcMain.handle(IPC.voiceMatchCancel, guard(() => { voice?.cancelEnrol(); if (enrolling) enrolEnded = "cancelled"; enrolling = null; broadcast(IPC.voiceStatus, voiceStatus(voiceDetail)); }));
  ipcMain.handle(IPC.voiceMatchForget, guard(() => {
    voice?.cancelEnrol();
    enrolling = null;
    enrolEnded = undefined;
    // The voiceprint, all it learnt, and the words learnt from what the user said (personal/service.ts).
    personal.forgetVoice();
    // A task's voice trust was granted against the voiceprint that is gone (voice-answer.ts TaskVoiceTrust).
    voiceTrust.endAll("voice-changed");
    settings.update({ voice: { ...settings.get().voice, match: false } });
    voice?.setVoiceprint(null);
    log.info("voice.match_forgotten");
    broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
  }));
  ipcMain.handle(IPC.voiceMatchReset, guard(() => {
    if (!voiceprints.reset()) return;
    voice?.setVoiceprint(ownerPrint());
    log.info("voice.match_reset");
    broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
  }));
  ipcMain.handle(IPC.voiceHeard, guard(() => personal.heardItems().map(h => h.id)));
  ipcMain.handle(IPC.voiceTeach, guard((id: unknown, meant: unknown) => {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || typeof meant !== "string" || !meant.trim() || meant.length > 2000) return { outcome: "unknown" };
    const r = personal.teach(id, meant);
    if (r.outcome === "learnt") broadcast(IPC.voiceWords, personal.words());
    return r;
  }));
  ipcMain.handle(IPC.voiceWords, guard(() => personal.words()));
  ipcMain.handle(IPC.voiceForgetWord, guard((expected: unknown) => personal.forgetWord(expected)));
  ipcMain.handle(IPC.voiceForgetWords, guard(() => { personal.forgetWords(); log.info("voice.words_forgotten"); }));
  ipcMain.handle(IPC.memoryList, guard(memoryView));
  ipcMain.handle(IPC.memoryForget, guard((id: unknown) => {
    if (!memoryOwner.ready) throw new Error("Ember couldn't finish deleting this memory. Wait until your saved memory is available, then try Undo or Forget again.");
    if (typeof id !== "string" || !id || id.length > 40) throw new Error("Ember couldn't finish deleting this memory. Try Forget again.");
    // Through learning: its "Ember learned" line and "forget that" let go of it too. Home says what went, with Undo.
    return learning.forgetCounted(id);
  }));
  // Undo of a recent Forget (Home's list, or an "Ember forgot" line): only while the account's memory is open, as its
  // list and Forget are (also while memory is switched off: memory-r3), never once the organisation turned memory off.
  ipcMain.handle(IPC.memoryRestore, guard((token: unknown) => {
    const open = memoryOwner.ready && memoryAllowed() && consented();
    if (!open) throw new Error("Ember couldn't put this memory back. Wait until your saved memory is available, then try Undo again.");
    if (typeof token !== "string" || token.length < 8 || token.length > 64) return false;
    const restored = learning.restore(token, open);
    // Its "Ember forgot" line says it is remembered again, where it was (memory-c1-3).
    const next = restored ? linesAfterRestore(learnedLines, token) : null;
    if (next) {
      learnedLines = next;
      broadcast(IPC.conversationChanged, conversationNow());
    }
    return restored;
  }));
  // A correction stays bound to the exact fact and current account view, without changing its source authority.
  ipcMain.handle(IPC.memoryCorrect, guard((change: unknown) => correctMemoryRequest(change, {
    ready: memoryOwner.ready, inForce: memoryOn(), epoch: memoryEpoch, correct: (expected, text) => learning.correct(expected, text),
  })));
  // Through learning: what waits to be learned, the "Ember learned" lines and Better recall's vectors go too.
  ipcMain.handle(IPC.memoryForgetAll, guard(() => {
    learning.forgetAll();
    // The saved copy of the conversation is part of what Ember keeps about the person: it goes too.
    const savedGone = agent?.forgetHistory() ?? true;
    memoryOwner.clear();
    memoryOwner.refresh(memoryConfigured());
    memoryEpoch++;
    publishMemoryOwner();
    // Told after the rest is done (Home shows a sentence that starts like this as it is).
    if (!savedGone) throw new Error("Ember couldn't finish deleting the saved conversation on this computer. Try Forget again.");
  }));
  // "Tell Ember about you": checked whole (IntroSchema, every string bounded) and kept only while memory is in force.
  ipcMain.handle(IPC.memoryIntroduce, guard((answers: unknown) => learning.introduce(answers)));
  // Better recall's model: its state, and the user's Download (the agreement to fetch it) and Remove.
  ipcMain.handle(IPC.memoryModel, guard(() => betterRecall.status()));
  ipcMain.handle(IPC.memoryModelDownload, guard(() => { void betterRecall.download().catch(() => { /* Settings is told why, in the status */ }); }));
  ipcMain.handle(IPC.memoryModelRemove, guard(() => {
    try { betterRecall.remove(); }
    catch (err) { throw new Error("Ember couldn't finish deleting Better recall's saved data. Try Remove again.", { cause: err }); }
  }));
  ipcMain.handle(IPC.updatesStatus, guard(() => updates.status));
  ipcMain.handle(IPC.updatesCheck, guard(() => updates.check()));
  ipcMain.handle(IPC.updatesOpen, guard(async () => {
    const page = updates.status.latest ? releasePage(updates.status.latest) : null;
    if (page) await shell.openExternal(page);
  }));
  ipcMain.handle(IPC.routinesList, guard(() => routineRows()));
  // The count for the Sign out and Forget questions: rejects when the book can't be read, so Home shows it as unknown.
  // Read from the file, not the book: no quarantine of a broken file, and policy-hidden routines still go at sign-out.
  // Only a tagged number leaves main: a failure's message carries the file's path.
  ipcMain.handle(IPC.routinesCount, guard(() => countStoredRoutines(userData, err => log.warn("routines.count_unreadable", { err: err instanceof Error ? err.message : String(err) }))));
  ipcMain.handle(IPC.remindersList, guard(() => reminderRows()));
  ipcMain.handle(IPC.reminderChange, guard((value: unknown) => {
    const parsed = ReminderChangeSchema.safeParse(value);
    if (!parsed.success || !hasConsent(settings.get())) throw new Error("Couldn't change this reminder. Refresh the list and try again.");
    const { expected, replacement } = parsed.data;
    try {
      const changed = agent?.reminders.change(expected, replacement, next => {
        const r = settings.get().routines;
        if (routinesAllowed() && r.on && r.consent.version >= FEATURE_CONSENT_VERSION.routines) routineBook.setReminders(next);
        else {
          // A reminder already kept must not reappear after a successful cancellation/edit while the mode changes.
          const kept = routineBook.reminders();
          if (kept.some(k => k.id === expected.id)) routineBook.setReminders(kept.filter(k => k.id !== expected.id));
        }
      });
      if (!changed) throw new Error("This reminder changed or is already due. Refresh the list and try again.");
    } catch (err) {
      if (err instanceof Error && /^(This reminder|Choose reminder)/.test(err.message)) throw err;
      throw new Error("Couldn't save the reminder change. The original reminder is still waiting.", { cause: err });
    }
  }));
  ipcMain.handle(IPC.routinesForget, guard((id: unknown) => {
    if (typeof id !== "string" || !id || id.length > 20) return;
    routineBook.forget(id);
  }));
  // Everything kept goes, and so do the reminders waiting this run (they would be kept again at their next change).
  ipcMain.handle(IPC.routinesForgetAll, guard(() => { routineBook.forgetAll(); agent?.reminders.clear(); }));
  // Extensions, plugins and connectors (Home's Extensions section): the settings window's own page only, as guard. With
  // no runtime the section says extensions aren't available yet; EMBER_TEST_EXTENSIONS shows a pretend one, which opens
  // nothing in the browser.
  const extensionsDemo = demoVariant(devEnv("EMBER_TEST_EXTENSIONS"));
  const extensionsApi: ExtensionsApi | null = extensionsDemo ? demoExtensionsApi(extensionsDemo) : extensions;
  // The user's own model provider (Home › Copilot): the settings window's own page only, as guard. The key comes in once
  // (saveKey) and is never sent back; "Test connection" makes one request to the endpoint in settings, with the saved key.
  registerProviderIpc(ipcMain, event => {
    const url = event.senderFrame?.url ?? "";
    return isTrustedSender(url) && !!home && !home.isDestroyed() && event.sender === home.webContents;
  }, providers.api, { log: log.child("provider") });
  // Any settings change may move the endpoint in force (the switch, its address, its models, its card): the host
  // reconnects when nothing would be cut off, else as soon as the turn and the tasks under way are done.
  settings.onChange(() => { providers.settingsChanged(); void agent?.providerChanged(); });
  registerExtensionsIpc(ipcMain, event => {
    const url = event.senderFrame?.url ?? "";
    return isTrustedSender(url) && !!home && !home.isDestroyed() && event.sender === home.webContents;
  }, extensionsApi, url => (extensionsDemo ? log.info("extensions.demo_open", { url }) : shell.openExternal(url)), { send: sendToHome, log: log.child("extensions") });
  ipcMain.handle(IPC.voiceDownload, guard(async () => {
    // Listening turned off by the organisation: nothing to download for.
    if (policy.features.voice === false) return;
    try {
      await voice?.downloadModels((done, total, phase) => broadcast(IPC.voiceProgress, { done, total, ...(phase ? { phase } : {}) }));
    } catch {
      return; // VoiceService already left "Downloading…" and said why (onState → voiceStatus with the detail)
    }
    broadcast(IPC.voiceStatus, voiceStatus());
  }));
  ipcMain.handle(IPC.voiceDownloadCancel, guard(() => { voice?.cancelDownload(); }));
  ipcMain.on(IPC.ask, (event, text: unknown) => {
    if (!askWindow.owns(event.sender) || typeof text !== "string") return;
    askWindow.hide();
    const t = text.slice(0, 2000);
    askHistory = [...askHistory.filter(h => h !== t), t].slice(-20);
    void askEmber(t);
  });
  ipcMain.on(IPC.askClose, event => { if (askWindow.owns(event.sender)) askWindow.hide(); });
  // "Set up voice in Settings…" (the speech models aren't downloaded): Home at Voice, its Download in view.
  ipcMain.on(IPC.askVoiceSettings, event => {
    if (!askWindow.owns(event.sender) || !isTrustedSender(event.senderFrame?.url ?? "")) return;
    askWindow.hide();
    showHome();
    sendToHome(IPC.focusSection, "voice:voice-download");
  });
  // One of Ember's suggestions chosen in the Ask box: only one it offers now, sent as Ember's words the user chose.
  // Never while a question is up, nor one that followed an answer no longer shown (companion-r2-1, companion-c2-2).
  ipcMain.on(IPC.askSuggestion, (event, text: unknown) => {
    if (!askWindow.owns(event.sender) || typeof text !== "string" || text.length > 200 || !personal.isSuggestion(text) || !askOffers().includes(text)) return;
    askWindow.hide();
    log.info("ask.suggestion");
    void askEmber(text, { suggested: true });
  });

  const isRect = (r: unknown): r is Rect => !!r && typeof r === "object" && ["x", "y", "width", "height"].every(k => Number.isFinite((r as Record<string, unknown>)[k]));
  ipcMain.on(OVERLAY.cards, (event, rect: unknown) => {
    if (!overlay?.owns(event.sender) || !(rect === null || isRect(rect))) return;
    overlay.setCards(event.sender, rect);
    // A card that came up or grew under the open box: the box moves off it (companion-r5-1).
    askWindow.keepClear();
  });
  ipcMain.on(OVERLAY.bubble, (event, raw: unknown) => {
    if (!overlay?.owns(event.sender)) return;
    const rect = bubbleBoxOf(raw);
    if (rect === undefined) return;
    const ended = overlay.bubbleRect()?.endShown === true;
    overlay.setBubble(event.sender, rect);
    // An answer opened in full showed its end, or another bubble came: what answers it is offered or goes (companion-v6-2).
    if ((overlay.bubbleRect()?.endShown === true) !== ended) askOffersChanged();
    // A question (or the box's own Listen once's "Listening…", never a wake's: companion-c2-3) that found no room clear
    // of the open Ask box: the box steps aside, once (companion-c1-1).
    askWindow.bubbleChanged(stepsAsideFor(lastState.bubble, manualCall?.source === "ask"));
  });
  ipcMain.on(OVERLAY.motion, (event, on: unknown) => {
    if (overlay?.owns(event.sender) && typeof on === "boolean") overlay.reducedMotionChanged(on);
  });
  ipcMain.on(OVERLAY.interactive, (event, rects: unknown) => {
    if (!overlay?.owns(event.sender) || !Array.isArray(rects) || rects.length > 32 || !rects.every(isRect)) return;
    overlay.setInteractive(event.sender, rects);
  });
  /** From the handle's page (a handle closed or crashed is no one: a check on it must not throw for the overlay's clicks). */
  const isHandle = (sender: Electron.WebContents) => !!handle && !handle.win.isDestroyed() && sender === handle.win.webContents;
  ipcMain.on(OVERLAY.pointerHeld, (event, held: unknown) => {
    if (overlay?.owns(event.sender) && typeof held === "boolean") overlay.pointerHeld(event.sender, held);
  });
  ipcMain.on(OVERLAY.taskReading, (event, raw: unknown) => {
    if (!overlay?.owns(event.sender) || !raw || typeof raw !== "object") return;
    const r = raw as { id?: unknown; reading?: unknown };
    if (typeof r.id !== "string" || r.id.length > 120 || typeof r.reading !== "boolean") return;
    agent?.tasks?.reading(r.id, event.sender.id, r.reading);
  });
  ipcMain.on(OVERLAY.bubbleAction, (event, id: unknown) => {
    const fromHandle = isHandle(event.sender);
    if (!(overlay?.owns(event.sender) || fromHandle) || typeof id !== "string" || id.length > 120) return;
    const task = /^task:(.+):(stop|dismiss|retry)$/.exec(id);
    // A question's whole text has all been in view on that page (review #116): its Allow works from now on. It says what
    // the user saw, not a click, so it counts while Ember drives the mouse too (the page takes no pointer then).
    const seen = wholeSeenOf(id);
    if (seen !== null) { confirmer?.wholeSeen(seen); return; }
    // Stopping a task is always honoured (also while Ember waits for the mouse), and so is an announced command's Stop
    // (critique integration-24). Anything else that arrives while Ember really drives the pointer was Ember's own
    // click, not the user's: ignored.
    if (borrowRef?.driving && !(task && task[2] === "stop") && !id.startsWith("ui:cmdstop:") && id !== "ui:stop") { log.warn("bubble.action_while_borrowing", { id }); return; }
    // The conversation's Stop while Copilot keeps it waiting (its turn ends; tasks go on), and a problem's Try again
    // (the same request, as it was asked: offered only where its turn ran no tool).
    if (id === "ui:stop") { resetAnswerSpeech(); void agent?.stopAnswer(); return; }
    if (id === "ui:retry") {
      // Taken on the first press: a second one, while this request waits for the screen's context, asks nothing.
      const again = agent?.takeRetry() ?? null;
      // Its caution as it was asked (heard unchecked, or one of Ember's suggestions: never the user's own words for
      // commands, however often it is retried); one no longer remembered here is treated as heard unchecked.
      const how = again === null ? undefined : [...recentAsks].reverse().find(a => a.text === again);
      if (again !== null) { captureContext(); void askEmber(again, { voiceUnchecked: how ? how.voiceUnchecked : true, ...(how?.suggested ? { suggested: true } : {}) }); }
      return;
    }
    // One of Ember's suggestions (what the user might say next): sent as the user's click on Ember's words, so the usual
    // policy applies and a command it names is never taken as the user's own words. Only one the bubble shows now
    // (suggestionsShown: never while a question or buttons are up).
    const suggested = suggestOf(id);
    if (suggested !== null) {
      const text = suggestionsShown(lastState)[suggested];
      if (text && personal.isSuggestion(text)) { log.info("bubble.suggestion", { n: suggested }); captureContext(); void askEmber(text, { suggested: true }); }
      return;
    }
    if (id === "ui:settings") { openSettings(); return; }
    // "Memory is off" behind the answer to a "remember…" memory couldn't keep (memory-c1-1): Settings › Memory, at its
    // list after a forget request (memory-r3-4).
    const memoryAt = memoryActionOpens(id);
    if (memoryAt) { openMemory(memoryAt); return; }
    if (id === "ui:setup-check") { showHome(); sendToHome(IPC.focusSection, "checks"); agent?.releaseBubble(lastState.bubble); return; }
    if (id === "ui:more") { expandAnswer(); return; }
    if (id === "ui:conversation") { readLastAnswer(); return; }
    if (id === "ui:close") { closeExpanded(); return; }
    // The administrator's policy changed while Ember ran: a restart reads it whole (run from an AppImage, the AppImage).
    if (id === "ui:restart" && admin.held) { app.relaunch(restartOptions(process.env, process.argv, process.execPath)); app.quit(); return; }
    // The targets runtime's own: a target picked, an offer, a connection, a panel to show, an announced command's Stop.
    if (targets?.bubbleAction(id)) return;
    if (task) {
      // Try again (a failed task's card): the user's click starts the same request again, asking every question again.
      if (task[2] === "stop") agent?.tasks?.cancel(task[1]); else if (task[2] === "retry") agent?.retryTask(task[1]); else agent?.tasks?.dismiss(task[1]);
      log.info("task.card_action", { action: task[2] });
      return;
    }
    log.info("bubble.action", { id, handled: confirmer?.answer(id, "bubble") ?? false });
  });
  ipcMain.on(OVERLAY.handleMenu, event => {
    if (isHandle(event.sender)) showMenu();
  });
  // The corner card showed the last line of the answer opened in full on it: what answers it is offered, only for the
  // answer shown now (a word about one that has gone is dropped: companion-repairs-x6-3).
  ipcMain.on(OVERLAY.handleAnswerEnd, (event, words: unknown) => {
    if (!isHandle(event.sender) || typeof words !== "string" || words.length > CONVERSATION_TEXT_LIMIT || words === cardEnded || !answerEndShown(lastState.bubble, null, words)) return;
    cardEnded = words;
    askOffersChanged();
  });
  ipcMain.on(OVERLAY.handleFit, (event, height: unknown) => {
    if (handle && isHandle(event.sender) && typeof height === "number") { handle.fit(height); deskViewRef?.handleMoved(); askWindow.keepClear(); }
  });

  settings.onChange((s) => {
    // The handle first: it may move (Handle position, the text size), and the overlays then hear where it is now.
    if (handle?.sendSettings(s)) deskViewRef?.handleMoved();
    // The desk view's bar grows with the text size: the view fits it at once (only when the size changed).
    deskViewRef?.fitText();
    overlay?.broadcastSettings(s);
  });
  // "Start Ember when I log in" keeps the OS's login item (Linux: ~/.config/autostart/ember.desktop) in step: at start
  // only when it is on, then whenever it changes, so a start with it off removes nothing (review #85).
  const autostart = loginItemFollower(on => sys.autostart.sync(on), (on, changed) => { if (changed) log.info("autostart.updated", { on }); },
    err => log.warn("autostart.failed", { err }));
  autostart(settings.get().startAtLogin);
  settings.onChange(s => autostart(s.startAtLogin));
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
    // The handle's word follows: "Finish setting up" until first run is done, the agent's own after (first-run-8).
    if (s.onboarded !== wasOnboarded) { const st = agent?.getStatus(); showState({ idle: st ? idleNow(st) : handleIdle(s.onboarded, "Not connected") }); }
    wasOnboarded = s.onboarded;
  });

  /**
   * The session ends (log-off, shut down) without will-quit on Windows and macOS (G10), and on Linux as the X server
   * goes: settings are saved and whatever Ember holds is let go of at once, as quitting would.
   */
  let sessionEnding = false;
  const endSession = (source: string) => {
    if (sessionEnding) return;
    sessionEnding = true;
    log.info("app.session_end", { source });
    endThisRun("session-end");
    try { settings.flush(); } catch (err) { log.warn("settings.not_saved", { err }); }
    // With the display gone there is no pointer or key to let go of, and asking X would end Ember mid-way.
    if (source !== "display-gone") {
      borrowRef?.stop();
      inputRef?.releaseAll();
    }
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
    // What Ember just remembered is written before it goes (a save waits a second after a change).
    learning.stop();
    memory.stop();
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
  // The display went away under Ember (a GNOME on Xorg logout ends the X server): the session is ending, not Ember
  // crashing, so this run's marker goes and the next login says nothing (reliability-performance-r1). Either Chromium
  // notices first, ends its run loop by itself and Electron says quit with no will-quit before it, or one of Ember's
  // own X calls does, and Xlib's IO error handler is the last word before the process ends. A failed start isn't this.
  if (sys.lifecycle.sessionEnd === "display-gone") {
    // After ready: GTK has set its own handler by then, which this one hands on to.
    let unwatchDisplay: (() => void) | null = null;
    void app.whenReady().then(() => { unwatchDisplay = sys.lifecycle.watchDisplay?.(() => endSession("display-gone")) ?? null; });
    app.on("quit", () => {
      if (!quitting && !startFailed) endSession("display-gone");
      unwatchDisplay?.();
    });
  }

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
    // The application menu (macOS: its Quit, Command+Q, asks as the handle's Quit does, and its Edit menu makes
    // Command+C/V/X/A/Z work in fields; Windows and Linux: none, so no Ctrl+Q that skips the question and no
    // DevTools), the dark native theme, the windows' icon on Linux and DevTools locked in a packaged build (windows.ts).
    setUpAppChrome({ os: platform.os, appMenu: sys.lifecycle.appMenu, appearance: settings.get().appearance, actions: { showSettings: () => showHome(), quit: () => void quitEmber() } });
    // Windows: the Start Menu shortcut toasts need (made once, for the zip build).
    sys.lifecycle.ensureShortcut();
    // Linux: X11 only with $DISPLAY, as always (the platform reads it).
    const ws = wsRef = wsState = platform.openWindows(log);
    const env = readEnvironment();
    let compositing = ws ? ws.hasCompositor() : false;
    askWindow.setOpaque(!compositing);
    // Made now (hidden), so the ask shortcut opens it at once: a box still loading took the first letters typed. Agreed
    // to later (the first run), it is made then (review #78).
    if (consented()) askWindow.prepare();
    settings.onChange(() => { if (consented()) askWindow.prepare(); askOffersChanged(); });
    // Where the pointer is, in global DIP, and the buttons held: from the window system (X11's XQueryPointer reports
    // physical pixels; Electron's position can be stale there), else Electron's.
    const cursor = () => {
      const p = ws?.pointer();
      if (!ws || !p) return screen.getCursorScreenPoint();
      const d = ws.toDipPoint(p);
      return { x: d.x, y: d.y, buttons: p.mask & 0x1f00 };
    };
    // A borrow still running hands back first (see the input's will-quit below): whether the window the keyboard goes
    // back to is still on screen is asked of the window system, which lists no windows once closed.
    app.on("will-quit", () => { borrowRef?.stopForQuit(); ws?.close(); });
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
      handle.setCompact(overlay?.isHidden() ?? false);
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

    // Ember's shortcuts, each by its default chord or else its fallback (D-45b). What another app holds is reported
    // (setup check, greeting); a shortcut held by neither chord is tried again every minute.
    let lastAskPress = 0;
    const shortcuts: Record<"ask" | "stop" | "settings" | "mute", () => void> = {
      settings: showHomeFromKeys,
      // A callback is not a press: X11 reports the shortcut again when its grab ends, after the keyboard buffer lets
      // go (the box then opened on a Backspace or a click). Only a real, fresh chord opens it. Elsewhere a callback is
      // one press (trusted, debounced).
      ask: () => {
        const now = Date.now(), chord = platform.shortcutsReReported ? ws?.keysDown() ?? null : null;
        if (!freshAskPress(chord, now, lastAskPress)) {
          log.info("ask.hotkey_ignored", { at: now - lastAskPress, chord });
          return;
        }
        lastAskPress = now;
        openAsk();
      },
      stop: () => stopEverything("hotkey"), mute: () => toggleMute(),
    };
    const registerShortcuts = () => {
      const { taken, missing } = holdShortcuts(ALWAYS_HELD, sc, fb, {
        isRegistered: accel => globalShortcut.isRegistered(accel),
        register: (id, accel) => globalShortcut.register(accel, shortcuts[id as keyof typeof shortcuts]),
      });
      const changed = JSON.stringify(taken) !== JSON.stringify(shortcutsTaken ?? []);
      // Any default taken is said (CI's Windows run forbids it: nothing else holds them there), with what Ember holds instead.
      if (taken.length && changed) log.warn("shortcut.unavailable", { taken, fallback: ALWAYS_HELD.filter(id => taken.includes(sc[id].accel) && !missing.includes(id)), missing });
      shortcutsTaken = taken;
      return missing;
    };
    if (registerShortcuts().length) {
      const retry = setInterval(() => { if (!registerShortcuts().length) clearInterval(retry); }, 60_000);
      retry.unref?.();
    }
    // Ask Ember in the OS's launcher, whatever another app holds (D-45b): the jump list (Windows) starts Ember with --ask,
    // the Dock menu (macOS) opens the box here; Linux's is its desktop entry's action (packaging/ember.desktop). Each is
    // logged once set (the smoke test requires it on its OS).
    try {
      if (platform.os === "win32") log.info("launcher.tasks", { ok: app.setUserTasks(jumpListTasks({ execPath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged })) });
      if (platform.os === "darwin" && app.dock) { app.dock.setMenu(Menu.buildFromTemplate(dockMenuItems(() => openAsk({ source: "launcher" })))); log.info("launcher.dock", {}); }
    } catch (err) {
      log.warn("launcher.tasks_failed", { err });
    }

    // Connect the brain. EMBER_TEST_PROVIDER_URL points it at an offline OpenAI-compatible server (tests, demos).
    // On macOS the saved sign-in is opened and sealed asynchronously: the keychain prompt after an update holds no main thread.
    tokens = new TokenStore(path.join(userData, "github-token.bin"), safeStorage, { version: app.getVersion(), asyncKeyring: platform.os === "darwin" });
    // The administrator can point Ember at the organisation's own endpoint (BYOK) instead of Copilot sign-in; it always
    // wins over the user's own provider (providerNow).
    let adminKey: string | undefined;
    try { adminKey = policy.provider ? sys.adminPolicy.providerApiKey(policy.provider) : undefined; } catch (err) { log.error("admin_policy.api_key_unreadable", { err }); }
    const testProvider = devEnv("EMBER_TEST_PROVIDER_URL");
    fixedProvider = testProvider
      ? { kind: "test", config: { type: "openai" as const, baseUrl: testProvider, apiKey: "test" }, keyId: "test-provider" }
      : policy.provider
        ? { kind: "admin", config: { type: policy.provider.type, baseUrl: policy.provider.baseUrl, apiKey: adminKey, wireApi: policy.provider.wireApi, azure: policy.provider.azure } }
        : null;
    const provider = fixedProvider;
    const runtime = locateRuntime({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, env: app.isPackaged ? {} : process.env, runtimeId: sys.paths.runtimeId, exe: sys.paths.runtimeExe });
    if (!runtime.exists) log.error("agent.runtime_missing", { path: runtime.path });
    // Perception: the accessibility sidecar (text) and the window system's capture (images). Linux starts the Python
    // AT-SPI sidecar (no launch); Windows and macOS the shared host (Windows: Ember's own binary in node mode; macOS: a
    // utility process, review #177).
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
    wsSeenRef = wsSeen;
    // The host's status for the setup checks (why it couldn't start, PowerShell's language mode), asked after the cold
    // start (and later still at login, so the probe stays out of the way of everything else starting). On Windows,
    // whose Screen reading row reads it, again on Check again and when reads find the helper can't work while the row
    // says it does, or the reverse (reliability-performance-c4-1): every request's outcome is told to the watch.
    // macOS's row reads the Accessibility permission live, and there shell_overlays works without it while reads fail
    // for it, so a watch would ask the host on every read for an answer nothing shows: it asks once, as before
    // (reliability-performance-v5-2).
    if (launch) {
      const ask = () => sidecar.status().then(st => { helper = toHelperStatus(st); }, err => { helper = helperStatusOfError(err); });
      const watch = helperWatch = platform.os === "win32" ? new HelperWatch({ ask, row: () => helper, waitMs: HELPER_RECHECK_MS }) : null;
      if (watch) {
        const request = sidecar.request.bind(sidecar);
        sidecar.request = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> =>
          request<T>(method, params, timeoutMs).then(v => { watch.saw(method, null); return v; }, (err: unknown) => { watch.saw(method, err); throw err; });
      }
      setTimeout(() => void (watch ? watch.again() : ask()), atLogin ? 60_000 : 10_000).unref();
    }
    // The first screenshot with Ember's marks on a fresh Windows or macOS machine doesn't pay fontconfig's cache build:
    // sharp's text is drawn once in the background, later at login (text-warm.ts).
    scheduleTextWarm({
      os: platform.os, argv: process.argv, marker: path.join(userData, "text-warmed"), key: app.getVersion(),
      delayMs: atLogin ? 60_000 : TEXT_WARM_DELAY_MS, draw: warmText, log: log.child("perception"),
    });
    perception = new Perception({
      sidecar: seenBy, x11: wsSeen, log: log.child("perception"),
      neverLook: () => settings.get().privacy.neverLook,
      // Every display in the window system's units; Electron's displays (X11's arithmetic) when none opened.
      screenBounds: () => (ws ? ws.screenBounds() : primaryScaledUnion(screen)),
      words: sys.words,
      isSecurityWindow: privacy.isSecurityWindow,
      // Linux: a pinentry, ssh-askpass or polkit agent's window, focused or not, stops all reading (safety-privacy-3).
      isPromptWindow: sys.privacy.isPromptWindow,
      // Remote desktops' and WSLg apps' windows are blacked out of every screenshot (Windows only; undefined elsewhere).
      isRemoteSurface: remoteSurfaceCheck(platform.os),
      os: platform.os,
      // macOS refused Ember the screen (no Screen Recording): Ember says so once a run, with the way to the setting
      // (the setup check's row: only the settings window applies a fix).
      onNoScreenAccess: () => {
        if (!sys.fixes.ids.includes("open-screen-recording-settings")) return;
        const bubble = { ...IDLE_BUBBLE, visible: true, mood: "attention" as const, title: "I can't take screenshots",
          thought: "I don't have macOS's Screen Recording permission. Open the setup check to allow it, then quit and reopen me.",
          actions: [{ id: "ui:setup-check", label: "Open setup check" }] };
        // It comes mid-task: main holds the bubble so the task's progress doesn't replace it before it is read (15 s,
        // ten times that with More time to read and answer), then lets go (the task's progress comes back, or it hides).
        const time = 15000 * readTime();
        agent?.claimBubble({ ms: time });
        setState({ bubble });
        setTimeout(() => {
          if (lastState.bubble === bubble && !(agent?.releaseBubble(bubble) ?? false)) setState({ emotion: "neutral", bubble: IDLE_BUBBLE });
        }, time);
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
    audit = new AuditLog(path.join(userData, "audit"), undefined, sys.auditSink(err => log.warn("audit.journal_failed", { err })),
      err => log.warn("audit.write_failed", { err }));
    // Work without asking as the log opens: turned off before now, and on as found in settings.json at start (by hand, or
    // from the last run): recorded, or else turned off (fail closed).
    for (const e of autonomyBeforeAudit.splice(0)) { try { audit.write({ event: "autonomy", ...e }); } catch (err) { log.warn("autonomy.audit_failed", { err }); } }
    if (autonomyWasOn) {
      try { audit.write({ event: "autonomy", on: true, via: "file", verified: false, atStart: true }); } catch (err) {
        log.warn("autonomy.audit_failed", { err });
        settings.update({ autonomy: { ...settings.get().autonomy, on: false } });
      }
    }
    // Nothing is pruned while the policy can't be used: its retention can't be read then.
    const keepDays = auditRetentionDays(admin);
    try { if (keepDays !== null) audit.prune(keepDays); } catch (err) { log.warn("audit.prune_failed", { err }); }
    // And once a day: an Ember that runs for weeks keeps nothing past the retention (review #86). It reads the policy
    // in force each day, so nothing is pruned once a changed policy holds Ember locked down (review #106).
    audit.pruneDaily(() => auditRetentionDays(admin), err => log.warn("audit.prune_failed", { err }));
    confirmer = new Confirmer(showState, {
      // A question waits 2 minutes for an answer, 20 with more time to read and answer; its answer, and the note that it
      // ran out of time, stay ten times as long too (tasks-approvals-4).
      timeoutMs: () => 120_000 * readTime(),
      answerMs: () => ANSWER_MS * readTime(),
      expiredMs: () => EXPIRED_MS * readTime(),
      // A click while Ember drives the mouse was Ember's own: never an answer (waiting for the user to let go is fine).
      // Where posted keys arrive late (macOS), neither is a chord within 500 ms of a key Ember posted itself.
      blocked: () => (borrowRef?.driving ?? false) || (inputRef?.pointerLags === true && Date.now() - (borrowRef?.lastSyntheticKeyAt ?? 0) < 500),
      onChange: questionChanged,
      keyHint: questionKeyHint,
      // Until a question's whole text has all been shown, the approve key shows its next part (review #116).
      readKeyHint: () => { holdQuestionKeys(); return readKeyWords(heldKeys()).map(k => k.hint).join(" · ") || undefined; },
      // A question shown in a window of Ember's own (a command, a consent card): the keys allow it only while that window
      // shows all of it (R7).
      panelReady: n => targets?.panelReady(n) ?? false,
      // And how to reach that window from the keyboard (the bubble's buttons are mouse-only).
      panelHint: p => targets?.panelHint(p),
      // An answer nobody replaces (a task in the corner ends on its card) goes after its moment, or what the question
      // covered shows again: never "Thanks! Carrying on." for good after the task is done.
      afterAnswer: answerSettler({ onScreen: () => lastState.bubble, reshow: () => agent?.afterAnswer() ?? false, set: setState }),
    });
    // Linux warns xtest.unavailable when XTest is missing.
    const xinput = inputRef = platform.openInput(ws, log);
    // A borrow still running lets go at once (keys up, pointer home, the keyboard back) before the connection closes:
    // the window system's will-quit above already did (it runs first), so this one only finds it stopped.
    app.on("will-quit", () => { borrowRef?.stopForQuit(); xinput?.close(); });
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
    // Nothing is borrowed while this computer's screen is locked, whatever the input's own check sees (review #81).
    const borrow: CursorBorrow | null = xinput && policy.features.cursor !== false ? new CursorBorrow(lockAwareInput(xinput, () => screenLock?.locked ?? false), {
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
      // Its bar grows with the text size (review #57).
      textScale: () => textScale(settings.get().textSize),
      canRead: () => hasConsent(settings.get()) && screenLock?.locked === false,
    });
    deskViewRef = deskView;
    let deskPlace: Promise<DeskPlace> | null = null;
    // A desk whose display died is gone: the next desk task starts a new one.
    deskManager?.onDead(() => { deskPlace = null; });
    app.on("will-quit", () => { void deskPlace?.then(p => p.close()).catch(() => undefined); deskManager?.stop(); });
    // Built whenever a window system opened: reading apps (tier 1) needs no input backend. They refuse this screen while
    // it's locked (review #81).
    const hands: Hands | undefined = wsSeen ? lockedOutHands({
      perception, sidecar: seenBy, audit, confirmer,
      policy: new PolicyEngine({
        neverLook: () => settings.get().privacy.neverLook, grants: () => settings.get().grants,
        rateLimit: policy.maxActionsPerMinute,
        actionsAllowed: () => policy.features.actions !== false,
        confirmEveryAction: () => policy.confirmEveryAction,
        allowGrants: () => policy.allowGrants,
        trustAskedApps: () => settings.get().trust.askedApps,
        // "Work without asking" (policy/autonomy.ts): only with its card agreed to and where the organisation allows it.
        autonomy: () => autonomyInForce(settings.get().autonomy, policy),
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
    }, () => screenLock?.locked ?? false) : undefined;
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
      // The user's own model provider's host while it is in force: the consent cards say what is read goes there.
      ownService: () => { const p = providerNow(); return p?.kind === "user" ? endpointHost(p.config.baseUrl) : null; },
      localHands: hands ?? null, showState: setState, notify,
      // "computers:host": the section, then the control there to focus (the settings page reads it).
      openSettings: (section, focus) => { showHome(); if (section) sendToHome(IPC.focusSection, focus ? `${section}:${focus}` : section); },
      ipc,
      // As the settings channels' guard: the settings window's own page only (critique integration-5).
      isHome: sender => !!home && !home.isDestroyed() && sender.id === home.webContents.id && isTrustedSender(home.webContents.getURL()),
      windows: {
        command: () => keepClear("command", createCommandWindow(platform.os)),
        // The prompt window takes the keyboard as settings does, and its field the keys (an SSH password is typed into
        // it; review #235): macOS activates Ember, Windows asks the input backend (foreground rules).
        prompt: () => keepClear("prompt", createPromptWindow(platform.os, {
          takeKeyboard: win => {
            bringToFront(win);
            if (!sys.lifecycle.activateOwnWithInput) return;
            const id = ownId(win);
            try { if (id) inputRef?.focusInput?.(id); } catch { /* best effort, as bringToFront's activation */ }
          },
        })),
      },
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
      stopTasksOn: (target, only, why) => { agent?.cancelTasksOn(target, only, why); },
      // Its bubbles go through the shared bubble, once the agent exists (the conversation's and the tasks' wait behind them).
      bubbles: () => agent?.notices ?? null,
      // Its offers on a board of their own: one nobody asked for waits behind a held Lost or "Can't connect" (cross-review X3).
      offers: () => agent?.offers ?? null,
      // Its bubbles' keyboard route names the settings shortcut only while Ember holds it, and its command window's
      // announcement the stop chord (cross-review X0).
      settingsKey: () => keyName("settings"),
      stopKey: () => keyName("stop"),
    });
    // Commands still running and connections are let go of when Ember quits.
    app.on("will-quit", () => { void targets?.dispose(); });
    // The saved copy of the conversation, only while the person keeps it (Home › Conversation); off by default.
    const history = { store: new HistoryStore({ dir: userData, log: log.child("history"), onProblem: p => { if (home && !home.isDestroyed()) home.webContents.send(IPC.historyProblemChanged, p); } }), enabled: () => settings.get().keepConversation };
    historyStore = history.store;
    let keptConversation = history.enabled();
    settings.onChange(() => {
      if (history.enabled() === keptConversation) return;
      keptConversation = history.enabled();
      agent?.applyHistorySetting();
    });
    agent = new AgentHost({
      history,
      // Always given, so sign-out and an account change forget them even while the organisation has them off (the host
      // uses them only while settings, with the policy applied, have them on). Memory learns on its own (hostMemory).
      memory: hostMemory,
      routines: routineBook,
      extensions,
      // Ember's two bodies: tasks work in the corner, on their cards; the cursor's bubble is the conversation's.
      cornerTasks: true,
      // Their views go to the overlay apart from the state (coalesced diffs, none while Ember is hidden).
      showView: (id, view) => overlay?.setView(id, view),
      readTime,
      taskWindow: createTaskWindowControl({
        list: () => shownWindows().filter(w => w.pid !== process.pid),
        blocked: () => !inputRef || !!screenLock?.locked || !!borrowRef?.driving,
        activate: id => inputRef?.activate(id),
      }),
      // A card kept to be read (an unanswered question's Try again) waits for a user who is away (tasks-approvals-4).
      userAway,
      // The bubble keeps its width while the text size grows its type: Read all counts the lines at that size (cross-review X2).
      textScale: () => textScale(settings.get().textSize),
      userData, runtimePath: runtime.path, settings, log: redactingLogger(log, () => providers.secrets()).child("agent"), setState, provider: providerNow, probeProvider: () => providers.api.test(), admin: () => policy, signInWith: signInWith(),
      // A policy that can't be used: no model service at all, GitHub Copilot included (it may require its own endpoint).
      refuseConnect: () => modelServiceRefusal(admin), policyHeld: () => !!admin.held,
      // Not while this screen is locked: a turn still running then would read it for the model (cross-review X9).
      describeScreen: () => seeing.describe(), screenLocked: () => screenLock?.locked ?? false, hands,
      // The keyring refused Ember's saved sign-in (macOS's keychain prompt after an update answered Deny): said so.
      signedOutWhy: () => (tokens?.unreadable ? sys.words.savedSignInRefused ?? null : null),
      // Signed out while the user's own provider waits for its card: agreeing is the way on (integrations-r3-1).
      providerWaiting: () => (fixedProvider ? null : providerWaitingHost(settings.get(), admin)),
      // Spoken without code or full addresses ("code shown in the bubble"), which nobody wants read out, sentence by
      // sentence as the answer streams in: Ember starts talking while Copilot is still writing, as a voice assistant does.
      onTurnStart: turn => {
        voice?.cancelListenOnce();
        resetAnswerSpeech();
        // A typed request isn't warmed by a wake: its voice loads now, while Copilot starts (voice-speaking-1).
        if (maySpeak()) voice?.warmSpeech();
        askedAt = Date.now();
        answerInterrupted = false;
        // A request typed in another language: its answer's short first words are said in that language (voice-speaking-11).
        answerLanguage.reset(turn.text);
        lastAskByVoice = turn.spoken && !turn.manual;
        if (turn.spoken) ackLater(turn.text);
        syncListenOnce();
      },
      onAnswerInterrupted: resetAnswerSpeech,
      onAnswerDelta: delta => { if (answerInterrupted || confirmer?.waiting) return; cancelAck(); turnLatency.mark("firstToken"); sayStreamed(answerSpeech.push(delta)); },
      // An answer whose voice Stop speaking silenced is still the answer, unsaid (voice-speaking-c1-1).
      onAnswerEnd: text => { if ((answerInterrupted && !answerHushed) || confirmer?.waiting) return; cancelAck(); lastReply = text; if (!answerHushed) sayStreamed(answerSpeech.finish(text), true, true); },
      onAnswer: text => { if ((answerInterrupted && !answerHushed) || confirmer?.waiting) return; cancelAck(); turnAnswer = text; lastReply = text; if (!answerHushed) sayStreamed(answerSpeech.finish(text), true); },
      // A spoken request gets a short follow-up window: no need to say "Hey Ember" again.
      onTurnEnd: aborted => {
        aborted ||= (answerInterrupted && !answerHushed) || !!confirmer?.waiting;
        cancelAck();
        // Nothing will be heard of a turn that was stopped, or not spoken: it is logged as it stands.
        if (aborted || !answerSpoken) turnLatency.end();
        // What the user might say next (personal/predict.ts): chips under this answer, and a longer follow-up window
        // after a spoken reply when a follow-up is likely.
        const task = aborted ? null : agent?.tasks?.list().filter(t => t.started >= askedAt).at(-1);
        const next = aborted ? null : personal.answered(lastReply || turnAnswer, { spoken: answerSpoken, task: task ? { status: task.status === "cancelled" ? "stopped" : task.status === "queued" ? "running" : task.status } : null });
        if (next?.suggestions.length && lastState.bubble.visible) showState({ suggest: { thought: lastState.bubble.thought, items: next.suggestions.map(s => s.text) } });
        lastReply = "";
        answerSpeech.reset();
        answerLanguage.reset();
        answerSpoken = false;
        ackSaid = null;
        if (lastAskByVoice && !aborted) voice?.followUp(next?.followUpMs ?? 8000, { afterQuestion: endsWithQuestion(turnAnswer) });
        lastAskByVoice = false;
        turnAnswer = "";
        answerInterrupted = true;
        answerHushed = false;
        syncListenOnce();
      },
      onStatus: status => {
        // Projects' work goes only where it must (integrations-r1): a reconnect stops a request under way, but keeps the
        // files, the request, the answer and its diff; the lockdown forgets it all (Sign out and an account change do
        // where they happen: integrations-c2-1); another service or account, only the previous answer as context.
        // Apply patch's confirmation sends nothing, so a reconnect try leaves it up (integrations-v4-2).
        if (projectJob && projectJobStops(projectLocalJobs.has(projectJob) ? "local" : "send", status.phase)) projectJob.abort();
        const forget = projectAfterStatus(status, projectExchange ? { scope: projectExchangeScope } : null, status.phase === "ready" ? agent?.projectWorkspaceScope() ?? null : null);
        if (forget !== "keep") forgetProject(forget);
        // Copilot refused the sign-in in use (at a start, or mid-session): Check again passes over it to the next one.
        // Ember's own that ran out unnoticed (the computer slept) is renewed and reconnected instead (cross-review X12).
        if (status.phase === "error" && status.reason === "sign-in" && currentToken) { refusedTokens.add(currentToken); keeper.refused(currentToken); }
        broadcast(IPC.agentStatusChanged, status);
        // The handle says why Ember can't answer yet, instead of "Ready" (in a few words: the pill is narrow).
        // Ready with a setup row holding Ember back: "Setup needed" (review #95).
        showState({ idle: idleNow(status), setup: setupNow(status) });
        // An open Ask box says it too, as it changes (companion-6).
        askWindow.setUnavailable(unansweredWord(status) ?? undefined);
      },
      // Home's conversation shows the answer as it develops (the same words as the bubble's).
      onAnswerStream: e => broadcast(IPC.conversationStream, e),
      // And whether the conversation is answering (home-c1-1): its composer's wait ends when the turn does, and says so
      // when a Stop ended it (home-c2-2).
      onConversationTurn: (turn, ended) => sendToHome(IPC.conversationTurnChanged, ended ? { turn, ended } : { turn }),
      onTranscript: (entries, why) => {
        // Forgotten (sign-out, another account): the "Ember learned" lines go with it. A New conversation clears them
        // too, but isn't announced as a forgetting: Home that asked for it resets itself when the request is answered.
        if (!entries.length) {
          resetAnswerSpeech();
          learnedLines = [];
          if (why !== "new-conversation") broadcast(IPC.conversationForgotten, null);
        }
        broadcast(IPC.conversationChanged, conversationNow(entries));
      },
      // Another account signed in: its conversation went, and with it what the ask box remembers (as at sign-out).
      onAccountChanged: () => { askHistory = []; forgetProject("all"); },
      // A reminder the user set is due (reminders.ts): said too when replies are spoken, and a notification while away.
      onReminder: r => {
        // After what Ember is saying (an answer under way), not cutting it off.
        if (maySpeak() && !agent?.answerOpen && !manualCall && voice?.micState !== "active") voice?.speak(spokenText(`Reminder: ${r.text}`), { append: true });
        // A notification shows on the lock screen: while it is locked, it says only that one is due.
        if (userAway()) notify("Ember: reminder", reminderNotification(r, screenLock?.locked ?? false));
      },
      onRemindersChanged: rows => broadcast(IPC.remindersChanged, reminderRows(rows)),
      // The voice's side of "Ember, systems check": listening off counts as off, whatever the microphone was doing.
      health: () => ({ mic: settings.get().wakeWord && voice ? voice.micState : "off", speaks: maySpeak() }),
      // "Work without asking" by voice (autonomy-intent.ts): turned on with all four scopes, its card opened in Settings.
      voiceTrust,
      autonomy: {
        state: () => ({ on: settings.get().autonomy.on && autonomyConsented(settings.get().autonomy), consented: autonomyConsented(settings.get().autonomy), managed: !autonomyAllowed(policy) }),
        // True once it is as asked and recorded (a turn on whose audit entry can't be written is undone: say so, not "Okay").
        set: (on, how) => {
          autonomyChangedBy = how;
          const a = settings.get().autonomy;
          try { settings.update({ autonomy: { ...a, on, ...(on ? { scopes: { ...ALL_SCOPES } } : {}) } }); } finally { autonomyChangedBy = null; }
          return (autonomyInForce(settings.get().autonomy, policy) !== null) === on;
        },
        open: consent => { showHome(); sendToHome(IPC.focusSection, consent ? "privacy:autonomy-yes" : "privacy:autonomy-on"); },
      },
      // A typed "stop" while a task is at work: the kill switch, as "Ember, stop" is (tasks-approvals-v2).
      stopEverything: () => stopEverything("typed"),
      onTaskFinished: t => {
        // Read out unless the user asked for results on screen only ("Ember, just show me": speakResults).
        if (maySpeak() && settings.get().speakResults && !agent?.answerOpen && !manualCall && voice?.micState !== "active") voice?.speak(spokenText(t.text), { append: true });
        // (And one whose question went unanswered while they were away: it needed them, tasks-approvals-4.)
        const notice = taskNotice(t);
        if (userAway() && notice) notify(notice.title, notice.body);
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
      // Its cancel words: the kill phrase only where Ember can tell its own voice from the user's (owner decision V1).
      cancelWords: () => cancelWords({ killPhrase: voice?.rejectsSpeakers ?? false, stopKey: holding("stop")?.say ?? null }),
      // Its bubbles name the settings shortcut and the stop chord only while Ember holds them (cross-review X0, X5), by
      // the chord it holds: the fallback while another app holds the default (D-45b).
      settingsKey: () => keyName("settings"),
      stopKey: () => keyName("stop"),
    });
    // The network came back (or the computer woke): a connection waiting to retry tries now. (Electron's
    // main process has no online/offline event; a VPN coming up is covered by asking, which retries too.)
    let wasOnline = net.isOnline();
    const netWatch = setInterval(() => { const on = net.isOnline(); if (on !== wasOnline) { wasOnline = on; agent?.networkChanged(on); if (on) keeper.wake(); } }, 5000);
    netWatch.unref?.();
    // Timers stood still while the computer slept: its own sign-in may be due for renewal, or have run out (cross-review X12).
    powerMonitor.on("resume", () => { keeper.wake(); agent?.networkChanged(true); });
    powerMonitor.on("unlock-screen", () => keeper.wake());
    // The brain connects once the user has agreed to what Ember does (first run asks).
    let brainStarted = false;
    const startBrain = async () => {
      if (brainStarted || !consented()) return;
      brainStarted = true;
      const since = signOuts;
      // macOS asks for the login keychain password before Ember may read its saved sign-in (after every update of an
      // ad-hoc-signed Ember). The read is asynchronous there, and Ember's windows still come up first, with a status that
      // says what the prompt is for (review #241). Only on the first start of a new version: other starts read at once,
      // without the keychain words. The status lasts through both reads (renewing a sign-in that ran out reads it first).
      // The user's own provider's key, read once (the keychain may ask on macOS, as for the sign-in).
      // The user's own provider's key, read once it is needed (the keychain may ask on macOS): the status says what for.
      if (!provider && providers.needsRead()) {
        setStatus("keychain", "Reading your saved API key…");
        try { await providers.ensureKey(); } finally { setStatus("keychain", null); }
      }
      const keychain = !provider && platform.os === "darwin" && !!tokens?.firstReadSinceUpdate();
      if (keychain) {
        setStatus("keychain", "Reading your saved sign-in from the keychain…");
        await new Promise(r => setTimeout(r, KEYCHAIN_PAUSE_MS));
      }
      if (!provider) await keeper.freshen();
      const found = provider ? null : await resolveToken(tokens, process.env, ghOptions()).finally(() => { if (keychain) setStatus("keychain", null); });
      log.info("auth.token", { source: testProvider ? "test-provider" : provider ? "admin-provider" : found?.source ?? "none", ...(providerNow()?.kind === "user" ? { provider: "user" } : {}), ...(tokens?.unreadable ? { saved: "unreadable" } : {}) });
      // Found on its own (GitHub CLI, environment): not used after the user signed out of Ember
      // (then "Sign in" may use it at once, so it isn't counted as the token in use). One Copilot refuses gives way to
      // the next source. Signed out while it looked (the settings window is up during a keychain prompt or a slow
      // renewal): nothing found then is connected (final review S1).
      const { phase } = provider ? { phase: await agent?.start(null, undefined, "auto") } : await connectWith(found, "auto", since);
      if (phase === "signed-out") { currentToken = null; keeper.use(null); }
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
    // Native speech through sherpa-onnx's C API on Linux (resources/voice-native), WebAssembly where it can't run.
    const speech = nativeSpeech();
    availableNaturalModels = naturalVoiceChoices(sys.voice.naturalVoice && process.env.EMBER_VOICE_BACKEND !== "wasm", speech.choice?.backend === "native" && !!speech.capiDir);
    if (speech.choice) log.info("voice.backend", { backend: speech.choice.backend, why: speech.choice.why });
    voice = new VoiceService({
      log: log.child("voice"),
      // A process that dies loading it starts again on WebAssembly (voice.native_failed).
      ...(speech.choice?.backend === "native" && speech.capiDir ? { capiDir: speech.capiDir } : {}),
      // How Ember's voice is played (VoiceOptions.playback): a development switch until echo-check.mjs has measured it.
      ...(devEnv("EMBER_TTS_OUTPUT") === "element" ? { playback: "element" as const } : {}),
      ...(testMicWav ? { testMicWav: true } : {}),
      modelsRoot: speechModels.root,
      // Models that came with Ember are never changed: damaged, the user's own folder replaces them (review #254).
      ...(speechModels.bundled ? { bundled: { userRoot: speechModels.userRoot } } : {}),
      // Speaker rejection needs PulseAudio's monitor sources (Linux only); elsewhere the setting says so.
      monitor: settings.get().voice.speakerRejection && sys.voice.speakerMonitor,
      conversation: () => settings.get().voice.conversation,
      // A screen reader says Listen once's status lines through the speakers: the voice process leaves them out.
      screenReaderOn: () => sys.a11y.screenReaderOn(),
      // (EMBER_NO_OUTPUT_WATCH: a test that speaks through the speakers as the user would count as other sound. A fake
      // microphone's WAV is Chromium's fake loopback too, so it would.)
      outputLevel: sys.voice.outputLevel && !testMicWav && !devEnv("EMBER_NO_OUTPUT_WATCH"),
      // Where the system that refused it lets the user allow it (the setup check has a button for it). Named without
      // a menu path: it differs between Windows 10 ("Privacy"), Windows 11 and macOS ("Privacy & Security").
      micHint: sys.fixes.ids.includes("open-microphone-settings") ? `To allow it, open the microphone's privacy settings in ${sys.words.settingsApp}.` : undefined,
      onEvent: onVoice,
      onListenOnce: syncListenOnce,
      onSelfSpeaking: on => { if (on) turnLatency.mark("firstAudio"); },
      // The level for Ember's presence ring and voice meter: straight to the overlay, never through the state.
      onLevel: l => {
        overlay?.setLevel(l);
        if (homeWantsLevel && l.mic !== undefined && home && !home.isDestroyed() && home.isVisible() && !home.isMinimized()) home.webContents.send(IPC.homeLevel, l.mic);
      },
      // Replies in Ember's own neural voice once its model is in (it downloads with the speech models).
      neuralVoice: true,
      // Kitten is the baseline neural voice. Explicit optional Kokoro retains its existing platform capability.
      naturalVoice: naturalVoiceOn(settings.get()),
      naturalModel: settings.get().voice.naturalModel,
      naturalSupported: availableNaturalModels.includes("kokoro"),
      rate: settings.get().voice.rate,
      // Whatever became of turning it on shows under its switch (never only in the log).
      onNatural: () => broadcast(IPC.voiceStatus, voiceStatus(voiceDetail)),
      voiceprint: ownerPrint,
      // Voice Match keeps learning (app/voice/adapt.ts): only while it is on, and the setting allows. What it learnt
      // goes with the voiceprint: the gate then checks the enrolment too, at the learnt print's threshold.
      learning: () => settings.get().voice.learn && !!ownerPrint(),
      matchLearnt: () => {
        const st = voiceprints.state();
        return st && st.clips.length ? { anchor: encodePrint(st.anchor), clips: st.clips.length } : null;
      },
      onSample: s => {
        // Paired by the utterance's number, never "the latest one heard": a later request, a dropped one or a spoken answer
        // (lastHeard cleared) leaves it unpaired, and an unpaired sample teaches nothing.
        const r = lastHeard && lastHeard.utterance === s.utterance ? lastHeard : null;
        lastHeard = null;
        const print = personal.sample(s, r ? { verified: r.verified, cut: r.cut, selfSpoke: r.selfSpoke, locked: confirmer?.voiceLocked ?? false } : null);
        if (print && settings.get().voice.match) { voice?.setVoiceprint(print, true); broadcast(IPC.voiceStatus, voiceStatus(voiceDetail)); }
      },
      onEnrol: p => {
        if (p.state === "done") {
          try {
            voiceprints.write(p.print);
            // Taught again: trust granted against the old voiceprint ends with it.
            voiceTrust.endAll("voice-changed");
            settings.update({ voice: { ...settings.get().voice, match: true } });
            voice?.setVoiceprint(p.print);
            log.info("voice.match_enrolled", { phrases: p.got });
            enrolEnded = "learnt";
          } catch (err) { log.warn("voice.match_not_saved", { err }); }
          enrolling = null;
        } else if (p.state === "cancelled") {
          // Said in settings: given up, timed out, stopped or cut short, never taken for the voice learnt (voice-listening-5).
          if (enrolling) enrolEnded = p.why === "timeout" || p.why === "stopped" || p.why === "gave-up" || p.why === "interrupted" ? p.why : "cancelled";
          if (p.why) log.info("voice.match_not_enrolled", { why: p.why, phrases: p.got });
          enrolling = null;
        } else {
          enrolling = { got: p.got, of: p.of, phrase: ENROL_PHRASES[Math.min(p.got, ENROL_PHRASES.length - 1)], ...(p.state === "again" && p.why ? { again: p.why as "short" | "unlike" | "failed" | "over" } : {}) };
        }
        broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
      },
      onModels: () => broadcast(IPC.voiceStatus, voiceStatus(voiceDetail)),
      onSpeech: ok => {
        if (speechHeard === ok) return;
        speechHeard = ok;
        log.info("voice.speech", { ok });
        broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
      },
      onState: (state, detail) => {
        voiceDetail = detail;
        setState({ mic: state, micLearning: !!voice?.isEnrolling });
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
        syncListenOnce();
      },
    });
    // Before anything starts listening, so the voice process loads the clearer recognizer the first time.
    voice.setClearHearing(settings.get().voice.clearHearing);
    if (settings.get().voice.muted) voice.setMuted(true);
    const wantVoice = () => policy.features.voice !== false && settings.get().wakeWord && settings.get().voice.consent && consented();
    void voice.setWanted(wantVoice());
    let wanted = wantVoice();
    let micConsent = settings.get().voice.consent;
    // Voice Match turned on or off in settings: the voice process checks requests from now on, or doesn't.
    let matchOn = settings.get().voice.match;
    settings.onChange(next => {
      if (next.voice.match === matchOn) return;
      matchOn = next.voice.match;
      // Voice Match turned off and on again is no continuous recognition of the owner: trust starts over.
      voiceTrust.endAll("voice-changed");
      voice?.setVoiceprint(ownerPrint());
      broadcast(IPC.voiceStatus, voiceStatus(voiceDetail));
    });
    // Keep learning my voice turned on or off (or Voice Match with it): the voice process offers samples, or stops.
    let learning = settings.get().voice.learn && !!ownerPrint();
    settings.onChange(next => {
      const on = next.voice.learn && next.voice.match && voiceprints.read() !== null;
      if (on === learning) return;
      learning = on;
      voice?.setLearning(on);
    });
    settings.onChange(next => applyNaturalVoicePreference(voice, next.voice));
    settings.onChange(() => silenceIfOff());
    settings.onChange(next => voice?.setRate(next.voice.rate));
    settings.onChange(next => voice?.setClearHearing(next.voice.clearHearing));
    let conversations = settings.get().voice.conversation;
    settings.onChange(next => {
      if (next.voice.conversation === conversations) return;
      conversations = next.voice.conversation;
      voice?.setConversation(conversations);
    });
    settings.onChange(next => {
      // macOS asks for the microphone once listening is agreed to, so its prompt comes with that context.
      if (next.voice.consent && !micConsent) sys.lifecycle.askMicrophone?.().catch(err => log.warn("voice.mic_ask_failed", { err }));
      micConsent = next.voice.consent;
      if (wantVoice() !== wanted) { wanted = wantVoice(); void voice?.setWanted(wanted); }
      if (!consented()) voice?.cancelListenOnce();
      syncListenOnce();
    });
    powerMonitor.on("suspend", () => voice?.cancelListenOnce());
    app.on("will-quit", () => voice?.stop());

    // The administrator's policy changed while Ember ran: everything stops, and Ember holds itself locked down (no
    // actions, commands, listening or model service) until the user restarts it, which reads the new policy whole.
    const unwatchPolicy = watchAdminPolicy({
      first: admin,
      read: () => sys.adminPolicy.load(devEnv("EMBER_ADMIN_POLICY")),
      onChange: next => {
        log.warn("admin_policy.changed", { file: next.source, error: next.error ?? null, note: "held locked down until Ember restarts" });
        admin = heldUntilRestart(next);
        policy = admin.policy;
        // An open settings window says so at once, as a fresh one would (safety-privacy-w5-1).
        sendToHome(IPC.adminChanged, homeAdmin(admin));
        wanted = false;
        void voice?.setWanted(false);
        // The connection goes too: the host's refuseConnect now says why, so nothing reconnects until the restart.
        void agent?.start(null);
        void killSwitch.pull("policy").then(() => {
          const bubble = { ...IDLE_BUBBLE, visible: true, mood: "attention" as const, title: "Your organisation changed my policy",
            thought: "I've stopped everything, and I won't act, listen or answer until you restart me.", actions: [{ id: "ui:restart", label: "Restart Ember" }] };
          statusBy.listen = statusBy.mic = null;
          setState({ emotion: "neutral", talking: false, status: statusBy.borrow, bubble });
        });
      },
    });

    // ───── Screen lock (review #81) ─────
    // While this computer's screen is locked, or its session isn't the one in front, whoever is there isn't the user:
    // Ember stops listening and speaking, takes no requests, its hands refuse this screen, and the tasks working on its
    // desktop stop, as on a remote computer whose screen locks. What stopped is said once the user is back.
    const lockControl = new LockController({
      stopDesktopTasks: () => agent?.cancelTasksOn("local", "desktop") ?? 0,
      setLocked: locked => { if (locked) projectJob?.abort(); voice?.setLocked(locked); },
      showNotice: n => showNotice(n, 8000),
    });
    screenLock = new ScreenLock({
      events: powerMonitor,
      // Linux: logind, watched (Electron's own reading can't see GNOME's lock shield there); elsewhere Electron's.
      ...(platform.os === "linux"
        ? logindLock({ sessionId: process.env.XDG_SESSION_ID, uid: process.getuid?.() ?? -1, log: log.child("screen") })
        : { initial: () => powerMonitor.getSystemIdleState(1) === "locked" }),
      onChange: locked => { log.info("screen.lock", { locked }); lockControl.change(locked); },
    });
    screenLock.start();
    if (screenLock.locked) lockControl.change(true);
    // One listener for the policy watch and the screen lock, in that order: an 11th will-quit listener warns of a leak.
    app.on("will-quit", () => { unwatchPolicy(); screenLock?.stop(); lockControl.dispose(); });

    // Started by the user (the launcher, a terminal) once set up, Ember greets, and settings opens only while a setup
    // row needs them; by a launcher's Ask Ember (--ask), the ask box; started at login (--autostart), Ember only greets,
    // unless the desktop session is one Ember can't use (a Wayland login after an Xorg one): then the check is shown.
    const view = startView({ onboarded: settings.get().onboarded, showSettings: process.argv.includes("--show-settings"), atLogin, sessionProblem: !!sessionGreeting(env), ask: wantsAsk(process.argv),
      setupNeeded: env.checks.some(needsUser) });
    if (view === "ask") openAsk({ source: "launcher" });
    else if (view === "settings") showHome();
    // The hello waits for Copilot to connect (at most a few seconds), so it doesn't say "not connected" too early.
    else setTimeout(() => void Promise.race([brainStart, new Promise(r => setTimeout(r, 5000))]).then(() => greet()), 800);
    // macOS: opening Ember.app again (Dock, Finder) reactivates this one instead of starting a second, so settings
    // opens. Listened for only from here: Electron documents "activate" for a first launch too, and at login that would
    // open settings over the decision just made.
    if (sys.lifecycle.reopenShowsSettings) app.on("activate", () => showHomeFromKeys());

    // Development: what each process costs (private bytes on Windows), with each renderer named after its page, every
    // EMBER_MEMORY_LOG seconds (memory-report.ts).
    const memoryEvery = Number(devEnv("EMBER_MEMORY_LOG") ?? "");
    if (memoryEvery > 0) {
      setInterval(() => {
        const pages = webContents.getAllWebContents().map(wc => ({ pid: wc.getOSProcessId(), url: wc.getURL(), title: BrowserWindow.fromWebContents(wc)?.getTitle() ?? "" }));
        log.info("memory.report", memoryReport(app.getAppMetrics(), pages));
      }, memoryEvery * 1000).unref();
    }

    if (devEnv("EMBER_TEST_HOOKS") === "1") {
      (globalThis as Record<string, unknown>).__ember = {
        settings, setState, greet, showHome, showHomeFromKeys, overlay: () => overlay, handle: () => handle,
        agent: () => agent, perception: () => perception, confirmer: () => confirmer, voice: () => voice, deskView: () => deskView, ask: (text: string, how?: { heardId?: number }) => { captureContext(); return askEmber(text, how?.heardId ? { heardId: how.heardId } : {}); }, showAsk: () => openAsk({ source: "test" }),
        showMenu, state: () => lastState, extensions: () => extensionsRef, stopEverything, personal: () => personalRef,
      };
    }
  };
}
