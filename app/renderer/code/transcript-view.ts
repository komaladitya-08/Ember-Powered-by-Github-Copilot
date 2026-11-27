/**
 * The shown session's transcript, drawn from its reduced items (transcript.ts): messages with markdown, folded
 * reasoning, tool rows by shape (a command with its live output and exit code, an edit with its diff, a read, a
 * search, a fetch, an MCP tool, others by name with their arguments folded), sub-agent rows that open on their own
 * nested transcript, notes, errors with the remedy the SDK names, unknown events folded, and request cards (cards.ts).
 *
 * Windowed: only the last WINDOW top-level items are in the page until "Show earlier" asks for more, and an item is
 * drawn again only when it (or what its drawing reads: its card's pending state, its nested items) changed. The app
 * draws at most once an animation frame, so streamed words are too. Focus inside a redrawn item goes back to the same
 * control. What is said: a new request assertively, a finished reply politely (live.ts).
 */
import type { CodeApp } from "./app";
import { Arming, requestCard, requestTitle } from "./cards";
import {
  CATCHING_UP, COPIED, COPILOT, OUTPUT_CUT, PROBLEM_DETAILS, QUEUED_TAG, REASONING, SANDBOXED_TAG, STEERED_TAG, THINKING, TOOL_ARGS, TOOL_DETAILS, TOOL_RESULT, UNSANDBOXED_TAG, YOU,
  agentState, agentWork, asksSaid, attachedNames, earlierItems, eventSummary, hookWords, noteWords, notSent, outputLabel, pathTail, problemLead, remedy,
  replySaid, sessionTitle, toolEnd, toolShape, toolTitle, transcriptEmpty,
} from "./copy";
import { diffView } from "./diff-view";
import { copyText, el } from "./dom";
import { copyTarget, markdownNodes } from "./markdown-dom";
import { permissionCard } from "./requests";
import { shown as shownValue, str, sub } from "./sdk";
import type { CodeState } from "./store";
import type { Item, RequestItem, ToolItem, Transcript } from "./transcript";

/** Top-level items in the page at first, and how many more "Show earlier" adds. */
export const WINDOW = 150;

interface Drawn { sig: unknown[]; li: HTMLLIElement }

