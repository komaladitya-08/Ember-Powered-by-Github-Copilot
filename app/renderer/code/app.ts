/**
 * The coding window's controller: it holds the store's state, draws the views at most once an animation frame (so
 * streamed text is drawn at most once a frame, however fast it comes), and is the only place that calls
 * `window.emberCode`. Each command it sends says nothing for itself: what main answers (a row, a refusal's sentence,
 * the mode in force) goes into the store, and the views draw that. Views get this object and never call main.
 */
import { CODE_LIMITS, type CodeAttachment, type CodeCreate, type CodeDone, type CodeEventEnvelope, type CodeRequestAnswer, type CodeRpcCall, type EmberCodeApi } from "../../shared/code";
import { agentsFrom, modelsFrom, queueFrom } from "./catalog";
import { slashCommands, type SlashCommand } from "./completions";
import { UNREACHABLE, modeRefused } from "./copy";
import {
  DEFAULT_UI, EMPTY_STATE, answering, attached, detached, envelope, listed, projectAdded, requestChanged, rowChanged, sendDone, sent,
  setCatalog, setNote, setQueue, setUi, show, type CodeState, type MainView, type UiPrefs,
} from "./store";

/** A view: drawn again with the new state and the one it last drew. */
export interface View { render(s: CodeState, prev: CodeState | null): void }

const UI_KEY = "ember.code.ui";
/** How many sessions stay attached at once besides the one shown (the busy ones and those last looked at). */
const ATTACHED_MAX = 4;

/** A refusal's sentence, or main's unreachable one. */
const reasonOf = (r: CodeDone<unknown> | undefined): string => (r && r.ok === false ? r.reason || UNREACHABLE : UNREACHABLE);

export class CodeApp {
  state: CodeState = EMPTY_STATE;
  private prev: CodeState | null = null;
  private views: View[] = [];
  private frame = 0;
  private keys = 0;
  /** Sessions attached, most recently shown last. */
  private attachedOrder: string[] = [];
  private attaching = new Map<string, Promise<void>>();
  /** Slash commands and completion triggers per session, read once each. */
  readonly commands = new Map<string, SlashCommand[]>();
  readonly triggers = new Map<string, string[]>();
  /** The live-region hook: what is said assertively (a request) and politely (a whole reply). */
  onSaid: ((kind: "asks" | "said", text: string) => void) | null = null;
  /** Views watching the SDK's events as they come (a panel that reads again on a signal-only event). */
  private eventWatchers = new Set<(env: CodeEventEnvelope) => void>();

  constructor(readonly api: EmberCodeApi) {
    this.state = { ...EMPTY_STATE, ui: loadUi() };
    api.onEvent(env => this.set(s => envelope(s, env)));
    api.onRow(change => this.set(s => rowChanged(s, change)));
    api.onRequest(change => this.set(s => requestChanged(s, change)));
    api.onEvent(env => { for (const fn of this.eventWatchers) fn(env); });
  }

  /** Call `fn` with each of main's envelopes after the store has taken it; returns the way to stop. */
  watchEvents(fn: (env: CodeEventEnvelope) => void): () => void {
    this.eventWatchers.add(fn);
    return () => { this.eventWatchers.delete(fn); };
  }

  /** A view to draw on every change. */
  add(view: View): void { this.views.push(view); view.render(this.state, null); }

