/**
 * Tool pinning, against the "rug pull" (a server changing a tool after the user agreed to it, research §5): when the
 * user agrees, Ember records a SHA-256 of each tool's name, description, input schema and hints. A tool whose hash
 * differs later is off until the user agrees again in Home. The model-facing check (`shownHash`) covers what the
 * runtime shows the model (name, description, schema), which it passes through unchanged but for the two empty schema
 * fields it adds (`shownSchema`). Pure.
 */

import crypto from "node:crypto";

/** The hints Ember reads from a tool (only ever to make a call stricter). */
export interface ToolHints { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean }

/** A tool as a server lists it (MCP tools/list). */
export interface ServedTool { name: string; description: string; inputSchema: unknown; annotations: ToolHints }

/** A tool as Ember pinned it. */
export interface PinnedTool extends ServedTool {
  /** toolHash() when the user agreed. */
  hash: string;
  /** The server lists it differently now (or no longer): off until the user agrees again. */
  changed?: boolean;
}

/** JSON with object keys sorted, so the same schema always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The pin of a tool: its name, description, schema and hints. */
export function toolHash(t: ServedTool): string {
  const hints: ToolHints = {};
  for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint"] as const) if (typeof t.annotations[k] === "boolean") hints[k] = t.annotations[k];
  return sha(canonical({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? null, annotations: hints }));
}

/**
 * An input schema as the runtime shows it to the model. The runtime gives a schema that has none `type: "object"` and
 * an empty `properties` (measured on the bundled runtime, integrations-x9-3: `{ "type": "object" }`, `{}` and no
 * schema are each shown as `{ "type": "object", "properties": {} }`, a schema with properties and no type gets the
 * type; nothing else differs: `$schema`, `$defs`, titles and `required` pass through). Neither adds a parameter or a
 * word, so a pin and what is shown are compared with both in place. The pin itself stays the server's own entry.
 */
export function shownSchema(schema: unknown): unknown {
  if (schema === null || schema === undefined) return { type: "object", properties: {} };
  if (typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  return { ...s, ...(s.type === undefined ? { type: "object" } : {}), ...(s.properties === undefined ? { properties: {} } : {}) };
}

/** The hash of what the model is shown of a tool (the runtime's metadata has no hints). */
export function shownHash(name: string, description: string, inputSchema: unknown): string {
  return sha(canonical({ name, description, inputSchema: shownSchema(inputSchema) }));
}

/** Pins every tool as it is served now (at install, or when the user agrees again). */
export function pinAll(tools: ServedTool[]): PinnedTool[] {
  return tools.map(t => ({ ...t, hash: toolHash(t) }));
}

/**
 * The pinned tools checked against what the server lists now: a tool whose hash differs, or that is gone, is
 * `changed` (its pinned description and hints are kept, so Home shows what was agreed). A new tool isn't added: it
 * was never agreed to. Already-changed tools stay changed.
 */
export function checkPins(pinned: PinnedTool[], served: ServedTool[]): PinnedTool[] {
  const now = new Map(served.map(t => [t.name, toolHash(t)]));
  return pinned.map(p => (p.changed || now.get(p.name) !== p.hash ? { ...p, changed: true } : p));
}

/**
 * Read-only by its own say: readOnlyHint true, and neither destructiveHint nor openWorldHint true (a tool that reaches
 * the open world sends what it is given there). Anything else is a changing tool.
 */
export function isReadOnly(t: { annotations: ToolHints }): boolean {
  return t.annotations.readOnlyHint === true && t.annotations.destructiveHint !== true && t.annotations.openWorldHint !== true;
}

/** JSON Schema's own type names: no words of the server's. */
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
/** Keys whose values are values, not more schema: shown as they are written. */
const VALUE_KEYS: Record<string, string> = { enum: "choices", const: "always", default: "default", examples: "examples" };
const valueText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Every word of a tool's input schema the model reads, as lines for the review card (integrations-c9-1: the card showed
 * a tool's name and description while the model also read the schema's description and each parameter's, where a
 * server can write instructions). One line per parameter, by its path ("q", "filter.from"), with its title,
 * description, choices, default, examples and any other text it carries; the schema's own description first. Only
 * JSON's type names, numbers, booleans, a `$schema` address and a `#/…` reference are left out: none is the server's
 * prose. Nothing is cut: the card shows what the model is sent.
 */
export function schemaWords(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, at: string[], named: boolean) => {
    if (Array.isArray(node)) { for (const n of node) walk(n, at, false); return; }
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && node) out.push(at.length ? `${at.join(".")}: ${node}` : node);
      return;
    }
    const o = node as Record<string, unknown>;
    const texts: string[] = [];
    const later: (() => void)[] = [];
    const props = o.properties && typeof o.properties === "object" && !Array.isArray(o.properties) ? Object.keys(o.properties) : [];
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [name, sub] of Object.entries(v)) later.push(() => walk(sub, [...at, name], true));
      } else if ((k === "$defs" || k === "definitions") && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [name, sub] of Object.entries(v)) later.push(() => walk(sub, [...at, name], true));
      } else if (k in VALUE_KEYS) {
        texts.push(`${VALUE_KEYS[k]}: ${Array.isArray(v) && k !== "const" && k !== "default" ? v.map(valueText).join(", ") : valueText(v)}`);
      } else if (k === "type") {
        const odd = (Array.isArray(v) ? v : [v]).filter(t => typeof t === "string" && !JSON_TYPES.has(t));
        if (odd.length) texts.push(`type: ${odd.join(", ")}`);
      } else if (k === "required" && Array.isArray(v)) {
        const odd = v.filter(n => typeof n !== "string" || !props.includes(n));
        if (odd.length) texts.push(`required: ${odd.map(valueText).join(", ")}`);
      } else if (typeof v === "string") {
        if ((k === "$schema" && /^https?:\/\/\S+$/.test(v)) || (k === "$ref" && /^#[\w/$.-]*$/.test(v))) continue;
        if (v) texts.push(k === "description" || k === "title" ? v : `${k}: ${v}`);
      } else if (v && typeof v === "object") {
        later.push(() => walk(v, at, false));
      }
    }
    if (texts.length || (named && at.length)) out.push(at.length ? `${at.join(".")}${texts.length ? `: ${texts.join(" · ")}` : ""}` : texts.join(" · "));
    for (const f of later) f();
  };
  walk(schema, [], false);
  return out;
}
