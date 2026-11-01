/**
 * What the agent reads on its screen, shaped to the protocol's strict schemas (§5.4: every object strict, every string
 * and list capped by CAPS, every number finite and every position inside ±CAPS.coord). Perception and the sidecar hand
 * out richer objects than the wire carries (an X11 window's class name, a read's internal fields), so each mapper picks
 * the fields the schema names and cuts what is too long, instead of sending an object the PC's mux would reject and
 * reset the link over. Pure.
 */

import type { Seen, WindowTarget } from "../main/perception";
import type { ActionResult, AxNode, AxWindow, Bounds, CanDo, ElementInfo, OtherWindow, PointElement } from "../main/perception/sidecar";
import type { DesktopApp } from "../main/hands/system";
import { execArgv } from "../main/hands/system";
import { CAPS, type RemoteApp, type SeenWire } from "../main/remote/protocol";

/** `s` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
export function cut(s: unknown, max: number): string {
  const t = typeof s === "string" ? s : "";
  if (t.length <= max) return t;
  const end = /[\ud800-\udbff]/.test(t[max - 1] ?? "") ? max - 1 : max;
  return t.slice(0, end);
}

/** A string with every control character dropped (names the PC may pass to a program), cut to `max`. */
export function plain(s: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are what's removed
  return cut(typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "") : "", max);
}

