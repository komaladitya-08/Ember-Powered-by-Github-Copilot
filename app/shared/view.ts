/**
 * Ember's generative UI: what a task may show on its card besides words (docs/DESIGN.md "Views"). A worker never sends
 * markup or code. It composes a view from this fixed, versioned catalog (`ember.view/2`): layout blocks (stack, row,
 * grid, card, section, divider), content blocks (heading, text, rich, keyvalue, badge, callout, quote) and data blocks
 * (list, table, steps, timeline, progress, gauge, metric, chart, compare, code, file). Main checks every view
 * (app/main/agent/view-schema.ts) and Ember draws it with its own components (app/renderer/shared/view-dom.ts), as
 * plain text and static SVG. That is the approach of declarative agent UIs such as A2UI and json-render: anything
 * outside the catalog isn't drawn, and the model chooses structure and words, never colours, sizes, URLs, icons or
 * controls. Every string is the model's, and may carry what it read on the screen, so it is untrusted: shown as text,
 * never as a link, a button or an instruction, inside a frame Ember writes ("Found by …").
 *
 * The stored form is flat (`ViewDoc`: a root id and a map of id → node), so a view can change one node at a time
 * (update_view) and the renderer can replace only what changed (`ViewPatch`). The catalog's first version (a flat
 * array of at most 6 blocks, `ViewBlockV1`) is still accepted and upgraded at once (`upgradeView`).
 *
 * Kept free of zod and the DOM: main, the overlay and Home all import it.
 */

/** One step of a task's plan, as its card lists it. */
export interface PlanStep { text: string; state: "done" | "now" | "todo" }

/** How a task works right now: through apps' accessibility, commands or another computer; on Ember's desk; or with the user's mouse and keyboard. */
export type TaskHand = "background" | "desk" | "cursor";

/** The catalog's first version: a flat array of blocks (finish_task before ember.view/2). Upgraded by `upgradeView`. */
export type ViewBlockV1 =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "facts"; rows: { label: string; value: string }[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "file"; path: string; label?: string }
  /** Items ticked off or not ("Night Light on"). */
  | { kind: "checklist"; items: { text: string; done: boolean }[] }
  /** How far something got: `value` of `total` (whole numbers, 0 <= value <= total), a static bar with the words. */
  | { kind: "progress"; label: string; value: number; total: number }
  /** Two things side by side: two column names, then rows of a label and each one's value. */
  | { kind: "compare"; columns: [string, string]; rows: { label: string; a: string; b: string }[] }
  /** A few lines of a file, as text (no link, nothing to open): refused whole if any line holds a secret (view-schema.ts). */
  | { kind: "excerpt"; path: string; lines: string[] }
  /** One outcome in words beside a symbol: fine, worth a look, or a problem (never colour alone). */
  | { kind: "status"; tone: "ok" | "warn" | "fail"; text: string };

/** @deprecated The first catalog's block; new code builds a `ViewDoc`. */
export type ViewBlock = ViewBlockV1;

/** The first catalog's limits: what fits a card, and keeps one card from folding the others away. */
export const VIEW_LIMITS = {
  blocks: 6, text: 600, items: 8, item: 200, rows: 6, columns: 3, cell: 80, label: 60, value: 200, path: 400, plan: 8, step: 80,
  lines: 8, line: 120, total: 10_000,
} as const;

/** A v1 status block's tone in words, before its text (screen readers, and the view as text). */
export const TONE_WORD: Record<"ok" | "warn" | "fail", string> = { ok: "OK: ", warn: "Worth a look: ", fail: "Problem: " };

/** A progress block's words: "3 of 5". */
export const progressWords = (value: number, total: number): string => `${fmt(value)} of ${fmt(total)}`;

/** The words of a task's plan step for screen readers, before the step ("Done: ", "Now: ", "Next: "). */
export const PLAN_WORD: Record<PlanStep["state"], string> = { done: "Done: ", now: "Now: ", todo: "Next: " };

/** How a task's card names its hand (shown under its title while it works). */
export const HAND_WORDS: Record<TaskHand, string> = {
  background: "In the background",
  desk: "On my desk",
  cursor: "Using your mouse and keyboard",
};