export function mountTranscript(app: CodeApp, root: HTMLElement): { render(s: CodeState, prev: CodeState | null): void; firstOpenRequest(): HTMLElement | null } {
  const list = el("ol", { className: "items" });
  const earlier = el("button", { type: "button", className: "btn quiet small earlier", hidden: true });
  const empty = el("p", { className: "transcript-empty" });
  const catching = el("p", { className: "hint catching", textContent: CATCHING_UP, hidden: true });
  root.replaceChildren(earlier, empty, list, catching);
  const arming = new Arming();
  const drawn = new Map<string, Drawn>();
  let sessionId: string | null = null;
  let windowSize = WINDOW;
  /** Items said already, so a redraw says nothing twice. */
  const told = new Set<string>();
  /** Nested work a person opened, kept open across redraws. */
  const opened = new Set<string>();

  /** The transcript follows new items while the person hasn't scrolled away from its end (judged at each scroll). */
  let stick = true;
  /** The person's own messages seen: a new one takes the transcript to its end, wherever it was. */
  const sentSeen = new Set<string>();
  root.addEventListener("scroll", () => { stick = root.scrollHeight - root.scrollTop - root.clientHeight < 48; }, { passive: true });
  earlier.addEventListener("click", () => { windowSize += WINDOW; app.draw(); });
  root.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("button[data-copy]");
    if (!b) return;
    const text = copyTarget(b);
    if (text === null) return;
    void copyText(text).then(ok => { if (ok) { const was = b.textContent; b.textContent = COPIED; setTimeout(() => { b.textContent = was; }, 1500); } });
  });
  root.addEventListener("toggle", e => {
    const d = e.target as HTMLElement;
    const key = d.dataset?.work;
    if (!key) return;
    if ((d as HTMLDetailsElement).open) opened.add(key); else opened.delete(key);
  }, true);

  function render(s: CodeState, prev: CodeState | null): void {
    const id = s.view.kind === "session" ? s.view.id : null;
    const t = id ? s.transcripts[id] : undefined;
    if (id !== sessionId) {
      for (const d of drawn.values()) arming.forget(d.li);
      drawn.clear();
      list.replaceChildren();
      sessionId = id;
      windowSize = WINDOW;
      stick = true;
    }
    if (!id || !t) { empty.hidden = !id; catching.hidden = !id; if (id) empty.textContent = ""; return; }
    if (prev && prev.view === s.view && prev.transcripts[id] === t && prev.pending === s.pending && prev.answering === s.answering) return;
    catching.hidden = !t.stale;
    const project = s.sessions.byId[id] ? s.projects.byId[s.sessions.byId[id].projectId]?.name : undefined;
    empty.textContent = transcriptEmpty(project);
    empty.hidden = t.items.length > 0;

    let nearEnd = stick;
    const focused = document.activeElement as HTMLElement | null;
    const children = new Map<string | undefined, Item[]>();
    for (const i of t.items) { const k = i.owner; const arr = children.get(k); if (arr) arr.push(i); else children.set(k, [i]); }
    const diffs = diffsByTool(t);
    // A message queued from here waits in the queue strip once main has taken it; it shows here when the SDK sends it.
    for (const i of t.items) if (i.kind === "user" && i.local && !sentSeen.has(i.key)) { sentSeen.add(i.key); nearEnd = true; }
    // Hooks show only when one failed (they run around every tool call).
    const top = (children.get(undefined) ?? []).filter(i => !(i.kind === "user" && i.local && i.delivery === "enqueue" && i.messageId && !i.problem) && !(i.kind === "hook" && i.state !== "failed"));
    const from = Math.max(0, top.length - windowSize);
    earlier.hidden = from === 0;
    earlier.textContent = earlierItems(from);
    const keep = new Set<string>();
    let at = 0;
    for (let n = from; n < top.length; n++) {
      const item = top[n];
      keep.add(item.key);
      const sig = sigOf(item, s, children, diffs, id);
      const had = drawn.get(item.key);
      let li = had?.li;
      if (!had || !same(had.sig, sig)) {
        const fresh = el("li", { className: `item k-${item.kind}`, data: { key: item.key } }, drawItem(item, s, id, children, diffs));
        if (had) {
          arming.forget(had.li);
          const was = focused && had.li.contains(focused) ? focused : null;
          had.li.replaceWith(fresh);
          if (was) refocus(fresh, was);
        }
        li = fresh;
        drawn.set(item.key, { sig, li });
        announce(item, s, id);
      }
      if (list.children[at] !== li) list.insertBefore(li!, list.children[at] ?? null);
      at++;
    }
    for (const [k, d] of drawn) if (!keep.has(k)) { arming.forget(d.li); d.li.remove(); drawn.delete(k); }
    if (nearEnd) root.scrollTop = root.scrollHeight;
  }

  /** What a new or changed item says: a request as it comes (assertive), a reply once it is whole (polite). */
  function announce(item: Item, s: CodeState, sessionId: string): void {
    const title = sessionTitle(s.sessions.byId[sessionId] ?? { name: "" });
    if (item.kind === "request" && !item.done && !told.has(item.key)) {
      told.add(item.key);
      app.onSaid?.("asks", asksSaid(requestTitle(item.request, item.data), title));
    }
    if (item.kind === "assistant" && !item.streaming && item.text.trim() && !told.has(item.key)) {
      told.add(item.key);
      app.onSaid?.("said", replySaid(item.text));
    }
    if (item.kind === "assistant" && item.streaming) told.delete(item.key);
  }

  /** What an item's drawing reads, so it is drawn again when any of it changes. */
  function sigOf(item: Item, s: CodeState, children: Map<string | undefined, Item[]>, diffs: Map<string, string>, sessionId: string): unknown[] {
    if (item.kind === "request") return [item, s.pending[item.requestId], s.answering[item.requestId]];
    if (item.kind === "tool") {
      const kids = children.get(item.toolCallId) ?? [];
      return [item, diffs.get(item.toolCallId), opened.has(item.key), ...kids.flatMap((k): unknown[] => (k.kind === "request" ? [k, s.pending[k.requestId], s.answering[k.requestId]] : [k]))];
    }
    if (item.kind === "user") return [item, sessionId];
    return [item];
  }

  function drawItem(item: Item, s: CodeState, sessionId: string, children: Map<string | undefined, Item[]>, diffs: Map<string, string>): HTMLElement {
    switch (item.kind) {
      case "user": {
        const tags = item.delivery === "enqueue" ? QUEUED_TAG : item.delivery === "immediate" ? STEERED_TAG : "";
        return el("div", { className: "msg you" },
          el("p", { className: "who", textContent: YOU }, tags ? el("span", { className: "tag quiet", textContent: tags }) : null),
          el("div", { className: "bubble", textContent: item.text }),
          item.attachments.length ? el("p", { className: "hint", textContent: attachedNames(item.attachments) }) : null,
          item.problem ? el("p", { className: "problem-line", textContent: notSent(item.problem) }) : null);
      }
      case "assistant": {
        const body = el("div", { className: "md" }, ...markdownNodes(item.text));
        if (item.streaming) body.append(el("span", { className: "caret", attrs: { "aria-hidden": "true" } }));
        return el("div", { className: `msg copilot${item.streaming ? " streaming" : ""}` }, el("p", { className: "who", textContent: COPILOT }), body);
      }
      case "reasoning": {
        const d = el("details", { className: "disclose reasoning" }, el("summary", { textContent: item.streaming ? THINKING : REASONING }), el("p", { className: "reasoning-text", textContent: item.text }));
        return d;
      }
      case "tool": return drawTool(item, s, sessionId, children, diffs);
      case "note": return el("p", { className: `note n-${item.note}`, textContent: noteWords(item.note, item.fields), data: { status: item.note === "compaction" ? (item.fields.state === "running" ? "running" : item.fields.state === "failed" ? "failed" : "done") : item.note === "abort" ? "stopped" : "done" } });
      case "hook": return el("p", { className: "note n-hook", textContent: hookWords(item), data: { status: item.state === "running" ? "running" : item.state === "failed" ? "failed" : "done" } });
      case "problem": {
        const fix = remedy(item.remediation);
        const lead = problemLead(item.level, item.type);
        if (item.level === "warning") {
          return el("div", { className: "problem warning", attrs: { role: "note" } }, el("p", { className: "problem-lead", textContent: `${lead}: ${item.message}` }), fix ? el("p", { className: "remedy", textContent: fix }) : null);
        }
        return el("div", { className: "problem error" },
          el("p", { className: "problem-lead", textContent: lead, data: { status: "failed" } }),
          fix ? el("p", { className: "remedy", textContent: fix }) : null,
          item.message ? el("details", { className: "disclose" }, el("summary", { textContent: PROBLEM_DETAILS }), el("pre", { className: "detail", textContent: item.message })) : null);
      }
      case "request": return requestCard(item, { app, sessionId, arming, pending: s.pending[item.requestId], answering: s.answering[item.requestId] });
      case "event": return el("details", { className: "disclose event" }, el("summary", { textContent: eventSummary(item.type) }), el("pre", { className: "detail", textContent: shownValue(item.data, 8_000) }));
    }
  }

  function drawTool(item: ToolItem, s: CodeState, sessionId: string, children: Map<string | undefined, Item[]>, diffs: Map<string, string>): HTMLElement {
    const shape = toolShape(item);
    const title = toolTitle(item);
    const head = el("p", { className: "tool-title", data: { status: item.state === "running" ? "running" : item.state === "failed" ? "failed" : "done" } },
      el("span", { className: "tool-name", textContent: title }),
      item.sandboxed === true ? el("span", { className: "tag quiet", textContent: SANDBOXED_TAG }) : item.sandboxed === false ? el("span", { className: "tag quiet", textContent: UNSANDBOXED_TAG }) : null);
    const box = el("div", { className: `tool s-${shape}` }, head);
    if (shape === "shell") {
      if (item.command) box.append(el("pre", { className: "tool-command", textContent: item.command }));
      const intent = str(item.args, "description");
      if (intent) box.append(el("p", { className: "hint", textContent: intent }));
    }
    if (shape === "fetch") { const url = str(item.args, "url"); if (url) box.append(el("p", { className: "tool-address", textContent: url })); }
    if (item.progress) box.append(el("p", { className: "hint", textContent: item.progress }));
    if (shape === "agent" && item.agent) {
      if (item.agent.description) box.append(el("p", { className: "hint", textContent: item.agent.description }));
      box.append(el("p", { className: "tool-end", textContent: agentState(item.agent) }));
      const kids = children.get(item.toolCallId) ?? [];
      if (kids.length) {
        const nested = el("ol", { className: "items nested" }, ...kids.map(k => el("li", { className: `item k-${k.kind}`, data: { key: k.key } }, drawItem(k, s, sessionId, children, diffs))));
        const d = el("details", { className: "disclose work", open: opened.has(item.key), data: { work: item.key } }, el("summary", { textContent: agentWork(kids.length, opened.has(item.key)) }), nested);
        box.append(d);
      }
      return box;
    }
    const diff = diffs.get(item.toolCallId) ?? editDiff(item);
    if (shape === "edit" && diff) box.append(diffView(diff, title, { numbered: diffs.has(item.toolCallId) }));
    else if (shape === "edit" && item.fileEdits.length > 1) box.append(el("p", { className: "hint", textContent: item.fileEdits.map(f => pathTail(f.path)).join(", ") }));
    const out = item.output || item.partial || "";
    if (out && (shape === "shell" || item.state !== "done")) {
      if (item.outputCut) box.append(el("p", { className: "hint", textContent: OUTPUT_CUT }));
      box.append(el("pre", { className: "tool-output", textContent: out, tabIndex: 0, attrs: { "aria-label": outputLabel(title) } }));
    }
    if (item.error?.message) {
      box.append(el("pre", { className: "tool-output error", textContent: item.error.message, tabIndex: 0, attrs: { "aria-label": outputLabel(title) } }));
      const fix = remedy(item.error.remediation);
      if (fix) box.append(el("p", { className: "remedy", textContent: fix }));
    }
    if (shape !== "shell" && shape !== "edit" && (item.args || item.argsText || item.result)) {
      const fold = el("details", { className: "disclose tool-more" }, el("summary", { textContent: TOOL_DETAILS }));
      if (item.args || item.argsText) fold.append(el("p", { className: "card-sub", textContent: TOOL_ARGS }), el("pre", { className: "detail", textContent: item.argsText ?? shownValue(item.args, 8_000) }));
      if (item.result) fold.append(el("p", { className: "card-sub", textContent: TOOL_RESULT }), el("pre", { className: "detail", textContent: item.result.length > 8_000 ? `${item.result.slice(0, 8_000)}…` : item.result }));
      box.append(fold);
    }
    // Reads, searches and edits that went well need no ending line; a command's exit code always shows.
    const end = shape === "shell" || item.state === "failed" || shape === "other" || shape === "mcp" ? toolEnd(item) : "";
    if (end) box.append(el("p", { className: "tool-end", textContent: end }));
    return box;
  }

  return {
    render,
    firstOpenRequest: () => list.querySelector<HTMLElement>(".card:not(.resolved)"),
  };
}

