/**
 * The protocol's acting methods (can_do, do_action, set_text, set_value, select_option, list_options, focus), with the
 * Python sidecar's rules: an element must be enabled and on screen; a click uses the element's own action, a one-way
 * one ("select") only where it changes something; a click on a list's row, a file or a tree item selects it as a single
 * click does and never opens it (UI Automation's Invoke on Explorer's items would), together with the list's focus
 * (where Enter goes) only in the window the user is in, since giving the keyboard elsewhere brings a window to the
 * front; secret fields are refused; what accessibility can't do but the user's mouse could says
 * "background_unavailable: …", so Ember asks to borrow the mouse; and an action whose app doesn't answer in time (a
 * button that opened a modal dialog) says "did not answer", never blocking the host. After each change the element is
 * read again for Ember to check (`after`); it going away is an answer (its dialog closed), not an error.
 */

import type { ActionResult, Bounds, CanDo, ElementInfo } from "../main/perception/sidecar";
import type { Host } from "./host";
import type { IdEntry } from "./ids";
import { isProviderError, type PerformOp, type RawNode } from "./provider";
import { BACKGROUND, BusyError, GoneError, NO_ANSWER, PermissionError, intParam, pyFloat, required } from "./protocol";
import {
  CLICK_CONTROLS, HANDLER_STOP, ITEM_ROLES, OWN_ACTIONS, PASSES_CLICK, ROW_CELL_ROLES, ROW_LIST_ROLES, actionNames, childContext,
  isChecked, statesOf,
} from "./roles";
import { innerLabel, type LabelSearch } from "./labels";
import { cellWords, nodeInfo } from "./reading";
import { boundsOf } from "./tree";

/** What each wanted action may be called, in order (as ACTION_ALIASES in ember_atspi.py). */
export const ACTION_ALIASES: Record<string, string[]> = {
  click: ["click", "press", "activate", "jump", "toggle", "check", "uncheck", "select", "dodefault", "open", "clickancestor"],
  press: ["press", "click", "activate"],
  activate: ["activate", "click", "press", "jump"],
  toggle: ["toggle", "click", "press", "activate", "check", "uncheck", "select", "dodefault"],
  expand: ["expand or contract", "expand", "open", "press"],
};
/** Actions that only turn a control one way: never used where they would change nothing (whether it is checked then). */
const ONE_WAY: Record<string, boolean> = { check: true, select: true, uncheck: false };

/** A check box in a list that only a click on it ticks (its action would open its row instead). */
export const LIST_CHECK_BOX = `${BACKGROUND}a check box in a list is ticked only by a click on it (its accessible action would open its row instead)`;
/** A row or item chosen as a click chooses it only in the window the user is in. */
export const ROW_IN_BACKGROUND = `${BACKGROUND}its window isn't the active one, and a row is chosen as a click chooses it (the list's cursor, which Enter and the app follow, with it) only by bringing the window to the front`;
export const ITEM_IN_BACKGROUND = `${BACKGROUND}its window isn't the active one, and an icon is chosen as a click chooses it (the cursor, which Enter follows, with it) only by bringing the window to the front`;
const ROW_UNSELECTABLE = `${BACKGROUND}its row can't be selected by accessibility`;
const ITEM_UNSELECTABLE = `${BACKGROUND}it can't be selected by accessibility`;
const NO_TEXT = `${BACKGROUND}this element's text can't be edited directly`;
const NO_VALUE = `${BACKGROUND}this element has no value to set`;
const NO_OPTIONS = `${BACKGROUND}this element has no selectable options`;

/** How far up the control a click goes to is looked for. */
const HANDLER_LEVELS = 64;
/** Rows of a list looked through at most, and for how long: listing them, finding one, checking for another of its name. */
const ROWS_MAX = 5000;
const LIST_ROWS_MS = 1500;
const FIND_ROW_MS = 2000;
const TWIN_ROWS_MS = 2500;
const TYPE_INSTEAD = "in a long list, type the name instead (in a file dialog: Ctrl+L, or its name field)";
/** Options looked at at most. */
const OPTIONS_MAX = 500;
/** Text read in full to change it at a place in it (append, insert): more, and it isn't changed that way. */
const COMPOSE_MAX = 100_000;

