/** Permission for a fixed, read-only user probe in an already-running WSL distro; never execution authority. */
import { commandMode, type LoadedAdminPolicy } from "../admin";
import type { Settings } from "../settings";
import { consentCurrent } from "../targets/consent";
import { wslAllowed } from "../targets/registry";
import { parseTargetId, type TargetId } from "../../shared/targets";

export function wslCodingUserPreparationAllowed(admin: LoadedAdminPolicy, prefs: Pick<Settings, "targets" | "commands">, target: string): boolean {
  try {
    if (parseTargetId(target)?.kind !== "wsl") return false;
    const command = prefs.commands[target as TargetId];
    return wslAllowed(admin) && commandMode(admin, "wsl") !== "off" && prefs.targets.wsl.on &&
      consentCurrent("wsl", prefs.targets.wsl.consent) && command?.on === true && consentCurrent("commands", command.consent);
  } catch { return false; }
}
