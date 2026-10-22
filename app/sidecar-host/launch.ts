/**
 * How Ember starts the sidecar host on Windows and macOS (a SidecarLaunch for AtspiSidecar): its own binary in node
 * mode (ELECTRON_RUN_AS_NODE=1) running dist/app/ax-sidecar.cjs, with no console window, the Windows bridge's script
 * and compiled-assembly cache named in its environment, and a first-request time long enough for a cold start (Windows
 * PowerShell compiles the bridge on its first run, with antivirus scanning it). Pure: main.ts (or the platform layer)
 * passes in what it knows.
 */

import type { SidecarLaunch } from "../main/perception/sidecar";

/** How long a new host's first requests may take, by platform: Windows' first start compiles the bridge. */
export const FIRST_REQUEST_MS: Partial<Record<NodeJS.Platform, number>> = { win32: 20_000, darwin: 10_000 };

/** Switches only tests use (see providers/index.ts): never passed to a packaged host. */
const TEST_SWITCHES = ["EMBER_AX_PROVIDER", "EMBER_AX_FAKE_DESKTOP", "EMBER_AX_FAKE_LOG"];

export interface HostLaunchOptions {
  /** Ember's own binary (process.execPath). */
  execPath: string;
  /** dist/app/ax-sidecar.cjs. */
  host: string;
  /** Windows: sidecar/uia/ember_uia.ps1 (under resources/ when packaged). */
  uiaScript?: string;
  /** Windows: where the compiled bridge is cached (a folder under Ember's userData). */
  uiaCache?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** A packaged Ember: test-only switches are left out. */
  packaged: boolean;
}

/** The launch for the sidecar host (see the module comment). */
export function hostLaunch(o: HostLaunchOptions): SidecarLaunch {
  const env: NodeJS.ProcessEnv = { ...o.env, ELECTRON_RUN_AS_NODE: "1" };
  if (o.packaged) for (const k of TEST_SWITCHES) delete env[k];
  if (o.uiaScript) env.EMBER_UIA_SCRIPT = o.uiaScript;
  if (o.uiaCache) env.EMBER_UIA_CACHE = o.uiaCache;
  return { command: o.execPath, args: [o.host], env, firstRequestMs: FIRST_REQUEST_MS[o.platform] ?? 5000, windowsHide: true };
}
