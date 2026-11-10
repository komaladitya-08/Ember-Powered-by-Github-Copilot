/**
 * Sign out and Forget everything each ask first, with live counts of what goes. Renderer only: confirming runs the same
 * IPC calls as before, and cancelling (or Esc) calls nothing. Each count is loading, unknown or known, so a failed read or
 * locked memory is never shown as zero; the question opens at once and refreshes from Home's own change events.
 */
import type { EmberHomeApi, MemoryView } from "../../shared/ipc";
import { FORGET_LOADING, forgetEverythingScope, signOutScope, type ForgetCounts } from "./copy";

type Field = Exclude<keyof ForgetCounts, "kept">;
const FIELDS: Field[] = ["tasks", "facts", "reminders", "routines"];
/** A read that hasn't answered by now is unknown, so a hung read never keeps the question empty. */
const READ_TIMEOUT_MS = 4000;

type Slot = { state: "loading" } | { state: "known"; n: number } | { state: "unknown" } | { state: "kept" };

/**
 * The saved facts as the questions count them. Locked or waiting memory returns no rows even when some are stored, so
 * only a ready owner's list is a count; memory main says Sign out leaves (never verified as this account's in this
 * run) is `kept` when some is saved and none when the owner waits with nothing saved (memory-11).
 */
export function factsCount(view: MemoryView | null): Slot {
  if (!view) return { state: "unknown" };
  if (view.ownership === "ready") return { state: "known", n: view.rows.length };
  if (view.erasesOnSignOut === false) return view.ownership === "locked" ? { state: "kept" } : { state: "known", n: 0 };
  return { state: "unknown" };
}
const factsSlot = factsCount;

/** Which counts the open question has: each field's newest answer wins, whether it was fetched or pushed. */
class Counts {
  private slots: Record<Field, Slot> = { tasks: { state: "loading" }, facts: { state: "loading" }, reminders: { state: "loading" }, routines: { state: "loading" } };
  private version: Record<Field, number> = { tasks: 0, facts: 0, reminders: 0, routines: 0 };
  constructor(private readonly api: EmberHomeApi, private readonly changed: () => void) {
    api.onTasks(t => this.set("tasks", tasksSlot(t)));
    api.onMemory(v => this.set("facts", factsSlot(v)));
    api.onReminders(r => this.set("reminders", { state: "known", n: r.length }));
    // A pushed list is only a hint: policy turns routines off and main then broadcasts [] with the book still stored.
    // So a push starts a fresh strict read (loading until it answers) and the older read is dropped by the version fence.
    api.onRoutines(() => this.live && this.read("routines", () => this.api.routinesCount(), c => c.known ? { state: "known", n: c.n } : { state: "unknown" }));
  }
  /** Whether its question is open; a push re-reads only then, so a closed question costs nothing. */
  private live = false;
  stop(): void { this.live = false; }
  private set(f: Field, slot: Slot, from?: number): void {
    if (from !== undefined && from !== this.version[f]) return; // a push arrived while this read was out
    if (from === undefined) this.version[f]++;
    this.slots[f] = slot;
    this.changed();
  }
  /** One field's strict read: loading now, then its answer, unknown on failure or timeout; a newer answer or read wins. */
  private read<T>(f: Field, call: () => Promise<T>, to: (v: T) => Slot): void {
    const mine = ++this.version[f];
    this.slots[f] = { state: "loading" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), READ_TIMEOUT_MS); });
    Promise.race([Promise.resolve().then(call), timeout]).then(v => to(v), (): Slot => ({ state: "unknown" }))
      .then(slot => { clearTimeout(timer); this.set(f, slot, mine); });
    this.changed();
  }
  /** Start fresh reads for all four; their slots read as loading until each answers, fails or times out. */
  refresh(): void {
    this.live = true;
    this.read("tasks", () => this.api.tasks(), tasksSlot);
    this.read("facts", () => this.api.memory(), factsSlot);
    this.read("reminders", () => this.api.reminders(), r => ({ state: "known", n: r.length }));
    this.read("routines", () => this.api.routinesCount(), c => c.known ? { state: "known", n: c.n } : { state: "unknown" });
  }
  get loading(): boolean { return FIELDS.some(f => this.slots[f].state === "loading"); }
  get view(): ForgetCounts {
    const n = (f: Field) => { const s = this.slots[f]; return s.state === "known" ? s.n : null; };
    const kept = this.slots.facts.state === "kept";
    return { tasks: n("tasks"), facts: n("facts"), reminders: n("reminders"), routines: n("routines"), ...(kept ? { kept } : {}) };
  }
}

// Queued tasks are cancelled by Sign out too, so they count with the running and waiting ones.
const tasksSlot = (tasks: { status: string }[]): Slot =>
  ({ state: "known", n: tasks.filter(t => t.status === "queued" || t.status === "running" || t.status === "waiting").length });

/** Closes whichever question is open, at once and without moving focus (the page is about to change under it). */
const dismissers = new Set<() => void>();
export function dismissForgetConfirms(): void { for (const fn of dismissers) fn(); }

