/**
 * Customise › Usage: the open session's use (session `usage.getMetrics`: requests, premium requests, time with the
 * model, changes, per model), the allowance (session `quota.get`, `quota.refresh` on Check again; without a session,
 * client `account.getQuota`), the context window (`metadata.contextInfo` and its largest parts,
 * `metadata.getContextHeaviestMessages`), and "Compact now" (`history.compact`, confirmed, with what it does; not while
 * a turn runs).
 */
import {
  COMPACT, COMPACT_BUSY, COMPACT_LEAD, COMPACT_QUESTION, CONTEXT, CONTEXT_EMPTY, HEAVIEST, QUOTA, QUOTA_NONE, QUOTA_REFRESH, USAGE_SESSION, changesLine,
  compactedWords, compactsAt, contextLine, contextMeter, contextParts, heavyLine, modelUsageLine, planWords, quotaLine, quotaName, usageLine,
} from "./copy-customise";
import { action, confirmed, defineSection, list, load, part, row } from "./customise-kit";
import { compacted, contextView, heaviest, percent, quotaRows, usageView } from "./customise-read";
import { el } from "./dom";

defineSection("Usage", "both", ctx => {
  const quota = (v: unknown) => {
    const q = quotaRows(v);
    return [q.plan ? el("p", { className: "cz-line", textContent: planWords(q.plan) }) : null, list(QUOTA, q.rows.map(x => row({ name: quotaName(x.type), lines: [quotaLine(x)], more: [x.unlimited ? null : meter(100 - x.remaining, quotaName(x.type))] })), QUOTA_NONE)];
  };
  const context = (host: HTMLElement) => load(host, () => ctx.call("session", "metadata.contextInfo", { promptTokenLimit: 0, outputTokenLimit: 0 }), v => {
    const c = contextView(v);
    if (!c) return el("p", { className: "cz-line", textContent: CONTEXT_EMPTY });
    const pct = percent(c.total, c.limit);
    const heavy = el("div");
    void load(heavy, () => ctx.call("session", "metadata.getContextHeaviestMessages", { limit: 5 }), h => {
      const rows = heaviest(h);
      return rows.length ? [el("h4", { textContent: HEAVIEST }), list(HEAVIEST, rows.map(m => row({ name: m.label, lines: [heavyLine(m)] })), "")] : [];
    });
    return [meter(pct, contextMeter(c, pct), contextLine(c)), el("p", { className: "cz-line", textContent: contextParts(c) }), compactsAt(c.compactAt) ? el("p", { className: "hint", textContent: compactsAt(c.compactAt) }) : null, heavy];
  });
  return {
    draw(body) {
      const r = ctx.session();
      const refresh = action(QUOTA_REFRESH, async () => { await load(quotaPart.body, () => ctx.call("session", "quota.refresh"), quota); }, { aria: `${QUOTA_REFRESH}: ${QUOTA}` });
      const quotaPart = part(QUOTA, { scope: r ? "session" : "client", session: r, actions: r ? [refresh] : [] });
      if (!r) {
        body.replaceChildren(quotaPart.root);
        void load(quotaPart.body, () => ctx.call("client", "account.getQuota", {}), quota);
        return;
      }
      const use = part(USAGE_SESSION);
      const ctxPart = part(CONTEXT);
      const compact = confirmed(COMPACT, COMPACT_QUESTION, COMPACT, async () => {
        if (ctx.app.state.transcripts[r.id]?.busy || ctx.session()?.busy) { ctx.say(COMPACT_BUSY); return; }
        const res = await ctx.call("session", "history.compact", { trigger: "manual" });
        ctx.say(res.ok ? compactedWords(compacted(res.value)) : res.reason);
        if (res.ok) void context(ctxPart.body);
      });
      ctxPart.root.append(el("p", { className: "hint", textContent: COMPACT_LEAD }), el("div", { className: "cz-form-actions" }, compact));
      body.replaceChildren(use.root, ctxPart.root, quotaPart.root);
      void load(use.body, () => ctx.call("session", "usage.getMetrics"), v => {
        const u = usageView(v);
        return [
          el("p", { className: "cz-line", textContent: usageLine(u) }),
          el("p", { className: "cz-line", textContent: changesLine(u) }),
          list(USAGE_SESSION, u.models.map(m => row({ name: m.id, lines: [modelUsageLine(m)] })), ""),
        ];
      });
      void context(ctxPart.body);
      void load(quotaPart.body, () => ctx.call("session", "quota.get"), quota);
    },
  };
});

/** A still meter: its fill and its words (a screen reader hears the words, the bar is drawn for the eye). */
function meter(pct: number, label: string, words?: string): HTMLElement {
  const fill = el("span", { className: "cz-meter-fill" });
  fill.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct))}%`);
  return el("div", { className: "cz-meter", attrs: { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": label } },
    el("span", { className: "cz-meter-track", attrs: { "aria-hidden": "true" } }, fill), words ? el("span", { className: "cz-line", attrs: { "aria-hidden": "true" }, textContent: words }) : null);
}
