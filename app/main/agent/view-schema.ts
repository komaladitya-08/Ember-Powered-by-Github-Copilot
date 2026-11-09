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
import { TOKEN_PATTERNS } from "../commands/redact";

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
  // A keyring or keychain folder, written as a path (the bare word in a sentence is fine).
  String.raw`[\\/]keyrings?([\\/]|$)|^keyrings?[\\/]`,
  String.raw`[\\/]Keychains([\\/]|$)|^Keychains[\\/]`,
  String.raw`^/etc/(shadow|gshadow|sudoers)`,
  String.raw`(^|[\\/])\.(netrc|pgpass|git-credentials|npmrc|pypirc)$`,
  // An env file, but not its checked-in examples.
  String.raw`(^|[\\/])\.env(\.(?!(example|sample|template|dist)$)[\w-]+)?$`,
  String.raw`\.(p12|pfx|kdbx)$`,
  // A private key file: an SSH key (not its .pub), anything in an ssl/private folder, a .key or .pem under one of the
  // folders keys live in, a key's backup. A Keynote "talk.key" or a "ca.pem" elsewhere is fine.
  String.raw`(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(?!\.pub$)(\.[\w.-]*)?$`,
  String.raw`(^|[\\/])ssl[\\/]private([\\/]|$)`,
  String.raw`(^|[\\/])(ssl|tls|certs?|private|keys)[\\/]([^\\/]+[\\/])*[^\\/]*\.(key|pem)$`,
  String.raw`\.key\.(bak|old|orig|save)$`,
].join("|"), "i");

/**
 * A line of code or of a file with the lines before it, up to 2 KiB, ending at the line: a property of an object or a
 * call opened above it reads as code there as in the whole file ("const auth = {", "  password: password"), and what
 * is looked for at a line's end is still found at its end (memory-w5-2).
 */
export function withLinesBefore(lines: readonly string[], i: number): string {
  let j = i;
  for (let size = 0; j > 0 && size + lines[j - 1]!.length + 1 <= 2048; j--) size += lines[j - 1]!.length + 1;
  return lines.slice(j, i + 1).join("\n");
}

