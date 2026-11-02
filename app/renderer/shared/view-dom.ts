/**
 * Draws a task's view (app/shared/view.ts, catalog ember.view/2) for any page: the overlay's task card now, Home's Task
 * activity next. DOM only, no framework: every string is set with textContent (SVG text too), never as markup, since a
 * view's words are the model's and may carry what it read on the screen. Nothing drawn here takes a click (the one
 * exception is a collapsed section's own disclosure in the window profile, which only folds it), and there are no
 * inline styles: sizes come from classes and data attributes, and a bar's length or a chart's shapes are SVG geometry,
 * so Home's `style-src 'self'` needs no exception.
 *
 * Two profiles (VIEW_PROFILES): "card" (the 320 px glass card, clipped to a card's height, a stricter cut of long
 * tables, lists, code and charts, each saying what it left out) and "window" (Home). Ember writes the frame: a
 * provenance line ("Found by …", what the task did) above, and "More in Home" when the card can't show it all.
 *
 * Updates (`ViewRenderer.patch`) replace only the nodes that changed, by id, and reorder a parent's children without
 * rebuilding them; a replaced node fades in once (view.css, `.vw-fresh`), never in Calm. Charts are static SVG, each
 * with a visually hidden table of the same numbers for screen readers.
 */

import {
  CALLOUT_WORDS, STEP_WORDS, TONE_SYMBOL, TONE_WORDS, VIEW_PROFILES, chartWords, deltaWords, fmt, isLayout, nodeLines,
  progressWords, provenanceWords, quoteCaption, walkView, type ViewDoc, type ViewNode, type ViewPatch, type ViewProfile, type ViewTone,
} from "../../shared/view";
import { chartGeometry, gaugeGeometry, sparkPoints } from "../../shared/view-chart";

const SVG = "http://www.w3.org/2000/svg";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

