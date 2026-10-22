/**
 * The setup checks' inputs on a Mac (EnvInputs.mac, design §9.8) and the fixes the settings window offers for them.
 * The inputs are Electron calls and cached koffi reads only, because the settings window asks for them on every
 * status request. A fix only opens the right System Settings pane, after doing the one thing that puts Ember in that
 * pane's list (macOS lists an app only once it has asked); it never changes a permission itself, and "reset" and
 * "move" run only when the user presses their button.
 */

import type { EnvInputs } from "../../../environment";
import type { AppLike, DesktopCapturerLike, EnvContext, FixId, ShellLike, SystemPlatform, SystemPreferencesLike } from "../../types";
import { SHORTCUTS } from "../../../../shared/shortcuts";
import { execRun, type Run } from "./exec";
import { PANES, darwinExtras, readPermissions, type PermissionDeps } from "./permissions";

/** Ember's bundle identifier (port/packaging's CFBundleIdentifier): what tccutil resets. */
export const BUNDLE_ID = "io.github.komaladitya08.ember";

/** The TCC services "Reset Ember's permissions" clears (Accessibility, Screen Recording, Input Monitoring). */
export const RESET_SERVICES = ["Accessibility", "ScreenCapture", "ListenEvent"] as const;

/** How long "Open System Settings" for Screen Recording waits for its one-pixel grab before opening the pane. */
export const GRAB_WAIT_MS = 3000;

/** The fixes this Mac offers, in the order the design lists them. */
export const DARWIN_FIXES: readonly FixId[] = [
  "open-accessibility-settings", "open-screen-recording-settings", "open-input-monitoring-settings", "open-microphone-settings",
  "open-automation-settings", "reset-permissions", "move-to-applications",
];

/** What the environment and the fixes take. */
export interface DarwinEnvDeps extends PermissionDeps {
  env: NodeJS.ProcessEnv;
  app: Pick<AppLike, "isInApplicationsFolder" | "moveToApplicationsFolder">;
  systemPreferences: Pick<SystemPreferencesLike, "getMediaAccessStatus" | "isTrustedAccessibilityClient" | "askForMediaAccess">;
  desktopCapturer: DesktopCapturerLike;
  shell: Pick<ShellLike, "openExternal">;
  run?: Run;
}

/** EnvInputs for inspectEnvironment: the common fields, and the `mac` block. */
export function darwinEnvironment(d: DarwinEnvDeps, ctx: EnvContext): EnvInputs {
  const p = readPermissions({ ...d, windows: () => (ctx.windows === undefined ? d.windows() : ctx.windows) });
  return {
    env: d.env,
    osRelease: null,
    glibc: null,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    platform: process.platform,
    arch: process.arch,
    shortcutsTaken: ctx.shortcutsTaken,
    shortcuts: SHORTCUTS.darwin,
    mac: {
      version: p.version, accessibility: p.accessibility, screen: p.screen, microphone: p.microphone,
      inputMonitoring: p.inputMonitoring, inApplications: p.inApplications, root: p.root,
    },
  };
}

const LABELS: Partial<Record<FixId, string>> = {
  "open-accessibility-settings": "Open System Settings",
  "open-screen-recording-settings": "Open System Settings",
  "open-input-monitoring-settings": "Open System Settings",
  "open-microphone-settings": "Open System Settings",
  "open-automation-settings": "Open System Settings",
  "reset-permissions": "Reset Ember's permissions",
  "move-to-applications": "Move to Applications",
};

/** The macOS fixes (design §9.8). */
export function darwinFixes(d: DarwinEnvDeps): SystemPlatform["fixes"] {
  const run = d.run ?? execRun;
  // Each "put Ember in the list" request runs once a session: macOS shows its own prompt only the first time anyway.
  const asked = new Set<FixId>();
  const once = (fix: FixId, fn: () => unknown) => {
    if (asked.has(fix)) return;
    asked.add(fix);
    try {
      fn();
    } catch {
      // The pane still opens: the user can add Ember there with +.
    }
  };
  const open = (url: string) => d.shell.openExternal(url);

  return {
    ids: DARWIN_FIXES,
    label: (fix: FixId) => LABELS[fix] ?? "Open System Settings",
    async apply(fix: FixId): Promise<void> {
      switch (fix) {
        case "open-accessibility-settings":
          once(fix, () => d.systemPreferences.isTrustedAccessibilityClient?.(true));
          return open(PANES.accessibility);
        case "open-screen-recording-settings":
          if (!asked.has(fix)) {
            asked.add(fix);
            // A one-pixel grab is what adds Ember to the Screen Recording list; its picture is thrown away, and the
            // pane opens after at most GRAB_WAIT_MS whatever the grab does.
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              // Called inside then(), so a getSources that throws instead of rejecting still opens the pane.
              Promise.resolve().then(() => d.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })).catch(() => []),
              new Promise(resolve => { timer = setTimeout(resolve, GRAB_WAIT_MS); }),
            ]);
            clearTimeout(timer);
          }
          return open(PANES.screenRecording);
        case "open-input-monitoring-settings": {
          // Counted as asked only once there is a window system to ask through (it opens at app ready).
          const ws = darwinExtras(d.windows());
          if (ws?.requestInputMonitoring) once(fix, () => ws.requestInputMonitoring!());
          return open(PANES.inputMonitoring);
        }
        case "open-microphone-settings": {
          let status: string | undefined;
          try {
            status = d.systemPreferences.getMediaAccessStatus?.("microphone");
          } catch {
            status = undefined; // can't tell: open the pane
          }
          if (status === "not-determined" && d.systemPreferences.askForMediaAccess) {
            await d.systemPreferences.askForMediaAccess("microphone").catch(() => false);
            return;
          }
          return open(PANES.microphone);
        }
        case "open-automation-settings":
          return open(PANES.automation);
        case "reset-permissions": {
          for (const service of RESET_SERVICES) {
            const r = await run("/usr/bin/tccutil", ["reset", service, BUNDLE_ID], { timeout: 10_000 });
            if (r.code !== 0) throw new Error("macOS didn't reset Ember's permissions. Remove Ember from each list in System Settings › Privacy & Security instead.");
          }
          // The reset took Ember off every list: each "Open System Settings" puts it back on its own the next time.
          asked.clear();
          // Asks for Accessibility again at once, so Ember is back in the list for the user to switch on.
          once("open-accessibility-settings", () => d.systemPreferences.isTrustedAccessibilityClient?.(true));
          return;
        }
        case "move-to-applications": {
          let moved: boolean;
          try {
            moved = d.app.moveToApplicationsFolder?.() ?? false;
          } catch {
            moved = false; // Electron throws when the move fails for any reason but the user's
          }
          if (!moved) throw new Error("Ember couldn't move itself: drag Ember into Applications.");
          return;
        }
        default:
          throw new Error(`unknown fix: ${fix}`);
      }
    },
  };
}
