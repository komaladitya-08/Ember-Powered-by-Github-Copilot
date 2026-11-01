/**
 * WSL-aware privacy and system (§4.5, §4.8; owned by package WB). A WSLg app's window is named "wsl:<distro>:<app>"
 * once identified, and Windows' vocabularies know none of Linux's terminals or authentication prompts. So a "wsl:"
 * window is also judged as a Linux app, by every name its program goes by (the exe, argv0, argv1, the AT-SPI name and
 * the kernel's 15-byte comm, whose cut-off forms of a terminal's name count too): a Linux terminal, polkit, pinentry,
 * ssh-askpass or gcr-prompter under WSLg is refused like a local one. An msrdc window nobody identified is also judged
 * by its title with Linux's security words ("Authentication Required"). Both checks only ever refuse more than the PC's
 * own, and change nothing for any other window. The system's app catalogue gains WSLg's shortcuts (apps.ts) on Windows.
 */

import { isTerminalApp } from "../hands/system";
import type { Logger } from "../logger";
import { TERMINALS } from "../hands/terminals";
import { isSecurityWindow } from "../policy/policy";
import { isWslApp } from "../policy/target-rules";
import type { AppIdentity, PrivacyVocabulary, SystemPlatform } from "../platform/types";
import { withWslApps } from "./apps";
import { currentRouter, wslNamesOf } from "./router";

/** The kernel keeps a process's name in 16 bytes with its NUL: what /proc/<pid>/comm shows of a longer name. */
const COMM_BYTES = 15;

/** Is `name` a terminal's name cut to comm's 15 bytes ("gnome-terminal-" for gnome-terminal-server)? */
export function isTruncatedTerminal(name: string): boolean {
  const n = Buffer.from(name.trim().toLowerCase(), "utf8");
  if (n.length !== COMM_BYTES) return false;
  for (const t of TERMINALS.linux) {
    const full = Buffer.from(t, "utf8");
    if (full.length > COMM_BYTES && full.subarray(0, COMM_BYTES).equals(n)) return true;
  }
  return false;
}

/** The Linux names a "wsl:<distro>:<app>" window goes by: its app part, and every name the router saw for it. */
export function linuxNamesOfApp(app: string): string[] {
  const m = /^wsl:[^:]+:(.+)$/i.exec(app.trim());
  if (!m) return [];
  return [...new Set([m[1].toLowerCase(), ...wslNamesOf(app)])];
}

/** Is any of these Linux names a terminal, a shell or an app with one built in (Linux's vocabulary)? */
export function linuxTerminalName(names: readonly string[]): boolean {
  return names.some(n => isTerminalApp({ id: n, name: n }, "linux") || isTruncatedTerminal(n));
}

/** msrdc's windows: WSLg's (or a Remote Desktop client's) that no one identified. */
const MSRDC = /^msrdc(?:\.exe)?$/i;

/** The PC's privacy and terminal checks, extended so a `wsl:<distro>:<app>` window is also judged as a Linux app. */
export function wslAwarePrivacy(p: { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean }):
  { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean } {
  return {
    isSecurityWindow(w) {
      if (p.isSecurityWindow(w)) return true;
      const app = (w.app ?? "").trim();
      const title = w.title ?? w.name ?? "";
      // An unidentified WSLg window shows a Linux app: its title is judged with Linux's words too.
      if (MSRDC.test(app)) return isSecurityWindow({ title }, "linux");
      if (!isWslApp(app)) return false;
      return linuxNamesOfApp(app).some(n => isSecurityWindow({ app: n, title }, "linux")) || isSecurityWindow({ title }, "linux");
    },
    isTerminalApp(a) {
      if (p.isTerminalApp(a)) return true;
      const app = (a.name ?? a.id ?? "").trim();
      const id = (a.id ?? "").trim();
      const wsl = isWslApp(app) ? app : isWslApp(id) ? id : null;
      return wsl !== null && linuxTerminalName(linuxNamesOfApp(wsl));
    },
  };
}

/**
 * The system with WSLg apps in its catalogue (withWslApps, §4.8). Off Windows it is `sys` itself; on Windows a view of
 * it whose `apps` also judge and open WSLg's shortcuts, through the WSL the router was given (none yet: the catalogue's
 * own answers, as before).
 */
export function wslAwareSystem(sys: SystemPlatform): SystemPlatform {
  if (sys?.os !== "win32") return sys;
  const wsl = () => currentRouter()?.o.wsl() ?? null;
  const on = () => currentRouter()?.active() === true;
  // The router's log, whenever there is one (main makes it before the agent asks for an app).
  const log: Logger = {
    debug: (m, f) => currentRouter()?.o.log.debug(m, f), info: (m, f) => currentRouter()?.o.log.info(m, f),
    warn: (m, f) => currentRouter()?.o.log.warn(m, f), error: (m, f) => currentRouter()?.o.log.error(m, f),
    child: () => log, get file() { return currentRouter()?.o.log.file ?? ""; },
  };
  let apps: SystemPlatform["apps"] | null = null;
  return new Proxy(sys, {
    get(target, key) {
      if (key === "apps") {
        apps ??= withWslApps(target.apps, { wsl, on, log });
        return apps;
      }
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
