/**
 * The protocol's reading methods (ping, status, list_windows, read_window, remember_secrets, mark_secret,
 * shell_overlays, secret_fields, read_element, at_point), answered as the Python sidecar answers them, from a provider's
 * snapshots, looks and hit tests. Budgets keep every answer well inside Ember's 5 s: finding the window is one window
 * list, a read is one snapshot (1.5 s at most) plus a few text looks, and an app that stops answering makes the read
 * `busy` rather than late.
 */

import type { AtPointResult, AxNode, Bounds, ElementInfo, PointElement } from "../main/perception/sidecar";
import { withheldIds } from "../main/perception/elements";
import type { Host } from "./host";
import type { IdEntry, ReadRecord } from "./ids";
import { isProviderError, type RawNode, type RawWindow, type Snapshot } from "./provider";
import { BusyError, GoneError, VERSION, intParam, ints, optInt, strings } from "./protocol";
import {
  CLIP_ROLES, DOCUMENT_ROLES, FIELD_ROLES, GENERIC_ROLES, LABEL_ROLES, MENU_ITEM_ROLES, ROW_LIST_ROLES, TEXT_ROLES, TOP,
  childContext, statesOf, type RoleContext,
} from "./roles";
import { secretByLayout } from "./labels";
import type { SecretValues, WireKey } from "./secrets";
import { MAX_DEPTH, MAX_NODES, NODE_TEXT, SELECTION_TEXT, boundsOf, buildNodes, clipTo, finite, notHandedOver, readText } from "./tree";
import { describeWindow, findWindow, listWindows, neverLooked, otherWindows, shellOverlays } from "./windows";

/** A read's walk takes at most this long, and the whole read should be done within READ_TOTAL_MS (as the Python sidecar's). */
export const READ_BUDGET_MS = 1500;
export const READ_TOTAL_MS = 3000;
/** Elements a snapshot may report per node a read lists (unlisted containers, hidden elements): what it is asked for. */
const RAW_PER_NODE = 4;
const RAW_NODES_MAX = 4000;
/** Text looks a read makes at most (text the snapshot didn't carry: a document's, the focused field's selection). */
const TEXT_LOOKS = 16;
/** The secret-field scan: how long, how many elements, as the Python sidecar's. */
const SCAN_BUDGET_MS = 2000;
const SCAN_NODES = 6000;
/** at_point: how long, how many levels and children it looks through. */
const AT_POINT_BUDGET_MS = 1000;
const AT_POINT_LEVELS = 40;
const AT_POINT_CHILDREN = 64;
/** A container with at most this many children may draw one over another: the last at a point is on top. */
const ON_TOP_CHILDREN = 16;
/** How far up from a field Ember's own secret finds withhold the names around it. */
const WITHHELD_LEVELS = 12;
/** Characters of an element's text read on its own. */
export const ELEMENT_TEXT = 2000;
/** Options, rows and children looked at for what a drop-down or a list has chosen. */
const CHOICES = 500;

const since = (t0: number) => Math.round(Date.now() - t0);

/** Runs a provider call that may say the app is busy: undefined then. */
async function unlessBusy<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (err) {
    if (isProviderError(err, "busy") || err instanceof BusyError) return undefined;
    throw err;
  }
}

/**
 * How the helper is: the Python sidecar's fields, and from the provider's health why it couldn't start (`detail`,
 * Windows' `languageMode`) and the bridge's DPI awareness (`dpi`, `processDpi`). It starts the provider as any request
 * does, but never fails for it: a start that failed is `toolkitAccessibility: false` with its reason, one still going
 * on is null, so Ember's setup check can say why Windows apps can't be read (Constrained Language mode, an execution
 * policy) instead of getting an error.
 */
