/**
 * The panel's Terminal tab (docs/CODING-APP.md §4), in two parts.
 *
 * Copilot's commands: every shell tool call of the session, in order, read from the transcript (terminal-model.ts),
 * each with its command, its output as it streams (`tool.shell_output`), its exit code, how long it took and whether it
 * ran in the sandbox, and "Show in transcript". The running one is shown first, with Stop: the SDK has no way to stop
 * one foreground tool call, so Stop cancels the command's background task where `tasks.list` has one, and otherwise
 * says what it does ("Stop the turn") and stops the turn as the composer's Stop does.
 *
 * Your commands: a command line in the session's folder through `shell.executeUserRequested`, the SDK's path for a
 * command the person runs themselves (the Copilot CLI's "!"): it runs through the session runtime, in its sandbox, and
 * its output goes into the session's history, so Copilot sees it, and it comes back with its output and exit code;
 * `shell.cancelUserRequested` cancels it. (`shell.exec` was not chosen: it returns only a process id, and nothing
 * carries its output to the window.) It is the person's own act, so it asks nothing. This is a command runner, not a
 * terminal emulator: output is plain text with ANSI colours mapped to the design system's tones, and the empty state
 * says so. Streaming output is never announced; only a command's end is said, once.
 */
import type { CodeApp } from "./app";
import { PANEL_NO_SESSION } from "./copy";
import {
  AGENT_HEADING, BY_SUB_AGENT, CANCEL, CANT_CANCEL, CANT_RUN, CANT_STOP, CLEAR, COMMAND_HINT, COMMAND_LINE_LABEL, NOT_IN_TRANSCRIPT, NO_AGENT_COMMANDS,
  NO_OUTPUT, OUTPUT_CUT, RUN, RUNNING_NOW, SHOW_IN_TRANSCRIPT, STOP_COMMAND, STOP_TURN, USER_EMPTY, USER_HEADING, YOUR_RUN,
  earlierLabel, outputLabel, runEnd, runningLabel, showLabel, stopLabel, userRunDone, whereItRuns,
} from "./copy-terminal";
import { button, el, setText } from "./dom";
import { registerPanelTab, type PanelContext } from "./panel";
import { revealInTranscript, rowKeyFor } from "./reveal";
import { bool, num, str } from "./sdk";
import type { CodeState } from "./store";
import {
  ansiRuns, boundScrollback, freshCursor, historyStep, keepTail, liveRowFor, remember, runMs, shellRuns,
  type HistoryCursor, type ShellRun, type UserRun,
} from "./terminal-model";
import { taskRows } from "./tasks-model";

/** How many of Copilot's commands are drawn before "Show earlier" (the newest are kept). */
const SHOWN = 40;

registerPanelTab({ id: "terminal", label: "Terminal", mount });

/** Output as runs of text in its tones (never markup). */
function outputNodes(text: string): Node[] {
  return ansiRuns(text).map(r => (r.tone || r.bold ? el("span", { className: `ansi${r.tone ? ` t-${r.tone}` : ""}${r.bold ? " b" : ""}`, textContent: r.text }) : document.createTextNode(r.text)));
}

/** Each session's own command line: what was run here, its history and where Up and Down are. */
interface Shell { runs: UserRun[]; history: string[]; cursor: HistoryCursor; line: string; calls: Set<string> }

