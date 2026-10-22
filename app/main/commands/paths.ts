/**
 * Paths on a target (design §3.6, §3.4.4, critique integration-11, -26, wsl-4): every path is made absolute and
 * normalised with the TARGET's rules (`node:path/posix` for Linux, macOS, WSL and SSH targets, `node:path/win32` for
 * Windows), never the PC's own `node:path`, so a WSL or SSH target judged from a Windows PC sees the same paths as one
 * judged from Linux. Then the path rules: secret paths (class d), Ember's own paths (refused, D4.5), shell start-up
 * files, git hooks, WSL's configuration, system locations and autostart folders (class e), the work tree and temporary
 * folders (§3.4.6), and the Windows path forms a lexical resolver can't follow (unclear). Pure; no file is touched.
 */

import posix from "node:path/posix";
import win32 from "node:path/win32";
import type { ClassifyContext, WindowsContext } from "./types";

/** The target's OS (the contract's own type, so this file imports nothing outside the commands package). */
type OS = ClassifyContext["os"];

/** Which path rules a path follows. */
export type PathFlavour = "posix" | "win32";

/** The path flavour of an OS: Windows' own rules on Windows, POSIX everywhere else. */
export const flavourOf = (os: OS): PathFlavour => (os === "win32" ? "win32" : "posix");

const trimPosix = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") || "/" : p);
const trimWin = (p: string): string => {
  const s = p.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  if (/^[A-Za-z]:\\$/.test(s)) return s;
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(s)) return s.replace(/\\$/, "");
  return s.length > 3 && s.endsWith("\\") ? s.replace(/\\+$/, "") : s;
};

/**
 * A target path made absolute and normalised with the target's rules (path.posix or path.win32 by os): `~` and `~/…`
 * (`~\…` on Windows) from `home`, a relative path joined to `cwd`, `.` and `..` removed lexically, a trailing separator
 * dropped, Windows separators and drive letters normalised. An empty `home` leaves a `~` path as it was written.
 */
export function resolveTargetPath(p: string, o: { os: OS; home: string; cwd: string }): string {
  if (o.os === "win32") {
    let s = p.replace(/\//g, "\\");
    if (s === "~" || s.startsWith("~\\")) {
      if (!o.home) return p;
      s = o.home + s.slice(1);
    }
    if (/^[A-Za-z]:\\/.test(s) || s.startsWith("\\\\")) return trimWin(win32.normalize(s));
    if (s.startsWith("\\")) {
      const drive = /^[A-Za-z]:/.exec(o.cwd)?.[0] ?? "";
      return trimWin(win32.normalize(drive + s));
    }
    const driveRel = /^([A-Za-z]):(.*)$/.exec(s);
    if (driveRel) {
      // A drive-relative path ("D:notes"): relative to that drive's folder, which is only known when it is the cwd's.
      const sameDrive = o.cwd.slice(0, 2).toLowerCase() === `${driveRel[1].toLowerCase()}:`;
      return trimWin(win32.normalize(sameDrive ? win32.join(o.cwd, driveRel[2]) : `${driveRel[1]}:\\${driveRel[2]}`));
    }
    return trimWin(win32.normalize(win32.join(o.cwd, s)));
  }
  let s = p;
  if (s === "~" || s.startsWith("~/")) {
    if (!o.home) return p;
    s = o.home + s.slice(1);
  }
  if (s.startsWith("/")) return trimPosix(posix.normalize(s));
  return trimPosix(posix.normalize(posix.join(o.cwd, s)));
}

/** Whether a path is absolute under its flavour's rules. */
export function isAbsolute(p: string, f: PathFlavour): boolean {
  return f === "win32" ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) : p.startsWith("/");
}

/** Everything the path rules need about the target and the task. */
export interface PathEnv {
  flavour: PathFlavour;
  /** The target's OS (macOS: case-insensitive like Windows). */
  os: OS;
  /** The target's home, or null when it isn't known (a distro reached through wsl.exe without its facts). */
  home: string | null;
  /** The task's folder (the work tree's root, §3.4.6), or null when unknown. */
  cwd: string | null;
  /** WSL's drive mounts ("/mnt") when the target is a distro; null elsewhere. */
  mountRoot: string | null;
  /** The Windows side (a WSL target's, or a Windows target's own built from its home). */
  windows: WindowsContext | null;
  /** Ember's own paths on the target, in this flavour (built-ins added by pathEnv). */
  ember: string[];
  /** Folders that count as temporary (built-ins added by pathEnv). */
  temp: string[];
}

/** Builds a PathEnv, adding the built-in Ember and temporary folders. */
export function pathEnv(o: {
  flavour: PathFlavour; os: OS; home: string | null; cwd: string | null; mountRoot?: string | null;
  windows?: WindowsContext | null; ember?: string[]; tempDirs?: string[];
}): PathEnv {
  const mountRoot = o.mountRoot ? trimPosix(o.mountRoot) : null;
  const ember: string[] = [];
  const temp: string[] = [];
  const add = (list: string[], p: string | null | undefined): void => { if (p) list.push(p); };
  if (o.flavour === "posix") {
    for (const p of ["/etc/ember", "/opt/ember", "/var/log/ember-remote", "/Library/Application Support/Ember", "/Applications/Ember.app"]) add(ember, p);
    if (o.home) {
      for (const r of [".config/ember", ".local/state/ember-remote", "Library/Application Support/ember", "Library/Application Support/Ember Remote"]) add(ember, `${o.home}/${r}`);
    }
    temp.push("/tmp", "/var/tmp");
    if (o.os === "darwin") temp.push("/private/tmp", "/private/var/folders", "/var/folders");
    if (mountRoot && o.windows) {
      for (const w of [...windowsEmberBuiltins(o.windows), ...o.windows.emberPaths]) add(ember, toMount(w, mountRoot));
      add(temp, toMount(o.windows.temp, mountRoot));
    }
  } else {
    const w = o.windows;
    if (w) {
      for (const p of [...windowsEmberBuiltins(w), ...w.emberPaths]) add(ember, p);
      add(temp, w.temp);
    }
  }
  for (const p of o.ember ?? []) add(ember, p);
  for (const p of o.tempDirs ?? []) add(temp, p);
  return { flavour: o.flavour, os: o.os, home: o.home, cwd: o.cwd, mountRoot, windows: o.windows ?? null, ember, temp };
}