const svg = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
  const e = document.createElementNS(SVG, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const sr = (text: string) => el("span", "sr", text);
/** A symbol from view.css's fixed set, decorative (the words beside it say it). */
const sym = (name: string) => { const i = el("i", "vw-sym"); i.dataset.symbol = name; i.setAttribute("aria-hidden", "true"); return i; };
const toned = <E extends Element>(e: E, tone: ViewTone | undefined): E => { if (tone) e.setAttribute("data-tone", tone); return e; };
/** Ember's own words where a view was cut short ("2 more rows"): never the model's. */
const moreLine = (n: number, what: string) => el("p", "vw-cut", `${fmt(n)} more ${what}`);

/** The default tone of each of a chart's series, in order. */
const SERIES_TONES: readonly ViewTone[] = ["info", "special", "positive"];

/** Where a view's words came from, as its frame says. */
export interface ViewFrame { title?: string; footprints?: string }

export interface ViewDomOptions {
  profile: ViewProfile;
  frame?: ViewFrame;
}

/**
 * Which nodes a profile draws: the first `nodes` in reading order, and of those the first `charts` charts and gauges
 * drawn as pictures (the rest as their words). The window profile draws everything main accepted.
 */
function budget(doc: ViewDoc, profile: ViewProfile): { drawn: Set<string>; pictures: Set<string>; left: number } {
  const p = VIEW_PROFILES[profile];
  const order = walkView(doc);
  const drawn = new Set(order.slice(0, p.nodes));
  const pictures = new Set(order.filter(id => drawn.has(id) && (doc.nodes[id].kind === "chart" || doc.nodes[id].kind === "gauge")).slice(0, p.charts));
  const left = order.slice(p.nodes).filter(id => !isLayout(doc.nodes[id]) && doc.nodes[id].kind !== "divider").length;
  return { drawn, pictures, left };
}

/** One view, drawn and kept up to date in place. */
export class ViewRenderer {
  /** The whole view with its frame: put it where it shows. */
  readonly el: HTMLElement;
  private readonly from: HTMLParagraphElement;
  private readonly body: HTMLDivElement;
  private readonly more: HTMLParagraphElement;
  private doc: ViewDoc | null = null;
  private readonly els = new Map<string, Element>();
  /** Each layout node's element its children go in. */
  private readonly slots = new Map<string, Element>();
  private plan = { drawn: new Set<string>(), pictures: new Set<string>(), left: 0 };

  constructor(private readonly o: ViewDomOptions) {
    this.el = el("div", "vw");
    this.el.dataset.profile = o.profile;
    this.from = el("p", "vw-from");
    this.body = el("div", "vw-body");
    this.more = el("p", "vw-more", "More in Home");
    this.more.hidden = true;
    this.el.append(this.from, this.body, this.more);
    this.setFrame(o.frame ?? {});
  }

  /** Ember's provenance line: who found it and what the task did (Ember's words; the model can't write them). */
  setFrame(f: ViewFrame): void {
    const t = provenanceWords(f);
    if (this.from.textContent !== t) this.from.textContent = t;
  }

  /** The view now, or null before the first. */
  get current(): ViewDoc | null { return this.doc; }

  /** Draws `doc` whole. */
  show(doc: ViewDoc): void {
    this.doc = doc;
    this.els.clear();
    this.slots.clear();
    this.plan = budget(doc, this.o.profile);
    const root = this.build(doc.root, false);
    this.body.replaceChildren(...(root ? [root] : []));
    this.more.hidden = this.plan.left === 0;
  }

  /**
   * Applies a change main sent (already applied to `next`): only the nodes in `p.nodes` are drawn again, and a parent's
   * children are reordered without rebuilding the ones that stayed. A change to what the card's profile can draw (a
   * node pushed past its limit) draws the whole view again.
   */
  patch(next: ViewDoc, p: ViewPatch): void {
    const prev = this.doc;
    if (!prev || p.base === null || p.root !== prev.root) { this.show(next); return; }
    const plan = budget(next, this.o.profile);
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));
    // Only when the profile cuts the view (before or now), or a chart moves in or out of the card's two pictures.
    if (plan.left > 0 || this.plan.left > 0 || !same(plan.pictures, this.plan.pictures)) { this.show(next); return; }
    this.doc = next;
    this.plan = plan;
    for (const id of p.removed) { this.els.delete(id); this.slots.delete(id); }
    // Leaves and layout nodes whose own props changed: drawn again. A layout node whose only change is its children:
    // its slot is filled again from the elements it already has.
    const changed = Object.keys(p.nodes).filter(id => plan.drawn.has(id));
    for (const id of changed) {
      const n = next.nodes[id], before = prev.nodes[id];
      const old = this.els.get(id);
      if (old && before && isLayout(n) && isLayout(before) && sameProps(n, before)) { this.fill(id, n.children, true); continue; }
      if (!old) continue; // a new node: its parent's change puts it in
      // A layout node drawn again keeps its children's elements (only their parent changed).
      const fresh = this.build(id, true, isLayout(n));
      if (fresh) old.replaceWith(fresh);
    }
    this.more.hidden = this.plan.left === 0;
  }

  /** The card's view as words (screen readers get the elements; this is for a page that wants the text). */
  text(): string {
    return this.doc ? walkView(this.doc).flatMap(id => nodeLines(this.doc!.nodes[id])).join("\n") : "";
  }

  /** Puts a layout node's children in its slot, building the ones it hasn't drawn yet (`fresh`: they fade in). */
  private fill(id: string, children: readonly string[], fresh: boolean): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const kids = children.filter(c => this.plan.drawn.has(c)).map(c => this.els.get(c) ?? this.build(c, fresh)).filter((e): e is Element => !!e);
    // Reorders in place: an element already there moves, only new ones are inserted.
    kids.forEach((k, i) => { if (slot.children[i] !== k) slot.insertBefore(k, slot.children[i] ?? null); });
    while (slot.children.length > kids.length) slot.lastElementChild!.remove();
  }

  private build(id: string, fresh: boolean, keepChildren = false): Element | null {
    const doc = this.doc!;
    const n = doc.nodes[id];
    if (!n || !this.plan.drawn.has(id)) return null;
    const e = this.o.profile === "card" && (n.kind === "chart" || n.kind === "gauge") && !this.plan.pictures.has(id)
      ? asWords(n) : this.node(id, n);
    if (n.weight) e.setAttribute("data-weight", String(n.weight));
    if (!isLayout(n)) e.setAttribute("data-leaf", "");
    e.setAttribute("data-node", id);
    if (fresh) e.classList.add("vw-fresh");
    this.els.set(id, e);
    if (isLayout(n)) {
      if (keepChildren) this.fill(id, n.children, false);
      else for (const c of n.children) { const k = this.build(c, fresh); if (k) this.slots.get(id)!.append(k); }
    }
    return e;
  }

  private node(id: string, n: ViewNode): Element {
    const card = this.o.profile === "card";
    const p = VIEW_PROFILES[this.o.profile];
    switch (n.kind) {
      case "stack": case "row": case "grid": case "card": {
        const e = el("div", `vw-${n.kind}`);
        if (n.kind === "stack" && n.gap) e.dataset.gap = n.gap;
        if (n.kind === "row") { if (n.align) e.dataset.align = n.align; if (n.justify) e.dataset.justify = n.justify; }
        if (n.kind === "grid") e.dataset.columns = String(Math.min(n.columns, p.gridColumns));
        if (n.kind === "card") toned(e, n.tone);
        this.slots.set(id, e);
        return e;
      }
      case "section": {
        // Folded only in a window, by Ember's own disclosure (it folds, nothing more); a card shows it open.
        if (!card && n.collapsed) {
          const d = el("details", "vw-section");
          const s = el("summary", "vw-section-title", n.title);
          const body = el("div", "vw-section-body");
          d.append(s, body);
          this.slots.set(id, body);
          return d;
        }
        const s = el("section", "vw-section");
        const body = el("div", "vw-section-body");
        s.append(el("h4", "vw-section-title", n.title), body);
        this.slots.set(id, body);
        return s;
      }
      case "divider": return el("hr", "vw-divider");
      case "heading": return el(n.level === 1 ? "h4" : "h5", `vw-heading vw-h${n.level}`, n.text);
      case "text": { const e = el("p", "vw-text", n.text); if (n.tone) e.dataset.tone = n.tone; return e; }
      case "rich": {
        const e = el("p", "vw-text");
        e.append(...n.runs.map(r => r.style === "strong" ? el("strong", undefined, r.text) : r.style === "code" ? el("code", "vw-mono", r.text) : document.createTextNode(r.text)));
        return e;
      }
      case "keyvalue": {
        const dl = el("dl", "vw-kv");
        for (const r of n.rows) {
          const dd = toned(el("dd"), r.tone);
          if (r.tone && TONE_WORDS[r.tone]) dd.append(sym(TONE_SYMBOL[r.tone]), sr(TONE_WORDS[r.tone]));
          dd.append(document.createTextNode(r.value));
          dl.append(el("dt", undefined, r.label), dd);
        }
        return dl;
      }
      case "badge": {
        const b = toned(el("span", "vw-badge"), n.tone);
        if (n.symbol) b.append(sym(n.symbol));
        if (TONE_WORDS[n.tone]) b.append(sr(TONE_WORDS[n.tone]));
        b.append(document.createTextNode(n.text));
        return b;
      }
      case "callout": {
        const c = toned(el("div", "vw-callout"), n.tone);
        c.setAttribute("role", "note");
        const words = el("div", "vw-callout-words");
        words.append(sr(CALLOUT_WORDS[n.tone]));
        if (n.title) words.append(el("b", "vw-callout-title", n.title));
        words.append(el("p", undefined, n.text));
        c.append(sym(n.symbol ?? TONE_SYMBOL[n.tone]), words);
        return c;
      }
      case "quote": {
        // Ember captions it from its checked source; the words are as they were found (no tone, no symbol, no heading).
        const f = el("figure", "vw-quote");
        const caption = quoteCaption(n.source);
        f.setAttribute("aria-label", caption.replace(/^From/, "Quoted from"));
        f.append(el("figcaption", undefined, caption), el("blockquote", undefined, n.text));
        return f;
      }
      case "list": {
        const list = el(n.ordered ? "ol" : "ul", "vw-list");
        list.append(...n.items.slice(0, p.items).map(t => el("li", undefined, t)));
        return withCut(list, n.items.length - p.items, n.items.length - p.items === 1 ? "item" : "items");
      }
      case "table": return table(n, p.tableColumns, p.tableRows);
      case "steps": {
        const ol = el("ol", "vw-steps");
        ol.append(...n.items.slice(0, p.items).map(i => {
          const li = el("li");
          li.dataset.state = i.state;
          li.append(el("i", "vw-mark"), sr(STEP_WORDS[i.state]), document.createTextNode(i.text));
          li.firstElementChild!.setAttribute("aria-hidden", "true");
          return li;
        }));
        return withCut(ol, n.items.length - p.items, n.items.length - p.items === 1 ? "step" : "steps");
      }
      case "timeline": {
        const ol = el("ol", "vw-timeline");
        ol.append(...n.items.slice(0, p.items).map(i => {
          const li = toned(el("li"), i.tone);
          const what = el("span", "vw-what");
          if (i.tone && TONE_WORDS[i.tone]) what.append(sr(TONE_WORDS[i.tone]));
          what.append(document.createTextNode(i.text));
          li.append(el("span", "vw-when", i.when), what);
          return li;
        }));
        return withCut(ol, n.items.length - p.items, n.items.length - p.items === 1 ? "event" : "events");
      }
      case "progress": {
        const w = toned(el("div", "vw-progress"), n.tone ?? "info");
        const words = el("p");
        words.append(el("span", "vw-label", n.label), el("span", "vw-n", progressWords(n.value, n.max)));
        // The bar is decorative (the words say it), its length SVG geometry set once (no transition).
        const bar = svg("svg", { class: "vw-bar", viewBox: "0 0 100 4", preserveAspectRatio: "none", "aria-hidden": "true" });
        bar.append(svg("rect", { class: "vw-track", x: 0, y: 0, width: 100, height: 4, rx: 2 }));
        const pct = Math.min(100, Math.max(0, Math.round((n.value / n.max) * 1000) / 10));
        if (pct > 0) bar.append(svg("rect", { class: "vw-fill", x: 0, y: 0, width: Math.max(pct, 2), height: 4, rx: 2 }));
        w.append(words, bar);
        return w;
      }
      case "gauge": return gauge(n);
      case "metric": return metric(n);
      case "chart": return chart(n, card);
      case "compare": {
        const t = el("table", "vw-table vw-compare");
        const head = el("tr");
        head.append(el("td"), ...n.columns.map(c => Object.assign(el("th", undefined, c), { scope: "col" })));
        const body = el("tbody");
        for (const r of n.rows.slice(0, p.tableRows)) {
          const tr = el("tr");
          tr.append(Object.assign(el("th", undefined, r.label), { scope: "row" }));
          for (const side of ["a", "b"] as const) {
            const td = el("td", undefined);
            if (r.better === side) { td.className = "vw-better"; td.append(sym("check"), sr("Better: ")); }
            td.append(document.createTextNode(r[side]));
            tr.append(td);
          }
          body.append(tr);
        }
        const thead = el("thead");
        thead.append(head);
        t.append(thead, body);
        return withCut(t, n.rows.length - p.tableRows, n.rows.length - p.tableRows === 1 ? "row" : "rows");
      }
      case "code": {
        const f = el("figure", "vw-code");
        if (n.caption || n.lang) {
          const cap = el("figcaption");
          if (n.caption) cap.append(document.createTextNode(n.caption));
          if (n.lang) cap.append(el("span", "vw-lang", n.lang));
          f.append(cap);
        }
        f.append(el("pre", "vw-mono", n.lines.slice(0, p.codeLines).join("\n")));
        return withCut(f, n.lines.length - p.codeLines, n.lines.length - p.codeLines === 1 ? "line" : "lines");
      }
      case "file": {
        const f = el("figure", "vw-file");
        const head = el("figcaption");
        head.append(sym("file"));
        if (n.label) head.append(el("span", "vw-label", `${n.label}: `));
        head.append(el("code", "vw-mono", n.path));
        f.append(head);
        if (n.lines?.length) f.append(el("pre", "vw-mono", n.lines.join("\n")));
        return f;
      }
      default:
        // A kind this page doesn't know (a newer catalog): skipped, never thrown on.
        return el("div", "vw-unknown");
    }
  }
}

