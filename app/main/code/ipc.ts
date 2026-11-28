/**
 * The coding window's channels (CODE_IPC) in main, over the hub (hub.ts). Every handler answers only the coding
 * window's own page (`CodeWindows.isCodeWindow`, checked before anything else: until the window's creator registers
 * it, every sender is refused) and takes its arguments as unknown, checked with zod for type and size (CODE_LIMITS).
 * Paths never come from the window as free text: a folder or a file comes from main's own pickers (the hub). Changes
 * go back on CODE_IPC.event (to the window that attached), row and request (to every coding window). Plain Node:
 * Electron's objects are injected.
 */

import { z } from "zod";
import { CODE_EFFORTS, CODE_IPC, CODE_LIMITS, type CodeActor } from "../../shared/code";
import { CODE_REFUSALS, refuse } from "./guards";
import type { CodeCommand, CodeHub } from "./hub";

/** The part of Electron's ipcMain these channels use. */
export interface CodeIpcMain {
  handle(channel: string, fn: (event: CodeIpcEvent, ...args: unknown[]) => unknown): void;
  on(channel: string, fn: (event: CodeIpcEvent, ...args: unknown[]) => void): void;
}
/** The part of an IPC event the sender check reads. */
export interface CodeIpcEvent { sender: unknown; senderFrame?: { url: string } | null }
/** The part of a webContents the registry uses. */
export interface CodeWebContents {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

/**
 * The coding windows main has made. The window's creator registers its webContents (`register`, which returns how
 * to let it go); the sender check and the sends read only these. With none registered, every sender is refused.
 */
export class CodeWindows {
  private readonly windows = new Map<number, CodeWebContents>();

  constructor(private readonly trustedUrl: (url: string) => boolean = () => true) {}

  /** A coding window's webContents, from its creator; returns its unregistration. */
  register(contents: CodeWebContents): () => void {
    this.windows.set(contents.id, contents);
    return () => { if (this.windows.get(contents.id) === contents) this.windows.delete(contents.id); };
  }

  /** Whether an IPC event came from a registered coding window's own page. */
  isCodeWindow(event: CodeIpcEvent): boolean {
    const sender = event.sender as CodeWebContents | undefined;
    if (!sender || typeof sender.id !== "number") return false;
    const known = this.windows.get(sender.id);
    if (!known || known !== sender || known.isDestroyed()) return false;
    return this.trustedUrl(event.senderFrame?.url ?? "");
  }

  /** Sends to one window (`to`, its id as a string) or every registered one. */
  send(channel: string, payload: unknown, to?: string): void {
    for (const [id, w] of this.windows) {
      if (to !== undefined && String(id) !== to) continue;
      if (w.isDestroyed()) { this.windows.delete(id); continue; }
      try { w.send(channel, payload); } catch { /* a window closing as it is sent to: it gets nothing more */ }
    }
  }
}

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const Mode = z.enum(["manual", "assisted", "allow-all"]);
const Agent = z.enum(["interactive", "plan", "autopilot"]);
const Position = z.object({ line: z.number().int().nonnegative().max(10_000_000), character: z.number().int().nonnegative().max(10_000_000) }).strict();
const PathText = z.string().min(1).max(4096);
/** A path relative to a session's folder ("" for its top): main resolves and checks it (folder.ts). */
const RelPath = z.string().max(CODE_LIMITS.relPath).refine(p => !/[\0\r\n]/.test(p));
const Attachment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), path: PathText, displayName: z.string().max(400).optional() }).strict(),
  z.object({ type: z.literal("directory"), path: PathText, displayName: z.string().max(400).optional() }).strict(),
  z.object({ type: z.literal("selection"), filePath: PathText, displayName: z.string().max(400), text: z.string().max(CODE_LIMITS.prompt).optional(),
    selection: z.object({ start: Position, end: Position }).strict().optional() }).strict(),
  z.object({ type: z.literal("blob"), data: z.string().max(Math.ceil(CODE_LIMITS.blob / 3) * 4), mimeType: z.string().max(100), displayName: z.string().max(400).optional() }).strict(),
]);
const Create = z.object({
  projectId: Id.optional(),
  isolation: z.enum(["folder", "worktree"]).optional(),
  baseBranch: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  permissionMode: Mode.optional(),
  agentMode: Agent.optional(),
  agent: z.string().min(1).max(200).optional(),
  name: z.string().max(CODE_LIMITS.name).optional(),
}).strict();
const Send = z.object({
  sessionId: Id,
  prompt: z.string().max(CODE_LIMITS.prompt),
  attachments: z.array(Attachment).max(CODE_LIMITS.attachments).optional(),
  mode: z.enum(["enqueue", "immediate"]).optional(),
  agentMode: z.enum(["interactive", "plan", "autopilot", "shell"]).optional(),
}).strict();
const Kind = z.enum(["permission", "user-input", "elicitation", "exit-plan-mode", "auto-mode-switch", "session-limits", "mcp-oauth", "sampling"]);
/** Anything JSON can carry, within CODE_LIMITS.params once serialised. */
const Json = z.unknown().refine(v => { try { return Buffer.byteLength(JSON.stringify(v ?? null) ?? "", "utf8") <= CODE_LIMITS.params; } catch { return false; } });
const Answer = z.object({ sessionId: Id, requestId: Id, kind: Kind, payload: Json }).strict();
const Rpc = z.object({
  scope: z.enum(["client", "session"]),
  sessionId: Id.optional(),
  method: z.string().min(1).max(120),
  params: Json.optional(),
}).strict();

