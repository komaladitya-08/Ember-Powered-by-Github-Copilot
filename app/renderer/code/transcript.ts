/**
 * One coding session's transcript, as pure reducers over the SDK's own events (docs/CODING-APP.md "Pass through, don't
 * translate"): main sends each event as the runtime sent it, numbered per session, and what a message, a tool row, a
 * sub-agent, a plan update or an error looks like is decided here. Nothing here decides anything for the person: a
 * request becomes an item that main's pending table arms (store.ts), never one the window answers by itself.
 *
 * The constraints: replay is idempotent (an envelope at or below the last `seq`, or an event id already seen, changes
 * nothing and returns the same object), a gap in `seq` marks the transcript stale so the window attaches again, an
 * event type the window doesn't know is kept as a folded "event" item rather than dropped, and sub-agent events nest
 * under the tool call that started the sub-agent (by `agentId`, else the event's `parentToolCallId`). No DOM, no IPC:
 * unit-tested in test/unit/code-transcript.test.ts.
 */
import type { CodeEventEnvelope, CodeRequestKind, CodeSdkEvent } from "../../shared/code";
import { argsOf, arr, bool, num, rec, str, sub } from "./sdk";

/** The most characters of output a tool row keeps (its last ones), and the most items a transcript keeps. */
export const OUTPUT_KEEP = 60_000;
export const ITEMS_KEEP = 4_000;
/** How many recent event ids a transcript remembers to drop a repeat. */
export const RECENT_IDS = 512;

interface Base { key: string; /** The sub-agent's tool call this belongs to (undefined: the main agent). */ owner?: string }

export interface UserItem extends Base {
  kind: "user";
  text: string;
  /** The attachments' names as shown (never paths to act on). */
  attachments: string[];
  messageId?: string;
  source?: string;
  agentMode?: string;
  /** Shown at once from the window's own send, before the SDK's `user.message` confirms it. */
  local?: boolean;
  /** Main's sentence when it didn't go. */
  problem?: string;
  /** Sent while a turn ran: queued, or steering it. */
  delivery?: "enqueue" | "immediate";
}
export interface AssistantItem extends Base { kind: "assistant"; messageId: string; text: string; streaming: boolean }
export interface ReasoningItem extends Base { kind: "reasoning"; reasoningId: string; text: string; streaming: boolean }

/** A sub-agent the model started through a tool call (`subagent.*`). */
export interface AgentRun {
  name: string;
  displayName: string;
  description?: string;
  model?: string;
  state: "running" | "done" | "failed" | "cancelled";
  error?: string;
  durationMs?: number;
  totalToolCalls?: number;
}

export interface ToolItem extends Base {
  kind: "tool";
  toolCallId: string;
  tool: string;
  title?: string;
  /** The arguments as an object, or null when they weren't one (`argsText` then holds what came). */
  args: Record<string, unknown> | null;
  argsText?: string;
  mcp?: { server: string; tool: string };
  /** The command a shell tool runs, as the SDK shows it. */
  command?: string;
  /** The output as it streamed (its last OUTPUT_KEEP characters), else the result's content. */
  output: string;
  outputCut: boolean;
  /** The last `tool.shell_output` sequence taken (a repeat is dropped). */
  lastSequence: number;
  partial?: string;
  progress?: string;
  state: "running" | "done" | "failed";
  exitCode?: number;
  sandboxed?: boolean;
  error?: { message: string; code?: string; remediation?: string };
  /** The result's text for tools whose output isn't a stream. */
  result?: string;
  fileEdits: { path: string; kind: string }[];
  agent?: AgentRun;
  /** When its start and its end came (the events' timestamps), for the Terminal tab's durations. */
  startedAt?: string;
  endedAt?: string;
  /** A command the person ran themselves (`shell.executeUserRequested`): the SDK's `isUserRequested`. */
  userRequested?: boolean;
}

export type NoteKind = "plan" | "todos" | "compaction" | "model" | "mode" | "permissions" | "skill" | "agent" | "abort" | "notification" | "info";
export interface NoteItem extends Base { kind: "note"; note: NoteKind; fields: Record<string, string | number | boolean | undefined> }
export interface HookItem extends Base { kind: "hook"; id: string; hookType: string; state: "running" | "done" | "failed"; error?: string }
export interface ProblemItem extends Base { kind: "problem"; level: "error" | "warning"; message: string; remediation?: string; type?: string; url?: string }
export interface RequestItem extends Base {
  kind: "request";
  requestId: string;
  request: CodeRequestKind;
  data: unknown;
  /** The SDK's `*.completed` came (or main said it was resolved): a record now. */
  done: boolean;
  /** What the SDK's completion said: its result, response, action or answer, as it sent it. */
  outcome?: unknown;
  /** Who answered it, as main told it. */
  by?: string;
}
/** An event the window has no drawing for: kept, folded, with its type and data. */
export interface EventItem extends Base { kind: "event"; type: string; data: unknown }