async function status(host: Host): Promise<unknown> {
  await host.begin().catch(() => undefined); // its failure is in health() (a start going on: health's ok is null)
  const health = host.provider.health();
  let apps = 0, accessibility: boolean | null = health.ok === false ? false : null;
  if (health.ok === true) {
    try {
      apps = new Set((await host.windows()).map(w => w.pid)).size;
    } catch {
      // No windows to count (the app list didn't answer): 0, as the Python sidecar says then.
    }
    try {
      accessibility = await host.provider.accessibility();
    } catch {
      // Can't be told.
    }
  }
  const out: Record<string, unknown> = { version: VERSION, python: `node ${process.versions.node} (${host.provider.kind})`, toolkitAccessibility: accessibility, apps };
  for (const k of ["detail", "languageMode", "dpi", "processDpi"] as const) if (typeof health[k] === "string" && health[k]) out[k] = health[k];
  return out;
}

async function listWindowsMethod(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const windows = await host.windows();
  return { windows: listWindows(windows, optInt(params.ownPid), host.vocabulary, host.known) };
}

/**
 * The handles a read keeps besides its listed elements': the window, and the containers that clip or choose among what
 * they hold (an element's `shown` is asked of them again, and a row is selected through its list).
 */
function holdsToo(r: RawNode, role: string): boolean {
  return r.depth === 0 || CLIP_ROLES.has(role) || DOCUMENT_ROLES.has(role) || !!r.selection;
}

/** The text and selection a read's snapshot didn't carry: a few text looks, within the read's time. */
async function fillTexts(host: Host, read: ReadRecord, built: ReturnType<typeof buildNodes>, until: number): Promise<void> {
  const byId = new Map(built.nodes.map(n => [n.id, n]));
  // The focused element's selection first: Ember reads none as "nothing selected" (and lets a key replace it).
  const wanted = [...built.wanted].sort((a, b) => Number(b.selection) - Number(a.selection)).slice(0, TEXT_LOOKS);
  for (const w of wanted) {
    if (Date.now() >= until) break;
    const node = byId.get(w.id);
    if (!node || node.secret) continue;
    const info = await unlessBusy(() => host.provider.textInfo(read.raw[w.index].handle, ELEMENT_TEXT)).catch(() => undefined);
    if (!info) continue;
    if (info.secret) {
      // The platform says it is a password field: it is secret, and nothing of it is kept.
      built.hidden.set(node.id, { name: node.name, role: node.role });
      delete node.text;
      delete node.selection;
      delete node.selected;
      delete node.value;
      node.secret = true;
      host.secrets.fields.add(host.keyOf(read.raw[w.index]));
      continue;
    }
    if (w.text) {
      const text = readText(info.text, NODE_TEXT);
      if (text) node.text = text;
    }
    if (w.selection && info.selection) node.selection = info.selection.slice(0, SELECTION_TEXT);
  }
}

