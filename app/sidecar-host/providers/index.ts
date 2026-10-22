/**
 * Which provider the sidecar host runs on: Windows' UI Automation bridge, macOS AX (not yet: an "unsupported" provider
 * that says so for every request), or the in-memory fake desktop for tests. The fake is chosen only with
 * EMBER_AX_PROVIDER=fake, and only in development: a packaged host (its bundle inside Ember's resources) never honours
 * it, so a stray variable can't make an installed Ember read a made-up desktop.
 */

import path from "node:path";
import type { AxProvider, ProviderHealth } from "../provider";
import { ProviderError, ownerPid } from "../provider";
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

/** A provider for a platform the host can't read yet: every request but ping says why. */
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

/**
 * The provider for this process (`file`: the host's own script, which says whether it is packaged; `owner`: Ember's
 * own process, never read: its windows are listed from Win32 facts alone).
 */
export function openProvider(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, file = typeof __filename === "string" ? __filename : "", owner = ownerPid(env, process.ppid)): AxProvider {
  switch (providerKind(env, platform, isPackaged(file))) {
    case "fake": return fakeFromEnv(env);
    case "uia": return new UiaProvider({ script: uiaScript(env, file), env, skipPids: owner === undefined ? [] : [owner] });
    case "ax": return new UnsupportedProvider("ax", "the macOS accessibility provider isn't part of this build yet");
    default: return new UnsupportedProvider("uia", `the accessibility host doesn't run on ${platform}: Ember reads apps there with its AT-SPI sidecar`);
  }
}
