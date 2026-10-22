/**
 * WSL as Ember sees it (§4.1): the distros on this PC, what WSL and WSLg look like here, and the service WA builds
 * (createWsl in app/main/wsl/service.ts; null off Windows). Types only; plain Node.
 */

import type { CommandRunner, WindowsContext } from "../commands/types";
import type { PlatformDoctorRow } from "../platform/types";

/** One WSL distro as Ember sees it. */
export interface WslDistro {
  name: string;
  /** 1 or 2 (WSL1 runs no WSLg). */
  version: 1 | 2;
  isDefault: boolean;
  /**
   * The distro's default user id **as the distro itself reports it** (`id -u` in the facts script, or the in-distro
   * sidecar's status): 0 means root (WSLg acting refused, every command asks). null: not known yet (not running since
   * Ember started). The registry's DefaultUid is a hint for listing only: an imported distro's /etc/wsl.conf
   * `[user] default=` wins over it (critique wsl-7).
   */
  defaultUid: number | null;
  running: boolean;
  /** Its first-run set-up (user creation) hasn't happened yet: Ember never starts it (critique wsl-19f). */
  needsSetup: boolean;
  /** A tool's own distro: "podman" (commands only, every command asks). Docker's and Rancher's are never listed. */
  tool?: "podman";
}

/** What WSL looks like on this PC. */
export interface WslFacts {
  installed: boolean;
  /** The wsl.exe Ember runs (Store/MSI WSL's, else the inbox one). */
  wslExe: string | null;
  /** docker-desktop*, rancher-desktop* are never listed. */
  distros: WslDistro[];
  /**
   * WSLg can be there: the Store/MSI WSL (wslVersion !== null), some distro of version 2, and no `guiApplications=false`;
   * confirmed per distro by the sidecar's `status.wslg` (/mnt/wslg exists). The inbox WSL never has WSLg (critique wsl-21).
   */
  wslg: { available: boolean; disabledByUser: boolean; version: string | null };
  /** "2.3.26.0" from `wsl --version`; null for the inbox WSL. */
  wslVersion: string | null;
}

/** WSL for Ember (createWsl in app/main/wsl/service.ts; null off Windows). */
export interface WslService {
  facts(o?: { refresh?: boolean }): Promise<WslFacts>;
  /** Cheap: the last facts' running set, refreshed at most every 2 s on demand. */
  isRunning(distro: string): boolean;
  /** The running set read now, uncached (`wsl --list --running --quiet`, filtered to known names). */
  runningNow(): Promise<Set<string>>;
  /** The command runner for a distro (§4.2). */
  runner(distro: string): CommandRunner;
  /** The distro's default uid as the distro reports it; asked only when it is running (never boots it). */
  defaultUid(distro: string): Promise<number | null>;
  /** The Windows side's facts for nested cmd/PowerShell and Windows-form paths (§3.4.5). */
  windowsContext(): WindowsContext;
  /** sha256 of /proc/sys/kernel/random/boot_id of each running WSL2 distro (SA's same-machine rule, §5.1.14). */
  bootIds(): Promise<string[]>;
  onChange(fn: (f: WslFacts) => void): () => void;
  doctorRows(): Promise<PlatformDoctorRow[]>;
  dispose(): void;
}
