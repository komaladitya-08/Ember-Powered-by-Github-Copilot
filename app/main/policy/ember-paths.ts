/**
 * Ember's own folders as one path names them (integ-y-1): its data folder and the organisation's policy folder, or a
 * folder that holds one (~/.config, %LOCALAPPDATA%, ~/Library/Application Support, and every folder above them),
 * judged by the commands classifier's own path rules (commands/paths.ts: isEmberPath, holdsEmberPath, globReaches),
 * so an extension's arguments and text typed in an app reach what a command naming the same path reaches. Case
 * counts only on Linux, as it does there for commands. Pure; no file is touched.
 */

import { globPrefix, globReaches, holdsEmberPath, isEmberPath, isUnder, pathEnv, resolveTargetPath, windowsContextOf, type PathEnv, type PathFlavour } from "../commands/paths";
import type { OS } from "../../shared/shortcuts";

/** Where a path is judged: this computer's OS, its user's home and Ember's own folders on it, if known. */
export interface EmberPlace {
  os: OS;
  /** The user's home (null or absent: any user's, as `~`, `$HOME` and `%USERPROFILE%` then say). */
  home?: string | null;
  /** Ember's own folders beyond the built-in ones (its data folder where EMBER_USER_DATA moved it). */
  ember?: readonly string[];
  /** The folder a relative path is relative to and that is not Ember's to protect (a stdio server's own folder). */
  own?: string | null;
}

/** What a path reaches of Ember's: "names", its data or policy folder or something in one; "holds", a folder above one. */
export type PathReach = "names" | "holds" | null;

/**
 * A typed path as the dialog or the program will read it (r10-safety-y10-2): a percent-escaped letter, digit or dot
 * decoded ("%65mber"), an escaped space unescaped ("Application\ Support"), and doubled separators and "/./" parts dropped.
 */
export const plainPath = (text: string): string => text
  .replace(/%([0-9a-f]{2})/gi, (all, hex: string) => { const c = String.fromCharCode(parseInt(hex, 16)); return /[a-z0-9.]/i.test(c) ? c : all; })
  .replace(/\\ /g, " ")
  .replace(/([/\\])(?:\.[/\\])+/g, "$1")
  .replace(/([/\\])[/\\]+/g, "$1");

/** Characters a path shows as nothing (format characters, the soft hyphen, the variation selectors): dropped, as the policy's labels drop them. */
const HIDDEN = /[\p{Cf}\u00ad\u115f\u1160\u3164\uffa0]|\u034f|\u17b4|\u17b5|\u180b|\u180c|\u180d|\u180f|[\ufe00-\ufe0f]/gu;

/** The longest text read as a path; a longer one is no path any program opens. */
const PATH_MAX = 4096;

/** A home for `~` when the user's isn't known: a name no user has, so only Ember's folders below it are matched. */
const ANY_POSIX_HOME = "/home/~";
const ANY_WIN_HOME = "C:\\Users\\~";

/** The home a path itself names (`/home/ana/…`, `/Users/ana/…`, `/root/…`, `C:\Users\ana\…`): Ember's folders are there too. */
function homeIn(abs: string, flavour: PathFlavour): string | null {
  const m = flavour === "win32" ? /^[A-Za-z]:\\Users\\[^\\]+/i.exec(abs) : /^\/(?:home|Users)\/[^/]+|^\/(?:var\/)?root(?=\/|$)/.exec(abs);
  return m ? m[0] : null;
}

/** `text` with a `file:` address, `~`, `$HOME`, `$XDG_CONFIG_HOME`, `%USERPROFILE%`, `%LOCALAPPDATA%` and `%APPDATA%` written out. */
function expanded(text: string, posixHome: string, winHome: string): string {
  let t = text;
  const file = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(t);
  if (file) t = /^\/[A-Za-z]:[\\/]/.test(file[1]) ? file[1].slice(1) : file[1];
  return t
    .replace(/^\$\{?HOME\}?(?=$|\/)/, posixHome)
    .replace(/^\$\{?XDG_CONFIG_HOME\}?(?=$|\/)/, `${posixHome}/.config`)
    .replace(/^%(?:USERPROFILE|HOME)%(?=$|[\\/])/i, winHome)
    .replace(/^%LOCALAPPDATA%(?=$|[\\/])/i, `${winHome}\\AppData\\Local`)
    .replace(/^%APPDATA%(?=$|[\\/])/i, `${winHome}\\AppData\\Roaming`);
}