async function readWindow(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const t0 = Date.now();
  const pid = optInt(params.pid);
  const title = typeof params.title === "string" ? params.title : "";
  const path = typeof params.path === "string" ? params.path : undefined;
  const ownPid = optInt(params.ownPid);
  const maxDepth = params.maxDepth === undefined ? MAX_DEPTH : intParam(params, "maxDepth");
  const maxNodes = params.maxNodes === undefined ? MAX_NODES : intParam(params, "maxNodes");
  let windows: RawWindow[];
  try {
    windows = await host.windows();
  } catch (err) {
    if (isProviderError(err, "busy")) return { window: null, nodes: [], busy: true, ms: since(t0) };
    throw err;
  }
  const win = findWindow(host.findable(windows), { pid, title, path, ownPid });
  if (!win) {
    // A window whose app didn't answer is busy (a file dialog listing a big folder), not gone.
    const lower = title.toLowerCase();
    const busy = host.findable(windows).some(w => w.busy && w.pid !== ownPid && (w.pid === pid || host.known.mightHave(w.pid, lower)));
    return { window: null, nodes: [], busy, ms: since(t0) };
  }
  const window = describeWindow(win, host.vocabulary);
  let busy = !!win.busy;
  if (!busy && window.name) host.known.remember(window.pid, [window], true);
  if (neverLooked(window, strings(params.neverLook), ints(params.skipPids))) {
    return { window, nodes: [], blocked: true, ms: since(t0) };
  }
  host.snapshots.begin(params.keep !== false);
  let nodes: AxNode[] = [];
  let cut: string[] = [];
  let over = false;
  let secretKeys: WireKey[] = [], withheldKeys: WireKey[] = [];
  if (!busy) {
    const budget = Math.max(300, Math.min(READ_BUDGET_MS, READ_TOTAL_MS - since(t0)));
    const snap: Snapshot | undefined = await unlessBusy(() => host.provider.snapshot(win.handle, {
      maxDepth: maxDepth + 1, maxNodes: Math.min(Math.max(maxNodes, 1) * RAW_PER_NODE, RAW_NODES_MAX), deadlineMs: budget,
    })).catch(err => {
      // Gone since it was listed: found, with nothing in it to read.
      if (isProviderError(err, "gone")) return { nodes: [], truncated: false, cut: [] };
      throw err;
    });
    if (!snap) busy = true;
    else {
      host.see(snap.nodes);
      const read: ReadRecord = { window: win, raw: snap.nodes, roles: [], ctx: [], generation: host.provider.generation };
      const built = buildNodes(snap.nodes, {
        vocabulary: host.vocabulary, maxDepth, maxNodes, windowActive: !!win.active,
        allocate: i => host.snapshots.add({ handle: snap.nodes[i].handle, read, index: i }),
        isSecret: (i, role, name) => host.secrets.isSecret(host.keyOf(snap.nodes[i]), snap.nodes[i], role, name),
      });
      read.roles = built.roles;
      read.ctx = built.ctx;
      cut = built.cut;
      if (snap.busy) busy = true;
      if (snap.cut.includes("time")) over = true;
      if (snap.truncated && snap.cut.includes("nodes") && !cut.includes("nodes")) cut.push("nodes");
      if (snap.truncated && snap.cut.includes("depth") && !cut.includes("depth")) cut.push("depth");
      // Containers that clip or choose: kept with the read (an element's `shown`, a row's list).
      const listed = new Set(built.indexOf.values());
      for (let i = 0; i < snap.nodes.length; i++) {
        if (built.ctx[i] && !listed.has(i) && holdsToo(snap.nodes[i], built.roles[i])) host.snapshots.hold({ handle: snap.nodes[i].handle, read, index: i });
      }
      if (!busy) await fillTexts(host, read, built, t0 + READ_TOTAL_MS);
      const keyOf = (id: number) => host.keyOf(snap.nodes[built.indexOf.get(id)!]);
      // Secret fields it doesn't list may be named in what it lists; past where the snapshot ended, nothing is known.
      const unreadAfter = !!snap.busy || (snap.truncated && snap.cut.some(c => c === "nodes" || c === "time"));
      const red = host.secrets.redact(built.nodes, built.hidden, keyOf, win.pid, {
        fields: built.unlisted, unreadAfter, inWeb: id => !!built.ctx[built.indexOf.get(id)!]?.inWeb || DOCUMENT_ROLES.has(built.roles[built.indexOf.get(id)!]),
      });
      for (const id of red.removed) host.snapshots.remove(id);
      nodes = red.nodes;
      secretKeys = red.secretKeys;
      withheldKeys = red.withheldKeys;
    }
  }
  const out: Record<string, unknown> = {
    window, nodes, truncated: cut.length > 0 || over, cut, others: busy ? [] : otherWindows(windows, win, host.vocabulary),
    secretKeys, withheldKeys, ms: since(t0),
  };
  if (busy) out.busy = true;
  else if (over) out.slow = true;
  host.snapshots.end();
  return out;
}

