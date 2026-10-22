/**
 * A remote's installed apps as a worker uses them (§2.6, §5.5; critique integration-7), and the worker's view of the
 * remote OS (`remoteWorkerSystem`). The list comes from the agent's `apps.list` (its .desktop files: names, keywords,
 * categories, the Exec line's argv and Terminal=), kept for at most 60 s and read synchronously as AppCatalog.list is.
 * Terminals are judged on the PC with the remote OS's vocabulary through wrappers and inline code, as on this computer,
 * from each app's argv and Terminal= (so gate 1 refuses what gate 2 would). Launching is asynchronous: it needs the fresh
 * stamp of the open_app step the user said yes to, sends `apps.launch`, and throws gate 2's words when the remote
 * refuses (the worker awaits it and returns them as the tool's refusal). Nothing from the list ever names a local file
 * or program: an app here is only an id the remote gave out. Plain Node.
 */

import { findApp, isTerminalApp, programsOf, type DesktopApp } from "../hands/system";
import { LAUNCHERS } from "../hands/terminals";
import { isSecurityWindow } from "../policy/policy";
import { KEYS, SHORTCUTS, type OS } from "../../shared/shortcuts";
import { PLATFORM_WORDS } from "../../shared/words";
import { askRemote, cleanRemote, gateRefusal, RemoteError, sha256Hex, unchecked, type StampBook } from "./remote-sidecar";
import type { WorkerSystem } from "../agent/worker";
import type { AppIdentity } from "../platform/types";
import type { Logger } from "../logger";
import type { RemoteApp } from "./protocol";
import type { RemoteLink } from "./types";

/** The list is asked for again at most this often (§5.5). */
export const APPS_TTL_MS = 60_000;
/** After a failed ask, the next one waits this long. */
const RETRY_MS = 10_000;
/** An app's name as Ember shows and judges it: one plain line of at most this many characters. */
const NAME_MAX = 100;

/** The worker's apps on a remote, with what the targets runtime and gate 1 use besides. */
export interface RemoteApps extends Required<Pick<WorkerSystem["apps"], "list" | "find" | "isTerminalApp" | "programsOf" | "appKey">> {
  /** Starts the app on the remote with the step's stamp; rejects with gate 2's words (RemoteStepError) or Ember's. */
  launch(app: DesktopApp): Promise<void>;
  /** Asks the remote for its list now (at most one ask at a time); resolves when it is in (or failed). */
  refresh(): Promise<void>;
  /** Is the app whose windows report this name a terminal, by its name or by every listed app shown so (gate 1)? */
  terminalByName(name: string): boolean;
  dispose(): void;
}

/** What createRemoteApps needs. */
export interface RemoteAppsOptions {
  /** The remote's OS: its vocabulary judges terminals and its rules name programs. */
  os: OS;
  label: string;
  log: Logger;
  stamps: StampBook;
  /** Why the remote's desktop can't be used now, or null when it can. */
  unavailable: () => string | null;
  now?: () => number;
}

/** A remote's app as this computer's catalogue entries are shaped (no local file: `file` is empty). */
export function desktopAppOf(a: RemoteApp): DesktopApp {
  return {
    id: a.id,
    name: cleanRemote(a.name, NAME_MAX),
    file: "",
    keywords: (a.keywords ?? []).map(k => cleanRemote(k, NAME_MAX)).filter(Boolean),
    ...(a.categories ? { categories: a.categories.map(c => cleanRemote(c, 64)).filter(Boolean) } : {}),
    ...(a.argv ? { argv: [...a.argv] } : {}),
    ...(a.terminal !== undefined ? { terminal: a.terminal } : {}),
  };
}