/**
 * What one path reaches of Ember's own (integ-y-1), as the commands classifier judges a command's path: Ember's data or
 * policy folder or anything in it, or a pattern that may match one ("names"); a folder above one, which moving or
 * deleting takes Ember's data with ("holds", or a pattern that may match such a folder). A web address and a relative
 * path with nowhere to be relative to reach nothing here.
 */
export function emberPathReach(text: string, place: EmberPlace): PathReach {
  if (!text || text.length > PATH_MAX || text.includes("\0") || (/^[a-z][a-z0-9+.-]+:\/\//i.test(text) && !/^file:/i.test(text))) return null;
  const home = place.home || null;
  const posixHome = home && home.startsWith("/") ? home : ANY_POSIX_HOME;
  const winHome = home && /^[A-Za-z]:[\\/]/.test(home) ? home : ANY_WIN_HOME;
  const t = expanded(plainPath(text.normalize("NFKC").replace(HIDDEN, "")), posixHome, winHome);
  const own = place.own || null;
  let flavour: PathFlavour;
  if (/^[A-Za-z]:[\\/]/.test(t) || /^\\\\/.test(t)) flavour = "win32";
  else if (t.startsWith("/")) flavour = "posix";
  else if (t === "~" || /^~[\\/]/.test(t)) flavour = place.os === "win32" ? "win32" : "posix";
  else if (own) flavour = /^[A-Za-z]:/.test(own) ? "win32" : "posix";
  else return null;
  // Case counts on Linux only (macOS and Windows: as the classifier's `caseless`).
  const os: OS = flavour === "win32" ? "win32" : place.os === "linux" ? "linux" : "darwin";
  const ownHome = flavour === "win32" ? winHome : posixHome;
  const abs = resolveTargetPath(t, { os, home: ownHome, cwd: own ?? (flavour === "win32" ? winHome : posixHome) });
  const ember = (place.ember ?? []).filter(p => (flavour === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/")));
  const homes = [...new Set([ownHome, homeIn(abs, flavour)].filter((h): h is string => !!h))];
  const envs: PathEnv[] = homes.map(h => pathEnv({ flavour, os, home: h, cwd: null, windows: flavour === "win32" ? windowsContextOf(h, ember) : null, ember }));
  // A distro's home that isn't known: Ember's folders in any home, and the folders above them (the classifier's own rule).
  if (flavour === "posix") envs.push(pathEnv({ flavour, os, home: null, cwd: null, ember }));
  const glob = flavour === "win32" ? /[*?]/.test(abs) : /(^|[^\\])[*?[]/.test(abs);
  let holds = false;
  for (const env of envs) {
    const fixed = glob ? globPrefix(abs, env) : abs;
    // The server's own folder is its own, even inside Ember's data folder (where its plugin is kept).
    if (own && isUnder(fixed, own, env)) return null;
    if (glob) {
      try {
        if (globReaches(abs, "read", env, false).ember || isEmberPath(fixed, env)) return "names";
        if (globReaches(abs, "deleteTree", env, false).ember || holdsEmberPath(fixed, env)) holds = true;
      } catch {
        // A pattern the matcher can't read: its fixed part decides, as the classifier's does.
        if (isEmberPath(fixed, env)) return "names";
        if (holdsEmberPath(fixed, env)) holds = true;
      }
    } else if (isEmberPath(abs, env)) return "names";
    else if (holdsEmberPath(abs, env)) holds = true;
  }
  return holds ? "holds" : null;
}
