/**
 * Reaching the same user's desktop on a Linux remote (R2 option A; §5.3.4, critique remote-2, -9, -12..15): which
 * graphical session to use, whether it is locked, and its environment, decided from logind, the user's systemd manager
 * and /proc, never from the SSH login's own environment (its DISPLAY may be `ssh -X`'s tunnel back to the PC). Only a
 * session of this uid on a local seat (seat0, not remote: VNC and xrdp sessions are not used, L21), active, unlocked,
 * and the only such one. `loginctl` and `busctl` output is read as `Key=Value` lines by name (systemd prints properties
 * in D-Bus order and skips empty ones), and busctl's plain format (systemd 239, RHEL 8's, has no --json). Pure over
 * injected readers, so it is tested with captured output; the desktop child then verifies what this finds (X opens,
 * the sidecar answers, the X screensaver is off) before anything is read.
 */

import path from "node:path/posix";
import { appEnv } from "../main/hands/system";

/** The session variables a desktop child may take (§5.3.4 step 4); `LC_*` too. */
const SESSION_VARS = new Set(["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "GDMSESSION", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS", "GTK_MODULES", "LANG"]);
const sessionVar = (k: string) => SESSION_VARS.has(k) || /^LC_[A-Z_]+$/.test(k);
/** The agent's own variables a desktop child starts from (critique remote-15: without HOME and PATH, apps misbehave). */
const BASE_VARS = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG"];
/** A DISPLAY on this machine (no host part: `localhost:10.0` is ssh -X's tunnel back to the PC). */
export const LOCAL_DISPLAY = /^:\d+(\.\d+)?$/;
/** A Wayland socket's name in XDG_RUNTIME_DIR. */
const WAYLAND_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** What discoverDesktop reads of the machine. Every reader resolves null when it couldn't read. */
export interface DesktopIo {
  uid: number;
  /** This login's name, for the messages ("Ember can't tell which of deploy's two desktops to use."). */
  user: string;
  /** This machine's name, for the messages ("build-01's screen is locked."). */
  host: string;
  /** This login's home folder (~/.Xauthority). */
  home: string;
  /** `loginctl show-user <uid> -p Display -p Sessions`. */
  showUser(uid: number): Promise<string | null>;
  /** `loginctl show-session <id> -p Id -p User -p Type -p Class -p Active -p State -p Remote -p Seat -p Display -p LockedHint`. */
  showSession(id: string): Promise<string | null>;
  /** `busctl --user get-property org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Environment`. */
  managerEnvironment(): Promise<string | null>;
  /** `busctl --user call org.gnome.ScreenSaver /org/gnome/ScreenSaver org.gnome.ScreenSaver GetActive`; "absent" when no such service. */
  gnomeScreenSaver(): Promise<string | null | "absent">;
  /** This uid's processes. */
  processes(): Promise<number[]>;
  cgroup(pid: number): Promise<string | null>;
  environ(pid: number): Promise<Buffer | null>;
  /** Is `p` a socket owned by `uid`? */
  socketOwnedBy(p: string, uid: number): Promise<boolean>;
  exists(p: string): Promise<boolean>;
  /** Is Ember itself (the desktop app) running for this user on this machine (its single-instance lock)? */
  emberRunning(): Promise<boolean>;
}

/** A desktop this agent may use, and the session environment its child gets. */
export interface DesktopFound {
  access: "screen" | "text";
  session: { id: string; type: "x11" | "wayland"; locked: false; active: true };
  /** The allow-listed session variables (DISPLAY local-form only). */
  env: Record<string, string>;
}

/** No desktop (commands only), and why in plain words. */
export interface NoDesktop { access: "none"; why: string; session?: { type: "x11" | "wayland"; locked: boolean; active: boolean } }

/** `Key=Value` lines by name (a value may hold "="); lines without one are ignored. */
export function parseProps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of text.split("\n")) {
    const eq = l.indexOf("=");
    if (eq > 0) out.set(l.slice(0, eq).trim(), l.slice(eq + 1).replace(/\r$/, ""));
  }
  return out;
}