/** A remote's apps (§5.5): the cached list, finding and judging them with the remote OS's rules, launching through gate 2. */
export function createRemoteApps(link: RemoteLink, o: RemoteAppsOptions): RemoteApps {
  const { os, label } = o;
  const now = o.now ?? (() => performance.now());
  const launchers = LAUNCHERS[os];
  let apps: DesktopApp[] = [];
  /** When the list may be asked for again (0: now). */
  let due = 0;
  let asking: Promise<void> | null = null;
  let disposed = false;

  const appKey = (name: string) => (os === "win32" ? name.toLowerCase().replace(/\.exe$/, "") : name.toLowerCase());
  const terminal = (app: AppIdentity) => isTerminalApp(app, os);

  const refresh = (): Promise<void> => {
    if (asking) return asking;
    if (disposed || o.unavailable()) return Promise.resolve();
    asking = askRemote(link, "apps.list", {}, { label }).then(r => {
      // Each id once (the first wins, as the XDG data folders' order does).
      const seen = new Set<string>();
      apps = r.apps.filter(a => !seen.has(a.id) && !!seen.add(a.id)).map(desktopAppOf).filter(a => a.name);
      due = now() + APPS_TTL_MS;
    }, (err: unknown) => {
      due = now() + RETRY_MS;
      o.log.warn("remote.apps_list_failed", { err: err instanceof Error ? err.name : "error" });
    }).finally(() => { asking = null; });
    return asking;
  };

  const terminalByName = (name: string): boolean => {
    const key = appKey(name.trim());
    if (!key) return false;
    if (terminal({ id: name, name })) return true;
    // Every listed app shown by that name (its name, id or programs; on a Mac also its keywords, which are the bundle's
    // display names, as isTerminalWindowApp reads them): a terminal's window says only its name.
    const shownAs = (a: DesktopApp) => [a.name, a.id, a.id.replace(/\.desktop$/i, ""), ...(os === "darwin" ? a.keywords : [])];
    return apps.some(a => terminal(a) && (shownAs(a).some(n => appKey(n.trim()) === key) || programsOf(a, launchers).has(key)));
  };

  return {
    list(): DesktopApp[] {
      if (!disposed && !o.unavailable() && now() >= due) void refresh();
      return apps;
    },
    find: (list, query) => findApp(list, query, os),
    isTerminalApp: app => terminal(app) || terminalByName(app.name),
    programsOf: app => programsOf(app, launchers),
    appKey,
    refresh,
    terminalByName,
    async launch(app: DesktopApp): Promise<void> {
      const why = o.unavailable();
      if (why) throw new RemoteError("not_ready", why);
      const listed = apps.find(a => a.id === app.id);
      if (!listed) throw new RemoteError("gone", `That app isn't among ${label}'s apps any more. Use open_app again.`);
      // As every launcher of Ember's: never a terminal (the remote's gate 2 refuses them too).
      if (terminal(listed) || terminalByName(listed.name)) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
      const stamp = o.stamps.take(["open_app"], s => s.app === listed.name && s.valueSha256 === sha256Hex(listed.name), label);
      const answer = await askRemote(link, "apps.launch", { epoch: link.epoch, appId: listed.id, stamp }, { label });
      const refused = gateRefusal(answer, label);
      if (refused) throw refused;
      if (answer.status !== "ok") throw new RemoteError("unchecked", unchecked(label));
    },
    dispose(): void {
      disposed = true;
      apps = [];
    },
  };
}

/**
 * The worker's view of a remote OS (§2.6): its keys, words and shortcuts, the remote's apps, no comfort settings
 * (Ember changes none on another computer), and its security-window vocabulary.
 */
export function remoteWorkerSystem(os: OS, apps: RemoteApps): WorkerSystem {
  return {
    os,
    keys: KEYS[os],
    words: PLATFORM_WORDS[os],
    shortcuts: SHORTCUTS[os],
    apps,
    settings: {
      available: {},
      change: () => Promise.reject(new Error("Ember doesn't change settings on another computer.")),
    },
    privacy: { isSecurityWindow: w => isSecurityWindow(w, os) },
  };
}
