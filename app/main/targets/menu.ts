/**
 * The handle menu's targets part (§8.1): a "Work on" picker when there is more than one place to work, "Bring Ember to
 * a computer…" once SSH is in use, and "Disconnect <host>" while the picker is on a connected remote. Nothing at all
 * when only this computer exists, so the menu stays as it is today until the user sets something up (critique
 * integration-25). Plain objects main hands to Menu.buildFromTemplate; pure.
 */

import type { TargetId } from "../../shared/targets";
import type { MenuItemLike } from "./types";
import { bindable, type TargetEntry } from "./registry";

/** What the menu needs from the runtime. */
export interface MenuInput {
  entries: readonly TargetEntry[];
  active: TargetId;
  /** The administrator allows SSH. */
  sshAllowed: boolean;
  pick(id: TargetId): void;
  bring(): void;
  disconnect(hostId: string): void;
}

/** A target's picker label: "build-01 (connecting…)", "build-01 (lost)", or its label. */
function pickerLabel(e: TargetEntry): string {
  if (e.state === "connecting") return `${e.label} (connecting…)`;
  if (e.state === "lost") return `${e.label} (lost)`;
  return e.label;
}

/** The targets part of the handle menu (§8.1). */
export function targetMenu(i: MenuInput): MenuItemLike[] {
  const targets = bindable(i.entries);
  const items: MenuItemLike[] = [];
  const picker = targets.length >= 2;
  if (picker) {
    items.push({
      label: "Work on", type: "submenu",
      submenu: targets.map(e => ({
        label: pickerLabel(e), type: "radio" as const, checked: e.id === i.active,
        enabled: e.state !== "lost" && e.state !== "unavailable",
        click: () => i.pick(e.id),
      })),
    });
  }
  // Offered once SSH is in use (a host added, or another place to work): never new for someone who set nothing up.
  const hosts = i.entries.some(e => e.kind === "ssh");
  if (i.sshAllowed && (picker || hosts)) items.push({ type: "separator" }, { label: "Bring Ember to a computer…", click: i.bring, opens: true });
  const active = targets.find(e => e.id === i.active);
  if (active?.kind === "ssh" && active.host && active.state === "ready") {
    const hostId = active.host.id;
    items.push({ label: `Disconnect ${active.label}`, click: () => i.disconnect(hostId) });
  }
  return items;
}