/** One C-escaped string as busctl writes it (cescape: \a \b \f \n \r \t \v \\ \" \' and \ooo for other bytes). */
function cunescape(s: string): string {
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34, "'": 39 };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = s[i + 1];
    if (n !== undefined && n in simple) { bytes.push(simple[n]); i++; continue; }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (oct) { bytes.push(parseInt(oct[0], 8) & 0xff); i += 3; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** busctl's plain output of an `as` value (`as 2 "A=1" "B=2"`) as its strings; null when it isn't one. */
export function parseBusctlStrings(text: string): string[] | null {
  const m = /^as (\d+)((?: "(?:[^"\\]|\\.)*")*)\s*$/s.exec(text.trim());
  if (!m) return null;
  const items = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => cunescape(x[1]));
  return items.length === Number(m[1]) ? items : null;
}

/** NUL-separated `KEY=value` (a /proc environ file) as a map. */
export function parseEnviron(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of buf.toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

/** `KEY=value` strings as a map. */
function pairs(list: string[]): Map<string, string> {
  return new Map(list.flatMap(e => {
    const eq = e.indexOf("=");
    return eq > 0 ? [[e.slice(0, eq), e.slice(eq + 1)] as [string, string]] : [];
  }));
}

/** Only the allow-listed session variables, a DISPLAY with a host part dropped. */
function sessionOnly(vars: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of vars) {
    if (!sessionVar(k) || !v) continue;
    if (k === "DISPLAY" && !LOCAL_DISPLAY.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** A session's logind properties. */
interface Session { id: string; user: string; type: string; cls: string; active: boolean; state: string; remote: boolean; seat: string; display: string; locked: boolean | null }

function sessionOf(id: string, text: string | null): Session | null {
  if (!text) return null;
  const p = parseProps(text);
  const lockedHint = p.get("LockedHint");
  return {
    id: p.get("Id") ?? id,
    user: p.get("User") ?? "",
    type: p.get("Type") ?? "",
    cls: p.get("Class") ?? "",
    active: p.get("Active") === "yes",
    state: p.get("State") ?? "",
    remote: p.get("Remote") === "yes",
    seat: p.get("Seat") ?? "",
    display: p.get("Display") ?? "",
    locked: lockedHint === "yes" ? true : lockedHint === "no" ? false : null,
  };
}

/**
 * The desktop this agent may use (§5.3.4 steps 1-5), or none with why. `waylandText`: a Wayland session may be used
 * for reading and accessibility actions (L5: only once the wayland-remote CI job passes); without it Wayland is none.
 */
export async function discoverDesktop(io: DesktopIo, o: { waylandText: boolean }): Promise<DesktopFound | NoDesktop> {
  const host = io.host;
  if (io.uid === 0) return { access: "none", why: "Ember doesn't use a desktop as root." };
  const userText = await io.showUser(io.uid);
  if (!userText) return { access: "none", why: `${host} has no desktop: Ember will run commands only.` };
  const user = parseProps(userText);
  const ids = [...new Set([...(user.get("Sessions") ?? "").split(/\s+/), user.get("Display") ?? ""].filter(id => /^[A-Za-z0-9._-]{1,64}$/.test(id)))];
  const sessions = (await Promise.all(ids.map(async id => sessionOf(id, await io.showSession(id))))).filter((s): s is Session => !!s);
  const graphical = sessions.filter(s => (s.type === "x11" || s.type === "wayland") && s.user === String(io.uid) && s.cls === "user");
  if (!graphical.length) return { access: "none", why: `${host} has no desktop: Ember will run commands only.` };
  const local = graphical.filter(s => s.seat !== "" && !s.remote);
  if (!local.length) return { access: "none", why: `${host}'s desktop is a remote session: Ember will run commands only.` };
  const live = local.filter(s => s.active && s.state === "active");
  if (live.length > 1) return { access: "none", why: `Ember can't tell which of ${io.user}'s ${live.length === 2 ? "two" : String(live.length)} desktops to use.` };
  if (!live.length) return { access: "none", why: `${io.user} isn't using ${host}'s screen right now: Ember will run commands only.` };
  const s = live[0];
  if (s.seat !== "seat0") return { access: "none", why: `${io.user}'s desktop on ${host} isn't on its main screen: Ember will run commands only.` };
  const type = s.type as "x11" | "wayland";
  const summary = { type, locked: true, active: true };
  // Locked (critique remote-14): logind's hint, GNOME's screensaver; either unreadable counts as locked.
  if (s.locked !== false) return { access: "none", why: `${host}'s screen is locked.`, session: summary };
  const saver = await io.gnomeScreenSaver();
  if (saver === null || (saver !== "absent" && !/^b false\s*$/.test(saver))) return { access: "none", why: `${host}'s screen is locked.`, session: summary };
  if (await io.emberRunning()) return { access: "none", why: `Ember is already running on ${host}'s screen.`, session: { ...summary, locked: false } };

  const env = await sessionEnvironment(io, s);
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${io.uid}`;
  env.XDG_RUNTIME_DIR = runtime;
  if (!env.XAUTHORITY) {
    for (const p of [`/run/user/${io.uid}/gdm/Xauthority`, path.join(io.home, ".Xauthority")]) {
      if (await io.exists(p)) { env.XAUTHORITY = p; break; }
    }
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS && await io.socketOwnedBy(`/run/user/${io.uid}/bus`, io.uid)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${io.uid}/bus`;
  if (env.WAYLAND_DISPLAY && !(WAYLAND_NAME.test(env.WAYLAND_DISPLAY) && await io.socketOwnedBy(path.join(runtime, env.WAYLAND_DISPLAY), io.uid))) delete env.WAYLAND_DISPLAY;
  // logind's own Display, where it names one, must be local and is what the session uses.
  if (s.display) {
    if (!LOCAL_DISPLAY.test(s.display)) return { access: "none", why: `Ember can't find ${host}'s display.`, session: { ...summary, locked: false } };
    env.DISPLAY = s.display;
  }
  const found: DesktopFound["session"] = { id: s.id, type, locked: false, active: true };
  if (type === "wayland") {
    if (!o.waylandText) return { access: "none", why: `Ember can't use ${host}'s Wayland desktop yet; it can run commands there.`, session: { ...summary, locked: false } };
    if (!env.DBUS_SESSION_BUS_ADDRESS) return { access: "none", why: `Ember can't reach ${host}'s desktop session.`, session: { ...summary, locked: false } };
    return { access: "text", session: found, env };
  }
  if (!env.DISPLAY) return { access: "none", why: `Ember can't find ${host}'s display.`, session: { ...summary, locked: false } };
  return { access: "screen", session: found, env };
}

/**
 * The session's variables (§5.3.4 step 4): from the user's systemd manager when it holds a display (gnome-session keeps
 * it current), else from the first readable process of this uid in the session's scope whose environment names this
 * session and a local display. ~/.Xauthority is the X cookie's last fallback.
 */
async function sessionEnvironment(io: DesktopIo, s: Session): Promise<Record<string, string>> {
  const managerText = await io.managerEnvironment();
  const manager = managerText ? parseBusctlStrings(managerText) : null;
  if (manager) {
    const vars = sessionOnly(pairs(manager));
    if (vars.DISPLAY || vars.WAYLAND_DISPLAY) return vars;
  }
  const scope = new RegExp(`/session-${s.id.replace(/[.]/g, "\\.")}\\.scope$`, "m");
  for (const pid of (await io.processes()).sort((a, b) => a - b)) {
    const cg = await io.cgroup(pid);
    if (!cg || !scope.test(cg)) continue;
    const environ = await io.environ(pid);
    if (!environ) continue; // unreadable (a program with file capabilities): the next one
    const vars = parseEnviron(environ);
    if (vars.get("XDG_SESSION_ID") !== s.id) continue;
    const display = vars.get("DISPLAY") ?? "";
    if (!LOCAL_DISPLAY.test(display) && !(s.type === "wayland" && vars.get("WAYLAND_DISPLAY"))) continue;
    return sessionOnly(vars);
  }
  return {};
}

/**
 * The desktop child's environment (§5.3.4 step 7, critique remote-15): the agent's own HOME, USER, LOGNAME, SHELL, PATH
 * and LANG with the session's variables laid over them, then appEnv's allow-list for apps on a user's screen (which
 * also drops SSH_*, Ember's own and the sign-in variables); ELECTRON_RUN_AS_NODE never.
 */
export function desktopChildEnv(base: NodeJS.ProcessEnv, session: Record<string, string>): NodeJS.ProcessEnv {
  const start: NodeJS.ProcessEnv = {};
  for (const k of BASE_VARS) if (base[k]) start[k] = base[k];
  for (const [k, v] of Object.entries(session)) if (sessionVar(k) && v) start[k] = v;
  if (start.DISPLAY && !LOCAL_DISPLAY.test(start.DISPLAY)) delete start.DISPLAY;
  const env = appEnv(start, { session: true });
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