const Defaults = z.object({
  permissionMode: Mode.optional(), agentMode: Agent.optional(), model: z.string().min(1).max(200).optional(),
  reasoningEffort: z.enum(CODE_EFFORTS).optional(), isolation: z.enum(["folder", "worktree"]).optional(),
}).strict();
const SettingsChange = z.object({
  projectId: Id.optional(), defaults: Defaults.optional(), instructions: z.string().max(CODE_LIMITS.instructions).optional(),
}).strict();
const Options = z.object({
  reasoningSummary: z.enum(["none", "concise", "detailed"]).optional(),
  contextTier: z.enum(["default", "long_context"]).optional(),
  excludedTools: z.array(z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:*/-]+$/)).max(CODE_LIMITS.excludedTools).optional(),
  coauthor: z.boolean().optional(),
}).strict();
const FolderChange = z.union([z.object({ add: z.literal(true) }).strict(), z.object({ remove: PathText }).strict()]);

/** Each channel's arguments, exactly, and the command they become. */
export const CODE_ARGS = {
  list: { args: z.tuple([]), command: (): CodeCommand => ({ type: "list" }) },
  addProject: { args: z.tuple([]), command: (): CodeCommand => ({ type: "addProject" }) },
  removeProject: { args: z.tuple([Id]), command: ([projectId]: [string]): CodeCommand => ({ type: "removeProject", projectId }) },
  create: { args: z.tuple([Create]), command: ([options]: [z.infer<typeof Create>]): CodeCommand => ({ type: "create", options }) },
  attach: { args: z.union([z.tuple([Id]), z.tuple([Id, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()])]),
    command: ([sessionId, sinceSeq]: [string, number?]): CodeCommand => ({ type: "attach", sessionId, ...(sinceSeq !== undefined ? { sinceSeq } : {}) }) },
  detach: { args: z.tuple([Id]), command: ([sessionId]: [string]): CodeCommand => ({ type: "detach", sessionId }) },
  send: { args: z.tuple([Send]), command: ([message]: [z.infer<typeof Send>]): CodeCommand => ({ type: "send", message }) },
  interrupt: { args: z.union([z.tuple([Id]), z.tuple([Id, z.object({ keepBackground: z.boolean().optional() }).strict().optional()])]),
    command: ([sessionId, o]: [string, { keepBackground?: boolean }?]): CodeCommand => ({ type: "interrupt", sessionId, ...(o?.keepBackground ? { keepBackground: true } : {}) }) },
  stopAll: { args: z.tuple([]), command: (): CodeCommand => ({ type: "stopAll" }) },
  respond: { args: z.tuple([Answer]), command: ([answer]: [z.infer<typeof Answer>]): CodeCommand => ({ type: "respond", answer }) },
  setPermissionMode: { args: z.tuple([Id, Mode]), command: ([sessionId, mode]: [string, z.infer<typeof Mode>]): CodeCommand => ({ type: "setPermissionMode", sessionId, mode }) },
  setAgentMode: { args: z.tuple([Id, Agent]), command: ([sessionId, mode]: [string, z.infer<typeof Agent>]): CodeCommand => ({ type: "setAgentMode", sessionId, mode }) },
  update: { args: z.tuple([Id, z.object({ name: z.string().max(CODE_LIMITS.name).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict()]),
    command: ([sessionId, change]: [string, { name?: string; pinned?: boolean; archived?: boolean }]): CodeCommand => ({ type: "update", sessionId, change }) },
  fork: { args: z.union([z.tuple([Id]), z.tuple([Id, z.object({ toEventId: Id.optional(), name: z.string().max(CODE_LIMITS.name).optional() }).strict().optional()])]),
    command: ([sessionId, o]: [string, { toEventId?: string; name?: string }?]): CodeCommand => ({ type: "fork", sessionId, ...(o?.toEventId ? { toEventId: o.toEventId } : {}), ...(o?.name ? { name: o.name } : {}) }) },
  remove: { args: z.tuple([Id]), command: ([sessionId]: [string]): CodeCommand => ({ type: "remove", sessionId }) },
  pickAttachments: { args: z.tuple([Id]), command: ([sessionId]: [string]): CodeCommand => ({ type: "pickAttachments", sessionId }) },
  rpc: { args: z.tuple([Rpc]), command: ([call]: [z.infer<typeof Rpc>]): CodeCommand => ({ type: "rpc", call }) },
  openLink: { args: z.tuple([z.string().min(1).max(CODE_LIMITS.link)]), command: ([url]: [string]): CodeCommand => ({ type: "openLink", url }) },
  markRead: { args: z.tuple([Id]), command: ([sessionId]: [string]): CodeCommand => ({ type: "markRead", sessionId }) },
  listFolder: { args: z.tuple([Id, RelPath]), command: ([sessionId, relDir]: [string, string]): CodeCommand => ({ type: "listFolder", sessionId, relDir }) },
  readFile: { args: z.tuple([Id, RelPath.min(1)]), command: ([sessionId, relPath]: [string, string]): CodeCommand => ({ type: "readFile", sessionId, relPath }) },
  settings: { args: z.union([z.tuple([]), z.tuple([Id])]), command: ([projectId]: [string?]): CodeCommand => ({ type: "settings", ...(projectId ? { projectId } : {}) }) },
  setSettings: { args: z.tuple([SettingsChange]), command: ([change]: [z.infer<typeof SettingsChange>]): CodeCommand => ({ type: "setSettings", change }) },
  projectFolders: { args: z.tuple([Id, FolderChange]), command: ([projectId, change]: [string, z.infer<typeof FolderChange>]): CodeCommand => ({ type: "projectFolders", projectId, change }) },
  sessionOptions: { args: z.tuple([Id]), command: ([sessionId]: [string]): CodeCommand => ({ type: "sessionOptions", sessionId }) },
  configure: { args: z.tuple([Id, Options]), command: ([sessionId, options]: [string, z.infer<typeof Options>]): CodeCommand => ({ type: "configure", sessionId, options }) },
} as const;

type Channel = keyof typeof CODE_ARGS;

/** The channels a window sends without waiting for an answer. */
const FIRE_AND_FORGET: ReadonlySet<Channel> = new Set(["detach", "stopAll", "markRead"]);

/**
 * Registers every CODE_IPC handler. Each refuses a sender that isn't a registered coding window (throws, as the other
 * windows' handlers do), and answers arguments that fail their schema with a refusal. Stop everything is always
 * accepted from a coding window.
 */
export function registerCodeIpc(ipcMain: CodeIpcMain, hub: Pick<CodeHub, "dispatch">, windows: Pick<CodeWindows, "isCodeWindow">, opts: { actor?: CodeActor; log?: { warn(event: string, fields?: Record<string, unknown>): void } } = {}): void {
  const actor = opts.actor ?? "user";
  for (const channel of Object.keys(CODE_ARGS) as Channel[]) {
    const name = CODE_IPC[channel];
    const spec = CODE_ARGS[channel];
    const run = async (event: CodeIpcEvent, args: unknown[]): Promise<unknown> => {
      const from = String((event.sender as { id?: unknown }).id ?? "window");
      const parsed = (spec.args as z.ZodType<unknown[]>).safeParse(args);
      if (!parsed.success) {
        opts.log?.warn("code.ipc_bad_args", { channel });
        return channel === "list" ? { projects: [], sessions: [] } : refuse(CODE_REFUSALS.badArgs);
      }
      return hub.dispatch((spec.command as (a: unknown[]) => CodeCommand)(parsed.data), actor, from);
    };
    if (FIRE_AND_FORGET.has(channel)) {
      ipcMain.on(name, (event, ...args) => {
        if (!windows.isCodeWindow(event)) { opts.log?.warn("code.ipc_untrusted", { channel }); return; }
        void run(event, args);
      });
    } else {
      ipcMain.handle(name, async (event, ...args) => {
        if (!windows.isCodeWindow(event)) throw new Error(`untrusted IPC sender on ${name}`);
        return run(event, args);
      });
    }
  }
}