export type Item = UserItem | AssistantItem | ReasoningItem | ToolItem | NoteItem | HookItem | ProblemItem | RequestItem | EventItem;

export interface Transcript {
  /** The last envelope applied (0: none yet). */
  lastSeq: number;
  /** A gap in `seq` was seen: the window must attach again before anything more is applied. */
  stale: boolean;
  /**
   * The session's history was rewound or cut (`session.snapshot_rewind`, `session.truncation`): what is shown no longer
   * holds, so the window attaches again without a seq and draws the kept history afresh.
   */
  rebuild?: boolean;
  recent: readonly string[];
  items: readonly Item[];
  /** A turn is under way (from `assistant.turn_start` to `session.idle`). */
  busy: boolean;
  intent?: string;
  usage?: { currentTokens: number; tokenLimit: number; messagesLength?: number };
  lastCall?: { model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cost?: number };
  model?: string;
  reasoningEffort?: string;
  agentMode?: string;
  permissionMode?: string;
  title?: string;
  context?: { cwd?: string; branch?: string; repository?: string };
  compacting: boolean;
  /** Bumped by the SDK's signal-only events, so a panel knows to read again (plan.read, queue.pendingItems, tasks.list). */
  versions: { plan: number; todos: number; queue: number; background: number };
  /** Sub-agent instance ids → the tool call that started each. */
  agents: Readonly<Record<string, string>>;
  /** Files of the session's own workspace folder the SDK says changed (`session.workspace_file_changed`): path → operation. */
  workspaceFiles?: Readonly<Record<string, string>>;
}

export const EMPTY_TRANSCRIPT: Transcript = {
  lastSeq: 0, stale: false, recent: [], items: [], busy: false, compacting: false,
  versions: { plan: 0, todos: 0, queue: 0, background: 0 }, agents: {},
};

/** The request kind each SDK `*.requested` event opens, and the `*.completed` event that closes it. */
export const REQUEST_EVENTS: Readonly<Record<string, CodeRequestKind>> = {
  "permission.requested": "permission",
  "user_input.requested": "user-input",
  "elicitation.requested": "elicitation",
  "exit_plan_mode.requested": "exit-plan-mode",
  "auto_mode_switch.requested": "auto-mode-switch",
  "session_limits_exhausted.requested": "session-limits",
  "mcp.oauth_required": "mcp-oauth",
  "sampling.requested": "sampling",
};
const COMPLETED_EVENTS = new Set([
  "permission.completed", "user_input.completed", "elicitation.completed", "exit_plan_mode.completed",
  "auto_mode_switch.completed", "session_limits_exhausted.completed", "mcp.oauth_completed", "sampling.completed",
]);

/**
 * Events that only change state the window keeps elsewhere or doesn't show (deltas the final event repairs, loading
 * notices, telemetry): no item. Anything not here and not handled below is kept as a folded "event" item.
 */
const QUIET = new Set([
  "session.start", "session.resume", "assistant.streaming_delta", "assistant.tool_call_delta", "assistant.idle",
  "assistant.server_tool_progress", "model.call_finished", "model.call_failure", "session.usage_checkpoint", "hook.progress",
  "session.tools_updated", "session.skills_loaded", "session.custom_agents_updated", "session.mcp_servers_loaded",
  "session.mcp_server_status_changed", "session.extensions_loaded", "commands.changed", "capabilities.changed",
  "session.managed_settings_resolved", "session.managed_settings_enforced", "session.quota_observation", "session.indexed_search",
  "tool_search.activated", "session.completion_receipt", "session.mode_notice_delivered", "permission.carriedForward",
  "permission.messageAuthorization", "permission.messageAuthorizationRead", "permission.messageAuthorizationDegraded",
  "permission.assentDetected", "permission.contextualAuthorization", "human_response.recorded", "subagent.configured",
  "session.auto_tier_recommendation", "session.workspace_file_changed", "session.remote_steerable_changed",
  "mcp.tools.list_changed", "mcp.resources.list_changed", "mcp.prompts.list_changed", "session.title_changed",
  "session.context_changed", "session.usage_info", "assistant.usage", "assistant.intent", "assistant.turn_start", "assistant.turn_end",
  "pending_messages.modified", "session.background_tasks_changed", "session.idle", "command.queued", "command.completed",
  "session.fusion_route_started", "assistant.fusion_phase_started", "assistant.fusion_phase_activity", "sandbox.decision",
  // Seen in every real session (runtime 1.0.97): the system prompt as it was sent, a server leaving the session as it
  // starts again (its status says the rest) and the objective's changes (the Plan tab reads them).
  "system.message", "session.mcp_server_removed", "session.autopilot_objective_changed",
]);
/** Main's debug events (model.message, model.messages_snapshot, model.call_*): large, and never the transcript's. */
const DEBUG_PREFIX = "model.";