/** An element as it is now, if the user could use it now (enabled and on screen), as usable() in ember_atspi.py. */
async function usable(host: Host, id: number): Promise<{ entry: IdEntry; n: RawNode; role: string }> {
  const entry = host.snapshots.get(id);
  const n = await host.look(entry.handle);
  if (!n) throw new Error(`element ${id} is gone (the window changed); read the window again`);
  const role = host.roleOf(n, entry.read.ctx[entry.index]);
  if (n.enabled === false) throw new Error(`element ${id} is disabled right now`);
  if (n.offscreen) throw new Error(`element ${id} is no longer on screen; read the window again`);
  return { entry, n, role };
}

/** An element as it is now, enabled or not (can_do and list_options don't ask for usable). */
async function current(host: Host, id: number): Promise<{ entry: IdEntry; n: RawNode; role: string }> {
  const entry = host.snapshots.get(id);
  const n = await host.look(entry.handle);
  if (!n) throw new GoneError(id);
  return { entry, n, role: host.roleOf(n, entry.read.ctx[entry.index]) };
}

/** Refuses password and secret fields (their contents are the user's to fill in). */
function refuseSecret(host: Host, n: RawNode, role: string): void {
  if (role === "password text") throw new PermissionError("password fields are off limits to Ember; the user must fill them in");
  if (host.secrets.isSecret(host.keyOf(n), n, role, n.name.trim())) throw new PermissionError("this looks like a password or payment field; the user must fill it in");
}

/** The action that does `want` (its name, of the element's names), or background_unavailable. */
export function pickAction(n: RawNode, role: string, want: string): { names: string[]; picked: string } {
  const names = actionNames(n);
  if (!names.length) throw new Error(`${BACKGROUND}this element has no accessible actions`);
  const checked = isChecked(n, role);
  for (const candidate of ACTION_ALIASES[want] ?? [want]) {
    if (!names.includes(candidate)) continue;
    if (candidate in ONE_WAY && ONE_WAY[candidate] === checked) continue;
    return { names, picked: candidate };
  }
  throw new Error(`${BACKGROUND}no '${want}' action (has: ${names.join(", ") || "none"})`);
}

/** Actions on a row or item that would open it rather than select it as a single click does. */
const OPENS_ROW = new Set(["click", "press", "activate", "dodefault", "expand or contract", "select", "open", "jump"]);

/**
 * What a click on a row or item does instead of its own action, which may open it ("select row", "select item"), or
 * "check box" for a box in a list whose state its row says but which has no toggle of its own (the mouse ticks it);
 * null where the element's action is a click's own.
 */
export function insteadOfAction(n: RawNode, role: string, names: string[], picked: string, want: string): "select row" | "select item" | "check box" | null {
  if (!ROW_CELL_ROLES.has(role) && !ITEM_ROLES.has(role)) return null;
  if (want === "toggle" && n.toggle !== undefined && !names.includes("toggle")) return "check box";
  // A toggle of its own (a list's check box) ticks the box, and opens nothing.
  if (picked === "toggle") return null;
  if (!OPENS_ROW.has(picked)) return null;
  return ITEM_ROLES.has(role) ? "select item" : "select row";
}

/** The list a row or item is in, as read: the nearest container above it that chooses among what it holds. */
function listOf(entry: IdEntry): number {
  const { raw, roles } = entry.read;
  for (let a = raw[entry.index].parent, i = 0; a >= 0 && i < 6; a = raw[a].parent, i++) {
    if (raw[a].selection || /^(list|list box|table|tree table|tree)$/.test(roles[a] ?? "")) return a;
    if (!ROW_CELL_ROLES.has(roles[a] ?? "") && !ITEM_ROLES.has(roles[a] ?? "")) break;
  }
  return -1;
}

/** Is `n` the only item of its list selected now (`list` its index in the read)? */
async function selectedAlone(host: Host, entry: IdEntry, list: number, n: RawNode): Promise<boolean> {
  if (!n.selected) return false;
  if (list < 0) return true;
  const kids = await host.children(entry.read.raw[list].handle, ROWS_MAX).catch(() => null);
  if (!kids) return true;
  return kids.filter(k => k.selected).every(k => k.key === n.key);
}

