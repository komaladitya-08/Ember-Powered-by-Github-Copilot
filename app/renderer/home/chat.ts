/**
 * Home's Chats pane: native Copilot sessions in a folder the person chose, shown as the SDK runs them (owner decision:
 * "GitHub Copilot SDK first"). It reaches main only through the preload's `window.emberChat` (app/preload/home.ts),
 * and draws chat-model.ts's view with words from copy.ts. Nothing here decides: a permission card offers exactly the
 * SDK's `choices` (an approval takes a press only once the card has been in view for AGREE_ARM_MS, and never from a
 * held key, as Ember's other approval surfaces; Don't allow is never held back), main hands the choice to the SDK
 * unchanged, and what the SDK says was decided becomes the card's record. Dormant while `settings.chat.native` is off
 * or the organisation allows no chat: the pane and its link stay hidden and nothing is asked of main. Model and tool
 * text is put in with `textContent` only.
 */
import { CHAT_AGENT_MODES, CHAT_LIMITS, CHAT_PERMISSION_MODES, type ChatDecisionKind, type ChatDone, type ChatEvent, type ChatSessionRow, type EmberChatApi } from "../../shared/chat";
import { AGREE_ARM_MS, heldPress } from "../../shared/provider";
import { heldLive } from "../shared/held-live";
import type { Settings, SettingsPatch } from "../../main/settings";
import type { Status } from "../../shared/ipc";
import {
  CHAT_AGENT_LABEL, CHAT_ANSWER_LABEL, CHAT_ANSWER_SEND, CHAT_CARD_FIELDS, CHAT_CARD_LEAD, CHAT_COPILOT, CHAT_DIFF_WORDS, CHAT_LIST_EMPTY,
  CHAT_LIST_TITLE, CHAT_MANAGED, CHAT_MESSAGE_LABEL, CHAT_MESSAGE_PLACEHOLDER, CHAT_NATIVE_HINT, CHAT_NATIVE_LABEL, CHAT_NATIVE_LOCKED, CHAT_NEW,
  CHAT_OUTPUT_CUT, CHAT_PERMISSION_LABEL, CHAT_QUESTION_LEAD, CHAT_QUESTION_WITHDRAWN, CHAT_READ_ONLY, CHAT_REASON_LABEL, CHAT_REASON_SUMMARY,
  CHAT_REASONING, CHAT_RESUMED, CHAT_SANDBOX_BYPASS, CHAT_SEND, CHAT_SEND_HINT, CHAT_STOP, CHAT_STOPPED, CHAT_TRUNCATED, CHAT_UNREACHABLE,
  CHAT_WRITES_FILES, CHAT_YOU, CHATS_LEAD, chatAgentHint, chatAgentName, chatAnswered, chatAssistedNote, chatAsksSaid, chatCardTitle, chatCovers,
  chatDecisionLabel, chatDiffMore, chatDiffSummary, chatFolderLine, chatModeRefused, chatNotSent, chatPendingJump, chatPermissionHint,
  chatPermissionName, chatRecord, chatReplySaid, chatRowLabel, chatRowState, chatStopLabel, chatTitle, chatTooLong, chatToolEnd, chatToolTitle,
  chatWarning, folderTail,
} from "./copy";
import {
  NO_CHATS, chatAnswered as answeredIn, chatAnswering, chatDecideFailed, chatDeciding, chatEvent, chatList, chatModeSet, chatOpened,
  chatRowsInOrder, chatSendFailed, chatSent, chatShow, diffFor, pendingOf, type ChatCardRow, type ChatQuestionRow, type ChatRow, type ChatSessionView,
  type ChatState, type ChatToolRow,
} from "./chat-model";
import { diffRows } from "../shared/diff-rows";

declare global { interface Window { emberChat?: EmberChatApi } }

/** What the pane needs of the rest of Home. */
export interface ChatHost {
  /** The preload's API (absent in a window without it: the pane never shows). */
  api: EmberChatApi | undefined;
  save(patch: SettingsPatch): Promise<boolean>;
}

