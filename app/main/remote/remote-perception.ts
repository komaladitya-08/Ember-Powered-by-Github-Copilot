/**
 * A remote's screen as a worker and the conductor read it (§5.5): reads, focus, windows, the point under a position and
 * the system-dialog check go to the agent's `perceive.*` ops; every text the model gets (perceive_window's elements,
 * describe_screen's description, the quick context and the open-windows list) is built here on the PC from the remote's
 * structured answers with Perception's own text functions (S0b), so every remote string is quoted and wrapped by
 * Ember's code, byte for byte as this screen's would be for the same read. The PC applies its own never-look list and
 * the remote OS's security-window vocabulary again to what comes back (a window that is private here is blocked here,
 * whatever the remote said), and withholds secret fields' contents again. A picture comes as a checked PNG
 * (remote-capture.ts). Every position is the remote's own: the PC never flies to it. Plain Node (sharp loads lazily, PC only).
 */

import { describeText, openWindowLines, openWindowsBlock, perceivedText, quickContextText, type OpenWindow, type Perceived, type QuickContext, type Seen, type WindowTarget } from "../perception";
import { insideSecrets, isNeverLook, secretIds, withheldIds } from "../perception/elements";
import { isSecurityWindow } from "../policy/policy";
import { PLATFORM_WORDS } from "../../shared/words";
import { checkRemoteImage, dropChannel, imageWaitMs, receiveImage } from "./remote-capture";
import { askRemote, type ElementBook } from "./remote-sidecar";
import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import type { AxNode, AxWindow, PointElement } from "../perception/sidecar";
import type { PerceptionPort } from "../perception/ports";
import type { Logger } from "../logger";
import type { RemoteDesktop } from "./remote-policy";
import type { RemoteLink } from "./types";
import type Sharp from "sharp";

/** How much longer a read with a picture may take than one without (the picture travels before its answer). */
const IMAGE_EXTRA_MS = 20_000;

/** What createRemotePerception needs. */
export interface RemotePerceptionOptions {
  label: string;
  /** The remote's OS: its security-window vocabulary and its words for why there is no picture. */
  os: OS;
  /** The target's id: a quick context read here carries it (a task starts there only on this target). */
  targetId: TargetId;
  log: Logger;
  /** The never-look list in force for this remote (gate 1's). */
  neverLook: () => string[];
  /**
   * Has the remote confirmed the never-look list in force here (policy.sync)? It masks those windows before a pixel
   * leaves, which the PC can't do afterwards: until it has, no picture is asked for.
   */
  neverLookSynced: () => Promise<boolean>;
  /** How much of the remote's desktop Ember uses now. */
  desktop: () => RemoteDesktop;
  /** The elements this link read (the sidecar's steps name only these). */
  elements: ElementBook;
  /** sharp (tests; default: loaded on first use). */
  sharp?: typeof Sharp;
}

/**
 * Why there is no picture, as the remote's Perception says it (perception/index.ts and its words): passed on only when it
 * is one of these exact texts; anything else a remote says becomes Ember's own words (§7.2 item 4).
 */
function knownNoShot(os: OS): ReadonlySet<string> {
  const words = PLATFORM_WORDS[os];
  return new Set([
    "screenshots aren't available on this display",
    "a password prompt is open, so Ember looks away until it's done",
    "a system dialog is open, so Ember looks away until it's done",
    words.shellUnchecked,
    words.overviewOpen,
    "Ember couldn't find the window on screen, so it can't tell what covers it",
    "the window is covered by other windows",
    "Ember couldn't check for private windows",
    "Ember couldn't check where its own windows are",
    "the app is busy, so Ember can't check it for password fields; try again in a moment",
    "Ember couldn't check the whole window for password fields",
    "the window is too big for Ember to check all of it for password fields in time; close what you don't need, or work in a smaller part of it",
    "the window is off screen, or the screen couldn't be captured safely",
  ]);
}

/**
 * What a remote read becomes on the PC: blocked when the window is private by the PC's own never-look list or the remote
 * OS's security vocabulary (its title and elements dropped, as Perception.read drops them), the app's other windows that
 * are private left out, and secret fields' contents withheld again (secretIds, insideSecrets, withheldIds: a read that
 * the remote's Perception already made is unchanged by this).
 */
