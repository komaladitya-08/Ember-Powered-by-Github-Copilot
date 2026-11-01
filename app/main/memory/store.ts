/**
 * Where Ember's memory lives: memory.json in Ember's data folder, readable by the user alone (mode 0600, in the 0700
 * folder), apart from the settings, which are shown and logged more freely (as voiceprint-store.ts does for Voice
 * Match). Written whole to a temporary file and renamed, so a crash never leaves half a file.
 *
 * A file that can't be read as memory is moved aside (memory.json.broken) rather than overwritten, and Ember starts
 * with an empty memory: nothing the user taught it is destroyed by a bad write or a hand edit.
 */

import fs from "node:fs";
import path from "node:path";
import { MemoryDataSchema, MemoryGraph, SYSTEM_CLOCK, type GraphClock } from "./graph";

export interface MemoryFile {
  /** The memory kept, or an empty one (none kept yet, or a broken file, which is moved aside). */
  load(clock?: GraphClock): MemoryGraph;
  save(graph: MemoryGraph): void;
  /** Deletes the file (and any broken copy): "Forget everything". */
  erase(): void;
  readonly path: string;
}

export function memoryFile(dir: string, onBroken?: (err: unknown) => void): MemoryFile {
  const file = path.join(dir, "memory.json");
  return {
    path: file,
    load(clock: GraphClock = SYSTEM_CLOCK) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        // None kept yet.
        return new MemoryGraph(undefined, clock);
      }
      try {
        return new MemoryGraph(MemoryDataSchema.parse(JSON.parse(raw)), clock);
      } catch (err) {
        try { fs.renameSync(file, `${file}.broken`); } catch { /* left where it is: save() will replace it */ }
        onBroken?.(err);
        return new MemoryGraph(undefined, clock);
      }
    },
    save(graph) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(graph.toJSON()) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    erase() {
      for (const f of [file, `${file}.tmp`, `${file}.broken`]) fs.rmSync(f, { force: true });
    },
  };
}
