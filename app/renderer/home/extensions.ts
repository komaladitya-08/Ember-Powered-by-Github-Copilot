/**
 * The settings window's Extensions section, drawn from extensions-copy.ts's views over `window.emberExtensions`
 * (EXTENSIONS_IPC). Only the user adds, so every add and connect first shows the consent card in place, and the request
 * goes to main only from its Agree button. Main checks every argument again and opens only GitHub's pages. Text from
 * marketplaces and connectors (names, descriptions) is set with textContent alone. The section is redrawn only when
 * what it shows changes, and keyboard focus stays on the control with the same key.
 */

import type { ExtensionsState, Status, EmberExtensionsApi } from "../../shared/ipc";
import type { Installed, MarketplaceEntry } from "../../shared/extensions";
import { marketplaceSource } from "../../shared/extensions-input";
import {
  BROWSE_DONE, BROWSE_EMPTY, CONNECTORS_EMPTY, EXTENSIONS_FAILED, EXTENSIONS_LOADING, INSTALLED_EMPTY, INSTALLED_TAG, MARKETPLACES_EMPTY, MARKETPLACE_INVALID,
  addedMarketplace, added, addingMarketplace, agreedAgain, browseLabel, browsingHeading, browsingLoading, connectOpened, connectPending, connected, connectorRow,
  consentCard, disconnected, entryCard, extensionsBlocked, extensionsError, installedRow, reagreeCard, removeMarketplaceLabel, removeMarketplaceQuestion, removed,
  type ConsentCard, type ItemAction,
} from "./extensions-copy";