  /** Change the state, and draw at the next animation frame (only once a frame, however many changes come). */
  set(fn: (s: CodeState) => CodeState): void {
    const next = fn(this.state);
    if (next === this.state) return;
    this.state = next;
    if (next.ui !== this.prev?.ui) saveUi(next.ui);
    for (const id of next.resync) void this.attach(id, true);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  /** Draw now (a view that must move focus at once). */
  draw(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const prev = this.prev;
    this.prev = this.state;
    for (const v of this.views) v.render(this.state, prev);
  }

  key(prefix = "k"): string { return `${prefix}${++this.keys}`; }

  // ───── Main's list and sessions ─────

  async refresh(): Promise<void> {
    try { const list = await this.api.list(); this.set(s => listed(s, list)); } catch { this.set(s => ({ ...s, listed: true })); /* the sidebar says it loaded nothing */ }
  }

  async addProject(): Promise<string | null> {
    let r: CodeDone<import("../../shared/code").CodeProject>;
    try { r = await this.api.addProject(); } catch { r = { ok: false, reason: UNREACHABLE }; }
    if (!r.ok) { if (r.code !== "cancelled") this.set(s => setNote(s, "", "sidebar", r.ok ? "" : r.reason)); return null; }
    const p = r.value;
    this.set(s => setNote(projectAdded(s, p), "", "sidebar", ""));
    return p.id;
  }

  /** Show a view of the main area. */
  showView(view: MainView): void { this.set(s => show(s, view)); }

  /** Show a session, attaching to it first when this window isn't watching it. */
  async openSession(id: string): Promise<void> {
    this.set(s => show(s, { kind: "session", id }));
    this.attachedOrder = [...this.attachedOrder.filter(x => x !== id), id];
    await this.attach(id);
    this.trimAttached();
    void this.loadSessionLists(id);
  }

  /**
   * Attach to a session: everything since the last seq this window applied (a gap's catch-up), or its whole kept
   * history the first time. One attach per session at a time.
   */
  attach(id: string, resync = false): Promise<void> {
    const running = this.attaching.get(id);
    if (running) return running;
    const t = this.state.transcripts[id];
    if (t && !resync && !t.stale) return Promise.resolve();
    // After a rewind or a cut the whole history is asked for again.
    const since = t && !t.rebuild ? t.lastSeq : undefined;
    const job = (async () => {
      try {
        const r = await this.api.attach(id, since);
        if (r.ok) this.set(s => attached(s, id, r.value, since));
        else this.set(s => setNote(s, id, "attach", r.reason));
      } catch { this.set(s => setNote(s, id, "attach", UNREACHABLE)); }
    })().finally(() => this.attaching.delete(id));
    this.attaching.set(id, job);
    return job;
  }

  /** Stop watching a session here (it keeps running): the window keeps a few, busy ones first. */
  detach(id: string): void {
    this.api.detach(id);
    this.attachedOrder = this.attachedOrder.filter(x => x !== id);
    this.set(s => detached(s, id));
  }

  private trimAttached(): void {
    const shown = this.state.view.kind === "session" ? this.state.view.id : null;
    const idle = this.attachedOrder.filter(id => id !== shown && !this.state.transcripts[id]?.busy && !Object.values(this.state.pending).some(p => p.sessionId === id));
    while (this.attachedOrder.length > ATTACHED_MAX + 1 && idle.length) this.detach(idle.shift()!);
  }

  async create(options: CodeCreate): Promise<string | null> {
    let r: CodeDone<import("../../shared/code").CodeSessionRow>;
    try { r = await this.api.create(options); } catch { r = { ok: false, reason: UNREACHABLE }; }
    if (!r.ok) { this.set(s => setNote(s, "", "start", r.ok ? "" : r.reason)); return null; }
    const row = r.value;
    this.set(s => setNote(rowChanged(s, row), "", "start", ""));
    await this.openSession(row.id);
    return row.id;
  }

  /** Delete a session (its history and the worktree Ember made for it): main's row change takes it off the list. */
  async remove(id: string): Promise<boolean> {
    let r: CodeDone;
    try { r = await this.api.remove(id); } catch { r = { ok: false, reason: UNREACHABLE }; }
    this.attachedOrder = this.attachedOrder.filter(x => x !== id);
    this.set(s => (r.ok ? rowChanged(s, { removed: id }) : setNote(s, "", "sidebar", reasonOf(r))));
    return r.ok;
  }

  /** A copy of a session from its history (a worktree session's copy gets a worktree of its own), then shown. */
  async fork(id: string): Promise<string | null> {
    let r: CodeDone<import("../../shared/code").CodeSessionRow>;
    try { r = await this.api.fork(id); } catch { r = { ok: false, reason: UNREACHABLE }; }
    if (!r.ok) { this.set(s => setNote(s, id, "composer", reasonOf(r))); return null; }
    const row = r.value;
    this.set(s => rowChanged(s, row));
    await this.openSession(row.id);
    return row.id;
  }

  /** The session is shown and the window has the focus: main clears its unread count (once each time it is shown). */
  markRead(id: string): void {
    if (this.readMarked === id) return;
    this.readMarked = id;
    try { this.api.markRead(id); } catch { /* main unreachable: the count stays until the next look */ }
  }
  /** The window looked away (blurred or showing something else): the next look marks again. */
  unmarkRead(): void { this.readMarked = null; }
  private readMarked: string | null = null;

  /** Open an address in the person's browser through main; why not, in the session's note. */
  async openLink(sessionId: string, url: string): Promise<void> {
    let r: CodeDone;
    try { r = await this.api.openLink(url); } catch { r = { ok: false, reason: UNREACHABLE }; }
    this.set(s => setNote(s, sessionId, "composer", r.ok ? "" : reasonOf(r)));
  }

  async updateRow(id: string, change: { name?: string; pinned?: boolean; archived?: boolean }): Promise<void> {
    try {
      const r = await this.api.update(id, change);
      if (r.ok) this.set(s => rowChanged(s, r.value));
      else this.set(s => setNote(s, "", "sidebar", r.reason));
    } catch { this.set(s => setNote(s, "", "sidebar", UNREACHABLE)); }
  }

  // ───── Messages and turns ─────

  /** Send a message: shown at once as the person's, then main's answer (its id, or why it didn't go). */
  async send(sessionId: string, prompt: string, attachments: CodeAttachment[], mode?: "enqueue" | "immediate"): Promise<boolean> {
    const k = this.key("you");
    this.set(s => sent(s, sessionId, k, prompt, attachments, mode));
    let r: CodeDone<{ messageId: string }>;
    try { r = await this.api.send({ sessionId, prompt, ...(attachments.length ? { attachments } : {}), ...(mode ? { mode } : {}) }); } catch { r = { ok: false, reason: UNREACHABLE }; }
    this.set(s => sendDone(s, sessionId, k, r.ok ? { ok: true, messageId: r.value.messageId } : { ok: false, reason: reasonOf(r) }));
    if (mode === "enqueue" || mode === "immediate") void this.readQueue(sessionId);
    return r.ok;
  }

  async interrupt(sessionId: string): Promise<void> {
    try {
      const r = await this.api.interrupt(sessionId);
      this.set(s => setNote(s, sessionId, "stop", r.ok ? "" : r.reason));
    } catch { this.set(s => setNote(s, sessionId, "stop", UNREACHABLE)); }
  }

  stopAll(): void { this.api.stopAll(); }

  /** Answer a request once: the card says it is on its way, and comes back with main's sentence if it was refused. */
  async respond(answer: CodeRequestAnswer): Promise<void> {
    if (this.state.answering[answer.requestId]?.state === "sending") return;
    this.set(s => answering(s, answer.requestId, { state: "sending" }));
    let r: CodeDone;
    try { r = await this.api.respond(answer); } catch { r = { ok: false, reason: UNREACHABLE }; }
    this.set(s => (r.ok ? s : answering(s, answer.requestId, { state: "refused", reason: reasonOf(r) })));
  }

  /** Change a mode: the picker then shows the mode main says is in force, and why when it isn't the one asked for. */
  async setMode(sessionId: string, picker: "agent" | "permission", mode: string): Promise<void> {
    let r: CodeDone<{ mode: string }>;
    try {
      r = picker === "agent" ? await this.api.setAgentMode(sessionId, mode as never) : await this.api.setPermissionMode(sessionId, mode as never);
    } catch { r = { ok: false, reason: UNREACHABLE }; }
    const row = this.state.sessions.byId[sessionId];
    if (!r.ok) {
      // Main names the mode still in force in its refusal's code ("mode:<mode>").
      const held = r.code?.startsWith("mode:") ? r.code.slice(5) : undefined;
      const was = picker === "agent" ? row?.agentMode : row?.permissionMode;
      const why = reasonOf(r);
      this.set(s => {
        const cur = s.sessions.byId[sessionId];
        const next = cur && held ? rowChanged(s, picker === "agent" ? { ...cur, agentMode: held as never } : { ...cur, permissionMode: held as never }) : s;
        return setNote(next, sessionId, picker, modeRefused(picker, mode, held ?? was, why));
      });
      return;
    }
    const inForce = r.value.mode;
    this.set(s => {
      const was = s.sessions.byId[sessionId];
      const next = was ? rowChanged(s, picker === "agent" ? { ...was, agentMode: inForce as never } : { ...was, permissionMode: inForce as never }) : s;
      return setNote(next, sessionId, picker, inForce === mode ? "" : modeRefused(picker, mode, inForce));
    });
  }

  /** Switch the session's model (and reasoning effort) through the SDK's own method. */
  async setModel(sessionId: string, modelId: string, effort?: string): Promise<void> {
    const r = await this.rpc({ scope: "session", sessionId, method: "model.switchTo", params: { modelId, ...(effort ? { reasoningEffort: effort } : {}) } });
    this.set(s => setNote(s, sessionId, "model", r.ok ? "" : modeRefused("model", modelId, s.transcripts[sessionId]?.model, reasonOf(r))));
  }
  async setEffort(sessionId: string, effort: string): Promise<void> {
    const r = await this.rpc({ scope: "session", sessionId, method: "model.setReasoningEffort", params: { reasoningEffort: effort } });
    this.set(s => setNote(s, sessionId, "effort", r.ok ? "" : modeRefused("effort", effort, s.transcripts[sessionId]?.reasoningEffort, reasonOf(r))));
  }

  async pickAttachments(sessionId: string): Promise<CodeAttachment[]> {
    try {
      const r = await this.api.pickAttachments(sessionId);
      if (r.ok) return r.value.slice(0, CODE_LIMITS.attachments);
      if (r.code !== "cancelled") this.set(s => setNote(s, sessionId, "composer", r.reason));
    } catch { this.set(s => setNote(s, sessionId, "composer", UNREACHABLE)); }
    return [];
  }

  // ───── The SDK's methods, by name ─────

  async rpc(call: CodeRpcCall): Promise<CodeDone<unknown>> {
    try { return await this.api.rpc(call); } catch { return { ok: false, reason: UNREACHABLE }; }
  }

  /** The models and agents the start flow and pickers list, read once. */
  async loadCatalog(): Promise<void> {
    if (this.state.catalog.models && this.state.catalog.agents) return;
    const [models, agents] = await Promise.all([
      this.rpc({ scope: "client", method: "models.list", params: {} }),
      this.rpc({ scope: "client", method: "agents.discover", params: {} }),
    ]);
    this.set(s => setCatalog(s, {
      ...(models.ok ? { models: modelsFrom(models.value) } : { models: [], modelsFailed: true }),
      agents: agents.ok ? agentsFrom(agents.value) : [],
    }));
  }

  /** A session's slash commands and completion triggers, read once. */
  async loadSessionLists(sessionId: string): Promise<void> {
    if (!this.commands.has(sessionId)) {
      const r = await this.rpc({ scope: "session", sessionId, method: "commands.list", params: { includeBuiltins: true, includeSkills: true } });
      this.commands.set(sessionId, r.ok ? slashCommands(r.value) : []);
    }
    if (!this.triggers.has(sessionId)) {
      const r = await this.rpc({ scope: "session", sessionId, method: "completions.getTriggerCharacters" });
      const chars = r.ok && Array.isArray((r.value as { triggerCharacters?: unknown })?.triggerCharacters) ? (r.value as { triggerCharacters: unknown[] }).triggerCharacters.filter((c): c is string => typeof c === "string" && c.length === 1) : [];
      this.triggers.set(sessionId, chars);
    }
  }

  /** The session's queue, read again (after a queued send, or when the SDK says it changed). */
  async readQueue(sessionId: string): Promise<void> {
    const version = this.state.transcripts[sessionId]?.versions.queue ?? 0;
    const r = await this.rpc({ scope: "session", sessionId, method: "queue.pendingItems" });
    if (!r.ok) return;
    const q = queueFrom(r.value);
    this.set(s => setQueue(s, sessionId, { ...q, version }));
  }

  /** One of the queue's own changes (remove, edit, send now), then the queue read again. */
  async queueChange(sessionId: string, method: "queue.removeAt" | "queue.updateText" | "queue.sendNow", params: Record<string, unknown>): Promise<void> {
    const r = await this.rpc({ scope: "session", sessionId, method, params });
    this.set(s => setNote(s, sessionId, "queue", r.ok ? "" : reasonOf(r)));
    await this.readQueue(sessionId);
  }

  setUi(patch: Partial<UiPrefs>): void { this.set(s => setUi(s, patch)); }
}

/** The window's layout as it was left (per viewer, in this browser profile only; missing or unreadable: the defaults). */
function loadUi(): UiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) ?? "null") as Partial<UiPrefs> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_UI;
    const n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    return {
      sidebarWidth: n(raw.sidebarWidth, DEFAULT_UI.sidebarWidth, 200, 480),
      panelWidth: n(raw.panelWidth, DEFAULT_UI.panelWidth, 260, 720),
      panelOpen: typeof raw.panelOpen === "boolean" ? raw.panelOpen : DEFAULT_UI.panelOpen,
      panelTab: typeof raw.panelTab === "string" ? raw.panelTab : DEFAULT_UI.panelTab,
      folded: Array.isArray(raw.folded) ? raw.folded.filter((x): x is string => typeof x === "string").slice(0, 200) : [],
    };
  } catch { return DEFAULT_UI; /* storage blocked or broken: the defaults */ }
}
function saveUi(ui: UiPrefs): void {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* storage blocked: the layout isn't kept */ }
}
