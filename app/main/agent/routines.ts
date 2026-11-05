/**
 * Routines and lasting reminders (the Jarvis research's J3/J4: JARVIS's "House Party Protocol", done safely). A
 * routine is a name the user gives to a few requests in their own words ("start my day": "open Mail", "show today's
 * calendar"); saying the name later runs them as if the user had just asked each one. With routines on, reminders also
 * survive a restart.
 *
 * What keeps it safe:
 * - Only the user's own words make a routine: its name and each of its steps must be mostly in what they said that turn
 *   (`ownWords`, as memory and reminders), so the screen, a file or a task result can't plant one, nor add a step to
 *   one the user is saving.
 * - Only the user's own words run or delete one: its name must be in what they said (conductor.ts).
 * - Running one never skips a question: its steps start as ordinary tasks, checked by the policy against what the user
 *   says when they run it and the routine's steps (their own words when they saved it), so every risky step asks, every
 *   time, with the usual question.
 * - Nothing is kept until the user turns routines on and agrees to their note (FEATURE_CONSENT_VERSION.routines), and the
 *   organisation can turn them off. routines.json is the user's alone (0600, in the 0700 data folder), written whole, and
 *   a broken file is moved aside, never overwritten.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ownWords } from "../memory/service";
import { MAX_REMINDERS, MAX_TEXT, type Reminder } from "./reminders";

/** One routine: its name and its steps, each a request in the user's words. */
export interface Routine { id: string; name: string; steps: string[]; created: number }

export const MAX_ROUTINES = 30;
export const MAX_STEPS = 8;
export const MAX_NAME = 60;

const RoutineSchema = z.object({
  id: z.string().min(1).max(20), name: z.string().min(1).max(MAX_NAME),
  steps: z.array(z.string().min(1).max(MAX_TEXT)).min(1).max(MAX_STEPS), created: z.number().int().nonnegative(),
});
const ReminderSchema = z.object({ id: z.string().min(1).max(20), text: z.string().min(1).max(MAX_TEXT), at: z.number().int().nonnegative(), created: z.number().int().nonnegative() });
const FileSchema = z.object({
  version: z.literal(1),
  routines: z.array(RoutineSchema).max(MAX_ROUTINES),
  reminders: z.array(ReminderSchema).max(MAX_REMINDERS),
});
type Data = z.infer<typeof FileSchema>;
const EMPTY = (): Data => ({ version: 1, routines: [], reminders: [] });

export interface RoutinesFile {
  load(): Data;
  save(d: Data): void;
  erase(): void;
  readonly path: string;
}

/** How many routines are stored: a number, or unknown when the file can't be read or isn't valid. */
export type StoredRoutinesCount = { known: true; n: number } | { known: false };

/**
 * Counts the routines in routines.json without touching it: no rename of a broken file, no file or folder made, and
 * whatever the admin's policy says (sign-out deletes them all the same). Missing is none; anything else wrong is unknown.
 */
export function countStoredRoutines(dir: string, onFailed?: (err: unknown) => void): StoredRoutinesCount {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "routines.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { known: true, n: 0 };
    onFailed?.(err);
    return { known: false };
  }
  try {
    return { known: true, n: FileSchema.parse(JSON.parse(raw)).routines.length };
  } catch (err) {
    onFailed?.(err);
    return { known: false };
  }
}

/** routines.json in Ember's data folder (as memory.json: 0600, written whole, a broken one moved aside). */
export function routinesFile(dir: string, onBroken?: (err: unknown) => void): RoutinesFile {
  const file = path.join(dir, "routines.json");
  return {
    path: file,
    load() {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (err) {
        // None kept yet. Any other failure (no permission, a folder in its place) is thrown: read as empty, the next
        // save would replace what the user kept.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY();
        throw err;
      }
      try {
        return FileSchema.parse(JSON.parse(raw));
      } catch (err) {
        // Moved aside under a name of its own, so a second broken file never replaces the first.
        try { fs.renameSync(file, brokenName(file)); } catch { /* left where it is: save() will replace it */ }
        onBroken?.(err);
        return EMPTY();
      }
    },
    save(d) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(d) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    erase() {
      const broken = (() => { try { return fs.readdirSync(dir).filter(f => f.startsWith("routines.json.broken")); } catch { return []; } })();
      for (const f of [file, `${file}.tmp`, ...broken.map(b => path.join(dir, b))]) fs.rmSync(f, { force: true });
    },
  };
}

