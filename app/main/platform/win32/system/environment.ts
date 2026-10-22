/**
 * The Windows inputs of the setup check (inspectEnvironment) and the fixes it offers. readEnvironment runs on every
 * settings-window status request, so everything here is cheap: process facts, the token's elevation and the session
 * read once, and the PowerShell facts (registry and two file streams) kept for a minute. What the accessibility helper
 * itself said arrives in EnvContext.helper (main asks it once in the background, never on Linux).
 */

import os from "node:os";
import { SHORTCUTS, type ShortcutTable } from "../../../../shared/shortcuts";
import type { EnvInputs } from "../../../environment";
import type { EnvContext, FixId, ShellLike } from "../../types";
import type { Win32SysApi } from "./ffi";
import { envValue } from "./interim";
import { powershellState, unblockHelper, type PowerShellFacts, type PowerShellState } from "./powershell";

/** EnvInputs.windows (§4.13): what the Windows rows of the setup check are decided from. */
export interface Win32EnvFacts {
  /** The Windows build ("10.0.22631" → 22631). */
  build: number;
  elevated: boolean;
  session: "console" | "rdp" | "service";
  powershell: PowerShellState;
  /** The helper's threads and its process see different DPI awareness (mixed-DPI risk, R22). */
  dpiMixed: boolean;
}

/** The Windows build from "10.0.22631" (process.getSystemVersion, or os.release()); 0 when it can't be read. */
export function windowsBuild(version: string): number {
  const m = /^\d+\.\d+\.(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

/** Where Ember runs: in a service's session (session 0), a remote desktop, or the console. */
export function sessionKind(env: NodeJS.ProcessEnv, sessionId: number | null): Win32EnvFacts["session"] {
  if (sessionId === 0) return "service"; // services run in session 0, whatever their environment says
  const name = envValue(env, "SESSIONNAME") ?? "";
  if (/^RDP-/i.test(name)) return "rdp";
  return "console";
}

/** The fixes Windows offers, and their button labels. */
export const WIN32_FIX_IDS: readonly FixId[] = ["open-microphone-settings", "unblock-helper"];
const LABELS: Partial<Record<FixId, string>> = { "open-microphone-settings": "Open Settings", "unblock-helper": "Unblock it" };

/** What the Windows environment needs. */
export interface Win32EnvDeps {
  env: NodeJS.ProcessEnv;
  api: () => Win32SysApi | null;
  powershell: { get(fresh?: boolean): PowerShellFacts; forget(): void };
  shell: Pick<ShellLike, "openExternal">;
  /** process.getSystemVersion (Electron), else os.release(). */
  systemVersion?: () => string;
  versions?: { electron?: string; chrome?: string; node: string };
  arch?: string;
  pid?: number;
  /** Removes a file's alternate stream (tests). */
  rm?: (p: string) => void;
}

/** The environment inputs and fixes for Windows. */
export function win32Environment(d: Win32EnvDeps): {
  environment(ctx: EnvContext): EnvInputs & { shortcuts: ShortcutTable; windows: Win32EnvFacts };
  fixes: { readonly ids: readonly FixId[]; apply(fix: FixId): Promise<void>; label(fix: FixId): string };
} {
  let elevated: boolean | null | undefined;
  let session: Win32EnvFacts["session"] | undefined;
  const systemVersion = d.systemVersion ?? (() => (process as { getSystemVersion?: () => string }).getSystemVersion?.() ?? os.release());
  return {
    environment(ctx) {
      const api = d.api();
      if (elevated === undefined || elevated === null) elevated = api ? api.elevated() : null;
      if (session === undefined) session = sessionKind(d.env, api ? api.sessionId(d.pid ?? process.pid) : null);
      const helper = ctx.helper;
      const inputs: EnvInputs & { shortcuts: ShortcutTable; windows: Win32EnvFacts } = {
        env: d.env,
        osRelease: null,
        glibc: null,
        versions: d.versions ?? { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
        platform: "win32",
        arch: d.arch ?? process.arch,
        shortcutsTaken: ctx.shortcutsTaken,
        shortcuts: SHORTCUTS.win32,
        windows: {
          build: windowsBuild(systemVersion()),
          elevated: elevated === true,
          session,
          powershell: powershellState(d.powershell.get(), helper),
          dpiMixed: !!helper?.dpi && !!helper.processDpi && helper.dpi !== helper.processDpi,
        },
      };
      return inputs;
    },
    fixes: {
      ids: WIN32_FIX_IDS,
      async apply(fix) {
        if (fix === "open-microphone-settings") {
          await d.shell.openExternal("ms-settings:privacy-microphone");
          return;
        }
        if (fix === "unblock-helper") {
          unblockHelper(d.powershell.get(true), d.rm);
          d.powershell.forget();
          return;
        }
        throw new Error(`unknown fix: ${fix}`);
      },
      label: fix => LABELS[fix] ?? "Fix",
    },
  };
}
