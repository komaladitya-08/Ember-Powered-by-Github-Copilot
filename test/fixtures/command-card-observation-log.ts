/** Bounded first-failure projection of the owned packaged profile's numeric card diagnostics; never prints a log line. */
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { COMMAND_CARD_OBSERVATION_RANGES } from "../../app/shared/command-card-observation";

export interface PackagedCommandCardObservation {
  schema: 1; known: number; card: number; sample: number; source: number; model: number; ui: number;
  geometry: number; arm: number; capped: number; host: number;
  /** Folded over the last card's records: 1 a record measured the page visible, 2 the last one did, 4 it went from visible to hidden. */
  visibility: number;
  /**
   * Set by the packaged journey when an answer's click was not taken: what UI Automation finds under the click point.
   * 1 the answer button or something inside it, 2 something else in the command window, 3 another program's,
   * 4 nothing it may read, 5 another window of Ember's; 0 not asked.
   */
  under: number;
}
const empty = (capped = 0): Readonly<PackagedCommandCardObservation> => Object.freeze({ schema: 1, known: 0, card: 0, sample: 0, source: 0,
  model: 0, ui: 0, geometry: 0, arm: 0, capped, host: 0, visibility: 0, under: 0 });
const RANGES = { ...COMMAND_CARD_OBSERVATION_RANGES, card: [1, 40], sample: [1, 16], host: [0, 7] } as const;
const MAX_TAIL = 256 * 1024;

/** At most 64 complete, closed numeric records. Partial, malformed, conflicting or capped evidence stays unknown. */
export function parseCommandCardObservationLog(value: unknown): Readonly<PackagedCommandCardObservation> {
  try {
    if (!value || types.isProxy(value) || !Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Buffer.prototype ||
        ["length", "byteLength", "byteOffset", "buffer", "toString", "utf8Slice"].some(name => Object.getOwnPropertyDescriptor(value, name)) || value.length > MAX_TAIL) return empty();
    const text = Buffer.prototype.toString.call(value, "utf8");
    if (!Buffer.prototype.equals.call(Buffer.from(text, "utf8"), value)) return empty();
    const lines = text.split("\n"), final = lines.pop();
    if (final?.includes("commands.card_observation")) return empty();
    let last: PackagedCommandCardObservation | undefined, count = 0, visibility = 0, wasVisible = false;
    for (const line of lines) {
      if (!line.includes("commands.card_observation")) continue;
      if (line.length > 4096) return empty();
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) return empty();
      const own = (key: string): unknown => Object.getOwnPropertyDescriptor(row, key)?.value;
      if (own("msg") !== "commands.card_observation") continue;
      if (++count > 64) return empty(1);
      const keys = Reflect.ownKeys(row), allowed = [...Object.keys(RANGES), "t", "level", "msg", "scope"];
      if (keys.length !== allowed.length || keys.some(key => typeof key !== "string" || !allowed.includes(key)) || own("level") !== "info"
          || typeof own("t") !== "string" || typeof own("scope") !== "string") return empty();
      const data: Record<string, number> = {};
      for (const [key, [minimum, maximum]] of Object.entries(RANGES)) {
        const field = own(key);
        if (typeof field !== "number" || !Number.isInteger(field) || field < minimum || field > maximum) return empty();
        data[key] = field;
      }
      if (data.capped === 1 || data.sample >= 16) return empty(1);
      const next: PackagedCommandCardObservation = { schema: 1, known: 1, card: data.card, sample: data.sample, source: data.source, model: data.model,
        ui: data.ui, geometry: data.geometry, arm: data.arm, capped: data.capped, host: data.host, visibility: 0, under: 0 };
      if (last && (next.card < last.card || next.card === last.card && next.sample < last.sample)) return empty();
      if (last && next.card === last.card && next.sample === last.sample && Object.keys(next).some(key => key !== "visibility" && key !== "under" && next[key as keyof typeof next] !== last![key as keyof typeof next])) return empty();
      if (!last || next.card !== last.card) { visibility = 0; wasVisible = false; }
      const visible = (next.geometry & 16) !== 0; // COMMAND_CARD_OBSERVATION_BITS.geometry.visible
      visibility = (visibility & 5) | (visible ? 3 : 0) | (wasVisible && !visible ? 4 : 0);
      wasVisible = visible; next.visibility = visibility;
      last = next;
    }
    return last ? Object.freeze(last) : empty();
  } catch { return empty(); }
}

/** One held ordinary-file read, no retries or rotation scan; capture must run before the fixture begins cleanup. */
export function readCommandCardObservationLog(profile: string): Readonly<PackagedCommandCardObservation> {
  let descriptor: number | undefined, result = empty();
  try {
    const directory = fs.lstatSync(profile);
    if (!directory.isDirectory() || directory.isSymbolicLink() || fs.realpathSync.native(profile) !== profile) return result;
    const logs = path.join(profile, "logs"), logDirectory = fs.lstatSync(logs);
    if (!logDirectory.isDirectory() || logDirectory.isSymbolicLink() || fs.realpathSync.native(logs) !== logs) return result;
    const file = path.join(logs, "ember.log"), original = fs.lstatSync(file);
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || !Number.isSafeInteger(original.size) || original.size < 0 || original.size > 16 * 1024 * 1024) return result;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== original.dev || before.ino !== original.ino || before.size !== original.size) return result;
    const start = Math.max(0, before.size - MAX_TAIL), bytes = Buffer.alloc(before.size - start);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, start) !== bytes.length) return result;
    const after = fs.fstatSync(descriptor), named = fs.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1
        || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size
        || fs.realpathSync.native(profile) !== profile || fs.realpathSync.native(logs) !== logs) return result;
    const firstLine = start > 0 ? bytes.indexOf(10) : -1;
    if (start > 0 && firstLine < 0) return result;
    result = parseCommandCardObservationLog(firstLine >= 0 ? bytes.subarray(firstLine + 1) : bytes);
  } catch { /* Unknown never changes the packaged test's original failure or cleanup. */ }
  finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { result = empty(); } } }
  return result;
}
