/**
 * A task's live view while it works (show_view and update_view), kept pure: no Electron, no timers of its own.
 *
 * `applyViewOps()` applies a batch of update_view's changes (replace, append, remove, set) to a copy of the view, then
 * checks the whole document again (view-schema.ts `checkDoc`: limits, references, mimicry, secrets, provenance), and
 * accepts the whole batch or none of it. Every accepted change bumps the view's `rev`.
 *
 * `ViewHub` carries views to a page: at most `VIEW_PATCHES_PER_SECOND` patches a second per task, each a diff from what
 * the page was last sent (so changes in between merge), and only while the page is visible: a hidden overlay keeps no
 * timer and gets the latest view when it shows again. A page that (re)loads gets every view whole (`snapshots()`).
 */

import { z } from "zod";
import { VIEW_V2, diffViews, isLayout, type ViewDoc, type ViewNode, type ViewPatch } from "../../shared/view";
import { IdMaker, checkDoc, flattenTree, type ViewCheck, type ViewContext } from "./view-schema";

const id = z.string().min(1).max(VIEW_V2.id);

/** update_view's changes, applied in order and checked as one batch. */
export const ViewOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), id: id.describe("The node to replace (with its children)"), node: z.record(z.string(), z.unknown()).describe("The new node, a tree as show_view takes") }).strict(),
  z.object({ op: z.literal("append"), parent: id.describe("A stack, row, grid, card or section"), node: z.record(z.string(), z.unknown()), before: id.optional().describe("Put it before this child (default: last)") }).strict(),
  z.object({ op: z.literal("remove"), id }).strict(),
  z.object({ op: z.literal("set"), id, props: z.record(z.string(), z.unknown()).describe("Props to change on that node (not kind, id or children)") }).strict(),
]);
export type ViewOp = z.infer<typeof ViewOpSchema>;
export const ViewOpsSchema = z.array(ViewOpSchema).min(1).max(VIEW_V2.ops);

/** The ids under `id` (itself included). */
function subtree(nodes: Record<string, ViewNode>, from: string): string[] {
  const out: string[] = [];
  const visit = (x: string) => {
    const n = nodes[x];
    if (!n || out.includes(x)) return;
    out.push(x);
    if (isLayout(n)) for (const c of n.children) visit(c);
  };
  visit(from);
  return out;
}

const parentOf = (nodes: Record<string, ViewNode>, child: string): string | null =>
  Object.entries(nodes).find(([, n]) => isLayout(n) && n.children.includes(child))?.[0] ?? null;

/**
 * `doc` after `ops`, checked whole, at `doc.rev + 1`: the new document, or one plain sentence naming the change that
 * can't be made (and then nothing changed).
 */
export function applyViewOps(doc: ViewDoc, ops: readonly ViewOp[], ctx: ViewContext): ViewCheck {
  const nodes: Record<string, ViewNode> = structuredClone(doc.nodes);
  const taken = new Set(Object.keys(nodes));
  const ids = new IdMaker(taken);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const at = `ops[${i}]`;
    const missing = (x: string) => ({ ok: false as const, error: `${at}: there is no node "${x.slice(0, 24)}" in the view` });
    if (op.op === "remove" || op.op === "replace" || op.op === "set") {
      if (!nodes[op.id]) return missing(op.id);
    }
    if (op.op === "remove") {
      if (op.id === doc.root) return { ok: false, error: `${at}: the root can't be removed; send a new view with show_view` };
      const p = parentOf(nodes, op.id);
      for (const x of subtree(nodes, op.id)) { delete nodes[x]; taken.delete(x); }
      if (p) { const n = nodes[p]; if (isLayout(n)) nodes[p] = { ...n, children: n.children.filter(c => c !== op.id) }; }
    } else if (op.op === "replace") {
      // The new node takes the old one's place and id; the old subtree goes first, so its ids may be used again.
      for (const x of subtree(nodes, op.id)) { delete nodes[x]; taken.delete(x); }
      const fresh: Record<string, ViewNode> = {};
      const r = flattenTree(op.node, fresh, ids, taken, `${at}.node`, 1, op.id);
      if ("error" in r) return { ok: false, error: r.error };
      Object.assign(nodes, fresh);
    } else if (op.op === "append") {
      const p = nodes[op.parent];
      if (!p) return missing(op.parent);
      if (!isLayout(p)) return { ok: false, error: `${at}: "${op.parent}" is a ${p.kind}, which holds no children` };
      if (op.before !== undefined && !p.children.includes(op.before)) return { ok: false, error: `${at}: "${op.before.slice(0, 24)}" isn't a child of "${op.parent}"` };
      const fresh: Record<string, ViewNode> = {};
      const r = flattenTree(op.node, fresh, ids, taken, `${at}.node`);
      if ("error" in r) return { ok: false, error: r.error };
      Object.assign(nodes, fresh);
      const children = [...p.children];
      children.splice(op.before === undefined ? children.length : children.indexOf(op.before), 0, r.id);
      nodes[op.parent] = { ...p, children };
    } else {
      const bad = Object.keys(op.props).find(k => k === "kind" || k === "id" || k === "children");
      if (bad) return { ok: false, error: `${at}.props.${bad}: set changes a node's props, never its ${bad}; use replace` };
      nodes[op.id] = { ...nodes[op.id], ...op.props } as ViewNode;
    }
  }
  return checkDoc({ catalog: doc.catalog, rev: doc.rev + 1, root: doc.root, nodes }, ctx);
}

