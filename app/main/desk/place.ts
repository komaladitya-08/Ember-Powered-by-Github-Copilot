/**
 * Everything Ember needs to work on its desk: its own accessibility sidecar
 * (on the desk's bus), X11 capture and XTest input on the desk display (made
 * by the desk's helper process, never in Ember), and launch recipes so apps
 * open there and never on the user's screen.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AtspiSidecar } from "../perception/sidecar";
import { Perception } from "../perception";
import type { Rect, StackedWindow, X11 } from "../x11";
import type { XInput } from "../hands/input";
import { execArgv, hasBuiltInShell, isTerminalApp, type DesktopApp } from "../hands/system";
import { DESK_STOPPED, deskInput, deskKeys, deskSnapshot, deskX11, type DeskKeys, type DeskSnapshot } from "./agent";
import type { DeskInfo, DeskManager } from "./desk";
import type { Logger } from "../logger";

export interface DeskPlace {
  info: DeskInfo;
  perception: Perception;
  sidecar: AtspiSidecar;
  input: XInput;
  x11: X11;
  /** Keys for characters the desk's keyboard doesn't have (the take-over view types the user's characters). */
  keys: DeskKeys;
  /** The desk as a small JPEG for the mini-view, made without Ember's thread waiting (null if it can't be taken). */
  snapshot(width: number, quality: number): Promise<DeskSnapshot | null>;
  /** True while the user has taken over the desk (Ember must not act there). */
  userInControl: () => boolean;
  /** True once the desk is gone (it died, or the place was closed): every X call there now throws. */
  readonly dead: boolean;
  /** Calls `fn` once when the desk dies (at once if it already has). */
  onDead(fn: () => void): void;
  /** Starts an app on the desk and returns its process id; throws for apps Ember won't run there. */
  open(app: DesktopApp): number | undefined;
  close(): void;
}

/**
 * LibreOffice on the desk runs no macros: with them, text typed into a document could run commands
 * (Basic's Shell()). Document macros are off, the macro editors, runners and the extension manager are
 * switched off, and the profile's own macro folders (Basic, Scripts) are read-only, so no macro can be
 * written there (e.g. by saving a document over one) and run from a link. Set in the desk's own profile
 * before every start, so a change made there meanwhile doesn't last.
 */
const LIBREOFFICE_LOCKDOWN = [
  // (And no first-start dialogs in the way.)
  ["/org.openoffice.Setup/Office", "ooSetupInstCompleted", "true"],
  ["/org.openoffice.Office.Common/Misc", "FirstRun", "false"],
  ["/org.openoffice.Office.Common/Misc", "ShowTipOfTheDay", "false"],
  ["/org.openoffice.Office.Common/Security/Scripting", "MacroSecurityLevel", "3"],
  ["/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution", "true"],
  ["/org.openoffice.Office.ExtensionManager/ExtensionSecurity", "DisableExtensionInstallation", "true"],
  // Documents opened on the desk fetch nothing on their own: external links and DDE aren't updated when they load
  // (Calc: 1 = never; Writer: 0 = never), and links in documents from outside the trusted places don't open.
  ["/org.openoffice.Office.Calc/Content/Update", "Link", "1"],
  ["/org.openoffice.Office.Writer/Content/Update", "Link", "0"],
  ["/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"],
  // Lock files stay on: without them LibreOffice neither says "Document in Use" nor "Changed by Others", and a save on
  // the desk overwrote what the user had saved meanwhile in their own LibreOffice. Stale ones the desk left (it was
  // stopped with documents open) go when it stops and starts (clearDeskLocks).
  ["/org.openoffice.Office.Common/Misc", "UseLocking", "true"],
] as const;
/** Commands switched off: the macro editors and runners, extensions, and Tools > Options (where the above could be undone). */
const LIBREOFFICE_OFF = ["BasicIDEAppear", "MacroDialog", "RunMacro", "ScriptOrganizer", "MacroOrganizer", "MacroRecorder", "PackageManager", "OptionsTreeDialog"];

/**
 * LibreOffice's work folder ("My Documents" in its options: where its Open and Save dialogs start). On the desk it is
 * the hand-off folder, as it is for the desk's other apps (they start there): its locks are cleared there, and the
 * user finds what Ember made there. The items as LibreOffice writes them when it is changed in its options: the folder,
 * and the old setting emptied (while it has a value, by default "$(work)", the home folder, LibreOffice takes that).
 */
