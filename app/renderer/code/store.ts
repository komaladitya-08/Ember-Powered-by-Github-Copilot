/**
 * The coding window's state as one pure store: normalised projects and session rows as main lists them, a transcript
 * per attached session (transcript.ts, reduced from the SDK's events), main's pending table, a draft per session and
 * the window's own preferences. Every change returns a new state and leaves the old one as it was, so a view compares
 * by reference to know what to draw again. No DOM and no IPC: main.ts wires it to `window.emberCode`, and
 * test/unit/code-store.test.ts tests it.
 *
 * The one rule it keeps for the person: what waits for an answer is what main's pending table says waits (a request is
 * answered once, through `respond`, and cleared in every window), never what the window works out from events alone.
 */
import type { CodeAttached, CodeAttachment, CodeEventEnvelope, CodePendingRequest, CodeProject, CodeSessionRow } from "../../shared/code";
import {
  EMPTY_TRANSCRIPT, applyEnvelope, attachedTranscript, requestOpened, requestResolved, sendRefused, sendTaken, sentLocally,
  type Transcript,
} from "./transcript";

/** A message not yet sent: kept per session, so moving between sessions loses nothing typed. */
export interface Draft { text: string; attachments: readonly CodeAttachment[] }

/** Panel tabs the window has (panel.ts registers their contents). */
export type PanelTabId = "changes" | "plan" | "files" | "terminal" | "agents" | (string & {});

/** What the window remembers of how it was laid out (kept in localStorage by main.ts). */
export interface UiPrefs {
  sidebarWidth: number;
  panelWidth: number;
  panelOpen: boolean;
  panelTab: PanelTabId;
  /** Projects folded in the sidebar. */
  folded: readonly string[];
}

export const DEFAULT_UI: UiPrefs = { sidebarWidth: 280, panelWidth: 360, panelOpen: false, panelTab: "changes", folded: [] };

/** A request being answered from this window: its answer is on its way, or main refused it with a sentence. */
export interface Answering { state: "sending" | "refused"; reason?: string }

/** Which main view is up: a session, the start flow, the customise surface, or nothing chosen. */
export type MainView = { kind: "session"; id: string } | { kind: "start"; projectId?: string } | { kind: "customise"; section: string } | { kind: "none" };

export interface CodeState {
  projects: { byId: Readonly<Record<string, CodeProject>>; order: readonly string[] };
  sessions: { byId: Readonly<Record<string, CodeSessionRow>>; order: readonly string[] };
  transcripts: Readonly<Record<string, Transcript>>;
  pending: Readonly<Record<string, CodePendingRequest>>;
  answering: Readonly<Record<string, Answering>>;
  drafts: Readonly<Record<string, Draft>>;
  ui: UiPrefs;
  view: MainView;
  /** The sidebar: archived sessions shown instead of the others, and the search's words. */
  archivedView: boolean;
  query: string;
  /** Sessions whose transcript has a gap: the window attaches to each again (and clears it with `attached`). */
  resync: readonly string[];
  /** Listed once at least (before that the sidebar says it is loading). */
  listed: boolean;
  /** A line under a picker or a control, per session (a refused mode change, what a send was refused for). */
  notes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Each session's queue as `queue.pendingItems` last said, with the transcript's queue version it was read at. */
  queues: Readonly<Record<string, QueueView>>;
  /** What the SDK lists for the pickers (client `models.list`, `agents.discover`), once read. */
  catalog: Catalog;
}

/** One queued message or command, as `queue.pendingItems` lists it. */
export interface QueueEntry { id: string; text: string; kind: string }
export interface QueueView { items: readonly QueueEntry[]; steering: readonly string[]; version: number }
/** A model as the pickers need it. */
export interface ModelChoice { id: string; name: string; efforts: readonly string[]; defaultEffort?: string; enabled: boolean }
export interface AgentChoice { id: string; name: string; description?: string }
export interface Catalog { models?: readonly ModelChoice[]; modelsFailed?: boolean; agents?: readonly AgentChoice[] }

