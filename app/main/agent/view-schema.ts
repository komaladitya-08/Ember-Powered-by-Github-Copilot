/**
 * The zod schema of Ember's generative UI catalog (app/shared/view.ts), and every check a view passes before anything
 * reaches a card. Kept in main: the renderer only draws checked views.
 *
 * Catalog v2 (`ember.view/2`): the model writes a nested tree of nodes from `VIEW_KINDS`; `checkView()` checks each
 * node's props against its kind's strict schema, gives unnamed nodes ids, flattens the tree into a `ViewDoc` and then
 * checks the whole document (`checkDoc()`, which update_view runs again after every batch of changes):
 * - the window profile's limits (VIEW_PROFILES.window: depth, nodes, children, characters, charts, table size);
 * - that every reference resolves, each node has one parent and there are no cycles;
 * - that no string imitates Ember's own controls or voice (`mimicRefusal`: "Allow", "Not now", a shortcut chord,
 *   "Ember: …"), since a view must never look like Ember's question, consent or allow/deny UI;
 * - that no string holds a secret, and no file or code block comes from where secrets live (fail closed: one failure
 *   refuses the whole view, never shown redacted);
 * - that a quote names only an app the task really read (`ViewContext`), or its caption falls back to "From the screen".
 *
 * The model's instructions for views (`viewCatalogPrompt()`) are generated from the same schemas, so what the model is
 * told and what main accepts never drift (json-render's catalog.prompt() idea). The first catalog (a flat array of at
 * most 6 blocks, `ViewSchema`) is still accepted and upgraded at once.
 */

import { z } from "zod";
import {
  CODE_LANGS, LAYOUT_KINDS, VIEW_CATALOG, VIEW_LIMITS as L, VIEW_PROFILES, VIEW_SYMBOLS, VIEW_TONES, VIEW_V2 as V,
  upgradeView, walkView, type ViewBlock, type ViewDoc, type ViewNode,
} from "../../shared/view";
import { SHORTCUTS, FALLBACK_SHORTCUTS } from "../../shared/shortcuts";
import { memoryRefusal } from "../memory/guard";

const line = (max: number) => z.string().trim().min(1).max(max);

/**
 * Folders whose files a view never shows: Ember's data folder on each OS, SSH and GPG keys, keyrings and password
 * stores, and the system's password files. A path written either way round (/ or \) matches.
 */
const PRIVATE_PATH = new RegExp([
  String.raw`(^|[\\/])\.config[\\/]ember([\\/]|$)`,
  String.raw`AppData[\\/]Local[\\/]ember([\\/]|$)`,
  String.raw`%LOCALAPPDATA%[\\/]ember([\\/]|$)`,
  String.raw`Application Support[\\/]ember([\\/]|$)`,
  String.raw`(^|[\\/])\.(ssh|gnupg|password-store|aws|kube|docker)([\\/]|$)`,
  String.raw`(^|[\\/])keyrings?([\\/]|$)`,
  String.raw`(^|[\\/])Keychains([\\/]|$)`,
  String.raw`^/etc/(shadow|gshadow|sudoers)`,
  String.raw`(^|[\\/])\.(netrc|pgpass|git-credentials|npmrc|pypirc)$`,
  String.raw`(^|[\\/])\.env(\.[\w-]+)?$`,
  String.raw`\.(pem|key|p12|pfx|kdbx)$`,
  String.raw`\.key\.(bak|old|orig|save)$`,
  String.raw`(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.|$)`,
  String.raw`[\\/]private[\\/]`,
].join("|"), "i");

/** Why an excerpt may not be shown, or null when it may (a secret in a line, or a private place). */
export function excerptRefusal(path: string, lines: readonly string[]): string | null {
  if (PRIVATE_PATH.test(path.trim())) return "that file is in a place where passwords and keys are kept, so Ember doesn't show it";
  for (const l of lines) {
    const why = memoryRefusal(l);
    if (why) return `${why}, so Ember doesn't show it`;
  }
  return memoryRefusal(lines.join("\n")) ? "it holds a password, token or key, so Ember doesn't show it" : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The first catalog (finish_task's `view` before ember.view/2): still accepted, and upgraded at once.

const whole = z.number().int().min(0).max(L.total);

export const ViewBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: line(L.text) }),
  z.object({ kind: z.literal("list"), items: z.array(line(L.item)).min(1).max(L.items), ordered: z.boolean().optional() }),
  z.object({ kind: z.literal("facts"), rows: z.array(z.object({ label: line(L.label), value: line(L.value) })).min(1).max(L.items) }),
  z.object({
    kind: z.literal("table"),
    columns: z.array(line(L.cell)).min(1).max(L.columns),
    rows: z.array(z.array(z.string().trim().max(L.cell)).min(1).max(L.columns)).min(1).max(L.rows),
  }).refine(t => t.rows.every(r => r.length === t.columns.length), "every row needs one cell per column"),
  z.object({ kind: z.literal("file"), path: line(L.path), label: line(L.label).optional() }),
  z.object({ kind: z.literal("checklist"), items: z.array(z.object({ text: line(L.item), done: z.boolean() })).min(1).max(L.items) }),
  z.object({ kind: z.literal("progress"), label: line(L.label), value: whole, total: whole.min(1) })
    .refine(p => p.value <= p.total, "value can't be more than total"),
  z.object({
    kind: z.literal("compare"),
    columns: z.tuple([line(L.cell), line(L.cell)]),
    rows: z.array(z.object({ label: line(L.label), a: z.string().trim().max(L.cell), b: z.string().trim().max(L.cell) })).min(1).max(L.rows),
  }),
  z.object({ kind: z.literal("excerpt"), path: line(L.path), lines: z.array(z.string().max(L.line)).min(1).max(L.lines) })
    .superRefine((x, ctx) => {
      const why = excerptRefusal(x.path, x.lines);
      if (why) ctx.addIssue({ code: "custom", message: `the excerpt can't be shown: ${why}. Leave it out` });
    }),
  z.object({ kind: z.literal("status"), tone: z.enum(["ok", "warn", "fail"]), text: line(L.item) }),
]);