const WORK_PATH = "/org.openoffice.Office.Paths/Paths/org.openoffice.Office.Paths:NamedPath['Work']";
const OLD_WORK_PATH = "/org.openoffice.Office.Common/Path/Current";
const workItems = (work: string) => [
  `<item oor:path="${OLD_WORK_PATH}"><prop oor:name="Work" oor:op="fuse"><value xsi:nil="true"/></prop></item>`,
  `<item oor:path="${WORK_PATH}"><prop oor:name="WritePath" oor:op="fuse"><value>${xmlText(pathToFileURL(work).href)}</value></prop></item>`,
];

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Makes a folder and everything in it read-only. */
function readOnly(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const n of fs.readdirSync(p)) readOnly(path.join(p, n));
  fs.chmodSync(p, st.isDirectory() ? 0o500 : 0o400);
}

/**
 * Locks a LibreOffice profile down (see LIBREOFFICE_LOCKDOWN): writes the settings into its
 * registrymodifications.xcu, keeping the rest of it, and makes its macro folders read-only.
 * `presets`: LibreOffice's own presets folder, whose Basic libraries a new profile starts with.
 * `work`: the folder its Open and Save dialogs start in (see WORK_PATH).
 */
export function lockDownLibreOffice(profile: string, presets?: string, work?: string): void {
  const user = path.join(profile, "user");
  fs.mkdirSync(user, { recursive: true, mode: 0o700 });
  for (const dir of ["basic", "Scripts"]) {
    const p = path.join(user, dir);
    if (!fs.existsSync(p)) {
      const from = presets && path.join(presets, dir);
      if (from && fs.existsSync(from)) fs.cpSync(from, p, { recursive: true }); else fs.mkdirSync(p, { recursive: true });
    }
    readOnly(p);
  }
  const file = path.join(user, "registrymodifications.xcu");
  let items: string[] = [];
  try {
    const text = fs.readFileSync(file, "utf8");
    items = text.match(/<item [\s\S]*?<\/item>/g) ?? [];
  } catch { /* a new profile */ }
  // Ember's own items go; everything else the profile has stays.
  const ours = (item: string) => LIBREOFFICE_LOCKDOWN.some(([p, name]) => item.includes(`oor:path="${p}"`) && item.includes(`oor:name="${name}"`))
    || item.includes('oor:path="/org.openoffice.Office.Commands/Execute/Disabled"') && item.includes('oor:name="ember-')
    || !!work && (item.includes(`oor:path="${WORK_PATH}"`) && item.includes('oor:name="WritePath"') || item.includes(`oor:path="${OLD_WORK_PATH}"`) && item.includes('oor:name="Work"'));
  const mine = [
    ...LIBREOFFICE_LOCKDOWN.map(([p, name, value]) => `<item oor:path="${p}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`),
    ...LIBREOFFICE_OFF.map(c => `<item oor:path="/org.openoffice.Office.Commands/Execute/Disabled"><node oor:name="ember-${c}" oor:op="replace"><prop oor:name="Command" oor:op="fuse"><value>${c}</value></prop></node></item>`),
    ...(work ? workItems(work) : []),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n${[...items.filter(i => !ours(i)), ...mine].join("\n")}\n</oor:items>\n`;
  fs.writeFileSync(file, xml);
}

/** LibreOffice's presets folder (beside its program folder), found from the command that starts it. */
function libreOfficePresets(cmd: string): string | undefined {
  const dirs = path.isAbsolute(cmd) ? [""] : (process.env.PATH ?? "/usr/bin:/bin").split(":");
  for (const d of dirs) {
    try {
      const program = path.dirname(fs.realpathSync(path.join(d, cmd)));
      const presets = path.join(program, "..", "presets");
      if (fs.existsSync(presets)) return presets;
    } catch { /* not here */ }
  }
  return undefined;
}

/** How to start an app so its instance is Ember's own (single-instance apps would otherwise join the user's). */
export function deskRecipe(app: DesktopApp, info: Pick<DeskInfo, "handOff"> & Partial<Pick<DeskInfo, "env">>, profiles: string): string[] {
  // One decision for both of Ember's ways to open apps (hands/system.ts): terminals, shells and apps with one built in.
  if (hasBuiltInShell(app)) throw new Error(`Ember doesn't use ${app.name} on its desk: it has a terminal built in`);
  if (isTerminalApp(app)) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
  const argv = app.exec ? execArgv(app.exec) : [];
  if (!argv.length) throw new Error(`${app.name} has no command to run`);
  const bin = path.basename(argv[0]);
  if (/^(firefox|thunderbird)/.test(bin)) {
    const dir = path.join(profiles, bin.startsWith("thunderbird") ? "thunderbird" : "firefox");
    fs.mkdirSync(dir, { recursive: true });
    return [argv[0], "--new-instance", "--profile", dir];
  }
  if (/^(libreoffice|soffice|localc|lowriter|loimpress|lodraw|lobase|lomath)/.test(bin)) {
    // A profile for this desk only (in its runtime folder, gone when the desk stops): nothing planted in one lasts.
    const dir = path.join(info.env?.XDG_RUNTIME_DIR ?? profiles, "libreoffice");
    lockDownLibreOffice(dir, libreOfficePresets(argv[0]), info.handOff);
    return [...argv, `-env:UserInstallation=${pathToFileURL(dir).href}`];
  }
  if (/^(chromium|chromium-browser|google-chrome|electron)/.test(bin)) {
    return [...argv, `--user-data-dir=${path.join(profiles, bin)}`, "--force-renderer-accessibility"];
  }
  return argv;
}

/** Accessible roles of dialog windows. */
export const DIALOG_ROLES = new Set(["alert", "dialog", "file chooser", "color chooser", "font chooser"]);

/**
 * A dialog's window on the desk when its title doesn't name it: GTK's message dialogs are "Question" or "Information"
 * over accessibility, while their X title is another ("Document in Use") or none at all. The one window of process
 * `pid` that is where the dialog was read (`bounds`: its accessible frame, which toolkits report with the window
 * manager's frame or without it); 0 if no window or several are there. Only for the desk: on the user's screen the
 * title must match.
 */
export function deskWindowAt(stack: StackedWindow[], pid: number, bounds: Rect): number {
  if (!(bounds.width > 0 && bounds.height > 0)) return 0;
  const near = (r: Rect) => Math.abs(r.x - bounds.x) + Math.abs(r.y - bounds.y) <= 8 && Math.abs(r.width - bounds.width) + Math.abs(r.height - bounds.height) <= 8;
  const hits = stack.filter(s => !s.overrideRedirect && s.pid === pid && [s.outer, s.inner, s].some(near));
  return hits.length === 1 ? hits[0].client : 0;
}

/**
 * The same object, but every call first checks that the desk is still up and
 * throws if not (a quick, clear error instead of a call to a helper that is
 * gone). close() on a dead desk does nothing.
 */
export function guardX<T extends object & { close(): void }>(target: T, up: () => boolean): T {
  return new Proxy(target, {
    get(t, key) {
      const v = Reflect.get(t, key) as unknown;
      if (typeof v !== "function") return v;
      if (key === "close") return () => { if (up()) t.close(); };
      return (...args: unknown[]) => {
        if (!up()) throw new Error(DESK_STOPPED);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

export async function openDeskPlace(desk: DeskManager, o: { sidecarScript: string; log: Logger; neverLook: () => string[]; profiles: string; userInControl?: () => boolean }): Promise<DeskPlace> {
  const info = await desk.start({ profiles: o.profiles });
  const agent = desk.agent;
  if (!agent || !desk.alive()) throw new Error("Ember's desk stopped as it started");
  let dead = false;
  const up = () => !dead && desk.alive();
  const x11 = guardX(deskX11(agent), up), input = guardX(deskInput(agent), up);
  const keys = guardX({ ...deskKeys(agent), close: () => undefined }, up);
  const sidecar = new AtspiSidecar(o.sidecarScript, o.log.child("desk-atspi"), undefined, info.env);
  const perception = new Perception({
    sidecar, x11, log: o.log.child("desk-perception"), neverLook: o.neverLook,
    screenBounds: () => ({ x: 0, y: 0, width: info.width, height: info.height }),
  });
  const deadFns: (() => void)[] = [];
  const gone = () => {
    if (dead) return;
    dead = true;
    sidecar.stop();
    for (const fn of deadFns.splice(0)) {
      try { fn(); } catch (err) { o.log.warn("desk.dead_handler_failed", { err }); }
    }
  };
  // Marked dead before anything else runs: the view's frame timer and a worker's borrow stop using the desk.
  const unsubscribe = desk.onDead(gone);
  return {
    info, perception, sidecar, input, x11, keys,
    snapshot: (width, quality) => (up() ? deskSnapshot(agent, width, quality) : Promise.reject(new Error(DESK_STOPPED))),
    userInControl: o.userInControl ?? (() => false),
    get dead() { return !up(); },
    onDead(fn) { if (dead) fn(); else deadFns.push(fn); },
    open(app) {
      if (!up()) throw new Error(DESK_STOPPED);
      const argv = deskRecipe(app, info, o.profiles);
      o.log.info("desk.open", { app: app.id });
      return desk.run(argv).pid;
    },
    close() {
      unsubscribe();
      sidecar.stop();
      // Keys and buttons still held on the desk are let go.
      input.close();
      dead = true;
      deadFns.length = 0;
    },
  };
}
