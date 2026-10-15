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

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? "info";
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  const now = opts.now ?? (() => new Date());
  const file = path.join(opts.dir, "ember.log");
  fs.mkdirSync(opts.dir, { recursive: true });

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
    if (ORDER[lvl] < ORDER[level]) return;
    const entry: Fields = { t: now().toISOString(), level: lvl, msg };
    if (scope) entry.scope = scope;
    for (const [k, v] of Object.entries(fields ?? {})) entry[k] = serialize(v);
    const line = JSON.stringify(entry) + "\n";
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, line);
    } catch {
      // Logging must never take the app down.
    }
    if (opts.stdout) process.stdout.write(line);
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
