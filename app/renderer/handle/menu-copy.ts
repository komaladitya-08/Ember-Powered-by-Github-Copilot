/**
 * The handle menu's computers part (§8.1), as words and what each item does: the targets runtime turns these into its
 * MenuItemLike items (adding the clicks). Nothing new appears without a reason (critique integration-25): "Work on"
 * only with two or more targets, "Bring Ember to a computer…" only while SSH is allowed, "Disconnect build-01" only
 * while the active target is a connected remote. With only this computer and SSH turned off it is empty. Pure.
 */

import type { TargetId, TargetSummary } from "../../shared/targets";

/** One menu item: a radio choice of target, a separator, or an action. */
export type TargetMenuItem =
  | { type: "submenu"; label: string; submenu: TargetMenuItem[] }
  | { type: "radio"; label: string; checked: boolean; enabled: boolean; activate: TargetId }
  | { type: "separator" }
  | { type: "normal"; label: string; action: "bring" }
  | { type: "normal"; label: string; action: "disconnect"; hostId: string };

/** A target's radio label: its name, with "(connecting…)" or "(lost)" while it is so. */
export function radioLabel(t: Pick<TargetSummary, "label" | "state">): string {
  return t.state === "connecting" ? `${t.label} (connecting…)` : t.state === "lost" ? `${t.label} (lost)` : t.label;
}

/** The computers part of the handle menu, to go after "Stop everything" (empty when it has nothing to offer). */
export function targetMenu(o: { summaries: readonly TargetSummary[]; sshAllowed: boolean }): TargetMenuItem[] {
  const local = o.summaries.find(t => t.id === "local");
  // This computer first, then the rest in the runtime's order.
  const all = [...(local ? [local] : []), ...o.summaries.filter(t => t.id !== "local")];
  const items: TargetMenuItem[] = [];
  if (all.length >= 2) {
    items.push({
      type: "submenu", label: "Work on",
      submenu: all.map(t => ({
        type: "radio" as const, label: t.id === "local" ? "This computer" : radioLabel(t), checked: t.active,
        // A lost (or unusable) target can't be picked.
        enabled: t.state !== "lost" && t.state !== "unavailable", activate: t.id,
      })),
    });
  }
  const tail: TargetMenuItem[] = [];
  if (o.sshAllowed) tail.push({ type: "normal", label: "Bring Ember to a computer…", action: "bring" });
  const active = all.find(t => t.active);
  if (active?.kind === "ssh" && (active.state === "ready" || active.state === "connecting")) {
    tail.push({ type: "normal", label: `Disconnect ${active.label}`, action: "disconnect", hostId: active.id.slice("ssh:".length) });
  }
  if (tail.length) items.push(...(items.length ? [{ type: "separator" } as const] : []), ...tail);
  return items;
}