declare global { interface Window { emberExtensions?: EmberExtensionsApi } }

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (label: string, cls: string, key: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement => {
  const b = el("button", cls, label);
  b.type = "button";
  b.dataset.key = key;
  if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
  b.addEventListener("click", onClick);
  return b;
};

let state: ExtensionsState | null = null;
let lockdown = false;
/** The marketplace being browsed, and what it lists (null while loading), or why it couldn't be read. */
let browsing: { name: string; entries: MarketplaceEntry[] | null; error: string | null } | null = null;
let connectors: MarketplaceEntry[] | null = null;
let connectorsError: string | null = null;
/** Connectors waiting for the user in GitHub's page. */
const pending = new Set<string>();
/** The consent card up now: before adding or connecting an entry, or agreeing again to an installed item. */
let asking: { kind: "entry"; entry: MarketplaceEntry } | { kind: "reagree"; item: Installed } | null = null;
/** Requests under way, by the key of the control that started them (its button waits for the answer). */
const busy = new Set<string>();
/** Tool lists the user opened or closed (kept across redraws). */
const openTools = new Set<string>();
const closedTools = new Set<string>();

const say = (text: string) => { $("extensions-msg").textContent = text; };
const api = () => window.emberExtensions;

/** Runs a request: its control waits, the message line says how it went (never the runtime's raw words). */
async function run(key: string, fn: () => Promise<{ ok: boolean; why?: string }>, ok: string | null): Promise<boolean> {
  if (busy.has(key)) return false;
  busy.add(key);
  draw();
  try {
    const r = await fn();
    say(r.ok ? ok ?? "" : r.why ?? EXTENSIONS_FAILED);
    return r.ok;
  } catch (err) {
    say(extensionsError(err));
    return false;
  } finally {
    busy.delete(key);
    draw();
  }
}

async function refresh(): Promise<void> {
  const a = api();
  if (!a) { state = { available: false, allowed: false, installed: [], marketplaces: [] }; draw(); return; }
  try {
    state = await a.state();
  } catch (err) {
    state = { available: true, allowed: true, installed: [], marketplaces: [], error: extensionsError(err) };
  }
  // A connector that is connected now no longer waits.
  for (const name of pending) if (state.installed.some(i => i.kind === "connector" && i.name === name && i.status === "ready")) pending.delete(name);
  if (state.available && state.allowed && connectors === null && connectorsError === null) void loadConnectors();
  draw();
}

async function loadConnectors(): Promise<void> {
  const a = api();
  if (!a) return;
  try {
    const r = await a.connectors();
    if (r.ok) { connectors = r.entries; connectorsError = null; } else { connectors = []; connectorsError = r.why; }
  } catch (err) {
    connectors = [];
    connectorsError = extensionsError(err);
  }
  draw();
}

async function browse(name: string): Promise<void> {
  const a = api();
  if (!a) return;
  browsing = { name, entries: null, error: null };
  asking = null;
  draw();
  $("ext-browse-h").focus();
  try {
    const r = await a.browse(name);
    if (browsing?.name !== name) return;
    browsing = r.ok ? { name, entries: r.entries, error: null } : { name, entries: [], error: r.why };
  } catch (err) {
    if (browsing?.name === name) browsing = { name, entries: [], error: extensionsError(err) };
  }
  draw();
}

/** The user agreed in the card: add or connect the entry, or agree again. */
async function agree(): Promise<void> {
  const a = api();
  const q = asking;
  if (!a || !q) return;
  asking = null;
  if (q.kind === "reagree") {
    await run(`item:${q.item.id}`, () => a.reagree(q.item.id), agreedAgain(q.item.name));
    return;
  }
  const e = q.entry;
  if (e.kind === "connector") { await connect(e.name); return; }
  const done = await run(`entry:${e.marketplace}:${e.name}`, () => a.install(e.marketplace, e.name), added(e.name));
  if (done && browsing?.name === e.marketplace) void browse(e.marketplace);
}

async function connect(name: string): Promise<void> {
  const a = api();
  if (!a) return;
  const key = `connector:${name}`;
  if (busy.has(key)) return;
  busy.add(key);
  draw();
  try {
    const r = await a.connect(name);
    if (!r.ok) { pending.delete(name); say(r.why); return; }
    if (r.state === "connected") { pending.delete(name); say(connected(name)); return; }
    pending.add(name);
    say(r.state === "consent" ? connectOpened(name) : connectPending(name));
  } catch (err) {
    say(extensionsError(err));
  } finally {
    busy.delete(key);
    draw();
  }
}

function itemAction(i: { id: string | null; name: string }, act: ItemAction, key: string): void {
  const a = api();
  if (!a) return;
  if (act.confirm && !window.confirm(act.confirm)) return;
  if (act.act === "connect") { void connect(i.name); return; }
  if (act.act === "reagree") {
    const item = state?.installed.find(x => x.id === i.id);
    if (item) { asking = { kind: "reagree", item }; draw(); focusKey("consent-yes"); }
    return;
  }
  const id = i.id;
  if (!id) return;
  if (act.act === "uninstall") void run(key, () => a.uninstall(id), removed(i.name));
  else void run(key, () => a.disconnect(id), disconnected(i.name));
}

// ───── Drawing ─────

function consentNode(c: ConsentCard): HTMLElement {
  const box = el("div", "consent ext-consent");
  box.setAttribute("role", "group");
  const title = el("p", "ext-consent-title", c.title);
  title.id = "ext-consent-title";
  box.setAttribute("aria-labelledby", title.id);
  const lines = el("ul", "ext-consent-lines");
  lines.id = "ext-consent-lines";
  for (const l of c.lines) lines.append(el("li", "", l));
  const actions = el("div", "agent-actions");
  const yes = button(c.yes, "btn", "consent-yes", () => void agree());
  yes.setAttribute("aria-describedby", lines.id);
  const no = button(c.no, "btn quiet", "consent-no", () => { const back = askedFrom(); asking = null; draw(); focusKey(back); });
  actions.append(yes, no);
  box.append(title, lines, actions);
  return box;
}

/** The key of the control the card was opened from (focus goes back there on Not now). */
function askedFrom(): string {
  if (!asking) return "";
  if (asking.kind === "reagree") return `item:${asking.item.id}:reagree`;
  return asking.entry.kind === "connector" && !browsing ? `connector:${asking.entry.name}` : `entry:${asking.entry.marketplace}:${asking.entry.name}`;
}

const PHASE = { ok: "ready", wait: "starting", fail: "error", off: "" } as const;
function statusLine(text: string, tone: keyof typeof PHASE): HTMLElement {
  const p = el("span", "ext-status");
  const dot = el("i", "dot");
  dot.setAttribute("aria-hidden", "true");
  if (PHASE[tone]) dot.dataset.phase = PHASE[tone];
  p.append(dot, el("span", "", text));
  return p;
}

function installedItem(i: Installed): HTMLLIElement {
  const r = installedRow(i);
  const li = el("li", "ext-item");
  const head = el("div", "ext-head");
  const text = el("span", "ext-text");
  text.append(el("b", "ext-name", r.name), el("span", "ext-meta", r.meta), statusLine(r.status.text, r.status.tone));
  const sw = el("input");
  sw.type = "checkbox";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-label", r.toggle.ariaLabel);
  sw.dataset.key = `item:${i.id}:switch`;
  sw.checked = r.toggle.checked;
  sw.disabled = r.toggle.disabled || busy.has(`item:${i.id}`) || !state?.allowed;
  sw.addEventListener("change", () => {
    const on = sw.checked;
    sw.checked = !on;
    const a = api();
    if (a) void run(`item:${i.id}`, () => a.setEnabled(i.id, on), null);
  });
  head.append(text, sw);
  li.append(head);
  // Each note says what to do next, which only applies while extensions may be used.
  if (r.note && state?.allowed) li.append(el("p", "ext-note", r.note));
  if (r.tools.length) {
    const fold = el("details", "ext-tools");
    // A changed tool is shown at once: it is what the user is asked to look at.
    fold.open = openTools.has(i.id) || (!closedTools.has(i.id) && r.tools.some(t => t.badge.tone === "no"));
    fold.addEventListener("toggle", () => {
      (fold.open ? openTools : closedTools).add(i.id);
      (fold.open ? closedTools : openTools).delete(i.id);
    });
    const summary = el("summary", "", r.toolSummary);
    summary.dataset.key = `item:${i.id}:tools`;
    fold.append(summary);
    const list = el("ul", "ext-tool-list");
    for (const t of r.tools) {
      const row = el("li");
      row.append(el("span", `tag ${t.badge.tone}`, t.badge.label), el("code", "ext-tool-name", t.name));
      if (t.description) row.append(el("span", "ext-tool-desc", t.description));
      list.append(row);
    }
    fold.append(list);
    li.append(fold);
  }
  if (asking?.kind === "reagree" && asking.item.id === i.id) li.append(consentNode(reagreeCard(asking.item)));
  else if (state?.allowed) {
    const actions = el("div", "ext-actions");
    for (const act of r.actions) {
      const key = `item:${i.id}:${act.act}`;
      const b = button(act.label, act.danger ? "btn quiet small danger" : "btn quiet small", key, () => itemAction(i, act, `item:${i.id}`), act.ariaLabel);
      if (busy.has(`item:${i.id}`)) b.setAttribute("aria-disabled", "true");
      actions.append(b);
    }
    li.append(actions);
  }
  return li;
}

function marketItem(m: { name: string; source: string }): HTMLLIElement {
  const li = el("li", "ext-market");
  const text = el("span", "ext-text");
  text.append(el("b", "ext-name", m.name), el("span", "ext-meta", m.source));
  li.append(text);
  // Turned off by the organisation: listed, but nothing to browse or change.
  if (!state?.allowed) return li;
  const actions = el("span", "ext-row-actions");
  const key = `market:${m.name}`;
  const open = button(browsing?.name === m.name ? "Browsing" : "Browse", "btn quiet small", `${key}:browse`, () => void browse(m.name), browseLabel(m.name));
  if (browsing?.name === m.name) open.setAttribute("aria-current", "true");
  const remove = button("Remove", "btn quiet small danger", `${key}:remove`, () => {
    if (!window.confirm(removeMarketplaceQuestion(m.name))) return;
    const a = api();
    if (!a) return;
    if (browsing?.name === m.name) browsing = null;
    void run(key, () => a.removeMarketplace(m.name), null);
  }, removeMarketplaceLabel(m.name));
  actions.append(open, remove);
  li.append(actions);
  return li;
}

function entryNode(e: MarketplaceEntry): HTMLLIElement {
  const c = entryCard(e);
  const li = el("li", "ext-card");
  const head = el("div", "ext-card-head");
  head.append(el("b", "ext-name", c.name), el("span", "tag", c.kind));
  li.append(head);
  if (c.description) li.append(el("p", "ext-desc", c.description));
  li.append(el("p", "ext-meta", c.meta));
  if (asking?.kind === "entry" && asking.entry.marketplace === e.marketplace && asking.entry.name === e.name) {
    li.append(consentNode(consentCard(e)));
    return li;
  }
  const foot = el("div", "ext-card-foot");
  const key = `entry:${e.marketplace}:${e.name}`;
  if (c.action && state?.allowed) {
    const b = button(c.action.label, "btn quiet small", key, () => { asking = { kind: "entry", entry: e }; draw(); focusKey("consent-yes"); }, c.action.ariaLabel);
    if (busy.has(key)) b.setAttribute("aria-disabled", "true");
    foot.append(b);
  } else if (c.installed) {
    foot.append(el("span", "ext-added", INSTALLED_TAG));
  }
  li.append(foot);
  return li;
}

function connectorNode(e: MarketplaceEntry): HTMLLIElement {
  // Connected (or connected once): the item itself, with its switch, tools, status and Disconnect.
  const installed = state?.installed.find(x => x.kind === "connector" && x.name === e.name);
  if (installed && !pending.has(e.name)) return installedItem(installed);
  const r = connectorRow(e, state?.installed ?? [], pending);
  const li = el("li", "ext-item");
  const head = el("div", "ext-head");
  const text = el("span", "ext-text");
  text.append(el("b", "ext-name", r.name));
  if (r.description) text.append(el("span", "ext-meta", r.description));
  const tone = r.state === "connected" ? "ok" : r.state === "pending" ? "wait" : r.state === "off" ? "off" : "fail";
  text.append(statusLine(r.status, tone));
  head.append(text);
  const key = `connector:${e.name}`;
  if (asking?.kind === "entry" && asking.entry.kind === "connector" && asking.entry.name === e.name && !browsing) {
    li.append(head, consentNode(consentCard(e)));
    return li;
  }
  if (r.action && state?.allowed) {
    const act = r.action;
    const b = button(act.label, act.danger ? "btn quiet small danger" : "btn quiet small", key, () => {
      // Connecting the first time shows the card; Check again and Connect again go straight on (the user agreed already).
      if (act.act === "connect" && r.state === "off") { asking = { kind: "entry", entry: e }; browsing = browsing?.name === e.marketplace ? browsing : null; draw(); focusKey("consent-yes"); return; }
      itemAction({ id: r.id, name: r.name }, act, key);
    }, act.ariaLabel);
    if (busy.has(key)) b.setAttribute("aria-disabled", "true");
    head.append(b);
  }
  li.append(head);
  return li;
}

const empty = (text: string) => el("li", "empty", text);

/** Focuses the control with `key`, if it is on the page. */
function focusKey(key: string): void {
  if (!key) return;
  document.querySelector<HTMLElement>(`#extensions [data-key="${CSS.escape(key)}"]`)?.focus();
}

let drawn = "";
/** Draws the section from what is known now. */
function draw(): void {
  if (!state) return;
  const blocked = extensionsBlocked({ available: state.available, allowed: state.allowed, lockdown });
  $("extensions-blocked").hidden = !blocked;
  $("extensions-blocked").textContent = blocked ?? "";
  // Unavailable: nothing more to show. Turned off: what was added stays listed (so the user sees it is off), read only.
  $("extensions-body").hidden = !state.available;
  if (!state.available) return;
  $("ext-market-form").hidden = !state.allowed;
  $("ext-markets-hint").hidden = !state.allowed;
  if (!state.allowed) { browsing = null; asking = null; }
  const key = JSON.stringify([state, browsing, connectors, connectorsError, [...pending], asking, [...busy]]);
  if (key === drawn) return;
  drawn = key;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.key ?? "";

  // Connectors the catalog lists are shown under Connectors, with their tools; everything else is here.
  const own = state.installed.filter(i => i.kind !== "connector" || !connectors?.some(c => c.name === i.name)).map(installedItem);
  $("ext-installed").replaceChildren(...(state.error ? [empty(state.error)] : own.length ? own : [empty(INSTALLED_EMPTY)]));
  $("ext-markets").replaceChildren(...(state.marketplaces.length ? state.marketplaces.map(marketItem) : [empty(MARKETPLACES_EMPTY)]));

  $("ext-browse").hidden = !browsing;
  if (browsing) {
    $("ext-browse-h").textContent = browsingHeading(browsing.name);
    $("ext-browse-status").textContent = browsing.entries === null ? browsingLoading(browsing.name) : browsing.error ?? (browsing.entries.length ? "" : BROWSE_EMPTY);
    $("ext-cards").replaceChildren(...(browsing.entries ?? []).map(entryNode));
  }

  // The catalog is GitHub's, read only while extensions may be used (connected ones stay listed under Added).
  $("ext-connectors-group").hidden = !state.allowed;
  const list = connectors === null ? [empty(EXTENSIONS_LOADING)]
    : connectorsError ? [empty(connectorsError)]
    : connectors.length ? connectors.map(connectorNode) : [empty(CONNECTORS_EMPTY)];
  $("ext-connectors").replaceChildren(...list);
  if (focused) focusKey(focused);
}

/** The status arrived: the organisation's policy, and whether Ember is locked down. */
export function extensionsStatus(st: Status): void {
  lockdown = st.admin.error !== null;
  draw();
}

/** Asks main for the extensions once and follows its changes; wires the marketplace form and the browsing panel. */
export function startExtensions(): void {
  const a = api();
  a?.onChanged(() => void refresh());
  void refresh();
  $("ext-market-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = $("ext-market-add") as HTMLInputElement;
    const source = marketplaceSource(input.value);
    if (!source) { say(MARKETPLACE_INVALID); input.focus(); return; }
    const x = api();
    if (!x) return;
    say(addingMarketplace(source));
    void run("market-add", () => x.addMarketplace(source), addedMarketplace(source)).then(ok => {
      // Typed over meanwhile: what is there now is the user's.
      if (ok && marketplaceSource(input.value) === source) input.value = "";
    });
  });
  $("ext-browse-done").textContent = BROWSE_DONE;
  $("ext-browse-done").addEventListener("click", () => {
    const back = browsing ? `market:${browsing.name}:browse` : "";
    browsing = null;
    if (asking?.kind === "entry" && asking.entry.kind !== "connector") asking = null;
    draw();
    focusKey(back);
  });
}
