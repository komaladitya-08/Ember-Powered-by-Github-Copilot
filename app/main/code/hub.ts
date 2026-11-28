/**
 * The coding hub (docs/CODING-APP.md §2 "CodeHub"): one `dispatch(command, actor)` for every command of the coding
 * window (CODE_IPC), the optional companion and tests, over this run's coding sessions (session-runtime.ts), Ember's
 * index of projects and sessions (session-index.ts) and the folders they work in (workspaces.ts).
 *
 * What it holds whatever the SDK allows (§3 "Guards"), each failing closed: nothing starts, is read from the runtime or
 * is sent before consent (`hasConsent`), or while the feature is off (`settings.code.enabled`); the organisation's
 * policy can only tighten (chat-policy.ts: none at all under LOCKDOWN or with acting off, a mode it forbids refused
 * with the mode that stays); nothing starts or is sent after a vault fill until Ember restarts; Stop (the kill
 * switch's "code" part) aborts every turn and background agent and refuses every request waiting; sign-out or another
 * account stops and lets go of every session; a window's RPC call passes the allow-list and the guards (guards.ts);
 * folders come only from main's own pickers and lists; and the audit log records each session's start and end, each
 * decision with who made it, each mode change and each message (as its length), never a command, a path, a file's
 * words or the person's words. A record that can't be written stops that session. Refusals are plain sentences
 * (CODE_REFUSALS, friendlyError), never the SDK's text. Plain Node: everything it needs is injected.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotClient, SessionEvent } from "@github/copilot-sdk";
import type {
  CodeActor, CodeAgentMode, CodeAttached, CodeAttachment, CodeCreate, CodeDefaults, CodeDone, CodeEventEnvelope, CodeFileRead, CodeFolderListing,
  CodePendingRequest, CodePermissionMode, CodeProject, CodeRequestAnswer, CodeRpcCall, CodeSdkEvent, CodeSend, CodeSessionOptions, CodeSessionRow,
  CodePrune, CodeSettings, CodeSettingsChange,
} from "../../shared/code";
import { CODE_IPC, CODE_LIMITS, linkRefusal } from "../../shared/code";
import type { AuditEntry } from "../policy/audit";
import type { EmberPlace } from "../policy/ember-paths";
import type { StopPart } from "../agent/killswitch";
import type { ChatPolicy } from "../agent/chat-policy";
import type { ModelRedactor } from "../agent/redacting-client";
import { friendlyError, type ServiceKind } from "../agent/presenter";
import { protectedPath } from "../agent/coding-session";
import { boundData, EventLog, eventRedactor } from "./events";
import { CODE_REFUSALS, isInside, reachesEmberData, refuse, rpcFailure, rpcRefusal } from "./guards";
import { FolderPathRefused, listFolder, readFolderFile } from "./folder";
import { KeptMissing, hideMcpSecrets, holdsKept, keptMerged } from "./mcp-secrets";
import { COMPANION_REFUSALS, CompanionPace, companionRefusal } from "./companion";
import type { RequestChange } from "./pending";
import { codeDir } from "./runtime";
import { siblingDenials } from "./state";
import { SessionIndex, indexFile, type IndexSession } from "./session-index";
import { CodeUnavailable, SessionRuntime, readPersistedHistory, rpcFn, sessionStateDir, type CodeAccess, type CodeSandbox, type SessionRuntimeOptions } from "./session-runtime";
import { exportName, transcriptMarkdown } from "./export";
import { FolderRefused, createWorktree, forkWorktree, gitFacts, gitRunner, removeWorktree, usableFolder, type GitRunner } from "./workspaces";

/** Every command the hub takes, by the window's channel names (CODE_IPC). */
export type CodeCommand =
  | { type: "list" }
  | { type: "addProject" }
  | { type: "removeProject"; projectId: string }
  | { type: "create"; options: CodeCreate }
  | { type: "attach"; sessionId: string; sinceSeq?: number }
  | { type: "detach"; sessionId: string }
  | { type: "send"; message: CodeSend }
  | { type: "interrupt"; sessionId: string; keepBackground?: boolean }
  | { type: "stopAll" }
  | { type: "respond"; answer: CodeRequestAnswer }
  | { type: "setPermissionMode"; sessionId: string; mode: CodePermissionMode }
  | { type: "setAgentMode"; sessionId: string; mode: CodeAgentMode }
  | { type: "update"; sessionId: string; change: { name?: string; pinned?: boolean; archived?: boolean } }
  | { type: "fork"; sessionId: string; toEventId?: string; name?: string }
  | { type: "remove"; sessionId: string }
  | { type: "pickAttachments"; sessionId: string }
  | { type: "rpc"; call: CodeRpcCall }
  | { type: "openLink"; url: string }
  | { type: "markRead"; sessionId: string }
  | { type: "listFolder"; sessionId: string; relDir: string }
  | { type: "readFile"; sessionId: string; relPath: string }
  | { type: "settings"; projectId?: string }
  | { type: "setSettings"; change: CodeSettingsChange }
  | { type: "projectFolders"; projectId: string; change: { add: true } | { remove: string } }
  | { type: "sessionOptions"; sessionId: string }
  | { type: "configure"; sessionId: string; options: CodeSessionOptions }
  | { type: "prune"; olderThanDays: number; dryRun: boolean }
  | { type: "exportSession"; sessionId: string };

/** What each command answers. */
export interface CodeAnswers {
  list: { projects: CodeProject[]; sessions: CodeSessionRow[] };
  addProject: CodeDone<CodeProject>;
  removeProject: CodeDone;
  create: CodeDone<CodeSessionRow>;
  attach: CodeDone<CodeAttached>;
  detach: void;
  send: CodeDone<{ messageId: string }>;
  interrupt: CodeDone;
  stopAll: void;
  respond: CodeDone;
  setPermissionMode: CodeDone<{ mode: CodePermissionMode }>;
  setAgentMode: CodeDone<{ mode: CodeAgentMode }>;
  update: CodeDone<CodeSessionRow>;
  fork: CodeDone<CodeSessionRow>;
  remove: CodeDone;
  pickAttachments: CodeDone<CodeAttachment[]>;
  rpc: CodeDone<unknown>;
  openLink: CodeDone;
  markRead: void;
  listFolder: CodeDone<CodeFolderListing>;
  readFile: CodeDone<CodeFileRead>;
  settings: CodeDone<CodeSettings>;
  setSettings: CodeDone<CodeSettings>;
  projectFolders: CodeDone<string[]>;
  sessionOptions: CodeDone<CodeSessionOptions>;
  configure: CodeDone<CodeSessionOptions>;
  prune: CodeDone<CodePrune>;
  exportSession: CodeDone;
}

/** Where a change goes: one window's events, or every window's rows and requests. */
export type CodeEmit = (channel: (typeof CODE_IPC)["event" | "row" | "request"], payload: unknown, to?: string) => void;

/** What a session is to the hub (SessionRuntime, or a fake in tests). */
export type CodeSessionLike = Pick<SessionRuntime,
  "id" | "folder" | "name" | "model" | "permissionMode" | "agentMode" | "busy" | "sandbox" | "closed" | "waiting" |
  "requests" | "respond" | "send" | "interrupt" | "setPermissionMode" | "setAgentMode" | "rename" | "rpc" | "history" | "bounded" | "trustChanged" | "restrict" | "stop" | "close">
  & Partial<Pick<SessionRuntime, "configure">>;