const sameProps = (a: ViewNode, b: ViewNode) => {
  const strip = (n: ViewNode) => JSON.stringify({ ...n, children: undefined });
  return strip(a) === strip(b);
};

/** `e`, followed by Ember's "N more …" when the profile cut `left` of its items. */
function withCut(e: HTMLElement, left: number, what: string): HTMLElement {
  if (left <= 0) return e;
  const w = el("div", "vw-cutwrap");
  w.append(e, moreLine(left, what));
  return w;
}

/** A chart past the card's pictures, as its words. */
function asWords(n: ViewNode): HTMLElement {
  const w = el("div", "vw-words");
  for (const l of nodeLines(n)) w.append(el("p", "vw-text", l));
  return w;
}

function table(n: Extract<ViewNode, { kind: "table" }>, maxCols: number, maxRows: number): HTMLElement {
  const t = el("table", "vw-table");
  const cols = Math.min(n.columns.length, maxCols);
  const num = new Set(n.numeric ?? []);
  if (n.caption) t.append(el("caption", undefined, n.caption));
  const head = el("tr");
  head.append(...n.columns.slice(0, cols).map((c, i) => { const th = Object.assign(el("th", undefined, c), { scope: "col" }); if (num.has(i)) th.className = "num"; return th; }));
  const thead = el("thead");
  thead.append(head);
  const body = el("tbody");
  for (const r of n.rows.slice(0, maxRows)) {
    const tr = el("tr");
    tr.append(...r.slice(0, cols).map((c, i) => { const td = el("td", undefined, c); if (num.has(i)) td.className = "num"; return td; }));
    body.append(tr);
  }
  t.append(thead, body);
  const rowsLeft = n.rows.length - maxRows, colsLeft = n.columns.length - cols;
  const cut = [rowsLeft > 0 ? `${fmt(rowsLeft)} more ${rowsLeft === 1 ? "row" : "rows"}` : "", colsLeft > 0 ? `${fmt(colsLeft)} more ${colsLeft === 1 ? "column" : "columns"}` : ""].filter(Boolean);
  if (!cut.length) return t;
  const w = el("div", "vw-cutwrap");
  w.append(t, el("p", "vw-cut", cut.join(", ")));
  return w;
}