async function rememberSecrets(host: Host, params: Record<string, unknown>): Promise<unknown> {
  for (const [into, keys] of [[host.secrets.fields, params.keys], [host.secrets.withheld, params.withheld]] as const) {
    if (!Array.isArray(keys)) continue;
    for (const k of keys) if (Array.isArray(k) && k.length === 2 && typeof k[0] === "string" && typeof k[1] === "string") into.add([k[0], k[1]]);
  }
  return { count: host.secrets.fields.size };
}

/** What a field holds now (its text, its choice, its number), for the names around it: never reported. */
async function valuesOf(host: Host, entry: IdEntry, role: string): Promise<SecretValues | null> {
  const n = await host.look(entry.handle).catch(() => null);
  if (!n) return null;
  return { name: n.name.trim(), role, text: n.value, selected: role === "combo box" ? n.value : undefined, value: finite(n.range?.value) };
}

async function markSecret(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const keys: WireKey[] = [], held: WireKey[] = [];
  const ids = Array.isArray(params.ids) ? params.ids.slice(0, 64) : [];
  for (const raw of ids) {
    const id = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    const entry = Number.isInteger(id) ? host.snapshots.find(id) : undefined;
    if (!entry) continue;
    const el = entry.read.raw[entry.index];
    const key = host.keyOf(el);
    if (!key) continue;
    host.secrets.fields.add(key);
    keys.push(key);
    // The names around it that say what it holds are withheld from now on (its containers as read, a dozen up).
    const role = entry.read.roles[entry.index];
    const values = await valuesOf(host, entry, role);
    if (!values) continue;
    const chain: AxNode[] = [{ ...values, id: 1, parent: null, depth: el.depth, role, name: el.name.trim(), states: [], bounds: null, secret: true }];
    const keyAt = new Map<number, WireKey | null>();
    for (let a = el.parent, i = 0; a >= 0 && i < WITHHELD_LEVELS; a = entry.read.raw[a].parent, i++) {
      const up = entry.read.raw[a];
      const upRole = entry.read.roles[a] ?? "";
      chain[chain.length - 1].parent = i + 2;
      chain.push({ id: i + 2, parent: null, depth: up.depth, role: upRole, name: up.name.trim(), states: [], bounds: null });
      keyAt.set(i + 2, host.keyOf(up));
    }
    for (const nid of withheldIds(chain, new Set([1]))) {
      const k = nid === 1 ? key : keyAt.get(nid);
      if (k) { host.secrets.withheld.add(k); held.push(k); }
    }
  }
  return { keys, withheldKeys: held };
}

async function shellOverlaysMethod(host: Host): Promise<unknown> {
  try {
    return { overlays: shellOverlays(await host.windows(), host.vocabulary), complete: true };
  } catch {
    // The windows couldn't be listed: a credential prompt may be up unseen, so no picture is taken (fail closed).
    return { overlays: [], complete: false };
  }
}

