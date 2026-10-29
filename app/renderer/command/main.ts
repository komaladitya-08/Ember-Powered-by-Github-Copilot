/**
 * The command window's page ("Ember commands", §3.9-§3.10, §8.5): the card on top (a question or an announcement),
 * a line for each task whose command has no tab yet ("Starting Ubuntu…"), and a tab per run with its header, its
 * command, its live terminal, its typing hint, its status line and Stop.
 *
 * The card's DOM is built only from CommandCard fields, as text nodes (never HTML), and rebuilt only when the question
 * changes; whether its whole command is in view is measured from the card's own element. Output bytes go only into
 * their run's xterm element (model.ts's reducer is the only path, and renderer-command.test.ts pins that no output
 * can touch the card). Allow stays disabled until the card's arm time has passed and its whole command has been in view.
 */

import type { CommandCard } from "../../main/commands/types";
import {
  ALLOW_LABEL, ANNOUNCE_HEADING, ANSWER_RETRY_HINT, CLOSE_LABEL, COPIED_LABEL, COPY_OUTPUT_LABEL, EMPTY_TEXT, LEGEND_MIXED, LEGEND_RTL, LEGEND_TOKENS,
  KEEP_OPEN_LABEL, NOT_NOW_LABEL, STOP_AND_CLOSE_LABEL, STOP_LABEL, askHeading, cardLines, closeHeading, closeLine, countdownText, headerLine, isRiskyCard,
  tabLabel,
} from "./copy";
import { shouldFocusTerminal } from "./keys";
import {
  INITIAL_MODEL, allowAnswer, allowEnabled, allowHint, pendingLines, reduce, sameAnnouncement, type CardMetrics, type CommandsApi, type Effect, type PageEvent, type TabView,
  type WindowView,
} from "./model";
import { breaksLine, legendFor, segmentLabel, visibleText } from "./visible";
import { cellSize, createRunTerminal, type RunTerminal } from "./terminal";
import { textScaleOf } from "./terminal-options";
import { applyTextScale, fitTerminal, termChromePx } from "./terminal-size";

declare global { interface Window { emberCommands: CommandsApi } }

const api = window.emberCommands;
const $ = (id: string) => document.getElementById(id)!;
let model = INITIAL_MODEL;
/**
 * The page's text scale (ember.css's --text-scale, set through html[data-text-size] by main): the terminals' type, and
 * the room the window's other parts take, follow it.
 */
const pageScale = () => textScaleOf(getComputedStyle(document.documentElement).getPropertyValue("--text-scale"));
let textScale = pageScale();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A string with every character made visible, as text nodes and spans (never HTML); the legend lines it needs. */
function visibleNodes(s: string): { nodes: Node[]; legend: string[] } {
  const segs = visibleText(s);
  const nodes: Node[] = [];
  for (const seg of segs) {
    if (seg.kind === "plain") { nodes.push(document.createTextNode(seg.text)); continue; }
    nodes.push(el("span", `vt vt-${seg.kind}`, segmentLabel(seg)));
    // A newline shows as its token and still ends the line, so a script reads as lines.
    if (breaksLine(seg)) nodes.push(document.createTextNode("\n"));
  }
  const l = legendFor(segs);
  return { nodes, legend: [...(l.tokens ? [LEGEND_TOKENS] : []), ...(l.mixed ? [LEGEND_MIXED] : []), ...(l.rtl ? [LEGEND_RTL] : [])] };
}

/**
 * A line of where a command runs ("On build-01 as deploy · bash · in /srv/app"), every character visible too: the
 * folder comes from the model, and an approval binds to it.
 */
function headerNode(header: string): { node: HTMLElement; legend: string[] } {
  const p = el("p", "where");
  const v = visibleNodes(header);
  p.append(...v.nodes);
  return { node: p, legend: v.legend };
}

/**
 * A command block: the whole command, wrapping, scrolling when long (never cut). It is focusable (so it can be scrolled
 * from the keyboard) and exposed as a read-only text box named `label`, so a screen reader reads the command itself as
 * its value, every visible token included, rather than only the label (a named generic, review #48).
 */
function commandBlock(command: string, label: string, id?: string): { block: HTMLPreElement; legend: string[] } {
  const block = el("pre", "command");
  if (id) block.id = id;
  block.tabIndex = 0;
  block.setAttribute("role", "textbox");
  block.setAttribute("aria-readonly", "true");
  block.setAttribute("aria-multiline", "true");
  block.setAttribute("aria-label", label);
  const v = visibleNodes(command);
  block.append(...v.nodes);
  return { block, legend: v.legend };
}

