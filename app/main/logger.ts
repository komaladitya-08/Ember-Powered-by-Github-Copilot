/**
 * Structured logging: one JSON object per line in <dir>/ember.log, rotated by
 * size. No Electron imports, so it can be unit-tested and reused by helpers.
 */

import fs from "node:fs";
import path from "node:path";
import { redactSecretText } from "./secret-text";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The level EMBER_LOG_LEVEL names, in any case; info when it is unset or names no level (`unknown` then holds it,
 * so the caller can say so). An unknown name used to turn on every debug line (review #90).
 */
export function logLevel(value: string | undefined): { level: LogLevel; unknown?: string } {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return { level: "info" };
  return Object.prototype.hasOwnProperty.call(ORDER, v) ? { level: v as LogLevel } : { level: "info", unknown: value };
}

export interface LoggerOptions {
  dir: string;
  level?: LogLevel;
  /** Also print each line to stdout (dev and smoke tests). */
  stdout?: boolean;
  /** Rotate when the file exceeds this many bytes. */
  maxBytes?: number;
  /** Rotated files to keep (ember.log.1 … ember.log.N). */
  keep?: number;
  now?: () => Date;
  /**
   * A last pass over every string and key of a line (the vault's redactor, app/main/vault/redact.ts: a value the vault
   * filled never reaches the file or stdout, whatever read it back). A pass that throws loses the line, never the value.
   */
  redact?: (text: string) => string;
  /** Where printed lines go: process.stdout and process.stderr unless a unit test passes its own. */
  streams?: { stdout?: LogStream; stderr?: LogStream };
}

/** A stream log lines are printed to: process.stdout or process.stderr. */
export interface LogStream {
  write(line: string, cb: (err?: Error | null) => void): boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** Print streams that failed a write (their reader went away: `| head` exited, a terminal closed): never written again. */
const goneStreams = new WeakSet<LogStream>();
/** Print streams already listened on for errors: one listener each, however many loggers print there. */
const heardStreams = new WeakSet<LogStream>();
/** The errors those failed writes raised, for isLogStreamFailure. */
const streamErrors = new WeakSet<object>();

/**
 * True for an error one of Ember's print streams raised when a write failed (that very error, not one that looks like
 * it): logging it would print to that stream again. Unheard, each failed write raised another, and Ember held a core,
 * wiped its own log and couldn't be quit (reliability-r8-1).
 */
export function isLogStreamFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && streamErrors.has(err);
}

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(scope: string): Logger;
  readonly file: string;
}

/** Nesting past this is written as "[deep]", never raw (JSON.stringify has no limit of its own). */
const MAX_DEPTH = 8;

/**
 * Errors anywhere in a value become plain objects (with code and cause); cycles and BigInts can't break a log line.
 * The finished line then has anything shaped like a credential replaced (BE audit #1), so a token in a name, a code, an
 * object key, a scope or a deep value never reaches the file or stdout, whatever put it there.
 */
function safeLine(entry: Fields, more?: (text: string) => string): string {
  // Redacted as a parsed value, never as finished text: a text pass can turn `"secret":true` into `"secret":[token]`.
  return JSON.stringify(redactValue(JSON.parse(rawLine(entry)) as unknown, more));
}

/** Names whose value is a credential whatever its type (the same words secret-text.ts finds in `name=value` text). */
const CREDENTIAL_KEY = /^(?:[a-z]+[_-])?token$|password|passwd|secret|api[_-]?key|authorization/i;

/** Every string and key redacted; a credential-named key's value, of any type, becomes "[token]". Output stays valid JSON. */
function redactValue(v: unknown, more?: (text: string) => string): unknown {
  const text = (s: string) => (more ? more(redactSecretText(s)) : redactSecretText(s));
  if (typeof v === "string") return text(v);
  if (Array.isArray(v)) return v.map(x => redactValue(x, more));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>; // so a `__proto__` key stays a key
    for (const [k, x] of Object.entries(v)) out[text(k)] = CREDENTIAL_KEY.test(k) ? "[token]" : redactValue(x, more);
    return out;
  }
  return v;
}