function mount(host: HTMLElement, ctx: PanelContext) {
  const app: CodeApp = ctx.app;
  const shells = new Map<string, Shell>();
  let sessionId: string | null = null;
  let n = 0;
  let tick = 0;
  let showAll = false;

  // ───── Copilot's commands ─────
  const agentH = el("h3", { id: "pt-agent-h", className: "pt-h", textContent: AGENT_HEADING });
  const running = el("div", { className: "pt-running" });
  const earlier = button("", { className: "pt-earlier" });
  const list = el("ol", { className: "pt-list" });
  const agentEmpty = el("p", { className: "pt-empty", textContent: NO_AGENT_COMMANDS });
  const agentNote = el("p", { className: "pt-note", attrs: { role: "status" } });
  const agent = el("section", { className: "pt-agent", attrs: { "aria-labelledby": "pt-agent-h" } }, agentH, agentNote, running, earlier, list, agentEmpty);

  // ───── Your commands ─────
  const userH = el("h3", { id: "pt-user-h", className: "pt-h", textContent: USER_HEADING });
  const where = el("p", { className: "pt-where" });
  const scroll = el("div", { className: "pt-scroll", tabIndex: 0, attrs: { role: "region", "aria-label": USER_HEADING } });
  const userEmpty = el("p", { className: "pt-empty", textContent: USER_EMPTY });
  const input = el("input", { id: "pt-input", className: "pt-input", type: "text", autocomplete: "off", spellcheck: false, attrs: { "aria-describedby": "pt-hint", autocapitalize: "off" } });
  const run = el("button", { type: "submit", className: "btn small pt-run", textContent: RUN });
  const cancel = button(CANCEL, { className: "pt-cancel" });
  const clear = button(CLEAR, { className: "pt-clear" });
  const busy = el("p", { className: "pt-busy", data: { status: "running" } });
  const form = el("form", { className: "pt-line" }, el("label", { className: "sr", htmlFor: "pt-input", textContent: COMMAND_LINE_LABEL }), el("span", { className: "pt-prompt", attrs: { "aria-hidden": "true" }, textContent: "$" }), input, run, cancel);
  const hint = el("p", { id: "pt-hint", className: "hint pt-hint", textContent: COMMAND_HINT });
  const said = el("p", { className: "sr", attrs: { role: "status" } });
  const userNote = el("p", { className: "pt-note" });
  const user = el("section", { className: "pt-user", attrs: { "aria-labelledby": "pt-user-h" } },
    el("div", { className: "pt-uhead" }, userH, clear), where, userEmpty, scroll, busy, form, hint, userNote, said);

  const none = el("p", { className: "panel-empty" });
  host.replaceChildren(el("div", { className: "pt" }, agent, user), none);

  const shell = (): Shell | null => {
    if (!sessionId) return null;
    let s = shells.get(sessionId);
    if (!s) shells.set(sessionId, s = { runs: [], history: [], cursor: freshCursor([]), line: "", calls: new Set() });
    return s;
  };

  // ───── Drawing Copilot's commands, row by row (only rows that changed are drawn again) ─────
  const drawn = new Map<string, { node: HTMLElement; sig: string }>();
  /** Which running commands have a background task to cancel (by tool call), read once each from `tasks.list`. */
  const cancellable = new Map<string, string | null>();

  function runRow(r: ShellRun, now: number, first: boolean): HTMLElement {
    const ms = runMs(r, now);
    const status = r.state === "running" ? "running" : r.state === "failed" || (r.exitCode !== undefined && r.exitCode !== 0) ? "failed" : "done";
    const out = el("pre", { className: "pt-out", tabIndex: 0, attrs: { "aria-label": outputLabel(r.command) } }, ...outputNodes(r.output));
    const body = r.output ? out : el("p", { className: "pt-quiet", textContent: r.state === "running" ? "" : NO_OUTPUT });
    const show = button(SHOW_IN_TRANSCRIPT, { aria: showLabel(r.command), onClick: () => reveal(r.toolCallId) });
    const actions = el("div", { className: "pt-actions" }, show);
    if (r.state === "running" && sessionId) {
      const task = cancellable.get(r.toolCallId);
      const stop = button(task ? STOP_COMMAND : STOP_TURN, { aria: task ? stopLabel(r.command) : undefined, onClick: () => { void stopRun(task ?? null); } });
      actions.prepend(stop);
    }
    const who = r.userRequested ? YOUR_RUN : r.owner ? BY_SUB_AGENT : "";
    const node = el("li", { className: `pt-cmd${first ? " first" : ""}`, data: { key: r.key } },
      el("p", { className: "pt-cmdline", data: { status } }, el("code", { className: "pt-code", textContent: r.command })),
      who ? el("p", { className: "pt-who", textContent: who }) : null,
      body,
      r.cut ? el("p", { className: "pt-quiet", textContent: OUTPUT_CUT }) : null,
      el("p", { className: "pt-end", textContent: runEnd(r, ms) }),
      actions);
    return node;
  }

  function drawAgent(s: CodeState): void {
    const t = sessionId ? s.transcripts[sessionId] : undefined;
    // The person's own commands are theirs, under "Your commands": the SDK marks them in their result, and the window
    // knows the ones it is running by their rows.
    const mine = shells.get(sessionId ?? "")?.calls ?? new Set<string>();
    const all = shellRuns(t).filter(r => !r.userRequested && !mine.has(r.toolCallId));
    const now = Date.now();
    agentEmpty.hidden = all.length > 0;
    const live = all.filter(r => r.state === "running");
    const done = all.filter(r => r.state !== "running");
    for (const r of live) if (!cancellable.has(r.toolCallId)) { cancellable.set(r.toolCallId, null); void findTask(r); }
    const shown = showAll ? done : done.slice(-SHOWN);
    earlier.hidden = shown.length === done.length;
    earlier.textContent = earlierLabel(done.length - shown.length);
    // The running command is first-class: on its own above the list, under its own heading.
    const runningNodes = live.map(r => paint(r, now, true));
    running.replaceChildren(...(live.length ? [el("h4", { className: "pt-sub", textContent: RUNNING_NOW }), el("ol", { className: "pt-list" }, ...runningNodes)] : []));
    list.replaceChildren(...shown.map(r => paint(r, now, false)));
    for (const k of [...drawn.keys()]) if (!all.some(r => r.key === k)) drawn.delete(k);
  }
  function paint(r: ShellRun, now: number, first: boolean): HTMLElement {
    const ms = runMs(r, now);
    // What makes a row be drawn again whole; output and time only change it in place, so focus and a reader's place stay.
    const shape = `${r.state}|${r.exitCode}|${r.sandboxed}|${first}|${cancellable.get(r.toolCallId) ?? ""}|${r.cut}|${r.output ? 1 : 0}`;
    const had = drawn.get(r.key);
    if (had && had.sig === shape) {
      const out = had.node.querySelector<HTMLElement>(".pt-out");
      if (out && out.dataset.len !== String(r.output.length)) {
        const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
        out.replaceChildren(...outputNodes(r.output));
        out.dataset.len = String(r.output.length);
        if (atEnd) out.scrollTop = out.scrollHeight;
      }
      const end = had.node.querySelector<HTMLElement>(".pt-end");
      if (end) setText(end, runEnd(r, ms));
      return had.node;
    }
    const node = runRow(r, now, first);
    const out = node.querySelector<HTMLElement>(".pt-out");
    if (out) { out.dataset.len = String(r.output.length); if (r.state === "running") requestAnimationFrame(() => { out.scrollTop = out.scrollHeight; }); }
    drawn.set(r.key, { node, sig: shape });
    return node;
  }
  earlier.addEventListener("click", () => { showAll = true; drawAgent(app.state); });

  async function findTask(r: ShellRun): Promise<void> {
    const id = sessionId;
    if (!id) return;
    const got = await app.rpc({ scope: "session", sessionId: id, method: "tasks.list" });
    if (id !== sessionId || !got.ok) return;
    const task = taskRows(got.value).find(t => t.kind === "shell" && t.state === "running" && (t.command ?? "").trim() === r.command.trim());
    cancellable.set(r.toolCallId, task?.id ?? null);
    drawAgent(app.state);
  }

  async function stopRun(taskId: string | null): Promise<void> {
    const id = sessionId;
    if (!id) return;
    if (!taskId) { await app.interrupt(id); return; }
    const got = await app.rpc({ scope: "session", sessionId: id, method: "tasks.cancel", params: { id: taskId } });
    if (!got.ok || bool(got.value, "cancelled") !== true) setText(agentNote, got.ok ? CANT_STOP : got.reason || CANT_STOP);
  }

  function reveal(toolCallId: string): void {
    if (!sessionId) return;
    const key = rowKeyFor(app, sessionId, toolCallId);
    if (!key || !revealInTranscript(app, key)) setText(agentNote, NOT_IN_TRANSCRIPT);
    else setText(agentNote, "");
  }

  // ───── The person's command line ─────
  const entryNodes = new Map<string, { node: HTMLElement; sig: string }>();
  function drawUser(s: CodeState): void {
    const sh = shell();
    const row = sessionId ? s.sessions.byId[sessionId] : undefined;
    setText(where, whereItRuns(row?.folder ?? "", row?.sandbox));
    if (!sh) return;
    const t = sessionId ? s.transcripts[sessionId] : undefined;
    // A running command's live output, from the transcript's row for it, until its result brings the whole of it.
    for (const r of sh.runs) {
      if (r.state !== "running") continue;
      const liveRow = liveRowFor(t, r.command, before.get(r.id) ?? new Set());
      if (liveRow) sh.calls.add(liveRow.toolCallId);
      if (liveRow && liveRow.output.length > r.output.length) { const k = keepTail(liveRow.output); r.output = k.text; r.cut = k.cut; }
    }
    userEmpty.hidden = sh.runs.length > 0;
    scroll.hidden = !sh.runs.length;
    clear.hidden = !sh.runs.some(r => r.state !== "running");
    const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4;
    const nodes = sh.runs.map(r => {
      const sig = `${r.state}|${r.output.length}|${r.exitCode}`;
      const had = entryNodes.get(r.id);
      if (had && had.sig === sig) return had.node;
      const status = r.state === "running" ? "running" : r.state === "cancelled" ? "stopped" : r.state === "failed" ? "failed" : "done";
      const node = el("div", { className: "pt-entry", data: { run: r.id } },
        el("p", { className: "pt-ran" }, el("span", { className: "pt-prompt", attrs: { "aria-hidden": "true" }, textContent: "$" }), el("code", { className: "pt-code", textContent: r.command })),
        r.output ? el("pre", { className: "pt-uout" }, ...outputNodes(r.output)) : null,
        r.cut ? el("p", { className: "pt-quiet", textContent: OUTPUT_CUT }) : null,
        r.state === "running" ? null : el("p", { className: "pt-end", data: { status }, textContent: runEnd({ state: r.state, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}) }, r.endedAt !== undefined ? r.endedAt - r.startedAt : undefined) }));
      entryNodes.set(r.id, { node, sig });
      return node;
    });
    scroll.replaceChildren(...nodes);
    for (const k of [...entryNodes.keys()]) if (!sh.runs.some(r => r.id === k)) entryNodes.delete(k);
    if (atEnd) scroll.scrollTop = scroll.scrollHeight;
    const now = sh.runs.find(r => r.state === "running");
    busy.hidden = !now;
    if (now) setText(busy, runningLabel(now.command));
    run.hidden = !!now;
    cancel.hidden = !now;
    input.readOnly = !!now;
  }

  /** The transcript's shell rows that were there when each of the person's commands was sent. */
  const before = new Map<string, Set<string>>();

  async function submit(): Promise<void> {
    const sh = shell();
    const id = sessionId;
    const command = input.value.trim();
    if (!sh || !id || !command || sh.runs.some(r => r.state === "running")) return;
    sh.history = remember(sh.history, command);
    sh.cursor = freshCursor(sh.history);
    input.value = "";
    sh.line = "";
    const r: UserRun = { id: `you-${Date.now().toString(36)}-${++n}`, command, output: "", cut: false, state: "running", startedAt: Date.now() };
    before.set(r.id, new Set(shellRuns(app.state.transcripts[id]).map(x => x.toolCallId)));
    sh.runs = boundScrollback([...sh.runs, r]);
    setText(userNote, "");
    drawUser(app.state);
    const got = await app.rpc({ scope: "session", sessionId: id, method: "shell.executeUserRequested", params: { requestId: r.id, command } });
    before.delete(r.id);
    r.endedAt = Date.now();
    if (!got.ok) {
      r.state = "failed";
      setText(userNote, got.reason || CANT_RUN);
    } else {
      const v = got.value;
      const out = str(v, "output", true);
      if (out !== undefined && out.length >= r.output.length) { const k = keepTail(out); r.output = k.text; r.cut = k.cut; }
      const code = num(v, "exitCode");
      if (code !== undefined) r.exitCode = code;
      const ok = bool(v, "success") ?? code === 0;
      if (r.state === "running") r.state = ok ? "done" : "failed";
      if (str(v, "toolCallId")) { r.toolCallId = str(v, "toolCallId"); sh.calls.add(r.toolCallId!); }
      // The runtime's error words are its own: the person is told the command didn't run, never them.
      if (!ok && !r.output && code === undefined && r.state !== "cancelled") setText(userNote, CANT_RUN);
      if (r.state !== "cancelled") setText(said, userRunDone(r.exitCode, r.state === "done"));
    }
    sh.runs = boundScrollback(sh.runs);
    if (id === sessionId) { drawUser(app.state); drawAgent(app.state); }
  }
  form.addEventListener("submit", e => { e.preventDefault(); void submit(); });
  cancel.addEventListener("click", () => { void cancelRun(); });
  async function cancelRun(): Promise<void> {
    const sh = shell();
    const id = sessionId;
    const r = sh?.runs.find(x => x.state === "running");
    if (!r || !id) return;
    const got = await app.rpc({ scope: "session", sessionId: id, method: "shell.cancelUserRequested", params: { requestId: r.id } });
    if (got.ok && bool(got.value, "cancelled") === true) { r.state = "cancelled"; r.endedAt = Date.now(); drawUser(app.state); input.focus(); }
    else setText(userNote, got.ok ? CANT_CANCEL : got.reason || CANT_CANCEL);
  }
  clear.addEventListener("click", () => { const sh = shell(); if (!sh) return; sh.runs = sh.runs.filter(r => r.state === "running"); drawUser(app.state); input.focus(); });
  input.addEventListener("keydown", e => {
    const sh = shell();
    if (!sh || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const step = historyStep(sh.history, sh.cursor, input.value, e.key === "ArrowUp" ? "up" : "down");
      if (!step) return;
      e.preventDefault();
      sh.cursor = step.cursor;
      input.value = step.line;
      input.setSelectionRange(step.line.length, step.line.length);
    } else if (e.key === "Escape" && sh.runs.some(r => r.state === "running")) { e.preventDefault(); void cancelRun(); }
  });
  input.addEventListener("input", () => { const sh = shell(); if (sh) { sh.line = input.value; sh.cursor = { ...sh.cursor, index: sh.history.length, draft: input.value }; } });

  function ticking(s: CodeState): void {
    const t = sessionId ? s.transcripts[sessionId] : undefined;
    const any = shellRuns(t).some(r => r.state === "running");
    if (any && !tick) tick = window.setInterval(() => { if (!host.hidden) drawAgent(app.state); }, 1000);
    if (!any && tick) { clearInterval(tick); tick = 0; }
  }

  return {
    show(id: string | null) {
      sessionId = id;
      showAll = false;
      drawn.clear(); entryNodes.clear();
      host.querySelector<HTMLElement>(".pt")!.hidden = !id;
      none.hidden = !!id;
      setText(none, id ? "" : PANEL_NO_SESSION);
      setText(agentNote, ""); setText(userNote, ""); setText(said, "");
      if (!id) return;
      const sh = shell()!;
      input.value = sh.line;
      drawUser(app.state);
      drawAgent(app.state);
      ticking(app.state);
    },
    render(s: CodeState, prev: CodeState | null) {
      if (!sessionId) return;
      const t = s.transcripts[sessionId], was = prev?.transcripts[sessionId];
      if (t !== was || !prev) { drawUser(s); drawAgent(s); ticking(s); }
      else if (prev.sessions.byId[sessionId] !== s.sessions.byId[sessionId]) drawUser(s);
    },
    dispose() { if (tick) clearInterval(tick); tick = 0; },
  };
}