async function secretFields(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const t0 = Date.now();
  const pid = optInt(params.pid);
  const path = typeof params.path === "string" ? params.path : "";
  const none = (busy: boolean) => ({ fields: [], complete: false, busy, ms: since(t0) });
  if (pid === undefined || !path) return none(false);
  let windows: RawWindow[];
  try {
    windows = await host.windows();
  } catch (err) {
    if (isProviderError(err, "busy")) return none(true);
    throw err;
  }
  const win = host.findable(windows).find(w => w.pid === pid && w.key === path);
  if (!win) return none(host.findable(windows).some(w => w.pid === pid && !!w.busy));
  if (win.busy) return none(true);
  const snap = await unlessBusy(() => host.provider.snapshot(win.handle, { maxDepth: MAX_DEPTH + 1, maxNodes: SCAN_NODES, deadlineMs: SCAN_BUDGET_MS }))
    .catch(err => {
      if (isProviderError(err, "gone")) return null;
      throw err;
    });
  if (snap === undefined) return none(true);
  if (snap === null) return none(false);
  host.see(snap.nodes);
  const raw = snap.nodes;
  const roles: string[] = new Array(raw.length).fill("");
  const ctx: RoleContext[] = new Array(raw.length);
  const closed: boolean[] = new Array(raw.length).fill(false);
  let cut = snap.truncated && snap.cut.some(c => c === "nodes" || c === "depth");
  const fields: number[] = [], labels: number[] = [];
  let loading = false;
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    const p = n.parent >= 0 && n.parent < i ? n.parent : -1;
    if ((p >= 0 && closed[p]) || n.offscreen) { closed[i] = true; continue; }
    if (n.depth > MAX_DEPTH) { cut = true; closed[i] = true; continue; }
    ctx[i] = p >= 0 ? { ...childContext(ctx[p], raw[p], roles[p]), depth: n.depth } : { ...TOP, depth: n.depth };
    const role = roles[i] = host.roleOf(n, ctx[i]);
    // A page that shows but isn't handed over yet: none of it can be checked (busy, as the Python sidecar says it).
    if (notHandedOver(raw, i, role)) loading = true;
    // A field is judged as a whole (what is inside it is its contents); a label names one.
    if (FIELD_ROLES.has(role)) { fields.push(i); closed[i] = true; }
    else if (LABEL_ROLES.has(role)) labels.push(i);
  }
  const secret: number[] = [], plain: AxNode[] = [];
  for (const i of fields) {
    const n = raw[i];
    const b = boundsOf(n.bounds);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    const name = n.name.trim();
    if (host.secrets.isSecret(host.keyOf(n), n, roles[i], name)) { secret.push(i); continue; }
    const selected = roles[i] === "combo box" && !n.editable && n.value?.trim() ? n.value.trim() : undefined;
    plain.push({ id: i + 1, parent: null, depth: n.depth, role: roles[i], name, states: [], bounds: b, ...(selected ? { selected } : {}) });
  }
  if (plain.length && !snap.busy) {
    // Unnamed fields beside or under a "Password" or "Card number" label are secret too.
    const named: AxNode[] = labels.flatMap(i => {
      const b = boundsOf(raw[i].bounds);
      const name = raw[i].name.trim();
      return b && name ? [{ id: i + 1, parent: null, depth: raw[i].depth, role: roles[i], name, states: [], bounds: b }] : [];
    });
    for (const id of secretByLayout([...named, ...plain])) {
      host.secrets.fields.add(host.keyOf(raw[id - 1]));
      secret.push(id - 1);
    }
  }
  const read: ReadRecord = { window: win, raw, roles, ctx, generation: host.provider.generation };
  const keys = new Map<string, WireKey>();
  const held = new Set<number>();
  const out = secret.map(i => {
    const k = host.keyOf(raw[i]);
    if (k) keys.set(`${k[0]} ${k[1]}`, k);
    // What clips the field is kept with it (Ember asks where it shows now while a picture is taken).
    for (let a = raw[i].parent; a >= 0; a = raw[a].parent) {
      if (!held.has(a) && holdsToo(raw[a], roles[a])) { held.add(a); host.snapshots.hold({ handle: raw[a].handle, read, index: a }); }
    }
    return { id: host.snapshots.add({ handle: raw[i].handle, read, index: i }), role: roles[i], bounds: boundsOf(raw[i].bounds)! };
  });
  const busy = !!snap.busy || loading;
  const over = snap.cut.includes("time");
  return { fields: out, complete: !(busy || over || cut), busy, secretKeys: [...keys.values()], ms: since(t0) };
}

/**
 * An element as it is now (ElementInfo; the body of read_element and of an action's before and after). Never the text,
 * value or choice of a secret field, nor a name withheld before. GoneError / BusyError when it can't be read.
 */