/** Whether a control can take focus now: not disabled, and not hidden by itself or by any ancestor (a hidden pane too). */
const usable = (el: HTMLElement | null): el is HTMLElement => {
  if (!el || el.hidden || (el as HTMLButtonElement | HTMLInputElement).disabled) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.offsetParent !== null;
};

/** Wire both questions; `hooks` keep today's error and in-flight handling in main.ts. */
export function mountForgetConfirms(api: EmberHomeApi, hooks: { signOutFailed(err: unknown): void; deleteMemory(remove: () => Promise<unknown>): Promise<void> }): void {
  /** One question: `after` lists where focus goes if the opener disappears once the action completes. */
  const ask = (opener: string, panel: string, scope: string, yes: string, no: string, words: (c: ForgetCounts) => string, run: () => Promise<void>, after: string[], heading: string) => {
    const open = document.getElementById(opener) as HTMLButtonElement, box = document.getElementById(panel)!;
    const yesBtn = document.getElementById(yes) as HTMLButtonElement, noBtn = document.getElementById(no) as HTMLButtonElement;
    const text = document.getElementById(scope)!;
    let pending = false, restoring = false;
    const render = () => {
      if (box.hidden) return;
      const loading = counts.loading;
      box.setAttribute("aria-busy", String(loading));
      text.textContent = loading ? FORGET_LOADING : words(counts.view);
      // No confirming while the numbers are being refreshed, so what is read is what is confirmed.
      yesBtn.disabled = loading || pending;
    };
    const counts = new Counts(api, render);
    /** Everything outside the question is inert while it is up, so a pointer can't reach the page behind it. */
    let made: HTMLElement[] = [];
    const makeInert = () => {
      for (let node: HTMLElement = box; node.parentElement; node = node.parentElement) {
        for (const sib of Array.from(node.parentElement.children)) {
          if (sib !== node && sib instanceof HTMLElement && !sib.inert) { sib.inert = true; made.push(sib); }
        }
      }
    };
    /** Undo every listener and the inert marks; safe to call twice (a hidden panel, an external hide, then close). */
    const teardown = () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      for (const el of made) el.inert = false;
      made = [];
      counts.stop();
    };
    // An enabled, visible control in `after` first, else the section heading.
    const visibleAfter = () => after.map(id => document.getElementById(id)).find(usable);
    const fallback = () => visibleAfter() ?? document.getElementById(heading) ?? undefined;
    const close = (refocus: boolean) => {
      box.hidden = true;
      teardown();
      if (!refocus) return;
      // The opener may have gone while the question was up (live memory changes), so fall back to a visible control.
      const target = usable(open) ? open : fallback();
      target?.focus();
    };
    const buttons = () => [noBtn, yesBtn].filter(b => !b.disabled);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key !== "Tab") return;
      const list = buttons(), i = list.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      if (!list.length) return;
      list[(i + (e.shiftKey ? list.length - 1 : 1)) % list.length]!.focus();
    };
    const onFocusIn = (e: FocusEvent) => { if (!box.contains(e.target as Node)) noBtn.focus(); };
    open.addEventListener("click", () => {
      if (pending) return;
      restoring = false;
      box.hidden = false;
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("focusin", onFocusIn, true);
      makeInert();
      counts.refresh(); // renders the loading state first
      render();
      noBtn.focus(); // the safe choice first, even while loading
    });
    noBtn.addEventListener("click", () => close(true));
    yesBtn.addEventListener("click", () => {
      if (pending || counts.loading) return;
      close(false);
      pending = true; restoring = true;
      if (!open.hidden) open.focus();
      void run().finally(() => { pending = false; restoreIfGone(); });
    });
    /** A successful action hides its opener; focus then goes to the first visible control in `after`, never nowhere. */
    const restoreIfGone = () => {
      if (!restoring || !open.hidden) return;
      const lost = document.activeElement === document.body || document.activeElement === open || !document.activeElement;
      if (!lost) { restoring = false; return; }
      const next = fallback();
      if (next) { next.focus(); restoring = false; }
    };
    // Hidden from outside (not by close): drop the trap so nothing stays inert or listening.
    dismissers.add(() => { if (!box.hidden) { box.hidden = true; teardown(); } });
    new MutationObserver(() => { if (box.hidden) teardown(); }).observe(box, { attributes: true, attributeFilter: ["hidden"] });
    new MutationObserver(restoreIfGone).observe(open, { attributes: true, attributeFilter: ["hidden"] });
  };
  ask("sign-out", "sign-out-confirm", "sign-out-scope", "sign-out-yes", "sign-out-no", signOutScope,
    () => api.signOut().catch(hooks.signOutFailed), ["sign-in", "retry"], "copilot-h");
  ask("memory-forget-all", "forget-all-confirm", "forget-all-scope", "forget-all-yes", "forget-all-no", forgetEverythingScope,
    // Then Memory's heading, never its switch, where a stray space would turn memory off (memory-c2-1).
    () => hooks.deleteMemory(() => api.forgetAllMemory()), [], "memory-h");
}
