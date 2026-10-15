/**
 * Everything Ember needs to work on its desk: its own accessibility sidecar
 * (on the desk's bus), X11 capture and XTest input on the desk display, and
 * launch recipes so apps open there and never on the user's screen.
 */

import fs from "node:fs";
import path from "node:path";
import { AtspiSidecar } from "../perception/sidecar";
import { Perception } from "../perception";
import { openX11, type X11 } from "../x11";
import { openXInput, xinputError, type XInput } from "../hands/input";
import { execArgv, isTerminalApp, type DesktopApp } from "../hands/system";
import { withDeskAuth, type DeskInfo, type DeskManager } from "./desk";
import type { Logger } from "../logger";

export interface DeskPlace {
  info: DeskInfo;
  perception: Perception;
  sidecar: AtspiSidecar;
  input: XInput;
  x11: X11;
  /** True while the user has taken over the desk (Ember must not act there). */
  userInControl: () => boolean;
  /** True once the desk's display is gone (it died, or the place was closed): every X call there now throws. */
  readonly dead: boolean;
  /** Calls `fn` once when the desk's display dies (at once if it already has). */
  onDead(fn: () => void): void;
  /** Starts an app on the desk and returns its process id; throws for apps Ember won't run there. */
  open(app: DesktopApp): number | undefined;
  close(): void;
}

/** Apps with a terminal built in (VS Code's integrated terminal): never on the desk. */
const BUILT_IN_TERMINAL = /^(code|code-insiders|code-oss|codium|vscodium)$/i;
const BUILT_IN_TERMINAL_ID = /(^|\.)(code|code-insiders|code-oss|codium|vscodium|visual-studio-code)$/i;

/** How to start an app so its instance is Ember's own (single-instance apps would otherwise join the user's). */
export function deskRecipe(app: DesktopApp, info: Pick<DeskInfo, "handOff">, profiles: string): string[] {
  if (isTerminalApp(app)) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
  const argv = app.exec ? execArgv(app.exec) : [];
  if (!argv.length) throw new Error(`${app.name} has no command to run`);
  const bin = path.basename(argv[0]);
  if (BUILT_IN_TERMINAL.test(bin) || BUILT_IN_TERMINAL_ID.test(app.id)) throw new Error(`Ember doesn't use ${app.name} on its desk: it has a terminal built in`);
  if (/^(firefox|thunderbird)/.test(bin)) {
    const dir = path.join(profiles, bin.startsWith("thunderbird") ? "thunderbird" : "firefox");
    fs.mkdirSync(dir, { recursive: true });
    return [argv[0], "--new-instance", "--profile", dir];
  }
  if (/^(libreoffice|soffice)/.test(bin)) {
    return [...argv, `-env:UserInstallation=file://${path.join(profiles, "libreoffice")}`];
  }
  if (/^(chromium|chromium-browser|google-chrome|electron)/.test(bin)) {
    return [...argv, `--user-data-dir=${path.join(profiles, bin)}`, "--force-renderer-accessibility"];
  }
  void info;
  return argv;
}

/**
 * The same object, but every call first checks that the display is still up
 * and throws if not: one X call on a dead display ends Ember (Xlib's I/O error
 * handler exits the process). close() on a dead display does nothing.
 */
export function guardX<T extends object & { close(): void }>(target: T, up: () => boolean): T {
  return new Proxy(target, {
    get(t, key) {
      const v = Reflect.get(t, key) as unknown;
      if (typeof v !== "function") return v;
      if (key === "close") return () => { if (up()) t.close(); };
      return (...args: unknown[]) => {
        if (!up()) throw new Error("Ember's desk has stopped");
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

export async function openDeskPlace(desk: DeskManager, o: { sidecarScript: string; log: Logger; neverLook: () => string[]; profiles: string; userInControl?: () => boolean }): Promise<DeskPlace> {
  const info = await desk.start({ profiles: o.profiles });
  // The desk is ready when start() returns (Xvfb said so and Ember's cookie opened it); retry briefly anyway.
  let rawX11: X11 | null = null, rawInput: XInput | null = null;
  for (let i = 0; i < 10 && !(rawX11 && rawInput) && desk.alive(); i++) {
    rawX11 ??= withDeskAuth(info, d => openX11(d));
    rawInput ??= withDeskAuth(info, d => openXInput(d));
    if (!(rawX11 && rawInput)) await new Promise(r => setTimeout(r, 50));
  }
  if (!rawX11 || !rawInput) {
    o.log.error("desk.connect_failed", { x11: !!rawX11, input: !!rawInput, inputError: String(xinputError ?? ""), xauthority: info.env.XAUTHORITY, display: info.display });
    if (desk.alive()) { rawX11?.close(); rawInput?.close(); }
    // A desk Ember can't use is no use to anyone: don't leave it running.
    desk.stop();
    throw new Error("couldn't connect to Ember's desk display");
  }
  let dead = false;
  const up = () => !dead && desk.alive();
  const x11 = guardX(rawX11, up), input = guardX(rawInput, up);
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
  // Marked dead before anything else runs: the view's frame timer and a worker's borrow stop touching X.
  const unsubscribe = desk.onDead(gone);
  return {
    info, perception, sidecar, input, x11,
    userInControl: o.userInControl ?? (() => false),
    get dead() { return !up(); },
    onDead(fn) { if (dead) fn(); else deadFns.push(fn); },
    open(app) {
      if (!up()) throw new Error("Ember's desk has stopped");
      const argv = deskRecipe(app, info, o.profiles);
      o.log.info("desk.open", { app: app.id });
      return desk.run(argv).pid;
    },
    close() {
      unsubscribe();
      sidecar.stop();
      x11.close();
      input.close();
      // A closed connection must not be used again (Xlib would read freed memory).
      dead = true;
      deadFns.length = 0;
    },
  };
}