export const EMPTY_STATE: CodeState = {
  projects: { byId: {}, order: [] }, sessions: { byId: {}, order: [] }, transcripts: {}, pending: {}, answering: {}, drafts: {},
  ui: DEFAULT_UI, view: { kind: "none" }, archivedView: false, query: "", resync: [], listed: false, notes: {}, queues: {}, catalog: {},
};

/** A line under one of a session's controls (`text` empty: none). */
export function setNote(s: CodeState, sessionId: string, slot: string, text: string): CodeState {
  const was = s.notes[sessionId] ?? {};
  if ((was[slot] ?? "") === text) return s;
  const next = text ? { ...was, [slot]: text } : without(was, slot);
  return { ...s, notes: { ...s.notes, [sessionId]: next } };
}
export function setQueue(s: CodeState, sessionId: string, q: QueueView): CodeState { return { ...s, queues: { ...s.queues, [sessionId]: q } }; }
export function setCatalog(s: CodeState, patch: Partial<Catalog>): CodeState { return { ...s, catalog: { ...s.catalog, ...patch } }; }

const without = <T>(o: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  if (!(key in o)) return o as Record<string, T>;
  const { [key]: _gone, ...rest } = o;
  return rest;
};

/** Main's list: projects and rows as main says they stand; transcripts and drafts kept. */
export function listed(s: CodeState, list: { projects: readonly CodeProject[]; sessions: readonly CodeSessionRow[] }): CodeState {
  const projects = Object.fromEntries(list.projects.map(p => [p.id, p]));
  const sessions = Object.fromEntries(list.sessions.map(r => [r.id, r]));
  const view = s.view.kind === "session" && !sessions[s.view.id] ? { kind: "none" as const } : s.view;
  return {
    ...s, listed: true, view,
    projects: { byId: projects, order: list.projects.map(p => p.id) },
    sessions: { byId: sessions, order: list.sessions.map(r => r.id) },
  };
}

/** A project added (main's picker): listed first. */
export function projectAdded(s: CodeState, p: CodeProject): CodeState {
  return { ...s, projects: { byId: { ...s.projects.byId, [p.id]: p }, order: [p.id, ...s.projects.order.filter(id => id !== p.id)] } };
}

/** A project removed. */
export function projectRemoved(s: CodeState, id: string): CodeState {
  return { ...s, projects: { byId: without(s.projects.byId, id), order: s.projects.order.filter(x => x !== id) } };
}

/** A row main pushed (it changed or is new), or one it removed. */
export function rowChanged(s: CodeState, change: CodeSessionRow | { removed: string }): CodeState {
  if ("removed" in change) {
    const id = change.removed;
    const pending = Object.fromEntries(Object.entries(s.pending).filter(([, p]) => p.sessionId !== id));
    return {
      ...s, pending,
      sessions: { byId: without(s.sessions.byId, id), order: s.sessions.order.filter(x => x !== id) },
      transcripts: without(s.transcripts, id), drafts: without(s.drafts, id),
      view: s.view.kind === "session" && s.view.id === id ? { kind: "none" } : s.view,
    };
  }
  const known = !!s.sessions.byId[change.id];
  return { ...s, sessions: { byId: { ...s.sessions.byId, [change.id]: change }, order: known ? s.sessions.order : [change.id, ...s.sessions.order] } };
}

/** A request main opened, or one it says was resolved (by anyone, in any window). */
export function requestChanged(s: CodeState, change: CodePendingRequest | { resolved: string; sessionId: string; by: string }): CodeState {
  if ("resolved" in change) {
    const t = s.transcripts[change.sessionId];
    return {
      ...s, pending: without(s.pending, change.resolved), answering: without(s.answering, change.resolved),
      ...(t ? { transcripts: { ...s.transcripts, [change.sessionId]: requestResolved(t, change.resolved, change.by) } } : {}),
    };
  }
  const t = s.transcripts[change.sessionId];
  return {
    ...s, pending: { ...s.pending, [change.requestId]: change },
    ...(t ? { transcripts: { ...s.transcripts, [change.sessionId]: requestOpened(t, change.requestId, change.kind, change.data) } } : {}),
  };
}

