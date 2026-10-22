/**
 * The wire format of Ember's accessibility sidecar, exactly as the Python AT-SPI sidecar writes it, so the client
 * (app/main/perception/sidecar.ts) can't tell the two apart: one JSON-RPC 2.0 request per line in, one answer per line
 * out, every non-ASCII character escaped (a line never holds a raw newline or a byte the reader could split), and an
 * answer JSON can't carry (NaN, Infinity) turned into an error rather than silently into null. Error messages keep the
 * Python wording, including the quotes Python puts round a KeyError's message ("'element 7 is no longer known; …'").
 */

/** The protocol's version, as the Python sidecar reports it (ping, status). */
export const VERSION = 3;

/** The words for an app that didn't answer in time; Ember matches "busy" in them. */
export const BUSY = "the app is busy (it didn't answer in time); try again in a moment";
/** An action whose app didn't answer in time: Ember can't tell whether it happened (it matches "did not answer"). */
export const NO_ANSWER = "the app did not answer in time (it may still do it)";
/** The prefix of what accessibility can't do but the user's mouse could (Ember then asks to borrow it). */
export const BACKGROUND = "background_unavailable: ";

/**
 * An error whose message is what Python's str() of a KeyError gives: the text in single quotes. The client matches
 * these by substring ("no longer known"), so the quotes are kept as Python sends them.
 */
export class KeyError extends Error {
  constructor(text: string) {
    super(`'${text}'`);
    this.name = "KeyError";
  }
}

/** A refusal Python raises as PermissionError (secret fields): a plain message. */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/** An element that went away: its read is out of date. */
export class GoneError extends Error {
  constructor(id?: number, cause?: unknown) {
    super(`element ${id ?? ""} is gone (the window changed); read the window again`, cause === undefined ? undefined : { cause });
    this.name = "GoneError";
  }
}

/** An app that didn't answer in time (the protocol's exact words). */
export class BusyError extends Error {
  constructor() {
    super(BUSY);
    this.name = "BusyError";
  }
}

/** A request as read from a line; `id` is null when the line couldn't be read. */
export interface Request { id: unknown; method: unknown; params: Record<string, unknown> }

/** Reads a request line (throws on JSON that isn't an object: answered as an error with id null). */
export function parseRequest(line: string): Request {
  const req: unknown = JSON.parse(line);
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("a request must be a JSON object");
  const r = req as { id?: unknown; method?: unknown; params?: unknown };
  const params = r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params as Record<string, unknown> : {};
  return { id: r.id ?? null, method: r.method, params };
}

/** Finds a value JSON can't carry (NaN, Infinity, a function, a BigInt), naming where; null when there is none. */
function unencodable(v: unknown, at: string, seen: Set<unknown>): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? null : `Out of range float values are not JSON compliant (${at})`;
  if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") return `Object of type ${typeof v} is not JSON serializable (${at})`;
  if (!v || typeof v !== "object") return null;
  if (seen.has(v)) return `Circular reference detected (${at})`;
  seen.add(v);
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
  for (const [k, x] of entries) {
    if (x === undefined) continue;
    const bad = unencodable(x, `${at}.${k}`, seen);
    if (bad) return bad;
  }
  seen.delete(v);
  return null;
}

/** JSON with every character past ASCII escaped, as Python's json.dumps writes it (ensure_ascii). */
export const asciiJson = (v: unknown): string =>
  JSON.stringify(v).replace(/[\u0080-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** One answer line (without its newline): the result, or an error when the result can't be encoded. */
export function encodeResult(id: unknown, result: unknown): string {
  const bad = unencodable(result, "result", new Set());
  if (bad) return encodeError(id, `the answer could not be encoded: ${bad}`);
  return asciiJson({ jsonrpc: "2.0", id, result });
}

/** One error line (without its newline). */
export function encodeError(id: unknown, message: string): string {
  return asciiJson({ jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null, error: { message } });
}

/** A required parameter (Python's params["x"], whose KeyError says 'x'). */
export function required(params: Record<string, unknown>, name: string): unknown {
  if (!(name in params) || params[name] === undefined) throw new KeyError(name);
  return params[name];
}

/** A required integer parameter, as Python's int(params["x"]) reads it (a number or a numeric string). */
export function intParam(params: Record<string, unknown>, name: string): number {
  const v = required(params, name);
  const n = typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v) ? Number(v) : v;
  if (typeof n === "boolean") return n ? 1 : 0;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`invalid literal for int() with base 10: ${JSON.stringify(v)}`);
  return Math.trunc(n);
}

/** An optional integer parameter: undefined unless it is a whole number (Python's isinstance(x, int)). */
export const optInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);

/** A list of strings (anything else in it left out). */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A list of integers (anything else in it left out). */
export const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : []);

/** A number as Python's %s prints a float ("150.0", "0.5"), for messages that quote one. */
export function pyFloat(v: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