export async function nodeInfo(host: Host, entry: IdEntry, id?: number): Promise<ElementInfo> {
  const n = await host.look(entry.handle);
  if (!n) throw new GoneError(id);
  const ctx = entry.read.ctx[entry.index] ?? TOP;
  const role = host.roleOf(n, ctx);
  const name = n.name.trim();
  const key = host.keyOf(n) ?? host.keyOf(entry.read.raw[entry.index]);
  const withheld = host.secrets.withheld.has(key);
  const info: ElementInfo = { role, name: withheld ? "" : name.slice(0, 200), states: statesOf(n, role), bounds: boundsOf(n.bounds) };
  // A closed menu's item (it still exists, no longer showing): the user chose it, or went elsewhere.
  if (MENU_ITEM_ROLES.has(role) && n.offscreen) info.offscreen = true;
  if (withheld) info.withheld = true;
  if (host.secrets.isSecret(key, n, role, name)) {
    info.secret = true;
    return info;
  }
  if (withheld) return info;
  const pid = entry.read.window.pid;
  if (n.value !== undefined && !(role === "combo box" && !n.editable)) info.text = n.value.slice(0, ELEMENT_TEXT);
  else if (n.hasText && role !== "combo box") {
    const t = await unlessBusy(() => host.provider.textInfo(entry.handle, ELEMENT_TEXT)).catch(() => undefined);
    if (t?.secret) return { ...info, secret: true };
    if (t) info.text = (t.text ?? "").slice(0, ELEMENT_TEXT);
  }
  const value = finite(n.range?.value);
  if (value !== undefined) info.value = value;
  if (role === "combo box") {
    const chosen = !n.editable && n.value?.trim() ? n.value.trim() : await chosenChild(host, n, pid);
    if (chosen !== undefined) info.selected = host.secrets.saidName(chosen, null, pid);
  } else if (ROW_LIST_ROLES.has(role)) {
    const words = await selectedRowWords(host, n, pid).catch(() => undefined);
    if (words) info.selected = words.slice(0, 200);
  } else if (role === "menu") {
    info.open = n.expanded === true || (n.expanded !== false && (await host.children(n.handle, 3).catch(() => [])).some(c => !c.offscreen));
  }
  return info;
}

/** The name of the option a combo box has chosen, asked of its options (its list's, where it holds one). */
async function chosenChild(host: Host, n: RawNode, pid: number): Promise<string | undefined> {
  const kids = await host.children(n.handle, 8).catch(() => []);
  const holder = kids.find(k => /^(List|AXList|AXMenu|Menu)$/.test(k.platformRole));
  const options = holder ? await host.children(holder.handle, CHOICES).catch(() => []) : kids;
  const item = options.find(o => o.selected);
  if (!item) return undefined;
  return host.secrets.saidName(item.name.trim(), host.keyOf(item), pid);
}

/** What a cell or row says: its name, or the first name inside it (two levels down); never a withheld one. */
export async function cellWords(host: Host, n: RawNode, pid: number, depth = 0): Promise<string> {
  const name = host.secrets.saidName(n.name.trim(), host.keyOf(n), pid);
  if (name || depth >= 2) return name;
  for (const c of (await host.children(n.handle, 4).catch(() => []))) {
    const inner = await cellWords(host, c, pid, depth + 1);
    if (inner) return inner;
  }
  return "";
}

/** The words of a list of rows' first selected row (its name, or the first name in it). */
async function selectedRowWords(host: Host, n: RawNode, pid: number): Promise<string | undefined> {
  const row = (await host.children(n.handle, CHOICES)).find(r => r.selected);
  return row ? await cellWords(host, row, pid) || undefined : undefined;
}

/**
 * The part of an element that shows now (`bounds` its rectangle): inside each container that clips it, and inside its
 * window, as visible_part in ember_atspi.py; undefined when that is all of it. A web page's content is clipped by its
 * page, never by what holds the page.
 */