export function guardSeen(seen: Seen, list: string[], isPrivateWindow: (w: { app?: string; title?: string }) => boolean): Seen {
  const look = list.filter(i => i.trim());
  const isPrivate = (app: string, title: string) => isNeverLook({ app, name: title }, look) || isPrivateWindow({ app, title });
  const w = seen.window, x = seen.x11Window;
  const blocked = seen.blocked || !!w && isPrivate(w.app, w.name) || !!x && isPrivate(x.wmClass ?? "", x.title);
  if (blocked) {
    // A private window's title goes no further than this (not to the model, not to the logs).
    return { window: w && { ...w, name: "" }, x11Window: x && { ...x, title: "" }, nodes: [], blocked: true, busy: false, truncated: null, others: [], ms: seen.ms, axScale: 1 };
  }
  return { ...seen, others: seen.others.filter(other => !isPrivate(w?.app ?? "", other.name)), nodes: withheld(seen.nodes.map(plainStates)) };
}

/**
 * A state as Ember lists it: a plain word or two ("focused", "multi line"), as every accessibility reader says them.
 * The element lists print states bare, unquoted (this screen's come from AT-SPI's own names), so a remote's state
 * that is anything else (`</screen>`, a sentence with a colon) is dropped here, never printed.
 */
const PLAIN_STATE = /^[a-z][a-z0-9 _-]{0,31}$/i;

/** A remote's element with only the states Ember can print as they are. */
function plainStates(n: AxNode): AxNode {
  return n.states.every(st => PLAIN_STATE.test(st)) ? n : { ...n, states: n.states.filter(st => PLAIN_STATE.test(st)) };
}

/** The read's nodes with secret fields' contents withheld (Perception.withSecrets, without telling a reader: there is none here). */
function withheld(nodes: AxNode[]): AxNode[] {
  const secret = secretIds(nodes);
  const inside = insideSecrets(nodes, secret);
  const saysSelected = new Set<number>();
  const names = withheldIds(nodes, secret, saysSelected);
  if (!secret.size && !inside.size && !names.size && !saysSelected.size) return nodes;
  return nodes.flatMap(n => {
    if (inside.has(n.id)) return [];
    if (names.has(n.id)) {
      const { text: _text, selection: _selection, selected: _selected, ...rest } = n;
      n = { ...rest, name: "", withheld: true };
    } else if (saysSelected.has(n.id)) {
      const { selected: _selected, ...rest } = n;
      n = rest;
    }
    if (!secret.has(n.id) || n.secret) return [n];
    const { text: _text, selection: _selection, selected: _selected, value: _value, ...rest } = n;
    return [{ ...rest, secret: true }];
  });
}