/** A whole first-catalog view: 1 to VIEW_LIMITS.blocks blocks. */
export const ViewSchema = z.array(ViewBlockSchema).min(1).max(L.blocks);

/** A plan as report_progress takes it: its steps, in order. */
export const PlanSchema = z.array(line(L.step)).min(1).max(L.plan);

// The schema and the catalog's type stay one: a block the schema accepts is a ViewBlock.
export type CheckedView = z.infer<typeof ViewSchema>;
const _same = (v: CheckedView): ViewBlock[] => v;
void _same;

// ---------------------------------------------------------------------------------------------------------------------
// Catalog v2: one strict schema of props per kind, with what the model is told about it.

const W = VIEW_PROFILES.window;
const tone = z.enum(VIEW_TONES);
const num = z.number().min(-V.number).max(V.number);
const cell = z.string().trim().max(V.cell);
const weight = z.number().int().min(1).max(4).optional().describe("share of a row's width");

/** A kind of block: its group, what the model is told it is for, and its props (children are given separately). */
interface KindDef { group: "layout" | "content" | "data"; about: string; props: z.ZodType }

const obj = <S extends z.ZodRawShape>(shape: S) => z.object({ ...shape, weight }).strict();

/** The catalog, in the order the model is told about it. A kind not here is refused; nothing here takes a click. */
export const VIEW_KINDS: Readonly<Record<string, KindDef>> = {
  stack: { group: "layout", about: "children one under another", props: obj({ gap: z.enum(["tight", "normal", "loose"]).optional() }) },
  row: { group: "layout", about: "children side by side (stacks on a narrow card)", props: obj({ align: z.enum(["start", "center", "end"]).optional(), justify: z.enum(["start", "between", "end"]).optional() }) },
  grid: { group: "layout", about: "children in 2 or 3 columns (a row of metric tiles)", props: obj({ columns: z.union([z.literal(2), z.literal(3)]) }) },
  card: { group: "layout", about: "a flat inset group of children", props: obj({ tone: tone.optional() }) },
  section: { group: "layout", about: "a titled group of children", props: obj({ title: line(V.heading), collapsed: z.boolean().optional() }) },
  divider: { group: "layout", about: "a thin rule", props: obj({}) },
  heading: { group: "content", about: "a short heading", props: obj({ text: line(V.heading), level: z.union([z.literal(1), z.literal(2)]) }) },
  text: { group: "content", about: "a paragraph", props: obj({ text: line(V.text), tone: z.enum(["secondary"]).optional() }) },
  rich: {
    group: "content", about: "a paragraph with some words bold or as code (no links)",
    props: obj({ runs: z.array(z.object({ text: z.string().min(1).max(V.run), style: z.enum(["strong", "code"]).optional() }).strict()).min(1).max(V.runs) }),
  },
  keyvalue: { group: "content", about: "label and value rows", props: obj({ rows: z.array(z.object({ label: line(V.label), value: line(V.value), tone: tone.optional() }).strict()).min(1).max(V.rows) }) },
  badge: { group: "content", about: "a small tag", props: obj({ text: line(V.badge), tone, symbol: z.enum(VIEW_SYMBOLS).optional() }) },
  callout: { group: "content", about: "a note set apart, by tone (a tip, something worth a look, a problem)", props: obj({ tone, title: line(V.heading).optional(), text: line(V.text), symbol: z.enum(VIEW_SYMBOLS).optional() }) },
  quote: {
    group: "content", about: "words copied as they are from a page, a file, an app or a command; Ember captions where from",
    props: obj({
      text: line(V.quote),
      source: z.object({ kind: z.enum(["screen", "app", "file", "web", "command"]), app: line(V.label).optional(), path: line(V.path).optional() }).strict(),
    }),
  },
  list: { group: "data", about: "a list", props: obj({ items: z.array(line(V.item)).min(1).max(W.items), ordered: z.boolean().optional() }) },
  table: {
    group: "data", about: "a small table; numeric lists the columns (from 0) to right-align",
    props: obj({
      columns: z.array(line(V.cell)).min(1).max(W.tableColumns),
      rows: z.array(z.array(cell).min(1).max(W.tableColumns)).min(1).max(W.tableRows),
      numeric: z.array(z.number().int().min(0).max(W.tableColumns - 1)).max(V.numeric).optional(),
      caption: line(V.caption).optional(),
    }).superRefine((t, ctx) => {
      if (!t.rows.every(r => r.length === t.columns.length)) ctx.addIssue({ code: "custom", message: "every row needs one cell per column" });
      if (t.numeric?.some(i => i >= t.columns.length)) ctx.addIssue({ code: "custom", message: "numeric names a column the table hasn't got" });
    }),
  },
  steps: { group: "data", about: "a checklist or plan of the task's own", props: obj({ items: z.array(z.object({ text: line(V.item), state: z.enum(["done", "now", "todo", "skipped", "failed"]) }).strict()).min(1).max(V.steps) }) },
  timeline: { group: "data", about: "events in order; when is your own short text", props: obj({ items: z.array(z.object({ when: line(V.when), text: line(V.item), tone: tone.optional() }).strict()).min(1).max(V.timeline) }) },
  progress: {
    group: "data", about: "how far something got (whole numbers)",
    props: obj({ label: line(V.label), value: z.number().int().min(0).max(V.progressMax), max: z.number().int().min(1).max(V.progressMax), tone: tone.optional() })
      .refine(p => p.value <= p.max, "value can't be more than max"),
  },
  gauge: {
    group: "data", about: "one value on a scale; bands colour parts of the scale",
    props: obj({
      label: line(V.label), value: num, min: num, max: num, unit: line(V.unit).optional(),
      bands: z.array(z.object({ upTo: num, tone }).strict()).min(1).max(V.bands).optional(),
    }).superRefine((g, ctx) => {
      if (!(g.min < g.max)) ctx.addIssue({ code: "custom", message: "min must be less than max" });
      else if (g.value < g.min || g.value > g.max) ctx.addIssue({ code: "custom", message: "value must be between min and max" });
      if (g.bands?.some((b, i) => b.upTo <= g.min || b.upTo > g.max || (i > 0 && b.upTo <= g.bands![i - 1].upTo))) ctx.addIssue({ code: "custom", message: "bands' upTo must rise, inside min to max" });
    }),
  },
  metric: {
    group: "data", about: "a key figure as a tile; several in a grid make a row of figures",
    props: obj({
      label: line(V.label), value: line(V.metricValue),
      delta: z.object({ text: line(V.delta), direction: z.enum(["up", "down", "flat"]), good: z.boolean().optional() }).strict().optional(),
      spark: z.array(num).min(2).max(V.spark).optional(),
    }),
  },
  chart: {
    group: "data", about: "a static chart; one value per category in each series (null: none); spark is a small trend line of one series",
    props: obj({
      type: z.enum(["bar", "hbar", "line", "area", "spark"]),
      title: line(V.heading).optional(),
      categories: z.array(line(V.label)).max(V.lineCategories),
      series: z.array(z.object({ name: line(V.label), values: z.array(num.nullable()).min(1).max(V.lineCategories), tone: tone.optional() }).strict()).min(1).max(V.series),
      unit: line(V.unit).optional(),
      yMin: num.optional(),
    }).superRefine((c, ctx) => {
      if (c.type === "spark") {
        if (c.series.length !== 1) ctx.addIssue({ code: "custom", message: "a spark has one series" });
        if (c.series[0] && c.series[0].values.length > V.spark) ctx.addIssue({ code: "custom", message: `a spark has at most ${V.spark} values` });
        return;
      }
      const most = c.type === "line" || c.type === "area" ? V.lineCategories : V.categories;
      if (c.categories.length < 1 || c.categories.length > most) ctx.addIssue({ code: "custom", message: `a ${c.type} chart needs 1 to ${most} categories` });
      if (c.series.some(s => s.values.length !== c.categories.length)) ctx.addIssue({ code: "custom", message: "each series needs one value per category" });
      if (c.series.every(s => s.values.every(v => v === null))) ctx.addIssue({ code: "custom", message: "the chart has no values" });
    }),
  },
  compare: {
    group: "data", about: "two things side by side; better marks the better one",
    props: obj({
      columns: z.tuple([line(V.cell), line(V.cell)]),
      rows: z.array(z.object({ label: line(V.label), a: cell, b: cell, better: z.enum(["a", "b"]).optional() }).strict()).min(1).max(V.compareRows),
    }),
  },
  code: { group: "data", about: "lines of code or output, as text (nothing is run)", props: obj({ lines: z.array(z.string().max(V.codeLine)).min(1).max(W.codeLines), lang: z.enum(CODE_LANGS).optional(), caption: line(V.caption).optional() }) },
  file: { group: "data", about: "a file the task saved or read (nothing opens it), with a few of its lines", props: obj({ path: line(V.path), label: line(V.label).optional(), lines: z.array(z.string().max(V.codeLine)).min(1).max(V.fileLines).optional() }) },
};