/** Why an excerpt may not be shown, or null when it may (a secret in a line, or a private place). */
export function excerptRefusal(path: string, lines: readonly string[]): string | null {
  if (PRIVATE_PATH.test(path.trim())) return "that file is in a place where passwords and keys are kept, so Ember doesn't show it";
  for (let i = 0; i < lines.length; i++) {
    const why = memoryRefusal(withLinesBefore(lines, i));
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
 * holding one is refused outright (fail closed), except where writing needs it (`invisibleAllowed`): "Al" + a zero-width
 * space + "low" must never pass as something other than "Allow".
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u00AD\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const PICTO = /\p{Extended_Pictographic}/u;
/** Emoji modifiers and the emoji variation selector, which may sit between a pictograph and a joiner. */
const EMOJI_TAIL = /^(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F)$/u;
/** Scripts whose words need a zero-width (non-)joiner (Persian, Urdu, Hindi, Malayalam…): never Latin, Greek or Cyrillic. */
const JOINING_SCRIPTS = ["Arabic", "Hebrew", "Syriac", "Thaana", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil",
  "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Khmer", "Mongolian"].map(s => new RegExp(`\\p{Script=${s}}`, "u"));

/**
 * Whether the invisible character at `i` of `cs` is one writing needs: the emoji presentation selector after a
 * pictograph ("⚠\uFE0F"), a joiner between pictographs (a family emoji), or a (non-)joiner between letters of one of the
 * scripts that use them. Anywhere else it is refused.
 */
function invisibleAllowed(cs: readonly string[], i: number): boolean {
  const c = cs[i];
  if (c === "\uFE0F") return i > 0 && PICTO.test(cs[i - 1]);
  if (c === "\u200D") {
    let p = i - 1;
    while (p >= 0 && EMOJI_TAIL.test(cs[p])) p--;
    if (p >= 0 && PICTO.test(cs[p]) && i + 1 < cs.length && PICTO.test(cs[i + 1])) return true;
  }
  if (c === "\u200C" || c === "\u200D") {
    // After a letter or sign of such a script, before another of the same script or the end of the word (a chillu).
    const a = cs[i - 1], b = cs[i + 1];
    return !!a && JOINING_SCRIPTS.some(re => re.test(a) && (b === undefined || re.test(b) || !/[\p{L}\p{N}\p{M}\p{Cf}]/u.test(b)));
  }
  return false;
}

/** Whether `s` holds an invisible or direction-changing character that writing doesn't need there. */
export function hidesCharacters(s: string): boolean {
  if (!INVISIBLE.test(s)) return false;
  const cs = [...s];
  return cs.some((c, i) => INVISIBLE.test(c) && !invisibleAllowed(cs, i));
}

/**
 * Letters from other scripts that look like Latin ones (Cyrillic, Greek, Armenian, Cherokee, small capitals and other
 * Latin forms NFKC keeps), mapped to the Latin letter with its case, before Ember's words are matched: "Аllow" with a
 * Cyrillic А reads as "Allow". NFKC already folds fullwidth and compatibility forms.
 */
const CONFUSABLE: Readonly<Record<string, string>> = Object.fromEntries([
  // Cyrillic
  ["а", "a"], ["в", "b"], ["е", "e"], ["ё", "e"], ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"], ["с", "c"], ["т", "t"],
  ["у", "y"], ["х", "x"], ["ѕ", "s"], ["і", "i"], ["ї", "i"], ["ј", "j"], ["һ", "h"], ["ԁ", "d"], ["ԛ", "q"], ["ԝ", "w"], ["ӏ", "l"],
  ["А", "A"], ["В", "B"], ["Е", "E"], ["К", "K"], ["М", "M"], ["Н", "H"], ["О", "O"], ["Р", "P"], ["С", "C"], ["Т", "T"], ["Х", "X"],
  ["У", "Y"], ["І", "I"], ["Ј", "J"], ["Ѕ", "S"], ["Ԁ", "D"], ["Ԛ", "Q"], ["Ԝ", "W"], ["Ӏ", "I"],
  // Greek
  ["α", "a"], ["β", "b"], ["ε", "e"], ["ι", "i"], ["κ", "k"], ["ν", "v"], ["ο", "o"], ["ρ", "p"], ["τ", "t"], ["υ", "u"], ["χ", "x"],
  ["ω", "w"], ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"], ["Ι", "I"], ["Κ", "K"], ["Μ", "M"], ["Ν", "N"], ["Ο", "O"],
  ["Ρ", "P"], ["Τ", "T"], ["Υ", "Y"], ["Χ", "X"],
  // Armenian and Cherokee
  ["օ", "o"], ["ո", "n"], ["ս", "u"], ["ց", "g"], ["հ", "h"], ["Ꭺ", "A"], ["Ꭼ", "E"], ["Ꮪ", "S"], ["Ꮃ", "W"], ["Ꮮ", "L"], ["Ꮯ", "C"],
  ["Ꭰ", "D"], ["Ꮋ", "H"], ["Ꮶ", "K"], ["Ꮇ", "M"], ["Ꮲ", "P"], ["Ꭲ", "T"], ["Ꮩ", "V"], ["Ꮓ", "Z"],
  // Latin look-alikes NFKC keeps
  ["ı", "i"], ["ȷ", "j"], ["ɑ", "a"], ["Ɑ", "A"], ["ɩ", "i"], ["ɡ", "g"], ["ℓ", "l"], ["ǀ", "l"],
  ["ᴀ", "a"], ["ʙ", "b"], ["ᴄ", "c"], ["ᴅ", "d"], ["ᴇ", "e"], ["ɢ", "g"], ["ʜ", "h"], ["ɪ", "i"], ["ᴊ", "j"], ["ᴋ", "k"], ["ʟ", "l"],
  ["ᴍ", "m"], ["ɴ", "n"], ["ᴏ", "o"], ["ᴘ", "p"], ["ʀ", "r"], ["ꜱ", "s"], ["ᴛ", "t"], ["ᴜ", "u"], ["ᴠ", "v"], ["ᴡ", "w"], ["ʏ", "y"], ["ᴢ", "z"],
]);
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "gu");

/** NFKD with combining marks and invisible characters dropped, look-alike letters mapped to Latin, case kept: the base of every match. */
const lookAlikeBase = (s: string) => s.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(CONFUSABLE_RE, c => CONFUSABLE[c] ?? c).normalize("NFKC");

/** A view string as Ember matches it: compatibility forms, marks and look-alikes folded, curly quotes straight, lower case. */
export function viewNorm(s: string): string {
  return lookAlikeBase(s).replace(/[’‘]/g, "'").toLowerCase();
}

/**
 * A word's skeleton for matching Ember's words only (in the spirit of UTS #39): its folded letters, with I, i, 1, |
 * and ǀ all read as l and 0 as o, so "AIlow", "A11ow" and "Al|ow" read as "allow". Ember's own words are compared by
 * their skeletons too.
 */
function skeleton(s: string): string {
  return viewNorm(s).replace(/[i1|ǀ]/g, "l").replace(/0/g, "o").replace(/'/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** A name as matched for equality (an app's name against those the task read). */
const fold = (s: string) => viewNorm(s).replace(/'/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const MIMIC = new Set(MIMIC_WORDS.map(skeleton));
const LABELS = new Set(MIMIC_LABELS.map(skeleton));
/** A short line that starts as one of Ember's questions' answers do ("Allow Ember to…", "Approve this"). */
const MIMIC_START = new RegExp(`^(${["allow", "deny", "approve", "grant", "confirm", "always allow", "not now"].map(skeleton).join("|")})\\b`);

/** Every name of a modifier key, on every OS, by the modifier it is. */
const MODIFIER: Readonly<Record<string, string>> = {
  ctrl: "ctrl", control: "ctrl", ctl: "ctrl", strg: "ctrl", "⌃": "ctrl",
  alt: "alt", option: "alt", opt: "alt", altgr: "alt", "⌥": "alt",
  win: "super", windows: "super", super: "super", meta: "super", cmd: "cmd", command: "cmd", "⌘": "cmd",
  shift: "shift", "⇧": "shift",
};
/** A key's names, as one name. */
const KEY_NAME: Readonly<Record<string, string>> = { enter: "return", return: "return", "⏎": "return", "↩": "return", escape: "esc", esc: "esc", period: ".", ".": "." };
/** Words people put between a chord's keys ("Windows key, Alt, Y", "hold Ctrl and Alt, then press Y"). */
const FILLER = new Set(["key", "keys", "logo", "and", "then", "press", "hold", "the", "plus", "button", "down", "together", "with", "also", "letter", "capital"]);

/**
 * Ember's allow, deny and stop chords on every OS, default and fallback, from app/shared/shortcuts.ts: each as its
 * modifiers (sorted, by what they are) and its key.
 */
const EMBER_CHORDS: ReadonlySet<string> = new Set((["linux", "win32", "darwin"] as const).flatMap(os => (["allow", "deny", "stop"] as const)
  .flatMap(id => [SHORTCUTS[os][id], FALLBACK_SHORTCUTS[os][id]]).map(sc => {
    const keys = sc.keys.map(k => k.toLowerCase());
    const key = keys[keys.length - 1];
    return `${keys.slice(0, -1).map(k => MODIFIER[k] ?? k).sort().join("+")}+${KEY_NAME[key] ?? key}`;
  })));

/**
 * Whether `s` names one of Ember's own allow, deny or stop chords, however it is written: its modifiers by any OS's
 * names or symbols, in any order, with any separators, quotes or filler words between ("press “Ctrl+Alt+Y”",
 * "Windows key, Alt, Y", "⌃⇧⌘Y", "Ctrl×Alt×Y"). Other chords ("Ctrl+Shift+N", "Cmd+Shift+.") are ordinary text.
 */
export function namesChord(s: string): boolean {
  const spaced = viewNorm(s).replace(/[⌃⌥⌘⇧⏎↩]/g, m => ` ${m} `);
  const tokens = (spaced.match(/[\p{L}\p{N}]+|[⌃⌥⌘⇧⏎↩.]/gu) ?? []).flatMap(runTogether);
  const isKey = (t: string) => CHORD_KEYS_BY_NAME.has(KEY_NAME[t] ?? t);
  const ember = (mods: Set<string>, key: string) => mods.size >= 2 && EMBER_CHORDS.has(`${[...mods].sort().join("+")}+${KEY_NAME[key] ?? key}`);
  let mods = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m = MODIFIER[t];
    if (m) { mods.add(m); continue; }
    const next = tokens[i + 1];
    // A "." between keys ("Ctrl.Alt.Y") separates them; at the end of a chord it may be the key itself.
    if (t === "." && next !== undefined && (MODIFIER[next] || next.length === 1)) continue;
    if (mods.size && FILLER.has(t)) continue;
    if (ember(mods, t)) return true;
    // The key first ("Y+Alt+Ctrl"): the modifiers after it.
    if (isKey(t)) {
      const after = new Set<string>();
      for (let j = i + 1; j < tokens.length; j++) {
        const mj = MODIFIER[tokens[j]];
        if (mj) after.add(mj);
        else if (!FILLER.has(tokens[j]) && tokens[j] !== ".") break;
      }
      if (ember(after, t)) return true;
    }
    mods = new Set();
  }
  return false;
}

/** The keys of Ember's chords, by one name each ("y", "return", "esc", "."). */
const CHORD_KEYS_BY_NAME: ReadonlySet<string> = new Set([...EMBER_CHORDS].map(c => c.slice(c.lastIndexOf("+") + 1)));
const RUN_TOGETHER = new RegExp(`^((?:${Object.keys(MODIFIER).filter(k => /^\p{L}+$/u.test(k)).sort((a, b) => b.length - a.length).join("|")})+)(${Object.keys(KEY_NAME).filter(k => /^\p{L}+$/u.test(k)).join("|")}|[a-z])$`, "u");
const MOD_NAMES = new RegExp(Object.keys(MODIFIER).filter(k => /^\p{L}+$/u.test(k)).sort((a, b) => b.length - a.length).join("|"), "gu");

/** A chord written as one word ("CtrlAltY", "controlshiftcommandperiod") as its keys; any other word as it is. */
function runTogether(t: string): string[] {
  const m = RUN_TOGETHER.exec(t);
  if (!m || MODIFIER[t]) return [t];
  const mods = m[1].match(MOD_NAMES) ?? [];
  return mods.join("") === m[1] && mods.length >= 2 ? [...mods, m[2]] : [t];
}

/**
 * A string as Ember looks for its own voice in it: look-alikes folded with their case, digits read as the letters they
 * stand in for (Emb3r), and letters spelt out one at a time joined up ("E m b e r").
 */
function voiceText(s: string): string {
  return lookAlikeBase(s).replace(/[’‘]/g, "'")
    .replace(/(?<![\p{L}\p{N}])\p{L}(?:[ ._·-]\p{L}(?![\p{L}\p{N}])){2,}/gu, m => m.replace(/[ ._·-]/g, ""))
    .replace(/(?<=\p{L})3(?=\p{L})/gu, "e").replace(/(?<=\p{L})0(?=\p{L})/gu, "o");
}
/**
 * Words in Ember's voice: "Ember:" (or a dash) where a speaker's name stands (a line's or a sentence's start, or after
 * a quote mark), "Ember:" anywhere before words of consent or the user, "I'm Ember", "Ember says". "The colour is
 * ember: a deep orange" is not.
 */
const AS_EMBER = [
  /(^|[.!?]\s+|["“”«»([]\s*)Ember\s*[:\-–—]/m,
  /\bember\s*[:\-–—]\s*["“]?\s*(the user|you|i\b|i'm|we\b|yes|ok|okay|approved|allow|go ahead|confirmed|said|says|agreed|accepted)/i,
  /\b(i'?m|i am|this is|it'?s|it is) ember\b/i,
  /\bember (says|said|asks|asked|needs|wants|would like|is asking|wrote|writes|told|tells)\b/i,
  /\b(from|by|signed|message from|note from) ember\s*[:\-–—]/i,
  /\bas ember (wrote|said|asked|told)\b/i,
];
/** Whether `s` speaks as Ember. */
export function speaksAsEmber(s: string): boolean {
  const v = voiceText(s);
  return AS_EMBER.some(re => re.test(v));
}

/**
 * Why `s` would make a view look like Ember's own question, consent or allow/deny UI, or null. `short` is a
 * button-like position (a badge, a heading, a title, a label), where a line starting as an answer does is refused too.
 * A string holding invisible or direction-changing characters is refused whatever it says.
 */
export function mimicRefusal(s: string, short = false): string | null {
  if (hidesCharacters(s)) return "it holds invisible or direction-changing characters";
  const f = skeleton(s);
  if (MIMIC.has(f) || (short && LABELS.has(f))) return `"${s.trim().slice(0, 30)}" is one of Ember's own buttons`;
  if (short && f.length <= 40 && MIMIC_START.test(f)) return `"${s.trim().slice(0, 30)}" reads like Ember's own question`;
  if (namesChord(s)) return "it names one of Ember's own shortcuts";
  if (speaksAsEmber(s)) return "it speaks as Ember";
  return null;
}

/**
 * Why `s` would show a secret or a place where secrets live, or null: a token, key, card number, a private key's
 * header or "password: hunter2" (memoryRefusal, read in `context`, a code line with the lines before it, where one is
 * given), or a path (anywhere in it, slashes however written) into a private place.
 */
export function secretRefusal(s: string, context = s): string | null {
  const why = memoryRefusal(context);
  if (why) return why;
  const n = s.normalize("NFKC").replace(/[∕⁄⧸／]/g, "/");
  if (PRIVATE_PATH.test(n.trim()) || n.split(/[\s"'`()<>[\]{},;]+/).some(t => t && PRIVATE_PATH.test(t))) return "it names a place where passwords and keys are kept";
  return null;
}

/**
 * Why `s`, strings run together with nothing between, holds a token or key the redactor knows ("ghp_…" split over two
 * rows), or null. Only tokens and keys: run together, numbers would read as card numbers.
 */
export function tokenRefusal(s: string): string | null {
  const squeezed = s.replace(/\s+/g, "");
  for (const re of TOKEN_PATTERNS) {
    const once = new RegExp(re.source, re.flags.replace("g", ""));
    if (once.test(s) || once.test(squeezed)) return "it holds a password, token or key";
  }
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

/** A node's headings, titles, labels and column names: where a speaker's name would stand. */
function labelStrings(n: ViewNode): string[] {
  switch (n.kind) {
    case "section": return [n.title];
    case "heading": return [n.text];
    case "badge": return [n.text];
    case "callout": return n.title ? [n.title] : [];
    case "keyvalue": return n.rows.map(r => r.label);
    case "table": return n.columns;
    case "compare": return [...n.columns, ...n.rows.map(r => r.label)];
    case "metric": return [n.label];
    case "timeline": return n.items.map(i => i.when);
    case "chart": return n.series.map(s => s.name);
    case "text": return [n.text];
    default: return [];
  }
}

/**
 * A node's strings as they read together: a label with its value, a column's name with each cell, a row's cells, a
 * list's items, the whole node. A secret or a shortcut split across fields ("Password" | "hunter2", "Ctrl+Alt" | "+Y")
 * is caught in these.
 */
function nodeTogether(n: ViewNode): string[] {
  const out: string[] = [];
  switch (n.kind) {
    case "keyvalue": for (const r of n.rows) out.push(`${r.label}: ${r.value}`); out.push(n.rows.map(r => r.value).join(" ")); break;
    case "table":
      for (const r of n.rows) { out.push(r.join(" ")); r.forEach((c, i) => out.push(`${n.columns[i] ?? ""}: ${c}`)); }
      break;
    case "compare": for (const r of n.rows) out.push(`${r.label}: ${r.a}`, `${r.label}: ${r.b}`, `${n.columns[0]}: ${r.a}`, `${n.columns[1]}: ${r.b}`); break;
    case "timeline": for (const i of n.items) out.push(`${i.when}: ${i.text}`); out.push(n.items.map(i => i.text).join(" ")); break;
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
  /** Every string in reading order: Ember's voice, a chord or a token spread over several nodes is caught in the whole view. */
  const all: string[] = [];
  /** Where in `all` a heading, title, label or column says only "Ember". */
  const emberLabels: number[] = [];
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
    // A code block's or a file's lines (first and last of its strings) are each read with the lines before them.
    const lines = n.kind === "code" ? n.lines : n.kind === "file" ? n.lines ?? [] : [];
    const first = n.kind === "file" ? strings.length - lines.length : 0;
    for (const [k, { s, short }] of strings.entries()) {
      chars += s.length;
      const mimic = mimicRefusal(s, short);
      if (mimic) return { ok: false, why: "mimic", error: `${id}: ${mimic}, so Ember doesn't show it. A view never asks, allows or speaks for Ember` };
      const secret = secretRefusal(s, k >= first && k < first + lines.length ? withLinesBefore(lines, k - first) : s);
      if (secret) return { ok: false, why: "secret", error: `${id}: ${secret}, so Ember doesn't show the view. Leave it out` };
    }
    for (const t of nodeTogether(n)) {
      if (namesChord(t)) return { ok: false, why: "mimic", error: `${id}: it names one of Ember's own shortcuts, so Ember doesn't show it. A view never asks, allows or speaks for Ember` };
      if (speaksAsEmber(t)) return { ok: false, why: "mimic", error: `${id}: it speaks as Ember, so Ember doesn't show it. A view never asks, allows or speaks for Ember` };
      const secret = secretRefusal(t);
      if (secret) return { ok: false, why: "secret", error: `${id}: ${secret}, so Ember doesn't show the view. Leave it out` };
    }
    // A row's children read as one line: a chord split over them is still a chord.
    if (n.kind === "row") {
      const line = n.children.flatMap(c => (nodes[c] ? nodeStrings(nodes[c]).map(x => x.s) : [])).join(" ");
      if (namesChord(line)) return { ok: false, why: "mimic", error: `${id}: it names one of Ember's own shortcuts, so Ember doesn't show it. A view never asks, allows or speaks for Ember` };
    }
    for (const l of labelStrings(n)) if (skeleton(l) === "ember") emberLabels.push(all.length + strings.findIndex(x => x.s === l));
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
  // The whole view read through, a string a line: Ember's voice spread over nodes, a token split over them.
  if (speaksAsEmber(all.join("\n"))) return { ok: false, why: "mimic", error: "the view speaks as Ember, so Ember doesn't show it. A view never asks, allows or speaks for Ember" };
  // One of Ember's chords spread over nodes in reading order (stacked texts, a heading and a line, badges in a grid).
  if (namesChord(all.join(" "))) return { ok: false, why: "mimic", error: "the view names one of Ember's own shortcuts, so Ember doesn't show it. A view never asks, allows or speaks for Ember" };
  // A label that is Ember's name, with anything after it: the view speaking as Ember under a heading or a label.
  if (emberLabels.some(i => i < all.length - 1)) return { ok: false, why: "mimic", error: "the view speaks as Ember, so Ember doesn't show it. A view never asks, allows or speaks for Ember" };
  // A token split over up to five strings in reading order (cells, items, nodes), each run read with nothing between.
  // Runs need a string with letters, as every token has: digits alone run together would read as a card number.
  for (let i = 0; i < all.length - 1; i++) {
    for (let k = 2; k <= 5 && i + k <= all.length; k++) {
      const run = all.slice(i, i + k);
      if (!run.some(x => /\p{L}/u.test(x))) continue;
      const split = tokenRefusal(run.join(""));
      if (split) return { ok: false, why: "secret", error: `the view: ${split}, so Ember doesn't show it. Leave it out` };
    }
  }
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