/** The same numbers as a chart, as a table only screen readers see (a chart's picture is one image to them). */
function dataTable(caption: string, columns: string[], rows: string[][]): HTMLTableElement {
  const t = el("table", "sr");
  t.append(el("caption", undefined, caption));
  const head = el("tr");
  head.append(...columns.map(c => Object.assign(el("th", undefined, c), { scope: "col" })));
  const thead = el("thead");
  thead.append(head);
  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    tr.append(Object.assign(el("th", undefined, r[0]), { scope: "row" }), ...r.slice(1).map(c => el("td", undefined, c)));
    body.append(tr);
  }
  t.append(thead, body);
  return t;
}

const value = (v: number | null | undefined, unit?: string) => (v === null || v === undefined ? "none" : `${fmt(v)}${unit ? ` ${unit}` : ""}`);

/** A chart's height in its own units: a card's is shorter, so a chart fits under a row of figures. */
const CHART_TALL = { card: 96, window: 140 } as const;
/** Its width in its own units, about the width it is drawn at, so its labels are caption-size on a card and in a window. */
const CHART_WIDE = { card: 280, window: 520 } as const;

function chart(n: Extract<ViewNode, { kind: "chart" }>, card: boolean): HTMLElement {
  const f = el("figure", "vw-chart");
  f.dataset.type = n.type;
  const g = chartGeometry(n, CHART_WIDE[card ? "card" : "window"], CHART_TALL[card ? "card" : "window"]);
  const tones = n.series.map((s, i) => s.tone ?? SERIES_TONES[i % SERIES_TONES.length]);
  if (n.title) f.append(el("figcaption", "vw-chart-title", n.title));
  if (n.series.length > 1) {
    const legend = el("ul", "vw-legend");
    legend.setAttribute("aria-hidden", "true");
    legend.append(...n.series.map((s, i) => {
      const li = toned(el("li"), tones[i]);
      li.dataset.series = String(i);
      li.append(el("i", "vw-swatch"), document.createTextNode(s.name));
      return li;
    }));
    f.append(legend);
  }
  const pic = svg("svg", { class: "vw-plot", viewBox: `0 0 ${g.width} ${g.height}`, role: "img", "aria-label": chartWords(n) });
  if (n.type !== "spark") {
    for (const t of g.ticks) {
      pic.append(g.horizontal
        ? svg("line", { class: "vw-grid", x1: t.at, x2: t.at, y1: g.plot.y, y2: g.plot.y + g.plot.h })
        : svg("line", { class: "vw-grid", x1: g.plot.x, x2: g.plot.x + g.plot.w, y1: t.at, y2: t.at }));
      const label = g.horizontal
        ? svg("text", { class: "vw-axis", "font-size": 11, x: t.at, y: g.plot.y + g.plot.h + 12, "text-anchor": "middle" })
        : svg("text", { class: "vw-axis", "font-size": 11, x: g.plot.x - 4, y: t.at + 3.5, "text-anchor": "end" });
      label.textContent = t.label;
      pic.append(label);
    }
    pic.append(g.horizontal
      ? svg("line", { class: "vw-base", x1: g.baseline, x2: g.baseline, y1: g.plot.y, y2: g.plot.y + g.plot.h })
      : svg("line", { class: "vw-base", x1: g.plot.x, x2: g.plot.x + g.plot.w, y1: g.baseline, y2: g.baseline }));
    for (const l of g.labels) {
      const t = g.horizontal
        ? svg("text", { class: "vw-axis", "font-size": 11, x: g.plot.x - 6, y: l.at + 3.5, "text-anchor": "end" })
        : svg("text", { class: "vw-axis", "font-size": 11, x: l.at, y: g.height - 4, "text-anchor": "middle" });
      t.textContent = l.label;
      pic.append(t);
    }
  }
  for (const b of g.bars) pic.append(toned(svg("rect", { class: "vw-mark-bar", x: b.x, y: b.y, width: b.w, height: b.h, rx: 1.5, "data-series": b.series }), tones[b.series]));
  for (const l of g.lines) {
    for (const d of l.areas) pic.append(toned(svg("path", { class: "vw-area", d, "data-series": l.series }), tones[l.series]));
    for (const pts of l.runs) pic.append(toned(svg("polyline", { class: "vw-line", points: pts, "data-series": l.series }), tones[l.series]));
  }
  f.append(pic);
  const cats = n.type === "spark" ? n.series[0].values.map((_, i) => String(i + 1)) : n.categories;
  f.append(dataTable(chartWords(n), [n.type === "spark" ? "Point" : "Category", ...n.series.map(s => s.name)],
    cats.map((c, i) => [c, ...n.series.map(s => value(s.values[i], n.unit))])));
  return f;
}