/** Where a broken routines.json goes: `routines.json.broken`, or `.broken-2`, `.broken-3`… when that is taken. */
function brokenName(file: string): string {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? `${file}.broken` : `${file}.broken-${n}`;
    if (!fs.existsSync(name)) return name;
  }
  return `${file}.broken-${Date.now()}`;
}

/** A routine's name as matched: lower case, curly apostrophes straight, quotes and end punctuation gone. */
export const routineKey = (name: string) => name.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/["“”]/g, "").replace(/[\s.!?…]+$/u, "").replace(/\s+/g, " ");

/** The user's routines and lasting reminders, read from the file when first used. */
export class RoutineBook {
  private data: Data | null = null;
  private readonly now: () => number;

  constructor(private o: { file: RoutinesFile; now?: () => number; onChange?: () => void }) {
    this.now = o.now ?? Date.now;
  }

  private get d(): Data {
    this.data ??= this.o.file.load();
    return this.data;
  }

  /** Saves `next` and only then keeps it: a write that fails changes nothing (and throws). */
  private write(next: Data): void {
    this.o.file.save(next);
    this.data = next;
    this.notify();
  }

  /** An observer cannot roll back a committed book or prevent its live reminders from catching up. */
  private notify(): void {
    try { this.o.onChange?.(); } catch { /* The next explicit list read reconciles a detached view. */ }
  }

  list(): Routine[] {
    return [...this.d.routines];
  }

  /** The routine called `name` (however it is cased or quoted), if any. */
  find(name: string): Routine | undefined {
    const key = routineKey(name);
    return this.d.routines.find(r => routineKey(r.name) === key);
  }

  /**
   * Saves a routine when `said` (what the user said this turn) holds its name and steps: one with the same name is
   * replaced. Returns it, or a sentence for the model saying why not.
   */
  save(name: string, steps: string[], said: string): Routine | string {
    const n = name.trim().replace(/\s+/g, " ");
    const s = steps.map(x => x.trim().replace(/\s+/g, " ")).filter(Boolean);
    if (!n || n.length > MAX_NAME) return `A routine needs a name of at most ${MAX_NAME} characters.`;
    if (!s.length || s.length > MAX_STEPS) return `A routine has 1 to ${MAX_STEPS} steps.`;
    if (s.some(x => x.length > MAX_TEXT)) return `Keep each step under ${MAX_TEXT} characters.`;
    // Only the user's own request makes a routine: never steps from the screen, a file or a task result.
    // Each step on its own: checked together, a step the screen planted would ride along with the user's.
    if (!ownWords(n, said) || !s.every(x => ownWords(x, said))) return "Not saved: a routine's name and each of its steps must be the user's own words from this request. Ask them to say the steps.";
    const old = this.find(n);
    if (!old && this.d.routines.length >= MAX_ROUTINES) return `Not saved: ${MAX_ROUTINES} routines are already kept. The user can delete one first.`;
    const r: Routine = { id: old?.id ?? crypto.randomBytes(3).toString("hex"), name: n, steps: s, created: this.now() };
    this.write({ ...this.d, routines: [...this.d.routines.filter(x => x !== old), r] });
    return r;
  }

  /** Forgets one routine by its id; false when there is none. */
  forget(id: string): boolean {
    const routines = this.d.routines.filter(r => r.id !== id);
    if (routines.length === this.d.routines.length) return false;
    this.write({ ...this.d, routines });
    return true;
  }

  /** Forgets every routine and lasting reminder, and the file. */
  forgetAll(): void {
    this.o.file.erase();
    this.data = EMPTY();
    this.notify();
  }

  /** The reminders kept for the next run. */
  reminders(): Reminder[] {
    return [...this.d.reminders];
  }

  /** Keeps `list` as the reminders waiting (each change to Reminders). */
  setReminders(list: readonly Reminder[]): void {
    this.write({ ...this.d, reminders: list.slice(0, MAX_REMINDERS).map(r => ({ id: r.id, text: r.text, at: r.at, created: r.created })) });
  }
}

/** What run_routine tells the conductor: the steps, in the user's words, to start in order. */
export function routineSteps(r: Routine): string {
  return `The user's routine “${r.name}”, in their own words when they saved it:\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nTell the user in a few words you're running it, then do each step as if they had just asked it (start_task, show_me, set_reminder, or an answer), in order. Ember still asks before anything risky.`;
}