/**
 * Selects a row or item alone, as a single click does: in the window the user is in it is given the keyboard first
 * (its list's focus, where Enter goes, moves with it, and most lists select it then); else, or where that didn't select
 * it, it is selected (UI Automation's Select replaces the selection). In a window the user isn't in, the keyboard can't
 * be given without bringing the window to the front: `inBackground` says so. Returns (it is selected alone now, it was).
 */
async function chooseItem(host: Host, entry: IdEntry, n: RawNode, unselectable: string, inBackground: string): Promise<{ ok: boolean; already: boolean }> {
  const list = listOf(entry);
  const focus = await host.windowActive(entry.read);
  if (await selectedAlone(host, entry, list, n) && (focus !== true || n.focused)) return { ok: true, already: true };
  if (focus === false) throw new Error(inBackground);
  if (!n.actions?.includes("select")) throw new Error(unselectable);
  if (focus === true && n.actions.includes("focus")) {
    const took = await perform(host, n.handle, "focus").then(() => true, () => false);
    if (took) {
      await host.settle();
      const now = await host.look(n.handle);
      if (now && now.focused && await selectedAlone(host, entry, list, now)) return { ok: true, already: false };
    }
  }
  let now = await host.look(n.handle);
  if (!now?.selected) {
    await perform(host, n.handle, "select").catch(err => {
      if (err instanceof Error && err.message === NO_ANSWER) throw err;
      throw new Error(unselectable);
    });
    await host.settle();
    now = await host.look(n.handle);
    if (!now?.selected) throw new Error(unselectable);
  }
  // Anything else still selected (a list that lets several be chosen) is unselected: a file dialog would open it too.
  if (list >= 0) {
    for (const other of await host.children(entry.read.raw[list].handle, ROWS_MAX).catch(() => [])) {
      if (other.selected && other.key !== n.key && other.actions?.includes("removeFromSelection")) {
        await perform(host, other.handle, "removeFromSelection").catch(() => undefined);
      }
    }
    await host.settle();
  }
  return { ok: !!now && await selectedAlone(host, entry, list, now), already: false };
}

/** Does a provider call; its app not answering in time is NO_ANSWER (it may still do it), a gone element GoneError. */
async function perform(host: Host, h: number, op: PerformOp, value?: unknown, id?: number): Promise<void> {
  try {
    await host.provider.perform(h, op, value);
  } catch (err) {
    if (isProviderError(err, "busy")) throw new Error(NO_ANSWER, { cause: err });
    if (isProviderError(err, "gone")) throw new GoneError(id, err);
    if (isProviderError(err, "unsupported")) throw new Error(`${BACKGROUND}this element can't ${op === "setValue" ? "have its text set" : `do "${op}"`} by accessibility`, { cause: err });
    throw err;
  }
}

/** The element after an action that worked: gone is an answer (a Close, OK or Save button closes its dialog), so is busy. */
async function afterAction(host: Host, entry: IdEntry, id?: number): Promise<{ after: ElementInfo | null; gone?: boolean; busy?: boolean }> {
  try {
    return { after: await nodeInfo(host, entry, id) };
  } catch (err) {
    if (err instanceof GoneError) return { after: null, gone: true };
    if (err instanceof BusyError) return { after: null, busy: true };
    throw err;
  }
}

/** Where the mouse lands on an element, as Ember aims (Worker.landingSpot: its middle, at most 120 px in from the left). */
function mouseSpot(b: Bounds | null): { x: number; y: number } | null {
  if (!b || b.width <= 0 || b.height <= 0) return null;
  return { x: b.x + Math.min(Math.floor(b.width / 2), 120), y: b.y + Math.floor(b.height / 2) };
}

/** Does a control round an element take a mouse click at `spot`? One without a position does, a page tab excepted. */
function takesClickAt(b: Bounds | null, role: string, spot: { x: number; y: number } | null): boolean {
  if (!spot || !b || b.width <= 0 || b.height <= 0) return role !== "page tab";
  return b.x <= spot.x && spot.x < b.x + b.width && b.y <= spot.y && spot.y < b.y + b.height;
}