function gauge(n: Extract<ViewNode, { kind: "gauge" }>): HTMLElement {
  const f = el("figure", "vw-gauge");
  const g = gaugeGeometry(n);
  const words = nodeLines(n)[0];
  const pic = svg("svg", { class: "vw-dial", viewBox: `0 0 ${g.width} ${g.height}`, role: "img", "aria-label": words });
  for (const b of g.bands) pic.append(toned(svg("path", { class: "vw-band", d: b.d }), b.tone as ViewTone));
  pic.append(svg("path", { class: "vw-track-arc", d: g.track }));
  // The value's arc takes the tone of the band it is in, else info.
  const band = n.bands?.find(b => n.value <= b.upTo)?.tone ?? "info";
  if (g.value) pic.append(toned(svg("path", { class: "vw-value-arc", d: g.value }), band));
  const v = svg("text", { class: "vw-dial-value", "font-size": 20, x: g.cx, y: g.cy - 8, "text-anchor": "middle" });
  v.textContent = `${fmt(n.value)}${n.unit ? ` ${n.unit}` : ""}`;
  const lo = svg("text", { class: "vw-axis", "font-size": 11, x: g.cx - 64, y: g.height - 1, "text-anchor": "middle" });
  lo.textContent = fmt(n.min);
  const hi = svg("text", { class: "vw-axis", "font-size": 11, x: g.cx + 64, y: g.height - 1, "text-anchor": "middle" });
  hi.textContent = fmt(n.max);
  pic.append(v, lo, hi);
  f.append(pic, el("figcaption", "vw-label", n.label));
  return f;
}

