/**
 * Where Voice Match keeps the owner's voiceprint (app/voice/voiceprint.ts): voiceprint.json in Ember's data folder,
 * readable by the user alone, apart from the settings (which are shown, copied and logged more freely). It holds the
 * numbers that say how the voice sounds, and which model made them: a voiceprint from another model means nothing to
 * this one, so it counts as none (the owner teaches Ember again). Forgetting deletes the file.
 *
 * Version 2 also keeps what Voice Match learnt since (app/voice/adapt.ts): the enrolment's print as the anchor, the
 * prints of up to ADAPT.maxClips of the owner's requests, and the print in use now; numbers only, never audio. A
 * version 1 file is its enrolment alone. "Reset to my enrolment" keeps the anchor and drops the rest.
 */

import fs from "node:fs";
import path from "node:path";
import { decodePrint, encodePrint } from "../voice/voiceprint";
import { sane, type AdaptState } from "../voice/adapt";

export interface VoiceprintStore {
  /** The owner's voiceprint in use (base64), or null: none kept, or one made by another model. */
  read(): string | null;
  /** A new enrolment (base64): what was learnt before goes. */
  write(print: string): void;
  forget(): void;
  /** The enrolment and what was learnt since, or null (none kept, another model's, unreadable). */
  state(): AdaptState | null;
  /** What was learnt (the anchor stays the enrolment's). */
  writeState(s: AdaptState, learntAt: number): void;
  /** Back to the enrolment alone; false when there is none. */
  reset(): boolean;
  /** How many of the owner's requests the print learnt from, and when it last did (ms; 0: never). */
  learnt(): { clips: number; at: number };
}

export function voiceprintStore(dir: string, model: string): VoiceprintStore {
  const file = path.join(dir, "voiceprint.json");
  const load = (): { st: AdaptState; at: number } | null => {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; model?: unknown; print?: unknown; anchor?: unknown; clips?: unknown; learntAt?: unknown };
      if (v.model !== model) return null;
      const print = decodePrint(v.print);
      if (!print) return null;
      if (v.version === 1) return { st: { anchor: print, clips: [], print }, at: 0 };
      if (v.version !== 2) return null;
      const anchor = decodePrint(v.anchor);
      if (!anchor) return null;
      const clips = Array.isArray(v.clips) ? v.clips.map(c => decodePrint(c)).filter((c): c is Float32Array => !!c) : [];
      return { st: sane({ anchor, clips, print }), at: typeof v.learntAt === "number" && Number.isFinite(v.learntAt) ? v.learntAt : 0 };
    } catch {
      return null;
    }
  };
  const save = (s: AdaptState, learntAt: number) => {
    const tmp = `${file}.tmp`;
    const body = { version: 2, model, print: encodePrint(s.print), anchor: encodePrint(s.anchor), clips: s.clips.map(encodePrint), learntAt, at: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    read() {
      const l = load();
      return l ? encodePrint(l.st.print) : null;
    },
    write(print) {
      const p = decodePrint(print);
      if (!p) throw new Error("not a voiceprint");
      // As given (enrolment's print is unit length already): read() gives back the very same.
      save({ anchor: p, clips: [], print: p }, 0);
    },
    forget() {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    },
    state() {
      return load()?.st ?? null;
    },
    writeState(s, learntAt) {
      save(s, learntAt);
    },
    reset() {
      const l = load();
      if (!l) return false;
      save({ anchor: l.st.anchor, clips: [], print: l.st.anchor }, 0);
      return true;
    },
    learnt() {
      const l = load();
      return { clips: l?.st.clips.length ?? 0, at: l?.at ?? 0 };
    },
  };
}
