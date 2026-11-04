/** Home edits remain bound to the shown reminder and a failed persistence change never cancels its timer. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reminders, type Reminder } from "../../app/main/agent/reminders";
import { RoutineBook, type RoutinesFile } from "../../app/main/agent/routines";
import { ReminderChangeSchema } from "../../app/shared/reminders";
import { localReminderTime } from "../../app/renderer/home/reminders";

const NOW = new Date(2026, 10, 4, 10, 0).getTime();
const add = (r: Reminders, text = "Call Priya") => r.add(text, NOW + 120_000, text) as Reminder;
describe("Home reminder edits (UX12)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("cancels just the selected reminder after the persisted list is saved", () => {
    const due: Reminder[] = [], lists: Reminder[][] = [];
    const r = new Reminders({ onDue: x => due.push(x), onList: x => lists.push(x) });
    const first = add(r), second = add(r, "Stand up");
    let saved: Reminder[] = [];
    expect(r.change(first, null, next => { saved = next; expect(r.list()).toHaveLength(2); })).toBe(true);
    expect(saved).toEqual([second]);
    expect(lists.at(-1)).toEqual([second]);
    vi.advanceTimersByTime(120_000);
    expect(due).toEqual([second]);
  });

  it("leaves the original timer and words intact after a failed save, then allows retry", () => {
    const due: Reminder[] = [], r = new Reminders({ onDue: x => due.push(x) }), original = add(r);
    expect(() => r.change(original, { text: "Call Morgan", at: NOW + 180_000 }, () => { throw new Error("disk full"); })).toThrow("disk full");
    expect(r.list()).toEqual([original]);
    expect(r.change(original, { text: "Call Morgan", at: NOW + 180_000 }, () => undefined)).toBe(true);
    vi.advanceTimersByTime(120_000); expect(due).toEqual([]);
    vi.advanceTimersByTime(60_000); expect(due.map(x => x.text)).toEqual(["Call Morgan"]);
  });

  it("rejects stale edits and expired records rather than overwriting a newer reminder", () => {
    const r = new Reminders({ onDue: () => undefined }), original = add(r);
    expect(r.change(original, { text: "New reminder", at: NOW + 180_000 }, () => undefined)).toBe(true);
    let written = false;
    expect(r.change(original, null, () => { written = true; })).toBe(false);
    expect(written).toBe(false);
    vi.advanceTimersByTime(180_000);
    expect(r.change(original, null, () => { written = true; })).toBe(false);
    expect(written).toBe(false);
  });

  it("persists an explicit Home edit once and doesn't turn a committed timer into a reported failure", () => {
    const r = new Reminders({ onDue: () => undefined }), original = add(r);
    let commits = 0;
    r.setOnChange(() => { throw new Error("A second save must not run"); });
    expect(r.change(original, { text: "Call Morgan", at: NOW + 180_000 }, () => { commits++; })).toBe(true);
    expect(commits).toBe(1);
    expect(r.list()[0].text).toBe("Call Morgan");
  });

  it("reconciles edits and cancellations after a committed book's observer fails", () => {
    let stored: ReturnType<RoutinesFile["load"]> = { version: 1, routines: [], reminders: [] };
    const file: RoutinesFile = { path: "/test/routines.json", load: () => structuredClone(stored), save: next => { stored = structuredClone(next); }, erase: () => undefined };
    const book = new RoutineBook({ file, onChange: () => { throw new Error("detached view"); } });
    const due: Reminder[] = [], r = new Reminders({ onDue: row => due.push(row) }), original = add(r);
    book.setReminders(r.list());
    expect(r.change(original, { text: "Call Morgan", at: NOW + 180_000 }, next => book.setReminders(next))).toBe(true);
    expect(r.list()).toEqual(stored.reminders);
    expect(book.reminders()).toEqual(stored.reminders);
    expect(r.change(r.list()[0], null, next => book.setReminders(next))).toBe(true);
    expect(stored.reminders).toEqual([]);
    expect(book.reminders()).toEqual([]);
    expect(r.list()).toEqual([]);
    vi.advanceTimersByTime(180_000);
    expect(due).toEqual([]);
  });

  it("clears live reminders after durable bulk erasure even when the book's observer fails", () => {
    let erased = false;
    const file: RoutinesFile = { path: "/test/routines.json", load: () => ({ version: 1, routines: [], reminders: [] }), save: () => undefined, erase: () => { erased = true; } };
    const book = new RoutineBook({ file, onChange: () => { throw new Error("detached view"); } });
    const due: Reminder[] = [], r = new Reminders({ onDue: row => due.push(row) });
    add(r); book.setReminders(r.list());
    book.save("Morning", ["stand up"], "Morning stand up");
    expect(() => { book.forgetAll(); r.clear(); }).not.toThrow();
    expect(erased).toBe(true);
    expect(book.list()).toEqual([]);
    expect(book.reminders()).toEqual([]);
    expect(r.list()).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(due).toEqual([]);
  });

  it("refuses invalid and distant times without removing the waiting reminder", () => {
    const r = new Reminders({ onDue: () => undefined }), original = add(r);
    for (const at of [NaN, NOW - 1, NOW, NOW + 8 * 86_400_000]) {
      expect(() => r.change(original, { text: "Call Priya", at }, () => undefined)).toThrow(/future time/);
      expect(r.list()).toEqual([original]);
    }
    expect(() => r.change(original, { text: " ", at: NOW + 180_000 }, () => undefined)).toThrow();
  });

  it("keeps live-list observation independent of persistence and doesn't erase lasting reminders on quit", () => {
    const observed: Reminder[][] = [], saved: Reminder[][] = [];
    const r = new Reminders({ onDue: () => undefined, onList: next => observed.push(next) });
    const original = add(r);
    r.setOnChange(next => saved.push(next));
    r.restore([original]);
    expect(observed.at(-1)).toEqual([original]);
    r.clear();
    expect(observed.at(-1)).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("does not claim a bulk deletion or discard the book's in-memory state when erase fails", () => {
    const file: RoutinesFile = { path: "/test/routines.json", load: () => ({ version: 1, routines: [], reminders: [] }), save: () => undefined, erase: () => { throw new Error("disk denied"); } };
    const book = new RoutineBook({ file });
    book.save("Morning", ["stand up"], "Morning stand up");
    expect(() => book.forgetAll()).toThrow("disk denied");
    expect(book.list().map(x => x.name)).toEqual(["Morning"]);
  });

  it("validates complete exact identities and formats datetime-local without a UTC shift", () => {
    const expected = { id: "abc123", text: "Call Priya", at: NOW + 120_000, created: NOW };
    expect(ReminderChangeSchema.safeParse({ expected, replacement: null }).success).toBe(true);
    expect(ReminderChangeSchema.safeParse({ expected: { id: "abc123" }, replacement: null }).success).toBe(false);
    expect(ReminderChangeSchema.safeParse({ expected, replacement: { text: "Call Priya", at: Infinity } }).success).toBe(false);
    expect(localReminderTime(NOW)).toBe("2026-11-04T10:00");
  });
});