function metric(n: Extract<ViewNode, { kind: "metric" }>): HTMLElement {
  const m = el("div", "vw-metric");
  m.append(el("span", "vw-metric-label", n.label), el("span", "vw-metric-value", n.value));
  if (n.delta) {
    const d = el("span", "vw-delta");
    d.dataset.direction = n.delta.direction;
    if (n.delta.good !== undefined) d.dataset.good = String(n.delta.good);
    const i = el("i", "vw-sym");
    i.dataset.symbol = n.delta.direction;
    i.setAttribute("aria-hidden", "true");
    // The words say the change ("up 4 %"); whether that is good is said to screen readers, and shown by its tone.
    const words = deltaWords(n.delta);
    const shown = words.replace(/ \((better|worse)\)$/, "");
    d.append(i, document.createTextNode(shown));
    if (shown !== words) d.append(sr(words.slice(shown.length)));
    m.append(d);
  }
  if (n.spark) {
    const pic = svg("svg", { class: "vw-spark", viewBox: "0 0 64 20", "aria-hidden": "true" });
    pic.append(svg("polyline", { class: "vw-line", points: sparkPoints(n.spark) }));
    m.append(pic);
  }
  return m;
}

/** A view drawn once (a page that never updates it). */
export function renderView(doc: ViewDoc, o: ViewDomOptions): HTMLElement {
  const r = new ViewRenderer(o);
  r.show(doc);
  return r.el;
}

