/**
 * Structured logging: one JSON object per line in <dir>/ember.log, rotated by
 * size. No Electron imports, so it can be unit-tested and reused by helpers.
 */

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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

/** Errors anywhere in a value become plain objects (with code and cause); cycles and BigInts can't break a log line. */
function safeLine(entry: Fields): string {
  // Only a value inside itself is a cycle: the same value twice side by side prints twice.
  const ancestors: object[] = [];
  const origin = new WeakMap<object, object>();
  return JSON.stringify(entry, function (this: object, _k, v: unknown) {
    if (typeof v === "bigint") return v.toString();
    if (!v || typeof v !== "object") return v;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.some(a => a === v || origin.get(a) === v)) return "[circular]";
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
  const level = opts.level ?? "info";
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
      const line = safeLine(entry) + "\n";
      if (toStderr) process.stderr.write(line);
      else {
        try {
          rotateIfNeeded();
          fs.appendFileSync(file, line, { mode: 0o600 });
        } catch { /* disk full, read-only… */ }
      }
      if (opts.stdout) process.stdout.write(line);
    } catch { /* an unprintable value */ }
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