const keep = <T>(list: readonly T[], max: number): T[] => (list.length > max ? list.slice(list.length - max) : list.slice());

/** `items` with the last one matching `pred` replaced by `fn` of it; the same array when none matches. */
function update<I extends Item>(items: readonly Item[], pred: (i: Item) => i is I, fn: (i: I) => Item): readonly Item[] {
  for (let n = items.length - 1; n >= 0; n--) {
    const it = items[n];
    if (pred(it)) {
      const next = fn(it);
      if (next === it) return items;
      const out = items.slice();
      out[n] = next;
      return out;
    }
  }
  return items;
}
const find = <I extends Item>(items: readonly Item[], pred: (i: Item) => i is I): I | undefined => {
  for (let n = items.length - 1; n >= 0; n--) { const it = items[n]; if (pred(it)) return it; }
  return undefined;
};
const append = (t: Transcript, item: Item): Transcript => ({ ...t, items: keep([...t.items, item], ITEMS_KEEP) });

const isTool = (id: string) => (i: Item): i is ToolItem => i.kind === "tool" && i.toolCallId === id;
const isAssistant = (id: string) => (i: Item): i is AssistantItem => i.kind === "assistant" && i.messageId === id;
const isReasoning = (id: string) => (i: Item): i is ReasoningItem => i.kind === "reasoning" && i.reasoningId === id;
const isRequest = (id: string) => (i: Item): i is RequestItem => i.kind === "request" && i.requestId === id;
const isHook = (id: string) => (i: Item): i is HookItem => i.kind === "hook" && i.id === id;

/** Output appended, kept to its last OUTPUT_KEEP characters. */
function appended(row: ToolItem, text: string): ToolItem {
  const all = row.output + text;
  return all.length > OUTPUT_KEEP ? { ...row, output: all.slice(all.length - OUTPUT_KEEP), outputCut: true } : { ...row, output: all };
}

/**
 * The sub-agent tool call an event belongs to: by its `agentId` (bound when its `subagent.started` came, or to the one
 * running sub-agent not yet bound), else by the `parentToolCallId` in its data when that names a tool row.
 */
function ownerOf(t: Transcript, e: CodeSdkEvent): { owner?: string; agents: Readonly<Record<string, string>> } {
  const parent = str(e.data, "parentToolCallId");
  if (e.agentId) {
    const known = t.agents[e.agentId];
    if (known) return { owner: known, agents: t.agents };
    const bound = new Set(Object.values(t.agents));
    const free = t.items.filter((i): i is ToolItem => i.kind === "tool" && i.agent?.state === "running" && !bound.has(i.toolCallId));
    const pick = parent && free.some(f => f.toolCallId === parent) ? parent : free.length === 1 ? free[0].toolCallId : parent;
    if (pick) return { owner: pick, agents: { ...t.agents, [e.agentId]: pick } };
    return { agents: t.agents };
  }
  if (parent && t.items.some(isTool(parent))) return { owner: parent, agents: t.agents };
  return { agents: t.agents };
}

/** A tool row as `tool.execution_start` describes it. */
function toolFrom(e: CodeSdkEvent, key: string, owner: string | undefined): ToolItem {
  const d = e.data;
  const rawArgs = rec(d)?.arguments;
  const args = argsOf(rawArgs);
  const shell = sub(d, "shellToolInfo");
  const server = str(d, "mcpServerName"), mcpTool = str(d, "mcpToolName");
  const command = str(shell, "displayCommand") ?? str(args, "command");
  return {
    kind: "tool", key, ...(owner ? { owner } : {}),
    toolCallId: str(d, "toolCallId") ?? key, tool: str(d, "toolName") ?? "tool",
    ...(str(d, "toolTitle") ? { title: str(d, "toolTitle") } : {}),
    args, ...(args === null && typeof rawArgs === "string" ? { argsText: rawArgs } : {}),
    ...(server && mcpTool ? { mcp: { server, tool: mcpTool } } : {}),
    ...(command ? { command } : {}),
    output: "", outputCut: false, lastSequence: -1, state: "running", fileEdits: [],
    ...(e.timestamp ? { startedAt: e.timestamp } : {}),
  };
}

