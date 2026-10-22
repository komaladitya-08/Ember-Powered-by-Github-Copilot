/**
 * The settings window's channels for computers and commands (TARGETS_IPC, §8.3). Every handler first checks that the
 * sender is the settings (home) window's own page (TargetsDeps.isHome; critique integration-5): no other window, page
 * or frame can list computers, connect one, turn commands on or skip a consent card. Every request is checked field by
 * field (ids against the target and host id rules, a destination against §5.1.2's validator, booleans as booleans)
 * before the runtime sees it. Plain Node.
 */

import { HOST_ID, TARGETS_IPC, parseTargetId, type TargetId, type TargetSummary, type TargetsAct } from "../../shared/targets";
import type { Logger } from "../logger";
import type { IpcLike, WebContentsLike } from "./types";

/** §5.1.2's destination validator (validDest): an alias, user@host, user@host:port or ssh://user@host:port. */
const DEST = /^(?!-)[A-Za-z0-9._%+@[\]:-]{1,255}$/;
const SSH_URL = /^ssh:\/\/[A-Za-z0-9._%+@[\]:-]{1,255}$/;

/** What an act answers: done (or under way), or why not, in plain words for the settings window. */
export type ActResult = { ok: true } | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every(k => keys.includes(k));

/** A TargetsAct from the page, checked field by field, or null (anything unexpected is refused, never repaired). */
export function parseAct(raw: unknown): TargetsAct | null {
  if (!isObj(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "activate":
      return only(raw, ["kind", "id"]) && typeof raw.id === "string" && parseTargetId(raw.id) ? { kind: "activate", id: raw.id as TargetId } : null;
    case "connect": case "disconnect": case "forget": case "uninstall":
      return only(raw, ["kind", "hostId"]) && typeof raw.hostId === "string" && HOST_ID.test(raw.hostId) ? { kind: raw.kind, hostId: raw.hostId } : null;
    case "add":
      return only(raw, ["kind", "dest"]) && typeof raw.dest === "string" && (DEST.test(raw.dest) || SSH_URL.test(raw.dest)) ? { kind: "add", dest: raw.dest } : null;
    case "wsl": case "offerSsh":
      return only(raw, ["kind", "on"]) && typeof raw.on === "boolean" ? { kind: raw.kind, on: raw.on } : null;
    case "commands": {
      if (!only(raw, ["kind", "id", "on", "askEvery"]) || typeof raw.id !== "string" || !parseTargetId(raw.id) || typeof raw.on !== "boolean") return null;
      if (raw.askEvery !== undefined && typeof raw.askEvery !== "boolean") return null;
      return { kind: "commands", id: raw.id as TargetId, on: raw.on, ...(typeof raw.askEvery === "boolean" ? { askEvery: raw.askEvery } : {}) };
    }
    case "openCommands":
      return only(raw, ["kind"]) ? { kind: "openCommands" } : null;
    default:
      return null;
  }
}

/** The channels' handlers, and how the runtime pushes a changed list to the settings window. */
export interface TargetsIpc {
  /** Sends the list to the settings window that last asked (if it is still the settings window's page). */
  push(list: TargetSummary[]): void;
}

/** Registers TARGETS_IPC's handlers. */
export function registerTargetsIpc(o: {
  ipc: IpcLike;
  isHome: (sender: WebContentsLike) => boolean;
  log: Logger;
  list: () => TargetSummary[];
  act: (a: TargetsAct) => ActResult | Promise<ActResult>;
}): TargetsIpc {
  let home: WebContentsLike | null = null;
  const fromHome = (sender: WebContentsLike | undefined, channel: string): boolean => {
    let ok: boolean;
    try { ok = !!sender && o.isHome(sender); } catch { ok = false; }
    if (!ok) o.log.warn("targets.ipc_refused", { channel });
    else home = sender!;
    return ok;
  };
  o.ipc.handle(TARGETS_IPC.list, e => {
    if (!fromHome(e?.sender, TARGETS_IPC.list)) throw new Error("not allowed");
    return o.list();
  });
  o.ipc.handle(TARGETS_IPC.act, async (e, raw) => {
    if (!fromHome(e?.sender, TARGETS_IPC.act)) throw new Error("not allowed");
    const a = parseAct(raw);
    if (!a) {
      o.log.warn("targets.act_malformed", {});
      return { ok: false, message: "Ember didn't understand that request." } satisfies ActResult;
    }
    try {
      return await o.act(a);
    } catch (err) {
      o.log.warn("targets.act_failed", { kind: a.kind, err });
      return { ok: false, message: "Something went wrong. Try again." } satisfies ActResult;
    }
  });
  return {
    push(list) {
      const h = home;
      if (!h) return;
      let still: boolean;
      try { still = o.isHome(h); } catch { still = false; }
      if (!still) { home = null; return; }
      try { h.send(TARGETS_IPC.changed, list); } catch (err) { o.log.warn("targets.push_failed", { err }); }
    },
  };
}