function rawLine(entry: Fields): string {
  // Only a value inside itself is a cycle: the same value twice side by side prints twice.
  const ancestors: object[] = [];
  const origin = new WeakMap<object, object>();
  return JSON.stringify(entry, function (this: object, _k, v: unknown) {
    if (typeof v === "bigint") return v.toString();
    if (!v || typeof v !== "object") return v;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.some(a => a === v || origin.get(a) === v)) return "[circular]";
    if (ancestors.length >= MAX_DEPTH) return "[deep]";
    let out: object = v;
    if (v instanceof Error) {
      const e = v as Error & { code?: unknown; cause?: unknown };
      out = { name: e.name, message: e.message, stack: e.stack, ...(e.code !== undefined ? { code: e.code } : {}), ...(e.cause !== undefined ? { cause: e.cause } : {}) };
      origin.set(out, v);
    }
    ancestors.push(out);
    return out;
  });
}

export function createLogger(opts: LoggerOptions): Logger {
  // Checked again here: a level that isn't one (a cast from the environment) means info, never "everything".
  const level = logLevel(opts.level).level;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  const now = opts.now ?? (() => new Date());
  const file = path.join(opts.dir, "ember.log");
  // Private: logs mention apps and windows the user worked in. A folder that can't be made
  // (owned by root after `su`, a file in the way) sends lines to stderr instead of stopping Ember.
  let toStderr = false;
  try { fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 }); } catch { toStderr = true; }

  const rotateIfNeeded = () => {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < maxBytes) return;
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  };

  const write = (lvl: LogLevel, scope: string | undefined, msg: string, fields?: Fields) => {
    // Logging must never take the app down, whatever it is given.
    try {
      if (ORDER[lvl] < ORDER[level]) return;
      // A field can't take the place of the time, level, event name or scope.
      const entry: Fields = { ...(fields ?? {}), t: now().toISOString(), level: lvl, msg };
      if (scope) entry.scope = scope;
      const line = safeLine(entry, opts.redact) + "\n";
      if (toStderr) print("stderr", line);
      else {
        try {
          rotateIfNeeded();
          fs.appendFileSync(file, line, { mode: 0o600 });
        } catch { /* disk full, read-only… */ }
      }
      if (opts.stdout) print("stdout", line);
    } catch { /* an unprintable value */ }
  };

  /** The first failed write switches a print stream off for good, said once in the log (reliability-r8-1). */
  const lose = (stream: LogStream, name: "stdout" | "stderr", err: unknown) => {
    if (typeof err === "object" && err !== null) streamErrors.add(err);
    if (goneStreams.has(stream)) return;
    goneStreams.add(stream);
    const code = (err as { code?: unknown } | null)?.code;
    write("warn", undefined, "log.stream_off", { stream: name, ...(typeof code === "string" ? { code: code.slice(0, 40) } : {}) });
  };

  // Looked up only once a line goes there: a packaged Ember that prints nothing never touches its stdout.
  const streamOf = (name: "stdout" | "stderr"): LogStream =>
    name === "stdout" ? opts.streams?.stdout ?? process.stdout : opts.streams?.stderr ?? process.stderr;

  const hear = (name: "stdout" | "stderr") => {
    const stream = streamOf(name);
    if (heardStreams.has(stream)) return;
    heardStreams.add(stream);
    // Node reports a failed write after write() returns, to its callback and then as an `error` event. Unheard, that
    // event is an uncaught exception, whose log line printed here failed the same way, without end.
    stream.on("error", (err: unknown) => lose(stream, name, err));
  };

  const print = (name: "stdout" | "stderr", line: string) => {
    const stream = streamOf(name);
    if (goneStreams.has(stream)) return;
    try {
      hear(name);
      // Printing to stdout hears stderr too: the two mostly share a reader (a terminal, `2>&1 | head`), and Node copies
      // a child's stderr to Ember's own (execFileSync), where a failure was logged as uncaught at every setup check.
      if (name === "stdout") hear("stderr");
      stream.write(line, err => { if (err) lose(stream, name, err); });
    } catch (err) {
      lose(stream, name, err); // a write that throws instead of reporting its error (a full disk reports, as EPIPE does)
    }
  };

  const make = (scope?: string): Logger => ({
    debug: (m, f) => write("debug", scope, m, f),
    info: (m, f) => write("info", scope, m, f),
    warn: (m, f) => write("warn", scope, m, f),
    error: (m, f) => write("error", scope, m, f),
    child: s => make(scope ? `${scope}.${s}` : s),
    file,
  });
  return make();
}