/** How often a page hears of one task's view changing, at most. */
export const VIEW_PATCHES_PER_SECOND = 4;

interface Entry { latest: ViewDoc | null; sent: ViewDoc | null; lastAt: number; timer: unknown }

/** Carries tasks' views to the overlay's pages: coalesced, diffs only, nothing while hidden. */
export class ViewHub {
  private readonly views = new Map<string, Entry>();
  private visible = true;
  private readonly gap = 1000 / VIEW_PATCHES_PER_SECOND;
  private readonly now: () => number;
  private readonly later: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (t: unknown) => void;

  constructor(private readonly o: {
    send: (p: ViewPatch) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  }) {
    this.now = o.now ?? Date.now;
    this.later = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.cancel = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A task's view now (null: it has none any more, its card went). */
  set(taskId: string, doc: ViewDoc | null): void {
    const e = this.views.get(taskId);
    if (!doc) {
      if (e?.timer) this.cancel(e.timer);
      this.views.delete(taskId);
      return;
    }
    const entry = e ?? { latest: null, sent: null, lastAt: -Infinity, timer: null };
    entry.latest = doc;
    this.views.set(taskId, entry);
    this.schedule(taskId, entry);
  }

  /** The page shows (Ember is visible) or not: hidden, nothing is sent; shown again, each view's changes go at once. */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    for (const [taskId, e] of this.views) {
      if (!on && e.timer) { this.cancel(e.timer); e.timer = null; }
      if (on) this.schedule(taskId, e);
    }
  }

  /** Every view whole, as last sent: for a page that has just (re)loaded. */
  snapshots(): ViewPatch[] {
    return [...this.views].filter(([, e]) => e.sent).map(([taskId, e]) => diffViews(taskId, null, e.sent!));
  }

  /** A task's latest checked view. */
  latest(taskId: string): ViewDoc | null {
    return this.views.get(taskId)?.latest ?? null;
  }

  private schedule(taskId: string, e: Entry): void {
    if (!this.visible || e.timer) return;
    const wait = e.lastAt + this.gap - this.now();
    if (wait <= 0) this.flush(taskId, e);
    else e.timer = this.later(() => { e.timer = null; if (this.views.get(taskId) === e) this.flush(taskId, e); }, wait);
  }

  private flush(taskId: string, e: Entry): void {
    if (!this.visible || !e.latest || e.latest === e.sent) return;
    const patch = diffViews(taskId, e.sent, e.latest);
    // A change that changed nothing (a set to the same value) still moves the rev on. The page isn't sent it, so `sent`
    // stays what the page holds: advancing it would make the next patch's base a rev the page never had, and the page
    // would drop every later patch as a gap until it reloaded.
    if (e.sent && patch.root === e.sent.root && !Object.keys(patch.nodes).length && !patch.removed.length) return;
    e.sent = e.latest;
    e.lastAt = this.now();
    try { this.o.send(patch); } catch { /* a page that went away mid-send: the next load gets snapshots() */ }
  }
}
