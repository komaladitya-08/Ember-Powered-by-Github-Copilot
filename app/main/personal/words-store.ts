/**
 * The corrections the user taught Ember ("That's not what I said", Settings › Voice › Learn my words): words.json in
 * Ember's data folder, readable by the user alone, written whole. What Ember heard and what was meant, a few words each,
 * and when: never audio, never a whole request. Forget removes one, Forget all (and Forget my voice) the file.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LearnedCorrection } from "./correct";

/** The most kept: the oldest goes first. */
export const MAX_WORDS = 100;

export interface LearnedWord extends LearnedCorrection { at: string }

const FileSchema = z.object({
  version: z.literal(1),
  words: z.array(z.object({ heard: z.string().min(1).max(80), meant: z.string().min(1).max(120), at: z.string().max(40) })).max(MAX_WORDS),
});

export interface WordsStore {
  list(): LearnedWord[];
  /** Keeps a correction (the same words heard replace the older one). */
  add(c: LearnedCorrection, now?: Date): LearnedWord[];
  /** Removes the one at `index` (as list() gave them). */
  forget(index: number): LearnedWord[];
  forgetAll(): void;
}

export function wordsStore(dir: string): WordsStore {
  const file = path.join(dir, "words.json");
  const read = (): LearnedWord[] => {
    try {
      const v = FileSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
      return v.success ? v.data.words : [];
    } catch {
      return [];
    }
  };
  const write = (words: LearnedWord[]) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, words }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    list: read,
    add(c, now = new Date()) {
      const words = [...read().filter(w => w.heard !== c.heard), { heard: c.heard.slice(0, 80), meant: c.meant.slice(0, 120), at: now.toISOString() }].slice(-MAX_WORDS);
      write(words);
      return words;
    },
    forget(index) {
      const words = read();
      if (!Number.isInteger(index) || index < 0 || index >= words.length) return words;
      words.splice(index, 1);
      if (words.length) write(words); else fs.rmSync(file, { force: true });
      return words;
    },
    forgetAll() {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    },
  };
}
