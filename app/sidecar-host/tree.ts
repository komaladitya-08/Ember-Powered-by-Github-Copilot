/**
 * A window's snapshot turned into the nodes of a read_window answer, with the Python sidecar's rules (its walk): what
 * doesn't show is never listed, nor anything inside it (invisible elements are a known prompt-injection channel);
 * unnamed grouping containers aren't listed but what they hold is, under the nearest listed ancestor; zero-size
 * elements aren't listed either; pre-order, `nodes[0]` the window itself; `depth` the real depth below the window;
 * at most `maxNodes` nodes (then cut "nodes") and `maxDepth` levels (something showing deeper: cut "depth"); nothing
 * inside a secret field. `shown` is the part of an element its scrolling container or window lets show.
 */

import type { AxNode, Bounds } from "../main/perception/sidecar";
import type { RawNode, Rect } from "./provider";
import type { SecretValues } from "./secrets";
import {
  CLIP_ROLES, DOCUMENT_ROLES, INTERACTIVE_ROLES, LAZY_ACTION_ROLES, SKIP_ROLES, TEXT_ROLES, UNNAMED_TEXT_ROLES, VALUE_ROLES,
  actionNames, atspiRole, childContext, statesOf, type RoleContext,
} from "./roles";

/** Read limits, as the Python sidecar's. */
export const MAX_DEPTH = 64;
export const MAX_NODES = 400;
/** Characters of a node's text in a read (read_element gives 2000). */
export const NODE_TEXT = 200;
/** Characters of a selection. */
export const SELECTION_TEXT = 500;
/** A spreadsheet's cell is named by its address: elsewhere a cell named so says `grid: false`. Keep in step with elements.ts. */
const CELL_ADDRESS = /^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}$/;
/** What stands in a text for an element inside it: no text of its own. */
const OBJECT_CHAR = /￼/g;

/** The overlap of a clip and a rectangle (the clip where the rectangle has no position, the rectangle without a clip). */
export function clipTo(clip: Bounds | null, b: Bounds | null): Bounds | null {
  if (!b) return clip;
  if (!clip) return b;
  const x = Math.max(clip.x, b.x), y = Math.max(clip.y, b.y);
  const x1 = Math.min(clip.x + clip.width, b.x + b.width), y1 = Math.min(clip.y + clip.height, b.y + b.height);
  return { x, y, width: Math.max(0, x1 - x), height: Math.max(0, y1 - y) };
}

