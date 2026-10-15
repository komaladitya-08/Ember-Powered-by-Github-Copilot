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
import { execArgv, type DesktopApp } from "../hands/system";
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
  /** Starts an app on the desk and returns its process id; throws for apps Ember won't run there. */
  open(app: DesktopApp): number | undefined;
  close(): void;
}

const TERMINALS = /(^|[.-])(gnome-terminal|konsole|xterm|terminator|tilix|xfce4-terminal|alacritty|kitty|ptyxis|terminal)($|[.-])/i;

/** How to start an app so its instance is Ember's own (single-instance apps would otherwise join the user's). */
export function deskRecipe(app: DesktopApp, info: Pick<DeskInfo, "handOff">, profiles: string): string[] {
  if (TERMINALS.test(app.id) || /terminal/i.test(app.name)) throw new Error("Ember doesn't run terminals, on its desk or anywhere else");
  const argv = app.exec ? execArgv(app.exec) : [];
  if (!argv.length) throw new Error(`${app.name} has no command to run`);
  const bin = path.basename(argv[0]);
  if (/^firefox/.test(bin)) {
    const dir = path.join(profiles, "firefox");
    fs.mkdirSync(dir, { recursive: true });
    return [argv[0], "--new-instance", "--profile", dir];
  }
  if (/^(libreoffice|soffice)/.test(bin)) {
    return [...argv, `-env:UserInstallation=file://${path.join(profiles, "libreoffice")}`];
  }
  if (/^(chromium|chromium-browser|google-chrome|code|electron)/.test(bin)) {
    return [...argv, `--user-data-dir=${path.join(profiles, bin)}`, "--force-renderer-accessibility"];
  }
  void info;
  return argv;
}

export async function openDeskPlace(desk: DeskManager, o: { sidecarScript: string; log: Logger; neverLook: () => string[]; profiles: string; userInControl?: () => boolean }): Promise<DeskPlace> {
  const info = await desk.start();
  // Xvfb creates its socket a moment before it accepts clients: retry briefly.
  let x11: X11 | null = null, input: XInput | null = null;
  for (let i = 0; i < 60 && !(x11 && input); i++) {
    x11 ??= withDeskAuth(info, d => openX11(d));
    input ??= withDeskAuth(info, d => openXInput(d));
    if (!(x11 && input)) await new Promise(r => setTimeout(r, 50));
  }
  if (!x11 || !input) {
    o.log.error("desk.connect_failed", { x11: !!x11, input: !!input, inputError: String(xinputError ?? ""), xauthority: info.env.XAUTHORITY, display: info.display });
    x11?.close(); input?.close();
    throw new Error("couldn't connect to Ember's desk display");
  }
  const sidecar = new AtspiSidecar(o.sidecarScript, o.log.child("desk-atspi"), undefined, info.env);
  const perception = new Perception({
    sidecar, x11, log: o.log.child("desk-perception"), neverLook: o.neverLook,
    screenBounds: () => ({ x: 0, y: 0, width: info.width, height: info.height }),
  });
  return {
    info, perception, sidecar, input, x11,
    userInControl: o.userInControl ?? (() => false),
    open(app) {
      const argv = deskRecipe(app, info, o.profiles);
      o.log.info("desk.open", { app: app.id });
      return desk.run(argv).pid;
    },
    close() {
      sidecar.stop();
      x11.close();
      input.close();
    },
  };
}