/** The card's lines under the command (what it does, why it asks) and the model's reason, small and grey. */
function appendLines(root: HTMLElement, card: CommandCard): void {
  const { lines, why } = cardLines(card);
  if (lines.length) {
    const ul = el("ul", "lines");
    for (const line of lines) {
      const li = el("li");
      li.append(...visibleNodes(line).nodes);
      ul.append(li);
    }
    root.append(ul);
  }
  if (why) {
    const p = el("p", "why");
    p.append(...visibleNodes(why).nodes);
    root.append(p);
  }
}

// ───── The question card ─────
interface AskEls {
  key: string; root: HTMLElement; block: HTMLPreElement; allow: HTMLButtonElement; deny: HTMLButtonElement;
  hint: HTMLElement; keys: HTMLElement; actions: HTMLElement; card: CommandCard & { n: number }; sent: boolean;
  /** The card's retry count this page last saw: a higher one gives the buttons back (review #271). */
  retry: number;
}
let ask: AskEls | null = null;
let armTimer: ReturnType<typeof setTimeout> | null = null;

function buildAsk(card: CommandCard & { n: number; retry?: number }): AskEls {
  const root = el("section", "card ask");
  root.setAttribute("aria-labelledby", "ask-h");
  const where = headerNode(headerLine(card));
  root.append(where.node);
  const h = el("h1", "heading", askHeading(card));
  h.id = "ask-h";
  root.append(h);
  const { block, legend } = commandBlock(card.command, "The command, every character shown", "ask-cmd");
  root.append(block);
  for (const line of new Set([...where.legend, ...legend])) root.append(el("p", "legend", line));
  appendLines(root, card);
  const hint = el("p", "hint");
  hint.setAttribute("aria-live", "polite");
  hint.hidden = true;
  const row = el("div", "buttons");
  // A command that deletes data gets a quiet marker on its card, and its Allow doesn't stand out (as the host-key card's
  // "Trust and connect" doesn't): habit shouldn't carry the user through it (review #275).
  const risky = isRiskyCard(card);
  root.classList.toggle("risky", risky);
  const allow = el("button", risky ? "btn quiet" : "btn", ALLOW_LABEL);
  allow.type = "button";
  allow.disabled = true;
  // Allow says what it allows: the command is its description.
  allow.setAttribute("aria-describedby", "ask-cmd");
  const deny = el("button", "btn quiet", NOT_NOW_LABEL);
  deny.type = "button";
  row.append(allow, deny);
  const keys = el("p", "keys");
  keys.hidden = true;
  // Allow, Not now and their hints stay at the bottom of the card area while the rest scrolls (review #265).
  const actions = el("div", "actions");
  actions.append(hint, row, keys);
  root.append(actions);
  const els: AskEls = { key: `${card.n}:${card.sha256}`, root, block, allow, deny, hint, keys, actions, card, sent: false, retry: card.retry ?? 0 };
  allow.addEventListener("click", e => {
    if (!e.isTrusted || ask !== els || els.sent) return;
    const a = allowAnswer(els.card, model.card, Date.now());
    if (!a) return;
    els.sent = true;
    allow.disabled = deny.disabled = true;
    api.answer(a);
  });
  deny.addEventListener("click", e => {
    if (!e.isTrusted || ask !== els || els.sent) return;
    els.sent = true;
    allow.disabled = deny.disabled = true;
    api.answer({ n: card.n, answer: "deny", sha256: card.sha256 });
  });
  block.addEventListener("scroll", () => measureCard(), { passive: true });
  cardResize.observe(block);
  cardVisible.observe(block);
  return els;
}

/**
 * What the element's scrolling ancestors leave visible (the card area scrolls when a question and an announcement are
 * both up), in viewport coordinates: the intersection of the viewport and each clipping ancestor's padding box.
 */
function clipOf(e: HTMLElement): NonNullable<CardMetrics["clip"]> {
  let top = 0, left = 0, bottom = window.innerHeight, right = window.innerWidth;
  for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    const r = a.getBoundingClientRect();
    const t = r.top + a.clientTop, l = r.left + a.clientLeft;
    top = Math.max(top, t);
    left = Math.max(left, l);
    bottom = Math.min(bottom, t + a.clientHeight);
    right = Math.min(right, l + a.clientWidth);
  }
  return { top, bottom, left, right };
}

