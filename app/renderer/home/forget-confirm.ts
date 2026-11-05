/**
 * Sign out and Forget everything each ask first, with live counts of what goes. Renderer only: confirming runs the same
 * IPC calls as before, and cancelling (or Esc) calls nothing.
 */
import type { EmberHomeApi } from "../../shared/ipc";
import { forgetEverythingScope, signOutScope, type ForgetCounts } from "./copy";

/** Counts read afresh from main; a read that fails counts as 0 rather than blocking the question. */
async function readCounts(api: EmberHomeApi): Promise<ForgetCounts> {
  const [tasks, memory, reminders, routines] = await Promise.all([
    api.tasks().catch(() => []), api.memory().catch(() => null), api.reminders().catch(() => []), api.routines().catch(() => []),
  ]);
  // Queued tasks are cancelled by Sign out too, so they count with the running and waiting ones.
  const live = tasks.filter(t => t.status === "queued" || t.status === "running" || t.status === "waiting").length;
  return { tasks: live, facts: memory?.rows.length ?? 0, reminders: reminders.length, routines: routines.length };
}

/** Wire both questions; `hooks` keep today's error and in-flight handling in main.ts. */
export function mountForgetConfirms(api: EmberHomeApi, hooks: { signOutFailed(err: unknown): void; deleteMemory(remove: () => Promise<unknown>): Promise<void> }): void {
  const ask = (opener: string, panel: string, scope: string, yes: string, no: string, words: (c: ForgetCounts) => string, run: () => void) => {
    const open = document.getElementById(opener) as HTMLButtonElement, box = document.getElementById(panel)!;
    const yesBtn = document.getElementById(yes) as HTMLButtonElement, noBtn = document.getElementById(no) as HTMLButtonElement;
    let generation = 0;
    const close = (refocus: boolean) => { generation++; box.hidden = true; if (refocus && !open.hidden) open.focus(); };
    open.addEventListener("click", () => {
      const mine = ++generation;
      void readCounts(api).then(c => {
        if (mine !== generation) return;
        document.getElementById(scope)!.textContent = words(c);
        box.hidden = false;
        noBtn.focus(); // the safe choice first
      });
    });
    noBtn.addEventListener("click", () => close(true));
    box.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(true); } });
    yesBtn.addEventListener("click", () => { close(false); run(); if (!open.hidden) open.focus(); });
  };
  ask("sign-out", "sign-out-confirm", "sign-out-scope", "sign-out-yes", "sign-out-no", signOutScope,
    () => { void api.signOut().catch(hooks.signOutFailed); });
  ask("memory-forget-all", "forget-all-confirm", "forget-all-scope", "forget-all-yes", "forget-all-no", forgetEverythingScope,
    () => { void hooks.deleteMemory(() => api.forgetAllMemory()); });
}