/**
 * The control round an element that a click on it goes to ({role, name}), as click_handler in ember_atspi.py: null where
 * the element acts itself or nothing round it does; {unknown} when accessibility hands it further up than Ember looks.
 * `picked`: the action a click by accessibility would do (null: the mouse clicks it). Its surroundings as read.
 */
function clickHandler(host: Host, entry: IdEntry, role: string, bounds: Bounds | null, picked: string | null): { role: string; name: string } | { unknown: true } | null {
  if (picked !== null && (!PASSES_CLICK.has(picked) || (picked === "dodefault" && CLICK_CONTROLS.has(role)))) return null;
  if (picked === null && CLICK_CONTROLS.has(role)) return null;
  const byAction = picked !== null;
  const spot = byAction ? null : mouseSpot(bounds);
  const { raw, roles } = entry.read;
  let a = raw[entry.index].parent;
  for (let i = 0; i < HANDLER_LEVELS; i++) {
    if (a < 0) return null;
    const r = roles[a] ?? "";
    if (HANDLER_STOP.has(r) || raw[a].depth === 0) return null;
    const acts = actionNames(raw[a]).some(x => OWN_ACTIONS.has(x));
    if ((acts || (!byAction && CLICK_CONTROLS.has(r))) && (byAction || takesClickAt(boundsOf(raw[a].bounds), r, spot))) {
      return { role: r, name: host.secrets.saidName(raw[a].name.trim(), host.keyOf(raw[a]), entry.read.window.pid).slice(0, 200) };
    }
    a = raw[a].parent;
  }
  return byAction ? { unknown: true } : null;
}

/** Can this element's text be set (a writable value)? */
const takesText = (n: RawNode) => !!n.actions?.includes("setValue");
/** Has it a number to set? */
const takesValue = (n: RawNode) => !!n.range && !n.range.readOnly && !!n.actions?.includes("setRange");

async function canDo(host: Host, params: Record<string, unknown>): Promise<CanDo> {
  const id = intParam(params, "id");
  const { entry, n, role } = await current(host, id);
  const kind = params.kind;
  const out: CanDo = { tier1: true };
  let picked: string | null = null;
  try {
    if (kind === "click" || kind === "toggle") {
      const found = pickAction(n, role, kind);
      picked = out.action = found.picked;
      const instead = insteadOfAction(n, role, found.names, found.picked, kind);
      if (instead === "check box") {
        // Ticked by a click on it alone: the mouse does it.
        out.action = "toggle";
        picked = null;
        throw new Error(LIST_CHECK_BOX);
      }
      if (instead) {
        out.action = instead;
        if (kind === "click") {
          const row = instead === "select row";
          if (!n.actions?.includes("select")) throw new Error(row ? ROW_UNSELECTABLE : ITEM_UNSELECTABLE);
          if (!await selectedAlone(host, entry, listOf(entry), n) && await host.windowActive(entry.read) === false) {
            throw new Error(row ? ROW_IN_BACKGROUND : ITEM_IN_BACKGROUND);
          }
        }
      }
    } else if (kind === "text") {
      if (!takesText(n)) throw new Error(NO_TEXT);
    } else if (kind === "value") {
      if (!takesValue(n)) throw new Error(NO_VALUE);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith(BACKGROUND.trim())) throw err;
    out.tier1 = false;
    out.why = message.slice(BACKGROUND.length);
  }
  if (kind === "click" || kind === "toggle") {
    // Whichever way it is clicked: by accessibility, or with the mouse where it can't be (picked is null).
    const handler = clickHandler(host, entry, role, boundsOf(n.bounds), picked);
    if (handler && "unknown" in handler) out.handlerUnknown = true;
    else if (handler) out.handler = handler;
  }
  if (params.caret) {
    out.focused = statesOf(n, role).includes("focused");
    const active = await host.windowActive(entry.read);
    if (active !== null) out.windowActive = active;
  }
  return out;
}

/** The provider operation for an action name. */
function opFor(picked: string, n: RawNode): PerformOp {
  switch (picked) {
    case "toggle": return "toggle";
    case "select": return "select";
    case "expand or contract": return n.expanded === true ? "collapse" : "expand";
    case "dodefault": return "legacy";
    default: return "invoke";
  }
}

