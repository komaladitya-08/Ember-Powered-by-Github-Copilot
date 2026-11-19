/** Select once, before any coding data is allocated or desktop tool gates are built. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodingStorageBase {
  /** Canonical common parent. Null means coding must not allocate private storage. */
  readonly common: string | null;
  /** Both spellings are Ember data, including before the common directory exists. */
  readonly protectedPaths: readonly string[];
}

export function selectCodingStorageBase(): CodingStorageBase {
  const name = `ember-coding-${process.getuid?.() ?? "unsupported"}`;
  const temporary = path.resolve(os.tmpdir());
  const logical = path.join(temporary, name);
  let common: string | null = null;
  try { common = path.join(fs.realpathSync.native(temporary), name); } catch { /* No canonical location: no allocation. */ }
  return Object.freeze({ common, protectedPaths: Object.freeze([...new Set([logical, ...(common ? [common] : [])])]) });
}
