/**
 * The handle menu's computers part (targets/menu.ts, §8.1): which items show for which targets, and which of them
 * open one of Ember's windows (the handle then keeps the keyboard off the user's app, review #68).
 */

import { describe, expect, it, vi } from "vitest";
import { targetMenu, type MenuInput } from "../../app/main/targets/menu";
import type { TargetEntry } from "../../app/main/targets/registry";
import type { MenuItemLike } from "../../app/main/targets/types";

const local: TargetEntry = { id: "local", kind: "local", label: "This computer", state: "ready", can: "apps", usable: true, listedOnly: false, names: [] };
const host = (state: TargetEntry["state"], id = "build-01"): TargetEntry => ({
  id: `ssh:${id}`, kind: "ssh", label: id, state, can: "commands", usable: state === "ready", listedOnly: false, names: [id],
  host: { id, dest: id, resolved: { user: "me", hostname: id, port: 22, jump: [] }, consent: { version: 1, at: "2026-10-01T00:00:00.000Z" } } as TargetEntry["host"],
});
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
});
