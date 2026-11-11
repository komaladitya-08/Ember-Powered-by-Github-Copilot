/**
 * Where Ember's memory lives: memory.json in Ember's data folder, readable by the user alone (mode 0600, in the 0700
 * folder), apart from the settings, which are shown and logged more freely (as voiceprint-store.ts does for Voice
 * Match). Written whole to a temporary file and renamed, so a crash never leaves half a file.
 *
 * A file that can't be read as memory is moved aside (memory.json.broken) rather than overwritten, and Ember starts
 * with an empty memory: nothing the user taught it is destroyed by a bad write or a hand edit. The first copy set aside
 * is never written over: a file that breaks later goes beside it (memory.json.broken.2, the latest only), since the
 * first is the memory the user had (memory-r7-2). A file that is there but
 * out of reach (a virus scan's lock, a permission) is neither: it is tried again, and if it stays out of reach this run
 * saves nothing over it, so the next start finds it whole.
 */

import fs from "node:fs";
import path from "node:path";
import { MemoryDataSchema, MemoryGraph, SYSTEM_CLOCK, type GraphClock } from "./graph";

export interface MemoryFile {
  /** The memory kept, or an empty one (none kept yet, a broken file, which is moved aside, or one out of reach for now). */
  load(clock?: GraphClock): MemoryGraph;
  /** Throws, changing nothing, while the file load found is out of reach. */
  save(graph: MemoryGraph): void;
  /** Deletes the file (and every broken copy): "Forget everything". */
  erase(): void;
  readonly path: string;
}

/** A locked file usually comes free in moments (Windows: EBUSY or EPERM while a scanner holds it). */
const READ_TRIES = 3;
const READ_WAIT_MS = 50;

function readPatiently(file: string): string {
  for (let tries = 1; ; tries++) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || tries >= READ_TRIES) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_WAIT_MS);
    }
  }
}

/**
 * `onBroken`: memory.json couldn't be used as it was: `out-of-reach` (there, but couldn't be read: left as it is) or
 * `moved-aside` (not memory: moved to memory.json.broken, and memory starts empty).
 */
export function memoryFile(dir: string, onBroken?: (err: unknown, how: "out-of-reach" | "moved-aside") => void): MemoryFile {
  const file = path.join(dir, "memory.json");
  /** load couldn't reach the file: what this run holds is not what the file holds. */
  let outOfReach = false;
  return {
    path: file,
    load(clock: GraphClock = SYSTEM_CLOCK) {
      outOfReach = false;
      let raw: string;
      try {
        raw = readPatiently(file);
      } catch (err) {
        // None kept yet, or there and out of reach: only absence means there is nothing to keep.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") { outOfReach = true; onBroken?.(err, "out-of-reach"); }
        return new MemoryGraph(undefined, clock);
      }
      try {
        return new MemoryGraph(MemoryDataSchema.parse(JSON.parse(raw)), clock);
      } catch (err) {
        try { fs.renameSync(file, fs.existsSync(`${file}.broken`) ? `${file}.broken.2` : `${file}.broken`); } catch { /* left where it is: save() will replace it */ }
        onBroken?.(err, "moved-aside");
        return new MemoryGraph(undefined, clock);
      }
    },
    save(graph) {
      if (outOfReach) throw new Error("memory.json could not be read, so it is left as it is");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      // Flushed before the rename: a power cut must not leave an empty file in place of the memory.
      fs.writeFileSync(tmp, JSON.stringify(graph.toJSON()) + "\n", { mode: 0o600, flush: true });
      fs.renameSync(tmp, file);
    },
    erase() {
      for (const f of [file, `${file}.tmp`, `${file}.broken`, `${file}.broken.2`]) fs.rmSync(f, { force: true });
      outOfReach = false;
    },
  };
}
