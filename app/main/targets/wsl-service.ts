/**
 * A WSL distro's commands (§2.5, §4.2): the CommandService for `wsl:<distro>`, over WA's runner for that distro and
 * the one command window. Commands there need the administrator's `commands.wsl`, WSL turned on (its card), the
 * user's switch and the commands card; a distro whose default user is root, or Podman's, asks before every command
 * (D4.6, §2.2). Its facts are read only once the distro is running, so listing or binding never boots a VM: the first
 * command does, as the user asked for work there. Plain Node.
 */

import { targetIdOf } from "../../shared/targets";
import { commandMode, type LoadedAdminPolicy } from "../admin";
import type { CommandRunner, CommandWindowPort, RunnerFacts } from "../commands/types";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { WslDistro } from "../wsl/types";
import type { TargetBinding } from "./types";
import { commandCapability, commandsSetting, recordCommandsConsent, shellsOf, warmFacts, type WarmService } from "./local-service";

/** Podman's machine (a tool's distro): every command asks (§2.2). */
export function isToolDistro(d: Pick<WslDistro, "name" | "tool">): boolean {
  return d.tool === "podman" || /^podman-machine/i.test(d.name);
}

/** A distro's CommandService. */
export function createWslService(o: {
  name: string;
  log: Logger;
  /** The distro as discovery last saw it (null: gone). */
  distro: () => WslDistro | null;
  binding: () => TargetBinding;
  runner: CommandRunner;
  window: CommandWindowPort;
  settings: SettingsStore;
  admin: () => LoadedAdminPolicy;
  /** WSL is turned on for Ember (its card accepted) and the administrator allows it. */
  wslOn: () => boolean;
}): WarmService {
  const id = targetIdOf("wsl", o.name);
  const warm = warmFacts(o.runner, o.log, "targets.wsl_facts_failed");
  const mode = () => commandMode(o.admin(), "wsl");
  const setting = () => commandsSetting(o.settings, id);
  /** Root as the distro reports it (its facts), else as discovery last read it from inside the distro (critique wsl-7). */
  const root = (f: RunnerFacts | null, d: WslDistro | null) => (f ? f.privileged : d?.defaultUid === 0);
  const unavailable = (d: WslDistro | null): string | null =>
    !o.wslOn() ? "WSL isn't turned on for Ember. The user can turn it on in Ember's settings (Computers)."
      : !d ? `${o.name} isn't installed any more.`
        : d.needsSetup ? `Set up ${o.name} first: open it from the Start menu once.` : null;
  const svc: WarmService = {
    get binding() { return o.binding(); },
    capability: () => {
      const d = o.distro();
      return commandCapability({
        kind: "wsl", label: `${o.name} (WSL)`, mode: mode(), setting: setting(), unavailable: unavailable(d),
        privileged: root(warm.facts(), d), tool: !!d && isToolDistro(d),
      });
    },
    // The distro's own shells once read, else bash and sh (§3.1: known without waiting).
    shells: () => shellsOf(warm.facts(), ["bash", "sh"]),
    runner: o.runner,
    window: o.window,
    consented: () => recordCommandsConsent(o.settings, id),
    userAskEvery: () => setting()?.askEvery === true || isToolDistro(o.distro() ?? { name: o.name }),
    mode,
    // Only a running distro is asked (asking boots a stopped one).
    warm: () => { if (o.distro()?.running) warm.warm(); },
    facts: warm.facts,
  };
  return svc;
}