/** Props that ask for something a view never has: they get a plain reason rather than "unrecognized key". */
const FORBIDDEN_PROPS = /^(href|url|src|link|links|image|images|icon|on[a-z]+|action|actions|button|buttons|color|colour|background|style|class|classname|html|markdown|font|size)$/i;

// ---------------------------------------------------------------------------------------------------------------------
// What the model is told: generated from the schemas above.

type Js = { type?: string | string[]; const?: unknown; enum?: unknown[]; anyOf?: Js[]; properties?: Record<string, Js>; required?: string[];
  items?: Js | false; prefixItems?: Js[]; maxItems?: number; maxLength?: number; minimum?: number; maximum?: number };

function sig(s: Js): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  // The palette and the symbols are listed once, after the kinds.
  if (s.enum && s.enum.join() === VIEW_TONES.join()) return "tone";
  if (s.enum && s.enum.join() === VIEW_SYMBOLS.join()) return "symbol";
  if (s.enum) return s.enum.map(e => JSON.stringify(e)).join("|");
  if (s.anyOf) return s.anyOf.map(sig).join("|");
  if (s.prefixItems) return `[${s.prefixItems.map(sig).join(", ")}]`;
  const t = Array.isArray(s.type) ? s.type.filter(x => x !== "null")[0] : s.type;
  const nullable = Array.isArray(s.type) && s.type.includes("null") ? "|null" : "";
  if (t === "string") return `text${s.maxLength ? `≤${s.maxLength}` : ""}`;
  if (t === "integer") return `whole number${s.minimum !== undefined && s.maximum !== undefined && s.maximum <= 10 ? ` ${s.minimum}–${s.maximum}` : ""}`;
  if (t === "number") return `number${nullable}`;
  if (t === "null") return "null";
  if (t === "boolean") return "true|false";
  if (t === "array") return `[${s.items ? sig(s.items) : ""}]${s.maxItems ? `≤${s.maxItems}` : ""}`;
  if (t === "object") return `{${Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${s.required?.includes(k) ? "" : "?"}: ${sig(v)}`).join(", ")}}`;
  return "value";
}

/** One kind's line of the model's instructions: its name, props and what it is for. */
function kindLine(kind: string, d: KindDef): string {
  const js = z.toJSONSchema(d.props, { unrepresentable: "any" }) as Js;
  const props = Object.entries(js.properties ?? {}).filter(([k]) => k !== "weight")
    .map(([k, v]) => `${k}${js.required?.includes(k) ? "" : "?"}: ${sig(v)}`);
  const children = LAYOUT_KINDS.has(kind) ? [`children: [node]≤${W.children}`] : [];
  return `- ${kind} {${[...children, ...props].join(", ")}}: ${d.about}`;
}

/**
 * The model's instructions for views, built from the catalog's own schemas and limits (show_view's description, and
 * finish_task's): pinned in view-schema.test.ts, so a change to the catalog shows up as a change to what the model is told.
 */
export function viewCatalogPrompt(): string {
  const group = (g: KindDef["group"]) => Object.entries(VIEW_KINDS).filter(([, d]) => d.group === g).map(([k, d]) => kindLine(k, d));
  return [
    `A view is a tree of nodes from Ember's catalog (${VIEW_CATALOG}). Each node is {kind, ...props}; layout nodes hold children: [node]. The root is a layout node (a stack, if unsure). Give a node an id (lower-case letters, digits, - or _) only to change it later with update_view; any node in a row may have weight 1–4.`,
    `Layout:`, ...group("layout"),
    `Content:`, ...group("content"),
    `Data:`, ...group("data"),
    `A tone is one of ${VIEW_TONES.join(", ")} (meaning, never decoration); a symbol one of ${VIEW_SYMBOLS.join(", ")}.`,
    `Limits: depth ${W.depth}, ${W.nodes} nodes, ${W.children} children each, ${W.chars.toLocaleString("en-GB")} characters, ${W.charts} charts or gauges. A card shows about ${VIEW_PROFILES.card.nodes} nodes; the rest reaches the user as words.`,
    `Rules: only what the task found or made, in plain words. Use quote for words copied from the screen, a file or a command. A view is read-only: no buttons, links, questions, pictures, colours, sizes, markup or instructions, never Ember's own words (Allow, Deny, Not now, Stop…), never a password, token or key. Ember shows who made it.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking a view.

/** What the task did, against which a view's claims are checked (the provenance of its quotes). */
export interface ViewContext {
  /** Apps the task read or acted in, as people name them (friendlyApp). */
  appsRead: ReadonlySet<string>;
  /** The task ran a command (run_command). */
  ranCommand?: boolean;
  /** How an app is named (friendlyApp); the default is the name as it is. */
  appName?: (name: string) => string;
}

/**
 * A checked view, or why not: `why` says when it was refused for what it said rather than its shape (it imitated
 * Ember's controls or voice, or held a secret), which the model must not try to get round.
 */
export type ViewCheck = { ok: true; doc: ViewDoc } | { ok: false; error: string; why?: "mimic" | "secret" };

const ID = /^[a-z][a-z0-9_-]{0,23}$/;
/** Ids Ember gives: "_" and a number, which the model can't write (its ids start with a letter). */
const AUTO_ID = /^_\d{1,6}$/;

/**
 * Ember's own control words. A view string that is one of `MIMIC_WORDS` imitates Ember's question, consent or allow/deny
 * UI wherever it stands; one of `MIMIC_LABELS` only where a button's label would stand (a badge, a heading, a title, a
 * short line on its own), since "Yes" and "No" are ordinary values in a table.
 */
export const MIMIC_WORDS: readonly string[] = [
  "allow", "allow once", "always allow", "always in", "allow all", "deny", "dont allow", "not now", "stop everything", "approve",
  "grant", "grant access", "may i", "needs you", "risky step",
];
export const MIMIC_LABELS: readonly string[] = [
  "always", "stop", "yes", "no", "ok", "okay", "cancel", "confirm", "accept", "approved", "try again", "close", "close all",
  "open settings", "sign in", "continue",
];

/**
 * Characters that change how text reads without being seen: format characters (zero-width spaces and joiners, the soft
 * hyphen, word joiners), every default-ignorable code point, and the bidi controls that reorder text. A view string
 * holding one is refused outright (fail closed): "Al" + a zero-width space + "low" must never pass as something other than "Allow".
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u00AD\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Letters from other scripts that look like Latin ones (Cyrillic, Greek, small capitals), folded to the Latin letter
 * before Ember's words are matched, so "Аllow" with a Cyrillic А reads as "allow". NFKC already folds fullwidth and
 * compatibility forms.
 */
const CONFUSABLE: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ["а", "a"], ["в", "b"], ["е", "e"], ["ё", "e"], ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"], ["с", "c"], ["т", "t"],
  ["у", "y"], ["х", "x"], ["ѕ", "s"], ["і", "i"], ["ї", "i"], ["ј", "j"], ["һ", "h"], ["ԁ", "d"], ["ԛ", "q"], ["ԝ", "w"], ["ӏ", "l"],
  ["ɡ", "g"], ["ո", "n"], ["ս", "u"], ["ⅼ", "l"],
  ["А", "a"], ["В", "b"], ["Е", "e"], ["К", "k"], ["М", "m"], ["Н", "h"], ["О", "o"], ["Р", "p"], ["С", "c"], ["Т", "t"], ["Х", "x"],
  ["У", "y"], ["І", "i"], ["Ј", "j"], ["Ѕ", "s"], ["Ԁ", "d"], ["Ԛ", "q"], ["Ԝ", "w"], ["Ӏ", "l"],
  // Greek
  ["α", "a"], ["β", "b"], ["ε", "e"], ["ι", "i"], ["κ", "k"], ["ν", "v"], ["ο", "o"], ["ρ", "p"], ["τ", "t"], ["υ", "u"], ["χ", "x"],
  ["ω", "w"], ["Α", "a"], ["Β", "b"], ["Ε", "e"], ["Ζ", "z"], ["Η", "h"], ["Ι", "i"], ["Κ", "k"], ["Μ", "m"], ["Ν", "n"], ["Ο", "o"],
  ["Ρ", "p"], ["Τ", "t"], ["Υ", "y"], ["Χ", "x"],
  // Latin look-alikes NFKC keeps
  ["ı", "i"], ["ȷ", "j"], ["ᴀ", "a"], ["ʙ", "b"], ["ᴄ", "c"], ["ᴅ", "d"], ["ᴇ", "e"], ["ɢ", "g"], ["ʜ", "h"], ["ɪ", "i"], ["ᴊ", "j"],
  ["ᴋ", "k"], ["ʟ", "l"], ["ᴍ", "m"], ["ɴ", "n"], ["ᴏ", "o"], ["ᴘ", "p"], ["ʀ", "r"], ["ꜱ", "s"], ["ᴛ", "t"], ["ᴜ", "u"], ["ᴠ", "v"],
  ["ᴡ", "w"], ["ʏ", "y"], ["ᴢ", "z"],
]);
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");

/** A view string as Ember matches it: NFKC, look-alike letters folded to Latin, curly quotes straight, lower case. */
export function viewNorm(s: string): string {
  return s.normalize("NFKC").replace(CONFUSABLE_RE, c => CONFUSABLE[c] ?? c).replace(/[’‘]/g, "'").toLowerCase();
}
const fold = (s: string) => viewNorm(s).replace(/'/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const MIMIC = new Set(MIMIC_WORDS);
const LABELS = new Set(MIMIC_LABELS);
/** A short line that starts as one of Ember's questions' answers do ("Allow Ember to…", "Approve this"). */
const MIMIC_START = /^(allow|deny|approve|grant|confirm|always allow|not now)\b/;

/** Every name of a modifier key, on every OS, by the modifier it is. */
const MODIFIER: Readonly<Record<string, string>> = {
  ctrl: "ctrl", control: "ctrl", ctl: "ctrl", strg: "ctrl", "⌃": "ctrl", "^": "ctrl",
  alt: "alt", option: "alt", opt: "alt", altgr: "alt", "⌥": "alt",
  win: "super", windows: "super", super: "super", meta: "super", cmd: "cmd", command: "cmd", "⌘": "cmd",
  shift: "shift", "⇧": "shift",
};
/** The keys of Ember's allow, deny and stop shortcuts (and their fallbacks) on every OS. */
const CHORD_KEYS = new Set(["y", "n", "x", "return", "enter", "⏎", "↩", "esc", "escape", "period", ".", "comma", ","]);
const _chordsCovered = (["linux", "win32", "darwin"] as const).every(os => (["allow", "deny", "stop"] as const)
  .every(id => [SHORTCUTS[os][id], FALLBACK_SHORTCUTS[os][id]].every(sc => CHORD_KEYS.has(sc.keys[sc.keys.length - 1].toLowerCase()))));
if (!_chordsCovered) throw new Error("view-schema: CHORD_KEYS misses one of Ember's shortcut keys");

/**
 * Whether `s` names a key chord like Ember's allow, deny or stop shortcuts, however it is written: two or more
 * modifiers (any OS's name or symbol for them) then one of those keys, with any separators ("Ctrl-Alt-Y", "⌃⇧⌘Y",
 * "Control + Option + Cmd + Y", "Ctrl＋Alt＋Y").
 */
export function namesChord(s: string): boolean {
  const spaced = viewNorm(s).replace(/[⌃⌥⌘⇧^⏎↩]/g, m => ` ${m} `);
  const tokens = spaced.split(/[\s+\-_=~–—/|·•]+/)
    .map(t => t.replace(/^["'([{<]+|["')\]}>:;!?]+$/g, ""))
    .map(t => (t.length > 1 ? t.replace(/[.,]+$/, "") : t))
    .filter(Boolean);
  let mods = new Set<string>();
  for (const t of tokens) {
    const m = MODIFIER[t];
    if (m) { mods.add(m); continue; }
    if (mods.size >= 2 && CHORD_KEYS.has(t)) return true;
    mods = new Set();
  }
  return false;
}

/** Words that speak as Ember ("Ember: …", "I'm Ember", "Ember says …"): a view is the task's, never Ember's voice. */
const AS_EMBER = [/^\s*ember\s*[:\-–—]/, /\bember\s*:/, /\b(i'?m|i am|this is|it's|it is) ember\b/, /\bember (says|asks|needs|wants|would like|is asking)\b/];

/**
 * Why `s` would make a view look like Ember's own question, consent or allow/deny UI, or null. `short` is a
 * button-like position (a badge, a heading, a title, a label), where a line starting as an answer does is refused too.
 * A string holding invisible or direction-changing characters is refused whatever it says.
 */
export function mimicRefusal(s: string, short = false): string | null {
  if (INVISIBLE.test(s)) return "it holds invisible or direction-changing characters";
  const f = fold(s);
  if (MIMIC.has(f) || (short && LABELS.has(f))) return `"${s.trim().slice(0, 30)}" is one of Ember's own buttons`;
  if (short && f.length <= 40 && MIMIC_START.test(f)) return `"${s.trim().slice(0, 30)}" reads like Ember's own question`;
  if (namesChord(s)) return "it names one of Ember's own shortcuts";
  const n = viewNorm(s);
  if (AS_EMBER.some(re => re.test(n))) return "it speaks as Ember";
  return null;
}