/** A bare tool row for an event about a tool call whose start wasn't seen (it came before the window attached). */
function bareTool(toolCallId: string, key: string, owner: string | undefined, tool = "tool"): ToolItem {
  return { kind: "tool", key, ...(owner ? { owner } : {}), toolCallId, tool, args: null, output: "", outputCut: false, lastSequence: -1, state: "running", fileEdits: [] };
}

/** `t` with the tool row `id` changed by `fn` (made bare first when it isn't there). */
function withTool(t: Transcript, id: string, key: string, owner: string | undefined, fn: (r: ToolItem) => ToolItem, tool?: string): Transcript {
  if (t.items.some(isTool(id))) return { ...t, items: update(t.items, isTool(id), fn) };
  return append(t, fn(bareTool(id, key, owner, tool)));
}

/** System notifications come wrapped in `<system_notification>` tags: their words without the tags. */
function notificationText(content: string): string {
  return content.replace(/<\/?[a-z_]+>/gi, "").replace(/\s+/g, " ").trim();
}

/** Streamed words of the main agent settle when its turn ends. */
function settle(items: readonly Item[]): readonly Item[] {
  let changed = false;
  const out = items.map(i => {
    if ((i.kind === "assistant" || i.kind === "reasoning") && i.streaming) { changed = true; return { ...i, streaming: false }; }
    return i;
  });
  return changed ? out : items;
}