/** Ember's own Windows folders that hold whatever its WindowsContext didn't list. */
function windowsEmberBuiltins(w: WindowsContext): string[] {
  const drive = /^[A-Za-z]:/.exec(w.systemRoot)?.[0] ?? "C:";
  return [`${w.localAppData}\\ember`, `${drive}\\Program Files\\Ember`];
}

/** A Windows WindowsContext from a Windows target's home (the defaults of a profile). */
export function windowsContextOf(home: string, emberPaths: string[] = []): WindowsContext {
  return {
    home,
    localAppData: `${home}\\AppData\\Local`,
    appData: `${home}\\AppData\\Roaming`,
    temp: `${home}\\AppData\\Local\\Temp`,
    systemRoot: `${/^[A-Za-z]:/.exec(home)?.[0] ?? "C:"}\\Windows`,
    emberPaths,
  };
}

/** A Windows path in its WSL drive-mount form: `C:\Users\ana` → `/mnt/c/Users/ana`. Non-drive paths stay as they are. */
export function toMount(p: string, mountRoot: string): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (!m) return p;
  const rest = m[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return trimPosix(`${trimPosix(mountRoot)}/${m[1].toLowerCase()}${rest ? `/${rest}` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing paths.

/** Whether comparisons on `p` ignore case: Windows, macOS, and WSL drive mounts (drvfs is case-insensitive). */
function caseless(p: string, env: PathEnv): boolean {
  if (env.flavour === "win32" || env.os === "darwin") return true;
  return env.mountRoot !== null && (p === env.mountRoot || p.startsWith(`${env.mountRoot}/`));
}

const sep = (env: PathEnv): string => (env.flavour === "win32" ? "\\" : "/");

/** The comparison form of a path. */
function key(p: string, env: PathEnv, ci = caseless(p, env)): string {
  const s = env.flavour === "win32" ? p.replace(/\//g, "\\") : p;
  return ci ? s.toLowerCase() : s;
}

/** `p` is `base` or inside it (both absolute, same flavour). */
export function isUnder(p: string, base: string, env: PathEnv): boolean {
  const ci = caseless(p, env) || caseless(base, env);
  const a = key(p, env, ci);
  const b = key(base, env, ci);
  if (a === b) return true;
  const s = sep(env);
  return a.startsWith(b.endsWith(s) ? b : b + s);
}

/** Every home folder whose secrets count: the target's own, and any user's (another account's keys are secrets too). */
function homePatterns(env: PathEnv): string[] {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (env.flavour === "win32") {
    const list = ["[a-z]:\\\\users\\\\[^\\\\]+"];
    if (env.home) list.unshift(esc(env.home.toLowerCase()));
    return list;
  }
  const list = ["/home/[^/]+", "/users/[^/]+", "/root", "/var/root"];
  if (env.home) list.unshift(esc(env.home));
  if (env.mountRoot) list.push(`${esc(env.mountRoot)}/[a-z]/users/[^/]+`);
  return list;
}

// ---------------------------------------------------------------------------------------------------------------
// The lists (§3.6.1, §3.5.5, §3.6.2). Relative entries are under a home; "*" matches within one segment.

/** POSIX secret paths relative to a home (a trailing "/" marks a folder). */
const SECRET_HOME_POSIX = [
  ".ssh/", ".gnupg/", ".aws/", ".azure/", ".kube/", ".config/gh/", ".config/hub", ".docker/config.json", ".netrc",
  "_netrc", ".npmrc", ".yarnrc.yml", ".pypirc", ".git-credentials", ".config/git/credentials", ".pgpass", ".my.cnf",
  ".vault-token", ".terraform.d/credentials.tfrc.json", ".cargo/credentials", ".cargo/credentials.toml",
  ".gem/credentials", ".m2/settings-security.xml", ".gradle/gradle.properties", ".config/rclone/rclone.conf",
  ".local/share/keyrings/", ".password-store/", ".config/Bitwarden*/", ".config/1Password/", ".mozilla/",
  "snap/firefox/", ".config/google-chrome/", ".config/chromium/", ".config/BraveSoftware/", ".config/microsoft-edge/",
  ".thunderbird/", ".local/share/ember*",
  // macOS.
  "Library/Keychains/", "Library/Cookies/", "Library/Application Support/Google/Chrome/",
  "Library/Application Support/Firefox/", "Library/Application Support/1Password/",
];

/** Windows secret paths relative to a profile (also judged under WSL's drive mounts). */
const SECRET_HOME_WINDOWS = [
  "AppData/Roaming/Microsoft/Credentials/", "AppData/Local/Microsoft/Credentials/", "AppData/Roaming/Microsoft/Protect/",
  "AppData/Local/Google/Chrome/User Data/", "AppData/Local/Microsoft/Edge/User Data/",
  "AppData/Roaming/Mozilla/Firefox/Profiles/", "AppData/Roaming/gh/", "AppData/Roaming/GitHub CLI/", ".ssh/", ".aws/",
  ".azure/", ".kube/", ".docker/config.json", "_netrc", ".npmrc", ".git-credentials",
];

/** A Windows profile holds both lists' secrets (a Windows build of OpenSSH, the AWS CLI and git keep the POSIX names). */
const SECRET_HOME_EITHER = [...SECRET_HOME_WINDOWS, ...SECRET_HOME_POSIX];

/** Shell and tool history (critique security-11), relative to a home. */
const HISTORY_HOME = [".local/share/fish/fish_history", ".zsh_sessions/", "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/"];
/** History file names, judged anywhere. */
const HISTORY_NAMES = new Set([
  ".bash_history", ".zsh_history", ".zhistory", ".sh_history", ".history", ".python_history", ".node_repl_history",
  ".psql_history", ".mysql_history", ".sqlite_history", ".rediscli_history", ".lesshst", ".viminfo", ".irb_history",
  ".rhistory", "fish_history", "consolehost_history.txt",
]);

/** Absolute POSIX secret paths. */
const SECRET_ABSOLUTE_POSIX = [
  "/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-", "/etc/sudoers", "/etc/sudoers.d/", "/root/",
  "/var/lib/sss/", "/etc/krb5.keytab", "/Library/Keychains/", "/proc/*/environ", "/etc/ssh/ssh_host_*_key",
  // Keyboards and mice as devices: reading one records what is typed, passwords included.
  "/dev/input/",
];

/** Secret basenames anywhere (§3.6.1). */
function secretBasename(name: string, ci: boolean): boolean {
  const n = ci ? name.toLowerCase() : name;
  const l = n.toLowerCase();
  if (l === ".env") return true;
  if (/^\.env\./.test(l)) return !/^\.env\.(example|sample|template|dist)$/.test(l);
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate)$/.test(l) || /\.tfstate\./.test(l)) return true;
  if (/^id_(rsa|ecdsa|ed25519|dsa)/.test(l)) return !l.endsWith(".pub");
  if (l === "credentials.json" || /^secrets\.ya?ml$/.test(l)) return true;
  return false;
}

/** Shell start-up and environment files (critique security-4), relative to a home. */
const STARTUP_HOME = [
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile", ".zshrc", ".zprofile",
  ".zshenv", ".zlogin", ".zlogout", ".kshrc", ".cshrc", ".tcshrc", ".login", ".inputrc", ".config/fish/config.fish",
  ".config/fish/conf.d/", ".config/fish/functions/", ".config/environment.d/", ".pam_environment", ".xprofile",
  ".xinitrc", ".xsession*", ".local/share/bash-completion/", ".zfunc/", ".oh-my-zsh/custom/", ".config/zsh/",
  ".config/powershell/",
];
const STARTUP_ABSOLUTE = [
  "/etc/profile", "/etc/profile.d/", "/etc/bash.bashrc", "/etc/bashrc", "/etc/zsh*", "/etc/zprofile", "/etc/zshrc",
  "/etc/environment",
];
/** PowerShell's profile files, wherever Documents is (OneDrive too) and in $PSHOME. */
const PS_PROFILE = /(^|[\\/])(windows)?powershell[\\/][^\\/]*profile\.ps1$/i;

/** Autostart and scheduling folders. */
const AUTOSTART_HOME = [
  ".config/autostart/", "Library/LaunchAgents/", ".config/systemd/user/",
  "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/",
];
const AUTOSTART_ABSOLUTE = ["/etc/systemd/", "/Library/LaunchAgents/", "/Library/LaunchDaemons/", "/etc/cron*", "/var/spool/cron/", "/etc/xdg/autostart/"];

/** System locations (writes are class e). */
const SYSTEM_POSIX = ["/etc/", "/usr/", "/bin/", "/sbin/", "/lib*/", "/boot/", "/opt/", "/var/", "/Library/", "/System/", "/dev/"];
/** Under /var and /dev, what is everyday output, not a system file. */
const NOT_SYSTEM_POSIX = ["/var/tmp/", "/var/folders/", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/", "/dev/pts/", "/dev/shm/", "/dev/zero"];
const SYSTEM_WINDOWS = ["Windows/", "Program Files*/", "ProgramData/"];

/** A disk or partition device (an overwrite erases a disk). */
const DISK_DEVICE = /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d|rdisk\d|mapper\/|dm-\d|loop\d|md\d|sr\d)/;
const DISK_DEVICE_WIN = /^\\\\\.\\(physicaldrive\d+|[a-z]:$)/i;

/** git's own settings files in a home (any setting may run code: §3.4.8), relative to a home. */
const GIT_CONFIG_HOME = [".gitconfig", ".config/git/config"];
/** A repository's own settings (`.git/config`, a submodule's `.git/modules/…/config`), in any folder. */
const GIT_CONFIG_FILE = /(^|[\\/])\.git[\\/](modules[\\/].+[\\/])?config$/i;

/** WSL's own configuration (critique wsl-22), relative to a Windows profile. */
const WSL_CONFIG_HOME = [".wslconfig", ".wslgconfig"];

/** A list entry as a regular expression source over `root` + `/` + entry ("*" within a segment; "/" at the end: a folder). */
function entrySource(entry: string, s: string): string {
  const body = entry
    .replace(/\/$/, "")
    .split("/")
    .map(seg => seg.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(s === "\\" ? "[^\\\\]*" : "[^/]*"))
    .join(s === "\\" ? "\\\\" : "/");
  return `${body}(?:${s === "\\" ? "\\\\" : "/"}|$)`;
}

/** Compiled entry lists, per list (the lists are module constants) and per roots, separator and case rule. */
const ENTRY_RES = new WeakMap<readonly string[], Map<string, RegExp>>();

function entriesRegExp(entries: readonly string[], k: string, make: () => RegExp): RegExp {
  let m = ENTRY_RES.get(entries);
  if (!m) { m = new Map(); ENTRY_RES.set(entries, m); }
  let re = m.get(k);
  if (!re) {
    if (m.size >= 32) m.clear();
    re = make();
    m.set(k, re);
  }
  return re;
}

/** Whether `p` lies under `root/entry` for one of the entries (roots are regular expression sources). */
function underEntries(p: string, roots: string[], entries: readonly string[], env: PathEnv, ci: boolean): boolean {
  const s = sep(env);
  const re = entriesRegExp(entries, `${ci ? "i" : "c"}${s}${roots.join("|")}`, () => {
    const parts = entries.map(e => entrySource(e, s));
    return new RegExp(`^(?:${roots.join("|")})${s === "\\" ? "\\\\" : "/"}(?:${parts.join("|")})`, ci ? "i" : "");
  });
  return re.test(key(p, env, ci));
}

/** Whether `p` lies under an absolute entry (POSIX). */
function underAbsolute(p: string, entries: readonly string[], ci: boolean): boolean {
  const re = entriesRegExp(entries, ci ? "i/" : "c/", () =>
    new RegExp(`^/(?:${entries.map(e => entrySource(e.replace(/^\//, ""), "/")).join("|")})`, ci ? "i" : ""));
  return re.test(p);
}

/** The basename of a path in its flavour. */
export function baseName(p: string, f: PathFlavour): string {
  return f === "win32" ? win32.basename(p) : posix.basename(p);
}

/** A `\\wsl.localhost\<D>\…`, `\\wsl$\<D>\…` or `\\?\UNC\wsl…` path as (distro, POSIX path), else null. */
export function wslUncPath(p: string): { distro: string; path: string } | null {
  const m = /^[\\/]{2}(?:\?[\\/]unc[\\/])?(wsl\.localhost|wsl\$)[\\/]([^\\/]+)((?:[\\/].*)?)$/i.exec(p);
  if (!m) return null;
  const rest = m[3].replace(/\\/g, "/");
  return { distro: m[2], path: posix.normalize(rest || "/") };
}

/** Why Ember can't tell which file a Windows-form path names (§3.4.4), or null. */
export function opaqueWindowsPath(raw: string): string | null {
  if (wslUncPath(raw)) return null;
  if (/^[\\/]{2}\?[\\/]/.test(raw)) return "device";
  if (/^[\\/]{2}\.[\\/]/.test(raw)) return "device";
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]*\$(?:[\\/]|$)/.test(raw)) return "admin-share";
  if (/^[\\/]{2}(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(?:[\\/]|$)/i.test(raw)) return "admin-share";
  return null;
}

/** A Windows 8.3 short name segment (`ANA~1`, `PROGRA~1`) in a path. */
export const SHORT_NAME = /(^|[\\/])[^\\/]*~\d[^\\/]*(?=[\\/]|$)/;

// ---------------------------------------------------------------------------------------------------------------
// The rules.

/** How a command uses a path. */
export type PathUse =
  | "read" | "readTree" | "write" | "append" | "delete" | "deleteTree" | "move" | "permTree" | "cd" | "exec" | "list";

/** A path rule that applies: a finding to add, or a refusal. */
export interface PathVerdict {
  kind: "secret" | "history" | "ember" | "startup" | "hook" | "git-config" | "wsl-config" | "system" | "autostart" | "disk";
}

/** Uses that change the path (writes, deletes, moves). */
export const WRITES: ReadonlySet<PathUse> = new Set<PathUse>(["write", "append", "delete", "deleteTree", "move", "permTree"]);

const EMBER_SHARE = [".local/share/ember*"];

/** Whether `p` is one of Ember's own paths or inside one (D4.5). */
export function isEmberPath(p: string, env: PathEnv): boolean {
  if (env.ember.some(e => isUnder(p, e, env))) return true;
  if (env.flavour === "posix" && env.home) {
    // ~/.local/share/ember* (the secret list's last entry, refused first).
    if (underEntries(p, [env.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], EMBER_SHARE, env, caseless(p, env))) return true;
  }
  // A distro whose home Ember doesn't know (reached from Windows): Ember's folders in any home.
  if (env.flavour === "posix" && !env.home && ANY_HOME_EMBER.test(p)) return true;
  return false;
}

/** Ember's folders under a POSIX home, in any home (`/home/<user>/…`, `/root/…`). */
const ANY_HOME_EMBER = /^\/(home\/[^/]+|root)\/(\.config\/ember|\.local\/state\/ember-remote|\.local\/share\/ember[^/]*)(\/|$)/;
/** The folders above them, when the home isn't known: `/`, `/home`, a home, its `.config`, `.local` and `.local/state`. */
const ANY_HOME_EMBER_ABOVE = /^\/((home(\/[^/]+(\/(\.config|\.local(\/(state|share))?))?)?|root(\/(\.config|\.local(\/(state|share))?))?)\/?)?$/;

/** Whether `p` is an ancestor of one of Ember's own paths (deleting, moving or re-permissioning it reaches Ember's). */
export function holdsEmberPath(p: string, env: PathEnv): boolean {
  if (env.flavour === "posix" && !env.home && ANY_HOME_EMBER_ABOVE.test(p)) return true;
  return env.ember.some(e => isUnder(e, p, env) && !isUnder(p, e, env));
}

/** Whether `p` is a secret path for this use, and which kind (history files have their own words). */
export function secretKind(p: string, use: PathUse, env: PathEnv): "secret" | "history" | null {
  // Listing names or entering a folder reads no secret (find's starts are judged by find's own rule).
  if (use === "list" || use === "cd") return null;
  const ci = caseless(p, env);
  const homes = homePatterns(env);
  const name = baseName(p, env.flavour);
  const lname = name.toLowerCase();
  if (HISTORY_NAMES.has(lname)) return "history";
  if (env.flavour === "win32") {
    const w = wslUncPath(p);
    if (w) return secretKind(w.path, use, { ...env, flavour: "posix", os: "linux", home: null, mountRoot: null });
    if (underEntries(p, homes, HISTORY_HOME, env, true)) return "history";
    if (underEntries(p, homes, SECRET_HOME_EITHER, env, true)) return sshReadOk(p, use, env) ? null : "secret";
    const sysRoot = env.windows?.systemRoot ?? "C:\\Windows";
    if (isUnder(p, `${sysRoot}\\System32\\config`, env)) return "secret";
    return secretBasename(name, true) ? "secret" : null;
  }
  if (underEntries(p, homes, HISTORY_HOME, env, ci)) return "history";
  if (underEntries(p, homes, SECRET_HOME_POSIX, env, ci)) return sshReadOk(p, use, env) ? null : "secret";
  if (env.mountRoot && underEntries(p, [`${env.mountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z]/users/[^/]+`], SECRET_HOME_WINDOWS, env, true)) {
    return sshReadOk(p, use, env) ? null : "secret";
  }
  if (underAbsolute(p, SECRET_ABSOLUTE_POSIX, ci)) return /\.pub$/.test(lname) && p.startsWith("/etc/ssh/") ? null : "secret";
  if (env.mountRoot && caseless(p, env)) {
    // C:\Windows\System32\config under the drive mounts.
    if (new RegExp(`^${env.mountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z]/windows/system32/config(/|$)`, "i").test(p)) return "secret";
  }
  return secretBasename(name, ci) ? "secret" : null;
}

/** Reading `~/.ssh/*.pub`, `known_hosts` and `config` is allowed (§3.6.1); everything else under .ssh isn't. */
function sshReadOk(p: string, use: PathUse, env: PathEnv): boolean {
  if (use !== "read" && use !== "list" && use !== "cd") return false;
  const segs = p.split(/[\\/]/);
  const i = segs.map(s => s.toLowerCase()).lastIndexOf(".ssh");
  if (i < 0) return false;
  if (use === "list" || use === "cd") return i === segs.length - 1 || segs.length - 1 === i;
  if (i !== segs.length - 2) return false;
  const name = segs[segs.length - 1].toLowerCase();
  return name.endsWith(".pub") || name === "known_hosts" || name === "config" || (env.flavour === "win32" && name === "known_hosts");
}

/** Whether `p` holds a secret path below it (an archive, copy, upload or recursive search of it reads secrets). */
export function holdsSecret(p: string, env: PathEnv): boolean {
  const candidates = secretCandidates(env);
  return candidates.some(c => isUnder(c, p, env));
}

const CANDIDATES = new WeakMap<PathEnv, readonly string[]>();

/** Concrete secret paths to test globs and folders against (worked out once per environment). */
export function secretCandidates(env: PathEnv): readonly string[] {
  let list = CANDIDATES.get(env);
  if (!list) { list = makeCandidates(env); CANDIDATES.set(env, list); }
  return list;
}

function makeCandidates(env: PathEnv): string[] {
  const out: string[] = [];
  const s = sep(env);
  if (env.home) {
    const rel = env.flavour === "win32" ? [...SECRET_HOME_WINDOWS, ...SECRET_HOME_POSIX] : SECRET_HOME_POSIX;
    for (const e of [...rel, ...HISTORY_HOME]) {
      const clean = e.replace(/\*/g, "x").replace(/\/$/, "/x");
      out.push(env.home + s + (env.flavour === "win32" ? clean.replace(/\//g, "\\") : clean));
    }
    for (const n of HISTORY_NAMES) out.push(env.home + s + n);
  }
  if (env.flavour === "posix") {
    for (const e of SECRET_ABSOLUTE_POSIX) out.push(e.replace(/\*/g, "x").replace(/\/$/, "/x"));
  } else {
    out.push(`${env.windows?.systemRoot ?? "C:\\Windows"}\\System32\\config\\SAM`);
  }
  return out;
}

/** Basenames that are secrets anywhere: a glob's last segment that matches one of them names secrets. */
export const SECRET_SAMPLE_NAMES = [
  ".env", ".env.local", ".env.production", "server.pem", "server.key", "cert.p12", "cert.pfx", "keys.jks",
  "app.keystore", "id_rsa", "id_ecdsa", "id_ed25519", "id_dsa", "vault.kdbx", "credentials.json", "secrets.yaml",
  "secrets.yml", "terraform.tfstate", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".bash_history",
  ".zsh_history", ".python_history",
];

/** Which start-up, hook, WSL, autostart or system rule a write to `p` meets, or null. */
export function writeKind(p: string, env: PathEnv): PathVerdict["kind"] | null {
  const ci = caseless(p, env);
  const homes = homePatterns(env);
  if (/(^|[\\/])\.git[\\/]hooks([\\/]|$)/i.test(p)) return "hook";
  if (GIT_CONFIG_FILE.test(p) || underEntries(p, homes, GIT_CONFIG_HOME, env, true)) return "git-config";
  if (PS_PROFILE.test(p)) return "startup";
  if (env.flavour === "win32") {
    if (underEntries(p, homes, WSL_CONFIG_HOME, env, true)) return "wsl-config";
    if (underEntries(p, homes, AUTOSTART_HOME, env, true)) return "autostart";
    if (underEntries(p, homes, STARTUP_HOME, env, true)) return "startup";
    if (DISK_DEVICE_WIN.test(p)) return "disk";
    const drive = /^[A-Za-z]:/.exec(env.windows?.systemRoot ?? "C:")?.[0] ?? "C:";
    if (underEntries(p, [drive.toLowerCase()], SYSTEM_WINDOWS, env, true)) return "system";
    if (env.windows && isUnder(p, env.windows.systemRoot, env)) return "system";
    return null;
  }
  if (underEntries(p, homes, STARTUP_HOME, env, ci) || underAbsolute(p, STARTUP_ABSOLUTE, ci)) return "startup";
  if (p === "/etc/wsl.conf") return "wsl-config";
  if (env.mountRoot && underEntries(p, [`${env.mountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z]/users/[^/]+`], WSL_CONFIG_HOME, env, true)) return "wsl-config";
  if (underEntries(p, homes, AUTOSTART_HOME, env, ci) || underAbsolute(p, AUTOSTART_ABSOLUTE, ci)) return "autostart";
  if (env.mountRoot && underEntries(p, [`${env.mountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z]/users/[^/]+`], AUTOSTART_HOME, env, true)) return "autostart";
  if (DISK_DEVICE.test(p)) return "disk";
  if (underAbsolute(p, NOT_SYSTEM_POSIX, false)) return null;
  if (underAbsolute(p, SYSTEM_POSIX, env.os === "darwin")) return "system";
  if (env.mountRoot && underEntries(p, [`${env.mountRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z]`], SYSTEM_WINDOWS, env, true)) return "system";
  return null;
}

/** Whether `p` is in a temporary folder (§3.4.6). */
export function isTemp(p: string, env: PathEnv): boolean {
  return env.temp.some(t => isUnder(p, t, env));
}

/**
 * Whether `p` is inside the work tree (§3.4.6): the task's folder and below, unless that folder is the home folder or
 * one of its ancestors (`/`, `/home`, `C:\`, `C:\Users`), in which case it is empty; temporary folders always count.
 */
export function inWorkTree(p: string, env: PathEnv): boolean {
  if (isTemp(p, env)) return true;
  if (!env.cwd) return false;
  if (env.home && isUnder(env.home, env.cwd, env)) return false;
  if (env.flavour === "posix" && (env.cwd === "/" || /^\/(home|Users)$/.test(env.cwd))) return false;
  if (env.flavour === "win32" && (/^[A-Za-z]:\\?$/.test(env.cwd) || /^[A-Za-z]:\\users$/i.test(env.cwd))) return false;
  return isUnder(p, env.cwd, env);
}

/** Whether `p` is a dot file directly in the home folder. */
export function homeDotFile(p: string, env: PathEnv): boolean {
  if (!env.home) return false;
  const parent = env.flavour === "win32" ? win32.dirname(p) : posix.dirname(p);
  return key(parent, env) === key(env.home, env) && baseName(p, env.flavour).startsWith(".");
}

/** Whether `p` is a root, the home folder or one of its ancestors, or an ancestor of the cwd. */
export function isBroadPath(p: string, env: PathEnv): boolean {
  if (env.flavour === "posix" ? p === "/" : /^[A-Za-z]:\\?$/.test(p) || /^\\\\[^\\]+\\[^\\]+$/.test(p)) return true;
  if (env.home && isUnder(env.home, p, env)) return true;
  if (env.cwd && isUnder(env.cwd, p, env)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Globs.

/**
 * A glob as a regular expression over absolute paths: `*` and `?` within a segment, `[…]` classes (`!` or `^` negates),
 * `**` across segments; backslash-escaped characters literal (POSIX). `dotRule`: POSIX shells' `*`, `?` and `[` don't
 * match a leading dot.
 */
export function globRegExp(pattern: string, env: PathEnv, dotRule: boolean): RegExp {
  const s = sep(env);
  const notSep = s === "\\" ? "[^\\\\/]" : "[^/]";
  let out = "";
  let segStart = true;
  for (let k = 0; k < pattern.length; k++) {
    const c = pattern[k];
    if (c === "\\" && env.flavour === "posix" && k + 1 < pattern.length) {
      out += pattern[k + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      k++;
      segStart = false;
      continue;
    }
    if (c === "*" && pattern[k + 1] === "*") {
      out += ".*";
      k++;
      segStart = false;
      continue;
    }
    if (c === "*" || c === "?") {
      const lead = segStart && dotRule ? "(?!\\.)" : "";
      out += lead + (c === "*" ? `${notSep}*` : notSep);
      segStart = false;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", k + 2);
      if (end > k) {
        let body = pattern.slice(k + 1, end);
        if (body.startsWith("!") || body.startsWith("^")) body = `^${body.slice(1)}`;
        out += `${segStart && dotRule ? "(?!\\.)" : ""}[${body.replace(/\\/g, "\\\\")}]`;
        k = end;
        segStart = false;
        continue;
      }
    }
    if (c === "/" || (c === "\\" && env.flavour === "win32")) {
      out += s === "\\" ? "[\\\\/]" : "/";
      segStart = true;
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    segStart = false;
  }
  return new RegExp(`^${out}$`, caseless(pattern, env) ? "i" : "");
}

/** One segment of a pattern: a literal name, a wildcard name, or `**` (any run of segments). */
type SegPat = { lit: string; re: null } | { lit: null; re: RegExp; head: string } | "**";

/** A segment pattern (`*` and `?` within the segment, `[…]` classes); `dotRule`: a leading wildcard skips dot names. */
function segPat(seg: string, ci: boolean, dotRule: boolean, posixEscapes: boolean): SegPat {
  if (seg === "**") return "**";
  let out = "";
  let head = "";
  let wild = false;
  let lit = "";
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (c === "\\" && posixEscapes && k + 1 < seg.length) {
      const n = seg[++k];
      out += n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      lit += n;
      if (!wild) head += n;
      continue;
    }
    if (c === "*" || c === "?") {
      out += (k === 0 && dotRule ? "(?!\\.)" : "") + (c === "*" ? "[^\\\\/]*" : "[^\\\\/]");
      wild = true;
      continue;
    }
    if (c === "[") {
      const end = seg.indexOf("]", k + 2);
      if (end > k) {
        let body = seg.slice(k + 1, end);
        if (body.startsWith("!") || body.startsWith("^")) body = `^${body.slice(1)}`;
        out += `${k === 0 && dotRule ? "(?!\\.)" : ""}[${body.replace(/\\/g, "\\\\")}]`;
        k = end;
        wild = true;
        continue;
      }
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    lit += c;
    if (!wild) head += c;
  }
  if (!wild) return { lit: ci ? lit.toLowerCase() : lit, re: null };
  return { lit: null, re: new RegExp(`^${out}$`, ci ? "i" : ""), head: ci ? head.toLowerCase() : head };
}

/** Whether two segment patterns can name the same name (conservative when both hold wildcards). */
function segsMeet(a: SegPat, b: SegPat): boolean {
  if (a === "**" || b === "**") return true;
  if (a.lit !== null && b.lit !== null) return a.lit === b.lit;
  if (a.lit !== null) return (b as { re: RegExp }).re.test(a.lit);
  if (b.lit !== null) return a.re.test(b.lit);
  // Both wildcards: they can meet unless their fixed beginnings differ.
  const ha = a.head;
  const hb = (b as { head: string }).head;
  return ha.startsWith(hb) || hb.startsWith(ha);
}

/** An absolute path or pattern as segment patterns (POSIX: leading "" for the root; Windows: the drive first). */
function patSegs(p: string, env: PathEnv, ci: boolean, dotRule: boolean): SegPat[] {
  const parts = (env.flavour === "win32" ? p.replace(/\//g, "\\").split("\\") : p.split("/")).filter((s, k) => k === 0 || s !== "");
  return parts.map(s => segPat(s, ci, dotRule, env.flavour === "posix"));
}

/**
 * Whether a glob may name `entry` (a folder, when `folder`) or something inside it; `ancestors`: also a folder above
 * it (a recursive read or a tree delete of that folder reaches the entry).
 */
function globMeets(g: SegPat[], e: SegPat[], folder: boolean, ancestors: boolean): boolean {
  const star = g.indexOf("**");
  const upto = star >= 0 ? star : g.length;
  for (let k = 0; k < Math.min(upto, e.length); k++) if (!segsMeet(g[k], e[k])) return false;
  if (star >= 0) return true;
  if (g.length === e.length) return true;
  if (g.length > e.length) return folder;
  return ancestors;
}

/** The secret entries of §3.6.1 as absolute patterns for this environment (`*` within a segment), folders marked. */
function secretEntries(env: PathEnv): { p: string; folder: boolean }[] {
  const out: { p: string; folder: boolean }[] = [];
  const s = sep(env);
  const add = (root: string, entry: string): void => {
    const folder = entry.endsWith("/");
    const rel = entry.replace(/\/$/, "");
    out.push({ p: root + s + (s === "\\" ? rel.replace(/\//g, "\\") : rel), folder });
  };
  if (env.flavour === "win32") {
    const homes = ["?:\\Users\\*"];
    if (env.home) homes.unshift(env.home);
    for (const h of homes) for (const e of [...SECRET_HOME_EITHER, ...HISTORY_HOME]) add(h, e);
    out.push({ p: `${env.windows?.systemRoot ?? "C:\\Windows"}\\System32\\config`, folder: true });
    return out;
  }
  const homes = ["/home/*", "/Users/*", "/root", "/var/root"];
  if (env.home) homes.unshift(env.home);
  for (const h of homes) for (const e of [...SECRET_HOME_POSIX, ...HISTORY_HOME]) add(h, e);
  if (env.mountRoot) {
    for (const e of [...SECRET_HOME_WINDOWS, ...HISTORY_HOME]) add(`${env.mountRoot}/?/Users/*`, e);
    out.push({ p: `${env.mountRoot}/?/Windows/System32/config`, folder: true });
  }
  for (const e of SECRET_ABSOLUTE_POSIX) out.push({ p: e.replace(/\/$/, ""), folder: e.endsWith("/") });
  return out;
}

/**
 * What a glob may reach (§3.6: a pattern can't be probed, so it is judged by every name it could match): a secret
 * (a §3.6.1 folder or file, or a secret or history file name as its last segment, unless that segment matches
 * anything), or one of Ember's own paths (one of them or inside one; with `tree`, a folder holding one too).
 * `absPattern` is absolute in the env's flavour; `dotRule`: POSIX shells' wildcards skip a leading dot.
 */
export function globReaches(absPattern: string, use: PathUse, env: PathEnv, dotRule: boolean): { secret: boolean; ember: boolean } {
  const ci = caseless(globPrefix(absPattern, env), env);
  const g = patSegs(absPattern, env, ci, dotRule);
  const tree = use === "deleteTree" || use === "move" || use === "permTree";
  let ember = false;
  for (const e of env.ember) {
    if (globMeets(g, patSegs(e, env, ci || caseless(e, env), false), true, tree)) { ember = true; break; }
  }
  let secret = false;
  if (use !== "list" && use !== "cd") {
    // Secrets are matched without regard to case (the stricter reading on a case-sensitive system).
    const gi = patSegs(absPattern, env, true, dotRule);
    for (const e of compiledSecretEntries(env)) {
      if (globMeets(gi, e.segs, e.folder, use === "readTree")) { secret = true; break; }
    }
    const last = gi[gi.length - 1];
    const catchAll = last === "**" || (last.lit === null && /^[*?]*(\.\*)?$/.test(absPattern.split(/[\\/]/).pop() ?? ""));
    if (!secret && !catchAll) {
      // Dot-file history names only: `*.txt` says nothing about PowerShell's ConsoleHost_history.txt.
      secret = [...SECRET_SAMPLE_NAMES, ...[...HISTORY_NAMES].filter(n => n.startsWith("."))].some(n => segsMeet(last, { lit: n.toLowerCase(), re: null }));
    }
  }
  return { secret, ember };
}

/** The write rules of §3.5.5 as absolute patterns (start-up files, git hooks and settings, WSL's settings, autostart). */
function writeEntries(env: PathEnv): { p: string; folder: boolean; kind: NonNullable<ReturnType<typeof writeKind>> }[] {
  const out: { p: string; folder: boolean; kind: NonNullable<ReturnType<typeof writeKind>> }[] = [];
  const s = sep(env);
  const join = (root: string, entry: string): string => root + s + (s === "\\" ? entry.replace(/\//g, "\\") : entry);
  const homes = env.flavour === "win32" ? ["?:\\Users\\*"] : ["/home/*", "/Users/*", "/root"];
  if (env.home) homes.unshift(env.home);
  for (const h of homes) {
    for (const e of STARTUP_HOME) out.push({ p: join(h, e.replace(/\/$/, "")), folder: e.endsWith("/"), kind: "startup" });
    for (const e of AUTOSTART_HOME) out.push({ p: join(h, e.replace(/\/$/, "")), folder: true, kind: "autostart" });
    for (const e of GIT_CONFIG_HOME) out.push({ p: join(h, e), folder: false, kind: "git-config" });
    if (env.flavour === "win32") {
      for (const e of WSL_CONFIG_HOME) out.push({ p: join(h, e), folder: false, kind: "wsl-config" });
      for (const d of ["Documents", "OneDrive*/Documents"]) for (const ps of ["WindowsPowerShell", "PowerShell"]) out.push({ p: join(h, `${d}/${ps}/*profile.ps1`), folder: false, kind: "startup" });
    }
  }
  if (env.flavour === "posix") {
    for (const e of STARTUP_ABSOLUTE) out.push({ p: e.replace(/\/$/, ""), folder: e.endsWith("/"), kind: "startup" });
    for (const e of AUTOSTART_ABSOLUTE) out.push({ p: e.replace(/\/$/, ""), folder: true, kind: "autostart" });
    out.push({ p: "/etc/wsl.conf", folder: false, kind: "wsl-config" });
    if (env.mountRoot) for (const e of WSL_CONFIG_HOME) out.push({ p: `${env.mountRoot}/?/Users/*/${e}`, folder: false, kind: "wsl-config" });
  }
  return out;
}

/**
 * The write rule a glob may meet (§3.5.5, §3.4.8): a start-up file, a git hook or git's own settings (in any folder),
 * WSL's settings or an autostart folder; null when none. System locations are judged on the fixed folder.
 */
export function globWriteKind(absPattern: string, env: PathEnv, dotRule: boolean): NonNullable<ReturnType<typeof writeKind>> | null {
  const g = patSegs(absPattern, env, true, dotRule);
  // `.git/hooks/…` and `.git/config` anywhere: a pair of segments the pattern may name.
  const dotGit = segPat(".git", true, false, false);
  for (let k = 0; k + 1 < g.length; k++) {
    if (!segsMeet(g[k], dotGit)) continue;
    if (segsMeet(g[k + 1], segPat("hooks", true, false, false)) && (g.length > k + 2 || g[k + 1] === "**")) return "hook";
    if (k + 2 === g.length && segsMeet(g[k + 1], segPat("config", true, false, false))) return "git-config";
  }
  const key = `${env.flavour}\0${env.home ?? ""}\0${env.mountRoot ?? ""}`;
  let list = WRITE_SEGS.get(key);
  if (!list) {
    if (WRITE_SEGS.size >= 16) WRITE_SEGS.clear();
    list = writeEntries(env).map(e => ({ segs: patSegs(e.p, env, true, false), folder: e.folder, kind: e.kind }));
    WRITE_SEGS.set(key, list);
  }
  for (const e of list) if (globMeets(g, e.segs, e.folder, false)) return e.kind;
  return null;
}
const WRITE_SEGS = new Map<string, { segs: SegPat[]; folder: boolean; kind: NonNullable<ReturnType<typeof writeKind>> }[]>();

/** Compiled secret entries per environment shape (flavour, home, mounts, system root), a few kept. */
const SECRET_SEGS = new Map<string, { segs: SegPat[]; folder: boolean }[]>();
function compiledSecretEntries(env: PathEnv): { segs: SegPat[]; folder: boolean }[] {
  const k = `${env.flavour}\0${env.home ?? ""}\0${env.mountRoot ?? ""}\0${env.windows?.systemRoot ?? ""}`;
  let list = SECRET_SEGS.get(k);
  if (!list) {
    if (SECRET_SEGS.size >= 16) SECRET_SEGS.clear();
    list = secretEntries(env).map(e => ({ segs: patSegs(e.p, env, true, false), folder: e.folder }));
    SECRET_SEGS.set(k, list);
  }
  return list;
}

/** The fixed part of a glob before its first wildcard segment (a folder every match is inside). */
export function globPrefix(pattern: string, env: PathEnv): string {
  const s = env.flavour === "win32" ? /[\\/]/ : /\//;
  const segs = pattern.split(s);
  const fixed: string[] = [];
  for (const seg of segs) {
    if (/(^|[^\\])[*?[]/.test(seg) || (env.flavour === "win32" && /[*?[]/.test(seg))) break;
    fixed.push(env.flavour === "posix" ? seg.replace(/\\(.)/g, "$1") : seg);
  }
  const joined = fixed.join(sep(env));
  if (joined === "" && env.flavour === "posix") return "/";
  return joined || pattern;
}
