/**
 * Home's native chat channels (CHAT_IPC) in main, over an injected ChatIpcApi. Every handler answers only the settings
 * window's own page (`isHomeSender`, checked before anything else) and takes its arguments as unknown, checked with zod
 * with size limits (CHAT_LIMITS). A new chat's folder is never a page's: main opens its own folder picker (the api's
 * `create`). A refusal or a failure answers `{ ok: false, why }` in one plain sentence (ChatUnavailable's own, else
 * friendlyError's), never the SDK's text. Plain Node: Electron's objects are injected.
 */

import { z } from "zod";
import { CHAT_IPC } from "../shared/ipc";
import { CHAT_AGENT_MODES, CHAT_DECISIONS, CHAT_LIMITS, CHAT_PERMISSION_MODES, type ChatAgentMode, type ChatDecision, type ChatDone, type ChatModeResult, type ChatPermissionMode, type ChatSessionRow } from "../shared/chat";
import { ChatUnavailable } from "./agent/chat-session";
import { NotOffered } from "./agent/chat-permission";
import { friendlyError } from "./agent/presenter";

/** What main does for the channels (main.ts builds it over ChatSessions and its folder picker). */
export interface ChatIpcApi {
  list(): Promise<ChatSessionRow[]>;
  /** Opens main's own folder picker; null when the person chose none. */
  create(name?: string): Promise<ChatSessionRow | null>;
  resume(id: string): Promise<ChatSessionRow>;
  send(id: string, text: string): Promise<void>;
  decide(id: string, requestId: string, decision: ChatDecision): Promise<void>;
  answer(id: string, requestId: string, answer: string, wasFreeform: boolean): void | Promise<void>;
  setPermissionMode(id: string, mode: ChatPermissionMode): Promise<ChatModeResult<ChatPermissionMode>>;
  setAgentMode(id: string, mode: ChatAgentMode): Promise<ChatModeResult<ChatAgentMode>>;
  stop(id: string): Promise<void>;
}

/** The part of Electron's ipcMain these channels use. */
export interface ChatIpcMain {
  handle(channel: string, fn: (event: ChatIpcEvent, ...args: unknown[]) => unknown): void;
}
/** The part of an invoke event the sender check reads. */
export interface ChatIpcEvent { sender: unknown; senderFrame?: { url: string } | null }

const Id = z.string().min(1).max(CHAT_LIMITS.id).regex(/^[A-Za-z0-9._:-]+$/);
const Decision = z.object({
  kind: z.enum(CHAT_DECISIONS),
  feedback: z.string().max(CHAT_LIMITS.feedback).optional(),
}).strict();

/** Each channel's arguments, exactly. */
export const CHAT_ARGS = {
  list: z.tuple([]),
  create: z.union([z.tuple([]), z.tuple([z.string().max(CHAT_LIMITS.name)])]),
  resume: z.tuple([Id]),
  send: z.tuple([Id, z.string().min(1).max(CHAT_LIMITS.prompt)]),
  decide: z.tuple([Id, Id, Decision]),
  answer: z.tuple([Id, Id, z.string().max(CHAT_LIMITS.answer), z.boolean()]),
  setPermissionMode: z.tuple([Id, z.enum(CHAT_PERMISSION_MODES)]),
  setAgentMode: z.tuple([Id, z.enum(CHAT_AGENT_MODES)]),
  stop: z.tuple([Id]),
} as const;

/** The plain sentence for arguments that fail their schema. */
export const CHAT_BAD_ARGS = "Ember couldn't read that request.";

type Channel = keyof typeof CHAT_ARGS;

/** One plain sentence for a failure. */
function why(err: unknown): string {
  if (err instanceof ChatUnavailable || err instanceof NotOffered) return err.message;
  return friendlyError(err instanceof Error ? err.message : String(err));
}

/** Registers CHAT_IPC's request channels. A sender that isn't the settings window is refused with an error. */
export function registerChatIpc(
  ipcMain: ChatIpcMain,
  isHomeSender: (event: ChatIpcEvent) => boolean,
  api: ChatIpcApi,
  opts: { log?: { warn(event: string, fields?: Record<string, unknown>): void } } = {},
): void {
  const on = <C extends Channel>(channel: C, run: (args: z.infer<(typeof CHAT_ARGS)[C]>) => unknown) => {
    const name = CHAT_IPC[channel];
    ipcMain.handle(name, async (event, ...args): Promise<ChatDone<unknown>> => {
      if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${name}`);
      const parsed = CHAT_ARGS[channel].safeParse(args);
      if (!parsed.success) return { ok: false, why: CHAT_BAD_ARGS };
      try {
        const value = await run(parsed.data as z.infer<(typeof CHAT_ARGS)[C]>);
        return { ok: true, value: value === undefined ? undefined : value };
      } catch (err) {
        if (!(err instanceof ChatUnavailable) && !(err instanceof NotOffered)) opts.log?.warn("chat.ipc_failed", { channel, err: err instanceof Error ? err.name : "unknown" });
        return { ok: false, why: why(err) };
      }
    });
  };
  on("list", () => api.list());
  on("create", ([name]) => api.create(name?.trim() || undefined));
  on("resume", ([id]) => api.resume(id));
  on("send", ([id, text]) => api.send(id, text));
  on("decide", ([id, requestId, decision]) => api.decide(id, requestId, decision));
  on("answer", ([id, requestId, answer, wasFreeform]) => api.answer(id, requestId, answer, wasFreeform));
  on("setPermissionMode", ([id, mode]) => api.setPermissionMode(id, mode));
  on("setAgentMode", ([id, mode]) => api.setAgentMode(id, mode));
  on("stop", ([id]) => api.stop(id));
}
