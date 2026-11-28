/**
 * Customise › Storage (docs/CODING-APP.md §8): how much room each coding session takes on this computer (client
 * `sessions.getSizes`, named from the window's own rows), and old sessions deleted with a dry run first (main's
 * `prune`: the runtime's own dry run lists them, never an open or pinned session, then each is deleted as Delete
 * deletes one, its worktree with it). The deletion is confirmed in place and names how many and how much.
 */
import type { CodePrune } from "../../shared/code";
import { sessionTitle } from "./copy";
import {
  PRUNE, PRUNE_DAYS, PRUNE_DAYS_HINT, PRUNE_FIND, PRUNE_LEAD, PRUNE_NONE, SIZES, SIZES_EMPTY, STORAGE_SECTION, bytesWords, pruneDeleted, pruneFound, pruneQuestion,
  pruneYes,
} from "./copy-storage";
import { action, confirmed, defineSection, field, input, list, load, part, problem, row } from "./customise-kit";
import { el } from "./dom";
import { rec } from "./sdk";

/** Each session's size from `sessions.getSizes`, largest first. */
export function sizesFrom(v: unknown): { id: string; bytes: number }[] {
  const sizes = rec(rec(v)?.sizes) ?? {};
  return Object.entries(sizes).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]) && e[1] >= 0).map(([id, bytes]) => ({ id, bytes })).sort((a, b) => b.bytes - a.bytes);
}

/** Days typed into the field: a whole number from 1 to 3650, or null. */
export function daysFrom(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
}

defineSection(STORAGE_SECTION, "client", ctx => ({
  draw(body) {
    const sizes = part(SIZES);
    const prune = part(PRUNE, { lead: PRUNE_LEAD });
    body.replaceChildren(sizes.root, prune.root);
    const name = (id: string) => { const r = ctx.app.state.sessions.byId[id]; return r ? sessionTitle(r) : id.slice(0, 8); };
    const drawSizes = () => load(sizes.body, () => ctx.call("client", "sessions.getSizes", {}), v =>
      list(SIZES, sizesFrom(v).map(s => row({ name: name(s.id), id: `cz-size-${s.id}`, lines: [bytesWords(s.bytes)] })), SIZES_EMPTY));
    void drawSizes();
    const api = ctx.app.api;
    if (!api.prune) { prune.body.replaceChildren(problem({ reason: "", unavailable: true })); return; }
    const days = input({ value: "30", type: "number" });
    days.min = "1";
    days.max = "3650";
    const f = field("cz-prune-days", PRUNE_DAYS, days, PRUNE_DAYS_HINT);
    const found = el("div", { className: "cz-prune-found" });
    const find = action(PRUNE_FIND, async () => {
      const n = daysFrom(days.value);
      f.error(n === null ? PRUNE_DAYS_HINT : "");
      if (n === null) return;
      const r = await api.prune!({ olderThanDays: n, dryRun: true });
      if (!r.ok) { found.replaceChildren(problem(r)); return; }
      found.replaceChildren(...dryRun(r.value, n));
    });
    const dryRun = (p: CodePrune, n: number): Node[] => {
      if (!p.sessions.length) return [el("p", { className: "cz-empty", textContent: PRUNE_NONE })];
      const go = confirmed(pruneYes(p.sessions.length), pruneQuestion(p.sessions.length, bytesWords(p.bytes)), pruneYes(p.sessions.length), async () => {
        const r = await api.prune!({ olderThanDays: n, dryRun: false });
        if (!r.ok) { ctx.say(r.reason); return; }
        ctx.say(pruneDeleted(r.value.sessions.length, bytesWords(r.value.bytes)));
        found.replaceChildren();
        await ctx.app.refresh();
        void drawSizes();
      });
      return [el("p", { className: "cz-line", textContent: pruneFound(p.sessions.length, bytesWords(p.bytes)) }),
        list(PRUNE, p.sessions.map(s => row({ name: s.name || name(s.id), id: `cz-prune-${s.id}`, lines: [bytesWords(s.bytes)] })), ""),
        el("div", { className: "cz-form-actions" }, go)];
    };
    prune.body.append(f.root, el("div", { className: "cz-form-actions" }, find), found);
  },
}));