async function doAction(host: Host, params: Record<string, unknown>): Promise<ActionResult> {
  const id = intParam(params, "id");
  const { entry, n, role } = await usable(host, id);
  const want = String(params.action || "click").toLowerCase();
  const { names, picked } = pickAction(n, role, want);
  // Never an action that would open a row: what a click does instead, or nothing.
  const instead = insteadOfAction(n, role, names, picked, want);
  if (instead === "check box") throw new Error(LIST_CHECK_BOX);
  if (instead && want !== "click") throw new Error(`element ${id} is no switch or check box: a click on it only selects it`);
  if (instead) {
    const row = instead === "select row";
    const before = await nodeInfo(host, entry, id);
    const { ok } = await chooseItem(host, entry, n, row ? ROW_UNSELECTABLE : ITEM_UNSELECTABLE, row ? ROW_IN_BACKGROUND : ITEM_IN_BACKGROUND);
    return { ...await afterAction(host, entry, id), ok, action: instead, before };
  }
  const before = await nodeInfo(host, entry, id);
  await perform(host, n.handle, opFor(picked, n), undefined, id);
  await host.settle();
  return { ...await afterAction(host, entry, id), ok: true, action: picked, before };
}

async function setText(host: Host, params: Record<string, unknown>): Promise<ActionResult> {
  const id = intParam(params, "id");
  const { entry, n, role } = await usable(host, id);
  refuseSecret(host, n, role);
  const text = typeof params.text === "string" ? params.text : String(params.text ?? "");
  const mode = typeof params.mode === "string" ? params.mode : "replace";
  if (!takesText(n)) throw new Error(NO_TEXT);
  let value = text;
  if (mode !== "replace") {
    // Text goes in at a place only where the whole of what is there was read (the platform sets a field's text whole).
    let info;
    try {
      info = await host.provider.textInfo(n.handle, COMPOSE_MAX);
    } catch (err) {
      if (isProviderError(err, "busy")) throw new BusyError();
      info = {};
    }
    if (info.secret) throw new PermissionError("password fields are off limits to Ember; the user must fill them in");
    const now = info.text ?? n.value ?? "";
    const whole = info.text !== undefined ? !info.truncated && now.length < COMPOSE_MAX : now.length < 2000;
    if (!whole) throw new Error(`${BACKGROUND}this element's text is too long to change at a place in it directly`);
    // Inserted at the caret, as AT-SPI inserts it: a selection there isn't replaced.
    if (mode === "append" || !now) value = now + text;
    else if (info.caret !== undefined && info.caret <= now.length) value = now.slice(0, info.caret) + text + now.slice(info.caret);
    else if (info.caretAtEnd) value = now + text;
    else throw new Error(`${BACKGROUND}where the caret is in this element's text can't be told`);
  }
  try {
    await perform(host, n.handle, "setValue", value, id);
  } catch (err) {
    if (isProviderError(err, "denied")) throw new PermissionError("password fields are off limits to Ember; the user must fill them in");
    throw err;
  }
  await host.settle();
  return { ...await afterAction(host, entry, id), ok: true };
}

async function setValue(host: Host, params: Record<string, unknown>): Promise<ActionResult> {
  const id = intParam(params, "id");
  const { entry, n, role } = await usable(host, id);
  refuseSecret(host, n, role);
  if (!takesValue(n)) throw new Error(NO_VALUE);
  const raw = required(params, "value");
  const value = typeof raw === "number" ? raw : Number(raw);
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim() || Number.isNaN(value))) {
    throw new Error(`could not convert string to float: ${JSON.stringify(String(raw))}`);
  }
  const { min, max } = n.range!;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`value ${pyFloat(value)} is outside ${pyFloat(min)}..${pyFloat(max)}`);
  await perform(host, n.handle, "setRange", value, id);
  await host.settle();
  return { ok: true, after: await nodeInfo(host, entry) };
}

/** The option called `want`: its exact name, else the one name equal to it but for case; never part of a name. */
export function optionIndex(names: string[], want: string): number | null {
  const w = want.trim();
  if (!w) return null;
  const exact = names.indexOf(w);
  if (exact >= 0) return exact;
  const same = names.map((n, i) => [n, i] as const).filter(([n]) => n.toLowerCase() === w.toLowerCase());
  return same.length && new Set(same.map(([n]) => n)).size === 1 ? same[0][1] : null;
}

