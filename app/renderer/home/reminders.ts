/** Upcoming reminders can be inspected, revised or cancelled locally, with exact-record and failed-save feedback. */
import type { EmberHomeApi, ReminderRow } from "../../shared/ipc";
import { REMINDER_WORDS as words, reminderDeleteScope } from "./copy";

/** A datetime-local input value in this computer's timezone, rather than a shifted UTC value. */
export function localReminderTime(at: number): string {
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Mount the Home-only reminder inventory; authored edits survive unrelated live-list changes. */
export function mountReminders(api: EmberHomeApi): void {
  const list = document.getElementById("reminders-list")!;
  const message = document.getElementById("routines-message")!;
  const bulk = document.getElementById("routines-forget-all") as HTMLButtonElement;
  const confirm = document.getElementById("routines-delete-confirm")!;
  const scope = document.getElementById("routines-delete-scope")!;
  const yes = document.getElementById("routines-delete-yes") as HTMLButtonElement;
  const no = document.getElementById("routines-delete-no") as HTMLButtonElement;
  let rows: ReminderRow[] = [], busy = false, readGeneration = 0, accountGeneration = 0;
  const attached = new Map<string, { row: HTMLElement; value: ReminderRow; editing: boolean }>();
  const say = (text: string) => { message.textContent = text; };
  const routineCount = () => document.querySelectorAll("#routines-list button").length;
  const updateBulk = () => {
    bulk.hidden = !rows.length && !routineCount();
    if (!confirm.hidden && !busy) scope.textContent = reminderDeleteScope(routineCount(), rows.length);
  };
  const draw = (next: ReminderRow[]) => {
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
    rows = next;
    const ids = new Set(rows.map(r => r.id));
    for (const [id, item] of attached) {
      if (ids.has(id)) continue;
      const focused = item.row.contains(document.activeElement);
      item.row.remove(); attached.delete(id);
      if (focused) { list.focus(); say(words.gone); }
    }
    list.querySelector(".empty")?.remove();
    let previous: ChildNode | null = null;
    for (const r of rows) {
      let item = attached.get(r.id);
      if (!item) {
        const row = document.createElement("li");
        item = { row, value: r, editing: false }; attached.set(r.id, item);
        const description = Object.assign(document.createElement("span"), { className: "reminder-words" });
        const text = document.createElement("span"), time = document.createElement("time"), kept = Object.assign(document.createElement("span"), { className: "hint" });
        description.append(text, time, kept);
        const actions = Object.assign(document.createElement("div"), { className: "agent-actions" });
        const edit = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: words.edit });
        const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: words.cancel });
        const form = Object.assign(document.createElement("form"), { className: "reminder-edit", hidden: true });
        const label = document.createElement("label"), input = Object.assign(document.createElement("input"), { type: "text", maxLength: 200, required: true });
        label.append(words.words, input);
        const dateLabel = document.createElement("label"), date = Object.assign(document.createElement("input"), { type: "datetime-local", required: true });
        dateLabel.append(words.time, date);
        const controls = Object.assign(document.createElement("div"), { className: "agent-actions" });
        const save = Object.assign(document.createElement("button"), { type: "submit", className: "btn quiet small", textContent: words.save });
        const discard = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: words.discard });
        controls.append(save, discard); form.append(label, dateLabel, controls); actions.append(edit, cancel); row.append(description, actions, form);
        let expected = r;
        const current = item;
        edit.addEventListener("click", () => {
          if (save.getAttribute("aria-disabled") === "true") return;
          expected = current.value; input.value = expected.text; date.value = localReminderTime(expected.at);
          form.hidden = false; actions.hidden = true; current.editing = true; input.focus(); say("");
        });
        discard.addEventListener("click", () => {
          if (save.getAttribute("aria-disabled") === "true") return;
          form.hidden = true; actions.hidden = false; current.editing = false; edit.focus();
        });
        const change = async (replacement: { text: string; at: number } | null) => {
          if (save.getAttribute("aria-disabled") === "true") return;
          const account = accountGeneration;
          for (const button of [save, cancel, discard]) button.setAttribute("aria-disabled", "true");
          try {
            const { id, text, at, created } = replacement ? expected : current.value;
            await api.changeReminder({ expected: { id, text, at, created }, replacement });
            if (account !== accountGeneration) return;
            const keepFocus = row.contains(document.activeElement);
            form.hidden = true; actions.hidden = false; current.editing = false;
            if (keepFocus && row.isConnected) edit.focus();
            const refreshed = await load();
            if (account !== accountGeneration) return;
            say((replacement ? words.updated : words.cancelled) + (refreshed ? "" : ` ${words.loadFailed}`));
          } catch { if (account === accountGeneration) say(words.failed); }
          finally { for (const button of [save, cancel, discard]) button.removeAttribute("aria-disabled"); }
        };
        cancel.addEventListener("click", () => { void change(null); });
        form.addEventListener("submit", e => {
          e.preventDefault();
          // A text-only correction preserves the original seconds instead of silently advancing the timer.
          const at = date.value === localReminderTime(expected.at) ? expected.at : new Date(date.value).getTime();
          if (!Number.isSafeInteger(at) || at <= Date.now() || at - Date.now() > 7 * 86_400_000) { say(words.future); date.focus(); return; }
          void change({ text: input.value.trim(), at });
        });
      }
      item.value = r;
      const [text, time, kept] = [...item.row.querySelector(".reminder-words")!.children] as HTMLElement[];
      text.textContent = r.text;
      time.textContent = new Date(r.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      time.setAttribute("datetime", new Date(r.at).toISOString());
      kept.textContent = r.kept ? words.kept : words.transient;
      const buttons = item.row.querySelectorAll("button");
      buttons[0].setAttribute("aria-label", `Edit reminder: ${r.text}`);
      buttons[1].setAttribute("aria-label", `Cancel reminder: ${r.text}`);
      const nextNode: ChildNode | null = previous ? previous.nextSibling : list.firstChild;
      if (nextNode !== item.row) list.insertBefore(item.row, nextNode);
      previous = item.row;
    }
    if (!rows.length) list.append(Object.assign(document.createElement("li"), { className: "empty", textContent: words.empty }));
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    updateBulk();
  };
  bulk.addEventListener("click", () => { confirm.hidden = false; updateBulk(); no.focus(); });
  no.addEventListener("click", () => { if (busy) return; confirm.hidden = true; (bulk.hidden ? list : bulk).focus(); });
  yes.addEventListener("click", async () => {
    if (busy) return;
    busy = true; yes.setAttribute("aria-disabled", "true"); no.setAttribute("aria-disabled", "true");
    const account = accountGeneration;
    try {
      await api.forgetAllRoutines(); if (account !== accountGeneration) return;
      const keepFocus = confirm.contains(document.activeElement);
      confirm.hidden = true; if (keepFocus) list.focus();
      const refreshed = await load(); if (account !== accountGeneration) return;
      say(words.deleted + (refreshed ? "" : ` ${words.loadFailed}`));
    }
    catch { if (account === accountGeneration) say(words.deleteFailed); }
    finally { busy = false; yes.removeAttribute("aria-disabled"); no.removeAttribute("aria-disabled"); }
  });
  new MutationObserver(updateBulk).observe(document.getElementById("routines-list")!, { childList: true, subtree: true });
  // An initial read never overwrites a newer pushed list.
  api.onReminders(next => { readGeneration++; draw(next); });
  api.onConversationForgotten?.(() => { accountGeneration++; readGeneration++; draw([]); confirm.hidden = true; say(""); });
  const load = () => {
    const generation = ++readGeneration;
    return api.reminders().then(next => { if (generation === readGeneration) draw(next); return true; }, () => {
      if (generation !== readGeneration) return true;
      say(words.loadFailed); return false;
    });
  };
  document.getElementById("reminders-refresh")!.addEventListener("click", () => { void load(); });
  void load();
}