async function visiblePart(host: Host, entry: IdEntry, bounds: Bounds | null): Promise<Bounds | undefined> {
  if (!bounds) return undefined;
  const { raw, roles } = entry.read;
  let shown: Bounds | null = bounds;
  let web = DOCUMENT_ROLES.has(roles[entry.index]);
  for (let a = raw[entry.index].parent, i = 0; a >= 0 && i < AT_POINT_LEVELS; a = raw[a].parent, i++) {
    const role = roles[a];
    const top = raw[a].parent < 0 || raw[a].depth === 0;
    if (top) {
      if (!web) shown = clipTo(shown, boundsOf((await host.look(raw[a].handle).catch(() => null))?.bounds));
      break;
    }
    if (DOCUMENT_ROLES.has(role)) {
      shown = clipTo(shown, boundsOf((await host.look(raw[a].handle).catch(() => null))?.bounds));
      web = true;
    } else if (CLIP_ROLES.has(role) && !web) {
      shown = clipTo(shown, boundsOf((await host.look(raw[a].handle).catch(() => null))?.bounds));
    }
  }
  const same = shown && shown.x === bounds.x && shown.y === bounds.y && shown.width === bounds.width && shown.height === bounds.height;
  return !shown || same ? undefined : shown;
}

async function readElement(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const id = intParam(params, "id");
  const entry = host.snapshots.get(id);
  const info = await nodeInfo(host, entry, id);
  if (params.shown) {
    const shown = await visiblePart(host, entry, info.bounds);
    if (shown) info.shown = shown;
  }
  // `formula`: only a spreadsheet's grid cell has one, and no provider reads a grid yet.
  return info;
}

const contains = (b: Bounds | null, x: number, y: number) => !!b && b.x <= x && x < b.x + b.width && b.y <= y && y < b.y + b.height;

/** Is this hit-test element the window asked about? */
const isWindow = (n: RawNode, w: RawWindow) =>
  (n.native !== undefined && w.native !== undefined ? n.native === w.native : n.key === w.key) && n.depth <= 0;

/**
 * What the window itself has at a point, looked for level by level (what the platform's hit test answers when another
 * window lies over it, as AT-SPI's per-app hit test does): the child that shows there, the one drawn on top where a
 * few overlap.
 */
async function descend(host: Host, top: RawNode, x: number, y: number, until: number): Promise<{ path: RawNode[]; late: boolean }> {
  const path: RawNode[] = [];
  let cur = top;
  for (let level = 0; level < AT_POINT_LEVELS; level++) {
    if (Date.now() >= until) return { path, late: true };
    const kids = await host.children(cur.handle, AT_POINT_CHILDREN);
    const here = kids.filter(k => !k.offscreen && contains(boundsOf(k.bounds), x, y));
    if (!here.length) break;
    const pick = kids.length <= ON_TOP_CHILDREN ? here[here.length - 1] : here[0];
    path.push(pick);
    cur = pick;
  }
  return { path, late: false };
}

