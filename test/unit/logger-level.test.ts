/**
 * EMBER_LOG_LEVEL as people type it (review #90): any case works ("WARN"), and a name that isn't a level ("warning",
 * "trace", "verbose") falls back to info, with a warning, instead of turning on every debug line.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, logLevel, type LogLevel } from "../../app/main/logger";

/** Which of a debug, an info and a warn line a logger at `level` writes. */
function written(level: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-level-"));
  const log = createLogger({ dir, level: level as LogLevel });
  log.debug("d");
  log.info("i");
  log.warn("w");
  return fs.readFileSync(log.file, "utf8").trim().split("\n").map(l => JSON.parse(l).msg);
}

describe("EMBER_LOG_LEVEL (review #90)", () => {
  it("takes a level in any case", () => {
    expect(logLevel("WARN")).toEqual({ level: "warn" });
    expect(logLevel(" Debug ")).toEqual({ level: "debug" });
    expect(logLevel("error")).toEqual({ level: "error" });
  });

  it("falls back to info for a name that isn't a level, and says which", () => {
    for (const v of ["warning", "trace", "verbose", "INFO2"]) expect(logLevel(v), v).toEqual({ level: "info", unknown: v });
    expect(logLevel(undefined)).toEqual({ level: "info" });
    expect(logLevel("")).toEqual({ level: "info" });
  });

  it("a logger given an unknown level writes as at info, never debug", () => {
    expect(written("info")).toEqual(["i", "w"]);
    expect(written("trace")).toEqual(["i", "w"]);
    expect(written("WARN")).toEqual(["w"]);
  });
});