/** The card's own element, measured: nothing but it (and what clips it) decides "seen" and "in view". */
function measureCard(): void {
  if (!ask) return;
  const b = ask.block;
  const r = b.getBoundingClientRect();
  // The card's buttons stay over the bottom of the card area: what they cover isn't in view.
  const clip = clipOf(b);
  clip.bottom = Math.min(clip.bottom, ask.actions.getBoundingClientRect().top);
  const metrics: CardMetrics = {
    scrollTop: b.scrollTop, scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, scrollWidth: b.scrollWidth, clientWidth: b.clientWidth,
    top: r.top, bottom: r.bottom, left: r.left, right: r.right, viewWidth: window.innerWidth, viewHeight: window.innerHeight,
    clip, visible: document.visibilityState === "visible",
  };
  dispatch({ type: "card-metrics", n: ask.card.n, metrics });
  paintAllow();
}
const cardResize = new ResizeObserver(() => measureCard());
// The block moving in or out of view for any reason (the card area scrolled, an announcement put above it, the layout
// changed) is measured again, so "in view" never outlives the view.
const cardVisible = new IntersectionObserver(() => measureCard(), { threshold: [0, 0.25, 0.5, 0.75, 0.99, 1] });

/** Allow, its hint and the key hint, from the model only. */
function paintAllow(): void {
  if (!ask) return;
  const now = Date.now();
  const on = allowEnabled(model.card, now);
  if (!ask.sent) ask.allow.disabled = !on;
  const hint = allowHint(model.card) ?? (ask.retry > 0 && !ask.sent ? ANSWER_RETRY_HINT : "");
  if (ask.hint.textContent !== hint) ask.hint.textContent = hint;
  ask.hint.hidden = !hint;
  // The approve keys work only while the whole command is in view (R7): their hint shows only then.
  const keys = on && model.card?.inView && model.view?.keyHint ? model.view.keyHint : "";
  if (ask.keys.textContent !== keys) ask.keys.textContent = keys;
  ask.keys.hidden = !keys;
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  if (model.card && !on) {
    const wait = model.card.shownAt + model.card.armMs - now;
    if (wait > 0) armTimer = setTimeout(paintAllow, wait + 5);
  }
}

// ───── The announcement ─────
interface AnnounceEls { key: string; root: HTMLElement; count: HTMLElement; endsAt: number }
let announce: AnnounceEls | null = null;
let countTimer: ReturnType<typeof setInterval> | null = null;

function buildAnnounce(card: CommandCard, endsAt: number, keys: string): AnnounceEls {
  const root = el("section", "card announce");
  root.setAttribute("aria-labelledby", "announce-h");
  const where = headerNode(headerLine(card));
  root.append(where.node);
  const h = el("h1", "heading", ANNOUNCE_HEADING);
  h.id = "announce-h";
  root.append(h);
  const { block, legend } = commandBlock(card.command, "The command, every character shown", "announce-cmd");
  root.append(block);
  for (const line of new Set([...where.legend, ...legend])) root.append(el("p", "legend", line));
  // What it does in plain words and the model's reason, as on the question card (review #269).
  appendLines(root, card);
  const count = el("p", "count", countdownText(endsAt, Date.now()));
  count.setAttribute("role", "timer");
  // Stop is the one thing to do here: the prominent button.
  const row = el("div", "buttons");
  const stop = el("button", "btn", STOP_LABEL);
  stop.type = "button";
  stop.setAttribute("aria-describedby", "announce-cmd");
  stop.addEventListener("click", e => {
    if (!e.isTrusted) return;
    stop.disabled = true;
    api.stop(card.runId);
  });
  row.append(stop);
  root.append(count);
  if (keys) root.append(el("p", "keys", keys));
  root.append(row);
  return { key: `${card.runId}:${endsAt}`, root, count, endsAt };
}

function tickCountdown(): void {
  if (!announce) return;
  const t = countdownText(announce.endsAt, Date.now());
  if (announce.count.textContent !== t) announce.count.textContent = t;
}

// ───── Closing while commands run (review #262) ─────
interface ClosingEls { running: number; root: HTMLElement }
let closingCard: ClosingEls | null = null;

