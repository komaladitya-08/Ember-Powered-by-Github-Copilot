/**
 * Fakes shared by the macOS system tests: Electron's parts as plain objects (each call recorded), a scripted Run for
 * Apple's command-line tools, and a fake darwin window system with the extras the permission reads use. Not a test
 * file itself (no .test.ts), so vitest only runs it through the files that import it.
 */

import { vi } from "vitest";
import type { ElectronParts, LoginItemSettingsLike, PlatformDeps, WindowSystem } from "../../app/main/platform/types";
import type { Run, RunOptions, RunResult } from "../../app/main/platform/darwin/system/exec";

/** One call to the fake Run. */
export interface RunCall { file: string; args: string[]; o?: RunOptions }

/** A Run that answers from `script` (first matching rule wins) and records every call. Unmatched: ENOENT. */
export function fakeRun(script: { match: (file: string, args: string[]) => boolean; result: Partial<RunResult> | (() => Partial<RunResult>) }[] = []) {
  const calls: RunCall[] = [];
  const run: Run = async (file, args, o) => {
    calls.push({ file, args: [...args], ...(o ? { o } : {}) });
    const rule = script.find(r => r.match(file, [...args]));
    if (!rule) return { code: null, stdout: "", stderr: "", failure: "ENOENT" };
    const r = typeof rule.result === "function" ? rule.result() : rule.result;
    return { code: 0, stdout: "", stderr: "", ...r };
  };
  return { run, calls };
}

/** A tool by its file and first argument. */
export const tool = (file: string, first?: string) => (f: string, args: string[]) => f === file && (first === undefined || args[0] === first);

/** Electron's parts as recording fakes; `overrides` replaces any member. */
export function fakeElectron(overrides: { app?: Partial<ElectronParts["app"]>; systemPreferences?: Partial<ElectronParts["systemPreferences"]>; login?: LoginItemSettingsLike } = {}) {
  let login: LoginItemSettingsLike = overrides.login ?? { openAtLogin: false, status: "not-registered", wasOpenedAtLogin: false };
  const app = {
    isPackaged: true,
    getPath: vi.fn((_n: string): string => { throw new Error("app.getPath called"); }),
    getAppPath: () => "/Applications/Ember.app/Contents/Resources/app",
    getVersion: () => "0.1.0",
    isAccessibilitySupportEnabled: vi.fn(() => { throw new Error("isAccessibilitySupportEnabled must never be asked"); }),
    setLoginItemSettings: vi.fn((s: { openAtLogin: boolean }) => { login = { ...login, openAtLogin: s.openAtLogin, status: s.openAtLogin ? "enabled" : "not-registered" }; }),
    getLoginItemSettings: vi.fn(() => login),
    focus: vi.fn(),
    isInApplicationsFolder: vi.fn(() => true),
    moveToApplicationsFolder: vi.fn(() => true),
    ...overrides.app,
  };
  const systemPreferences = {
    getMediaAccessStatus: vi.fn((t: "microphone" | "camera" | "screen") => (t === "screen" ? "granted" : "not-determined") as "granted" | "not-determined"),
    askForMediaAccess: vi.fn(async () => true),
    isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => true),
    getAnimationSettings: vi.fn(() => ({ prefersReducedMotion: false })),
    ...overrides.systemPreferences,
  };
  const shell = { openExternal: vi.fn(async (_url: string) => undefined) };
  const desktopCapturer = { getSources: vi.fn(async () => []) };
  const powerMonitor = { on: vi.fn() };
  const browserWindow = { getFocusedWindow: vi.fn(() => null) };
  const screen = {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, size: { width: 1440, height: 900 } }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, size: { width: 1440, height: 900 } }],
  };
  // Electron's utilityProcess (the accessibility host's launch, review #177): what its fork returns.
  const utilityChild = { pid: undefined, stdout: null, stderr: null, postMessage: vi.fn(), kill: vi.fn(() => false), on: vi.fn() };
  const utilityProcess = { fork: vi.fn((_modulePath: string, _args: string[], _options: unknown) => utilityChild) };
  const electron = { app, systemPreferences, shell, desktopCapturer, powerMonitor, browserWindow, screen, utilityProcess } as unknown as ElectronParts;
  return { electron, app, systemPreferences, shell, desktopCapturer, powerMonitor, browserWindow, screen, utilityProcess, utilityChild, setLogin: (s: LoginItemSettingsLike) => { login = s; } };
}

/** PlatformDeps over fake Electron parts. */
export function fakeDeps(electron: ElectronParts, env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/ada" }): PlatformDeps {
  return {
    electron, packaged: true, execPath: "/Applications/Ember.app/Contents/MacOS/Ember", appPath: "/Applications/Ember.app/Contents/Resources/app",
    resourcesPath: "/Applications/Ember.app/Contents/Resources", env,
  };
}

/** A darwin window system as far as the permission reads go, with FX-PD's extras when given. */
export function fakeDarwinWindows(extras: { trusted?: boolean; screen?: boolean; inputMonitoring?: boolean | null; requestInputMonitoring?: () => unknown;
  secureInput?: () => { on: boolean | null; pid: number | null; app: string } } = {}): WindowSystem {
  const ws: Record<string, unknown> = {
    kind: "darwin",
    compositorMayChange: false,
    accessibilityTrusted: () => extras.trusted ?? true,
    screenRecording: () => extras.screen ?? true,
  };
  if ("inputMonitoring" in extras) ws.inputMonitoring = () => extras.inputMonitoring;
  if (extras.requestInputMonitoring) ws.requestInputMonitoring = extras.requestInputMonitoring;
  if (extras.secureInput) ws.secureInput = extras.secureInput;
  return ws as unknown as WindowSystem;
}