export interface CodeHubDeps {
  /** "Before Ember starts" agreed to. */
  hasConsent(): boolean;
  /** `settings.code.enabled`. */
  enabled(): boolean;
  /** The organisation's policy as sessions take it; null: none at all. */
  policy(): ChatPolicy | null;
  /** Something was filled from the vault in this run. */
  vaultFilled(): boolean;
  /** The sign-in and model; null while Ember isn't connected. */
  access(): (CodeAccess & { service: ServiceKind }) | null;
  /** The coding runtime's client (runtime.ts). */
  client(): Promise<CopilotClient>;
  /** Ember's data folder (the coding folder is inside it). */
  userData: string;
  /** Where the coding runtime keeps its sessions in this run (CodeRuntime.home): beside the data folder, not in it. */
  runtimeHome(): string;
  /** Ember's own data, install and policy paths. */
  protectedPaths(): readonly string[];
  /** Where paths are judged: this computer's OS, the user's home, Ember's paths. */
  place(): EmberPlace;
  audit(): { write(e: AuditEntry): void } | null;
  emit: CodeEmit;
  /** Main's own folder picker; null when none was chosen. */
  pickFolder(): Promise<string | null>;
  /** Main's own file picker rooted at `root`; null when none was chosen. */
  pickFiles(root: string): Promise<string[] | null>;
  /** Main's own save dialog for a file named `name`; null when none was chosen. None: sessions aren't exported. */
  pickSaveFile?: (name: string) => Promise<string | null>;
  /** Opens a checked http or https address in the person's browser (main.ts: shell.openExternal); none: links don't open. */
  openExternal?: (url: string) => Promise<void>;
  log?: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
  redact?: ModelRedactor;
  git?: GitRunner;
  index?: SessionIndex;
  /** Opens a session (SessionRuntime.open; a fake in tests). */
  open?: (o: SessionRuntimeOptions) => Promise<CodeSessionLike>;
  now?: () => number;
}

/** Image types an attachment is sent as a blob for, by extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** Files one pick may return. */
const PICK_MAX = CODE_LIMITS.attachments;
/** Client methods that take the sign-in as a parameter: main adds it (the runtime has none of its own). */
const TAKES_SIGN_IN: ReadonlySet<string> = new Set(["models.list", "account.getQuota"]);
/** Paths offered for one session that are remembered for its attachments at most. */
const OFFERED_MAX = 20_000;

export class CodeHub {
  private readonly sessions = new Map<string, CodeSessionLike>();
  private readonly opening = new Map<string, Promise<CodeSessionLike>>();
  private readonly logs = new Map<string, EventLog>();
  /** Windows (by their id) attached to each session: they get its events. */
  private readonly watchers = new Map<string, Set<string>>();
  /** Events since a window last looked, by session (kept in the index as it changes). */
  private readonly unread = new Map<string, number>();
  /** The session each window (by its id) shows with the focus (markRead): what happens there isn't unread. */
  private readonly looking = new Map<string, string>();
  /** Paths main's pickers offered for each session: only these, or paths in the session's folder, are attached. */
  private readonly offered = new Map<string, Set<string>>();
  private readonly index: SessionIndex;
  private readonly git: GitRunner;
  private readonly now: () => number;
  /** The companion's commands a minute (companion.ts CompanionPace). */
  private readonly pace: CompanionPace;

  constructor(private readonly d: CodeHubDeps) {
    this.index = d.index ?? new SessionIndex(indexFile(codeDir(d.userData)), d.log).load();
    this.git = d.git ?? gitRunner();
    this.now = d.now ?? Date.now;
    this.pace = new CompanionPace(undefined, this.now);
  }

  /** Why nothing may start or be sent now, or null. */
  refusal(): string | null {
    if (!this.d.enabled()) return CODE_REFUSALS.off;
    if (!this.d.hasConsent()) return CODE_REFUSALS.consent;
    if (!this.d.policy()) return CODE_REFUSALS.policy;
    if (this.d.vaultFilled()) return CODE_REFUSALS.vault;
    return null;
  }

  /** Runs one command for `actor` (`from`: the window that sent it, for its events). Never throws. */
  async dispatch<C extends CodeCommand>(command: C, actor: CodeActor, from = "window"): Promise<CodeAnswers[C["type"]]> {
    try {
      if (actor === "companion") {
        // What the companion may ask, and how fast, is the hub's to hold (companion.ts), never the prompt's.
        const why = companionRefusal(command) ?? (command.type !== "stopAll" && !this.pace.take() ? COMPANION_REFUSALS.paced : null);
        this.record(null, { phase: "companion", command: command.type, ...(why ? { refused: true } : {}) });
        if (why) return refuse(why) as unknown as CodeAnswers[C["type"]];
      }
      return await this.run(command, actor, from) as CodeAnswers[C["type"]];
    } catch (err) {
      if (command.type === "list") return { projects: this.index.projects(), sessions: [] } as unknown as CodeAnswers[C["type"]];
      if (command.type === "detach" || command.type === "stopAll" || command.type === "markRead") return undefined as unknown as CodeAnswers[C["type"]];
      if (!(err instanceof CodeUnavailable) && !(err instanceof FolderRefused)) this.d.log?.warn("code.command_failed", { command: command.type, err: err instanceof Error ? err.name : "unknown" });
      return refuse(this.why(err)) as unknown as CodeAnswers[C["type"]];
    }
  }

  private why(err: unknown): string {
    if (err instanceof CodeUnavailable || err instanceof FolderRefused) return err.message;
    const raw = err instanceof Error ? err.message : "";
    return friendlyError(raw, undefined, { provider: this.d.access()?.service ?? false });
  }

  private async run(c: CodeCommand, actor: CodeActor, from: string): Promise<unknown> {
    switch (c.type) {
      case "list": return this.list();
      case "addProject": return this.addProject();
      case "removeProject": return this.removeProject(c.projectId);
      case "create": return this.create(c.options, actor);
      case "attach": return this.attach(c.sessionId, c.sinceSeq, from);
      case "detach": this.detach(c.sessionId, from); return undefined;
      case "send": return this.send(c.message, actor);
      case "interrupt": return this.interrupt(c.sessionId, c.keepBackground === true, actor);
      case "stopAll": await this.stopAll(); return undefined;
      case "respond": return this.respond(c.answer, actor);
      case "setPermissionMode": return this.setPermissionMode(c.sessionId, c.mode, actor);
      case "setAgentMode": return this.setAgentMode(c.sessionId, c.mode, actor);
      case "update": return this.update(c.sessionId, c.change, actor);
      case "fork": return this.fork(c.sessionId, c.toEventId, c.name, actor);
      case "remove": return this.remove(c.sessionId, actor);
      case "pickAttachments": return this.pickAttachments(c.sessionId);
      case "rpc": return this.rpc(c.call);
      case "openLink": return this.openLink(c.url, actor);
      case "markRead": this.markRead(c.sessionId, from); return undefined;
      case "listFolder": return this.listFolder(c.sessionId, c.relDir);
      case "readFile": return this.readFile(c.sessionId, c.relPath);
      case "settings": return this.settings(c.projectId);
      case "setSettings": return this.setSettings(c.change, actor);
      case "projectFolders": return this.projectFolders(c.projectId, c.change, actor);
      case "sessionOptions": return this.sessionOptions(c.sessionId);
      case "configure": return this.configure(c.sessionId, c.options, actor);
      case "prune": return this.prune(c.olderThanDays, c.dryRun, actor);
      case "exportSession": return this.exportSession(c.sessionId, actor);
    }
  }

  private gate(): ChatPolicy {
    const why = this.refusal();
    if (why) throw new CodeUnavailable(why);
    return this.d.policy()!;
  }

  // ── Projects and the list ────────────────────────────────────────────────────────────────────────────────────

  private async list(): Promise<CodeAnswers["list"]> {
    const meta = new Map<string, { summary?: string; startTime?: Date | string; modifiedTime?: Date | string; folder?: string }>();
    // The SDK's own metadata only once the feature may run: nothing is read from the runtime before consent.
    if (!this.refusal()) {
      const kept = await (await this.d.client()).listSessions().catch(() => []);
      for (const k of kept) meta.set(k.sessionId, { ...(k.summary ? { summary: k.summary } : {}), startTime: k.startTime, modifiedTime: k.modifiedTime, ...(k.context?.workingDirectory ? { folder: k.context.workingDirectory } : {}) });
      for (const [id, m] of meta) if (!this.index.session(id) && m.folder) await this.adopt(id, m.folder);
    }
    const ids = new Set([...this.index.sessionIds(), ...meta.keys(), ...this.sessions.keys()]);
    const sessions: CodeSessionRow[] = [];
    for (const id of ids) {
      const row = this.row(id, meta.get(id));
      if (row) sessions.push(row);
    }
    return { projects: this.index.projects(), sessions };
  }

