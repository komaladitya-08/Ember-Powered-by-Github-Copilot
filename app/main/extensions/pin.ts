/**
 * Tool pinning, against the "rug pull" (a server changing a tool after the user agreed to it, research §5): when the
 * user agrees, Ember records a SHA-256 of each tool's name, description, input schema and hints. A tool whose hash
 * differs later is off until the user agrees again in Home. The model-facing check (`shownHash`) covers what the
 * runtime shows the model (name, description, schema), which the spike found it passes through unchanged. Pure.
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

/** The hash of what the model is shown of a tool (the runtime's metadata has no hints). */
export function shownHash(name: string, description: string, inputSchema: unknown): string {
  return sha(canonical({ name, description, inputSchema: inputSchema ?? null }));
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