/** One of main's envelopes. A gap marks the session for attaching again; a session not attached here keeps nothing. */
export function envelope(s: CodeState, env: CodeEventEnvelope): CodeState {
  const t = s.transcripts[env.sessionId];
  if (!t) return s;
  const next = applyEnvelope(t, env);
  if (next === t) return s;
  const resync = next.stale && !s.resync.includes(env.sessionId) ? [...s.resync, env.sessionId] : s.resync;
  return { ...s, resync, transcripts: { ...s.transcripts, [env.sessionId]: next } };
}

/**
 * What an attach returned: the row, the events since `since` (or the whole kept history without it) and every request
 * still waiting, which replaces this session's part of the pending table.
 */
export function attached(s: CodeState, sessionId: string, a: CodeAttached, since?: number): CodeState {
  // Whether a turn is under way is main's to say here: the kept history has no `session.idle` (the SDK doesn't keep it),
  // so a replayed `assistant.turn_start` would otherwise leave every attached session working.
  // `reset` (main's): the events are the whole kept history, so what was shown is dropped and drawn again.
  const reset = a.reset === true;
  let t = { ...attachedTranscript(s.transcripts[sessionId], a.events, a.seq, reset ? undefined : since), busy: a.row.busy };
  const pending: Record<string, CodePendingRequest> = Object.fromEntries(Object.entries(s.pending).filter(([, p]) => p.sessionId !== sessionId));
  for (const p of a.pending) { pending[p.requestId] = p; t = requestOpened(t, p.requestId, p.kind, p.data); }
  // A request this transcript shows as open that main no longer has waiting was answered while the window was away.
  const waiting = new Set(a.pending.map(p => p.requestId));
  t = t.items.reduce((acc, i) => (i.kind === "request" && !i.done && !waiting.has(i.requestId) ? requestResolved(acc, i.requestId, "sdk") : acc), t);
  return {
    ...rowChanged(s, a.row), pending,
    transcripts: { ...s.transcripts, [sessionId]: t },
    resync: s.resync.filter(id => id !== sessionId),
  };
}

/** The window stopped watching a session (detach): its transcript goes, its row and draft stay. */
export function detached(s: CodeState, sessionId: string): CodeState {
  return { ...s, transcripts: without(s.transcripts, sessionId), resync: s.resync.filter(id => id !== sessionId) };
}

const withTranscript = (s: CodeState, id: string, fn: (t: Transcript) => Transcript): CodeState =>
  ({ ...s, transcripts: { ...s.transcripts, [id]: fn(s.transcripts[id] ?? EMPTY_TRANSCRIPT) } });

/** The person sent a message from this window: shown at once, as theirs. */
export function sent(s: CodeState, sessionId: string, key: string, text: string, attachments: readonly CodeAttachment[], delivery?: "enqueue" | "immediate"): CodeState {
  const names = attachments.map(a => a.displayName ?? (a.type === "selection" ? a.filePath : a.type === "blob" ? "image" : a.path).split(/[\\/]/).pop() ?? "");
  return withTranscript(s, sessionId, t => sentLocally(t, key, text, names, delivery));
}
/** Main took it (its message id) or refused it (its sentence). */
export function sendDone(s: CodeState, sessionId: string, key: string, r: { ok: true; messageId: string } | { ok: false; reason: string }): CodeState {
  return withTranscript(s, sessionId, t => (r.ok ? sendTaken(t, key, r.messageId) : sendRefused(t, key, r.reason)));
}