async function atPoint(host: Host, params: Record<string, unknown>): Promise<unknown> {
  const t0 = Date.now();
  const ownPid = optInt(params.ownPid);
  let windows: RawWindow[];
  try {
    windows = await host.windows();
  } catch (err) {
    if (isProviderError(err, "busy")) return { chain: [], busy: true, ms: since(t0) };
    throw err;
  }
  const win = findWindow(host.findable(windows), { pid: optInt(params.pid), title: typeof params.title === "string" ? params.title : "", path: typeof params.path === "string" ? params.path : undefined, ownPid });
  if (!win) return { chain: [], found: false, ms: since(t0) };
  if (neverLooked(describeWindow(win, host.vocabulary), strings(params.neverLook), ints(params.skipPids))) return { chain: [], blocked: true, ms: since(t0) };
  const x = intParam(params, "x"), y = intParam(params, "y");
  const until = t0 + AT_POINT_BUDGET_MS;
  // The window's app: a provider that hit-tests app by app (AX) looks only there, never into Ember's own process.
  const hits = await unlessBusy(() => host.provider.elementsAt(x, y, win.pid));
  if (hits === undefined) return { chain: [], busy: true, ms: since(t0) };
  host.see(hits);
  let path: RawNode[];
  let first: RoleContext = TOP;
  let start: RawNode | null = null;
  let late = false;
  if (hits.length && isWindow(hits[0], win)) {
    // The window itself is at the point: the chain starts below it.
    start = hits[0];
    path = hits.slice(1);
  } else if (hits.length && hits[0].pid === win.pid) {
    // One of the app's own popups or dialogs lies over it: the chain starts in it (Ember reads a menu or popup first
    // as one lying over what it aims at).
    path = hits;
  } else {
    // Another app's window, or nothing the hit test knows: what the window itself has there.
    start = await host.look(win.handle);
    if (!start) return { chain: [], found: false, ms: since(t0) };
    const found = await descend(host, start, x, y, until).catch(err => {
      if (err instanceof BusyError) return { path: [], late: true };
      throw err;
    });
    path = found.path;
    late = found.late;
  }
  if (start) {
    const role = host.roleOf(start, TOP);
    first = childContext(TOP, start, role);
  }
  const chain: PointElement[] = [];
  const nodes: AxNode[] = [];
  const keys: (WireKey | null)[] = [];
  const noted: WireKey[] = [];
  const pid = win.pid;
  let ctx = first, secret = false, last: RawNode | null = null;
  for (const el of path) {
    const role = host.roleOf(el, ctx);
    const name = el.name.trim();
    const key = host.keyOf(el);
    secret = TEXT_ROLES.has(role) && host.secrets.isSecret(key, el, role, name);
    const step: PointElement = { role, name: secret ? "" : host.secrets.saidName(name, key, pid).slice(0, 200), bounds: boundsOf(el.bounds) };
    if (secret) {
      step.secret = true;
      // Nor do the names round it that say what it holds.
      const values: AxNode = { id: nodes.length + 1, parent: nodes.length || null, depth: nodes.length, role, name, states: [], bounds: null, secret: true, text: el.value, value: finite(el.range?.value) };
      for (const nid of withheldIds([...nodes, values], new Set([values.id]))) {
        if (nid === values.id || !chain[nid - 1]?.name) continue;
        chain[nid - 1].name = "";
        const k = keys[nid - 1];
        if (k) { host.secrets.withheld.add(k); noted.push(k); }
      }
    }
    chain.push(step);
    nodes.push({ id: nodes.length + 1, parent: nodes.length || null, depth: nodes.length, role, name, states: [], bounds: null });
    keys.push(key);
    last = el;
    if (secret) break;
    ctx = childContext(ctx, el, role);
  }
  if (last && !secret && !late && Date.now() < until && GENERIC_ROLES.has(chain[chain.length - 1].role)) {
    // An empty grouping container: the app told nothing about what shows there.
    const kids = await host.children(last.handle, 1).catch(() => [{}]);
    if (!kids.length) chain[chain.length - 1].empty = true;
  }
  const out: AtPointResult & { withheldKeys?: WireKey[] } = { chain, ms: since(t0) };
  if (noted.length) out.withheldKeys = noted;
  // The app didn't answer in time, or the time ran out before the deepest element: Ember can't tell what is there.
  if (late) out.busy = true;
  return out;
}

/** The reading methods, by protocol name. */
export const READING = {
  ping: async () => ({ version: VERSION }),
  status,
  list_windows: listWindowsMethod,
  read_window: readWindow,
  remember_secrets: rememberSecrets,
  mark_secret: markSecret,
  shell_overlays: shellOverlaysMethod,
  secret_fields: secretFields,
  read_element: readElement,
  at_point: atPoint,
};
