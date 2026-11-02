/**
 * Reminders the user asks for ("remind me in 20 minutes to call Priya", "at 3 pm, tell me to stand up"): the first of
 * the Jarvis research's bounded interjections (J4). Plain TypeScript decides when one is due, never a model, and a
 * reminder only ever tells the user something: it never starts a task or acts in an app.
 *
 * Two limits keep it safe and private:
 * - Only the user's own words set one: a reminder whose words aren't mostly in what the user said this turn is refused
 *   (`ownWords`, as memory does), so text on the screen, in a file or in a task result can't plant one.
 * - Reminders live in memory only, never on disk, so Ember keeps nothing new (CLAUDE.md "Consent"); they end when Ember
 *   quits, and the conductor says so when it sets one.
 */

import crypto from "node:crypto";
import { ownWords } from "../memory/service";

/** One reminder: its words (the user's), when it is due (the clock's ms) and when it was set. */
export interface Reminder { id: string; text: string; at: number; created: number }

/** At most this many waiting at once. */
export const MAX_REMINDERS = 20;
/** The furthest ahead a reminder may be set: a week (and setTimeout's limit is about 24.8 days). */
export const MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** A reminder's words, at most. */
export const MAX_TEXT = 200;

/** When a reminder is due, from minutes from now or a local clock time ("15:30", "3:30 pm"): its ms, or why not. */
export function reminderTime(a: { minutes?: number; at?: string }, now: number): number | string {
  if (a.minutes !== undefined) {
    if (!Number.isFinite(a.minutes) || a.minutes < 1) return "A reminder needs at least a minute.";
    const at = now + Math.round(a.minutes) * 60_000;
    return at - now > MAX_AHEAD_MS ? "Reminders can be at most a week ahead." : at;
  }
  if (a.at === undefined) return "Give minutes or at.";
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(a.at);
  if (!m) return `Couldn't read the time “${a.at.slice(0, 20)}”: give it as HH:MM.`;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const half = m[3]?.toLowerCase().replace(/\./g, "");
  if (half) { if (h < 1 || h > 12) return "That isn't a time of day."; h = (h % 12) + (half === "pm" ? 12 : 0); }
  if (h > 23 || min > 59) return "That isn't a time of day.";
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  // Already past today: the same time tomorrow.
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** A time as people say it, in the user's locale ("3:30 PM"). */
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "today at 3:30 PM", "tomorrow at 9:00 AM", or the weekday further ahead. */
export function whenWords(at: number, now: number): string {
  const day = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  const on = days <= 0 ? "today" : days === 1 ? "tomorrow" : new Date(at).toLocaleDateString([], { weekday: "long" });
  return `${on} at ${clockTime(at)}`;
}

export interface RemindersOptions {
  /** A reminder is due: tell the user (it has already left the list). */
  onDue: (r: Reminder) => void;
  now?: () => number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

/** The user's reminders while Ember runs. */
export class Reminders {
  private items = new Map<string, { r: Reminder; timer: ReturnType<typeof setTimeout> }>();
  private readonly now: () => number;
  private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout };

  constructor(private o: RemindersOptions) {
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? { set: setTimeout, clear: clearTimeout };
  }

  /**
   * Sets a reminder for `text` at `at`, when `said` (what the user said this turn) holds its words. Returns it, or a
   * sentence saying why not (for the model to tell the user).
   */
  add(text: string, at: number, said: string): Reminder | string {
    const t = text.trim().replace(/\s+/g, " ");
    if (!t) return "A reminder needs words.";
    if (t.length > MAX_TEXT) return `Keep the reminder under ${MAX_TEXT} characters.`;
    // Only the user's own request sets a reminder: never words from the screen, a file or a task result.
    if (!ownWords(t, said)) return "Not set: a reminder must use the user's own words from this request. Use their words, or ask them what to remind them of.";
    if (this.items.size >= MAX_REMINDERS) return `Not set: ${MAX_REMINDERS} reminders are already waiting. The user can cancel one first.`;
    const now = this.now();
    if (at - now > MAX_AHEAD_MS) return "Reminders can be at most a week ahead.";
    const r: Reminder = { id: crypto.randomBytes(3).toString("hex"), text: t, at: Math.max(at, now), created: now };
    const timer = this.timers.set(() => this.due(r.id), Math.max(0, r.at - now));
    (timer as { unref?: () => void }).unref?.();
    this.items.set(r.id, { r, timer });
    return r;
  }

  /** The reminders waiting, soonest first. */
  list(): Reminder[] {
    return [...this.items.values()].map(i => i.r).sort((a, b) => a.at - b.at);
  }

  /** Cancels one by its id; false when there is none. */
  cancel(id: string): boolean {
    const i = this.items.get(id);
    if (!i) return false;
    this.timers.clear(i.timer);
    this.items.delete(id);
    return true;
  }

  /** Every reminder goes (sign-out, quit). */
  clear(): void {
    for (const i of this.items.values()) this.timers.clear(i.timer);
    this.items.clear();
  }

  private due(id: string): void {
    const i = this.items.get(id);
    if (!i) return;
    this.items.delete(id);
    this.o.onDue(i.r);
  }
}
