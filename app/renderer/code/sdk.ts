/**
 * Reading the SDK's payloads, which reach the coding window as `unknown` (app/shared/code.ts passes events through as
 * the runtime sent them): small total functions that return a value of the asked type or nothing, never throw, and
 * never trust a field's type. Pure, so the reducers built on them are pure too.
 */

/** `v` as a plain object, or null. */
export function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A string field (`""` counts as absent unless `empty`). */
export function str(o: unknown, key: string, empty = false): string | undefined {
  const v = rec(o)?.[key];
  return typeof v === "string" && (empty || v !== "") ? v : undefined;
}

/** A finite number field. */
export function num(o: unknown, key: string): number | undefined {
  const v = rec(o)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A boolean field. */
export function bool(o: unknown, key: string): boolean | undefined {
  const v = rec(o)?.[key];
  return typeof v === "boolean" ? v : undefined;
}

/** An array field (empty when absent). */
export function arr(o: unknown, key: string): unknown[] {
  const v = rec(o)?.[key];
  return Array.isArray(v) ? v : [];
}

/** The strings of an array field. */
export function strs(o: unknown, key: string): string[] {
  return arr(o, key).filter((x): x is string => typeof x === "string");
}

/** A nested object field. */
export function sub(o: unknown, key: string): Record<string, unknown> | null {
  return rec(rec(o)?.[key]);
}

/**
 * A tool's arguments as an object: the SDK sends them as JSON (an object), and older events as a JSON string. A string
 * that isn't JSON (cut by main's bound) is no object.
 */
export function argsOf(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try { return rec(JSON.parse(v)); } catch { return null; /* cut or not JSON: the row shows the tool by name */ }
  }
  return rec(v);
}

/** A value as text for showing whole (JSON, two-space indented), bounded by `max` characters. */
export function shown(v: unknown, max = 20_000): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try { s = JSON.stringify(v, null, 2) ?? ""; } catch { s = String(v); /* a cycle can't come over IPC; kept total */ }
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