/** One SDK event applied to the transcript (envelope numbering is `applyEnvelope`'s). */
export function reduceEvent(t: Transcript, e: CodeSdkEvent): Transcript {
  if (e.type === "subagent.started") return agentStarted(t, e);
  const d = e.data;
  const key = e.id;
  const { owner, agents } = ownerOf(t, e);
  if (agents !== t.agents) t = { ...t, agents };
  const mine = owner === undefined;
  const at = owner ? { owner } : {};

  const requestKind = REQUEST_EVENTS[e.type];
  if (requestKind) {
    const requestId = str(d, "requestId") ?? key;
    if (t.items.some(isRequest(requestId))) return t;
    return append(t, { kind: "request", key, ...at, requestId, request: requestKind, data: d, done: false });
  }
  if (COMPLETED_EVENTS.has(e.type)) {
    const requestId = str(d, "requestId");
    if (!requestId) return t;
    const o = rec(d);
    const outcome = o ? (o.result ?? o.response ?? o.action ?? o.outcome ?? (o.answer !== undefined ? { answer: o.answer, wasFreeform: o.wasFreeform } : o.approved !== undefined ? { approved: o.approved, selectedAction: o.selectedAction, feedback: o.feedback } : undefined)) : undefined;
    return { ...t, items: update(t.items, isRequest(requestId), r => ({ ...r, done: true, ...(outcome !== undefined ? { outcome } : {}) })) };
  }

  switch (e.type) {
    case "user.message": {
      const text = str(d, "content", true) ?? "";
      const names = arr(d, "attachments").map(a => str(a, "displayName") ?? (str(a, "path") ?? str(a, "filePath") ?? "").split(/[\\/]/).pop() ?? str(a, "type") ?? "").filter(Boolean);
      const messageId = str(d, "messageId");
      const confirmed: Omit<UserItem, "key"> = {
        kind: "user", ...at, text, attachments: names, ...(messageId ? { messageId } : {}),
        ...(str(d, "source") ? { source: str(d, "source") } : {}), ...(str(d, "agentMode") ? { agentMode: str(d, "agentMode") } : {}),
      };
      // The window's own message, shown as it was sent, is this one: by its id, else the first unconfirmed with these words.
      const local = (i: Item): i is UserItem => i.kind === "user" && !!i.local && (messageId ? i.messageId === messageId || (!i.messageId && i.text === text) : i.text === text);
      const had = t.items.find(local);
      if (had) return { ...t, items: update(t.items, (i): i is UserItem => i === had, r => ({ ...confirmed, key: r.key, ...(r.delivery ? { delivery: r.delivery } : {}) })) };
      return append(t, { ...confirmed, key });
    }
    case "assistant.turn_start": return mine ? { ...t, busy: true } : t;
    case "assistant.turn_end": return t;
    case "assistant.intent": return mine && str(d, "intent") ? { ...t, intent: str(d, "intent") } : t;
    case "assistant.message_start": {
      const id = str(d, "messageId");
      if (!id || t.items.some(isAssistant(id))) return t;
      return append(t, { kind: "assistant", key, ...at, messageId: id, text: "", streaming: true });
    }
    case "assistant.message_delta": {
      const id = str(d, "messageId"), text = str(d, "deltaContent", true) ?? "";
      if (!id) return t;
      if (t.items.some(isAssistant(id))) return { ...t, items: update(t.items, isAssistant(id), r => (r.streaming ? { ...r, text: r.text + text } : r)) };
      return append(t, { kind: "assistant", key, ...at, messageId: id, text, streaming: true });
    }
    case "assistant.message": {
      const id = str(d, "messageId") ?? key, text = str(d, "content", true) ?? "";
      if (t.items.some(isAssistant(id))) return { ...t, items: update(t.items, isAssistant(id), r => ({ ...r, text: text || r.text, streaming: false })) };
      // A message of tool calls only adds nothing.
      if (!text.trim()) return t;
      return append(t, { kind: "assistant", key, ...at, messageId: id, text, streaming: false });
    }
    case "assistant.reasoning_delta": {
      const id = str(d, "reasoningId"), text = str(d, "deltaContent", true) ?? "";
      if (!id) return t;
      if (t.items.some(isReasoning(id))) return { ...t, items: update(t.items, isReasoning(id), r => (r.streaming ? { ...r, text: r.text + text } : r)) };
      return append(t, { kind: "reasoning", key, ...at, reasoningId: id, text, streaming: true });
    }
    case "assistant.reasoning": {
      const id = str(d, "reasoningId") ?? key, text = str(d, "content", true) ?? "";
      if (t.items.some(isReasoning(id))) return { ...t, items: update(t.items, isReasoning(id), r => ({ ...r, text: text || r.text, streaming: false })) };
      if (!text.trim()) return t;
      return append(t, { kind: "reasoning", key, ...at, reasoningId: id, text, streaming: false });
    }
    case "assistant.usage": {
      if (!mine) return t;
      return { ...t, lastCall: { model: str(d, "model"), inputTokens: num(d, "inputTokens"), outputTokens: num(d, "outputTokens"), cacheReadTokens: num(d, "cacheReadTokens"), cost: num(d, "cost") } };
    }
    case "session.usage_info": {
      const currentTokens = num(d, "currentTokens"), tokenLimit = num(d, "tokenLimit");
      if (currentTokens === undefined || tokenLimit === undefined) return t;
      return { ...t, usage: { currentTokens, tokenLimit, messagesLength: num(d, "messagesLength") } };
    }
    // A command the person ran themselves (`shell.executeUserRequested`) starts with `tool.user_requested`, never
    // `tool.execution_start` (probed on runtime 1.0.97): its row is a shell row from the first.
    case "tool.user_requested":
    case "tool.execution_start": {
      const fresh: ToolItem = e.type === "tool.user_requested" ? { ...toolFrom(e, key, owner), userRequested: true } : toolFrom(e, key, owner);
      const id = fresh.toolCallId;
      // A row made before its start (a sub-agent's started first) keeps its key, output and sub-agent.
      if (t.items.some(isTool(id))) return { ...t, items: update(t.items, isTool(id), r => ({ ...fresh, key: r.key, ...(r.owner ? { owner: r.owner } : {}), output: r.output, outputCut: r.outputCut, lastSequence: r.lastSequence, ...(r.agent ? { agent: r.agent } : {}), state: r.state === "running" ? fresh.state : r.state })) };
      return append(t, fresh);
    }
    case "tool.execution_progress": {
      const id = str(d, "toolCallId");
      return id ? withTool(t, id, key, owner, r => ({ ...r, progress: str(d, "progressMessage") })) : t;
    }
    case "tool.execution_partial_result": {
      const id = str(d, "toolCallId");
      return id ? withTool(t, id, key, owner, r => ({ ...r, partial: str(d, "partialOutput", true) ?? r.partial })) : t;
    }
    case "tool.shell_output": {
      const id = str(d, "toolCallId"), text = str(d, "text", true) ?? "", sequence = num(d, "sequence") ?? -1;
      if (!id) return t;
      return withTool(t, id, key, owner, r => (sequence >= 0 && sequence <= r.lastSequence ? r : { ...appended(r, text), lastSequence: Math.max(sequence, r.lastSequence) }));
    }
    case "tool.execution_complete": {
      const id = str(d, "toolCallId");
      if (!id) return t;
      const success = bool(d, "success") ?? false;
      const result = sub(d, "result");
      const content = str(result, "content", true);
      const err = sub(d, "error");
      const exitCode = num(sub(d, "shellExecution"), "exitCode");
      const edits = arr(d, "fileEdits").map(f => ({ path: str(f, "path") ?? "", kind: str(f, "kind") ?? "edit" })).filter(f => f.path);
      return withTool(t, id, key, owner, r => {
        const isShell = r.command !== undefined || exitCode !== undefined;
        // A shell's result is its output where none streamed (the SDK sends both); another tool's result is its own.
        const withOut = isShell && !r.output && content ? appended(r, content) : r;
        return {
          ...withOut, state: success ? "done" : "failed", progress: undefined, partial: undefined, fileEdits: edits,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(e.timestamp ? { endedAt: e.timestamp } : {}),
          ...(bool(d, "isUserRequested") ? { userRequested: true } : {}),
          ...(bool(d, "sandboxed") !== undefined ? { sandboxed: bool(d, "sandboxed") } : {}),
          ...(!isShell && content ? { result: content } : {}),
          ...(err ? { error: { message: str(err, "message") ?? "", ...(str(err, "code") ? { code: str(err, "code") } : {}), ...(str(err, "remediation") ? { remediation: str(err, "remediation") } : {}) } } : {}),
        };
      });
    }
    case "subagent.completed":
    case "subagent.failed": {
      const id = str(d, "toolCallId");
      if (!id) return t;
      const failed = e.type === "subagent.failed";
      return withTool(t, id, key, undefined, r => ({
        ...r,
        agent: {
          ...(r.agent ?? { name: str(d, "agentName") ?? "agent", displayName: str(d, "agentDisplayName") ?? "agent" }),
          state: failed ? "failed" : bool(d, "cancelled") ? "cancelled" : "done",
          ...(failed && str(d, "error") ? { error: str(d, "error") } : {}),
          ...(num(d, "durationMs") !== undefined ? { durationMs: num(d, "durationMs") } : {}),
          ...(num(d, "totalToolCalls") !== undefined ? { totalToolCalls: num(d, "totalToolCalls") } : {}),
        },
      }), "task");
    }
    case "subagent.selected": return append(t, { kind: "note", key, ...at, note: "agent", fields: { agent: str(d, "agentDisplayName") ?? str(d, "agentName"), on: true } });
    case "subagent.deselected": return append(t, { kind: "note", key, ...at, note: "agent", fields: { on: false } });
    case "skill.invoked": return append(t, { kind: "note", key, ...at, note: "skill", fields: { name: str(d, "name"), description: str(d, "description"), plugin: str(d, "pluginName") } });
    case "hook.start": {
      const id = str(d, "hookInvocationId") ?? key;
      if (t.items.some(isHook(id))) return t;
      return append(t, { kind: "hook", key, ...at, id, hookType: str(d, "hookType") ?? "hook", state: "running" });
    }
    case "hook.end": {
      const id = str(d, "hookInvocationId");
      if (!id) return t;
      const ok = bool(d, "success") ?? true;
      const error = str(sub(d, "error"), "message");
      if (!t.items.some(isHook(id))) return append(t, { kind: "hook", key, ...at, id, hookType: str(d, "hookType") ?? "hook", state: ok ? "done" : "failed", ...(error ? { error } : {}) });
      return { ...t, items: update(t.items, isHook(id), h => ({ ...h, state: ok ? "done" : "failed", ...(error ? { error } : {}) })) };
    }
    case "session.plan_changed": {
      const next = { ...t, versions: { ...t.versions, plan: t.versions.plan + 1 } };
      return append(next, { kind: "note", key, ...at, note: "plan", fields: { operation: str(d, "operation") } });
    }
    case "session.todos_changed": {
      const next = { ...t, versions: { ...t.versions, todos: t.versions.todos + 1 } };
      // A run of writes to the to-do list is one note.
      const last = next.items[next.items.length - 1];
      if (last?.kind === "note" && last.note === "todos") return next;
      return append(next, { kind: "note", key, ...at, note: "todos", fields: {} });
    }
    case "session.compaction_start":
      return append({ ...t, compacting: true }, { kind: "note", key, note: "compaction", fields: { state: "running", trigger: str(d, "trigger") } });
    case "session.compaction_complete": {
      const fields = {
        state: (bool(d, "success") ?? false) ? "done" : "failed", tokensRemoved: num(d, "tokensRemoved"), messagesRemoved: num(d, "messagesRemoved"),
        error: str(d, "error"), checkpoint: num(d, "checkpointNumber"),
      };
      const running = (i: Item): i is NoteItem => i.kind === "note" && i.note === "compaction" && i.fields.state === "running";
      if (find(t.items, running)) return { ...t, compacting: false, items: update(t.items, running, n => ({ ...n, fields: { ...n.fields, ...fields } })) };
      return append({ ...t, compacting: false }, { kind: "note", key, note: "compaction", fields });
    }
    case "session.model_change": {
      const to = str(d, "newModel");
      const effort = rec(d)?.reasoningEffort === null ? undefined : str(d, "reasoningEffort");
      const next = { ...t, ...(to ? { model: to } : {}), reasoningEffort: effort ?? t.reasoningEffort };
      return append(next, { kind: "note", key, note: "model", fields: { from: str(d, "previousModel"), to, effort } });
    }
    case "session.mode_changed": {
      const to = str(d, "newMode");
      return append({ ...t, ...(to ? { agentMode: to } : {}) }, { kind: "note", key, note: "mode", fields: { from: str(d, "previousMode"), to } });
    }
    case "session.permissions_changed": {
      const to = str(d, "mode");
      return append({ ...t, ...(to ? { permissionMode: to } : {}) }, { kind: "note", key, note: "permissions", fields: { from: str(d, "previousMode"), to } });
    }
    case "session.info": return append(t, { kind: "note", key, ...at, note: "info", fields: { message: str(d, "message"), tip: str(d, "tip") } });
    case "session.error":
    case "session.warning": {
      const error = e.type === "session.error";
      return append(t, {
        kind: "problem", key, ...at, level: error ? "error" : "warning", message: str(d, "message") ?? "",
        ...(str(d, "remediation") ? { remediation: str(d, "remediation") } : {}),
        ...(str(d, error ? "errorType" : "warningType") ? { type: str(d, error ? "errorType" : "warningType") } : {}),
        ...(str(d, "url") ? { url: str(d, "url") } : {}),
      });
    }
    case "abort": return append({ ...t, items: settle(t.items) }, { kind: "note", key, note: "abort", fields: { reason: str(d, "reason") } });
    case "system.notification": {
      const kind = str(sub(d, "kind"), "type");
      return append(t, { kind: "note", key, ...at, note: "notification", fields: { text: notificationText(str(d, "content", true) ?? ""), type: kind } });
    }
    default: break;
  }

  // State-only events, then the rest kept as they came.
  const s = stateOnly(t, e, mine);
  if (s) return s;
  if (QUIET.has(e.type) || e.type.startsWith(DEBUG_PREFIX)) return t;
  return append(t, { kind: "event", key, ...at, type: e.type, data: d });
}