/** The question the window asks when the user closes it while commands run: stop them and close, or keep it open. */
function buildClosing(running: number): ClosingEls {
  const root = el("section", "card closing");
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-labelledby", "closing-h");
  root.setAttribute("aria-describedby", "closing-d");
  const h = el("h1", "heading", closeHeading(running));
  h.id = "closing-h";
  const d = el("p", "closing-line", closeLine(running));
  d.id = "closing-d";
  const row = el("div", "buttons");
  const stop = el("button", "btn", STOP_AND_CLOSE_LABEL);
  stop.type = "button";
  const keep = el("button", "btn quiet", KEEP_OPEN_LABEL);
  keep.type = "button";
  stop.addEventListener("click", e => { if (e.isTrusted) { stop.disabled = keep.disabled = true; api.closeWindow(true); } });
  keep.addEventListener("click", e => { if (e.isTrusted) { stop.disabled = keep.disabled = true; api.closeWindow(false); } });
  row.append(stop, keep);
  root.append(h, d, row);
  // The safe answer has the keyboard: Enter keeps the commands running.
  requestAnimationFrame(() => keep.focus());
  return { running, root };
}

// ───── Tabs ─────
interface TabEls {
  seq: number; runId: string; command: string; tab: HTMLButtonElement; panel: HTMLElement; status: HTMLElement; typing: HTMLElement;
  action: HTMLButtonElement; host: HTMLElement; term: RunTerminal; ended: boolean;
  /** The hidden live line: what a screen reader was last told of the status (review #276). */
  live: HTMLElement;
}
const tabEls = new Map<number, TabEls>();
const OUTCOME_WORD: Record<TabView["outcome"], string> = { running: "Running: ", done: "Finished: ", failed: "Ended: ", stopped: "Stopped: " };
const WAITING_WORD = "Waiting for you: ";

