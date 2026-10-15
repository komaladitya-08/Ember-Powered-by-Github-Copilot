/**
 * Locates the bundled Copilot runtime (copilot-runtime + runtime.node from
 * @github/copilot-sdk-linux-x64). Packaged builds unpack it from the asar.
 */

import fs from "node:fs";
import path from "node:path";

const RELATIVE = path.join("node_modules", "@github", "copilot-sdk-linux-x64", "prebuilds", "linux-x64", "copilot-runtime");

export interface RuntimeLocation {
  path: string;
  exists: boolean;
}

export function locateRuntime(opts: { appPath: string; resourcesPath?: string; env?: NodeJS.ProcessEnv }): RuntimeLocation {
  const env = opts.env ?? process.env;
  const candidates = [
    env.EMBER_COPILOT_RUNTIME,
    opts.resourcesPath && path.join(opts.resourcesPath, "app.asar.unpacked", RELATIVE),
    path.join(opts.appPath, RELATIVE),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      ensureExecutable(p);
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