  /**
   * A session the runtime keeps that Ember's index doesn't (made before the index, or the index was lost): indexed under
   * the project of its folder, which is added as the folder picker would add it. A folder Ember won't work in (gone, or
   * its own data) leaves it under no project (projectId "": the window's "Other sessions"), unindexed.
   */
  private async adopt(id: string, folder: string): Promise<void> {
    try {
      const usable = await usableFolder(folder, this.emberPaths());
      const project = this.index.projectAt(usable) ?? this.index.addProject({ folder: usable, name: path.basename(usable) || usable, ...(await gitFacts(usable, this.git)) });
      if (!this.index.session(id)) this.index.addSession(id, { projectId: project.id, folder: usable, isolation: "folder", createdBy: "system" });
    } catch (err) {
      if (!(err instanceof FolderRefused)) this.d.log?.warn("code.adopt_failed", { err: err instanceof Error ? err.name : "unknown" });
    }
  }

  private async addProject(): Promise<CodeDone<CodeProject>> {
    this.gate();
    const picked = await this.d.pickFolder();
    if (!picked) return refuse(CODE_REFUSALS.picked);
    const project = await this.projectFor(picked);
    return { ok: true, value: project };
  }

  /** The project of a folder main's picker chose: refused for Ember's own data; git's facts read. */
  private async projectFor(picked: string): Promise<CodeProject> {
    const folder = await usableFolder(picked, this.emberPaths());
    const facts = await gitFacts(folder, this.git);
    const p = this.index.addProject({ folder, name: path.basename(folder) || folder, ...facts });
    return this.index.projects().find(x => x.id === p.id)!;
  }