/** An answer on its way from this window, or main's refusal of it (the card's buttons come back with its sentence). */
export function answering(s: CodeState, requestId: string, a: Answering | null): CodeState {
  return { ...s, answering: a ? { ...s.answering, [requestId]: a } : without(s.answering, requestId) };
}

export function setDraft(s: CodeState, sessionId: string, d: Draft): CodeState {
  return { ...s, drafts: d.text || d.attachments.length ? { ...s.drafts, [sessionId]: d } : without(s.drafts, sessionId) };
}
export function setUi(s: CodeState, patch: Partial<UiPrefs>): CodeState { return { ...s, ui: { ...s.ui, ...patch } }; }
export function show(s: CodeState, view: MainView): CodeState { return { ...s, view }; }
export function setQuery(s: CodeState, query: string): CodeState { return { ...s, query }; }
export function setArchivedView(s: CodeState, on: boolean): CodeState { return { ...s, archivedView: on }; }

// ───── Selectors ─────

/** How a session stands, for its mark and its words: needs you first, then working, then unread. */
export type SessionStatus = "needs-you" | "working" | "unread" | "idle";
export function statusOf(s: CodeState, row: CodeSessionRow): SessionStatus {
  if (pendingOf(s, row.id).length || row.pending > 0) return "needs-you";
  const t = s.transcripts[row.id];
  if (row.busy || t?.busy) return "working";
  return row.unread > 0 ? "unread" : "idle";
}

/** Requests waiting in a session, oldest first. */
export function pendingOf(s: CodeState, sessionId: string): CodePendingRequest[] {
  return Object.values(s.pending).filter(p => p.sessionId === sessionId).sort((a, b) => a.openedAt - b.openedAt);
}

/** Every request waiting, oldest first. */
export function allPending(s: CodeState): CodePendingRequest[] {
  return Object.values(s.pending).sort((a, b) => a.openedAt - b.openedAt);
}

/** Whether a session's row matches the sidebar's search (its name, its project's name or folder, its branch). */
export function matches(s: CodeState, row: CodeSessionRow, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const p = s.projects.byId[row.projectId];
  return [row.name, row.folder, row.branch, p?.name, p?.folder].some(v => !!v && v.toLocaleLowerCase().includes(q));
}

/** One project's group in the sidebar. */
export interface SidebarGroup { project: CodeProject | null; projectId: string; rows: CodeSessionRow[] }

/**
 * The sidebar's groups: each project with its sessions (pinned first, then the latest), archived ones only in the
 * archived view, filtered by the search; a project with nothing to show is kept outside a search (so a new project
 * shows), dropped in one. Sessions of a project main no longer lists go in a group of their own.
 */
export function sidebarGroups(s: CodeState): SidebarGroup[] {
  const rows = s.sessions.order.map(id => s.sessions.byId[id]).filter((r): r is CodeSessionRow => !!r)
    .filter(r => r.archived === s.archivedView && matches(s, r, s.query));
  const by = (a: CodeSessionRow, b: CodeSessionRow) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt;
  const groups: SidebarGroup[] = s.projects.order.map(id => ({ project: s.projects.byId[id] ?? null, projectId: id, rows: rows.filter(r => r.projectId === id).sort(by) }));
  const orphans = rows.filter(r => !s.projects.byId[r.projectId]).sort(by);
  if (orphans.length) groups.push({ project: null, projectId: "", rows: orphans });
  return groups.filter(g => g.rows.length || (!s.query.trim() && !s.archivedView && g.project));
}

/** How many sessions are archived (the archived view's count). */
export function archivedCount(s: CodeState): number {
  return Object.values(s.sessions.byId).filter(r => r.archived).length;
}

/** The session shown, if one is. */
export function shownSession(s: CodeState): CodeSessionRow | null {
  return s.view.kind === "session" ? s.sessions.byId[s.view.id] ?? null : null;
}