const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.trunc(v))) : 0);
const coord = (v: number) => Math.max(-CAPS.coord, Math.min(CAPS.coord, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A rectangle inside ±CAPS.coord, or null when any of it isn't a finite number. */
export function wireBounds(b: Bounds | null | undefined): Bounds | null {
  if (!b || !finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height)) return null;
  return { x: coord(b.x), y: coord(b.y), width: coord(b.width), height: coord(b.height) };
}

const strings = (list: unknown, n: number, max: number): string[] => (Array.isArray(list) ? list.slice(0, n).map(s => cut(s, max)) : []);

/** An optional field: present only when `v` is. */
const opt = <K extends string, V>(k: K, v: V | undefined | null): Partial<Record<K, V>> => (v === undefined || v === null ? {} : ({ [k]: v } as Record<K, V>));

export function wireWindow(w: AxWindow): AxWindow {
  return {
    app: cut(w.app, CAPS.str.app),
    pid: finite(w.pid) ? int(w.pid) : null,
    ...opt("path", w.path !== undefined ? cut(w.path, CAPS.str.path) : undefined),
    name: cut(w.name, CAPS.str.title),
    role: cut(w.role, CAPS.str.role),
    active: !!w.active,
    bounds: wireBounds(w.bounds),
    ...(w.busy ? { busy: true } : {}),
  };
}

function wireNode(n: AxNode): AxNode {
  const shown = wireBounds(n.shown);
  return {
    id: int(n.id),
    parent: finite(n.parent) ? int(n.parent) : null,
    depth: int(n.depth, 10_000),
    role: cut(n.role, CAPS.str.role),
    name: cut(n.name, CAPS.str.name),
    states: strings(n.states, CAPS.states, CAPS.str.state),
    bounds: wireBounds(n.bounds),
    ...opt("actions", Array.isArray(n.actions) ? strings(n.actions, CAPS.states, CAPS.str.app) : undefined),
    ...opt("text", n.text !== undefined ? cut(n.text, CAPS.str.text) : undefined),
    ...opt("selection", n.selection !== undefined ? cut(n.selection, CAPS.str.text) : undefined),
    ...opt("selected", n.selected !== undefined ? cut(n.selected, CAPS.str.name) : undefined),
    ...opt("value", finite(n.value) ? n.value : undefined),
    ...opt("editable", typeof n.editable === "boolean" ? n.editable : undefined),
    ...opt("secret", typeof n.secret === "boolean" ? n.secret : undefined),
    ...opt("withheld", typeof n.withheld === "boolean" ? n.withheld : undefined),
    ...opt("shown", shown ?? undefined),
    ...opt("grid", typeof n.grid === "boolean" ? n.grid : undefined),
    ...opt("size", n.size ? { rows: int(n.size.rows, 2 ** 31), columns: int(n.size.columns, 2 ** 31) } : undefined),
  };
}

function wireOther(o: OtherWindow): OtherWindow {
  return { name: cut(o.name, CAPS.str.title), role: cut(o.role, CAPS.str.role), active: !!o.active, modal: !!o.modal };
}

/** A read as Seen's wire form (SeenWire). */
export function wireSeen(s: Seen): SeenWire {
  const x = s.x11Window;
  return {
    window: s.window ? wireWindow(s.window) : null,
    x11Window: x ? {
      id: int(x.id), pid: finite(x.pid) ? int(x.pid) : null, title: cut(x.title, CAPS.str.title),
      x: finite(x.x) ? coord(x.x) : 0, y: finite(x.y) ? coord(x.y) : 0, width: finite(x.width) ? coord(x.width) : 0, height: finite(x.height) ? coord(x.height) : 0,
      ...opt("wmClass", x.wmClass !== undefined ? cut(x.wmClass, CAPS.str.app) : undefined),
    } : null,
    nodes: (s.nodes ?? []).slice(0, CAPS.nodes).map(wireNode),
    blocked: !!s.blocked,
    busy: !!s.busy,
    truncated: s.truncated === "nodes" || s.truncated === "time" || s.truncated === "depth" || s.truncated === "loading" ? s.truncated : null,
    others: (s.others ?? []).slice(0, CAPS.windows).map(wireOther),
    ms: finite(s.ms) ? Math.max(0, s.ms) : 0,
    axScale: finite(s.axScale) && s.axScale > 0 ? Math.min(16, s.axScale) : 1,
    ...(s.ember ? { ember: true } : {}),
  };
}

export function wireElementInfo(e: ElementInfo): ElementInfo {
  const shown = wireBounds(e.shown);
  return {
    role: cut(e.role, CAPS.str.role),
    name: cut(e.name, CAPS.str.name),
    states: strings(e.states, CAPS.states, CAPS.str.state),
    bounds: wireBounds(e.bounds),
    ...opt("text", e.text !== undefined ? cut(e.text, CAPS.str.text) : undefined),
    ...opt("value", finite(e.value) ? e.value : undefined),
    ...opt("selected", e.selected !== undefined ? cut(e.selected, CAPS.str.name) : undefined),
    ...opt("secret", typeof e.secret === "boolean" ? e.secret : undefined),
    ...opt("withheld", typeof e.withheld === "boolean" ? e.withheld : undefined),
    ...opt("shown", shown ?? undefined),
    ...opt("open", typeof e.open === "boolean" ? e.open : undefined),
    ...opt("offscreen", typeof e.offscreen === "boolean" ? e.offscreen : undefined),
    ...opt("formula", e.formula !== undefined ? cut(e.formula, CAPS.str.text) : undefined),
  };
}

export function wireCanDo(c: CanDo): CanDo {
  return {
    tier1: !!c.tier1,
    ...opt("why", c.why !== undefined ? cut(c.why, CAPS.str.reason) : undefined),
    ...opt("focused", typeof c.focused === "boolean" ? c.focused : undefined),
    ...opt("windowActive", typeof c.windowActive === "boolean" ? c.windowActive : undefined),
    ...opt("action", c.action !== undefined ? cut(c.action, CAPS.str.app) : undefined),
    ...opt("handler", c.handler ? { role: cut(c.handler.role, CAPS.str.role), name: cut(c.handler.name, CAPS.str.name) } : undefined),
    ...opt("handlerUnknown", typeof c.handlerUnknown === "boolean" ? c.handlerUnknown : undefined),
  };
}

export function wireActionResult(r: ActionResult): ActionResult {
  return {
    ok: !!r.ok,
    ...opt("action", r.action !== undefined ? cut(r.action, CAPS.str.app) : undefined),
    ...opt("option", r.option !== undefined ? cut(r.option, CAPS.str.name) : undefined),
    ...opt("before", r.before ? wireElementInfo(r.before) : undefined),
    after: r.after ? wireElementInfo(r.after) : null,
    ...opt("gone", typeof r.gone === "boolean" ? r.gone : undefined),
    ...opt("busy", typeof r.busy === "boolean" ? r.busy : undefined),
    ...opt("unchecked", finite(r.unchecked) ? int(r.unchecked) : undefined),
  };
}

export function wirePoint(p: PointElement): PointElement {
  return {
    role: cut(p.role, CAPS.str.role),
    name: cut(p.name, CAPS.str.name),
    bounds: wireBounds(p.bounds),
    ...opt("secret", typeof p.secret === "boolean" ? p.secret : undefined),
    ...opt("empty", typeof p.empty === "boolean" ? p.empty : undefined),
  };
}

/** A window target from the PC as Perception takes it (only the fields it names). */
export function targetOf(t: WindowTarget): WindowTarget {
  return { ...opt("pid", t.pid), ...opt("title", t.title), ...opt("path", t.path) };
}

/** An installed app as the PC judges it (its id, names, launch argv and Terminal=), or null when its id can't travel. */
export function wireApp(a: DesktopApp): RemoteApp | null {
  // eslint-disable-next-line no-control-regex -- an id with a control character isn't one the PC can name
  if (!a.id || a.id.length > CAPS.str.path || /[\u0000-\u001f\u007f]/.test(a.id)) return null;
  const argv = a.argv ?? (a.exec ? execArgv(a.exec) : undefined);
  return {
    id: a.id,
    name: cut(a.name, CAPS.str.app),
    ...opt("keywords", a.keywords?.length ? strings(a.keywords, CAPS.states, CAPS.str.app) : undefined),
    ...opt("categories", a.categories?.length ? strings(a.categories, CAPS.states, CAPS.str.role) : undefined),
    ...opt("argv", argv?.length ? strings(argv, CAPS.paths, CAPS.str.path) : undefined),
    ...opt("terminal", a.terminal ? true : undefined),
  };
}