/** Focus that was in a redrawn item goes to the same control in its new drawing, or to the item itself. */
function refocus(fresh: HTMLElement, was: HTMLElement): void {
  const name = was.dataset.focus;
  const same = name ? fresh.querySelector<HTMLElement>(`[data-focus="${CSS.escape(name)}"]`) : null;
  const target = same && !(same as HTMLButtonElement).disabled ? same : fresh;
  if (target === fresh) fresh.tabIndex = -1;
  target.focus({ preventScroll: true });
}

const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The diff each tool call's write request carried, so the edit's row shows what changed once the card is a record. */
function diffsByTool(t: Transcript): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of t.items) {
    if (i.kind !== "request" || i.request !== "permission") continue;
    const r = sub(i.data, "permissionRequest");
    const tool = str(r, "toolCallId") ?? str(i.data, "toolCallId");
    const v = permissionCard(i.data).view;
    if (tool && v.kind === "write" && v.diff) out.set(tool, v.diff);
  }
  return out;
}

/**
 * Where no write request carried a diff (the session allowed the edit without asking), the edit's own arguments as one:
 * the text it replaced and the text it put in its place (`old_str`/`new_str`), or a new file's text. Its line numbers
 * aren't the file's, so the view leaves them out.
 */
export function editDiff(item: ToolItem): string | undefined {
  const before = str(item.args, "old_str", true), after = str(item.args, "new_str", true);
  const lines = (s: string, sign: string) => s.replace(/\n$/, "").split("\n").map(l => sign + l);
  if (before !== undefined && after !== undefined) return ["@@ -1 +1 @@", ...lines(before, "-"), ...lines(after, "+")].join("\n");
  const text = str(item.args, "file_text", true) ?? str(item.args, "content", true);
  if (text !== undefined && item.tool.toLowerCase() === "create") return ["@@ -0,0 +1 @@", ...lines(text, "+")].join("\n");
  return undefined;
}

export type { RequestItem };
