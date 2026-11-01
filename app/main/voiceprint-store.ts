/**
 * Where Voice Match keeps the owner's voiceprint (app/voice/voiceprint.ts): voiceprint.json in Ember's data folder,
 * readable by the user alone, apart from the settings (which are shown, copied and logged more freely). It holds 256
 * numbers that say how the voice sounds, and which model made them: a voiceprint from another model means nothing to
 * this one, so it counts as none (the owner teaches Ember again). Forgetting deletes the file.
 */

import fs from "node:fs";
import path from "node:path";
import { decodePrint } from "../voice/voiceprint";

export interface VoiceprintStore {
  /** The owner's voiceprint (base64), or null: none kept, or one made by another model. */
  read(): string | null;
  write(print: string): void;
  forget(): void;
}

export function voiceprintStore(dir: string, model: string): VoiceprintStore {
  const file = path.join(dir, "voiceprint.json");
  return {
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; model?: unknown; print?: unknown };
        return v.version === 1 && v.model === model && decodePrint(v.print) ? (v.print as string) : null;
      } catch {
        return null;
      }
    },
    write(print) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, model, print, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    forget() {
      fs.rmSync(file, { force: true });
    },
  };
}