/** What Home tells the pane. */
export interface ChatPane {
  settings(s: Settings): void;
  admin(a: Status["admin"]): void;
  /** The microphone is open for a request: nothing is said (held-live.ts). */
  hold(on: boolean): void;
}

/** The organisation allows chats: not under a lockdown (or one held until a restart), and acting not turned off. */
export function chatsAllowed(a: Status["admin"] | null): boolean {
  return !!a && a.error === null && !a.held && a.features?.actions !== false;
}

/** How often streamed words are drawn at most (design-system.md: streamed text at most 15 times a second). */
const DRAW_MS = 66;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const $ = (id: string) => document.getElementById(id)!;
const said = (done: ChatDone<unknown> | undefined): string | null => (done && done.ok === false ? done.why : null);

export function mountChats(host: ChatHost): ChatPane {
  const api = host.api;
  const sw = $("chat-native") as HTMLInputElement;
  const pane = $("chats"), link = $("jump-chats");
  const list = $("chat-list"), listMsg = $("chat-list-msg"), main = $("chat-main"), log = $("chat-log");
  const message = $("chat-message") as HTMLTextAreaElement, send = $("chat-send") as HTMLButtonElement, stop = $("chat-stop") as HTMLButtonElement;
  const permission = $("chat-permission") as HTMLSelectElement, agent = $("chat-agent") as HTMLSelectElement;
  const composeStatus = $("chat-compose-status"), count = $("chat-count"), pendingJump = $("chat-pending") as HTMLButtonElement;
  const saidLive = heldLive($("chat-said"));
  const asksLive = heldLive($("chat-asks"), 300);

  // Words, once.
  $("chat-native-label").textContent = CHAT_NATIVE_LABEL;
  $("chats-lead").textContent = CHATS_LEAD;
  $("chat-list-h").textContent = CHAT_LIST_TITLE;
  $("chat-new").textContent = CHAT_NEW;
  $("chat-permission-label").textContent = CHAT_PERMISSION_LABEL;
  $("chat-agent-label").textContent = CHAT_AGENT_LABEL;
  $("chat-message-label").textContent = CHAT_MESSAGE_LABEL;
  message.placeholder = CHAT_MESSAGE_PLACEHOLDER;
  $("chat-send-hint").textContent = CHAT_SEND_HINT;
  send.textContent = CHAT_SEND;
  stop.textContent = CHAT_STOP;
  permission.replaceChildren(...CHAT_PERMISSION_MODES.map(m => el("option", { value: m, textContent: chatPermissionName(m) })));
  agent.replaceChildren(...CHAT_AGENT_MODES.map(m => el("option", { value: m, textContent: chatAgentName(m) })));
  list.dataset.empty = CHAT_LIST_EMPTY;
  // A scrollable log is reached by the keyboard too.
  log.tabIndex = 0;

  let state: ChatState = NO_CHATS;
  let wanted = false, allowed = false, on = false, listed = false;
  let keys = 0;
  const key = () => `c${++keys}`;

  // ───── The switch: the user's own setting, shown as in force (the organisation's "no chat" wins) ─────
  sw.addEventListener("change", () => { void host.save({ chat: { native: sw.checked } }); });
  const drawSwitch = () => {
    sw.checked = wanted && allowed;
    sw.disabled = !allowed;
    $("chat-native-row").classList.toggle("locked", !allowed);
    sw.title = allowed ? "" : "Managed by your organisation";
    const hint = allowed ? CHAT_NATIVE_HINT : CHAT_NATIVE_LOCKED;
    if ($("chat-native-hint").textContent !== hint) $("chat-native-hint").textContent = hint;
    const now = wanted && allowed && !!api;
    if (now === on) return;
    on = now;
    pane.hidden = link.hidden = !on;
    if (on && !listed) void refresh();
    if (!on) listed = false;
  };

  // ───── Main's list ─────
  async function refresh(): Promise<void> {
    if (!api) return;
    let r: ChatDone<ChatSessionRow[]>;
    try { r = await api.list(); } catch { listMsg.textContent = CHAT_UNREACHABLE; return; }
    if (!r.ok) { listMsg.textContent = r.why; return; }
    listed = true;
    listMsg.textContent = "";
    apply(chatList(state, r.value));
  }

  function apply(next: ChatState): void {
    state = next;
    schedule();
  }

  // Drawing waits for the next frame, at most DRAW_MS apart, so streamed words don't redraw on every token.
  let drawTimer: ReturnType<typeof setTimeout> | null = null;
  let drawnAt = 0;
  function schedule(): void {
    if (drawTimer) return;
    const wait = Math.max(0, DRAW_MS - (performance.now() - drawnAt));
    drawTimer = setTimeout(() => { drawTimer = null; drawnAt = performance.now(); draw(); }, wait);
  }

  function draw(): void {
    if (!on) return;
    drawList();
    drawShown();
  }

  // ───── The list of chats ─────
  const items = new Map<string, HTMLLIElement>();
  function drawList(): void {
    const rows = chatRowsInOrder(state);
    const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#chat-list [data-chat]")?.dataset.chat;
    const next: HTMLLIElement[] = [];
    for (const row of rows) {
      let li = items.get(row.id);
      if (!li) {
        const button = el("button", { type: "button", className: "chat-open" });
        button.dataset.chat = row.id;
        button.addEventListener("click", () => { void open(row.id); });
        li = el("li", {}, button);
        items.set(row.id, li);
      }
      const button = li.firstElementChild as HTMLButtonElement;
      const shown = state.shown === row.id;
      const stateWords = chatRowState(row);
      const sig = JSON.stringify([chatTitle(row), row.folder, stateWords, shown]);
      if (button.dataset.sig !== sig) {
        button.dataset.sig = sig;
        button.setAttribute("aria-label", chatRowLabel(row));
        if (shown) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
        const mark = el("span", { className: "chat-mark" });
        mark.setAttribute("aria-hidden", "true");
        if (row.pending > 0) mark.dataset.status = "waiting";
        else if (row.busy) mark.dataset.status = "running";
        button.replaceChildren(
          el("span", { className: "chat-open-text" }, el("span", { className: "chat-open-name", textContent: chatTitle(row) }), el("span", { className: "chat-open-folder", textContent: folderTail(row.folder) })),
          ...(stateWords ? [el("span", { className: "chat-open-state" }, mark, stateWords)] : []),
        );
      }
      next.push(li);
    }
    for (const [id, li] of items) if (!rows.some(r => r.id === id)) { items.delete(id); li.remove(); }
    if (next.length !== list.children.length || next.some((li, i) => list.children[i] !== li)) list.replaceChildren(...next);
    if (focusedId && document.activeElement === document.body) items.get(focusedId)?.querySelector("button")?.focus();
  }

  async function open(id: string): Promise<void> {
    const v = state.sessions[id];
    if (!v || !api) return;
    listMsg.textContent = "";
    if (v.row.open) { apply(chatShow(state, id)); afterShow(); return; }
    let r: ChatDone<ChatSessionRow>;
    try { r = await api.resume(id); } catch { listMsg.textContent = CHAT_UNREACHABLE; return; }
    if (!r.ok) { listMsg.textContent = r.why; return; }
    apply(chatOpened(state, r.value, true));
    afterShow();
  }

  /** A chat now shown: its name takes focus, so a screen reader hears where it is. */
  function afterShow(): void {
    clearTimeout(drawTimer ?? undefined);
    drawTimer = null;
    draw();
    $("chat-name").focus();
  }

  $("chat-new").addEventListener("click", () => {
    if (!api) return;
    listMsg.textContent = "";
    void api.create().then(r => {
      if (!r.ok) { listMsg.textContent = r.why; return; }
      if (!r.value) return; // the folder picker was cancelled
      apply(chatOpened(state, r.value));
      afterShow();
      message.focus();
    }, () => { listMsg.textContent = CHAT_UNREACHABLE; });
  });

  // ───── The shown chat ─────
  const rowEls = new Map<string, { row: ChatRow; li: HTMLLIElement }>();
  let drawnSession: string | null = null;
  /** When each card's approvals first came into view (performance.now()); kept across redraws of the card. */
  const inView = new Map<string, number>();
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.request;
      if (e.isIntersecting && id && !inView.has(id)) inView.set(id, performance.now());
    }
  });
  const armed = (requestId: string) => performance.now() - (inView.get(requestId) ?? Infinity) >= AGREE_ARM_MS;

  function drawShown(): void {
    const id = state.shown;
    const v = id ? state.sessions[id] : undefined;
    main.hidden = !v;
    if (!v || !id) { drawnSession = null; return; }
    if (drawnSession !== id) { rowEls.clear(); seen.disconnect(); log.replaceChildren(); drawnSession = id; }
    const title = chatTitle(v.row);
    if ($("chat-name").textContent !== title) $("chat-name").textContent = title;
    const folder = chatFolderLine(v.row.folder);
    if ($("chat-folder").textContent !== folder) $("chat-folder").textContent = folder;
    $("chat-resumed").hidden = !v.resumed;
    $("chat-resumed").textContent = CHAT_RESUMED;
    drawModes(v);
    drawRows(v);
    const busy = v.row.busy;
    stop.hidden = !busy;
    stop.setAttribute("aria-label", chatStopLabel(title));
    const pending = pendingOf(v);
    pendingJump.hidden = !pending;
    pendingJump.textContent = chatPendingJump(pending);
  }

  function drawModes(v: ChatSessionView): void {
    for (const [select, picker, mode, hint, note] of [
      [permission, "permission", v.row.permissionMode, chatPermissionHint, "chat-permission-note"],
      [agent, "agent", v.row.agentMode, chatAgentHint, "chat-agent-note"],
    ] as const) {
      if (!select.dataset.busy && select.value !== mode) select.value = mode;
      const h = hint(mode);
      const hintEl = $(`chat-${picker}-hint`);
      if (hintEl.textContent !== h) hintEl.textContent = h;
      const n = v.notes[picker];
      const words = n ? chatModeRefused(picker, n.requested, n.mode) : "";
      if ($(note).textContent !== words) $(note).textContent = words;
    }
  }

  function drawRows(v: ChatSessionView): void {
    const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const focused = document.activeElement;
    const keep = new Set<string>();
    let i = 0;
    for (const row of v.rows) {
      keep.add(row.key);
      const had = rowEls.get(row.key);
      let li = had?.li;
      if (!had || had.row !== row) {
        const fresh = drawRow(v, row);
        if (had) {
          const wasFocused = !!focused && had.li.contains(focused);
          seen.unobserve(had.li);
          had.li.replaceWith(fresh);
          if (wasFocused) refocus(fresh, focused as HTMLElement);
        }
        li = fresh;
        rowEls.set(row.key, { row, li });
        announce(v, row, had?.row);
      }
      // In the transcript's order: a row not yet at its place is moved there (rows that went are after them all).
      const at = log.children[i] ?? null;
      if (at !== li) log.insertBefore(li!, at);
      i++;
    }
    for (const [k, { li }] of rowEls) if (!keep.has(k)) { seen.unobserve(li); li.remove(); rowEls.delete(k); }
    if (nearEnd) log.scrollTop = log.scrollHeight;
  }

  /** Focus that was in a row redrawn goes to the same control in its new drawing, or to the row itself. */
  function refocus(fresh: HTMLElement, was: HTMLElement): void {
    const name = was.dataset.focus;
    const same = name ? fresh.querySelector<HTMLElement>(`[data-focus="${CSS.escape(name)}"]`) : null;
    const target = same && !(same as HTMLButtonElement).disabled ? same : fresh;
    if (target === fresh) fresh.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  /** What a new or changed row says: a card as it appears (assertive), a reply once it is whole (polite). */
  function announce(v: ChatSessionView, row: ChatRow, before: ChatRow | undefined): void {
    if (row.kind === "permission" && row.state === "waiting" && !before) asksLive.say(chatAsksSaid(chatCardTitle(row.request as { kind: string }), chatTitle(v.row)));
    if (row.kind === "reply" && !row.streaming && (!before || (before.kind === "reply" && before.streaming)) && row.text.trim()) saidLive.say(chatReplySaid(row.text));
  }

  function drawRow(v: ChatSessionView, row: ChatRow): HTMLLIElement {
    switch (row.kind) {
      case "you": {
        const li = el("li", { className: "you" }, el("span", { className: "who", textContent: CHAT_YOU }), el("p", { textContent: row.text }));
        if (row.problem) li.append(el("p", { className: "chat-row-problem", textContent: chatNotSent(row.problem) }));
        return li;
      }
      case "reply": return el("li", { className: "reply" }, el("span", { className: "who", textContent: CHAT_COPILOT }), el("p", { textContent: row.text }));
      case "reasoning": {
        const d = el("details", { className: "disclose chat-reasoning" }, el("summary", { textContent: CHAT_REASONING }), el("p", { textContent: row.text }));
        return el("li", { className: "reasoning" }, d);
      }
      case "tool": return drawTool(v, row);
      case "permission": return drawCard(v, row);
      case "question": return drawQuestion(v, row);
      case "problem": return el("li", { className: "problem" }, el("p", { textContent: row.text }));
      case "stopped": return el("li", { className: "stopped" }, el("p", { textContent: CHAT_STOPPED }));
    }
  }

  function drawTool(v: ChatSessionView, row: ChatToolRow): HTMLLIElement {
    const head = el("p", { className: "chat-tool-title", textContent: chatToolTitle(row) });
    head.dataset.status = row.state;
    const li = el("li", { className: "chat-tool" }, head);
    if (row.shape === "shell" && row.command) li.append(el("pre", { className: "chat-code", textContent: row.command }));
    if (row.shape === "fetch" && row.url) li.append(el("p", { className: "chat-address", textContent: row.url }));
    if (row.progress) li.append(el("p", { className: "hint", textContent: row.progress }));
    const diff = row.shape === "edit" ? diffFor(v, row) : undefined;
    if (diff) li.append(drawDiff(diff));
    else if (row.edits.length && row.shape === "edit") li.append(el("p", { className: "hint", textContent: row.edits.map(folderTail).join(", ") }));
    const out = row.error ? (row.output ? `${row.output}\n${row.error}` : row.error) : row.output;
    if (out && (row.shape === "shell" || row.state === "failed")) {
      if (row.outputCut) li.append(el("p", { className: "hint", textContent: CHAT_OUTPUT_CUT }));
      const pre = el("pre", { className: "chat-output", textContent: out, tabIndex: 0 });
      pre.setAttribute("aria-label", `Output of ${chatToolTitle(row)}`);
      li.append(pre);
    }
    const end = chatToolEnd(row);
    if (end) li.append(el("p", { className: "chat-tool-end", textContent: end }));
    return li;
  }

  function drawDiff(diff: string): HTMLElement {
    const d = diffRows(diff);
    const box = el("div", { className: "chat-diff" });
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", chatDiffSummary(d.added, d.removed));
    box.append(el("p", { className: "chat-diff-summary", textContent: chatDiffSummary(d.added, d.removed) }));
    const lines = el("div", { className: "chat-diff-lines", tabIndex: 0 });
    lines.setAttribute("aria-label", chatDiffSummary(d.added, d.removed));
    for (const r of d.rows) {
      const line = el("div", { className: `d-${r.kind}` });
      const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
      const signEl = el("span", { className: "d-sign", textContent: sign });
      signEl.setAttribute("aria-hidden", "true");
      const words = r.kind === "add" || r.kind === "del" ? CHAT_DIFF_WORDS[r.kind] : "";
      line.append(
        el("span", { className: "d-no", textContent: r.oldNo !== undefined ? String(r.oldNo) : "" }),
        el("span", { className: "d-no", textContent: r.newNo !== undefined ? String(r.newNo) : "" }),
        signEl,
        el("span", { className: "d-text" }, ...(words ? [el("span", { className: "sr", textContent: words })] : []), r.text || " "),
      );
      for (const n of line.querySelectorAll(".d-no")) n.setAttribute("aria-hidden", "true");
      lines.append(line);
    }
    box.append(lines);
    if (d.more) box.append(el("p", { className: "hint", textContent: chatDiffMore(d.more) }));
    return box;
  }

  /** A label and the SDK's words for it, as a definition. */
  const field = (dl: HTMLDListElement, label: string, value: Node | string) => { dl.append(el("dt", { textContent: label }), el("dd", {}, value)); };
  const code = (text: string) => el("pre", { className: "chat-code", textContent: text });

  function drawCard(v: ChatSessionView, row: ChatCardRow): HTMLLIElement {
    const li = el("li", { className: "chat-card" });
    li.dataset.request = row.requestId;
    const r = row.request;
    const title = chatCardTitle(r as { kind: string });
    if (row.state === "resolved") {
      const rec = el("p", { className: "chat-record", textContent: chatRecord(row.outcome?.decision ?? "", row.outcome?.by ?? "sdk", row.chosen, r.kind) });
      rec.dataset.status = row.outcome?.decision.startsWith("approved") ? "done" : "stopped";
      li.classList.add("resolved");
      li.append(el("span", { className: "sr", textContent: `${title} ` }), rec);
      return li;
    }
    li.setAttribute("role", "group");
    const titleId = `chat-card-${row.requestId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    li.setAttribute("aria-labelledby", titleId);
    const tag = el("span", { className: "chat-tag", textContent: "Needs you" });
    li.append(el("p", { className: "chat-card-lead" }, tag, el("span", { textContent: CHAT_CARD_LEAD })), el("p", { className: "chat-card-title", id: titleId, textContent: title }));
    const dl = el("dl", { className: "chat-fields" });
    switch (r.kind) {
      case "shell":
        field(dl, CHAT_CARD_FIELDS.command, code(r.command));
        if (r.intention) field(dl, CHAT_CARD_FIELDS.reason, r.intention);
        if (r.paths.length) field(dl, CHAT_CARD_FIELDS.paths, r.paths.join("\n"));
        if (r.urls.length) field(dl, CHAT_CARD_FIELDS.urls, r.urls.join("\n"));
        break;
      case "write":
        field(dl, CHAT_CARD_FIELDS.file, r.file);
        if (r.intention) field(dl, CHAT_CARD_FIELDS.reason, r.intention);
        if (r.diff) field(dl, CHAT_CARD_FIELDS.changes, drawDiff(r.diff));
        break;
      case "read":
        field(dl, CHAT_CARD_FIELDS.path, r.path);
        if (r.intention) field(dl, CHAT_CARD_FIELDS.reason, r.intention);
        break;
      case "url":
        field(dl, CHAT_CARD_FIELDS.address, r.url);
        if (r.intention) field(dl, CHAT_CARD_FIELDS.reason, r.intention);
        break;
      case "mcp":
        field(dl, CHAT_CARD_FIELDS.server, r.server);
        field(dl, CHAT_CARD_FIELDS.tool, r.title ? `${r.title} (${r.tool})` : r.tool);
        if (r.args) field(dl, CHAT_CARD_FIELDS.args, code(r.args));
        break;
      case "memory":
        field(dl, CHAT_CARD_FIELDS.fact, r.fact);
        break;
      case "custom-tool":
        field(dl, CHAT_CARD_FIELDS.tool, r.description ? `${r.tool}: ${r.description}` : r.tool);
        if (r.args) field(dl, CHAT_CARD_FIELDS.args, code(r.args));
        break;
      case "hook":
        field(dl, CHAT_CARD_FIELDS.tool, r.tool);
        if (r.message) field(dl, CHAT_CARD_FIELDS.message, r.message);
        break;
      default: break;
    }
    if (dl.childElementCount) li.append(dl);
    const notes: string[] = [];
    if (r.kind === "shell" && r.warning) notes.push(chatWarning(r.warning));
    if (r.kind === "shell" && r.writesFiles) notes.push(CHAT_WRITES_FILES);
    if (r.kind === "mcp" && r.readOnly) notes.push(CHAT_READ_ONLY);
    if (r.kind === "shell" && row.choices.includes("approve-for-session") && r.commands.length) notes.push(chatCovers(r.commands.map(c => c.identifier)));
    if (row.assisted) notes.push(chatAssistedNote(row.assisted));
    if (row.sandboxBypass !== undefined) notes.push(CHAT_SANDBOX_BYPASS);
    if (row.managed) notes.push(CHAT_MANAGED);
    if (row.truncated) notes.push(CHAT_TRUNCATED);
    for (const n of notes) li.append(el("p", { className: "hint", textContent: n }));

    const sending = row.state === "sending";
    const reason = el("textarea", { id: `${titleId}-reason`, rows: 2, maxLength: CHAT_LIMITS.feedback, disabled: sending });
    reason.dataset.focus = "reason";
    const buttons = el("div", { className: "agent-actions chat-choices" });
    for (const kind of row.choices) {
      const b = el("button", { type: "button", className: "btn quiet small", textContent: chatDecisionLabel(kind, r.kind), disabled: sending });
      b.dataset.focus = kind;
      if (kind !== "reject") {
        // A held Enter or Space from a control before (or the card coming up under a press) chooses nothing.
        b.addEventListener("keydown", e => { if (heldPress(e)) e.preventDefault(); });
      }
      b.addEventListener("click", () => {
        if (kind !== "reject" && !armed(row.requestId)) return;
        void decide(v.row.id, row.requestId, kind, kind === "reject" ? reason.value : "");
      });
      buttons.append(b);
    }
    li.append(buttons);
    if (row.choices.includes("reject")) {
      const fold = el("details", { className: "disclose chat-reason" }, el("summary", { textContent: CHAT_REASON_SUMMARY }), el("label", { htmlFor: reason.id, textContent: CHAT_REASON_LABEL }), reason);
      (fold.firstElementChild as HTMLElement).dataset.focus = "reason-fold";
      if (row.problem) fold.open = true;
      li.append(fold);
    }
    if (row.problem) li.append(el("p", { className: "chat-row-problem", textContent: row.problem }));
    seen.observe(li);
    return li;
  }

  async function decide(id: string, requestId: string, kind: ChatDecisionKind, feedback: string): Promise<void> {
    if (!api) return;
    const words = feedback.trim().slice(0, CHAT_LIMITS.feedback);
    apply(chatDeciding(state, id, requestId, kind));
    let r: ChatDone;
    try { r = await api.decide(id, requestId, kind === "reject" && words ? { kind, feedback: words } : { kind }); } catch { r = { ok: false, why: CHAT_UNREACHABLE }; }
    const why = said(r);
    if (why) apply(chatDecideFailed(state, id, requestId, why));
  }

  function drawQuestion(v: ChatSessionView, row: ChatQuestionRow): HTMLLIElement {
    const li = el("li", { className: "chat-card chat-question" });
    const qid = `chat-q-${row.requestId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    if (row.state === "answered" || row.state === "withdrawn") {
      li.classList.add("resolved");
      li.append(el("p", { className: "chat-card-title", textContent: row.question }), el("p", { className: "chat-record", textContent: row.state === "answered" ? chatAnswered(row.answer ?? "") : CHAT_QUESTION_WITHDRAWN }));
      return li;
    }
    li.setAttribute("role", "group");
    li.setAttribute("aria-labelledby", qid);
    const sending = row.state === "sending";
    li.append(el("p", { className: "chat-card-lead", textContent: CHAT_QUESTION_LEAD }), el("p", { className: "chat-card-title", id: qid, textContent: row.question }));
    if (row.choices?.length) {
      const buttons = el("div", { className: "agent-actions chat-choices" });
      row.choices.forEach((c, i) => {
        const b = el("button", { type: "button", className: "btn quiet small", textContent: c, disabled: sending });
        b.dataset.focus = `choice-${i}`;
        b.addEventListener("click", () => { void answer(v.row.id, row.requestId, c, false); });
        buttons.append(b);
      });
      li.append(buttons);
    }
    if (row.allowFreeform) {
      const input = el("textarea", { id: `${qid}-answer`, rows: 2, maxLength: CHAT_LIMITS.answer, disabled: sending });
      input.dataset.focus = "answer";
      const go = el("button", { type: "submit", className: "btn quiet small", textContent: CHAT_ANSWER_SEND, disabled: sending });
      go.dataset.focus = "answer-send";
      const form = el("form", { className: "chat-answer" }, el("label", { htmlFor: input.id, textContent: CHAT_ANSWER_LABEL }), input, el("div", { className: "agent-actions" }, go));
      form.addEventListener("submit", e => { e.preventDefault(); if (input.value.trim()) void answer(v.row.id, row.requestId, input.value.trim(), true); });
      li.append(form);
    }
    if (row.problem) li.append(el("p", { className: "chat-row-problem", textContent: row.problem }));
    return li;
  }

  async function answer(id: string, requestId: string, text: string, freeform: boolean): Promise<void> {
    if (!api) return;
    apply(chatAnswering(state, id, requestId, text));
    let r: ChatDone;
    try { r = await api.answer(id, requestId, text, freeform); } catch { r = { ok: false, why: CHAT_UNREACHABLE }; }
    apply(answeredIn(state, id, requestId, said(r) ?? undefined));
  }

  // ───── The pickers ─────
  for (const [select, picker] of [[permission, "permission"], [agent, "agent"]] as const) {
    select.addEventListener("change", () => {
      const id = state.shown;
      if (!api || !id) return;
      const mode = select.value;
      select.dataset.busy = "1";
      select.disabled = true;
      const call = picker === "permission" ? api.setPermissionMode(id, mode as never) : api.setAgentMode(id, mode as never);
      void call.then(r => {
        if (r.ok) apply(chatModeSet(state, id, picker, r.value));
        else { $(`chat-${picker}-note`).textContent = r.why; apply(state); }
      }, () => { $(`chat-${picker}-note`).textContent = CHAT_UNREACHABLE; }).finally(() => {
        delete select.dataset.busy;
        select.disabled = false;
        const v = state.sessions[id];
        if (v) select.value = picker === "permission" ? v.row.permissionMode : v.row.agentMode;
        select.focus();
      });
    });
  }

  // ───── The composer ─────
  const tooLong = () => message.value.length > CHAT_LIMITS.prompt;
  message.addEventListener("input", () => {
    const over = tooLong();
    count.hidden = !over;
    count.textContent = over ? chatTooLong(message.value.length, CHAT_LIMITS.prompt) : "";
  });
  message.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      ($("chat-compose") as HTMLFormElement).requestSubmit();
    }
  });
  $("chat-compose").addEventListener("submit", e => {
    e.preventDefault();
    const id = state.shown;
    const text = message.value;
    if (!api || !id || !text.trim() || tooLong()) return;
    const k = key();
    composeStatus.textContent = "";
    message.value = "";
    apply(chatSent(state, id, text, k));
    void api.send(id, text).then(r => r, (): ChatDone => ({ ok: false, why: CHAT_UNREACHABLE })).then(r => {
      const why = said(r);
      if (!why) return;
      apply(chatSendFailed(state, id, k, why));
      // The words come back, so nothing typed is lost.
      if (!message.value) message.value = text;
    });
  });
  stop.addEventListener("click", () => {
    const id = state.shown;
    if (!api || !id) return;
    void api.stop(id).then(r => { composeStatus.textContent = said(r) ?? ""; }, () => { composeStatus.textContent = CHAT_UNREACHABLE; });
  });
  pendingJump.addEventListener("click", () => {
    const card = log.querySelector<HTMLElement>("li.chat-card:not(.resolved)");
    if (!card) return;
    card.scrollIntoView({ block: "nearest" });
    const first = card.querySelector<HTMLElement>(".chat-choices button:not(:disabled)");
    (first ?? card).focus();
  });

  // ───── Main's events ─────
  api?.onEvent((e: ChatEvent) => {
    apply(chatEvent(state, e, key()));
  });

  return {
    settings(s) { wanted = s.chat?.native === true; drawSwitch(); },
    admin(a) { allowed = chatsAllowed(a); drawSwitch(); },
    hold(onHold) { saidLive.hold(onHold); asksLive.hold(onHold); },
  };
}