/** A list of rows' rows (a table's, a tree's top level), its headers left out. */
async function rowsOf(host: Host, n: RawNode): Promise<RawNode[]> {
  return (await host.children(n.handle, ROWS_MAX)).filter(r => !/^(Header|HeaderItem|ScrollBar|AXColumn|AXScrollBar)$/.test(r.platformRole));
}

/** The names of rows, from the first, for at most `ms` (their own names, else the first name in them). */
async function rowNames(host: Host, rows: RawNode[], pid: number, ms: number, stopAt?: string): Promise<string[]> {
  const until = Date.now() + ms;
  const names: string[] = [];
  for (const r of rows) {
    if (Date.now() >= until) break;
    const name = r.name.trim() ? host.secrets.saidName(r.name.trim(), host.keyOf(r), pid) : await cellWords(host, r, pid);
    names.push(name);
    if (stopAt !== undefined && stopAt && name === stopAt) break;
  }
  return names;
}

/** The options of a combo box or list: what it chooses among, and their names (secret or withheld ones nameless, in place). */
async function optionItems(host: Host, entry: IdEntry, n: RawNode, role: string): Promise<{ names: string[]; items: RawNode[]; rows?: number }> {
  refuseSecret(host, n, role);
  const pid = entry.read.window.pid;
  const ctx = entry.read.ctx[entry.index];
  if (ROW_LIST_ROLES.has(role)) {
    const rows = await rowsOf(host, n);
    const names = await rowNames(host, rows, pid, LIST_ROWS_MS);
    return { names, items: rows.slice(0, names.length), rows: rows.length };
  }
  // A combo box keeps its options in a list of its own (a closed one's too); a list holds them itself.
  let holder = n, holderCtx = childContext(ctx, n, role);
  if (role === "combo box") {
    const kids = await host.children(n.handle, 8);
    const list = kids.find(k => /^(list|list box|menu)$/.test(host.roleOf(k, holderCtx)));
    if (list) { holder = list; holderCtx = childContext(holderCtx, list, host.roleOf(list, holderCtx)); }
  }
  const items = (await host.children(holder.handle, OPTIONS_MAX)).filter(c => c.platformRole !== "ScrollBar" && c.platformRole !== "Button");
  if (!n.selection && !holder.selection && !items.some(c => c.actions?.includes("select"))) throw new Error(NO_OPTIONS);
  const names: string[] = [];
  for (const c of items) {
    const r = host.roleOf(c, holderCtx);
    const name = c.name.trim();
    if (host.secrets.isSecret(host.keyOf(c), c, r, name)) { names.push(""); continue; }
    const search = (el: RawNode, at = holderCtx): LabelSearch => ({
      role: host.roleOf(el, at), name: el.name,
      children: async () => (await host.children(el.handle, 16)).map(k => search(k, childContext(at, el, host.roleOf(el, at)))),
    });
    names.push(host.secrets.saidName(name || await innerLabel(search(c)), host.keyOf(c), pid));
  }
  return { names, items };
}

async function listOptions(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const id = intParam(params, "id");
  const { entry, n, role } = await current(host, id);
  const { names, rows } = await optionItems(host, entry, n, role);
  return rows !== undefined && rows > names.length ? { options: names, left: rows - names.length } : { options: names };
}