/**
 * A sub-agent started by a tool call. Its event carries an `agentId` the window already knows when it is a nested
 * sub-agent's start told by its parent (the row goes under that parent); an unknown one is the new sub-agent's own,
 * bound here to this tool call, so the events it sends next nest under its row.
 */
function agentStarted(t: Transcript, e: CodeSdkEvent): Transcript {
  const d = e.data;
  const id = str(d, "toolCallId");
  if (!id) return t;
  let owner: string | undefined;
  let next = t;
  if (e.agentId && t.agents[e.agentId]) owner = t.agents[e.agentId] === id ? t.items.find(isTool(id))?.owner : t.agents[e.agentId];
  else {
    const parent = str(d, "parentToolCallId");
    owner = parent && parent !== id && t.items.some(isTool(parent)) ? parent : undefined;
    if (e.agentId) next = { ...t, agents: { ...t.agents, [e.agentId]: id } };
  }
  const run: AgentRun = {
    name: str(d, "agentName") ?? "agent", displayName: str(d, "agentDisplayName") ?? str(d, "agentName") ?? "agent",
    ...(str(d, "agentDescription") ? { description: str(d, "agentDescription") } : {}), ...(str(d, "model") ? { model: str(d, "model") } : {}),
    state: "running",
  };
  return withTool(next, id, e.id, owner, r => ({ ...r, agent: run }), "task");
}

