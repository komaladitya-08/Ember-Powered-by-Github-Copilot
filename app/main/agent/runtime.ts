/**
 * Locates the bundled Copilot runtime (copilot-runtime + runtime.node from
 * @github/copilot-sdk-<platform id>, linux-x64 on Linux). Packaged builds unpack it from the asar.
 * npm installs only the running OS's package, so each OS names its own (the platform's paths.runtimeId/runtimeExe).
 */

import fs from "node:fs";
import path from "node:path";
import type { OS } from "../../shared/shortcuts";

/** Linux's runtime, as Ember has always shipped it. */
const LINUX = { id: "linux-x64", exe: "copilot-runtime" };

/**
 * The Copilot SDK's platform id and runtime file name for an OS and CPU, as the SDK's own resolver names them
 * (win32-x64/copilot-runtime.exe, darwin-arm64/copilot-runtime…). Linux stays linux-x64, the only Linux Ember
 * supports.
 */
export function runtimeFor(os: OS, arch: string): { id: string; exe: string } {
  if (os === "win32") return { id: `win32-${arch}`, exe: "copilot-runtime.exe" };
  if (os === "darwin") return { id: `darwin-${arch}`, exe: "copilot-runtime" };
  return LINUX;
}

/** Where the runtime sits inside an app folder (node_modules/@github/copilot-sdk-<id>/prebuilds/<id>/<exe>). */
export function runtimeRelative(runtimeId = LINUX.id, exe = LINUX.exe): string {
  return path.join("node_modules", "@github", `copilot-sdk-${runtimeId}`, "prebuilds", runtimeId, exe);
}

export interface RuntimeLocation {
  path: string;
  exists: boolean;
}

/**
 * The runtime Ember starts: EMBER_COPILOT_RUNTIME (development; main passes an empty env when packaged), the copy
 * unpacked beside a packaged app's asar, or the app folder's own. `runtimeId`/`exe` name the OS's package (defaults:
 * Linux's). A Windows .exe is never chmodded (only the read-only bit exists there).
 */
export function locateRuntime(opts: { appPath: string; resourcesPath?: string; env?: NodeJS.ProcessEnv; runtimeId?: string; exe?: string }): RuntimeLocation {
  const env = opts.env ?? process.env;
  const relative = runtimeRelative(opts.runtimeId, opts.exe);
  const candidates = [
    env.EMBER_COPILOT_RUNTIME,
    opts.resourcesPath && path.join(opts.resourcesPath, "app.asar.unpacked", relative),
    path.join(opts.appPath, relative),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      if (!/\.exe$/i.test(opts.exe ?? "")) ensureExecutable(p);
      return { path: p, exists: true };
    }
  }
  return { path: candidates[candidates.length - 1], exists: false };
}

function ensureExecutable(p: string): void {
  try {
    const mode = fs.statSync(p).mode;
    if ((mode & 0o111) === 0) fs.chmodSync(p, mode | 0o755);
  } catch {
    // Read-only install: the package manager already set the mode.
  }
}