function buildTab(t: TabView): TabEls {
  const tab = el("button", "tab");
  tab.type = "button";
  tab.id = `tab-${t.seq}`;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", `panel-${t.seq}`);
  // The computer's badge reads "build-01: make test" to a screen reader.
  const where = t.where ? [el("span", "tab-where", t.where), el("span", "sr", ": ")] : [];
  tab.append(el("span", "sr"), ...where, el("span", "tab-label", visibleText(tabLabel(t.command)).map(segmentLabel).join("")));
  tab.title = t.title;
  tab.addEventListener("click", () => select(t.runId));
  tab.addEventListener("keydown", tabKeys);

  const panel = el("section", "panel");
  panel.id = `panel-${t.seq}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tab.id);
  panel.hidden = true;
  const header = headerNode(t.header);
  const { block, legend } = commandBlock(t.command, "The command");
  block.classList.add("small");
  // What the marks in the header and the command mean, as on the card (review #266).
  const legends = [...new Set([...header.legend, ...legend])].map(line => el("p", "legend", line));
  const host = el("div", "term");
  host.setAttribute("aria-roledescription", "terminal");
  host.setAttribute("aria-label", "What the command shows");
  const typing = el("p", "typing", t.typing);
  const foot = el("div", "foot");
  // The visible status counts down every second while a link is quiet; a screen reader hears each new status once,
  // from a hidden live line updated only when the status says something new (review #276).
  const status = el("p", "status", t.status);
  const live = el("p", "sr status-live", t.status);
  live.setAttribute("role", "status");
  // What the terminal shows, to the clipboard (Ctrl+C copies a selection; this copies it all, review #268).
  const copy = el("button", "btn quiet copy", COPY_OUTPUT_LABEL);
  copy.type = "button";
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  copy.addEventListener("click", e => {
    if (!e.isTrusted) return;
    const cur = tabEls.get(t.seq);
    if (!cur?.term.copyAll()) return;
    copy.textContent = COPIED_LABEL;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copy.textContent = COPY_OUTPUT_LABEL; }, 1500);
  });
  const action = el("button", "btn quiet", t.ended ? CLOSE_LABEL : STOP_LABEL);
  action.type = "button";
  action.addEventListener("click", e => {
    if (!e.isTrusted) return;
    const cur = tabEls.get(t.seq);
    if (!cur) return;
    if (cur.ended) api.close(cur.runId);
    else { action.disabled = true; api.stop(cur.runId); }
  });
  foot.append(status, live, copy, action);
  // The status line and Stop come before the terminal, on screen and in the Tab order: they are reached without
  // passing through it (reviews #42, #261).
  panel.append(header.node, block, ...legends, foot, host, typing);
  const term = createRunTerminal({
    cols: t.cols, rows: t.rows, interactive: t.interactive, mac: model.view?.os === "darwin", screenReader: model.view?.screenReader === true,
    scale: textScale, onInput: data => api.input(t.runId, data),
  });
  return { seq: t.seq, runId: t.runId, command: t.command, tab, panel, status, typing, action, host, term, ended: t.ended, live };
}

/** The tab list's keys: ←/→ move between tabs, Home/End to the ends (WAI-ARIA tabs). */
function tabKeys(e: KeyboardEvent): void {
  const order = model.view?.tabs ?? [];
  const at = order.findIndex(t => t.runId === model.selected);
  if (at < 0) return;
  const to = e.key === "ArrowRight" ? Math.min(order.length - 1, at + 1) : e.key === "ArrowLeft" ? Math.max(0, at - 1)
    : e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : -1;
  if (to < 0) return;
  e.preventDefault();
  select(order[to].runId);
  tabEls.get(order[to].seq)?.tab.focus();
}

function select(runId: string): void {
  dispatch({ type: "select", runId });
  render();
}

// ───── Rendering from the model ─────
function render(): void {
  const v = model.view;
  // The card area: the question about closing first, then the announcement (counting down), then the question.
  const closingRunning = v?.closing?.running ?? 0;
  if ((closingCard?.running ?? 0) !== closingRunning) {
    closingCard?.root.remove();
    closingCard = closingRunning > 0 ? buildClosing(closingRunning) : null;
    if (closingCard) $("cards").prepend(closingCard.root);
  }
  const ann = v?.announce ?? null;
  const annKey = ann ? `${ann.card.runId}:${ann.endsAt}` : "";
  if ((announce?.key ?? "") !== annKey) {
    announce?.root.remove();
    announce = ann ? buildAnnounce(ann.card, ann.endsAt, v?.announceKeys ?? "") : null;
    if (announce) {
      if (closingCard) closingCard.root.after(announce.root);
      else $("cards").prepend(announce.root);
    }
  }
  if (announce && !countTimer) countTimer = setInterval(tickCountdown, 250);
  if (!announce && countTimer) { clearInterval(countTimer); countTimer = null; }

  const card = v?.card ?? null;
  const askKey = card ? `${card.n}:${card.sha256}` : "";
  if ((ask?.key ?? "") !== askKey) {
    if (ask) { cardResize.unobserve(ask.block); cardVisible.unobserve(ask.block); ask.root.remove(); }
    ask = card ? buildAsk(card) : null;
    if (ask) {
      $("cards").append(ask.root);
      requestAnimationFrame(measureCard);
    }
  }
  $("cards").hidden = !announce && !ask && !closingCard;
  // An answer the card sent that wasn't taken: its buttons work again (review #271).
  if (ask && card && (card.retry ?? 0) > ask.retry) {
    ask.retry = card.retry ?? 0;
    ask.sent = false;
    ask.deny.disabled = false;
  }
  // Anything drawn may have moved the card: measure it again once laid out.
  if (ask) { paintAllow(); requestAnimationFrame(measureCard); }

  // A task whose command has no tab yet ("Starting Ubuntu…"): its line, as text nodes, until the tab comes.
  const lines = pendingLines(v);
  const box = $("pending");
  const linesKey = JSON.stringify(lines);
  if (box.dataset.lines !== linesKey) {
    box.replaceChildren(...lines.map(text => {
      const p = el("p", "pending-line", text);
      p.dataset.status = "running";
      return p;
    }));
    box.dataset.lines = linesKey;
  }
  box.hidden = lines.length === 0;

  // The tabs, newest first.
  const tabs = v?.tabs ?? [];
  const seqs = new Set(tabs.map(t => t.seq));
  for (const [seq, t] of tabEls) {
    if (seqs.has(seq)) continue;
    t.term.dispose();
    t.tab.remove();
    t.panel.remove();
    tabEls.delete(seq);
  }
  const list = $("tabs");
  tabs.forEach((t, i) => {
    let e = tabEls.get(t.seq);
    if (!e) {
      e = buildTab(t);
      tabEls.set(t.seq, e);
    }
    if (list.children[i] !== e.tab) list.insertBefore(e.tab, list.children[i] ?? null);
    if (!e.panel.isConnected) $("panels").append(e.panel);
    const on = t.runId === model.selected;
    e.tab.setAttribute("aria-selected", String(on));
    e.tab.tabIndex = on ? 0 : -1;
    // A run waiting at a prompt for the user's typing shows the waiting symbol and says so (review #263).
    e.tab.dataset.status = t.waiting ? "waiting" : t.outcome;
    const word = t.waiting ? WAITING_WORD : OUTCOME_WORD[t.outcome];
    const sr = e.tab.querySelector(".sr")!; // the first .sr: how it is going
    if (sr.textContent !== word) sr.textContent = word;
    if (e.status.textContent !== t.status) e.status.textContent = t.status;
    if (!sameAnnouncement(e.live.textContent ?? "", t.status)) e.live.textContent = t.status;
    if (e.typing.textContent !== t.typing) e.typing.textContent = t.typing;
    e.typing.hidden = !t.typing;
    e.term.setInteractive(t.interactive);
    e.term.setScreenReader(v?.screenReader === true);
    if (e.ended !== t.ended) {
      e.ended = t.ended;
      e.action.textContent = t.ended ? CLOSE_LABEL : STOP_LABEL;
      e.action.disabled = false;
    }
    e.action.setAttribute("aria-label", `${t.ended ? CLOSE_LABEL : STOP_LABEL}: ${tabLabel(t.command)}`);
    const wasHidden = e.panel.hidden;
    e.panel.hidden = !on;
    if (on) {
      e.term.open(e.host);
      if (wasHidden) e.term.refresh();
    }
  });
  list.hidden = tabs.length === 0;
  $("empty").hidden = tabs.length > 0 || !!announce || !!ask || lines.length > 0;
  // Nothing below the card area: it may take the whole window (review #265).
  document.querySelector("main.window")?.classList.toggle("cards-only", tabs.length === 0 && lines.length === 0);
  focusTerminal();
  reportSize();
}

/**
 * Puts the keyboard in the selected run's terminal when it takes typing and nothing else wants it (keys.ts), so the
 * answer to "[sudo] password for ana:" typed at once reaches the run (review #264). It never takes the focus from
 * another window: the page's own focus only follows when the user brings the window up.
 */
function focusTerminal(): void {
  const t = model.view?.tabs.find(x => x.runId === model.selected);
  const e = t ? tabEls.get(t.seq) : undefined;
  if (!t || !e?.term.opened) return;
  const a = document.activeElement;
  if (shouldFocusTerminal({ interactive: t.interactive, ended: t.ended, cardUp: !!ask || !!announce || !!closingCard, focusIdle: !a || a === document.body })) e.term.focus();
}

/**
 * Tells main what terminal size fits the window now (without a card, the parts round the terminal at the text size,
 * terminal-size.ts), so new runs start at it. `scale`: the page's text scale (the one it has now, unless it is changing).
 */
let sizeSent = "";
function reportSize(scale = textScale): void {
  const cell = cellSize($("measure"), scale);
  if (!cell) return;
  const fit = fitTerminal(cell, $("panels").clientWidth, window.innerHeight - termChromePx(scale));
  const key = `${fit.cols}x${fit.rows}`;
  if (key === sizeSent) return;
  sizeSent = key;
  api.size(fit);
}

function apply(effects: Effect[]): void {
  for (const e of effects) {
    if (e.kind === "write") tabEls.get(e.seq)?.term.write(e.bytes);
    else api.cardSeen(e.msg);
  }
}

function dispatch(ev: PageEvent): void {
  const r = reduce(model, ev);
  model = r.model;
  apply(r.effects);
}

function onState(view: WindowView): void {
  dispatch({ type: "state", view, now: Date.now() });
  render();
}

$("empty").textContent = EMPTY_TEXT;
api.onState(onState);
api.onOutput(msg => dispatch({ type: "output", msg }));
window.addEventListener("resize", () => { measureCard(); reportSize(); });
// The text size changed (main sets html[data-text-size] as the page loads and whenever the setting changes): every
// run's terminal takes the new type size, and new runs start at what fits the window with it (terminal-size.ts; main
// grows the window by the same scale, and its resize reports again).
new MutationObserver(() => {
  textScale = applyTextScale(textScale, pageScale(), [...tabEls.values()].map(t => t.term), reportSize);
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-text-size"] });
window.addEventListener("focus", () => focusTerminal());
// A scroll anywhere on the page (the card area, not only the command block) can move the card out of view.
document.addEventListener("scroll", () => measureCard(), { capture: true, passive: true });
document.addEventListener("visibilitychange", () => measureCard());
// Main may have sent the state before this page listened: take it whole, with each run's recent output.
void api.pull().then(snap => {
  if (!snap) return;
  onState(snap.state);
  for (const msg of snap.replay) dispatch({ type: "output", msg });
});