/** What the state-only events change (null: not one of them). */
function stateOnly(t: Transcript, e: CodeSdkEvent, mine: boolean): Transcript | null {
  const d = e.data;
  switch (e.type) {
    case "session.start":
    case "session.resume": {
      const model = str(d, "selectedModel"), effort = str(d, "reasoningEffort");
      return { ...t, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) };
    }
    case "session.title_changed": return str(d, "title") ? { ...t, title: str(d, "title") } : t;
    case "session.context_changed": return { ...t, context: { cwd: str(d, "cwd"), branch: str(d, "branch"), repository: str(d, "repository") } };
    case "pending_messages.modified": return { ...t, versions: { ...t.versions, queue: t.versions.queue + 1 } };
    case "session.background_tasks_changed": return { ...t, versions: { ...t.versions, background: t.versions.background + 1 } };
    case "session.workspace_file_changed": {
      const path = str(d, "path");
      return path ? { ...t, workspaceFiles: { ...t.workspaceFiles, [path]: str(d, "operation") ?? "update" } } : t;
    }
    case "session.idle": return mine ? { ...t, busy: false, intent: undefined, compacting: false, items: settle(t.items) } : t;
    case "session.shutdown": return { ...t, busy: false, items: settle(t.items) };
    case "session.snapshot_rewind":
    case "session.truncation": return { ...t, stale: true, rebuild: true };
    default: return null;
  }
}

/**
 * One envelope applied. An envelope at or below the last `seq`, or an event id already seen, changes nothing (the same
 * object comes back). One past the next `seq` marks the transcript stale: nothing more is applied until the window has
 * attached again (`attachedTranscript`).
 */