/**
 * Why `s` would show a secret or a place where secrets live, or null: a token, key, card number or "password: …"
 * (memoryRefusal), a private key's header, or a path (anywhere in it, slashes however written) into a private place.
 */
export function secretRefusal(s: string): string | null {
  const why = memoryRefusal(s);
  if (why) return why;
  const n = s.normalize("NFKC").replace(/[∕⁄⧸／]/g, "/");
  if (PRIVATE_PATH.test(n.trim()) || n.split(/[\s"'`()<>[\]{},;]+/).some(t => t && PRIVATE_PATH.test(t))) return "it names a place where passwords and keys are kept";
  return null;
}

/** Every string a node holds, with whether it sits where a button's label would. */
function nodeStrings(n: ViewNode): { s: string; short: boolean }[] {
  const out: { s: string; short: boolean }[] = [];
  const add = (s: string | undefined, short = false) => { if (s !== undefined) out.push({ s, short }); };
  switch (n.kind) {
    case "section": add(n.title, true); break;
    case "heading": add(n.text, true); break;
    case "text": add(n.text, n.text.length <= 40); break;
    case "rich": { const all = n.runs.map(r => r.text).join(""); for (const r of n.runs) add(r.text); add(all, all.length <= 40); break; }
    case "keyvalue": for (const r of n.rows) { add(r.label); add(r.value); } break;
    case "badge": add(n.text, true); break;
    case "callout": add(n.title, true); add(n.text, n.text.length <= 40); break;
    case "quote": add(n.text); add(n.source.app); add(n.source.path); break;
    case "list": for (const i of n.items) add(i); break;
    case "table": for (const c of n.columns) add(c); for (const r of n.rows) for (const c of r) add(c); add(n.caption); break;
    case "steps": for (const i of n.items) add(i.text, true); break;
    case "timeline": for (const i of n.items) { add(i.when); add(i.text); } break;
    case "progress": add(n.label); break;
    case "gauge": add(n.label); add(n.unit); break;
    case "metric": add(n.label); add(n.value, true); add(n.delta?.text); break;
    case "chart": add(n.title, true); for (const c of n.categories) add(c); for (const s of n.series) add(s.name); add(n.unit); break;
    case "compare": for (const c of n.columns) add(c, true); for (const r of n.rows) { add(r.label); add(r.a); add(r.b); } break;
    case "code": for (const l of n.lines) add(l); add(n.caption); break;
    case "file": add(n.path); add(n.label); for (const l of n.lines ?? []) add(l); break;
    default: break;
  }
  return out;
}

/**
 * A node's strings as they read together: a label with its value, a column's name with each cell, a row's cells, a
 * list's items, the whole node. A secret or a shortcut split across fields ("Password" | "hunter2", "Ctrl+Alt" | "+Y")
 * is caught in these.
 */
function nodeTogether(n: ViewNode): string[] {
  const out: string[] = [];
  switch (n.kind) {
    case "keyvalue": for (const r of n.rows) out.push(`${r.label}: ${r.value}`); break;
    case "table":
      for (const r of n.rows) { out.push(r.join(" ")); r.forEach((c, i) => out.push(`${n.columns[i] ?? ""}: ${c}`)); }
      break;
    case "compare": for (const r of n.rows) out.push(`${r.label}: ${r.a}`, `${r.label}: ${r.b}`, `${n.columns[0]}: ${r.a}`, `${n.columns[1]}: ${r.b}`); break;
    case "timeline": for (const i of n.items) out.push(`${i.when}: ${i.text}`); break;
    case "metric": out.push(`${n.label}: ${n.value}`); break;
    case "list": out.push(n.items.join(" ")); break;
    case "steps": out.push(n.items.map(i => i.text).join(" ")); break;
    case "callout": if (n.title) out.push(`${n.title}: ${n.text}`); break;
    case "chart": for (const s of n.series) out.push(`${s.name}: ${s.values.join(" ")}`); break;
    default: break;
  }
  out.push(nodeStrings(n).map(x => x.s).join("\n"));
  return out;
}

const issueText = (e: z.ZodError, at: string) => e.issues.map(i => `${[at, ...i.path].filter(p => p !== "").join(".")}: ${i.message}`).join("; ");

/** One node's own props (no id, no children), checked against its kind: the checked node, or why not. */
export function checkNodeProps(kind: string, props: Record<string, unknown>, at: string, children?: string[]): { node: ViewNode } | { error: string } {
  const def = VIEW_KINDS[kind];
  if (!def) return { error: `${at}: "${String(kind).slice(0, 24)}" isn't a kind of block Ember draws (the catalog: ${Object.keys(VIEW_KINDS).join(", ")})` };
  const bad = Object.keys(props).find(k => FORBIDDEN_PROPS.test(k));
  if (bad) return { error: `${at}.${bad}: views have no links, pictures, colours, styles or controls; leave it out` };
  const r = def.props.safeParse(props);
  if (!r.success) return { error: issueText(r.error, at) };
  const node = { kind, ...(r.data as object), ...(LAYOUT_KINDS.has(kind) ? { children: children ?? [] } : {}) } as ViewNode;
  return { node };
}

/** Ids for nodes the model left unnamed: "_1", "_2", … past any already in `taken`. */
export class IdMaker {
  private n = 0;
  constructor(private readonly taken: Set<string>) {
    for (const id of taken) if (AUTO_ID.test(id)) this.n = Math.max(this.n, Number(id.slice(1)));
  }
  next(): string {
    let id: string;
    do id = `_${++this.n}`; while (this.taken.has(id));
    this.taken.add(id);
    return id;
  }
}

/**
 * A nested tree as the model writes it, flattened into `nodes` (ids given where missing, each id once). Returns the
 * subtree's root id, or an error naming where.
 */
export function flattenTree(input: unknown, nodes: Record<string, ViewNode>, ids: IdMaker, taken: Set<string>, at = "view", depth = 1, fixedId?: string): { id: string } | { error: string } {
  if (depth > W.depth + 1) return { error: `${at}: the view nests more than ${W.depth} deep` };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: `${at}: a node is an object with a kind` };
  const { kind, id, children, ...props } = input as Record<string, unknown>;
  if (typeof kind !== "string") return { error: `${at}.kind: every node needs a kind` };
  let nodeId: string;
  if (fixedId !== undefined) {
    // A replacement keeps the id of the node it replaces (one of Ember's own, perhaps).
    if (id !== undefined && id !== fixedId) return { error: `${at}.id: a replacement keeps the id "${fixedId}"` };
    taken.add(fixedId);
    nodeId = fixedId;
  } else if (id !== undefined) {
    if (typeof id !== "string" || !ID.test(id)) return { error: `${at}.id: an id is lower-case letters, digits, - or _, starting with a letter (at most 24)` };
    if (taken.has(id)) return { error: `${at}.id: "${id}" is already used in this view` };
    taken.add(id);
    nodeId = id;
  } else nodeId = ids.next();
  const layout = LAYOUT_KINDS.has(kind);
  if (!layout && children !== undefined) return { error: `${at}.children: a ${kind.slice(0, 24)} holds no children (only stack, row, grid, card and section do)` };
  const kids: string[] = [];
  if (layout) {
    if (!Array.isArray(children) || children.length < 1) return { error: `${at}.children: a ${kind} needs at least one child` };
    if (children.length > W.children) return { error: `${at}.children: at most ${W.children} children in one ${kind}` };
    for (let i = 0; i < children.length; i++) {
      const r = flattenTree(children[i], nodes, ids, taken, `${at}.children[${i}]`, depth + 1);
      if ("error" in r) return r;
      kids.push(r.id);
      // Stops at once past the cap, rather than checking every node of an oversized tree.
      if (taken.size > W.nodes + 1) return { error: `${at}: the view has more than ${W.nodes} nodes` };
    }
  }
  const r = checkNodeProps(kind, props, at, kids);
  if ("error" in r) return r;
  nodes[nodeId] = r.node;
  return { id: nodeId };
}

/**
 * A quote's source as Ember will caption it: an app only if the task read it (as people name it), a command only if
 * the task ran one; anything else falls back to the screen. Never refused: the caption just says less.
 */
function checkedSource(src: Extract<ViewNode, { kind: "quote" }>["source"], ctx: ViewContext): Extract<ViewNode, { kind: "quote" }>["source"] {
  const name = ctx.appName ?? ((s: string) => s);
  if (src.kind === "app" || (src.kind === "screen" && src.app)) {
    const app = src.app ? fold(name(src.app)) : undefined;
    // Captioned with the app's name as the task read it, never the model's spelling of it.
    const read = app ? [...ctx.appsRead].find(a => fold(a) === app) : undefined;
    return read ? { kind: "app", app: read } : { kind: "screen" };
  }
  if (src.kind === "command" && !ctx.ranCommand) return { kind: "screen" };
  // A file or a web page only if the task read something (an app, a page) or ran a command that could show one.
  if ((src.kind === "file" || src.kind === "web") && !ctx.ranCommand && ctx.appsRead.size === 0) return { kind: "screen" };
  return src.path ? { kind: src.kind, path: src.path } : { kind: src.kind };
}

/**
 * The whole document's checks (after show_view, and again after every update_view batch): references, one parent,
 * no cycles, the window profile's limits, mimicry, secrets and private places, and quotes' provenance. Returns the
 * document with quotes' sources as Ember will caption them, or why the whole view is refused.
 */
export function checkDoc(doc: ViewDoc, ctx: ViewContext): ViewCheck {
  const { nodes, root } = doc;
  const r = nodes[root];
  if (!r) return { ok: false, error: "the view has no root" };
  if (!LAYOUT_KINDS.has(r.kind)) return { ok: false, error: "the view's root must be a layout node (a stack)" };
  const parent = new Map<string, string>();
  for (const [id, n] of Object.entries(nodes)) {
    if (!ID.test(id) && !AUTO_ID.test(id)) return { ok: false, error: `"${id.slice(0, 24)}" isn't an id Ember accepts` };
    if (!VIEW_KINDS[n.kind]) return { ok: false, error: `"${String(n.kind).slice(0, 24)}" isn't a kind of block Ember draws` };
    if ("children" in n) {
      if (n.children.length > W.children) return { ok: false, error: `${id}: at most ${W.children} children in one ${n.kind}` };
      if (n.children.length < 1) return { ok: false, error: `${id}: a ${n.kind} needs at least one child` };
      for (const c of n.children) {
        if (!nodes[c]) return { ok: false, error: `${id} names a child "${c.slice(0, 24)}" that isn't in the view` };
        if (c === root || parent.has(c)) return { ok: false, error: `"${c.slice(0, 24)}" is in the view twice` };
        parent.set(c, id);
      }
    }
  }
  // Depth from the root (a cycle can't be reached from it, since the root has no parent and each node has one).
  const depth = new Map<string, number>([[root, 1]]);
  const order = walkView(doc);
  for (const id of order) {
    const n = nodes[id];
    const d = depth.get(id)!;
    if (d > W.depth) return { ok: false, error: `the view nests more than ${W.depth} deep` };
    if ("children" in n) for (const c of n.children) depth.set(c, d + 1);
  }
  const unreached = Object.keys(nodes).filter(id => !depth.has(id));
  if (unreached.length) return { ok: false, error: `"${unreached[0].slice(0, 24)}" isn't reached from the view's root` };
  if (order.length > W.nodes) return { ok: false, error: `the view has ${order.length} nodes; at most ${W.nodes}` };
  let chars = 0, charts = 0;
  const out: Record<string, ViewNode> = {};
  /** Every string in reading order: a shortcut spread over several nodes is caught in the whole view. */
  const all: string[] = [];
  for (const id of order) {
    let n = nodes[id];
    // Each node again against its kind (update_view's set merges props): the schema is the one source.
    const { kind, ...rest } = n as ViewNode & Record<string, unknown>;
    const children = "children" in n ? n.children : undefined;
    delete (rest as Record<string, unknown>).children;
    const again = checkNodeProps(kind, rest, id, children);
    if ("error" in again) return { ok: false, error: again.error };
    n = again.node;
    if (n.kind === "chart" || n.kind === "gauge") charts++;
    const strings = nodeStrings(n);
    for (const { s, short } of strings) {
      chars += s.length;
      const mimic = mimicRefusal(s, short);
      if (mimic) return { ok: false, why: "mimic", error: `${id}: ${mimic}, so Ember doesn't show it. A view never asks, allows or speaks for Ember` };
      const secret = secretRefusal(s);
      if (secret) return { ok: false, why: "secret", error: `${id}: ${secret}, so Ember doesn't show the view. Leave it out` };
    }
    for (const t of nodeTogether(n)) {
      if (namesChord(t)) return { ok: false, why: "mimic", error: `${id}: it names one of Ember's own shortcuts, so Ember doesn't show it. A view never asks, allows or speaks for Ember` };
      const secret = secretRefusal(t);
      if (secret) return { ok: false, why: "secret", error: `${id}: ${secret}, so Ember doesn't show the view. Leave it out` };
    }
    all.push(...strings.map(x => x.s));
    if (n.kind === "file") {
      const why = excerptRefusal(n.path, n.lines ?? []);
      if (why) return { ok: false, why: "secret", error: `${id}: the file can't be shown: ${why}. Leave it out` };
    }
    if (n.kind === "code") {
      const why = secretRefusal(n.lines.join("\n"));
      if (why) return { ok: false, why: "secret", error: `${id}: ${why}, so Ember doesn't show it. Leave it out` };
    }
    if (n.kind === "quote") {
      if (n.source.path && PRIVATE_PATH.test(n.source.path.trim())) return { ok: false, why: "secret", error: `${id}: that file is in a place where passwords and keys are kept, so Ember doesn't show it` };
      n = { ...n, source: checkedSource(n.source, ctx) };
    }
    out[id] = n;
  }
  if (namesChord(all.join(" "))) return { ok: false, why: "mimic", error: "the view names one of Ember's own shortcuts, so Ember doesn't show it. A view never asks, allows or speaks for Ember" };
  if (chars > W.chars) return { ok: false, error: `the view holds ${chars} characters; at most ${W.chars}` };
  if (charts > W.charts) return { ok: false, error: `the view has ${charts} charts and gauges; at most ${W.charts}` };
  return { ok: true, doc: { catalog: VIEW_CATALOG, rev: doc.rev, root, nodes: out } };
}

/**
 * A view as the model gave it (a v2 tree, or a first-catalog array of blocks), checked whole: the checked document at
 * `rev`, or one plain sentence saying what to change.
 */
export function checkView(input: unknown, ctx: ViewContext, rev = 1): ViewCheck {
  if (Array.isArray(input)) {
    const v1 = ViewSchema.safeParse(input);
    if (!v1.success) {
      // The first catalog's excerpt refuses a secret in its schema: still a refusal for what it said.
      const secret = v1.error.issues.some(i => /can't be shown/.test(i.message));
      return { ok: false, error: issueText(v1.error, "view"), ...(secret ? { why: "secret" as const } : {}) };
    }
    return checkDoc(upgradeView(v1.data, rev), ctx);
  }
  const nodes: Record<string, ViewNode> = {};
  const taken = new Set<string>();
  const ids = new IdMaker(taken);
  // A leaf at the top is wrapped in a stack: the root is always a layout node.
  const top = input && typeof input === "object" && typeof (input as { kind?: unknown }).kind === "string" && !LAYOUT_KINDS.has((input as { kind: string }).kind)
    ? { kind: "stack", children: [input] } : input;
  const r = flattenTree(top, nodes, ids, taken);
  if ("error" in r) return { ok: false, error: r.error };
  return checkDoc({ catalog: VIEW_CATALOG, rev, root: r.id, nodes }, ctx);
}

/** finish_task's and show_view's `view` as the runtime is told it: a tree (see the description), or the older array of blocks. */
export const ViewInputSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.record(z.string(), z.unknown())).min(1).max(L.blocks),
]);
