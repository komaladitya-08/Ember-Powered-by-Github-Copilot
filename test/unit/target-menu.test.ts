/**
 * The handle menu's computers part (targets/menu.ts, §8.1), the one source of its words and rules (review #76):
 * which items show for which targets, and which of them open one of Ember's windows (the handle then keeps the
 * keyboard off the user's app, review #68).
 */

import { describe, expect, it, vi } from "vitest";
import { menuOptions, targetMenu, type MenuInput, type MenuItemOptions } from "../../app/main/targets/menu";
import type { TargetEntry } from "../../app/main/targets/registry";
import type { MenuItemLike } from "../../app/main/targets/types";

const local: TargetEntry = { id: "local", kind: "local", label: "This computer", state: "ready", can: "apps", usable: true, listedOnly: false, names: [] };
const host = (state: TargetEntry["state"], id = "build-01"): TargetEntry => ({
  id: `ssh:${id}`, kind: "ssh", label: id, state, can: "commands", usable: state === "ready", listedOnly: false, names: [id],
  host: { id, dest: id, resolved: { user: "me", hostname: id, port: 22, jump: [] }, consent: { version: 1, at: "2026-10-01T00:00:00.000Z" } } as TargetEntry["host"],
});
const labels = (items: MenuItemLike[]): unknown[] => items.map(i => (i.type === "separator" ? "—" : i.submenu ? [i.label, labels(i.submenu)] : i.label));
const menu = (over: Partial<MenuInput> = {}): MenuItemLike[] => targetMenu({
  entries: [local], active: "local", sshAllowed: true, pick: vi.fn(), bring: vi.fn(), disconnect: vi.fn(), ...over,
});

describe("the handle menu's computers part", () => {
  it("marks \"Bring Ember to a computer…\" as opening a window, and nothing else", () => {
    const items = menu({ entries: [local, host("ready")], active: "ssh:build-01" });
    const bring = items.find(i => i.label === "Bring Ember to a computer…");
    expect(bring?.opens).toBe(true);
    expect(items.filter(i => i !== bring).every(i => !i.opens && (i.submenu ?? []).every(s => !s.opens))).toBe(true);
  });

  it("offers \"Bring Ember to a computer…\" whenever the administrator allows SSH, also before any host is added", () => {
    expect(labels(menu())).toEqual(["—", "Bring Ember to a computer…"]);
    expect(menu({ sshAllowed: false })).toEqual([]);
    expect(labels(menu({ sshAllowed: false, entries: [local, host("ready")] }))).toEqual([["Work on", ["This computer", "build-01"]]]);
  });

  it("disconnects the connected remote the picker is on, and stops a host that is still connecting", () => {
    const disconnect = vi.fn();
    expect(labels(menu({ entries: [local, host("ready")], active: "ssh:build-01" })).at(-1)).toBe("Disconnect build-01");
    const items = menu({ entries: [local, host("connecting"), host("lost", "db")], disconnect });
    expect(labels(items)).toEqual([["Work on", ["This computer", "build-01 (connecting…)", "db (lost)"]], "—", "Bring Ember to a computer…", "Cancel connecting to build-01"]);
    items.at(-1)!.click!();
    expect(disconnect).toHaveBeenCalledWith("build-01");
  });
});

describe("the computers part as the handle's menu takes it (menuOptions)", () => {
  /** Every item, submenus included. */
  const all = (items: MenuItemOptions[]): MenuItemOptions[] => items.flatMap(i => [i, ...all(i.submenu ?? [])]);

  it("tells main an item opens one of Ember's windows before that item's click runs, and for no other item", () => {
    const order: string[] = [];
    const items = menu({
      entries: [local, host("ready"), host("connecting", "build-02")], active: "ssh:build-01",
      pick: id => order.push(`pick ${id}`), bring: () => order.push("bring"), disconnect: id => order.push(`disconnect ${id}`),
    });
    const opts = menuOptions(items, () => order.push("opened"));
    const click = (label: string) => { const i = all(opts).find(o => o.label === label); i?.click?.(); };
    click("Bring Ember to a computer…");
    expect(order).toEqual(["opened", "bring"]);
    order.length = 0;
    // The picker's radios (in a submenu), Disconnect and Cancel connecting open nothing.
    for (const label of ["This computer", "build-01", "Disconnect build-01", "Cancel connecting to build-02"]) click(label);
    expect(order).toEqual(["pick local", "pick ssh:build-01", "disconnect build-01", "disconnect build-02"]);
  });

  it("passes the words and states through, submenus too, and never hands Electron the `opens` mark", () => {
    const opts = menuOptions(menu({ entries: [local, host("lost")], active: "local" }), () => undefined);
    expect(opts[0]).toMatchObject({ label: "Work on", type: "submenu" });
    expect(opts[0]?.submenu?.map(i => [i.label, i.type, i.checked, i.enabled])).toEqual([
      ["This computer", "radio", true, true], ["build-01 (lost)", "radio", false, false],
    ]);
    expect(opts.map(i => i.type ?? "normal")).toEqual(["submenu", "separator", "normal"]);
    expect(all(opts).some(i => "opens" in i)).toBe(false);
    // Fields an item doesn't have stay out (Electron's defaults apply), rather than set to undefined.
    expect(Object.keys(opts[1] ?? {})).toEqual(["type"]);
  });
});