/** A plan as its card's steps: those before `now` done, `now` under way, the rest to come (`now` past the end: all done). */
export function planSteps(steps: readonly string[], now: number): PlanStep[] {
  return steps.map((text, i) => ({ text, state: i < now ? "done" : i === now ? "now" : "todo" }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Catalog v2

/** The catalog's id: main rejects anything outside it, and a renderer skips (never throws on) a kind it doesn't know. */
export const VIEW_CATALOG = "ember.view/2";

/**
 * The semantic palette: the only colours a view has. Each maps to one of Ember's system colours (neutral grey, info
 * blue, positive green, caution yellow, negative red, special purple), always beside a symbol or words. Ember's accent is
 * never one of them: it is Ember's own action and status colour.
 */
export const VIEW_TONES = ["neutral", "info", "positive", "caution", "negative", "special"] as const;
export type ViewTone = (typeof VIEW_TONES)[number];

/**
 * The fixed symbols a view may name (callouts and badges), drawn from Ember's own masks (view.css). Ember's status
 * symbols (working, waiting…) are deliberately not among them, so a view can't look like a task's or a question's state.
 */
export const VIEW_SYMBOLS = ["info", "tip", "caution", "problem", "check", "cross", "clock", "file", "folder", "app", "person", "calendar", "chart"] as const;
export type ViewSymbol = (typeof VIEW_SYMBOLS)[number];

/** Where a quote's words came from. `app` is kept only when the task really read that app (checked by main). */
export interface QuoteSource { kind: "screen" | "app" | "file" | "web" | "command"; app?: string; path?: string }

export type StepState = "done" | "now" | "todo" | "skipped" | "failed";
export type ChartType = "bar" | "hbar" | "line" | "area" | "spark";

/** What any node may carry: its share of a row's width (1–4; elsewhere ignored). */
interface NodeBase { weight?: number }

export type ViewLayoutNode =
  | (NodeBase & { kind: "stack"; children: string[]; gap?: "tight" | "normal" | "loose" })
  | (NodeBase & { kind: "row"; children: string[]; align?: "start" | "center" | "end"; justify?: "start" | "between" | "end" })
  | (NodeBase & { kind: "grid"; children: string[]; columns: 2 | 3 })
  | (NodeBase & { kind: "card"; children: string[]; tone?: ViewTone })
  | (NodeBase & { kind: "section"; title: string; children: string[]; collapsed?: boolean });

export type ViewLeafNode =
  | (NodeBase & { kind: "divider" })
  | (NodeBase & { kind: "heading"; text: string; level: 1 | 2 })
  | (NodeBase & { kind: "text"; text: string; tone?: "secondary" })
  | (NodeBase & { kind: "rich"; runs: { text: string; style?: "strong" | "code" }[] })
  | (NodeBase & { kind: "keyvalue"; rows: { label: string; value: string; tone?: ViewTone }[] })
  | (NodeBase & { kind: "badge"; text: string; tone: ViewTone; symbol?: ViewSymbol })
  | (NodeBase & { kind: "callout"; tone: ViewTone; title?: string; text: string; symbol?: ViewSymbol })
  | (NodeBase & { kind: "quote"; text: string; source: QuoteSource })
  | (NodeBase & { kind: "list"; items: string[]; ordered?: boolean })
  | (NodeBase & { kind: "table"; columns: string[]; rows: string[][]; numeric?: number[]; caption?: string })
  | (NodeBase & { kind: "steps"; items: { text: string; state: StepState }[] })
  | (NodeBase & { kind: "timeline"; items: { when: string; text: string; tone?: ViewTone }[] })
  | (NodeBase & { kind: "progress"; label: string; value: number; max: number; tone?: ViewTone })
  | (NodeBase & { kind: "gauge"; label: string; value: number; min: number; max: number; unit?: string; bands?: { upTo: number; tone: ViewTone }[] })
  | (NodeBase & { kind: "metric"; label: string; value: string; delta?: { text: string; direction: "up" | "down" | "flat"; good?: boolean }; spark?: number[] })
  | (NodeBase & { kind: "chart"; type: ChartType; title?: string; categories: string[]; series: { name: string; values: (number | null)[]; tone?: ViewTone }[]; unit?: string; yMin?: number })
  | (NodeBase & { kind: "compare"; columns: [string, string]; rows: { label: string; a: string; b: string; better?: "a" | "b" }[] })
  | (NodeBase & { kind: "code"; lines: string[]; lang?: string; caption?: string })
  | (NodeBase & { kind: "file"; path: string; label?: string; lines?: string[] });

/** One node of a checked view (flat form: a layout node names its children by id). */
export type ViewNode = ViewLayoutNode | ViewLeafNode;
export type ViewKind = ViewNode["kind"];

/** The layout kinds: the only ones with children. */
export const LAYOUT_KINDS: ReadonlySet<string> = new Set(["stack", "row", "grid", "card", "section"]);
export const isLayout = (n: ViewNode): n is ViewLayoutNode => LAYOUT_KINDS.has(n.kind);

/** A checked view, as main stores it and sends it: flat, one root, versioned. */
export interface ViewDoc {
  catalog: typeof VIEW_CATALOG;
  /** Bumped by main on each accepted change. */
  rev: number;
  /** The id of a layout node. */
  root: string;
  nodes: Record<string, ViewNode>;
}

/**
 * The limits, as two profiles: the card's (the glass card in the corner, 320 px wide) and the window's (Home, about
 * 560 px). The window's is the hard cap main enforces; a view past the card's is still accepted, and the card draws the
 * first part and says what it left out ("2 more rows"), the whole of it reaching the conversation as words.
 */
export const VIEW_PROFILES = {
  card: { depth: 4, nodes: 40, children: 8, chars: 2_000, charts: 2, tableColumns: 3, tableRows: 6, codeLines: 12, gridColumns: 2, items: 8 },
  window: { depth: 5, nodes: 120, children: 12, chars: 8_000, charts: 6, tableColumns: 6, tableRows: 20, codeLines: 40, gridColumns: 3, items: 12 },
} as const;
export type ViewProfile = keyof typeof VIEW_PROFILES;

/** Per-string and per-block limits (every profile). */
export const VIEW_V2 = {
  text: 600, item: 200, label: 60, value: 200, cell: 80, path: 400, heading: 80, badge: 24, codeLine: 160, quote: 600,
  when: 24, unit: 8, metricValue: 16, delta: 12, caption: 120, lang: 16, run: 200,
  runs: 24, rows: 12, steps: 12, timeline: 12, categories: 12, lineCategories: 24, series: 3, spark: 24, bands: 3,
  compareRows: 8, fileLines: 8, numeric: 6, number: 1e12, progressMax: 1e9, id: 24, ops: 16,
} as const;

/** The code block's language label (a label only: nothing is highlighted or run). */
export const CODE_LANGS = ["text", "shell", "python", "javascript", "typescript", "json", "yaml", "toml", "ini", "xml", "html", "css", "sql", "c", "cpp", "csharp", "java", "go", "rust", "ruby", "php", "markdown", "diff", "log"] as const;

/** A tone's words for screen readers and the text form, before a toned item ("Caution: "). Neutral says nothing. */
export const TONE_WORDS: Readonly<Record<ViewTone, string>> = {
  neutral: "", info: "Note: ", positive: "OK: ", caution: "Worth a look: ", negative: "Problem: ", special: "Note: ",
};

/** A callout's prefix, set by its tone (shown to screen readers and in the text form; its symbol shows it on screen). */
export const CALLOUT_WORDS: Readonly<Record<ViewTone, string>> = {
  neutral: "Note: ", info: "Note: ", positive: "OK: ", caution: "Worth a look: ", negative: "Problem: ", special: "Tip: ",
};

/** The symbol a callout or badge shows when it names none: one per tone. */
export const TONE_SYMBOL: Readonly<Record<ViewTone, ViewSymbol>> = {
  neutral: "info", info: "info", positive: "check", caution: "caution", negative: "problem", special: "tip",
};

/** A step's state in words, before it (screen readers and the text form). */
export const STEP_WORDS: Readonly<Record<StepState, string>> = {
  done: "Done: ", now: "Now: ", todo: "To do: ", skipped: "Skipped: ", failed: "Didn't work: ",
};

/** A metric's change in words: "up 4 %" (and, for screen readers, whether that is good). */
export function deltaWords(d: { text: string; direction: "up" | "down" | "flat"; good?: boolean }): string {
  const way = d.direction === "up" ? "up" : d.direction === "down" ? "down" : "no change,";
  return `${way} ${d.text}${d.good === undefined ? "" : d.good ? " (better)" : " (worse)"}`;
}

/** The caption Ember sets on a quote, from its checked source: "From Firefox", "From a file", "From the screen". */
export function quoteCaption(s: QuoteSource): string {
  switch (s.kind) {
    case "app": return s.app ? `From ${s.app}` : "From the screen";
    case "file": return "From a file";
    case "web": return "From a web page";
    case "command": return "From a command";
    default: return "From the screen";
  }
}

/** Ember's provenance line above a view: who found it, then what the task did ("Found by this task · Clicked 3 times"). */
export function provenanceWords(o: { title?: string; footprints?: string }): string {
  const who = o.title ? `Found by “${o.title}”` : "Found by this task";
  return o.footprints ? `${who} · ${o.footprints}` : who;
}

/** A number as views write it: grouped, at most two decimals ("1,240", "3.5"), the same everywhere. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });
}

const withUnit = (n: number, unit?: string) => `${fmt(n)}${unit ? ` ${unit}` : ""}`;

/** What kind of chart, in words: its accessible name ("Bar chart, 2 series, 6 categories"). */
export function chartWords(c: Extract<ViewNode, { kind: "chart" }>): string {
  const type = { bar: "Bar chart", hbar: "Bar chart", line: "Line chart", area: "Area chart", spark: "Trend" }[c.type];
  const n = c.series.length;
  const cats = c.type === "spark" ? `${c.series[0]?.values.length ?? 0} points` : `${c.categories.length} ${c.categories.length === 1 ? "category" : "categories"}`;
  return `${c.title ? `${c.title}: ` : ""}${type}, ${n} series, ${cats}`;
}

/** One node's own lines (its children aren't included): the text form, for the conversation, speech and the audit. */
export function nodeLines(n: ViewNode): string[] {
  switch (n.kind) {
    case "stack": case "row": case "grid": case "card": case "divider": return [];
    case "section": return [n.title];
    case "heading": case "text": return [n.text];
    case "rich": return [n.runs.map(r => r.text).join("")];
    case "keyvalue": return n.rows.map(r => `${r.label}: ${TONE_WORDS[r.tone ?? "neutral"]}${r.value}`);
    case "badge": return [`${TONE_WORDS[n.tone]}${n.text}`];
    case "callout": return [`${CALLOUT_WORDS[n.tone]}${n.title ? `${n.title}. ` : ""}${n.text}`];
    case "quote": return [`${quoteCaption(n.source)}: ${n.text}`];
    case "list": return n.items.map((t, i) => `${n.ordered ? `${i + 1}.` : "-"} ${t}`);
    case "table": return [...(n.caption ? [n.caption] : []), n.columns.join(" | "), ...n.rows.map(r => r.join(" | "))];
    case "steps": return n.items.map(i => `${STEP_WORDS[i.state]}${i.text}`);
    case "timeline": return n.items.map(i => `${i.when}: ${TONE_WORDS[i.tone ?? "neutral"]}${i.text}`);
    case "progress": return [`${n.label}: ${progressWords(n.value, n.max)}`];
    case "gauge": return [`${n.label}: ${withUnit(n.value, n.unit)} (from ${withUnit(n.min, n.unit)} to ${withUnit(n.max, n.unit)})`];
    case "metric": return [`${n.label}: ${n.value}${n.delta ? `, ${deltaWords(n.delta)}` : ""}`];
    case "chart": {
      const head = chartWords(n);
      if (n.type === "spark") return [`${head}: ${n.series[0]?.values.map(v => (v === null ? "none" : withUnit(v, n.unit))).join(", ") ?? ""}`];
      return [head, ...n.series.map(s => `${s.name}: ${n.categories.map((c, i) => `${c} ${s.values[i] === null || s.values[i] === undefined ? "none" : withUnit(s.values[i]!, n.unit)}`).join(", ")}`)];
    }
    case "compare": return [`${n.columns[0]} / ${n.columns[1]}`, ...n.rows.map(r => `${r.label}: ${r.a} / ${r.b}${r.better ? ` (better: ${n.columns[r.better === "a" ? 0 : 1]})` : ""}`)];
    case "code": return [...(n.caption ? [n.caption] : []), ...n.lines];
    case "file": return [n.label ? `${n.label}: ${n.path}` : n.path, ...(n.lines ?? [])];
    default: return [];
  }
}

/** The ids of a view's nodes in reading order from its root (each once, even if a broken doc named one twice). */
export function walkView(doc: ViewDoc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const n = doc.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    out.push(id);
    if (isLayout(n)) for (const c of n.children) visit(c);
  };
  visit(doc.root);
  return out;
}

/** A view as plain text (the conversation, speech, the corner card without a compositor): lines, one per row. */
export function viewText(view: ViewDoc | readonly ViewBlockV1[]): string {
  const doc = Array.isArray(view) ? upgradeView(view as readonly ViewBlockV1[]) : view as ViewDoc;
  return walkView(doc).flatMap(id => nodeLines(doc.nodes[id])).join("\n");
}

/** How many blocks (non-layout nodes) and charts a view has, for the audit ("Showed a view (6 blocks, 1 chart)"). */
export function viewCounts(doc: ViewDoc): { blocks: number; charts: number } {
  let blocks = 0, charts = 0;
  for (const id of walkView(doc)) {
    const n = doc.nodes[id];
    if (isLayout(n) || n.kind === "divider") continue;
    blocks++;
    if (n.kind === "chart" || n.kind === "gauge" || (n.kind === "metric" && n.spark)) charts++;
  }
  return { blocks, charts };
}

/** A first-catalog view as a v2 document: a root stack of the same blocks, in order (Ember's ids _1, _2, … in reading order). */
export function upgradeView(v1: readonly ViewBlockV1[], rev = 1): ViewDoc {
  const nodes: Record<string, ViewNode> = {};
  const ids: string[] = [];
  v1.forEach((b, i) => {
    const id = `_${i + 2}`;
    ids.push(id);
    nodes[id] = upgradeBlock(b);
  });
  return { catalog: VIEW_CATALOG, rev, root: "_1", nodes: { _1: { kind: "stack", children: ids }, ...nodes } };
}

function upgradeBlock(b: ViewBlockV1): ViewNode {
  switch (b.kind) {
    case "text": return { kind: "text", text: b.text };
    case "list": return { kind: "list", items: [...b.items], ...(b.ordered ? { ordered: true } : {}) };
    case "facts": return { kind: "keyvalue", rows: b.rows.map(r => ({ label: r.label, value: r.value })) };
    case "table": return { kind: "table", columns: [...b.columns], rows: b.rows.map(r => [...r]) };
    case "file": return { kind: "file", path: b.path, ...(b.label ? { label: b.label } : {}) };
    case "checklist": return { kind: "steps", items: b.items.map(i => ({ text: i.text, state: i.done ? "done" : "todo" })) };
    case "progress": return { kind: "progress", label: b.label, value: b.value, max: b.total };
    case "compare": return { kind: "compare", columns: [b.columns[0], b.columns[1]], rows: b.rows.map(r => ({ label: r.label, a: r.a, b: r.b })) };
    case "excerpt": return { kind: "file", path: b.path, lines: [...b.lines] };
    case "status": return { kind: "callout", tone: b.tone === "ok" ? "positive" : b.tone === "warn" ? "caution" : "negative", text: b.text };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Updates: whole nodes replaced by id, in checked batches (AG-UI's snapshot, then deltas).

/**
 * A change to a task's view, as main sends it to a page: the nodes that changed (whole), the ids that went, and the
 * root. `base` is the rev it applies to (null: a whole snapshot, sent first and after any gap).
 */
export interface ViewPatch {
  taskId: string;
  rev: number;
  base: number | null;
  root: string;
  nodes: Record<string, ViewNode>;
  removed: string[];
}

/** What changed from `prev` (null: nothing yet) to `next`: a snapshot when there was nothing, else the changed nodes. */
export function diffViews(taskId: string, prev: ViewDoc | null, next: ViewDoc): ViewPatch {
  if (!prev) return { taskId, rev: next.rev, base: null, root: next.root, nodes: { ...next.nodes }, removed: [] };
  const nodes: Record<string, ViewNode> = {};
  for (const [id, n] of Object.entries(next.nodes)) if (!prev.nodes[id] || JSON.stringify(prev.nodes[id]) !== JSON.stringify(n)) nodes[id] = n;
  const removed = Object.keys(prev.nodes).filter(id => !(id in next.nodes));
  return { taskId, rev: next.rev, base: prev.rev, root: next.root, nodes, removed };
}

/** A page's copy of a view after `p`, or null when `p` doesn't follow the copy it has (a gap: wait for a snapshot). */
export function applyViewPatch(doc: ViewDoc | null | undefined, p: ViewPatch): ViewDoc | null {
  if (p.base === null) return { catalog: VIEW_CATALOG, rev: p.rev, root: p.root, nodes: { ...p.nodes } };
  if (!doc || doc.rev !== p.base) return null;
  const nodes = { ...doc.nodes, ...p.nodes };
  for (const id of p.removed) delete nodes[id];
  return { catalog: VIEW_CATALOG, rev: p.rev, root: p.root, nodes };
}