  /** Refused while any session, archived ones too, is under the project: none is left pointing at a project gone. */
  private async removeProject(projectId: string): Promise<CodeDone> {
    if (!this.index.project(projectId)) return refuse(CODE_REFUSALS.project);
    if (this.index.sessionIds().some(id => this.index.session(id)?.projectId === projectId)) return refuse(CODE_REFUSALS.projectHasSessions, "has-sessions");
    if (!this.index.removeProject(projectId)) return refuse(CODE_REFUSALS.project);
    return { ok: true };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async create(asked: CodeCreate, actor: CodeActor): Promise<CodeDone<CodeSessionRow>> {
    let o = asked;
    const policy = this.gate();
    const access = this.d.access();
    if (!access) throw new CodeUnavailable(CODE_REFUSALS.offline);
    if (o.permissionMode && !policy.permissionModes.includes(o.permissionMode)) throw new CodeUnavailable(CODE_REFUSALS.modeRefused);
    if (o.name !== undefined && o.name.length > CODE_LIMITS.name) throw new CodeUnavailable(CODE_REFUSALS.name);
    let project: CodeProject;
    if (o.projectId) {
      const known = this.index.project(o.projectId);
      if (!known) throw new CodeUnavailable(CODE_REFUSALS.project);
      project = await this.projectFor(known.folder);
    } else {
      const picked = await this.d.pickFolder();
      if (!picked) return refuse(CODE_REFUSALS.picked);
      project = await this.projectFor(picked);
    }
    // What the start named wins; what it left out is the person's defaults (the project's over everyone's).
    const d = this.userDefaults(project.id);
    o = {
      ...o,
      ...(o.isolation === undefined && d.isolation === "worktree" && project.gitRoot ? { isolation: "worktree" } : {}),
      ...(o.model === undefined && d.model ? { model: d.model } : {}),
      ...(o.reasoningEffort === undefined && o.model === undefined && d.reasoningEffort ? { reasoningEffort: d.reasoningEffort } : {}),
      ...(o.permissionMode === undefined && d.permissionMode ? { permissionMode: d.permissionMode } : {}),
      ...(o.agentMode === undefined && d.agentMode ? { agentMode: d.agentMode } : {}),
    };
    const id = crypto.randomUUID();
    const isolation = o.isolation ?? "folder";
    let folder = project.folder;
    let tree: { folder: string; branch: string; baseBranch: string } | undefined;
    if (isolation === "worktree") {
      tree = await createWorktree({ codeDir: codeDir(this.d.userData), sessionId: id, gitRoot: project.gitRoot, ...(o.baseBranch ? { baseBranch: o.baseBranch } : {}), git: this.git });
      folder = tree.folder;
    }
    this.index.addSession(id, {
      projectId: project.id, folder, isolation, createdBy: actor,
      ...(tree ? { branch: tree.branch, baseBranch: tree.baseBranch, worktree: tree.folder, ...(project.gitRoot ? { gitRoot: project.gitRoot } : {}) } : project.branch ? { branch: project.branch } : {}),
      ...(o.name ? { name: o.name.trim() } : {}), ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}), ...(o.agentMode ? { agentMode: o.agentMode } : {}),
      ...(o.model ? { model: o.model } : {}),
    });
    try {
      const s = await this.openSession(id, false, {
        ...(o.model ? { model: o.model } : {}), ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}), ...(o.agent ? { agent: o.agent } : {}),
        ...(o.name ? { name: o.name.trim() } : {}), ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}), ...(o.agentMode ? { agentMode: o.agentMode } : {}),
      });
      this.record(id, { phase: "start", by: actor, isolation, sandbox: s.sandbox, permissionMode: s.permissionMode, agentMode: s.agentMode });
    } catch (err) {
      // Nothing is left of a session that didn't start: its record and the worktree made for it go.
      this.index.removeSession(id);
      if (tree) await removeWorktree({ codeDir: codeDir(this.d.userData), folder: tree.folder, ...(project.gitRoot ? { gitRoot: project.gitRoot } : {}), git: this.git }).catch(() => undefined);
      throw err;
    }
    const row = this.row(id)!;
    this.d.emit(CODE_IPC.row, row);
    return { ok: true, value: row };
  }

  /** The open session `id`, opened (resumed) when it is kept but not open. */
  private async ensureOpen(id: string): Promise<CodeSessionLike> {
    const open = this.sessions.get(id);
    if (open && !open.closed) return open;
    this.gate();
    return this.openSession(id, true);
  }

  private async openSession(id: string, resume: boolean, start?: SessionRuntimeOptions["start"]): Promise<CodeSessionLike> {
    const already = this.opening.get(id);
    if (already) return already;
    const policy = this.gate();
    const access = this.d.access();
    if (!access) throw new CodeUnavailable(CODE_REFUSALS.offline);
    let record = this.index.session(id);
    if (!record && resume) {
      // A session the runtime keeps that the index doesn't (made before the index, or the index was lost).
      const meta = await (await this.d.client()).getSessionMetadata(id).catch(() => undefined);
      const folder = meta?.context?.workingDirectory;
      if (!folder) throw new CodeUnavailable(CODE_REFUSALS.unknown);
      const usable = await usableFolder(folder, this.emberPaths());
      const project = this.index.projectAt(usable) ?? this.index.addProject({ folder: usable, name: path.basename(usable) || usable, ...(await gitFacts(usable, this.git)) });
      record = this.index.addSession(id, { projectId: project.id, folder: usable, isolation: "folder", createdBy: "system" });
    }
    if (!record) throw new CodeUnavailable(CODE_REFUSALS.unknown);
    const folder = record.worktree ? record.folder : await usableFolder(record.folder, this.emberPaths());
    const client = await this.d.client();
    const protectedPaths = this.emberPaths();
    const denied = await this.denied(id);
    const log = this.logs.get(id) ?? new EventLog(id);
    this.logs.set(id, log);
    const setup = await this.setupFor(record);
    const making = (this.d.open ?? SessionRuntime.open)({
      ...(setup ? { setup } : {}),
      client, id, resume, folder, denied, place: { ...this.d.place(), ember: protectedPaths }, stateDir: sessionStateDir(this.d.runtimeHome(), id),
      policy, access: { ...(access.model ? { model: access.model } : {}), ...(access.provider ? { provider: access.provider } : !access.provider && access.gitHubToken ? { gitHubToken: access.gitHubToken } : {}) },
      log, start: start ?? { ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}), ...(record.agentMode ? { agentMode: record.agentMode } : {}) },
      ...(this.d.redact ? { redact: this.d.redact } : {}),
      onEnvelope: e => this.onEnvelope(e),
      onRequest: change => this.onRequest(change),
      onFacts: () => this.onFacts(id),
      onDecided: d => this.record(id, { phase: "decision", kind: d.kind, decision: d.decision, by: d.by }),
    });
    this.opening.set(id, making);
    let session: CodeSessionLike;
    try { session = await making; } finally { this.opening.delete(id); }
    // Consent, the policy or the vault changed while it opened: it doesn't stay.
    if (this.refusal()) { await session.close().catch(() => undefined); this.gate(); }
    this.sessions.set(id, session);
    if (resume) this.record(id, { phase: "open", permissionMode: session.permissionMode, agentMode: session.agentMode, sandbox: session.sandbox });
    await this.restrictOthers(id);
    return session;
  }

  /** Ember's own paths and the coding runtime's state folder, which no tool reaches but for a session's own state. */
  private emberPaths(): string[] {
    return [...new Set([...this.d.protectedPaths(), this.d.runtimeHome()])];
  }

  /**
   * What session `id`'s sandbox denies: Ember's own paths (each as named and as resolved), and of the runtime's state
   * folder everything but this session's own state (state.ts `siblingDenials`; the folder itself can't be denied, or
   * its own state would be too). Where the state folder lies inside one of Ember's paths (an earlier build's that
   * couldn't be moved) that path denies it whole, as before.
   */
  private async denied(id: string): Promise<string[]> {
    const root = path.resolve(this.d.runtimeHome());
    const ember = this.d.protectedPaths().filter(p => path.resolve(p) !== root);
    const spellings = await protectedPath(root);
    return [...new Set([...(await Promise.all(ember.map(protectedPath))).flat(), ...await siblingDenials(spellings, id)])];
  }

  /**
   * After a session opened (its state folder may be new), every other open session's sandbox denies that folder too,
   * for the commands it starts from then on; a session whose sandbox won't take it is closed (fail closed).
   */
  private async restrictOthers(opened: string): Promise<void> {
    for (const [id, s] of [...this.sessions.entries()]) {
      if (id === opened || s.closed || s.sandbox === "off") continue;
      const ok = await s.restrict(await this.denied(id)).catch(() => false);
      if (ok || s.closed) continue;
      this.d.log?.warn("code.restrict_failed", {});
      this.sessions.delete(id);
      await s.close().catch(() => undefined);
      this.record(id, { phase: "close" });
      this.onFacts(id);
    }
  }

  private async attach(id: string, sinceSeq: number | undefined, from: string): Promise<CodeDone<CodeAttached>> {
    const s = await this.ensureOpen(id);
    const log = this.logs.get(id)!;
    let events: CodeEventEnvelope[] | null = sinceSeq === undefined ? null : log.since(sinceSeq);
    let reset = false;
    if (events === null) {
      reset = true;
      if (log.whole) events = log.held();
      else {
        const kept = await s.history().catch(() => [] as SessionEvent[]);
        events = log.history(kept.map(e => s.bounded(e)), event => {
          const n = log.seqOf(event.id);
          if (n !== undefined) this.toWatchers(id, { sessionId: id, seq: n, event });
        });
      }
    }
    let set = this.watchers.get(id);
    if (!set) this.watchers.set(id, set = new Set());
    set.add(from);
    this.seen(id);
    const row = this.row(id)!;
    return { ok: true, value: { row, events, pending: s.requests(), seq: log.seq, ...(reset ? { reset: true } : {}) } };
  }

  private detach(id: string, from: string): void {
    this.watchers.get(id)?.delete(from);
    if (this.looking.get(from) === id) this.looking.delete(from);
  }

  private async send(m: CodeSend, actor: CodeActor): Promise<CodeDone<{ messageId: string }>> {
    this.gate();
    if (!this.d.access()) throw new CodeUnavailable(CODE_REFUSALS.offline);
    if (m.prompt.length > CODE_LIMITS.prompt) throw new CodeUnavailable(CODE_REFUSALS.prompt);
    if ((m.attachments?.length ?? 0) > CODE_LIMITS.attachments) throw new CodeUnavailable(CODE_REFUSALS.tooMany);
    const s = await this.ensureOpen(m.sessionId);
    const attachments = (m.attachments ?? []).map(a => this.checkedAttachment(m.sessionId, s.folder, a));
    if (!this.record(m.sessionId, { phase: "sent", by: actor, chars: m.prompt.length, attachments: attachments.length, ...(m.mode ? { mode: m.mode } : {}) })) throw new CodeUnavailable(CODE_REFUSALS.audit);
    const messageId = await s.send({ prompt: m.prompt, ...(attachments.length ? { attachments } : {}), ...(m.mode ? { mode: m.mode } : {}), ...(m.agentMode ? { agentMode: m.agentMode } : {}) });
    return { ok: true, value: { messageId: String(messageId ?? "") } };
  }

  /** An attachment as it is sent: a path main offered or one in the session's folder, never Ember's data; an image within the limit. */
  private checkedAttachment(id: string, folder: string, a: CodeAttachment): CodeAttachment {
    const offered = this.offered.get(id) ?? new Set<string>();
    const pathOk = (p: string) => path.isAbsolute(p) && (offered.has(p) || isInside(p, folder)) && reachesEmberData([p], { place: { ...this.d.place(), ember: this.emberPaths() }, cwd: folder }) === false;
    switch (a.type) {
      case "file": case "directory":
        if (!pathOk(a.path)) throw new CodeUnavailable(CODE_REFUSALS.attachment);
        return a;
      case "selection":
        if (!pathOk(a.filePath)) throw new CodeUnavailable(CODE_REFUSALS.attachment);
        return a;
      case "blob":
        if (!/^image\/(png|jpeg|gif|webp)$/.test(a.mimeType) || a.data.length > Math.ceil(CODE_LIMITS.blob / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new CodeUnavailable(CODE_REFUSALS.attachment);
        return a;
    }
  }

  private async interrupt(id: string, keepBackground: boolean, actor: CodeActor): Promise<CodeDone> {
    const s = this.sessions.get(id);
    if (!s || s.closed) return refuse(CODE_REFUSALS.closed);
    await s.interrupt(keepBackground);
    this.record(id, { phase: "interrupt", by: actor, keepBackground });
    return { ok: true };
  }

  /** Stops every session at once (and any still opening, once it opens). */
  stopAll(): Promise<void> {
    const work: Promise<unknown>[] = [...this.sessions.values()].map(s => s.stop().catch(() => undefined));
    for (const making of this.opening.values()) work.push(making.then(s => s.stop()).catch(() => undefined));
    return Promise.all(work).then(() => undefined);
  }

  private async respond(a: CodeRequestAnswer, actor: CodeActor): Promise<CodeDone> {
    const s = this.sessions.get(a.sessionId);
    if (!s || s.closed) return refuse(CODE_REFUSALS.request);
    // The companion reads a request out; the person answers it (docs/CODING-APP.md §5: not in the first release).
    if (actor === "companion") return refuse(CODE_REFUSALS.companionAnswer);
    await s.respond(a.requestId, a.kind, a.payload, actor);
    return { ok: true };
  }

  private async setPermissionMode(id: string, mode: CodePermissionMode, actor: CodeActor): Promise<CodeDone<{ mode: CodePermissionMode }>> {
    const policy = this.gate();
    const s = await this.ensureOpen(id);
    // The organisation's cap is Ember's to keep too: refused, saying which mode stays.
    if (!policy.permissionModes.includes(mode)) return refuse(CODE_REFUSALS.modeRefused, `mode:${s.permissionMode}`);
    const before = s.permissionMode;
    const after = await s.setPermissionMode(mode);
    this.index.updateSession(id, { permissionMode: after });
    this.record(id, { phase: "mode", by: actor, permissionMode: after, before, requested: mode });
    if (after !== mode) return refuse(CODE_REFUSALS.modeRefused, `mode:${after}`);
    return { ok: true, value: { mode: after } };
  }

  private async setAgentMode(id: string, mode: CodeAgentMode, actor: CodeActor): Promise<CodeDone<{ mode: CodeAgentMode }>> {
    this.gate();
    const s = await this.ensureOpen(id);
    const before = s.agentMode;
    const after = await s.setAgentMode(mode);
    this.index.updateSession(id, { agentMode: after });
    this.record(id, { phase: "mode", by: actor, agentMode: after, before, requested: mode });
    return { ok: true, value: { mode: after } };
  }

  private async update(id: string, change: { name?: string; pinned?: boolean; archived?: boolean }, actor: CodeActor): Promise<CodeDone<CodeSessionRow>> {
    if (!this.index.session(id) && !this.sessions.has(id)) return refuse(CODE_REFUSALS.unknown);
    if (change.name !== undefined) {
      const name = change.name.trim();
      if (name.length > CODE_LIMITS.name) return refuse(CODE_REFUSALS.name);
      const s = this.sessions.get(id);
      if (s && !s.closed) await s.rename(name);
      this.index.updateSession(id, { name });
    }
    if (change.pinned !== undefined || change.archived !== undefined) {
      this.index.updateSession(id, { ...(change.pinned !== undefined ? { pinned: change.pinned } : {}), ...(change.archived !== undefined ? { archived: change.archived } : {}) }, false);
    }
    this.record(id, { phase: "update", by: actor, ...(change.name !== undefined ? { nameChars: change.name.length } : {}), ...(change.pinned !== undefined ? { pinned: change.pinned } : {}), ...(change.archived !== undefined ? { archived: change.archived } : {}) });
    const row = this.row(id)!;
    this.d.emit(CODE_IPC.row, row);
    return { ok: true, value: row };
  }

  private async fork(id: string, toEventId: string | undefined, name: string | undefined, actor: CodeActor): Promise<CodeDone<CodeSessionRow>> {
    this.gate();
    const parent = this.index.session(id);
    if (!parent) return refuse(CODE_REFUSALS.unknown);
    if (name !== undefined && name.length > CODE_LIMITS.name) return refuse(CODE_REFUSALS.name);
    const client = await this.d.client();
    const forked = await client.rpc.sessions.fork({ sessionId: id, ...(toEventId ? { toEventId } : {}), ...(name ? { name } : {}) });
    // A fork of a folder session works in that folder. A fork of a worktree session gets a worktree of its own, from
    // where its parent's stands (workspaces.ts forkWorktree), so removing either leaves the other's folder whole; one
    // that can't be made means no fork.
    let tree: { folder: string; branch: string } | undefined;
    if (parent.worktree) {
      try {
        tree = await forkWorktree({ codeDir: codeDir(this.d.userData), sessionId: forked.sessionId, gitRoot: parent.gitRoot, from: parent.worktree, git: this.git });
      } catch (err) {
        await client.deleteSession(forked.sessionId).catch(() => undefined);
        if (!(err instanceof FolderRefused)) this.d.log?.warn("code.fork_tree_failed", { err: err instanceof Error ? err.name : "unknown" });
        return refuse(CODE_REFUSALS.forkTree);
      }
    }
    this.index.addSession(forked.sessionId, {
      projectId: parent.projectId, folder: tree?.folder ?? parent.folder, isolation: parent.isolation, createdBy: actor, parentId: id,
      ...(tree ? { branch: tree.branch, worktree: tree.folder, ...(parent.branch ? { baseBranch: parent.branch } : {}), ...(parent.gitRoot ? { gitRoot: parent.gitRoot } : {}) } : parent.branch ? { branch: parent.branch } : {}),
      ...(name ?? forked.name ? { name: (name ?? forked.name ?? "").slice(0, CODE_LIMITS.name) } : {}),
      ...(parent.permissionMode ? { permissionMode: parent.permissionMode } : {}), ...(parent.agentMode ? { agentMode: parent.agentMode } : {}),
    });
    this.record(forked.sessionId, { phase: "fork", by: actor, parent: id });
    const row = this.row(forked.sessionId)!;
    this.d.emit(CODE_IPC.row, row);
    return { ok: true, value: row };
  }

  private async remove(id: string, actor: CodeActor): Promise<CodeDone> {
    const record = this.index.session(id);
    const open = this.sessions.get(id);
    if (!record && !open) return refuse(CODE_REFUSALS.unknown);
    if (open) await open.close().catch(() => undefined);
    this.sessions.delete(id);
    if (this.d.hasConsent()) await (await this.d.client()).deleteSession(id).catch(err => { this.d.log?.warn("code.delete_failed", { err: err instanceof Error ? err.name : "unknown" }); });
    this.index.removeSession(id);
    // The worktree goes with the session that made it, unless a fork still works in it.
    if (record?.worktree && !this.index.sessionIds().some(other => this.index.session(other)?.folder === record.folder)) {
      await removeWorktree({ codeDir: codeDir(this.d.userData), folder: record.worktree, ...(record.gitRoot ? { gitRoot: record.gitRoot } : {}), git: this.git })
        .catch(err => { this.d.log?.warn("code.worktree_remove_failed", { err: err instanceof Error ? err.name : "unknown" }); });
    }
    this.logs.delete(id);
    this.watchers.delete(id);
    this.unread.delete(id);
    this.offered.delete(id);
    for (const [w, s] of this.looking) if (s === id) this.looking.delete(w);
    this.record(id, { phase: "end", by: actor, removed: true });
    this.d.emit(CODE_IPC.row, { removed: id });
    return { ok: true };
  }

  private async pickAttachments(id: string): Promise<CodeDone<CodeAttachment[]>> {
    this.gate();
    const record = this.index.session(id);
    const open = this.sessions.get(id);
    const folder = open?.folder ?? record?.folder;
    if (!folder) return refuse(CODE_REFUSALS.unknown);
    const picked = await this.d.pickFiles(folder);
    if (!picked?.length) return refuse(CODE_REFUSALS.picked);
    if (picked.length > PICK_MAX) return refuse(CODE_REFUSALS.tooMany);
    const where = { place: { ...this.d.place(), ember: this.emberPaths() }, cwd: folder };
    const out: CodeAttachment[] = [];
    let set = this.offered.get(id);
    if (!set) this.offered.set(id, set = new Set());
    for (const p of picked) {
      if (!path.isAbsolute(p) || reachesEmberData([p], where) !== false) return refuse(CODE_REFUSALS.emberData);
      const mime = IMAGE_TYPES[path.extname(p).toLowerCase()];
      if (mime) {
        const stat = await fs.stat(p);
        if (stat.size > CODE_LIMITS.blob) return refuse("That picture is too large to attach.");
        out.push({ type: "blob", data: (await fs.readFile(p)).toString("base64"), mimeType: mime, displayName: path.basename(p) });
      } else {
        out.push({ type: "file", path: p, displayName: path.basename(p) });
        set.add(p);
      }
    }
    return { ok: true, value: out };
  }

  private async rpc(call: CodeRpcCall): Promise<CodeDone<unknown>> {
    this.gate();
    const place = { ...this.d.place(), ember: this.emberPaths() };
    if (call.scope === "client") {
      // The worktrees Ember made for its sessions are theirs: a discovery call may name one (skills, agents,
      // instructions and hooks of the files that session works in), though it lies in Ember's data folder.
      const trees = this.index.sessionIds().map(id => this.index.session(id)?.worktree).filter((f): f is string => !!f);
      const why = rpcRefusal(call, { place, own: trees });
      if (why) return refuse(why);
      const client = await this.d.client();
      const fn = rpcFn(client.rpc, call.method);
      if (!fn) return refuse(CODE_REFUSALS.rpcNotAllowed);
      let params: unknown = call.params ?? {};
      // The coding runtime is tokenless (runtime.ts): its account-wide lists answer "Not authenticated" unless the
      // call carries the sign-in (probed on runtime 1.0.97), which only main has. Never a token the window sent.
      if (TAKES_SIGN_IN.has(call.method) && params && typeof params === "object" && !Array.isArray(params)) {
        const { gitHubToken: _ignored, ...rest } = params as Record<string, unknown>;
        const token = this.d.access()?.gitHubToken;
        params = token ? { ...rest, gitHubToken: token } : rest;
      }
      // A server's values the window was never sent come back as CODE_KEPT: the stored ones go in their place.
      if ((call.method === "mcp.config.update" || call.method === "mcp.config.add") && holdsKept(params)) {
        try { params = keptMerged(params, await this.rpcCall(() => client.rpc.mcp.config.list())); }
        catch (err) { if (err instanceof KeptMissing) return refuse(CODE_REFUSALS.rpcKept); throw err; }
      }
      const value = await this.rpcCall(() => fn(params));
      return { ok: true, value: this.bound(call.method === "mcp.config.list" ? hideMcpSecrets(value) : value) };
    }
    if (!call.sessionId) return refuse(CODE_REFUSALS.unknown);
    const s = this.sessions.get(call.sessionId);
    if (!s || s.closed) return refuse(CODE_REFUSALS.closed);
    const why = rpcRefusal(call, { place, cwd: s.folder, own: [sessionStateDir(this.d.runtimeHome(), s.id)] });
    if (why) return refuse(why);
    const value = await this.rpcCall(() => s.rpc(call.method, call.params ?? {}));
    // The folder trusted now: its own hooks may run (in the sandbox only: SessionRuntime.trustChanged).
    if (call.method === "permissions.folderTrust.addTrusted") await s.trustChanged().catch(() => undefined);
    return { ok: true, value: this.bound(value) };
  }

  /** An SDK RPC call whose failure is said in Ember's words for a method that failed (`rpcFailure`), never the runtime's. */
  private async rpcCall<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (err) {
      if (err instanceof CodeUnavailable) throw err;
      this.d.log?.warn("code.rpc_failed", { err: err instanceof Error ? err.name : "unknown" });
      throw new CodeUnavailable(rpcFailure(err instanceof Error ? err.message : ""));
    }
  }

  /** The folder a session works in (open or kept) and the place its paths are judged; null for one Ember doesn't know. */
  private sessionFolder(id: string): string | null {
    return this.sessions.get(id)?.folder ?? this.index.session(id)?.folder ?? null;
  }

  /**
   * A folder of the session's working folder (folder.ts): rooted there, never out of it after links, `.git` and what
   * git ignores left out, never Ember's own data (a worktree Ember made is the session's own). The files it lists are
   * ones the window may attach.
   */
  private async listFolder(id: string, relDir: string): Promise<CodeDone<CodeFolderListing>> {
    this.gate();
    const folder = this.sessionFolder(id);
    if (!folder) return refuse(CODE_REFUSALS.unknown);
    const where = { place: { ...this.d.place(), ember: this.emberPaths() }, cwd: folder, own: [folder] };
    let listing: CodeFolderListing;
    try { listing = await listFolder(folder, relDir, this.git); } catch (err) {
      if (err instanceof FolderPathRefused) return refuse(CODE_REFUSALS.folderPath);
      this.d.log?.warn("code.list_folder_failed", { err: err instanceof Error ? err.name : "unknown" });
      return refuse(CODE_REFUSALS.folderRead);
    }
    const entries = listing.entries.filter(e => reachesEmberData([e.path], where) === false);
    let set = this.offered.get(id);
    if (!set) this.offered.set(id, set = new Set());
    for (const e of entries) if (e.kind === "file" && set.size < OFFERED_MAX) set.add(e.path);
    return { ok: true, value: { ...listing, entries } };
  }

  /** A file of the session's working folder, as text within CODE_LIMITS.fileBytes, or why it isn't shown. */
  private async readFile(id: string, relPath: string): Promise<CodeDone<CodeFileRead>> {
    this.gate();
    const folder = this.sessionFolder(id);
    if (!folder) return refuse(CODE_REFUSALS.unknown);
    let read: CodeFileRead & { real: string };
    try { read = await readFolderFile(folder, relPath); } catch (err) {
      if (err instanceof FolderPathRefused) return refuse(CODE_REFUSALS.folderPath);
      this.d.log?.warn("code.read_file_failed", { err: err instanceof Error ? err.name : "unknown" });
      return refuse(CODE_REFUSALS.folderRead);
    }
    const { real, ...value } = read;
    if (reachesEmberData([real], { place: { ...this.d.place(), ember: this.emberPaths() }, cwd: folder, own: [folder] }) !== false) return refuse(CODE_REFUSALS.rpcPath);
    // Redacted as events are (the vault's values, GitHub's tokens), but not cut: CODE_LIMITS.fileBytes bounds it.
    return { ok: true, value: "text" in value ? { text: eventRedactor(this.d.redact)(value.text), size: value.size } : value };
  }

  /**
   * Opens an address from the transcript or a request in the person's browser: http or https only, bounded, with no
   * user name or password in it (`linkRefusal`), and audited by its host alone (never the path or query, which may
   * name a file or carry words). Needs only the feature on and consent: it sends nothing to Copilot.
   */
  private async openLink(url: string, actor: CodeActor): Promise<CodeDone> {
    if (!this.d.enabled()) return refuse(CODE_REFUSALS.off);
    if (!this.d.hasConsent()) return refuse(CODE_REFUSALS.consent);
    const why = linkRefusal(url);
    if (why) return refuse(why === "credentials" ? CODE_REFUSALS.linkCredentials : CODE_REFUSALS.link);
    const host = new URL(url).hostname;
    if (!this.d.openExternal || !this.record(null, { phase: "link", by: actor, host })) return refuse(CODE_REFUSALS.linkFailed);
    try { await this.d.openExternal(url); } catch { return refuse(CODE_REFUSALS.linkFailed); }
    return { ok: true };
  }

  /** The window `from` shows session `id` and has the focus: nothing is unread, and nothing counts while it looks. */
  private markRead(id: string, from: string): void {
    if (!this.index.session(id) && !this.sessions.has(id)) return;
    this.looking.set(from, id);
    const had = this.unread.get(id) ?? this.index.session(id)?.unread ?? 0;
    this.seen(id);
    if (had) { const row = this.row(id); if (row) this.d.emit(CODE_IPC.row, row); }
  }

  /** A coding window closed: it watches and looks at nothing any more. */
  windowGone(from: string): void {
    this.looking.delete(from);
    for (const set of this.watchers.values()) set.delete(from);
  }

  /** Whether a window shows `id` with the focus now (markRead): its events aren't unread. */
  private lookedAt(id: string): boolean {
    for (const s of this.looking.values()) if (s === id) return true;
    return false;
  }

  /** One more thing unread in `id`, kept in the index at once (not only when the session closes). */
  private unreadOne(id: string): void {
    const n = (this.unread.get(id) ?? this.index.session(id)?.unread ?? 0) + 1;
    this.unread.set(id, n);
    this.index.updateSession(id, { unread: n }, false);
  }

  // ── Defaults, a project's settings and a session's options ──────────────────────────────────────────────────

  /**
   * The person's defaults for a new session in project `projectId` (or anywhere, without one): the project's own over
   * everyone's, field by field, with a permission mode the organisation's policy doesn't leave open dropped (the
   * session then starts as manual). What a start or the companion leaves unnamed comes from here; other code in main
   * (the companion's tools, Home) reads "the user's defaults" through this. Reads only Ember's own index.
   */
  userDefaults(projectId?: string): CodeDefaults {
    const project = projectId ? this.index.project(projectId)?.defaults ?? {} : {};
    const merged: CodeDefaults = { ...this.index.defaults(), ...project };
    const modes = this.d.policy()?.permissionModes ?? [];
    if (merged.permissionMode && !modes.includes(merged.permissionMode)) delete merged.permissionMode;
    return merged;
  }

  private settingsView(projectId?: string): CodeSettings {
    const p = projectId ? this.index.project(projectId) : undefined;
    return {
      defaults: this.index.defaults(),
      ...(p ? { project: { ...(p.defaults ? { defaults: { ...p.defaults } } : {}), ...(p.instructions ? { instructions: p.instructions } : {}), ...(p.folders?.length ? { folders: [...p.folders] } : {}) } } : {}),
      effective: this.userDefaults(p?.id),
      permissionModes: [...(this.d.policy()?.permissionModes ?? [])],
    };
  }

  /** Reads only Ember's own index: needs the feature on and consent, not the runtime. */
  private settings(projectId?: string): CodeDone<CodeSettings> {
    if (!this.d.enabled()) return refuse(CODE_REFUSALS.off);
    if (!this.d.hasConsent()) return refuse(CODE_REFUSALS.consent);
    if (projectId && !this.index.project(projectId)) return refuse(CODE_REFUSALS.project);
    return { ok: true, value: this.settingsView(projectId) };
  }

  /**
   * Everyone's or a project's defaults, and a project's instructions: the person's own choice, audited by what changed
   * (keys and the instructions' length, never their words). A default mode the organisation forbids is refused.
   */
  private setSettings(c: CodeSettingsChange, actor: CodeActor): CodeDone<CodeSettings> {
    const policy = this.gate();
    if (c.projectId && !this.index.project(c.projectId)) return refuse(CODE_REFUSALS.project);
    if (c.defaults?.permissionMode && !policy.permissionModes.includes(c.defaults.permissionMode)) return refuse(CODE_REFUSALS.modeRefused);
    if (c.instructions !== undefined && !c.projectId) return refuse(CODE_REFUSALS.project);
    if (c.instructions !== undefined && c.instructions.length > CODE_LIMITS.instructions) return refuse(CODE_REFUSALS.instructions);
    if (c.defaults) {
      const ok = c.projectId ? this.index.updateProject(c.projectId, { defaults: c.defaults }) : this.index.setDefaults(c.defaults);
      if (!ok) return refuse(CODE_REFUSALS.badArgs);
    }
    if (c.instructions !== undefined && c.projectId && !this.index.updateProject(c.projectId, { instructions: c.instructions })) return refuse(CODE_REFUSALS.badArgs);
    this.record(null, { phase: "settings", by: actor, scope: c.projectId ? "project" : "everyone", ...(c.defaults ? { defaults: Object.keys(c.defaults).sort() } : {}), ...(c.instructions !== undefined ? { instructionsChars: c.instructions.length } : {}) });
    return { ok: true, value: this.settingsView(c.projectId) };
  }

  /**
   * A project's extra folders: one added only from main's own folder picker, refused for Ember's own data (and for
   * the project's own folder, which every session has already); one removed only if it is on the list.
   */
  private async projectFolders(projectId: string, change: { add: true } | { remove: string }, actor: CodeActor): Promise<CodeDone<string[]>> {
    this.gate();
    const p = this.index.project(projectId);
    if (!p) return refuse(CODE_REFUSALS.project);
    const now = p.folders ?? [];
    let next: string[];
    if ("remove" in change) {
      if (!now.includes(change.remove)) return refuse(CODE_REFUSALS.folderPath);
      next = now.filter(f => f !== change.remove);
    } else {
      if (now.length >= CODE_LIMITS.folders) return refuse(CODE_REFUSALS.tooManyFolders);
      const picked = await this.d.pickFolder();
      if (!picked) return refuse(CODE_REFUSALS.picked);
      const folder = await usableFolder(picked, this.emberPaths());
      if (folder === p.folder || now.includes(folder)) return { ok: true, value: [...now] };
      next = [...now, folder];
    }
    if (!this.index.updateProject(projectId, { folders: next })) return refuse(CODE_REFUSALS.badArgs);
    this.record(null, { phase: "settings", by: actor, scope: "project", folders: next.length });
    return { ok: true, value: next };
  }

  private sessionOptions(id: string): CodeDone<CodeSessionOptions> {
    if (!this.d.enabled()) return refuse(CODE_REFUSALS.off);
    if (!this.d.hasConsent()) return refuse(CODE_REFUSALS.consent);
    const r = this.index.session(id);
    if (!r) return refuse(CODE_REFUSALS.unknown);
    return { ok: true, value: { ...(r.options ?? {}), ...(r.options?.excludedTools ? { excludedTools: [...r.options.excludedTools] } : {}) } };
  }

  /** A session's options: changed now where it is open (`options.update`), and kept for every time it opens again. */
  private async configure(id: string, options: CodeSessionOptions, actor: CodeActor): Promise<CodeDone<CodeSessionOptions>> {
    this.gate();
    const r = this.index.session(id);
    if (!r) return refuse(CODE_REFUSALS.unknown);
    const next: CodeSessionOptions = { ...(r.options ?? {}), ...options };
    const s = await this.ensureOpen(id);
    if (!s.configure) return refuse(CODE_REFUSALS.rpcUnsupported);
    await this.rpcCall(() => s.configure!(next));
    if (!this.index.updateSession(id, { options: next }, false)) return refuse(CODE_REFUSALS.badArgs);
    this.record(id, { phase: "configure", by: actor, keys: Object.keys(options).sort(), ...(next.excludedTools ? { excludedTools: next.excludedTools.length } : {}) });
    return { ok: true, value: next };
  }

  // ── Storage and export ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Sessions not used for `olderThanDays` days: the runtime's own dry run (`sessions.pruneOld` with `dryRun`) says
   * which, never an open, busy or pinned one (excluded by id), each with its size (`sessions.getSizes`); with `dryRun`
   * false each is deleted as Delete deletes one (its history, its index record, a worktree Ember made), so the index and
   * worktrees stay whole: the runtime's own delete would leave both behind. Audited with the count.
   */
  private async prune(olderThanDays: number, dryRun: boolean, actor: CodeActor): Promise<CodeDone<CodePrune>> {
    this.gate();
    const client = await this.d.client();
    const keep = [...new Set([...[...this.sessions.entries()].filter(([, s]) => !s.closed).map(([id]) => id), ...this.index.sessionIds().filter(id => this.index.session(id)?.pinned)])];
    const plan = await this.rpcCall(() => client.rpc.sessions.pruneOld({ olderThanDays, dryRun: true, includeNamed: true, ...(keep.length ? { excludeSessionIds: keep } : {}) }));
    const sizes = (await this.rpcCall(() => client.rpc.sessions.getSizes()).catch(() => ({ sizes: {} as Record<string, number> }))).sizes ?? {};
    const ids = (plan.candidates ?? []).filter((id: unknown): id is string => typeof id === "string" && !keep.includes(id));
    const sessions = ids.map(id => ({ id, name: this.row(id)?.name ?? "", bytes: typeof sizes[id] === "number" ? sizes[id] : 0 }));
    if (dryRun) return { ok: true, value: { sessions, bytes: sessions.reduce((n, s) => n + s.bytes, 0), deleted: false } };
    let removed = 0;
    for (const s of sessions) if ((await this.remove(s.id, actor)).ok) removed++;
    this.record(null, { phase: "prune", by: actor, olderThanDays, removed });
    return { ok: true, value: { sessions, bytes: sessions.reduce((n, s) => n + s.bytes, 0), deleted: true } };
  }

  /**
   * A session's transcript as Markdown (export.ts) in a file the person chose in main's own save dialog: never a path
   * from the window, never inside Ember's data, written 0600. Read from the SDK's kept events without opening the
   * session, redacted and bounded as events are. Audited by its size, never its words or the path.
   */
  private async exportSession(id: string, actor: CodeActor): Promise<CodeDone> {
    this.gate();
    if (!this.d.pickSaveFile) return refuse(CODE_REFUSALS.rpcUnsupported);
    const row = this.row(id);
    if (!row || !this.index.session(id) && !this.sessions.has(id)) return refuse(CODE_REFUSALS.unknown);
    const open = this.sessions.get(id);
    const kept = await this.rpcCall(async () => (open && !open.closed ? open.history() : readPersistedHistory(await this.d.client(), id)));
    const redact = eventRedactor(this.d.redact);
    const events = kept.map(e => ({ type: String(e.type), data: boundData((e as { data?: unknown }).data ?? {}, redact).data }));
    const markdown = transcriptMarkdown(events, { title: row.name, folder: row.folder, at: new Date(this.now()) });
    const file = await this.d.pickSaveFile(exportName(row.name));
    if (!file) return refuse(CODE_REFUSALS.picked);
    if (!path.isAbsolute(file) || reachesEmberData([file], { place: { ...this.d.place(), ember: this.emberPaths() } }) !== false) return refuse(CODE_REFUSALS.emberData);
    if (!this.record(id, { phase: "export", by: actor, chars: markdown.length })) return refuse(CODE_REFUSALS.audit);
    try { await fs.writeFile(file, markdown, { encoding: "utf8", mode: 0o600 }); } catch (err) {
      this.d.log?.warn("code.export_failed", { err: err instanceof Error ? err.name : "unknown" });
      return refuse(CODE_REFUSALS.exportFailed);
    }
    return { ok: true };
  }

  /** What session `record` opens with: its project's instructions and extra folders (each still usable), its options. */
  private async setupFor(record: IndexSession): Promise<SessionRuntimeOptions["setup"] | undefined> {
    const p = this.index.project(record.projectId);
    const folders: string[] = [];
    for (const f of p?.folders ?? []) {
      // A folder gone, or now Ember's own data, is left out (never handed to the tools).
      try { folders.push(await usableFolder(f, this.emberPaths())); } catch (err) { if (!(err instanceof FolderRefused)) this.d.log?.warn("code.folder_unusable", { err: err instanceof Error ? err.name : "unknown" }); }
    }
    const setup = { ...(p?.instructions ? { instructions: p.instructions } : {}), ...(folders.length ? { folders } : {}), ...(record.options ? { options: record.options } : {}) };
    return Object.keys(setup).length ? setup : undefined;
  }

  /** An RPC result as a window gets it: redacted and bounded as events are. */
  private bound(v: unknown): unknown { return boundData(v ?? null, eventRedactor(this.d.redact)).data; }

  // ── Events, rows and requests ────────────────────────────────────────────────────────────────────────────────

  private onEnvelope(e: CodeEventEnvelope): void {
    this.toWatchers(e.sessionId, e);
    if (!this.lookedAt(e.sessionId) && !e.event.ephemeral) {
      this.unreadOne(e.sessionId);
      const row = this.row(e.sessionId);
      if (row) this.d.emit(CODE_IPC.row, row);
    }
  }

  private toWatchers(id: string, e: CodeEventEnvelope): void {
    for (const w of this.watchers.get(id) ?? []) this.d.emit(CODE_IPC.event, e, w);
  }

  private onRequest(change: RequestChange): void {
    this.d.emit(CODE_IPC.request, change);
    if ("resolved" in change) return;
    // A request waiting counts as unread for a session nobody is looking at.
    if (!this.lookedAt(change.sessionId)) this.unreadOne(change.sessionId);
  }

  private readonly factsQueued = new Set<string>();
  private onFacts(id: string): void {
    // One row a turn of the event loop, whatever changed in it.
    if (this.factsQueued.has(id)) return;
    this.factsQueued.add(id);
    queueMicrotask(() => {
      this.factsQueued.delete(id);
      const s = this.sessions.get(id);
      if (s && !s.closed) this.index.updateSession(id, { permissionMode: s.permissionMode, agentMode: s.agentMode, ...(s.model ? { model: s.model } : {}) }, false);
      const row = this.row(id);
      if (row) this.d.emit(CODE_IPC.row, row);
    });
  }

  /** A window looked: nothing is unread. */
  private seen(id: string): void {
    this.unread.set(id, 0);
    this.index.updateSession(id, { unread: 0 }, false);
  }

  /** The row of `id`: the index's facts, the open session's, and the SDK's metadata. */
  private row(id: string, meta?: { summary?: string; startTime?: Date | string; modifiedTime?: Date | string; folder?: string }): CodeSessionRow | null {
    const r: IndexSession | undefined = this.index.session(id);
    const s = this.sessions.get(id);
    const open = !!s && !s.closed;
    if (!r && !s && !meta) return null;
    const time = (v: Date | string | undefined) => (v === undefined ? undefined : new Date(v).getTime());
    const unread = this.unread.get(id) ?? r?.unread ?? 0;
    const sandbox: CodeSandbox | undefined = open ? s.sandbox : undefined;
    return {
      id, projectId: r?.projectId ?? "",
      name: ((open && s.name) || r?.name || meta?.summary || "").slice(0, CODE_LIMITS.name),
      folder: s?.folder ?? r?.folder ?? meta?.folder ?? "",
      isolation: r?.isolation ?? "folder", ...(r?.branch ? { branch: r.branch } : {}),
      permissionMode: open ? s.permissionMode : r?.permissionMode ?? "manual",
      agentMode: open ? s.agentMode : r?.agentMode ?? "interactive",
      ...((open && s.model) || r?.model ? { model: (open && s.model) || r?.model } : {}),
      open, busy: open && s.busy, pending: open ? s.waiting : 0, unread,
      pinned: r?.pinned ?? false, archived: r?.archived ?? false,
      ...(r?.parentId ? { parentId: r.parentId } : {}), createdBy: r?.createdBy ?? "system",
      createdAt: r?.createdAt ?? time(meta?.startTime) ?? this.now(), updatedAt: Math.max(r?.updatedAt ?? 0, time(meta?.modifiedTime) ?? 0) || this.now(),
      ...(sandbox ? { sandbox } : {}),
    };
  }

  // ── Stop, the account and the gate ───────────────────────────────────────────────────────────────────────────

  /** The kill switch's part: every turn ends, background agents are cancelled and what waits is refused. */
  stopPart(): StopPart {
    return { name: "code", stop: () => this.stopAll() };
  }

  /** Something the gate reads changed (consent, the setting, the policy, a vault fill): where sessions may no longer run, every one stops. */
  changed(): Promise<void> {
    return this.refusal() ? this.stopAll() : Promise.resolve();
  }

  /**
   * Sign-out or another account: every session stops (what waits is refused) and is let go, since each was opened
   * under the sign-in that has ended. What the runtime keeps on disk stays. Never rejects.
   */
  async accountEnded(): Promise<void> {
    try { await this.stopAll(); } catch (err) { this.d.log?.warn("code.stop_failed", { err: err instanceof Error ? err.name : "unknown" }); }
    await this.dispose();
  }

  /** Lets every session go (what the runtime keeps on disk stays), keeping the unread counts in the index. */
  async dispose(): Promise<void> {
    const all = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(all.map(async ([id, s]) => {
      await s.close().catch(() => undefined);
      this.record(id, { phase: "close" });
      this.index.updateSession(id, { unread: this.unread.get(id) ?? 0 }, false);
      const row = this.row(id);
      if (row) this.d.emit(CODE_IPC.row, row);
    }));
    await this.index.flushed();
  }

  /** The requests waiting in every open session (for the companion's "what is waiting"). */
  waiting(): CodePendingRequest[] {
    return [...this.sessions.values()].filter(s => !s.closed).flatMap(s => s.requests());
  }

  /**
   * What the companion's read of session `id` sees (companion.ts readText): its row, the events this run holds for it
   * (none for a session not open in this run: nothing is opened or read from the runtime for a read), what waits in
   * it and its project's name. Null for a session the hub doesn't know, or while sessions may not run. Audited as a
   * companion command.
   */
  companionRead(id: string): { row: CodeSessionRow; events: CodeSdkEvent[]; waiting: CodePendingRequest[]; project: string } | null {
    if (this.refusal()) return null;
    const row = this.row(id);
    if (!row) return null;
    this.record(id, { phase: "companion", command: "read" });
    const s = this.sessions.get(id);
    return {
      row, events: (this.logs.get(id)?.held() ?? []).map(e => e.event), waiting: s && !s.closed ? s.requests() : [],
      project: this.index.project(row.projectId)?.name ?? "",
    };
  }

  /** The name of session `id`'s project, for the companion's words about it ("" when it has none). */
  projectNameOf(id: string): string {
    const p = this.index.session(id)?.projectId;
    return (p && this.index.project(p)?.name) || "";
  }

  /** One audit entry; one that can't be written stops the session it is about (fail closed). Returns whether it was written. */
  private record(id: string | null, fields: Record<string, unknown>): boolean {
    try {
      const audit = this.d.audit();
      if (!audit) throw new Error("no audit log");
      audit.write({ event: "code", ...(id ? { session: id } : {}), ...fields });
      return true;
    } catch (err) {
      this.d.log?.warn("code.audit_failed", { err: err instanceof Error ? err.name : "unknown" });
      const s = id ? this.sessions.get(id) : null;
      void s?.stop().catch(() => undefined);
      return false;
    }
  }
}
