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
  const seen = new WeakSet<object>();
  return JSON.stringify(entry, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Error) {
      const e = v as Error & { code?: unknown; cause?: unknown };
      return { name: e.name, message: e.message, stack: e.stack, ...(e.code !== undefined ? { code: e.code } : {}), ...(e.cause !== undefined ? { cause: e.cause } : {}) };
    }
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  });
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? "info";
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  const now = opts.now ?? (() => new Date());
  const file = path.join(opts.dir, "ember.log");
  // Private: logs mention apps and windows the user worked in.
  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });

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
      const entry: Fields = { t: now().toISOString(), level: lvl, msg };
      if (scope) entry.scope = scope;
      Object.assign(entry, fields ?? {});
      const line = safeLine(entry) + "\n";
      try {
        rotateIfNeeded();
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch { /* disk full, read-only… */ }
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
