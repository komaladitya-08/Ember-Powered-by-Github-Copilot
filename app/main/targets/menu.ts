/**
 * The handle menu's targets part (§8.1), the one source of its words and rules: a "Work on" picker when there is more
 * than one place to work, "Bring Ember to a computer…" whenever the administrator allows SSH, "Disconnect <host>"
 * while the picker is on a connected remote, and "Cancel connecting to <host>" while a host is connecting. Nothing at
 * all when only this computer exists and SSH is off (critique integration-25: nothing new without a reason). Plain
 * objects main hands to Menu.buildFromTemplate; pure.
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
  // The way to SSH from the handle, offered whenever the administrator allows it (§8.1).
  if (i.sshAllowed) items.push({ type: "separator" }, { label: "Bring Ember to a computer…", click: i.bring, opens: true });
  const active = targets.find(e => e.id === i.active);
  if (active?.kind === "ssh" && active.host && active.state === "ready") {
    const hostId = active.host.id;
    items.push({ label: `Disconnect ${active.label}`, click: () => i.disconnect(hostId) });
  }
  // A host still connecting (from settings, an offer or a pick) can be stopped here too, as its bubble's Cancel does.
  for (const e of targets) {
    if (e.kind !== "ssh" || !e.host || e.state !== "connecting") continue;
    const hostId = e.host.id;
    items.push({ label: `Cancel connecting to ${e.label}`, click: () => i.disconnect(hostId) });
  }
  return items;
}

/** A menu item as Electron's Menu.buildFromTemplate takes it: MenuItemLike without main's `opens` mark. */
export type MenuItemOptions = Omit<MenuItemLike, "opens" | "submenu"> & { submenu?: MenuItemOptions[] };

/**
 * The items as the handle's menu takes them (submenus too). `opened` is told just before the click of an item that
 * opens one of Ember's windows ("Bring Ember to a computer…" opens settings), so the menu doesn't hand the keyboard
 * back to the user's app over it; no other item tells it. Fields an item lacks stay out (Electron's defaults apply).
 */
export function menuOptions(items: readonly MenuItemLike[], opened: () => void): MenuItemOptions[] {
  return items.map(i => {
    const click = i.click;
    return {
      ...(i.label !== undefined ? { label: i.label } : {}), ...(i.type ? { type: i.type } : {}),
      ...(i.checked !== undefined ? { checked: i.checked } : {}), ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
      ...(i.submenu ? { submenu: menuOptions(i.submenu, opened) } : {}),
      ...(click ? { click: i.opens ? () => { opened(); click(); } : click } : {}),
    };
  });
}