export function applyEnvelope(t: Transcript, env: CodeEventEnvelope): Transcript {
  if (t.stale) return t;
  if (env.seq <= t.lastSeq) return t;
  if (env.seq !== t.lastSeq + 1) return { ...t, stale: true };
  if (t.recent.includes(env.event.id)) return { ...t, lastSeq: env.seq };
  const next = reduceEvent(t, env.event);
  return { ...next, lastSeq: env.seq, recent: keep([...t.recent, env.event.id], RECENT_IDS) };
}

/**
 * A replayed history with what each rewind took away left out: `session.snapshot_rewind` names the user message it
 * went back to (`upToEventId`, which goes too), and main's in-memory replay still holds what came after it, so the
 * events from that message up to the rewind are dropped, and the rewind event with them (probed on runtime 1.0.97:
 * a rewind's `eventsRemoved` events stay in the run's log). A rewind whose message isn't among them (the SDK's own
 * history, already cut) is dropped alone.
 */
export function withoutRewound(events: readonly CodeEventEnvelope[]): CodeEventEnvelope[] {
  const out: CodeEventEnvelope[] = [];
  for (const env of events) {
    if (env.event.type !== "session.snapshot_rewind") { out.push(env); continue; }
    const to = str(env.event.data, "upToEventId");
    const at = to ? out.findIndex(e => e.event.id === to) : -1;
    if (at >= 0) out.splice(at);
  }
  return out;
}

/**
 * What an attach returned, applied: with `since` (the window's last seq) the events after it go on the transcript kept;
 * without, the transcript is built again from the kept history. Either way it is no longer stale, and its `lastSeq` is
 * main's.
 */
export function attachedTranscript(t: Transcript | undefined, events: readonly CodeEventEnvelope[], seq: number, since?: number): Transcript {
  // A message sent but not yet confirmed survives a rebuild (its `user.message` may be among these events, or still come).
  let base: Transcript = since !== undefined && t ? { ...t, stale: false, lastSeq: since }
    : { ...EMPTY_TRANSCRIPT, items: t ? t.items.filter(i => i.kind === "user" && i.local) : [] };
  for (const env of since === undefined ? withoutRewound(events) : events) {
    if (env.seq <= base.lastSeq) continue;
    // Main's history may skip numbers (its ephemeral events aren't kept): that is no gap of the window's.
    base = applyEnvelope({ ...base, lastSeq: env.seq - 1 }, env);
  }
  // What the history didn't confirm comes after it, where it was sent.
  if (since === undefined && t) {
    const unconfirmed = (i: Item) => i.kind === "user" && !!i.local;
    base = { ...base, items: [...base.items.filter(i => !unconfirmed(i)), ...base.items.filter(unconfirmed)] };
  }
  return { ...base, stale: false, lastSeq: Math.max(base.lastSeq, seq) };
}

/** The window's own message, shown at once (`key`: unique for the page). */
export function sentLocally(t: Transcript, key: string, text: string, attachments: string[], delivery?: "enqueue" | "immediate"): Transcript {
  return append(t, { kind: "user", key, text, attachments, local: true, ...(delivery ? { delivery } : {}) });
}

/** Main took the message: its id, so the SDK's `user.message` is matched to it. */
export function sendTaken(t: Transcript, key: string, messageId: string): Transcript {
  return { ...t, items: update(t.items, (i): i is UserItem => i.kind === "user" && i.key === key, r => (r.local ? { ...r, messageId } : r)) };
}

/** A message that didn't go: its row says why. */
export function sendRefused(t: Transcript, key: string, reason: string): Transcript {
  return { ...t, items: update(t.items, (i): i is UserItem => i.kind === "user" && i.key === key, r => ({ ...r, problem: reason })) };
}

/** A request main says was resolved (by someone, in any window): its item becomes a record. */
export function requestResolved(t: Transcript, requestId: string, by: string): Transcript {
  return { ...t, items: update(t.items, isRequest(requestId), r => (r.done && r.by === by ? r : { ...r, done: true, by })) };
}

/** A pending request main replayed or opened that the transcript has no item for (its event wasn't kept): one now. */
export function requestOpened(t: Transcript, requestId: string, kind: CodeRequestKind, data: unknown): Transcript {
  if (t.items.some(isRequest(requestId))) return t;
  return append(t, { kind: "request", key: `request:${requestId}`, requestId, request: kind, data, done: false });
}

/** The items of one agent (undefined: the main agent's), in order. */
export function itemsOf(t: Transcript, owner?: string): Item[] {
  return t.items.filter(i => i.owner === owner);
}
