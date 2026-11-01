/**
 * How Ember starts the sidecar host on Windows and macOS (a SidecarLaunch for AtspiSidecar), running
 * dist/app/ax-sidecar.cjs. Windows: its own binary in node mode (ELECTRON_RUN_AS_NODE=1), with no console window and
 * the bridge's script and compiled-assembly cache named in its environment. macOS: an Electron utility process of
 * Ember's (the fork main hands in), because the macOS build turns node mode off (review #177: any program could
 * otherwise start Ember's binary as Node, and macOS can hold Ember responsible for it, with Ember's Accessibility and
 * Screen Recording grants); being Ember's own child, the host is still the process macOS holds Ember responsible for.
 * Both get a first-request time long enough for a cold start (Windows PowerShell compiles the bridge on its first run,
 * with antivirus scanning it). Pure: main.ts (or the platform layer) passes in what it knows.
 */

import type { SidecarLaunch, UtilityFork } from "../main/perception/sidecar";

/** How long a new host's first requests may take, by platform: Windows' first start compiles the bridge. */
export const FIRST_REQUEST_MS: Partial<Record<NodeJS.Platform, number>> = { win32: 20_000, darwin: 10_000 };

/**
 * Switches only tests use (see providers/index.ts): never passed to a packaged host. Exported so that Ember's own
 * environment for the host (the platform layer's hostEnv) keeps exactly these in development and drops them packaged.
 */
export const TEST_SWITCHES: readonly string[] = ["EMBER_AX_PROVIDER", "EMBER_AX_FAKE_DESKTOP", "EMBER_AX_FAKE_LOG"];

/** The macOS host's utility process name (app.getAppMetrics, child-process-gone). */
export const HOST_SERVICE_NAME = "Ember accessibility";

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
  /**
   * macOS: Electron's utilityProcess.fork, which starts the host. A packaged Ember on macOS has no other way (no launch
   * without it); in a development tree, without it, `execPath` must be a real Node (the integration tests).
   */
  fork?: UtilityFork;
}

/** The launch for the sidecar host (see the module comment). Throws for a packaged macOS Ember without a fork. */
export function hostLaunch(o: HostLaunchOptions): SidecarLaunch {
  const darwin = o.platform === "darwin";
  if (darwin && o.packaged && !o.fork) throw new Error("On macOS, Ember's accessibility helper runs only as a utility process of Ember's");
  const env: NodeJS.ProcessEnv = { ...o.env };
  // Node mode is Windows' alone: on macOS a stray ELECTRON_RUN_AS_NODE (in any case) is never passed on.
  if (darwin) for (const k of Object.keys(env)) { if (k.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[k]; }
  else env.ELECTRON_RUN_AS_NODE = "1";
  // Compared without case: Windows' environment is case-insensitive, so a packaged host would read Ember_AX_Provider too.
  if (o.packaged) for (const k of Object.keys(env)) if (TEST_SWITCHES.includes(k.toUpperCase())) delete env[k];
  if (o.uiaScript) env.EMBER_UIA_SCRIPT = o.uiaScript;
  if (o.uiaCache) env.EMBER_UIA_CACHE = o.uiaCache;
  const firstRequestMs = FIRST_REQUEST_MS[o.platform] ?? 5000;
  if (darwin && o.fork) return { command: o.execPath, args: [o.host], env, firstRequestMs, utility: { fork: o.fork, serviceName: HOST_SERVICE_NAME } };
  return { command: o.execPath, args: [o.host], env, firstRequestMs, windowsHide: true };
}