const sameRect = (a: Bounds | null, b: Bounds | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** A rectangle for the wire: integers, or null without a position. */
export function boundsOf(r: Rect | null | undefined): Bounds | null {
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

/** Text as a read reports it: cut, and none when it is empty or only stands for elements inside it. */
export function readText(text: string | undefined, max = NODE_TEXT): string | undefined {
  if (!text || !text.replace(OBJECT_CHAR, "")) return undefined;
  return text.slice(0, max);
}

/** A finite number, or undefined (JSON carries no NaN or Infinity). */
export const finite = (v: number | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** What a node still needs from the app (one textInfo call): its text, and (it has the keyboard) its selection. */
export interface TextWanted { id: number; index: number; text: boolean; selection: boolean }

export interface BuildOptions {
  vocabulary: "uia" | "ax";
  maxDepth: number;
  maxNodes: number;
  /** The window is the one the user is in (its node says "active"). */
  windowActive: boolean;
  /** A new id for the element at this index of the snapshot. */
  allocate(index: number): number;
  /** Is this element's text off limits (see Secrets.isSecret)? */
  isSecret(index: number, role: string, name: string): boolean;
}

/** The nodes of a read, and what the host needs to finish it. */
export interface Built {
  nodes: AxNode[];
  /** What the secret fields among them hold (never reported; see Secrets.redact). */
  hidden: Map<number, SecretValues>;
  /** Each node's index in the snapshot. */
  indexOf: Map<number, number>;
  /** Every element's role and context (listed or not), by index. */
  roles: string[];
  ctx: RoleContext[];
  /** "nodes" and/or "depth": what was left out for want of room. */
  cut: string[];
  /** Nodes whose text or selection the snapshot didn't carry. */
  wanted: TextWanted[];
}

/** The first selected option a combo box holds, two levels down at most, by its name. */
function chosenIn(raw: RawNode[], at: number): string | undefined {
  const depth = raw[at].depth;
  for (let j = at + 1; j < raw.length && raw[j].depth > depth; j++) {
    if (raw[j].depth <= depth + 2 && raw[j].selected && raw[j].name.trim()) return raw[j].name.trim();
  }
  return undefined;
}

/** Turns a snapshot's elements into a read's nodes (see the module comment). */
export function buildNodes(raw: RawNode[], o: BuildOptions): Built {
  const nodes: AxNode[] = [];
  const hidden = new Map<number, SecretValues>();
  const indexOf = new Map<number, number>();
  const roles: string[] = new Array(raw.length).fill("");
  const ctx: RoleContext[] = new Array(raw.length);
  const cut: string[] = [];
  const wanted: TextWanted[] = [];
  const cutShort = (why: string) => { if (!cut.includes(why)) cut.push(why); };
  // Per index: nothing inside it is listed (it doesn't show, it is secret, or it lies too deep); the id of the nearest
  // listed element at or above it; the clip what is inside it shows within; whether it is in a web page.
  const closed: boolean[] = new Array(raw.length).fill(false);
  const listedAt: (number | null)[] = new Array(raw.length).fill(null);
  const clipFor: (Bounds | null)[] = new Array(raw.length).fill(null);
  const webFor: boolean[] = new Array(raw.length).fill(false);
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    const p = n.parent >= 0 && n.parent < i ? n.parent : -1;
    if (p >= 0 && closed[p]) { closed[i] = true; continue; }
    if (nodes.length >= o.maxNodes) { cutShort("nodes"); break; }
    if (n.offscreen) { closed[i] = true; continue; }
    if (n.depth > o.maxDepth) { cutShort("depth"); closed[i] = true; continue; }
    const c = p >= 0 ? { ...childContext(ctx[p], raw[p], roles[p]), depth: n.depth } : { depth: n.depth, inWeb: false, inTerminal: false, parentRole: "" };
    ctx[i] = c;
    const role = roles[i] = atspiRole(o.vocabulary, n, c);
    const name = n.name.trim();
    const bounds = boundsOf(n.bounds);
    const clip = p >= 0 ? clipFor[p] : null;
    const web = p >= 0 ? webFor[p] : false;
    const page = DOCUMENT_ROLES.has(role);
    listedAt[i] = p >= 0 ? listedAt[p] : null;
    let secret = false;
    const listed = !SKIP_ROLES.has(role) || !!name;
    if (listed && (!bounds || (bounds.width > 0 && bounds.height > 0))) {
      const id = o.allocate(i);
      const node: AxNode = {
        id, parent: listedAt[i], depth: n.depth, role, name: name.slice(0, 200),
        states: statesOf(n, role, n.depth === 0 && o.windowActive), bounds,
      };
      const interactive = INTERACTIVE_ROLES.has(role);
      if (interactive && !LAZY_ACTION_ROLES.has(role)) {
        const acts = actionNames(n);
        if (acts.length) node.actions = acts;
      }
      const wants: TextWanted = { id, index: i, text: false, selection: false };
      const focused = node.states.includes("focused");
      if (TEXT_ROLES.has(role)) {
        secret = o.isSecret(i, role, name);
        const text = role === "combo box" && !n.editable ? undefined : readText(n.value);
        const chosen = role === "combo box" ? (!n.editable && n.value?.trim() ? n.value.trim() : chosenIn(raw, i)) : undefined;
        if (secret) {
          node.secret = true;
          hidden.set(id, { name: node.name, role, text: readText(n.value, 2000), selected: chosen, value: finite(n.range?.value) });
        } else {
          if (text) node.text = text;
          else if (n.hasText && role !== "combo box") wants.text = true;
          if (focused) wants.selection = true;
          if (chosen) node.selected = chosen;
        }
      } else if (UNNAMED_TEXT_ROLES.has(role) && !name && !web) {
        secret = o.isSecret(i, role, name);
        const text = secret ? undefined : readText(n.value);
        if (text) node.text = text;
        else if (!secret && n.hasText) wants.text = true;
        if (!secret && focused) wants.selection = true;
      } else if (role === "table cell" && CELL_ADDRESS.test(name)) {
        // Named by its address, but not a spreadsheet's grid (no provider reads one yet): Ember mustn't take it for one.
        node.grid = false;
        secret = o.isSecret(i, role, name);
        if (secret) node.secret = true;
        else if (readText(n.value)) node.text = readText(n.value);
      }
      if (!secret && !wants.selection && focused && n.editable && !TEXT_ROLES.has(role)) wants.selection = true;
      if (VALUE_ROLES.has(role) && !secret) {
        const v = finite(n.range?.value);
        if (v !== undefined) node.value = v;
      }
      if ((interactive || TEXT_ROLES.has(role)) && n.editable) node.editable = true;
      // A page is clipped by the page it is a frame of, never by what holds the page.
      const by = web || !page ? clip : null;
      const shown = by && bounds ? clipTo(by, bounds) : null;
      if (shown && !sameRect(shown, bounds)) node.shown = shown;
      if (wants.text || wants.selection) wanted.push(wants);
      nodes.push(node);
      indexOf.set(id, i);
      listedAt[i] = id;
    } else if (TEXT_ROLES.has(role)) {
      secret = o.isSecret(i, role, name);
    }
    // What a secret field holds is its contents too: nothing inside it is listed.
    if (secret) closed[i] = true;
    if (page) {
      clipFor[i] = web ? clipTo(clip, bounds) : bounds;
      webFor[i] = true;
    } else {
      clipFor[i] = (n.depth === 0 || CLIP_ROLES.has(role)) && !web ? clipTo(clip, bounds) : clip;
      webFor[i] = web;
    }
  }
  return { nodes, hidden, indexOf, roles, ctx, cut, wanted };
}