async function selectOption(host: Host, params: Record<string, unknown>): Promise<ActionResult & { already?: boolean }> {
  const id = intParam(params, "id");
  const { entry, n, role } = await usable(host, id);
  refuseSecret(host, n, role);
  const want = String(params.option ?? "").trim();
  const pid = entry.read.window.pid;
  if (ROW_LIST_ROLES.has(role)) {
    // A row, selected alone as a click on it selects it: two of that name can't be told apart.
    const rows = await rowsOf(host, n);
    const start = Date.now();
    const count = Math.min(rows.length, ROWS_MAX);
    let names = await rowNames(host, rows.slice(0, count), pid, FIND_ROW_MS, want);
    let index: number | null = want && names[names.length - 1] === want ? names.length - 1 : null;
    if (index === null) {
      if (names.length < rows.length) throw new Error(`Ember looked through the list's first ${names.length} rows of ${rows.length} in time and none is called exactly that: ${TYPE_INSTEAD}`);
      index = optionIndex(names, want);
      if (index === null) throw new Error(`no option has exactly that name (it has ${rows.length} options); list them and use one in full`);
    }
    const same = names[index].toLowerCase();
    if (names.length < count) names = [...names, ...await rowNames(host, rows.slice(names.length, count), pid, Math.max(0, start + TWIN_ROWS_MS - Date.now()))];
    if (names.filter(x => x.toLowerCase() === same).length > 1) throw new Error("several rows are called that; click a cell of the one meant instead");
    let chosen: { ok: boolean; already: boolean };
    try {
      chosen = await chooseRow(host, entry, rows[index]);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ROW_IN_BACKGROUND) throw err;
      throw new Error("its window isn't the active one, and choosing a row there by name would bring it to the front: click a cell of that row instead", { cause: err });
    }
    const res: ActionResult & { already?: boolean } = { ...await afterAction(host, entry, id), ok: chosen.ok, option: names[index] };
    if (chosen.already) res.already = true;
    if (rows.length - names.length > 0) res.unchecked = rows.length - names.length;
    return res;
  }
  const { names, items } = await optionItems(host, entry, n, role);
  const index = optionIndex(names, want);
  // The options themselves are app text: they are listed with list_options, not in an error.
  if (index === null) throw new Error(`no option has exactly that name (it has ${names.length} options); list them and use one in full`);
  const item = items[index];
  if (item.selected) return { ...await afterAction(host, entry, id), ok: true, option: names[index], already: true };
  const was = items.find(c => c.selected);
  let ok = await perform(host, item.handle, "select").then(() => true, err => {
    if (err instanceof Error && err.message === NO_ANSWER) throw err;
    return false;
  });
  await host.settle();
  if (ok) ok = !!(await host.look(item.handle).catch(() => null))?.selected;
  if (!ok && was) {
    // The field was left emptier than it was: the option chosen before is chosen again.
    const still = await host.look(was.handle).catch(() => null);
    if (still && !still.selected) await perform(host, was.handle, "select").catch(() => undefined);
  }
  const res = { ...await afterAction(host, entry, id), ok, option: names[index] };
  // A drop-down that shows its choice must show this one: an option that says it is selected while its box still
  // shows another (a list behind a closed box the app didn't hear about) wasn't chosen as far as the user can see.
  if (ok && role === "combo box" && res.after?.selected !== undefined && res.after.selected !== "" && res.after.selected !== names[index]) res.ok = false;
  return res;
}

/** A list's row chosen by its words: selected alone, as a click on it selects it (see chooseItem). */
async function chooseRow(host: Host, listEntry: IdEntry, row: RawNode): Promise<{ ok: boolean; already: boolean }> {
  // The row is looked at through its list (the read's entry for the list), whose handle chooses among them.
  const entry: IdEntry = {
    handle: row.handle,
    read: { ...listEntry.read, raw: [...listEntry.read.raw, { ...row, parent: listEntry.index, depth: listEntry.read.raw[listEntry.index].depth + 1 }] },
    index: listEntry.read.raw.length,
  };
  return chooseItem(host, entry, row, ROW_UNSELECTABLE, ROW_IN_BACKGROUND);
}

async function focus(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const id = intParam(params, "id");
  const { entry, n } = await usable(host, id);
  // Giving an element the keyboard brings its window to the front: only in the window the user is in already.
  if (await host.windowActive(entry.read) !== true) throw new Error(`${BACKGROUND}its window isn't the active one, and giving an element there the keyboard would bring it to the front`);
  await perform(host, n.handle, "focus", undefined, id);
  await host.settle();
  return { ok: true, after: await nodeInfo(host, entry) };
}

/** The acting methods, by protocol name. */
export const ACTING = {
  can_do: canDo,
  do_action: doAction,
  set_text: setText,
  set_value: setValue,
  select_option: selectOption,
  list_options: listOptions,
  focus,
};
