/**
 * Which provider the sidecar host runs on: Windows' UI Automation bridge, macOS AX (in-process, through koffi), or the
 * in-memory fake desktop for tests; elsewhere an "unsupported" provider that says why for every request. The fake is
 * chosen only with EMBER_AX_PROVIDER=fake, and only in development: a packaged host (its bundle inside Ember's
 * resources) never honours it, so a stray variable can't make an installed Ember read a made-up desktop.
 */

import path from "node:path";
import type { AxProvider, ProviderHealth } from "../provider";
import { ProviderError, ownerPid } from "../provider";
import { AxDarwinProvider } from "./ax-darwin";
import { axApiError, openAxApi } from "./ax-darwin-api";
import { fakeFromEnv } from "./fake";
import { UiaProvider, uiaScript } from "./uia";

/** Is this host running from a packaged Ember (resources/app or an asar), not from a development tree? */
export function isPackaged(file: string): boolean {
  const parts = path.resolve(file).split(/[\\/]+/).map(p => p.toLowerCase());
  return parts.includes("app.asar") || parts.some((p, i) => p === "resources" && parts[i + 1] === "app");
}

/** Which provider: "fake" (development only, asked for), else the platform's own. */
export function providerKind(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, packaged: boolean): "fake" | "uia" | "ax" | "none" {
  if (env.EMBER_AX_PROVIDER === "fake" && !packaged) return "fake";
  if (platform === "win32") return "uia";
  if (platform === "darwin") return "ax";
  return "none";
}

/** A provider for a platform the host doesn't read: every request but ping says why. */
export class UnsupportedProvider implements AxProvider {
  readonly generation = 1;

  constructor(readonly kind: "uia" | "ax", private why: string) {}

  get vocabulary(): "uia" | "ax" { return this.kind; }
  async start(): Promise<void> { throw new Error(this.why); }
  async accessibility(): Promise<boolean | null> { return null; }
  health(): ProviderHealth { return { ok: false, detail: this.why }; }
  private fail(): never { throw new ProviderError("failed", this.why); }
  async topWindows(): Promise<never> { this.fail(); }
  async snapshot(): Promise<never> { this.fail(); }
  async element(): Promise<never> { this.fail(); }
  async elementsAt(): Promise<never> { this.fail(); }
  async focused(): Promise<never> { this.fail(); }
  async children(): Promise<never> { this.fail(); }
  async perform(): Promise<never> { this.fail(); }
  async textInfo(): Promise<never> { this.fail(); }
  release(): void {}
  stop(): void {}
}

/** A note for Ember's log (it logs the host's stderr at debug level): events and counts, never screen text. */
function stderrNote(event: string, fields: Record<string, unknown> = {}): void {
  try {
    process.stderr.write(JSON.stringify({ event, ...fields }) + "\n");
  } catch {
    // stderr is gone: nobody is left to tell.
  }
}

/**
 * The provider for this process (`file`: the host's own script, which says whether it is packaged; `owner`: Ember's
 * own process, never read: its windows are listed from the window system's facts alone). The macOS provider binds
 * nothing until its first start, so choosing it is free on any OS (off macOS its start says why it can't run).
 */
export function openProvider(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, file = typeof __filename === "string" ? __filename : "", owner = ownerPid(env, process.ppid)): AxProvider {
  switch (providerKind(env, platform, isPackaged(file))) {
    case "fake": return fakeFromEnv(env);
    case "uia": return new UiaProvider({ script: uiaScript(env, file), env, skipPids: owner === undefined ? [] : [owner] });
    case "ax": return new AxDarwinProvider({ open: openAxApi, openError: () => axApiError, owner, note: stderrNote });
    default: return new UnsupportedProvider("uia", `the accessibility host doesn't run on ${platform}: Ember reads apps there with its AT-SPI sidecar`);
  }
}