/**
 * Fits a drawn card view to the card's height (view.css's max-height on its body): the first block that would pass it,
 * and every block after it, is left out whole (never cut through), a layout node with nothing left in it goes too, and
 * Ember's "More in Home" says so. Call after layout (a frame after the view changed): one pass of reads, then writes.
 */
export function fitView(r: ViewRenderer): void {
  const body = r.el.querySelector<HTMLElement>(".vw-body");
  const more = r.el.querySelector<HTMLElement>(".vw-more");
  if (!body || !more) return;
  for (const e of body.querySelectorAll("[data-cut]")) e.removeAttribute("data-cut");
  const cap = parseFloat(getComputedStyle(body).maxHeight);
  if (!Number.isFinite(cap)) return;
  const top = body.getBoundingClientRect().top;
  const leaves = [...body.querySelectorAll<HTMLElement>("[data-leaf]")];
  const first = leaves.findIndex(e => e.getBoundingClientRect().bottom - top > cap + 0.5);
  if (first < 0) return;
  for (const e of leaves.slice(first)) e.setAttribute("data-cut", "");
  // Layout nodes left empty, innermost first (querySelectorAll is in document order: reversed, children come first).
  for (const e of [...body.querySelectorAll<HTMLElement>("[data-node]:not([data-leaf])")].reverse()) {
    const kids = [...e.querySelectorAll<HTMLElement>("[data-leaf]")];
    if (kids.length && kids.every(k => k.hasAttribute("data-cut"))) e.setAttribute("data-cut", "");
  }
  more.hidden = false;
}