/** A remote's screen as a PerceptionPort (§5.5). */
export function createRemotePerception(link: RemoteLink, o: RemotePerceptionOptions): PerceptionPort {
  const { label, os } = o;
  const noShots = knownNoShot(os);
  const isPrivateWindow = (w: { app?: string; title?: string; name?: string }) => isSecurityWindow(w, os);
  const isPrivate = (app: string, title: string) => isNeverLook({ app, name: title }, o.neverLook().filter(i => i.trim())) || isPrivateWindow({ app, title });

  /** The remote's desktop, or an error saying why Ember can't use it. */
  const usable = (): RemoteDesktop => {
    const d = o.desktop();
    if (d.desktop === "none") throw new Error(d.why ?? `Ember can't use ${label}'s desktop.`);
    return d;
  };
  /** A read as the PC lets it through; a kept read's element ids are the ones steps may name. */
  const seenOf = (s: Seen, kept: boolean): Seen => {
    const seen = guardSeen(s, o.neverLook(), isPrivateWindow);
    if (kept && !seen.blocked) o.elements.noteRead(seen.nodes);
    return seen;
  };
  const focusedSeen = async (): Promise<Seen> => {
    usable();
    return seenOf(await askRemote(link, "perceive.focused", {}, { label }), true);
  };
  /** The remote's open windows as Ember lists them, private ones left out ([] when the list can't be had). */
  const openLines = async (): Promise<OpenWindow[]> => {
    try {
      const r = await askRemote(link, "perceive.openWindows", {}, { label });
      return r.lines.filter(l => !isPrivate(l.app, l.title)).map(l => ({ app: l.app, title: l.title, active: l.active, ...(l.busy ? { busy: true } : {}) }));
    } catch (err) {
      o.log.warn("remote.open_windows_failed", { err: err instanceof Error ? err.name : "error" });
      return [];
    }
  };

  return {
    focused: () => focusedSeen(),

    async read(target: WindowTarget, _x11Window?: unknown, _stack?: unknown, opts: { keep?: boolean; cells?: string[] } = {}): Promise<Seen> {
      usable();
      const args = {
        target: { ...(target.pid != null ? { pid: target.pid } : {}), ...(target.title ? { title: target.title } : {}), ...(target.path ? { path: target.path } : {}) },
        ...(opts.keep === false ? { keep: false } : {}),
        ...(opts.cells?.length ? { cells: opts.cells } : {}),
      };
      return seenOf(await askRemote(link, "perceive.read", args, { label }), opts.keep !== false);
    },

    async atPoint(target: WindowTarget, p: { x: number; y: number }, k = 1): Promise<PointElement[] | null> {
      if (target.pid == null || !target.path || o.desktop().desktop === "none") return null;
      try {
        const r = await askRemote(link, "perceive.atPoint", { target: { pid: target.pid, path: target.path }, x: p.x, y: p.y, k }, { label });
        return r.chain;
      } catch {
        // Can't be told (as when the remote's app didn't answer): the caller treats it as unknown.
        return null;
      }
    },

    async quickContext(): Promise<QuickContext | null> {
      if (o.desktop().desktop === "none") return null;
      let seen: Seen;
      try {
        seen = await focusedSeen();
      } catch {
        return null;
      }
      const title = seen.window?.name || seen.x11Window?.title || "";
      const ctx = quickContextText(seen, seen.blocked || !title ? [] : openWindowLines(await openLines()));
      return ctx && { ...ctx, targetId: o.targetId };
    },

    async describe(): Promise<string> {
      const d = o.desktop();
      if (d.desktop === "none") return `Ember can't read ${label}'s screen: ${d.why ?? "there is no desktop session it can use"}`;
      let seen: Seen;
      try {
        seen = await focusedSeen();
      } catch (err) {
        o.log.warn("remote.describe_failed", { err: err instanceof Error ? err.name : "error" });
        return `Ember could not read ${label}'s screen right now (it didn't answer).`;
      }
      // (Nothing more is listed for a private window.)
      return describeText(seen, seen.blocked ? "" : openWindowsBlock(await openLines()));
    },

    async perceive(opts: { image: boolean; scope: "window" | "screen"; target?: WindowTarget }): Promise<Perceived> {
      const d = usable();
      // A picture only once the remote has the never-look list in force here (it masks those windows before sending).
      const unsynced = opts.image && d.desktop === "screen" && !(await o.neverLookSynced().catch(() => false));
      const image = opts.image && d.desktop === "screen" && !unsynced;
      const target = opts.target && { ...(opts.target.pid != null ? { pid: opts.target.pid } : {}), ...(opts.target.title ? { title: opts.target.title } : {}), ...(opts.target.path ? { path: opts.target.path } : {}) };
      const r = await askRemote(link, "perceive.perceive", { image, scope: opts.scope, ...(target ? { target } : {}) }, { label, extraMs: image ? IMAGE_EXTRA_MS : 0 });
      const seen = seenOf(r.seen, true);
      const text = perceivedText(seen);
      const noShot = (why: string): Perceived => ({ ...seen, text: `${text}\n(No screenshot: ${why}.)`, capture: null });
      if (!opts.image || seen.blocked) {
        // A picture of a window that is private here never goes further: its bytes are taken and dropped.
        if (r.image) dropChannel(link, r.image.channel);
        return { ...seen, text, capture: null };
      }
      if (!image) {
        if (r.image) dropChannel(link, r.image.channel);
        return noShot(unsynced ? `${label} hasn't confirmed which windows Ember must not look at` : d.noShot ?? `${label} gives Ember no screenshots`);
      }
      if (!r.image) return noShot(r.noShot !== undefined && noShots.has(r.noShot) ? r.noShot : `${label} didn't send one`);
      const bytes = await receiveImage(link, r.image, label, imageWaitMs(r.image, link.rttMs));
      if (!(bytes instanceof Uint8Array)) return noShot(bytes.why);
      // The desktop may have gone (locked, a policy change) while the picture travelled: then it isn't used.
      if (o.desktop().desktop !== "screen") return noShot(o.desktop().noShot ?? `${label}'s desktop can't be used now`);
      const picture = await checkRemoteImage(bytes, r.image, seen.nodes, label, o.sharp ? { sharp: o.sharp } : {});
      if ("why" in picture) {
        o.log.warn("remote.image_refused", { why: picture.why.replace(label, "<host>") });
        return noShot(picture.why);
      }
      return { ...seen, text, capture: picture.capture };
    },

    async systemDialogOpen(): Promise<boolean> {
      if (o.desktop().desktop === "none") return true;
      try {
        return (await askRemote(link, "perceive.systemDialog", {}, { label })).open;
      } catch {
        // Can't tell: one may be open (fail closed: Ember looks away).
        return true;
      }
    },

    async windows(): Promise<AxWindow[]> {
      usable();
      const { windows } = await askRemote(link, "perceive.windows", {}, { label });
      return windows.filter(w => !isPrivate(w.app, w.name));
    },
  };
}
